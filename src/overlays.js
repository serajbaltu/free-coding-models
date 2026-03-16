/**
 * @file overlays.js
 * @description Factory for TUI overlay renderers and recommend analysis flow.
 *
 * @details
 *   This module centralizes all overlay rendering in one place:
 *   - Settings, Install Endpoints, Help, Log, Smart Recommend, Feedback, Changelog
 *   - FCM Proxy V2 overlay with current-tool auto-sync toggle and cleanup
 *   - Settings diagnostics for provider key tests, including wrapped retry/error details
 *   - Recommend analysis timer orchestration and progress updates
 *
 *   The factory pattern keeps stateful UI logic isolated while still
 *   allowing the main CLI to control shared state and dependencies.
 *
 *   📖 The proxy overlay rows are: Enable → Auto-sync current tool → Port → Cleanup → Install/Restart/Stop/Kill/Logs
 *   📖 Feedback overlay (I key) combines feature requests + bug reports in one left-aligned input
 *
 *   → Functions:
 *   - `createOverlayRenderers` — returns renderer + analysis helpers
 *
 * @exports { createOverlayRenderers }
 * @see ./proxy-sync.js — resolveProxySyncToolMode powers current-tool proxy sync hints
 * @see ./key-handler.js — handles keypresses for all overlay interactions
 */

import { loadChangelog } from './changelog-loader.js'
import { buildCliHelpLines } from './cli-help.js'
import { resolveProxySyncToolMode } from './proxy-sync.js'

