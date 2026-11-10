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

let providerUsageResult = null
let providerUsageError = false

function useQuery({ queryKey }) {
  const kind = queryKey[1]
  let data = null
  if (kind === 'snapshot') data = querySnapshot
  else if (kind === 'servers') data = { servers: querySnapshot.servers, totals: querySnapshot.totals, show_chip: true }
  else if (kind === 'labels') data = labels
  else if (kind === 'quota') data = null
  else if (kind === 'provider-usage') data = providerUsageError ? null : host.request('model.options', {})
  return { data, isLoading: false, isError: kind === 'provider-usage' && providerUsageError, isFetching: false, refetch: () => {} }
}

const opened = []
const host = {
  state: { focusedSessionId: atom(null), focusedSessionProfile: atom('default') },
  profileRoutes: () => [{ profile: 'default' }],
  requestProfile: async () => ({ sessions: [] }),
  request: (method, params) => {
    if (method === 'model.options') return providerUsageResult
    return {}
  },
  openSession: (id, opts) => opened.push({ id, opts }),
  navigate: () => {}
}
const cn = (...args) => args.filter(Boolean).join(' ')
const profileColor = () => 'var(--ui-accent)'
const Button = function Button(props) {
  return { type: 'button', props: { ...(props || {}) } }
}
const Component = props => (props && props.children != null ? props.children : null)
// Keep props for components whose attributes the assertions read.
// Plain functions (the walker calls them with props) that keep every prop on a
// visitable element; EmptyState surfaces title/description as text.
const Badge = function Badge(props) {
  return { type: 'badge', props: { ...(props || {}) } }
}
const EmptyState = function EmptyState(props) {
  const { title, description, ...rest } = props || {}
  return { type: 'empty-state', props: { ...rest, title, description, children: [title, ' ', description] } }
}
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
  `${body}\nreturn { plugin, FlightdeckPage, ModelView, AgentView, SwimLane, ServerCard, CloudCard, PlanUsage, drawSwimLane, swimLanes, Section, unreachableReason, useProviderUsage, providerUsageToQuota, mergeProviderUsage, planFingerprint, requestTooltip, modelDisplayName }`
)
const mod = factory(
  atom, Badge, Button, Component, EmptyState, Component, Component, Component,
  Component, Component, cn, host, profileColor, useQuery, useValue,
  'palette', 'routes', 'sidebar', 'statusbar',
  useEffect, useMemo, useRef, useState, jsx, jsxs, globalThis
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
let querySnapshot = fixture
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
check('cloud lane draws its traffic (per-request bars, or bucket columns as fallback)', cloudLanes.length > 0 && cloudLanes.every(lane => lane.bars.length >= 1), cloudLanes.map(l => `${l.label}: ${l.bars.length} ${l.ticks ? 'buckets' : 'bars'}`).join(', '))
check('cloud bucket fallback columns scale to the max bucket, not the total', cloudLanes.every(lane => !lane.ticks || lane.concurrency === Math.max(...lane.bars.map(b => b.count))), cloudLanes.filter(l => l.ticks).map(l => `peak ${l.concurrency}`).join(', ') || 'no fallback lane in fixture')
check('non-streamed requests are whole-response bars', studio && studio.bars.some(bar => bar.whole), studio ? `${studio.bars.filter(b => b.whole).length} whole` : 'lane missing')

// 2. Swim lane draw: bars actually reach the canvas.
globalThis.getComputedStyle = () => ({
  getPropertyValue: name => `var(${name})`
})
const drawn = { fillRect: 0, strokeRect: 0, fillText: [], fillTextAt: [] }
const fakeCtx = {
  clearRect() {}, save() {}, restore() {}, setTransform() {}, setLineDash() {},
  beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
  stroke() {}, fill() {},
  fillRect() { drawn.fillRect += 1 },
  strokeRect() { drawn.strokeRect += 1 },
  fillText(text, x, y) { drawn.fillText.push(text); drawn.fillTextAt.push({ text, x, y }) },
  measureText(text) { return { width: String(text).length * 5.5 } },
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', globalAlpha: 1
}
const hits = mod.drawSwimLane(fakeCtx, 900, 190, lanes, win, fakeCtx, labels)
const localHits = hits.filter(hit => hit.lane && hit.lane.kind === 'local')
check('swim lane draw paints ≥6 local bars', localHits.length >= 6, `${localHits.length} local bars, ${drawn.fillRect} fillRects`)
check('swim lane draw labels local and cloud lanes', drawn.fillText.includes('local') && drawn.fillText.includes('cloud'), drawn.fillText.filter(t => t === 'local' || t === 'cloud').join(', '))
check('swim lane labels carry no tok/s text', !drawn.fillText.some(t => String(t).includes('tok/s')), drawn.fillText.filter(t => String(t).includes('tok/s')).join(', ') || 'no tok/s labels')

// 2a. The container grows with the lane count so no lane is ever clipped. The
//     old fixed 190 px held 4 lanes of 56 px only until the 4th was drawn below
//     the canvas. Build snapshots with an exact lane count (one server each).
const laneBase = fixture.generated_at
const laneSnapshotFor = count => ({
  window: { seconds: 60, since: laneBase },
  servers: Array.from({ length: count }, (_, i) => ({
    name: `lane-${i}`, kind: 'tensorfold', base_url: `http://127.0.0.1:${7100 + i}`,
    slots: 2,
    requests: [{
      started_at: laneBase + 10 + i, first_chunk_at: laneBase + 12 + i,
      ended_at: laneBase + 20 + i, profile: 'default', session_id: `lane${i}`, status: 'done'
    }]
  })),
  models: []
})
const swimBoxHeight = node => {
  const box = elements(node).find(item => item.props.ref && item.props.style && item.props.style.height)
  return box ? parseFloat(String(box.props.style.height)) : NaN
}
const fourLaneSnap = laneSnapshotFor(4)
const fourLaneRows = mod.swimLanes(fourLaneSnap, 60, (laneBase + 60) * 1000)
check('four-lane snapshot builds 4 lanes', fourLaneRows.lanes.length === 4, `${fourLaneRows.lanes.length} lanes`)
const fourBoxH = swimBoxHeight(mod.SwimLane({ snapshot: fourLaneSnap, labels, now: (laneBase + 60) * 1000, windowSeconds: 60 }))
const fourMinH = 4 + 16 + 4 * 56
check('four-lane container height covers top + axis + 4*56', fourBoxH >= fourMinH, `${fourBoxH}px >= ${fourMinH}px`)
const oneBoxH = swimBoxHeight(mod.SwimLane({ snapshot: laneSnapshotFor(1), labels, now: (laneBase + 60) * 1000, windowSeconds: 60 }))
check('one-lane container keeps the 190px minimum', oneBoxH === 190, `${oneBoxH}px`)

// The 4th lane's label must land inside the canvas the container gives it.
// The canvas content box is at most the container height minus its 4 px
// padding (top+bottom) and 1 px border (top+bottom); using that as the bound is
// safe whether the box is content-box or border-box sized.
const fourCanvasH = fourBoxH - 8 - 2
drawn.fillTextAt.length = 0
mod.drawSwimLane(fakeCtx, 900, fourCanvasH, fourLaneRows.lanes, fourLaneRows.win, fakeCtx, labels)
const fourthLabel = drawn.fillTextAt.find(item => item.text === 'lane-3')
check('fourth lane label draws inside the canvas',
  fourthLabel && fourthLabel.y < fourCanvasH,
  fourthLabel ? `y=${fourthLabel.y} < ${fourCanvasH}` : 'lane-3 label missing')

// 2b. Cloud lanes built from per-request rows use the SAME encoding as local:
//     bars stacked by overlap, right label 'peak N'. The backend is adding
//     model.requests rows to cloud entries; the fixture has none, so clone one.
const cloudRowsSnapshot = JSON.parse(JSON.stringify(fixture))
const cloudRowModel = cloudRowsSnapshot.models.find(m => m.lane === 'cloud')
const crowBase = win.end - 30
cloudRowModel.requests = [0, 4, 8].map(offset => ({
  started_at: crowBase + offset,
  first_chunk_at: crowBase + offset + 1,
  ended_at: crowBase + offset + 16,
  profile: 'default',
  session_id: `cloudrows_${offset}`,
  status: 'done',
  model: cloudRowModel.model,
  prompt_tokens: 100,
  completion_tokens: 40
}))
const cloudRows = mod.swimLanes(cloudRowsSnapshot, 60, fixture.generated_at * 1000)
const cloudRowLane = cloudRows.lanes.find(lane => lane.kind === 'cloud' && (lane.requests || []).length === 3)
check('cloud lane with requests builds 3 bars stacked to peak 3',
  cloudRowLane && cloudRowLane.bars.length === 3 && cloudRowLane.concurrency === 3 && !cloudRowLane.ticks,
  cloudRowLane ? `${cloudRowLane.bars.length} bars, peak ${cloudRowLane.concurrency}` : 'lane missing')
const cloudRowDraw = { fillRect: 0, strokeRect: 0, fillText: [] }
const cloudRowCtx = { ...fakeCtx, fillRect() { cloudRowDraw.fillRect += 1 }, strokeRect() { cloudRowDraw.strokeRect += 1 }, fillText(t) { cloudRowDraw.fillText.push(t) } }
mod.drawSwimLane(cloudRowCtx, 900, 190, cloudRows.lanes, cloudRows.win, cloudRowCtx, labels)
check('cloud lane right label reads peak 3', cloudRowDraw.fillText.includes('peak 3'),
  cloudRowDraw.fillText.filter(t => String(t).startsWith('peak')).join(', '))
// 2b-2. The agent loop from the live screenshot: 3 back-to-back requests whose
//       first token lands at (or within 0.25 s of) the end — nothing streamed.
//       Each must be its OWN hatched bar (whole = true) with a 1 px start gap
//       (abutStart), and the left detail must say '3 req' with NO 'n req'
//       number repeated on the right axis (only 'peak N').
const cloudLoopSnapshot = JSON.parse(JSON.stringify(fixture))
const cloudLoopModel = cloudLoopSnapshot.models.find(m => m.lane === 'cloud')
const loopBase = win.end - 30
cloudLoopModel.requests = [0, 16, 32].map(offset => ({
  started_at: loopBase + offset,
  first_chunk_at: loopBase + offset + 16,   // first token == end: never streamed
  ended_at: loopBase + offset + 16,
  profile: 'default',
  session_id: `cloudloop_${offset}`,
  status: 'done',
  model: cloudLoopModel.model,
  prompt_tokens: 900,
  completion_tokens: 60
}))
const cloudLoop = mod.swimLanes(cloudLoopSnapshot, 60, fixture.generated_at * 1000)
const cloudLoopLane = cloudLoop.lanes.find(lane => lane.kind === 'cloud' && (lane.requests || []).length === 3)
check('3 back-to-back non-streamed cloud rows render as 3 separate hatched bars',
  cloudLoopLane && cloudLoopLane.bars.length === 3
    && cloudLoopLane.bars.every(bar => bar.whole === true)
    && cloudLoopLane.bars.every(bar => bar.slot === 0)
    && cloudLoopLane.bars.filter(bar => bar.abutStart).length === 1
    && cloudLoopLane.bars[1].abutStart === true && cloudLoopLane.bars[2].abutStart === false,
  cloudLoopLane ? `${cloudLoopLane.bars.length} bars, ${cloudLoopLane.bars.filter(b => b.whole).length} whole, `
    + `${cloudLoopLane.bars.filter(b => b.abutStart).length} abutting` : 'lane missing')
const cloudLoopDraw = { fillRect: 0, strokeRect: 0, fillText: [] }
const cloudLoopCtx = { ...fakeCtx, fillRect() { cloudLoopDraw.fillRect += 1 }, strokeRect() { cloudLoopDraw.strokeRect += 1 }, fillText(t) { cloudLoopDraw.fillText.push(t) } }
mod.drawSwimLane(cloudLoopCtx, 900, 190, cloudLoop.lanes, cloudLoop.win, cloudLoopCtx, labels)
const loopRightLabels = cloudLoopDraw.fillText.filter(t => String(t).startsWith('peak') || /req$/.test(String(t)))
check('cloud loop lane: left detail and right axis agree on the count (3 req left, no number right)',
  cloudLoopLane && /^3 req · 0 streamed$/.test(cloudLoopLane.detail || '')
    && !cloudLoopDraw.fillText.some(t => /^\d+ req$/.test(String(t)))
    && loopRightLabels.length === cloudLoop.lanes.length,
  `${cloudLoopLane ? cloudLoopLane.detail : 'lane missing'} | right: ${loopRightLabels.join(', ')}`)

// 2b-3. The per-agent legend entries take their label from snapshot.agents, so
//       a lane whose session has a titled agent row shows the title, never the
//       date id. Seed a title on the agent row that owns a local lane's rows.
const legendTitleSnapshot = JSON.parse(JSON.stringify(fixture))
const localRowServer = fixture.servers.find(s => (s.requests || []).length > 0)
const legendTitleSession = localRowServer.requests.find(r => r.session_id).session_id
const legendTitleProfile = localRowServer.requests.find(r => r.session_id).profile || 'default'
legendTitleSnapshot.agents = (legendTitleSnapshot.agents || []).filter(a => a.session_id !== legendTitleSession)
legendTitleSnapshot.agents.push({
  profile: legendTitleProfile, session_id: legendTitleSession, kind: 'session',
  title: 'Flightdeck hackathon', label: '', source: 'cli'
})
const legendTitleLane = mod.SwimLane({
  snapshot: legendTitleSnapshot, labels, now: fixture.generated_at * 1000, windowSeconds: 60
})
const legendTitleText = textOf(legendTitleLane)
// UI v2: legend entries use shortAgentLabel; the profile prefix only appears
// when the chart mixes profiles (this fixture has one).
check('legend agent entry shows the snapshot agent title, not the date id',
  legendTitleText.includes('Flightdeck hackathon')
    && !legendTitleText.includes(`${legendTitleProfile} · Flightdeck hackathon`)
    && !legendTitleText.includes(`session ${legendTitleSession.slice(0, 8)}`),
  legendTitleText.slice(-140))

// 2c. A 150-request fan-out must draw the NEWEST request, not the oldest:
//     requestRows used to .slice(0, 40), keeping the 40 OLDEST rows.
const manyRequests = Array.from({ length: 150 }, (_, i) => ({
  id: `many-${i}`, started_at: win.end - 150 + i, first_chunk_at: win.end - 149 + i,
  ended_at: win.end - 146 + i, profile: 'default', session_id: 's1',
  status: 'done', model: cloudRowModel.model, prompt_tokens: 100, completion_tokens: 20,
}))
const manyClone = JSON.parse(JSON.stringify(fixture))
const manyModel = manyClone.models.find(m => m.lane === 'cloud')
manyModel.requests = manyRequests
const manyRows = mod.swimLanes(manyClone, 300, fixture.generated_at * 1000)
const manyLane = manyRows.lanes.find(lane => lane.kind === 'cloud' && (lane.requests || []).length > 40)
check('lane given 150 requests keeps rows past the old 40-row slice',
  manyLane && manyLane.bars.length > 40,
  manyLane ? `${manyLane.bars.length} bars` : 'lane missing')
const manyIds = manyLane ? (manyLane.requests || []).map(row => row.id) : []
check('lane given 150 requests keeps the newest row in its bars',
  manyLane && manyIds.includes('many-149') && manyLane.bars.some(bar => bar.request && bar.request.id === 'many-149'),
  manyLane ? (manyIds.includes('many-149') ? 'many-149 drawn' : 'newest row dropped') : 'lane missing')
check('lane given 150 requests drops the OLDEST rows under the cap, not the newest',
  manyLane && !manyIds.includes('many-0'),
  manyLane ? (manyIds.includes('many-0') ? 'oldest kept — cap wrong' : 'oldest dropped') : 'lane missing')
check('local lane right labels carry peak and slots',
  drawn.fillText.some(t => /^peak \d+$/.test(String(t))) && drawn.fillText.some(t => /^of \d+ slots$/.test(String(t))),
  drawn.fillText.filter(t => /^peak \d+$/.test(String(t)) || /^of \d+ slots$/.test(String(t))).join(', '))

// 3. By agent (UI v2 cards): every agent row (profile, session, subagent, cron)
//    carries model chips and the three big number columns; secondary stats
//    (latency/TTFT p50, errors) render only when known — never as an empty
//    cell or a '—' placeholder.
const agentTree = mod.AgentView({ snapshot: fixture, labels, now: fixture.generated_at * 1000, windowSeconds: 60 })
const agentRows = elements(agentTree).filter(item => item.props['data-agent-row'] != null)
const agentRowNames = agentRows.map(item => item.props['data-agent-row'])
check('By agent renders every agent row', agentRows.length >= 3, agentRowNames.join(', '))
const rowsWithoutModels = agentRows.filter(item => countIn(item, 'data-model-row') === 0)
check('every agent row has ≥1 model chip', agentRows.length > 0 && rowsWithoutModels.length === 0, rowsWithoutModels.length ? rowsWithoutModels.map(r => r.props['data-agent-row']).join(', ') : `${agentRows.length} rows`)
const modelRows = elements(agentTree).filter(item => item.props['data-model-row'] != null)
check('model chips carry the model name and a request count', modelRows.length > 0 && modelRows.every(item => /· \d+ req/.test(textOf(item))), modelRows.map(item => textOf(item).slice(0, 40)).join(' | '))

const BIG_COLUMNS = ['flight', 'req', 'tokens']
function missingColumns(item) {
  const cols = new Set(elements(item).filter(e => e.props['data-col'] != null).map(e => e.props['data-col']))
  return BIG_COLUMNS.filter(col => !cols.has(col))
}
const rowsMissingColumns = agentRows.filter(item => missingColumns(item).length > 0)
check('every agent row has the in-flight / requests / tokens numbers', agentRows.length > 0 && rowsMissingColumns.length === 0, rowsMissingColumns.length ? rowsMissingColumns.map(r => `${r.props['data-agent-row']}: ${missingColumns(r).join('/')}`).join(', ') : 'flight req tokens')
const emptyColumns = agentRows.filter(item =>
  elements(item).some(e => e.props['data-col'] != null && textOf(e).trim() === '')
)
check('no column renders empty', agentRows.length > 0 && emptyColumns.length === 0, `${emptyColumns.length} rows with empty columns`)
const dashSecondary = agentRows.filter(item =>
  elements(item).some(e => ['lat', 'ttft', 'err'].includes(e.props['data-col']) && /—/.test(textOf(e))))
check('secondary stats render only when known (no — placeholders)', dashSecondary.length === 0,
  `${dashSecondary.length} rows with a — secondary stat`)

// 3b. Per-model latency/ttft/errors moved from sub-row columns into the hover
//     card's per-model lines: inject them into a cloned node and require the
//     card facts to carry the values, not the '—' fallback.
const timingFixture = structuredClone(fixture)
const timingAgent = timingFixture.agents.find(node => (node.models || []).length > 0)
timingAgent.models[0] = { ...timingAgent.models[0], latency_ms_p50: 1234.0, ttft_ms_p50: 56.0, errors_5m: 2 }
const timingFacts = partA().agentCardFacts(timingAgent, labels, fixture.generated_at * 1000)
const timingLine = timingFacts.models[0] ? timingFacts.models[0].line : ''
check('agent card renders per-model latency/ttft/errors',
  timingLine.includes('p50 1.2s') && timingLine.includes('TTFT 56ms') && timingLine.includes('2 errors'),
  timingLine || 'card model line missing')

// 4. Subagent labels: the row shows the short label on one line; the full
//    role-prefixed goal rides on the row (data-agent-full / aria-label) for the
//    hover card, never inline.
const subagentRow = agentRows.find(item => item.props['data-agent-row'] === '20261107_174026_d25bb8')
const subagentLabel = subagentRow && elements(subagentRow).find(e => e.props['data-agent-full'] != null)
check('subagent label is role-prefixed and carries the full goal for the card', subagentLabel && subagentLabel.props['data-agent-full'].startsWith('subagent · ') && subagentLabel.props['data-agent-full'].includes('Execute /Users/openclaw/.hermes/cache/scratch/flightdeck-briefs/I2-health-backend.md'), subagentLabel ? subagentLabel.props['data-agent-full'].slice(0, 60) : 'label missing')
check('subagent label text is one short line', subagentLabel && !textOf(subagentLabel).includes('\n') && textOf(subagentLabel).length <= 30 && !textOf(subagentLabel).includes('/Users/'), subagentLabel ? `${textOf(subagentLabel)} (${textOf(subagentLabel).length} chars)` : 'label missing')

// 4b. Session labels: the real title replaces the date id, the source badge and
//     started/active line render, the full id is tooltipped, and the row opens
//     the conversation through the SDK.
const SESSION_ID = '20261104_044650_9024bf'
const titledSnapshot = JSON.parse(JSON.stringify(fixture))
titledSnapshot.agents[0].last_active_at = fixture.generated_at - 120
const titledLabels = {
  [SESSION_ID]: {
    title: 'Redefine Gerard role and responsibilities',
    preview: 'Redefine Gerard??',
    source: 'desktop',
    started_at: 1793789991.450546
  }
}
const titledTree = mod.AgentView({ snapshot: titledSnapshot, labels: titledLabels, now: fixture.generated_at * 1000, windowSeconds: 60 })
const titledText = textOf(titledTree)
// UI v2: the row shows the SHORT label (first four words); the full title is
// the row's data-agent-full for the hover card.
const titledName = elements(titledTree).find(item => item.props['data-agent-full'] === 'Redefine Gerard role and responsibilities')
check('session row shows the real title, not the date id',
  titledText.includes('Redefine Gerard role') && !!titledName && !titledText.includes('session 20261104'),
  titledName ? `short '${textOf(titledName)}', full in data-agent-full` : 'title missing')
check('session row shows the source badge', titledText.includes('desktop'), titledText.includes('desktop') ? 'desktop badge' : 'badge missing')
check('session row shows started and last activity',
  titledText.includes('started Nov 4') && titledText.includes('active 2m ago'), titledText.slice(0, 120))
// UI v2: the full id rides in the hover card's meta line, not a native title.
const idCard = partA().agentCardFacts(titledSnapshot.agents[0], titledLabels, fixture.generated_at * 1000)
check('session row tooltips the full id', idCard.meta.includes(SESSION_ID), idCard.meta)
const clickable = elements(titledTree).find(item => typeof item.props.onClick === 'function' && item.props['data-agent-row'] == null)
check('session row is clickable to open the conversation', !!clickable, clickable ? 'onClick present' : 'no onClick')
if (clickable) clickable.props.onClick()
check('click opens the session through host.openSession',
  opened.length === 1 && opened[0].id === SESSION_ID && opened[0].opts.profile === 'default',
  opened.length ? JSON.stringify(opened[0]) : 'openSession not called')
const previewTree = mod.AgentView({
  snapshot: titledSnapshot,
  labels: { [SESSION_ID]: { title: '', preview: 'First preview line\nsecond line', source: 'signal', started_at: 1793789991.450546 } },
  now: fixture.generated_at * 1000,
  windowSeconds: 60
})
check('session label falls back to the preview first line',
  textOf(previewTree).includes('First preview line') && !textOf(previewTree).includes('second line'),
  textOf(previewTree).slice(0, 100))
check('session label falls back to the short id with no title or preview',
  textOf(agentTree).includes('session 20261104'), textOf(agentTree).includes('session 20261104') ? 'short id' : 'missing')

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
// UI v2: KV cache / prefix hit / MTP accept are ring gauges in the hero row;
// TTFT, time per token, memory and preemptions are one compact 'server' line.
const healthPieces = [
  'KV cache', '70%', 'Prefix hit', '93%', 'MTP accept', '68%',
  'TTFT p50 820ms · p95 8.2s', 'time per token 19.0 ms', 'memory 98.8 GB', 'preemptions 0'
]
const missingHealth = healthPieces.filter(piece => !healthText.includes(piece))
check('server health line renders every reported field', missingHealth.length === 0,
  missingHealth.length ? `missing: ${missingHealth.join(', ')}` : healthText.slice(0, 120))
const healthRings = elements(healthCard).filter(item => item.props['data-ring'] != null)
const ringArcs = healthRings.map(item => elements(item).find(e => e.props['data-ring-arc'] != null)?.props['data-ring-arc'])
check('health hero row draws KV, prefix and MTP ring gauges',
  healthRings.map(item => item.props['data-ring']).join(',') === 'kv,prefix,mtp' && ringArcs.join(',') === '70,93,68',
  `${healthRings.length} rings: ${ringArcs.join(', ')}`)
const healthTips = [
  ...healthRings.map(item => [item.props['data-ring'], item.props.title]),
  ...elements(healthCard).filter(item => item.props['data-stat'] != null && item.props.title)
    .map(item => [item.props['data-stat'], item.props.title])
]
const untooltipped = ['kv', 'prefix', 'mtp', 'ttft', 'tpot', 'mem', 'preempt']
  .filter(id => !healthTips.some(([key, title]) => key === id && title && title.includes('ALL traffic')))
check('health items carry plain-word tooltips', untooltipped.length === 0,
  untooltipped.length ? `no tooltip: ${untooltipped.join(', ')}` : 'kv, prefix, mtp, ttft, tpot, mem, preempt')
const serverLine = elements(healthCard).find(item => item.props['data-stat-line'] === 'server')
const ttftItem = serverLine && elements(serverLine).find(item => item.props['data-stat'] === 'ttft')
check('TTFT tooltip says server-side numbers cover all traffic',
  ttftItem && ttftItem.props.title.includes('ALL traffic') && ttftItem.props.title.includes('not just'),
  ttftItem ? ttftItem.props.title.slice(0, 90) : 'TTFT item missing')
const kvOnly = JSON.parse(JSON.stringify(healthServer))
kvOnly.health = { kv_cache_usage: 0.7 }
const kvOnlyText = textOf(mod.ServerCard({ server: kvOnly, models: fixture.models, labels, now: fixture.generated_at * 1000 }))
check('health line omits missing fields', kvOnlyText.includes('KV cache') && !kvOnlyText.includes('Prefix hit') && !kvOnlyText.includes('memory'),
  kvOnlyText.slice(0, 80))
const noHealthText = textOf(mod.ServerCard({ server: fixture.servers.find(s => s.name === 'studio-ds4'), models: fixture.models, labels, now: fixture.generated_at * 1000 }))
check('server card with no health block renders no health line',
  !noHealthText.includes('Prefix hit') && !noHealthText.includes('time per token') && !noHealthText.includes('memory '),
  'studio-ds4 has no health block')

// 6. The whole page renders without undefined components and shows the swim
//    lane canvas.
const page = mod.FlightdeckPage({})
const pageElements = elements(page)
const canvas = pageElements.find(item => item.type === 'canvas')
check('page renders the swim lane canvas', canvas && String(canvas.props['aria-label'] || '').includes('cloud model'), canvas ? canvas.props['aria-label'].slice(0, 60) : 'canvas missing')
// Legend appears exactly once: the header meta carries no encoding text, the
// footer carries the only 'colour = agent'-style line, once on the page.
const swimSection = pageElements.find(item =>
  item.type === 'section' && textOf(item).startsWith('Swim lane') && elements(item).some(el => el.type === 'canvas'))
check('swim lane section header drops the duplicated legend copy',
  swimSection && !textOf(swimSection).includes('dim = prefill'),
  swimSection ? textOf(swimSection).slice(0, 80) : 'section missing')
let legendLineCount = 0
walk(page, item => {
  if (item.kind === 'text' && item.text.includes('colour = agent')) legendLineCount += 1
})
check('the legend line appears exactly once on the page (footer only)', legendLineCount === 1, `${legendLineCount} copies`)
// The live fixture paints no beyond-slots bar, so the honest conditional
// legend drops that swatch there; seed a 9th request starting after the first
// four overlap so the drawn lanes contain every phase at least once.
const phaseAllSnapshot = JSON.parse(JSON.stringify(fixture))
const phaseServer = phaseAllSnapshot.servers.find(s =>
  s.name === 'studio-ds4' && Array.isArray(s.requests) && s.requests.length)
// Make every window row overlap in time (so slots=4 runs out and rows go
// beyond-slots) and clone the whole-response row four more times: then the
// drawn lane contains at least one bar of each phase — waiting (TTFT inside
// the bar), generating, hatched whole, and dashed queued.
phaseServer.requests = phaseServer.requests
  .filter(r => r.started_at != null && r.ended_at != null)
  .map(r => ({ ...r, started_at: 1794094925, ended_at: 1794094940, first_chunk_at: 1794094928 }))
const phaseWhole = fixture.servers
  .find(s => s.name === 'studio-ds4').requests
  .find(r => r.first_chunk_at == null || r.ended_at == null)
// UI v2: 'not streamed' (hatched) is a verdict on a FINISHED row only — an
// in-flight row with no first chunk is still waiting. The seeded whole rows are
// finished with no first chunk.
for (let i = 0; i < 4; i += 1) {
  const seeded = JSON.parse(JSON.stringify(phaseWhole))
  phaseServer.requests.push({ ...seeded, first_chunk_at: null, ended_at: seeded.started_at + 6, status: 'done', session_id: `phase-queued-${i}` })
}
// The page renders the swim lane from querySnapshot, so seed the lane there
// too — otherwise the page below honestly omits the queued swatch and the
// 'every phase' assertion tests nothing.
querySnapshot = phaseAllSnapshot
// Check the swim lane's own phase computation first — the legend renders a
// swatch only when a DRAWN bar uses that phase, and a seeded lane with no
// beyond-slots bar would otherwise be an invisible test bug.
// (The lane's `detail` doubles as fix-1's assertion: local lanes now read
// '<n> req · <m> streamed' from laneWindowCounts, never live running/slots.)
const phaseLanes = mod.swimLanes(phaseAllSnapshot, 300, fixture.generated_at * 1000).lanes
const phaseLane = phaseLanes.find(l => l.label === 'studio-ds4')
check('local lane detail uses the req/streamed form (fix 1: no live running/slots)',
  phaseLane && /^\d+ req · \d+ streamed$/.test(phaseLane.detail)
    && !/slots/.test(phaseLane.detail)
    && Number(phaseLane.detail.match(/^(\d+)/)[1]) === phaseLane.bars.length
    && Number(phaseLane.detail.match(/· (\d+) streamed/)[1]) === phaseLane.bars.filter(b => !b.whole).length,
  phaseLane ? `${phaseLane.detail}, ${phaseLane.bars.length} bars, ${phaseLane.bars.filter(b => b.whole).length} whole` : 'lane missing')
const phaseSeen = {
  waiting: phaseLane && phaseLane.bars.some(b => !b.whole && b.request && b.request.first_chunk_at != null && b.request.first_chunk_at > b.start),
  generating: phaseLane && phaseLane.bars.some(b => !b.whole),
  whole: phaseLane && phaseLane.bars.some(b => b.whole),
  queued: phaseLane && phaseLane.slots != null && phaseLane.bars.some(b => b.slot >= phaseLane.slots)
}
check('the seeded fixture actually draws every phase (waiting/generating/whole/queued)',
  phaseSeen.waiting && phaseSeen.generating && phaseSeen.whole && phaseSeen.queued,
  Object.entries(phaseSeen).map(([k, v]) => `${k}=${v}`).join(' '))
// The page's swim lane reads its snapshot from the query cache, so the render
// below has to happen WHILE querySnapshot is the seeded lane — building the
// text with the fixture restored would honestly omit the queued swatch.
const phaseAllPage = textOf(mod.FlightdeckPage({}))
querySnapshot = fixture
// The legend's no-decode/prefill assertion belongs to the swim lane section:
// the page legitimately carries 'decode / prefill' on the server cards' own
// tok/s chart, so a whole-page absence check would assert something false.
const phaseSwimSection = elements(mod.FlightdeckPage({})).find(item =>
  item.type === 'section' && textOf(item).startsWith('Swim lane') && elements(item).some(el => el.type === 'canvas'))
check('legend renders every phase swatch when a drawn bar uses it (and the agent rule)',
  phaseAllPage.includes('waiting for first token')
    && phaseAllPage.includes('generating')
    && phaseAllPage.includes('not streamed (whole response)')
    && phaseAllPage.includes('queued (beyond slots)')
    && phaseAllPage.includes('colour = agent')
    && phaseAllPage.includes('rows = requests running at the same time')
    && phaseSwimSection && !textOf(phaseSwimSection).includes('prefill')
    && !textOf(phaseSwimSection).includes('decode'),
  phaseAllPage.slice(0, 160))
check('legend omits swatches for phases no drawn bar uses, keeps the agent sentence',
  !!swimSection && textOf(swimSection).includes('waiting for first token')
    && textOf(swimSection).includes('generating')
    && textOf(swimSection).includes('not streamed (whole response)')
    && !textOf(swimSection).includes('queued (beyond slots)')
    && textOf(swimSection).includes('colour = agent')
    && textOf(swimSection).includes('rows = requests running at the same time')
    && !textOf(swimSection).includes('prefill') && !textOf(swimSection).includes('decode'),
  swimSection ? textOf(swimSection).slice(0, 160) : 'section missing')
check('swim lane section header keeps the window + ordering meta',
  swimSection && textOf(swimSection).includes('local lanes first, then cloud'),
  swimSection ? textOf(swimSection).slice(0, 90) : 'section missing')

// 7. Routing: the placement chip on a routed subagent row and the Routing strip
//    at the bottom of By model (CAPACITY.md §9). The fixture carries no routing
//    block or decisions, so this is a copy with both seeded.
const routingSnapshot = JSON.parse(JSON.stringify(fixture))
routingSnapshot.routing = {
  armed: true, backend: 'flightdeck', inner_backend: 'default', blocked_by: null, message: '',
  eligible_lanes: [{ name: 'ds4', base_url: 'http://127.0.0.1:18010' },
                   { name: 'GN100', base_url: 'http://127.0.0.1:18009' }]
}
routingSnapshot.decisions = [
  { decided_at: fixture.generated_at - 30, action: 'move', requested_lane: 'ds4', chosen_lane: 'GN100',
    chosen_model: 'qwen38-flash-next-tf-fp4', reason: 'ds4 full 4/4, model qwen38-flash-next-tf-fp4',
    goal: 'metrics adapters' },
  { decided_at: fixture.generated_at - 90, action: 'stay', requested_lane: 'ds4', chosen_lane: 'ds4',
    chosen_model: 'ds4', reason: '2 of 4 slots free, queue empty', goal: 'write the capacity tests' },
  { decided_at: fixture.generated_at - 150, action: 'skip', requested_lane: 'ds4', chosen_lane: null,
    chosen_model: null, reason: 'all local lanes full: ds4 4/4, GN100 5/5', goal: 'review the routing chip' },
  { decided_at: fixture.generated_at - 210, action: 'move', requested_lane: 'ds4', chosen_lane: 'GN100',
    chosen_model: 'qwen38-flash-next-tf-fp4', reason: 'ds4 queue 2', goal: 'seed the fixture' },
  { decided_at: fixture.generated_at - 270, action: 'stay', requested_lane: 'ds4', chosen_lane: 'ds4',
    chosen_model: 'ds4', reason: '1 of 4 slots free, queue empty', goal: 'wire the strip' },
  { decided_at: fixture.generated_at - 330, action: 'move', requested_lane: 'ds4', chosen_lane: 'GN100',
    chosen_model: 'qwen38-flash-next-tf-fp4', reason: 'oldest placement', goal: 'must not render' }
]
routingSnapshot.agents[0].children[0].routed = {
  action: 'move', lane: 'GN100', requested_lane: 'ds4',
  reason: 'ds4 full 4/4, model qwen38-flash-next-tf-fp4',
  model: 'qwen38-flash-next-tf-fp4', at: fixture.generated_at - 30
}
const routedTree = mod.AgentView({ snapshot: routingSnapshot, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60 })
const routedChipEl = elements(routedTree).find(item => item.props['data-routed'] != null)
check('routed subagent row carries the routed chip',
  routedChipEl && routedChipEl.props['data-routed'] === 'GN100' &&
  textOf(routedChipEl).includes('routed → GN100'),
  routedChipEl ? textOf(routedChipEl) : 'chip missing')
check('routed chip tooltips the full reason and goal',
  routedChipEl && routedChipEl.props.title.includes('ds4 full 4/4, model qwen38-flash-next-tf-fp4') &&
  routedChipEl.props.title.includes('goal: Execute /Users/openclaw'),
  routedChipEl ? routedChipEl.props.title.slice(0, 90) : 'chip missing')
check('only the routed subagent row carries the chip',
  countIn(routedTree, 'data-routed') === 1, `${countIn(routedTree, 'data-routed')} chips`)

function stripTitle(strip) {
  const header = elements(strip).find(item => item.props.title && item.props['data-decision'] == null)
  return header ? header.props.title : ''
}
const routingView = mod.ModelView({ snapshot: routingSnapshot, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null })
const routingViewText = textOf(routingView)
const orderIdx = {
  swim: routingViewText.indexOf('Swim lane'),
  local: routingViewText.indexOf('Local servers'),
  cloud: routingViewText.indexOf('Cloud lanes'),
  routing: routingViewText.indexOf('Routing')
}
check('By model orders swim lane, local servers, cloud lanes, then routing',
  orderIdx.swim >= 0 && orderIdx.swim < orderIdx.local &&
  orderIdx.local < orderIdx.cloud && orderIdx.cloud < orderIdx.routing,
  `swim ${orderIdx.swim} < local ${orderIdx.local} < cloud ${orderIdx.cloud} < routing ${orderIdx.routing}`)
const strip = elements(routingView).find(item => item.props['data-routing-strip'] != null)
check('By model ends with the Routing strip',
  strip && strip.props['data-routing-strip'] === 'armed',
  strip ? strip.props['data-routing-strip'] : 'strip missing')
const stripText = textOf(strip || {})
check('Routing strip shows the armed state',
  stripText.includes('Routing') && stripText.includes('armed'), stripText.slice(0, 80))
check('Routing strip shows the last 5 placements, not the 6th',
  countIn(strip, 'data-decision') === 5 && stripText.includes('last 5 placements') &&
  !stripText.includes('must not render'),
  `${countIn(strip, 'data-decision')} rows`)
check('Routing strip shows time, from → to, reason and goal',
  stripText.includes('30s ago') && stripText.includes('ds4 → GN100') &&
  stripText.includes('ds4 full 4/4, model qwen38-flash-next-tf-fp4') &&
  stripText.includes('metrics adapters'), stripText.slice(0, 160))
check('Routing strip shows a skip with no chosen lane as unrouted',
  stripText.includes('ds4 → unrouted'), stripText.includes('ds4 → unrouted') ? 'skip row' : stripText.slice(0, 160))

const blockedSnapshot = JSON.parse(JSON.stringify(routingSnapshot))
blockedSnapshot.routing = {
  armed: false, backend: 'model_map', inner_backend: 'default', blocked_by: 'model_map',
  message: "Flightdeck routing is on but delegation.backend is 'model_map' (capacity-routing). "
    + "Switch with `/delegation flightdeck --now` (or `hermes config set delegation.backend flightdeck`).",
  eligible_lanes: []
}
const blockedStrip = elements(mod.ModelView({ snapshot: blockedSnapshot, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
  .find(item => item.props['data-routing-strip'] != null)
check('Routing strip names the backend that blocks it',
  blockedStrip && blockedStrip.props['data-routing-strip'] === 'blocked by model_map' &&
  stripTitle(blockedStrip).includes('/delegation flightdeck --now'),
  blockedStrip ? stripTitle(blockedStrip).slice(0, 90) : 'strip missing')

const offSnapshot = JSON.parse(JSON.stringify(routingSnapshot))
offSnapshot.routing = {
  armed: false, backend: 'flightdeck', inner_backend: 'default', blocked_by: null,
  message: '', eligible_lanes: []
}
const offStrip = elements(mod.ModelView({ snapshot: offSnapshot, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
  .find(item => item.props['data-routing-strip'] != null)
check('Routing strip says off and tooltips the enable instruction',
  offStrip && offStrip.props['data-routing-strip'] === 'off' &&
  stripTitle(offStrip).includes('route_delegation') &&
  stripTitle(offStrip).includes('/delegation flightdeck --now'),
  offStrip ? stripTitle(offStrip).slice(0, 90) : 'strip missing')
check('Routing off renders one compact line, no placements',
  offStrip && textOf(offStrip).includes('Capacity routing: off') &&
  !textOf(offStrip).includes('last 5 placements') &&
  countIn(offStrip, 'data-decision') === 0,
  offStrip ? textOf(offStrip).slice(0, 120) : 'strip missing')

const unavailableStrip = elements(mod.ModelView({ snapshot: fixture, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
  .find(item => item.props['data-routing-strip'] != null)
check('Routing strip says unavailable with no routing block',
  unavailableStrip && unavailableStrip.props['data-routing-strip'] === 'unavailable' &&
  stripTitle(unavailableStrip).includes('capacity.py'),
  unavailableStrip ? stripTitle(unavailableStrip).slice(0, 90) : 'strip missing')

// 8. Row-carried metadata (state.db): a session row with its own title and no
//    session.list labels must render that title, its source, and its started day.
const rowMetaSnapshot = JSON.parse(JSON.stringify(fixture))
const ROW_META_ID = '20261108_073655_dd0211'
const rowMetaAgent = rowMetaSnapshot.agents.find(node => node.kind === 'session')
rowMetaAgent.session_id = ROW_META_ID
rowMetaAgent.title = 'Flightdeck hackathon'
rowMetaAgent.source = 'cli'
rowMetaAgent.started_at = 1793789991.450546
const rowMetaTree = mod.AgentView({ snapshot: rowMetaSnapshot, labels: {}, now: fixture.generated_at * 1000, windowSeconds: 60 })
const rowMetaText = textOf(rowMetaTree)
check('agent row prefers the snapshot row title over the date-id fallback',
  rowMetaText.includes('Flightdeck hackathon') && !rowMetaText.includes(`session ${ROW_META_ID.slice(0, 8)}`),
  rowMetaText.includes('Flightdeck hackathon') ? 'row title rendered' : 'row title missing')
check('agent row renders the snapshot row source badge', rowMetaText.includes('cli'),
  rowMetaText.includes('cli') ? 'cli badge' : 'source badge missing')
check('agent row renders the snapshot row started day', rowMetaText.includes('started Nov 4'),
  rowMetaText.includes('started Nov 4') ? 'started Nov 4' : rowMetaText.slice(0, 120))

// 9. demo badge (page header) + empty_reason copy (By model empty state).
const demoSnapshot = JSON.parse(JSON.stringify(fixture))
demoSnapshot.demo = true
querySnapshot = demoSnapshot
const demoPageText = textOf(mod.FlightdeckPage({}))
querySnapshot = fixture
check('page header shows the demo data badge when snapshot.demo', demoPageText.includes('demo data'),
  demoPageText.includes('demo data') ? 'demo badge' : 'badge missing')
const demoBadge = elements(mod.FlightdeckPage({})).find(item => textOf(item).trim() === 'demo data')
querySnapshot = demoSnapshot
const demoBadgeNode = elements(mod.FlightdeckPage({})).find(item => item.props.title && textOf(item).trim() === 'demo data')
querySnapshot = fixture
check('demo badge tooltips the demo_mode switch',
  demoBadgeNode && demoBadgeNode.props.title.includes('demo_mode') && demoBadgeNode.props.title.includes('Settings → Plugins → Flightdeck'),
  demoBadgeNode ? demoBadgeNode.props.title.slice(0, 80) : 'badge tooltip missing')
const noDemoText = textOf(mod.ModelView({ snapshot: fixture, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
check('no demo badge when snapshot.demo is unset', !noDemoText.includes('demo data'),
  noDemoText.includes('demo data') ? 'unexpected badge' : 'clean')
const noServersSnapshot = JSON.parse(JSON.stringify(fixture))
noServersSnapshot.servers = []
noServersSnapshot.models = []
noServersSnapshot.agents = []
noServersSnapshot.unreachable = []
noServersSnapshot.idle = []
noServersSnapshot.servers_source = 'none'
noServersSnapshot.empty_reason = 'no_servers_configured'
querySnapshot = noServersSnapshot
const emptyText = textOf(mod.ModelView({ snapshot: noServersSnapshot, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
querySnapshot = fixture
check('empty state names empty_reason=no_servers_configured',
  emptyText.includes('No model servers configured. Add servers in Settings → Plugins → Flightdeck, or turn on demo_mode to see sample data.'),
  emptyText.slice(0, 140))

// 10. Server capacity badge says the free count, not 'spare'.
const freeServer = JSON.parse(JSON.stringify(fixture.servers[0]))
freeServer.running = 1
freeServer.slots = 5
freeServer.waiting = 0
freeServer.in_flight = 1
const freeText = textOf(mod.ServerCard({ server: freeServer, models: fixture.models, labels, now: fixture.generated_at * 1000 }))
check('capacity badge shows the free count when slots are open',
  freeText.includes('4 free') && !freeText.includes('spare'), freeText.slice(0, 120))

// 11. Cloud lane left-gutter detail stays short: '<n> req · <m> streamed'.
const cloudDetail = cloudLanes.find(lane => /\d+ req · \d+ streamed/.test(lane.detail || ''))
check('cloud lane detail is the short req/streamed form', !!cloudDetail,
  cloudLanes.map(l => l.detail).join(' | '))

// 12. Unreachable rows: one compact non-overflowing line per dead server —
//     dot · name · host:port · collapsed reason · down-age · Hide. The raw
//     per-endpoint dump belongs in the tooltip only. The fixture has one
//     unreachable server; seed the two screenshot examples into a clone.
const unreachSnapshot = JSON.parse(JSON.stringify(fixture))
unreachSnapshot.unreachable = [
  { name: 'main-llm', base_url: 'http://127.0.0.1:18008', since: 1794161555.0,
    error: '/health: ConnectionResetError: [Errno 54] Connection reset by peer; /metrics: ConnectionResetError: [Errno 54] Connection reset by peer; /api/ps: ConnectionResetError: [Errno 54] Connection reset by peer; /v1/models: ConnectionResetError: [Errno 54] Connection reset by peer' },
  { name: 'qwen3.5-9b', base_url: 'http://127.0.0.1:18436', since: 1794161555.0,
    error: '/health: TimeoutError: timed out; /metrics: TimeoutError: timed out; /api/ps: TimeoutError: timed out' }
]
let hiddenItem = null
const unreachView = mod.ModelView({ snapshot: unreachSnapshot, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: item => { hiddenItem = item } })
const unreachGroup = elements(unreachView).find(item => item.props['data-unreachable-group'] != null)
const unreachRows = elements(unreachView).filter(item => item.props['data-unreachable-row'] != null)
check('unreachable section header keeps the N servers unreachable form',
  unreachGroup && textOf(unreachGroup).includes('2 servers unreachable'),
  unreachGroup ? textOf(unreachGroup).slice(0, 40) : 'section missing')
const rowNamed = name => unreachRows.find(item => textOf(item).includes(name))
const resetRow = rowNamed('main-llm')
const timeoutRow = rowNamed('qwen3.5-9b')
check('unreachable row shows the name and the collapsed reason',
  resetRow && textOf(resetRow).includes('main-llm') && textOf(resetRow).includes('connection reset')
    && timeoutRow && textOf(timeoutRow).includes('qwen3.5-9b') && textOf(timeoutRow).includes('timed out'),
  unreachRows.map(item => textOf(item).slice(0, 60)).join(' | '))
check('unreachable row drops the scheme from the base_url',
  resetRow && textOf(resetRow).includes('127.0.0.1:18008') && !textOf(resetRow).includes('http://'),
  resetRow ? textOf(resetRow).slice(0, 80) : 'row missing')
check('unreachable row tooltips the full raw error, one endpoint per line',
  resetRow && resetRow.props.title && resetRow.props.title.includes('/metrics')
    && resetRow.props.title.includes('\n/metrics:'),
  resetRow && resetRow.props.title ? resetRow.props.title.slice(0, 60) : 'no tooltip')
const textCells = unreachRows.map(row =>
  elements(row).find(e => e.props.style && e.props.style.whiteSpace === 'nowrap'))
check('unreachable text cell can never overflow: nowrap + ellipsis + minWidth 0',
  unreachRows.length === 2 && textCells.length === 2
    && textCells.every(e => e.props.style.textOverflow === 'ellipsis' && e.props.style.minWidth === 0
      && e.props.style.overflow === 'hidden'),
  textCells.length ? JSON.stringify(textCells[0].props.style) : 'no ellipsis cell')
const hideButtons = unreachRows.map(row =>
  elements(row).find(e => e.props['data-hide-unreachable'] != null && typeof e.props.onClick === 'function'))
check('every unreachable row carries a Hide button',
  unreachRows.length === 2 && hideButtons.every(Boolean),
  `${hideButtons.filter(Boolean).length}/${unreachRows.length} hide buttons`)
if (hideButtons[0]) hideButtons[0].props.onClick()
check('Hide routes through the idle group\'s hideServer mechanism',
  hiddenItem && hiddenItem.base_url === 'http://127.0.0.1:18008',
  hiddenItem ? hiddenItem.base_url : 'onHide not called')
const hiddenUnreach = JSON.parse(JSON.stringify(unreachSnapshot))
// The snapshot echoes the hidden_servers filter it ran with, and a hidden entry
// also carries `hidden: true`: either way the row is gone, from the list and
// from the count.
hiddenUnreach.unreachable = unreachSnapshot.unreachable.map(item =>
  String(item.base_url || '').replace(/\/+$/, '') === 'http://127.0.0.1:18008'
    ? { ...item, hidden: true } : item)
hiddenUnreach.hidden_servers = ['http://127.0.0.1:18008']
const hiddenUnreachText = textOf(mod.ModelView({ snapshot: hiddenUnreach, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
check('hidden unreachable servers drop from the list and the count',
  !hiddenUnreachText.includes('main-llm') && hiddenUnreachText.includes('1 server unreachable')
    && hiddenUnreachText.includes('qwen3.5-9b'),
  (hiddenUnreachText.match(/\d+ servers? unreachable/) || [''])[0])
const echoHidden = JSON.parse(JSON.stringify(unreachSnapshot))
echoHidden.hidden_servers = ['main-llm']
const echoHiddenText = textOf(mod.ModelView({ snapshot: echoHidden, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
check('hidden_servers matching by name also drops the unreachable row',
  !echoHiddenText.includes('main-llm') && echoHiddenText.includes('1 server unreachable'),
  (echoHiddenText.match(/\d+ servers? unreachable/) || [''])[0])

const mixedReason = mod.unreachableReason
  ? mod.unreachableReason('/health: ConnectionResetError: [Errno 54] Connection reset by peer; /metrics: TimeoutError: timed out; /api/ps: ConnectionRefusedError: [Errno 61] Connection refused')
  : null
check('mixed error classes collapse to the first plus (+n more)',
  mixedReason === 'connection reset (+2 more)', String(mixedReason))
const httpReason = mod.unreachableReason
  ? mod.unreachableReason('/health: HTTP 503: Service Unavailable; /metrics: TimeoutError: timed out; /v1/models: HTTP 503: Service Unavailable')
  : null
check('an HTTP class is the verdict and folds transport noise behind it',
  httpReason === 'HTTP 503 (+1 more)', String(httpReason))
const refusedReason = mod.unreachableReason
  ? mod.unreachableReason('/health: ConnectionRefusedError: [Errno 61] Connection refused; /metrics: ConnectionRefusedError: [Errno 61] Connection refused')
  : null
const hostReason = mod.unreachableReason
  ? mod.unreachableReason('/health: URLError: nodename nor servname provided, or not known')
  : null
check('refused / host-not-found / timeout classes map to plain words',
  refusedReason === 'connection refused' && hostReason === 'host not found'
    && mod.unreachableReason('/health: TimeoutError: timed out') === 'timed out',
  [refusedReason, hostReason].join(' | '))
const longReason = mod.unreachableReason
  ? mod.unreachableReason('/health: WeirdVendorError: ' + 'x'.repeat(120))
  : null
check('an unknown class falls back to the first message trimmed to ~60 chars',
  longReason === 'WeirdVendorError: ' + 'x'.repeat(40) + '…', String(longReason))
const noSince = JSON.parse(JSON.stringify(unreachSnapshot))
noSince.unreachable = [{ name: 'no-since', base_url: 'http://127.0.0.1:19000', error: '/health: URLError: unknown' }]
const noSinceRow = elements(mod.ModelView({ snapshot: noSince, labels,
  now: fixture.generated_at * 1000, windowSeconds: 60, onHide: null }))
  .find(item => item.props['data-unreachable-row'] != null)
check('unreachable row omits the down-age when since is missing',
  noSinceRow && !textOf(noSinceRow).includes('down') && textOf(noSinceRow).includes('URLError: unknown'),
  noSinceRow ? textOf(noSinceRow).slice(0, 80) : 'row missing')

// 13. Cloud card: the tok/s chart comes from Hermes' own request rows, the
//     snapshot quota block renders under the metrics, and the holder line
//     resolves agent row titles instead of the raw session id.
const cloudSnap = JSON.parse(JSON.stringify(fixture))
const cloudModel = cloudSnap.models.find(model => model.lane === 'cloud')
cloudModel.requests = [
  { session_id: '20261107_174026_d25bb8', started_at: fixture.generated_at - 40,
    first_chunk_at: fixture.generated_at - 38, ended_at: fixture.generated_at - 20,
    prompt_tokens: 120, completion_tokens: 60, status: 'done' },
  { session_id: '20261107_174026_d25bb8', started_at: fixture.generated_at - 30,
    first_chunk_at: fixture.generated_at - 28, ended_at: fixture.generated_at - 10,
    prompt_tokens: 80, completion_tokens: 40, status: 'done' }
]
const cloudCardText = textOf(mod.CloudCard({ model: cloudModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
check('cloud card charts Hermes-observed decode/prefill, not request buckets',
  cloudCardText.includes('Hermes-observed') && cloudCardText.includes('decode / prefill')
    && !cloudCardText.includes('requests, last'),
  cloudCardText.slice(0, 160))
const quotaModel = { ...cloudModel, quota: {
  windows: [{ label: '5-hour', used_percent: 42, remaining_percent: 58,
    reset_at: fixture.generated_at + 7200 }]
} }
const quotaText = textOf(mod.CloudCard({ model: quotaModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
check('cloud card renders the snapshot quota windows',
  quotaText.includes('5-hour') && quotaText.includes('42% used'), quotaText.slice(0, 160))
const unavailableText = textOf(mod.CloudCard({ model: { ...cloudModel,
  quota: { unavailable_reason: 'timeout', windows: [] } }, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
check('cloud card renders an unavailable quota honestly',
  unavailableText.includes('plan usage unavailable'), unavailableText.slice(0, 160))
const noQuotaText = textOf(mod.CloudCard({ model: { ...cloudModel, quota: null }, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
check('cloud card renders no quota line when the quota is null',
  !noQuotaText.includes('5-hour') && !noQuotaText.includes('plan usage unavailable'),
  noQuotaText.slice(0, 160))

// 14. Live plan usage from the public model.options RPC: the backend only fills
//     model.quota in demo mode, so a live cloud card reads provider usage.
const usageIso = new Date((fixture.generated_at + 7200) * 1000).toISOString()
providerUsageResult = { providers: [
  { slug: 'claude-subscription-directsdk-experimental', name: 'Claude',
    usage: { windows: [{ label: '5-hour', used_percent: 42, resets_at: usageIso, scope: 'account' }] } }
] }
const usageMap = mod.useProviderUsage()
check('provider usage map keys by lowercase provider slug',
  usageMap.get('claude-subscription-directsdk-experimental') != null,
  `${usageMap.size} providers`)
const usageText = textOf(mod.CloudCard({ model: { ...cloudModel, quota: null }, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap }))
check('cloud card renders live model.options usage when model.quota is null',
  usageText.includes('5-hour') && usageText.includes('42% used'), usageText.slice(0, 160))
check('ok usage renders bars and no waiting line',
  usageText.includes('5-hour') && !usageText.includes('waiting for Hermes')
    && !usageText.includes('could not ask Hermes'), usageText.slice(0, 160))

// 14a. A provider row that exists but has no numeric window yet (all accounts
//      unknown, or no usage key) must say so instead of rendering nothing.
providerUsageResult = { providers: [
  { slug: 'anthropic', name: 'Anthropic', usage: { accounts: [
    { label: 'ANTHROPIC_TOKEN', windows: [], state: 'unknown' },
    { label: 'claude_code', windows: [], state: 'unknown' }
  ] } }
] }
const pendingMap = mod.useProviderUsage()
const pendingModel = { ...cloudModel, provider: 'anthropic', quota: null }
const pendingText = textOf(mod.CloudCard({ model: pendingModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: pendingMap }))
check('provider row with accounts all unknown renders the waiting line',
  pendingText.includes("plan usage: waiting for Hermes to read the provider's limits")
    && !pendingText.includes('could not ask Hermes'), pendingText.slice(0, 200))
const pendingLine = elements(mod.CloudCard({ model: pendingModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: pendingMap }))
  .find(el => el.props.title && String(el.props.title).includes('last checked'))
check('waiting line carries the model.options diagnostic tooltip',
  pendingLine && String(pendingLine.props.title).includes('model.options')
    && String(pendingLine.props.title).includes('hermes usage')
    && String(pendingLine.props.title).includes('last checked'),
  pendingLine ? pendingLine.props.title : 'no tooltip')

// 14b. A failed model.options call gets its own line, not a silent blank.
providerUsageError = true
const errorMap = mod.useProviderUsage()
const errorText = textOf(mod.CloudCard({ model: pendingModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: errorMap }))
check('model.options error renders the could-not-ask line',
  errorText.includes('plan usage: could not ask Hermes (model.options failed)')
    && !errorText.includes('waiting for Hermes'), errorText.slice(0, 200))
providerUsageError = false

// 14c. A provider absent from model.options is one that never reports usage:
//      the card stays clean, with no plan-usage line at all.
providerUsageResult = { providers: [
  { slug: 'other-provider', name: 'Other', usage: { windows: [
    { label: 'Weekly', used_percent: 5, resets_at: usageIso, scope: 'account' }] } }
] }
const absentMap = mod.useProviderUsage()
const absentText = textOf(mod.CloudCard({ model: pendingModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: absentMap }))
check('provider absent from model.options renders no plan-usage line',
  !absentText.includes('plan usage:') && !absentText.includes('waiting for Hermes')
    && !absentText.includes('could not ask Hermes'), absentText.slice(0, 200))

// 14d. Anthropic's two-account shape: the token account is unknown, the
//      claude_code account has the real windows; the card shows the latter.
providerUsageResult = { providers: [
  { slug: 'anthropic', name: 'Anthropic', usage: { accounts: [
    { label: 'ANTHROPIC_TOKEN', windows: [], state: 'unknown' },
    { label: 'claude_code', windows: [
      { label: 'Current week', used_percent: 12, resets_at: usageIso, scope: 'account' }],
      state: 'ready' }
  ] } }
] }
const twoAccountMap = mod.useProviderUsage()
const twoAccountText = textOf(mod.CloudCard({ model: pendingModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: twoAccountMap }))
check('anthropic two-account shape renders the claude_code Current week',
  twoAccountText.includes('Current week') && twoAccountText.includes('12% used')
    && twoAccountText.includes('account: claude_code')
    && !twoAccountText.includes('ANTHROPIC_TOKEN')
    && !twoAccountText.includes('waiting for Hermes'), twoAccountText.slice(0, 240))
const demoUsageModel = { ...cloudModel, quota: { windows: [{ label: 'weekly', used_percent: 10,
  remaining_percent: 90, reset_at: fixture.generated_at + 7200 }] } }
const demoUsageText = textOf(mod.CloudCard({ model: demoUsageModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap }))
check('demo model.quota takes precedence over live provider usage',
  demoUsageText.includes('weekly') && !demoUsageText.includes('5-hour'), demoUsageText.slice(0, 160))
// 14b. A provider's usage fetch can fail intermittently (the Claude Code CLI
//      outlasts its 8 s timeout). Keep the last good reading, labelled with its
//      age; older than 15 min, show nothing; a fresh reading clears the label.
providerUsageResult = { providers: [
  { slug: 'claude-subscription-directsdk-experimental', name: 'Claude', usage: null }
] }
const staleMap = mod.useProviderUsage()
const staleText = textOf(mod.CloudCard({ model: { ...cloudModel, quota: null }, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: staleMap }))
check('a failed refresh keeps the last good usage, labelled stale',
  staleText.includes('5-hour') && staleText.includes('42% used')
    && staleText.includes('last refresh failed'),
  staleText.slice(0, 240))
const staleQuota = mod.providerUsageToQuota(staleMap.get('claude-subscription-directsdk-experimental'))
check('stale usage carries as_of in seconds and a tooltip on the age line',
  staleQuota && staleQuota.as_of != null && staleQuota.as_of > 0
    && elements(mod.PlanUsage({ quota: staleQuota })).some(el =>
      el.props.title === "The provider's usage check did not answer on the last refresh; showing the most recent good reading."),
  staleQuota ? `as_of=${staleQuota.as_of}` : 'no quota')
const expiredMap = mod.mergeProviderUsage({ providers: [
  { slug: 'claude-subscription-directsdk-experimental', name: 'Claude', usage: null }
] }, Date.now() + 16 * 60 * 1000)
const expiredText = textOf(mod.CloudCard({ model: { ...cloudModel, quota: null }, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: expiredMap }))
check('last good usage older than 15 min renders nothing',
  !expiredText.includes('5-hour') && !expiredText.includes('last refresh failed'),
  expiredText.slice(0, 160))
providerUsageResult = { providers: [
  { slug: 'claude-subscription-directsdk-experimental', name: 'Claude',
    usage: { windows: [{ label: '5-hour', used_percent: 42, resets_at: usageIso, scope: 'account' }] } }
] }
const freshMap = mod.useProviderUsage()
const freshText = textOf(mod.CloudCard({ model: { ...cloudModel, quota: null }, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap, usageMap: freshMap }))
check('a fresh usage reading clears the stale label',
  freshText.includes('5-hour') && freshText.includes('42% used')
    && !freshText.includes('last refresh failed'),
  freshText.slice(0, 160))
const accountQuota = mod.providerUsageToQuota({ windows: [], accounts: [
  { id: 'a1', label: 'Account 2', windows: [{ label: 'weekly', used_percent: 25,
    resets_at: usageIso, scope: 'model' }] }
] })
check('provider usage falls back to the first account with windows, untitled when alone',
  accountQuota && accountQuota.title === null
    && accountQuota.windows[0].detail === 'model-specific cap'
    && accountQuota.windows[0].reset_at === Date.parse(usageIso) / 1000,
  JSON.stringify(accountQuota))
const singleAccountQuota = mod.providerUsageToQuota({ windows: [], accounts: [
  { id: 'openai-codex-oauth-1', label: 'openai-codex-oauth-1', windows: [
    { label: 'Weekly', used_percent: 5, resets_at: usageIso, scope: 'account' }] }
] })
const singleAccountText = textOf(mod.PlanUsage({ quota: singleAccountQuota }))
check('single credential-pool account renders no raw account id',
  singleAccountQuota && singleAccountQuota.title === null
    && singleAccountText.includes('Weekly')
    && !singleAccountText.includes('openai-codex-oauth-1'),
  singleAccountText.slice(0, 200))
const poolQuota = mod.providerUsageToQuota({ windows: [], accounts: [
  { id: 'openai-codex-oauth-1', label: 'openai-codex-oauth-1', windows: [
    { label: 'Weekly', used_percent: 5, resets_at: usageIso, scope: 'account' }] },
  { id: 'openai-codex-oauth-2', label: 'openai-codex-oauth-2', windows: [
    { label: 'Weekly', used_percent: 9, resets_at: usageIso, scope: 'account' }] }
] })
const poolText = textOf(mod.PlanUsage({ quota: poolQuota }))
check('multi-account pool renders a numbered account title, not a raw id',
  poolQuota && poolQuota.title === 'account 1 of 2'
    && poolText.includes('account 1 of 2')
    && !poolText.includes('openai-codex-oauth'),
  poolText.slice(0, 200))
check('provider usage with no numeric window returns null',
  mod.providerUsageToQuota({ windows: [{ label: 'x', used_percent: null }] }) === null)
// Plan usage rows: the label cell must fit the longest window label whole
// ('Current session'/'Current week' used to truncate to 'Current …'), and a
// model-scoped window reads '· model cap' instead of 'model-specific cap'.
const planQuota = mod.providerUsageToQuota({ windows: [
  { label: 'Current session', used_percent: 5, resets_at: usageIso, scope: 'account' },
  { label: 'Current week', used_percent: 12, resets_at: usageIso, scope: 'account' },
  { label: 'Fable week', used_percent: 0, resets_at: usageIso, scope: 'model' }
] })
const planNode = mod.PlanUsage({ quota: planQuota })
const planText = textOf(planNode)
check('plan usage rows render full window labels and one model cap suffix',
  planText.includes('Current session') && planText.includes('Current week')
    && planText.includes('Fable week') && planText.includes('model cap')
    && (planText.match(/model cap/g) || []).length === 1
    && !planText.includes('model-specific cap'),
  planText.slice(0, 200))
const planLabelSpans = elements(planNode).filter(item =>
  item.props.title === 'Current session' || item.props.title === 'Current week'
    || item.props.title === 'Fable week')
check('plan usage label cells are nowrap with the full label as tooltip',
  planLabelSpans.length === 3
    && planLabelSpans.every(item => item.props.style && item.props.style.whiteSpace === 'nowrap'
      && item.props.style.minWidth && !String(item.props.className).includes('truncate')),
  planLabelSpans.map(item => `${item.props.title}@${item.props.style && item.props.style.minWidth}`).join(', '))

// 14c. Two cloud cards on one Claude subscription: the API lane and the
//      subscription-direct lane report the same plan a minute apart. The card
//      with more windows keeps the bars; the other shows one shared-plan line.
//      Different numbers keep both cards' bars. planFingerprint is the gate.
const sharedPlanT = 1762552800
const baseCloudModel = JSON.parse(JSON.stringify(fixture.models.find(model => model.lane === 'cloud')))
const anthropicPlanModel = {
  ...baseCloudModel, key: 'anthropic|claude-opus-5-5', provider: 'anthropic',
  model: 'claude-opus-5-5', base_url: 'https://api.anthropic.com',
  quota: { windows: [{ label: 'Current week', used_percent: 6, reset_at: sharedPlanT }] }
}
const directsdkPlanModel = {
  ...baseCloudModel, key: 'claude-subscription-directsdk-experimental|claude-opus-5-5',
  provider: 'claude-subscription-directsdk-experimental', model: 'claude-opus-5-5',
  base_url: 'process://claude-subscription-directsdk-experimental',
  quota: { windows: [
    { label: 'Current week', used_percent: 6, reset_at: sharedPlanT + 60 },
    { label: 'Fable week', used_percent: 0, reset_at: sharedPlanT, detail: 'model-specific cap' }
  ] }
}
const sharedPlanSnap = JSON.parse(JSON.stringify(fixture))
sharedPlanSnap.models = [anthropicPlanModel, directsdkPlanModel]
const sharedPlanView = mod.ModelView({ snapshot: sharedPlanSnap, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300 })
const sharedPlanCards = elements(sharedPlanView).filter(el => el.type === 'article')
// UI v2: the base URL rides in the header tooltip; find cards by their key.
const anthropicCard = sharedPlanCards.find(el => el.props['data-cloud-card'] === 'anthropic|claude-opus-5-5')
const directsdkCard = sharedPlanCards.find(el => el.props['data-cloud-card'] === 'claude-subscription-directsdk-experimental|claude-opus-5-5')
check('same plan: the card with more windows keeps the bars and the Fable cap',
  directsdkCard && textOf(directsdkCard).includes('Fable week')
    && textOf(directsdkCard).includes('6% used'),
  directsdkCard ? textOf(directsdkCard).slice(0, 240) : 'directsdk card missing')
check('same plan: the other card renders one shared-plan line, not the bars',
  anthropicCard && textOf(anthropicCard).includes('shared plan with claude-opus-5-5 (DirectSDK)')
    && !textOf(anthropicCard).includes('6% used') && !textOf(anthropicCard).includes('Fable week'),
  anthropicCard ? textOf(anthropicCard).slice(0, 240) : 'anthropic card missing')
check('shared-plan line carries the counts-once tooltip',
  anthropicCard && elements(anthropicCard).some(el =>
    el.props.title === 'Same subscription as the other card; usage counts once.'),
  anthropicCard ? 'tooltip missing' : 'anthropic card missing')
const differentPlanSnap = JSON.parse(JSON.stringify(sharedPlanSnap))
differentPlanSnap.models[0].quota.windows[0].used_percent = 7
const differentPlanView = mod.ModelView({ snapshot: differentPlanSnap, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300 })
const differentPlanCards = elements(differentPlanView).filter(el => el.type === 'article')
const differentAnthropic = differentPlanCards.find(el => el.props['data-cloud-card'] === 'anthropic|claude-opus-5-5')
const differentDirectsdk = differentPlanCards.find(el => el.props['data-cloud-card'] === 'claude-subscription-directsdk-experimental|claude-opus-5-5')
check('different plan numbers: both cards keep their own bars',
  differentAnthropic && differentDirectsdk
    && textOf(differentAnthropic).includes('7% used') && textOf(differentDirectsdk).includes('6% used')
    && !textOf(differentAnthropic).includes('shared plan with')
    && !textOf(differentDirectsdk).includes('shared plan with'),
  `${differentAnthropic ? textOf(differentAnthropic).slice(0, 80) : 'anthropic missing'} | ${differentDirectsdk ? textOf(differentDirectsdk).slice(0, 80) : 'directsdk missing'}`)
const sharedFingerprint = mod.planFingerprint(anthropicPlanModel.quota)
check('plan fingerprint ignores the model cap and rounds the reset to 5 minutes',
  sharedFingerprint != null && sharedFingerprint === mod.planFingerprint(directsdkPlanModel.quota),
  `${sharedFingerprint} vs ${mod.planFingerprint(directsdkPlanModel.quota)}`)
check('plan fingerprint differs when the numbers differ',
  mod.planFingerprint({ windows: [{ label: 'Current week', used_percent: 7, reset_at: sharedPlanT }] }) !== sharedFingerprint,
  mod.planFingerprint({ windows: [{ label: 'Current week', used_percent: 7, reset_at: sharedPlanT }] }))
check('plan fingerprint is null without a numeric account window',
  mod.planFingerprint(null) === null && mod.planFingerprint({ windows: [] }) === null
    && mod.planFingerprint({ windows: [{ label: 'Fable week', used_percent: 0,
      reset_at: sharedPlanT, detail: 'model-specific cap' }] }) === null,
  'null quota, empty windows, model-only windows')
check('plan fingerprint sorts windows so display order cannot split a plan',
  mod.planFingerprint({ windows: [
    { label: 'Current week', used_percent: 12, reset_at: sharedPlanT + 7200 },
    { label: 'Current session', used_percent: 5, reset_at: sharedPlanT }
  ] }) === mod.planFingerprint({ windows: [
    { label: 'Current session', used_percent: 5, reset_at: sharedPlanT },
    { label: 'Current week', used_percent: 12, reset_at: sharedPlanT + 7200 }
  ] }),
  'reversed window order')
const holderSnap = JSON.parse(JSON.stringify(fixture))
const holderModel = holderSnap.models.find(model => model.lane === 'cloud')
holderSnap.agents[0].children
  .find(row => row.session_id === '20261107_174026_d25bb8').title = 'Flightdeck hackathon'
holderModel.agents = [{ profile: 'default', session_id: '20261107_174026_d25bb8',
  label: '', in_flight: 1 }]
const holderText = textOf(mod.CloudCard({ model: holderModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: holderSnap }))
// UI v2: the row shows shortAgentLabel (a subagent's short goal); the row
// title, resolved from the snapshot row, rides in the row tooltip.
const holderRow = elements(mod.CloudCard({ model: holderModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: holderSnap }))
  .find(el => el.props['data-held-row'] === '20261107_174026_d25bb8')
check('cloud card HELD BY resolves the agent row title, not the session id',
  holderRow && String(holderRow.props.title).includes('Flightdeck hackathon') && !holderText.includes('session 2026'),
  holderRow ? `${textOf(holderRow)} | ${String(holderRow.props.title).slice(0, 80)}` : holderText.slice(0, 160))

// HELD BY: cloud cards reuse the local card's section — one row per agent with
// an in-flight request right now, never the old variable-length holder list.
const heldSnap = JSON.parse(JSON.stringify(fixture))
const heldModel = heldSnap.models.find(model => model.lane === 'cloud')
const heldSessions = [
  ['20261107_174026_d25bb8', 'Azure SFTP Server'],
  ['20261104_044650_9024bf', 'Add season and record to team header']
]
heldSnap.agents = heldSessions.map(([session_id, title]) => ({ profile: 'default', session_id, title }))
heldModel.agents = heldSessions.map(([session_id]) =>
  ({ profile: 'default', session_id, label: '', in_flight: 1 }))
heldModel.requests = heldSessions.map(([session_id], index) => ({
  profile: 'default', session_id, model: heldModel.model, status: 'in-flight',
  started_at: fixture.generated_at - 120 - index * 60, ended_at: null
}))
const heldCard = mod.CloudCard({ model: heldModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: heldSnap })
const heldCardText = textOf(heldCard)
const heldRows = elements(heldCard).filter(el =>
  el.props.className === 'flex items-center gap-2 text-[0.6875rem]')
check('cloud card HELD BY renders one row per in-flight holder with its title',
  heldCardText.includes('held by') && heldRows.length === 2
    && heldCardText.includes('Azure SFTP Server')
    && heldCardText.includes('Add season and record')
    && heldRows.some(el => String(el.props.title).includes('Add season and record to team header'))
    && !heldCardText.includes('agents holding')
    && !heldCardText.includes('Azure SFTP Server · Add season'),
  heldCardText.slice(0, 200))

const fiveSnap = JSON.parse(JSON.stringify(fixture))
const fiveModel = fiveSnap.models.find(model => model.lane === 'cloud')
const fiveTitles = ['Azure SFTP Server', 'Add season and record to team header',
  'Pick up open-threads', 'Flightdeck hackathon', 'Fifth holder']
fiveSnap.agents = fiveTitles.map((title, index) =>
  ({ profile: 'default', session_id: `holder-${index}`, title }))
fiveModel.agents = fiveTitles.map((_, index) =>
  ({ profile: 'default', session_id: `holder-${index}`, label: '', in_flight: 1 }))
fiveModel.requests = fiveTitles.map((_, index) => ({
  profile: 'default', session_id: `holder-${index}`, model: fiveModel.model,
  status: 'in-flight', started_at: fixture.generated_at - 60 - index * 10, ended_at: null
}))
const fiveCard = mod.CloudCard({ model: fiveModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: fiveSnap })
const fiveRows = elements(fiveCard).filter(el =>
  el.props.className === 'flex items-center gap-2 text-[0.6875rem]')
const moreEl = elements(fiveCard).find(el => textOf(el) === '+1 more')
check('cloud card HELD BY caps at four rows and tooltips the rest',
  fiveRows.length === 4 && moreEl && moreEl.props.title.includes('Fifth holder')
    && !textOf(fiveCard).includes('Fifth holder'),
  `${fiveRows.length} rows, more=${moreEl ? moreEl.props.title : 'missing'}`)

const finishedSnap = JSON.parse(JSON.stringify(fixture))
const finishedModel = finishedSnap.models.find(model => model.lane === 'cloud')
finishedSnap.agents = [{ profile: 'default', session_id: 'finished-1', title: 'Finished session' }]
finishedModel.agents = [{ profile: 'default', session_id: 'finished-1', label: '', in_flight: 0 }]
finishedModel.requests = [{ profile: 'default', session_id: 'finished-1',
  model: finishedModel.model, status: 'done', started_at: fixture.generated_at - 60,
  ended_at: fixture.generated_at - 10 }]
const finishedCard = mod.CloudCard({ model: finishedModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: finishedSnap })
const finishedRows = elements(finishedCard).filter(el =>
  el.props.className === 'flex items-center gap-2 text-[0.6875rem]')
check('cloud card with only finished requests renders no holders',
  textOf(finishedCard).includes('no in-flight request observed') && finishedRows.length === 0
    && !textOf(finishedCard).includes('Finished session'),
  textOf(finishedCard).slice(0, 160))

// UI v2: the chart is the full-width card footer ([data-card-chart]).
const chartContainers = [heldCard, fiveCard].map(card =>
  elements(card).find(el => el.props['data-card-chart'] === 'cloud'))
check('cloud cards with different holder counts render the same chart width',
  chartContainers.every(el => el && el.props.className === chartContainers[0].props.className
    && JSON.stringify(el.props.style || null) === JSON.stringify(chartContainers[0].props.style || null)),
  chartContainers.map(el =>
    el ? `${el.props.className} ${JSON.stringify(el.props.style || null)}` : 'missing').join(' | '))

// 15. Polish: swim-lane tooltip lines, cloud card title, section meta, whole
//     responses on cloud cards, and the local slots tooltip.
const streamedRequest = { session_id: '20261107_174026_d25bb8', model: 'claude-opus-5-5[1m]',
  started_at: fixture.generated_at - 40, first_chunk_at: fixture.generated_at - 38,
  ended_at: fixture.generated_at - 20, prompt_tokens: 94000, completion_tokens: 1234,
  status: 'done' }
const laneForTooltip = { label: 'claude-subscription-directsdk-experimental / claude-opus-5-5[1m]' }
const tooltip = mod.requestTooltip(streamedRequest, labels, holderSnap, laneForTooltip)
const tooltipLines = tooltip.split('\n')
check('request tooltip line 1 is the By-agent label, never the date id',
  tooltipLines[0].startsWith('subagent · ') && tooltipLines[0].includes('Flightdeck hackathon')
    && !tooltip.includes('20261107'), tooltipLines[0])
check('request tooltip is five lines with model on lane and a finished status',
  tooltipLines.length === 5
    && tooltipLines[1] === 'claude-opus-5-5[1m] on claude-subscription-directsdk-experimental / claude-opus-5-5[1m]'
    && tooltipLines[4] === 'finished' && !tooltip.includes('generating') && !tooltip.includes('done'),
  tooltipLines.join(' | '))
check('streamed tooltip line 3 carries first token and a guarded rate',
  tooltipLines[2].includes('first token after 2.0s')
    && tooltipLines[2].includes('generated 1,234 tok at') && tooltipLines[2].includes('tok/s'),
  tooltipLines[2])
const wholeRequest = { ...streamedRequest, first_chunk_at: fixture.generated_at - 20,
  ended_at: fixture.generated_at - 20, completion_tokens: 1000 }
const wholeTooltip = mod.requestTooltip(wholeRequest, labels, holderSnap, laneForTooltip)
check('whole-response tooltip says not streamed and prints no tok/s',
  wholeTooltip.includes('whole response after') && wholeTooltip.includes('(not streamed)')
    && !wholeTooltip.includes('tok/s') && !wholeTooltip.includes('generating'), wholeTooltip)
const shortRequest = { ...streamedRequest, first_chunk_at: fixture.generated_at - 20.4,
  ended_at: fixture.generated_at - 20, completion_tokens: 1000 }
const shortTooltip = mod.requestTooltip(shortRequest, labels, holderSnap, laneForTooltip)
check('tok/s skipped when the generating span is under 0.5 s',
  !shortTooltip.includes('tok/s') && shortTooltip.includes('first token after'), shortTooltip)
const runningRequest = { ...streamedRequest, ended_at: null }
const runningTooltip = mod.requestTooltip(runningRequest, labels, holderSnap, laneForTooltip)
check('in-flight tooltip status is running, never done',
  runningTooltip.split('\n')[4] === 'running' && !runningTooltip.includes('done'), runningTooltip.split('\n')[4])
const titleEl = elements(mod.CloudCard({ model: cloudModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
  .find(el => el.props.title === 'claude-subscription-directsdk-experimental/claude-opus-5-5[1m]')
check('cloud card title shows the short model with the full provider/model tooltip',
  titleEl && textOf(titleEl) === 'claude-opus-5-5[1m]', titleEl ? textOf(titleEl) : 'title element missing')
check('cloud section meta names Hermes-only requests and no server load',
  textOf(page).includes("only this machine's Hermes requests; providers don't publish server load"))
const wholeCloudModel = { ...cloudModel, quota: null,
  requests: cloudModel.requests.map(row => ({ ...row, first_chunk_at: row.ended_at })) }
const wholeCloudText = textOf(mod.CloudCard({ model: wholeCloudModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
const wholeCloudMetrics = elements(mod.CloudCard({ model: wholeCloudModel, labels,
  now: fixture.generated_at * 1000, windowSeconds: 300, snapshot: cloudSnap }))
// UI v2: TTFT is a BigStat (value over label); a whole-response lane shows no
// decode rate at all rather than a second 'not streamed'.
check('cloud card shows not streamed for TTFT and no decode rate when every request is whole',
  wholeCloudMetrics.some(el => el.props['data-col'] === 'ttft' && textOf(el) === 'not streamedTTFT p50')
    && !wholeCloudMetrics.some(el => el.props['data-stat'] === 'decode'),
  wholeCloudText.slice(0, 160))
const slotsEl = elements(page).find(el =>
  el.props.title === 'Requests the server can run at once; more than this wait in its queue.')
check('local card slots label carries the queue tooltip',
  slotsEl && textOf(slotsEl) === 'slots', slotsEl ? textOf(slotsEl) : 'slots label missing')

// --- UI v2 part A ---------------------------------------------------------------
// shortAgentLabel, the swim-lane tooltip card facts and the By agent card rows.
// A second factory exposes the helpers this block needs without touching the
// shared return list above (a function declaration, so it hoists for the By
// agent checks earlier in the file).
function partA() {
  if (partA.cached) return partA.cached
  const factoryA = new Function(
    'atom', 'Badge', 'Button', 'Codicon', 'EmptyState', 'ErrorState', 'ScrollArea', 'SegmentedControl',
    'Skeleton', 'StatusDot', 'cn', 'host', 'profileColor', 'useQuery', 'useValue',
    'PALETTE_AREA', 'ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'STATUSBAR_AREAS',
    'useEffect', 'useMemo', 'useRef', 'useState', 'jsx', 'jsxs',
    `${body}\nreturn { shortAgentLabel, fullAgentText, requestCardFacts, requestTooltip, agentCardFacts, AgentView, swimLanes, AGENT_STAT_W, AGENT_CHILD_LIMIT }`
  )
  partA.cached = factoryA(
    atom, Badge, Button, Component, EmptyState, Component, Component, Component,
    Component, Component, cn, host, profileColor, useQuery, useValue,
    'palette', 'routes', 'sidebar', 'statusbar',
    useEffect, useMemo, useRef, useState, jsx, jsxs, globalThis
  )
  return partA.cached
}
{
  const A = partA()
  const NOW_MS = fixture.generated_at * 1000

  // A1. shortAgentLabel: session title, subagent goal clause (≤30 chars), cron.
  const sessionShort = A.shortAgentLabel({ kind: 'session', session_id: 's-1', title: 'Flightdeck hackathon' }, {})
  check('shortAgentLabel keeps a short session title as-is', sessionShort === 'Flightdeck hackathon', sessionShort)
  const longShort = A.shortAgentLabel({ kind: 'session', session_id: 's-2', title: 'Redefine Gerard role and responsibilities for the next quarter' }, {})
  check('shortAgentLabel cuts a long session title to its first words (≤30 chars)',
    longShort.length <= 30 && longShort.startsWith('Redefine Gerard') && !longShort.includes('quarter'), longShort)
  const goals = [
    "Write a 400-word explanation of why GPU inference servers batch requests and what a 'slot' is. No tools needed; answer directly.",
    'In about 200 words, explain the difference between time-to-first-token and decode throughput for LLM serving.',
    'Read-only research: work out exactly how credentials and model connections must be set up for a second install',
    'Execute /Users/openclaw/.hermes/cache/scratch/flightdeck-briefs/I2-health-backend.md end to end and report back'
  ]
  const goalShorts = goals.map(goal => A.shortAgentLabel({ kind: 'subagent', session_id: 'g', goal, title: `Subagent: ${goal.slice(0, 40)}…` }, {}))
  check('shortAgentLabel gives a subagent its goal clause, ≤30 chars, no lead verb or path',
    goalShorts.every(text => text.length > 0 && text.length <= 30 && !/^(write|in about)\b/i.test(text) && !text.includes('/Users/')),
    goalShorts.join(' | '))
  check('shortAgentLabel stops a subagent goal at its first clause',
    goalShorts[2] === 'Read-only research', goalShorts[2])
  const cronShorts = [
    A.shortAgentLabel({ kind: 'cron', session_id: 'c1', cron_job: 'nightly-digest' }, {}),
    A.shortAgentLabel({ kind: 'cron', session_id: 'c2', title: 'Check automated weekly emails for weekend games' }, {}),
    A.shortAgentLabel({ kind: 'cron', session_id: 'c3' }, {})
  ]
  check('shortAgentLabel names a cron run by its job, then its title, then "cron run"',
    cronShorts[0] === 'nightly-digest' && cronShorts[1].startsWith('Check automated weekly') && cronShorts[1].length <= 30 && cronShorts[2] === 'cron run',
    cronShorts.join(' | '))
  const echoFull = A.fullAgentText({ kind: 'subagent', session_id: 'g', goal: goals[1], title: `Subagent: ${goals[1].slice(0, 40)}…` }, {})
  check('subagent full text prints the goal once (title that echoes it is dropped)',
    echoFull === `subagent · ${goals[1]}`, echoFull.slice(0, 80))

  // A2. Tooltip card facts: in-flight waiting, streamed, not-streamed.
  const lane = { label: 'studio-ds4', kind: 'local' }
  const nowS = Date.now() / 1000
  const snapA = { agents: [] }
  const waiting = A.requestCardFacts({ session_id: 'w', profile: 'default', model: 'ds4', started_at: nowS - 7.2, first_chunk_at: null, ended_at: null, status: 'in-flight' }, {}, snapA, lane)
  check('tooltip card: in-flight request with no first chunk reads waiting so far, generating —',
    waiting.waitedLabel === 'waiting so far' && /^7\.\ds$/.test(waiting.waited) && waiting.generating === '—'
      && waiting.status === 'running' && !JSON.stringify(waiting).includes('not streamed'),
    `${waiting.waited} ${waiting.waitedLabel} / ${waiting.generating} ${waiting.generatingLabel} / ${waiting.status}`)
  const waitingText = A.requestTooltip({ session_id: 'w', profile: 'default', model: 'ds4', started_at: nowS - 7.2, first_chunk_at: null, ended_at: null, status: 'in-flight' }, {}, snapA, lane)
  check('text tooltip: in-flight request with no first chunk says waiting, never not streamed',
    waitingText.includes('waiting for first token') && !waitingText.includes('not streamed'), waitingText.split('\n').slice(-1)[0])
  const streamed = A.requestCardFacts({ session_id: 's', profile: 'default', model: 'ds4', started_at: 100, first_chunk_at: 101.5, ended_at: 105.5, prompt_tokens: 2000, cached_tokens: 1000, completion_tokens: 400, status: 'done' }, {}, snapA, lane)
  check('tooltip card: streamed request shows waited, generating span and tok/s',
    streamed.waitedLabel === 'waited for 1st token' && streamed.waited === '1.5s' && streamed.generating === '4.0s'
      && streamed.generatingLabel === 'generating · 100 tok/s' && streamed.tokensIn === '2k' && streamed.tokensInLabel === 'tokens in · 50% cached'
      && streamed.status === 'finished',
    `${streamed.waited}/${streamed.generating} ${streamed.generatingLabel} ${streamed.tokensIn} ${streamed.tokensInLabel}`)
  const whole = A.requestCardFacts({ session_id: 'n', profile: 'default', model: 'ds4', started_at: 100, first_chunk_at: null, ended_at: 112, prompt_tokens: 100, completion_tokens: 50, status: 'done' }, {}, snapA, lane)
  check('tooltip card: finished request with no first chunk is not streamed (whole response)',
    whole.waitedLabel === 'whole response' && whole.waited === '12.0s' && whole.generating === 'not streamed',
    `${whole.waited} ${whole.waitedLabel} / ${whole.generating}`)
  const generatingNow = A.requestCardFacts({ session_id: 'g', profile: 'default', model: 'ds4', started_at: nowS - 5, first_chunk_at: nowS - 3, ended_at: null, status: 'in-flight' }, {}, snapA, lane)
  check('tooltip card: in-flight streaming request shows waited and generating so far',
    generatingNow.waitedLabel === 'waited for 1st token' && generatingNow.waited === '2.0s' && /^3\.\ds$/.test(generatingNow.generating),
    `${generatingNow.waited} / ${generatingNow.generating}`)
  // The canvas agrees: an in-flight no-first-chunk bar is not a hatched whole bar.
  const waitSnap = JSON.parse(JSON.stringify(fixture))
  const waitServer = waitSnap.servers.find(s => (s.requests || []).some(r => r.ended_at == null && r.first_chunk_at == null))
  const waitLanes = waitServer ? A.swimLanes(waitSnap, 300, NOW_MS).lanes.find(l => l.label === waitServer.name) : null
  const waitBars = waitLanes ? waitLanes.bars.filter(bar => bar.request.ended_at == null && bar.request.first_chunk_at == null) : []
  check('swim lane: an in-flight bar with no first chunk is waiting, not hatched whole',
    waitBars.length > 0 && waitBars.every(bar => !bar.whole), `${waitBars.length} waiting bars, ${waitBars.filter(b => b.whole).length} whole`)

  // A3. By agent rows: no MIX bar, model chips present, kind badges, idle,
  //     fixed-width number columns, subagents capped at 4 + '+N more'.
  const byAgentSnap = JSON.parse(JSON.stringify(fixture))
  const parent = byAgentSnap.agents.find(row => row.kind === 'session')
  parent.title = 'Flightdeck hackathon'
  parent.in_flight = 0
  const childTemplate = (parent.children || [])[0] || { kind: 'subagent', profile: parent.profile, models: parent.models }
  parent.children = goals.concat(['List 30 creative names for a fleet-monitoring tool', 'Write a Python function that packs time intervals'])
    .map((goal, i) => ({
      ...JSON.parse(JSON.stringify(childTemplate)),
      kind: 'subagent', role: 'leaf', goal, title: `Subagent: ${goal.slice(0, 40)}…`,
      session_id: `child-${i}`, parent_session_id: parent.session_id,
      in_flight: i === 5 ? 1 : 0, requests_5m: 10 - i
    }))
  byAgentSnap.agents.push({
    profile: parent.profile, session_id: 'cron-1', kind: 'cron', cron_job: 'nightly-digest', in_flight: 0,
    requests_5m: 2, errors_5m: 0, tokens_in: 1000, tokens_out: 100, cached_tokens: 0,
    latency_ms_p50: null, ttft_ms_p50: null, models: parent.models, children: []
  })
  const byAgent = A.AgentView({ snapshot: byAgentSnap, labels: {}, now: NOW_MS, windowSeconds: 300 })
  const byAgentEls = elements(byAgent)
  const byAgentText = textOf(byAgent)
  check('By agent has no MIX bar or mix column',
    !byAgentEls.some(el => el.props.title && /share of this row/i.test(el.props.title)) && !/\bmix\b/i.test(byAgentText),
    /\bmix\b/i.test(byAgentText) ? 'mix text present' : 'no mix')
  const rowsA = byAgentEls.filter(el => el.props['data-agent-row'] != null)
  const chipLess = rowsA.filter(row => countIn(row, 'data-model-row') === 0)
  check('By agent: every row carries model chips', rowsA.length > 0 && chipLess.length === 0,
    chipLess.map(r => r.props['data-agent-row']).join(', ') || `${rowsA.length} rows`)
  const chipText = textOf(byAgentEls.find(el => el.props['data-model-row'] != null))
  // name and count are sibling spans (CSS gap between them, so no space in text)
  check('By agent: a model chip reads "<model> · <n> req"', /^\S.*· \d+ req/.test(chipText), chipText)
  const badges = new Set(byAgentEls.filter(el => el.props['data-agent-badge'] != null).map(el => el.props['data-agent-badge']))
  check('By agent: kind badges for session, subagent and cron', badges.has('session') && badges.has('subagent') && badges.has('cron'),
    [...badges].join(', '))
  const parentRow = rowsA.find(row => row.props['data-agent-row'] === parent.session_id)
  check('By agent: an idle agent reads "idle" in the in-flight column',
    parentRow && textOf(elements(parentRow).find(el => el.props['data-col'] === 'flight')).startsWith('idle'),
    parentRow ? textOf(elements(parentRow).find(el => el.props['data-col'] === 'flight')) : 'row missing')
  const parentName = parentRow && elements(parentRow).find(el => el.props['data-agent-name'] != null)
  check('By agent: the row name is the short label, one line with ellipsis',
    parentName && textOf(parentName) === 'Flightdeck hackathon' && parentName.props.style.whiteSpace === 'nowrap'
      && parentName.props.style.textOverflow === 'ellipsis' && parentName.props.style.minWidth === 0,
    parentName ? textOf(parentName) : 'name missing')
  const subLabels = rowsA.filter(row => row.props['data-agent-kind'] === 'subagent')
    .map(row => textOf(elements(row).find(el => el.props['data-agent-name'] != null)))
  check('By agent: subagent rows never print the full goal inline',
    subLabels.length > 0 && subLabels.every(text => text.length <= 30 && !text.includes('/Users/')), subLabels.join(' | '))
  const shownChildren = rowsA.filter(row => String(row.props['data-agent-row']).startsWith('child-'))
  const more = byAgentEls.find(el => el.props['data-more-subagents'] != null)
  check('By agent: at most 4 subagents shown, then "+N more"',
    shownChildren.length === A.AGENT_CHILD_LIMIT && more && more.props['data-more-subagents'] === '2' && textOf(more) === '+2 more'
      && typeof more.props.onClick === 'function',
    `${shownChildren.length} shown, ${more ? textOf(more) : 'no expander'}`)
  check('By agent: the busy subagent sorts into the visible four',
    shownChildren.some(row => row.props['data-agent-row'] === 'child-5'), shownChildren.map(r => r.props['data-agent-row']).join(', '))
  // No horizontal overflow by construction: the number block is three fixed
  // widths (≈250 px) that never shrink; the name column is min-width 0 and
  // ellipsises. Every row's block is identical so columns line up.
  const blocks = byAgentEls.filter(el => el.props['data-agent-numbers'] != null)
  const blockWidths = blocks.map(block => elements(block).filter(el => el.props['data-col'] != null)
    .map(el => parseInt(el.props.style.width, 10)))
  const W = A.AGENT_STAT_W
  check('By agent: every number block is the same three fixed widths, ≤260 px in total',
    blocks.length === rowsA.length && blockWidths.every(ws => ws.length === 3 && ws[0] === W.flight && ws[1] === W.req && ws[2] === W.tokens)
      && W.flight + W.req + W.tokens + 24 <= 260 && blocks.every(block => block.props.style.flex === '0 0 auto'),
    `${blocks.length} blocks for ${rowsA.length} rows · ${W.flight}+${W.req}+${W.tokens}`)
  const card = A.agentCardFacts(parent.children[3], {}, NOW_MS)
  check('By agent card carries the full goal, kind and per-model lines',
    card.full && card.full.includes('I2-health-backend.md') && card.meta.startsWith('subagent') && card.models.length > 0,
    `${card.name} · ${card.meta} · ${card.models.length} models`)
}

// --- UI v2 part B ---------------------------------------------------------------
// Local server cards (header, ring gauges, compact idle variant, dropped count
// in the tooltip, HELD BY short labels) and cloud cards (provider label,
// BigStats, plan bars with reset text, the auto-fill grid). Its own factory, so
// the shared return list above stays untouched.
{
  const factoryB = new Function(
    'atom', 'Badge', 'Button', 'Codicon', 'EmptyState', 'ErrorState', 'ScrollArea', 'SegmentedControl',
    'Skeleton', 'StatusDot', 'cn', 'host', 'profileColor', 'useQuery', 'useValue',
    'PALETTE_AREA', 'ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'STATUSBAR_AREAS',
    'useEffect', 'useMemo', 'useRef', 'useState', 'jsx', 'jsxs',
    `${body}\nreturn { serverModelShort, cloudProviderLabel, providerPlanLabel, isQuietServer, fmtResetTime, shortAgentLabel, ServerCard, CloudCard, PlanUsage, ModelView }`
  )
  const B = factoryB(
    atom, Badge, Button, Component, EmptyState, Component, Component, Component,
    Component, Component, cn, host, profileColor, useQuery, useValue,
    'palette', 'routes', 'sidebar', 'statusbar',
    useEffect, useMemo, useRef, useState, jsx, jsxs, globalThis
  )
  const NOW_MS = fixture.generated_at * 1000
  const serverByName = name => JSON.parse(JSON.stringify(fixture.servers.find(s => s.name === name)))
  const cardOf = (server, extra) => B.ServerCard({ server, models: fixture.models, labels, now: NOW_MS, ...(extra || {}) })
  const headerOf = card => elements(card).find(el => el.props['data-server-title'] != null)
  const occurrences = (text, word) => text.split(word).length - 1

  // Header: 'name · model short name', the name exactly once, URL only in the tooltip.
  const gbCard = cardOf({ ...serverByName('gb10-qwen'), running: 1, in_flight: 1 })
  const gbHeader = headerOf(gbCard)
  const gbRow = elements(gbCard).find(el => typeof el.props.title === 'string' && el.props.title.includes('http://127.0.0.1:18009'))
  check('server header is "name · model" and never repeats the name',
    gbHeader && textOf(gbHeader) === 'gb10-qwen · GN100 Qwen3.8-Flash-Next FP4'
      && occurrences(textOf(gbCard), 'gb10-qwen') === 1,
    gbHeader ? textOf(gbHeader) : 'header missing')
  check('server URL rides in the header tooltip, not the card text',
    gbRow && !textOf(gbCard).includes('127.0.0.1'), gbRow ? 'tooltip ok' : textOf(gbCard).slice(0, 120))
  const echoServer = { ...serverByName('qwen3.5-9b'), running: 1, in_flight: 1 }
  const echoHeader = headerOf(cardOf(echoServer))
  check('server header drops a model id that only restates the name (and a helper-model title)',
    echoHeader && textOf(echoHeader) === 'qwen3.5-9b' && B.serverModelShort(echoServer) === '',
    echoHeader ? textOf(echoHeader) : 'header missing')
  check('server model short name drops a kind word and stays short',
    B.serverModelShort({ name: 'box', kind: 'vllm', title: 'Llama 4 Scout vLLM (8xH100, fp8)' }) === 'Llama 4 Scout'
      && B.serverModelShort({ name: 'ds4', models: ['ds4'] }) === ''
      && B.serverModelShort({ name: 'lab', models: ['org/Some-Model-7B-Instruct'] }).length <= 36,
    `${B.serverModelShort({ name: 'box', kind: 'vllm', title: 'Llama 4 Scout vLLM (8xH100, fp8)' })} | ${B.serverModelShort({ name: 'ds4', models: ['ds4'] })}`)

  // Ring gauges: one per reported health ratio, none without a health block.
  const ringServer = { ...serverByName('gb10-qwen'), running: 1, in_flight: 1,
    health: { kv_cache_usage: 0.17, prefix_cache_hit_rate: 0.93, spec_accept_rate: 0.66,
      disconnects_total: 22, disconnects_delta: 0, preemptions_total: 0, preemptions_delta: 0 } }
  const ringCard = cardOf(ringServer)
  const rings = elements(ringCard).filter(el => el.props['data-ring'] != null)
  const hero = elements(ringCard).find(el => el.props['data-hero'] != null)
  check('ring gauges render for KV cache, prefix hit and MTP accept inside the hero row',
    rings.map(el => el.props['data-ring']).join(',') === 'kv,prefix,mtp'
      && hero && elements(hero).filter(el => el.props['data-ring'] != null).length === 3
      && elements(hero).some(el => el.props['data-slots-meter'] != null)
      && ['17%', '93%', '66%'].every(pct => textOf(hero).includes(pct)),
    hero ? textOf(hero) : 'hero missing')
  const kvOnlyRings = elements(cardOf({ ...ringServer, health: { kv_cache_usage: 0.4 } })).filter(el => el.props['data-ring'] != null)
  const noHealthRings = elements(cardOf({ ...ringServer, health: null })).filter(el => el.props['data-ring'] != null)
  check('ring gauges appear only for reported fields', kvOnlyRings.length === 1 && noHealthRings.length === 0,
    `${kvOnlyRings.length} with kv only, ${noHealthRings.length} with no health`)
  const serverKicker = elements(ringCard).find(el => textOf(el) === 'server' && typeof el.props.title === 'string')
  check('dropped connections leave the card for the tooltip',
    !textOf(ringCard).includes('dropped') && !textOf(ringCard).includes('(of ')
      && serverKicker && serverKicker.props.title.includes('Client connections dropped'),
    serverKicker ? serverKicker.props.title.slice(-90) : 'server kicker missing')
  const hermesLine = elements(ringCard).find(el => el.props['data-stat-line'] === 'Hermes')
  check('Hermes-observed numbers sit on their own muted "Hermes" line',
    hermesLine && textOf(hermesLine).startsWith('Hermes') && textOf(hermesLine).includes('in flight'),
    hermesLine ? textOf(hermesLine) : 'Hermes line missing')
  const sparkWrap = elements(ringCard).find(el => el.props['data-card-chart'] === 'server')
  check('server sparkline is the full-width card footer',
    sparkWrap && !sparkWrap.props.className && sparkWrap.props.style.marginTop === 'auto',
    sparkWrap ? JSON.stringify(sparkWrap.props.style) : 'chart wrapper missing')

  // Compact variant: a server with nothing from Hermes in the window folds to
  // one clickable line; a busy one never does.
  const idleServer = serverByName('qwen3.5-9b')
  const idleCard = cardOf(idleServer)
  const idleArticle = elements(idleCard).find(el => el.type === 'article')
  const expander = elements(idleCard).find(el => el.props['data-expand-server'] === 'qwen3.5-9b')
  check('idle server renders the compact one-line variant, expandable on click',
    B.isQuietServer(idleServer) && idleArticle && idleArticle.props['data-compact'] === 'true'
      && expander && typeof expander.props.onClick === 'function' && expander.props['aria-expanded'] === 'false'
      && textOf(idleCard).includes('idle') && !elements(idleCard).some(el => el.props['data-ring'] != null || el.props['data-held-by'] != null),
    textOf(idleCard).slice(0, 120))
  const busyServer = serverByName('studio-ds4')
  check('a server with Hermes traffic in the window keeps the full card',
    !B.isQuietServer(busyServer) && elements(cardOf(busyServer)).find(el => el.type === 'article').props['data-compact'] === 'false'
      && !B.isQuietServer({ ...idleServer, error: 'boom' }),
    'studio-ds4 has a running slot')
  const layoutView = B.ModelView({ snapshot: fixture, labels, now: NOW_MS, windowSeconds: 60, onHide: null })
  const quietGroup = elements(layoutView).find(el => el.props['data-quiet-servers'] != null)
  const activeGrid = elements(layoutView).find(el => el.props['data-server-grid'] != null)
  // Fixture: gb10-qwen and studio-ds4 carry rows in the window; qwen3.5-9b none.
  check('quiet servers stack under the full cards',
    quietGroup && quietGroup.props['data-quiet-servers'] === 1 && activeGrid && activeGrid.props['data-server-grid'] === 2
      && elements(quietGroup).some(el => el.props['data-server-card'] === 'qwen3.5-9b'),
    `${quietGroup ? quietGroup.props['data-quiet-servers'] : 'no'} quiet, ${activeGrid ? activeGrid.props['data-server-grid'] : 'no'} full`)

  // HELD BY rows use the short agent label; the full text is the row tooltip.
  const heldSession = 'held-short-1'
  const heldTitle = 'Investigate the warehouse SFTP outage and write up the timeline for ops'
  const heldSnapB = JSON.parse(JSON.stringify(fixture))
  heldSnapB.agents = [{ profile: 'default', session_id: heldSession, kind: 'session', title: heldTitle }]
  const heldServer = { ...serverByName('studio-ds4'),
    agents: [{ profile: 'default', session_id: heldSession, requests: 1, oldest_started_at: fixture.generated_at - 30 }] }
  const heldRowB = elements(cardOf(heldServer, { snapshot: heldSnapB }))
    .find(el => el.props['data-held-row'] === heldSession)
  const wantShort = B.shortAgentLabel(heldSnapB.agents[0], labels)
  check('server HELD BY rows show shortAgentLabel with the full title in the tooltip',
    heldRowB && textOf(heldRowB).startsWith(wantShort) && wantShort.length < heldTitle.length
      && String(heldRowB.props.title).includes(heldTitle),
    heldRowB ? `${textOf(heldRowB)} | ${wantShort}` : 'held row missing')

  // Cloud cards: provider label mapping, BigStats, tooltip-only notes.
  check('provider label maps DirectSDK / API / Codex and keeps other slugs',
    B.cloudProviderLabel('claude-subscription-directsdk-experimental') === 'DirectSDK'
      && B.cloudProviderLabel('anthropic') === 'API' && B.cloudProviderLabel('openai') === 'API'
      && B.cloudProviderLabel('openai-codex') === 'Codex' && B.cloudProviderLabel('openrouter') === 'openrouter'
      && B.providerPlanLabel('anthropic') === 'API',
    ['claude-subscription-directsdk-experimental', 'anthropic', 'openai-codex', 'openrouter'].map(B.cloudProviderLabel).join(', '))
  const cloudBase = JSON.parse(JSON.stringify(fixture.models.find(model => model.lane === 'cloud')))
  const streamedCloud = { ...cloudBase, quota: null, in_flight: 2, requests_5m: 17, requests_1m: 4,
    streamed: 5, non_streamed: 0, ttft_ms_p50: 929 }
  const cloudCardB = B.CloudCard({ model: streamedCloud, labels, now: NOW_MS, windowSeconds: 300, snapshot: fixture })
  const statsB = Object.fromEntries(elements(cloudCardB).filter(el => el.props['data-col'] != null)
    .map(el => [el.props['data-col'], textOf(el)]))
  check('cloud card BigStats: in flight, req / 5 min, TTFT p50',
    statsB['in-flight'] === '2in flight' && statsB.requests === '17req / 5 min' && statsB.ttft === '929msTTFT p50',
    JSON.stringify(statsB))
  const oneMinStats = Object.fromEntries(elements(B.CloudCard({ model: streamedCloud, labels, now: NOW_MS, windowSeconds: 60, snapshot: fixture }))
    .filter(el => el.props['data-col'] != null).map(el => [el.props['data-col'], textOf(el)]))
  check('cloud card request BigStat follows the 1m window', oneMinStats.requests === '4req / 1 min', JSON.stringify(oneMinStats))
  const pill = elements(cloudCardB).find(el => el.props['data-provider-label'] != null)
  check('cloud header shows the provider label; "Hermes traffic only" moves to the tooltip',
    pill && textOf(pill) === 'DirectSDK' && !textOf(cloudCardB).includes('Hermes traffic only')
      && String(pill.props.title).includes('Hermes traffic only') && !textOf(cloudCardB).includes('process://'),
    pill ? textOf(pill) : 'provider pill missing')

  // Plan bars: label, bar, '26% used · resets <day time>'.
  const resetAt = 1794394800
  const planB = B.PlanUsage({ quota: { windows: [
    { label: 'Current week', used_percent: 26, reset_at: resetAt },
    { label: 'Weekly', used_percent: null, reset_at: resetAt }
  ] } })
  const planTexts = elements(planB).filter(el => el.props['data-plan-text'] != null).map(textOf)
  const planBars = elements(planB).filter(el => el.props['data-plan-bar'] != null)
  check('plan bar row reads "26% used · resets <time>" over a 26% bar',
    planTexts[0] === `26% used · resets ${B.fmtResetTime(resetAt)}` && B.fmtResetTime(resetAt)
      && planBars.length === 1 && planBars[0].props['data-plan-bar'] === 26,
    `${planTexts.join(' | ')} · ${planBars.length} bars`)
  check('plan window with no reading keeps its reset text and draws no bar',
    planTexts[1] === `no usage reported · resets ${B.fmtResetTime(resetAt)}`, planTexts[1] || 'missing')

  // Cloud grid: auto-fill minmax(360px, 1fr) so cards sit 2-3 per row when wide.
  const cloudGrid = elements(B.ModelView({ snapshot: fixture, labels, now: NOW_MS, windowSeconds: 300, onHide: null }))
    .find(el => el.props['data-cloud-grid'] != null)
  check('cloud cards sit in an auto-fill minmax(360px, 1fr) grid',
    cloudGrid && cloudGrid.props.style.display === 'grid'
      && cloudGrid.props.style.gridTemplateColumns === 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))',
    cloudGrid ? cloudGrid.props.style.gridTemplateColumns : 'grid missing')
}

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('FAILED:', failed.map(item => item.name).join(' | '))
  process.exit(1)
}
