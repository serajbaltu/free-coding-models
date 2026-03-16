/**
 * @file src/proxy-foreground.js
 * @description Foreground proxy mode — starts the FCM Proxy V2 in the current terminal
 * with a live dashboard showing status, accounts, and incoming requests.
 *
 * 📖 This is the `--proxy` flag handler. Unlike the daemon, it runs in the foreground
 *    with a live-updating terminal UI that shows proxy health and request activity.
 *    Perfect for debugging, dev testing (no .git check), and monitoring.
 *
 * @functions
 *   → startForegroundProxy(config, chalk) — main entry point, starts proxy + dashboard
 *
 * @exports startForegroundProxy
 *
 * @see src/proxy-server.js — ProxyServer implementation
 * @see src/proxy-topology.js — topology builder
 * @see bin/fcm-proxy-daemon.js — headless daemon equivalent
 */

import { loadConfig, getProxySettings } from './config.js'
import { ProxyServer } from './proxy-server.js'
import { buildProxyTopologyFromConfig, buildMergedModelsForDaemon } from './proxy-topology.js'
import { sources } from '../sources.js'
import { syncProxyToTool, resolveProxySyncToolMode } from './proxy-sync.js'
import { buildMergedModels } from './model-merger.js'
import { createHash, randomBytes } from 'node:crypto'

// 📖 Default foreground proxy port — same as daemon
const DEFAULT_PORT = 18045

/**
 * 📖 Start the proxy in foreground mode with a live terminal dashboard.
 * 📖 No .git check, no daemon install — just starts the proxy and shows activity.
 *
 * @param {object} config — loaded FCM config
 * @param {object} chalk — chalk instance for terminal colors
 */
