/**
 * @file lib/config.js
 * @description JSON config management for free-coding-models multi-provider support.
 *
 * 📖 This module manages ~/.free-coding-models.json, the new config file that
 *    stores API keys and per-provider enabled/disabled state for all providers
 *    (NVIDIA NIM, Groq, Cerebras, etc.).
 *
 * 📖 Config file location: ~/.free-coding-models.json
 * 📖 File permissions: 0o600 (user read/write only — contains API keys)
 *
 * 📖 Config JSON structure:
 *   {
 *     "apiKeys": {
 *       "nvidia":     "nvapi-xxx",
 *       "groq":       "gsk_xxx",
 *       "cerebras":   "csk_xxx",
 *       "sambanova":  "sn-xxx",
 *       "openrouter": "sk-or-xxx",
 *       "huggingface":"hf_xxx",
 *       "replicate":  "r8_xxx",
 *       "deepinfra":  "di_xxx",
 *       "fireworks":  "fw_xxx",
 *       "codestral":  "csk-xxx",
 *       "hyperbolic": "eyJ...",
 *       "scaleway":   "scw-xxx",
 *       "googleai":   "AIza...",
 *       "siliconflow":"sk-xxx",
 *       "together":   "together-xxx",
 *       "cloudflare": "cf-xxx",
 *       "perplexity": "pplx-xxx",
 *       "zai":        "zai-xxx"
 *     },
 *     "providers": {
 *       "nvidia":     { "enabled": true },
 *       "groq":       { "enabled": true },
 *       "cerebras":   { "enabled": true },
 *       "sambanova":  { "enabled": true },
 *       "openrouter": { "enabled": true },
 *       "huggingface":{ "enabled": true },
 *       "replicate":  { "enabled": true },
 *       "deepinfra":  { "enabled": true },
 *       "fireworks":  { "enabled": true },
 *       "codestral":  { "enabled": true },
 *       "hyperbolic": { "enabled": true },
 *       "scaleway":   { "enabled": true },
 *       "googleai":   { "enabled": true },
 *       "siliconflow":{ "enabled": true },
 *       "together":   { "enabled": true },
 *       "cloudflare": { "enabled": true },
 *       "perplexity": { "enabled": true },
 *       "zai":        { "enabled": true }
 *     },
 *     "favorites": [
 *       "nvidia/deepseek-ai/deepseek-v3.2"
 *     ],
 *     "telemetry": {
 *       "enabled": true,
 *       "consentVersion": 1,
 *       "anonymousId": "anon_550e8400-e29b-41d4-a716-446655440000"
 *     },

 *     "profiles": {
 *       "work":     { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} },
 *       "personal": { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} },
 *       "fast":     { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} }
 *     },
 *     "endpointInstalls": [
 *       { "providerKey": "nvidia", "toolMode": "opencode", "scope": "all", "modelIds": [], "lastSyncedAt": "2026-03-09T10:00:00.000Z" }
 *     ]
 *   }
 *

 *
 * 📖 Migration: On first run, if the old plain-text ~/.free-coding-models exists
 *    and the new JSON file does not, the old key is auto-migrated as the nvidia key.
 *    The old file is left in place (not deleted) for safety.
 *
 * @functions
 *   → loadConfig() — Read ~/.free-coding-models.json; auto-migrate old plain-text config if needed
 *   → saveConfig(config, options?) — Write config to ~/.free-coding-models.json with atomic replace + merge safeguards
 *   → getApiKey(config, providerKey) — Get effective API key (env var override > config > null)
 *   → addApiKey(config, providerKey, key) — Append a key (string→array); ignores empty/duplicate
 *   → removeApiKey(config, providerKey, index?) — Remove key at index (or last); collapses array-of-1 to string; deletes when empty
 *   → listApiKeys(config, providerKey) — Return all keys for a provider as normalized array
 *   → isProviderEnabled(config, providerKey) — Check if provider is enabled (defaults true)
 *   → buildPersistedConfig(incomingConfig, diskConfig, options?) — Merge a live snapshot with the latest disk state safely
 *   → replaceConfigContents(targetConfig, nextConfig) — Refresh an in-memory config object from a normalized snapshot
 *   → persistApiKeysForProvider(config, providerKey) — Persist one provider's API keys without clobbering the rest of the file

 *   → getProxySettings(config) — Return normalized proxy settings from config
 *   → setClaudeProxyModelRouting(config, modelId) — Mirror free-claude-code MODEL/MODEL_* routing onto one selected FCM model
 *   → normalizeEndpointInstalls(endpointInstalls) — Keep tracked endpoint installs stable across app versions
 *
 * @exports loadConfig, saveConfig, validateConfigFile, getApiKey, isProviderEnabled
 * @exports addApiKey, removeApiKey, listApiKeys — multi-key management helpers
 * @exports getProxySettings, setClaudeProxyModelRouting, normalizeEndpointInstalls
 * @exports buildPersistedConfig, replaceConfigContents, persistApiKeysForProvider
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/free-coding-models.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 📖 New JSON config path — stores all providers' API keys + enabled state
export const CONFIG_PATH = join(homedir(), '.free-coding-models.json')

// 📖 Daemon data directory — PID file, logs, etc.
export const DAEMON_DATA_DIR = join(homedir(), '.free-coding-models')

// 📖 Old plain-text config path — used only for migration
const LEGACY_CONFIG_PATH = join(homedir(), '.free-coding-models')

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia:     'NVIDIA_API_KEY',
  groq:       'GROQ_API_KEY',
  cerebras:   'CEREBRAS_API_KEY',
  sambanova:  'SAMBANOVA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface:['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  replicate:  'REPLICATE_API_TOKEN',
  deepinfra:  ['DEEPINFRA_API_KEY', 'DEEPINFRA_TOKEN'],
  fireworks:  'FIREWORKS_API_KEY',
  codestral:  'CODESTRAL_API_KEY',
  hyperbolic: 'HYPERBOLIC_API_KEY',
  scaleway:   'SCALEWAY_API_KEY',
  googleai:   'GOOGLE_API_KEY',
  siliconflow:'SILICONFLOW_API_KEY',
  together:   'TOGETHER_API_KEY',
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'],
  qwen:       'DASHSCOPE_API_KEY',
  zai:        'ZAI_API_KEY',
  iflow:      'IFLOW_API_KEY',
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneConfigValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeFavoriteList(favorites) {
  if (!Array.isArray(favorites)) return []
  const normalized = []
  const seen = new Set()
  for (const entry of favorites) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

function normalizeApiKeyValue(value) {
  if (Array.isArray(value)) {
    const normalized = []
    const seen = new Set()
    for (const item of value) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      normalized.push(trimmed)
    }
    if (normalized.length === 0) return null
    if (normalized.length === 1) return normalized[0]
    return normalized
  }

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeApiKeysSection(apiKeys) {
  if (!isPlainObject(apiKeys)) return {}
  const normalized = {}
  for (const [providerKey, value] of Object.entries(apiKeys)) {
    const normalizedValue = normalizeApiKeyValue(value)
    if (normalizedValue !== null) normalized[providerKey] = normalizedValue
  }
  return normalized
}

function normalizeProvidersSection(providers) {
  if (!isPlainObject(providers)) return {}
  const normalized = {}
  for (const [providerKey, value] of Object.entries(providers)) {
    if (typeof value === 'boolean') {
      normalized[providerKey] = { enabled: value !== false }
      continue
    }
    if (!isPlainObject(value)) continue
    normalized[providerKey] = { ...value, enabled: value.enabled !== false }
  }
  return normalized
}

function normalizeSettingsSection(settings) {
  const safeSettings = isPlainObject(settings) ? { ...settings } : {}
  return {
    ...safeSettings,
    hideUnconfiguredModels: typeof safeSettings.hideUnconfiguredModels === 'boolean' ? safeSettings.hideUnconfiguredModels : true,
    proxy: normalizeProxySettings(safeSettings.proxy),
    disableWidthsWarning: safeSettings.disableWidthsWarning === true,
  }
}

function normalizeTelemetrySection(telemetry) {
  const safeTelemetry = isPlainObject(telemetry) ? { ...telemetry } : {}
  return {
    enabled: typeof safeTelemetry.enabled === 'boolean' ? safeTelemetry.enabled : null,
    consentVersion: typeof safeTelemetry.consentVersion === 'number' ? safeTelemetry.consentVersion : 0,
    anonymousId: typeof safeTelemetry.anonymousId === 'string' && safeTelemetry.anonymousId.trim()
      ? safeTelemetry.anonymousId
      : null,
  }
}

function normalizeProfileSettings(settings) {
  const safeSettings = isPlainObject(settings) ? { ...settings } : {}
  return {
    ..._emptyProfileSettings(),
    ...safeSettings,
    proxy: normalizeProxySettings(safeSettings.proxy),
    disableWidthsWarning: safeSettings.disableWidthsWarning === true,
  }
}



function normalizeConfigShape(config) {
  const safeConfig = isPlainObject(config) ? config : {}
  return {
    apiKeys: normalizeApiKeysSection(safeConfig.apiKeys),
    providers: normalizeProvidersSection(safeConfig.providers),
    settings: normalizeSettingsSection(safeConfig.settings),
    favorites: normalizeFavoriteList(safeConfig.favorites),
    telemetry: normalizeTelemetrySection(safeConfig.telemetry),
    endpointInstalls: normalizeEndpointInstalls(safeConfig.endpointInstalls),


  }
}

function readStoredConfigSnapshot() {
  if (!existsSync(CONFIG_PATH)) return _emptyConfig()

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8').trim()
    if (!raw) return _emptyConfig()
    return normalizeConfigShape(JSON.parse(raw))
  } catch {
    return _emptyConfig()
  }
}

function mergeOrderedUniqueStrings(primaryEntries, fallbackEntries) {
  const merged = []
  const seen = new Set()
  for (const entry of [...normalizeFavoriteList(primaryEntries), ...normalizeFavoriteList(fallbackEntries)]) {
    if (seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  return merged
}

function mergeEndpointInstalls(diskEndpointInstalls, incomingEndpointInstalls) {
  const merged = new Map()
  for (const entry of normalizeEndpointInstalls(diskEndpointInstalls)) {
    merged.set(`${entry.providerKey}::${entry.toolMode}`, entry)
  }
  for (const entry of normalizeEndpointInstalls(incomingEndpointInstalls)) {
    merged.set(`${entry.providerKey}::${entry.toolMode}`, entry)
  }
  return [...merged.values()]
}

function mergeProfiles(diskProfiles, incomingProfiles, options = {}) {
  // 📖 Profile system removed - return empty object
  return {}
}

/**
 * 📖 buildPersistedConfig merges the latest disk snapshot with the in-memory config so
 * 📖 stale writers do not accidentally wipe secrets or favorites they did not touch.
 *
 * @param {object} incomingConfig
 * @param {object} [diskConfig=_emptyConfig()]
 * @param {{ replaceApiKeys?: boolean, replaceFavorites?: boolean, replaceEndpointInstalls?: boolean, replaceProfileNames?: string[], removedProfileNames?: string[] }} [options]
 * @returns {object}
 */
