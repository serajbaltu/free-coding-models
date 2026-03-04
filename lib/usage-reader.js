/**
 * @file lib/usage-reader.js
 * @description Pure functions to read model quota usage from token-stats.json.
 *
 * Designed for TUI consumption: reads the pre-computed `quotaSnapshots.byModel`
 * section from the JSON file written by TokenStats.  Never reads the JSONL log.
 *
 * All functions are pure (no shared mutable state) and handle missing/malformed
 * files gracefully by returning safe fallback values.
 *
 * Default path: ~/.free-coding-models/token-stats.json
 *
 * ## Freshness contract
 * Usage snapshots carry an `updatedAt` ISO timestamp.  Any entry whose
 * `updatedAt` is older than SNAPSHOT_TTL_MS (30 minutes) is excluded and
 * treated as `N/A` by the UI.  Entries that predate this feature (no
 * `updatedAt` field) are included for backward compatibility.
 *
 * @exports SNAPSHOT_TTL_MS
 * @exports loadUsageSnapshot
 * @exports loadUsageMap
 * @exports usageForModelId
 * @exports usageForRow
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_STATS_FILE = join(homedir(), '.free-coding-models', 'token-stats.json')

/**
 * Freshness TTL for quota snapshots in milliseconds (30 minutes).
 * Snapshots older than this are treated as stale and excluded from results.
 * The UI renders stale/missing entries as `N/A`.
 */
export const SNAPSHOT_TTL_MS = 30 * 60 * 1000

/**
 * Returns true when the snapshot entry is considered fresh enough to display.
 *
 * Rules:
 * - If `updatedAt` is absent (older format): include for backward compatibility.
 * - If `updatedAt` parses to a time older than SNAPSHOT_TTL_MS ago: exclude (stale).
 * - If `updatedAt` is within TTL (strictly less than TTL ms ago): include.
 *
 * @param {{ updatedAt?: string }} entry
 * @param {number} [nowMs] - optional current time (ms) for testability
 * @returns {boolean}
 */
function isSnapshotFresh(entry, nowMs = Date.now()) {
  if (!entry || typeof entry.updatedAt !== 'string') return true // backward compat
  const updatedMs = Date.parse(entry.updatedAt)
  if (!Number.isFinite(updatedMs)) return true // unparseable: be generous
  return nowMs - updatedMs < SNAPSHOT_TTL_MS
}

/**
 * Load token-stats.json and return model/provider usage maps.
 * Entries with stale `updatedAt` (older than SNAPSHOT_TTL_MS) are excluded.
 *
 * @param {string} [statsFile]
 * @returns {{ byModel: Record<string, number>, byProvider: Record<string, number> }}
 */
export function loadUsageSnapshot(statsFile = DEFAULT_STATS_FILE) {
  try {
    if (!existsSync(statsFile)) return { byModel: {}, byProvider: {} }
    const raw = readFileSync(statsFile, 'utf8')
    const data = JSON.parse(raw)

    const byModelSrc = data?.quotaSnapshots?.byModel
    const byProviderSrc = data?.quotaSnapshots?.byProvider

    const now = Date.now()

    const byModel = {}
    if (byModelSrc && typeof byModelSrc === 'object') {
      for (const [modelId, entry] of Object.entries(byModelSrc)) {
        if (entry && typeof entry.quotaPercent === 'number' && Number.isFinite(entry.quotaPercent)) {
          if (isSnapshotFresh(entry, now)) {
            byModel[modelId] = entry.quotaPercent
          }
        }
      }
    }

    const byProvider = {}
    if (byProviderSrc && typeof byProviderSrc === 'object') {
      for (const [providerKey, entry] of Object.entries(byProviderSrc)) {
        if (entry && typeof entry.quotaPercent === 'number' && Number.isFinite(entry.quotaPercent)) {
          if (isSnapshotFresh(entry, now)) {
            byProvider[providerKey] = entry.quotaPercent
          }
        }
      }
    }

    return { byModel, byProvider }
  } catch {
    return { byModel: {}, byProvider: {} }
  }
}

/**
 * Load token-stats.json and return a plain object mapping modelId → quotaPercent.
 *
 * Only includes models whose `quotaPercent` is a finite number and whose
 * snapshot is fresh (within SNAPSHOT_TTL_MS).
 * Returns an empty object on any error (missing file, bad JSON, missing keys).
 *
 * @param {string} [statsFile] - Path to token-stats.json (defaults to ~/.free-coding-models/token-stats.json)
 * @returns {Record<string, number>}  e.g. { 'claude-3-5': 80, 'gpt-4o': 45 }
 */
export function loadUsageMap(statsFile = DEFAULT_STATS_FILE) {
  return loadUsageSnapshot(statsFile).byModel
}

/**
 * Return the quota percent remaining for a specific model.
 * Returns null if the model has no snapshot or its snapshot is stale.
 *
 * @param {string} modelId
 * @param {string} [statsFile] - Path to token-stats.json (defaults to ~/.free-coding-models/token-stats.json)
 * @returns {number | null}  quota percent (0–100), or null if unknown/stale
 */
export function usageForModelId(modelId, statsFile = DEFAULT_STATS_FILE) {
  const map = loadUsageMap(statsFile)
  const value = map[modelId]
  return value !== undefined ? value : null
}

/**
 * Return quota percent for a table row with model-first, provider fallback.
 * Both model and provider snapshots are checked for freshness independently.
 * Returns null when both are absent or stale.
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @param {string} [statsFile]
 * @returns {number | null}
 */
export function usageForRow(providerKey, modelId, statsFile = DEFAULT_STATS_FILE) {
  const { byModel, byProvider } = loadUsageSnapshot(statsFile)
  if (byModel[modelId] !== undefined) return byModel[modelId]
  if (byProvider[providerKey] !== undefined) return byProvider[providerKey]
  return null
}
