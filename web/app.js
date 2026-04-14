/**
 * @file web/app.js — V3 Full-feature Web Dashboard Client
 * Features: SSE, Favorites, Tool Switcher, Command Palette, Smart Recommend,
 *           Changelog, Help, Feedback, Ping Cadence, Export, Analytics
 */

// ─── State ───────────────────────────────────────────────────────────────────
let models = []
let sortColumn = 'avg', sortDirection = 'asc'
let filterTier = 'all', filterStatus = 'all', filterProvider = 'all', filterFav = 'all'
let searchQuery = '', selectedModelId = null, eventSource = null
let updateCount = 0, configData = null, revealedKeys = new Set()
let currentView = 'dashboard', favorites = new Set()
let activeTool = 'opencode', pingCadence = 10000

const TOOLS = [
  { id: 'opencode', label: 'OpenCode CLI', icon: '📦' },
  { id: 'opencode-desktop', label: 'OpenCode Desktop', icon: '📦' },
  { id: 'openclaw', label: 'OpenClaw', icon: '🦞' },
  { id: 'crush', label: 'Crush', icon: '💘' },
  { id: 'goose', label: 'Goose', icon: '🪿' },
  { id: 'aider', label: 'Aider', icon: '🛠' },
  { id: 'qwen', label: 'Qwen Code', icon: '🐉' },
  { id: 'openhands', label: 'OpenHands', icon: '🤲' },
  { id: 'amp', label: 'Amp', icon: '⚡' },
  { id: 'rovo', label: 'Rovo', icon: '🦘' },
  { id: 'gemini', label: 'Gemini CLI', icon: '♊' },
]

const CADENCES = [2000, 5000, 10000, 30000]
const CADENCE_LABELS = { 2000: '2s', 5000: '5s', 10000: '10s', 30000: '30s' }

const CMD_ACTIONS = [
  { icon: '📊', label: 'Go to Dashboard', shortcut: '1', action: () => switchView('dashboard') },
  { icon: '⚙️', label: 'Go to Settings', shortcut: '2', action: () => switchView('settings') },
  { icon: '📈', label: 'Go to Analytics', shortcut: '3', action: () => switchView('analytics') },
  { icon: '🎯', label: 'Smart Recommend', shortcut: '4', action: () => switchView('recommend') },
  { icon: '📜', label: 'View Changelog', shortcut: '5', action: () => switchView('changelog') },
  { icon: '🌙', label: 'Toggle Theme', shortcut: 'G', action: toggleTheme },
  { icon: '📤', label: 'Export Data', shortcut: 'E', action: () => { $('#export-modal').hidden = false } },
  { icon: '❓', label: 'Keyboard Shortcuts', shortcut: 'K', action: () => { $('#help-modal').hidden = false } },
  { icon: '📝', label: 'Send Feedback', shortcut: 'I', action: () => { $('#feedback-modal').hidden = false } },
  { icon: '⭐', label: 'Show Favorites Only', shortcut: 'F', action: toggleFavFilter },
  { icon: '🔄', label: 'Cycle Tool Mode', shortcut: 'Z', action: cycleToolMode },
  { icon: '⏱️', label: 'Change Ping Speed', shortcut: 'W', action: cyclePingCadence },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $ = s => document.querySelector(s)
const $$ = s => document.querySelectorAll(s)
const escapeHtml = s => s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''
const TIER_RANKS = { 'S+':0,'S':1,'A+':2,'A':3,'A-':4,'B+':5,'B':6,'C':7 }
const tierRank = t => TIER_RANKS[t] ?? 99
const VERDICT_RANKS = { 'Perfect':0,'Normal':1,'Slow':2,'Spiky':3,'Very Slow':4,'Overloaded':5,'Unstable':6,'Not Active':7,'Pending':8 }
const verdictRank = v => VERDICT_RANKS[v] ?? 99
const parseSwe = s => s && s !== '—' ? parseFloat(s.replace('%','')) || 0 : 0
const parseCtx = c => { if (!c || c === '—') return 0; const s=c.toLowerCase(); if (s.includes('m')) return parseFloat(s)*1000; if (s.includes('k')) return parseFloat(s); return 0 }

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' }
  const toast = document.createElement('div')
  toast.className = `toast toast--${type}`
  toast.innerHTML = `<span class="toast__icon">${icons[type]||'📌'}</span><span class="toast__message">${escapeHtml(message)}</span><button class="toast__close">&times;</button>`
  $('#toast-container').appendChild(toast)
  const dismiss = () => { toast.classList.add('toast--exiting'); setTimeout(() => toast.remove(), 300) }
  toast.querySelector('.toast__close').onclick = dismiss
  setTimeout(dismiss, duration)
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (eventSource) eventSource.close()
  eventSource = new EventSource('/api/events')
  eventSource.onmessage = (e) => {
    try {
      models = JSON.parse(e.data); updateCount++
      if (currentView === 'dashboard') { renderTable(); updateStats() }
      if (currentView === 'analytics') renderAnalytics()
      if (updateCount === 1) populateProviderFilter()
      if (selectedModelId) updateDetailPanel()
    } catch (err) { console.error('SSE parse error:', err) }
  }
  eventSource.onerror = () => setTimeout(connectSSE, 3000)
}

