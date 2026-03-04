/**
 * @file test/usage-reader.test.js
 * @description Tests for lib/usage-reader.js pure functions (Task 3).
 *
 * Each describe block gets its own isolated temp directory via makeTempDir().
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadUsageSnapshot, loadUsageMap, usageForModelId, usageForRow, SNAPSHOT_TTL_MS } from '../lib/usage-reader.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create an isolated temp dir; returns helpers + cleanup. */
function makeTempDir(label) {
  const dir = join(tmpdir(), `fcm-ur-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const statsFile = join(dir, 'token-stats.json')
  const write = (data) => writeFileSync(statsFile, JSON.stringify(data))
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  return { dir, statsFile, write, cleanup }
}

/** Return an ISO timestamp that is `offsetMs` milliseconds before now (default 60s = fresh). */
function freshTs(offsetMs = 60 * 1000) {
  return new Date(Date.now() - offsetMs).toISOString()
}

// ─── Suite: loadUsageMap ──────────────────────────────────────────────────────

describe('usage-reader – loadUsageMap', () => {
  let ctx

  before(() => { ctx = makeTempDir('lum') })
  after(() => ctx.cleanup())

  it('returns empty map when file does not exist', () => {
    const nonexistent = join(ctx.dir, 'no-such-file.json')
    const map = loadUsageMap(nonexistent)
    assert.ok(typeof map === 'object' && map !== null, 'must return an object')
    assert.strictEqual(Object.keys(map).length, 0, 'empty map for missing file')
  })

  it('returns empty map when file contains invalid JSON', () => {
    writeFileSync(ctx.statsFile, '{ this is not valid json !!!}')
    const map = loadUsageMap(ctx.statsFile)
    assert.ok(typeof map === 'object' && map !== null)
    assert.strictEqual(Object.keys(map).length, 0)
  })

  it('returns empty map when file is valid JSON but has no quotaSnapshots', () => {
    ctx.write({ byAccount: {}, byModel: {}, hourly: {}, daily: {} })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map).length, 0)
  })

  it('returns empty map when quotaSnapshots.byModel is missing', () => {
    ctx.write({ quotaSnapshots: { byAccount: {} } })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map).length, 0)
  })

  it('returns map of modelId -> quotaPercent for valid stats', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'claude-3-5': { quotaPercent: 80, updatedAt: freshTs() },
          'gpt-4o': { quotaPercent: 45, updatedAt: freshTs() },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map).length, 2)
    assert.strictEqual(map['claude-3-5'], 80)
    assert.strictEqual(map['gpt-4o'], 45)
  })

  it('includes quotaPercent for entry with updatedAt', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'gemini-pro': { quotaPercent: 60, updatedAt: freshTs() },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['gemini-pro'], 60)
  })

  it('skips byModel entries missing quotaPercent field', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'good-model': { quotaPercent: 70, updatedAt: freshTs() },
          'bad-model': { updatedAt: freshTs() }, // missing quotaPercent
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok('good-model' in map, 'good-model must be included')
    assert.ok(!('bad-model' in map), 'bad-model missing quotaPercent must be skipped')
  })

  it('handles non-numeric quotaPercent gracefully (skips entry)', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'fine-model': { quotaPercent: 55, updatedAt: freshTs() },
          'weird-model': { quotaPercent: 'lots', updatedAt: freshTs() },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok('fine-model' in map)
    assert.ok(!('weird-model' in map), 'non-numeric quotaPercent must be skipped')
  })

  it('handles null or empty quotaSnapshots gracefully', () => {
    ctx.write({ quotaSnapshots: null })
    assert.doesNotThrow(() => loadUsageMap(ctx.statsFile))

    ctx.write({ quotaSnapshots: {} })
    const map2 = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map2).length, 0)
  })
})

describe('usage-reader – loadUsageSnapshot', () => {
  let ctx

  before(() => { ctx = makeTempDir('lus') })
  after(() => ctx.cleanup())

  it('returns model and provider maps', () => {
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'model-a': { quotaPercent: 80, updatedAt: freshTs() },
        },
        byProvider: {
          groq: { quotaPercent: 64, updatedAt: freshTs() },
        },
      },
    })

    const snapshot = loadUsageSnapshot(ctx.statsFile)
    assert.strictEqual(snapshot.byModel['model-a'], 80)
    assert.strictEqual(snapshot.byProvider.groq, 64)
  })
})

// ─── Suite: usageForModelId ───────────────────────────────────────────────────

describe('usage-reader – usageForModelId', () => {
  let ctx

  before(() => { ctx = makeTempDir('ufm') })
  after(() => ctx.cleanup())

  it('returns null when model not in map', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'existing-model': { quotaPercent: 70, updatedAt: freshTs() },
        },
      },
    })
    const result = usageForModelId('no-such-model', ctx.statsFile)
    assert.strictEqual(result, null)
  })

  it('returns quotaPercent for known model', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'known-model': { quotaPercent: 88, updatedAt: freshTs() },
        },
      },
    })
    const result = usageForModelId('known-model', ctx.statsFile)
    assert.strictEqual(result, 88)
  })

  it('returns null for missing file', () => {
    const result = usageForModelId('any-model', join(ctx.dir, 'does-not-exist.json'))
    assert.strictEqual(result, null)
  })

  it('returns null for malformed file', () => {
    writeFileSync(ctx.statsFile, 'BROKEN')
    const result = usageForModelId('any-model', ctx.statsFile)
    assert.strictEqual(result, null)
  })
})

describe('usage-reader – usageForRow', () => {
  let ctx

  before(() => { ctx = makeTempDir('ufr') })
  after(() => ctx.cleanup())

  it('prefers model-specific quota when available', () => {
    ctx.write({
      quotaSnapshots: {
        byModel: { 'model-a': { quotaPercent: 71, updatedAt: freshTs() } },
        byProvider: { groq: { quotaPercent: 55, updatedAt: freshTs() } },
      },
    })

    assert.strictEqual(usageForRow('groq', 'model-a', ctx.statsFile), 71)
  })

  it('falls back to provider quota when model is missing', () => {
    ctx.write({
      quotaSnapshots: {
        byModel: {},
        byProvider: { groq: { quotaPercent: 77, updatedAt: freshTs() } },
      },
    })

    assert.strictEqual(usageForRow('groq', 'unknown-model', ctx.statsFile), 77)
  })

  it('returns null when neither model nor provider usage exists', () => {
    ctx.write({ quotaSnapshots: { byModel: {}, byProvider: {} } })
    assert.strictEqual(usageForRow('cerebras', 'model-x', ctx.statsFile), null)
  })
})

// ─── Suite: multi-account aggregation (integration) ──────────────────────────

describe('usage-reader – aggregation from multiple accounts (integration)', () => {
  let ctx

  before(() => { ctx = makeTempDir('agg') })
  after(() => ctx.cleanup())

  it('byModel quotaPercent reflects average of multiple accounts sharing a model', () => {
    // Simulate what TokenStats.updateQuotaSnapshot would produce
    const freshTime = new Date(Date.now() - 60 * 1000).toISOString() // 1 min ago = fresh
    ctx.write({
      quotaSnapshots: {
        byAccount: {
          'acct-a': { quotaPercent: 90, providerKey: 'p1', modelId: 'shared', updatedAt: freshTime },
          'acct-b': { quotaPercent: 50, providerKey: 'p2', modelId: 'shared', updatedAt: freshTime },
        },
        byModel: {
          // Average of 90 + 50 = 70
          'shared': { quotaPercent: 70, updatedAt: freshTime },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['shared'], 70, 'should reflect the stored average')
  })
})

// ─── Suite: snapshot freshness (TTL) ─────────────────────────────────────────

describe('usage-reader – snapshot freshness TTL', () => {
  let ctx

  before(() => { ctx = makeTempDir('ttl') })
  after(() => ctx.cleanup())

  it('exports SNAPSHOT_TTL_MS as a positive number (30 minutes)', () => {
    assert.ok(typeof SNAPSHOT_TTL_MS === 'number', 'SNAPSHOT_TTL_MS must be a number')
    assert.ok(SNAPSHOT_TTL_MS > 0, 'SNAPSHOT_TTL_MS must be positive')
    assert.strictEqual(SNAPSHOT_TTL_MS, 30 * 60 * 1000, 'SNAPSHOT_TTL_MS must be 30 minutes')
  })

  it('loadUsageMap includes fresh model entry (updatedAt within TTL)', () => {
    const freshTime = new Date(Date.now() - 60 * 1000).toISOString() // 1 min ago
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'fresh-model': { quotaPercent: 75, updatedAt: freshTime },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['fresh-model'], 75, 'fresh entry must be included')
  })

  it('loadUsageMap excludes stale model entry (updatedAt older than TTL)', () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString() // 31 min ago
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'stale-model': { quotaPercent: 60, updatedAt: staleTime },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok(!('stale-model' in map), 'stale entry (>30m) must be excluded from loadUsageMap')
  })

  it('loadUsageMap excludes model entry exactly at TTL boundary (exclusive)', () => {
    // Exactly at 30m (boundary): should be treated as stale
    const boundaryTime = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'boundary-model': { quotaPercent: 50, updatedAt: boundaryTime },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok(!('boundary-model' in map), 'entry at exactly TTL boundary must be excluded')
  })

  it('loadUsageMap includes model entry just inside TTL (updatedAt < 30m ago)', () => {
    // 29m59s ago: just within TTL — must be included
    const justFreshTime = new Date(Date.now() - (30 * 60 * 1000 - 1000)).toISOString()
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'just-fresh-model': { quotaPercent: 88, updatedAt: justFreshTime },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['just-fresh-model'], 88, 'entry just inside TTL must be included')
  })

  it('loadUsageMap includes entry without updatedAt (backward compat: no TTL filter)', () => {
    // Old snapshots without updatedAt are included to preserve backward compatibility.
    // (Freshness check only applies when updatedAt is present.)
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'no-timestamp-model': { quotaPercent: 42 },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['no-timestamp-model'], 42, 'entry without updatedAt must still be included for backward compat')
  })

  it('loadUsageSnapshot excludes stale provider entry (updatedAt older than TTL)', () => {
    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString() // 45 min ago
    const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min ago
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'model-b': { quotaPercent: 80, updatedAt: freshTime },
        },
        byProvider: {
          'stale-provider': { quotaPercent: 70, updatedAt: staleTime },
          'fresh-provider': { quotaPercent: 60, updatedAt: freshTime },
        },
      },
    })
    const snap = loadUsageSnapshot(ctx.statsFile)
    assert.ok(!('stale-provider' in snap.byProvider), 'stale provider must be excluded')
    assert.strictEqual(snap.byProvider['fresh-provider'], 60, 'fresh provider must be included')
  })

  it('usageForRow returns null when model snapshot is stale (falls back to provider, but provider also stale)', () => {
    const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString() // 40 min ago
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'stale-model': { quotaPercent: 50, updatedAt: staleTime },
        },
        byProvider: {
          'stale-prov': { quotaPercent: 60, updatedAt: staleTime },
        },
      },
    })
    const result = usageForRow('stale-prov', 'stale-model', ctx.statsFile)
    assert.strictEqual(result, null, 'both model and provider are stale: result must be null')
  })

  it('usageForRow uses fresh provider fallback when model is stale', () => {
    const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    const freshTime = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'stale-model': { quotaPercent: 50, updatedAt: staleTime },
        },
        byProvider: {
          'fresh-prov': { quotaPercent: 72, updatedAt: freshTime },
        },
      },
    })
    const result = usageForRow('fresh-prov', 'stale-model', ctx.statsFile)
    assert.strictEqual(result, 72, 'stale model snapshot must fall back to fresh provider')
  })

  it('usageForModelId returns null when snapshot is stale', () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'some-model': { quotaPercent: 55, updatedAt: staleTime },
        },
      },
    })
    const result = usageForModelId('some-model', ctx.statsFile)
    assert.strictEqual(result, null, 'stale model snapshot must return null from usageForModelId')
  })
})
