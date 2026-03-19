/**
 * @file test/test.js
 * @description Unit tests for free-coding-models using Node.js built-in test runner.
 *
 * 📖 Run with: `node --test test/test.js` or `pnpm test`
 * 📖 Uses node:test + node:assert (zero dependencies, works on Node 18+)
 *
 * @functions
 *   → sources.js data integrity — validates model array structure, tiers, uniqueness
 *   → Core logic — getAvg, getVerdict, getUptime, filterByTier, sortResults, findBestModel
 *   → CLI arg parsing — parseArgs covers all flag combinations
 *   → Package & CLI sanity — package.json fields, bin entry, shebang, imports
 *   → Provider key test model discovery — protects settings key-check probes from stale provider catalogs
 *   → Provider key test outcome classification — distinguishes auth failure, rate limits, and no-callable-model cases
 *   → Provider key test diagnostics — explains probe failures in human-readable form
 *
 * @see lib/utils.js — the functions under test
 * @see sources.js — model data validated here
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, accessSync, constants, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// 📖 Import modules under test
import { nvidiaNim, sources, MODELS } from '../sources.js'
import {
  getAvg, getVerdict, getUptime, getP95, getJitter, getStabilityScore,
  sortResults, filterByTier, findBestModel, parseArgs,
  TIER_ORDER, VERDICT_ORDER, TIER_LETTER_MAP,
  scoreModelForTask, getTopRecommendations, TASK_TYPES, PRIORITY_TYPES, CONTEXT_BUDGETS,
  formatCtxWindow, labelFromId
} from '../src/utils.js'
import {
  _emptyProfileSettings,
  normalizeEndpointInstalls, getApiKey,
  buildPersistedConfig
} from '../src/config.js'
import { buildProviderModelTokenKey, loadTokenUsageByProviderModel, formatTokenTotalCompact } from '../src/token-usage-reader.js'
import { renderTable } from '../src/render-table.js'
import { createOverlayRenderers } from '../src/overlays.js'
import { buildProviderModelsUrl, parseProviderModelIds, listProviderTestModels, classifyProviderTestOutcome, buildProviderTestDetail } from '../src/key-handler.js'
import { buildCliHelpText } from '../src/cli-help.js'
import {
  buildToolEnv,
  prepareExternalToolLaunch,
  resolveLauncherModelId,
} from '../src/tool-launchers.js'
import { getToolInstallPlan, isToolInstalled, resolveToolBinaryPath } from '../src/tool-bootstrap.js'
import { TOOL_METADATA, TOOL_MODE_ORDER, getCompatibleTools, isModelCompatibleWithTool, findSimilarCompatibleModels } from '../src/tool-metadata.js'
import { sortResultsWithPinnedFavorites } from '../src/render-helpers.js'
import { parseMouseEvents, containsMouseSequence, createMouseHandler, MOUSE_ENABLE, MOUSE_DISABLE } from '../src/mouse.js'
import { COLUMN_SORT_MAP } from '../src/render-table.js'
import { startOpenClaw } from '../src/openclaw.js'
import { getConfiguredInstallableProviders, getInstallTargetModes, installProviderEndpoints } from '../src/endpoint-installer.js'
import { cleanupLegacyProxyArtifacts } from '../src/legacy-proxy-cleanup.js'
import {
  buildFixTasks,
  classifyToolTranscript,
  createTestfcmRunId,
  extractJsonPayload,
  hasConfiguredKey,
  normalizeTestfcmToolName,
  pickTestfcmSelectionIndex,
  resolveTestfcmToolSpec,
} from '../src/testfcm.js'
import {
  buildCommandPaletteEntries,
  fuzzyMatchCommand,
  filterCommandPaletteEntries,
} from '../src/command-palette.js'

// ─── Helper: create a mock model result ──────────────────────────────────────
// 📖 Builds a minimal result object matching the shape used by the main script
function mockResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'test/model',
    label: 'Test Model',
    tier: 'S',
    sweScore: '50.0%',
    ctx: '128k',
    status: 'up',
    pings: [],
    httpCode: null,
    ...overrides,
  }
}

describe('command palette fuzzy search', () => {
  it('matches in-order characters and returns highlight positions', () => {
    const out = fuzzyMatchCommand('srt', 'Sort by rank')
    assert.equal(out.matched, true)
    assert.ok(out.score > 0)
    assert.deepEqual(out.positions, [0, 2, 3])
  })

  it('returns no match when query letters are missing', () => {
    const out = fuzzyMatchCommand('zzz', 'Sort by rank')
    assert.equal(out.matched, false)
    assert.equal(out.score, 0)
    assert.deepEqual(out.positions, [])
  })

  it('ranks direct label matches above keyword-only matches', () => {
    const entries = buildCommandPaletteEntries()
    const commandsOnly = entries.filter(e => e.type === 'command')
    const ranked = filterCommandPaletteEntries(commandsOnly, 'uptime')
    assert.ok(ranked.length > 0)
    assert.equal(ranked[0].id, 'sort-uptime')
  })

  it('keeps a stable category+label order when scores tie', () => {
    const tied = [
      { id: 'x', label: 'Alpha', type: 'command', depth: 1, hasChildren: false, isExpanded: false, shortcut: null, keywords: ['foo'] },
      { id: 'y', label: 'Beta', type: 'command', depth: 1, hasChildren: false, isExpanded: false, shortcut: null, keywords: ['foo'] },
    ]
    const ranked = filterCommandPaletteEntries(tied, 'foo')
    assert.ok(ranked.length >= 2)
  })

  it('exposes explicit ping mode commands in the action submenu', () => {
    const entries = buildCommandPaletteEntries()
    const ids = new Set(entries.map((entry) => entry.id))
    assert.ok(ids.has('action-set-ping-speed'))
    assert.ok(ids.has('action-set-ping-normal'))
    assert.ok(ids.has('action-set-ping-slow'))
    assert.ok(ids.has('action-set-ping-forced'))
  })

  it('exposes explicit tool and favorites mode commands in the action submenu', () => {
    const entries = buildCommandPaletteEntries()
    const ids = new Set(entries.map((entry) => entry.id))
    assert.ok(ids.has('action-set-tool-opencode'))
    assert.ok(ids.has('action-set-tool-opencode-desktop'))
    assert.ok(ids.has('action-set-tool-openclaw'))
    assert.ok(ids.has('action-toggle-favorite-mode'))
    assert.ok(ids.has('action-favorites-mode-pinned'))
    assert.ok(ids.has('action-favorites-mode-normal'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 1. SOURCES.JS DATA INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════
describe('sources.js data integrity', () => {
  const VALID_TIERS = ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']

  it('nvidiaNim is a non-empty array', () => {
    assert.ok(Array.isArray(nvidiaNim))
    assert.ok(nvidiaNim.length > 0, 'nvidiaNim should have models')
  })

  it('every model entry has [modelId, label, tier, sweScore, ctx] structure', () => {
    for (const entry of nvidiaNim) {
      assert.ok(Array.isArray(entry), `Entry should be an array: ${JSON.stringify(entry)}`)
      assert.equal(entry.length, 5, `Entry should have 5 elements: ${JSON.stringify(entry)}`)
      assert.equal(typeof entry[0], 'string', `modelId should be string: ${entry[0]}`)
      assert.equal(typeof entry[1], 'string', `label should be string: ${entry[1]}`)
      assert.equal(typeof entry[2], 'string', `tier should be string: ${entry[2]}`)
      assert.equal(typeof entry[3], 'string', `sweScore should be string: ${entry[3]}`)
      assert.equal(typeof entry[4], 'string', `ctx should be string: ${entry[4]}`)
    }
  })

  it('all tiers are valid', () => {
    for (const [modelId, , tier] of nvidiaNim) {
      assert.ok(VALID_TIERS.includes(tier), `Invalid tier "${tier}" for model "${modelId}"`)
    }
  })

  it('no duplicate model IDs', () => {
    const ids = nvidiaNim.map(m => m[0])
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    assert.deepEqual(dupes, [], `Duplicate model IDs found: ${dupes.join(', ')}`)
  })

  it('MODELS flat array matches sources count', () => {
    let totalFromSources = 0
    for (const s of Object.values(sources)) {
      totalFromSources += s.models.length
    }
    assert.equal(MODELS.length, totalFromSources, 'MODELS length should match sum of all source models')
  })

  it('sources object has nvidia key with correct structure', () => {
    assert.ok(sources.nvidia, 'sources.nvidia should exist')
    assert.equal(sources.nvidia.name, 'NIM')
    assert.ok(Array.isArray(sources.nvidia.models))
    assert.equal(sources.nvidia.models, nvidiaNim)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 2. CORE LOGIC FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
describe('getAvg', () => {
  it('returns Infinity when no pings', () => {
    assert.equal(getAvg(mockResult({ pings: [] })), Infinity)
  })

  it('returns Infinity when no successful pings', () => {
    assert.equal(getAvg(mockResult({ pings: [{ ms: 500, code: '500' }] })), Infinity)
  })

  it('calculates average from successful pings only', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '200' },
        { ms: 999, code: '500' }, // 📖 should be ignored
      ]
    })
    assert.equal(getAvg(r), 300)
  })

  it('includes 401 pings because no-key responses still measure real latency', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '401' },
        { ms: 999, code: '500' },
      ]
    })
    assert.equal(getAvg(r), 300)
  })

  it('rounds to integer', () => {
    const r = mockResult({
      pings: [{ ms: 333, code: '200' }, { ms: 334, code: '200' }]
    })
    assert.equal(getAvg(r), 334) // 📖 (333+334)/2 = 333.5 → 334
  })
})

describe('getVerdict', () => {
  it('returns Overloaded for 429 status', () => {
    assert.equal(getVerdict(mockResult({ httpCode: '429', pings: [{ ms: 100, code: '429' }] })), 'Overloaded')
  })

  it('returns Perfect for fast avg (<400ms)', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 200, code: '200' }] })), 'Perfect')
  })

  it('returns Normal for avg 400-999ms', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 500, code: '200' }] })), 'Normal')
  })

  it('returns Slow for avg 1000-2999ms', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 2000, code: '200' }] })), 'Slow')
  })

  it('returns Very Slow for avg 3000-4999ms', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 4000, code: '200' }] })), 'Very Slow')
  })

  it('returns Unstable for timeout with prior success', () => {
    assert.equal(getVerdict(mockResult({
      status: 'timeout',
      pings: [{ ms: 200, code: '200' }, { ms: 0, code: '000' }]
    })), 'Unstable')
  })

  it('returns Not Active for timeout without prior success', () => {
    assert.equal(getVerdict(mockResult({ status: 'timeout', pings: [{ ms: 0, code: '000' }] })), 'Not Active')
  })

  it('returns Pending when no successful pings and status is up', () => {
    assert.equal(getVerdict(mockResult({ status: 'up', pings: [] })), 'Pending')
  })

  it('uses 401-only latency samples for noauth verdicts', () => {
    assert.equal(getVerdict(mockResult({
      status: 'noauth',
      httpCode: '401',
      pings: [{ ms: 350, code: '401' }]
    })), 'Perfect')
  })
})

describe('getUptime', () => {
  it('returns 0 when no pings', () => {
    assert.equal(getUptime(mockResult({ pings: [] })), 0)
  })

  it('returns 100 when all pings succeed', () => {
    assert.equal(getUptime(mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 200, code: '200' }]
    })), 100)
  })

  it('returns 50 when half succeed', () => {
    assert.equal(getUptime(mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 0, code: '500' }]
    })), 50)
  })

  it('returns 0 when none succeed', () => {
    assert.equal(getUptime(mockResult({
      pings: [{ ms: 0, code: '500' }, { ms: 0, code: '429' }]
    })), 0)
  })
})

describe('provider key test model discovery', () => {
  it('derives /models from a chat completions url', () => {
    assert.equal(
      buildProviderModelsUrl('https://api.sambanova.ai/v1/chat/completions'),
      'https://api.sambanova.ai/v1/models'
    )
  })

  it('returns null when the provider url is not chat/completions', () => {
    assert.equal(buildProviderModelsUrl('https://api.replicate.com/v1/predictions'), null)
  })

  it('parses model ids from an OpenAI-style /models payload', () => {
    assert.deepEqual(
      parseProviderModelIds({
        data: [
          { id: 'DeepSeek-V3-0324' },
          { id: 'Meta-Llama-3.1-8B-Instruct' },
          { nope: true },
        ],
      }),
      ['DeepSeek-V3-0324', 'Meta-Llama-3.1-8B-Instruct']
    )
  })

  it('prioritizes the SambaNova override ahead of discovered and static ids', () => {
    assert.deepEqual(
      listProviderTestModels('sambanova', sources.sambanova, ['Qwen3-235B', 'DeepSeek-V3-0324']).slice(0, 4),
      ['DeepSeek-V3-0324', 'Qwen3-235B', 'MiniMax-M2.5', 'DeepSeek-R1-0528']
    )
  })

  it('uses discovered repo-known ids before the static catalog head for NVIDIA', () => {
    assert.deepEqual(
      listProviderTestModels('nvidia', sources.nvidia, ['openai/gpt-oss-120b', 'deepseek-ai/deepseek-v3.2']).slice(0, 5),
      [
        'deepseek-ai/deepseek-v3.1-terminus',
        'openai/gpt-oss-120b',
        'deepseek-ai/deepseek-v3.2',
        'moonshotai/kimi-k2.5',
        'z-ai/glm5',
      ]
    )
  })

  it('falls back to static models when no discovery data exists', () => {
    assert.equal(
      listProviderTestModels('groq', sources.groq)[0],
      'llama-3.3-70b-versatile'
    )
  })
})

describe('classifyProviderTestOutcome', () => {
  it('returns ok when any probe succeeds', () => {
    assert.equal(classifyProviderTestOutcome(['404', '200']), 'ok')
  })

  it('returns fail on auth errors', () => {
    assert.equal(classifyProviderTestOutcome(['403']), 'auth_error')
  })

  it('returns rate_limited when all attempted probes are throttled', () => {
    assert.equal(classifyProviderTestOutcome(['429', '429']), 'rate_limited')
  })

  it('returns no_callable_model when every attempted model is missing', () => {
    assert.equal(classifyProviderTestOutcome(['404', '410', '404']), 'no_callable_model')
  })

  it('falls back to fail for mixed non-auth transport or server errors', () => {
    assert.equal(classifyProviderTestOutcome(['404', '500', 'ERR']), 'fail')
  })
})

describe('buildProviderTestDetail', () => {
  it('mentions auth rejection and attempt history', () => {
    const detail = buildProviderTestDetail('Groq', 'auth_error', [
      { attempt: 1, model: 'llama-3.3-70b-versatile', code: '401' },
    ], 'Live model discovery returned HTTP 401; falling back to the repo catalog.')

    assert.match(detail, /Groq rejected the configured key/i)
    assert.match(detail, /invalid, expired, revoked, or truncated/i)
    assert.match(detail, /#1 llama-3\.3-70b-versatile -> 401/)
  })

  it('explains rate limiting separately from auth failure', () => {
    const detail = buildProviderTestDetail('OpenRouter', 'rate_limited', [
      { attempt: 1, model: 'qwen/qwen3-coder:free', code: '429' },
      { attempt: 2, model: 'openai/gpt-oss-120b:free', code: '429' },
    ])

    assert.match(detail, /throttled every probe/i)
    assert.match(detail, /quota window/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 2b. STABILITY FUNCTIONS (p95, jitter, stability score)
// ═══════════════════════════════════════════════════════════════════════════════
describe('getP95', () => {
  it('returns Infinity when no pings', () => {
    assert.equal(getP95(mockResult({ pings: [] })), Infinity)
  })

  it('returns Infinity when no successful pings', () => {
    assert.equal(getP95(mockResult({ pings: [{ ms: 500, code: '500' }] })), Infinity)
  })

  it('returns the single value when one ping', () => {
    assert.equal(getP95(mockResult({ pings: [{ ms: 300, code: '200' }] })), 300)
  })

  it('returns the highest value for small sets', () => {
    // With 5 pings: ceil(5 * 0.95) - 1 = 4 → last element
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 200, code: '200' },
        { ms: 300, code: '200' }, { ms: 400, code: '200' },
        { ms: 5000, code: '200' },
      ]
    })
    assert.equal(getP95(r), 5000)
  })

  it('ignores non-200 pings', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 200, code: '200' },
        { ms: 99999, code: '500' }, // should be ignored
      ]
    })
    assert.equal(getP95(r), 200)
  })

  it('includes 401 pings in percentile calculations', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '401' },
        { ms: 200, code: '200' },
        { ms: 99999, code: '500' },
      ]
    })
    assert.equal(getP95(r), 200)
  })

  it('catches tail latency spikes with 20 pings', () => {
    // With 20 pings: p95 index = ceil(20 * 0.95) - 1 = 18
    // Need at least 2 high values so index 18 hits the spike
    const pings = Array.from({ length: 18 }, () => ({ ms: 200, code: '200' }))
    pings.push({ ms: 5000, code: '200' })
    pings.push({ ms: 5000, code: '200' })
    const r = mockResult({ pings })
    assert.equal(getP95(r), 5000)
  })
})

describe('getJitter', () => {
  it('returns 0 when no pings', () => {
    assert.equal(getJitter(mockResult({ pings: [] })), 0)
  })

  it('returns 0 when only one ping', () => {
    assert.equal(getJitter(mockResult({ pings: [{ ms: 500, code: '200' }] })), 0)
  })

  it('returns 0 when all pings are identical', () => {
    const r = mockResult({
      pings: [{ ms: 300, code: '200' }, { ms: 300, code: '200' }, { ms: 300, code: '200' }]
    })
    assert.equal(getJitter(r), 0)
  })

  it('calculates correct jitter for known values', () => {
    // pings: 100, 300 → mean = 200, variance = ((100-200)^2 + (300-200)^2)/2 = 10000, σ = 100
    const r = mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 300, code: '200' }]
    })
    assert.equal(getJitter(r), 100)
  })

  it('ignores non-200 pings', () => {
    const r = mockResult({
      pings: [
        { ms: 300, code: '200' }, { ms: 300, code: '200' },
        { ms: 99999, code: '500' }, // should be ignored
      ]
    })
    assert.equal(getJitter(r), 0)
  })

  it('includes 401 pings in jitter calculations', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '401' },
        { ms: 300, code: '200' },
        { ms: 99999, code: '500' },
      ]
    })
    assert.equal(getJitter(r), 100)
  })

  it('returns high jitter for spiky latencies', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 5000, code: '200' },
      ]
    })
    // mean = 1325, large std dev
    const jitter = getJitter(r)
    assert.ok(jitter > 1000, `Expected high jitter, got ${jitter}`)
  })
})

describe('getStabilityScore', () => {
  it('returns -1 when no successful pings', () => {
    assert.equal(getStabilityScore(mockResult({ pings: [] })), -1)
    assert.equal(getStabilityScore(mockResult({ pings: [{ ms: 0, code: '500' }] })), -1)
  })

  it('returns high score for consistent fast model', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 210, code: '200' },
        { ms: 190, code: '200' }, { ms: 205, code: '200' },
        { ms: 195, code: '200' },
      ]
    })
    const score = getStabilityScore(r)
    assert.ok(score >= 80, `Expected high stability score, got ${score}`)
  })

  it('computes a stability score from 401 latency samples too', () => {
    const score = getStabilityScore(mockResult({
      status: 'noauth',
      pings: [
        { ms: 200, code: '401' },
        { ms: 220, code: '401' },
        { ms: 210, code: '401' },
      ]
    }))
    assert.ok(score >= 0 && score <= 100, `Score should be 0-100, got ${score}`)
  })

  it('returns low score for spiky model', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 8000, code: '200' },
        { ms: 100, code: '200' }, { ms: 7000, code: '200' },
      ]
    })
    const score = getStabilityScore(r)
    assert.ok(score < 60, `Expected low stability score for spiky model, got ${score}`)
  })

  it('penalizes low uptime', () => {
    const good = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 200, code: '200' },
        { ms: 200, code: '200' }, { ms: 200, code: '200' },
      ]
    })
    const flaky = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 0, code: '500' },
        { ms: 0, code: '500' }, { ms: 0, code: '500' },
      ]
    })
    assert.ok(getStabilityScore(good) > getStabilityScore(flaky))
  })

  it('Model B (consistent 400ms) scores higher than Model A (avg 250ms, spiky p95)', () => {
    // The motivating example from the issue
    const modelA = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 6000, code: '200' }, // p95 spike!
      ]
    })
    const modelB = mockResult({
      pings: [
        { ms: 400, code: '200' }, { ms: 380, code: '200' },
        { ms: 420, code: '200' }, { ms: 410, code: '200' },
        { ms: 390, code: '200' }, { ms: 400, code: '200' },
        { ms: 395, code: '200' }, { ms: 405, code: '200' },
        { ms: 400, code: '200' }, { ms: 400, code: '200' },
      ]
    })
    assert.ok(
      getStabilityScore(modelB) > getStabilityScore(modelA),
      `Model B (consistent) should score higher than Model A (spiky)`
    )
  })

  it('score is between 0 and 100 for valid data', () => {
    const r = mockResult({
      pings: [{ ms: 500, code: '200' }, { ms: 1000, code: '200' }]
    })
    const score = getStabilityScore(r)
    assert.ok(score >= 0 && score <= 100, `Score should be 0-100, got ${score}`)
  })
})

describe('getVerdict stability-aware', () => {
  it('returns Spiky for normal avg but terrible p95 (≥3 pings)', () => {
    // 18 pings at 200ms + 2 at 8000ms
    // avg = (18*200 + 2*8000)/20 = (3600+16000)/20 = 980ms → Normal range
    // p95 index = ceil(20*0.95)-1 = 18, sorted[18] = 8000 → p95 > 5000 → Spiky
    const pings = Array.from({ length: 18 }, () => ({ ms: 200, code: '200' }))
    pings.push({ ms: 8000, code: '200' })
    pings.push({ ms: 8000, code: '200' })
    const r = mockResult({ pings })
    assert.equal(getVerdict(r), 'Spiky')
  })

  it('still returns Perfect for fast avg when p95 is fine', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 210, code: '200' },
        { ms: 190, code: '200' }, { ms: 205, code: '200' },
      ]
    })
    assert.equal(getVerdict(r), 'Perfect')
  })

  it('does not flag Spiky with only 1-2 pings (not enough data)', () => {
    const r = mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 5000, code: '200' }]
    })
    // avg = 2550 which is > 1000 but < 3000, so verdict is Slow (not Spiky)
    // The avg pushes it out of the "fast" range entirely
    const verdict = getVerdict(r)
    assert.ok(verdict !== 'Spiky', `Should not be Spiky with 2 pings, got ${verdict}`)
  })

  it('Spiky is in VERDICT_ORDER', () => {
    assert.ok(VERDICT_ORDER.includes('Spiky'), 'VERDICT_ORDER should include Spiky')
  })
})

describe('filterByTier', () => {
  const results = [
    mockResult({ tier: 'S+', label: 'A' }),
    mockResult({ tier: 'S', label: 'B' }),
    mockResult({ tier: 'A+', label: 'C' }),
    mockResult({ tier: 'A', label: 'D' }),
    mockResult({ tier: 'A-', label: 'E' }),
    mockResult({ tier: 'B+', label: 'F' }),
    mockResult({ tier: 'B', label: 'G' }),
    mockResult({ tier: 'C', label: 'H' }),
  ]

  it('filters S tier (S+ and S)', () => {
    const filtered = filterByTier(results, 'S')
    assert.equal(filtered.length, 2)
    assert.ok(filtered.every(r => ['S+', 'S'].includes(r.tier)))
  })

  it('filters A tier (A+, A, A-)', () => {
    const filtered = filterByTier(results, 'A')
    assert.equal(filtered.length, 3)
  })

  it('filters B tier (B+, B)', () => {
    const filtered = filterByTier(results, 'B')
    assert.equal(filtered.length, 2)
  })

  it('filters C tier (C only)', () => {
    const filtered = filterByTier(results, 'C')
    assert.equal(filtered.length, 1)
  })

  it('is case-insensitive', () => {
    const filtered = filterByTier(results, 's')
    assert.equal(filtered.length, 2)
  })

  it('returns null for invalid tier', () => {
    assert.equal(filterByTier(results, 'X'), null)
  })
})

describe('sortResults', () => {
  it('sorts by avg ascending', () => {
    const results = [
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'asc')
    assert.equal(sorted[0].label, 'Fast')
    assert.equal(sorted[1].label, 'Slow')
  })

  it('sorts by avg descending', () => {
    const results = [
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'desc')
    assert.equal(sorted[0].label, 'Slow')
  })

  it('sorts by tier', () => {
    const results = [
      mockResult({ tier: 'C', label: 'C' }),
      mockResult({ tier: 'S+', label: 'S+' }),
    ]
    const sorted = sortResults(results, 'tier', 'asc')
    assert.equal(sorted[0].tier, 'S+')
  })

  it('sorts by model name', () => {
    const results = [
      mockResult({ label: 'Zeta' }),
      mockResult({ label: 'Alpha' }),
    ]
    const sorted = sortResults(results, 'model', 'asc')
    assert.equal(sorted[0].label, 'Alpha')
  })

  it('sorts by ctx (context window) ascending', () => {
    const results = [
      mockResult({ label: 'Small', ctx: '8k' }),
      mockResult({ label: 'Large', ctx: '128k' }),
      mockResult({ label: 'Medium', ctx: '32k' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.equal(sorted[0].label, 'Small')
    assert.equal(sorted[1].label, 'Medium')
    assert.equal(sorted[2].label, 'Large')
  })

  it('sorts by ctx with million tokens', () => {
    const results = [
      mockResult({ label: 'K', ctx: '128k' }),
      mockResult({ label: 'M', ctx: '1m' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.equal(sorted[0].label, 'K')
    assert.equal(sorted[1].label, 'M')
  })

  it('does not mutate original array', () => {
    const results = [
      mockResult({ label: 'B', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'A', pings: [{ ms: 100, code: '200' }] }),
    ]
    const original = [...results]
    sortResults(results, 'avg', 'asc')
    assert.equal(results[0].label, original[0].label)
  })

  it('sorts by stability descending (most stable first)', () => {
    const stable = mockResult({
      label: 'Stable',
      pings: [
        { ms: 200, code: '200' }, { ms: 210, code: '200' },
        { ms: 190, code: '200' }, { ms: 205, code: '200' },
      ]
    })
    const spiky = mockResult({
      label: 'Spiky',
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 8000, code: '200' },
      ]
    })
    const sorted = sortResults([spiky, stable], 'stability', 'desc')
    assert.equal(sorted[0].label, 'Stable')
  })

  it('sorts by usage ascending (low usagePercent first)', () => {
    const results = [
      mockResult({ label: 'HighUsage', usagePercent: 80 }),
      mockResult({ label: 'LowUsage',  usagePercent: 20 }),
      mockResult({ label: 'MedUsage',  usagePercent: 50 }),
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    assert.equal(sorted[0].label, 'LowUsage')
    assert.equal(sorted[1].label, 'MedUsage')
    assert.equal(sorted[2].label, 'HighUsage')
  })

  it('sorts by usage descending (high usagePercent first)', () => {
    const results = [
      mockResult({ label: 'LowUsage',  usagePercent: 20 }),
      mockResult({ label: 'HighUsage', usagePercent: 80 }),
    ]
    const sorted = sortResults(results, 'usage', 'desc')
    assert.equal(sorted[0].label, 'HighUsage')
    assert.equal(sorted[1].label, 'LowUsage')
  })

  it('treats missing usagePercent as 0 when sorting by usage ascending', () => {
    const results = [
      mockResult({ label: 'HasUsage', usagePercent: 50 }),
      mockResult({ label: 'NoUsage' }),  // no usagePercent field → treated as 0
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    assert.equal(sorted[0].label, 'NoUsage')
    assert.equal(sorted[1].label, 'HasUsage')
  })
})

describe('renderTable health labels', () => {
  it('renders explicit labels for common HTTP failure codes', () => {
    const results = [
      mockResult({ label: '429 model', status: 'down', httpCode: '429', pings: [{ ms: 0, code: '429' }], providerKey: 'nvidia', totalTokens: 0 }),
      mockResult({ label: '410 model', status: 'down', httpCode: '410', pings: [{ ms: 0, code: '410' }], providerKey: 'nvidia', totalTokens: 0 }),
      mockResult({ label: '404 model', status: 'down', httpCode: '404', pings: [{ ms: 0, code: '404' }], providerKey: 'nvidia', totalTokens: 0 }),
      mockResult({ label: '500 model', status: 'down', httpCode: '500', pings: [{ ms: 0, code: '500' }], providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable(results, 0, 0)

    assert.match(output, /429 TRY LATER/)
    assert.match(output, /410 GONE/)
    assert.match(output, /404 NOT FOUND/)
    assert.match(output, /500 ERROR/)
  })

  it('renders auth failure distinctly from missing key', () => {
    const results = [
      mockResult({ label: 'Auth fail', status: 'auth_error', httpCode: '401', pings: [{ ms: 25, code: '401' }], providerKey: 'groq', totalTokens: 0 }),
      mockResult({ label: 'No key', status: 'noauth', httpCode: '401', pings: [{ ms: 25, code: '401' }], providerKey: 'groq', totalTokens: 0 }),
    ]
    const output = renderTable(results, 0, 0)

    assert.match(output, /AUTH FAIL/)
    assert.match(output, /NO KEY/)
  })
})

describe('renderTable outdated footer banner', () => {
  it('renders a dedicated update banner when startup auto-check already found a newer version', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const { version: localVersion } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const output = renderTable(
      results,
      0,
      0,
      null,
      'avg',
      'asc',
      10_000,
      Date.now(),
      'opencode',
      0,
      0,
      20,
      190,
      0,
      null,
      'normal',
      'auto',
      false,
      null,
      false,
      0,
      'idle',
      null,
      false,
      '9.9.9',
      true
    )

    assert.match(output, new RegExp(`Update available: v${escapeRegex(localVersion)} -> v9\\.9\\.9`))
    assert.match(output, /npm install -g free-coding-models@latest/)
    assert.match(output, /⚠ Update available:.*\x1B\[K\n.*N Changelog.*Ctrl\+C Exit/)
  })

  it('stays quiet when no newer version is known', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable(results, 0, 0, null, 'avg', 'asc', 10_000, Date.now(), 'opencode', 0, 0, 20, 190)

    assert.doesNotMatch(output, /Update available:/)
  })

  it('shows the active custom text filter badge between changelog and exit hints', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable(
      results,
      0,
      0,
      null,
      'avg',
      'asc',
      10_000,
      Date.now(),
      'opencode',
      0,
      0,
      20,
      190,
      0,
      null,
      'normal',
      'auto',
      false,
      null,
      false,
      0,
      'idle',
      null,
      false,
      null,
      true,
      true,
      'deep'
    )

    assert.match(output, /X Disable filter: "deep"/)
    assert.match(output, /N Changelog[\s\S]*X Disable filter: "deep"[\s\S]*Ctrl\+C Exit/)
  })

  it('stays quiet in dev-mode render paths even if npm has a newer published version', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable(
      results,
      0,
      0,
      null,
      'avg',
      'asc',
      10_000,
      Date.now(),
      'opencode',
      0,
      0,
      20,
      190,
      0,
      null,
      'normal',
      'auto',
      false,
      null,
      false,
      0,
      'idle',
      null,
      false,
      '9.9.9',
      false
    )

    assert.doesNotMatch(output, /Update available:/)
  })

  it('skips the narrow-terminal overlay when terminal width is 80 columns or wider', () => {
    const output = renderTable(
      [mockResult()],
      0,
      0,
      0,
      'avg',
      'asc',
      10_000,
      Date.now(),
      'opencode',
      0,
      0,
      20,
      120,
      0,
      null,
      'normal',
      'auto',
      false,
      Date.now(),
      false,
      0,
      'idle',
      null,
      false,
      null,
      true
    )

    assert.doesNotMatch(output, /Please maximize your terminal/)
    assert.match(output, /free-coding-models/)
  })
})

describe('renderTable responsive column visibility', () => {
  // 📖 Helper: render with a specific terminalCols value (all other params at sensible defaults)
  const renderAtWidth = (cols) => renderTable(
    [mockResult({ providerKey: 'nvidia', totalTokens: 0, pings: [{ ms: 200, code: '200' }] })],
    0, 0, null, 'avg', 'asc', 10_000, Date.now(), 'opencode',
    0, 0, 30, cols
  )

  // 📖 Full row width = 169 cols (12 data cols + 11 separators + 2 margin)
  // 📖 Compact mode (146 cols): wPing 14→9, wAvg 11→8, wStab 11→8, wSource 14→7, wStatus 18→13
  // 📖 Hide Rank: <146 | Hide Uptime: <137 | Hide Tier: <128 | Hide Stability: <120

  it('shows all columns and full labels at very wide terminal (200 cols)', () => {
    const output = renderAtWidth(200)
    assert.match(output, /Rank/)
    assert.match(output, /Tier/)
    assert.match(output, /Up%/)
    // 📖 Header renders StaBility (capital B for hotkey)
    assert.match(output, /StaBility/)
    assert.match(output, /Latest Ping/)
    assert.match(output, /Avg Ping/)
    // 📖 Full provider header 'PrOviDer' visible
    assert.match(output, /Provider|PrOviDer/)
  })

  it('uses compact labels in compact mode (slightly narrow)', () => {
    // 📖 At 146 cols, compact mode activates but no columns hidden yet
    const output = renderAtWidth(146)
    assert.match(output, /Lat\. P/)
    assert.match(output, /Avg\. P/)
    assert.doesNotMatch(output, /Latest Ping/)
    assert.doesNotMatch(output, /Avg Ping/)
    // 📖 Provider header should be compact 'PrOD…'
    assert.match(output, /PrOD…/)
    // 📖 All optional columns still visible
    assert.match(output, /Rank/)
    assert.match(output, /Up%/)
  })

  it('hides Rank column first when too narrow for compact', () => {
    // 📖 At 137 cols, Rank is hidden (compact = 146, minus Rank col+sep = 137)
    const output = renderAtWidth(137)
    assert.doesNotMatch(output, /Rank/)
    // 📖 Other always-visible columns should still be present
    assert.match(output, /Model/)
    assert.match(output, /Health/)
  })

  it('hides Rank and Up% at narrower widths', () => {
    // 📖 At 128 cols, Rank and Uptime hidden (137 minus Up% col+sep = 128)
    const output = renderAtWidth(128)
    assert.doesNotMatch(output, /Rank/)
    // 📖 Up% header is just 'Up%' — check it is NOT in the output
    assert.doesNotMatch(output, /Up%/)
    assert.match(output, /Model/)
  })

  it('hides Rank, Up%, and Tier at even narrower widths', () => {
    // 📖 At 120 cols, Rank, Uptime, and Tier hidden (128 minus Tier col+sep = 120)
    const output = renderAtWidth(120)
    assert.doesNotMatch(output, /Rank/)
    const lines = output.split('\n')
    const headerLine = lines.find(l => l.includes('Model') && l.includes('Health'))
    assert.ok(headerLine, 'header line should exist')
    assert.ok(!headerLine.includes('Tier'), 'Tier should be hidden at 120 cols')
  })

  it('hides all 4 optional columns at very narrow widths', () => {
    // 📖 At 109 cols, all 4 optional columns hidden (120 minus Stability col+sep = 109)
    const output = renderAtWidth(109)
    assert.doesNotMatch(output, /Rank/)
    // 📖 Stability/StaB. should be gone
    assert.doesNotMatch(output, /Stability/)
    assert.doesNotMatch(output, /StaB\./)
    // 📖 Core columns always present
    assert.match(output, /Model/)
    assert.match(output, /Health/)
    assert.match(output, /Verdict/)
  })

  it('truncates provider name to 4 chars + ellipsis in compact mode', () => {
    // 📖 In compact mode, provider names longer than 5 chars should be truncated
    const output = renderAtWidth(160)
    // 📖 'NIM' is only 3 chars so it should NOT be truncated
    // 📖 But the header should show compact 'PrOD…'
    assert.match(output, /PrOD…/)
  })

  it('truncates health status text in compact mode', () => {
    // 📖 In compact mode, health text after 6 chars gets '…' appended
    // 📖 '✅ UP' is short enough — no truncation expected
    const output = renderAtWidth(160)
    assert.match(output, /UP/)
  })
})

describe('renderSettings provider test badges', () => {
  function buildSettingsRenderer(config) {
    const state = {
      settingsOpen: true,
      settingsCursor: 0,
      settingsEditMode: false,
      settingsAddKeyMode: false,
      settingsEditBuffer: '',
      settingsErrorMsg: null,
      settingsTestResults: {},
      settingsTestDetails: {},
      settingsUpdateState: 'idle',
      settingsUpdateLatestVersion: null,
      settingsUpdateError: null,
      settingsScrollOffset: 0,
      settingsSyncStatus: null,
      activeProfile: null,
      terminalRows: 40,
      terminalCols: 120,
      config,
    }

    return createOverlayRenderers(state, {
      chalk,
      sources: { groq: sources.groq },
      PROVIDER_METADATA: {
        groq: {
          label: 'Groq',
          rateLimits: 'Free dev tier',
          signupUrl: 'https://console.groq.com/keys',
          signupHint: 'API Keys → Create API Key',
        },
      },
      PROVIDER_COLOR: {
        groq: [255, 204, 188],
      },
      LOCAL_VERSION: '0.2.1',
      getApiKey,
      resolveApiKeys: (cfg, providerKey) => {
        const raw = cfg.apiKeys?.[providerKey]
        if (Array.isArray(raw)) return raw
        return typeof raw === 'string' && raw ? [raw] : []
      },
      isProviderEnabled: () => true,
      listProfiles: () => [],
      TIER_CYCLE: ['All'],
      SETTINGS_OVERLAY_BG: null,
      HELP_OVERLAY_BG: null,
      RECOMMEND_OVERLAY_BG: null,
      OVERLAY_PANEL_WIDTH: 120,
      keepOverlayTargetVisible: (currentOffset) => currentOffset,
      sliceOverlayLines: (lines, offset = 0) => ({ visible: lines, offset }),
      tintOverlayLines: (lines) => lines,
      TASK_TYPES: [],
      PRIORITY_TYPES: [],
      CONTEXT_BUDGETS: [],
      FRAMES: ['-'],
      TIER_COLOR: () => '',
      getAvg: () => 0,
      getStabilityScore: () => 0,
      toFavoriteKey: () => '',
      getTopRecommendations: () => [],
      adjustScrollOffset: () => {},
      getPingModel: () => null,
      getConfiguredInstallableProviders: () => [],
      getInstallTargetModes: () => [],
      getProviderCatalogModels: () => [],
      padEndDisplay: (value) => value,
    }).renderSettings
  }

  it('shows Test when a provider has a saved key but no test ran yet', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: { groq: 'gsk_live_key' }, providers: {}, settings: {} })
    const output = renderSettings()

    assert.match(output, /\[Test\]/)
  })

  it('shows Missing Key when a provider has no saved key', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: {} })
    const output = renderSettings()

    assert.match(output, /\[Missing Key 🔑\]/)
  })

  it('does not show the removed Small Width Warnings toggle in settings', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: {} })
    const output = renderSettings()

    assert.doesNotMatch(output, /Small Width Warnings/)
  })

  it('shows the global theme row with the resolved auto label', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: { theme: 'auto' } })
    const output = renderSettings()

    assert.match(output, /Global Theme/)
    assert.match(output, /Auto/)
  })
})

describe('findBestModel', () => {
  it('returns null for empty array', () => {
    assert.equal(findBestModel([]), null)
  })

  it('prefers model that is up', () => {
    const results = [
      mockResult({ label: 'Down', status: 'down', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ label: 'Up', status: 'up', pings: [{ ms: 500, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Up')
  })

  it('prefers fastest avg when both up', () => {
    const results = [
      mockResult({ label: 'Slow', status: 'up', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', status: 'up', pings: [{ ms: 100, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Fast')
  })

  it('prefers higher uptime when avg is equal', () => {
    const results = [
      mockResult({ label: 'Flaky', status: 'up', pings: [{ ms: 300, code: '200' }, { ms: 0, code: '500' }] }),
      mockResult({ label: 'Stable', status: 'up', pings: [{ ms: 300, code: '200' }, { ms: 300, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Stable')
  })

  it('prefers more stable model when avg is equal', () => {
    // Both have same avg (300ms) but different stability
    const results = [
      mockResult({
        label: 'Spiky',
        status: 'up',
        pings: [
          { ms: 100, code: '200' }, { ms: 100, code: '200' },
          { ms: 100, code: '200' }, { ms: 900, code: '200' },
        ]
      }),
      mockResult({
        label: 'Consistent',
        status: 'up',
        pings: [
          { ms: 300, code: '200' }, { ms: 300, code: '200' },
          { ms: 300, code: '200' }, { ms: 300, code: '200' },
        ]
      }),
    ]
    assert.equal(findBestModel(results).label, 'Consistent')
  })
})

describe('renderToolInstallPrompt', () => {
  it('renders the official install command for a missing launcher', () => {
    const installPlan = getToolInstallPlan('opencode', { platform: 'darwin' })
    const state = {
      toolInstallPromptOpen: true,
      toolInstallPromptCursor: 0,
      toolInstallPromptScrollOffset: 0,
      toolInstallPromptMode: 'opencode',
      toolInstallPromptModel: {
        label: 'DeepSeek V3.2',
      },
      toolInstallPromptPlan: installPlan,
      toolInstallPromptErrorMsg: null,
      terminalRows: 40,
      terminalCols: 120,
      config: { settings: {} },
    }

    const renderers = createOverlayRenderers(state, {
      chalk,
      sources,
      PROVIDER_METADATA: {},
      PROVIDER_COLOR: {},
      LOCAL_VERSION: '0.3.18',
      getApiKey: () => null,
      resolveApiKeys: () => [],
      isProviderEnabled: () => true,
      TIER_CYCLE: ['All'],
      OVERLAY_PANEL_WIDTH: 120,
      keepOverlayTargetVisible: (currentOffset) => currentOffset,
      sliceOverlayLines: (lines, offset = 0) => ({ visible: lines, offset }),
      tintOverlayLines: (lines) => lines,
      TASK_TYPES: [],
      PRIORITY_TYPES: [],
      CONTEXT_BUDGETS: [],
      FRAMES: ['-'],
      TIER_COLOR: () => '',
      getAvg: () => 0,
      getStabilityScore: () => 0,
      toFavoriteKey: () => '',
      getTopRecommendations: () => [],
      adjustScrollOffset: () => {},
      getPingModel: () => null,
      getConfiguredInstallableProviders: () => [],
      getInstallTargetModes: () => [],
      getProviderCatalogModels: () => [],
      getToolMeta: () => ({ label: 'OpenCode CLI', emoji: '💻' }),
      getToolInstallPlan: () => installPlan,
      padEndDisplay: (value) => value,
    })

    const output = renderers.renderToolInstallPrompt()
    assert.match(output, /Missing Tool/)
    assert.match(output, /npm install -g opencode-ai/)
    assert.match(output, /DeepSeek V3\.2/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 3. CLI ARG PARSING
// ═══════════════════════════════════════════════════════════════════════════════
describe('parseArgs', () => {
  // 📖 parseArgs expects argv starting from index 0 (like process.argv)
  // 📖 so we prepend ['node', 'script'] to simulate real argv
  const argv = (...args) => ['node', 'script', ...args]

  it('extracts API key from first non-flag arg', () => {
    const result = parseArgs(argv('nvapi-xxx'))
    assert.equal(result.apiKey, 'nvapi-xxx')
  })

  it('returns null apiKey when none given', () => {
    const result = parseArgs(argv('--best'))
    assert.equal(result.apiKey, null)
  })

  it('detects --best flag', () => {
    assert.equal(parseArgs(argv('--best')).bestMode, true)
    assert.equal(parseArgs(argv()).bestMode, false)
  })

  it('detects --fiable flag', () => {
    assert.equal(parseArgs(argv('--fiable')).fiableMode, true)
  })

  it('detects --premium flag', () => {
    assert.equal(parseArgs(argv('--premium')).premiumMode, true)
    assert.equal(parseArgs(argv()).premiumMode, false)
  })

  it('detects --opencode flag', () => {
    assert.equal(parseArgs(argv('--opencode')).openCodeMode, true)
  })

  it('detects --openclaw flag', () => {
    assert.equal(parseArgs(argv('--openclaw')).openClawMode, true)
  })

  it('detects --opencode-desktop flag', () => {
    assert.equal(parseArgs(argv('--opencode-desktop')).openCodeDesktopMode, true)
    assert.equal(parseArgs(argv()).openCodeDesktopMode, false)
  })

  it('detects external tool flags', () => {
    const result = parseArgs(argv(
      '--aider',
      '--crush',
      '--goose',
      '--qwen',
      '--openhands',
      '--amp',
      '--pi'
    ))
    assert.equal(result.aiderMode, true)
    assert.equal(result.crushMode, true)
    assert.equal(result.gooseMode, true)
    assert.equal(result.qwenMode, true)
    assert.equal(result.openHandsMode, true)
    assert.equal(result.ampMode, true)
    assert.equal(result.piMode, true)
  })

  it('detects --no-telemetry flag', () => {
    assert.equal(parseArgs(argv('--no-telemetry')).noTelemetry, true)
    assert.equal(parseArgs(argv()).noTelemetry, false)
  })

  it('detects --help and -h flags', () => {
    assert.equal(parseArgs(argv('--help')).helpMode, true)
    assert.equal(parseArgs(argv('-h')).helpMode, true)
    assert.equal(parseArgs(argv()).helpMode, false)
  })

  it('parses --tier value', () => {
    assert.equal(parseArgs(argv('--tier', 'S')).tierFilter, 'S')
    assert.equal(parseArgs(argv('--tier', 'a')).tierFilter, 'A') // 📖 uppercased
  })

  it('returns null tierFilter when --tier has no value', () => {
    assert.equal(parseArgs(argv('--tier')).tierFilter, null)
    assert.equal(parseArgs(argv('--tier', '--best')).tierFilter, null) // 📖 next arg is a flag
  })

  it('does not capture --tier value as apiKey', () => {
    assert.equal(parseArgs(argv('--tier', 'S')).apiKey, null)
    assert.equal(parseArgs(argv('--opencode', '--tier', 'A')).apiKey, null)
  })

  it('handles multiple flags together', () => {
    const result = parseArgs(argv('nvapi-key', '--opencode', '--best', '--tier', 'S'))
    assert.equal(result.apiKey, 'nvapi-key')
    assert.equal(result.openCodeMode, true)
    assert.equal(result.bestMode, true)
    assert.equal(result.tierFilter, 'S')
  })

  it('flags are case-insensitive', () => {
    assert.equal(parseArgs(argv('--BEST')).bestMode, true)
    assert.equal(parseArgs(argv('--OpenCode')).openCodeMode, true)
    assert.equal(parseArgs(argv('--HELP')).helpMode, true)
  })
})

describe('cli help text', () => {
  it('lists the supported CLI flags for the direct-only app surface', () => {
    const help = buildCliHelpText()
    const expectedEntries = [
      '--opencode',
      '--opencode-desktop',
      '--openclaw',
      '--crush',
      '--goose',
      '--pi',
      '--aider',
      '--qwen',
      '--openhands',
      '--amp',
      '--best',
      '--fiable',
      '--premium',
      '--json',
      '--tier <S|A|B|C>',
      '--recommend',
      '--no-telemetry',
      '--help, -h',
    ]

    for (const entry of expectedEntries) {
      assert.match(help, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 4. PACKAGE & CLI SANITY
// ═══════════════════════════════════════════════════════════════════════════════
describe('package.json sanity', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  it('has required fields', () => {
    assert.ok(pkg.name, 'name is required')
    assert.ok(pkg.version, 'version is required')
    assert.ok(pkg.main, 'main is required')
    assert.ok(pkg.bin, 'bin is required')
    assert.ok(pkg.license, 'license is required')
  })

  it('version matches semver pattern', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  })

  it('bin entry points to existing file', () => {
    const binPath = join(ROOT, pkg.bin['free-coding-models'])
    assert.ok(existsSync(binPath), `bin entry ${pkg.bin['free-coding-models']} should exist`)
  })

  it('main entry points to existing file', () => {
    const mainPath = join(ROOT, pkg.main)
    assert.ok(existsSync(mainPath), `main entry ${pkg.main} should exist`)
  })

  it('type is module (ESM)', () => {
    assert.equal(pkg.type, 'module')
  })

  it('engines requires node >= 18', () => {
    assert.ok(pkg.engines?.node, 'engines.node should be set')
    assert.match(pkg.engines.node, /18/)
  })
})

describe('CLI entry point sanity', () => {
  const binContent = readFileSync(join(ROOT, 'bin/free-coding-models.js'), 'utf8')

  it('has shebang line', () => {
    assert.ok(binContent.startsWith('#!/usr/bin/env node'), 'Should start with shebang')
  })

  it('imports from sources.js', () => {
    // no longer imports sources.js directly
  })

  it('imports from lib/utils.js', () => {
    assert.ok(binContent.includes("from '../src/utils.js'"), 'Should import lib/utils.js')
  })
})

describe('constants consistency', () => {
  it('TIER_ORDER covers all tiers used in sources', () => {
    const tiersInModels = [...new Set(MODELS.map(m => m[2]))]
    for (const tier of tiersInModels) {
      assert.ok(TIER_ORDER.includes(tier), `Tier "${tier}" from models not in TIER_ORDER`)
    }
  })

  it('TIER_LETTER_MAP covers all tier letters', () => {
    assert.deepEqual(Object.keys(TIER_LETTER_MAP).sort(), ['A', 'B', 'C', 'S'])
  })

  it('all TIER_LETTER_MAP values are subsets of TIER_ORDER', () => {
    for (const [letter, tiers] of Object.entries(TIER_LETTER_MAP)) {
      for (const tier of tiers) {
        assert.ok(TIER_ORDER.includes(tier), `TIER_LETTER_MAP['${letter}'] has invalid tier "${tier}"`)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 5. SMART RECOMMEND — SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
describe('Smart Recommend constants', () => {
  it('TASK_TYPES has expected keys', () => {
    assert.deepEqual(Object.keys(TASK_TYPES).sort(), ['quickfix', 'refactor', 'review', 'testgen'])
  })

  it('TASK_TYPES weights sum to 1.0 for each task', () => {
    for (const [key, task] of Object.entries(TASK_TYPES)) {
      const sum = task.sweWeight + task.speedWeight + task.ctxWeight + task.stabilityWeight
      assert.ok(Math.abs(sum - 1.0) < 0.001, `${key} weights sum to ${sum}, expected 1.0`)
    }
  })

  it('PRIORITY_TYPES has expected keys', () => {
    assert.deepEqual(Object.keys(PRIORITY_TYPES).sort(), ['balanced', 'quality', 'speed'])
  })

  it('PRIORITY_TYPES balanced has 1.0 multipliers', () => {
    assert.equal(PRIORITY_TYPES.balanced.speedMultiplier, 1.0)
    assert.equal(PRIORITY_TYPES.balanced.sweMultiplier, 1.0)
  })

  it('CONTEXT_BUDGETS has expected keys', () => {
    assert.deepEqual(Object.keys(CONTEXT_BUDGETS).sort(), ['large', 'medium', 'small'])
  })

  it('CONTEXT_BUDGETS have ascending idealCtx', () => {
    assert.ok(CONTEXT_BUDGETS.small.idealCtx < CONTEXT_BUDGETS.medium.idealCtx)
    assert.ok(CONTEXT_BUDGETS.medium.idealCtx < CONTEXT_BUDGETS.large.idealCtx)
  })
})

describe('scoreModelForTask', () => {
  it('returns 0 for invalid task type', () => {
    assert.equal(scoreModelForTask(mockResult(), 'invalid', 'balanced', 'small'), 0)
  })

  it('returns 0 for invalid priority', () => {
    assert.equal(scoreModelForTask(mockResult(), 'quickfix', 'invalid', 'small'), 0)
  })

  it('returns 0 for invalid context budget', () => {
    assert.equal(scoreModelForTask(mockResult(), 'quickfix', 'balanced', 'invalid'), 0)
  })

  it('returns a score between 0 and 100', () => {
    const r = mockResult({ pings: [{ ms: 200, code: '200' }, { ms: 300, code: '200' }] })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0 && score <= 100, `score ${score} should be 0-100`)
  })

  it('penalizes down models', () => {
    const up = mockResult({ status: 'up', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const down = mockResult({ status: 'down', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const scoreUp = scoreModelForTask(up, 'quickfix', 'balanced', 'small')
    const scoreDown = scoreModelForTask(down, 'quickfix', 'balanced', 'small')
    assert.ok(scoreUp > scoreDown, `up (${scoreUp}) should beat down (${scoreDown})`)
  })

  it('penalizes timeout models', () => {
    const up = mockResult({ status: 'up', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const timeout = mockResult({ status: 'timeout', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const scoreUp = scoreModelForTask(up, 'quickfix', 'balanced', 'small')
    const scoreTimeout = scoreModelForTask(timeout, 'quickfix', 'balanced', 'small')
    assert.ok(scoreUp > scoreTimeout, `up (${scoreUp}) should beat timeout (${scoreTimeout})`)
  })

  it('higher SWE score gives higher score for quality-focused tasks', () => {
    const highSwe = mockResult({ sweScore: '70.0%', pings: [{ ms: 300, code: '200' }], ctx: '128k' })
    const lowSwe = mockResult({ sweScore: '20.0%', pings: [{ ms: 300, code: '200' }], ctx: '128k' })
    const scoreHigh = scoreModelForTask(highSwe, 'refactor', 'quality', 'medium')
    const scoreLow = scoreModelForTask(lowSwe, 'refactor', 'quality', 'medium')
    assert.ok(scoreHigh > scoreLow, `high SWE (${scoreHigh}) should beat low SWE (${scoreLow})`)
  })

  it('faster model scores better for speed-focused quickfix', () => {
    const fast = mockResult({ pings: [{ ms: 100, code: '200' }], sweScore: '40.0%', ctx: '128k' })
    const slow = mockResult({ pings: [{ ms: 4000, code: '200' }], sweScore: '40.0%', ctx: '128k' })
    const scoreFast = scoreModelForTask(fast, 'quickfix', 'speed', 'small')
    const scoreSlow = scoreModelForTask(slow, 'quickfix', 'speed', 'small')
    assert.ok(scoreFast > scoreSlow, `fast (${scoreFast}) should beat slow (${scoreSlow})`)
  })

  it('larger context model scores better for large codebase budget', () => {
    const bigCtx = mockResult({ ctx: '256k', pings: [{ ms: 300, code: '200' }], sweScore: '40.0%' })
    const smallCtx = mockResult({ ctx: '4k', pings: [{ ms: 300, code: '200' }], sweScore: '40.0%' })
    const scoreBig = scoreModelForTask(bigCtx, 'review', 'balanced', 'large')
    const scoreSmall = scoreModelForTask(smallCtx, 'review', 'balanced', 'large')
    assert.ok(scoreBig > scoreSmall, `big ctx (${scoreBig}) should beat small ctx (${scoreSmall})`)
  })

  it('handles missing SWE score (dash)', () => {
    const r = mockResult({ sweScore: '—', pings: [{ ms: 200, code: '200' }] })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0, `score with no SWE should be >= 0`)
  })

  it('handles missing context (dash)', () => {
    const r = mockResult({ ctx: '—', pings: [{ ms: 200, code: '200' }], sweScore: '40.0%' })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0, `score with no ctx should be >= 0`)
  })

  it('handles no pings (Infinity avg)', () => {
    const r = mockResult({ pings: [], sweScore: '40.0%', ctx: '128k' })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0, `score with no pings should be >= 0`)
  })

  it('handles 1m context', () => {
    const r = mockResult({ ctx: '1m', pings: [{ ms: 200, code: '200' }], sweScore: '40.0%' })
    const score = scoreModelForTask(r, 'review', 'balanced', 'large')
    assert.ok(score > 0, `1m context model should score > 0`)
  })
})

describe('getTopRecommendations', () => {
  it('returns topN results', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'b', sweScore: '40.0%', pings: [{ ms: 200, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'c', sweScore: '70.0%', pings: [{ ms: 150, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'd', sweScore: '30.0%', pings: [{ ms: 300, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'e', sweScore: '50.0%', pings: [{ ms: 250, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.equal(recs.length, 3)
  })

  it('returns results sorted by score descending', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'b', sweScore: '30.0%', pings: [{ ms: 500, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'c', sweScore: '70.0%', pings: [{ ms: 150, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.ok(recs[0].score >= recs[1].score, 'first should have highest score')
    assert.ok(recs[1].score >= recs[2].score, 'second should beat third')
  })

  it('excludes hidden results', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'b', sweScore: '90.0%', pings: [{ ms: 50, code: '200' }], ctx: '256k', hidden: true }),
      mockResult({ modelId: 'c', sweScore: '30.0%', pings: [{ ms: 200, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.equal(recs.length, 2, 'hidden model should be excluded')
    const ids = recs.map(r => r.result.modelId)
    assert.ok(!ids.includes('b'), 'hidden model b should not appear')
  })

  it('returns fewer than topN if not enough results', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.equal(recs.length, 1)
  })

  it('each result has result and score fields', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small')
    assert.ok(recs[0].result, 'should have result field')
    assert.equal(typeof recs[0].score, 'number', 'should have numeric score')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 6. PARSEARGS — --profile AND --recommend FLAGS
// ═══════════════════════════════════════════════════════════════════════════════
describe('parseArgs --recommend', () => {
  // 📖 Helper: simulate process.argv (first two entries are node + script path)
  const argv = (...args) => ['node', 'script.js', ...args]

  it('parses --recommend flag', () => {
    assert.equal(parseArgs(argv('--recommend')).recommendMode, true)
  })

  it('recommendMode defaults to false', () => {
    assert.equal(parseArgs(argv()).recommendMode, false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 7. CONFIG PROFILES — pure logic tests (no filesystem I/O)
// ═══════════════════════════════════════════════════════════════════════════════
describe('config profile functions', () => {
  // 📖 Helper: create a minimal config object matching the shape from loadConfig()
  function mockConfig() {
    return {
      apiKeys: { nvidia: 'test-key' },
      providers: { nvidia: true },
      settings: {
        hideUnconfiguredModels: true,
      },
      favorites: ['nvidia/test-model'],
      telemetry: { enabled: false },
      profiles: {},
      activeProfile: null,
    }
  }

  it('_emptyProfileSettings returns expected shape', () => {
    const settings = _emptyProfileSettings()
    assert.equal(typeof settings.tierFilter, 'object') // null
    assert.equal(settings.sortColumn, 'avg')
    assert.equal(settings.sortAsc, true)
    assert.equal(settings.pingInterval, 10000)
    assert.equal(settings.hideUnconfiguredModels, true)
    assert.equal(settings.favoritesPinnedAndSticky, false)
  })

  it('defaults configured-only mode and preferred tool mode in profile settings', () => {
    assert.equal(_emptyProfileSettings().hideUnconfiguredModels, true)
    assert.equal(_emptyProfileSettings().favoritesPinnedAndSticky, false)
    assert.equal(_emptyProfileSettings().preferredToolMode, 'opencode')
    assert.equal(_emptyProfileSettings().theme, 'auto')
  })
})

describe('buildPersistedConfig', () => {
  it('preserves disk apiKeys and favorites when a stale snapshot saves unrelated changes', () => {
    const diskConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
        groq: 'disk-groq',
      },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: ['nvidia/model-a', 'groq/model-b'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
      },
      providers: {},
      settings: { hideUnconfiguredModels: false },
      favorites: ['nvidia/model-a'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig)
    assert.deepEqual(persisted.apiKeys, {
      nvidia: 'disk-nvidia',
      groq: 'disk-groq',
    })
    assert.deepEqual(persisted.favorites, ['nvidia/model-a', 'groq/model-b'])
    assert.equal(persisted.settings.hideUnconfiguredModels, false)
  })

  it('can exactly replace favorites when the caller intentionally removes one', () => {
    const diskConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: ['nvidia/model-a', 'groq/model-b'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: ['groq/model-b'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig, { replaceFavorites: true })
    assert.deepEqual(persisted.favorites, ['groq/model-b'])
  })

  it('can exactly replace apiKeys when a provider key is intentionally removed', () => {
    const diskConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
        groq: 'disk-groq',
      },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
      },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig, { replaceApiKeys: true })
    assert.deepEqual(persisted.apiKeys, { nvidia: 'disk-nvidia' })
  })

  it('can exactly replace tracked endpoint installs when managed catalogs are rewritten', () => {
    const diskConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [
        {
          providerKey: 'groq',
          toolMode: 'goose',
          scope: 'selected',
          modelIds: ['openai/gpt-oss-120b'],
          lastSyncedAt: '2026-03-09T08:00:00.000Z',
        },
      ],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [
        {
          providerKey: 'nvidia',
          toolMode: 'opencode',
          scope: 'selected',
          modelIds: ['deepseek-ai/deepseek-v3.2'],
          lastSyncedAt: '2026-03-10T09:00:00.000Z',
        },
      ],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig, { replaceEndpointInstalls: true })
    assert.deepEqual(persisted.endpointInstalls, [
      {
        providerKey: 'nvidia',
        toolMode: 'opencode',
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v3.2'],
        lastSyncedAt: '2026-03-10T09:00:00.000Z',
      },
    ])
  })
})

// ─── formatCtxWindow ─────────────────────────────────────────────────────────
// 📖 Tests for context window number-to-string conversion used by dynamic OpenRouter discovery
describe('formatCtxWindow', () => {
  it('converts 128000 to 128k', () => {
    assert.equal(formatCtxWindow(128000), '128k')
  })

  it('converts 256000 to 256k', () => {
    assert.equal(formatCtxWindow(256000), '256k')
  })

  it('converts 1048576 to 1M', () => {
    assert.equal(formatCtxWindow(1048576), '1M')
  })

  it('converts 2000000 to 2M', () => {
    assert.equal(formatCtxWindow(2000000), '2M')
  })

  it('converts 32768 to 33k (rounds)', () => {
    assert.equal(formatCtxWindow(32768), '33k')
  })

  it('returns 128k for zero', () => {
    assert.equal(formatCtxWindow(0), '128k')
  })

  it('returns 128k for negative', () => {
    assert.equal(formatCtxWindow(-1), '128k')
  })

  it('returns 128k for non-number', () => {
    assert.equal(formatCtxWindow(null), '128k')
    assert.equal(formatCtxWindow(undefined), '128k')
    assert.equal(formatCtxWindow('128k'), '128k')
  })
})

// ─── labelFromId ─────────────────────────────────────────────────────────────
// 📖 Tests for OpenRouter model ID to human-readable label conversion
describe('labelFromId', () => {
  it('strips :free suffix and org prefix', () => {
    assert.equal(labelFromId('qwen/qwen3-coder:free'), 'Qwen3 Coder')
  })

  it('handles deep nested org paths', () => {
    assert.equal(labelFromId('meta-llama/llama-3.3-70b-instruct:free'), 'Llama 3.3 70b Instruct')
  })

  it('handles underscore-separated names', () => {
    assert.equal(labelFromId('org/model_name_v2:free'), 'Model Name V2')
  })

  it('handles ID without org prefix', () => {
    assert.equal(labelFromId('mimo-v2-flash:free'), 'Mimo V2 Flash')
  })

  it('handles ID without :free suffix', () => {
    assert.equal(labelFromId('qwen/qwen3-coder'), 'Qwen3 Coder')
  })
})

// ─── token-usage-reader ─────────────────────────────────────────────────────
describe('token-usage-reader', () => {
  it('buildProviderModelTokenKey combines provider and model', () => {
    assert.equal(buildProviderModelTokenKey('groq', 'openai/gpt-oss-120b'), 'groq::openai/gpt-oss-120b')
  })

  it('formatTokenTotalCompact renders raw, k, and M with 2 decimals', () => {
    assert.equal(formatTokenTotalCompact(0), '0')
    assert.equal(formatTokenTotalCompact(999), '999')
    assert.equal(formatTokenTotalCompact(1234), '1.23k')
    assert.equal(formatTokenTotalCompact(999999), '1.00M')
    assert.equal(formatTokenTotalCompact(1456789), '1.46M')
  })

  it('loadTokenUsageByProviderModel aggregates tokens per exact provider/model pair', () => {
    const dir = join(tmpdir(), `fcm-token-usage-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const statsFile = join(dir, 'token-stats.json')

    try {
      writeFileSync(statsFile, JSON.stringify({
        byAccount: {
          'groq/openai-gpt-oss-120b/0': { tokens: 1500 },
          'groq/openai-gpt-oss-120b/1': { tokens: 300 },
          'nvidia/openai-gpt-oss-120b/0': { tokens: 5500 },
        },
      }, null, 2))

      const totals = loadTokenUsageByProviderModel({ statsFile })
      assert.equal(totals['groq::openai-gpt-oss-120b'], 1800)
      assert.equal(totals['nvidia::openai-gpt-oss-120b'], 5500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('/testfcm helpers', () => {
  it('normalizes common tool aliases to canonical launcher modes', () => {
    assert.equal(normalizeTestfcmToolName('opencodecli'), 'opencode')
    assert.equal(normalizeTestfcmToolName('crush'), 'crush')
  })

  it('resolves a known tool spec and keeps its CLI flag', () => {
    const spec = resolveTestfcmToolSpec('goose')
    assert.equal(spec?.mode, 'goose')
    assert.equal(spec?.flag, '--goose')
  })

  it('treats string and array API key entries as configured only when non-empty', () => {
    assert.equal(hasConfiguredKey('gsk_live'), true)
    assert.equal(hasConfiguredKey('   '), false)
    assert.equal(hasConfiguredKey(['', '  ', 'gsk_live']), true)
    assert.equal(hasConfiguredKey(['', '  ']), false)
  })

  it('builds compact run ids from timestamps', () => {
    assert.equal(createTestfcmRunId(new Date('2026-03-16T18:45:12.345Z')), '20260316-184512-345')
  })

  it('extracts JSON arrays from mixed stdout text', () => {
    const parsed = extractJsonPayload('  ⚡ Pinging models...\n\n[\n  {"label":"Model A"}\n]\n')
    assert.deepEqual(parsed, [{ label: 'Model A' }])
  })

  it('picks the first clearly healthy preflight row before pressing Enter', () => {
    const index = pickTestfcmSelectionIndex([
      { status: 'down', httpCode: 'ERR' },
      { status: 'up', httpCode: '401' },
      { status: 'up', httpCode: '200' },
      { status: 'up', httpCode: '200' },
    ])
    assert.equal(index, 2)
  })

  it('classifies a successful assistant transcript', () => {
    const result = classifyToolTranscript('Mock Crush ready\nhello, how can i help you?\n')
    assert.equal(result.status, 'passed')
    assert.equal(result.findings.length, 0)
  })

  it('classifies invalid API failures and emits a follow-up task', () => {
    const result = classifyToolTranscript('Error: invalid api key (401 unauthorized)')
    assert.equal(result.status, 'failed')
    assert.equal(result.findings[0]?.id, 'invalid_api_key')
    assert.match(buildFixTasks(result.findings)[0] || '', /Validate the provider key/i)
  })

  it('flags PTY width warnings as actionable harness failures', () => {
    const result = classifyToolTranscript('Please maximize your terminal for optimal use. The current terminal is too small.')
    assert.equal(result.status, 'failed')
    assert.equal(result.findings[0]?.id, 'terminal_too_small')
    assert.match(buildFixTasks(result.findings)[0] || '', /width warning disabled|wider PTY/i)
  })

  it('stays inconclusive when no success or known failure pattern exists', () => {
    const result = classifyToolTranscript('Tool opened, waiting for model...')
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.findings.length, 0)
  })
})

describe('tool launcher env building', () => {
  it('sanitizes inherited OpenAI-compatible vars for direct launches', () => {
    const config = { apiKeys: { nvidia: 'nvapi-test' } }
    const model = { providerKey: 'nvidia', modelId: 'openai/gpt-oss-120b' }
    const inheritedEnv = {
      OPENAI_API_KEY: 'stale-openai-key',
      OPENAI_BASE_URL: 'https://old.example/v1',
      PATH: process.env.PATH || '',
    }

    const { env } = buildToolEnv('crush', model, config, {
      sanitize: true,
      includeCompatDefaults: true,
      includeProviderEnv: false,
      inheritedEnv,
    })

    assert.equal(env.OPENAI_API_KEY, 'nvapi-test')
    assert.match(env.OPENAI_BASE_URL || '', /integrate\.api\.nvidia\.com/)
    assert.equal(env.LLM_MODEL, 'openai/openai/gpt-oss-120b')
  })

  it('keeps launcher model ids provider-native in direct mode', () => {
    assert.equal(resolveLauncherModelId({ modelId: 'deepseek-ai/deepseek-v3.1' }), 'deepseek-ai/deepseek-v3.1')
  })
})

describe('tool bootstrap helpers', () => {
  it('returns the npm install plan for opencode', () => {
    const plan = getToolInstallPlan('opencode', { platform: 'darwin' })
    assert.equal(plan.supported, true)
    assert.equal(plan.binary, 'opencode')
    assert.match(plan.shellCommand || '', /npm install -g opencode-ai/)
  })

  it('returns the official goose installer script on linux', () => {
    const plan = getToolInstallPlan('goose', { platform: 'linux' })
    assert.equal(plan.supported, true)
    assert.match(plan.shellCommand || '', /download_cli\.sh \| CONFIGURE=false bash/)
  })

  it('marks OpenHands auto-install unsupported on native Windows', () => {
    const plan = getToolInstallPlan('openhands', { platform: 'win32' })
    assert.equal(plan.supported, false)
    assert.match(plan.reason || '', /WSL/i)
  })

  it('resolves a fake tool binary from PATH without spawning it', () => {
    const dir = join(tmpdir(), `fcm-tool-bootstrap-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const binaryPath = join(dir, 'crush')

    try {
      writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n')
      chmodSync(binaryPath, 0o755)

      const resolved = resolveToolBinaryPath('crush', { env: { PATH: dir } })
      assert.equal(resolved, binaryPath)
      assert.equal(isToolInstalled('crush', { env: { PATH: dir } }), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tool compatibility matrix', () => {
  it('regular providers are compatible with all non-cliOnly tools', () => {
    const regularTools = getCompatibleTools('nvidia')
    assert.ok(regularTools.includes('opencode'))
    assert.ok(regularTools.includes('opencode-desktop'))
    assert.ok(regularTools.includes('openclaw'))
    assert.ok(regularTools.includes('goose'))
    assert.ok(regularTools.includes('amp'))
    assert.ok(!regularTools.includes('rovo'), 'regular models should NOT be compatible with rovo')
    assert.ok(!regularTools.includes('gemini'), 'regular models should NOT be compatible with gemini')
  })

  it('rovo models are only compatible with rovo', () => {
    const tools = getCompatibleTools('rovo')
    assert.deepEqual(tools, ['rovo'])
  })

  it('gemini models are only compatible with gemini', () => {
    const tools = getCompatibleTools('gemini')
    assert.deepEqual(tools, ['gemini'])
  })

  it('opencode-zen models are only compatible with opencode and opencode-desktop', () => {
    const tools = getCompatibleTools('opencode-zen')
    assert.deepEqual(tools, ['opencode', 'opencode-desktop'])
  })

  it('isModelCompatibleWithTool returns true for matching pairs', () => {
    assert.ok(isModelCompatibleWithTool('nvidia', 'opencode'))
    assert.ok(isModelCompatibleWithTool('rovo', 'rovo'))
    assert.ok(isModelCompatibleWithTool('gemini', 'gemini'))
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'opencode'))
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'opencode-desktop'))
  })

  it('isModelCompatibleWithTool returns false for incompatible pairs', () => {
    assert.ok(!isModelCompatibleWithTool('rovo', 'opencode'))
    assert.ok(!isModelCompatibleWithTool('gemini', 'openclaw'))
    assert.ok(!isModelCompatibleWithTool('opencode-zen', 'goose'))
    assert.ok(!isModelCompatibleWithTool('opencode-zen', 'rovo'))
    assert.ok(!isModelCompatibleWithTool('nvidia', 'rovo'))
  })

  it('every tool in TOOL_MODE_ORDER has an emoji and color', () => {
    for (const toolKey of TOOL_MODE_ORDER) {
      const meta = TOOL_METADATA[toolKey]
      assert.ok(meta, `missing TOOL_METADATA for ${toolKey}`)
      assert.ok(typeof meta.emoji === 'string' && meta.emoji.length >= 1, `${toolKey} needs an emoji`)
      assert.ok(Array.isArray(meta.color) && meta.color.length === 3, `${toolKey} needs a [r,g,b] color`)
    }
  })

  it('all tool emojis are unique (except OpenCode CLI/Desktop sharing 📦)', () => {
    // 📖 OpenCode CLI and Desktop intentionally share 📦 — they are the same platform
    const emojis = TOOL_MODE_ORDER.map(k => TOOL_METADATA[k].emoji)
    const nonShared = emojis.filter(e => e !== '📦')
    const unique = new Set(nonShared)
    assert.equal(unique.size, nonShared.length, `duplicate emojis found (excluding 📦): ${nonShared.join(',')}`)
  })

  it('sources.js opencode-zen has zenOnly flag', () => {
    assert.ok(sources['opencode-zen'], 'opencode-zen source must exist')
    assert.ok(sources['opencode-zen'].zenOnly, 'opencode-zen must have zenOnly: true')
    assert.ok(sources['opencode-zen'].models.length > 0, 'opencode-zen must have models')
  })

  // 📖 findSimilarCompatibleModels tests
  it('findSimilarCompatibleModels returns models sorted by SWE delta', () => {
    const mockResults = [
      { modelId: 'a', label: 'Model A', tier: 'S+', sweScore: '72.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Model B', tier: 'S', sweScore: '65.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'c', label: 'Model C', tier: 'A+', sweScore: '80.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'd', label: 'Model D', tier: 'A', sweScore: '50.0%', providerKey: 'nvidia', hidden: false },
    ]
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 3)
    assert.equal(result.length, 3)
    // 📖 Closest to 70.0% should be 72.0% (delta 2), then 65.0% (delta 5), then 80.0% (delta 10)
    assert.equal(result[0].sweScore, '72.0%')
    assert.equal(result[1].sweScore, '65.0%')
    assert.equal(result[2].sweScore, '80.0%')
  })

  it('findSimilarCompatibleModels excludes incompatible models', () => {
    const mockResults = [
      { modelId: 'a', label: 'Regular', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Rovo Only', tier: 'S', sweScore: '71.0%', providerKey: 'rovo', hidden: false },
    ]
    // 📖 When looking for models compatible with 'opencode', rovo models should be excluded
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 3)
    assert.equal(result.length, 1)
    assert.equal(result[0].label, 'Regular')
  })

  it('findSimilarCompatibleModels excludes hidden models', () => {
    const mockResults = [
      { modelId: 'a', label: 'Visible', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Hidden', tier: 'S', sweScore: '71.0%', providerKey: 'nvidia', hidden: true },
    ]
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 3)
    assert.equal(result.length, 1)
    assert.equal(result[0].label, 'Visible')
  })

  it('findSimilarCompatibleModels respects maxResults limit', () => {
    const mockResults = [
      { modelId: 'a', label: 'A', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'B', tier: 'S', sweScore: '71.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'c', label: 'C', tier: 'S', sweScore: '72.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'd', label: 'D', tier: 'S', sweScore: '73.0%', providerKey: 'nvidia', hidden: false },
    ]
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 2)
    assert.equal(result.length, 2)
  })

  it('findSimilarCompatibleModels handles missing SWE scores gracefully', () => {
    const mockResults = [
      { modelId: 'a', label: 'No SWE', tier: 'S', sweScore: '-', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Has SWE', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
    ]
    // 📖 When selected model has no SWE score, treat as 0 — should still return results
    const result = findSimilarCompatibleModels('-', 'opencode', mockResults, 3)
    assert.equal(result.length, 2)
    // 📖 '-' parses as 0, so the model with sweScore '-' (also 0) should be closest
    assert.equal(result[0].label, 'No SWE')
  })
})

describe('tool launch preparation', () => {
  function createToolPaths(dir) {
    return {
      aiderConfigPath: join(dir, 'aider', '.aider.conf.yml'),
      crushConfigPath: join(dir, 'crush', 'crush.json'),
      gooseProvidersDir: join(dir, 'goose', 'custom_providers'),
      gooseSecretsPath: join(dir, 'goose', 'secrets.yaml'),
      gooseConfigPath: join(dir, 'goose', 'config.yaml'),
      qwenConfigPath: join(dir, 'qwen', 'settings.json'),
      ampConfigPath: join(dir, 'amp', 'settings.json'),
      piModelsPath: join(dir, 'pi', 'models.json'),
      piSettingsPath: join(dir, 'pi', 'settings.json'),
      openHandsEnvPath: join(dir, '.fcm-openhands-env'),
    }
  }

  it('persists the selected model into every external tool before launch', () => {
    const dir = join(tmpdir(), `fcm-tool-launch-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const paths = createToolPaths(dir)
    const config = { apiKeys: { nvidia: 'nvapi-test' } }
    const model = { providerKey: 'nvidia', modelId: 'deepseek-ai/deepseek-v3.2', label: 'DeepSeek V3.2' }

    try {
      const aiderPlan = prepareExternalToolLaunch('aider', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      assert.equal(aiderPlan.command, 'aider')
      assert.deepEqual(aiderPlan.args, ['--model', 'openai/deepseek-ai/deepseek-v3.2'])
      assert.match(readFileSync(paths.aiderConfigPath, 'utf8'), /model: openai\/deepseek-ai\/deepseek-v3\.2/)

      const crushPlan = prepareExternalToolLaunch('crush', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const crushConfig = JSON.parse(readFileSync(paths.crushConfigPath, 'utf8'))
      assert.equal(crushPlan.command, 'crush')
      assert.equal(crushConfig.models.large.model, 'deepseek-ai/deepseek-v3.2')
      assert.equal(crushConfig.models.large.provider, 'freeCodingModels')
      assert.equal(crushConfig.models.small.model, 'deepseek-ai/deepseek-v3.2')

      const goosePlan = prepareExternalToolLaunch('goose', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const gooseConfig = readFileSync(paths.gooseConfigPath, 'utf8')
      assert.equal(goosePlan.command, 'goose')
      assert.match(gooseConfig, /GOOSE_PROVIDER: fcm-nvidia/)
      assert.match(gooseConfig, /GOOSE_MODEL: deepseek-ai\/deepseek-v3\.2/)

      const qwenPlan = prepareExternalToolLaunch('qwen', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const qwenConfig = JSON.parse(readFileSync(paths.qwenConfigPath, 'utf8'))
      assert.equal(qwenPlan.command, 'qwen')
      assert.equal(qwenConfig.model, 'deepseek-ai/deepseek-v3.2')
      assert.equal(qwenConfig.modelProviders.openai[0].id, 'deepseek-ai/deepseek-v3.2')

      const openHandsPlan = prepareExternalToolLaunch('openhands', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const openHandsEnv = readFileSync(paths.openHandsEnvPath, 'utf8')
      assert.equal(openHandsPlan.command, 'openhands')
      assert.deepEqual(openHandsPlan.args, ['--override-with-envs'])
      assert.match(openHandsEnv, /OPENAI_MODEL="deepseek-ai\/deepseek-v3\.2"/)
      assert.match(openHandsEnv, /LLM_MODEL="openai\/deepseek-ai\/deepseek-v3\.2"/)

      const ampPlan = prepareExternalToolLaunch('amp', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const ampConfig = JSON.parse(readFileSync(paths.ampConfigPath, 'utf8'))
      assert.equal(ampPlan.command, 'amp')
      assert.equal(ampConfig['amp.model'], 'deepseek-ai/deepseek-v3.2')

      const piPlan = prepareExternalToolLaunch('pi', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const piModels = JSON.parse(readFileSync(paths.piModelsPath, 'utf8'))
      const piSettings = JSON.parse(readFileSync(paths.piSettingsPath, 'utf8'))
      assert.equal(piPlan.command, 'pi')
      assert.deepEqual(piPlan.args, ['--provider', 'freeCodingModels', '--model', 'deepseek-ai/deepseek-v3.2', '--api-key', piPlan.apiKey])
      assert.equal(piModels.providers.freeCodingModels.models[0].id, 'deepseek-ai/deepseek-v3.2')
      assert.equal(piSettings.defaultModel, 'deepseek-ai/deepseek-v3.2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('openclaw selected model persistence', () => {
  it('writes the selected provider/model as the OpenClaw default instead of forcing nvidia', async () => {
    const dir = join(tmpdir(), `fcm-openclaw-launch-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const openclawConfigPath = join(dir, 'openclaw', 'openclaw.json')
    const config = { apiKeys: { groq: 'gsk-test' } }
    const model = { providerKey: 'groq', modelId: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' }

    try {
      const result = await startOpenClaw(model, config, { paths: { openclawConfigPath } })
      const written = JSON.parse(readFileSync(openclawConfigPath, 'utf8'))

      assert.equal(result?.providerId, 'fcm-groq')
      assert.equal(written.agents.defaults.model.primary, 'fcm-groq/openai/gpt-oss-120b')
      assert.equal(Boolean(written.models.providers['fcm-groq']), true)
      assert.equal(written.models.providers['fcm-groq'].models[0].id, 'openai/gpt-oss-120b')
      assert.equal(written.env.GROQ_API_KEY, 'gsk-test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('endpoint install tracking', () => {
  it('exposes only persisted-config install targets in the Y install list', () => {
    const installTargets = getInstallTargetModes()
    assert.deepEqual(installTargets, ['opencode', 'opencode-desktop', 'openclaw', 'crush', 'goose', 'pi', 'aider', 'qwen', 'openhands', 'amp'])
  })

  it('normalizes tracked installs to canonical shape', () => {
    const normalized = normalizeEndpointInstalls([
      {
        providerKey: 'nvidia',
        toolMode: 'opencode',
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v3.2', '', 'deepseek-ai/deepseek-v3.2'],
        lastSyncedAt: '2026-03-09T12:00:00.000Z',
      },
      null,
      { providerKey: '', toolMode: 'goose' },
    ])

    assert.deepEqual(normalized, [
      {
        providerKey: 'nvidia',
        toolMode: 'opencode',
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v3.2'],
        lastSyncedAt: '2026-03-09T12:00:00.000Z',
      },
    ])
  })

  it('lists only configured providers that support direct endpoint installs', () => {
    const providers = getConfiguredInstallableProviders({
      apiKeys: {
        nvidia: 'nvapi-test',
        replicate: 'r8-test',
      },
    })

    assert.ok(providers.some((provider) => provider.providerKey === 'nvidia'))
    assert.ok(!providers.some((provider) => provider.providerKey === 'replicate'))
  })
})

describe('endpoint installer', () => {
  it('installs a managed OpenCode provider catalog and tracks it canonically', () => {
    const dir = join(tmpdir(), `fcm-opencode-install-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })

    const config = {
      apiKeys: { nvidia: 'nvapi-test' },
      providers: {},
      settings: {},
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      profiles: {},
      activeProfile: null,
    }

    const paths = {
      opencodeConfigPath: join(dir, 'opencode', 'opencode.json'),
      openclawConfigPath: join(dir, 'openclaw', 'openclaw.json'),
      crushConfigPath: join(dir, 'crush', 'crush.json'),
      gooseProvidersDir: join(dir, 'goose', 'custom_providers'),
      gooseSecretsPath: join(dir, 'goose', 'secrets.yaml'),
    }

    try {
      const expectedApiKey = getApiKey(config, 'nvidia')
      const result = installProviderEndpoints(config, 'nvidia', 'opencode-desktop', {
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v3.2'],
        paths,
      })

      const written = JSON.parse(readFileSync(paths.opencodeConfigPath, 'utf8'))
      assert.equal(result.toolMode, 'opencode')
      assert.equal(result.modelCount, 1)
      assert.equal(written.provider['fcm-nvidia'].options.apiKey, expectedApiKey)
      assert.deepEqual(written.provider['fcm-nvidia'].models, {
        'deepseek-ai/deepseek-v3.2': { name: 'DeepSeek V3.2' },
      })
      assert.deepEqual(config.endpointInstalls.map((entry) => ({
        providerKey: entry.providerKey,
        toolMode: entry.toolMode,
        scope: entry.scope,
        modelIds: entry.modelIds,
      })), [
        {
          providerKey: 'nvidia',
          toolMode: 'opencode',
          scope: 'selected',
          modelIds: ['deepseek-ai/deepseek-v3.2'],
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('installs Goose custom provider metadata and persists the matching secret', () => {
    const dir = join(tmpdir(), `fcm-goose-install-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })

    const config = {
      apiKeys: { groq: 'gsk-test' },
      providers: {},
      settings: {},
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      profiles: {},
      activeProfile: null,
    }

    const paths = {
      opencodeConfigPath: join(dir, 'opencode', 'opencode.json'),
      openclawConfigPath: join(dir, 'openclaw', 'openclaw.json'),
      crushConfigPath: join(dir, 'crush', 'crush.json'),
      gooseProvidersDir: join(dir, 'goose', 'custom_providers'),
      gooseSecretsPath: join(dir, 'goose', 'secrets.yaml'),
    }

    try {
      const expectedApiKey = getApiKey(config, 'groq')
      installProviderEndpoints(config, 'groq', 'goose', {
        scope: 'selected',
        modelIds: ['openai/gpt-oss-120b'],
        paths,
      })

      const providerFile = join(paths.gooseProvidersDir, 'fcm-groq.json')
      const providerConfig = JSON.parse(readFileSync(providerFile, 'utf8'))
      const secretsYaml = readFileSync(paths.gooseSecretsPath, 'utf8')

      assert.equal(providerConfig.api_key_env, 'FCM_GROQ_API_KEY')
      assert.equal(providerConfig.models[0].name, 'openai/gpt-oss-120b')
      assert.match(secretsYaml, new RegExp(`FCM_GROQ_API_KEY:\\s+${JSON.stringify(String(expectedApiKey))}`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('legacy proxy cleanup', () => {
  function createCleanupFixtureDir() {
    const dir = join(tmpdir(), `fcm-legacy-cleanup-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('removes discontinued proxy fields from the main config while preserving direct installs', () => {
    const homeDir = createCleanupFixtureDir()
    const configPath = join(homeDir, '.free-coding-models.json')
    const opencodeConfigPath = join(homeDir, '.config', 'opencode', 'opencode.json')
    mkdirSync(dirname(opencodeConfigPath), { recursive: true })

    try {
      writeFileSync(configPath, JSON.stringify({
        apiKeys: { nvidia: 'nvapi-test' },
        providers: {},
        settings: {
          preferredToolMode: 'claude-code',
          proxy: { enabled: true },
        },
        proxySettings: { enabled: true },
        endpointInstalls: [
          { providerKey: 'nvidia', toolMode: 'claude-code', scope: 'all', modelIds: [] },
          { providerKey: 'nvidia', toolMode: 'opencode', scope: 'selected', modelIds: ['deepseek-ai/deepseek-v3.2'] },
        ],
      }, null, 2))

      writeFileSync(opencodeConfigPath, JSON.stringify({
        provider: {
          'fcm-proxy': { options: { apiKey: 'legacy' } },
          'fcm-nvidia': { options: { apiKey: 'nvapi-test' } },
        },
        model: 'fcm-proxy/deepseek-ai/deepseek-v3.2',
      }, null, 2))

      const summary = cleanupLegacyProxyArtifacts({
        homeDir,
        paths: {
          configPath,
          opencodeConfigPath,
          shellProfilePaths: [],
        },
      })

      const nextConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      const nextOpencode = JSON.parse(readFileSync(opencodeConfigPath, 'utf8'))

      assert.equal(summary.changed, true)
      assert.equal('proxySettings' in nextConfig, false)
      assert.equal('proxy' in nextConfig.settings, false)
      assert.equal(nextConfig.settings.preferredToolMode, 'opencode')
      assert.deepEqual(nextConfig.endpointInstalls, [
        { providerKey: 'nvidia', toolMode: 'opencode', scope: 'selected', modelIds: ['deepseek-ai/deepseek-v3.2'] },
      ])
      assert.equal(Boolean(nextOpencode.provider['fcm-proxy']), false)
      assert.equal(Boolean(nextOpencode.provider['fcm-nvidia']), true)
      assert.equal('model' in nextOpencode, false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('removes proxy-only env files and shell sourcing lines', () => {
    const homeDir = createCleanupFixtureDir()
    const envPath = join(homeDir, '.fcm-claude-code-env')
    const envBackupPath = `${envPath}.bak`
    const zshrcPath = join(homeDir, '.zshrc')

    try {
      writeFileSync(envPath, 'export ANTHROPIC_BASE_URL=http://127.0.0.1:18045/v1\n')
      writeFileSync(envBackupPath, 'backup\n')
      writeFileSync(zshrcPath, [
        '# 📖 FCM Proxy — Claude Code env vars',
        'source "$HOME/.fcm-claude-code-env"',
        'export PATH="$HOME/bin:$PATH"',
      ].join('\n'))

      const summary = cleanupLegacyProxyArtifacts({
        homeDir,
        paths: {
          shellProfilePaths: [zshrcPath],
        },
      })

      const nextZshrc = readFileSync(zshrcPath, 'utf8')
      assert.equal(summary.changed, true)
      assert.equal(existsSync(envPath), false)
      assert.equal(existsSync(envBackupPath), false)
      assert.doesNotMatch(nextZshrc, /\.fcm-claude-code-env/)
      assert.match(nextZshrc, /export PATH=/)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('removes legacy Goose and Qwen proxy entries but keeps direct providers', () => {
    const homeDir = createCleanupFixtureDir()
    const gooseProvidersDir = join(homeDir, '.config', 'goose', 'custom_providers')
    const gooseSecretsPath = join(homeDir, '.config', 'goose', 'secrets.yaml')
    const gooseConfigPath = join(homeDir, '.config', 'goose', 'config.yaml')
    const qwenConfigPath = join(homeDir, '.qwen', 'settings.json')
    mkdirSync(gooseProvidersDir, { recursive: true })
    mkdirSync(dirname(qwenConfigPath), { recursive: true })

    try {
      writeFileSync(join(gooseProvidersDir, 'fcm-proxy.json'), '{}\n')
      writeFileSync(join(gooseProvidersDir, 'fcm-nvidia.json'), '{}\n')
      writeFileSync(gooseSecretsPath, [
        `FCM_PROXY_API_KEY: ${JSON.stringify('legacy-secret')}`,
        `FCM_NVIDIA_API_KEY: ${JSON.stringify('direct-secret')}`,
      ].join('\n'))
      writeFileSync(gooseConfigPath, [
        'GOOSE_PROVIDER: fcm-proxy',
        'GOOSE_MODEL: fcm-proxy/deepseek-ai/deepseek-v3.2',
        'OTHER_SETTING: keep-me',
      ].join('\n'))
      writeFileSync(qwenConfigPath, JSON.stringify({
        modelProviders: {
          openai: [
            { id: 'fcm-proxy/deepseek-ai/deepseek-v3.2', envKey: 'FCM_PROXY_API_KEY', baseUrl: 'http://127.0.0.1:18045/v1' },
            { id: 'fcm-nvidia/deepseek-ai/deepseek-v3.2', envKey: 'FCM_NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1' },
          ],
        },
        model: 'fcm-proxy/deepseek-ai/deepseek-v3.2',
      }, null, 2))

      cleanupLegacyProxyArtifacts({
        homeDir,
        paths: {
          gooseProvidersDir,
          gooseSecretsPath,
          gooseConfigPath,
          qwenConfigPath,
          shellProfilePaths: [],
        },
      })

      const nextSecrets = readFileSync(gooseSecretsPath, 'utf8')
      const nextGooseConfig = readFileSync(gooseConfigPath, 'utf8')
      const nextQwenConfig = JSON.parse(readFileSync(qwenConfigPath, 'utf8'))

      assert.equal(existsSync(join(gooseProvidersDir, 'fcm-proxy.json')), false)
      assert.equal(existsSync(join(gooseProvidersDir, 'fcm-nvidia.json')), true)
      assert.doesNotMatch(nextSecrets, /FCM_PROXY_API_KEY/)
      assert.match(nextSecrets, /FCM_NVIDIA_API_KEY/)
      assert.doesNotMatch(nextGooseConfig, /GOOSE_PROVIDER:\s*fcm-proxy/)
      assert.match(nextGooseConfig, /OTHER_SETTING: keep-me/)
      assert.deepEqual(nextQwenConfig.modelProviders.openai, [
        { id: 'fcm-nvidia/deepseek-ai/deepseek-v3.2', envKey: 'FCM_NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1' },
      ])
      assert.equal('model' in nextQwenConfig, false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('keeps a direct OpenHands env file but removes the old localhost proxy variant', () => {
    const homeDir = createCleanupFixtureDir()
    const openHandsEnvPath = join(homeDir, '.fcm-openhands-env')

    try {
      writeFileSync(openHandsEnvPath, [
        'export OPENAI_API_KEY=direct-key',
        'export OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1',
      ].join('\n'))

      cleanupLegacyProxyArtifacts({ homeDir, paths: { shellProfilePaths: [] } })
      assert.equal(existsSync(openHandsEnvPath), true)

      writeFileSync(openHandsEnvPath, [
        '# FCM Proxy V2',
        'export OPENAI_BASE_URL=http://127.0.0.1:18045/v1',
      ].join('\n'))

      cleanupLegacyProxyArtifacts({ homeDir, paths: { shellProfilePaths: [] } })
      assert.equal(existsSync(openHandsEnvPath), false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

// ─── Dynamic OpenRouter model discovery (MODELS mutation) ────────────────────
// 📖 Tests that verify the MODELS array mutation logic used by fetchOpenRouterFreeModels
describe('Dynamic OpenRouter MODELS mutation', () => {
  it('MODELS array contains openrouter entries from static sources', () => {
    const orEntries = MODELS.filter(m => m[5] === 'openrouter')
    assert.ok(orEntries.length > 0, 'Should have at least one openrouter entry in MODELS')
  })

  it('all openrouter entries have valid tuple format [id, label, tier, swe, ctx, providerKey]', () => {
    const orEntries = MODELS.filter(m => m[5] === 'openrouter')
    for (const entry of orEntries) {
      assert.equal(entry.length, 6, `Entry ${entry[0]} should have 6 elements`)
      assert.equal(typeof entry[0], 'string', 'modelId should be string')
      assert.equal(typeof entry[1], 'string', 'label should be string')
      assert.ok(TIER_ORDER.includes(entry[2]), `tier ${entry[2]} should be valid`)
      assert.match(entry[3], /^\d+\.\d+%$/, 'sweScore should match N.N% format')
      assert.match(entry[4], /^\d+[kM]$/, 'ctx should match Nk or NM format')
      assert.equal(entry[5], 'openrouter', 'providerKey should be openrouter')
    }
  })

  it('MODELS array is mutable (can splice and push)', () => {
    const originalLength = MODELS.length
    // Push a test entry
    MODELS.push(['test/model:free', 'Test Model', 'B', '25.0%', '128k', 'openrouter'])
    assert.equal(MODELS.length, originalLength + 1)
    // Remove it
    MODELS.splice(MODELS.length - 1, 1)
    assert.equal(MODELS.length, originalLength)
  })
})

// ─── Custom text filter matching logic ───────────────────────────────────────
// 📖 Tests that verify the custom text filter matching behavior used in applyTierFilter().
// 📖 The filter is case-insensitive and matches against label, ctx, providerKey, and provider display name.
describe('Custom text filter matching logic', () => {
  // 📖 Helper that mirrors the exact matching logic from applyTierFilter() in app.js
  function matchesTextFilter(row, query, providerSources) {
    if (!query) return true
    const q = query.toLowerCase()
    const providerName = (providerSources[row.providerKey]?.name || '').toLowerCase()
    return (row.label || '').toLowerCase().includes(q)
      || (row.ctx || '').toLowerCase().includes(q)
      || (row.providerKey || '').toLowerCase().includes(q)
      || providerName.includes(q)
  }

  const mockSources = {
    nvidia: { name: 'NVIDIA NIM' },
    groq: { name: 'Groq' },
    cerebras: { name: 'Cerebras' },
    openrouter: { name: 'OpenRouter' },
  }

  const mockRows = [
    { label: 'DeepSeek V3', ctx: '128k', providerKey: 'nvidia' },
    { label: 'Claude 4 Sonnet', ctx: '200k', providerKey: 'openrouter' },
    { label: 'Llama 4 Scout', ctx: '512k', providerKey: 'groq' },
    { label: 'Qwen 3 235B', ctx: '128k', providerKey: 'cerebras' },
  ]

  it('matches model name (case-insensitive)', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'deepseek', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], 'DEEPSEEK', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], 'DeepSeek', mockSources), true)
  })

  it('matches partial model name', () => {
    assert.equal(matchesTextFilter(mockRows[1], 'claude', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], 'sonnet', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], '4 Son', mockSources), true)
  })

  it('matches context window string', () => {
    assert.equal(matchesTextFilter(mockRows[0], '128k', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], '200k', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[2], '512k', mockSources), true)
  })

  it('matches provider key', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'nvidia', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[2], 'groq', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[3], 'cerebras', mockSources), true)
  })

  it('matches provider display name', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'NVIDIA NIM', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], 'nim', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], 'OpenRouter', mockSources), true)
  })

  it('returns false for non-matching query', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'anthropic', mockSources), false)
    assert.equal(matchesTextFilter(mockRows[0], 'gemini', mockSources), false)
    assert.equal(matchesTextFilter(mockRows[0], '999k', mockSources), false)
  })

  it('returns true when query is null or empty', () => {
    assert.equal(matchesTextFilter(mockRows[0], null, mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], '', mockSources), true)
  })

  it('filters a list of models correctly', () => {
    const filtered = mockRows.filter(r => matchesTextFilter(r, '128k', mockSources))
    assert.equal(filtered.length, 2) // DeepSeek V3 and Qwen 3 235B both have 128k
    assert.equal(filtered[0].label, 'DeepSeek V3')
    assert.equal(filtered[1].label, 'Qwen 3 235B')
  })

  it('stacks with other filters (simulated tier + text)', () => {
    // 📖 Simulate tier S+ filter reducing to a subset, then text filter further narrows
    const tierSPlusRows = mockRows.filter(r => r.label.includes('Claude')) // pretend only Claude is S+
    const result = tierSPlusRows.filter(r => matchesTextFilter(r, 'sonnet', mockSources))
    assert.equal(result.length, 1)
    assert.equal(result[0].label, 'Claude 4 Sonnet')
  })
})

// ─── sortResultsWithPinnedFavorites (no toolMode partition) ───────────────────
// 📖 Sorting no longer partitions by tool compatibility — incompatible models stay
// 📖 in their natural sorted position and are highlighted with a red background instead.

describe('sortResultsWithPinnedFavorites normal sort order', () => {
  const mockModels = [
    { id: 'nvidia-1', providerKey: 'nvidia', label: 'Llama 3.1', idx: 1, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
    { id: 'rovo-1', providerKey: 'rovo', label: 'Claude Sonnet 4', idx: 2, tier: 'S+', pings: [], isRecommended: false, isFavorite: false },
    { id: 'openrouter-1', providerKey: 'openrouter', label: 'GPT-4o', idx: 3, tier: 'S', pings: [], isRecommended: false, isFavorite: false },
    { id: 'gemini-1', providerKey: 'gemini', label: 'Gemini 2.5 Pro', idx: 4, tier: 'S+', pings: [], isRecommended: false, isFavorite: false },
    { id: 'zen-1', providerKey: 'opencode-zen', label: 'Big Pickle', idx: 5, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
    { id: 'groq-1', providerKey: 'groq', label: 'Llama 3.3 70B', idx: 6, tier: 'A+', pings: [], isRecommended: false, isFavorite: false },
  ]

  it('returns normal rank sort order — no partitioning by tool compatibility', () => {
    const sorted = sortResultsWithPinnedFavorites(mockModels, 'rank', 'asc', { pinFavorites: false })
    // 📖 All models in rank ascending order: idx 1,2,3,4,5,6 — rovo/gemini/zen NOT pushed to bottom
    assert.equal(sorted[0].id, 'nvidia-1')
    assert.equal(sorted[1].id, 'rovo-1')
    assert.equal(sorted[2].id, 'openrouter-1')
    assert.equal(sorted[3].id, 'gemini-1')
    assert.equal(sorted[4].id, 'zen-1')
    assert.equal(sorted[5].id, 'groq-1')
  })

  it('recommended models still pinned above others', () => {
    const models = [
      { id: 'regular-1', providerKey: 'nvidia', label: 'Llama', idx: 1, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
      { id: 'rovo-1', providerKey: 'rovo', label: 'Claude Sonnet 4', idx: 2, tier: 'S+', pings: [], isRecommended: true, recommendScore: 90, isFavorite: false },
    ]
    const sorted = sortResultsWithPinnedFavorites(models, 'rank', 'asc', { pinFavorites: false })
    assert.equal(sorted[0].id, 'rovo-1')
    assert.equal(sorted[1].id, 'regular-1')
  })

  it('favorites pinned above non-favorites when pinFavorites=true', () => {
    const models = [
      { id: 'regular-1', providerKey: 'nvidia', label: 'Llama', idx: 1, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
      { id: 'rovo-fav', providerKey: 'rovo', label: 'Claude Fav', idx: 3, tier: 'S', pings: [], isRecommended: false, isFavorite: true, favoriteRank: 0 },
    ]
    const sorted = sortResultsWithPinnedFavorites(models, 'rank', 'asc', { pinFavorites: true })
    assert.equal(sorted[0].id, 'rovo-fav')
    assert.equal(sorted[1].id, 'regular-1')
  })
})

// ─── Mouse support tests ────────────────────────────────────────────────

describe('parseMouseEvents', () => {
  it('parses a left-click press event', () => {
    // 📖 SGR: \x1b[<0;10;5M → left press at col 10, row 5
    const events = parseMouseEvents('\x1b[<0;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'press')
    assert.equal(events[0].button, 'left')
    assert.equal(events[0].x, 10)
    assert.equal(events[0].y, 5)
    assert.equal(events[0].shift, false)
    assert.equal(events[0].meta, false)
    assert.equal(events[0].ctrl, false)
  })

  it('parses a left-click release event', () => {
    // 📖 SGR: \x1b[<0;10;5m → left release at col 10, row 5
    const events = parseMouseEvents('\x1b[<0;10;5m')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'release')
    assert.equal(events[0].button, 'left')
    assert.equal(events[0].x, 10)
    assert.equal(events[0].y, 5)
  })

  it('parses a right-click press event', () => {
    // 📖 SGR: \x1b[<2;20;15M → right press
    const events = parseMouseEvents('\x1b[<2;20;15M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'press')
    assert.equal(events[0].button, 'right')
    assert.equal(events[0].x, 20)
    assert.equal(events[0].y, 15)
  })

  it('parses a middle-click event', () => {
    const events = parseMouseEvents('\x1b[<1;5;3M')
    assert.equal(events.length, 1)
    assert.equal(events[0].button, 'middle')
    assert.equal(events[0].type, 'press')
  })

  it('parses scroll-up event', () => {
    // 📖 SGR: \x1b[<64;10;5M → scroll up
    const events = parseMouseEvents('\x1b[<64;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'scroll-up')
    assert.equal(events[0].button, 'scroll-up')
    assert.equal(events[0].x, 10)
    assert.equal(events[0].y, 5)
  })

  it('parses scroll-down event', () => {
    const events = parseMouseEvents('\x1b[<65;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'scroll-down')
    assert.equal(events[0].button, 'scroll-down')
  })

  it('parses drag event', () => {
    // 📖 SGR: \x1b[<32;10;5M → left drag
    const events = parseMouseEvents('\x1b[<32;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'drag')
    assert.equal(events[0].button, 'left')
  })

  it('detects shift modifier', () => {
    // 📖 Shift adds +4 to button field: 0+4 = 4
    const events = parseMouseEvents('\x1b[<4;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].shift, true)
    assert.equal(events[0].meta, false)
    assert.equal(events[0].ctrl, false)
    assert.equal(events[0].button, 'left')
  })

  it('detects meta/alt modifier', () => {
    // 📖 Meta adds +8: 0+8 = 8
    const events = parseMouseEvents('\x1b[<8;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].meta, true)
    assert.equal(events[0].shift, false)
  })

  it('detects ctrl modifier', () => {
    // 📖 Ctrl adds +16: 0+16 = 16
    const events = parseMouseEvents('\x1b[<16;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].ctrl, true)
  })

  it('detects combined modifiers (shift + ctrl)', () => {
    // 📖 Shift(4) + Ctrl(16) = 20 on left button
    const events = parseMouseEvents('\x1b[<20;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].shift, true)
    assert.equal(events[0].ctrl, true)
    assert.equal(events[0].meta, false)
    assert.equal(events[0].button, 'left')
  })

  it('parses multiple events from a single data chunk', () => {
    // 📖 Rapid scrolling can send multiple events in one chunk
    const data = '\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M'
    const events = parseMouseEvents(data)
    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'scroll-up')
    assert.equal(events[1].type, 'scroll-up')
    assert.equal(events[2].type, 'scroll-down')
  })

  it('returns empty array for non-mouse data', () => {
    const events = parseMouseEvents('hello world')
    assert.deepEqual(events, [])
  })

  it('handles Buffer input', () => {
    const buf = Buffer.from('\x1b[<0;10;5M', 'utf8')
    const events = parseMouseEvents(buf)
    assert.equal(events.length, 1)
    assert.equal(events[0].button, 'left')
  })

  it('parses large coordinates (> 223 columns)', () => {
    // 📖 SGR mode supports coordinates > 223 (unlike X10 mode)
    const events = parseMouseEvents('\x1b[<0;300;150M')
    assert.equal(events.length, 1)
    assert.equal(events[0].x, 300)
    assert.equal(events[0].y, 150)
  })
})

describe('containsMouseSequence', () => {
  it('returns true for SGR mouse data', () => {
    assert.equal(containsMouseSequence('\x1b[<0;10;5M'), true)
  })

  it('returns true for partial mouse prefix in mixed data', () => {
    assert.equal(containsMouseSequence('abc\x1b[<0;10;5Mdef'), true)
  })

  it('returns false for regular keypress data', () => {
    assert.equal(containsMouseSequence('\x1b[A'), false) // up arrow
    assert.equal(containsMouseSequence('T'), false)
    assert.equal(containsMouseSequence('\r'), false)
  })

  it('returns false for empty string', () => {
    assert.equal(containsMouseSequence(''), false)
  })

  it('handles Buffer input', () => {
    const buf = Buffer.from('\x1b[<0;1;1M', 'utf8')
    assert.equal(containsMouseSequence(buf), true)
  })
})

describe('createMouseHandler', () => {
  it('emits click on left-button release', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    // 📖 Send press then release — click is emitted only on release
    handler('\x1b[<0;10;5M')  // press
    handler('\x1b[<0;10;5m')  // release
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'click')
    assert.equal(received[0].button, 'left')
    assert.equal(received[0].x, 10)
    assert.equal(received[0].y, 5)
  })

  it('does not emit click on press alone (only on release)', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<0;10;5M')  // press only
    assert.equal(received.length, 0)
  })

  it('emits scroll events immediately (no press/release)', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<64;10;5M')  // scroll up
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'scroll-up')
  })

  it('emits drag events', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<32;10;5M')  // left drag
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'drag')
    assert.equal(received[0].button, 'left')
  })

  it('emits right-click on right-button release', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<2;15;8M')  // right press
    handler('\x1b[<2;15;8m')  // right release
    // 📖 Right press is ignored; only release emits click
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'click')
    assert.equal(received[0].button, 'right')
  })

  it('detects double-click on same position within timeout', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    // 📖 Two rapid left releases at the same position → click + double-click
    handler('\x1b[<0;10;5m')  // first release
    handler('\x1b[<0;10;5m')  // second release (within 400ms)

    assert.equal(received.length, 2)
    assert.equal(received[0].type, 'click')
    assert.equal(received[1].type, 'double-click')
  })

  it('does not double-click on different positions', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    handler('\x1b[<0;10;5m')  // first release at (10,5)
    handler('\x1b[<0;20;5m')  // second release at (20,5) — different x

    assert.equal(received.length, 2)
    assert.equal(received[0].type, 'click')
    assert.equal(received[1].type, 'click') // 📖 Not double-click — different position
  })

  it('ignores non-mouse data', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('T')       // regular keypress
    handler('\x1b[A')  // up arrow
    assert.equal(received.length, 0)
  })

  it('third rapid click does not trigger another double-click', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    handler('\x1b[<0;10;5m')  // 1st release → click
    handler('\x1b[<0;10;5m')  // 2nd release → double-click (resets)
    handler('\x1b[<0;10;5m')  // 3rd release → click (not double-click)

    assert.equal(received.length, 3)
    assert.equal(received[0].type, 'click')
    assert.equal(received[1].type, 'double-click')
    assert.equal(received[2].type, 'click') // 📖 Reset after double-click
  })
})

describe('MOUSE_ENABLE / MOUSE_DISABLE sequences', () => {
  it('MOUSE_ENABLE contains all required mode activations', () => {
    // 📖 Mode 1000 (basic), 1002 (button-event), 1006 (SGR)
    assert.ok(MOUSE_ENABLE.includes('\x1b[?1000h'), 'missing mode 1000 enable')
    assert.ok(MOUSE_ENABLE.includes('\x1b[?1002h'), 'missing mode 1002 enable')
    assert.ok(MOUSE_ENABLE.includes('\x1b[?1006h'), 'missing mode 1006 enable')
  })

  it('MOUSE_DISABLE contains all required mode deactivations', () => {
    assert.ok(MOUSE_DISABLE.includes('\x1b[?1000l'), 'missing mode 1000 disable')
    assert.ok(MOUSE_DISABLE.includes('\x1b[?1002l'), 'missing mode 1002 disable')
    assert.ok(MOUSE_DISABLE.includes('\x1b[?1006l'), 'missing mode 1006 disable')
  })

  it('MOUSE_DISABLE reverses MOUSE_ENABLE modes in opposite order', () => {
    // 📖 Best practice: disable in reverse order of enable
    const enableOrder = ['1000', '1002', '1006']
    const disableOrder = ['1006', '1002', '1000']
    enableOrder.forEach((mode, i) => {
      assert.ok(MOUSE_ENABLE.indexOf(`?${mode}h`) >= 0)
    })
    disableOrder.forEach((mode, i) => {
      assert.ok(MOUSE_DISABLE.indexOf(`?${mode}l`) >= 0)
    })
  })
})

describe('COLUMN_SORT_MAP', () => {
  it('maps rank column to rank sort key', () => {
    assert.equal(COLUMN_SORT_MAP.rank, 'rank')
  })

  it('maps tier column to null (triggers filter cycle, not sort)', () => {
    assert.equal(COLUMN_SORT_MAP.tier, null)
  })

  it('maps swe column to swe sort key', () => {
    assert.equal(COLUMN_SORT_MAP.swe, 'swe')
  })

  it('maps ctx column to ctx sort key', () => {
    assert.equal(COLUMN_SORT_MAP.ctx, 'ctx')
  })

  it('maps model column to model sort key', () => {
    assert.equal(COLUMN_SORT_MAP.model, 'model')
  })

  it('maps source column to origin sort key', () => {
    assert.equal(COLUMN_SORT_MAP.source, 'origin')
  })

  it('maps ping column to ping sort key', () => {
    assert.equal(COLUMN_SORT_MAP.ping, 'ping')
  })

  it('maps avg column to avg sort key', () => {
    assert.equal(COLUMN_SORT_MAP.avg, 'avg')
  })

  it('maps health column to condition sort key', () => {
    assert.equal(COLUMN_SORT_MAP.health, 'condition')
  })

  it('maps verdict column to verdict sort key', () => {
    assert.equal(COLUMN_SORT_MAP.verdict, 'verdict')
  })

  it('maps stability column to stability sort key', () => {
    assert.equal(COLUMN_SORT_MAP.stability, 'stability')
  })

  it('maps uptime column to uptime sort key', () => {
    assert.equal(COLUMN_SORT_MAP.uptime, 'uptime')
  })

  it('has entries for all expected columns', () => {
    const expected = ['rank', 'tier', 'swe', 'ctx', 'model', 'source', 'ping', 'avg', 'health', 'verdict', 'stability', 'uptime']
    for (const col of expected) {
      assert.ok(col in COLUMN_SORT_MAP, `missing column: ${col}`)
    }
  })
})