// ─── Init Favorites ──────────────────────────────────────────────────────────
async function loadFavorites() {
  try {
    const r = await fetch('/api/favorites')
    const d = await r.json()
    favorites = new Set(d.favorites || [])
  } catch { /* ignore */ }
}

async function toggleFavorite(modelId) {
  const isFav = favorites.has(modelId)
  try {
    await fetch('/api/favorites', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ modelId, favorite: !isFav }) })
    if (isFav) favorites.delete(modelId); else favorites.add(modelId)
    renderTable(); updateStats()
    showToast(isFav ? 'Removed from favorites' : 'Added to favorites', 'success')
  } catch { showToast('Failed to update favorite', 'error') }
}

function toggleFavFilter() {
  filterFav = filterFav === 'all' ? 'favorites' : 'all'
  $$('.fav-btn').forEach(b => b.classList.toggle('fav-btn--active', b.dataset.fav === filterFav))
  renderTable()
}

// ─── View Navigation ─────────────────────────────────────────────────────────
function switchView(viewId) {
  currentView = viewId
  $$('.view').forEach(v => v.classList.add('view--hidden'))
  $(`#view-${viewId}`)?.classList.remove('view--hidden')
  $$('.sidebar__nav-item[data-view]').forEach(n => n.classList.remove('sidebar__nav-item--active'))
  $(`#nav-${viewId}`)?.classList.add('sidebar__nav-item--active')
  if (viewId === 'settings') loadSettingsPage()
  if (viewId === 'analytics') renderAnalytics()
  if (viewId === 'changelog') loadChangelog()
}

$$('.sidebar__nav-item[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)))
$('#settings-btn')?.addEventListener('click', () => switchView('settings'))

// ─── Rendering ───────────────────────────────────────────────────────────────
function getFilteredModels() {
  let f = [...models]
  if (filterTier !== 'all') f = f.filter(m => m.tier === filterTier)
  if (filterStatus !== 'all') f = f.filter(m => filterStatus === 'up' ? m.status === 'up' : filterStatus === 'down' ? (m.status === 'down' || m.status === 'timeout') : m.status === 'pending')
  if (filterProvider !== 'all') f = f.filter(m => m.providerKey === filterProvider)
  if (filterFav === 'favorites') f = f.filter(m => favorites.has(m.modelId))
  if (searchQuery) { const q = searchQuery.toLowerCase(); f = f.filter(m => m.label.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q) || m.origin.toLowerCase().includes(q) || m.tier.toLowerCase().includes(q)) }
  f.sort((a,b) => { let c=0; const col=sortColumn
    if (col==='idx') c=a.idx-b.idx; else if (col==='tier') c=tierRank(a.tier)-tierRank(b.tier)
    else if (col==='label') c=a.label.localeCompare(b.label); else if (col==='origin') c=a.origin.localeCompare(b.origin)
    else if (col==='sweScore') c=parseSwe(a.sweScore)-parseSwe(b.sweScore)
    else if (col==='ctx') c=parseCtx(a.ctx)-parseCtx(b.ctx)
    else if (col==='latestPing') c=(a.latestPing??Infinity)-(b.latestPing??Infinity)
    else if (col==='avg') c=(a.avg===Infinity?99999:a.avg)-(b.avg===Infinity?99999:b.avg)
    else if (col==='stability') c=(a.stability??-1)-(b.stability??-1)
    else if (col==='verdict') c=verdictRank(a.verdict)-verdictRank(b.verdict)
    else if (col==='uptime') c=(a.uptime??0)-(b.uptime??0)
    return sortDirection==='asc'?c:-c })
  return f
}

function renderTable() {
  const filtered = getFilteredModels()
  const tbody = $('#table-body')
  if (!filtered.length) { tbody.innerHTML = `<tr class="loading-row"><td colspan="14"><div class="loading-spinner"><span style="font-size:24px">🔍</span><span>No models match your filters</span></div></td></tr>`; return }
  const online = filtered.filter(m => m.status==='up' && m.avg!==Infinity && m.avg<99000)
  const top3 = [...online].sort((a,b)=>a.avg-b.avg).slice(0,3).map(m=>m.modelId)
  tbody.innerHTML = filtered.map((m,i) => {
    const ri = top3.indexOf(m.modelId)
    const rc = ri===0?'rank-1':ri===1?'rank-2':ri===2?'rank-3':''
    const medal = ri===0?'🥇':ri===1?'🥈':ri===2?'🥉':''
    const isFav = favorites.has(m.modelId)
    return `<tr class="${rc}" data-model-id="${m.modelId}">
      <td><span class="fav-star ${isFav?'fav-star--active':''}" data-fav-id="${m.modelId}">${isFav?'★':'☆'}</span></td>
      <td class="td--rank">${medal||(i+1)}</td>
      <td>${tierBadge(m.tier)}</td>
      <td><div class="model-name"><span class="status-dot status-dot--${m.status}"></span>${escapeHtml(m.label)}${!m.hasApiKey&&!m.cliOnly?'<span class="no-key-badge">🔑 NO KEY</span>':''}</div><div class="model-id">${escapeHtml(m.modelId)}</div></td>
      <td><span class="provider-pill">${escapeHtml(m.origin)}</span></td>
      <td class="swe-score ${sweClass(m.sweScore)}">${m.sweScore||'—'}</td>
      <td class="ctx-value">${m.ctx||'—'}</td>
      <td class="ping-value ${pingClass(m.latestPing)}">${formatPing(m.latestPing,m.latestCode)}</td>
      <td class="ping-value ${pingClass(m.avg)}">${formatAvg(m.avg)}</td>
      <td class="td--stability">${stabilityCell(m.stability)}</td>
      <td>${verdictBadge(m.verdict,m.httpCode)}</td>
      <td class="td--uptime"><span class="uptime-value">${m.uptime>0?m.uptime+'%':'—'}</span></td>
      <td class="td--sparkline">${sparkline(m.pingHistory)}</td>
      <td><div class="row-actions"><button class="row-action-btn row-action-btn--launch" data-launch-id="${m.modelId}" title="Launch">🚀</button></div></td>
    </tr>`
  }).join('')

  tbody.querySelectorAll('.fav-star').forEach(s => s.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(s.dataset.favId) }))
  tbody.querySelectorAll('.row-action-btn--launch').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); launchModel(b.dataset.launchId) }))
  tbody.querySelectorAll('tr[data-model-id]').forEach(r => r.addEventListener('click', () => { selectedModelId = r.dataset.modelId; showDetailPanel(selectedModelId) }))
}

