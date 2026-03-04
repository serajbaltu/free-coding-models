import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

const OC_CONFIG_DIR = join(homedir(), '.config', 'opencode')
const OC_CONFIG_PATH = join(OC_CONFIG_DIR, 'opencode.json')
const OC_BACKUP_PATH = join(OC_CONFIG_DIR, 'opencode.json.bak')
const FCM_PROVIDER_ID = 'fcm-proxy'
const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:8045/v1'

function generateProxyToken() {
  return `fcm_${randomBytes(24).toString('hex')}`
}

function ensureV1BaseUrl(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    return DEFAULT_PROXY_BASE_URL
  }
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * Load existing OpenCode config, or return empty object.
 */
export function loadOpenCodeConfig() {
  try {
    if (existsSync(OC_CONFIG_PATH)) {
      return JSON.parse(readFileSync(OC_CONFIG_PATH, 'utf8'))
    }
  } catch {}
  return {}
}

/**
 * Save OpenCode config with automatic backup.
 * Creates backup of current config before overwriting.
 */
export function saveOpenCodeConfig(config) {
  mkdirSync(OC_CONFIG_DIR, { recursive: true })
  // Backup existing config before saving
  if (existsSync(OC_CONFIG_PATH)) {
    copyFileSync(OC_CONFIG_PATH, OC_BACKUP_PATH)
  }
  writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Restore OpenCode config from backup.
 * @returns {boolean} true if restored, false if no backup exists
 */
export function restoreOpenCodeBackup() {
  if (!existsSync(OC_BACKUP_PATH)) return false
  copyFileSync(OC_BACKUP_PATH, OC_CONFIG_PATH)
  return true
}

/**
 * Pure merge: apply FCM provider entry into an existing OpenCode config object.
 *
 * This function contains the merge logic without any filesystem I/O so it can
 * be unit-tested in isolation. It is exported for tests and used internally by
 * syncToOpenCode.
 *
 * CRITICAL: This function ONLY adds/updates the fcm-proxy provider entry.
 * It PRESERVES all existing providers (antigravity-manager, openai, iflow, etc.)
 * and all other top-level keys ($schema, mcp, plugin, command, model).
 *
 * proxyInfo should only carry runtime port/token when the proxy is actively
 * running (running === true). Callers MUST NOT pass stale values from a stopped
 * proxy — use undefined/omit the fields instead so we fall back to the existing
 * persisted provider options cleanly.
 *
 * @param {Object} ocConfig - Existing OpenCode config object (will be mutated in-place)
 * @param {Array} mergedModels - Output of buildMergedModels()
 * @param {{ proxyPort?: number, proxyToken?: string }} proxyInfo
 * @returns {Object} The mutated ocConfig
 */
export function mergeOcConfig(ocConfig, mergedModels, proxyInfo = {}) {
  ocConfig.provider = ocConfig.provider || {}

  const existingProvider = ocConfig.provider[FCM_PROVIDER_ID] || {}
  const existingOptions = existingProvider.options || {}

  // Only use the runtime proxyPort if it is a valid positive integer.
  // A null/undefined/0 port means the proxy is not running — fall back to
  // the existing persisted baseURL so we don't write a broken URL.
  const hasValidPort = Number.isInteger(proxyInfo.proxyPort) && proxyInfo.proxyPort > 0
  const baseURL = ensureV1BaseUrl(
    hasValidPort
      ? `http://127.0.0.1:${proxyInfo.proxyPort}`
      : existingOptions.baseURL
  )

  // Keep token stable unless caller provides a runtime token.
  // A non-string or empty proxyToken is treated as absent.
  const hasValidToken = typeof proxyInfo.proxyToken === 'string' && proxyInfo.proxyToken.length > 0
  const hasExistingToken =
    typeof existingOptions.apiKey === 'string' &&
    existingOptions.apiKey.length > 0 &&
    existingOptions.apiKey !== 'fcm-proxy-token'
  const apiKey = hasValidToken ? proxyInfo.proxyToken : (hasExistingToken ? existingOptions.apiKey : generateProxyToken())

  const models = {}
  for (const m of mergedModels) {
    models[m.slug] = { name: m.label }
  }

  ocConfig.provider[FCM_PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'FCM Rotation Proxy',
    options: {
      ...existingOptions,
      baseURL,
      apiKey,
    },
    models,
  }

  return ocConfig
}

/**
 * MERGE the single FCM proxy provider into OpenCode config.
 *
 * CRITICAL: This function ONLY adds/updates the fcm-proxy provider entry.
 * It PRESERVES all existing providers (antigravity-manager, openai, iflow, etc.)
 * and all other top-level keys ($schema, mcp, plugin, command, model).
 *
 * proxyInfo should only carry runtime port/token when the proxy is actively
 * running (running === true). Callers MUST NOT pass stale values from a stopped
 * proxy — use undefined/omit the fields instead so we fall back to the existing
 * persisted provider options cleanly.
 *
 * @param {Object} fcmConfig - FCM config (from loadConfig())
 * @param {Object} _sources - PROVIDERS object from sources.js (unused, kept for signature compatibility)
 * @param {Array} mergedModels - Output of buildMergedModels()
 * @param {{ proxyPort?: number, proxyToken?: string }} proxyInfo
 */
export function syncToOpenCode(fcmConfig, _sources, mergedModels, proxyInfo = {}) {
  const oc = loadOpenCodeConfig()
  const merged = mergeOcConfig(oc, mergedModels, proxyInfo)
  saveOpenCodeConfig(merged)
  return {
    providerKey: FCM_PROVIDER_ID,
    modelCount: Object.keys(merged.provider[FCM_PROVIDER_ID].models).length,
    path: OC_CONFIG_PATH,
  }
}
