#!/usr/bin/env node
/**
 * @file free-coding-models.js
 * @description Live terminal availability checker for coding LLM models with OpenCode & OpenClaw integration.
 *
 * @details
 *   This CLI tool discovers and benchmarks language models optimized for coding.
 *   It runs in an alternate screen buffer, pings all models in parallel, re-pings successful ones
 *   multiple times for reliable latency measurements, and prints a clean final table.
 *   During benchmarking, users can navigate with arrow keys and press Enter to act on the selected model.
 *
 *   🎯 Key features:
 *   - Parallel pings across all models with animated real-time updates (multi-provider)
 *   - Continuous monitoring with 60-second ping intervals (never stops)
 *   - Rolling averages calculated from ALL successful pings since start
 *   - Best-per-tier highlighting with medals (🥇🥈🥉)
 *   - Interactive navigation with arrow keys directly in the table
 *   - Instant OpenCode OR OpenClaw action on Enter key press
 *   - Startup mode menu (OpenCode CLI vs OpenCode Desktop vs OpenClaw) when no flag is given
 *   - Automatic config detection and model setup for both tools
 *   - JSON config stored in ~/.free-coding-models.json (auto-migrates from old plain-text)
 *   - Multi-provider support via sources.js (NIM/Groq/Cerebras/OpenRouter/Hugging Face/Replicate/DeepInfra/... — extensible)
 *   - Settings screen (P key) to manage API keys, provider toggles, and manual updates
 *   - Favorites system: toggle with F, pin rows to top, persist between sessions
 *   - Uptime percentage tracking (successful pings / total pings)
 *   - Sortable columns (R/Y/O/M/L/A/S/N/H/V/B/U keys)
 *   - Tier filtering via T key (cycles S+→S→A+→A→A-→B+→B→C→All)
 *
 *   → Functions:
 *   - `loadConfig` / `saveConfig` / `getApiKey`: Multi-provider JSON config via lib/config.js
 *   - `getTelemetryDistinctId`: Generate/reuse a stable anonymous ID for telemetry
 *   - `getTelemetryTerminal`: Infer terminal family (Terminal.app, iTerm2, kitty, etc.)
 *   - `isTelemetryDebugEnabled` / `telemetryDebug`: Optional runtime telemetry diagnostics via env
 *   - `sendUsageTelemetry`: Fire-and-forget anonymous app-start event
 *   - `ensureFavoritesConfig` / `toggleFavoriteModel`: Persist and toggle pinned favorites
 *   - `promptApiKey`: Interactive wizard for first-time multi-provider API key setup
 *   - `promptModeSelection`: Startup menu to choose OpenCode vs OpenClaw
 *   - `buildPingRequest` / `ping`: Build provider-specific probe requests and measure latency
 *   - `renderTable`: Generate ASCII table with colored latency indicators and status emojis
 *   - `getAvg`: Calculate average latency from all successful pings
 *   - `getVerdict`: Determine verdict string based on average latency (Overloaded for 429)
 *   - `getUptime`: Calculate uptime percentage from ping history
 *   - `sortResults`: Sort models by various columns
 *   - `checkNvidiaNimConfig`: Check if NVIDIA NIM provider is configured in OpenCode
 *   - `isTcpPortAvailable` / `resolveOpenCodeTmuxPort`: Pick a safe OpenCode port when running in tmux
 *   - `startOpenCode`: Launch OpenCode CLI with selected model (configures if needed)
 *   - `startOpenCodeDesktop`: Set model in shared config & open OpenCode Desktop app
 *   - `loadOpenClawConfig` / `saveOpenClawConfig`: Manage ~/.openclaw/openclaw.json
 *   - `startOpenClaw`: Set selected model as default in OpenClaw config (remote, no launch)
 *   - `filterByTier`: Filter models by tier letter prefix (S, A, B, C)
 *   - `main`: Orchestrates CLI flow, wizard, ping loops, animation, and output
 *
 *   📦 Dependencies:
 *   - Node.js 18+ (native fetch)
 *   - chalk: Terminal styling and colors
 *   - readline: Interactive input handling
 *   - sources.js: Model definitions from all providers
 *
 *   ⚙️ Configuration:
 *   - API keys stored per-provider in ~/.free-coding-models.json (0600 perms)
 *   - Old ~/.free-coding-models plain-text auto-migrated as nvidia key on first run
 *   - Env vars override config: NVIDIA_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, HUGGINGFACE_API_KEY/HF_TOKEN, REPLICATE_API_TOKEN, DEEPINFRA_API_KEY/DEEPINFRA_TOKEN, FIREWORKS_API_KEY, SILICONFLOW_API_KEY, TOGETHER_API_KEY, PERPLEXITY_API_KEY, ZAI_API_KEY, etc.
 *   - ZAI (z.ai) uses a non-standard base path; cloudflare needs CLOUDFLARE_ACCOUNT_ID in env.
 *   - Cloudflare Workers AI requires both CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_KEY) and CLOUDFLARE_ACCOUNT_ID
 *   - Models loaded from sources.js — all provider/model definitions are centralized there
 *   - OpenCode config: ~/.config/opencode/opencode.json
 *   - OpenClaw config: ~/.openclaw/openclaw.json
 *   - Ping timeout: 15s per attempt
 *   - Ping interval: 60 seconds (continuous monitoring mode)
 *   - Animation: 12 FPS with braille spinners
 *
 *   🚀 CLI flags:
 *   - (no flag): Show startup menu → choose OpenCode or OpenClaw
 *   - --opencode: OpenCode CLI mode (launch CLI with selected model)
 *   - --opencode-desktop: OpenCode Desktop mode (set model & open Desktop app)
 *   - --openclaw: OpenClaw mode (set selected model as default in OpenClaw)
 *   - --best: Show only top-tier models (A+, S, S+)
 *   - --fiable: Analyze 10s and output the most reliable model
 *   - --no-telemetry: Disable anonymous usage analytics for this run
 *   - --tier S/A/B/C: Filter models by tier letter (S=S+/S, A=A+/A/A-, B=B+/B, C=C)
 *
 *   @see {@link https://build.nvidia.com} NVIDIA API key generation
 *   @see {@link https://github.com/opencode-ai/opencode} OpenCode repository
 *   @see {@link https://openclaw.ai} OpenClaw documentation
 */