// ─── Cell Renderers ──────────────────────────────────────────────────────────
function tierBadge(t) { return `<span class="tier-badge tier-badge--${t.replace('+','plus').replace('-','minus').toLowerCase()}">${t}</span>` }
function sweClass(s) { const v=parseSwe(s); return v>=65?'swe-high':v>=40?'swe-mid':'swe-low' }
function pingClass(ms) { if (ms==null||ms===Infinity) return 'ping-none'; return ms<500?'ping-fast':ms<1500?'ping-medium':'ping-slow' }
function formatPing(ms,code) { if (ms==null) return '<span class="ping-none">—</span>'; if (code==='429') return '<span class="ping-slow">429</span>'; if (code==='000') return '<span class="ping-slow">TIMEOUT</span>'; return `${ms}ms` }
function formatAvg(avg) { if (avg==null||avg===Infinity||avg>99000) return '<span class="ping-none">—</span>'; return `${avg}ms` }
function stabilityCell(s) { if (s==null||s<0) return '<span class="ping-none">—</span>'; const c=s>=70?'high':s>=40?'mid':'low'; return `<div class="stability-cell"><div class="stability-bar"><div class="stability-bar__fill stability-bar__fill--${c}" style="width:${s}%"></div></div><span class="stability-value">${s}</span></div>` }
function verdictBadge(v,hc) { if (!v) return '<span class="verdict-badge verdict--pending">Pending</span>'; if (hc==='429') return '<span class="verdict-badge verdict--ratelimited">⚠️ Rate Limited</span>'; const m={'perfect':'perfect','normal':'normal','slow':'slow','spiky':'spiky','veryslow':'veryslow','overloaded':'overloaded','unstable':'unstable','notactive':'notactive','pending':'pending'}; return `<span class="verdict-badge verdict--${m[v.toLowerCase().replace(/\s+/g,'')]||'pending'}">${v}</span>` }
function sparkline(h) { if (!h||h.length<2) return ''; const v=h.filter(p=>p.code==='200'||p.code==='401'); if (v.length<2) return ''; const vals=v.map(p=>p.ms),max=Math.max(...vals,1),min=Math.min(...vals,0),range=max-min||1,w=80,ht=22,step=w/(vals.length-1); const pts=vals.map((val,i)=>`${(i*step).toFixed(1)},${(ht-((val-min)/range)*(ht-4)-2).toFixed(1)}`).join(' '); const last=vals[vals.length-1],color=last<500?'#00ff88':last<1500?'#ffaa00':'#ff4444'; return `<svg class="sparkline-svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}"><polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" points="${pts}" opacity="0.8"/></svg>` }

// ─── Stats ───────────────────────────────────────────────────────────────────
function updateStats() {
  const total=models.length, online=models.filter(m=>m.status==='up').length
  const onP=models.filter(m=>m.status==='up'&&m.avg!==Infinity&&m.avg<99000)
  const avg=onP.length?Math.round(onP.reduce((s,m)=>s+m.avg,0)/onP.length):null
  const fastest=[...onP].sort((a,b)=>a.avg-b.avg)[0]
  const providers=new Set(models.map(m=>m.providerKey)).size
  $('#stat-total-value').textContent = total
  $('#stat-online-value').textContent = online
  $('#stat-avg-value').textContent = avg!=null?`${avg}ms`:'—'
  $('#stat-best-value').textContent = fastest?fastest.label:'—'
  $('#stat-favorites-value').textContent = favorites.size
  $('#stat-providers-value').textContent = providers
}

function populateProviderFilter() {
  const providers=[...new Set(models.map(m=>m.providerKey))].sort()
  const origins={}; models.forEach(m=>{origins[m.providerKey]=m.origin})
  $('#provider-filter').innerHTML = '<option value="all">All Providers</option>' + providers.map(p=>`<option value="${p}">${origins[p]} (${models.filter(m=>m.providerKey===p).length})</option>`).join('')
}

