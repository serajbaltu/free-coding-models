/**
 * @file test/token-stats.test.js
 * @description Tests for TokenStats quota snapshot persistence (Task 2).
 *
 * Uses a temporary directory to avoid polluting ~/.free-coding-models.
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TokenStats } from '../lib/token-stats.js'

// ─── Temp dir helpers ─────────────────────────────────────────────────────────

let tmpDataDir

function freshTokenStats() {
  return new TokenStats({ dataDir: tmpDataDir })
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('TokenStats – quota snapshots', () => {
  before(() => {
    tmpDataDir = join(tmpdir(), `fcm-test-${process.pid}-${Date.now()}`)
    mkdirSync(tmpDataDir, { recursive: true })
  })

  after(() => {
    try { rmSync(tmpDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    // Wipe data dir between tests for isolation
    const statsFile = join(tmpDataDir, 'token-stats.json')
    const logFile = join(tmpDataDir, 'request-log.jsonl')
    try { rmSync(statsFile) } catch { /* ignore */ }
    try { rmSync(logFile) } catch { /* ignore */ }
  })

  // ── updateQuotaSnapshot ────────────────────────────────────────────────────

  it('updateQuotaSnapshot stores per-account snapshot', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 75, providerKey: 'prov-a', modelId: 'model-x' })

    const summary = ts.getSummary()
    assert.ok(summary.quotaSnapshots, 'getSummary must include quotaSnapshots')
    assert.ok(summary.quotaSnapshots.byAccount, 'quotaSnapshots must have byAccount map')
    const snap = summary.quotaSnapshots.byAccount['acct-1']
    assert.ok(snap, 'byAccount must contain acct-1')
    assert.strictEqual(snap.quotaPercent, 75)
    assert.strictEqual(snap.providerKey, 'prov-a')
    assert.strictEqual(snap.modelId, 'model-x')
    assert.ok(typeof snap.updatedAt === 'string', 'updatedAt must be an ISO string')

    const providerSnap = summary.quotaSnapshots.byProvider['prov-a']
    assert.ok(providerSnap, 'byProvider must contain prov-a')
    assert.strictEqual(providerSnap.quotaPercent, 75)
  })

  it('updateQuotaSnapshot keeps latest provider quota across models', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 90, providerKey: 'groq', modelId: 'model-a' })
    ts.updateQuotaSnapshot('acct-2', { quotaPercent: 62, providerKey: 'groq', modelId: 'model-b' })

    const providerSnap = ts.getSummary().quotaSnapshots.byProvider.groq
    assert.ok(providerSnap)
    assert.strictEqual(providerSnap.quotaPercent, 62)
  })

  it('updateQuotaSnapshot overwrites previous snapshot for the same account', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 75, providerKey: 'prov-a', modelId: 'model-x' })
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 50, providerKey: 'prov-a', modelId: 'model-x' })

    const snap = ts.getSummary().quotaSnapshots.byAccount['acct-1']
    assert.strictEqual(snap.quotaPercent, 50, 'Second update must overwrite first')
  })

  it('updateQuotaSnapshot computes per-model quotaPercent as average of accounts sharing model', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 80, providerKey: 'p1', modelId: 'shared-model' })
    ts.updateQuotaSnapshot('acct-2', { quotaPercent: 60, providerKey: 'p2', modelId: 'shared-model' })

    const byModel = ts.getSummary().quotaSnapshots.byModel
    assert.ok(byModel, 'quotaSnapshots must have byModel map')
    const modelSnap = byModel['shared-model']
    assert.ok(modelSnap, 'byModel must contain shared-model')
    assert.strictEqual(modelSnap.quotaPercent, 70, 'Average of 80 and 60 = 70')
    assert.ok(typeof modelSnap.updatedAt === 'string', 'byModel entry must have updatedAt')
  })

  it('updateQuotaSnapshot updates byModel when one account quota changes', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 100, providerKey: 'p1', modelId: 'dynamic-model' })
    ts.updateQuotaSnapshot('acct-2', { quotaPercent: 100, providerKey: 'p2', modelId: 'dynamic-model' })
    // Reduce one account
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 40, providerKey: 'p1', modelId: 'dynamic-model' })

    const modelSnap = ts.getSummary().quotaSnapshots.byModel['dynamic-model']
    assert.strictEqual(modelSnap.quotaPercent, 70, 'Average of 40 and 100 = 70')
  })

  it('updateQuotaSnapshot works without providerKey/modelId (minimal snapshot)', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-min', { quotaPercent: 33 })

    const snap = ts.getSummary().quotaSnapshots.byAccount['acct-min']
    assert.ok(snap, 'minimal snapshot must be stored')
    assert.strictEqual(snap.quotaPercent, 33)
    assert.strictEqual(snap.providerKey, undefined)
    assert.strictEqual(snap.modelId, undefined)
  })

  // ── Persistence ────────────────────────────────────────────────────────────

  it('save() persists quotaSnapshots to token-stats.json', () => {
    const ts = freshTokenStats()
    ts.updateQuotaSnapshot('acct-1', { quotaPercent: 55, providerKey: 'p', modelId: 'm' })
    ts.save()

    const statsFile = join(tmpDataDir, 'token-stats.json')
    assert.ok(existsSync(statsFile), 'token-stats.json must exist after save')
    const saved = JSON.parse(readFileSync(statsFile, 'utf8'))
    assert.ok(saved.quotaSnapshots, 'saved file must include quotaSnapshots')
    assert.strictEqual(saved.quotaSnapshots.byAccount['acct-1'].quotaPercent, 55)
  })

  it('loading a stats file with quotaSnapshots restores them correctly', () => {
    // Write a pre-populated stats file
    const statsFile = join(tmpDataDir, 'token-stats.json')
    const preloaded = {
      byAccount: {}, byModel: {}, hourly: {}, daily: {},
      quotaSnapshots: {
        byAccount: {
          'preloaded-acct': { quotaPercent: 42, updatedAt: '2026-01-01T00:00:00.000Z', providerKey: 'pp', modelId: 'pm' },
        },
        byModel: {
          'pm': { quotaPercent: 42, updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
    }
    writeFileSync(statsFile, JSON.stringify(preloaded))

    const ts = freshTokenStats()
    const snap = ts.getSummary().quotaSnapshots.byAccount['preloaded-acct']
    assert.ok(snap, 'preloaded snapshot must survive load')
    assert.strictEqual(snap.quotaPercent, 42)
  })

  // ── Backward compatibility ─────────────────────────────────────────────────

  it('loads old stats file without quotaSnapshots without crashing', () => {
    const statsFile = join(tmpDataDir, 'token-stats.json')
    const oldSchema = {
      byAccount: { 'old-acct': { requests: 5, tokens: 100, errors: 0 } },
      byModel: { 'old-model': { requests: 5, tokens: 100 } },
      hourly: {}, daily: {},
    }
    writeFileSync(statsFile, JSON.stringify(oldSchema))

    let ts
    assert.doesNotThrow(() => { ts = freshTokenStats() })

    // Old fields must still be accessible
    const summary = ts.getSummary()
    assert.ok(summary.byAccount['old-acct'], 'old byAccount entries must be preserved')
    assert.ok(summary.byModel['old-model'], 'old byModel entries must be preserved')

    // quotaSnapshots should initialise to empty if absent
    assert.ok(summary.quotaSnapshots, 'quotaSnapshots must be present even for old schema')
    assert.deepStrictEqual(summary.quotaSnapshots.byAccount, {})
    assert.deepStrictEqual(summary.quotaSnapshots.byModel, {})
    assert.deepStrictEqual(summary.quotaSnapshots.byProvider, {})
  })

  it('existing record() behavior is unaffected by quota snapshot changes', () => {
    const ts = freshTokenStats()
    ts.record({
      accountId: 'r-acct',
      modelId: 'r-model',
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 100,
      success: true,
    })
    ts.updateQuotaSnapshot('r-acct', { quotaPercent: 80, modelId: 'r-model' })

    const summary = ts.getSummary()
    assert.strictEqual(summary.byAccount['r-acct'].requests, 1)
    assert.strictEqual(summary.byAccount['r-acct'].tokens, 15)
    assert.strictEqual(summary.byModel['r-model'].requests, 1)
    assert.ok(summary.recentRequests.length >= 1)
  })

  it('record() writes enriched JSONL log schema with ISO timestamp', () => {
    const ts = freshTokenStats()
    ts.record({
      accountId: 'acct-1',
      modelId: 'model-1',
      providerKey: 'groq',
      statusCode: 200,
      requestType: 'chat.completions',
      promptTokens: 12,
      completionTokens: 8,
      latencyMs: 99,
      success: true,
    })

    const logFile = join(tmpDataDir, 'request-log.jsonl')
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    assert.strictEqual(lines.length, 1)
    const entry = JSON.parse(lines[0])

    assert.strictEqual(typeof entry.timestamp, 'string')
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), 'timestamp must be parseable ISO date')
    assert.strictEqual(entry.providerKey, 'groq')
    assert.strictEqual(entry.statusCode, 200)
    assert.strictEqual(entry.requestType, 'chat.completions')
    assert.strictEqual(entry.promptTokens, 12)
    assert.strictEqual(entry.completionTokens, 8)
  })

  it('getSummary includes quotaSnapshots even when empty', () => {
    const ts = freshTokenStats()
    const summary = ts.getSummary()
    assert.ok('quotaSnapshots' in summary, 'getSummary must always include quotaSnapshots key')
    assert.ok('byAccount' in summary.quotaSnapshots)
    assert.ok('byModel' in summary.quotaSnapshots)
    assert.ok('byProvider' in summary.quotaSnapshots)
  })
})