import chalk from 'chalk'
import { createRequire } from 'module'
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { MODELS, sources } from '../sources.js'
import { getAvg, getVerdict, getUptime, getP95, getJitter, getStabilityScore, sortResults, filterByTier, findBestModel, parseArgs, TIER_ORDER, VERDICT_ORDER, TIER_LETTER_MAP, scoreModelForTask, getTopRecommendations, TASK_TYPES, PRIORITY_TYPES, CONTEXT_BUDGETS, formatCtxWindow, labelFromId, getProxyStatusInfo } from '../src/utils.js'
import { loadConfig, saveConfig, getApiKey, resolveApiKeys, addApiKey, removeApiKey, isProviderEnabled, saveAsProfile, loadProfile, listProfiles, deleteProfile, getActiveProfileName, setActiveProfile, _emptyProfileSettings } from '../src/config.js'
import { buildMergedModels } from '../src/model-merger.js'
import { ProxyServer } from '../src/proxy-server.js'
import { loadOpenCodeConfig, saveOpenCodeConfig, syncToOpenCode, restoreOpenCodeBackup } from '../src/opencode-sync.js'
import { usageForRow as _usageForRow } from '../src/usage-reader.js'
import { loadRecentLogs } from '../src/log-reader.js'
import { buildProviderModelTokenKey, loadTokenUsageByProviderModel } from '../src/token-usage-reader.js'
import { parseOpenRouterResponse, fetchProviderQuota as _fetchProviderQuotaFromModule } from '../src/provider-quota-fetchers.js'
import { isKnownQuotaTelemetry } from '../src/quota-capabilities.js'
import { ALT_ENTER, ALT_LEAVE, ALT_HOME, PING_TIMEOUT, PING_INTERVAL, FPS, COL_MODEL, COL_MS, CELL_W, FRAMES, TIER_CYCLE, SETTINGS_OVERLAY_BG, HELP_OVERLAY_BG, RECOMMEND_OVERLAY_BG, LOG_OVERLAY_BG, OVERLAY_PANEL_WIDTH, TABLE_HEADER_LINES, TABLE_FOOTER_LINES, TABLE_FIXED_LINES, msCell, spinCell } from '../src/constants.js'
import { TIER_COLOR } from '../src/tier-colors.js'
import { resolveCloudflareUrl, buildPingRequest, ping, extractQuotaPercent, getProviderQuotaPercentCached, usagePlaceholderForProvider } from '../src/ping.js'
import { runFiableMode, filterByTierOrExit, fetchOpenRouterFreeModels } from '../src/analysis.js'
import { PROVIDER_METADATA, ENV_VAR_NAMES, isWindows, isMac } from '../src/provider-metadata.js'
import { parseTelemetryEnv, isTelemetryDebugEnabled, telemetryDebug, ensureTelemetryConfig, getTelemetryDistinctId, getTelemetrySystem, getTelemetryTerminal, isTelemetryEnabled, sendUsageTelemetry, sendFeatureRequest, sendBugReport } from '../src/telemetry.js'
import { ensureFavoritesConfig, toFavoriteKey, syncFavoriteFlags, toggleFavoriteModel } from '../src/favorites.js'
import { checkForUpdateDetailed, checkForUpdate, runUpdate, promptUpdateNotification } from '../src/updater.js'
import { promptApiKey } from '../src/setup.js'
import { stripAnsi, maskApiKey, displayWidth, padEndDisplay, tintOverlayLines, keepOverlayTargetVisible, sliceOverlayLines, calculateViewport, sortResultsWithPinnedFavorites, renderProxyStatusLine, adjustScrollOffset } from '../src/render-helpers.js'
import { renderTable } from '../src/render-table.js'
import { setOpenCodeModelData, startOpenCode, startOpenCodeDesktop, startProxyAndLaunch, autoStartProxyIfSynced, ensureProxyRunning, buildProxyTopologyFromConfig } from '../src/opencode.js'
import { startOpenClaw } from '../src/openclaw.js'
import { createOverlayRenderers } from '../src/overlays.js'
import { createKeyHandler } from '../src/key-handler.js'