// ─── Detail Panel ────────────────────────────────────────────────────────────
function showDetailPanel(modelId) {
  const m = models.find(x=>x.modelId===modelId); if (!m) return
  $('#detail-panel').removeAttribute('hidden')
  $('#detail-title').textContent = m.label
  updateDetailPanel()
}

function updateDetailPanel() {
  const m=models.find(x=>x.modelId===selectedModelId); if (!m) return
  const isFav = favorites.has(m.modelId)
  $('#detail-fav').textContent = isFav ? '★ Favorited' : '☆ Favorite'
  $('#detail-body').innerHTML = [
    ['Model ID', `<span style="font-size:11px;word-break:break-all">${escapeHtml(m.modelId)}</span>`],
    ['Provider', escapeHtml(m.origin)], ['Tier', tierBadge(m.tier)],
    ['SWE-bench Score', `<span class="swe-score ${sweClass(m.sweScore)}">${m.sweScore||'—'}</span>`],
    ['Context Window', m.ctx||'—'], ['Status', `<span class="status-dot status-dot--${m.status}"></span>${m.status}`],
    ['Latest Ping', `<span class="${pingClass(m.latestPing)}">${formatPing(m.latestPing,m.latestCode)}</span>`],
    ['Average', `<span class="${pingClass(m.avg)}">${formatAvg(m.avg)}</span>`],
    ['P95', m.p95!=null&&m.p95!==Infinity?m.p95+'ms':'—'],
    ['Jitter (σ)', m.jitter!=null&&m.jitter!==Infinity?m.jitter+'ms':'—'],
    ['Stability', stabilityCell(m.stability)], ['Verdict', verdictBadge(m.verdict,m.httpCode)],
    ['Uptime', m.uptime>0?m.uptime+'%':'—'], ['Ping Count', m.pingCount],
    ['API Key', m.hasApiKey?'✅ Configured':'❌ Missing'],
  ].map(([l,v])=>`<div class="detail-stat"><span class="detail-stat__label">${l}</span><span class="detail-stat__value">${v}</span></div>`).join('')
}

$('#detail-close')?.addEventListener('click', () => { $('#detail-panel').hidden = true; selectedModelId = null })
$('#detail-launch')?.addEventListener('click', () => { if (selectedModelId) launchModel(selectedModelId) })
$('#detail-fav')?.addEventListener('click', () => { if (selectedModelId) toggleFavorite(selectedModelId) })

// ─── Tool Switcher ───────────────────────────────────────────────────────────
function setActiveTool(toolId) {
  const tool = TOOLS.find(t=>t.id===toolId); if (!tool) return
  activeTool = toolId
  $('#tool-switcher-icon').textContent = tool.icon
  $('#tool-switcher-name').textContent = tool.label
  $$('.tool-switcher__option').forEach(o => o.classList.toggle('tool-switcher__option--active', o.dataset.tool===toolId))
  $('#tool-switcher-dropdown').hidden = true
  showToast(`Tool: ${tool.icon} ${tool.label}`, 'info')
}

function cycleToolMode() {
  const idx = TOOLS.findIndex(t=>t.id===activeTool)
  setActiveTool(TOOLS[(idx+1)%TOOLS.length].id)
}

$('#tool-switcher-btn')?.addEventListener('click', () => { const d=$('#tool-switcher-dropdown'); d.hidden=!d.hidden })
$$('.tool-switcher__option').forEach(o => o.addEventListener('click', () => setActiveTool(o.dataset.tool)))
document.addEventListener('click', e => { if (!e.target.closest('.tool-switcher')) $('#tool-switcher-dropdown').hidden = true })

async function launchModel(modelId) {
  const m = models.find(x=>x.modelId===modelId); if (!m) return
  const tool = TOOLS.find(t=>t.id===activeTool)
  navigator.clipboard.writeText(m.modelId).catch(()=>{})
  
  showToast(`🚀 Launching ${m.label} in ${tool.label}...`, 'info', 3000)
  
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, toolId: activeTool })
    })
    if (!res.ok) throw new Error(await res.text())
    showToast(`✅ Launched successfully! Check terminal/app.`, 'success', 3000)
  } catch (err) {
    showToast(`❌ Launch failed: ${err.message}`, 'error', 5000)
  }
}

// ─── Ping Cadence ────────────────────────────────────────────────────────────
async function cyclePingCadence() {
  const idx = CADENCES.indexOf(pingCadence)
  const next = CADENCES[(idx+1)%CADENCES.length]
  try {
    await fetch('/api/ping-cadence', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({interval:next}) })
    pingCadence = next
    $('#ping-cadence-label').textContent = CADENCE_LABELS[next]
    showToast(`Ping interval: ${CADENCE_LABELS[next]}`, 'info')
  } catch { showToast('Failed to change ping speed', 'error') }
}
$('#ping-cadence-btn')?.addEventListener('click', cyclePingCadence)

// ─── Command Palette ─────────────────────────────────────────────────────────
let cmdSelectedIdx = 0

function openCmdPalette() { $('#cmd-palette-modal').hidden = false; $('#cmd-palette-input').value = ''; $('#cmd-palette-input').focus(); renderCmdResults('') }
function closeCmdPalette() { $('#cmd-palette-modal').hidden = true }