export function buildPersistedConfig(incomingConfig, diskConfig = _emptyConfig(), options = {}) {
  const normalizedIncoming = normalizeConfigShape(incomingConfig)
  const normalizedDisk = normalizeConfigShape(diskConfig)
  const merged = {
    apiKeys: options.replaceApiKeys === true
      ? cloneConfigValue(normalizedIncoming.apiKeys)
      : { ...normalizedDisk.apiKeys, ...normalizedIncoming.apiKeys },
    providers: { ...normalizedDisk.providers, ...normalizedIncoming.providers },
    settings: cloneConfigValue(normalizedIncoming.settings),
    favorites: options.replaceFavorites === true
      ? [...normalizedIncoming.favorites]
      : mergeOrderedUniqueStrings(normalizedIncoming.favorites, normalizedDisk.favorites),
    telemetry: {
      ...normalizedDisk.telemetry,
      ...normalizedIncoming.telemetry,
    },
    // 📖 Managed endpoint installs sometimes need an exact snapshot so stale disk
    // 📖 records do not come back after a fresh install/refresh pass.
    endpointInstalls: options.replaceEndpointInstalls === true
      ? cloneConfigValue(normalizedIncoming.endpointInstalls)
      : mergeEndpointInstalls(normalizedDisk.endpointInstalls, normalizedIncoming.endpointInstalls),
    // 📖 Profile system removed - always null

  }

  return normalizeConfigShape(merged)
}

