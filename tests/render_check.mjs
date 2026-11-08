// Render check for Flightdeck's desktop/plugin.js against the real live
// snapshot (tests/fixtures/snapshot-live-1.json, captured from the live backend
// at window=1m). No dependencies: stubs the @hermes/plugin-sdk and react surface
// the plugin uses, renders By model and By agent, and asserts the swim lane and
// the By agent rows. Run: node tests/render_check.mjs
import { readFileSync } from 'node:fs'

const PLUGIN = new URL('../desktop/plugin.js', import.meta.url)
const FIXTURE = new URL('./fixtures/snapshot-live-1.json', import.meta.url)
const src = readFileSync(PLUGIN, 'utf8')
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const labels = {}

// --- minimal SDK / react stubs ------------------------------------------------

function atom(value) {
  let current = value
  return {
    get: () => current,
    set: next => {
      current = typeof next === 'function' ? next(current) : next
    },
    subscribe: () => () => {}
  }
}
const useValue = a => a.get()
const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}]
const useEffect = () => {}
const useMemo = fn => fn()
const useRef = initial => ({ current: initial })

function useQuery({ queryKey }) {
  const kind = queryKey[1]
  let data = null
  if (kind === 'snapshot') data = fixture
  else if (kind === 'servers') data = { servers: fixture.servers, totals: fixture.totals, show_chip: true }
  else if (kind === 'labels') data = labels
  else if (kind === 'quota') data = null
  return { data, isLoading: false, isError: false, isFetching: false, refetch: () => {} }
}

const host = {
  state: { focusedSessionId: atom(null), focusedSessionProfile: atom('default') },
  profileRoutes: () => [{ profile: 'default' }],
  requestProfile: async () => ({ sessions: [] }),
  request: async () => ({}),
  navigate: () => {}
}
const cn = (...args) => args.filter(Boolean).join(' ')
const profileColor = () => 'var(--ui-accent)'
const Component = props => (props && props.children != null ? props.children : null)
// jsx(type, props, key?) builds an element the walker can visit; the SDK
// components above are plain functions the walker calls with props.
const jsx = (type, props) => ({ type, props: props || {} })
const jsxs = jsx

// --- load the plugin with the stubs -----------------------------------------

const body = src.slice(src.indexOf("const ID = 'flightdeck'")).replace('export default {', 'const plugin = {')
const factory = new Function(
  'atom', 'Badge', 'Button', 'Codicon', 'EmptyState', 'ErrorState', 'ScrollArea', 'SegmentedControl',
  'Skeleton', 'StatusDot', 'cn', 'host', 'profileColor', 'useQuery', 'useValue',
  'PALETTE_AREA', 'ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'STATUSBAR_AREAS',
  'useEffect', 'useMemo', 'useRef', 'useState', 'jsx', 'jsxs',
  `${body}\nreturn { plugin, FlightdeckPage, ModelView, AgentView, SwimLane, ServerCard, drawSwimLane, swimLanes }`
)
const mod = factory(
  atom, Component, Component, Component, Component, Component, Component, Component,
  Component, Component, cn, host, profileColor, useQuery, useValue,
  'palette', 'routes', 'sidebar', 'statusbar',
  useEffect, useMemo, useRef, useState, jsx, jsxs
)

// --- tree helpers -------------------------------------------------------------

function walk(node, visit, path = 'root') {
  if (node == null || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ kind: 'text', text: String(node), path })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, visit, `${path}[${i}]`))
    return
  }
  if (typeof node !== 'object' || node.type == null) return
  if (typeof node.type === 'function') {
    walk(node.type(node.props || {}), visit, `${path}>${node.type.name || 'fn'}`)
    return
  }
  visit({ kind: 'element', type: node.type, props: node.props || {}, path })
  walk(node.props && node.props.children, visit, `${path}>${node.type}`)
}

function elements(node) {
  const found = []
  walk(node, item => {
    if (item.kind === 'element') found.push(item)
  })
  return found
}

function textOf(node) {
  let text = ''
  walk(node, item => {
    if (item.kind === 'text') text += item.text
  })
  return text
}

function countIn(node, attr) {
  return elements(node).filter(item => item.props[attr] != null).length
}

