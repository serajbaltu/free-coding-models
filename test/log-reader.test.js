/**
 * @file test/log-reader.test.js
 * @description Tests for lib/log-reader.js (Task 5).
 *
 * Covers:
 *   - parseLogLine: valid, malformed, missing timestamp, blank
 *   - loadRecentLogs: missing file, empty file, valid entries, corrupt lines,
 *     newest-first ordering, limit enforcement, bounded tail read
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseLogLine, loadRecentLogs } from '../lib/log-reader.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(label) {
  const dir = join(tmpdir(), `fcm-lr-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const logFile = join(dir, 'request-log.jsonl')
  const writeLine  = (obj) => appendFileSync(logFile, JSON.stringify(obj) + '\n')
  const writeRaw   = (str) => appendFileSync(logFile, str + '\n')
  const cleanup    = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  return { dir, logFile, writeLine, writeRaw, cleanup }
}

// ─── Suite: parseLogLine ──────────────────────────────────────────────────────

describe('log-reader – parseLogLine', () => {
  it('returns null for blank line', () => {
    assert.strictEqual(parseLogLine(''), null)
    assert.strictEqual(parseLogLine('   '), null)
  })

  it('returns null for invalid JSON', () => {
    assert.strictEqual(parseLogLine('not json'), null)
    assert.strictEqual(parseLogLine('{bad: json}'), null)
  })

  it('returns null when timestamp is missing', () => {
    const line = JSON.stringify({ modelId: 'gpt-4o', statusCode: 200 })
    assert.strictEqual(parseLogLine(line), null)
  })

  it('returns null for JSON null', () => {
    assert.strictEqual(parseLogLine('null'), null)
  })

  it('returns null for JSON array instead of object', () => {
    assert.strictEqual(parseLogLine('[]'), null)
  })

  it('parses a minimal valid entry', () => {
    const entry = { timestamp: '2026-03-01T00:00:00.000Z' }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.time, '2026-03-01T00:00:00.000Z')
    assert.strictEqual(row.requestType, 'chat.completions')
    assert.strictEqual(row.model, 'unknown')
    assert.strictEqual(row.provider, 'unknown')
    assert.strictEqual(row.status, 'unknown')
    assert.strictEqual(row.tokens, 0)
    assert.strictEqual(row.latency, 0)
  })

  it('parses a full entry using modelId / providerKey fields', () => {
    const entry = {
      timestamp: '2026-03-02T12:00:00.000Z',
      modelId: 'llama-3.3-70b-instruct',
      providerKey: 'nvidia',
      statusCode: '200',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      latencyMs: 420,
    }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.time, '2026-03-02T12:00:00.000Z')
    assert.strictEqual(row.requestType, 'chat.completions')
    assert.strictEqual(row.model, 'llama-3.3-70b-instruct')
    assert.strictEqual(row.provider, 'nvidia')
    assert.strictEqual(row.status, '200')
    assert.strictEqual(row.tokens, 150)
    assert.strictEqual(row.latency, 420)
  })

  it('falls back to model/provider/status field aliases', () => {
    const entry = {
      timestamp: '2026-03-02T12:00:00.000Z',
      model: 'gpt-4o',
      provider: 'openai',
      status: '429',
      latency: 320,
    }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.model, 'gpt-4o')
    assert.strictEqual(row.provider, 'openai')
    assert.strictEqual(row.status, '429')
    assert.strictEqual(row.latency, 320)
  })

  it('handles missing usage gracefully (tokens = 0)', () => {
    const entry = { timestamp: '2026-03-01T00:00:00.000Z', modelId: 'x' }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.tokens, 0)
  })

  it('handles partial usage object (only prompt_tokens)', () => {
    const entry = {
      timestamp: '2026-03-01T00:00:00.000Z',
      usage: { prompt_tokens: 30 },
    }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.tokens, 30)
  })

  it('parses numeric timestamp into ISO format', () => {
    const row = parseLogLine(JSON.stringify({ timestamp: 1772551002198 }))
    assert.ok(row !== null)
    assert.match(row.time, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('falls back to top-level camelCase token fields', () => {
    const entry = {
      timestamp: '2026-03-01T00:00:00.000Z',
      promptTokens: 25,
      completionTokens: 10,
    }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.tokens, 35)
  })

  it('infers provider/status from accountId and success fields', () => {
    const entry = {
      timestamp: '2026-03-01T00:00:00.000Z',
      accountId: 'groq/llama-3.3-70b/0',
      success: true,
    }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.provider, 'groq')
    assert.strictEqual(row.status, '200')
  })

  it('uses requestType when provided', () => {
    const entry = {
      timestamp: '2026-03-01T00:00:00.000Z',
      requestType: 'chat.completions',
    }
    const row = parseLogLine(JSON.stringify(entry))
    assert.ok(row !== null)
    assert.strictEqual(row.requestType, 'chat.completions')
  })
})

// ─── Suite: loadRecentLogs ────────────────────────────────────────────────────

describe('log-reader – loadRecentLogs', () => {
  let ctx

  before(() => { ctx = makeTempDir('lrl') })
  after(() => ctx.cleanup())

  it('returns empty array when file does not exist', () => {
    const nonexistent = join(ctx.dir, 'no-such-file.jsonl')
    const rows = loadRecentLogs({ logFile: nonexistent })
    assert.ok(Array.isArray(rows))
    assert.strictEqual(rows.length, 0)
  })

  it('returns empty array for empty file', () => {
    const emptyFile = join(ctx.dir, 'empty.jsonl')
    writeFileSync(emptyFile, '')
    const rows = loadRecentLogs({ logFile: emptyFile })
    assert.strictEqual(rows.length, 0)
  })

  it('returns parsed rows from valid file', () => {
    const file = join(ctx.dir, 'valid.jsonl')
    const entry1 = { timestamp: '2026-03-01T10:00:00.000Z', modelId: 'a', providerKey: 'nim', statusCode: '200', latencyMs: 100, usage: { prompt_tokens: 10, completion_tokens: 5 } }
    const entry2 = { timestamp: '2026-03-01T11:00:00.000Z', modelId: 'b', providerKey: 'groq', statusCode: '429', latencyMs: 300, usage: {} }
    writeFileSync(file, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n')
    const rows = loadRecentLogs({ logFile: file })
    assert.strictEqual(rows.length, 2)
    // newest-first: entry2 has later timestamp
    assert.strictEqual(rows[0].model, 'b')
    assert.strictEqual(rows[1].model, 'a')
  })

  it('skips malformed lines without crashing', () => {
    const file = join(ctx.dir, 'mixed.jsonl')
    const good = { timestamp: '2026-03-01T12:00:00.000Z', modelId: 'good', providerKey: 'x', statusCode: '200', latencyMs: 50 }
    writeFileSync(file, [
      'NOT_JSON',
      JSON.stringify(good),
      '{broken',
      '',
    ].join('\n'))
    const rows = loadRecentLogs({ logFile: file })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].model, 'good')
  })

  it('returns rows newest-first (reverse file order)', () => {
    const file = join(ctx.dir, 'ordered.jsonl')
    const entries = [
      { timestamp: '2026-03-01T08:00:00.000Z', modelId: 'first', providerKey: 'p', statusCode: '200', latencyMs: 10 },
      { timestamp: '2026-03-01T09:00:00.000Z', modelId: 'second', providerKey: 'p', statusCode: '200', latencyMs: 20 },
      { timestamp: '2026-03-01T10:00:00.000Z', modelId: 'third', providerKey: 'p', statusCode: '200', latencyMs: 30 },
    ]
    writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    const rows = loadRecentLogs({ logFile: file })
    assert.strictEqual(rows[0].model, 'third')
    assert.strictEqual(rows[1].model, 'second')
    assert.strictEqual(rows[2].model, 'first')
  })

  it('enforces limit option', () => {
    const file = join(ctx.dir, 'limit.jsonl')
    const entries = Array.from({ length: 10 }, (_, i) => ({
      timestamp: `2026-03-01T${String(i).padStart(2, '0')}:00:00.000Z`,
      modelId: `model-${i}`,
      providerKey: 'p',
      statusCode: '200',
      latencyMs: i * 10,
    }))
    writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    const rows = loadRecentLogs({ logFile: file, limit: 3 })
    assert.strictEqual(rows.length, 3)
    // newest first
    assert.strictEqual(rows[0].model, 'model-9')
    assert.strictEqual(rows[1].model, 'model-8')
    assert.strictEqual(rows[2].model, 'model-7')
  })

  it('handles file with only malformed lines gracefully', () => {
    const file = join(ctx.dir, 'allbad.jsonl')
    writeFileSync(file, 'garbage\n{bad}\nnull\n')
    const rows = loadRecentLogs({ logFile: file })
    // null line parses to null, empty string parses to null, garbage parses to null
    // 'null' — parseLogLine returns null because JSON.parse('null') = null (not object)
    assert.strictEqual(rows.length, 0)
  })
})
