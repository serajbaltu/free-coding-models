/**
 * @file lib/proxy-server.js
 * @description Multi-account rotation proxy server with SSE streaming,
 * token stats tracking, Anthropic/OpenAI translation, and persistent request logging.
 *
 * Design:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0)
 *   - SSE is piped through without buffering (upstreamRes.pipe(clientRes))
 *   - HTTP/HTTPS module is chosen BEFORE the request is created (single code-path)
 *   - x-ratelimit-* headers are stripped from all responses forwarded to clients
 *   - Retry loop: first attempt uses sticky session fingerprint; subsequent
 *     retries use fresh P2C to avoid hitting the same failed account
 *   - Claude-family aliases are resolved inside the proxy so Claude Code can
 *     keep emitting `claude-*` / `sonnet` / `haiku` style model ids safely
 *
 * @exports ProxyServer
 */

import http from 'node:http'
import https from 'node:https'
import { AccountManager } from './account-manager.js'
import { classifyError } from './error-classifier.js'
import { applyThinkingBudget, compressContext } from './request-transformer.js'
import { TokenStats } from './token-stats.js'
import { createHash } from 'node:crypto'
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  createAnthropicSSETransformer,
  estimateAnthropicTokens,
} from './anthropic-translator.js'
import {
  translateResponsesToOpenAI,
  translateOpenAIToResponses,
  createResponsesSSETransformer,
} from './responses-translator.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Choose the http or https module based on the URL scheme.
 * MUST be called before creating the request (single code-path).
 *
 * @param {string} url
 * @returns {typeof import('http') | typeof import('https')}
 */
function selectClient(url) {
  return url.startsWith('https') ? https : http
}

/**
 * Return a copy of the headers object with all x-ratelimit-* entries removed.
 *
 * @param {Record<string, string | string[]>} headers
 * @returns {Record<string, string | string[]>}
 */
function stripRateLimitHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith('x-ratelimit')) {
      result[key] = value
    }
  }
  return result
}

// 📖 Max body size limit to prevent memory exhaustion attacks (10 MB)
const MAX_BODY_SIZE = 10 * 1024 * 1024

/**
 * Buffer all chunks from an http.IncomingMessage and return the body as a string.
 * Enforces a size limit to prevent memory exhaustion from oversized payloads.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 * @throws {Error} with statusCode 413 if body exceeds MAX_BODY_SIZE
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalSize = 0
    req.on('data', chunk => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        const err = new Error('Request body too large')
        err.statusCode = 413
        return reject(err)
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

/**
 * Write a JSON (or pre-serialised) response to the client.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object | string} body
 */
function sendJson(res, statusCode, body) {
  if (res.headersSent) return
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(json)
}

