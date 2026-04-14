/**
 * @file web/server.js
 * @description HTTP server for the free-coding-models Web Dashboard V3.
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sources, MODELS } from '../sources.js'
import { loadConfig, getApiKey, saveConfig, isProviderEnabled } from '../src/config.js'
import { ping } from '../src/ping.js'
import {
  getAvg, getVerdict, getUptime, getP95, getJitter,
  getStabilityScore, TIER_ORDER
} from '../src/utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── State ───────────────────────────────────────────────────────────────────

let config = loadConfig()
let pingInterval = 10_000

const results = MODELS.map(([modelId, label, tier, sweScore, ctx, providerKey], idx) => ({
  idx: idx + 1, modelId, label, tier, sweScore, ctx, providerKey,
  status: 'pending', pings: [], httpCode: null,
  origin: sources[providerKey]?.name || providerKey,
  url: sources[providerKey]?.url || null,
  cliOnly: sources[providerKey]?.cliOnly || false,
  zenOnly: sources[providerKey]?.zenOnly || false,
}))

const sseClients = new Set()

// ─── Ping Loop ───────────────────────────────────────────────────────────────

let pingRound = 0
let pingLoopRunning = false

async function pingAllModels() {
  if (pingLoopRunning) return
  pingLoopRunning = true
  pingRound++
  const batchSize = 30
  const modelsToPing = results.filter(r =>
    !r.cliOnly && r.url && isProviderEnabled(config, r.providerKey)
  )

  for (let i = 0; i < modelsToPing.length; i += batchSize) {
    const batch = modelsToPing.slice(i, i + batchSize)
    await Promise.all(batch.map(async (r) => {
      const apiKey = getApiKey(config, r.providerKey)
      try {
        const result = await ping(apiKey, r.modelId, r.providerKey, r.url)
        r.httpCode = result.code
        if (['200', '401', '429'].includes(result.code)) {
          r.status = 'up'
          r.pings.push({ ms: result.ms, code: result.code })
        } else if (result.code === '000') {
          r.status = 'timeout'
        } else {
          r.status = 'down'
          r.pings.push({ ms: result.ms, code: result.code })
        }
        if (r.pings.length > 60) r.pings = r.pings.slice(-60)
      } catch {
        r.status = 'timeout'
      }
    }))
  }

  broadcastUpdate()
  pingLoopRunning = false
}

function broadcastUpdate() {
  const data = JSON.stringify(getModelsPayload())
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`) } catch { sseClients.delete(client) }
  }
}

function getModelsPayload() {
  return results.map(r => ({
    idx: r.idx, modelId: r.modelId, label: r.label, tier: r.tier,
    sweScore: r.sweScore, ctx: r.ctx, providerKey: r.providerKey,
    origin: r.origin, status: r.status, httpCode: r.httpCode,
    cliOnly: r.cliOnly, zenOnly: r.zenOnly,
    avg: getAvg(r), verdict: getVerdict(r), uptime: getUptime(r),
    p95: getP95(r), jitter: getJitter(r), stability: getStabilityScore(r),
    latestPing: r.pings.length > 0 ? r.pings[r.pings.length - 1].ms : null,
    latestCode: r.pings.length > 0 ? r.pings[r.pings.length - 1].code : null,
    pingHistory: r.pings.slice(-20).map(p => ({ ms: p.ms, code: p.code })),
    pingCount: r.pings.length,
    hasApiKey: !!getApiKey(config, r.providerKey),
  }))
}

function getConfigPayload() {
  const providers = {}
  for (const [key, src] of Object.entries(sources)) {
    const rawKey = getApiKey(config, key)
    providers[key] = {
      name: src.name, hasKey: !!rawKey,
      maskedKey: rawKey ? maskApiKey(rawKey) : null,
      enabled: isProviderEnabled(config, key),
      modelCount: src.models?.length || 0,
      cliOnly: src.cliOnly || false,
    }
  }
  return { providers, totalModels: MODELS.length, favorites: config.favorites || [] }
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return ''
  if (key.length <= 8) return '••••••••'
  return '••••••••' + key.slice(-4)
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function serveFile(res, filename, contentType) {
  try {
    const content = readFileSync(join(__dirname, filename), 'utf8')
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
  })
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://${req.headers.host}`)

  // Reveal key for a provider
  const keyMatch = url.pathname.match(/^\/api\/key\/(.+)$/)
  if (keyMatch) {
    const rawKey = getApiKey(config, decodeURIComponent(keyMatch[1]))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ key: rawKey || null }))
    return
  }

  switch (url.pathname) {
    case '/': serveFile(res, 'index.html', 'text/html; charset=utf-8'); break
    case '/styles.css': serveFile(res, 'styles.css', 'text/css; charset=utf-8'); break
    case '/app.js': serveFile(res, 'app.js', 'application/javascript; charset=utf-8'); break

    case '/api/models':
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getModelsPayload()))
      break

    case '/api/config':
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getConfigPayload()))
      break

    case '/api/events':
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
      res.write(`data: ${JSON.stringify(getModelsPayload())}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      break

    case '/api/changelog': {
      try {
        const content = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ content }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ content: 'Changelog not available.' }))
      }
      break
    }

    case '/api/favorites': {
      if (req.method === 'POST') {
        try {
          const { modelId, favorite } = JSON.parse(await readBody(req))
          if (!config.favorites) config.favorites = []
          if (favorite && !config.favorites.includes(modelId)) config.favorites.push(modelId)
          else if (!favorite) config.favorites = config.favorites.filter(id => id !== modelId)
          try { saveConfig(config) } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e.message })); return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, favorites: config.favorites }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ favorites: config.favorites || [] }))
      }
      break
    }

    case '/api/ping-cadence': {
      if (req.method === 'POST') {
        try {
          const { interval } = JSON.parse(await readBody(req))
          if ([2000, 5000, 10000, 30000].includes(interval)) {
            pingInterval = interval
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, interval: pingInterval }))
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid interval' }))
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ interval: pingInterval }))
      }
      break
    }

    case '/api/launch': {
      if (req.method === 'POST') {
        try {
          const { modelId, toolId } = JSON.parse(await readBody(req))
          const mSrc = results.find(m => m.modelId === modelId)
          if (!mSrc) throw new Error('Model not found')
          
          const modelData = { providerKey: mSrc.providerKey, modelId: mSrc.modelId, label: mSrc.label }

          // Fire and forget so we don't hang the HTTP request while the tool runs
          ;(async () => {
            try {
              if (toolId === 'opencode') {
                const { startOpenCode } = await import('../src/opencode.js')
                await startOpenCode(modelData, config)
              } else if (toolId === 'opencode-desktop') {
                const { startOpenCodeDesktop } = await import('../src/opencode.js')
                await startOpenCodeDesktop(modelData, config)
              } else if (toolId === 'openclaw') {
                const { startOpenClaw } = await import('../src/openclaw.js')
                await startOpenClaw(modelData, config)
              } else {
                const { startExternalTool } = await import('../src/tool-launchers.js')
                await startExternalTool(toolId, modelData, config)
              }
            } catch (err) {
              console.error(`  ❌ Failed to launch ${toolId}:`, err)
            }
          })()

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      } else {
        res.writeHead(405); res.end('Method Not Allowed')
      }
      break
    }

    case '/api/version-check': {
      try {
        const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
        const current = pkg.version
        
        let latest = current
        try {
          const registryRes = await fetch('https://registry.npmjs.org/free-coding-models/latest', { signal: AbortSignal.timeout(3000) })
          if (registryRes.ok) {
            const data = await registryRes.json()
            latest = data.version
          }
        } catch (e) {
          // silently ignore registry fetch errors to not block the UI
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ 
          current, 
          latest, 
          hasUpdate: current !== latest 
        }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      break
    }

    case '/api/settings': {
      if (req.method === 'POST') {
        try {
          const settings = JSON.parse(await readBody(req))
          if (settings.apiKeys) {
            for (const [key, value] of Object.entries(settings.apiKeys)) {
              if (value) config.apiKeys[key] = value
              else delete config.apiKeys[key]
            }
          }
          if (settings.providers) {
            for (const [key, value] of Object.entries(settings.providers)) {
              if (!config.providers[key]) config.providers[key] = {}
              config.providers[key].enabled = value.enabled !== false
            }
          }
          try { saveConfig(config) } catch (saveErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: saveErr.message })); return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      } else {
        res.writeHead(405); res.end('Method Not Allowed')
      }
      break
    }

    default: res.writeHead(404); res.end('Not Found')
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export async function startWebServer(port = 3333) {
  const server = createServer(handleRequest)
  
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`  Port ${port} is in use, trying ${port + 1}...`)
      setTimeout(() => {
        server.close()
        server.listen(port + 1)
      }, 100)
    } else {
      console.error(e)
    }
  })

  server.on('listening', () => {
    const currentPort = server.address().port
    console.log()
    console.log(`  ⚡ free-coding-models Web Dashboard`)
    console.log(`  🌐 http://localhost:${currentPort}`)
    console.log(`  📊 Monitoring ${results.filter(r => !r.cliOnly).length} models across ${Object.keys(sources).length} providers`)
    console.log(`  Press Ctrl+C to stop`)
    console.log()
  })

  server.listen(port)

  async function schedulePingLoop() {
    await pingAllModels()
    setTimeout(schedulePingLoop, pingInterval)
  }
  schedulePingLoop()

  return server
}