export async function startForegroundProxy(config, chalk) {
  const proxySettings = getProxySettings(config)
  const port = proxySettings.preferredPort || DEFAULT_PORT

  // 📖 Ensure a stable token exists — generate one if missing (dev-friendly)
  let token = proxySettings.stableToken
  if (!token) {
    token = 'fcm_' + randomBytes(16).toString('hex')
    console.log(chalk.yellow('  ⚠ No stableToken in config — generated a temporary one for this session'))
  }

  console.log()
  console.log(chalk.bold('  📡 FCM Proxy V2 — Foreground Mode'))
  console.log(chalk.dim('  ─────────────────────────────────────────────'))
  console.log()

  // 📖 Build topology
  console.log(chalk.dim('  Building merged model catalog...'))
  let mergedModels
  try {
    mergedModels = await buildMergedModelsForDaemon()
  } catch (err) {
    console.error(chalk.red(`  ✗ Failed to build model catalog: ${err.message}`))
    process.exit(1)
  }

  const topology = buildProxyTopologyFromConfig(config, mergedModels, sources)
  const { accounts, proxyModels, anthropicRouting } = topology

  if (accounts.length === 0) {
    console.error(chalk.red('  ✗ No API keys configured — no accounts to serve.'))
    console.error(chalk.dim('  Add keys via the TUI first (run free-coding-models without --proxy)'))
    process.exit(1)
  }

  // 📖 Start proxy server
  const proxy = new ProxyServer({
    port,
    accounts,
    proxyApiKey: token,
    anthropicRouting,
  })

  let listeningPort
  try {
    const result = await proxy.start()
    listeningPort = result.port
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`  ✗ Port ${port} already in use.`))
      console.error(chalk.dim('  Another FCM proxy or process may be running on that port.'))
      process.exit(2)
    }
    console.error(chalk.red(`  ✗ Failed to start proxy: ${err.message}`))
    process.exit(1)
  }

  const modelCount = Object.keys(proxyModels).length

  // 📖 Sync env file for claude-code if it's a syncable tool
  try {
    const baseUrl = `http://127.0.0.1:${listeningPort}/v1`
    const proxyInfo = { baseUrl, token }
    syncProxyToTool('claude-code', proxyInfo, mergedModels)
  } catch { /* best effort */ }

  // 📖 Dashboard header
  console.log(chalk.green('  ✓ Proxy running'))
  console.log()
  console.log(chalk.bold('  Status'))
  console.log(chalk.dim('  ─────────────────────────────────────────────'))
  console.log(`  ${chalk.cyan('Endpoint')}     http://127.0.0.1:${listeningPort}`)
  console.log(`  ${chalk.cyan('Token')}        ${token.slice(0, 12)}...${token.slice(-4)}`)
  console.log(`  ${chalk.cyan('Accounts')}     ${accounts.length}`)
  console.log(`  ${chalk.cyan('Models')}       ${modelCount}`)
  console.log()

  // 📖 Show provider breakdown
  const byProvider = {}
  for (const acct of accounts) {
    byProvider[acct.providerKey] = (byProvider[acct.providerKey] || 0) + 1
  }
  console.log(chalk.bold('  Providers'))
  console.log(chalk.dim('  ─────────────────────────────────────────────'))
  for (const [provider, count] of Object.entries(byProvider).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${chalk.cyan(provider.padEnd(20))} ${count} account${count > 1 ? 's' : ''}`)
  }
  console.log()

  // 📖 Claude Code quick-start hint
  console.log(chalk.bold('  Quick Start'))
  console.log(chalk.dim('  ─────────────────────────────────────────────'))
  console.log(chalk.dim('  Claude Code:'))
  console.log(`    ${chalk.cyan(`ANTHROPIC_BASE_URL=http://127.0.0.1:${listeningPort} ANTHROPIC_API_KEY=${token} claude`)}`)
  console.log()
  console.log(chalk.dim('  curl test:'))
  console.log(`    ${chalk.cyan(`curl -s -H "x-api-key: ${token}" http://127.0.0.1:${listeningPort}/v1/models | head`)}`)
  console.log()

  console.log(chalk.bold('  Live Requests'))
  console.log(chalk.dim('  ─────────────────────────────────────────────'))
  console.log(chalk.dim('  Waiting for incoming requests... (Ctrl+C to stop)'))
  console.log()

  // 📖 Monkey-patch tokenStats.record to intercept and display live requests
  const originalRecord = proxy._tokenStats.record.bind(proxy._tokenStats)
  let requestCount = 0
  proxy._tokenStats.record = (entry) => {
    originalRecord(entry)
    requestCount++

    const now = new Date().toLocaleTimeString()
    const status = entry.success ? chalk.green(`${entry.statusCode}`) : chalk.red(`${entry.statusCode}`)
    const latency = entry.latencyMs ? chalk.dim(`${entry.latencyMs}ms`) : ''
    const tokens = (entry.promptTokens + entry.completionTokens) > 0
      ? chalk.dim(`${entry.promptTokens}+${entry.completionTokens}tok`)
      : ''
    const reqType = entry.requestType || 'unknown'
    const model = entry.requestedModelId || entry.modelId || '?'
    const provider = entry.providerKey || '?'
    const switched = entry.switched ? chalk.yellow(' ↻') : ''

    console.log(
      `  ${chalk.dim(now)}  ${status}  ${chalk.cyan(reqType.padEnd(20))}  ` +
      `${chalk.white(model)}  →  ${chalk.dim(provider)}${switched}  ${latency}  ${tokens}`
    )
  }

  // 📖 Also intercept errors on the _handleRequest level to show auth failures etc.
  const originalHandleRequest = proxy._handleRequest.bind(proxy)
  proxy._handleRequest = (req, res) => {
    const origEnd = res.end.bind(res)
    const method = req.method
    const url = req.url
    let logged = false

    res.end = function (...args) {
      if (!logged && res.statusCode >= 400) {
        logged = true
        const now = new Date().toLocaleTimeString()
        const status = chalk.red(`${res.statusCode}`)
        const ua = req.headers['user-agent'] || ''
        // 📖 Try to detect the client tool from user-agent
        const tool = detectClientTool(ua, req.headers)
        const toolLabel = tool ? chalk.magenta(` [${tool}]`) : ''
        console.log(
          `  ${chalk.dim(now)}  ${status}  ${chalk.cyan(`${method} ${url}`.padEnd(20))}  ` +
          `${chalk.dim('rejected')}${toolLabel}`
        )
        // 📖 Debug: show auth headers on 401 to help diagnose auth issues
        if (res.statusCode === 401) {
          const authHeader = req.headers.authorization ? `Bearer ${req.headers.authorization.slice(0, 20)}...` : 'none'
          const xApiKeyHeader = req.headers['x-api-key'] ? `${req.headers['x-api-key'].slice(0, 20)}...` : 'none'
          console.log(chalk.dim(`         auth: ${authHeader}  |  x-api-key: ${xApiKeyHeader}`))
        }
      }
      return origEnd(...args)
    }

    return originalHandleRequest(req, res)
  }

  // 📖 Graceful shutdown
  const shutdown = async (signal) => {
    console.log()
    console.log(chalk.dim(`  Received ${signal} — shutting down...`))
    try { await proxy.stop() } catch { /* best effort */ }
    console.log(chalk.green(`  ✓ Proxy stopped. ${requestCount} request${requestCount !== 1 ? 's' : ''} served this session.`))
    console.log()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

/**
 * 📖 Detect which client tool sent the request based on User-Agent or custom headers.
 * 📖 Claude Code, Codex, OpenCode etc. each have distinctive UA patterns.
 */
function detectClientTool(ua, headers) {
  if (!ua && !headers) return null
  const uaLower = (ua || '').toLowerCase()

  if (uaLower.includes('claude') || uaLower.includes('anthropic')) return 'Claude Code'
  if (headers?.['anthropic-version'] || headers?.['x-api-key']) return 'Anthropic SDK'
  if (uaLower.includes('codex')) return 'Codex'
  if (uaLower.includes('opencode')) return 'OpenCode'
  if (uaLower.includes('cursor')) return 'Cursor'
  if (uaLower.includes('aider')) return 'Aider'
  if (uaLower.includes('goose')) return 'Goose'
  if (uaLower.includes('openclaw')) return 'OpenClaw'
  if (uaLower.includes('node-fetch') || uaLower.includes('undici')) return 'Node.js'
  if (uaLower.includes('python')) return 'Python'
  if (uaLower.includes('curl')) return 'curl'
  return null
}
