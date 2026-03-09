/**
 * @file render-table.js
 * @description Master table renderer for the main TUI list.
 *
 * @details
 *   This module contains the full renderTable implementation used by the CLI.
 *   It renders the header, model rows, status indicators, and footer hints
 *   with consistent alignment, colorization, and viewport clipping.
 *
 *   🎯 Key features:
 *   - Full table layout with tier, latency, stability, uptime, token totals, and usage columns
 *   - Hotkey-aware header lettering so highlighted letters always match live sort/filter keys
 *   - Emoji-aware padding via padEndDisplay for aligned verdict/status cells
 *   - Viewport clipping with above/below indicators
 *   - Smart badges (mode, tier filter, origin filter, profile)
 *   - Proxy status line integrated in footer
 *
 *   → Functions:
 *   - `setActiveProxy` — Provide the active proxy instance for footer status rendering
 *   - `renderTable` — Render the full TUI table as a string (no side effects)
 *
 *   📦 Dependencies:
 *   - ../sources.js: sources provider metadata
 *   - ../src/constants.js: PING_INTERVAL, FRAMES
 *   - ../src/tier-colors.js: TIER_COLOR
 *   - ../src/utils.js: getAvg, getVerdict, getUptime, getStabilityScore
 *   - ../src/ping.js: usagePlaceholderForProvider
 *   - ../src/render-helpers.js: calculateViewport, sortResultsWithPinnedFavorites, renderProxyStatusLine, padEndDisplay
 *
 *   @see bin/free-coding-models.js — main entry point that calls renderTable
 */

import chalk from 'chalk'
import { createRequire } from 'module'
import { sources } from '../sources.js'
import { PING_INTERVAL, FRAMES } from './constants.js'
import { TIER_COLOR } from './tier-colors.js'
import { getAvg, getVerdict, getUptime, getStabilityScore } from './utils.js'
import { usagePlaceholderForProvider } from './ping.js'
import { formatTokenTotalCompact } from './token-usage-reader.js'
import { calculateViewport, sortResultsWithPinnedFavorites, renderProxyStatusLine, padEndDisplay } from './render-helpers.js'

const require = createRequire(import.meta.url)
const { version: LOCAL_VERSION } = require('../package.json')

// 📖 Provider column palette: keep all Origins in the same visual family
// 📖 (blue/cyan tones) while making each provider easy to distinguish at a glance.
const PROVIDER_COLOR = {
  nvidia: [120, 205, 255],
  groq: [95, 185, 255],
  cerebras: [70, 165, 255],
  sambanova: [45, 145, 245],
  openrouter: [135, 220, 255],
  huggingface: [110, 190, 235],
  replicate: [85, 175, 230],
  deepinfra: [60, 160, 225],
  fireworks: [125, 215, 245],
  codestral: [100, 180, 240],
  hyperbolic: [75, 170, 240],
  scaleway: [55, 150, 235],
  googleai: [130, 210, 255],
  siliconflow: [90, 195, 245],
  together: [65, 155, 245],
  cloudflare: [115, 200, 240],
  perplexity: [140, 225, 255],
  qwen: [80, 185, 235],
  zai: [50, 140, 225],
  iflow: [145, 230, 255],
}

// 📖 Active proxy reference for footer status line (set by bin/free-coding-models.js).
let activeProxyRef = null

// 📖 setActiveProxy: Store active proxy instance for renderTable footer line.
export function setActiveProxy(proxyInstance) {
  activeProxyRef = proxyInstance
}

