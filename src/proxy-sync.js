/**
 * @file src/proxy-sync.js
 * @description Generalized proxy sync & cleanup for all supported tools.
 *
 * @details
 *   📖 When FCM Proxy V2 is enabled, there is ONE endpoint (http://127.0.0.1:{port}/v1)
 *   with ONE token that serves ALL models. This module writes that single endpoint into
 *   whichever tool the user has selected, and cleans up old per-provider `fcm-*` vestiges.
 *
 *   📖 Each tool has its own config format (JSON, YAML, env file). The sync functions
 *   know how to write the `fcm-proxy` entry in each format. The cleanup functions
 *   remove ALL `fcm-*` entries (both old direct installs and previous proxy entries).
 *
 * @functions
 *   → syncProxyToTool(toolMode, proxyInfo, mergedModels) — write proxy endpoint to tool config
 *   → cleanupToolConfig(toolMode) — remove all FCM entries from tool config
 *   → resolveProxySyncToolMode(toolMode) — normalize a live tool mode to a proxy-syncable target
 *   → getProxySyncableTools() — list of tools that support proxy sync
 *
 * @exports syncProxyToTool, cleanupToolConfig, resolveProxySyncToolMode, getProxySyncableTools, PROXY_SYNCABLE_TOOLS
 *
 * @see src/endpoint-installer.js — per-provider direct install (Y key flow)
 * @see src/opencode-sync.js — OpenCode-specific sync (used internally by this module)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { syncToOpenCode, cleanupOpenCodeProxyConfig } from './opencode-sync.js'
import { getToolMeta } from './tool-metadata.js'

// 📖 Provider ID used for all proxy entries — replaces per-provider fcm-{providerKey} IDs
const PROXY_PROVIDER_ID = 'fcm-proxy'

// 📖 Ensures the env file is sourced in the user's shell profile (.zshrc, .bashrc, .bash_profile)
// 📖 Only adds the source line if not already present — idempotent
function ensureShellSourceLine(envFilePath) {
  const home = homedir()
  const candidates = ['.zshrc', '.bashrc', '.bash_profile']
  let profilePath = null
  for (const c of candidates) {
    const p = join(home, c)
    if (existsSync(p)) { profilePath = p; break }
  }
  if (!profilePath) return // 📖 No shell profile found — skip silently

  try {
    const content = readFileSync(profilePath, 'utf8')
    if (content.includes(envFilePath)) return // 📖 Already sourced
    const sourceLine = `\n# 📖 FCM Proxy — Claude Code env vars\n[ -f "${envFilePath}" ] && source "${envFilePath}"\n`
    writeFileSync(profilePath, content + sourceLine)
  } catch { /* best effort */ }
}

// 📖 Tools that support proxy sync (have base URL + API key config)
// 📖 Gemini is excluded — it only stores a model name, no URL/key fields.
// 📖 Claude proxy integration is
// 📖 runtime-only now, with fake Claude ids handled by the proxy itself.
export const PROXY_SYNCABLE_TOOLS = [
  'opencode', 'opencode-desktop', 'openclaw', 'crush', 'goose', 'pi',
  'aider', 'amp', 'qwen', 'codex', 'openhands', 'claude-code',
]

const PROXY_SYNCABLE_CANONICAL = new Set(PROXY_SYNCABLE_TOOLS.map(tool => tool === 'opencode-desktop' ? 'opencode' : tool))

// ─── Shared helpers ──────────────────────────────────────────────────────────

function getDefaultPaths() {
  const home = homedir()
  return {
    opencodeConfigPath: join(home, '.config', 'opencode', 'opencode.json'),
    openclawConfigPath: join(home, '.openclaw', 'openclaw.json'),
    crushConfigPath: join(home, '.config', 'crush', 'crush.json'),
    gooseProvidersDir: join(home, '.config', 'goose', 'custom_providers'),
    gooseSecretsPath: join(home, '.config', 'goose', 'secrets.yaml'),
    piModelsPath: join(home, '.pi', 'agent', 'models.json'),
    piSettingsPath: join(home, '.pi', 'agent', 'settings.json'),
    aiderConfigPath: join(home, '.aider.conf.yml'),
    ampConfigPath: join(home, '.config', 'amp', 'settings.json'),
    qwenConfigPath: join(home, '.qwen', 'settings.json'),
  }
}