function renderCmdResults(query) {
  const q = query.toLowerCase()
  const filtered = CMD_ACTIONS.filter(a => a.label.toLowerCase().includes(q))
  cmdSelectedIdx = 0
  $('#cmd-palette-results').innerHTML = filtered.map((a,i) =>
    `<div class="cmd-item ${i===0?'cmd-item--selected':''}" data-cmd-idx="${i}">
      <span class="cmd-item__icon">${a.icon}</span>
      <span class="cmd-item__label">${a.label}</span>
      ${a.shortcut?`<span class="cmd-item__shortcut">${a.shortcut}</span>`:''}
    </div>`
  ).join('') || '<div class="cmd-item"><span class="cmd-item__label" style="color:var(--color-text-dim)">No results</span></div>'

  $$('.cmd-item[data-cmd-idx]').forEach(el => {
    el.addEventListener('click', () => { const act = filtered[parseInt(el.dataset.cmdIdx)]; if (act) { closeCmdPalette(); act.action() } })
  })
}

$('#cmd-palette-input')?.addEventListener('input', e => renderCmdResults(e.target.value))
$('#cmd-palette-modal')?.addEventListener('click', e => { if (e.target === $('#cmd-palette-modal')) closeCmdPalette() })
$('#cmd-palette-btn')?.addEventListener('click', openCmdPalette)

// ─── Smart Recommend ─────────────────────────────────────────────────────────
let wizardAnswers = {}

function setupWizard() {
  const steps = [['wizard-task-type',1], ['wizard-priority',2], ['wizard-tool',3]]
  steps.forEach(([id, step]) => {
    $(`#${id}`)?.querySelectorAll('.wizard-option').forEach(opt => {
      opt.addEventListener('click', () => {
        opt.parentElement.querySelectorAll('.wizard-option').forEach(o => o.classList.remove('wizard-option--selected'))
        opt.classList.add('wizard-option--selected')
        wizardAnswers[`step${step}`] = opt.dataset.value
        setTimeout(() => {
          $(`#wizard-step-${step}`).hidden = true
          if (step < 3) $(`#wizard-step-${step+1}`).hidden = false
          else showWizardResults()
        }, 300)
      })
    })
  })
  $('#wizard-restart')?.addEventListener('click', resetWizard)
}

function resetWizard() {
  wizardAnswers = {}
  $$('.wizard-option').forEach(o => o.classList.remove('wizard-option--selected'))
  $('#wizard-step-1').hidden = false
  $('#wizard-step-2').hidden = true
  $('#wizard-step-3').hidden = true
  $('#wizard-results').hidden = true
}

function showWizardResults() {
  const { step1, step2 } = wizardAnswers
  let scored = models.filter(m => m.status === 'up' && m.avg !== Infinity && m.avg < 99000)
  scored = scored.map(m => {
    let score = 0
    const tier = tierRank(m.tier)
    // Quality weight
    if (step1 === 'refactor' || step1 === 'review') score += (7-tier) * 15
    else if (step1 === 'feature' || step1 === 'debug') score += (7-tier) * 10
    else score += (7-tier) * 5

    if (step2 === 'speed') score += Math.max(0, 100 - (m.avg / 20))
    else if (step2 === 'quality') score += parseSwe(m.sweScore) * 1.5
    else if (step2 === 'stability') score += (m.stability || 0)
    else if (step2 === 'context') score += parseCtx(m.ctx) / 10

    return { ...m, _score: score }
  })
  scored.sort((a,b) => b._score - a._score)
  const top5 = scored.slice(0, 5)

  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣']
  $('#wizard-results-list').innerHTML = top5.map((m,i) =>
    `<div class="wizard-result-card">
      <div class="wizard-result__rank">${medals[i]}</div>
      <div class="wizard-result__info">
        <div class="wizard-result__name">${escapeHtml(m.label)}</div>
        <div class="wizard-result__meta">
          <span>${tierBadge(m.tier)}</span>
          <span>${m.avg}ms avg</span>
          <span>${m.sweScore || '—'}</span>
          <span>${escapeHtml(m.origin)}</span>
        </div>
      </div>
      <button class="wizard-result__action" data-launch-id="${m.modelId}">🚀 Use</button>
    </div>`
  ).join('')

  $$('.wizard-result__action').forEach(b => b.addEventListener('click', () => launchModel(b.dataset.launchId)))
  $('#wizard-results').hidden = false
}

// ─── Changelog ───────────────────────────────────────────────────────────────
let changelogLoaded = false
async function loadChangelog() {
  if (changelogLoaded) return
  try {
    const r = await fetch('/api/changelog')
    const { content } = await r.json()
    $('#changelog-content').innerHTML = markdownToHtml(content)
    changelogLoaded = true
  } catch { $('#changelog-content').innerHTML = '<p>Failed to load changelog</p>' }
}

function markdownToHtml(md) {
  return md.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '<br><br>')
}