// --- assertions ---------------------------------------------------------------

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. Swim lane lanes: local servers with rows, then cloud models with traffic.
const { win, lanes } = mod.swimLanes(fixture, 60, fixture.generated_at * 1000)
const localLanes = lanes.filter(lane => lane.kind === 'local')
const cloudLanes = lanes.filter(lane => lane.kind === 'cloud')
const studio = localLanes.find(lane => lane.label === 'studio-ds4')
check('swim lane has ≥1 local lane', localLanes.length >= 1, `${localLanes.length} local: ${localLanes.map(l => l.label).join(', ')}`)
check('studio-ds4 local lane has ≥6 bars', studio && studio.bars.length >= 6, studio ? `${studio.bars.length} bars` : 'lane missing')
check('swim lane has ≥1 cloud lane', cloudLanes.length >= 1, `${cloudLanes.length} cloud: ${cloudLanes.map(l => l.label).join(', ')}`)
check('cloud lane draws 15 s request ticks', cloudLanes.length > 0 && cloudLanes.every(lane => lane.bars.length >= 1), cloudLanes.map(l => `${l.label}: ${l.bars.length} ticks`).join(', '))
check('non-streamed requests are whole-response bars', studio && studio.bars.some(bar => bar.whole), studio ? `${studio.bars.filter(b => b.whole).length} whole` : 'lane missing')

// 2. Swim lane draw: bars actually reach the canvas.
globalThis.getComputedStyle = () => ({
  getPropertyValue: name => `var(${name})`
})
const drawn = { fillRect: 0, strokeRect: 0, fillText: [] }
const fakeCtx = {
  clearRect() {}, save() {}, restore() {}, setTransform() {}, setLineDash() {},
  beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
  stroke() {}, fill() {},
  fillRect() { drawn.fillRect += 1 },
  strokeRect() { drawn.strokeRect += 1 },
  fillText(text) { drawn.fillText.push(text) },
  measureText(text) { return { width: String(text).length * 5.5 } },
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', globalAlpha: 1
}
const hits = mod.drawSwimLane(fakeCtx, 900, 190, lanes, win, fakeCtx, labels)
const localHits = hits.filter(hit => hit.lane && hit.lane.kind === 'local')
check('swim lane draw paints ≥6 local bars', localHits.length >= 6, `${localHits.length} local bars, ${drawn.fillRect} fillRects`)
check('swim lane draw labels local and cloud lanes', drawn.fillText.includes('local') && drawn.fillText.includes('cloud'), drawn.fillText.filter(t => t === 'local' || t === 'cloud').join(', '))

// 3. By agent: every agent row (profile, session, subagent, cron) has model
//    sub-rows with the full column set.
const agentTree = mod.AgentView({ snapshot: fixture, labels, now: fixture.generated_at * 1000, windowSeconds: 60 })
const agentRows = elements(agentTree).filter(item => item.props['data-agent-row'] != null)
const agentRowNames = agentRows.map(item => item.props['data-agent-row'])
check('By agent renders every agent row', agentRows.length >= 3, agentRowNames.join(', '))
const rowsWithoutModels = agentRows.filter(item => countIn(item, 'data-model-row') === 0)
check('every agent row has ≥1 model sub-row', agentRows.length > 0 && rowsWithoutModels.length === 0, rowsWithoutModels.length ? rowsWithoutModels.map(r => r.props['data-agent-row']).join(', ') : `${agentRows.length} rows`)
const modelRows = elements(agentTree).filter(item => item.props['data-model-row'] != null)
check('model sub-rows carry the model label', modelRows.length > 0 && modelRows.every(item => textOf(item).includes('·') || textOf(item).includes('/')), modelRows.map(item => textOf(item).slice(0, 40)).join(' | '))

const COLUMNS = ['flight', 'req', 'tokens', 'lat', 'ttft', 'err']
function missingColumns(item) {
  const cols = new Set(elements(item).filter(e => e.props['data-col'] != null).map(e => e.props['data-col']))
  return COLUMNS.filter(col => !cols.has(col))
}
const rowsMissingColumns = agentRows.filter(item => missingColumns(item).length > 0)
check('every agent row has all 6 columns', agentRows.length > 0 && rowsMissingColumns.length === 0, rowsMissingColumns.length ? rowsMissingColumns.map(r => `${r.props['data-agent-row']}: ${missingColumns(r).join('/')}`).join(', ') : 'flight req tokens lat ttft err')
const modelRowsMissingColumns = modelRows.filter(item => missingColumns(item).length > 0)
check('every model sub-row has all 6 columns', modelRows.length > 0 && modelRowsMissingColumns.length === 0, modelRowsMissingColumns.length ? modelRowsMissingColumns.map(r => `${r.props['data-model-row']}: ${missingColumns(r).join('/')}`).join(', ') : 'flight req tokens lat ttft err')
const emptyColumns = [...agentRows, ...modelRows].filter(item =>
  elements(item).some(e => e.props['data-col'] != null && textOf(e).trim() === '')
)
check('no column renders empty', agentRows.length + modelRows.length > 0 && emptyColumns.length === 0, `${emptyColumns.length} rows with empty columns`)