// 📖 mergedModels: cross-provider grouped model list (one entry per label, N providers each)
// 📖 mergedModelByLabel: fast lookup map from display label → merged model entry
const mergedModels = buildMergedModels(MODELS)
const mergedModelByLabel = new Map(mergedModels.map(m => [m.label, m]))
setOpenCodeModelData(mergedModels, mergedModelByLabel)

// 📖 Provider quota cache is managed by lib/provider-quota-fetchers.js (TTL + backoff).
// 📖 Usage placeholder logic uses isKnownQuotaTelemetry() from lib/quota-capabilities.js.

const require = createRequire(import.meta.url)
const readline = require('readline')

// ─── Version check ────────────────────────────────────────────────────────────
const pkg = require('../package.json')
const LOCAL_VERSION = pkg.version

// 📖 sendFeatureRequest, sendBugReport → imported from ../src/telemetry.js

// 📖 parseTelemetryEnv, isTelemetryDebugEnabled, telemetryDebug, ensureTelemetryConfig → imported from ../src/telemetry.js

// 📖 ensureFavoritesConfig, toFavoriteKey, syncFavoriteFlags, toggleFavoriteModel → imported from ../src/favorites.js

// ─── Alternate screen control ─────────────────────────────────────────────────
// 📖 \x1b[?1049h = enter alt screen  \x1b[?1049l = leave alt screen
// 📖 \x1b[?25l   = hide cursor       \x1b[?25h   = show cursor
// 📖 \x1b[H      = cursor to top
// 📖 NOTE: We avoid \x1b[2J (clear screen) because Ghostty scrolls cleared
// 📖 content into the scrollback on the alt screen, pushing the header off-screen.
// 📖 Instead we overwrite in place: cursor home, then \x1b[K (erase to EOL) per line.
// 📖 \x1b[?7l disables auto-wrap so wide rows clip at the right edge instead of
// 📖 wrapping to the next line (which would double the row height and overflow).
// NOTE: All constants (ALT_ENTER, PING_TIMEOUT, etc.) are imported from ../src/constants.js

// ─── Styling ──────────────────────────────────────────────────────────────────
// 📖 Tier colors (TIER_COLOR) are imported from ../src/tier-colors.js
// 📖 All TUI constants (ALT_ENTER, PING_TIMEOUT, etc.) are imported from ../src/constants.js

// 📖 renderTable is now extracted to ../src/render-table.js

// ─── OpenCode integration ──────────────────────────────────────────────────────
// 📖 OpenCode helpers are imported from ../src/opencode.js

// ─── OpenCode integration ──────────────────────────────────────────────────────
// 📖 OpenCode helpers are imported from ../src/opencode.js