// ═══════ SETTINGS PAGE ═══════════════════════════════════════════════════════
async function loadSettingsPage() {
  try { const r = await fetch('/api/config'); configData = await r.json(); renderSettingsProviders() } catch { showToast('Failed to load settings','error') }
}
function renderSettingsProviders(sf='') {
  if (!configData) return
  const c = $('#settings-providers')
  const entries = Object.entries(configData.providers).filter(([k,p]) => !sf || p.name.toLowerCase().includes(sf.toLowerCase()) || k.toLowerCase().includes(sf.toLowerCase())).sort((a,b)=>a[1].name.localeCompare(b[1].name))
  c.innerHTML = entries.map(([key,p]) => {
    const isR = revealedKeys.has(key), mk = p.hasKey ? (isR ? (p.maskedKey||'••••••••') : maskKey(p.maskedKey||'')) : ''
    return `<div class="settings-card" data-provider="${key}" id="settings-card-${key}">
      <div class="settings-card__header" onclick="toggleSettingsCard('${key}')">
        <div class="settings-card__icon">🔌</div>
        <div class="settings-card__info"><div class="settings-card__name">${escapeHtml(p.name)}</div><div class="settings-card__meta">${p.modelCount} models · ${escapeHtml(key)}</div></div>
        <span class="settings-card__status ${p.hasKey?'settings-card__status--configured':'settings-card__status--missing'}">${p.hasKey?'✅ Active':'🔑 No Key'}</span>
        <span class="settings-card__toggle-icon">▼</span>
      </div>
      <div class="settings-card__body"><div class="settings-card__content">
        ${p.hasKey?`<div class="api-key-group"><label class="api-key-group__label">Current API Key</label><div class="api-key-display"><span class="api-key-display__value" id="key-display-${key}">${mk}</span><div class="api-key-display__actions"><button class="btn btn--sm btn--icon" onclick="toggleRevealKey('${key}')" title="${isR?'Hide':'Reveal'}">${isR?'🙈':'👁️'}</button><button class="btn btn--sm btn--icon" onclick="copyKey('${key}')" title="Copy">📋</button><button class="btn btn--sm btn--danger" onclick="deleteKey('${key}')" title="Delete">🗑️</button></div></div></div>`:''
        }
        <div class="api-key-group"><label class="api-key-group__label">${p.hasKey?'Update':'Add'} API Key</label><div class="api-key-group__row"><input type="password" class="api-key-group__input" id="key-input-${key}" placeholder="Enter your API key..." autocomplete="off"><button class="btn btn--sm btn--success" onclick="saveKey('${key}')">${p.hasKey?'Update':'Save'}</button></div></div>
        <div class="settings-card__enabled"><span class="settings-card__enabled-label">Provider Enabled</span><label class="toggle-switch"><input type="checkbox" ${p.enabled!==false?'checked':''} onchange="toggleProvider('${key}',this.checked)"><span class="toggle-switch__slider"></span></label></div>
      </div></div></div>`
  }).join('')
}

window.toggleSettingsCard = k => $(`#settings-card-${k}`)?.classList.toggle('settings-card--expanded')
window.toggleRevealKey = async k => { if (revealedKeys.has(k)) { revealedKeys.delete(k); renderSettingsProviders($('#settings-search')?.value||''); return }; try { const r=await fetch(`/api/key/${k}`); const d=await r.json(); if(d.key){revealedKeys.add(k);const el=$(`#key-display-${k}`);if(el)el.textContent=d.key;const c=$(`#settings-card-${k}`);const was=c?.classList.contains('settings-card--expanded');renderSettingsProviders($('#settings-search')?.value||'');if(was)$(`#settings-card-${k}`)?.classList.add('settings-card--expanded')}} catch{showToast('Failed to reveal key','error')} }
window.copyKey = async k => { try{const r=await fetch(`/api/key/${k}`);const d=await r.json();if(d.key){await navigator.clipboard.writeText(d.key);showToast('API key copied','success')}else showToast('No key','warning')}catch{showToast('Failed','error')} }
window.saveKey = async k => { const i=$(`#key-input-${k}`);const v=i?.value?.trim();if(!v){showToast('Please enter a key','warning');return};try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKeys:{[k]:v}})});const d=await r.json();if(d.success){showToast(`Key saved for ${k}`,'success');i.value='';revealedKeys.delete(k);await loadSettingsPage();$(`#settings-card-${k}`)?.classList.add('settings-card--expanded')}else showToast(d.error||'Failed','error')}catch{showToast('Network error','error')} }
window.deleteKey = async k => { if(!confirm(`Delete key for "${k}"?`))return;try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKeys:{[k]:''}})});const d=await r.json();if(d.success){showToast(`Key deleted for ${k}`,'info');revealedKeys.delete(k);await loadSettingsPage()}else showToast(d.error||'Failed','error')}catch{showToast('Network error','error')} }
window.toggleProvider = async(k,en) => { try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providers:{[k]:{enabled:en}}})});const d=await r.json();if(d.success)showToast(`${k} ${en?'enabled':'disabled'}`,'success');else showToast(d.error||'Failed','error')}catch{showToast('Network error','error')} }
function maskKey(k) { if(!k||k.length<8) return '••••••••'; return '••••••••'+k.slice(-4) }
$('#settings-search')?.addEventListener('input', e => renderSettingsProviders(e.target.value))
$('#settings-expand-all')?.addEventListener('click', () => $$('.settings-card').forEach(c=>c.classList.add('settings-card--expanded')))
$('#settings-collapse-all')?.addEventListener('click', () => $$('.settings-card').forEach(c=>c.classList.remove('settings-card--expanded')))

