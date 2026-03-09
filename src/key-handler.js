/**
 * @file key-handler.js
 * @description Factory for the main TUI keypress handler.
 *
 * @details
 *   This module encapsulates the full onKeyPress switch used by the TUI,
 *   including settings navigation, overlays, profile management, and
 *   OpenCode/OpenClaw launch actions. It also keeps the live key bindings
 *   aligned with the highlighted letters shown in the table headers.
 *
 *   → Functions:
 *   - `createKeyHandler` — returns the async keypress handler
 *
 * @exports { createKeyHandler }
 */

export function createKeyHandler(ctx) {
  const {
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
    startRecommendAnalysis,
    stopRecommendAnalysis,
    sendFeatureRequest,
    sendBugReport,
    stopUi,
    ping,
    getPingModel,
    TASK_TYPES,
    PRIORITY_TYPES,
    CONTEXT_BUDGETS,
    toFavoriteKey,
    mergedModels,
    apiKey,
    chalk,
    setResults,
    readline,
  } = ctx

  let userSelected = null

  // ─── Settings key test helper ───────────────────────────────────────────────
  // 📖 Fires a single ping to the selected provider to verify the API key works.
  async function testProviderKey(providerKey) {
    const src = sources[providerKey]
    if (!src) return
    const testKey = getApiKey(state.config, providerKey)
    if (!testKey) { state.settingsTestResults[providerKey] = 'fail'; return }

    // 📖 Use the first model in the provider's list for the test ping
    const testModel = src.models[0]?.[0]
    if (!testModel) { state.settingsTestResults[providerKey] = 'fail'; return }

    state.settingsTestResults[providerKey] = 'pending'
    const { code } = await ping(testKey, testModel, providerKey, src.url)
    state.settingsTestResults[providerKey] = code === '200' ? 'ok' : 'fail'
  }

  // 📖 Manual update checker from settings; keeps status visible in maintenance row.
  async function checkUpdatesFromSettings() {
    if (state.settingsUpdateState === 'checking' || state.settingsUpdateState === 'installing') return
    state.settingsUpdateState = 'checking'
    state.settingsUpdateError = null
    const { latestVersion, error } = await checkForUpdateDetailed()
    if (error) {
      state.settingsUpdateState = 'error'
      state.settingsUpdateLatestVersion = null
      state.settingsUpdateError = error
      return
    }
    if (latestVersion) {
      state.settingsUpdateState = 'available'
      state.settingsUpdateLatestVersion = latestVersion
      state.settingsUpdateError = null
      return
    }
    state.settingsUpdateState = 'up-to-date'
    state.settingsUpdateLatestVersion = null
    state.settingsUpdateError = null
  }

  // 📖 Leaves TUI cleanly, then runs npm global update command.
  function launchUpdateFromSettings(latestVersion) {
    if (!latestVersion) return
    state.settingsUpdateState = 'installing'
    stopUi({ resetRawMode: true })
    runUpdate(latestVersion)
  }

  return async (str, key) => {
    if (!key) return

    // 📖 Profile save mode: intercept ALL keys while inline name input is active.
    // 📖 Enter → save, Esc → cancel, Backspace → delete char, printable → append to buffer.
    if (state.profileSaveMode) {
      if (key.ctrl && key.name === 'c') { exit(0); return }
      if (key.name === 'escape') {
        // 📖 Cancel profile save — discard typed name
        state.profileSaveMode = false
        state.profileSaveBuffer = ''
        return
      }
      if (key.name === 'return') {
        // 📖 Confirm profile save — persist current TUI settings under typed name
        const name = state.profileSaveBuffer.trim()
        if (name.length > 0) {
          saveAsProfile(state.config, name, {
            tierFilter: TIER_CYCLE[state.tierFilterMode],
            sortColumn: state.sortColumn,
            sortAsc: state.sortDirection === 'asc',
            pingInterval: state.pingInterval,
          })
          setActiveProfile(state.config, name)
          state.activeProfile = name
          saveConfig(state.config)
        }
        state.profileSaveMode = false
        state.profileSaveBuffer = ''
        return
      }
      if (key.name === 'backspace') {
        state.profileSaveBuffer = state.profileSaveBuffer.slice(0, -1)
        return
      }
      // 📖 Append printable characters (str is the raw character typed)
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        state.profileSaveBuffer += str
      }
      return
    }

    // 📖 Feature Request overlay: intercept ALL keys while overlay is active.
    // 📖 Enter → send to Discord, Esc → cancel, Backspace → delete char, printable → append to buffer.
    if (state.featureRequestOpen) {
      if (key.ctrl && key.name === 'c') { exit(0); return }

      if (key.name === 'escape') {
        // 📖 Cancel feature request — close overlay
        state.featureRequestOpen = false
        state.featureRequestBuffer = ''
        state.featureRequestStatus = 'idle'
        state.featureRequestError = null
        return
      }

      if (key.name === 'return') {
        // 📖 Send feature request to Discord webhook
        const message = state.featureRequestBuffer.trim()
        if (message.length > 0 && state.featureRequestStatus !== 'sending') {
          state.featureRequestStatus = 'sending'
          const result = await sendFeatureRequest(message)
          if (result.success) {
            // 📖 Success — show confirmation briefly, then close overlay after 3 seconds
            state.featureRequestStatus = 'success'
            setTimeout(() => {
              state.featureRequestOpen = false
              state.featureRequestBuffer = ''
              state.featureRequestStatus = 'idle'
              state.featureRequestError = null
            }, 3000)
          } else {
            // 📖 Error — show error message, keep overlay open
            state.featureRequestStatus = 'error'
            state.featureRequestError = result.error || 'Unknown error'
          }
        }
        return
      }

      if (key.name === 'backspace') {
        // 📖 Don't allow editing while sending or after success
        if (state.featureRequestStatus === 'sending' || state.featureRequestStatus === 'success') return
        state.featureRequestBuffer = state.featureRequestBuffer.slice(0, -1)
        // 📖 Clear error status when user starts editing again
        if (state.featureRequestStatus === 'error') {
          state.featureRequestStatus = 'idle'
          state.featureRequestError = null
        }
        return
      }

      // 📖 Append printable characters (str is the raw character typed)
      // 📖 Limit to 500 characters (Discord embed description limit)
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        // 📖 Don't allow editing while sending or after success
        if (state.featureRequestStatus === 'sending' || state.featureRequestStatus === 'success') return
        if (state.featureRequestBuffer.length < 500) {
          state.featureRequestBuffer += str
          // 📖 Clear error status when user starts editing again
          if (state.featureRequestStatus === 'error') {
            state.featureRequestStatus = 'idle'
            state.featureRequestError = null
          }
        }
      }
      return
    }

    // 📖 Bug Report overlay: intercept ALL keys while overlay is active.
    // 📖 Enter → send to Discord, Esc → cancel, Backspace → delete char, printable → append to buffer.
    if (state.bugReportOpen) {
      if (key.ctrl && key.name === 'c') { exit(0); return }

      if (key.name === 'escape') {
        // 📖 Cancel bug report — close overlay
        state.bugReportOpen = false
        state.bugReportBuffer = ''
        state.bugReportStatus = 'idle'
        state.bugReportError = null
        return
      }

      if (key.name === 'return') {
        // 📖 Send bug report to Discord webhook
        const message = state.bugReportBuffer.trim()
        if (message.length > 0 && state.bugReportStatus !== 'sending') {
          state.bugReportStatus = 'sending'
          const result = await sendBugReport(message)
          if (result.success) {
            // 📖 Success — show confirmation briefly, then close overlay after 3 seconds
            state.bugReportStatus = 'success'
            setTimeout(() => {
              state.bugReportOpen = false
              state.bugReportBuffer = ''
              state.bugReportStatus = 'idle'
              state.bugReportError = null
            }, 3000)
          } else {
            // 📖 Error — show error message, keep overlay open
            state.bugReportStatus = 'error'
            state.bugReportError = result.error || 'Unknown error'
          }
        }
        return
      }

      if (key.name === 'backspace') {
        // 📖 Don't allow editing while sending or after success
        if (state.bugReportStatus === 'sending' || state.bugReportStatus === 'success') return
        state.bugReportBuffer = state.bugReportBuffer.slice(0, -1)
        // 📖 Clear error status when user starts editing again
        if (state.bugReportStatus === 'error') {
          state.bugReportStatus = 'idle'
          state.bugReportError = null
        }
        return
      }

      // 📖 Append printable characters (str is the raw character typed)
      // 📖 Limit to 500 characters (Discord embed description limit)
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        // 📖 Don't allow editing while sending or after success
        if (state.bugReportStatus === 'sending' || state.bugReportStatus === 'success') return
        if (state.bugReportBuffer.length < 500) {
          state.bugReportBuffer += str
          // 📖 Clear error status when user starts editing again
          if (state.bugReportStatus === 'error') {
            state.bugReportStatus = 'idle'
            state.bugReportError = null
          }
        }
      }
      return
    }

    // 📖 Help overlay: full keyboard navigation + key swallowing while overlay is open.
    if (state.helpVisible) {
      const pageStep = Math.max(1, (state.terminalRows || 1) - 2)
      if (key.name === 'escape' || key.name === 'k') {
        state.helpVisible = false
        return
      }
      if (key.name === 'up') { state.helpScrollOffset = Math.max(0, state.helpScrollOffset - 1); return }
      if (key.name === 'down') { state.helpScrollOffset += 1; return }
      if (key.name === 'pageup') { state.helpScrollOffset = Math.max(0, state.helpScrollOffset - pageStep); return }
      if (key.name === 'pagedown') { state.helpScrollOffset += pageStep; return }
      if (key.name === 'home') { state.helpScrollOffset = 0; return }
      if (key.name === 'end') { state.helpScrollOffset = Number.MAX_SAFE_INTEGER; return }
      if (key.ctrl && key.name === 'c') { exit(0); return }
      return
    }

    // 📖 Log page overlay: full keyboard navigation + key swallowing while overlay is open.
    if (state.logVisible) {
      const pageStep = Math.max(1, (state.terminalRows || 1) - 2)
      if (key.name === 'escape' || key.name === 'x') {
        state.logVisible = false
        return
      }
      if (key.name === 'up') { state.logScrollOffset = Math.max(0, state.logScrollOffset - 1); return }
      if (key.name === 'down') { state.logScrollOffset += 1; return }
      if (key.name === 'pageup') { state.logScrollOffset = Math.max(0, state.logScrollOffset - pageStep); return }
      if (key.name === 'pagedown') { state.logScrollOffset += pageStep; return }
      if (key.name === 'home') { state.logScrollOffset = 0; return }
      if (key.name === 'end') { state.logScrollOffset = Number.MAX_SAFE_INTEGER; return }
      if (key.ctrl && key.name === 'c') { exit(0); return }
      return
    }

    // 📖 Smart Recommend overlay: full keyboard handling while overlay is open.
    if (state.recommendOpen) {
      if (key.ctrl && key.name === 'c') { exit(0); return }

      if (state.recommendPhase === 'questionnaire') {
        const questions = [
          { options: Object.keys(TASK_TYPES), answerKey: 'taskType' },
          { options: Object.keys(PRIORITY_TYPES), answerKey: 'priority' },
          { options: Object.keys(CONTEXT_BUDGETS), answerKey: 'contextBudget' },
        ]
        const q = questions[state.recommendQuestion]

        if (key.name === 'escape') {
          // 📖 Cancel recommend — close overlay
          state.recommendOpen = false
          state.recommendPhase = 'questionnaire'
          state.recommendQuestion = 0
          state.recommendCursor = 0
          state.recommendAnswers = { taskType: null, priority: null, contextBudget: null }
          return
        }
        if (key.name === 'up') {
          state.recommendCursor = state.recommendCursor > 0 ? state.recommendCursor - 1 : q.options.length - 1
          return
        }
        if (key.name === 'down') {
          state.recommendCursor = state.recommendCursor < q.options.length - 1 ? state.recommendCursor + 1 : 0
          return
        }
        if (key.name === 'return') {
          // 📖 Record answer and advance to next question or start analysis
          state.recommendAnswers[q.answerKey] = q.options[state.recommendCursor]
          if (state.recommendQuestion < questions.length - 1) {
            state.recommendQuestion++
            state.recommendCursor = 0
          } else {
            // 📖 All questions answered — start analysis phase
            startRecommendAnalysis()
          }
          return
        }
        return // 📖 Swallow all other keys
      }

      if (state.recommendPhase === 'analyzing') {
        if (key.name === 'escape') {
          // 📖 Cancel analysis — stop timers, return to questionnaire
          stopRecommendAnalysis()
          state.recommendOpen = false
          state.recommendPhase = 'questionnaire'
          state.recommendQuestion = 0
          state.recommendCursor = 0
          state.recommendAnswers = { taskType: null, priority: null, contextBudget: null }
          return
        }
        return // 📖 Swallow all keys during analysis (except Esc and Ctrl+C)
      }

      if (state.recommendPhase === 'results') {
        if (key.name === 'escape') {
          // 📖 Close results — recommendations stay highlighted in main table
          state.recommendOpen = false
          return
        }
        if (key.name === 'q') {
          // 📖 Start a new search
          state.recommendPhase = 'questionnaire'
          state.recommendQuestion = 0
          state.recommendCursor = 0
          state.recommendAnswers = { taskType: null, priority: null, contextBudget: null }
          state.recommendResults = []
          state.recommendScrollOffset = 0
          return
        }
        if (key.name === 'up') {
          const count = state.recommendResults.length
          if (count === 0) return
          state.recommendCursor = state.recommendCursor > 0 ? state.recommendCursor - 1 : count - 1
          return
        }
        if (key.name === 'down') {
          const count = state.recommendResults.length
          if (count === 0) return
          state.recommendCursor = state.recommendCursor < count - 1 ? state.recommendCursor + 1 : 0
          return
        }
        if (key.name === 'return') {
          // 📖 Select the highlighted recommendation — close overlay, jump cursor to it
          const rec = state.recommendResults[state.recommendCursor]
          if (rec) {
            const recKey = toFavoriteKey(rec.result.providerKey, rec.result.modelId)
            state.recommendOpen = false
            // 📖 Jump to the recommended model in the main table
            const idx = state.visibleSorted.findIndex(r => toFavoriteKey(r.providerKey, r.modelId) === recKey)
            if (idx >= 0) {
              state.cursor = idx
              adjustScrollOffset(state)
            }
          }
          return
        }
        return // 📖 Swallow all other keys
      }

      return // 📖 Catch-all swallow
    }

    // ─── Settings overlay keyboard handling ───────────────────────────────────
    if (state.settingsOpen) {
      const providerKeys = Object.keys(sources)
      const updateRowIdx = providerKeys.length
      // 📖 Profile rows start after update row — one row per saved profile
      const savedProfiles = listProfiles(state.config)
      const profileStartIdx = updateRowIdx + 1
      const maxRowIdx = savedProfiles.length > 0 ? profileStartIdx + savedProfiles.length - 1 : updateRowIdx

      // 📖 Edit/Add-key mode: capture typed characters for the API key
      if (state.settingsEditMode || state.settingsAddKeyMode) {
        if (key.name === 'return') {
          // 📖 Save the new key and exit edit/add mode
          const pk = providerKeys[state.settingsCursor]
          const newKey = state.settingsEditBuffer.trim()
          if (newKey) {
            // 📖 Validate OpenRouter keys start with "sk-or-" to detect corruption
            if (pk === 'openrouter' && !newKey.startsWith('sk-or-')) {
              // 📖 Don't save corrupted keys - show warning and cancel
              state.settingsEditMode = false
              state.settingsAddKeyMode = false
              state.settingsEditBuffer = ''
              state.settingsErrorMsg = '⚠️  OpenRouter keys must start with "sk-or-". Key not saved.'
              setTimeout(() => { state.settingsErrorMsg = null }, 3000)
              return
            }
            if (state.settingsAddKeyMode) {
              // 📖 Add-key mode: append new key (addApiKey handles duplicates/empty)
              addApiKey(state.config, pk, newKey)
            } else {
              // 📖 Edit mode: replace the primary key (string-level)
              state.config.apiKeys[pk] = newKey
            }
            saveConfig(state.config)
          }
          state.settingsEditMode = false
          state.settingsAddKeyMode = false
          state.settingsEditBuffer = ''
        } else if (key.name === 'escape') {
          // 📖 Cancel without saving
          state.settingsEditMode = false
          state.settingsAddKeyMode = false
          state.settingsEditBuffer = ''
        } else if (key.name === 'backspace') {
          state.settingsEditBuffer = state.settingsEditBuffer.slice(0, -1)
        } else if (str && !key.ctrl && !key.meta && str.length === 1) {
          // 📖 Append printable character to buffer
          state.settingsEditBuffer += str
        }
        return
      }

      // 📖 Normal settings navigation
      if (key.name === 'escape' || key.name === 'p') {
        // 📖 Close settings — rebuild results to reflect provider changes
        state.settingsOpen = false
        state.settingsEditMode = false
        state.settingsAddKeyMode = false
        state.settingsEditBuffer = ''
        state.settingsSyncStatus = null  // 📖 Clear sync status on close
        // 📖 Rebuild results: add models from newly enabled providers, remove disabled
        const nextResults = MODELS
          .filter(([,,,,,pk]) => isProviderEnabled(state.config, pk))
          .map(([modelId, label, tier, sweScore, ctx, providerKey], i) => {
            // 📖 Try to reuse existing result to keep ping history
            const existing = state.results.find(r => r.modelId === modelId && r.providerKey === providerKey)
            if (existing) return existing
            return { idx: i + 1, modelId, label, tier, sweScore, ctx, providerKey, status: 'pending', pings: [], httpCode: null, isPinging: false, hidden: false }
          })
        // 📖 Re-index results
        nextResults.forEach((r, i) => { r.idx = i + 1 })
        state.results = nextResults
        setResults(nextResults)
        syncFavoriteFlags(state.results, state.config)
        applyTierFilter()
        const visible = state.results.filter(r => !r.hidden)
        state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
        if (state.cursor >= state.visibleSorted.length) state.cursor = Math.max(0, state.visibleSorted.length - 1)
        adjustScrollOffset(state)
        // 📖 Re-ping all models that were 'noauth' (got 401 without key) but now have a key
        // 📖 This makes the TUI react immediately when a user adds an API key in settings
        const pingModel = getPingModel?.()
        if (pingModel) {
          state.results.forEach(r => {
            if (r.status === 'noauth' && getApiKey(state.config, r.providerKey)) {
              r.status = 'pending'
              r.pings = []
              r.httpCode = null
              r.isPinging = false
              pingModel(r).catch(() => {})
            }
          })
        }
        return
      }

      if (key.name === 'up' && state.settingsCursor > 0) {
        state.settingsCursor--
        return
      }

      if (key.name === 'down' && state.settingsCursor < maxRowIdx) {
        state.settingsCursor++
        return
      }

      if (key.name === 'pageup') {
        const pageStep = Math.max(1, (state.terminalRows || 1) - 2)
        state.settingsCursor = Math.max(0, state.settingsCursor - pageStep)
        return
      }

      if (key.name === 'pagedown') {
        const pageStep = Math.max(1, (state.terminalRows || 1) - 2)
        state.settingsCursor = Math.min(maxRowIdx, state.settingsCursor + pageStep)
        return
      }

      if (key.name === 'home') {
        state.settingsCursor = 0
        return
      }

      if (key.name === 'end') {
        state.settingsCursor = maxRowIdx
        return
      }

      if (key.name === 'return') {
        if (state.settingsCursor === updateRowIdx) {
          if (state.settingsUpdateState === 'available' && state.settingsUpdateLatestVersion) {
            launchUpdateFromSettings(state.settingsUpdateLatestVersion)
            return
          }
          checkUpdatesFromSettings()
          return
        }

        // 📖 Profile row: Enter → load the selected profile (apply its settings live)
        if (state.settingsCursor >= profileStartIdx && savedProfiles.length > 0) {
          const profileIdx = state.settingsCursor - profileStartIdx
          const profileName = savedProfiles[profileIdx]
          if (profileName) {
            const settings = loadProfile(state.config, profileName)
            if (settings) {
              state.sortColumn = settings.sortColumn || 'avg'
              state.sortDirection = settings.sortAsc ? 'asc' : 'desc'
              state.pingInterval = settings.pingInterval || PING_INTERVAL
              if (settings.tierFilter) {
                const tierIdx = TIER_CYCLE.indexOf(settings.tierFilter)
                if (tierIdx >= 0) state.tierFilterMode = tierIdx
              } else {
                state.tierFilterMode = 0
              }
              state.activeProfile = profileName
              syncFavoriteFlags(state.results, state.config)
              applyTierFilter()
              const visible = state.results.filter(r => !r.hidden)
              state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
              saveConfig(state.config)
            }
          }
          return
        }

        // 📖 Enter edit mode for the selected provider's key
        const pk = providerKeys[state.settingsCursor]
        state.settingsEditBuffer = state.config.apiKeys?.[pk] ?? ''
        state.settingsEditMode = true
        return
      }

      if (key.name === 'space') {
        if (state.settingsCursor === updateRowIdx) return
        // 📖 Profile rows don't respond to Space
        if (state.settingsCursor >= profileStartIdx) return

        // 📖 Toggle enabled/disabled for selected provider
        const pk = providerKeys[state.settingsCursor]
        if (!state.config.providers) state.config.providers = {}
        if (!state.config.providers[pk]) state.config.providers[pk] = { enabled: true }
        state.config.providers[pk].enabled = !isProviderEnabled(state.config, pk)
        saveConfig(state.config)
        return
      }

      if (key.name === 't') {
        if (state.settingsCursor === updateRowIdx) return
        // 📖 Profile rows don't respond to T (test key)
        if (state.settingsCursor >= profileStartIdx) return

        // 📖 Test the selected provider's key (fires a real ping)
        const pk = providerKeys[state.settingsCursor]
        testProviderKey(pk)
        return
      }

      if (key.name === 'u') {
        checkUpdatesFromSettings()
        return
      }

      // 📖 Backspace on a profile row → delete that profile
      if (key.name === 'backspace' && state.settingsCursor >= profileStartIdx && savedProfiles.length > 0) {
        const profileIdx = state.settingsCursor - profileStartIdx
        const profileName = savedProfiles[profileIdx]
        if (profileName) {
          deleteProfile(state.config, profileName)
          // 📖 If the deleted profile was active, clear active state
          if (state.activeProfile === profileName) {
            setActiveProfile(state.config, null)
            state.activeProfile = null
          }
          saveConfig(state.config)
          // 📖 Re-clamp cursor after deletion (profile list just got shorter)
          const newProfiles = listProfiles(state.config)
          const newMaxRowIdx = newProfiles.length > 0 ? profileStartIdx + newProfiles.length - 1 : updateRowIdx
          if (state.settingsCursor > newMaxRowIdx) {
            state.settingsCursor = Math.max(0, newMaxRowIdx)
          }
        }
        return
      }

      if (key.ctrl && key.name === 'c') { exit(0); return }

       // 📖 S key: sync FCM provider entries to OpenCode config (merge, don't replace)
        if (key.name === 's' && !key.shift && !key.ctrl) {
          try {
            // 📖 Sync now also ensures proxy is running, so OpenCode can use fcm-proxy immediately.
            const started = await ensureProxyRunning(state.config)
            const result = syncToOpenCode(state.config, sources, mergedModels, {
              proxyPort: started.port,
              proxyToken: started.proxyToken,
              availableModelSlugs: started.availableModelSlugs,
            })
            state.settingsSyncStatus = {
              type: 'success',
              msg: `✅ Synced ${result.providerKey} (${result.modelCount} models), proxy running on :${started.port}`,
            }
        } catch (err) {
          state.settingsSyncStatus = { type: 'error', msg: `❌ Sync failed: ${err.message}` }
        }
        return
      }

      // 📖 R key: restore OpenCode config from backup (opencode.json.bak)
      if (key.name === 'r' && !key.shift && !key.ctrl) {
        try {
          const restored = restoreOpenCodeBackup()
          state.settingsSyncStatus = restored
            ? { type: 'success', msg: '✅ OpenCode config restored from backup' }
            : { type: 'error', msg: '⚠  No backup found (opencode.json.bak)' }
        } catch (err) {
          state.settingsSyncStatus = { type: 'error', msg: `❌ Restore failed: ${err.message}` }
        }
        return
      }

      // 📖 + key: open add-key input (empty buffer) — appends new key on Enter
      if ((str === '+' || key.name === '+') && state.settingsCursor < providerKeys.length) {
        state.settingsEditBuffer = ''      // 📖 Start with empty buffer (not existing key)
        state.settingsAddKeyMode = true    // 📖 Add mode: Enter will append, not replace
        state.settingsEditMode = false
        return
      }

      // 📖 - key: remove one key (last by default) instead of deleting entire provider
      if ((str === '-' || key.name === '-') && state.settingsCursor < providerKeys.length) {
        const pk = providerKeys[state.settingsCursor]
        const removed = removeApiKey(state.config, pk)  // removes last key; collapses array-of-1 to string
        if (removed) {
          saveConfig(state.config)
          const remaining = resolveApiKeys(state.config, pk).length
          const msg = remaining > 0
            ? `✅ Removed one key for ${pk} (${remaining} remaining)`
            : `✅ Removed last API key for ${pk}`
          state.settingsSyncStatus = { type: 'success', msg }
        }
        return
      }

      return // 📖 Swallow all other keys while settings is open
    }

    // 📖 P key: open settings screen
    if (key.name === 'p' && !key.shift) {
      state.settingsOpen = true
      state.settingsCursor = 0
      state.settingsEditMode = false
      state.settingsAddKeyMode = false
      state.settingsEditBuffer = ''
      state.settingsScrollOffset = 0
      return
    }

    // 📖 Q key: open Smart Recommend overlay
    if (key.name === 'q') {
      state.recommendOpen = true
      state.recommendPhase = 'questionnaire'
      state.recommendQuestion = 0
      state.recommendCursor = 0
      state.recommendAnswers = { taskType: null, priority: null, contextBudget: null }
      state.recommendResults = []
      state.recommendScrollOffset = 0
      return
    }

    // 📖 Shift+P: cycle through profiles (or show profile picker)
    if (key.name === 'p' && key.shift) {
      const profiles = listProfiles(state.config)
      if (profiles.length === 0) {
        // 📖 No profiles saved — save current config as 'default' profile
        saveAsProfile(state.config, 'default', {
          tierFilter: TIER_CYCLE[state.tierFilterMode],
          sortColumn: state.sortColumn,
          sortAsc: state.sortDirection === 'asc',
          pingInterval: state.pingInterval,
        })
        setActiveProfile(state.config, 'default')
        state.activeProfile = 'default'
        saveConfig(state.config)
      } else {
        // 📖 Cycle to next profile (or back to null = raw config)
        const currentIdx = state.activeProfile ? profiles.indexOf(state.activeProfile) : -1
        const nextIdx = (currentIdx + 1) % (profiles.length + 1) // +1 for "no profile"
        if (nextIdx === profiles.length) {
          // 📖 Back to raw config (no profile)
          setActiveProfile(state.config, null)
          state.activeProfile = null
          saveConfig(state.config)
        } else {
          const nextProfile = profiles[nextIdx]
          const settings = loadProfile(state.config, nextProfile)
          if (settings) {
            // 📖 Apply profile's TUI settings to live state
            state.sortColumn = settings.sortColumn || 'avg'
            state.sortDirection = settings.sortAsc ? 'asc' : 'desc'
            state.pingInterval = settings.pingInterval || PING_INTERVAL
            if (settings.tierFilter) {
              const tierIdx = TIER_CYCLE.indexOf(settings.tierFilter)
              if (tierIdx >= 0) state.tierFilterMode = tierIdx
            } else {
              state.tierFilterMode = 0
            }
            state.activeProfile = nextProfile
            // 📖 Rebuild favorites from profile data
            syncFavoriteFlags(state.results, state.config)
            applyTierFilter()
            const visible = state.results.filter(r => !r.hidden)
            state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
            state.cursor = 0
            state.scrollOffset = 0
            saveConfig(state.config)
          }
        }
      }
      return
    }

    // 📖 Shift+S: enter profile save mode — inline text prompt for typing a profile name
    if (key.name === 's' && key.shift) {
      state.profileSaveMode = true
      state.profileSaveBuffer = ''
      return
    }

    // 📖 Sorting keys: R=rank, Y=tier, O=origin, M=model, L=latest ping, A=avg ping, S=SWE-bench, C=context, H=health, V=verdict, B=stability, U=uptime, G=usage
    // 📖 T is reserved for tier filter cycling — tier sort moved to Y
    // 📖 D is now reserved for provider filter cycling
    const sortKeys = {
      'r': 'rank', 'y': 'tier', 'o': 'origin', 'm': 'model',
      'l': 'ping', 'a': 'avg', 's': 'swe', 'c': 'ctx', 'h': 'condition', 'v': 'verdict', 'b': 'stability', 'u': 'uptime', 'g': 'usage'
    }

    if (sortKeys[key.name] && !key.ctrl && !key.shift) {
      const col = sortKeys[key.name]
      // 📖 Toggle direction if same column, otherwise reset to asc
      if (state.sortColumn === col) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc'
      } else {
        state.sortColumn = col
        state.sortDirection = 'asc'
      }
      // 📖 Recompute visible sorted list and reset cursor to top to avoid stale index
      const visible = state.results.filter(r => !r.hidden)
      state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
      state.cursor = 0
      state.scrollOffset = 0
      return
    }

    // 📖 F key: toggle favorite on the currently selected row and persist to config.
    if (key.name === 'f') {
      const selected = state.visibleSorted[state.cursor]
      if (!selected) return
      const wasFavorite = selected.isFavorite
      toggleFavoriteModel(state.config, selected.providerKey, selected.modelId)
      syncFavoriteFlags(state.results, state.config)
      applyTierFilter()
      const visible = state.results.filter(r => !r.hidden)
      state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)

      // 📖 UX rule: when unpinning a favorite, jump back to the top of the list.
      if (wasFavorite) {
        state.cursor = 0
        state.scrollOffset = 0
        return
      }

      const selectedKey = toFavoriteKey(selected.providerKey, selected.modelId)
      const newCursor = state.visibleSorted.findIndex(r => toFavoriteKey(r.providerKey, r.modelId) === selectedKey)
      if (newCursor >= 0) state.cursor = newCursor
      else if (state.cursor >= state.visibleSorted.length) state.cursor = Math.max(0, state.visibleSorted.length - 1)
      adjustScrollOffset(state)
      return
    }

    // 📖 J key: open Feature Request overlay (anonymous Discord feedback)
    if (key.name === 'j') {
      state.featureRequestOpen = true
      state.featureRequestBuffer = ''
      state.featureRequestStatus = 'idle'
      state.featureRequestError = null
      return
    }

    // 📖 I key: open Bug Report overlay (anonymous Discord bug reports)
    if (key.name === 'i') {
      state.bugReportOpen = true
      state.bugReportBuffer = ''
      state.bugReportStatus = 'idle'
      state.bugReportError = null
      return
    }

    // 📖 Interval adjustment keys: W=decrease (faster), ==increase (slower)
    // 📖 X was previously used for interval increase but is now reserved for the log page overlay.
    // 📖 Minimum 1s, maximum 60s
    if (key.name === 'w') {
      state.pingInterval = Math.max(1000, state.pingInterval - 1000)
    } else if (str === '=' || key.name === '=') {
      state.pingInterval = Math.min(60000, state.pingInterval + 1000)
    }

    // 📖 Tier toggle key: T = cycle through each individual tier (All → S+ → S → A+ → A → A- → B+ → B → C → All)
    if (key.name === 't') {
      state.tierFilterMode = (state.tierFilterMode + 1) % TIER_CYCLE.length
      applyTierFilter()
      // 📖 Recompute visible sorted list and reset cursor to avoid stale index into new filtered set
      const visible = state.results.filter(r => !r.hidden)
      state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
      state.cursor = 0
      state.scrollOffset = 0
      return
    }

    // 📖 Provider filter key: D = cycle through each provider (All → NIM → Groq → ... → All)
    if (key.name === 'd') {
      state.originFilterMode = (state.originFilterMode + 1) % ORIGIN_CYCLE.length
      applyTierFilter()
      // 📖 Recompute visible sorted list and reset cursor to avoid stale index into new filtered set
      const visible = state.results.filter(r => !r.hidden)
      state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection)
      state.cursor = 0
      state.scrollOffset = 0
      return
    }

    // 📖 Help overlay key: K = toggle help overlay
    if (key.name === 'k') {
      state.helpVisible = !state.helpVisible
      if (state.helpVisible) state.helpScrollOffset = 0
      return
    }

    // 📖 Mode toggle key: Z = cycle through modes (CLI → Desktop → OpenClaw)
    if (key.name === 'z') {
      const modeOrder = ['opencode', 'opencode-desktop', 'openclaw']
      const currentIndex = modeOrder.indexOf(state.mode)
      const nextIndex = (currentIndex + 1) % modeOrder.length
      state.mode = modeOrder[nextIndex]
      return
    }

    // 📖 X key: toggle the log page overlay (shows recent requests from request-log.jsonl).
    // 📖 NOTE: X was previously used for ping-interval increase; that binding moved to '='.
    if (key.name === 'x') {
      state.logVisible = !state.logVisible
      if (state.logVisible) state.logScrollOffset = 0
      return
    }

    if (key.name === 'up') {
      // 📖 Main list wrap navigation: top -> bottom on Up.
      const count = state.visibleSorted.length
      if (count === 0) return
      state.cursor = state.cursor > 0 ? state.cursor - 1 : count - 1
      adjustScrollOffset(state)
      return
    }

    if (key.name === 'down') {
      // 📖 Main list wrap navigation: bottom -> top on Down.
      const count = state.visibleSorted.length
      if (count === 0) return
      state.cursor = state.cursor < count - 1 ? state.cursor + 1 : 0
      adjustScrollOffset(state)
      return
    }

    if (key.name === 'c' && key.ctrl) { // Ctrl+C
      exit(0)
      return
    }

    if (key.name === 'return') { // Enter
      // 📖 Use the cached visible+sorted array — guaranteed to match what's on screen
      const selected = state.visibleSorted[state.cursor]
      if (!selected) return // 📖 Guard: empty visible list (all filtered out)
      // 📖 Allow selecting ANY model (even timeout/down) - user knows what they're doing
      userSelected = { modelId: selected.modelId, label: selected.label, tier: selected.tier, providerKey: selected.providerKey }

      // 📖 Stop everything and act on selection immediately
      readline.emitKeypressEvents(process.stdin)
      process.stdin.setRawMode(true)
      stopUi()

      // 📖 Show selection with status
      if (selected.status === 'timeout') {
        console.log(chalk.yellow(`  ⚠ Selected: ${selected.label} (currently timing out)`))
      } else if (selected.status === 'down') {
        console.log(chalk.red(`  ⚠ Selected: ${selected.label} (currently down)`))
      } else {
        console.log(chalk.cyan(`  ✓ Selected: ${selected.label}`))
      }
      console.log()

      // 📖 Warn if no API key is configured for the selected model's provider
      if (state.mode !== 'openclaw') {
        const selectedApiKey = getApiKey(state.config, selected.providerKey)
        if (!selectedApiKey) {
          console.log(chalk.yellow(`  Warning: No API key configured for ${selected.providerKey}.`))
          console.log(chalk.yellow(`  OpenCode may not be able to use ${selected.label}.`))
          console.log(chalk.dim(`  Set ${ENV_VAR_NAMES[selected.providerKey] || selected.providerKey.toUpperCase() + '_API_KEY'} or configure via settings (P key).`))
          console.log()
        }
      }

      // 📖 Dispatch to the correct integration based on active mode
      if (state.mode === 'openclaw') {
        await startOpenClaw(userSelected, apiKey)
      } else if (state.mode === 'opencode-desktop') {
        await startOpenCodeDesktop(userSelected, state.config)
      } else {
        const topology = buildProxyTopologyFromConfig(state.config)
        if (topology.accounts.length === 0) {
          console.log(chalk.yellow('  No API keys found for proxy model catalog. Falling back to direct flow.'))
          console.log()
          await startOpenCode(userSelected, state.config)
        } else {
          await startProxyAndLaunch(userSelected, state.config)
        }
      }
      process.exit(0)
    }
  }
}