/**
 * 📖 Match routes on the URL pathname only so Claude Code's `?beta=true`
 * 📖 Anthropic requests resolve exactly like FastAPI routes do in free-claude-code.
 *
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function getRequestPathname(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname || '/'
  } catch {
    return req.url || '/'
  }
}

function normalizeRequestedModel(modelId) {
  if (typeof modelId !== 'string') return null
  const trimmed = modelId.trim()
  if (!trimmed) return null
  return trimmed.replace(/^fcm-proxy\//, '')
}

function normalizeAnthropicRouting(anthropicRouting = null) {
  return {
    model: normalizeRequestedModel(anthropicRouting?.model),
    modelOpus: normalizeRequestedModel(anthropicRouting?.modelOpus),
    modelSonnet: normalizeRequestedModel(anthropicRouting?.modelSonnet),
    modelHaiku: normalizeRequestedModel(anthropicRouting?.modelHaiku),
  }
}

function classifyClaudeVirtualModel(modelId) {
  const normalized = normalizeRequestedModel(modelId)
  if (!normalized) return null

  const lower = normalized.toLowerCase()

  // 📖 Mirror free-claude-code's family routing approach: classify by Claude
  // 📖 family keywords, not only exact ids. Claude Code regularly emits both
  // 📖 short aliases (`sonnet`) and full versioned ids (`claude-3-5-sonnet-*`).
  if (lower === 'default') return 'default'
  if (/^opus(?:plan)?(?:\[1m\])?$/.test(lower)) return 'opus'
  if (/^sonnet(?:\[1m\])?$/.test(lower)) return 'sonnet'
  if (lower === 'haiku') return 'haiku'
  if (!lower.startsWith('claude-')) return null
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('sonnet')) return 'sonnet'
  return null
}

function resolveAnthropicMappedModel(modelId, anthropicRouting) {
  const routing = normalizeAnthropicRouting(anthropicRouting)
  const fallbackModel = routing.model
  if (!fallbackModel && !routing.modelOpus && !routing.modelSonnet && !routing.modelHaiku) {
    return null
  }

  const family = classifyClaudeVirtualModel(modelId)
  if (family === 'opus') return routing.modelOpus || fallbackModel
  if (family === 'sonnet') return routing.modelSonnet || fallbackModel
  if (family === 'haiku') return routing.modelHaiku || fallbackModel

  // 📖 free-claude-code falls back to MODEL for unknown Claude ids too.
  return fallbackModel
}

// 📖 Accepts both standard Bearer auth and Anthropic SDK x-api-key header
// 📖 Claude Code sends credentials via x-api-key, not Authorization: Bearer
function parseProxyAuthorizationHeader(authorization, expectedToken, xApiKey = null) {
  if (!expectedToken) return { authorized: true, modelHint: null }

  // 📖 Check standard Bearer auth first
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const rawToken = authorization.slice('Bearer '.length).trim()
    if (rawToken === expectedToken) return { authorized: true, modelHint: null }
    if (rawToken.startsWith(`${expectedToken}:`)) {
      const modelHint = normalizeRequestedModel(rawToken.slice(expectedToken.length + 1))
      return modelHint ? { authorized: true, modelHint } : { authorized: false, modelHint: null }
    }
  }

  // 📖 Fallback: Anthropic SDK x-api-key header
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    const trimmed = xApiKey.trim()
    if (trimmed === expectedToken) return { authorized: true, modelHint: null }
    if (trimmed.startsWith(`${expectedToken}:`)) {
      const modelHint = normalizeRequestedModel(trimmed.slice(expectedToken.length + 1))
      return modelHint ? { authorized: true, modelHint } : { authorized: false, modelHint: null }
    }
  }

  // 📖 Accept real Anthropic API keys (sk-ant-*) — Claude Code uses its own stored key
  // 📖 even when ANTHROPIC_BASE_URL is overridden to point at the proxy.
  // 📖 The proxy is bound to 127.0.0.1 only, so accepting these keys is safe.
  const candidateToken = (typeof authorization === 'string' && authorization.startsWith('Bearer '))
    ? authorization.slice('Bearer '.length).trim()
    : (typeof xApiKey === 'string' ? xApiKey.trim() : '')
  if (candidateToken.startsWith('sk-ant-')) {
    return { authorized: true, modelHint: null }
  }

  return { authorized: false, modelHint: null }
}

// ─── ProxyServer ─────────────────────────────────────────────────────────────

export class ProxyServer {
  /**
 * @param {{
 *   port?: number,
 *   accounts?: Array<{ id: string, providerKey: string, apiKey: string, modelId: string, url: string }>,
 *   retries?: number,
 *   proxyApiKey?: string,
 *   anthropicRouting?: { model?: string|null, modelOpus?: string|null, modelSonnet?: string|null, modelHaiku?: string|null },
 *   accountManagerOpts?: object,
 *   tokenStatsOpts?: object,
 *   thinkingConfig?: { mode: string, budget_tokens?: number },
 *   compressionOpts?: { level?: number, toolResultMaxChars?: number, thinkingMaxChars?: number, maxTotalChars?: number },
 *   upstreamTimeoutMs?: number
 * }} opts
 */
  constructor({
    port = 0,
    accounts = [],
    retries = 8,
    proxyApiKey = null,
    anthropicRouting = null,
    accountManagerOpts = {},
    tokenStatsOpts = {},
    thinkingConfig,
    compressionOpts,
    upstreamTimeoutMs = 45_000,
  } = {}) {
    this._port = port
    this._retries = retries
    this._thinkingConfig = thinkingConfig
    this._compressionOpts = compressionOpts
    this._proxyApiKey = proxyApiKey
    this._anthropicRouting = normalizeAnthropicRouting(anthropicRouting)
    this._accounts = accounts
    this._upstreamTimeoutMs = upstreamTimeoutMs
    // 📖 Progressive backoff delays (ms) for retries — first attempt is immediate,
    // subsequent ones add increasing delay + random jitter (0-100ms) to avoid
    // re-hitting the same rate-limit window on 429s from providers
    this._retryDelays = [0, 300, 800]
    this._accountManager = new AccountManager(accounts, accountManagerOpts)
    this._tokenStats = new TokenStats(tokenStatsOpts)
    this._startTime = Date.now()
    this._running = false
    this._listeningPort = null
    this._server = http.createServer((req, res) => this._handleRequest(req, res))
  }

  /**
   * Start listening on 127.0.0.1.
   *
   * @returns {Promise<{ port: number }>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(this._port, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        this._running = true
        this._listeningPort = this._server.address().port
        resolve({ port: this._listeningPort })
      })
    })
  }

  /**
   * Save stats and close the server.
   *
   * @returns {Promise<void>}
   */
  stop() {
    this._tokenStats.save()
    return new Promise(resolve => {
      this._server.close(() => {
        this._running = false
        this._listeningPort = null
        resolve()
      })
    })
  }

  getStatus() {
    return {
      running: this._running,
      port: this._listeningPort,
      accountCount: this._accounts.length,
      healthByAccount: this._accountManager.getAllHealth(),
      anthropicRouting: this._anthropicRouting,
    }
  }

  _getAuthContext(req) {
    return parseProxyAuthorizationHeader(req.headers.authorization, this._proxyApiKey, req.headers['x-api-key'])
  }

  _isAuthorized(req) {
    return this._getAuthContext(req).authorized
  }

  _resolveAnthropicRequestedModel(modelId, authModelHint = null) {
    const requestedModel = normalizeRequestedModel(modelId)
    if (requestedModel && this._accountManager.hasAccountsForModel(requestedModel)) {
      return requestedModel
    }

    const mappedModel = resolveAnthropicMappedModel(requestedModel, this._anthropicRouting)
    if (mappedModel && this._accountManager.hasAccountsForModel(mappedModel)) {
      return mappedModel
    }

    // 📖 Claude Code still emits internal aliases / tier model ids for some
    // 📖 background and helper paths. Keep the old auth-token hint as a final
    // 📖 compatibility fallback for already-launched sessions, but the primary
    // 📖 routing path is now the free-claude-code style proxy-side mapping above.
    if (authModelHint && this._accountManager.hasAccountsForModel(authModelHint)) {
      if (!requestedModel || classifyClaudeVirtualModel(requestedModel) || requestedModel.toLowerCase().startsWith('claude-')) {
        return authModelHint
      }
    }

    // 📖 Last resort: when the requested model is a Claude virtual model and no routing resolved,
    // 📖 fall back to the first available account's model (free-claude-code behavior)
    if (!requestedModel || classifyClaudeVirtualModel(requestedModel) || requestedModel.toLowerCase().startsWith('claude-')) {
      const firstModel = this._accounts[0]?.modelId
      if (firstModel) return firstModel
    }

    return requestedModel
  }

  // ── Request routing ────────────────────────────────────────────────────────

  _handleRequest(req, res) {
    const pathname = getRequestPathname(req)

    // 📖 Root endpoint is unauthenticated so a browser hit on http://127.0.0.1:{port}/
    // 📖 gives a useful status payload instead of a misleading Unauthorized error.
    if (req.method === 'GET' && pathname === '/') {
      return this._handleRoot(res)
    }

    // 📖 Health endpoint is unauthenticated so external monitors can probe it
    if (req.method === 'GET' && pathname === '/v1/health') {
      return this._handleHealth(res)
    }

    const authContext = this._getAuthContext(req)
    if (!authContext.authorized) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      this._handleModels(res)
    } else if (req.method === 'GET' && pathname === '/v1/stats') {
      this._handleStats(res)
    } else if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      this._handleChatCompletions(req, res).catch(err => {
        console.error('[proxy] Internal error:', err)
        // 📖 Return 413 for body-too-large, generic 500 for everything else — never leak stack traces
        const status = err.statusCode === 413 ? 413 : 500
        const msg = err.statusCode === 413 ? 'Request body too large' : 'Internal server error'
        sendJson(res, status, { error: msg })
      })
    } else if (req.method === 'POST' && pathname === '/v1/messages') {
      // 📖 Anthropic Messages API translation — enables Claude Code compatibility
      this._handleAnthropicMessages(req, res, authContext).catch(err => {
        console.error('[proxy] Internal error:', err)
        const status = err.statusCode === 413 ? 413 : 500
        const msg = err.statusCode === 413 ? 'Request body too large' : 'Internal server error'
        sendJson(res, status, { error: msg })
      })
    } else if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
      this._handleAnthropicCountTokens(req, res).catch(err => {
        console.error('[proxy] Internal error:', err)
        const status = err.statusCode === 413 ? 413 : 500
        const msg = err.statusCode === 413 ? 'Request body too large' : 'Internal server error'
        sendJson(res, status, { error: msg })
      })
    } else if (req.method === 'POST' && pathname === '/v1/responses') {
      this._handleResponses(req, res).catch(err => {
        console.error('[proxy] Internal error:', err)
        const status = err.statusCode === 413 ? 413 : 500
        const msg = err.statusCode === 413 ? 'Request body too large' : 'Internal server error'
        sendJson(res, status, { error: msg })
      })
    } else if (req.method === 'POST' && pathname === '/v1/completions') {
      // These legacy/alternative OpenAI endpoints are not supported by the proxy.
      // Return 501 (not 404) so callers get a clear signal instead of silently failing.
      sendJson(res, 501, {
        error: 'Not Implemented',
        message: `${pathname} is not supported by this proxy. Use POST /v1/chat/completions instead.`,
      })
    } else {
      sendJson(res, 404, { error: 'Not found' })
    }
  }

  // ── GET /v1/models ─────────────────────────────────────────────────────────

  _handleModels(res) {
    const seen = new Set()
    const data = []
    const models = []
    for (const acct of this._accounts) {
      const publicModelId = acct.proxyModelId || acct.modelId
      if (!seen.has(publicModelId)) {
        seen.add(publicModelId)
        const modelEntry = {
          id: publicModelId,
          slug: publicModelId,
          name: publicModelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'proxy',
        }
        data.push(modelEntry)
        models.push(modelEntry)
      }
    }
    sendJson(res, 200, { object: 'list', data, models })
  }

  // ── POST /v1/chat/completions ──────────────────────────────────────────────

  async _handleChatCompletions(clientReq, clientRes) {
    // 1. Read and parse request body
    const rawBody = await readBody(clientReq)
    let body
    try {
      body = JSON.parse(rawBody)
    } catch {
      return sendJson(clientRes, 400, { error: 'Invalid JSON body' })
    }

    // 2. Optional transformations (both functions return new objects, no mutation)
    if (this._compressionOpts && Array.isArray(body.messages)) {
      body = { ...body, messages: compressContext(body.messages, this._compressionOpts) }
    }
    if (this._thinkingConfig) {
      body = applyThinkingBudget(body, this._thinkingConfig)
    }

    // 3. Session fingerprint for first-attempt sticky routing
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(body.messages?.slice(-1) ?? []))
      .digest('hex')
      .slice(0, 16)

    const requestedModel = typeof body.model === 'string'
      ? body.model.replace(/^fcm-proxy\//, '')
      : undefined

    // 4. Early check: if a specific model is requested but has no registered accounts,
    // return 404 immediately with a clear message rather than silently failing.
    if (requestedModel && !this._accountManager.hasAccountsForModel(requestedModel)) {
      return sendJson(clientRes, 404, {
        error: 'Model not found',
        message: `Model '${requestedModel}' is not available through this proxy. Use GET /v1/models to list available models.`,
      })
    }

    const formatSwitchReason = (classified) => {
      switch (classified?.type) {
        case 'QUOTA_EXHAUSTED':
          return 'quota'
        case 'RATE_LIMITED':
          return '429'
        case 'MODEL_NOT_FOUND':
          return '404'
        case 'MODEL_CAPACITY':
          return 'capacity'
        case 'SERVER_ERROR':
          return '5xx'
        case 'NETWORK_ERROR':
          return 'network'
        default:
          return 'retry'
      }
    }

    // 5. Retry loop with progressive backoff
    let pendingSwitchReason = null
    let previousAccount = null
    for (let attempt = 0; attempt < this._retries; attempt++) {
      // 📖 Apply backoff delay before retries (first attempt is immediate)
      const delay = this._retryDelays[Math.min(attempt, this._retryDelays.length - 1)]
      if (delay > 0) await new Promise(r => setTimeout(r, delay + Math.random() * 100))

      // First attempt: respect sticky session.
      // Subsequent retries: fresh P2C (don't hammer the same failed account).
      const selectOpts = attempt === 0
        ? { sessionFingerprint: fingerprint, requestedModel }
        : { requestedModel }
      const account = this._accountManager.selectAccount(selectOpts)
      if (!account) break // No available accounts → fall through to 503

      const result = await this._forwardRequest(account, body, clientRes, {
        requestedModel,
        switched: attempt > 0,
        switchReason: pendingSwitchReason,
        switchedFromProviderKey: previousAccount?.providerKey,
        switchedFromModelId: previousAccount?.modelId,
      })

      // Response fully sent (success JSON or SSE pipe established)
      if (result.done) return

      // Error path: classify → record → retry or forward error
      const { statusCode, responseBody, responseHeaders, networkError } = result
      const classified = classifyError(
        networkError ? 0 : statusCode,
        responseBody || '',
        responseHeaders || {}
      )

      this._accountManager.recordFailure(account.id, classified, { providerKey: account.providerKey })
      if (responseHeaders) {
        const quotaUpdated = this._accountManager.updateQuota(account.id, responseHeaders)
        this._persistQuotaSnapshot(account, quotaUpdated)
      }

      if (!classified.shouldRetry) {
        // Non-retryable (auth error, unknown) → return upstream response directly
        return sendJson(
          clientRes,
          statusCode || 500,
          responseBody || JSON.stringify({ error: 'Upstream error' })
        )
      }
      // shouldRetry === true → next attempt
      pendingSwitchReason = formatSwitchReason(classified)
      previousAccount = account
    }

    // All retries consumed, or no accounts available from the start
    sendJson(clientRes, 503, { error: 'All accounts exhausted or unavailable' })
  }

  // ── Upstream forwarding ────────────────────────────────────────────────────

  /**
   * Forward one attempt to the upstream API.
   *
   * Resolves with:
   *   { done: true }
   *     — The response has been committed to clientRes (success JSON sent, or
   *       SSE pipe established).  The retry loop must return immediately.
   *
   *   { done: false, statusCode, responseBody, responseHeaders, networkError }
   *     — An error occurred; the retry loop decides whether to retry or give up.
   *
   * @param {{ id: string, apiKey: string, modelId: string, url: string }} account
   * @param {object} body
   * @param {http.ServerResponse} clientRes
   * @param {{ requestedModel?: string, switched?: boolean, switchReason?: string|null, switchedFromProviderKey?: string, switchedFromModelId?: string }} [logContext]
   * @returns {Promise<{ done: boolean }>}
   */
  _forwardRequest(account, body, clientRes, logContext = {}) {
    return new Promise(resolve => {
      // Replace client-supplied model name with the account's model ID
      const newBody = { ...body, model: account.modelId }
      const bodyStr = JSON.stringify(newBody)

      // Build the full upstream URL from the account's base URL
      const baseUrl = account.url.replace(/\/$/, '')
      let upstreamUrl
      try {
        upstreamUrl = new URL(baseUrl + '/chat/completions')
      } catch {
        // 📖 Malformed upstream URL — resolve as network error so retry loop can continue
        return resolve({ done: false, statusCode: 0, responseBody: 'Invalid upstream URL', networkError: true })
      }

      // Choose http or https module BEFORE creating the request
      const client = selectClient(account.url)
      const startTime = Date.now()

      const requestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: upstreamUrl.pathname + (upstreamUrl.search || ''),
        method: 'POST',
        headers: {
          'authorization': `Bearer ${account.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      }

      const upstreamReq = client.request(requestOptions, upstreamRes => {
        const { statusCode } = upstreamRes
        const headers = upstreamRes.headers
        const contentType = headers['content-type'] || ''
        const isSSE = contentType.includes('text/event-stream')

        if (statusCode >= 200 && statusCode < 300) {
          if (isSSE) {
            // ── SSE passthrough: MUST NOT buffer ──────────────────────────
            const strippedHeaders = stripRateLimitHeaders(headers)
            clientRes.writeHead(statusCode, {
              ...strippedHeaders,
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            })

            // Tap the data stream to capture usage from the last data line.
            // Register BEFORE pipe() so both listeners share the same event queue.
            // 📖 sseLineBuffer persists between chunks to handle lines split across boundaries
            let lastChunkData = ''
            let sseLineBuffer = ''
            upstreamRes.on('data', chunk => {
              sseLineBuffer += chunk.toString()
              const lines = sseLineBuffer.split('\n')
              // 📖 Last element may be an incomplete line — keep it for next chunk
              sseLineBuffer = lines.pop() || ''
              for (const line of lines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  lastChunkData = line.slice(6).trim()
                }
              }
            })

            upstreamRes.on('end', () => {
              let promptTokens = 0
              let completionTokens = 0
              try {
                const parsed = JSON.parse(lastChunkData)
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0
                  completionTokens = parsed.usage.completion_tokens || 0
                }
              } catch { /* no usage in stream — ignore */ }
              // Always record every upstream attempt so the log page shows real requests
              this._tokenStats.record({
                accountId: account.id,
                modelId: account.modelId,
                providerKey: account.providerKey,
                statusCode,
                requestType: 'chat.completions',
                promptTokens,
                completionTokens,
                latencyMs: Date.now() - startTime,
                success: true,
                requestedModelId: logContext.requestedModel,
                switched: logContext.switched === true,
                switchReason: logContext.switchReason,
                switchedFromProviderKey: logContext.switchedFromProviderKey,
                switchedFromModelId: logContext.switchedFromModelId,
              })
              this._accountManager.recordSuccess(account.id, Date.now() - startTime)
              const quotaUpdated = this._accountManager.updateQuota(account.id, headers)
              this._persistQuotaSnapshot(account, quotaUpdated)
            })

            // 📖 Error handlers on both sides of the pipe to prevent uncaught errors
            upstreamRes.on('error', err => { if (!clientRes.destroyed) clientRes.destroy(err) })
            clientRes.on('error', () => { if (!upstreamRes.destroyed) upstreamRes.destroy() })

            // Pipe after listeners are registered; upstream → client, no buffering
            upstreamRes.pipe(clientRes)

            // ── Downstream disconnect cleanup ─────────────────────────────
            // If the client closes its connection mid-stream, destroy the
            // upstream request and response promptly so we don't hold the
            // upstream connection open indefinitely.
            clientRes.on('close', () => {
              if (!upstreamRes.destroyed) upstreamRes.destroy()
              if (!upstreamReq.destroyed) upstreamReq.destroy()
            })

            // The pipe handles the rest asynchronously; signal done to retry loop
            resolve({ done: true })
          } else {
            // ── JSON response ─────────────────────────────────────────────
            const chunks = []
            upstreamRes.on('data', chunk => chunks.push(chunk))
            upstreamRes.on('end', () => {
              const responseBody = Buffer.concat(chunks).toString()
              const latencyMs = Date.now() - startTime

              const quotaUpdated = this._accountManager.updateQuota(account.id, headers)
              this._accountManager.recordSuccess(account.id, latencyMs)
              this._persistQuotaSnapshot(account, quotaUpdated)

              // Always record every upstream attempt so the log page shows real requests.
              // Extract tokens if upstream provides them; default to 0 when not present.
              let promptTokens = 0
              let completionTokens = 0
              try {
                const parsed = JSON.parse(responseBody)
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0
                  completionTokens = parsed.usage.completion_tokens || 0
                }
              } catch { /* non-JSON body — tokens stay 0 */ }
              this._tokenStats.record({
                accountId: account.id,
                modelId: account.modelId,
                providerKey: account.providerKey,
                statusCode,
                requestType: 'chat.completions',
                promptTokens,
                completionTokens,
                latencyMs,
                success: true,
                requestedModelId: logContext.requestedModel,
                switched: logContext.switched === true,
                switchReason: logContext.switchReason,
                switchedFromProviderKey: logContext.switchedFromProviderKey,
                switchedFromModelId: logContext.switchedFromModelId,
              })

              // Forward stripped response to client
              const strippedHeaders = stripRateLimitHeaders(headers)
              clientRes.writeHead(statusCode, {
                ...strippedHeaders,
                'content-type': 'application/json',
              })
              clientRes.end(responseBody)
              resolve({ done: true })
            })
          }
        } else {
          // ── Error response: buffer for classification in retry loop ─────
          const chunks = []
          upstreamRes.on('data', chunk => chunks.push(chunk))
          upstreamRes.on('end', () => {
            const latencyMs = Date.now() - startTime
            // Log every failed upstream attempt so the log page shows real requests
            this._tokenStats.record({
              accountId: account.id,
              modelId: account.modelId,
              providerKey: account.providerKey,
              statusCode,
              requestType: 'chat.completions',
              promptTokens: 0,
              completionTokens: 0,
              latencyMs,
              success: false,
              requestedModelId: logContext.requestedModel,
              switched: logContext.switched === true,
              switchReason: logContext.switchReason,
              switchedFromProviderKey: logContext.switchedFromProviderKey,
              switchedFromModelId: logContext.switchedFromModelId,
            })
            resolve({
              done: false,
              statusCode,
              responseBody: Buffer.concat(chunks).toString(),
              responseHeaders: headers,
              networkError: false,
            })
          })
        }
      })

      upstreamReq.on('error', err => {
        // TCP / DNS / timeout errors — log as network failure
        const latencyMs = Date.now() - startTime
        this._tokenStats.record({
          accountId: account.id,
          modelId: account.modelId,
          providerKey: account.providerKey,
          statusCode: 0,
          requestType: 'chat.completions',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs,
          success: false,
          requestedModelId: logContext.requestedModel,
          switched: logContext.switched === true,
          switchReason: logContext.switchReason,
          switchedFromProviderKey: logContext.switchedFromProviderKey,
          switchedFromModelId: logContext.switchedFromModelId,
        })
        // TCP / DNS / timeout errors
        resolve({
          done: false,
          statusCode: 0,
          responseBody: err.message,
          responseHeaders: {},
          networkError: true,
        })
      })

      // Abort the upstream request if it exceeds the configured timeout.
      // This prevents indefinite hangs (e.g. nvidia returning 504 after 302 s).
      // The 'timeout' event fires but does NOT automatically abort; we must call destroy().
      upstreamReq.setTimeout(this._upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error(`Upstream request timed out after ${this._upstreamTimeoutMs}ms`))
      })

      upstreamReq.write(bodyStr)
      upstreamReq.end()
    })
  }

  /**
   * Persist a quota snapshot for the given account into TokenStats.
   * Called after every `AccountManager.updateQuota()` so TUI can read fresh data.
   * Never exposes apiKey.
   *
   * @param {{ id: string, providerKey?: string, modelId?: string }} account
   * @param {boolean} quotaUpdated
   */
  _persistQuotaSnapshot(account, quotaUpdated = true) {
    if (!quotaUpdated) return
    const health = this._accountManager.getHealth(account.id)
    if (!health) return
    this._tokenStats.updateQuotaSnapshot(account.id, {
      quotaPercent: health.quotaPercent,
      ...(account.providerKey !== undefined && { providerKey: account.providerKey }),
      ...(account.modelId !== undefined && { modelId: account.modelId }),
    })
  }

  // ── GET /v1/health ──────────────────────────────────────────────────────────

  /**
   * 📖 Friendly unauthenticated landing endpoint for browsers and quick local checks.
   */
  _handleRoot(res) {
    const status = this.getStatus()
    const uniqueModels = new Set(this._accounts.map(acct => acct.proxyModelId || acct.modelId)).size
    sendJson(res, 200, {
      status: 'ok',
      service: 'fcm-proxy-v2',
      running: status.running,
      accountCount: status.accountCount,
      modelCount: uniqueModels,
      endpoints: {
        health: '/v1/health',
        models: '/v1/models',
        stats: '/v1/stats',
      },
    })
  }

  /**
   * 📖 Health endpoint for daemon liveness checks. Unauthenticated so external
   * monitors (TUI, launchctl, systemd) can probe without needing the token.
   */
  _handleHealth(res) {
    const status = this.getStatus()
    sendJson(res, 200, {
      status: 'ok',
      uptime: process.uptime(),
      port: status.port,
      accountCount: status.accountCount,
      running: status.running,
    })
  }

  // ── GET /v1/stats ──────────────────────────────────────────────────────────

  /**
   * 📖 Authenticated stats endpoint — returns per-account health, token stats summary,
   * and proxy uptime. Useful for monitoring and debugging.
   */
  _handleStats(res) {
    const healthByAccount = this._accountManager.getAllHealth()
    const summary = this._tokenStats.getSummary()

    // 📖 Compute totals from the summary data
    const dailyEntries = Object.values(summary.daily || {})
    const totalRequests = dailyEntries.reduce((sum, d) => sum + (d.requests || 0), 0)
    const totalTokens = dailyEntries.reduce((sum, d) => sum + (d.tokens || 0), 0)

    sendJson(res, 200, {
      accounts: healthByAccount,
      tokenStats: {
        byModel: summary.byModel || {},
        recentRequests: summary.recentRequests || [],
      },
      anthropicRouting: this._anthropicRouting,
      totals: {
        requests: totalRequests,
        tokens: totalTokens,
      },
      uptime: Math.floor((Date.now() - this._startTime) / 1000),
    })
  }

  // ── POST /v1/messages (Anthropic translation) ──────────────────────────────

  /**
   * 📖 Handle Anthropic Messages API requests by translating to OpenAI format,
   * forwarding through the existing chat completions handler, then translating
   * the response back to Anthropic format.
   *
   * 📖 This makes Claude Code work natively through the FCM proxy.
   */
  async _handleAnthropicMessages(clientReq, clientRes, authContext = { modelHint: null }) {
    const rawBody = await readBody(clientReq)
    let anthropicBody
    try {
      anthropicBody = JSON.parse(rawBody)
    } catch {
      return sendJson(clientRes, 400, { error: { type: 'invalid_request_error', message: 'Invalid JSON body' } })
    }

    // 📖 Translate Anthropic → OpenAI
    const openaiBody = translateAnthropicToOpenAI(anthropicBody)
    const resolvedModel = this._resolveAnthropicRequestedModel(openaiBody.model, authContext.modelHint)
    if (resolvedModel) openaiBody.model = resolvedModel
    const isStreaming = openaiBody.stream === true

    if (isStreaming) {
      // 📖 Streaming mode: pipe through SSE transformer
      await this._handleAnthropicMessagesStreaming(openaiBody, anthropicBody.model, clientRes)
    } else {
      // 📖 JSON mode: forward, translate response, return
      await this._handleAnthropicMessagesJson(openaiBody, anthropicBody.model, clientRes)
    }
  }

  /**
   * 📖 Count tokens for Anthropic Messages requests without calling upstream.
   * 📖 Claude Code uses this endpoint for budgeting / UI hints, so a fast local
   * 📖 estimate is enough to keep the flow working through the proxy.
   */
  async _handleAnthropicCountTokens(clientReq, clientRes) {
    const rawBody = await readBody(clientReq)
    let anthropicBody
    try {
      anthropicBody = JSON.parse(rawBody)
    } catch {
      return sendJson(clientRes, 400, { error: { type: 'invalid_request_error', message: 'Invalid JSON body' } })
    }

    sendJson(clientRes, 200, {
      input_tokens: estimateAnthropicTokens(anthropicBody),
    })
  }

  /**
   * 📖 Handle OpenAI Responses API requests by translating them to chat
   * 📖 completions, forwarding through the existing proxy path, then converting
   * 📖 the result back to the Responses wire format.
   */
  async _handleResponses(clientReq, clientRes) {
    const rawBody = await readBody(clientReq)
    let responsesBody
    try {
      responsesBody = JSON.parse(rawBody)
    } catch {
      return sendJson(clientRes, 400, { error: 'Invalid JSON body' })
    }

    const isStreaming = responsesBody.stream === true || String(clientReq.headers.accept || '').includes('text/event-stream')
    const openaiBody = translateResponsesToOpenAI({ ...responsesBody, stream: isStreaming })

    if (isStreaming) {
      await this._handleResponsesStreaming(openaiBody, responsesBody.model, clientRes)
    } else {
      await this._handleResponsesJson(openaiBody, responsesBody.model, clientRes)
    }
  }

  async _handleResponsesJson(openaiBody, requestModel, clientRes) {
    const capturedChunks = []
    let capturedStatusCode = 200
    let capturedHeaders = {}

    const fakeRes = {
      headersSent: false,
      destroyed: false,
      socket: null,
      writeHead(statusCode, headers) {
        capturedStatusCode = statusCode
        capturedHeaders = headers || {}
        this.headersSent = true
      },
      write(chunk) { capturedChunks.push(chunk) },
      end(data) {
        if (data) capturedChunks.push(data)
      },
      on() { return this },
      once() { return this },
      emit() { return false },
      destroy() { this.destroyed = true },
      removeListener() { return this },
    }

    await this._handleChatCompletionsInternal(openaiBody, fakeRes)

    const responseBody = capturedChunks.join('')
    if (capturedStatusCode >= 200 && capturedStatusCode < 300) {
      try {
        const openaiResponse = JSON.parse(responseBody)
        const responsesResponse = translateOpenAIToResponses(openaiResponse, requestModel)
        sendJson(clientRes, 200, responsesResponse)
      } catch {
        sendJson(clientRes, capturedStatusCode, responseBody)
      }
      return
    }

    // 📖 Forward upstream-style JSON errors unchanged for OpenAI-compatible clients.
    sendJson(clientRes, capturedStatusCode, responseBody)
  }

  async _handleResponsesStreaming(openaiBody, requestModel, clientRes) {
    const { transform } = createResponsesSSETransformer(requestModel)
    await this._handleResponsesStreamDirect(openaiBody, clientRes, transform)
  }

  async _handleResponsesStreamDirect(openaiBody, clientRes, sseTransform) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(openaiBody.messages?.slice(-1) ?? []))
      .digest('hex')
      .slice(0, 16)

    const requestedModel = typeof openaiBody.model === 'string'
      ? openaiBody.model.replace(/^fcm-proxy\//, '')
      : undefined

    if (requestedModel && !this._accountManager.hasAccountsForModel(requestedModel)) {
      return sendJson(clientRes, 404, {
        error: 'Model not found',
        message: `Model '${requestedModel}' is not available.`,
      })
    }

    sseTransform.pipe(clientRes)

    for (let attempt = 0; attempt < this._retries; attempt++) {
      const delay = this._retryDelays[Math.min(attempt, this._retryDelays.length - 1)]
      if (delay > 0) await new Promise(r => setTimeout(r, delay + Math.random() * 100))

      const selectOpts = attempt === 0
        ? { sessionFingerprint: fingerprint, requestedModel }
        : { requestedModel }
      const account = this._accountManager.selectAccount(selectOpts)
      if (!account) break

      const result = await this._forwardRequestForResponsesStream(account, openaiBody, sseTransform, clientRes)
      if (result.done) return

      const { statusCode, responseBody, responseHeaders, networkError } = result
      const classified = classifyError(
        networkError ? 0 : statusCode,
        responseBody || '',
        responseHeaders || {}
      )
      this._accountManager.recordFailure(account.id, classified, { providerKey: account.providerKey })
      if (!classified.shouldRetry) {
        sseTransform.end()
        return sendJson(clientRes, statusCode || 500, responseBody || JSON.stringify({ error: 'Upstream error' }))
      }
    }

    sseTransform.end()
    sendJson(clientRes, 503, { error: 'All accounts exhausted or unavailable' })
  }

  /**
   * 📖 Handle non-streaming Anthropic Messages by internally dispatching to
   * chat completions logic and translating the JSON response back.
   */
  async _handleAnthropicMessagesJson(openaiBody, requestModel, clientRes) {
    // 📖 Create a fake request/response pair to capture the OpenAI response
    const capturedChunks = []
    let capturedStatusCode = 200
    let capturedHeaders = {}

    const fakeRes = {
      headersSent: false,
      destroyed: false,
      socket: null,
      writeHead(statusCode, headers) {
        capturedStatusCode = statusCode
        capturedHeaders = headers || {}
        this.headersSent = true
      },
      write(chunk) { capturedChunks.push(chunk) },
      end(data) {
        if (data) capturedChunks.push(data)
      },
      on() { return this },
      once() { return this },
      emit() { return false },
      destroy() { this.destroyed = true },
      removeListener() { return this },
    }

    // 📖 Build a fake IncomingMessage-like with pre-parsed body
    const fakeReq = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(JSON.stringify(openaiBody)))
        if (event === 'end') cb()
        return this
      },
      removeListener() { return this },
    }

    // 📖 Use internal handler directly instead of fake request
    await this._handleChatCompletionsInternal(openaiBody, fakeRes)

    const responseBody = capturedChunks.join('')

    if (capturedStatusCode >= 200 && capturedStatusCode < 300) {
      try {
        const openaiResponse = JSON.parse(responseBody)
        const anthropicResponse = translateOpenAIToAnthropic(openaiResponse, requestModel)
        sendJson(clientRes, 200, anthropicResponse)
      } catch {
        // 📖 Couldn't parse — forward raw
        sendJson(clientRes, capturedStatusCode, responseBody)
      }
    } else {
      // 📖 Error — wrap in Anthropic error format
      sendJson(clientRes, capturedStatusCode, {
        type: 'error',
        error: { type: 'api_error', message: responseBody },
      })
    }
  }

  /**
   * 📖 Handle streaming Anthropic Messages by forwarding as streaming OpenAI
   * chat completions and piping through the SSE translator.
   */
  async _handleAnthropicMessagesStreaming(openaiBody, requestModel, clientRes) {
    // 📖 We need to intercept the SSE response and translate it
    const { transform, getUsage } = createAnthropicSSETransformer(requestModel)

    let resolveForward
    const forwardPromise = new Promise(r => { resolveForward = r })

    const fakeRes = {
      headersSent: false,
      destroyed: false,
      socket: null,
      writeHead(statusCode, headers) {
        this.headersSent = true
        if (statusCode >= 200 && statusCode < 300) {
          // 📖 Write Anthropic SSE headers
          clientRes.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          })
        } else {
          clientRes.writeHead(statusCode, headers)
        }
      },
      write(chunk) { /* SSE data handled via pipe */ },
      end(data) {
        if (data && !this.headersSent) {
          // 📖 Non-streaming error response
          clientRes.end(data)
        }
        resolveForward()
      },
      on() { return this },
      once() { return this },
      emit() { return false },
      destroy() { this.destroyed = true },
      removeListener() { return this },
    }

    // 📖 Actually we need to pipe the upstream SSE through our transformer.
    // 📖 The simplest approach: use _handleChatCompletionsInternal with stream=true
    // 📖 and capture the piped response through our transformer.

    // 📖 For streaming, we go lower level — use the retry loop directly
    await this._handleAnthropicStreamDirect(openaiBody, requestModel, clientRes, transform)
  }

  /**
   * 📖 Direct streaming handler for Anthropic messages.
   * 📖 Runs the retry loop, pipes upstream SSE through the Anthropic transformer.
   */
  async _handleAnthropicStreamDirect(openaiBody, requestModel, clientRes, sseTransform) {
    const { createHash: _createHash } = await import('node:crypto')
    const fingerprint = _createHash('sha256')
      .update(JSON.stringify(openaiBody.messages?.slice(-1) ?? []))
      .digest('hex')
      .slice(0, 16)

    const requestedModel = typeof openaiBody.model === 'string'
      ? openaiBody.model.replace(/^fcm-proxy\//, '')
      : undefined

    if (requestedModel && !this._accountManager.hasAccountsForModel(requestedModel)) {
      return sendJson(clientRes, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: `Model '${requestedModel}' is not available.` },
      })
    }

    // 📖 Pipe the transform to client
    sseTransform.pipe(clientRes)

    for (let attempt = 0; attempt < this._retries; attempt++) {
      // 📖 Progressive backoff for retries (same as chat completions)
      const delay = this._retryDelays[Math.min(attempt, this._retryDelays.length - 1)]
      if (delay > 0) await new Promise(r => setTimeout(r, delay + Math.random() * 100))

      const selectOpts = attempt === 0
        ? { sessionFingerprint: fingerprint, requestedModel }
        : { requestedModel }
      const account = this._accountManager.selectAccount(selectOpts)
      if (!account) break

      const result = await this._forwardRequestForAnthropicStream(account, openaiBody, sseTransform, clientRes)

      if (result.done) return

      const { statusCode, responseBody, responseHeaders, networkError } = result
      const classified = classifyError(
        networkError ? 0 : statusCode,
        responseBody || '',
        responseHeaders || {}
      )
      this._accountManager.recordFailure(account.id, classified, { providerKey: account.providerKey })
      if (!classified.shouldRetry) {
        sseTransform.end()
        return sendJson(clientRes, statusCode || 500, {
          type: 'error',
          error: { type: 'api_error', message: responseBody || 'Upstream error' },
        })
      }
    }

    sseTransform.end()
    sendJson(clientRes, 503, {
      type: 'error',
      error: { type: 'overloaded_error', message: 'All accounts exhausted or unavailable' },
    })
  }

  /**
   * 📖 Forward a streaming request to upstream and pipe SSE through transform.
   */
  _forwardRequestForAnthropicStream(account, body, sseTransform, clientRes) {
    return new Promise(resolve => {
      const newBody = { ...body, model: account.modelId, stream: true }
      const bodyStr = JSON.stringify(newBody)
      const baseUrl = account.url.replace(/\/$/, '')
      let upstreamUrl
      try {
        upstreamUrl = new URL(baseUrl + '/chat/completions')
      } catch {
        return resolve({ done: false, statusCode: 0, responseBody: 'Invalid upstream URL', networkError: true })
      }
      const client = selectClient(account.url)
      const startTime = Date.now()

      const requestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: upstreamUrl.pathname + (upstreamUrl.search || ''),
        method: 'POST',
        headers: {
          'authorization': `Bearer ${account.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      }

      const upstreamReq = client.request(requestOptions, upstreamRes => {
        const { statusCode } = upstreamRes

        if (statusCode >= 200 && statusCode < 300) {
          // 📖 Write Anthropic SSE headers if not already sent
          if (!clientRes.headersSent) {
            clientRes.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            })
          }

          // 📖 Error handlers on both sides of the pipe to prevent uncaught errors
          upstreamRes.on('error', err => { if (!clientRes.destroyed) clientRes.destroy(err) })
          clientRes.on('error', () => { if (!upstreamRes.destroyed) upstreamRes.destroy() })

          // 📖 Pipe upstream SSE through Anthropic translator
          upstreamRes.pipe(sseTransform, { end: true })

          upstreamRes.on('end', () => {
            this._accountManager.recordSuccess(account.id, Date.now() - startTime)
          })

          clientRes.on('close', () => {
            if (!upstreamRes.destroyed) upstreamRes.destroy()
            if (!upstreamReq.destroyed) upstreamReq.destroy()
          })

          resolve({ done: true })
        } else {
          const chunks = []
          upstreamRes.on('data', chunk => chunks.push(chunk))
          upstreamRes.on('end', () => {
            resolve({
              done: false,
              statusCode,
              responseBody: Buffer.concat(chunks).toString(),
              responseHeaders: upstreamRes.headers,
              networkError: false,
            })
          })
        }
      })

      upstreamReq.on('error', err => {
        resolve({
          done: false,
          statusCode: 0,
          responseBody: err.message,
          responseHeaders: {},
          networkError: true,
        })
      })

      upstreamReq.setTimeout(this._upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error(`Upstream request timed out after ${this._upstreamTimeoutMs}ms`))
      })

      upstreamReq.write(bodyStr)
      upstreamReq.end()
    })
  }

  /**
   * 📖 Forward a streaming chat-completions request and translate the upstream
   * 📖 SSE stream into Responses API events on the fly.
   */
  _forwardRequestForResponsesStream(account, body, sseTransform, clientRes) {
    return new Promise(resolve => {
      const newBody = { ...body, model: account.modelId, stream: true }
      const bodyStr = JSON.stringify(newBody)
      const baseUrl = account.url.replace(/\/$/, '')
      let upstreamUrl
      try {
        upstreamUrl = new URL(baseUrl + '/chat/completions')
      } catch {
        return resolve({ done: false, statusCode: 0, responseBody: 'Invalid upstream URL', networkError: true })
      }

      const client = selectClient(account.url)
      const startTime = Date.now()
      const requestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: upstreamUrl.pathname + (upstreamUrl.search || ''),
        method: 'POST',
        headers: {
          'authorization': `Bearer ${account.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      }

      const upstreamReq = client.request(requestOptions, upstreamRes => {
        const { statusCode } = upstreamRes

        if (statusCode >= 200 && statusCode < 300) {
          if (!clientRes.headersSent) {
            clientRes.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            })
          }

          upstreamRes.on('error', err => { if (!clientRes.destroyed) clientRes.destroy(err) })
          clientRes.on('error', () => { if (!upstreamRes.destroyed) upstreamRes.destroy() })

          upstreamRes.pipe(sseTransform, { end: true })
          upstreamRes.on('end', () => {
            this._accountManager.recordSuccess(account.id, Date.now() - startTime)
          })

          clientRes.on('close', () => {
            if (!upstreamRes.destroyed) upstreamRes.destroy()
            if (!upstreamReq.destroyed) upstreamReq.destroy()
          })

          resolve({ done: true })
        } else {
          const chunks = []
          upstreamRes.on('data', chunk => chunks.push(chunk))
          upstreamRes.on('end', () => {
            resolve({
              done: false,
              statusCode,
              responseBody: Buffer.concat(chunks).toString(),
              responseHeaders: upstreamRes.headers,
              networkError: false,
            })
          })
        }
      })

      upstreamReq.on('error', err => {
        resolve({
          done: false,
          statusCode: 0,
          responseBody: err.message,
          responseHeaders: {},
          networkError: true,
        })
      })

      upstreamReq.setTimeout(this._upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error(`Upstream request timed out after ${this._upstreamTimeoutMs}ms`))
      })

      upstreamReq.write(bodyStr)
      upstreamReq.end()
    })
  }

  /**
   * 📖 Internal version of chat completions handler that takes a pre-parsed body.
   * 📖 Used by the Anthropic JSON translation path to avoid re-parsing.
   */
  async _handleChatCompletionsInternal(body, clientRes) {
    // 📖 Reuse the exact same logic as _handleChatCompletions but with pre-parsed body
    if (this._compressionOpts && Array.isArray(body.messages)) {
      body = { ...body, messages: compressContext(body.messages, this._compressionOpts) }
    }
    if (this._thinkingConfig) {
      body = applyThinkingBudget(body, this._thinkingConfig)
    }

    const fingerprint = createHash('sha256')
      .update(JSON.stringify(body.messages?.slice(-1) ?? []))
      .digest('hex')
      .slice(0, 16)

    const requestedModel = typeof body.model === 'string'
      ? body.model.replace(/^fcm-proxy\//, '')
      : undefined

    if (requestedModel && !this._accountManager.hasAccountsForModel(requestedModel)) {
      return sendJson(clientRes, 404, {
        error: 'Model not found',
        message: `Model '${requestedModel}' is not available.`,
      })
    }

    for (let attempt = 0; attempt < this._retries; attempt++) {
      const delay = this._retryDelays[Math.min(attempt, this._retryDelays.length - 1)]
      if (delay > 0) await new Promise(r => setTimeout(r, delay + Math.random() * 100))

      const selectOpts = attempt === 0
        ? { sessionFingerprint: fingerprint, requestedModel }
        : { requestedModel }
      const account = this._accountManager.selectAccount(selectOpts)
      if (!account) break

      const result = await this._forwardRequest(account, body, clientRes, { requestedModel })
      if (result.done) return

      const { statusCode, responseBody, responseHeaders, networkError } = result
      const classified = classifyError(
        networkError ? 0 : statusCode,
        responseBody || '',
        responseHeaders || {}
      )
      this._accountManager.recordFailure(account.id, classified, { providerKey: account.providerKey })
      if (!classified.shouldRetry) {
        return sendJson(clientRes, statusCode || 500, responseBody || JSON.stringify({ error: 'Upstream error' }))
      }
    }

    sendJson(clientRes, 503, { error: 'All accounts exhausted or unavailable' })
  }

  // ── Hot-reload accounts ─────────────────────────────────────────────────────

  /**
   * 📖 Atomically swap the account list and rebuild the AccountManager.
   * 📖 Used by the daemon when config changes (new API keys, providers toggled).
   * 📖 In-flight requests on old accounts will finish naturally.
   *
   * @param {Array} accounts — new account list
   * @param {{ model?: string|null, modelOpus?: string|null, modelSonnet?: string|null, modelHaiku?: string|null }} anthropicRouting
   */
  updateAccounts(accounts, anthropicRouting = this._anthropicRouting) {
    this._accounts = accounts
    this._anthropicRouting = normalizeAnthropicRouting(anthropicRouting)
    this._accountManager = new AccountManager(accounts, {})
  }
}