// ═══════ ANALYTICS ═══════════════════════════════════════════════════════════
function renderAnalytics() { if(!models.length)return; renderProviderHealth(); renderLeaderboard(); renderTierDistribution() }
function renderProviderHealth() {
  const pm = {}; models.forEach(m=>{if(!pm[m.origin])pm[m.origin]={total:0,online:0};pm[m.origin].total++;if(m.status==='up')pm[m.origin].online++})
  const entries = Object.entries(pm).sort((a,b)=>(b[1].online/b[1].total)-(a[1].online/a[1].total))
  $('#provider-health-body').innerHTML = entries.map(([n,d])=>{const p=d.total>0?Math.round(d.online/d.total*100):0;return `<div class="provider-health-item"><span class="provider-health__name">${escapeHtml(n)}</span><div class="provider-health__bar"><div class="provider-health__fill" style="width:${p}%"></div></div><span class="provider-health__pct ${p>70?'ping-fast':p>30?'ping-medium':'ping-slow'}">${p}%</span></div>`}).join('')||'<div style="color:var(--color-text-dim)">Waiting...</div>'
}
function renderLeaderboard() {
  const top10=[...models.filter(m=>m.status==='up'&&m.avg!==Infinity&&m.avg<99000)].sort((a,b)=>a.avg-b.avg).slice(0,10)
  const medals = ['🥇','🥈','🥉']
  $('#leaderboard-body').innerHTML = top10.map((m,i)=>`<div class="leaderboard-item"><div class="leaderboard__rank ${i<3?`leaderboard__rank--${i+1}`:''}">${medals[i]||(i+1)}</div><span class="leaderboard__name">${escapeHtml(m.label)}</span><span class="leaderboard__latency">${m.avg}ms</span></div>`).join('')||'<div style="color:var(--color-text-dim)">Waiting...</div>'
}
function renderTierDistribution() {
  const tc={};models.forEach(m=>{tc[m.tier]=(tc[m.tier]||0)+1});const max=Math.max(...Object.values(tc),1)
  const colors={'S+':'#ffd700','S':'#ff8c00','A+':'#00c8ff','A':'#3ddc84','A-':'#7ecf7e','B+':'#a8a8c8','B':'#808098','C':'#606078'}
  $('#tier-dist-body').innerHTML = ['S+','S','A+','A','A-','B+','B','C'].map(t=>{const c=tc[t]||0;return `<div class="tier-dist-item"><div class="tier-dist__badge">${tierBadge(t)}</div><div class="tier-dist__bar"><div class="tier-dist__fill" style="width:${(c/max)*100}%;background:${colors[t]}"></div></div><span class="tier-dist__count">${c}</span></div>`}).join('')
}

// ═══════ EXPORT ══════════════════════════════════════════════════════════════
$('#export-btn')?.addEventListener('click', ()=>$('#export-modal').hidden=false)
$('#export-close')?.addEventListener('click', ()=>$('#export-modal').hidden=true)
$('#export-modal')?.addEventListener('click', e=>{if(e.target===$('#export-modal'))$('#export-modal').hidden=true})
$('#export-json')?.addEventListener('click', ()=>{downloadFile(JSON.stringify(getFilteredModels(),null,2),'export.json','application/json');showToast('Exported JSON','success');$('#export-modal').hidden=true})
$('#export-csv')?.addEventListener('click', ()=>{const f=getFilteredModels();const csv=['Rank,Tier,Model,Provider,SWE%,Context,Ping,Avg,Stability,Verdict,Uptime',...f.map((m,i)=>[i+1,m.tier,m.label,m.origin,m.sweScore||'',m.ctx||'',m.latestPing||'',m.avg===Infinity?'':m.avg,m.stability||'',m.verdict||'',m.uptime||''].join(','))].join('\n');downloadFile(csv,'export.csv','text/csv');showToast('Exported CSV','success');$('#export-modal').hidden=true})
$('#export-clipboard')?.addEventListener('click', async()=>{const f=getFilteredModels().filter(m=>m.status==='up').slice(0,20);const t=f.map((m,i)=>`${i+1}. ${m.label} [${m.tier}] — ${m.avg!==Infinity?m.avg+'ms':'N/A'} (${m.origin})`).join('\n');await navigator.clipboard.writeText(t);showToast('Copied','success');$('#export-modal').hidden=true})
function downloadFile(c,n,t){const b=new Blob([c],{type:t});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=n;a.click();URL.revokeObjectURL(u)}

// ═══════ HELP, FEEDBACK MODALS ══════════════════════════════════════════════
$('#help-close')?.addEventListener('click', ()=>$('#help-modal').hidden=true)
$('#help-modal')?.addEventListener('click', e=>{if(e.target===$('#help-modal'))$('#help-modal').hidden=true})
$('#sidebar-help-btn')?.addEventListener('click', ()=>$('#help-modal').hidden=false)
$('#footer-help')?.addEventListener('click', ()=>$('#help-modal').hidden=false)

$('#feedback-close')?.addEventListener('click', ()=>$('#feedback-modal').hidden=true)
$('#feedback-modal')?.addEventListener('click', e=>{if(e.target===$('#feedback-modal'))$('#feedback-modal').hidden=true})
$('#footer-feedback')?.addEventListener('click', ()=>$('#feedback-modal').hidden=false)
$('#footer-palette')?.addEventListener('click', openCmdPalette)

