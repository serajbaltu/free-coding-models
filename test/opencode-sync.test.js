/**
 * @file test/opencode-sync.test.js
 * @description Unit tests for lib/opencode-sync.js — proxy-aware settings sync hardening.
 *
 * Tests cover:
 *   1. Single-provider merge preservation (non-FCM providers are untouched)
 *   2. Runtime proxy values (port/token) used only when proxy is running
 *   3. Fallback to existing persisted provider options when proxy is not running
 *
 * Uses the pure mergeOcConfig() function which performs the merge without I/O,
 * allowing full unit-test coverage without filesystem setup.
 *
 * Run: node --test test/opencode-sync.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeOcConfig } from '../lib/opencode-sync.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal merged-models array (output of buildMergedModels).
 * Each element must have .slug and .label.
 */
function mockMergedModels(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    slug: `model-${i + 1}`,
    label: `Test Model ${i + 1}`,
  }))
}

/**
 * Build a minimal OpenCode config with some existing non-FCM providers
 * and other top-level keys that must be preserved.
 */
function baseOcConfig() {
  return {
    $schema: 'https://opencode.ai/config.schema.json',
    model: 'anthropic/claude-opus-4-5',
    provider: {
      'anthropic': {
        name: 'Anthropic',
        options: { apiKey: 'sk-ant-abc123' },
      },
      'openai': {
        name: 'OpenAI',
        options: { apiKey: 'sk-openai-xyz' },
      },
    },
    mcp: { server: {} },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 1. SINGLE-PROVIDER MERGE PRESERVATION
// ═══════════════════════════════════════════════════════════════════════════════
describe('mergeOcConfig — single-provider merge preservation', () => {
  it('does not remove existing non-FCM providers', () => {
    const oc = baseOcConfig()
    mergeOcConfig(oc, mockMergedModels())
    assert.ok(oc.provider['anthropic'], 'anthropic provider should be preserved')
    assert.ok(oc.provider['openai'], 'openai provider should be preserved')
  })

  it('preserves non-FCM provider options unchanged', () => {
    const oc = baseOcConfig()
    mergeOcConfig(oc, mockMergedModels())
    assert.equal(oc.provider['anthropic'].options.apiKey, 'sk-ant-abc123')
    assert.equal(oc.provider['openai'].options.apiKey, 'sk-openai-xyz')
  })

  it('preserves top-level keys ($schema, model, mcp)', () => {
    const oc = baseOcConfig()
    mergeOcConfig(oc, mockMergedModels())
    assert.equal(oc.$schema, 'https://opencode.ai/config.schema.json')
    assert.equal(oc.model, 'anthropic/claude-opus-4-5')
    assert.ok(oc.mcp, 'mcp key should be preserved')
  })

  it('adds fcm-proxy provider to existing provider map', () => {
    const oc = baseOcConfig()
    mergeOcConfig(oc, mockMergedModels())
    assert.ok(oc.provider['fcm-proxy'], 'fcm-proxy provider should be added')
    // Total providers: anthropic + openai + fcm-proxy = 3
    assert.equal(Object.keys(oc.provider).length, 3)
  })

  it('sets correct npm and name fields on fcm-proxy', () => {
    const oc = baseOcConfig()
    mergeOcConfig(oc, mockMergedModels())
    const fcm = oc.provider['fcm-proxy']
    assert.equal(fcm.npm, '@ai-sdk/openai-compatible')
    assert.equal(fcm.name, 'FCM Rotation Proxy')
  })

  it('writes all merged model slugs into fcm-proxy models', () => {
    const oc = baseOcConfig()
    const models = mockMergedModels(3)
    mergeOcConfig(oc, models)
    const fcmModels = oc.provider['fcm-proxy'].models
    assert.equal(Object.keys(fcmModels).length, 3)
    assert.ok(fcmModels['model-1'], 'model-1 should be present')
    assert.ok(fcmModels['model-2'], 'model-2 should be present')
    assert.ok(fcmModels['model-3'], 'model-3 should be present')
  })

  it('each model entry has a name field matching the label', () => {
    const oc = baseOcConfig()
    mergeOcConfig(oc, mockMergedModels(2))
    const fcmModels = oc.provider['fcm-proxy'].models
    assert.equal(fcmModels['model-1'].name, 'Test Model 1')
    assert.equal(fcmModels['model-2'].name, 'Test Model 2')
  })

  it('works on empty config with no existing providers', () => {
    const oc = {}
    mergeOcConfig(oc, mockMergedModels())
    assert.ok(oc.provider['fcm-proxy'], 'fcm-proxy should be added to empty config')
    // No other providers
    assert.equal(Object.keys(oc.provider).length, 1)
  })

  it('only updates fcm-proxy when called a second time (idempotent merge)', () => {
    const oc = baseOcConfig()
    const models = mockMergedModels(2)
    mergeOcConfig(oc, models)
    // Simulate second sync with same data
    mergeOcConfig(oc, models)
    // Still only 3 providers (anthropic, openai, fcm-proxy)
    assert.equal(Object.keys(oc.provider).length, 3)
    assert.ok(oc.provider['anthropic'], 'anthropic still present after second sync')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 2. RUNTIME VALUES USED ONLY WHEN PROXY IS RUNNING
// ═══════════════════════════════════════════════════════════════════════════════
describe('mergeOcConfig — runtime proxy values only when running', () => {
  it('uses runtime proxyPort when provided as a valid positive integer', () => {
    const oc = {}
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: 9876 })
    const baseURL = oc.provider['fcm-proxy'].options.baseURL
    assert.equal(baseURL, 'http://127.0.0.1:9876/v1')
  })

  it('uses runtime proxyToken when provided as a non-empty string', () => {
    const oc = {}
    mergeOcConfig(oc, mockMergedModels(), { proxyToken: 'my-runtime-token' })
    assert.equal(oc.provider['fcm-proxy'].options.apiKey, 'my-runtime-token')
  })

  it('uses both proxyPort and proxyToken from running proxy', () => {
    const oc = {}
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: 8045, proxyToken: 'runtime-tok' })
    const opts = oc.provider['fcm-proxy'].options
    assert.equal(opts.baseURL, 'http://127.0.0.1:8045/v1')
    assert.equal(opts.apiKey, 'runtime-tok')
  })

  it('does NOT use proxyPort when proxy is not running (port is undefined)', () => {
    // Simulate: proxy stopped → caller passes no proxyPort
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:7777/v1', apiKey: 'existing-tok' },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: undefined, proxyToken: undefined })
    assert.equal(
      oc.provider['fcm-proxy'].options.baseURL,
      'http://127.0.0.1:7777/v1',
      'Should preserve existing baseURL when port is undefined'
    )
  })

  it('does NOT use proxyToken when proxy is not running (token is undefined)', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:7777/v1', apiKey: 'existing-tok' },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: undefined, proxyToken: undefined })
    assert.equal(
      oc.provider['fcm-proxy'].options.apiKey,
      'existing-tok',
      'Should preserve existing apiKey when token is undefined'
    )
  })

  it('ignores null proxyPort (stopped proxy returns null listeningPort)', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:9999/v1', apiKey: 'saved-tok' },
        },
      },
    }
    // ProxyServer.stop() sets _listeningPort = null
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: null, proxyToken: null })
    assert.equal(
      oc.provider['fcm-proxy'].options.baseURL,
      'http://127.0.0.1:9999/v1',
      'null port must not overwrite existing baseURL'
    )
    assert.equal(
      oc.provider['fcm-proxy'].options.apiKey,
      'saved-tok',
      'null token must not overwrite existing apiKey'
    )
  })

  it('ignores proxyPort of 0 (invalid)', () => {
    const oc = {
      provider: {
        'fcm-proxy': { options: { baseURL: 'http://127.0.0.1:5555/v1', apiKey: 'tok' } },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: 0 })
    assert.equal(oc.provider['fcm-proxy'].options.baseURL, 'http://127.0.0.1:5555/v1')
  })

  it('ignores proxyPort that is not an integer (string port)', () => {
    const oc = {
      provider: {
        'fcm-proxy': { options: { baseURL: 'http://127.0.0.1:5555/v1', apiKey: 'tok' } },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: '8045' })
    // String '8045' is not Number.isInteger → falls back to existing
    assert.equal(oc.provider['fcm-proxy'].options.baseURL, 'http://127.0.0.1:5555/v1')
  })

  it('ignores empty string proxyToken', () => {
    const oc = {
      provider: {
        'fcm-proxy': { options: { baseURL: 'http://127.0.0.1:5555/v1', apiKey: 'existing' } },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyToken: '' })
    assert.equal(oc.provider['fcm-proxy'].options.apiKey, 'existing')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 3. FALLBACK TO EXISTING PROVIDER OPTIONS WHEN NOT RUNNING
// ═══════════════════════════════════════════════════════════════════════════════
describe('mergeOcConfig — fallback to existing provider options', () => {
  it('preserves existing baseURL when no runtime port is given', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:8045/v1', apiKey: 'old-tok' },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels())
    assert.equal(oc.provider['fcm-proxy'].options.baseURL, 'http://127.0.0.1:8045/v1')
  })

  it('preserves existing apiKey when no runtime token is given', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:8045/v1', apiKey: 'persisted-token' },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels())
    assert.equal(oc.provider['fcm-proxy'].options.apiKey, 'persisted-token')
  })

  it('uses default baseURL when no runtime port and no existing config', () => {
    const oc = {}
    mergeOcConfig(oc, mockMergedModels())
    assert.equal(oc.provider['fcm-proxy'].options.baseURL, 'http://127.0.0.1:8045/v1')
  })

  it('generates a random proxy token when no runtime token and no existing config', () => {
    const oc = {}
    mergeOcConfig(oc, mockMergedModels())
    const generated = oc.provider['fcm-proxy'].options.apiKey
    assert.match(generated, /^fcm_[a-f0-9]{48}$/)
  })

  it('replaces legacy placeholder token with generated random token', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: {
            baseURL: 'http://127.0.0.1:8045/v1',
            apiKey: 'fcm-proxy-token',
          },
          models: {},
        },
      },
    }

    mergeOcConfig(oc, mockMergedModels())

    const generated = oc.provider['fcm-proxy'].options.apiKey
    assert.notEqual(generated, 'fcm-proxy-token')
    assert.match(generated, /^fcm_[a-f0-9]{48}$/)
  })

  it('preserves extra custom options the user may have set manually', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: {
            baseURL: 'http://127.0.0.1:8045/v1',
            apiKey: 'tok',
            customHeader: 'x-custom-value', // user-set option
          },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels())
    // customHeader should survive the merge (spread ...existingOptions)
    assert.equal(oc.provider['fcm-proxy'].options.customHeader, 'x-custom-value')
  })

  it('runtime port takes precedence over existing baseURL when proxy is running', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:8045/v1', apiKey: 'old-tok' },
        },
      },
    }
    // Proxy started on a new port
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: 9000, proxyToken: 'new-tok' })
    assert.equal(oc.provider['fcm-proxy'].options.baseURL, 'http://127.0.0.1:9000/v1')
    assert.equal(oc.provider['fcm-proxy'].options.apiKey, 'new-tok')
  })

  it('runtime token takes precedence over existing apiKey when proxy is running', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:8045/v1', apiKey: 'stale-token' },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: 8045, proxyToken: 'fresh-token' })
    assert.equal(oc.provider['fcm-proxy'].options.apiKey, 'fresh-token')
  })

  it('stopped-proxy scenario: port null, token null → existing options survive', () => {
    // Simulates: user had proxy running, proxy.stop() was called,
    // then user presses S in the settings screen.
    // The caller passes no proxyPort/proxyToken (undefined, not the stopped null values).
    const oc = {
      provider: {
        'anthropic': { options: { apiKey: 'sk-ant-abc' } },
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:7654/v1', apiKey: 'prev-token' },
        },
      },
    }
    mergeOcConfig(oc, mockMergedModels(), { proxyPort: undefined, proxyToken: undefined })

    // FCM proxy options preserved
    assert.equal(oc.provider['fcm-proxy'].options.baseURL, 'http://127.0.0.1:7654/v1')
    assert.equal(oc.provider['fcm-proxy'].options.apiKey, 'prev-token')
    // Non-FCM provider still intact
    assert.ok(oc.provider['anthropic'])
    assert.equal(oc.provider['anthropic'].options.apiKey, 'sk-ant-abc')
  })

  it('models are always updated regardless of proxy status', () => {
    const oc = {
      provider: {
        'fcm-proxy': {
          options: { baseURL: 'http://127.0.0.1:8045/v1', apiKey: 'tok' },
          models: { 'old-slug': { name: 'Old Model' } },
        },
      },
    }
    const newModels = [
      { slug: 'new-slug-1', label: 'New Model 1' },
      { slug: 'new-slug-2', label: 'New Model 2' },
    ]
    mergeOcConfig(oc, newModels)
    const fcmModels = oc.provider['fcm-proxy'].models
    // Old model should be gone — models list is always fully replaced
    assert.ok(!fcmModels['old-slug'], 'old model should not remain')
    assert.ok(fcmModels['new-slug-1'], 'new-slug-1 should be present')
    assert.ok(fcmModels['new-slug-2'], 'new-slug-2 should be present')
  })
})
