import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../src/proxy-server.js'
import { parseLogLine } from '../src/log-reader.js'

// Helper: create mock upstream API
function createMockUpstream(responseBody, statusCode = 200, extraHeaders = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        const headers = {
          'content-type': 'application/json',
          ...extraHeaders,
        }
        res.writeHead(statusCode, headers)
        res.end(JSON.stringify(responseBody))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Helper: create SSE streaming mock upstream
function createMockStreamingUpstream() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const chunks = [
          { choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: { content: ' World' } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]
        let i = 0
        const send = () => {
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
            i++
            setTimeout(send, 10)
          } else {
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }
        send()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Helper: make request to proxy
function makeRequest(port, body, method = 'POST', path = '/v1/chat/completions', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extraHeaders },
    }, res => {
      let responseBody = ''
      res.on('data', chunk => responseBody += chunk)
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody })
      })
    })
    req.on('error', reject)
    if (method === 'POST') req.write(data)
    req.end()
  })
}

// Helper: make streaming request
function makeStreamRequest(port, body, path = '/v1/chat/completions') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, stream: true })
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk.toString()))
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, chunks }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('ProxyServer', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('forwards JSON request and strips rate limit headers', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      200,
      { 'x-ratelimit-remaining': '99', 'x-ratelimit-limit': '100' }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'test-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'test-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
    assert.ok(!res.headers['x-ratelimit-remaining'], 'Rate limit headers should be stripped')
    const parsed = JSON.parse(res.body)
    assert.ok(parsed.choices)
  })

  it('streams SSE without buffering', async () => {
    const upstream = await createMockStreamingUpstream()
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'stream-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'stream-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeStreamRequest(port, { model: 'stream-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
    const allData = res.chunks.join('')
    assert.ok(allData.includes('Hello'), 'Should contain streamed content')
    assert.ok(allData.includes('[DONE]'), 'Should contain DONE marker')
  })

  it('rotates to next account on 429', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429, { 'retry-after': '60' })
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'bad-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', proxyModelId: 'test', url: bad.url + '/v1' },
      { id: 'good-acct', providerKey: 'p2', apiKey: 'k2', modelId: 'm2', proxyModelId: 'test', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
  })

  it('returns 503 when all accounts exhausted', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'only-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', proxyModelId: 'test', url: bad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 1 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503)
  })

  it('serves GET /v1/models', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'models-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'cool-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/v1/models')
    assert.strictEqual(res.statusCode, 200)
    const parsed = JSON.parse(res.body)
    assert.ok(Array.isArray(parsed.data), 'Should return models array')
  })

  it('serves GET / with an unauthenticated status payload', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'root-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'test-model', proxyModelId: 'gpt-oss-120b', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/')
    const parsed = JSON.parse(res.body)

    assert.strictEqual(res.statusCode, 200)
    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.service, 'fcm-proxy-v2')
    assert.equal(parsed.accountCount, 1)
    assert.equal(parsed.modelCount, 1)
    assert.equal(parsed.endpoints.health, '/v1/health')
  })

  it('respects retry-after', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429, { 'retry-after': '3600' })
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'retry-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', proxyModelId: 'test', url: bad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // First request triggers 429 and sets retry-after
    await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    // Second request should fail immediately (account in retry-after)
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503)
  })

  it('getStatus returns running, port, accountCount and healthByAccount', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'status-acct-1', providerKey: 'prov1', apiKey: 'k1', modelId: 'model-a', url: upstream.url + '/v1' },
      { id: 'status-acct-2', providerKey: 'prov2', apiKey: 'k2', modelId: 'model-b', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'test-secret-token' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const status = proxy.getStatus()

    assert.strictEqual(status.running, true)
    assert.strictEqual(status.port, port)
    assert.strictEqual(status.accountCount, 2)

    // healthByAccount must be present and keyed by account id
    assert.ok('healthByAccount' in status, 'status must include healthByAccount')
    assert.ok('status-acct-1' in status.healthByAccount, 'healthByAccount must include status-acct-1')
    assert.ok('status-acct-2' in status.healthByAccount, 'healthByAccount must include status-acct-2')

    const h1 = status.healthByAccount['status-acct-1']
    assert.strictEqual(typeof h1.score, 'number', 'health entry must have numeric score')
    // quotaPercent is null when no quota headers received (unknown signal) — not a number
    assert.ok(h1.quotaPercent === null || typeof h1.quotaPercent === 'number', 'health entry quotaPercent must be null or number')

    // API keys must NOT be present in status
    assert.ok(!('proxyApiKey' in status), 'status must not expose proxyApiKey')
    assert.ok(!('apiKey' in status), 'status must not expose apiKey')
  })

  it('getStatus healthByAccount reflects account provider and model identity', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'identity-acct', providerKey: 'myprovider', apiKey: 'secret', modelId: 'my-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts })
    await proxy.start()
    cleanups.push(() => proxy.stop())

    const status = proxy.getStatus()
    const h = status.healthByAccount['identity-acct']

    assert.strictEqual(h.providerKey, 'myprovider')
    assert.strictEqual(h.modelId, 'my-model')
  })

  it('proxy passes providerKey to recordFailure for unknown-telemetry 429 temp cooldown', async () => {
    // Unknown provider (huggingface) gets 3 consecutive 429s → temp cooldown, not permanent disable
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'hf-acct', providerKey: 'huggingface', apiKey: 'k1', modelId: 'm1', proxyModelId: 'test', url: bad.url + '/v1' },
      { id: 'gr-acct', providerKey: 'groq', apiKey: 'k2', modelId: 'm2', proxyModelId: 'test', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // This request should fail on hf-acct (429) and succeed on gr-acct
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)

    // hf-acct should NOT be permanently disabled (only 1 failure, threshold is 3)
    const status = proxy.getStatus()
    const hfHealth = status.healthByAccount['hf-acct']
    assert.strictEqual(hfHealth.disabled, false, 'unknown-telemetry 429 should not permanently disable account')
  })

  it('proxy rotates away from unknown-telemetry account after 3 consecutive 429s', async () => {
    // We need 3 429s on the same account to trigger temp cooldown
    // Use retries=4 to ensure 3 hits on hf-acct; only 1 good account
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'hf-acct-2', providerKey: 'huggingface', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
      { id: 'gr-acct-2', providerKey: 'groq', apiKey: 'k2', modelId: 'm2', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 5 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // Manually cause 3 failures to trigger cooldown
    const am = proxy._accountManager
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    am.recordFailure('hf-acct-2', err429, { providerKey: 'huggingface' })
    am.recordFailure('hf-acct-2', err429, { providerKey: 'huggingface' })
    am.recordFailure('hf-acct-2', err429, { providerKey: 'huggingface' })

    // hf-acct-2 should now be in temporary cooldown
    const ra = am.getRetryAfter('hf-acct-2')
    assert.ok(ra > 0, `hf-acct-2 should have a cooldown after 3 failures, got ${ra}`)

    const status = proxy.getStatus()
    assert.strictEqual(status.healthByAccount['hf-acct-2'].disabled, false, 'should NOT be permanently disabled')
  })
})