$$('.feedback-type-btn').forEach(b => b.addEventListener('click', ()=>{$$('.feedback-type-btn').forEach(x=>x.classList.remove('feedback-type-btn--active'));b.classList.add('feedback-type-btn--active')}))
$('#feedback-submit')?.addEventListener('click', ()=>{const t=$('#feedback-text')?.value?.trim();if(!t){showToast('Write something first','warning');return};showToast('Thanks for your feedback! 💚','success');$('#feedback-text').value='';$('#feedback-modal').hidden=true})

// ─── Theme ───────────────────────────────────────────────────────────────────
function toggleTheme() { const h=document.documentElement;h.setAttribute('data-theme',h.getAttribute('data-theme')==='dark'?'light':'dark') }
$('#theme-toggle')?.addEventListener('click', toggleTheme)
$('#sidebar-theme-toggle')?.addEventListener('click', toggleTheme)

// ─── Filters & Sorting ──────────────────────────────────────────────────────
$('#search-input')?.addEventListener('input', e=>{searchQuery=e.target.value;renderTable()})
$('#tier-filters')?.addEventListener('click', e=>{const b=e.target.closest('.tier-btn');if(!b)return;filterTier=b.dataset.tier;$$('.tier-btn').forEach(x=>x.classList.remove('tier-btn--active'));b.classList.add('tier-btn--active');renderTable()})
$('#status-filters')?.addEventListener('click', e=>{const b=e.target.closest('.status-btn');if(!b)return;filterStatus=b.dataset.status;$$('.status-btn').forEach(x=>x.classList.remove('status-btn--active'));b.classList.add('status-btn--active');renderTable()})
$('#provider-filter')?.addEventListener('change', e=>{filterProvider=e.target.value;renderTable()})
$('#fav-filter')?.addEventListener('click', e=>{const b=e.target.closest('.fav-btn');if(!b)return;filterFav=b.dataset.fav;$$('.fav-btn').forEach(x=>x.classList.remove('fav-btn--active'));b.classList.add('fav-btn--active');renderTable()})
$('#models-table thead')?.addEventListener('click', e=>{const th=e.target.closest('th.sortable');if(!th)return;const col=th.dataset.sort;if(sortColumn===col)sortDirection=sortDirection==='asc'?'desc':'asc';else{sortColumn=col;sortDirection='asc'};$$('th.sortable').forEach(t=>t.classList.remove('sort-active'));th.classList.add('sort-active');renderTable()})

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return
  if ((e.ctrlKey||e.metaKey)&&e.key==='k') { e.preventDefault(); if(currentView!=='dashboard')switchView('dashboard'); $('#search-input')?.focus(); return }
  if ((e.ctrlKey||e.metaKey)&&e.key==='p') { e.preventDefault(); openCmdPalette(); return }
  if (e.key==='Escape') { if(!$('#detail-panel').hidden){$('#detail-panel').hidden=true;selectedModelId=null}; if(!$('#export-modal').hidden)$('#export-modal').hidden=true; if(!$('#help-modal').hidden)$('#help-modal').hidden=true; if(!$('#feedback-modal').hidden)$('#feedback-modal').hidden=true; closeCmdPalette(); return }
  if (e.key==='g'||e.key==='G') toggleTheme()
  if (e.key==='z'||e.key==='Z') cycleToolMode()
  if (e.key==='w'||e.key==='W') cyclePingCadence()
  if (e.key==='f'||e.key==='F') toggleFavFilter()
  if (e.key==='k'||e.key==='K') $('#help-modal').hidden = false
  if (e.key==='i'||e.key==='I') $('#feedback-modal').hidden = false
  if (e.key==='e'||e.key==='E') $('#export-modal').hidden = false
})

// ─── Initialize ──────────────────────────────────────────────────────────────
async function checkForUpdates() {
  try {
    const res = await fetch('/api/version-check')
    const data = await res.json()
    if (data.hasUpdate && data.latest) {
      const vSpan = $('#update-version')
      if (vSpan) vSpan.textContent = `v${data.latest}`
      const banner = $('#update-banner')
      if (banner) {
        banner.hidden = false
        document.body.classList.add('has-banner')
      }
    }
  } catch (e) {
    console.error('Update check failed:', e)
  }
}

$('#update-dismiss')?.addEventListener('click', () => {
  const banner = $('#update-banner')
  if (banner) {
    banner.hidden = true
    document.body.classList.remove('has-banner')
  }
})

$('#update-install')?.addEventListener('click', async () => {
  try {
    const vSpan = $('#update-version')
    const latest = vSpan ? vSpan.textContent.replace('v', '') : 'latest'
    await navigator.clipboard.writeText(`npm install -g free-coding-models@${latest}`)
    showToast('Copied update command to clipboard!', 'success')
    const banner = $('#update-banner')
    if (banner) {
      banner.hidden = true
      document.body.classList.remove('has-banner')
    }
  } catch (err) {
    showToast('Failed to copy command', 'error')
  }
})

loadFavorites()
connectSSE()
setupWizard()
checkForUpdates()