async function main() {
  const cliArgs = parseArgs(process.argv)

  // Validate --tier early, before entering alternate screen
  if (cliArgs.tierFilter && !TIER_LETTER_MAP[cliArgs.tierFilter]) {
    console.error(chalk.red(`  Unknown tier "${cliArgs.tierFilter}". Valid tiers: S, A, B, C`))
    process.exit(1)
  }

  // 📖 Load JSON config (auto-migrates old plain-text ~/.free-coding-models if needed)
  const config = loadConfig()
  ensureTelemetryConfig(config)
  ensureFavoritesConfig(config)

  // 📖 If --profile <name> was passed, load that profile into the live config
  if (cliArgs.profileName) {
    const profileSettings = loadProfile(config, cliArgs.profileName)
    if (!profileSettings) {
      console.error(chalk.red(`  Unknown profile "${cliArgs.profileName}". Available: ${listProfiles(config).join(', ') || '(none)'}`))
      process.exit(1)
    }
    saveConfig(config)
  }

  // 📖 Check if any provider has a key — if not, run the first-time setup wizard
  const hasAnyKey = Object.keys(sources).some(pk => !!getApiKey(config, pk))

  if (!hasAnyKey) {
    const result = await promptApiKey(config)
    if (!result) {
      console.log()
      console.log(chalk.red('  ✖ No API key provided.'))
      console.log(chalk.dim('  Run `free-coding-models` again or set NVIDIA_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY.'))
      console.log()
      process.exit(1)
    }
  }

  // 📖 Backward-compat: keep apiKey var for startOpenClaw() which still needs it
  let apiKey = getApiKey(config, 'nvidia')

  // 📖 Default mode: OpenCode CLI
  let mode = 'opencode'
  if (cliArgs.openClawMode) mode = 'openclaw'
  else if (cliArgs.openCodeDesktopMode) mode = 'opencode-desktop'
  else if (cliArgs.openCodeMode) mode = 'opencode'

  // 📖 Track app opening early so fast exits are still counted.
  // 📖 Must run before update checks because npm registry lookups can add startup delay.
  void sendUsageTelemetry(config, cliArgs, {
    event: 'app_start',
    version: LOCAL_VERSION,
    mode,
    ts: new Date().toISOString(),
  })

  // 📖 Check for updates in the background
  let latestVersion = null
  try {
    latestVersion = await checkForUpdate()
  } catch {
    // Silently fail - don't block the app if npm registry is unreachable
  }

  // 📖 Auto-update system: force updates and handle changelog automatically
  // 📖 Skip when running from source (dev mode) — .git means we're in a repo checkout,
  // 📖 not a global npm install. Auto-update would overwrite the global copy but restart
  // 📖 the local one, causing an infinite update loop since LOCAL_VERSION never changes.
  const isDevMode = existsSync(join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '.git'))
  if (latestVersion && !isDevMode) {
    console.log()
    console.log(chalk.bold.red('  ⚠ AUTO-UPDATE AVAILABLE'))
    console.log(chalk.red(`  Version ${latestVersion} will be installed automatically`))
    console.log(chalk.dim('  Opening changelog in browser...'))
    console.log()
    
    // 📖 Open changelog automatically
    const { execSync } = require('child_process')
    const changelogUrl = 'https://github.com/vava-nessa/free-coding-models/releases'
    try {
      if (isMac) {
        execSync(`open "${changelogUrl}"`, { stdio: 'ignore' })
      } else if (isWindows) {
        execSync(`start "" "${changelogUrl}"`, { stdio: 'ignore' })
      } else {
        execSync(`xdg-open "${changelogUrl}"`, { stdio: 'ignore' })
      }
      console.log(chalk.green('  ✅ Changelog opened in browser'))
    } catch {
      console.log(chalk.yellow('  ⚠ Could not open browser automatically'))
      console.log(chalk.dim(`  Visit manually: ${changelogUrl}`))
    }
    
    // 📖 Force update immediately
    console.log(chalk.cyan('  🚀 Starting auto-update...'))
    runUpdate(latestVersion)
    return // runUpdate will restart the process
  }

  // 📖 Dynamic OpenRouter free model discovery — fetch live free models from API
  // 📖 Replaces static openrouter entries in MODELS with fresh data.
  // 📖 Fallback: if fetch fails, the static list from sources.js stays intact + warning shown.
  const dynamicModels = await fetchOpenRouterFreeModels()
  if (dynamicModels) {
    // 📖 Remove all existing openrouter entries from MODELS
    for (let i = MODELS.length - 1; i >= 0; i--) {
      if (MODELS[i][5] === 'openrouter') MODELS.splice(i, 1)
    }
    // 📖 Push fresh entries with 'openrouter' providerKey
    for (const [modelId, label, tier, swe, ctx] of dynamicModels) {
      MODELS.push([modelId, label, tier, swe, ctx, 'openrouter'])
    }
  } else {
    console.log(chalk.yellow('  OpenRouter: using cached model list (live fetch failed)'))
  }

  // 📖 Build results from MODELS — only include enabled providers
  // 📖 Each result gets providerKey so ping() knows which URL + API key to use

  let results = MODELS
    .filter(([,,,,,providerKey]) => isProviderEnabled(config, providerKey))
    .map(([modelId, label, tier, sweScore, ctx, providerKey], i) => ({
      idx: i + 1, modelId, label, tier, sweScore, ctx, providerKey,
      status: 'pending',
      pings: [],  // 📖 All ping results (ms or 'TIMEOUT')
      httpCode: null,
      isPinging: false, // 📖 Per-row live flag so Latest Ping can keep last value and show a spinner during refresh.
      hidden: false,  // 📖 Simple flag to hide/show models
    }))
  syncFavoriteFlags(results, config)

  // 📖 Load usage data from token-stats.json and attach usagePercent to each result row.
  // 📖 usagePercent is the quota percent remaining (0–100). undefined = no data available.
  // 📖 Freshness-aware: snapshots older than 30 minutes are excluded (shown as N/A in UI).
  const tokenTotalsByProviderModel = loadTokenUsageByProviderModel()
  for (const r of results) {
    const pct = _usageForRow(r.providerKey, r.modelId)
    r.usagePercent = typeof pct === 'number' ? pct : undefined
    r.totalTokens = tokenTotalsByProviderModel[buildProviderModelTokenKey(r.providerKey, r.modelId)] || 0
  }

  // 📖 Add interactive selection state - cursor index and user's choice
  // 📖 sortColumn: 'rank'|'tier'|'origin'|'model'|'ping'|'avg'|'status'|'verdict'|'uptime'
  // 📖 sortDirection: 'asc' (default) or 'desc'
    // 📖 pingInterval: current interval in ms (default 2000, adjustable with W/= keys)
    // 📖 tierFilter: current tier filter letter (null = all, 'S' = S+/S, 'A' = A+/A/A-, etc.)
  const state = {
    results,
    pendingPings: 0,
    frame: 0,
    cursor: 0,
    selectedModel: null,
    sortColumn: 'avg',
    sortDirection: 'asc',
    pingInterval: PING_INTERVAL,  // 📖 Track current interval for W/= keys
    lastPingTime: Date.now(),     // 📖 Track when last ping cycle started
    mode,                         // 📖 'opencode' or 'openclaw' — controls Enter action
    tierFilterMode: 0,            // 📖 Index into TIER_CYCLE (0=All, 1=S+, 2=S, ...)
    originFilterMode: 0,          // 📖 Index into ORIGIN_CYCLE (0=All, then providers)
    scrollOffset: 0,              // 📖 First visible model index in viewport
    terminalRows: process.stdout.rows || 24,  // 📖 Current terminal height
    // 📖 Settings screen state (P key opens it)
    settingsOpen: false,          // 📖 Whether settings overlay is active
    settingsCursor: 0,            // 📖 Which provider row is selected in settings
    settingsEditMode: false,      // 📖 Whether we're in inline key editing mode (edit primary key)
    settingsAddKeyMode: false,    // 📖 Whether we're in add-key mode (append a new key to provider)
    settingsEditBuffer: '',       // 📖 Typed characters for the API key being edited
    settingsErrorMsg: null,       // 📖 Temporary error message to display in settings
    settingsTestResults: {},      // 📖 { providerKey: 'pending'|'ok'|'fail'|null }
    settingsUpdateState: 'idle',  // 📖 'idle'|'checking'|'available'|'up-to-date'|'error'|'installing'
    settingsUpdateLatestVersion: null, // 📖 Latest npm version discovered from manual check
    settingsUpdateError: null,    // 📖 Last update-check error message for maintenance row
    config,                       // 📖 Live reference to the config object (updated on save)
    visibleSorted: [],            // 📖 Cached visible+sorted models — shared between render loop and key handlers
    helpVisible: false,           // 📖 Whether the help overlay (K key) is active
    settingsScrollOffset: 0,      // 📖 Vertical scroll offset for Settings overlay viewport
    helpScrollOffset: 0,          // 📖 Vertical scroll offset for Help overlay viewport
    // 📖 Smart Recommend overlay state (Q key opens it)
    recommendOpen: false,         // 📖 Whether the recommend overlay is active
    recommendPhase: 'questionnaire', // 📖 'questionnaire'|'analyzing'|'results' — current phase
    recommendCursor: 0,           // 📖 Selected question option (0-based index within current question)
    recommendQuestion: 0,         // 📖 Which question we're on (0=task, 1=priority, 2=context)
    recommendAnswers: { taskType: null, priority: null, contextBudget: null }, // 📖 User's answers
    recommendProgress: 0,         // 📖 Analysis progress percentage (0–100)
    recommendResults: [],         // 📖 Top N recommendations from getTopRecommendations()
    recommendScrollOffset: 0,     // 📖 Vertical scroll offset for Recommend overlay viewport
    recommendAnalysisTimer: null, // 📖 setInterval handle for the 10s analysis phase
    recommendPingTimer: null,     // 📖 setInterval handle for 2 pings/sec during analysis
    recommendedKeys: new Set(),   // 📖 Set of "providerKey/modelId" for recommended models (shown in main table)
    // 📖 Config Profiles state
    activeProfile: getActiveProfileName(config), // 📖 Currently loaded profile name (or null)
    profileSaveMode: false,       // 📖 Whether the inline "Save profile" name input is active
    profileSaveBuffer: '',        // 📖 Typed characters for the profile name being saved
    // 📖 Feature Request state (J key opens it)
    featureRequestOpen: false,    // 📖 Whether the feature request overlay is active
    featureRequestBuffer: '',     // 📖 Typed characters for the feature request message
    featureRequestStatus: 'idle', // 📖 'idle'|'sending'|'success'|'error' — webhook send status
    featureRequestError: null,    // 📖 Last webhook error message
    // 📖 Bug Report state (I key opens it)
    bugReportOpen: false,         // 📖 Whether the bug report overlay is active
    bugReportBuffer: '',          // 📖 Typed characters for the bug report message
    bugReportStatus: 'idle',      // 📖 'idle'|'sending'|'success'|'error' — webhook send status
    bugReportError: null,         // 📖 Last webhook error message
    // 📖 OpenCode sync status (S key in settings)
    settingsSyncStatus: null,     // 📖 { type: 'success'|'error', msg: string } — shown in settings footer
    // 📖 Log page overlay state (X key opens it)
    logVisible: false,            // 📖 Whether the log page overlay is active
    logScrollOffset: 0,           // 📖 Vertical scroll offset for log overlay viewport
    // 📖 Proxy startup status — set by autoStartProxyIfSynced, consumed by Task 3 indicator
    // 📖 null = not configured/not attempted
    // 📖 { phase: 'starting' } — proxy start in progress
    // 📖 { phase: 'running', port, accountCount } — proxy is live
    // 📖 { phase: 'failed', reason } — proxy failed to start
    proxyStartupStatus: null,     // 📖 Startup-phase proxy status (null | { phase, ...details })
  }

  // 📖 Re-clamp viewport on terminal resize
  process.stdout.on('resize', () => {
    state.terminalRows = process.stdout.rows || 24
    adjustScrollOffset(state)
  })

  // 📖 Auto-start proxy on launch if OpenCode config already has an fcm-proxy provider.
  // 📖 Fire-and-forget: does not block UI startup. state.proxyStartupStatus is updated async.
  if (mode === 'opencode' || mode === 'opencode-desktop') {
    void autoStartProxyIfSynced(config, state)
  }

  // 📖 Enter alternate screen — animation runs here, zero scrollback pollution
  process.stdout.write(ALT_ENTER)

  // 📖 Ensure we always leave alt screen cleanly (Ctrl+C, crash, normal exit)
  const exit = (code = 0) => {
    clearInterval(ticker)
    clearTimeout(state.pingIntervalObj)
    process.stdout.write(ALT_LEAVE)
    process.exit(code)
  }
  process.on('SIGINT',  () => exit(0))
  process.on('SIGTERM', () => exit(0))

  // 📖 originFilterMode: index into ORIGIN_CYCLE, 0=All, then each provider key in order
  const ORIGIN_CYCLE = [null, ...Object.keys(sources)]
  state.tierFilterMode = 0
  state.originFilterMode = 0

  function applyTierFilter() {
    const activeTier = TIER_CYCLE[state.tierFilterMode]
    const activeOrigin = ORIGIN_CYCLE[state.originFilterMode]
    state.results.forEach(r => {
      // 📖 Favorites stay visible regardless of tier/origin filters.
      if (r.isFavorite) {
        r.hidden = false
        return
      }
      // 📖 Apply both tier and origin filters — model is hidden if it fails either
      const tierHide = activeTier !== null && r.tier !== activeTier
      const originHide = activeOrigin !== null && r.providerKey !== activeOrigin
      r.hidden = tierHide || originHide
    })
    return state.results
  }

  // ─── Overlay renderers + key handler ─────────────────────────────────────
  let pingModel = null
  let ticker = null
  let onKeyPress = null
  const stopUi = ({ resetRawMode = false } = {}) => {
    if (ticker) clearInterval(ticker)
    clearTimeout(state.pingIntervalObj)
    if (onKeyPress) process.stdin.removeListener('keypress', onKeyPress)
    if (process.stdin.isTTY && resetRawMode) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(ALT_LEAVE)
  }

  const overlays = createOverlayRenderers(state, {
    chalk,
    sources,
    PROVIDER_METADATA,
    LOCAL_VERSION,
    getApiKey,
    resolveApiKeys,
    isProviderEnabled,
    listProfiles,
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
    getPingModel: () => pingModel
  })

  onKeyPress = createKeyHandler({
    state,
    exit,
    cliArgs,
    MODELS,
    sources,
    getApiKey,
    resolveApiKeys,
    addApiKey,
    removeApiKey,
    isProviderEnabled,
    listProfiles,
    loadProfile,
    deleteProfile,
    saveAsProfile,
    setActiveProfile,
    saveConfig,
    syncFavoriteFlags,
    toggleFavoriteModel,
    sortResultsWithPinnedFavorites,
    adjustScrollOffset,
    applyTierFilter,
    PING_INTERVAL,
    TIER_CYCLE,
    ORIGIN_CYCLE,
    ENV_VAR_NAMES,
    ensureProxyRunning,
    syncToOpenCode,
    restoreOpenCodeBackup,
    checkForUpdateDetailed,
    runUpdate,
    startOpenClaw,
    startOpenCodeDesktop,
    startOpenCode,
    startProxyAndLaunch,
    buildProxyTopologyFromConfig,
    startRecommendAnalysis: overlays.startRecommendAnalysis,
    stopRecommendAnalysis: overlays.stopRecommendAnalysis,
    sendFeatureRequest,
    sendBugReport,
    stopUi,
    ping,
    TASK_TYPES,
    PRIORITY_TYPES,
    CONTEXT_BUDGETS,
    toFavoriteKey,
    mergedModels,
    apiKey,
    chalk,
    setResults: (next) => { results = next },
    readline,
  })

  // Apply CLI --tier filter if provided
  if (cliArgs.tierFilter) {
    const allowed = TIER_LETTER_MAP[cliArgs.tierFilter]
    state.results.forEach(r => {
      r.hidden = r.isFavorite ? false : !allowed.includes(r.tier)
    })
  }

  // 📖 Setup keyboard input for interactive selection during pings
  // 📖 Use readline with keypress event for arrow key handling
  process.stdin.setEncoding('utf8')
  process.stdin.resume()

  let userSelected = null

  // 📖 Enable keypress events on stdin
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  process.stdin.on('keypress', onKeyPress)

  // 📖 Animation loop: render settings overlay, recommend overlay, help overlay, feature request overlay, bug report overlay, OR main table
  ticker = setInterval(() => {
    state.frame++
    // 📖 Cache visible+sorted models each frame so Enter handler always matches the display
    if (!state.settingsOpen && !state.recommendOpen && !state.featureRequestOpen && !state.bugReportOpen) {
      const visible = state.results.filter(r => !r.hidden)
      state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
    }
    const content = state.settingsOpen
      ? overlays.renderSettings()
      : state.recommendOpen
        ? overlays.renderRecommend()
        : state.featureRequestOpen
          ? overlays.renderFeatureRequest()
          : state.bugReportOpen
            ? overlays.renderBugReport()
            : state.helpVisible
              ? overlays.renderHelp()
              : state.logVisible
                ? overlays.renderLog()
                : renderTable(state.results, state.pendingPings, state.frame, state.cursor, state.sortColumn, state.sortDirection, state.pingInterval, state.lastPingTime, state.mode, state.tierFilterMode, state.scrollOffset, state.terminalRows, state.originFilterMode, state.activeProfile, state.profileSaveMode, state.profileSaveBuffer, state.proxyStartupStatus)
    process.stdout.write(ALT_HOME + content)
  }, Math.round(1000 / FPS))

  // 📖 Populate visibleSorted before the first frame so Enter works immediately
  const initialVisible = state.results.filter(r => !r.hidden)
  state.visibleSorted = sortResultsWithPinnedFavorites(initialVisible, state.sortColumn, state.sortDirection)

  process.stdout.write(ALT_HOME + renderTable(state.results, state.pendingPings, state.frame, state.cursor, state.sortColumn, state.sortDirection, state.pingInterval, state.lastPingTime, state.mode, state.tierFilterMode, state.scrollOffset, state.terminalRows, state.originFilterMode, state.activeProfile, state.profileSaveMode, state.profileSaveBuffer, state.proxyStartupStatus))

  // 📖 If --recommend was passed, auto-open the Smart Recommend overlay on start
  if (cliArgs.recommendMode) {
    state.recommendOpen = true
    state.recommendPhase = 'questionnaire'
    state.recommendCursor = 0
    state.recommendQuestion = 0
    state.recommendAnswers = { taskType: null, priority: null, contextBudget: null }
    state.recommendProgress = 0
    state.recommendResults = []
    state.recommendScrollOffset = 0
  }

  // ── Continuous ping loop — ping all models every N seconds forever ──────────

  // 📖 Single ping function that updates result
  // 📖 Uses per-provider API key and URL from sources.js
  // 📖 If no API key is configured, pings without auth — a 401 still tells us latency + server is up
  pingModel = async (r) => {
    state.pendingPings += 1
    r.isPinging = true

    try {
      const providerApiKey = getApiKey(state.config, r.providerKey) ?? null
      const providerUrl = sources[r.providerKey]?.url ?? sources.nvidia.url
      let { code, ms, quotaPercent } = await ping(providerApiKey, r.modelId, r.providerKey, providerUrl)

      if ((quotaPercent === null || quotaPercent === undefined) && providerApiKey) {
        const providerQuota = await getProviderQuotaPercentCached(r.providerKey, providerApiKey)
        if (typeof providerQuota === 'number' && Number.isFinite(providerQuota)) {
          quotaPercent = providerQuota
        }
      }

      // 📖 Store ping result as object with ms and code
      // 📖 ms = actual response time (even for errors like 429)
      // 📖 code = HTTP status code ('200', '429', '500', '000' for timeout)
      r.pings.push({ ms, code })

      // 📖 Update status based on latest ping
      if (code === '200') {
        r.status = 'up'
      } else if (code === '000') {
        r.status = 'timeout'
      } else if (code === '401') {
        // 📖 401 = server is reachable but no API key set (or wrong key)
        // 📖 Treated as 'noauth' — server is UP, latency is real, just needs a key
        r.status = 'noauth'
        r.httpCode = code
      } else {
        r.status = 'down'
        r.httpCode = code
      }

      if (typeof quotaPercent === 'number' && Number.isFinite(quotaPercent)) {
        r.usagePercent = quotaPercent
        // Provider-level fallback: apply latest known quota to sibling rows on same provider.
        for (const sibling of state.results) {
          if (sibling.providerKey === r.providerKey && (sibling.usagePercent === undefined || sibling.usagePercent === null)) {
            sibling.usagePercent = quotaPercent
          }
        }
      }
    } finally {
      r.isPinging = false
      state.pendingPings = Math.max(0, state.pendingPings - 1)
    }
  }

  // 📖 Initial ping of all models
  const initialPing = Promise.all(state.results.map(r => pingModel(r)))

  // 📖 Continuous ping loop with dynamic interval (adjustable with W/= keys)
  const schedulePing = () => {
    state.pingIntervalObj = setTimeout(async () => {
      state.lastPingTime = Date.now()

      // 📖 Refresh persisted usage snapshots each cycle so proxy writes appear live in table.
      // 📖 Freshness-aware: stale snapshots (>30m) are excluded and row reverts to undefined.
      for (const r of state.results) {
        const pct = _usageForRow(r.providerKey, r.modelId)
        if (typeof pct === 'number' && Number.isFinite(pct)) {
          r.usagePercent = pct
        } else {
          // If snapshot is now stale or gone, clear the cached value so UI shows N/A.
          r.usagePercent = undefined
        }
      }

      state.results.forEach(r => {
        pingModel(r).catch(() => {
          // Individual ping failures don't crash the loop
        })
      })

      // 📖 Schedule next ping with current interval
      schedulePing()
    }, state.pingInterval)
  }

  // 📖 Start the ping loop
  state.pingIntervalObj = null
  schedulePing()

  await initialPing

  // 📖 Keep interface running forever - user can select anytime or Ctrl+C to exit
  // 📖 The pings continue running in background with dynamic interval
  // 📖 User can press W to decrease interval (faster pings) or = to increase (slower)
  // 📖 Current interval shown in header: "next ping Xs"
}

main().catch((err) => {
  process.stdout.write(ALT_LEAVE)
  console.error(err)
  process.exit(1)
})
