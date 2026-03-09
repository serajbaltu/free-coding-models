/**
 * @file token-usage-reader.js
 * @description Reads historical token usage from request-log.jsonl and aggregates it by exact provider + model pair.
 *
 * @details
 *   The TUI already shows live latency and quota state, but that does not tell
 *   you how much you've actually consumed on a given Origin. This module reads
 *   the persistent JSONL request log once at startup and builds a compact
 *   `provider::model -> totalTokens` map for table display.
 *
 *   Why this exists:
 *   - `token-stats.json` keeps convenience aggregates, but not the exact
 *     provider+model sum needed for the new table column.
 *   - `request-log.jsonl` is the source of truth because every proxied request
 *     records prompt and completion token counts with provider context.
 *   - Startup-only parsing keeps runtime overhead negligible during TUI redraws.
 *
 * @functions
 *   → `buildProviderModelTokenKey` — creates a stable aggregation key
 *   → `loadTokenUsageByProviderModel` — reads request-log.jsonl and returns total tokens by provider+model
 *   → `formatTokenTotalCompact` — renders totals as integer K / M strings for narrow columns
 *
 * @exports buildProviderModelTokenKey, loadTokenUsageByProviderModel, formatTokenTotalCompact
 *
 * @see src/log-reader.js
 * @see src/render-table.js
 */

import { loadRecentLogs } from './log-reader.js'

// 📖 buildProviderModelTokenKey keeps provider-scoped totals isolated even when
// 📖 multiple Origins expose the same model ID.
export function buildProviderModelTokenKey(providerKey, modelId) {
  return `${providerKey}::${modelId}`
}

// 📖 loadTokenUsageByProviderModel reads the full bounded log history available
// 📖 through log-reader and sums tokens per exact provider+model pair.
export function loadTokenUsageByProviderModel({ logFile, limit = 50_000 } = {}) {
  const rows = loadRecentLogs({ logFile, limit })
  const totals = {}

  for (const row of rows) {
    const providerKey = typeof row.provider === 'string' ? row.provider : 'unknown'
    const modelId = typeof row.model === 'string' ? row.model : 'unknown'
    const tokens = Number(row.tokens) || 0
    if (tokens <= 0) continue

    const key = buildProviderModelTokenKey(providerKey, modelId)
    totals[key] = (totals[key] || 0) + tokens
  }

  return totals
}

// 📖 formatTokenTotalCompact keeps the new column narrow and scannable:
// 📖 0-999 => raw integer, 1k-999k => Nk, 1m+ => NM, no decimals.
export function formatTokenTotalCompact(totalTokens) {
  const safeTotal = Number(totalTokens) || 0
  if (safeTotal >= 1_000_000) return `${Math.floor(safeTotal / 1_000_000)}M`
  if (safeTotal >= 1_000) return `${Math.floor(safeTotal / 1_000)}k`
  return String(Math.floor(safeTotal))
}
