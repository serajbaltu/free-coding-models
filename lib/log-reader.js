/**
 * @file lib/log-reader.js
 * @description Pure functions to load recent request-log entries from
 *   ~/.free-coding-models/request-log.jsonl, newest-first, bounded by a
 *   configurable row limit.
 *
 * Design principles:
 *   - Bounded reads only — never slurp the entire log for every TUI repaint.
 *   - Tolerates malformed / partially-written JSONL lines by skipping them.
 *   - No shared mutable state (pure functions, injectable file path for tests).
 *   - No new npm dependencies — uses only Node.js built-ins.
 *
 * Default path:
 *   ~/.free-coding-models/request-log.jsonl
 *
 * Row object shape returned from loadRecentLogs():
 *   {
 *     time:     string   // ISO timestamp string  (from entry.timestamp)
 *     requestType: string // e.g. "chat.completions"
 *     model:    string   // e.g. "llama-3.3-70b-instruct"
 *     provider: string   // e.g. "nvidia"
 *     status:   string   // e.g. "200" | "429" | "error"
 *     tokens:   number   // promptTokens + completionTokens (0 if unknown)
 *     latency:  number   // ms (0 if unknown)
 *   }
 *
 * @exports loadRecentLogs
 * @exports parseLogLine
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_LOG_FILE = join(homedir(), '.free-coding-models', 'request-log.jsonl')

/** Maximum bytes to read from the tail of the file to avoid OOM on large logs. */
const MAX_READ_BYTES = 128 * 1024 // 128 KB

function normalizeTimestamp(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString()
  }
  if (typeof raw === 'string') {
    const numeric = Number(raw)
    if (Number.isFinite(numeric)) return new Date(numeric).toISOString()
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return null
}

function inferProvider(entry) {
  if (entry.providerKey || entry.provider) {
    return String(entry.providerKey ?? entry.provider)
  }
  if (typeof entry.accountId === 'string' && entry.accountId.includes('/')) {
    return entry.accountId.split('/')[0] || 'unknown'
  }
  return 'unknown'
}

function inferStatus(entry) {
  if (entry.statusCode !== undefined || entry.status !== undefined) {
    return String(entry.statusCode ?? entry.status)
  }
  if (typeof entry.success === 'boolean') {
    return entry.success ? '200' : 'error'
  }
  return 'unknown'
}

function inferRequestType(entry) {
  if (entry.requestType !== undefined || entry.type !== undefined) {
    return String(entry.requestType ?? entry.type)
  }
  if (typeof entry.url === 'string') {
    if (entry.url.includes('/chat/completions')) return 'chat.completions'
    if (entry.url.includes('/models')) return 'models'
  }
  return 'chat.completions'
}

/**
 * Parse a single JSONL line into a normalised log row object.
 *
 * Returns `null` for any line that is blank, not valid JSON, or missing
 * the required `timestamp` field.
 *
 * @param {string} line - A single text line from the JSONL file.
 * @returns {{ time: string, requestType: string, model: string, provider: string, status: string, tokens: number, latency: number } | null}
 */
export function parseLogLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  let entry
  try {
    entry = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!entry || typeof entry !== 'object') return null
  if (!entry.timestamp) return null

  const normalizedTime = normalizeTimestamp(entry.timestamp)
  if (!normalizedTime) return null

  const model    = String(entry.modelId    ?? entry.model    ?? 'unknown')
  const provider = inferProvider(entry)
  const status   = inferStatus(entry)
  const requestType = inferRequestType(entry)
  const tokens   = (Number(entry.usage?.prompt_tokens ?? entry.promptTokens ?? 0) +
                    Number(entry.usage?.completion_tokens ?? entry.completionTokens ?? 0)) || 0
  const latency  = Number(entry.latencyMs ?? entry.latency ?? 0) || 0

  return {
    time: normalizedTime,
    requestType,
    model,
    provider,
    status,
    tokens,
    latency,
  }
}

/**
 * Load the N most-recent log entries from the JSONL file, newest-first.
 *
 * Only reads up to MAX_READ_BYTES from the end of the file to avoid
 * loading the entire log history.  Malformed lines are silently skipped.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.logFile]  - Path to request-log.jsonl (injectable for tests)
 * @param {number}  [opts.limit]    - Maximum rows to return (default 200)
 * @returns {Array<{ time: string, requestType: string, model: string, provider: string, status: string, tokens: number, latency: number }>}
 */
export function loadRecentLogs({ logFile = DEFAULT_LOG_FILE, limit = 200 } = {}) {
  try {
    if (!existsSync(logFile)) return []

    const fileSize = statSync(logFile).size
    if (fileSize === 0) return []

    // 📖 Read only the tail of the file (bounded by MAX_READ_BYTES) to avoid
    // 📖 reading multi-megabyte logs on every TUI repaint.
    const readBytes = Math.min(fileSize, MAX_READ_BYTES)
    const fileOffset = fileSize - readBytes

    const buf = Buffer.allocUnsafe(readBytes)
    const fd = openSync(logFile, 'r')
    try {
      readSync(fd, buf, 0, readBytes, fileOffset)
    } finally {
      closeSync(fd)
    }

    const text = buf.toString('utf8')

    // 📖 Split on newlines; if we started mid-line (fileOffset > 0), drop
    // 📖 the first (potentially incomplete) line to avoid corrupt JSON.
    const rawLines = text.split('\n')
    const lines = fileOffset > 0 ? rawLines.slice(1) : rawLines

    const rows = []
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
      const row = parseLogLine(lines[i])
      if (row) rows.push(row)
    }
    return rows
  } catch {
    return []
  }
}