// ─── renderTable: mode param controls footer hint text (opencode vs openclaw) ─────────
export function renderTable(results, pendingPings, frame, cursor = null, sortColumn = 'avg', sortDirection = 'asc', pingInterval = PING_INTERVAL, lastPingTime = Date.now(), mode = 'opencode', tierFilterMode = 0, scrollOffset = 0, terminalRows = 0, originFilterMode = 0, activeProfile = null, profileSaveMode = false, profileSaveBuffer = '', proxyStartupStatus = null) {
  // 📖 Filter out hidden models for display
  const visibleResults = results.filter(r => !r.hidden)

  const up      = visibleResults.filter(r => r.status === 'up').length
  const down    = visibleResults.filter(r => r.status === 'down').length
  const timeout = visibleResults.filter(r => r.status === 'timeout').length
  const pending = visibleResults.filter(r => r.status === 'pending').length

  // 📖 Calculate seconds until next ping
  const timeSinceLastPing = Date.now() - lastPingTime
  const timeUntilNextPing = Math.max(0, pingInterval - timeSinceLastPing)
  const secondsUntilNext = Math.ceil(timeUntilNextPing / 1000)

  const phase = pending > 0
    ? chalk.dim(`discovering — ${pending} remaining…`)
    : pendingPings > 0
      ? chalk.dim(`pinging — ${pendingPings} in flight…`)
      : chalk.dim(`next ping ${secondsUntilNext}s`)

  // 📖 Mode badge shown in header so user knows what Enter will do
  // 📖 Now includes key hint for mode toggle
  let modeBadge
  if (mode === 'openclaw') {
    modeBadge = chalk.bold.rgb(255, 100, 50)(' [🦞 OpenClaw]')
  } else if (mode === 'opencode-desktop') {
    modeBadge = chalk.bold.rgb(0, 200, 255)(' [🖥  Desktop]')
  } else {
    modeBadge = chalk.bold.rgb(0, 200, 255)(' [💻 CLI]')
  }
  
  // 📖 Add mode toggle hint
  const modeHint = chalk.dim.yellow(' (Z to toggle)')

  // 📖 Tier filter badge shown when filtering is active (shows exact tier name)
  const TIER_CYCLE_NAMES = [null, 'S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']
  let tierBadge = ''
  if (tierFilterMode > 0) {
    tierBadge = chalk.bold.rgb(255, 200, 0)(` [${TIER_CYCLE_NAMES[tierFilterMode]}]`)
  }

  const normalizeOriginLabel = (name, key) => {
    if (key === 'qwen') return 'Alibaba'
    return name
  }

  // 📖 Origin filter badge — shown when filtering by provider is active
  let originBadge = ''
  if (originFilterMode > 0) {
    const originKeys = [null, ...Object.keys(sources)]
    const activeOriginKey = originKeys[originFilterMode]
    const activeOriginName = activeOriginKey ? sources[activeOriginKey]?.name ?? activeOriginKey : null
    if (activeOriginName) {
      originBadge = chalk.bold.rgb(100, 200, 255)(` [${normalizeOriginLabel(activeOriginName, activeOriginKey)}]`)
    }
  }

  // 📖 Profile badge — shown when a named profile is active (Shift+P to cycle, Shift+S to save)
  let profileBadge = ''
  if (activeProfile) {
    profileBadge = chalk.bold.rgb(200, 150, 255)(` [📋 ${activeProfile}]`)
  }

  // 📖 Column widths (generous spacing with margins)
  const W_RANK = 6
  const W_TIER = 6
  const W_CTX = 6
  const W_SOURCE = 14
  const W_MODEL = 26
  const W_SWE = 9
  const W_PING = 14
  const W_AVG = 11
  const W_STATUS = 18
  const W_VERDICT = 14
  const W_STAB = 11
  const W_UPTIME = 6
  const W_TOKENS = 7
  const W_USAGE = 7

  // 📖 Sort models using the shared helper
  const sorted = sortResultsWithPinnedFavorites(visibleResults, sortColumn, sortDirection)

  const lines = [
    `  ${chalk.greenBright.bold('✅ FCM')}${modeBadge}${modeHint}${tierBadge}${originBadge}${profileBadge}   ` +
      chalk.greenBright(`✅ ${up}`) + chalk.dim(' up  ') +
      chalk.yellow(`⏳ ${timeout}`) + chalk.dim(' timeout  ') +
      chalk.red(`❌ ${down}`) + chalk.dim(' down  ') +
      phase,
    '',
  ]

  // 📖 Header row with sorting indicators
  // 📖 NOTE: padEnd on chalk strings counts ANSI codes, breaking alignment
  // 📖 Solution: build plain text first, then colorize
  const dir = sortDirection === 'asc' ? '↑' : '↓'

  const rankH    = 'Rank'
  const tierH    = 'Tier'
  const originH  = 'Provider'
  const modelH   = 'Model'
  const sweH     = sortColumn === 'swe' ? dir + ' SWE%' : 'SWE%'
  const ctxH     = sortColumn === 'ctx' ? dir + ' CTX' : 'CTX'
  const pingH    = sortColumn === 'ping' ? dir + ' Latest Ping' : 'Latest Ping'
  const avgH     = sortColumn === 'avg' ? dir + ' Avg Ping' : 'Avg Ping'
  const healthH  = sortColumn === 'condition' ? dir + ' Health' : 'Health'
  const verdictH = sortColumn === 'verdict' ? dir + ' Verdict' : 'Verdict'
  const stabH    = sortColumn === 'stability' ? dir + ' Stability' : 'Stability'
  const uptimeH  = sortColumn === 'uptime' ? dir + ' Up%' : 'Up%'
  const tokensH  = 'Used'
  const usageH   = sortColumn === 'usage' ? dir + ' Usage' : 'Usage'

  // 📖 Helper to colorize first letter for keyboard shortcuts
  // 📖 IMPORTANT: Pad PLAIN TEXT first, then apply colors to avoid alignment issues
  const colorFirst = (text, width, colorFn = chalk.yellow) => {
    const first = text[0]
    const rest = text.slice(1)
    const plainText = first + rest
    const padding = ' '.repeat(Math.max(0, width - plainText.length))
    return colorFn(first) + chalk.dim(rest + padding)
  }

  // 📖 Now colorize after padding is calculated on plain text
  const rankH_c    = colorFirst(rankH, W_RANK)
  const tierH_c    = colorFirst('Tier', W_TIER)
  const originLabel = 'Provider'
  const originH_c  = sortColumn === 'origin'
    ? chalk.bold.cyan(originLabel.padEnd(W_SOURCE))
    : (originFilterMode > 0 ? chalk.bold.rgb(100, 200, 255)(originLabel.padEnd(W_SOURCE)) : (() => {
      // 📖 Provider keeps O for sorting and D for provider-filter cycling.
      const plain = 'PrOviDer'
      const padding = ' '.repeat(Math.max(0, W_SOURCE - plain.length))
      return chalk.dim('Pr') + chalk.yellow.bold('O') + chalk.dim('vi') + chalk.yellow.bold('D') + chalk.dim('er' + padding)
    })())
  const modelH_c   = colorFirst(modelH, W_MODEL)
  const sweH_c     = sortColumn === 'swe' ? chalk.bold.cyan(sweH.padEnd(W_SWE)) : colorFirst(sweH, W_SWE)
  const ctxH_c     = sortColumn === 'ctx' ? chalk.bold.cyan(ctxH.padEnd(W_CTX)) : colorFirst(ctxH, W_CTX)
  const pingH_c    = sortColumn === 'ping' ? chalk.bold.cyan(pingH.padEnd(W_PING)) : colorFirst('Latest Ping', W_PING)
  const avgH_c     = sortColumn === 'avg' ? chalk.bold.cyan(avgH.padEnd(W_AVG)) : colorFirst('Avg Ping', W_AVG)
  const healthH_c  = sortColumn === 'condition' ? chalk.bold.cyan(healthH.padEnd(W_STATUS)) : colorFirst('Health', W_STATUS)
  const verdictH_c = sortColumn === 'verdict' ? chalk.bold.cyan(verdictH.padEnd(W_VERDICT)) : colorFirst(verdictH, W_VERDICT)
  // 📖 Custom colorization for Stability: highlight 'B' (the sort key) since 'S' is taken by SWE
  const stabH_c    = sortColumn === 'stability' ? chalk.bold.cyan(stabH.padEnd(W_STAB)) : (() => {
    const plain = 'Stability'
    const padding = ' '.repeat(Math.max(0, W_STAB - plain.length))
    return chalk.dim('Sta') + chalk.yellow.bold('B') + chalk.dim('ility' + padding)
  })()
  // 📖 Up% sorts on U, so keep the highlighted shortcut in the shared yellow sort-key color.
  const uptimeH_c  = sortColumn === 'uptime' ? chalk.bold.cyan(uptimeH.padEnd(W_UPTIME)) : (() => {
    const plain = 'Up%'
    const padding = ' '.repeat(Math.max(0, W_UPTIME - plain.length))
    return chalk.yellow.bold('U') + chalk.dim('p%' + padding)
  })()
  const tokensH_c  = chalk.dim(tokensH.padEnd(W_TOKENS))
  // 📖 Usage sorts on plain G, so the highlighted letter must stay in the visible header.
  const usageH_c   = sortColumn === 'usage' ? chalk.bold.cyan(usageH.padEnd(W_USAGE)) : (() => {
    const plain = 'UsaGe'
    const padding = ' '.repeat(Math.max(0, W_USAGE - plain.length))
    return chalk.dim('Usa') + chalk.yellow.bold('G') + chalk.dim('e' + padding)
  })()

  // 📖 Header with proper spacing (column order: Rank, Tier, SWE%, CTX, Model, Provider, Latest Ping, Avg Ping, Health, Verdict, Stability, Up%, Used, Usage)
  lines.push('  ' + rankH_c + '  ' + tierH_c + '  ' + sweH_c + '  ' + ctxH_c + '  ' + modelH_c + '  ' + originH_c + '  ' + pingH_c + '  ' + avgH_c + '  ' + healthH_c + '  ' + verdictH_c + '  ' + stabH_c + '  ' + uptimeH_c + '  ' + tokensH_c + '  ' + usageH_c)

  // 📖 Separator line
  lines.push(
    '  ' +
    chalk.dim('─'.repeat(W_RANK)) + '  ' +
    chalk.dim('─'.repeat(W_TIER)) + '  ' +
    chalk.dim('─'.repeat(W_SWE)) + '  ' +
    chalk.dim('─'.repeat(W_CTX)) + '  ' +
    '─'.repeat(W_MODEL) + '  ' +
    '─'.repeat(W_SOURCE) + '  ' +
    chalk.dim('─'.repeat(W_PING)) + '  ' +
    chalk.dim('─'.repeat(W_AVG)) + '  ' +
    chalk.dim('─'.repeat(W_STATUS)) + '  ' +
    chalk.dim('─'.repeat(W_VERDICT)) + '  ' +
    chalk.dim('─'.repeat(W_STAB)) + '  ' +
    chalk.dim('─'.repeat(W_UPTIME)) + '  ' +
    chalk.dim('─'.repeat(W_TOKENS)) + '  ' +
    chalk.dim('─'.repeat(W_USAGE))
  )

  // 📖 Viewport clipping: only render models that fit on screen
  const vp = calculateViewport(terminalRows, scrollOffset, sorted.length)

  if (vp.hasAbove) {
    lines.push(chalk.dim(`  ... ${vp.startIdx} more above ...`))
  }

  for (let i = vp.startIdx; i < vp.endIdx; i++) {
    const r = sorted[i]
    const tierFn = TIER_COLOR[r.tier] ?? (t => chalk.white(t))

    const isCursor = cursor !== null && i === cursor

    // 📖 Left-aligned columns - pad plain text first, then colorize
    const num = chalk.dim(String(r.idx).padEnd(W_RANK))
    const tier = tierFn(r.tier.padEnd(W_TIER))
    // 📖 Keep terminal view provider-specific so each row is monitorable per provider
    const providerNameRaw = sources[r.providerKey]?.name ?? r.providerKey ?? 'NIM'
    const providerName = normalizeOriginLabel(providerNameRaw, r.providerKey)
    const providerRgb = PROVIDER_COLOR[r.providerKey] ?? [105, 190, 245]
    const source = chalk.rgb(...providerRgb)(providerName.padEnd(W_SOURCE))
    // 📖 Favorites: always reserve 2 display columns at the start of Model column.
    // 📖 🎯 (2 cols) for recommended, ⭐ (2 cols) for favorites, '  ' (2 spaces) for non-favorites — keeps alignment stable.
    const favoritePrefix = r.isRecommended ? '🎯' : r.isFavorite ? '⭐' : '  '
    const prefixDisplayWidth = 2
    const nameWidth = Math.max(0, W_MODEL - prefixDisplayWidth)
    const name = favoritePrefix + r.label.slice(0, nameWidth).padEnd(nameWidth)
    const sweScore = r.sweScore ?? '—'
    // 📖 SWE% colorized on the same gradient as Tier:
    //   ≥70% bright neon green (S+), ≥60% green (S), ≥50% yellow-green (A+),
    //   ≥40% yellow (A), ≥35% amber (A-), ≥30% orange-red (B+),
    //   ≥20% red (B), <20% dark red (C), '—' dim
    let sweCell
    if (sweScore === '—') {
      sweCell = chalk.dim(sweScore.padEnd(W_SWE))
    } else {
      const sweVal = parseFloat(sweScore)
      const swePadded = sweScore.padEnd(W_SWE)
      if (sweVal >= 70)      sweCell = chalk.bold.rgb(0,   255,  80)(swePadded)
      else if (sweVal >= 60) sweCell = chalk.bold.rgb(80,  220,   0)(swePadded)
      else if (sweVal >= 50) sweCell = chalk.bold.rgb(170, 210,   0)(swePadded)
      else if (sweVal >= 40) sweCell = chalk.rgb(240, 190,   0)(swePadded)
      else if (sweVal >= 35) sweCell = chalk.rgb(255, 130,   0)(swePadded)
      else if (sweVal >= 30) sweCell = chalk.rgb(255,  70,   0)(swePadded)
      else if (sweVal >= 20) sweCell = chalk.rgb(210,  20,   0)(swePadded)
      else                   sweCell = chalk.rgb(140,   0,   0)(swePadded)
    }
    
    // 📖 Context window column - colorized by size (larger = better)
    const ctxRaw = r.ctx ?? '—'
    const ctxCell = ctxRaw !== '—' && (ctxRaw.includes('128k') || ctxRaw.includes('200k') || ctxRaw.includes('1m'))
      ? chalk.greenBright(ctxRaw.padEnd(W_CTX))
      : ctxRaw !== '—' && (ctxRaw.includes('32k') || ctxRaw.includes('64k'))
      ? chalk.cyan(ctxRaw.padEnd(W_CTX))
      : chalk.dim(ctxRaw.padEnd(W_CTX))

    // 📖 Keep the row-local spinner small and inline so users can still read the last measured latency.
    const buildLatestPingDisplay = (value) => {
      const spinner = r.isPinging ? ` ${FRAMES[frame % FRAMES.length]}` : ''
      return `${value}${spinner}`.padEnd(W_PING)
    }

    // 📖 Latest ping - pings are objects: { ms, code }
    // 📖 Show response time for 200 (success) and 401 (no-auth but server is reachable)
    const latestPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null
    let pingCell
    if (!latestPing) {
      const placeholder = r.isPinging ? buildLatestPingDisplay('———') : '———'.padEnd(W_PING)
      pingCell = chalk.dim(placeholder)
    } else if (latestPing.code === '200') {
      // 📖 Success - show response time
      const str = buildLatestPingDisplay(String(latestPing.ms))
      pingCell = latestPing.ms < 500 ? chalk.greenBright(str) : latestPing.ms < 1500 ? chalk.yellow(str) : chalk.red(str)
    } else if (latestPing.code === '401') {
      // 📖 401 = no API key but server IS reachable — still show latency in dim
      pingCell = chalk.dim(buildLatestPingDisplay(String(latestPing.ms)))
    } else {
      // 📖 Error or timeout - show "———" (error code is already in Status column)
      const placeholder = r.isPinging ? buildLatestPingDisplay('———') : '———'.padEnd(W_PING)
      pingCell = chalk.dim(placeholder)
    }

    // 📖 Avg ping (just number, no "ms")
    const avg = getAvg(r)
    let avgCell
    if (avg !== Infinity) {
      const str = String(avg).padEnd(W_AVG)
      avgCell = avg < 500 ? chalk.greenBright(str) : avg < 1500 ? chalk.yellow(str) : chalk.red(str)
    } else {
      avgCell = chalk.dim('———'.padEnd(W_AVG))
    }

    // 📖 Status column - build plain text with emoji, pad, then colorize
    // 📖 Different emojis for different error codes
    let statusText, statusColor
    if (r.status === 'noauth') {
      // 📖 Server responded but needs an API key — shown dimly since it IS reachable
      statusText = `🔑 NO KEY`
      statusColor = (s) => chalk.dim(s)
    } else if (r.status === 'pending') {
      statusText = `${FRAMES[frame % FRAMES.length]} wait`
      statusColor = (s) => chalk.dim.yellow(s)
    } else if (r.status === 'up') {
      statusText = `✅ UP`
      statusColor = (s) => s
    } else if (r.status === 'timeout') {
      statusText = `⏳ TIMEOUT`
      statusColor = (s) => chalk.yellow(s)
    } else if (r.status === 'down') {
      const code = r.httpCode ?? 'ERR'
      // 📖 Different emojis for different error codes
      const errorEmojis = {
        '429': '🔥',  // Rate limited / overloaded
        '404': '🚫',  // Not found
        '500': '💥',  // Internal server error
        '502': '🔌',  // Bad gateway
        '503': '🔒',  // Service unavailable
        '504': '⏰',  // Gateway timeout
      }
      const errorLabels = {
        '404': '404 NOT FOUND',
        '410': '410 GONE',
        '429': '429 TRY LATER',
        '500': '500 ERROR',
      }
      const emoji = errorEmojis[code] || '❌'
      statusText = `${emoji} ${errorLabels[code] || code}`
      statusColor = (s) => chalk.red(s)
    } else {
      statusText = '?'
      statusColor = (s) => chalk.dim(s)
    }
    const status = statusColor(padEndDisplay(statusText, W_STATUS))

    // 📖 Verdict column - use getVerdict() for stability-aware verdicts, then render with emoji
    const verdict = getVerdict(r)
    let verdictText, verdictColor
    // 📖 Verdict colors follow the same green→red gradient as TIER_COLOR / SWE%
    switch (verdict) {
      case 'Perfect':
        verdictText = 'Perfect 🚀'
        verdictColor = (s) => chalk.bold.rgb(0, 255, 180)(s)    // bright cyan-green — stands out from Normal
        break
      case 'Normal':
        verdictText = 'Normal ✅'
        verdictColor = (s) => chalk.bold.rgb(140, 200, 0)(s)    // lime-yellow — clearly warmer than Perfect
        break
      case 'Spiky':
        verdictText = 'Spiky 📈'
        verdictColor = (s) => chalk.bold.rgb(170, 210, 0)(s)    // A+ yellow-green
        break
      case 'Slow':
        verdictText = 'Slow 🐢'
        verdictColor = (s) => chalk.bold.rgb(255, 130, 0)(s)    // A- amber
        break
      case 'Very Slow':
        verdictText = 'Very Slow 🐌'
        verdictColor = (s) => chalk.bold.rgb(255, 70, 0)(s)     // B+ orange-red
        break
      case 'Overloaded':
        verdictText = 'Overloaded 🔥'
        verdictColor = (s) => chalk.bold.rgb(210, 20, 0)(s)     // B red
        break
      case 'Unstable':
        verdictText = 'Unstable ⚠️'
        verdictColor = (s) => chalk.bold.rgb(175, 10, 0)(s)     // between B and C
        break
      case 'Not Active':
        verdictText = 'Not Active 👻'
        verdictColor = (s) => chalk.dim(s)
        break
      case 'Pending':
        verdictText = 'Pending ⏳'
        verdictColor = (s) => chalk.dim(s)
        break
      default:
        verdictText = 'Unusable 💀'
        verdictColor = (s) => chalk.bold.rgb(140, 0, 0)(s)      // C dark red
        break
    }
    // 📖 Use padEndDisplay to account for emoji display width (2 cols each) so all rows align
    const speedCell = verdictColor(padEndDisplay(verdictText, W_VERDICT))

    // 📖 Stability column - composite score (0–100) from p95 + jitter + spikes + uptime
    // 📖 Left-aligned to sit flush under the column header
    const stabScore = getStabilityScore(r)
    let stabCell
    if (stabScore < 0) {
      stabCell = chalk.dim('———'.padEnd(W_STAB))
    } else if (stabScore >= 80) {
      stabCell = chalk.greenBright(String(stabScore).padEnd(W_STAB))
    } else if (stabScore >= 60) {
      stabCell = chalk.cyan(String(stabScore).padEnd(W_STAB))
    } else if (stabScore >= 40) {
      stabCell = chalk.yellow(String(stabScore).padEnd(W_STAB))
    } else {
      stabCell = chalk.red(String(stabScore).padEnd(W_STAB))
    }

    // 📖 Uptime column - percentage of successful pings
    // 📖 Left-aligned to sit flush under the column header
    const uptimePercent = getUptime(r)
    const uptimeStr = uptimePercent + '%'
    let uptimeCell
    if (uptimePercent >= 90) {
      uptimeCell = chalk.greenBright(uptimeStr.padEnd(W_UPTIME))
    } else if (uptimePercent >= 70) {
      uptimeCell = chalk.yellow(uptimeStr.padEnd(W_UPTIME))
    } else if (uptimePercent >= 50) {
      uptimeCell = chalk.rgb(255, 165, 0)(uptimeStr.padEnd(W_UPTIME)) // orange
    } else {
      uptimeCell = chalk.red(uptimeStr.padEnd(W_UPTIME))
    }

    // 📖 When cursor is on this row, render Model and Provider in bright white for readability
    const nameCell = isCursor ? chalk.white.bold(favoritePrefix + r.label.slice(0, nameWidth).padEnd(nameWidth)) : name
    const sourceCursorText = providerName.padEnd(W_SOURCE)
    const sourceCell = isCursor ? chalk.white.bold(sourceCursorText) : source

    // 📖 Usage column — provider-scoped remaining quota when measurable,
    // 📖 otherwise a green dot to show "usable but not meaningfully quantifiable".
    let usageCell
    if (r.usagePercent !== undefined && r.usagePercent !== null) {
      const usageStr = Math.round(r.usagePercent) + '%'
      if (r.usagePercent >= 80) {
        usageCell = chalk.greenBright(usageStr.padEnd(W_USAGE))
      } else if (r.usagePercent >= 50) {
        usageCell = chalk.yellow(usageStr.padEnd(W_USAGE))
      } else if (r.usagePercent >= 20) {
        usageCell = chalk.rgb(255, 165, 0)(usageStr.padEnd(W_USAGE)) // orange
      } else {
        usageCell = chalk.red(usageStr.padEnd(W_USAGE))
      }
    } else {
      const usagePlaceholder = usagePlaceholderForProvider(r.providerKey)
      usageCell = usagePlaceholder === '🟢'
        ? chalk.greenBright(usagePlaceholder.padEnd(W_USAGE))
        : chalk.dim(usagePlaceholder.padEnd(W_USAGE))
    }

    // 📖 Used column — total historical prompt+completion tokens consumed for this
    // 📖 exact provider/model pair, loaded once from request-log.jsonl at startup.
    const tokenTotal = Number(r.totalTokens) || 0
    const tokensCell = tokenTotal > 0
      ? chalk.rgb(120, 210, 255)(formatTokenTotalCompact(tokenTotal).padEnd(W_TOKENS))
      : chalk.dim('0'.padEnd(W_TOKENS))

    // 📖 Build row with double space between columns (order: Rank, Tier, SWE%, CTX, Model, Provider, Latest Ping, Avg Ping, Health, Verdict, Stability, Up%, Used, Usage)
    const row = '  ' + num + '  ' + tier + '  ' + sweCell + '  ' + ctxCell + '  ' + nameCell + '  ' + sourceCell + '  ' + pingCell + '  ' + avgCell + '  ' + status + '  ' + speedCell + '  ' + stabCell + '  ' + uptimeCell + '  ' + tokensCell + '  ' + usageCell

    if (isCursor) {
      lines.push(chalk.bgRgb(50, 0, 60)(row))
    } else if (r.isRecommended) {
      // 📖 Medium green background for recommended models (distinguishable from favorites)
      lines.push(chalk.bgRgb(15, 40, 15)(row))
    } else if (r.isFavorite) {
      lines.push(chalk.bgRgb(35, 20, 0)(row))
    } else {
      lines.push(row)
    }
  }

  if (vp.hasBelow) {
    lines.push(chalk.dim(`  ... ${sorted.length - vp.endIdx} more below ...`))
  }

   // 📖 Profile save inline prompt — shown when Shift+S is pressed, replaces spacer line
   if (profileSaveMode) {
     lines.push(chalk.bgRgb(40, 20, 60)(`  📋 Save profile as: ${chalk.cyanBright(profileSaveBuffer + '▏')}  ${chalk.dim('Enter save  •  Esc cancel')}`))
   } else {
     lines.push('')
   }
  const intervalSec = Math.round(pingInterval / 1000)

  // 📖 Footer hints adapt based on active mode
  const actionHint = mode === 'openclaw'
    ? chalk.rgb(255, 100, 50)('Enter→SetOpenClaw')
    : mode === 'opencode-desktop'
      ? chalk.rgb(0, 200, 255)('Enter→OpenDesktop')
      : chalk.rgb(0, 200, 255)('Enter→OpenCode')
  // 📖 Line 1: core navigation + sorting shortcuts
  lines.push(chalk.dim(`  ↑↓ Navigate  •  `) + actionHint + chalk.dim(`  •  `) + chalk.yellow('F') + chalk.dim(` Favorite  •  R/Y/O/M/L/A/S/C/H/V/B/U/`) + chalk.yellow('G') + chalk.dim(` Sort  •  `) + chalk.yellow('T') + chalk.dim(` Tier  •  `) + chalk.yellow('D') + chalk.dim(` Provider  •  W↓/=↑ (${intervalSec}s)  •  `) + chalk.rgb(255, 100, 50).bold('Z') + chalk.dim(` Mode  •  `) + chalk.yellow('X') + chalk.dim(` Logs  •  `) + chalk.yellow('P') + chalk.dim(` Settings  •  `) + chalk.rgb(0, 255, 80).bold('K') + chalk.dim(` Help`))
  // 📖 Line 2: profiles, recommend, feature request, bug report, and extended hints — gives visibility to less-obvious features
  lines.push(chalk.dim(`  `) + chalk.rgb(200, 150, 255).bold('⇧P') + chalk.dim(` Cycle profile  •  `) + chalk.rgb(200, 150, 255).bold('⇧S') + chalk.dim(` Save profile  •  `) + chalk.rgb(0, 200, 180).bold('Q') + chalk.dim(` Smart Recommend  •  `) + chalk.rgb(57, 255, 20).bold('J') + chalk.dim(` Request feature  •  `) + chalk.rgb(255, 87, 51).bold('I') + chalk.dim(` Report bug  •  `) + chalk.yellow('Esc') + chalk.dim(` Close overlay`))
  // 📖 Proxy status line — always rendered with explicit state (starting/running/failed/stopped)
  lines.push(renderProxyStatusLine(proxyStartupStatus, activeProxyRef))
  lines.push(
    chalk.rgb(255, 150, 200)('  Made with 💖 & ☕ by \x1b]8;;https://github.com/vava-nessa\x1b\\vava-nessa\x1b]8;;\x1b\\') +
    chalk.dim('  •  ') +
    '⭐ ' +
    chalk.yellow('\x1b]8;;https://github.com/vava-nessa/free-coding-models\x1b\\Star on GitHub\x1b]8;;\x1b\\') +
    chalk.dim('  •  ') +
    '🤝 ' +
    chalk.rgb(255, 165, 0)('\x1b]8;;https://github.com/vava-nessa/free-coding-models/graphs/contributors\x1b\\Contributors\x1b]8;;\x1b\\') +
    chalk.dim('  •  ') +
    '💬 ' +
    chalk.rgb(200, 150, 255)('\x1b]8;;https://discord.gg/5MbTnDC3Md\x1b\\Discord\x1b]8;;\x1b\\') +
    chalk.dim(' → ') +
    chalk.rgb(200, 150, 255)('https://discord.gg/5MbTnDC3Md') +
    chalk.dim('  •  ') +
    chalk.dim(`v${LOCAL_VERSION}`) +
    chalk.dim('  •  ') +
    chalk.dim('Ctrl+C Exit')
  )

  // 📖 Append \x1b[K (erase to EOL) to each line so leftover chars from previous
  // 📖 frames are cleared. Then pad with blank cleared lines to fill the terminal,
  // 📖 preventing stale content from lingering at the bottom after resize.
  const EL = '\x1b[K'
  const cleared = lines.map(l => l + EL)
  const remaining = terminalRows > 0 ? Math.max(0, terminalRows - cleared.length) : 0
  for (let i = 0; i < remaining; i++) cleared.push(EL)
  return cleared.join('\n')
}