export function createOverlayRenderers(state, deps) {
  const {
    chalk,
    sources,
    PROVIDER_METADATA,
    PROVIDER_COLOR,
    LOCAL_VERSION,
    getApiKey,
    getProxySettings,
    resolveApiKeys,
    isProviderEnabled,
    TIER_CYCLE,
    SETTINGS_OVERLAY_BG,
    HELP_OVERLAY_BG,
    RECOMMEND_OVERLAY_BG,
    LOG_OVERLAY_BG,
    OVERLAY_PANEL_WIDTH,
    keepOverlayTargetVisible,
    sliceOverlayLines,
    tintOverlayLines,
    loadRecentLogs,
    TASK_TYPES,
    PRIORITY_TYPES,
    CONTEXT_BUDGETS,
    FRAMES,
    TIER_COLOR,
    getAvg,
    getStabilityScore,
    toFavoriteKey,
    getTopRecommendations,
    adjustScrollOffset,
    getPingModel,
    getConfiguredInstallableProviders,
    getInstallTargetModes,
    getProviderCatalogModels,
    CONNECTION_MODES,
    getToolMeta,
  } = deps

  // 📖 Wrap plain diagnostic text so long Settings messages stay readable inside
  // 📖 the overlay instead of turning into one truncated red line.
  // 📖 Uses 100% of terminal width minus padding for better readability.
  const wrapPlainText = (text, width = null) => {
    const effectiveWidth = width || (state.terminalCols - 16)
    const normalized = typeof text === 'string' ? text.trim() : ''
    if (!normalized) return []
    const words = normalized.split(/\s+/)
    const lines = []
    let current = ''
    for (const word of words) {
      const next = current ? `${current} ${word}` : word
      if (next.length > effectiveWidth && current) {
        lines.push(current)
        current = word
      } else {
        current = next
      }
    }
    if (current) lines.push(current)
    return lines
  }

  // 📖 Keep log token formatting aligned with the main table so the same totals
  // 📖 read the same everywhere in the TUI.
  const formatLogTokens = (totalTokens) => {
    const safeTotal = Number(totalTokens) || 0
    if (safeTotal <= 0) return '--'
    if (safeTotal >= 999_500) return `${(safeTotal / 1_000_000).toFixed(2)}M`
    if (safeTotal >= 1_000) return `${(safeTotal / 1_000).toFixed(2)}k`
    return String(Math.floor(safeTotal))
  }

  // 📖 Colorize latency with gradient: green (<500ms) → orange (<1000ms) → yellow (<1500ms) → red (>=1500ms)
  const colorizeLatency = (latency, text) => {
    const ms = Number(latency) || 0
    if (ms <= 0) return chalk.dim(text)
    if (ms < 500) return chalk.greenBright(text)
    if (ms < 1000) return chalk.rgb(255, 165, 0)(text)  // Orange
    if (ms < 1500) return chalk.yellow(text)
    return chalk.red(text)
  }

  // 📖 Colorize tokens with gradient: dim green (few) → bright green (many)
  const colorizeTokens = (tokens, text) => {
    const tok = Number(tokens) || 0
    if (tok <= 0) return chalk.dim(text)
    // Gradient: light green (low) → medium green → bright green (high, >30k)
    if (tok < 10_000) return chalk.hex('#90EE90')(text)  // Light green
    if (tok < 30_000) return chalk.hex('#32CD32')(text)  // Lime green
    return chalk.greenBright(text)  // Full brightness green
  }

  // 📖 Get model color based on status code - distinct colors for each error type
  const getModelColorByStatus = (status) => {
    const sc = String(status)
    if (sc === '200') return chalk.greenBright  // Success - bright green
    if (sc === '404') return chalk.rgb(139, 0, 0)  // Not found - dark red
    if (sc === '400') return chalk.hex('#8B008B')  // Bad request - dark magenta
    if (sc === '401') return chalk.hex('#9932CC')  // Unauthorized - dark orchid
    if (sc === '403') return chalk.hex('#BA55D3')  // Forbidden - medium orchid
    if (sc === '413') return chalk.hex('#FF6347')  // Payload too large - tomato red
    if (sc === '429') return chalk.hex('#FFB90F')  // Rate limit - dark orange
    if (sc === '500') return chalk.hex('#DC143C')  // Internal server error - crimson
    if (sc === '502') return chalk.hex('#C71585')  // Bad gateway - medium violet red
    if (sc === '503') return chalk.hex('#9370DB')  // Service unavailable - medium purple
    if (sc.startsWith('5')) return chalk.magenta  // Other 5xx - magenta
    if (sc === '0') return chalk.hex('#696969')  // Timeout/error - dim gray
    return chalk.white  // Unknown - white
  }

  // ─── Settings screen renderer ─────────────────────────────────────────────
  // 📖 renderSettings: Draw the settings overlay in the alt screen buffer.
  // 📖 Shows all providers with their API key (masked) + enabled state.
  // 📖 When in edit mode (settingsEditMode=true), shows an inline input field.
  // 📖 Key "T" in settings = test API key for selected provider.
  function renderSettings() {
    const providerKeys = Object.keys(sources)
const updateRowIdx = providerKeys.length
      const widthWarningRowIdx = updateRowIdx + 1
      const proxyDaemonRowIdx = widthWarningRowIdx + 1
      const changelogViewRowIdx = proxyDaemonRowIdx + 1
    const proxySettings = getProxySettings(state.config)
    const EL = '\x1b[K'
    const lines = []
    const cursorLineByRow = {}

    // 📖 Branding header
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold('⚙  Settings')}`)

    if (state.settingsErrorMsg) {
      lines.push(`  ${chalk.red.bold(state.settingsErrorMsg)}`)
      lines.push('')
    }

    lines.push(`  ${chalk.bold('🧩 Providers')}`)
    // 📖 Dynamic separator line using 100% terminal width
    const separatorWidth = Math.max(20, state.terminalCols - 10)
    lines.push(`  ${chalk.dim('  ' + '─'.repeat(separatorWidth))}`)
    lines.push('')

    for (let i = 0; i < providerKeys.length; i++) {
      const pk = providerKeys[i]
      const src = sources[pk]
      const meta = PROVIDER_METADATA[pk] || {}
      const isCursor = i === state.settingsCursor
      const enabled = isProviderEnabled(state.config, pk)
      const keyVal = state.config.apiKeys?.[pk] ?? ''
      // 📖 Resolve all keys for this provider (for multi-key display)
      const allKeys = resolveApiKeys(state.config, pk)
      const keyCount = allKeys.length

      // 📖 Build API key display — mask most chars, show last 4
      let keyDisplay
      if ((state.settingsEditMode || state.settingsAddKeyMode) && isCursor) {
        // 📖 Inline editing/adding: show typed buffer with cursor indicator
        const modePrefix = state.settingsAddKeyMode ? chalk.dim('[+] ') : ''
        keyDisplay = chalk.cyanBright(`${modePrefix}${state.settingsEditBuffer || ''}▏`)
      } else if (keyCount > 0) {
        // 📖 Show the primary (first/string) key masked + count indicator for extras
        const primaryKey = allKeys[0]
        const visible = primaryKey.slice(-4)
        const masked = '•'.repeat(Math.min(16, Math.max(4, primaryKey.length - 4)))
        const keyMasked = chalk.dim(masked + visible)
        const extra = keyCount > 1 ? chalk.cyan(` (+${keyCount - 1} more)`) : ''
        keyDisplay = keyMasked + extra
      } else {
        keyDisplay = chalk.dim('(no key set)')
      }

      // 📖 Test result badge
      const testResult = state.settingsTestResults[pk]
      // 📖 Default badge reflects configuration first: a saved key should look
      // 📖 ready to test even before the user has run the probe once.
      let testBadge = keyCount > 0 ? chalk.cyan('[Test]') : chalk.dim('[Missing Key 🔑]')
      if (testResult === 'pending') testBadge = chalk.yellow('[Testing…]')
      else if (testResult === 'ok')   testBadge = chalk.greenBright('[Test ✅]')
      else if (testResult === 'missing_key') testBadge = chalk.dim('[Missing Key 🔑]')
      else if (testResult === 'auth_error') testBadge = chalk.red('[Auth ❌]')
      else if (testResult === 'rate_limited') testBadge = chalk.yellow('[Rate limit ⏳]')
      else if (testResult === 'no_callable_model') testBadge = chalk.magenta('[No model ⚠]')
      else if (testResult === 'fail') testBadge = chalk.red('[Test ❌]')
      // 📖 No truncation of rate limits - overlay now uses 100% terminal width
      const rateSummary = chalk.dim(meta.rateLimits || 'No limit info')

      const enabledBadge = enabled ? chalk.greenBright('✅') : chalk.redBright('❌')
      // 📖 Color provider names the same way as in the main table
      const providerRgb = PROVIDER_COLOR[pk] ?? [105, 190, 245]
      const providerName = chalk.bold.rgb(...providerRgb)((meta.label || src.name || pk).slice(0, 22).padEnd(22))
      const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')

      const row = `${bullet}[ ${enabledBadge} ] ${providerName}  ${keyDisplay.padEnd(30)}  ${testBadge}  ${rateSummary}`
      cursorLineByRow[i] = lines.length
      lines.push(isCursor ? chalk.bgRgb(30, 30, 60)(row) : row)
    }

    lines.push('')
    const selectedProviderKey = providerKeys[Math.min(state.settingsCursor, providerKeys.length - 1)]
    const selectedSource = sources[selectedProviderKey]
    const selectedMeta = PROVIDER_METADATA[selectedProviderKey] || {}
    if (selectedSource && state.settingsCursor < providerKeys.length) {
      const selectedKey = getApiKey(state.config, selectedProviderKey)
      const setupStatus = selectedKey ? chalk.green('API key detected ✅') : chalk.yellow('API key missing ⚠')
      // 📖 Color the provider name in the setup instructions header
      const selectedProviderRgb = PROVIDER_COLOR[selectedProviderKey] ?? [105, 190, 245]
      const coloredProviderName = chalk.bold.rgb(...selectedProviderRgb)(selectedMeta.label || selectedSource.name || selectedProviderKey)
      lines.push(`  ${chalk.bold('Setup Instructions')} — ${coloredProviderName}`)
      lines.push(chalk.dim(`  1) Create a ${selectedMeta.label || selectedSource.name} account: ${selectedMeta.signupUrl || 'signup link missing'}`))
      lines.push(chalk.dim(`  2) ${selectedMeta.signupHint || 'Generate an API key and paste it with Enter on this row'}`))
      lines.push(chalk.dim(`  3) Press ${chalk.yellow('T')} to test your key. Status: ${setupStatus}`))
      if (selectedProviderKey === 'cloudflare') {
        const hasAccountId = Boolean((process.env.CLOUDFLARE_ACCOUNT_ID || '').trim())
        const accountIdStatus = hasAccountId ? chalk.green('CLOUDFLARE_ACCOUNT_ID detected ✅') : chalk.yellow('Set CLOUDFLARE_ACCOUNT_ID ⚠')
        lines.push(chalk.dim(`  4) Export ${chalk.yellow('CLOUDFLARE_ACCOUNT_ID')} in your shell. Status: ${accountIdStatus}`))
      }
      const testDetail = state.settingsTestDetails?.[selectedProviderKey]
      if (testDetail) {
        lines.push('')
        lines.push(chalk.red.bold('  Test Diagnostics'))
        for (const detailLine of wrapPlainText(testDetail)) {
          lines.push(chalk.red(`  ${detailLine}`))
        }
      }
      lines.push('')
    }

    lines.push('')
    lines.push(`  ${chalk.bold('🛠 Maintenance')}`)
    lines.push(`  ${chalk.dim('  ' + '─'.repeat(separatorWidth))}`)
    lines.push('')

    const updateCursor = state.settingsCursor === updateRowIdx
    const updateBullet = updateCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const updateState = state.settingsUpdateState
    const latestFound = state.settingsUpdateLatestVersion
    const updateActionLabel = updateState === 'available' && latestFound
      ? `Install update (v${latestFound})`
      : 'Check for updates manually'
    let updateStatus = chalk.dim('Press Enter or U to check npm registry')
    if (updateState === 'checking') updateStatus = chalk.yellow('Checking npm registry…')
    if (updateState === 'available' && latestFound) updateStatus = chalk.greenBright(`Update available: v${latestFound} (Enter to install)`)
    if (updateState === 'up-to-date') updateStatus = chalk.green('Already on latest version')
    if (updateState === 'error') updateStatus = chalk.red('Check failed (press U to retry)')
    if (updateState === 'installing') updateStatus = chalk.cyan('Installing update…')
    const updateRow = `${updateBullet}${chalk.bold(updateActionLabel).padEnd(44)} ${updateStatus}`
    cursorLineByRow[updateRowIdx] = lines.length
    lines.push(updateCursor ? chalk.bgRgb(30, 30, 60)(updateRow) : updateRow)
    // 📖 Widths Warning toggle row (disable widths warning)
    const disableWidthsWarning = Boolean(state.config.settings?.disableWidthsWarning)
    const widthWarningBullet = state.settingsCursor === widthWarningRowIdx ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const widthWarningStatus = disableWidthsWarning ? chalk.greenBright('DISABLED') : chalk.dim('enabled')
    const widthWarningRow = `${widthWarningBullet}${chalk.bold('Disable Widths Warning').padEnd(44)} ${widthWarningStatus}`
    cursorLineByRow[widthWarningRowIdx] = lines.length
    lines.push(state.settingsCursor === widthWarningRowIdx ? chalk.bgRgb(30, 30, 60)(widthWarningRow) : widthWarningRow)
    if (updateState === 'error' && state.settingsUpdateError) {
      lines.push(chalk.red(`      ${state.settingsUpdateError}`))
    }

    // 📖 FCM Proxy V2 — single row that opens a dedicated overlay
    lines.push('')
    lines.push(`  ${chalk.bold('📡 FCM Proxy V2')}`)
    lines.push(`  ${chalk.dim('  ' + '─'.repeat(separatorWidth))}`)
    lines.push('')

    const proxyDaemonBullet = state.settingsCursor === proxyDaemonRowIdx ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const proxyStatus = proxySettings.enabled ? chalk.greenBright('Proxy ON') : chalk.dim('Proxy OFF')
    const daemonStatus = state.daemonStatus || 'not-installed'
    let daemonBadge
    if (daemonStatus === 'running') daemonBadge = chalk.greenBright('Service ON')
    else if (daemonStatus === 'stopped') daemonBadge = chalk.yellow('Service stopped')
    else if (daemonStatus === 'stale' || daemonStatus === 'unhealthy') daemonBadge = chalk.red('Service ' + daemonStatus)
    else daemonBadge = chalk.dim('Service OFF')
    const proxyDaemonRow = `${proxyDaemonBullet}${chalk.bold('FCM Proxy V2 settings →').padEnd(44)} ${proxyStatus} ${chalk.dim('•')} ${daemonBadge}`
    cursorLineByRow[proxyDaemonRowIdx] = lines.length
    lines.push(state.settingsCursor === proxyDaemonRowIdx ? chalk.bgRgb(20, 45, 60)(proxyDaemonRow) : proxyDaemonRow)

    // 📖 Changelog viewer row
    const changelogViewBullet = state.settingsCursor === changelogViewRowIdx ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const changelogViewRow = `${changelogViewBullet}${chalk.bold('View Changelog').padEnd(44)} ${chalk.dim('Enter browse version history')}`
    cursorLineByRow[changelogViewRowIdx] = lines.length
    lines.push(state.settingsCursor === changelogViewRowIdx ? chalk.bgRgb(30, 45, 30)(changelogViewRow) : changelogViewRow)

    // 📖 Profile system removed - API keys now persist permanently across all sessions

    lines.push('')
    if (state.settingsEditMode) {
      lines.push(chalk.dim('  Type API key  •  Enter Save  •  Esc Cancel'))
    } else if (state.settingsProxyPortEditMode) {
      lines.push(chalk.dim('  Type proxy port (0 = auto)  •  Enter Save  •  Esc Cancel'))
    } else {
      lines.push(chalk.dim('  ↑↓ Navigate  •  Enter Edit/Run  •  + Add key  •  - Remove key  •  Space Toggle  •  T Test key  •  S Sync→OpenCode  •  R Restore backup  •  U Updates  •  Esc Close'))
    }
    // 📖 Show sync/restore status message if set
    if (state.settingsSyncStatus) {
      const { type, msg } = state.settingsSyncStatus
      lines.push(type === 'success' ? chalk.greenBright(`  ${msg}`) : chalk.yellow(`  ${msg}`))
    }
    lines.push('')

    // 📖 Footer with credits
    lines.push('')
    lines.push(
      chalk.dim('  ') +
      chalk.rgb(255, 150, 200)('Made with 💖 & ☕ by ') +
      chalk.cyanBright('\x1b]8;;https://github.com/vava-nessa\x1b\\vava-nessa\x1b]8;;\x1b\\') +
      chalk.dim('  •  ☕ ') +
      chalk.rgb(255, 200, 100)('\x1b]8;;https://buymeacoffee.com/vavanessadev\x1b\\Buy me a coffee\x1b]8;;\x1b\\') +
      chalk.dim('  •  ') +
      'Esc to close'
    )

    // 📖 Keep selected Settings row visible on small terminals by scrolling the overlay viewport.
    const targetLine = cursorLineByRow[state.settingsCursor] ?? 0
    state.settingsScrollOffset = keepOverlayTargetVisible(
      state.settingsScrollOffset,
      targetLine,
      lines.length,
      state.terminalRows
    )
    const { visible, offset } = sliceOverlayLines(lines, state.settingsScrollOffset, state.terminalRows)
    state.settingsScrollOffset = offset

    const tintedLines = tintOverlayLines(visible, SETTINGS_OVERLAY_BG, state.terminalCols)
    const cleared = tintedLines.map(l => l + EL)
    return cleared.join('\n')
  }

  // ─── Install Endpoints overlay renderer ───────────────────────────────────
  // 📖 renderInstallEndpoints drives the provider → tool → connection → scope → model flow
  // 📖 behind the `Y` hotkey. It deliberately reuses the same overlay viewport
  // 📖 helpers as Settings so long provider/model lists stay navigable.
  function renderInstallEndpoints() {
    const EL = '\x1b[K'
    const lines = []
    const cursorLineByRow = {}
    const providerChoices = getConfiguredInstallableProviders(state.config)
    const toolChoices = getInstallTargetModes()
    const connectionChoices = CONNECTION_MODES || []
    const totalSteps = 5
    const scopeChoices = [
      {
        key: 'all',
        label: 'Install all models',
        hint: 'Recommended — FCM will refresh this provider catalog automatically later.',
      },
      {
        key: 'selected',
        label: 'Install selected models only',
        hint: 'Choose a smaller curated subset for a cleaner model picker.',
      },
    ]
    const selectedProviderLabel = state.installEndpointsProviderKey
      ? (sources[state.installEndpointsProviderKey]?.name || state.installEndpointsProviderKey)
      : '—'

    // 📖 Resolve tool label from metadata instead of hard-coded switch
    const selectedToolLabel = state.installEndpointsToolMode
      ? (() => {
          const meta = getToolMeta(state.installEndpointsToolMode)
          const suffix = state.installEndpointsToolMode.startsWith('opencode') ? ' (shared opencode.json)' : ''
          return `${meta.label}${suffix}`
        })()
      : '—'

    const selectedConnectionLabel = state.installEndpointsConnectionMode === 'proxy'
      ? 'FCM Proxy V2'
      : state.installEndpointsConnectionMode === 'direct'
        ? 'Direct Provider'
        : '—'

    lines.push('')
    // 📖 Branding header
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold('🔌 Install Endpoints')}`)
    lines.push('')
    lines.push(chalk.dim('  — install provider catalogs into supported coding tools'))
    if (state.installEndpointsErrorMsg) {
      lines.push(`  ${chalk.yellow(state.installEndpointsErrorMsg)}`)
    }
    lines.push('')

    if (state.installEndpointsPhase === 'providers') {
      lines.push(`  ${chalk.bold(`Step 1/${totalSteps}`)}  ${chalk.cyan('Choose a configured provider')}`)
      lines.push('')

      if (providerChoices.length === 0) {
        lines.push(chalk.dim('  No configured providers can be installed directly right now.'))
        lines.push(chalk.dim('  Add an API key in Settings (`P`) first, then reopen this screen.'))
      } else {
        providerChoices.forEach((provider, idx) => {
          const isCursor = idx === state.installEndpointsCursor
          const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
          const row = `${bullet}${chalk.bold(provider.label.padEnd(24))} ${chalk.dim(`${provider.modelCount} models`)}`
          cursorLineByRow[idx] = lines.length
          lines.push(isCursor ? chalk.bgRgb(24, 44, 62)(row) : row)
        })
      }

      lines.push('')
      lines.push(chalk.dim('  ↑↓ Navigate  •  Enter Choose provider  •  Esc Close'))
    } else if (state.installEndpointsPhase === 'tools') {
      lines.push(`  ${chalk.bold(`Step 2/${totalSteps}`)}  ${chalk.cyan('Choose the target tool')}`)
      lines.push(chalk.dim(`  Provider: ${selectedProviderLabel}`))
      lines.push('')

      // 📖 Use getToolMeta for labels instead of hard-coded ternary chains
      toolChoices.forEach((toolMode, idx) => {
        const isCursor = idx === state.installEndpointsCursor
        const meta = getToolMeta(toolMode)
        const label = `${meta.emoji} ${meta.label}`
        const note = toolMode.startsWith('opencode')
          ? chalk.dim('shared config file')
          : ['claude-code', 'codex', 'openhands'].includes(toolMode)
            ? chalk.dim('env file (~/.fcm-*-env)')
            : chalk.dim('managed config install')
        const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
        const row = `${bullet}${chalk.bold(label.padEnd(26))} ${note}`
        cursorLineByRow[idx] = lines.length
        lines.push(isCursor ? chalk.bgRgb(24, 44, 62)(row) : row)
      })

      lines.push('')
      lines.push(chalk.dim('  ↑↓ Navigate  •  Enter Choose tool  •  Esc Back'))
    } else if (state.installEndpointsPhase === 'connection') {
      // 📖 Step 3: Choose connection mode — Direct Provider vs FCM Proxy
      lines.push(`  ${chalk.bold(`Step 3/${totalSteps}`)}  ${chalk.cyan('Choose connection mode')}`)
      lines.push(chalk.dim(`  Provider: ${selectedProviderLabel}  •  Tool: ${selectedToolLabel}`))
      lines.push('')

      connectionChoices.forEach((mode, idx) => {
        const isCursor = idx === state.installEndpointsCursor
        const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
        const icon = mode.key === 'proxy' ? '🔄' : '⚡'
        const row = `${bullet}${icon} ${chalk.bold(mode.label)}`
        cursorLineByRow[idx] = lines.length
        lines.push(isCursor ? chalk.bgRgb(24, 44, 62)(row) : row)
        lines.push(chalk.dim(`      ${mode.hint}`))
        lines.push('')
      })

      lines.push(chalk.dim('  Enter Continue  •  Esc Back'))
    } else if (state.installEndpointsPhase === 'scope') {
      lines.push(`  ${chalk.bold(`Step 4/${totalSteps}`)}  ${chalk.cyan('Choose the install scope')}`)
      lines.push(chalk.dim(`  Provider: ${selectedProviderLabel}  •  Tool: ${selectedToolLabel}  •  ${selectedConnectionLabel}`))
      lines.push('')

      scopeChoices.forEach((scope, idx) => {
        const isCursor = idx === state.installEndpointsCursor
        const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
        const row = `${bullet}${chalk.bold(scope.label)}`
        cursorLineByRow[idx] = lines.length
        lines.push(isCursor ? chalk.bgRgb(24, 44, 62)(row) : row)
        lines.push(chalk.dim(`      ${scope.hint}`))
        lines.push('')
      })

      lines.push(chalk.dim('  Enter Continue  •  Esc Back'))
    } else if (state.installEndpointsPhase === 'models') {
      const models = getProviderCatalogModels(state.installEndpointsProviderKey)
      const selectedCount = state.installEndpointsSelectedModelIds.size

      lines.push(`  ${chalk.bold(`Step 5/${totalSteps}`)}  ${chalk.cyan('Choose which models to install')}`)
      lines.push(chalk.dim(`  Provider: ${selectedProviderLabel}  •  Tool: ${selectedToolLabel}  •  ${selectedConnectionLabel}`))
      lines.push(chalk.dim(`  Selected: ${selectedCount}/${models.length}`))
      lines.push('')

      models.forEach((model, idx) => {
        const isCursor = idx === state.installEndpointsCursor
        const selected = state.installEndpointsSelectedModelIds.has(model.modelId)
        const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
        const checkbox = selected ? chalk.greenBright('[✓]') : chalk.dim('[ ]')
        const tier = chalk.cyan(model.tier.padEnd(2))
        const row = `${bullet}${checkbox} ${chalk.bold(model.label.padEnd(26))} ${tier} ${chalk.dim(model.ctx.padEnd(6))} ${chalk.dim(model.modelId)}`
        cursorLineByRow[idx] = lines.length
        lines.push(isCursor ? chalk.bgRgb(24, 44, 62)(row) : row)
      })

      lines.push('')
      lines.push(chalk.dim('  ↑↓ Navigate  •  Space Toggle model  •  A All/None  •  Enter Install  •  Esc Back'))
    } else if (state.installEndpointsPhase === 'result') {
      const result = state.installEndpointsResult
      const accent = result?.type === 'success' ? chalk.greenBright : chalk.redBright
      lines.push(`  ${chalk.bold('Result')}  ${accent(result?.title || 'Install result unavailable')}`)
      lines.push('')

      for (const detail of result?.lines || []) {
        lines.push(`  ${detail}`)
      }

      if (result?.type === 'success') {
        lines.push('')
        lines.push(chalk.dim('  Future FCM launches will refresh this catalog automatically when the provider list evolves.'))
      }

      lines.push('')
      lines.push(chalk.dim('  Enter or Esc Close'))
    }

    const targetLine = cursorLineByRow[state.installEndpointsCursor] ?? 0
    state.installEndpointsScrollOffset = keepOverlayTargetVisible(
      state.installEndpointsScrollOffset,
      targetLine,
      lines.length,
      state.terminalRows
    )
    const { visible, offset } = sliceOverlayLines(lines, state.installEndpointsScrollOffset, state.terminalRows)
    state.installEndpointsScrollOffset = offset

    const tintedLines = tintOverlayLines(visible, SETTINGS_OVERLAY_BG, state.terminalCols)
    const cleared = tintedLines.map((line) => line + EL)
    return cleared.join('\n')
  }

  // ─── Help overlay renderer ────────────────────────────────────────────────
  // 📖 renderHelp: Draw the help overlay listing all key bindings.
  // 📖 Toggled with K key. Gives users a quick reference without leaving the TUI.
  function renderHelp() {
    const EL = '\x1b[K'
    const lines = []

    // 📖 Branding header
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold('❓ Help & Keyboard Shortcuts')}`)
    lines.push('')
    lines.push(`  ${chalk.dim('— ↑↓ / PgUp / PgDn / Home / End scroll • K or Esc close')}`)
    lines.push(`  ${chalk.bold('Columns')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Rank')}        SWE-bench rank (1 = best coding score)  ${chalk.dim('Sort:')} ${chalk.yellow('R')}`)
    lines.push(`              ${chalk.dim('Quick glance at which model is objectively the best coder right now.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Tier')}        S+ / S / A+ / A / A- / B+ / B / C based on SWE-bench score  ${chalk.dim('Cycle:')} ${chalk.yellow('T')}`)
    lines.push(`              ${chalk.dim('Skip the noise — S/S+ models solve real GitHub issues, C models are for light tasks.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('SWE%')}        SWE-bench score — coding ability benchmark (color-coded)  ${chalk.dim('Sort:')} ${chalk.yellow('S')}`)
    lines.push(`              ${chalk.dim('The raw number behind the tier. Higher = better at writing, fixing, and refactoring code.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('CTX')}         Context window size (128k, 200k, 256k, 1m, etc.)  ${chalk.dim('Sort:')} ${chalk.yellow('C')}`)
    lines.push(`              ${chalk.dim('Bigger context = the model can read more of your codebase at once without forgetting.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Model')}       Model name (⭐ = favorited, pinned at top)  ${chalk.dim('Sort:')} ${chalk.yellow('M')}  ${chalk.dim('Favorite:')} ${chalk.yellow('F')}`)
    lines.push(`              ${chalk.dim('Star the ones you like — they stay pinned at the top across restarts.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Provider')}    Provider source (NIM, Groq, Cerebras, etc.)  ${chalk.dim('Sort:')} ${chalk.yellow('O')}  ${chalk.dim('Cycle:')} ${chalk.yellow('D')}`)
    lines.push(`              ${chalk.dim('Same model on different providers can have very different speed and uptime.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Latest')}      Most recent ping response time (ms)  ${chalk.dim('Sort:')} ${chalk.yellow('L')}`)
    lines.push(`              ${chalk.dim('Shows how fast the server is responding right now — useful to catch live slowdowns.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Avg Ping')}    Average response time across all measurable pings (200 + 401) (ms)  ${chalk.dim('Sort:')} ${chalk.yellow('A')}`)
    lines.push(`              ${chalk.dim('The long-term truth. Even without a key, a 401 still gives real latency so the average stays useful.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Health')}      Live status: ✅ UP / 🔥 429 / ⏳ TIMEOUT / ❌ ERR / 🔑 NO KEY  ${chalk.dim('Sort:')} ${chalk.yellow('H')}`)
    lines.push(`              ${chalk.dim('Tells you instantly if a model is reachable or down — no guesswork needed.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Verdict')}     Overall assessment: Perfect / Normal / Spiky / Slow / Overloaded  ${chalk.dim('Sort:')} ${chalk.yellow('V')}`)
    lines.push(`              ${chalk.dim('One-word summary so you don\'t have to cross-check speed, health, and stability yourself.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Stability')}   Composite 0–100 score: p95 + jitter + spike rate + uptime  ${chalk.dim('Sort:')} ${chalk.yellow('B')}`)
    lines.push(`              ${chalk.dim('A fast model that randomly freezes is worse than a steady one. This catches that.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Up%')}         Uptime — ratio of successful pings to total pings  ${chalk.dim('Sort:')} ${chalk.yellow('U')}`)
    lines.push(`              ${chalk.dim('If a model only works half the time, you\'ll waste time retrying. Higher = more reliable.')}`)
    lines.push('')
    lines.push(`  ${chalk.cyan('Used')}        Total prompt+completion tokens consumed in logs for this exact provider/model pair`)
    lines.push(`              ${chalk.dim('Loaded once at startup from request-log.jsonl. Displayed in K tokens, or M tokens above one million.')}`)
    lines.push('')


    lines.push('')
    lines.push(`  ${chalk.bold('Main TUI')}`)
    lines.push(`  ${chalk.bold('Navigation')}`)
    lines.push(`  ${chalk.yellow('↑↓')}           Navigate rows`)
    lines.push(`  ${chalk.yellow('Enter')}        Select model and launch`)
    lines.push('')
    lines.push(`  ${chalk.bold('Controls')}`)
    lines.push(`  ${chalk.yellow('W')}  Toggle ping mode  ${chalk.dim('(speed 2s → normal 10s → slow 30s → forced 4s)')}`)
    lines.push(`  ${chalk.yellow('E')}  Toggle configured models only  ${chalk.dim('(enabled by default)')}`)
    lines.push(`  ${chalk.yellow('X')}  Toggle token log page  ${chalk.dim('(shows recent request usage from request-log.jsonl)')}`)
    lines.push(`  ${chalk.yellow('Z')}  Cycle tool mode  ${chalk.dim('(OpenCode → Desktop → OpenClaw → Crush → Goose → Pi → Aider → Claude Code → Codex → Gemini → Qwen → OpenHands → Amp)')}`)
    lines.push(`  ${chalk.yellow('F')}  Toggle favorite on selected row  ${chalk.dim('(⭐ pinned at top, persisted)')}`)
    lines.push(`  ${chalk.yellow('Y')}  Install endpoints  ${chalk.dim('(provider catalog → compatible tools, Direct or FCM Proxy V2)')}`)
    lines.push(`  ${chalk.yellow('Q')}  Smart Recommend  ${chalk.dim('(🎯 find the best model for your task — questionnaire + live analysis)')}`)
    lines.push(`  ${chalk.rgb(255, 87, 51).bold('I')}  Feedback, bugs & requests  ${chalk.dim('(📝 send anonymous feedback, bug reports, or feature requests)')}`)
    lines.push(`  ${chalk.yellow('J')}  FCM Proxy V2 settings  ${chalk.dim('(📡 open proxy configuration and background service management)')}`)
    lines.push(`  ${chalk.yellow('P')}  Open settings  ${chalk.dim('(manage API keys, provider toggles, proxy, manual update)')}`)
      // 📖 Profile system removed - API keys now persist permanently across all sessions
    lines.push(`  ${chalk.yellow('Shift+R')}  Reset view settings  ${chalk.dim('(tier filter, sort, provider filter → defaults)')}`)
    lines.push(`  ${chalk.yellow('N')}  Changelog  ${chalk.dim('(📋 browse all versions, Enter to view details)')}`)
    lines.push(`  ${chalk.yellow('K')} / ${chalk.yellow('Esc')}  Show/hide this help`)
    lines.push(`  ${chalk.yellow('Ctrl+C')}  Exit`)
    lines.push('')
    lines.push(`  ${chalk.bold('Settings (P)')}`)
    lines.push(`  ${chalk.yellow('↑↓')}           Navigate rows`)
    lines.push(`  ${chalk.yellow('PgUp/PgDn')}    Jump by page`)
    lines.push(`  ${chalk.yellow('Home/End')}     Jump first/last row`)
    lines.push(`  ${chalk.yellow('Enter')}        Edit key / check-install update`)
    lines.push(`  ${chalk.yellow('Space')}        Toggle provider enable/disable`)
    lines.push(`  ${chalk.yellow('T')}            Test selected provider key`)
    lines.push(`  ${chalk.yellow('U')}            Check updates manually`)
    lines.push(`  ${chalk.yellow('Esc')}          Close settings`)
    lines.push('')
    lines.push(...buildCliHelpLines({ chalk, indent: '  ', title: 'CLI Flags' }))
    lines.push('')
    // 📖 Help overlay can be longer than viewport, so keep a dedicated scroll offset.
    const { visible, offset } = sliceOverlayLines(lines, state.helpScrollOffset, state.terminalRows)
    state.helpScrollOffset = offset
    const tintedLines = tintOverlayLines(visible, HELP_OVERLAY_BG, state.terminalCols)
    const cleared = tintedLines.map(l => l + EL)
    return cleared.join('\n')
  }

  // ─── Log page overlay renderer ────────────────────────────────────────────
  // 📖 renderLog: Draw the log page overlay showing recent requests from
  // 📖 ~/.free-coding-models/request-log.jsonl, newest-first.
  // 📖 Toggled with X key. Esc or X closes.
  function renderLog() {
    const EL = '\x1b[K'
    const lines = []

    // 📖 Branding header
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold('📋 Request Log')}`)
    lines.push('')
    lines.push(chalk.dim('  — recent requests • ↑↓ scroll • A toggle all/500 • X or Esc close'))
    lines.push(chalk.dim('  Works only when the multi-account proxy is enabled and requests go through it.'))
    lines.push(chalk.dim('  Direct provider launches do not currently write into this log.'))

    // 📖 Load recent log entries — bounded read, newest-first, malformed lines skipped.
    // 📖 Show up to 500 entries by default, or all if logShowAll is true.
    const logLimit = state.logShowAll ? Number.MAX_SAFE_INTEGER : 500
    const logRows = loadRecentLogs({ limit: logLimit })
    const totalTokens = logRows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0)

    if (logRows.length === 0) {
      lines.push(chalk.dim('  No log entries found.'))
      lines.push(chalk.dim('  Logs are written to ~/.free-coding-models/request-log.jsonl'))
      lines.push(chalk.dim('  when requests are proxied through the multi-account rotation proxy.'))
      lines.push(chalk.dim('  Direct provider launches do not currently feed this token log.'))
    } else {
      lines.push(`  ${chalk.bold('Total Consumed:')} ${chalk.greenBright(formatLogTokens(totalTokens))}`)
      lines.push('')
      // 📖 Column widths for the log table
      const W_TIME    = 19
      const W_PROV    = 14
      const W_MODEL   = 44
      const W_ROUTE   = 18
      const W_STATUS  = 8
      const W_TOKENS  = 12
      const W_LAT     = 10

      // 📖 Header row
      const hTime   = chalk.dim('Time'.padEnd(W_TIME))
      const hProv   = chalk.dim('Provider'.padEnd(W_PROV))
      const hModel  = chalk.dim('Model'.padEnd(W_MODEL))
      const hRoute  = chalk.dim('Route'.padEnd(W_ROUTE))
      const hStatus = chalk.dim('Status'.padEnd(W_STATUS))
      const hTok    = chalk.dim('Tokens Used'.padEnd(W_TOKENS))
      const hLat    = chalk.dim('Latency'.padEnd(W_LAT))

      // 📖 Show mode indicator (all vs limited)
      const modeBadge = state.logShowAll
        ? chalk.yellow.bold('ALL')
        : chalk.cyan.bold('500')
      const countBadge = chalk.dim(`Showing ${logRows.length} entries`)

      lines.push(`  ${hTime}  ${hProv}  ${hModel}  ${hRoute}  ${hStatus}  ${hTok}  ${hLat}`)
      lines.push(`  ${chalk.dim('─'.repeat(W_TIME + W_PROV + W_MODEL + W_ROUTE + W_STATUS + W_TOKENS + W_LAT + 12))}  ${modeBadge}  ${countBadge}`)

      for (const row of logRows) {
        // 📖 Format time as HH:MM:SS (strip the date part for compactness)
        let timeStr = row.time
        try {
          const d = new Date(row.time)
          if (!Number.isNaN(d.getTime())) {
            timeStr = d.toISOString().replace('T', ' ').slice(0, 19)
          }
        } catch { /* keep raw */ }

        const requestedModelLabel = row.requestedModel || ''
        // 📖 Always show "requested → actual" if they differ, not just when switched
        const displayModel = requestedModelLabel && requestedModelLabel !== row.model
          ? `${requestedModelLabel} → ${row.model}`
          : row.model

        // 📖 Color-code status with distinct colors for each error type
        let statusCell
        const sc = String(row.status)
        if (sc === '200') {
          statusCell = chalk.greenBright(sc.padEnd(W_STATUS))
        } else if (sc === '404') {
          statusCell = chalk.rgb(139, 0, 0).bold(sc.padEnd(W_STATUS))  // Dark red for 404
        } else if (sc === '400') {
          statusCell = chalk.hex('#8B008B').bold(sc.padEnd(W_STATUS))  // Dark magenta
        } else if (sc === '401') {
          statusCell = chalk.hex('#9932CC').bold(sc.padEnd(W_STATUS))  // Dark orchid
        } else if (sc === '403') {
          statusCell = chalk.hex('#BA55D3').bold(sc.padEnd(W_STATUS))  // Medium orchid
        } else if (sc === '413') {
          statusCell = chalk.hex('#FF6347').bold(sc.padEnd(W_STATUS))  // Tomato red
        } else if (sc === '429') {
          statusCell = chalk.hex('#FFB90F').bold(sc.padEnd(W_STATUS))  // Dark orange
        } else if (sc === '500') {
          statusCell = chalk.hex('#DC143C').bold(sc.padEnd(W_STATUS))  // Crimson
        } else if (sc === '502') {
          statusCell = chalk.hex('#C71585').bold(sc.padEnd(W_STATUS))  // Medium violet red
        } else if (sc === '503') {
          statusCell = chalk.hex('#9370DB').bold(sc.padEnd(W_STATUS))  // Medium purple
        } else if (sc.startsWith('5')) {
          statusCell = chalk.magenta(sc.padEnd(W_STATUS))  // Other 5xx - magenta
        } else if (sc === '0') {
          statusCell = chalk.hex('#696969')(sc.padEnd(W_STATUS))  // Dim gray for timeout
        } else {
          statusCell = chalk.dim(sc.padEnd(W_STATUS))
        }

        const tokStr = formatLogTokens(row.tokens)
        const latStr = row.latency > 0 ? `${row.latency}ms` : '--'
        const routeLabel = row.switched
          ? `SWITCHED ↻ ${row.switchReason || 'fallback'}`
          : 'direct'

        // 📖 Detect failed requests with zero tokens - these get special red highlighting
        const isFailedWithZeroTokens = row.status !== '200' && (!row.tokens || Number(row.tokens) === 0)

        const timeCell  = chalk.dim(timeStr.slice(0, W_TIME).padEnd(W_TIME))
        // 📖 Provider display: Use pretty label if available, otherwise raw key.
        // 📖 All these logs are from FCM Proxy V2.
        const providerLabel = PROVIDER_METADATA[row.provider]?.label || row.provider
        const providerRgb = PROVIDER_COLOR[row.provider] ?? [105, 190, 245]
        const provCell  = chalk.bold.rgb(...providerRgb)(providerLabel.slice(0, W_PROV).padEnd(W_PROV))

        // 📖 Color model based on status - red for failed requests with zero tokens
        let modelCell
        if (isFailedWithZeroTokens) {
          modelCell = chalk.red.bold(displayModel.slice(0, W_MODEL).padEnd(W_MODEL))
        } else {
          const modelColorFn = getModelColorByStatus(row.status)
          modelCell = row.switched
            ? chalk.bold.rgb(255, 210, 90)(displayModel.slice(0, W_MODEL).padEnd(W_MODEL))
            : modelColorFn(displayModel.slice(0, W_MODEL).padEnd(W_MODEL))
        }

        const routeCell = row.switched
          ? chalk.bgRgb(120, 25, 25).yellow.bold(` ${routeLabel.slice(0, W_ROUTE - 2).padEnd(W_ROUTE - 2)} `)
          : chalk.dim(routeLabel.padEnd(W_ROUTE))

        // 📖 Colorize tokens - red cross emoji for failed requests with zero tokens
        let tokCell
        if (isFailedWithZeroTokens) {
          tokCell = chalk.red.bold('✗'.padEnd(W_TOKENS))
        } else {
          tokCell = colorizeTokens(row.tokens, tokStr.padEnd(W_TOKENS))
        }

        // 📖 Colorize latency with gradient (green → orange → yellow → red)
        const latCell = colorizeLatency(row.latency, latStr.padEnd(W_LAT))

        // 📖 Build the row line - add dark red background for failed requests with zero tokens
        const rowText = `  ${timeCell}  ${provCell}  ${modelCell}  ${routeCell}  ${statusCell}  ${tokCell}  ${latCell}`
        if (isFailedWithZeroTokens) {
          lines.push(chalk.bgRgb(40, 0, 0)(rowText))
        } else {
          lines.push(rowText)
        }
      }
    }

    lines.push('')
    lines.push(chalk.dim(`  Showing up to 200 most recent entries  •  X or Esc close`))
    lines.push('')

    const { visible, offset } = sliceOverlayLines(lines, state.logScrollOffset, state.terminalRows)
    state.logScrollOffset = offset
    const tintedLines = tintOverlayLines(visible, LOG_OVERLAY_BG, state.terminalCols)
    const cleared = tintedLines.map(l => l + EL)
    return cleared.join('\n')
  }

  // 📖 renderRecommend: Draw the Smart Recommend overlay with 3 phases:
  //   1. 'questionnaire' — ask 3 questions (task type, priority, context budget)
  //   2. 'analyzing' — loading screen with progress bar (10s, 2 pings/sec)
  //   3. 'results' — show Top 3 recommendations with scores
  function renderRecommend() {
    const EL = '\x1b[K'
    const lines = []

    // 📖 Branding header
    lines.push('')
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold('🎯 Smart Recommend')}`)
    lines.push('')
    lines.push(chalk.dim('  — find the best model for your task'))
    lines.push('')

    if (state.recommendPhase === 'questionnaire') {
      // 📖 Question definitions — each has a title, options array, and answer key
      const questions = [
        {
          title: 'What are you working on?',
          options: Object.entries(TASK_TYPES).map(([key, val]) => ({ key, label: val.label })),
          answerKey: 'taskType',
        },
        {
          title: 'What matters most?',
          options: Object.entries(PRIORITY_TYPES).map(([key, val]) => ({ key, label: val.label })),
          answerKey: 'priority',
        },
        {
          title: 'How big is your context?',
          options: Object.entries(CONTEXT_BUDGETS).map(([key, val]) => ({ key, label: val.label })),
          answerKey: 'contextBudget',
        },
      ]

      const q = questions[state.recommendQuestion]
      const qNum = state.recommendQuestion + 1
      const qTotal = questions.length

      // 📖 Progress breadcrumbs showing answered questions
      let breadcrumbs = ''
      for (let i = 0; i < questions.length; i++) {
        const answered = state.recommendAnswers[questions[i].answerKey]
        if (i < state.recommendQuestion && answered) {
          const answeredLabel = questions[i].options.find(o => o.key === answered)?.label || answered
          breadcrumbs += chalk.greenBright(`  ✓ ${questions[i].title} ${chalk.bold(answeredLabel)}`) + '\n'
        }
      }
      if (breadcrumbs) {
        lines.push(breadcrumbs.trimEnd())
        lines.push('')
      }

      lines.push(`  ${chalk.bold(`Question ${qNum}/${qTotal}:`)} ${chalk.cyan(q.title)}`)
      lines.push('')

      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i]
        const isCursor = i === state.recommendCursor
        const bullet = isCursor ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
        const label = isCursor ? chalk.bold.white(opt.label) : chalk.white(opt.label)
        lines.push(`${bullet}${label}`)
      }

      lines.push('')
      lines.push(chalk.dim('  ↑↓ navigate  •  Enter select  •  Esc cancel'))

    } else if (state.recommendPhase === 'analyzing') {
      // 📖 Loading screen with progress bar
      const pct = Math.min(100, Math.round(state.recommendProgress))
      const barWidth = 40
      const filled = Math.round(barWidth * pct / 100)
      const empty = barWidth - filled
      const bar = chalk.greenBright('█'.repeat(filled)) + chalk.dim('░'.repeat(empty))

      lines.push(`  ${chalk.bold('Analyzing models...')}`)
      lines.push('')
      lines.push(`  ${bar}  ${chalk.bold(String(pct) + '%')}`)
      lines.push('')

      // 📖 Show what we're doing
      const taskLabel = TASK_TYPES[state.recommendAnswers.taskType]?.label || '—'
      const prioLabel = PRIORITY_TYPES[state.recommendAnswers.priority]?.label || '—'
      const ctxLabel = CONTEXT_BUDGETS[state.recommendAnswers.contextBudget]?.label || '—'
      lines.push(chalk.dim(`  Task: ${taskLabel}  •  Priority: ${prioLabel}  •  Context: ${ctxLabel}`))
      lines.push('')

      // 📖 Spinning indicator
      const spinIdx = state.frame % FRAMES.length
      lines.push(`  ${chalk.yellow(FRAMES[spinIdx])} Pinging models at 2 pings/sec to gather fresh latency data...`)
      lines.push('')
      lines.push(chalk.dim('  Esc to cancel'))

    } else if (state.recommendPhase === 'results') {
      // 📖 Show Top 3 results with detailed info
      const taskLabel = TASK_TYPES[state.recommendAnswers.taskType]?.label || '—'
      const prioLabel = PRIORITY_TYPES[state.recommendAnswers.priority]?.label || '—'
      const ctxLabel = CONTEXT_BUDGETS[state.recommendAnswers.contextBudget]?.label || '—'
      lines.push(chalk.dim(`  Task: ${taskLabel}  •  Priority: ${prioLabel}  •  Context: ${ctxLabel}`))
      lines.push('')

      if (state.recommendResults.length === 0) {
        lines.push(`  ${chalk.yellow('No models could be scored. Try different criteria or wait for more pings.')}`)
      } else {
        lines.push(`  ${chalk.bold('Top Recommendations:')}`)
        lines.push('')

        for (let i = 0; i < state.recommendResults.length; i++) {
          const rec = state.recommendResults[i]
          const r = rec.result
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'
          const providerName = sources[r.providerKey]?.name ?? r.providerKey
          const tierFn = TIER_COLOR[r.tier] ?? (t => chalk.white(t))
          const avg = getAvg(r)
          const avgStr = avg === Infinity ? '—' : Math.round(avg) + 'ms'
          const sweStr = r.sweScore ?? '—'
          const ctxStr = r.ctx ?? '—'
          const stability = getStabilityScore(r)
          const stabStr = stability === -1 ? '—' : String(stability)

          const isCursor = i === state.recommendCursor
          const highlight = isCursor ? chalk.bgRgb(20, 50, 25) : (s => s)

          lines.push(highlight(`  ${medal} ${chalk.bold('#' + (i + 1))}  ${chalk.bold.white(r.label)}  ${chalk.dim('(' + providerName + ')')}`))
          lines.push(highlight(`       Score: ${chalk.bold.greenBright(String(rec.score) + '/100')}  │  Tier: ${tierFn(r.tier)}  │  SWE: ${chalk.cyan(sweStr)}  │  Avg: ${chalk.yellow(avgStr)}  │  CTX: ${chalk.cyan(ctxStr)}  │  Stability: ${chalk.cyan(stabStr)}`))
          lines.push('')
        }
      }

      lines.push('')
      lines.push(`  ${chalk.dim('These models are now')} ${chalk.greenBright('highlighted')} ${chalk.dim('and')} 🎯 ${chalk.dim('pinned in the main table.')}`)
      lines.push('')
      lines.push(chalk.dim('  ↑↓ navigate  •  Enter select & close  •  Esc close  •  Q new search'))
    }

    lines.push('')
    const { visible, offset } = sliceOverlayLines(lines, state.recommendScrollOffset, state.terminalRows)
    state.recommendScrollOffset = offset
    const tintedLines = tintOverlayLines(visible, RECOMMEND_OVERLAY_BG, state.terminalCols)
    const cleared2 = tintedLines.map(l => l + EL)
    return cleared2.join('\n')
  }

  // ─── Smart Recommend: analysis phase controller ────────────────────────────
  // 📖 startRecommendAnalysis: begins the 10-second analysis phase.
  // 📖 Pings a random subset of visible models at 2 pings/sec while advancing progress.
  // 📖 After 10 seconds, computes recommendations and transitions to results phase.
  function startRecommendAnalysis() {
    state.recommendPhase = 'analyzing'
    state.recommendProgress = 0
    state.recommendResults = []

    const pingModel = getPingModel?.()
    if (!pingModel) return

    const startTime = Date.now()
    const ANALYSIS_DURATION = 10_000 // 📖 10 seconds
    const PING_RATE = 500            // 📖 2 pings per second (every 500ms)

    // 📖 Progress updater — runs every 200ms to update the progress bar
    state.recommendAnalysisTimer = setInterval(() => {
      const elapsed = Date.now() - startTime
      state.recommendProgress = Math.min(100, (elapsed / ANALYSIS_DURATION) * 100)

      if (elapsed >= ANALYSIS_DURATION) {
        // 📖 Analysis complete — compute recommendations
        clearInterval(state.recommendAnalysisTimer)
        clearInterval(state.recommendPingTimer)
        state.recommendAnalysisTimer = null
        state.recommendPingTimer = null

        const recs = getTopRecommendations(
          state.results,
          state.recommendAnswers.taskType,
          state.recommendAnswers.priority,
          state.recommendAnswers.contextBudget,
          3
        )
        state.recommendResults = recs
        state.recommendPhase = 'results'
        state.recommendCursor = 0

        // 📖 Mark recommended models so the main table can highlight them
        state.recommendedKeys = new Set(recs.map(rec => toFavoriteKey(rec.result.providerKey, rec.result.modelId)))
        // 📖 Tag each result object so sortResultsWithPinnedFavorites can pin them
        state.results.forEach(r => {
          const key = toFavoriteKey(r.providerKey, r.modelId)
          const rec = recs.find(rec => toFavoriteKey(rec.result.providerKey, rec.result.modelId) === key)
          r.isRecommended = !!rec
          r.recommendScore = rec ? rec.score : 0
        })
      }
    }, 200)

    // 📖 Targeted pinging — ping random visible models at 2/sec for fresh data
    state.recommendPingTimer = setInterval(() => {
      const visible = state.results.filter(r => !r.hidden && r.status !== 'noauth')
      if (visible.length === 0) return
      // 📖 Pick a random model to ping — spreads load across all models over 10s
      const target = visible[Math.floor(Math.random() * visible.length)]
      pingModel(target).catch(() => {})
    }, PING_RATE)
  }

  // ─── Feedback overlay renderer ────────────────────────────────────────────
  // 📖 renderFeedback: Draw the overlay for anonymous Discord feedback.
  // 📖 Shows an input field where users can type feedback, bug reports, or any comments.
  function renderFeedback() {
    const EL = '\x1b[K'
    const lines = []

    // 📖 Calculate available space for multi-line input (dynamic based on terminal width)
    const maxInputWidth = state.terminalCols - 8 // 8 = padding (4 spaces each side)
    const maxInputLines = 10 // Show up to 10 lines of input
    
    // 📖 Split buffer into lines for display (with wrapping)
    const wrapText = (text, width) => {
      const words = text.split(' ')
      const lines = []
      let currentLine = ''
      
      for (const word of words) {
        const testLine = currentLine ? currentLine + ' ' + word : word
        if (testLine.length <= width) {
          currentLine = testLine
        } else {
          if (currentLine) lines.push(currentLine)
          currentLine = word
        }
      }
      if (currentLine) lines.push(currentLine)
      return lines
    }

    const inputLines = wrapText(state.bugReportBuffer, maxInputWidth)
    const displayLines = inputLines.slice(0, maxInputLines)

    // 📖 Branding header
    lines.push('')
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold.rgb(57, 255, 20)('📝 Feedback, bugs & requests')}`)
    lines.push('')
    lines.push(chalk.dim("  — don't hesitate to send us feedback, bug reports, or just your feeling about the app"))
    lines.push('')
    
    // 📖 Status messages (if any)
    if (state.bugReportStatus === 'sending') {
      lines.push(`  ${chalk.yellow('⏳ Sending...')}`)
      lines.push('')
    } else if (state.bugReportStatus === 'success') {
      lines.push(`  ${chalk.greenBright.bold('✅ Successfully sent!')} ${chalk.dim('Closing overlay in 3 seconds...')}`)
      lines.push('')
      lines.push(`  ${chalk.dim('Thank you for your feedback! It has been sent to the project team.')}`)
      lines.push('')
    } else if (state.bugReportStatus === 'error') {
      lines.push(`  ${chalk.red('❌ Error:')} ${chalk.yellow(state.bugReportError || 'Failed to send')}`)
      lines.push(`  ${chalk.dim('Press Backspace to edit, or Esc to close')}`)
      lines.push('')
    } else {
      lines.push(`  ${chalk.dim('Type your feedback below. Press Enter to send, Esc to cancel.')}`)
      lines.push(`  ${chalk.dim('Your message will be sent anonymously to the project team.')}`)
      lines.push('')
    }

    // 📖 Simple input area – left-aligned, framed by horizontal lines
    lines.push(`  ${chalk.cyan('Message')} (${state.bugReportBuffer.length}/500 chars)`)
    lines.push(`  ${chalk.dim('─'.repeat(maxInputWidth))}`)
    // 📖 Input lines — left-aligned, or placeholder when empty
    if (displayLines.length > 0) {
      for (const line of displayLines) {
        lines.push(`    ${line}`)
      }
      // 📖 Show cursor on last line
      if (state.bugReportStatus === 'idle' || state.bugReportStatus === 'error') {
        lines[lines.length - 1] += chalk.cyanBright('▏')
      }
    } else {
      const placeholderBR = state.bugReportStatus === 'idle' ? chalk.white.italic('Type your message here...') : ''
      lines.push(`    ${placeholderBR}${chalk.cyanBright('▏')}`)
    }
    lines.push(`  ${chalk.dim('─'.repeat(maxInputWidth))}`)
    lines.push('')
    lines.push(chalk.dim('  Enter Send  •  Esc Cancel  •  Backspace Delete'))

    // 📖 Apply overlay tint and return
    const BUG_REPORT_OVERLAY_BG = chalk.bgRgb(0, 0, 0) // Dark red-ish background (RGB: 46, 20, 20)
    const tintedLines = tintOverlayLines(lines, BUG_REPORT_OVERLAY_BG, state.terminalCols)
    const cleared = tintedLines.map(l => l + EL)
    return cleared.join('\n')
  }

  // ─── Changelog overlay renderer ───────────────────────────────────────────
  // 📖 renderChangelog: Two-phase overlay — index of all versions or details of one version
  function renderChangelog() {
    const EL = '\x1b[K'
    const lines = []
    const changelogData = loadChangelog()
    const { versions } = changelogData
    const versionList = Object.keys(versions).sort((a, b) => {
      const aParts = a.split('.').map(Number)
      const bParts = b.split('.').map(Number)
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0
        const bVal = bParts[i] || 0
        if (bVal !== aVal) return bVal - aVal
      }
      return 0
    })

    // 📖 Branding header
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)

    if (state.changelogPhase === 'index') {
      // ═══════════════════════════════════════════════════════════════════════
      // 📖 INDEX PHASE: Show all versions with selection
      // ═══════════════════════════════════════════════════════════════════════
      lines.push(`  ${chalk.bold('📋 Changelog - All Versions')}`)
      lines.push(`  ${chalk.dim('— ↑↓ navigate • Enter select • Esc close')}`)
      lines.push('')

      for (let i = 0; i < versionList.length; i++) {
        const version = versionList[i]
        const changes = versions[version]
        const isSelected = i === state.changelogCursor

        // 📖 Count items in this version
        let itemCount = 0
        for (const key of ['added', 'fixed', 'changed', 'updated']) {
          if (changes[key]) itemCount += changes[key].length
        }

        // 📖 Build a short summary from the first few items (max ~15 words, stripped of markdown)
        const allItems = []
        for (const k of ['added', 'fixed', 'changed', 'updated']) {
          if (changes[k]) for (const item of changes[k]) allItems.push(item)
        }
        let summary = ''
        if (allItems.length > 0) {
          // 📖 Extract the bold title part if present, otherwise use the raw text
          const firstItem = allItems[0]
          const boldMatch = firstItem.match(/\*\*([^*]+)\*\*/)
          const rawText = boldMatch ? boldMatch[1] : firstItem.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
          // 📖 Truncate to ~15 words max
          const words = rawText.split(/\s+/).slice(0, 15)
          summary = words.join(' ')
          if (rawText.split(/\s+/).length > 15) summary += '…'
        }

        // 📖 Format version line with selection highlight + dim summary
        const countStr = `${itemCount} ${itemCount === 1 ? 'change' : 'changes'}`
        const prefix = `  v${version.padEnd(8)} — ${countStr}`
        if (isSelected) {
          const full = summary ? `${prefix} · ${summary}` : prefix
          lines.push(chalk.inverse(full))
        } else {
          const dimSummary = summary ? chalk.dim(` · ${summary}`) : ''
          lines.push(`${prefix}${dimSummary}`)
        }
      }

      lines.push('')
      lines.push(`  ${chalk.dim(`Total: ${versionList.length} versions`)}`)

    } else if (state.changelogPhase === 'details') {
      // ═══════════════════════════════════════════════════════════════════════
      // 📖 DETAILS PHASE: Show detailed changes for selected version
      // ═══════════════════════════════════════════════════════════════════════
      lines.push(`  ${chalk.bold(`📋 v${state.changelogSelectedVersion}`)}`)
      lines.push(`  ${chalk.dim('— ↑↓ / PgUp / PgDn scroll • B back • Esc close')}`)
      lines.push('')

      const changes = versions[state.changelogSelectedVersion]
      if (changes) {
        const sections = { added: '✨ Added', fixed: '🐛 Fixed', changed: '🔄 Changed', updated: '📝 Updated' }
        for (const [key, label] of Object.entries(sections)) {
          if (changes[key] && changes[key].length > 0) {
            lines.push(`  ${chalk.yellow(label)}`)
            for (const item of changes[key]) {
              // 📖 Unwrap markdown bold/code markers for display
              let displayText = item.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
              // 📖 Wrap long lines
              const maxWidth = state.terminalCols - 16
              if (displayText.length > maxWidth) {
                displayText = displayText.substring(0, maxWidth - 3) + '…'
              }
              lines.push(`    • ${displayText}`)
            }
            lines.push('')
          }
        }
      }
    }

    // 📖 Keep selected changelog row visible by scrolling the overlay viewport (index phase)
    if (state.changelogPhase === 'index') {
      const targetLine = 4 + state.changelogCursor  // 📖 3 header lines + 1 blank = versions start at line 4
      state.changelogScrollOffset = keepOverlayTargetVisible(
        state.changelogScrollOffset,
        targetLine,
        lines.length,
        state.terminalRows
      )
    }

    // 📖 Use scrolling with overlay handler
    const CHANGELOG_OVERLAY_BG = chalk.bgRgb(10, 40, 80)  // Dark blue background
    const { visible, offset } = sliceOverlayLines(lines, state.changelogScrollOffset, state.terminalRows)
    state.changelogScrollOffset = offset
    const tintedLines = tintOverlayLines(visible, CHANGELOG_OVERLAY_BG, state.terminalCols)
    const cleared = tintedLines.map(l => l + EL)
    return cleared.join('\n')
  }

  // ─── FCM Proxy V2 overlay renderer ──────────────────────────────────────────
  // 📖 renderProxyDaemon: Dedicated full-page overlay for FCM Proxy V2 configuration
  // 📖 and background service management. Opened from Settings → "FCM Proxy V2 settings →".
  // 📖 Contains all proxy toggles, service status/actions, explanations, and emergency kill.
  function renderProxyDaemon() {
    const EL = '\x1b[K'
    const lines = []
    const cursorLineByRow = {}
    const proxySettings = getProxySettings(state.config)

    // 📖 Row indices — these control cursor navigation
    const ROW_PROXY_ENABLED = 0
    const ROW_PROXY_SYNC = 1
    const ROW_PROXY_PORT = 2
    const ROW_PROXY_CLEANUP = 3
    const ROW_DAEMON_INSTALL = 4
    const ROW_DAEMON_RESTART = 5
    const ROW_DAEMON_STOP = 6
    const ROW_DAEMON_KILL = 7
    const ROW_DAEMON_LOGS = 8

    const daemonStatus = state.daemonStatus || 'not-installed'
    const daemonInfo = state.daemonInfo
    const daemonIsActive = daemonStatus === 'running' || daemonStatus === 'unhealthy' || daemonStatus === 'stale'
    const daemonIsInstalled = daemonIsActive || daemonStatus === 'stopped'

    // 📖 Compute max row — hide daemon action rows when daemon not installed
    let maxRow = ROW_DAEMON_INSTALL
    if (daemonIsInstalled) maxRow = ROW_DAEMON_LOGS

    // 📖 Header
    lines.push(`  ${chalk.cyanBright('🚀')} ${chalk.bold.cyanBright('free-coding-models')} ${chalk.dim(`v${LOCAL_VERSION}`)}`)
    lines.push(`  ${chalk.bold('📡 FCM Proxy V2 Manager')}`)
    lines.push(`  ${chalk.dim('— Esc back to Settings • ↑↓ navigate • Enter select')}`)
    lines.push('')
    lines.push(`  ${chalk.bgRed.white.bold(' ⚠ EXPERIMENTAL ')} ${chalk.red('This feature is under active development and may not work as expected.')}`)
    lines.push(`  ${chalk.red('Found a bug? Press')} ${chalk.bold.white('I')} ${chalk.red('on the main screen or join our Discord to report issues & suggest improvements.')}`)
    lines.push('')

    // 📖 Feedback message (auto-clears after 5s)
    const msg = state.proxyDaemonMessage
    if (msg && (Date.now() - msg.ts < 5000)) {
      const msgColor = msg.type === 'success' ? chalk.greenBright : msg.type === 'warning' ? chalk.yellow : chalk.red
      lines.push(`  ${msgColor(msg.msg)}`)
      lines.push('')
    }

    // ────────────────────────────── PROXY SECTION ──────────────────────────────
    lines.push(`  ${chalk.bold('🔀 Proxy Configuration')}`)
    lines.push(`  ${chalk.dim('  ─────────────────────────────────────────────')}`)
    lines.push('')
    lines.push(`  ${chalk.dim('  The local proxy groups all your provider API keys into a single')}`)
    lines.push(`  ${chalk.dim('  endpoint. Tools like OpenCode, Claude Code, Goose, etc. connect')}`)
    lines.push(`  ${chalk.dim('  to this proxy which handles key rotation, rate limiting, and failover.')}`)
    lines.push('')

    // 📖 Proxy sync now always follows the currently selected Z-mode when supported.
    const currentToolMode = state.mode || 'opencode'
    const currentToolMeta = getToolMeta(currentToolMode)
    const currentToolLabel = `${currentToolMeta.emoji} ${currentToolMeta.label}`
    const proxySyncTool = resolveProxySyncToolMode(currentToolMode)
    const proxySyncHint = proxySyncTool
      ? chalk.dim(`  Current tool: ${currentToolLabel}`)
      : chalk.yellow(`  Current tool: ${currentToolLabel} (launcher-only, no persisted proxy config)`)
    lines.push(proxySyncHint)
    lines.push('')

    // 📖 Row 0: Proxy enabled toggle
    const r0b = state.proxyDaemonCursor === ROW_PROXY_ENABLED ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const r0val = proxySettings.enabled ? chalk.greenBright('Enabled') : chalk.dim('Disabled (opt-in)')
    const r0 = `${r0b}${chalk.bold('Proxy mode').padEnd(44)} ${r0val}`
    cursorLineByRow[ROW_PROXY_ENABLED] = lines.length
    lines.push(state.proxyDaemonCursor === ROW_PROXY_ENABLED ? chalk.bgRgb(20, 45, 60)(r0) : r0)

    // 📖 Row 1: Auto-sync proxy config to the current tool when that tool supports persisted sync.
    const r2b = state.proxyDaemonCursor === ROW_PROXY_SYNC ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const r2val = proxySettings.syncToOpenCode ? chalk.greenBright('Enabled') : chalk.dim('Disabled')
    const r2label = proxySyncTool
      ? `Auto-sync proxy to ${currentToolMeta.label}`
      : 'Auto-sync proxy to current tool'
    const r2note = proxySyncTool ? '' : ` ${chalk.dim('(unavailable for this mode)')}`
    const r2 = `${r2b}${chalk.bold(r2label).padEnd(44)} ${r2val}${r2note}`
    cursorLineByRow[ROW_PROXY_SYNC] = lines.length
    lines.push(state.proxyDaemonCursor === ROW_PROXY_SYNC ? chalk.bgRgb(20, 45, 60)(r2) : r2)

    // 📖 Row 2: Preferred port
    const r3b = state.proxyDaemonCursor === ROW_PROXY_PORT ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const r3val = state.settingsProxyPortEditMode && state.proxyDaemonCursor === ROW_PROXY_PORT
      ? chalk.cyanBright(`${state.settingsProxyPortBuffer}▏`)
      : (proxySettings.preferredPort === 0 ? chalk.dim('auto (OS-assigned)') : chalk.green(String(proxySettings.preferredPort)))
    const r3 = `${r3b}${chalk.bold('Preferred proxy port').padEnd(44)} ${r3val}`
    cursorLineByRow[ROW_PROXY_PORT] = lines.length
    lines.push(state.proxyDaemonCursor === ROW_PROXY_PORT ? chalk.bgRgb(20, 45, 60)(r3) : r3)

    // 📖 Row 3: Clean current tool proxy config
    const r4b = state.proxyDaemonCursor === ROW_PROXY_CLEANUP ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const r4title = proxySyncTool
      ? `Clean ${currentToolMeta.label} proxy config`
      : `Clean ${currentToolMeta.label} proxy config`
    const r4hint = proxySyncTool
      ? chalk.dim('Enter → removes all fcm-* entries')
      : chalk.dim('Unavailable for this mode')
    const r4 = `${r4b}${chalk.bold(r4title).padEnd(44)} ${r4hint}`
    cursorLineByRow[ROW_PROXY_CLEANUP] = lines.length
    lines.push(state.proxyDaemonCursor === ROW_PROXY_CLEANUP ? chalk.bgRgb(45, 30, 30)(r4) : r4)

    // ────────────────────────────── DAEMON SECTION ─────────────────────────────
    lines.push('')
    lines.push(`  ${chalk.bold('📡 FCM Proxy V2 Background Service')}`)
    lines.push(`  ${chalk.dim('  ─────────────────────────────────────────────')}`)
    lines.push('')
    lines.push(`  ${chalk.dim('  The background service keeps FCM Proxy V2 running 24/7 — even when')}`)
    lines.push(`  ${chalk.dim('  the TUI is closed or after a reboot. Claude Code, Gemini CLI, and')}`)
    lines.push(`  ${chalk.dim('  all tools stay connected at all times.')}`)
    lines.push('')

    // 📖 Status display
    let daemonStatusLine = `  ${chalk.bold('  Status:')} `
    if (daemonStatus === 'running') {
      daemonStatusLine += chalk.greenBright('● Running')
      if (daemonInfo) daemonStatusLine += chalk.dim(` — PID ${daemonInfo.pid} • Port ${daemonInfo.port} • ${daemonInfo.accountCount || '?'} accounts • ${daemonInfo.modelCount || '?'} models`)
    } else if (daemonStatus === 'stopped') {
      daemonStatusLine += chalk.yellow('○ Stopped') + chalk.dim(' — service installed but not running')
    } else if (daemonStatus === 'stale') {
      daemonStatusLine += chalk.red('⚠ Stale') + chalk.dim(' — service crashed, PID no longer alive')
    } else if (daemonStatus === 'unhealthy') {
      daemonStatusLine += chalk.red('⚠ Unhealthy') + chalk.dim(' — PID alive but health check failed')
    } else {
      daemonStatusLine += chalk.dim('○ Not installed')
    }
    lines.push(daemonStatusLine)

    // 📖 Version mismatch warning
    if (daemonInfo?.version && daemonInfo.version !== LOCAL_VERSION) {
      lines.push(`  ${chalk.yellow(`  ⚠ Version mismatch: service v${daemonInfo.version} vs FCM v${LOCAL_VERSION}`)}`)
      lines.push(`  ${chalk.dim('    Restart or reinstall the service to apply the update.')}`)
    }

    // 📖 Uptime
    if (daemonStatus === 'running' && daemonInfo?.startedAt) {
      const upSec = Math.floor((Date.now() - new Date(daemonInfo.startedAt).getTime()) / 1000)
      const upMin = Math.floor(upSec / 60)
      const upHr = Math.floor(upMin / 60)
      const uptimeStr = upHr > 0 ? `${upHr}h ${upMin % 60}m` : upMin > 0 ? `${upMin}m ${upSec % 60}s` : `${upSec}s`
      lines.push(`  ${chalk.dim(`  Uptime: ${uptimeStr}`)}`)
    }

    lines.push('')

    // 📖 Row 5: Install / Uninstall
    const d0b = state.proxyDaemonCursor === ROW_DAEMON_INSTALL ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
    const d0label = daemonIsInstalled ? 'Uninstall service' : 'Install background service'
    const d0hint = daemonIsInstalled
      ? chalk.dim('Enter → stop service + remove config')
      : chalk.dim('Enter → install as OS service (launchd/systemd)')
    const d0 = `${d0b}${chalk.bold(d0label).padEnd(44)} ${d0hint}`
    cursorLineByRow[ROW_DAEMON_INSTALL] = lines.length
    lines.push(state.proxyDaemonCursor === ROW_DAEMON_INSTALL ? chalk.bgRgb(daemonIsInstalled ? 45 : 20, daemonIsInstalled ? 30 : 45, daemonIsInstalled ? 30 : 40)(d0) : d0)

    // 📖 Rows 6-9 only shown when service is installed
    if (daemonIsInstalled) {
      // 📖 Row 6: Restart
      const d1b = state.proxyDaemonCursor === ROW_DAEMON_RESTART ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
      const d1 = `${d1b}${chalk.bold('Restart service').padEnd(44)} ${chalk.dim('Enter → stop + start via OS service manager')}`
      cursorLineByRow[ROW_DAEMON_RESTART] = lines.length
      lines.push(state.proxyDaemonCursor === ROW_DAEMON_RESTART ? chalk.bgRgb(20, 45, 60)(d1) : d1)

      // 📖 Row 7: Stop (SIGTERM)
      const d2b = state.proxyDaemonCursor === ROW_DAEMON_STOP ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
      const d2warn = chalk.dim(' (service may auto-restart)')
      const d2 = `${d2b}${chalk.bold('Stop service').padEnd(44)} ${chalk.dim('Enter → graceful shutdown (SIGTERM)')}${d2warn}`
      cursorLineByRow[ROW_DAEMON_STOP] = lines.length
      lines.push(state.proxyDaemonCursor === ROW_DAEMON_STOP ? chalk.bgRgb(45, 40, 20)(d2) : d2)

      // 📖 Row 8: Force kill (SIGKILL) — emergency
      const d3b = state.proxyDaemonCursor === ROW_DAEMON_KILL ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
      const d3 = `${d3b}${chalk.bold.red('Force kill service').padEnd(44)} ${chalk.dim('Enter → SIGKILL — emergency only')}`
      cursorLineByRow[ROW_DAEMON_KILL] = lines.length
      lines.push(state.proxyDaemonCursor === ROW_DAEMON_KILL ? chalk.bgRgb(60, 20, 20)(d3) : d3)

      // 📖 Row 9: View logs
      const d4b = state.proxyDaemonCursor === ROW_DAEMON_LOGS ? chalk.bold.cyan('  ❯ ') : chalk.dim('    ')
      const d4 = `${d4b}${chalk.bold('View service logs').padEnd(44)} ${chalk.dim('Enter → show last 50 log lines')}`
      cursorLineByRow[ROW_DAEMON_LOGS] = lines.length
      lines.push(state.proxyDaemonCursor === ROW_DAEMON_LOGS ? chalk.bgRgb(30, 30, 50)(d4) : d4)
    }

    // ────────────────────────────── INFO SECTION ───────────────────────────────
    lines.push('')
    lines.push(`  ${chalk.bold('ℹ  How it works')}`)
    lines.push(`  ${chalk.dim('  ─────────────────────────────────────────────')}`)
    lines.push('')
    lines.push(`  ${chalk.dim('  📖 The proxy starts a local HTTP server on 127.0.0.1 (localhost only).')}`)
    lines.push(`  ${chalk.dim('  📖 External tools connect to it as if it were OpenAI/Anthropic.')}`)
    lines.push(`  ${chalk.dim('  📖 The proxy rotates between your API keys across all providers.')}`)
    lines.push('')
    lines.push(`  ${chalk.dim('  📖 The background service adds persistence: install it once, and the proxy')}`)
    lines.push(`  ${chalk.dim('  📖 starts automatically at login and survives reboots.')}`)
    lines.push('')
    lines.push(`  ${chalk.dim('  📖 Claude Code support: FCM Proxy V2 translates Anthropic wire format')}`)
    lines.push(`  ${chalk.dim('  📖 (POST /v1/messages) to OpenAI format for upstream providers.')}`)
    lines.push('')
    if (process.platform === 'darwin') {
      lines.push(`  ${chalk.dim('  📦 macOS: launchd LaunchAgent at ~/Library/LaunchAgents/com.fcm.proxy.plist')}`)
    } else if (process.platform === 'linux') {
      lines.push(`  ${chalk.dim('  📦 Linux: systemd user service at ~/.config/systemd/user/fcm-proxy.service')}`)
    } else {
      lines.push(`  ${chalk.dim('  ⚠ Windows: background service not supported — use in-process proxy (starts with TUI)')}`)
    }
    lines.push('')

    // 📖 Clamp cursor
    if (state.proxyDaemonCursor > maxRow) state.proxyDaemonCursor = maxRow

    // 📖 Scrolling and tinting
    const PROXY_DAEMON_BG = chalk.bgRgb(15, 25, 45)
    const targetLine = cursorLineByRow[state.proxyDaemonCursor] ?? 0
    state.proxyDaemonScrollOffset = keepOverlayTargetVisible(
      state.proxyDaemonScrollOffset,
      targetLine,
      lines.length,
      state.terminalRows
    )
    const { visible, offset } = sliceOverlayLines(lines, state.proxyDaemonScrollOffset, state.terminalRows)
    state.proxyDaemonScrollOffset = offset
    const tintedLines = tintOverlayLines(visible, PROXY_DAEMON_BG, state.terminalCols)
    return tintedLines.map(l => l + EL).join('\n')
  }

  // 📖 stopRecommendAnalysis: cleanup timers if user cancels during analysis
  function stopRecommendAnalysis() {
    if (state.recommendAnalysisTimer) { clearInterval(state.recommendAnalysisTimer); state.recommendAnalysisTimer = null }
    if (state.recommendPingTimer) { clearInterval(state.recommendPingTimer); state.recommendPingTimer = null }
  }

  return {
    renderSettings,
    renderProxyDaemon,
    renderInstallEndpoints,
    renderHelp,
    renderLog,
    renderRecommend,
    renderFeedback,
    renderChangelog,
    startRecommendAnalysis,
    stopRecommendAnalysis,
  }
}