/**
 * 📖 replaceConfigContents keeps long-lived in-memory config references fresh after a save.
 * 📖 The TUI stores `state.config` by reference, so we mutate it in-place instead of swapping it.
 *
 * @param {object} targetConfig
 * @param {object} nextConfig
 * @returns {object}
 */
export function replaceConfigContents(targetConfig, nextConfig) {
  const normalizedNextConfig = cloneConfigValue(normalizeConfigShape(nextConfig))

  if (!isPlainObject(targetConfig)) return normalizedNextConfig

  for (const key of Object.keys(targetConfig)) {
    delete targetConfig[key]
  }
  Object.assign(targetConfig, normalizedNextConfig)
  return targetConfig
}

/**
 * 📖 persistApiKeysForProvider writes exactly one provider's key set back to disk using the
 * 📖 latest config snapshot first, so editing one provider cannot erase favorites or other keys.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {{ success: boolean, error?: string, backupCreated?: boolean }}
 */
export function persistApiKeysForProvider(config, providerKey) {
  const latestConfig = readStoredConfigSnapshot()
  const normalizedProviderValue = normalizeApiKeyValue(config?.apiKeys?.[providerKey])

  if (normalizedProviderValue === null) delete latestConfig.apiKeys[providerKey]
  else latestConfig.apiKeys[providerKey] = cloneConfigValue(normalizedProviderValue)

  const saveResult = saveConfig(latestConfig, {
    replaceApiKeys: true,
    replaceProfileNames: [],
  })

  if (saveResult.success) replaceConfigContents(config, latestConfig)
  return saveResult
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.free-coding-models.json (new format)
 *   2. If missing, check if ~/.free-coding-models (old plain-text) exists → migrate
 *   3. If neither, return an empty default config
 *
 * 📖 Now includes automatic validation and repair from backups if config is corrupted.
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, favorites: string[], telemetry: { enabled: boolean | null, consentVersion: number, anonymousId: string | null } }}
 */