// 4. Subagent labels: one line, full text in the tooltip, role prefixed.
const subagentRow = agentRows.find(item => item.props['data-agent-row'] === '20261107_174026_d25bb8')
const subagentLabel = subagentRow && elements(subagentRow).find(e => e.props.title && e.props.title.startsWith('leaf · '))
check('subagent label is role-prefixed and tooltipped', subagentLabel && subagentLabel.props.title.includes('Execute /Users/openclaw/.hermes/cache/scratch/flightdeck-briefs/I2-health-backend.md'), subagentLabel ? subagentLabel.props.title.slice(0, 60) : 'label missing')
check('subagent label text is one line', subagentLabel && !textOf(subagentLabel).includes('\n'), subagentLabel ? `${textOf(subagentLabel).length} chars` : 'label missing')

// 5. Local server card health row: one compact line under the slot bar, every
//    server-side number labelled, missing fields omitted, inline bars for KV and
//    MTP acceptance. The fixture carries no health block, so this is a copy of
//    the live snapshot with a health block on gb10-qwen (DESIGN §9.1).
const healthServer = JSON.parse(JSON.stringify(fixture.servers.find(s => s.name === 'gb10-qwen')))
healthServer.health = {
  kv_cache_usage: 0.7, kv_cache_usage_mean: 0.65,
  prefix_cache_hit_rate: 0.93, spec_accept_rate: 0.68,
  server_ttft_p50: 0.82, server_ttft_p95: 8.2,
  server_tpot_p50: 0.019,
  preemptions_total: 2, preemptions_delta: 0,
  disconnects_total: 21, disconnects_delta: 1,
  memory_bytes: 98800000000, memory_peak_bytes: 100000000000
}
const healthCard = mod.ServerCard({ server: healthServer, models: fixture.models, labels, now: fixture.generated_at * 1000 })
const healthText = textOf(healthCard)
const healthPieces = [
  'KV', '70%', 'prefix hit 93%', 'MTP accept', '68%',
  'TTFT p50 0.82s / p95 8.2s', 'TPOT 19 ms', 'mem 98.8 GB'
]
const missingHealth = healthPieces.filter(piece => !healthText.includes(piece))
check('server health line renders every reported field', missingHealth.length === 0,
  missingHealth.length ? `missing: ${missingHealth.join(', ')}` : healthText.slice(0, 120))
const healthBars = elements(healthCard).filter(item => item.props.style && item.props.style.width === '30px')
const barFills = healthBars.map(item => elements(item).find(e => e.props.style && /%$/.test(String(e.props.style.width)))?.props.style.width)
check('health line draws inline KV and MTP accept bars', healthBars.length === 2 && barFills.join(',') === '70%,68%',
  `${healthBars.length} bars: ${barFills.join(', ')}`)
const healthLabels = ['KV', 'prefix hit', 'MTP accept', 'TTFT', 'TPOT', 'mem']
const untooltipped = healthLabels.filter(label =>
  !elements(healthCard).some(item => item.props.title && textOf(item).startsWith(label))
)
check('health items carry plain-word tooltips', untooltipped.length === 0,
  untooltipped.length ? `no tooltip: ${untooltipped.join(', ')}` : healthLabels.join(', '))
const ttftItem = elements(healthCard).find(item => item.props.title && textOf(item).startsWith('TTFT'))
check('TTFT tooltip says server-side numbers cover all traffic',
  ttftItem && ttftItem.props.title.includes('ALL traffic') && ttftItem.props.title.includes('not just Hermes'),
  ttftItem ? ttftItem.props.title.slice(0, 90) : 'TTFT item missing')
const kvOnly = JSON.parse(JSON.stringify(healthServer))
kvOnly.health = { kv_cache_usage: 0.7 }
const kvOnlyText = textOf(mod.ServerCard({ server: kvOnly, models: fixture.models, labels, now: fixture.generated_at * 1000 }))
check('health line omits missing fields', kvOnlyText.includes('KV') && !kvOnlyText.includes('prefix hit') && !kvOnlyText.includes('mem'),
  kvOnlyText.slice(0, 80))
const noHealthText = textOf(mod.ServerCard({ server: fixture.servers.find(s => s.name === 'studio-ds4'), models: fixture.models, labels, now: fixture.generated_at * 1000 }))
check('server card with no health block renders no health line',
  !noHealthText.includes('prefix hit') && !noHealthText.includes('TPOT') && !noHealthText.includes('mem '),
  'studio-ds4 has no health block')

// 6. The whole page renders without undefined components and shows the swim
//    lane canvas.
const page = mod.FlightdeckPage({})
const pageElements = elements(page)
const canvas = pageElements.find(item => item.type === 'canvas')
check('page renders the swim lane canvas', canvas && String(canvas.props['aria-label'] || '').includes('cloud lane'), canvas ? canvas.props['aria-label'].slice(0, 60) : 'canvas missing')

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('FAILED:', failed.map(item => item.name).join(' | '))
  process.exit(1)
}