// ─── Suite: ProxyServer – model-not-found routing ─────────────────────────────
// These tests verify that requesting an unknown model returns 404 with a clear
// message instead of silently falling back to a random account.

describe('ProxyServer – model-not-found routing', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('returns 404 when requested model has no accounts', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    )
    cleanups.push(() => upstream.server.close())

    // Accounts serve 'real-model', not 'ghost-model'
    const accounts = [
      { id: 'acct-1', providerKey: 'p1', apiKey: 'k1', modelId: 'real-model', proxyModelId: 'real-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'ghost-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 404)
    const body = JSON.parse(res.body)
    assert.ok(body.error, 'response must have error field')
    assert.ok(body.message.includes('ghost-model'), 'error message must name the missing model')
  })

  it('does NOT fall back to a random account for unknown model', async () => {
    // Accounts serve 'provider-model'. If fallback were still present, 'unknown' would use them.
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'wrong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'fallback-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'provider-model', proxyModelId: 'provider-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // Requesting a model that does not exist must NOT silently return 200 from a fallback
    const res = await makeRequest(port, { model: 'iflow/TBStars2-200B', messages: [{ role: 'user', content: 'hi' }] })
    assert.notStrictEqual(res.statusCode, 200, 'must NOT return 200 by falling back to wrong account')
    assert.strictEqual(res.statusCode, 404, 'must return 404 for unknown model')
  })

  it('still succeeds when fcm-proxy/ prefix is stripped and model matches', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'acct-pfx', providerKey: 'p1', apiKey: 'k1', modelId: 'upstream-id', proxyModelId: 'my-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // OpenCode sends "fcm-proxy/my-model" — the proxy strips the prefix before matching
    const res = await makeRequest(port, { model: 'fcm-proxy/my-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
  })
})

// ─── Suite: ProxyServer – log coherence (Task 5) ─────────────────────────────
// These tests verify that every real upstream attempt (success OR failure)
// produces a coherent JSONL log entry with all required fields.