export function loadConfig() {
  // 📖 Try new JSON config first
  if (existsSync(CONFIG_PATH)) {
    // 📖 Validate the config file first, try auto-repair if corrupted
    const validation = validateConfigFile({ autoRepair: true })
    
    if (!validation.valid && !validation.repaired) {
      // 📖 Config is corrupted and repair failed - warn user but continue with empty config
      console.error(`⚠️  Warning: Config file is corrupted and could not be repaired: ${validation.error}`)
      console.error('⚠️  Starting with fresh config. Your backups are in ~/.free-coding-models.backups/')
    }

    if (validation.repaired) {
      console.log('✅ Config file was corrupted but has been restored from backup.')
    }

    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8').trim()
      return normalizeConfigShape(JSON.parse(raw))
    } catch {
      // 📖 Corrupted JSON — return empty config (user will re-enter keys)
      return _emptyConfig()
    }
  }

  // 📖 Migration path: old plain-text file exists, new JSON doesn't
  if (existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const oldKey = readFileSync(LEGACY_CONFIG_PATH, 'utf8').trim()
      if (oldKey) {
        const config = _emptyConfig()
        config.apiKeys.nvidia = oldKey
        // 📖 Auto-save migrated config so next launch is fast
        const result = saveConfig(config)
        if (!result.success) {
          console.error(`⚠️  Warning: Failed to save migrated config: ${result.error}`)
        }
        return config
      }
    } catch {
      // 📖 Can't read old file — proceed with empty config
    }
  }

  return _emptyConfig()
}

/**
 * 📖 saveConfig: Write the config object to ~/.free-coding-models.json.
 *
 * 📖 Uses mode 0o600 so the file is only readable by the owning user (API keys!).
 * 📖 Pretty-prints JSON for human readability.
 * 📖 Now includes:
 *   - Automatic backup before overwriting (keeps last 5 versions)
 *   - Verification that write succeeded
 *   - Explicit error handling (no silent failures)
 *   - Post-write validation to ensure file is valid JSON
 *
 * @param {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, favorites?: string[], telemetry?: { enabled?: boolean | null, consentVersion?: number, anonymousId?: string | null } }} config
 * @param {{ replaceApiKeys?: boolean, replaceFavorites?: boolean, replaceEndpointInstalls?: boolean, replaceProfileNames?: string[], removedProfileNames?: string[] }} [options]
 * @returns {{ success: boolean, error?: string, backupCreated?: boolean }}
 */