function ensureDirFor(filePath) {
  const dir = join(filePath, '..')
  mkdirSync(dir, { recursive: true })
}

function readJson(filePath, fallback = {}) {
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch { /* corrupted — start fresh */ }
  return { ...fallback }
}

function writeJson(filePath, data) {
  ensureDirFor(filePath)
  const backupPath = filePath + '.bak'
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, backupPath) } catch { /* best effort */ }
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
  return backupPath
}

function readSimpleYamlMap(filePath) {
  if (!existsSync(filePath)) return {}
  const out = {}
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

function writeSimpleYamlMap(filePath, entries) {
  ensureDirFor(filePath)
  const lines = Object.keys(entries).sort().map(key => `${key}: ${JSON.stringify(String(entries[key] ?? ''))}`)
  writeFileSync(filePath, lines.join('\n') + '\n')
}

// 📖 Build proxy model list from mergedModels array
// 📖 Each model has { slug, label, ctx } — slug is the proxy model ID
function buildProxyModels(mergedModels) {
  return mergedModels.map(m => ({ slug: m.slug, label: m.label, ctx: m.ctx || '128k' }))
}

function parseContextWindow(ctx) {
  if (typeof ctx !== 'string' || !ctx.trim()) return 128000
  const trimmed = ctx.trim().toLowerCase()
  const multiplier = trimmed.endsWith('m') ? 1_000_000 : trimmed.endsWith('k') ? 1_000 : 1
  const numeric = Number.parseFloat(trimmed.replace(/[mk]$/i, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return 128000
  return Math.round(numeric * multiplier)
}

function getDefaultMaxTokens(contextWindow) {
  return Math.max(4096, Math.min(contextWindow, 32768))
}

export function resolveProxySyncToolMode(toolMode) {
  if (typeof toolMode !== 'string' || toolMode.length === 0) return null
  const canonical = toolMode === 'opencode-desktop' ? 'opencode' : toolMode
  return PROXY_SYNCABLE_CANONICAL.has(canonical) ? canonical : null
}

// ─── Per-tool sync functions ─────────────────────────────────────────────────
// 📖 Each writes a single `fcm-proxy` provider entry with ALL models

function syncOpenCode(proxyInfo, mergedModels) {
  // 📖 Delegate to the existing OpenCode sync module
  return syncToOpenCode(null, null, mergedModels, proxyInfo)
}

function syncOpenClaw(proxyInfo, mergedModels, paths) {
  const filePath = paths.openclawConfigPath
  const config = readJson(filePath, {})
  const models = buildProxyModels(mergedModels)

  if (!config.models || typeof config.models !== 'object') config.models = {}
  if (config.models.mode !== 'replace') config.models.mode = 'merge'
  if (!config.models.providers || typeof config.models.providers !== 'object') config.models.providers = {}
  if (!config.agents || typeof config.agents !== 'object') config.agents = {}
  if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {}
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') config.agents.defaults.models = {}

  // 📖 Remove old fcm-* providers (direct installs vestiges)
  for (const key of Object.keys(config.models.providers)) {
    if (key.startsWith('fcm-')) delete config.models.providers[key]
  }
  for (const modelRef of Object.keys(config.agents.defaults.models)) {
    if (modelRef.startsWith('fcm-')) delete config.agents.defaults.models[modelRef]
  }

  // 📖 Write single fcm-proxy provider with all models
  config.models.providers[PROXY_PROVIDER_ID] = {
    baseUrl: proxyInfo.baseUrl,
    apiKey: proxyInfo.token,
    api: 'openai-completions',
    models: models.map(m => {
      const contextWindow = parseContextWindow(m.ctx)
      return {
        id: m.slug, name: m.label, api: 'openai-completions', reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow, maxTokens: getDefaultMaxTokens(contextWindow),
      }
    }),
  }
  for (const m of models) {
    config.agents.defaults.models[`${PROXY_PROVIDER_ID}/${m.slug}`] = {}
  }

  writeJson(filePath, config)
  return { path: filePath, modelCount: models.length }
}

function syncCrush(proxyInfo, mergedModels, paths) {
  const filePath = paths.crushConfigPath
  const config = readJson(filePath, { $schema: 'https://charm.land/crush.json' })
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}
  const models = buildProxyModels(mergedModels)

  // 📖 Remove old fcm-* providers
  for (const key of Object.keys(config.providers)) {
    if (key.startsWith('fcm-')) delete config.providers[key]
  }

  config.providers[PROXY_PROVIDER_ID] = {
    name: 'FCM Proxy V2',
    type: 'openai-compat',
    base_url: proxyInfo.baseUrl,
    api_key: proxyInfo.token,
    models: models.map(m => {
      const contextWindow = parseContextWindow(m.ctx)
      return { id: m.slug, name: m.label, context_window: contextWindow, default_max_tokens: getDefaultMaxTokens(contextWindow) }
    }),
  }

  writeJson(filePath, config)
  return { path: filePath, modelCount: models.length }
}

function syncGoose(proxyInfo, mergedModels, paths) {
  const models = buildProxyModels(mergedModels)
  const providerFilePath = join(paths.gooseProvidersDir, `${PROXY_PROVIDER_ID}.json`)

  // 📖 Remove old fcm-* provider files
  try {
    if (existsSync(paths.gooseProvidersDir)) {
      for (const f of readdirSync(paths.gooseProvidersDir)) {
        if (f.startsWith('fcm-') && f !== `${PROXY_PROVIDER_ID}.json`) {
          try { unlinkSync(join(paths.gooseProvidersDir, f)) } catch { /* best effort */ }
        }
      }
    }
  } catch { /* best effort */ }

  const providerConfig = {
    name: PROXY_PROVIDER_ID,
    engine: 'openai',
    display_name: 'FCM Proxy V2',
    description: 'Managed by free-coding-models — single endpoint for all models',
    api_key_env: 'FCM_PROXY_API_KEY',
    base_url: proxyInfo.baseUrl,
    models: models.map(m => ({ name: m.slug, context_limit: parseContextWindow(m.ctx) })),
    supports_streaming: true,
    requires_auth: true,
  }

  writeJson(providerFilePath, providerConfig)

  // 📖 Write secret + clean old fcm-* secrets
  const secrets = readSimpleYamlMap(paths.gooseSecretsPath)
  for (const key of Object.keys(secrets)) {
    if (key.startsWith('FCM_') && key.endsWith('_API_KEY') && key !== 'FCM_PROXY_API_KEY') {
      delete secrets[key]
    }
  }
  secrets.FCM_PROXY_API_KEY = proxyInfo.token
  writeSimpleYamlMap(paths.gooseSecretsPath, secrets)

  return { path: providerFilePath, modelCount: models.length }
}

function syncPi(proxyInfo, mergedModels, paths) {
  const models = buildProxyModels(mergedModels)

  // 📖 Write models.json
  const modelsConfig = readJson(paths.piModelsPath, { providers: {} })
  if (!modelsConfig.providers || typeof modelsConfig.providers !== 'object') modelsConfig.providers = {}
  // 📖 Remove old fcm-* providers
  for (const key of Object.keys(modelsConfig.providers)) {
    if (key.startsWith('fcm-')) delete modelsConfig.providers[key]
  }
  modelsConfig.providers[PROXY_PROVIDER_ID] = {
    baseUrl: proxyInfo.baseUrl,
    api: 'openai-completions',
    apiKey: proxyInfo.token,
    models: models.map(m => ({ id: m.slug, name: m.label })),
  }
  writeJson(paths.piModelsPath, modelsConfig)

  // 📖 Write settings.json — set default to first model
  const settingsConfig = readJson(paths.piSettingsPath, {})
  settingsConfig.defaultProvider = PROXY_PROVIDER_ID
  settingsConfig.defaultModel = models[0]?.slug ?? ''
  writeJson(paths.piSettingsPath, settingsConfig)

  return { path: paths.piModelsPath, modelCount: models.length }
}

function syncAider(proxyInfo, mergedModels, paths) {
  const models = buildProxyModels(mergedModels)
  const primarySlug = models[0]?.slug ?? ''
  const lines = [
    '# 📖 Managed by free-coding-models — FCM Proxy V2',
    `openai-api-base: ${proxyInfo.baseUrl}`,
    `openai-api-key: ${proxyInfo.token}`,
    `model: openai/${primarySlug}`,
    '',
  ]
  ensureDirFor(paths.aiderConfigPath)
  if (existsSync(paths.aiderConfigPath)) {
    try { copyFileSync(paths.aiderConfigPath, paths.aiderConfigPath + '.bak') } catch { /* best effort */ }
  }
  writeFileSync(paths.aiderConfigPath, lines.join('\n'))
  return { path: paths.aiderConfigPath, modelCount: models.length }
}

function syncAmp(proxyInfo, mergedModels, paths) {
  const models = buildProxyModels(mergedModels)
  const config = readJson(paths.ampConfigPath, {})
  config['amp.url'] = proxyInfo.baseUrl
  config['amp.model'] = models[0]?.slug ?? ''
  writeJson(paths.ampConfigPath, config)
  return { path: paths.ampConfigPath, modelCount: models.length }
}

function syncQwen(proxyInfo, mergedModels, paths) {
  const models = buildProxyModels(mergedModels)
  const config = readJson(paths.qwenConfigPath, {})
  if (!config.modelProviders || typeof config.modelProviders !== 'object') config.modelProviders = {}
  if (!Array.isArray(config.modelProviders.openai)) config.modelProviders.openai = []

  // 📖 Remove old FCM-managed entries
  config.modelProviders.openai = config.modelProviders.openai.filter(
    entry => !models.some(m => m.slug === entry?.id)
  )
  // 📖 Prepend proxy models
  const newEntries = models.map(m => ({
    id: m.slug, name: m.label, envKey: 'FCM_PROXY_API_KEY', baseUrl: proxyInfo.baseUrl,
  }))
  config.modelProviders.openai = [...newEntries, ...config.modelProviders.openai]
  config.model = models[0]?.slug ?? ''
  writeJson(paths.qwenConfigPath, config)
  return { path: paths.qwenConfigPath, modelCount: models.length }
}

function syncEnvTool(proxyInfo, mergedModels, toolMode) {
  const home = homedir()
  const envFilePath = join(home, `.fcm-${toolMode}-env`)
  const models = buildProxyModels(mergedModels)
  const primarySlug = models[0]?.slug ?? ''

  const envLines = [
    '# 📖 Managed by free-coding-models — FCM Proxy V2 (single endpoint, all models)',
    `# 📖 ${models.length} models available through the proxy`,
    `export OPENAI_API_KEY="${proxyInfo.token}"`,
    `export OPENAI_BASE_URL="${proxyInfo.baseUrl}"`,
    `export OPENAI_MODEL="${primarySlug}"`,
    `export LLM_API_KEY="${proxyInfo.token}"`,
    `export LLM_BASE_URL="${proxyInfo.baseUrl}"`,
    `export LLM_MODEL="openai/${primarySlug}"`,
  ]

  // 📖 Claude Code: Anthropic-specific env vars
  if (toolMode === 'claude-code') {
    const proxyBase = proxyInfo.baseUrl.replace(/\/v1$/, '')
    envLines.push(`export ANTHROPIC_API_KEY="${proxyInfo.token}"`)
    envLines.push(`export ANTHROPIC_BASE_URL="${proxyBase}"`)
  }

  ensureDirFor(envFilePath)
  if (existsSync(envFilePath)) {
    try { copyFileSync(envFilePath, envFilePath + '.bak') } catch { /* best effort */ }
  }
  writeFileSync(envFilePath, envLines.join('\n') + '\n')

  // 📖 Auto-source the env file in the shell profile so Claude Code picks it up
  if (toolMode === 'claude-code') {
    ensureShellSourceLine(envFilePath)
  }

  return { path: envFilePath, modelCount: models.length }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 📖 Sync FCM Proxy V2 endpoint to a specific tool's config.
 * 📖 Writes a single `fcm-proxy` provider with ALL available models and
 * 📖 cleans up old per-provider `fcm-*` entries in the same operation.
 *
 * @param {string} toolMode — tool key (e.g. 'opencode', 'claude-code', 'goose')
 * @param {{ baseUrl: string, token: string }} proxyInfo — proxy endpoint info
 * @param {Array} mergedModels — output of buildMergedModels() with { slug, label, ctx }
 * @returns {{ success: boolean, path?: string, modelCount?: number, error?: string }}
 */
export function syncProxyToTool(toolMode, proxyInfo, mergedModels) {
  const canonical = resolveProxySyncToolMode(toolMode)
  if (!canonical) {
    return { success: false, error: `Tool '${toolMode}' does not support proxy sync` }
  }

  try {
    const paths = getDefaultPaths()
    let result

    switch (canonical) {
      case 'opencode':
        result = syncOpenCode(proxyInfo, mergedModels)
        break
      case 'openclaw':
        result = syncOpenClaw(proxyInfo, mergedModels, paths)
        break
      case 'crush':
        result = syncCrush(proxyInfo, mergedModels, paths)
        break
      case 'goose':
        result = syncGoose(proxyInfo, mergedModels, paths)
        break
      case 'pi':
        result = syncPi(proxyInfo, mergedModels, paths)
        break
      case 'aider':
        result = syncAider(proxyInfo, mergedModels, paths)
        break
      case 'amp':
        result = syncAmp(proxyInfo, mergedModels, paths)
        break
      case 'qwen':
        result = syncQwen(proxyInfo, mergedModels, paths)
        break
      case 'claude-code':
      case 'codex':
      case 'openhands':
        result = syncEnvTool(proxyInfo, mergedModels, canonical)
        break
      default:
        return { success: false, error: `Unknown tool: ${toolMode}` }
    }

    return { success: true, ...result }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * 📖 Remove all FCM-managed entries from a tool's config.
 * 📖 Removes both old per-provider `fcm-*` and the unified `fcm-proxy` entries.
 *
 * @param {string} toolMode
 * @returns {{ success: boolean, error?: string }}
 */
export function cleanupToolConfig(toolMode) {
  const canonical = resolveProxySyncToolMode(toolMode)
  if (!canonical) {
    return { success: false, error: `Tool '${toolMode}' does not support proxy cleanup` }
  }

  try {
    const paths = getDefaultPaths()

    switch (canonical) {
      case 'opencode': {
        const result = cleanupOpenCodeProxyConfig()
        // 📖 Also clean old fcm-{provider} entries beyond fcm-proxy
        try {
          const oc = JSON.parse(readFileSync(paths.opencodeConfigPath, 'utf8'))
          if (oc.provider) {
            let changed = false
            for (const key of Object.keys(oc.provider)) {
              if (key.startsWith('fcm-')) { delete oc.provider[key]; changed = true }
            }
            if (changed) writeJson(paths.opencodeConfigPath, oc)
          }
        } catch { /* best effort */ }
        return { success: true, ...result }
      }
      case 'openclaw': {
        const config = readJson(paths.openclawConfigPath, {})
        if (config.models?.providers) {
          for (const key of Object.keys(config.models.providers)) {
            if (key.startsWith('fcm-')) delete config.models.providers[key]
          }
        }
        if (config.agents?.defaults?.models) {
          for (const ref of Object.keys(config.agents.defaults.models)) {
            if (ref.startsWith('fcm-')) delete config.agents.defaults.models[ref]
          }
        }
        writeJson(paths.openclawConfigPath, config)
        return { success: true }
      }
      case 'crush': {
        const config = readJson(paths.crushConfigPath, {})
        if (config.providers) {
          for (const key of Object.keys(config.providers)) {
            if (key.startsWith('fcm-')) delete config.providers[key]
          }
        }
        writeJson(paths.crushConfigPath, config)
        return { success: true }
      }
      case 'goose': {
        // 📖 Remove all fcm-* provider files
        try {
            if (existsSync(paths.gooseProvidersDir)) {
            for (const f of readdirSync(paths.gooseProvidersDir)) {
              if (f.startsWith('fcm-')) {
                try { unlinkSync(join(paths.gooseProvidersDir, f)) } catch { /* best effort */ }
              }
            }
          }
        } catch { /* best effort */ }
        // 📖 Remove FCM secrets
        const secrets = readSimpleYamlMap(paths.gooseSecretsPath)
        for (const key of Object.keys(secrets)) {
          if (key.startsWith('FCM_') && key.endsWith('_API_KEY')) delete secrets[key]
        }
        writeSimpleYamlMap(paths.gooseSecretsPath, secrets)
        return { success: true }
      }
      case 'pi': {
        const modelsConfig = readJson(paths.piModelsPath, { providers: {} })
        if (modelsConfig.providers) {
          for (const key of Object.keys(modelsConfig.providers)) {
            if (key.startsWith('fcm-')) delete modelsConfig.providers[key]
          }
        }
        writeJson(paths.piModelsPath, modelsConfig)
        return { success: true }
      }
      case 'aider': {
        // 📖 Only remove if managed by FCM
        try {
          if (existsSync(paths.aiderConfigPath)) {
            const content = readFileSync(paths.aiderConfigPath, 'utf8')
            if (content.includes('Managed by free-coding-models')) {
                unlinkSync(paths.aiderConfigPath)
            }
          }
        } catch { /* best effort */ }
        return { success: true }
      }
      case 'amp': {
        const config = readJson(paths.ampConfigPath, {})
        delete config['amp.url']
        delete config['amp.model']
        writeJson(paths.ampConfigPath, config)
        return { success: true }
      }
      case 'qwen': {
        const config = readJson(paths.qwenConfigPath, {})
        if (Array.isArray(config.modelProviders?.openai)) {
          config.modelProviders.openai = config.modelProviders.openai.filter(
            entry => entry?.envKey !== 'FCM_PROXY_API_KEY'
          )
        }
        writeJson(paths.qwenConfigPath, config)
        return { success: true }
      }
      case 'claude-code':
      case 'codex':
      case 'openhands': {
        const envFilePath = join(homedir(), `.fcm-${canonical}-env`)
        try {
          if (existsSync(envFilePath)) {
            unlinkSync(envFilePath)
          }
        } catch { /* best effort */ }
        return { success: true }
      }
      default:
        return { success: false, error: `Unknown tool: ${toolMode}` }
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * 📖 Returns the list of tools that support proxy sync.
 * 📖 Enriched with display metadata from tool-metadata.js.
 *
 * @returns {Array<{ key: string, label: string, emoji: string }>}
 */
export function getProxySyncableTools() {
  return PROXY_SYNCABLE_TOOLS.map(key => {
    const meta = getToolMeta(key)
    return { key, label: meta.label, emoji: meta.emoji }
  })
}