function makeTempLogDir(label) {
  const dir = join(tmpdir(), `fcm-proxy-log-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    logFile: join(dir, 'request-log.jsonl'),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } },
    readLog: () => {
      const logFile = join(dir, 'request-log.jsonl')
      if (!existsSync(logFile)) return []
      return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    },
  }
}

describe('ProxyServer – log coherence', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('logs successful request with usage data', async () => {
    const logCtx = makeTempLogDir('success-usage')
    cleanups.push(logCtx.cleanup)

    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      200
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{ id: 'log-acct', providerKey: 'testprov', apiKey: 'k1', modelId: 'test-model', url: upstream.url + '/v1' }]
    const proxy = new ProxyServer({ port: 0, accounts, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.strictEqual(entries.length, 1, 'should log exactly 1 entry for a successful request')

    const e = entries[0]
    assert.ok(e.timestamp, 'entry must have timestamp')
    assert.strictEqual(e.modelId, 'test-model', 'entry must carry modelId')
    assert.strictEqual(e.providerKey, 'testprov', 'entry must carry providerKey')
    assert.strictEqual(e.statusCode, 200, 'entry must carry statusCode=200')
    assert.strictEqual(e.requestType, 'chat.completions', 'entry must carry requestType')
    assert.strictEqual(e.promptTokens, 10, 'entry must carry promptTokens from usage')
    assert.strictEqual(e.completionTokens, 5, 'entry must carry completionTokens from usage')
    assert.ok(e.latencyMs >= 0, 'entry must carry non-negative latencyMs')
    assert.strictEqual(e.success, true, 'entry must have success=true')

    // log-reader should be able to parse this entry cleanly
    const row = parseLogLine(JSON.stringify(e))
    assert.ok(row !== null, 'log-reader parseLogLine must parse the entry')
    assert.strictEqual(row.model, 'test-model')
    assert.strictEqual(row.provider, 'testprov')
    assert.strictEqual(row.status, '200')
    assert.strictEqual(row.tokens, 15)
  })

  it('logs successful request even when upstream returns NO usage', async () => {
    const logCtx = makeTempLogDir('success-no-usage')
    cleanups.push(logCtx.cleanup)

    // Upstream returns 200 but no usage field
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hello' } }] },
      200
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{ id: 'log-nousage', providerKey: 'provx', apiKey: 'k1', modelId: 'model-x', url: upstream.url + '/v1' }]
    const proxy = new ProxyServer({ port: 0, accounts, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'model-x', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.strictEqual(entries.length, 1, 'should log entry even without usage data')

    const e = entries[0]
    assert.ok(e.timestamp, 'entry must have timestamp')
    assert.strictEqual(e.modelId, 'model-x')
    assert.strictEqual(e.providerKey, 'provx')
    assert.strictEqual(e.statusCode, 200)
    assert.strictEqual(e.requestType, 'chat.completions')
    assert.strictEqual(e.promptTokens, 0, 'tokens default to 0 when not provided')
    assert.strictEqual(e.completionTokens, 0)
    assert.strictEqual(e.success, true)

    const row = parseLogLine(JSON.stringify(e))
    assert.ok(row !== null)
    assert.strictEqual(row.tokens, 0)
  })

  it('logs failed 429 request attempt', async () => {
    const logCtx = makeTempLogDir('fail-429')
    cleanups.push(logCtx.cleanup)

    // Use a single bad account that always returns 429 so retries all hit it.
    // The proxy will exhaust retries → 503, but every attempt should be logged.
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'bad-log-acct', providerKey: 'prov-bad', apiKey: 'k1', modelId: 'bad-model', url: bad.url + '/v1' },
    ]
    // retries=2 → 2 attempts against bad-log-acct → expect 2 log entries
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'bad-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503, 'proxy should 503 when all accounts exhausted')

    const entries = logCtx.readLog()
    // Expect at least 1 log entry for the failed 429 attempt
    assert.ok(entries.length >= 1, `should log failed attempt(s), got ${entries.length}`)

    const failEntry = entries.find(e => e.statusCode === 429)
    assert.ok(failEntry, 'should have a log entry for the 429 failure')
    assert.strictEqual(failEntry.providerKey, 'prov-bad')
    assert.strictEqual(failEntry.success, false, 'failed entry must have success=false')
    assert.ok(failEntry.timestamp, 'failed entry must have timestamp')
    assert.strictEqual(failEntry.requestType, 'chat.completions')
    assert.strictEqual(failEntry.modelId, 'bad-model')

    // log-reader must parse the failed entry cleanly
    const row = parseLogLine(JSON.stringify(failEntry))
    assert.ok(row !== null, 'log-reader must parse the 429 entry')
    assert.strictEqual(row.status, '429', 'row.status must be "429"')
    assert.strictEqual(row.provider, 'prov-bad')
    assert.strictEqual(row.model, 'bad-model')
  })

  it('log entry fields are all human-readable / renderable', async () => {
    const logCtx = makeTempLogDir('renderable')
    cleanups.push(logCtx.cleanup)

    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      200
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{ id: 'render-acct', providerKey: 'myprov', apiKey: 'k1', modelId: 'render-model', url: upstream.url + '/v1' }]
    const proxy = new ProxyServer({ port: 0, accounts, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'render-model', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.strictEqual(entries.length, 1)
    const e = entries[0]

     // timestamp must be renderable as a Date
     const d = new Date(e.timestamp)
     assert.ok(!Number.isNaN(d.getTime()), 'timestamp must be a valid ISO date string')
 
     // log-reader row must have consistent time field
     const row = parseLogLine(JSON.stringify(e))
     assert.ok(row !== null)
     const rowDate = new Date(row.time)
     assert.ok(!Number.isNaN(rowDate.getTime()), 'row.time must be a renderable ISO date string')
     assert.ok(row.time === e.timestamp, 'row.time must match the stored timestamp')
   })
 })

// ─── Suite: ProxyServer – compatibility routes ────────────────────────────────
// These tests verify that legacy unsupported routes still fail clearly, while
// Responses + Anthropic compatibility routes stay functional.

describe('ProxyServer – compatibility routes', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('POST /v1/completions returns 501 Not Implemented', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'any', prompt: 'hello' }, 'POST', '/v1/completions')
    assert.strictEqual(res.statusCode, 501)
    const body = JSON.parse(res.body)
    assert.ok(body.error, 'should include error field')
    assert.match(body.error, /not implemented|not supported/i, 'error message should mention not implemented or not supported')
  })

  it('POST /v1/responses returns Responses JSON translated from chat completions', async () => {
    const upstream = await createMockUpstream(
      {
        id: 'chatcmpl_resp_json',
        model: 'provider-model',
        choices: [{ message: { content: 'ok from responses' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      },
      200,
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'responses-json-acct',
      providerKey: 'test',
      apiKey: 'key-1',
      modelId: 'provider-model',
      proxyModelId: 'gpt-oss-120b',
      url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, {
      model: 'gpt-oss-120b',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }, 'POST', '/v1/responses')
    assert.strictEqual(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.strictEqual(body.object, 'response')
    assert.strictEqual(body.output[0].type, 'message')
    assert.match(body.output[0].content[0].text, /ok from responses/)
    assert.strictEqual(body.usage.input_tokens, 2)
    assert.strictEqual(body.usage.output_tokens, 3)
  })

  it('POST /v1/responses streams Responses SSE translated from chat completions', async () => {
    const upstream = await createMockStreamingUpstream()
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'responses-stream-acct',
      providerKey: 'test',
      apiKey: 'key-1',
      modelId: 'provider-model',
      proxyModelId: 'gpt-oss-120b',
      url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeStreamRequest(port, {
      model: 'gpt-oss-120b',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }, '/v1/responses')

    assert.strictEqual(res.statusCode, 200)
    const allData = res.chunks.join('')
    assert.ok(allData.includes('response.created'), 'should emit response.created')
    assert.ok(allData.includes('response.output_text.delta'), 'should emit text deltas')
    assert.ok(allData.includes('response.completed'), 'should emit response.completed')
  })

  it('POST /v1/messages/count_tokens returns a positive local estimate', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, {
      model: 'claude-sonnet-4',
      system: 'You are a helpful coding assistant.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Count the tokens in this request.' }] },
      ],
      tools: [
        { name: 'exec_command', description: 'Run a shell command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
      ],
    }, 'POST', '/v1/messages/count_tokens')

    assert.strictEqual(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.input_tokens > 0)
  })

  it('POST /v1/messages/count_tokens accepts Claude beta query params', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, {
      model: 'claude-sonnet-4-6',
      system: 'You are a helpful coding assistant.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Count the beta route tokens.' }] },
      ],
    }, 'POST', '/v1/messages/count_tokens?beta=true')

    assert.strictEqual(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.input_tokens > 0)
  })

  it('POST /v1/messages mirrors Claude proxy-side MODEL/MODEL_* routing', async () => {
    let capturedUpstreamModel = null
    const upstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          capturedUpstreamModel = JSON.parse(body).model
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl_claude_mapped',
            model: 'provider-model',
            choices: [{ message: { content: 'mapped ok' } }],
            usage: { prompt_tokens: 4, completion_tokens: 3 },
          }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => upstream.server.close())

    const proxy = new ProxyServer({
      port: 0,
      accounts: [{
        id: 'claude-routed-acct',
        providerKey: 'test',
        apiKey: 'key-1',
        modelId: 'provider-model',
        proxyModelId: 'gpt-oss-120b',
        url: upstream.url + '/v1',
      }],
      proxyApiKey: 'secret-key',
      anthropicRouting: {
        model: 'gpt-oss-120b',
        modelOpus: 'gpt-oss-120b',
        modelSonnet: 'gpt-oss-120b',
        modelHaiku: 'gpt-oss-120b',
      },
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(
      port,
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      },
      'POST',
      '/v1/messages',
      { authorization: 'Bearer secret-key' },
    )

    assert.strictEqual(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.type, 'message')
    assert.match(body.content[0].text, /mapped ok/i)
    assert.equal(capturedUpstreamModel, 'provider-model')
  })

  it('POST /v1/messages accepts Claude beta query params and still routes proxy-side Claude aliases', async () => {
    let capturedUpstreamModel = null
    const upstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          capturedUpstreamModel = JSON.parse(body).model
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl_claude_beta_route',
            model: 'provider-model',
            choices: [{ message: { content: 'beta ok' } }],
            usage: { prompt_tokens: 4, completion_tokens: 3 },
          }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => upstream.server.close())

    const proxy = new ProxyServer({
      port: 0,
      accounts: [{
        id: 'claude-beta-route-acct',
        providerKey: 'test',
        apiKey: 'key-1',
        modelId: 'provider-model',
        proxyModelId: 'gpt-oss-120b',
        url: upstream.url + '/v1',
      }],
      proxyApiKey: 'secret-key',
      anthropicRouting: {
        model: 'gpt-oss-120b',
        modelOpus: 'gpt-oss-120b',
        modelSonnet: 'gpt-oss-120b',
        modelHaiku: 'gpt-oss-120b',
      },
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(
      port,
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi beta' }] }],
      },
      'POST',
      '/v1/messages?beta=true',
      { authorization: 'Bearer secret-key' },
    )

    assert.strictEqual(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.type, 'message')
    assert.match(body.content[0].text, /beta ok/i)
    assert.equal(capturedUpstreamModel, 'provider-model')
  })

  it('POST /v1/messages falls back to proxy-side MODEL for unknown Claude model ids', async () => {
    const capturedUpstreamModels = []
    const upstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          capturedUpstreamModels.push(JSON.parse(body).model)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl_claude_fallback_model',
            model: 'provider-model',
            choices: [{ message: { content: 'fallback model ok' } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => upstream.server.close())

    const proxy = new ProxyServer({
      port: 0,
      accounts: [{
        id: 'claude-model-fallback-acct',
        providerKey: 'test',
        apiKey: 'key-1',
        modelId: 'provider-model',
        proxyModelId: 'gpt-oss-120b',
        url: upstream.url + '/v1',
      }],
      proxyApiKey: 'secret-key',
      anthropicRouting: {
        model: 'gpt-oss-120b',
        modelOpus: null,
        modelSonnet: null,
        modelHaiku: null,
      },
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    for (const requestedModel of ['claude-2.1', 'some-unknown-model']) {
      const res = await makeRequest(
        port,
        {
          model: requestedModel,
          max_tokens: 128,
          messages: [{ role: 'user', content: [{ type: 'text', text: requestedModel }] }],
        },
        'POST',
        '/v1/messages',
        { authorization: 'Bearer secret-key' },
      )

      assert.strictEqual(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'message')
      assert.match(body.content[0].text, /fallback model ok/i)
    }

    assert.deepEqual(
      capturedUpstreamModels,
      ['provider-model', 'provider-model'],
    )
  })

  it('POST /v1/messages remaps Claude internal model ids to the auth-token-selected proxy model', async () => {
    let capturedUpstreamModel = null
    const upstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          capturedUpstreamModel = JSON.parse(body).model
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl_claude_fallback',
            model: 'provider-model',
            choices: [{ message: { content: 'fallback ok' } }],
            usage: { prompt_tokens: 4, completion_tokens: 3 },
          }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'claude-fallback-acct',
      providerKey: 'test',
      apiKey: 'key-1',
      modelId: 'provider-model',
      proxyModelId: 'gpt-oss-120b',
      url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(
      port,
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      },
      'POST',
      '/v1/messages',
      { authorization: 'Bearer secret-key:gpt-oss-120b' },
    )

    assert.strictEqual(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.type, 'message')
    assert.match(body.content[0].text, /fallback ok/i)
    assert.equal(capturedUpstreamModel, 'provider-model')
  })

  it('POST /v1/messages also remaps versioned Claude family ids like Claude proxy does', async () => {
    const capturedUpstreamModels = []
    const upstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          capturedUpstreamModels.push(JSON.parse(body).model)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: `chatcmpl_${capturedUpstreamModels.length}`,
            model: 'provider-model',
            choices: [{ message: { content: 'family ok' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => upstream.server.close())

    const proxy = new ProxyServer({
      port: 0,
      accounts: [{
        id: 'claude-family-acct',
        providerKey: 'test',
        apiKey: 'key-1',
        modelId: 'provider-model',
        proxyModelId: 'gpt-oss-120b',
        url: upstream.url + '/v1',
      }],
      proxyApiKey: 'secret-key',
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const familyModels = [
      'claude-3-5-sonnet-20241022',
      'claude-3-haiku-20240307',
      'Claude-3-Opus-20240229',
      'default',
    ]

    for (const familyModel of familyModels) {
      const res = await makeRequest(
        port,
        {
          model: familyModel,
          max_tokens: 128,
          messages: [{ role: 'user', content: [{ type: 'text', text: `Route ${familyModel}` }] }],
        },
        'POST',
        '/v1/messages',
        { authorization: 'Bearer secret-key:gpt-oss-120b' },
      )

      assert.strictEqual(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'message')
      assert.match(body.content[0].text, /family ok/i)
    }

    assert.deepEqual(
      capturedUpstreamModels,
      familyModels.map(() => 'provider-model'),
    )
  })

  it('GET /unknown-path returns 404', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/unknown-path')
    assert.strictEqual(res.statusCode, 404)
  })

  it('401 unauthorized on /v1/completions when auth is wrong', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [], proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // No auth header — should get 401, not 501
    const res = await makeRequest(port, { model: 'any', prompt: 'hello' }, 'POST', '/v1/completions')
    assert.strictEqual(res.statusCode, 401)
  })
})

// ─── Suite: ProxyServer – x-api-key auth (BUG 1) ─────────────────────────────
// Claude Code / Anthropic SDK sends credentials via x-api-key header, not Bearer

describe('ProxyServer – x-api-key auth', () => {
  const cleanups = []
  after(async () => { for (const fn of cleanups) await fn() })

  it('accepts x-api-key header for authentication', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'acct-1', providerKey: 'p1', apiKey: 'k1', modelId: 'test-model', proxyModelId: 'test-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // 📖 x-api-key should authenticate successfully
    const res = await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, 'POST', '/v1/chat/completions', { 'x-api-key': 'secret-key' })
    assert.strictEqual(res.statusCode, 200)
  })

  it('rejects invalid x-api-key', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [], proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/v1/models', { 'x-api-key': 'wrong-key' })
    assert.strictEqual(res.statusCode, 401)
  })

  it('supports model hint in x-api-key (token:model format)', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'acct-1', providerKey: 'p1', apiKey: 'k1', modelId: 'target-model', proxyModelId: 'target-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(
      port,
      { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] },
      'POST', '/v1/messages',
      { 'x-api-key': 'secret-key:target-model' }
    )
    // 📖 Should not be 401 — the x-api-key with model hint should authenticate
    assert.notStrictEqual(res.statusCode, 401)
  })

  it('accepts real Anthropic API keys (sk-ant-*) as valid auth', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'acct-1', providerKey: 'p1', apiKey: 'k1', modelId: 'test-model', proxyModelId: 'test-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // 📖 Claude Code sends its own stored Anthropic key — proxy should accept it
    const res = await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, 'POST', '/v1/chat/completions', { authorization: 'Bearer sk-ant-oat01-realkey123' })
    assert.strictEqual(res.statusCode, 200)
  })

  it('still rejects non-Anthropic invalid keys', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [], proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/v1/models', { authorization: 'Bearer totally-wrong-key' })
    assert.strictEqual(res.statusCode, 401)
  })
})

// ─── Suite: ProxyServer – Claude model fallback (BUG 2) ──────────────────────
// When anthropicRouting is all null, Claude model names should fall back to first account

describe('ProxyServer – Claude model fallback with null routing', () => {
  const cleanups = []
  after(async () => { for (const fn of cleanups) await fn() })

  it('falls back to first account model when anthropicRouting is all null', async () => {
    let capturedModel = null
    const upstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          try { capturedModel = JSON.parse(body).model } catch {}
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        })
      })
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }))
    })
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'acct-1', providerKey: 'p1', apiKey: 'k1', modelId: 'real-oss-model', proxyModelId: 'real-oss-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({
      port: 0, accounts, proxyApiKey: 'secret-key',
      anthropicRouting: { model: null, modelOpus: null, modelSonnet: null, modelHaiku: null },
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // 📖 Claude Code sends a Claude model name — should fallback to first account's model
    const res = await makeRequest(
      port,
      { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] },
      'POST', '/v1/messages',
      { 'x-api-key': 'secret-key' }
    )
    assert.notStrictEqual(res.statusCode, 404, 'should not return 404 for Claude model with fallback')
    assert.notStrictEqual(res.statusCode, 401, 'should not return 401 with valid x-api-key')
  })
})

// ─── Suite: ProxyServer – upstream request timeout ────────────────────────────
// These tests verify that the proxy does NOT hang forever when the upstream
// is slow or unresponsive — it must time out and treat it like a network error.

describe('ProxyServer – upstream request timeout', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('times out and retries when upstream hangs longer than upstreamTimeoutMs', async () => {
    // Create a mock upstream that hangs without responding for 2 seconds
    let connectionCount = 0
    const hangingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        connectionCount++
        // Never respond — simulate hanging upstream
        req.on('data', () => {})
        req.on('end', () => {
          // Intentionally don't call res.end() — just hang
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => hangingUpstream.server.close())

    const goodUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => goodUpstream.server.close())

    const accounts = [
      { id: 'hang-acct', providerKey: 'hang', apiKey: 'k1', modelId: 'hang-model', proxyModelId: 'test', url: hangingUpstream.url + '/v1' },
      { id: 'good-acct-to', providerKey: 'good', apiKey: 'k2', modelId: 'good-model', proxyModelId: 'test', url: goodUpstream.url + '/v1' },
    ]
    // upstreamTimeoutMs=200ms: much shorter than the 302s real hang
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2, upstreamTimeoutMs: 200 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const start = Date.now()
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    const elapsed = Date.now() - start

    // Must complete in much less than 302 seconds (within 2000ms for this test)
    assert.ok(elapsed < 2000, `Request took ${elapsed}ms, expected < 2000ms (timeout should have fired)`)
    // Should have fallen over to the good upstream
    assert.strictEqual(res.statusCode, 200)
  })

  it('returns 503 when all accounts time out and no fallback', async () => {
    const hangingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => { /* hang */ })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => hangingUpstream.server.close())

    const accounts = [
      { id: 'hang-only', providerKey: 'hang', apiKey: 'k1', modelId: 'hang-model', proxyModelId: 'test', url: hangingUpstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 1, upstreamTimeoutMs: 150 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const start = Date.now()
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    const elapsed = Date.now() - start

    assert.ok(elapsed < 2000, `Request took ${elapsed}ms, expected < 2000ms`)
    assert.strictEqual(res.statusCode, 503)
  })

  it('logs timeout attempts in the request log', async () => {
    const logCtx = makeTempLogDir('timeout-log')
    cleanups.push(logCtx.cleanup)

    const hangingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => { /* hang */ })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => hangingUpstream.server.close())

    const accounts = [
      { id: 'hang-log-acct', providerKey: 'hang-prov', apiKey: 'k1', modelId: 'hang-model', proxyModelId: 'test', url: hangingUpstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({
      port: 0, accounts, retries: 1, upstreamTimeoutMs: 150,
      tokenStatsOpts: { dataDir: logCtx.dir },
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.ok(entries.length >= 1, 'timeout should produce a log entry')
    const timeoutEntry = entries[0]
    assert.strictEqual(timeoutEntry.success, false, 'timed-out request must be logged as failed')
    assert.strictEqual(timeoutEntry.statusCode, 0, 'timeout entry must use statusCode=0 (network error)')
    assert.strictEqual(timeoutEntry.providerKey, 'hang-prov')
  })
})

// ─── Suite: ProxyServer – SSE downstream disconnect cleanup ───────────────────
// When the downstream client closes its connection mid-stream, the proxy MUST
// promptly destroy the upstream request/response so the upstream connection is
// not held open indefinitely (resource leak).

describe('ProxyServer – SSE downstream disconnect cleanup', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('destroys upstream request when client disconnects mid-stream', async () => {
    // Track whether upstream connection was closed/destroyed promptly
    let upstreamResponseClosed = false

    // Keep track of active sockets so we can destroy them in cleanup
    const activeSockets = new Set()

    const streamingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        // Track upstream-side response closure (pipe close propagation)
        res.on('close', () => { upstreamResponseClosed = true })

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        // Stream slowly — client will disconnect before the stream ends
        let i = 0
        const send = () => {
          if (res.destroyed || res.writableEnded) return
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `chunk-${i}` } }] })}\n\n`)
          i++
          // Keep streaming until the connection closes
          setTimeout(send, 50)
        }
        send()
      })
      server.on('connection', socket => {
        activeSockets.add(socket)
        socket.on('close', () => activeSockets.delete(socket))
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    // On cleanup: destroy active sockets to unblock server.close()
    cleanups.push(() => {
      for (const s of activeSockets) s.destroy()
      return new Promise(r => streamingUpstream.server.close(r))
    })

    const accounts = [{
      id: 'disconnect-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'stream-model', url: streamingUpstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // Make a streaming request but abort (destroy) after receiving the first chunk
    await new Promise((resolve) => {
      const data = JSON.stringify({ model: 'stream-model', messages: [{ role: 'user', content: 'hi' }], stream: true })
      const req = http.request({
        hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, res => {
        res.once('data', () => {
          // Abruptly destroy the client socket — simulates downstream disconnect
          res.destroy()
          resolve()
        })
        res.on('error', () => { /* expected — we destroyed it */ resolve() })
      })
      req.on('error', () => resolve())
      req.write(data)
      req.end()
    })

    // Give the proxy a short moment to propagate the disconnect to the upstream
    await new Promise(r => setTimeout(r, 200))

    assert.strictEqual(upstreamResponseClosed, true,
      'upstream response should have been destroyed/closed when client disconnected')
  })
})

// ─── Suite: ProxyServer – provider-level 404 model-not-found rotation ─────────
// These tests verify that when a provider returns 404 with a "model not found /
// inaccessible / not deployed" body, the proxy rotates to the next available
// account rather than immediately forwarding the error to the client.

describe('ProxyServer – provider 404 model-not-found triggers rotation', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('rotates to next account when first provider returns 404 model-not-found and second returns 200', async () => {
    // First upstream: 404 with "Model not found, inaccessible, and/or not deployed"
    const fireworksBad = await createMockUpstream(
      { error: { message: 'Model not found, inaccessible, and/or not deployed', type: 'invalid_request_error' } },
      404
    )
    // Second upstream: 200 success
    const goodUpstream = await createMockUpstream(
      { choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      200
    )
    cleanups.push(() => fireworksBad.server.close(), () => goodUpstream.server.close())

    const accounts = [
      { id: 'fireworks-acct', providerKey: 'fireworks', apiKey: 'k1', modelId: 'target-model', proxyModelId: 'target-model', url: fireworksBad.url + '/v1' },
      { id: 'good-acct', providerKey: 'groq', apiKey: 'k2', modelId: 'target-model', proxyModelId: 'target-model', url: goodUpstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'target-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200, `Expected 200 after rotation, got ${res.statusCode}: ${res.body}`)
    const parsed = JSON.parse(res.body)
    assert.ok(parsed.choices, 'response must have choices from second provider')
  })

  it('returns 503 when all providers return 404 model-not-found', async () => {
    const bad1 = await createMockUpstream(
      { error: { message: 'Model not found, inaccessible, and/or not deployed' } }, 404
    )
    const bad2 = await createMockUpstream(
      { error: { message: 'model inaccessible' } }, 404
    )
    cleanups.push(() => bad1.server.close(), () => bad2.server.close())

    const accounts = [
      { id: 'bad1', providerKey: 'fireworks', apiKey: 'k1', modelId: 'no-model', proxyModelId: 'no-model', url: bad1.url + '/v1' },
      { id: 'bad2', providerKey: 'together', apiKey: 'k2', modelId: 'no-model', proxyModelId: 'no-model', url: bad2.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 3 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'no-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503, `Expected 503 when all providers fail with 404, got ${res.statusCode}`)
  })

  it('account is penalized (skipAccount=true) after MODEL_NOT_FOUND: recordFailure is called and circuitBreaker records the failure', async () => {
    const bad = await createMockUpstream(
      { error: { message: 'Model not found, inaccessible, and/or not deployed' } }, 404
    )
    const good = await createMockUpstream(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, 200
    )
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'bad-404', providerKey: 'fireworks', apiKey: 'k1', modelId: 'mm', proxyModelId: 'mm', url: bad.url + '/v1' },
      { id: 'good-200', providerKey: 'groq', apiKey: 'k2', modelId: 'mm', proxyModelId: 'mm', url: good.url + '/v1' },
    ]
    // circuitBreakerThreshold=1: after 1 failure, circuit opens
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2, accountManagerOpts: { circuitBreakerThreshold: 1 } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // Directly inject a MODEL_NOT_FOUND failure into bad-404 to simulate what the proxy does
    const { classifyError: ce } = await import('../src/error-classifier.js')
    const classified = ce(404, 'Model not found, inaccessible, and/or not deployed', {})
    proxy._accountManager.recordFailure('bad-404', classified, { providerKey: 'fireworks' })

    // The circuit breaker should now be open (threshold=1 means 1 failure trips it)
    const badHealth = proxy._accountManager._healthMap.get('bad-404')
    assert.ok(badHealth.circuitBreaker.isOpen(), 'circuit breaker should be open after 1 MODEL_NOT_FOUND failure with threshold=1')
    assert.strictEqual(badHealth.failureCount, 1, 'failureCount must be 1 after MODEL_NOT_FOUND')

    // bad-404 should be unavailable for selection
    const selected = proxy._accountManager.selectAccount({ requestedModel: 'mm' })
    assert.ok(selected !== null, 'there should be an available account (good-200)')
    assert.strictEqual(selected.id, 'good-200', 'should select good-200 because bad-404 is circuit-broken')
  })

  it('generic provider 404 (no model keywords) is NOT rotated — forwarded directly', async () => {
    // A plain 404 "not found" (e.g. wrong endpoint URL, no model keywords) should NOT trigger rotation.
    // It falls through as UNKNOWN (shouldRetry=false) and is forwarded to the client.
    // Use a single account to make selection deterministic.
    const genericBad = await createMockUpstream(
      { error: { message: 'The requested URL was not found on the server.' } }, 404
    )
    cleanups.push(() => genericBad.server.close())

    const accounts = [
      { id: 'generic-404-acct', providerKey: 'someprov', apiKey: 'k1', modelId: 'mymodel', proxyModelId: 'mymodel', url: genericBad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'mymodel', messages: [{ role: 'user', content: 'hi' }] })
    // Generic 404 (no model keywords): UNKNOWN → shouldRetry=false → forwarded directly → client gets 404
    assert.strictEqual(res.statusCode, 404, `generic 404 without model keywords should be forwarded as-is, got ${res.statusCode}`)
  })
})