export function saveConfig(config, options = {}) {
  // 📖 Create backup of existing config before overwriting
  const backupCreated = createBackup()
  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`

  try {
    const persistedConfig = buildPersistedConfig(config, readStoredConfigSnapshot(), options)
    const json = JSON.stringify(persistedConfig, null, 2)
    writeFileSync(tempPath, json, { mode: 0o600 })
    renameSync(tempPath, CONFIG_PATH)

    // 📖 Verify the write succeeded by reading back and validating
    try {
      const parsed = readStoredConfigSnapshot()

      // 📖 Basic sanity check - ensure apiKeys object exists
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Written config is not a valid object')
      }

      // 📖 Verify critical data wasn't lost - check ALL keys are preserved
      if (persistedConfig.apiKeys && Object.keys(persistedConfig.apiKeys).length > 0) {
        if (!parsed.apiKeys) {
          throw new Error('apiKeys object missing after write')
        }
        const originalKeys = Object.keys(persistedConfig.apiKeys).sort()
        const writtenKeys = Object.keys(parsed.apiKeys).sort()
        if (originalKeys.length > writtenKeys.length) {
          const lostKeys = originalKeys.filter(k => !writtenKeys.includes(k))
          throw new Error(`API keys lost during write: ${lostKeys.join(', ')}`)
        }
        // 📖 Also verify each key's value is not empty
        for (const key of originalKeys) {
          if (!parsed.apiKeys[key] || parsed.apiKeys[key].length === 0) {
            throw new Error(`API key for ${key} is empty after write`)
          }
        }
      }

      replaceConfigContents(config, persistedConfig)
      return { success: true, backupCreated }
    } catch (verifyError) {
      // 📖 Verification failed - this is critical!
      let errorMsg = `Config verification failed: ${verifyError.message}`
      
      // 📖 Try to restore from backup if we have one
      if (backupCreated) {
        try {
          restoreFromBackup()
          errorMsg += ' (Restored from backup)'
        } catch (restoreError) {
          errorMsg += ` (Backup restoration failed: ${restoreError.message})`
        }
      }

      return { success: false, error: errorMsg, backupCreated }
    }
  } catch (writeError) {
    // 📖 Write failed - explicit error instead of silent failure
    let errorMsg = `Failed to write config: ${writeError.message}`
    try { unlinkSync(tempPath) } catch { /* ignore temp cleanup failures */ }
    
    // 📖 Try to restore from backup if we have one
    if (backupCreated) {
      try {
        restoreFromBackup()
        errorMsg += ' (Restored from backup)'
      } catch (restoreError) {
        errorMsg += ` (Backup restoration failed: ${restoreError.message})`
      }
    }

    return { success: false, error: errorMsg, backupCreated }
  }
}

/**
 * 📖 createBackup: Creates a timestamped backup of the current config file.
 * 📖 Keeps only the 5 most recent backups to avoid disk space issues.
 * 📖 Backup files are stored in ~/.free-coding-models.backups/
 * 
 * @returns {boolean} true if backup was created, false otherwise
 */
function createBackup() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return false // No file to backup
    }

    // 📖 Create backup directory if it doesn't exist
    const backupDir = join(homedir(), '.free-coding-models.backups')
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { mode: 0o700, recursive: true })
    }

    // 📖 Create timestamped backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, -5) + 'Z'
    const backupPath = join(backupDir, `config.${timestamp}.json`)
    const backupContent = readFileSync(CONFIG_PATH, 'utf8')
    writeFileSync(backupPath, backupContent, { mode: 0o600 })

    // 📖 Clean up old backups (keep only 5 most recent)
    const backups = readdirSync(backupDir)
      .filter(f => f.startsWith('config.') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: join(backupDir, f),
        time: statSync(join(backupDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time)

    // 📖 Delete old backups beyond the 5 most recent
    if (backups.length > 5) {
      for (const oldBackup of backups.slice(5)) {
        try {
          unlinkSync(oldBackup.path)
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    return true
  } catch (error) {
    // 📖 Log but don't fail if backup creation fails
    console.error(`Warning: Backup creation failed: ${error.message}`)
    return false
  }
}

/**
 * 📖 restoreFromBackup: Restores the most recent backup.
 * 📖 Used when config write or verification fails.
 * 
 * @throws {Error} if no backup exists or restoration fails
 */
function restoreFromBackup() {
  const backupDir = join(homedir(), '.free-coding-models.backups')
  
  if (!existsSync(backupDir)) {
    throw new Error('No backup directory found')
  }

  // 📖 Find the most recent backup
  const backups = readdirSync(backupDir)
    .filter(f => f.startsWith('config.') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: join(backupDir, f),
      time: statSync(join(backupDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time)

  if (backups.length === 0) {
    throw new Error('No backups available')
  }

  const latestBackup = backups[0]
  const backupContent = readFileSync(latestBackup.path, 'utf8')
  
  // 📖 Verify backup is valid JSON before restoring
  JSON.parse(backupContent)
  
  // 📖 Restore the backup
  writeFileSync(CONFIG_PATH, backupContent, { mode: 0o600 })
}

/**
 * 📖 validateConfigFile: Checks if the config file is valid JSON.
 * 📖 Returns validation result and can auto-repair from backups if needed.
 * 
 * @param {{ autoRepair?: boolean }} options - If true, attempts to repair using backups
 * @returns {{ valid: boolean, error?: string, repaired?: boolean }}
 */
export function validateConfigFile(options = {}) {
  const { autoRepair = false } = options

  try {
    if (!existsSync(CONFIG_PATH)) {
      return { valid: true } // No config file is valid (will be created)
    }

    const content = readFileSync(CONFIG_PATH, 'utf8')
    
    // 📖 Check if file is empty
    if (!content.trim()) {
      throw new Error('Config file is empty')
    }

    // 📖 Try to parse JSON
    const parsed = JSON.parse(content)

    // 📖 Basic structure validation
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Config is not a valid object')
    }

    // 📖 Check for critical corruption (apiKeys should be an object if it exists).
    // 📖 Treat this as recoverable — loadConfig() will normalize the value safely.
    if (parsed.apiKeys !== null && parsed.apiKeys !== undefined
      && (typeof parsed.apiKeys !== 'object' || Array.isArray(parsed.apiKeys))) {
      console.warn('⚠️  apiKeys field malformed; it will be normalized on load')
    }

    return { valid: true }
  } catch (error) {
    const errorMsg = `Config validation failed: ${error.message}`

    // 📖 Attempt auto-repair from backup if requested
    if (autoRepair) {
      try {
        restoreFromBackup()
        return { valid: false, error: errorMsg, repaired: true }
      } catch (repairError) {
        return { valid: false, error: `${errorMsg} (Repair failed: ${repairError.message})`, repaired: false }
      }
    }

    return { valid: false, error: errorMsg, repaired: false }
  }
}

/**
 * 📖 getApiKey: Get the effective API key for a provider.
 *
 * 📖 Priority order (first non-empty wins):
 *   1. Environment variable (e.g. NVIDIA_API_KEY) — for CI/headless
 *   2. Config file value — from ~/.free-coding-models.json
 *   3. null — no key configured
 *
 * @param {{ apiKeys: Record<string,string> }} config
 * @param {string} providerKey — e.g. 'nvidia', 'groq', 'cerebras'
 * @returns {string|null}
 */
export function getApiKey(config, providerKey) {
  // 📖 Env var override — takes precedence over everything
  const envVar = ENV_VARS[providerKey]
  const envCandidates = Array.isArray(envVar) ? envVar : [envVar]
  for (const candidate of envCandidates) {
    if (candidate && process.env[candidate]) return process.env[candidate]
  }

  // 📖 Config file value
  const key = config?.apiKeys?.[providerKey]
  if (key) return key

  return null
}

/**
 * addApiKey: Append a new API key for a provider.
 *
 * - If the provider has no key yet, sets it as a plain string.
 * - If the provider already has one string key, converts to array [existing, new].
 * - If the provider already has an array, pushes the new key.
 * - Ignores empty/whitespace keys.
 * - Ignores exact duplicates (same string already present).
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} providerKey — Provider identifier (e.g. 'groq')
 * @param {string} key — New API key to add
 * @returns {boolean} true if added, false if ignored (empty or duplicate)
 */
export function addApiKey(config, providerKey, key) {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return false
  if (!config.apiKeys) config.apiKeys = {}
  const current = config.apiKeys[providerKey]
  if (!current) {
    config.apiKeys[providerKey] = trimmed
    return true
  }
  if (typeof current === 'string') {
    if (current === trimmed) return false // duplicate
    config.apiKeys[providerKey] = [current, trimmed]
    return true
  }
  if (Array.isArray(current)) {
    if (current.includes(trimmed)) return false // duplicate
    current.push(trimmed)
    return true
  }
  // unknown shape — replace
  config.apiKeys[providerKey] = trimmed
  return true
}

/**
 * removeApiKey: Remove an API key for a provider by index, or remove the last one.
 *
 * - Removes the key at `index` if provided, else removes the last key.
 * - If only one key remains after removal, collapses array to string.
 * - If the last key is removed, deletes the provider entry entirely.
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} providerKey — Provider identifier (e.g. 'groq')
 * @param {number} [index] — 0-based index to remove; omit to remove last
 * @returns {boolean} true if a key was removed, false if nothing to remove
 */
export function removeApiKey(config, providerKey, index) {
  if (!config.apiKeys) return false
  const current = config.apiKeys[providerKey]
  if (!current) return false

  if (typeof current === 'string') {
    // Only one key — remove it
    delete config.apiKeys[providerKey]
    return true
  }

  if (Array.isArray(current)) {
    const idx = (index !== undefined && index >= 0 && index < current.length) ? index : current.length - 1
    current.splice(idx, 1)
    if (current.length === 0) {
      delete config.apiKeys[providerKey]
    } else if (current.length === 1) {
      config.apiKeys[providerKey] = current[0] // collapse array-of-1 to string
    }
    return true
  }

  return false
}

/**
 * listApiKeys: Return all configured API keys for a provider as a normalized array.
 * Empty when no key is configured.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {string[]}
 */
export function listApiKeys(config, providerKey) {
  return resolveApiKeys(config, providerKey)
}

/**
 * Resolve all API keys for a provider as an array.
 * Handles: string → [string], string[] → string[], missing → []
 * Filters empty strings. Falls back to envVarName if no config key.
 */
export function resolveApiKeys(config, providerKey, envVarName) {
  const raw = config?.apiKeys?.[providerKey]
  let keys = []
  if (Array.isArray(raw)) {
    keys = raw
  } else if (typeof raw === 'string' && raw.length > 0) {
    keys = [raw]
  } else if (envVarName && process.env[envVarName]) {
    keys = [process.env[envVarName]]
  }
  return keys.filter(k => typeof k === 'string' && k.length > 0)
}

/**
 * Normalize config for disk persistence.
 * Single-element arrays collapse to string. Multi-element arrays stay.
 */
export function normalizeApiKeyConfig(config) {
  if (!config?.apiKeys) return
  for (const [key, val] of Object.entries(config.apiKeys)) {
    if (Array.isArray(val) && val.length === 1) {
      config.apiKeys[key] = val[0]
    }
  }
}

/**
 * 📖 isProviderEnabled: Check if a provider is enabled in config.
 *
 * 📖 Providers are enabled by default if not explicitly set to false.
 * 📖 A provider without an API key should still appear in settings (just can't ping).
 *
 * @param {{ providers: Record<string,{enabled:boolean}> }} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) return true // 📖 Default: enabled
  return providerConfig.enabled !== false
}



/**
 * 📖 _emptyProfileSettings: Default TUI settings.
 *
 * @returns {{ tierFilter: string|null, sortColumn: string, sortAsc: boolean, pingInterval: number, hideUnconfiguredModels: boolean, preferredToolMode: string }}
 */
export function _emptyProfileSettings() {
  return {
    tierFilter: null,     // 📖 null = show all tiers, or 'S'|'A'|'B'|'C'|'D'
    sortColumn: 'avg',    // 📖 default sort column
    sortAsc: true,        // 📖 true = ascending (fastest first for latency)
    pingInterval: 10000,  // 📖 default ms between pings in the steady "normal" mode
    hideUnconfiguredModels: true, // 📖 true = default to providers that are actually configured
    preferredToolMode: 'opencode', // 📖 remember the last Z-selected launcher across app restarts
    proxy: normalizeProxySettings(),
    disableWidthsWarning: false, // 📖 Disable widths warning (default off)
  }
}

function normalizeAnthropicRouting(anthropicRouting = null) {
  const normalizeModelId = (value) => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim().replace(/^fcm-proxy\//, '')
    return trimmed || null
  }

  return {
    // 📖 Mirror free-claude-code naming: MODEL is the fallback, and MODEL_* are
    // 📖 Claude-family overrides. FCM currently pins all four to one selected model.
    model: normalizeModelId(anthropicRouting?.model),
    modelOpus: normalizeModelId(anthropicRouting?.modelOpus),
    modelSonnet: normalizeModelId(anthropicRouting?.modelSonnet),
    modelHaiku: normalizeModelId(anthropicRouting?.modelHaiku),
  }
}

/**
 * 📖 normalizeProxySettings: keep proxy-related preferences stable across old configs,
 * 📖 new installs, and profile switches. Proxy is opt-in by default.
 *
 * 📖 stableToken — persisted bearer token shared between TUI and daemon. Generated once
 *    on first access so env files and tool configs remain valid across restarts.
 * 📖 daemonEnabled — opt-in for the always-on background proxy daemon (launchd / systemd).
 * 📖 daemonConsent — ISO timestamp of when user consented to daemon install, or null.
 *
 * @param {object|undefined|null} proxy
 * @returns {{ enabled: boolean, syncToOpenCode: boolean, preferredPort: number, stableToken: string, daemonEnabled: boolean, daemonConsent: string|null, anthropicRouting: { model: string|null, modelOpus: string|null, modelSonnet: string|null, modelHaiku: string|null } }}
 */
export function normalizeProxySettings(proxy = null) {
  const preferredPort = Number.isInteger(proxy?.preferredPort) && proxy.preferredPort >= 0 && proxy.preferredPort <= 65535
    ? proxy.preferredPort
    : 0

  // 📖 Generate a stable proxy token once and persist it forever
  const stableToken = (typeof proxy?.stableToken === 'string' && proxy.stableToken.length > 0)
    ? proxy.stableToken
    : `fcm_${randomBytes(24).toString('hex')}`

  return {
    enabled: proxy?.enabled === true,
    syncToOpenCode: proxy?.syncToOpenCode === true,
    preferredPort,
    stableToken,
    daemonEnabled: proxy?.daemonEnabled === true,
    daemonConsent: (typeof proxy?.daemonConsent === 'string' && proxy.daemonConsent.length > 0)
      ? proxy.daemonConsent
      : null,
    anthropicRouting: normalizeAnthropicRouting(proxy?.anthropicRouting),
    // 📖 activeTool — legacy field kept only for backward compatibility.
    // 📖 Runtime sync now follows the current Z-selected tool automatically.
    activeTool: (typeof proxy?.activeTool === 'string' && proxy.activeTool.length > 0)
      ? proxy.activeTool
      : null,
  }
}

/**
 * 📖 getProxySettings: return normalized proxy settings from the live config.
 * 📖 This centralizes the opt-in default so launchers do not guess.
 *
 * @param {object} config
 * @returns {{ enabled: boolean, syncToOpenCode: boolean, preferredPort: number }}
 */
export function getProxySettings(config) {
  return normalizeProxySettings(config?.settings?.proxy)
}

/**
 * 📖 Persist the free-claude-code style MODEL / MODEL_OPUS / MODEL_SONNET /
 * 📖 MODEL_HAIKU routing onto one selected proxy model. Claude Code itself then
 * 📖 keeps speaking in fake Claude model ids while the proxy chooses the backend.
 *
 * @param {object} config
 * @param {string} modelId
 * @returns {boolean} true when the normalized proxy settings changed
 */
export function setClaudeProxyModelRouting(config, modelId) {
  const normalizedModelId = typeof modelId === 'string' ? modelId.trim().replace(/^fcm-proxy\//, '') : ''
  if (!normalizedModelId) return false

  if (!config.settings || typeof config.settings !== 'object') config.settings = {}

  const current = getProxySettings(config)
  const nextAnthropicRouting = {
    model: normalizedModelId,
    modelOpus: normalizedModelId,
    modelSonnet: normalizedModelId,
    modelHaiku: normalizedModelId,
  }

  const changed = current.enabled !== true
    || current.anthropicRouting.model !== nextAnthropicRouting.model
    || current.anthropicRouting.modelOpus !== nextAnthropicRouting.modelOpus
    || current.anthropicRouting.modelSonnet !== nextAnthropicRouting.modelSonnet
    || current.anthropicRouting.modelHaiku !== nextAnthropicRouting.modelHaiku

  config.settings.proxy = {
    ...current,
    enabled: true,
    anthropicRouting: nextAnthropicRouting,
  }

  return changed
}

/**
 * 📖 normalizeEndpointInstalls keeps the endpoint-install tracking list safe to replay.
 *
 * 📖 Each entry represents one managed catalog install performed through the `Y` flow:
 *   - `providerKey`: FCM provider identifier (`nvidia`, `groq`, ...)
 *   - `toolMode`: canonical tool id (`opencode`, `openclaw`, `crush`, `goose`)
 *   - `scope`: `all` or `selected`
 *   - `modelIds`: only used when `scope === 'selected'`
 *   - `lastSyncedAt`: informational timestamp updated on successful refresh
 *
 * @param {unknown} endpointInstalls
 * @returns {{ providerKey: string, toolMode: string, scope: 'all'|'selected', modelIds: string[], lastSyncedAt: string | null }[]}
 */
export function normalizeEndpointInstalls(endpointInstalls) {
  if (!Array.isArray(endpointInstalls)) return []
  return endpointInstalls
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const providerKey = typeof entry.providerKey === 'string' ? entry.providerKey.trim() : ''
      const toolMode = typeof entry.toolMode === 'string' ? entry.toolMode.trim() : ''
      if (!providerKey || !toolMode) return null
      const scope = entry.scope === 'selected' ? 'selected' : 'all'
      const modelIds = Array.isArray(entry.modelIds)
        ? [...new Set(entry.modelIds.filter((modelId) => typeof modelId === 'string' && modelId.trim().length > 0))]
        : []
      const lastSyncedAt = typeof entry.lastSyncedAt === 'string' && entry.lastSyncedAt.trim().length > 0
        ? entry.lastSyncedAt
        : null
      return { providerKey, toolMode, scope, modelIds, lastSyncedAt }
    })
    .filter(Boolean)
}

// 📖 Profile system removed - API keys now persist permanently across all sessions

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    favorites: [],
    proxySettings: { enabled: false, routing: {} },
    endpointInstalls: {},
    settings: _emptyProfileSettings(),
  }
}
