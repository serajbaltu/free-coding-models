/**
 * @file lib/token-stats.js
 * @description Persistent token usage tracking for the multi-account proxy.
 *
 * Records per-account and per-model token usage, hourly/daily aggregates,
 * an in-memory ring buffer of the 100 most-recent requests, and an
 * append-only JSONL log file for detailed history.
 *
 * Storage locations:
 *   ~/.free-coding-models/token-stats.json  — aggregated stats (auto-saved every 10 records)
 *   ~/.free-coding-models/request-log.jsonl — timestamped per-request log (pruned after 30 days)
 *
 * @exports TokenStats
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_DATA_DIR = join(homedir(), '.free-coding-models')
const MAX_RING_BUFFER = 100
const RETENTION_DAYS = 30

function timestampToMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

export class TokenStats {
  /**
   * @param {{ dataDir?: string }} [opts]
   *   dataDir  — override the default ~/.free-coding-models directory (used in tests)
   */
  constructor({ dataDir } = {}) {
    this._dataDir = dataDir || DEFAULT_DATA_DIR
    this._statsFile = join(this._dataDir, 'token-stats.json')
    this._logFile = join(this._dataDir, 'request-log.jsonl')
    this._stats = {
      byAccount: {},
      byModel: {},
      hourly: {},
      daily: {},
      quotaSnapshots: { byAccount: {}, byModel: {}, byProvider: {} },
    }
    this._ringBuffer = []
    this._recordsSinceLastSave = 0
    this._load()
    this._pruneOldLogs()
  }

  _load() {
    try {
      mkdirSync(this._dataDir, { recursive: true })
      if (existsSync(this._statsFile)) {
        const loaded = JSON.parse(readFileSync(this._statsFile, 'utf8'))
        this._stats = loaded
      }
    } catch { /* start fresh */ }
    // Ensure quotaSnapshots always exists (backward compat for old files)
    if (!this._stats.quotaSnapshots || typeof this._stats.quotaSnapshots !== 'object') {
      this._stats.quotaSnapshots = { byAccount: {}, byModel: {}, byProvider: {} }
    }
    if (!this._stats.quotaSnapshots.byAccount) this._stats.quotaSnapshots.byAccount = {}
    if (!this._stats.quotaSnapshots.byModel) this._stats.quotaSnapshots.byModel = {}
    if (!this._stats.quotaSnapshots.byProvider) this._stats.quotaSnapshots.byProvider = {}
  }

  _pruneOldLogs() {
    try {
      if (!existsSync(this._logFile)) return
      const cutoff = Date.now() - RETENTION_DAYS * 86400000
      const lines = readFileSync(this._logFile, 'utf8').split('\n').filter(Boolean)
      const kept = lines.filter(line => {
        try {
          const millis = timestampToMillis(JSON.parse(line).timestamp)
          return millis !== null && millis >= cutoff
        } catch {
          return false
        }
      })
      writeFileSync(this._logFile, kept.join('\n') + (kept.length ? '\n' : ''))
    } catch { /* ignore */ }
  }

  /**
   * Record a single request's token usage.
   *
   * @param {{ accountId: string, modelId: string, providerKey?: string, statusCode?: number|string, requestType?: string, promptTokens?: number, completionTokens?: number, latencyMs?: number, success?: boolean }} entry
   */
  record(entry) {
    const {
      accountId,
      modelId,
      providerKey = 'unknown',
      statusCode = 200,
      requestType = 'chat.completions',
      promptTokens = 0,
      completionTokens = 0,
      latencyMs = 0,
      success = true,
    } = entry
    const totalTokens = promptTokens + completionTokens
    const now = new Date()
    const hourKey = now.toISOString().slice(0, 13)
    const dayKey = now.toISOString().slice(0, 10)

    // By account
    const acct = this._stats.byAccount[accountId] ||= { requests: 0, tokens: 0, errors: 0 }
    acct.requests++
    acct.tokens += totalTokens
    if (!success) acct.errors++

    // By model
    const model = this._stats.byModel[modelId] ||= { requests: 0, tokens: 0 }
    model.requests++
    model.tokens += totalTokens

    // Hourly
    this._stats.hourly[hourKey] ||= { requests: 0, tokens: 0 }
    this._stats.hourly[hourKey].requests++
    this._stats.hourly[hourKey].tokens += totalTokens

    // Daily
    this._stats.daily[dayKey] ||= { requests: 0, tokens: 0 }
    this._stats.daily[dayKey].requests++
    this._stats.daily[dayKey].tokens += totalTokens

    // Ring buffer (newest at end)
    this._ringBuffer.push({ ...entry, timestamp: now.toISOString() })
    if (this._ringBuffer.length > MAX_RING_BUFFER) this._ringBuffer.shift()

    // JSONL log
    try {
      const logEntry = {
        timestamp: now.toISOString(),
        accountId,
        modelId,
        providerKey,
        statusCode,
        requestType,
        promptTokens,
        completionTokens,
        latencyMs,
        success,
      }
      appendFileSync(this._logFile, JSON.stringify(logEntry) + '\n')
    } catch { /* ignore */ }

    // Auto-save every 10 records
    this._recordsSinceLastSave++
    if (this._recordsSinceLastSave >= 10) this.save()
  }

  save() {
    try {
      mkdirSync(this._dataDir, { recursive: true })
      writeFileSync(this._statsFile, JSON.stringify(this._stats, null, 2))
      this._recordsSinceLastSave = 0
    } catch { /* ignore */ }
  }

  /**
   * Persist a quota snapshot for a single account.
   * Also recomputes the per-model aggregate quota if modelId is provided.
   * Tracks latest provider-level quota snapshot when providerKey is provided.
   *
   * Quota snapshots are lightweight (not per-request) and are written to
   * token-stats.json immediately so the TUI can read them without waiting
   * for the next 10-record auto-save cycle.
   *
   * @param {string} accountId
   * @param {{ quotaPercent: number, providerKey?: string, modelId?: string, updatedAt?: string }} opts
   */
  updateQuotaSnapshot(accountId, { quotaPercent, providerKey, modelId, updatedAt } = {}) {
    const snap = {
      quotaPercent,
      updatedAt: updatedAt || new Date().toISOString(),
    }
    if (providerKey !== undefined) snap.providerKey = providerKey
    if (modelId !== undefined) snap.modelId = modelId

    this._stats.quotaSnapshots.byAccount[accountId] = snap

    if (modelId !== undefined) {
      this._recomputeModelQuota(modelId)
    }

    if (providerKey !== undefined) {
      this._stats.quotaSnapshots.byProvider[providerKey] = {
        quotaPercent,
        updatedAt: snap.updatedAt,
      }
    }

    // Persist immediately (quota data must be fresh for TUI reads)
    this.save()
  }

  /**
   * Recompute the per-model quota snapshot by averaging all account snapshots
   * that share the given modelId.
   *
   * @param {string} modelId
   */
  _recomputeModelQuota(modelId) {
    const accountSnaps = Object.values(this._stats.quotaSnapshots.byAccount)
      .filter(s => s.modelId === modelId)

    if (accountSnaps.length === 0) return

    const avgPercent = Math.round(
      accountSnaps.reduce((sum, s) => sum + s.quotaPercent, 0) / accountSnaps.length
    )
    const latestUpdatedAt = accountSnaps.reduce(
      (latest, s) => (s.updatedAt > latest ? s.updatedAt : latest),
      accountSnaps[0].updatedAt
    )

    this._stats.quotaSnapshots.byModel[modelId] = {
      quotaPercent: avgPercent,
      updatedAt: latestUpdatedAt,
    }
  }

  /**
   * Return a summary snapshot including the 10 most-recent requests.
   *
   * @returns {{ byAccount: object, byModel: object, hourly: object, daily: object, recentRequests: object[] }}
   */
  getSummary() {
    return {
      ...this._stats,
      recentRequests: this._ringBuffer.slice(-10),
    }
  }
}
