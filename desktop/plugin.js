// Flightdeck — Desktop half.
// Live air-traffic control for Hermes agents and model servers: local server
// capacity first (slots, queue, decode/prefill, held-by), cloud lanes labelled
// "Hermes traffic only", and the agent tree. Disk-loaded uncompiled: jsx()/jsxs()
// only, imports from @hermes/plugin-sdk and react/jsx-runtime, theme vars only.

import {
  atom,
  Badge,
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  ScrollArea,
  SegmentedControl,
  Skeleton,
  StatusDot,
  cn,
  host,
  profileColor,
  useQuery,
  useValue,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'flightdeck'
const ROUTE = '/flightdeck'
const POLL_MS = 5000
const SWIM_BUCKET_SECONDS = 15
const CHIP_POLL_MS = 10000
const QUOTA_POLL_MS = 15000

const $view = atom('model')
const $window = atom('300')

let restRef = null

// ---------------------------------------------------------------------------
// Numbers. null is "unknown" and renders as an em dash, never as zero.

function fmtInt(value) {
  if (value == null) return '—'
  const n = Math.round(value)
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtRate(value) {
  if (value == null) return '—'
  if (Math.abs(value) >= 100) return fmtInt(value)
  return value.toFixed(1)
}

// ---------------------------------------------------------------------------
// Provider/model labels — the ONE place a model string becomes display text.
// A provider/model such as 'claude-subscription-directsdk-experimental/claude-
// opus-5-5' renders as just the model half; the full string always rides in the
// title tooltip.  Every card, sub-row and swim-lane label routes through here.
const MODEL_SHORT_MAX = 48

// 'provider/model' (or a bare model) → short display text.  A model name can
// itself carry slashes (org/collection names), so prefer the split on the LAST
// '/' of 'provider/model'; if what follows is still unreasonably long, take the
// last segment.
function modelDisplayName(value) {
  const text = String(value == null ? '' : value)
  if (!text) return 'model'
  const index = text.lastIndexOf('/')
  const tail = index >= 0 ? text.slice(index + 1) : text
  if (!tail) return text.replace(/\//g, ' · ')
  return tail.length > MODEL_SHORT_MAX ? tail.split('/').pop() : tail
}

// The display half of a lane/model label's `model` field, which may already be
// 'provider/model'.
function laneModelShort(value) {
  const text = String(value == null ? '' : value)
  return text ? modelDisplayName(text) : 'model'
}

// Tooltip form: the full 'provider/model', one slash, no spaces.
function fullModelLabel(provider, model) {
  const prov = String(provider || '').trim()
  const mod = String(model || '').trim()
  if (prov && mod) return `${prov}/${mod}`
  return mod || prov || 'model'
}

function fmtMs(value) {
  if (value == null) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

function fmtTokens(value) {
  if (value == null) return '—'
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return fmtInt(value)
}

// Token counts carry their unit; M/k keep their case so M never reads as minutes.
function tokenText(value) {
  if (value == null) return '—'
  return `${fmtTokens(value)} tok`
}

function fmtElapsed(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const minutes = Math.floor(s / 60)
    const rest = s % 60
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// A start time in the future is not "0s elapsed": it is a clock skew or a
// fixture, and renders as unknown rather than a fake live number.
function elapsedOf(ts, now) {
  if (ts == null) return null
  const seconds = now / 1000 - ts
  if (seconds < -2) return null
  return fmtElapsed(seconds)
}

function fmtDuration(seconds) {
  if (seconds == null) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

function fmtAgo(tsSeconds, now) {
  if (tsSeconds == null || !Number.isFinite(tsSeconds)) return '—'
  const s = Math.max(0, Math.round(now / 1000 - tsSeconds))
  if (s < 2) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${(s / 3600).toFixed(1)}h ago`
}

// Collapse the per-endpoint probe error ("; "-joined "path: Err: msg" parts,
// servers.py probe) into one short phrase for a single-line row. Same class on
// every endpoint → that class's plain-words label; mixed → first label plus
// the number of other classes; nothing recognizable → the first message.
const UNREACHABLE_CLASS_PATTERNS = [
  [/connection reset|errno 54|reset by peer/i, () => 'connection reset'],
  [/timeouterror|timed out|timeout/i, () => 'timed out'],
  [/connectionrefusederror|errno 61|refused/i, () => 'connection refused'],
  [/gaiconnecterror|name or service not known|nodename nor servname|getaddrinfo|unreachable host|host not found/i, () => 'host not found'],
  [/http\s*(?:error\s*)?(?:status\s*)?(\d{3})|returned\s+http\s*(\d{3})|(?:^|\D)4\d{2}(?:\D|$)|(?:^|\D)5\d{2}(?:\D|$)|http\s*>=?\s*400|returned\s+http/i, m => {
    const code = m[1] || m[2] || (m[0].match(/[45]\d{2}/) || [])[0]
    return code ? `HTTP ${code}` : 'HTTP error'
  }]
]

function unreachableClass(message) {
  for (const [pattern, label] of UNREACHABLE_CLASS_PATTERNS) {
    const match = message.match(pattern)
    if (match) return label(match)
  }
  return null
}

// Unrecognized message: keep the leading "VendorError:" name and the first 60
// code points of the whole message, with the ellipsis taking the last slot.
function trimUnknownClass(message) {
  if (message.length <= 60) return message
  return `${message.slice(0, 58)}…`
}

function unreachableReason(error) {
  const parts = String(error || '').split(';').map(part => part.trim()).filter(Boolean)
  if (!parts.length) return 'unreachable'
  const labels = []
  for (const part of parts) {
    let message = part.trim()
    // Split on the FIRST ':' only when the head looks like a probe path
    // ("/health", "/metrics"): "ConnectionResetError: [Errno 54] ..." keeps
    // its own message, the class regexes match the whole thing either way.
    const idx = message.indexOf(':')
    if (idx > 0 && message.startsWith('/')) message = message.slice(idx + 1).trim()
    const label = unreachableClass(message)
      // Long unknown-class messages are trimmed to 60 visible characters
      // (excluding the space separators) before the ellipsis.
      || trimUnknownClass(message)
    if (!labels.includes(label)) labels.push(label)
  }
  // An HTTP status from ANY endpoint means the server process answered: that
  // HTTP label leads, in endpoint order; the rest counts as (+n more).
  const httpIdx = labels.findIndex(label => /^HTTP /i.test(label))
  const all = httpIdx > 0 ? [labels[httpIdx], ...labels.slice(0, httpIdx), ...labels.slice(httpIdx + 1)] : labels
  return all.length === 1 ? all[0] : `${all[0]} (+${all.length - 1} more)`
}

function unreachableTooltip(error) {
  return String(error || 'unreachable').replace(/;\s*\/(?=\S)/g, '\n/')
}

// Real plurals: "1 server", "2 servers" — never "2 server(s)".
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function profileTone(name) {
  return profileColor(name) || 'var(--ui-accent)'
}

// Canvas fills need concrete colors: a CSS var() is not a valid fillStyle, so
// profileTone() draws transparent bars. Agents get a fixed HSL palette, assigned
// per draw in order of appearance so the legend and the bars always agree.
const AGENT_PALETTE = [
  'hsl(210 90% 62%)', 'hsl(285 80% 68%)', 'hsl(160 70% 48%)', 'hsl(38 95% 58%)',
  'hsl(0 80% 62%)', 'hsl(188 85% 55%)', 'hsl(255 85% 70%)', 'hsl(24 90% 60%)'
]

function agentKey(row) {
  return `${(row && row.profile) || ''}|${(row && row.session_id) || ''}`
}

// snapshot.agents indexed by session id, walking the WHOLE tree: subagent rows
// are nested under their parent as `children` (and deeper), so a map of the
// roots alone leaves nested sessions unresolvable. Shared by the swim-lane
// legend and the cloud card's holder line — both label a session id that only
// appears in an agent row, and both must resolve to the same row.
function agentRowBySession(snapshot) {
  const rowBySession = new Map()
  const visitAgentRow = row => {
    if (!row || typeof row !== 'object') return
    if (row.session_id && !rowBySession.has(row.session_id)) {
      rowBySession.set(row.session_id, row)
    }
    if (Array.isArray(row.children)) row.children.forEach(visitAgentRow)
  }
  ;(Array.isArray(snapshot && snapshot.agents) ? snapshot.agents : []).forEach(visitAgentRow)
  return rowBySession
}

function agentColorMap(rows) {
  const colors = new Map()
  let next = 0
  for (const server of rows || []) {
    for (const request of server.requests || []) {
      const key = agentKey(request)
      if (!colors.has(key)) {
        colors.set(key, AGENT_PALETTE[next % AGENT_PALETTE.length])
        next += 1
      }
    }
  }
  return colors
}

// A request's generation span [first chunk, end]; null when the row never
// streamed (no first chunk, or a first chunk at/after the end — the same
// predicate the swim lane hatches with). Reused by the in-flight row's
// generating-bar start and by the cloud card's tok/s bins.
function requestGenStart(row) {
  if (!row || row.first_chunk_at == null) return null
  if (isWholeResponse(row)) return null
  return row.first_chunk_at
}

// A session's resolved metadata from session.list: title, preview, source,
// started_at. Older builds stored a bare title string, so both shapes read.
function sessionMeta(labels, sessionId) {
  const entry = labels && labels[sessionId]
  if (!entry) return null
  return typeof entry === 'string' ? { title: entry } : entry
}

// Title first, then the preview's first line, then nothing — the caller falls
// back to the short id. A date-prefixed id is never a label.
function sessionTitle(labels, sessionId) {
  const meta = sessionMeta(labels, sessionId)
  const title = meta && meta.title
  if (title) return title
  const preview = meta && meta.preview
  if (preview) {
    const line = String(preview).split('\n')[0].trim()
    if (line) return line
  }
  return ''
}

// Row-first label resolution. The snapshot now carries the row's own title /
// label / source / started_at read from that profile's state.db, so those win;
// session.list labels are the fallback, then the caller's date-id fallback.
function rowTitle(row) {
  const own = row && (row.title || (row.label && String(row.label).trim()))
  if (own) return String(own)
  return sessionTitle(null, row && row.session_id)
}

function rowSource(row) {
  const own = row && row.source
  if (own) return String(own)
  const meta = sessionMeta(null, row && row.session_id)
  return (meta && meta.source) || ''
}

function rowStartedAt(row) {
  const own = row && row.started_at
  if (own != null) return own
  const meta = sessionMeta(null, row && row.session_id)
  return (meta && meta.started_at) || null
}

// A row's display label. Snapshot labels are always ""; sessions resolve from
// session.list, subagents from role + goal, cron runs from the job name.
function agentLabel(row, labels) {
  if (!row) return 'unknown'
  // The row's own title/label from state.db wins; session.list is the fallback.
  const title = rowTitle(row) || sessionTitle(labels, row.session_id)
  if (row.kind === 'cron') {
    const base = row.cron_job ? `cron: ${row.cron_job}` : 'cron run'
    return title ? `${base} · ${title}` : base
  }
  if (row.kind === 'subagent') {
    // The raw internal role 'leaf' is jargon; readers care that it is a
    // subagent. 'orchestrator' (and any future named role) stays as-is.
    const role = !row.role || row.role === 'leaf' ? 'subagent' : row.role
    const base = row.goal ? `${role} · ${row.goal}` : role
    return title ? `${base} · ${title}` : base
  }
  if (title) return title
  const id = String(row.session_id || '')
  return id ? `session ${id.slice(0, 8)}` : 'session'
}

// "started Nov 4 · active 2m ago" — real timestamps only; a missing piece is
// omitted rather than rendered as an em dash.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtDay(tsSeconds) {
  if (tsSeconds == null || !Number.isFinite(tsSeconds)) return null
  const date = new Date(tsSeconds * 1000)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

function sessionActivity(row, labels, now) {
  const meta = sessionMeta(labels, row.session_id) || {}
  const parts = []
  const started = fmtDay(rowStartedAt(row) ?? meta.started_at)
  if (started) parts.push(`started ${started}`)
  const last = row.last_active_at != null ? row.last_active_at : meta.last_active_at
  const active = fmtAgo(last, now)
  if (active !== '—') parts.push(`active ${active}`)
  return parts.join(' · ')
}

function serverVerdict(server) {
  if (!server) return { label: 'unknown', variant: 'outline', tone: 'muted' }
  if (server.error || server.healthy === false) return { label: 'unreachable', variant: 'destructive', tone: 'bad' }
  if (server.slots == null) return { label: 'no slot gauge', variant: 'outline', tone: 'muted' }
  const used = server.running != null ? server.running : 0
  if (server.waiting > 0) return { label: 'queueing', variant: 'warn', tone: 'warn' }
  if (used >= server.slots) return { label: 'saturated', variant: 'warn', tone: 'warn' }
  if (server.slots > 0 && used / server.slots >= 0.5) return { label: 'busy', variant: 'default', tone: 'good' }
  // 'spare' on a server with 1/5 slots busy said nothing; the free count is the
  // number a reader wants. saturated/queueing/busy keep their own wording.
  const free = Math.max(0, (server.slots != null ? server.slots : 0) - used)
  return { label: `${free} free`, variant: 'success', tone: 'good' }
}

// ---------------------------------------------------------------------------
// Data. One snapshot call per window per view; the chip polls /servers; labels
// resolve per profile; quota comes from session.stats for the focused session.

function useNow(ms) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

function useSnapshot(windowSeconds) {
  return useQuery({
    queryKey: [ID, 'snapshot', windowSeconds],
    queryFn: () => restRef(`/snapshot?window=${windowSeconds}`),
    refetchInterval: POLL_MS,
    staleTime: 4000,
    retry: 1
  })
}

function useServers() {
  return useQuery({
    queryKey: [ID, 'servers'],
    queryFn: () => restRef('/servers'),
    refetchInterval: CHIP_POLL_MS,
    staleTime: 8000,
    retry: 1
  })
}

// session.list reaches older and hidden rows with a large limit; the newest-200
// default window can push a long-lived session out. A row resolves by id,
// resolved_id (compression tip) or lineage root, so a snapshot id that differs
// from the stored row still finds its title.
const LABEL_LIST_PARAMS = { limit: 2000, include_hidden: true }

function routeRank(route, profile) {
  if (!route) return -1
  return (route.profile === profile ? 4 : 0) + (route.targetProfile === profile ? 4 : 0)
    + (route.mode === 'local' ? 2 : 0) + (route.primary ? 1 : 0)
}

function useSessionLabels(profiles) {
  const key = profiles.join('|')
  return useQuery({
    queryKey: [ID, 'labels', key],
    enabled: profiles.length > 0,
    staleTime: 30000,
    retry: 1,
    queryFn: async () => {
      let routes = []
      try {
        // profileRoutes is async; an un-awaited Promise has no .find and threw
        // into the catch below, which left every label empty.
        routes = await host.profileRoutes()
      } catch {
        routes = []
      }
      routes = Array.isArray(routes) ? routes : []
      const out = {}
      for (const profile of profiles) {
        const candidates = routes
          .filter(r => r && (r.profile === profile || r.targetProfile === profile || r.name === profile))
          .sort((a, b) => routeRank(b, profile) - routeRank(a, profile))
        const route = candidates[0]
        try {
          const res = route
            ? await host.requestProfile(route, 'session.list', LABEL_LIST_PARAMS)
            : await host.requestProfile(profile, 'session.list', LABEL_LIST_PARAMS)
          const rows = res && Array.isArray(res.sessions) ? res.sessions : []
          for (const session of rows) {
            if (!session || !session.id) continue
            const meta = {
              title: session.title || '',
              preview: session.preview || '',
              source: session.source || '',
              started_at: session.started_at || 0
            }
            out[session.id] = meta
            if (session.resolved_id && !out[session.resolved_id]) out[session.resolved_id] = meta
            if (session._lineage_root_id && !out[session._lineage_root_id]) out[session._lineage_root_id] = meta
          }
        } catch {
          // Labels are a nicety; ids stay readable without them.
        }
      }
      return out
    }
  })
}

function useQuota(provider) {
  const sessionId = useValue(host.state.focusedSessionId)
  return useQuery({
    queryKey: [ID, 'quota', provider, sessionId],
    enabled: !!provider && !!sessionId,
    refetchInterval: QUOTA_POLL_MS,
    staleTime: 12000,
    retry: 1,
    queryFn: () => host.request('session.stats', { session_id: sessionId })
  })
}

function quotaLine(stats, provider) {
  const limit = stats && stats.rate_limit
  if (!limit || limit.provider !== provider) return null
  const minute = limit.requests_min
  if (!minute || minute.limit == null) return null
  const remaining = minute.remaining != null ? minute.remaining : minute.limit - (minute.used || 0)
  return `quota: ${fmtInt(remaining)}/${fmtInt(minute.limit)} req/min, resets in ${fmtDuration(minute.reset_seconds)} (live session)`
}

function planLine(stats) {
  const gauge = stats && stats.plan_gauge
  if (!gauge || gauge.used_bp == null) return null
  const pct = (gauge.used_bp / 100).toFixed(1)
  const resets = gauge.resets_at_ms ? fmtDuration(gauge.resets_at_ms / 1000 - Date.now() / 1000) : null
  return `plan: ${pct}% used${resets ? `, resets ${resets}` : ''}`
}

// ---------------------------------------------------------------------------
// Small shared pieces.

function Section({ label, meta, children }) {
  return jsxs('section', {
    className: 'flex flex-col gap-2',
    children: [
      jsxs('div', {
        className: 'flex items-baseline gap-2 px-0.5',
        children: [
          jsx('h2', {
            className: 'text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-tertiary)',
            children: label
          }),
          meta
            ? jsx('span', { className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: meta })
            : null
        ]
      }),
      children
    ]
  })
}

function Stat({ label, value, tone }) {
  return jsxs('span', {
    className: 'inline-flex items-baseline gap-1.5',
    children: [
      tone ? jsx('span', { className: cn('size-1.5 self-center rounded-full', tone) }) : null,
      jsx('span', { className: 'tabular-nums font-semibold text-(--ui-text-primary)', children: value }),
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label })
    ]
  })
}

function Metric({ label, value, accent, title }) {
  return jsxs('span', {
    className: 'inline-flex items-baseline gap-1',
    title: title || undefined,
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
      jsx('span', {
        className: cn('tabular-nums font-medium', accent ? 'text-(--ui-accent)' : 'text-(--ui-text-primary)'),
        children: value
      })
    ]
  })
}

// Engine health line. Server-side numbers cover all traffic, not just Hermes;
// every tooltip says so in plain words. Missing fields are omitted, never zero.
function fmtHealthSeconds(value) {
  if (value == null) return null
  return `${Number(value.toFixed(2))}s`
}

function fmtHealthPct(value) {
  if (value == null) return null
  return `${Math.round(value * 100)}%`
}

function fmtHealthMem(bytes) {
  if (bytes == null) return null
  return `${(bytes / 1e9).toFixed(1)} GB`
}

function HealthBar({ pct }) {
  return jsx('span', {
    style: {
      display: 'inline-block',
      width: '30px',
      height: '4px',
      borderRadius: '2px',
      overflow: 'hidden',
      background: 'var(--ui-bg-tertiary)',
      verticalAlign: 'middle'
    },
    children: jsx('span', {
      style: {
        display: 'block',
        width: `${Math.max(0, Math.min(100, pct))}%`,
        height: '100%',
        background: 'var(--ui-accent)'
      }
    })
  })
}

function ServerHealth({ health }) {
  if (!health) return null
  const items = []
  const kv = fmtHealthPct(health.kv_cache_usage)
  if (kv != null) {
    items.push(jsxs('span', {
      title: 'KV cache fill on this server — how full its cache is right now; server-side, all traffic',
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      children: [
        jsx('span', { children: 'KV' }),
        jsx(HealthBar, { pct: Math.round(health.kv_cache_usage * 100) }),
        jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: kv })
      ]
    }))
  }
  const prefix = fmtHealthPct(health.prefix_cache_hit_rate)
  if (prefix != null) {
    items.push(jsx('span', {
      title: 'prefix cache hit rate — share of prefix lookups that found a match; server-side, all traffic',
      children: `prefix hit ${prefix}`
    }))
  }
  const accept = fmtHealthPct(health.spec_accept_rate)
  if (accept != null) {
    items.push(jsxs('span', {
      title: 'MTP acceptance rate — share of drafted tokens the model accepted; server-side, all traffic',
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      children: [
        jsx('span', { children: 'MTP accept' }),
        jsx(HealthBar, { pct: Math.round(health.spec_accept_rate * 100) }),
        jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: accept })
      ]
    }))
  }
  const ttftP50 = fmtHealthSeconds(health.server_ttft_p50)
  const ttftP95 = fmtHealthSeconds(health.server_ttft_p95)
  if (ttftP50 != null || ttftP95 != null) {
    const parts = []
    if (ttftP50 != null) parts.push(`p50 ${ttftP50}`)
    if (ttftP95 != null) parts.push(`p95 ${ttftP95}`)
    items.push(jsx('span', {
      title: "time to first token from the server's own /metrics histogram — p50 median and p95. Server-side numbers cover ALL traffic hitting the server, not just requests from this machine's Hermes",
      children: `server TTFT ${parts.join(' / ')}`
    }))
  }
  const tpot = health.server_tpot_p50 != null ? `${Math.round(health.server_tpot_p50 * 1000)} ms` : null
  if (tpot != null) {
    items.push(jsx('span', {
      title: 'time per output token from the server\'s own histogram — median; server-side numbers cover ALL traffic, not just Hermes',
      children: `TPOT ${tpot}`
    }))
  }
  const mem = fmtHealthMem(health.memory_bytes)
  if (mem != null) {
    items.push(jsx('span', {
      title: 'device memory the engine holds; server-side, all traffic',
      children: `mem ${mem}`
    }))
  }
  // Preemptions/disconnects were rendered nowhere, so the check below could
  // never see them; a server that preempted a request should say so.
  const preempt = health.preemptions_delta != null
    ? `${health.preemptions_delta} preempted${health.preemptions_total != null ? ` (of ${health.preemptions_total})` : ''}`
    : health.preemptions_total
      ? `${health.preemptions_total} preempted`
      : null
  if (preempt) {
    items.push(jsx('span', {
      title: 'requests the engine preempted (evicted to free KV) in the last sample interval, and its lifetime total; server-side, all traffic',
      children: preempt
    }))
  }
  const drops = health.disconnects_delta != null
    ? `${health.disconnects_delta} dropped${health.disconnects_total != null ? ` (of ${health.disconnects_total})` : ''}`
    : health.disconnects_total
      ? `${health.disconnects_total} dropped`
      : null
  if (drops) {
    items.push(jsx('span', {
      title: 'client connections dropped in the last sample interval, and the lifetime total; server-side, all traffic',
      children: drops
    }))
  }
  if (!items.length) return null
  const children = []
  items.forEach((item, i) => {
    if (i > 0) children.push(jsx('span', { style: { color: 'var(--ui-stroke-tertiary)' }, children: '·' }, `sep-${i}`))
    children.push(item)
  })
  return jsx('div', {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: '8px',
      rowGap: '2px',
      fontSize: '0.6rem',
      color: 'var(--ui-text-quaternary)'
    },
    children
  })
}

// Same cells as the local card's slot gauge, filled by percentage: a plan
// window is the same kind of "N of a fixed allowance consumed" reading, so it
// wears the same face. Colour escalates as the allowance runs out.
function UsageBar({ percent }) {
  const cells = []
  const pct = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  const used = Math.max(0, Math.min(24, Math.round((pct / 100) * 24)))
  const tone = pct >= 90
    ? 'bg-(--ui-destructive)'
    : pct >= 75
      ? 'bg-(--ui-warning)'
      : 'bg-(--ui-accent)'
  for (let i = 0; i < 24; i += 1) {
    cells.push(
      jsx(
        'span',
        {
          className: cn(
            'h-3 w-2 rounded-[1.5px] transition-colors duration-500',
            i < used
              ? tone
              : 'bg-(--ui-bg-tertiary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)]'
          ),
          title: i < used ? 'allowance used' : 'allowance left'
        },
        `usage-${i}`
      )
    )
  }
  return jsx('span', { className: 'inline-flex items-center gap-[3px]', children: cells })
}

// Plan-window reset time in the user's locale: a clock time today/tomorrow,
// weekday + time once it is more than a day out.
const RESET_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function fmtResetTime(resetAtSeconds) {
  if (resetAtSeconds == null || !Number.isFinite(resetAtSeconds)) return null
  const date = new Date(resetAtSeconds * 1000)
  if (!Number.isFinite(date.getTime())) return null
  const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = (resetAtSeconds - Date.now() / 1000) / 86400
  return days > 1 ? `${RESET_WEEKDAYS[date.getDay()]} ${clock}` : clock
}

function SlotBar({ total, running, waiting }) {
  if (total == null) {
    return jsx('span', { className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'no slot gauge' })
  }
  const cells = []
  const slots = Math.max(0, Math.min(Math.round(total), 24))
  const used = Math.max(0, Math.min(running != null ? Math.round(running) : 0, slots))
  const queue = Math.max(0, Math.min(waiting != null ? Math.round(waiting) : 0, 12))
  for (let i = 0; i < slots; i += 1) {
    cells.push(
      jsx(
        'span',
        {
          className: cn(
            'h-3 w-2 rounded-[1.5px] transition-colors duration-500',
            i < used
              ? 'bg-(--ui-accent)'
              : 'bg-(--ui-bg-tertiary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)]'
          ),
          title: i < used ? 'slot in use' : 'free slot'
        },
        `slot-${i}`
      )
    )
  }
  for (let i = 0; i < queue; i += 1) {
    cells.push(
      jsx(
        'span',
        {
          className: 'h-3 w-2 rounded-[1.5px] border border-dashed border-(--ui-stroke-tertiary)',
          title: 'queued request'
        },
        `queue-${i}`
      )
    )
  }
  return jsx('span', { className: 'inline-flex items-center gap-[3px]', children: cells })
}

function Sparkline({ samples }) {
  const series = useMemo(() => {
    if (!Array.isArray(samples) || samples.length < 2) return null
    const rows = samples.filter(s => Array.isArray(s) && s.length >= 3 && s[1] != null && s[2] != null)
    if (rows.length < 2) return null
    let maxDecode = 0
    let maxPrefill = 0
    for (const row of rows) {
      if (row[1] > maxDecode) maxDecode = row[1]
      if (row[2] > maxPrefill) maxPrefill = row[2]
    }
    if (maxDecode <= 0 && maxPrefill <= 0) return null
    const decode = []
    const prefill = []
    for (let i = 0; i < rows.length; i += 1) {
      const x = (i / (rows.length - 1)) * 100
      decode.push(`${x.toFixed(2)},${(25 - (rows[i][1] / maxDecode) * 22).toFixed(2)}`)
      prefill.push(`${x.toFixed(2)},${(25 - (rows[i][2] / maxPrefill) * 22).toFixed(2)}`)
    }
    return {
      decode: decode.join(' '), prefill: prefill.join(' '),
      area: `0,26 ${decode.join(' ')} 100,26`, maxDecode, maxPrefill
    }
  }, [samples])

  if (!series) return null
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 text-[0.55rem] tabular-nums text-(--ui-text-quaternary)',
        children: [
          jsx('span', { children: `max ${fmtRate(series.maxDecode)} tok/s` }),
          jsxs('span', {
            className: 'inline-flex items-center gap-1',
            children: [
              jsx('span', { className: 'size-1 rounded-full', style: { background: 'var(--ui-accent)' } }),
              jsx('span', { children: 'decode' }),
              jsx('span', { className: 'size-1 rounded-full', style: { background: 'var(--ui-text-quaternary)' } }),
              jsx('span', { children: 'prefill' })
            ]
          })
        ]
      }),
      jsxs('svg', {
        viewBox: '0 0 100 26',
        preserveAspectRatio: 'none',
        className: 'h-6 w-full',
        'aria-hidden': 'true',
        children: [
          jsx('line', {
            x1: 0, y1: 25.5, x2: 100, y2: 25.5,
            stroke: 'var(--ui-stroke-secondary)', strokeWidth: 0.5,
            vectorEffect: 'non-scaling-stroke'
          }),
          jsx('polygon', { points: series.area, fill: 'var(--ui-accent)', opacity: 0.1 }),
          jsx('polyline', {
            points: series.decode,
            fill: 'none',
            stroke: 'var(--ui-accent)',
            strokeWidth: 1.4,
            vectorEffect: 'non-scaling-stroke',
            strokeLinejoin: 'round'
          }),
          jsx('polyline', {
            points: series.prefill,
            fill: 'none',
            stroke: 'var(--ui-text-quaternary)',
            strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke',
            strokeLinejoin: 'round'
          })
        ]
      })
    ]
  })
}

// Requests per 15 s bucket over the window. Bars, not a gauge: no track, no
// full-width fill, nothing that can read as utilization when nothing is in flight.
function RequestSparkline({ buckets }) {
  const series = useMemo(() => {
    if (!Array.isArray(buckets) || !buckets.length) return null
    const max = Math.max(...buckets, 1)
    const step = 100 / buckets.length
    const width = Math.max(1, step * 0.62)
    return {
      max,
      bars: buckets.map((count, i) => ({
        x: i * step + (step - width) / 2,
        width,
        height: Math.max(count > 0 ? 1.5 : 0, (count / max) * 18),
        count
      }))
    }
  }, [buckets])

  if (!series) return null
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsx('span', {
        className: 'text-[0.55rem] tabular-nums text-(--ui-text-quaternary)',
        children: `max ${series.max} / 15s`
      }),
      jsxs('svg', {
        viewBox: '0 0 100 20',
        preserveAspectRatio: 'none',
        className: 'h-5 w-full',
        'aria-hidden': 'true',
        children: [
          jsx('line', {
            x1: 0, y1: 19.5, x2: 100, y2: 19.5,
            stroke: 'var(--ui-stroke-secondary)', strokeWidth: 0.5,
            vectorEffect: 'non-scaling-stroke'
          }),
          series.bars.map(bar =>
            jsx('rect', {
              x: bar.x, y: 20 - bar.height, width: bar.width, height: bar.height,
              fill: 'var(--ui-accent)', opacity: bar.count > 0 ? 0.7 : 0
            }, `bucket-${bar.x}`)
          )
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// By model — local server cards first.

function ServerCard({ server, models, labels, now }) {
  const verdict = serverVerdict(server)
  const agents = Array.isArray(server.agents) ? server.agents : []
  const held = agents.filter(a => (a.requests || a.in_flight || 0) > 0)
  const unattributed = server.unattributed || 0
  const over = server.over_attributed || 0
  const sampled = server.sampled_at ? Date.parse(server.sampled_at) / 1000 : null
  // The server object carries no TTFT of its own; the busiest model lane on it
  // does, and that is the honest number to show next to the server's rates.
  const serverModels = Array.isArray(models) ? models.filter(m => m.server_name === server.name) : []
  const busiest = serverModels.slice().sort((a, b) => (b.in_flight || 0) - (a.in_flight || 0))[0]
  const ttft = server.ttft_ms_p50 != null ? server.ttft_ms_p50 : busiest ? busiest.ttft_ms_p50 : null
  const latency = server.latency_ms_p50 != null ? server.latency_ms_p50 : busiest ? busiest.latency_ms_p50 : null
  // A server whose rows are mostly whole-response has no honest TTFT or decode
  // rate; its busiest lane's latency is the number to show instead.
  const wholeResponse = busiest ? (busiest.non_streamed || 0) > (busiest.streamed || 0) : false

  return jsxs('article', {
    className: 'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-2.5',
    title: server.title || undefined,
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(StatusDot, {
            tone: verdict.tone,
            className: cn('size-2', server.in_flight > 0 && 'animate-pulse')
          }),
          jsx('span', {
            className: 'text-[0.8125rem] font-semibold tracking-tight text-(--ui-text-primary)',
            children: server.name
          }),
          jsx(Badge, { variant: 'outline', size: 'xs', children: server.kind }),
          server.aux
            ? jsx(Badge, { variant: 'muted', size: 'xs', title: server.title || 'auxiliary helper model', children: 'aux' })
            : null,
          jsx(Badge, { variant: verdict.variant, size: 'xs', children: verdict.label }),
          jsx('span', {
            className: 'ml-auto truncate font-mono text-[0.6rem] text-(--ui-text-quaternary)',
            children: server.base_url
          }),
          sampled != null
            ? jsx('span', {
                className: 'shrink-0 text-[0.6rem] text-(--ui-text-quaternary)',
                children: fmtAgo(sampled, now)
              })
            : null
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-2 text-[0.6875rem]',
        children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'slots' }),
          jsx(SlotBar, { total: server.slots, running: server.running, waiting: server.waiting }),
          jsx('span', {
            className: 'tabular-nums text-(--ui-text-secondary)',
            children: `${server.running != null ? server.running : '—'}/${server.slots != null ? server.slots : '—'}`
          }),
          server.waiting > 0
            ? jsx(Badge, { variant: 'warn', size: 'xs', children: `${server.waiting} queued` })
            : null,
          jsx('span', {
            className: 'ml-auto tabular-nums text-(--ui-text-quaternary)',
            children: server.error ? 'unreachable' : 'live'
          })
        ]
      }),
      jsx(ServerHealth, { health: server.health }),
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.6875rem]',
        children: [
          jsx(Metric, {
            label: 'decode',
            value: server.decode_tps != null ? `${fmtRate(server.decode_tps)} tok/s` : '—',
            accent: true,
            title: 'output tokens per second while streaming'
          }),
          jsx(Metric, {
            label: 'prefill',
            value: server.prefill_tps != null ? `${fmtRate(server.prefill_tps)} tok/s` : '—',
            title: 'prompt tokens processed per second before the first token'
          }),
          jsx(Metric, {
            label: 'Hermes latency p50',
            value: fmtMs(latency),
            title: "request duration (median) as observed by this machine's Hermes — only the requests Hermes sent, unlike the server-side numbers in the health row"
          }),
          jsx(Metric, {
            label: 'Hermes TTFT p50',
            value: fmtMs(ttft),
            title: `time to first token (median) as observed by this machine's Hermes — only the requests Hermes sent, unlike the server's own /metrics quantiles in the health row${wholeResponse ? '; not applicable: this server returns whole responses' : ''}${busiest && busiest.provider_aliases && busiest.provider_aliases.length > 1 ? ` · providers: ${busiest.provider_aliases.join(', ')}` : ''}`
          }),
          jsx(Metric, {
            label: 'in flight',
            value: server.in_flight != null ? server.in_flight : '—',
            title: 'requests the server counts as running right now'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-0.5 border-t border-(--ui-stroke-secondary) pt-1.5',
        children: [
          jsx('span', {
            className: 'text-[0.6rem] uppercase tracking-[0.08em] text-(--ui-text-quaternary)',
            children: 'held by'
          }),
          held.length
            ? held.map(agent =>
                jsxs(
                  'div',
                  {
                    className: 'flex items-center gap-2 text-[0.6875rem]',
                    children: [
                      jsx('span', {
                        className: 'size-1.5 shrink-0 rounded-full',
                        style: { background: profileTone(agent.profile) }
                      }),
                      jsx('span', {
                        className: 'min-w-0 flex-1 truncate text-(--ui-text-secondary)',
                        children: agentLabel(agent, labels)
                      }),
                      jsx('span', {
                        className: 'w-36 shrink-0 truncate text-right font-mono text-[0.6rem] text-(--ui-text-quaternary)',
                        children: agent.model || ''
                      }),
                      jsx('span', {
                        className: 'w-14 shrink-0 text-right tabular-nums text-(--ui-text-tertiary)',
                        children: elapsedOf(agent.oldest_started_at, now) || '—'
                      }),
                      agent.requests
                        ? jsx(Badge, { variant: 'muted', size: 'xs', children: `${agent.requests}` })
                        : null
                    ]
                  },
                  `${agent.session_id}-${agent.model}`
                )
              )
            : jsx('span', {
                className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
                children: 'no in-flight request observed'
              }),
          unattributed > 0
            ? jsxs('div', {
                className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('span', { className: 'size-1.5 shrink-0 rounded-full bg-(--ui-bg-tertiary)' }),
                  jsx('span', { className: 'min-w-0 truncate', children: 'not observed by Flightdeck' }),
                  jsx('span', { className: 'ml-auto tabular-nums', children: unattributed })
                ]
              })
            : null,
          over > 0
            ? jsx('span', {
                className: 'text-[0.6rem] text-(--ui-text-quaternary)',
                children: `${over} row(s) the server does not count (queued or closing)`
              })
            : null
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('div', { className: 'min-w-0 flex-1', children: jsx(Sparkline, { samples: server.samples }) }),
          jsx('span', {
            className: 'shrink-0 text-[0.6rem] text-(--ui-text-quaternary)',
            children: 'decode / prefill · 5m'
          })
        ]
      })
    ]
  })
}

// Plan usage from the snapshot's `quota` block (the backend fills it; may be
// null). One row per window — label, the slot-gauge bar filled by used_percent,
// '42% used · resets 3:10 PM'. A window with a null used_percent still shows
// its label and reset, never a fake fill. `unavailable_reason` is one honest
// muted line; a null quota renders nothing at all.
function PlanUsage({ quota }) {
  if (!quota || typeof quota !== 'object') return null
  const windows = Array.isArray(quota.windows)
    ? quota.windows.filter(w => w && typeof w === 'object')
    : []
  if (!windows.length && !quota.unavailable_reason) return null
  const planText = [
    quota.plan ? quota.title ? `${quota.plan} · ${quota.title}` : quota.plan : (quota.title || null),
    quota.source ? `via ${quota.source}` : null,
    quota.fetched_at != null ? `updated ${fmtAgo(quota.fetched_at, Date.now() / 1000)}` : null
  ].filter(Boolean).join(' · ')
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      windows.map((window, index) => {
        const used = Number.isFinite(window.used_percent)
          ? Math.max(0, Math.min(100, window.used_percent))
          : null
        const reset = fmtResetTime(window.reset_at)
        const text = used == null
          ? (reset ? `resets ${reset}` : 'no usage reported')
          : (reset ? `${Math.round(used)}% used · resets ${reset}` : `${Math.round(used)}% used`)
        return jsxs('div', {
          className: 'flex items-center gap-2 text-[0.65rem]',
          children: [
            jsx('span', {
              className: 'w-14 shrink-0 truncate text-(--ui-text-tertiary)',
              children: window.label || `window ${index + 1}`
            }),
            used == null
              ? jsx('span', {
                  className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                  children: 'no usage reported'
                })
              : jsx(UsageBar, { percent: used }),
            jsx('span', {
              className: 'tabular-nums text-(--ui-text-secondary)',
              children: text
            }),
            window.detail
              ? jsx('span', {
                  className: 'min-w-0 truncate text-(--ui-text-quaternary)',
                  children: window.detail
                })
              : null
          ]
        }, `${window.label || 'window'}-${index}`)
      }),
      planText
        ? jsx('span', {
            className: 'text-[0.6rem] text-(--ui-text-quaternary)',
            children: planText
          })
        : null,
      quota.unavailable_reason
        ? jsx('span', {
            className: 'text-[0.6rem] text-(--ui-text-quaternary)',
            children: `plan usage unavailable: ${quota.unavailable_reason}`
          })
        : null
    ]
  })
}

function CloudCard({ model, labels, now, windowSeconds, snapshot }) {
  const quotaQ = useQuota(model.provider)
  // The snapshot's own quota block wins; the live session.stats gauge is only
  // a fallback for a lane the snapshot has no quota for.
  const quota = model.quota != null ? null : quotaLine(quotaQ.data, model.provider)
  const plan = model.quota != null ? null : planLine(quotaQ.data)
  // `now` is ms (useNow); the tok/s series wants seconds.
  const winEnd = now / 1000
  const samples = cloudSamplesFromRequests(model.requests || [], winEnd - windowSeconds, winEnd)
  const bucketValue = Array.isArray(model.requests_buckets)
    && model.requests_buckets.some(n => Number(n) > 0)
  const rowBySession = agentRowBySession(snapshot)
  const inFlight = model.in_flight || 0
  const tokens = model.tokens || {}
  const streamed = model.streamed || 0
  const nonStreamed = model.non_streamed || 0
  const wholeResponse = nonStreamed > streamed
  const cachedPct = tokens.prompt ? Math.round((tokens.cached || 0) / tokens.prompt * 100) : null

  return jsxs('article', {
    className: 'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-2.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(StatusDot, {
            tone: inFlight > 0 ? 'good' : 'muted',
            className: cn('size-2', inFlight > 0 && 'animate-pulse')
          }),
          jsx(Codicon, { name: 'cloud', size: 12, className: 'text-(--ui-text-tertiary)' }),
          jsx('span', {
            className: 'text-[0.8125rem] font-semibold tracking-tight text-(--ui-text-primary)',
            children: `${model.provider} / ${model.model}`
          }),
          jsx(Badge, { variant: 'outline', size: 'xs', children: 'Hermes traffic only' }),
          jsx('span', {
            className: 'ml-auto truncate font-mono text-[0.6rem] text-(--ui-text-quaternary)',
            children: model.base_url
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.6875rem]',
        children: [
          jsx(Metric, {
            label: 'in flight',
            value: inFlight,
            accent: inFlight > 0,
            title: 'requests running right now'
          }),
          jsx(Metric, {
            label: 'req/min',
            value: model.requests_1m != null ? model.requests_1m : '—',
            title: 'requests per minute in the window'
          }),
          jsx(Metric, {
            label: 'latency p50',
            value: fmtMs(model.latency_ms_p50),
            title: 'request duration (median)'
          }),
          jsx(Metric, {
            label: 'TTFT p50',
            value: fmtMs(model.ttft_ms_p50),
            title: wholeResponse
              ? 'time to first token (median) — not applicable: this lane returns whole responses'
              : 'time to first token (median)'
          }),
          jsx(Metric, {
            label: 'decode',
            value: model.decode_tps != null ? `${fmtRate(model.decode_tps)} tok/s` : '—',
            title: 'output tokens per second while streaming'
          }),
          jsx(Metric, {
            label: 'input',
            value: `${tokenText(tokens.prompt)}${cachedPct ? ` · ${cachedPct}% cached` : ''}`,
            title: 'prompt tokens sent to the model; cached share was reused, not reprocessed'
          }),
          jsx(Metric, {
            label: 'output',
            value: tokenText(tokens.completion),
            title: 'completion tokens generated'
          }),
          jsx(Metric, {
            label: 'errors',
            value: `${model.errors_5m != null ? model.errors_5m : 0}${model.errors_429_5m ? ` · ${model.errors_429_5m} × 429` : ''}`,
            title: 'failed requests in the window; 429s are rate limits'
          })
        ]
      }),
      jsx(PlanUsage, { quota: model.quota }),
      quota || plan
        ? jsxs('div', {
            className: 'flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[0.65rem] text-(--ui-text-tertiary)',
            children: [
              quota ? jsx('span', { className: 'tabular-nums', children: quota }) : null,
              plan ? jsx('span', { className: 'tabular-nums', children: plan }) : null
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex items-end gap-3 border-t border-(--ui-stroke-secondary) pt-1.5',
        children: [
          jsxs('div', {
            className: 'min-w-0 flex-1 flex items-center gap-2',
            children: [
              jsx('div', {
                className: 'min-w-0 flex-1',
                children: samples.length
                  ? jsx(Sparkline, { samples })
                  : (bucketValue ? jsx(RequestSparkline, { buckets: model.requests_buckets }) : null)
              }),
              jsx('span', {
                className: 'shrink-0 text-[0.6rem] text-(--ui-text-quaternary)',
                title: "Computed from this machine's Hermes requests only; the provider does not publish server throughput.",
                children: samples.length
                  ? `decode / prefill · ${fmtDuration(windowSeconds)} · Hermes-observed`
                  : `requests, last ${fmtDuration(windowSeconds)}`
              })
            ]
          }),
          jsxs('div', {
            className: 'flex flex-col gap-0.5 text-[0.6rem] text-(--ui-text-quaternary)',
            children: [
              jsx('span', {
                children: `${model.agents ? model.agents.length : 0} agent${model.agents && model.agents.length === 1 ? '' : 's'} holding`
              }),
              jsx('span', {
                children: model.agents && model.agents.length
                  ? model.agents.map(a => agentLabel(rowBySession.get(a.session_id) || a, labels)).join(' · ')
                  : 'no in-flight request observed'
              })
            ]
          })
        ]
      })
    ]
  })
}

function NoServerCard({ model, labels, now }) {
  const inFlight = model.in_flight || 0
  const tokens = model.tokens || {}
  const wholeResponse = (model.non_streamed || 0) > (model.streamed || 0)
  const cachedPct = tokens.prompt ? Math.round((tokens.cached || 0) / tokens.prompt * 100) : null
  return jsxs('article', {
    className: 'flex flex-col gap-2 rounded-lg border border-dashed border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-2.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(StatusDot, {
            tone: inFlight > 0 ? 'good' : 'muted',
            className: cn('size-2', inFlight > 0 && 'animate-pulse')
          }),
          jsx('span', {
            className: 'text-[0.8125rem] font-semibold tracking-tight text-(--ui-text-primary)',
            title: model.provider_aliases && model.provider_aliases.length > 1
              ? `providers: ${model.provider_aliases.join(', ')}`
              : undefined,
            children: `${model.provider} / ${model.model}`
          }),
          jsx(Badge, { variant: 'outline', size: 'xs', children: 'no server metrics' }),
          jsx('span', {
            className: 'ml-auto truncate font-mono text-[0.6rem] text-(--ui-text-quaternary)',
            children: model.base_url
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.6875rem]',
        children: [
          jsx(Metric, {
            label: 'in flight',
            value: inFlight,
            accent: inFlight > 0,
            title: 'requests running right now'
          }),
          jsx(Metric, {
            label: 'req/min',
            value: model.requests_1m != null ? model.requests_1m : '—',
            title: 'requests per minute in the window'
          }),
          jsx(Metric, {
            label: 'latency p50',
            value: fmtMs(model.latency_ms_p50),
            title: 'request duration (median)'
          }),
          jsx(Metric, {
            label: 'TTFT p50',
            value: fmtMs(model.ttft_ms_p50),
            title: wholeResponse
              ? 'time to first token (median) — not applicable: this lane returns whole responses'
              : 'time to first token (median)'
          }),
          jsx(Metric, {
            label: 'decode',
            value: model.decode_tps != null ? `${fmtRate(model.decode_tps)} tok/s` : '—',
            title: 'output tokens per second while streaming'
          }),
          jsx(Metric, {
            label: 'input',
            value: `${tokenText(tokens.prompt)}${cachedPct ? ` · ${cachedPct}% cached` : ''}`,
            title: 'prompt tokens sent to the model; cached share was reused, not reprocessed'
          }),
          jsx(Metric, {
            label: 'output',
            value: tokenText(tokens.completion),
            title: 'completion tokens generated'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-2 text-[0.65rem] text-(--ui-text-quaternary)',
        children: [
          jsx('span', {
            children: 'base_url matches no declared server; numbers are Hermes hook rows only'
          }),
          jsx('span', {
            className: 'ml-auto',
            children: model.agents && model.agents.length
              ? model.agents.map(a => agentLabel(a, labels)).join(' · ')
              : 'no in-flight request observed'
          })
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// The swim-lane. A canvas, one lane per local server, x = the selected window.
// Throughput history comes from server samples (real, per server). In-flight
// agent bars come from each server agent's oldest_started_at (real row timing).
// If the backend later ships per-request rows (`server.requests`), each request
// is drawn as a dim prefill segment split at first_chunk_at and a bright decode
// segment, colored by profile — the design's full Option A.

function truncateText(ctx2, text, maxWidth) {
  if (ctx2.measureText(text).width <= maxWidth) return text
  let cut = text
  while (cut.length > 1 && ctx2.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1)
  return `${cut}…`
}

function requestTooltip(request, labels) {
  const ttft = request.first_chunk_at != null && request.started_at != null
    ? Math.max(0, request.first_chunk_at - request.started_at) * 1000
    : null
  const genEnd = request.ended_at != null ? request.ended_at : Date.now() / 1000
  const genSpan = request.first_chunk_at != null ? Math.max(0, genEnd - request.first_chunk_at) : null
  const generating = genSpan && genSpan > 0 && request.completion_tokens != null
    ? request.completion_tokens / genSpan
    : null
  return [
    agentLabel(request, labels || {}),
    request.model || 'model unknown',
    `TTFT ${fmtMs(ttft)}`,
    `generating ${generating != null ? `${fmtRate(generating)} tok/s` : '—'}`,
    isWholeResponse(request) ? 'not streamed (whole response)' : 'streamed',
    `${tokenText(request.prompt_tokens)} in / ${tokenText(request.completion_tokens)} out`,
    request.status || 'status unknown'
  ].join(' · ')
}

// The swim lane's window comes from the snapshot itself, never the page clock:
// a snapshot polled 5 s ago still shows the rows the backend put in it, and a
// stale page clock can never hide a lane's bars or draw the empty message.
function swimWindow(snapshot, windowSeconds, now) {
  const win = snapshot && snapshot.window
  const seconds = Number(win && win.seconds) || Number(windowSeconds) || 300
  const end = Number(win && win.since != null ? win.since + seconds : null) ||
    Number(snapshot && snapshot.generated_at) ||
    Number(now) / 1000
  const start = Number(win && win.since != null ? win.since : null) || end - seconds
  return { seconds, start, end }
}

// No streamed output: no first chunk at all, or a first token at/after the end
// (minus a quarter-second of slack). A non-streamed response has nothing honest
// to show as 'generating', so it draws as the hatched whole-response bar.
// THIS is the single streamed predicate: the canvas hatches a bar exactly when
// this is true, and the lane's 'n streamed' count is the rows where it is false.
function isWholeResponse(request) {
  if (!request) return true
  const first = request.first_chunk_at
  if (first == null) return true
  const end = request.ended_at != null ? request.ended_at : null
  if (end == null) return false
  return first >= end - 0.25
}

// The cloud card's decode/prefill series, derived from Hermes' OWN per-request
// rows — the provider publishes no server throughput for a cloud lane, so this
// is the only honest tok/s history a cloud card can show. Each row spreads its
// completion tokens uniformly over its generating span (first_chunk_at →
// ended_at, or `winEnd` — which the caller passes as `now` — while in flight; a
// non-streamed row — no first chunk, or one at/after the end minus a
// quarter-second of slack — spreads them over the whole span instead) and its
// prompt tokens uniformly over the prefill span (started_at → first_chunk_at,
// or the whole span when non-streamed). Buckets are 5 s wide over the rows' own
// span, so the output has the exact shape the local cards' Sparkline consumes:
// [bucketStart, decodeTokPerSec, prefillTokPerSec].
const CLOUD_SAMPLE_SECONDS = 5

function cloudSamplesFromRequests(requests, winStart, winEnd) {
  const rows = (Array.isArray(requests) ? requests : []).filter(
    row => row && row.started_at != null
  )
  if (!rows.length) return []
  let lo = winStart
  let hi = winEnd
  for (const row of rows) {
    if (row.started_at < lo) lo = row.started_at
    const end = row.ended_at != null ? row.ended_at : winEnd
    if (end > hi) hi = end
  }
  const span = Math.max(CLOUD_SAMPLE_SECONDS, hi - lo)
  const buckets = Math.max(2, Math.ceil(span / CLOUD_SAMPLE_SECONDS))
  const decode = new Array(buckets).fill(0)
  const prefill = new Array(buckets).fill(0)
  // Spread `tokens` uniformly over [from, to] clipped to the window, so every
  // bucket it touches gets the tokens proportional to the overlap.
  const spread = (from, to, tokens, into) => {
    if (!(tokens > 0) || !(to > from)) return
    const a = Math.max(from, lo)
    const b = Math.min(to, hi)
    if (!(b > a)) return
    const perSecond = tokens / (to - from)
    let i = Math.max(0, Math.floor((a - lo) / CLOUD_SAMPLE_SECONDS))
    const last = Math.min(buckets - 1, Math.floor((b - lo) / CLOUD_SAMPLE_SECONDS))
    for (; i <= last; i += 1) {
      const bucketStart = lo + i * CLOUD_SAMPLE_SECONDS
      const overlap = Math.min(b, bucketStart + CLOUD_SAMPLE_SECONDS) - Math.max(a, bucketStart)
      if (overlap > 0) into[i] += perSecond * overlap
    }
  }
  for (const row of rows) {
    const start = row.started_at
    const end = row.ended_at != null ? row.ended_at : winEnd
    if (!(end > start)) continue
    const streamed = !isWholeResponse(row)
    const genStart = streamed ? row.first_chunk_at : start
    spread(genStart, end, row.completion_tokens, decode)
    spread(start, streamed ? row.first_chunk_at : end, row.prompt_tokens, prefill)
  }
  let maxDecode = 0
  let maxPrefill = 0
  for (let i = 0; i < buckets; i += 1) {
    decode[i] = decode[i] / CLOUD_SAMPLE_SECONDS
    prefill[i] = prefill[i] / CLOUD_SAMPLE_SECONDS
    if (decode[i] > maxDecode) maxDecode = decode[i]
    if (prefill[i] > maxPrefill) maxPrefill = prefill[i]
  }
  if (maxDecode <= 0 && maxPrefill <= 0) return []
  const samples = []
  for (let i = 0; i < buckets; i += 1) {
    if (decode[i] > 0 || prefill[i] > 0) {
      samples.push([lo + i * CLOUD_SAMPLE_SECONDS, decode[i], prefill[i]])
    }
  }
  return samples
}

// One stacked sub-row per overlapping request: slot 1 at the top, queued
// requests beyond the server's slots drawn dashed. A request that never
// streamed is a whole response and draws as one uniform hatched bar.
// `abutStart` marks a request that starts the instant the previous bar on its
// row ends (an agent loop firing back-to-back) — the draw insets those by 1 px
// so 15 requests never read as one continuous block.
function stackBars(requests, win) {
  const rows = []
  const rowEnds = []
  for (const request of requests || []) {
    const start = Math.max(win.start, request.started_at)
    const end = request.ended_at != null ? Math.min(win.end, request.ended_at) : win.end
    let slot = rowEnds.findIndex(ends => ends <= start)
    if (slot < 0) {
      slot = rowEnds.length
      rowEnds.push(end)
    } else {
      rowEnds[slot] = end
    }
    // Back-to-back on this exact sub-row (an agent loop: the next call starts
    // the instant the previous ends) — drawn with a 1 px gap at its start.
    const abutStart = rows.some(other => other.slot === slot && Math.abs(other.end - start) < 0.001)
    rows.push({ request, start, end, slot, whole: isWholeResponse(request), abutStart })
  }
  return rows
}

// Fallback for a cloud lane whose backend carries no per-request rows: its
// traffic is the 15 s request buckets, drawn as columns scaled to a concurrency
// axis whose height is the MAX bucket count (never the total), so a lane that
// never ran more than one request at a time has full-height columns and a
// 'peak 1 / 15 s' axis. One tick per non-empty bucket.
function bucketTicks(buckets, win) {
  const perBucket = Math.max(1, Math.ceil(win.seconds / SWIM_BUCKET_SECONDS))
  const ticks = []
  for (let i = 0; i < buckets.length && i < perBucket; i += 1) {
    const count = Number(buckets[i]) || 0
    if (!count) continue
    ticks.push({
      start: win.start + i * SWIM_BUCKET_SECONDS,
      end: win.start + (i + 1) * SWIM_BUCKET_SECONDS,
      count,
      slot: 0
    })
  }
  return ticks
}

// Requests the lane actually drew in the selected window — the ONLY count the
// lane shows. A bucket-fallback lane has no rows, so its bucket total is the
// number of requests in the window. Left detail and right axis must never
// disagree, so both read this, never the backend's requests_1m.
function laneWindowCounts(lane) {
  const rows = (lane && lane.requests) || []
  if (rows.length) {
    // The SAME predicate the canvas draws with: a bar is hatched exactly when
    // isWholeResponse(row) is true, so 'streamed' counts the rows that are not.
    return { count: rows.length, streamed: rows.filter(row => !isWholeResponse(row)).length }
  }
  const total = Number(lane && lane.total) || 0
  return { count: total, streamed: Number(lane && lane.model && lane.model.streamed) || 0 }
}

// Which bar phases the chart ACTUALLY draws. The footer legend renders one
// swatch per phase only when at least one drawn bar uses it — a lane with no
// queued bar never shows 'queued (beyond slots)', a lane with no streamed bar
// never shows the waiting/generating pair. Bucket-fallback lanes paint plain
// columns (none of these phases), so a chart of only bucket lanes shows just
// the 'colour = agent' sentence.
function lanePhasePresence(lanes) {
  const present = { waiting: false, generating: false, whole: false, queued: false }
  for (const lane of lanes || []) {
    if (lane.ticks) continue
    for (const bar of lane.bars || []) {
      if (lane.slots != null && bar.slot >= lane.slots) { present.queued = true; continue }
      if (bar.whole) { present.whole = true; continue }
      if (bar.request && bar.request.first_chunk_at != null && bar.request.first_chunk_at > bar.start) {
        present.waiting = true
      }
      present.generating = true
    }
  }
  return present
}

// Every lane in the window: local servers with rows or in-flight work, then one
// cloud lane per cloud model with traffic. The whole ecosystem, local first.
// EVERY lane uses the same encoding: per-request bars stacked by overlap, so
// the number of rows stacked at any x is the concurrency at that moment. Cloud
// model entries carry the same per-request rows (model.requests) as servers;
// only when they're missing but the buckets show traffic does the lane fall
// back to the 15 s bucket columns.
function swimLanes(snapshot, windowSeconds, now) {
  const win = swimWindow(snapshot, windowSeconds, now)
  const servers = Array.isArray(snapshot && snapshot.servers) ? snapshot.servers : []
  const models = Array.isArray(snapshot && snapshot.models) ? snapshot.models : []
  const lanes = []
  const requestRows = rows => (Array.isArray(rows) ? rows : [])
    .filter(row => row && row.started_at != null && (row.ended_at == null || row.ended_at >= win.start))
    .sort((a, b) => a.started_at - b.started_at)
    // Newest-first: backend caps can drop the oldest, never the most recent.
    .slice(-120)
  for (const server of servers) {
    if (!server || server.kind === 'cloud') continue
    const requests = requestRows(server.requests)
    if (!requests.length && !((server.in_flight || 0) > 0)) continue
    const bars = stackBars(requests, win)
    const counts = laneWindowCounts({ requests, total: requests.length })
    lanes.push({
      kind: 'local',
      id: `local:${server.base_url || server.name}`,
      label: server.name || 'server',
      // Same left-detail form as a cloud lane: the request/streamed counts from
      // laneWindowCounts — the same numbers the bars are drawn from. Never the
      // live running/slots here: that disagreed with the right axis's
      // 'peak N of S slots' on one lane. Live running/slots is on the server
      // card, and slots live on this lane's right edge only.
      detail: `${fmtInt(counts.count)} req · ${fmtInt(counts.streamed)} streamed`,
      server,
      requests,
      bars,
      reqCount: counts.count,
      streamedCount: counts.streamed,
      concurrency: Math.max(0, ...bars.map(bar => bar.slot + 1)),
      slots: server.slots != null ? Math.max(1, server.slots) : Math.max(1, ...bars.map(bar => bar.slot + 1))
    })
  }
  for (const model of models) {
    if (!model || model.lane !== 'cloud') continue
    const buckets = Array.isArray(model.requests_buckets) ? model.requests_buckets : []
    const bucketTotal = buckets.reduce((sum, n) => sum + (Number(n) || 0), 0)
    const total = bucketTotal || (model.requests_1m || 0) || (model.requests_5m || 0)
    if (!total) continue
    const requests = requestRows(model.requests)
    if (requests.length) {
      // Same encoding as local lanes: per-request bars, stacked rows = concurrency.
      const bars = stackBars(requests, win)
      // The count BOTH sides of the lane show: the rows drawn in this window.
      // Never model.requests_1m — that disagreed with the rows on the canvas.
      const counts = laneWindowCounts({ requests, total })
      lanes.push({
        kind: 'cloud',
        id: `cloud:${model.key || model.provider}`,
        label: `${model.provider || 'cloud'} / ${model.model || 'model'}`,
        // Short enough for the 124 px left gutter: the long form truncated.
        detail: `${fmtInt(counts.count)} req · ${fmtInt(counts.streamed)} streamed`,
        model,
        requests,
        bars,
        reqCount: counts.count,
        streamedCount: counts.streamed,
        concurrency: Math.max(0, ...bars.map(bar => bar.slot + 1)),
        slots: null,
        total
      })
      continue
    }
    if (!bucketTotal) continue
    // Fallback: no per-request rows from the backend, only buckets.
    const counts = laneWindowCounts({ requests: [], total })
    lanes.push({
      kind: 'cloud',
      id: `cloud:${model.key || model.provider}`,
      label: `${model.provider || 'cloud'} / ${model.model || 'model'}`,
      detail: `${fmtInt(counts.count)} req · ${fmtInt(counts.streamed)} streamed`,
      model,
      requests: [],
      bars: bucketTicks(buckets, win),
      ticks: true,
      reqCount: counts.count,
      streamedCount: counts.streamed,
      concurrency: Math.max(0, ...buckets.map(n => Number(n) || 0)),
      slots: null,
      total
    })
  }
  return { win, lanes }
}

// One lane per server or cloud model with traffic — ONE encoding everywhere:
// each request is a horizontal bar from start to end, low alpha = waiting for
// the first token (queue + prefill + thinking), full colour = generating,
// hatched = whole response (the reply never streamed), dashed outline = queued
// beyond the server's slot count. Back-to-back requests on a row get a 1 px gap
// at their start and a 1 px darker outline in the bar's own colour, so an agent
// loop of 15 abutting calls reads as 15 blocks, not one blob. Bars are stacked
// into sub-rows by overlap, so the y-axis IS concurrency: stacked rows at any x
// = concurrent requests at that moment, and the row height grows to fill the
// lane (peak 1 draws one thick bar, not a stripe). The right edge labels the
// axis: bold 'peak N', muted 'of S slots' for local lanes — and nothing else,
// since the request count is already in the lane's left detail, from the same
// number. A cloud lane whose backend carries no per-request rows falls back to
// 15 s bucket columns scaled to the max bucket.
// A lane's right-side concurrency-axis labels: bold 'peak N' (the max stacked
// rows in the window = most concurrent requests), muted 'of S slots' for local
// lanes only. The request count is deliberately NOT repeated here — the left
// detail ('<n> req · <m> streamed') and this axis both come from
// laneWindowCounts, so one number, shown once. A bucket-fallback cloud lane
// labels the axis 'peak N / 15 s' instead, since its columns are scaled to the
// max bucket. Measured with the drawing context (the gutter is computed inside
// the draw, where the ctx exists), so the widest label never clips.
function laneRightLabels(lane) {
  if (lane.ticks) return [`peak ${lane.concurrency} / ${SWIM_BUCKET_SECONDS} s`]
  const labels = [`peak ${lane.concurrency}`]
  if (lane.kind === 'local' && lane.slots != null) labels.push(`of ${lane.slots} slots`)
  return labels
}

const RIGHT_GUTTER_MIN = 60
const RIGHT_GUTTER_PAD = 18

function shadeColor(color, amount) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim())
  if (!hex) return color
  let digits = hex[1]
  if (digits.length === 3) digits = digits.split('').map(ch => ch + ch).join('')
  const n = parseInt(digits, 16)
  const part = shift => {
    const v = (n >> shift) & 0xff
    return Math.round(shift ? v * (1 - amount) : v * (1 - amount * 0.6))
  }
  const to2 = v => v.toString(16).padStart(2, '0')
  return `#${to2(part(16))}${to2(part(8))}${to2(part(0))}`
}

function drawSwimLane(ctx2, width, height, lanes, win, canvas, labels) {
  const style = getComputedStyle(canvas)
  const accent = style.getPropertyValue('--ui-accent').trim() || 'currentColor'
  const dim = style.getPropertyValue('--ui-text-quaternary').trim() || 'currentColor'
  const stroke = style.getPropertyValue('--ui-stroke-secondary').trim() || 'currentColor'
  const text = style.getPropertyValue('--ui-text-tertiary').trim() || 'currentColor'

  const gutter = 124
  // Right gutter: wide enough for the widest right-side scale label of any lane
  // ('peak 12 of 12 slots'), measured with the real font. A fixed 56 px
  // clipped those labels at the canvas edge.
  let right = RIGHT_GUTTER_MIN
  if (lanes.length) {
    ctx2.font = '9px sans-serif'
    for (const lane of lanes) {
      right = Math.max(right, ...laneRightLabels(lane).map(
        label => Math.ceil((ctx2.measureText(label).width || 0) + RIGHT_GUTTER_PAD)
      ))
    }
  }
  const axisH = 16
  const top = 4
  const plotW = Math.max(40, width - gutter - right)
  const xOf = t => gutter + ((Math.max(win.start, Math.min(win.end, t)) - win.start) / win.seconds) * plotW
  const hits = []

  ctx2.clearRect(0, 0, width, height)
  ctx2.textBaseline = 'middle'
  ctx2.textAlign = 'left'

  if (!lanes.length) {
    ctx2.fillStyle = text
    ctx2.font = '11px sans-serif'
    ctx2.fillText('no local or cloud traffic in this window', gutter, height / 2)
    return hits
  }

  const laneH = Math.max(56, (height - top - axisH) / lanes.length)
  // Every lane with per-request rows feeds the palette, so a cloud lane's
  // agent bars get legend colours just like a local lane's.
  const colors = agentColorMap(lanes.filter(lane => (lane.requests || []).length))

  for (let li = 0; li < lanes.length; li += 1) {
    const lane = lanes[li]
    const y = top + li * laneH
    const innerH = laneH - 6
    // The exact strings this lane paints on its right edge — the same strings
    // the gutter was measured from, so they can never clip.
    const rightLabels = laneRightLabels(lane)

    ctx2.fillStyle = 'transparent'
    ctx2.strokeStyle = stroke
    ctx2.lineWidth = 1
    ctx2.strokeRect(gutter + 0.5, y + 0.5, plotW - 1, innerH - 1)

    // ONE encoding for every lane, local and cloud alike: the stacked bars are
    // the y-axis (concurrency), so the row height grows to fill the lane —
    // peak 1 draws one thick bar, peak 8 draws eight thin ones.
    const peak = Math.max(1, lane.concurrency)
    const rowGap = 2
    const rowH = Math.max(3, Math.min(14, (innerH - 8 - rowGap * (peak - 1)) / peak))
    const barTop = y + 4

    if (lane.ticks) {
      // Fallback cloud lane: 15 s bucket columns scaled to the MAX bucket, so
      // the column height reads against the 'peak N / 15 s' axis label.
      const baseY = y + innerH - 6
      const plotH = innerH - 22
      const maxCount = Math.max(1, peak)
      ctx2.save()
      ctx2.fillStyle = accent
      ctx2.globalAlpha = 0.55
      for (const tick of lane.bars) {
        const x1 = xOf(tick.start) + 2
        const x2 = Math.max(x1 + 2, xOf(tick.end) - 2)
        const tickH = Math.max(2, (tick.count / maxCount) * plotH)
        ctx2.fillRect(x1, baseY - tickH, Math.max(2, x2 - x1), tickH)
        ctx2.fillStyle = text
        ctx2.font = '8px sans-serif'
        ctx2.fillText(String(tick.count), x1, baseY - tickH - 6)
        ctx2.fillStyle = accent
      }
      ctx2.restore()
    } else {
      // Per-request bars, stacked into sub-rows by overlap: rows stacked at any
      // x = concurrent requests at that moment.
      lane.bars.forEach(item => {
        const { request, start, end, slot, whole } = item
        // Request boundaries: a bar that starts the instant the previous one on
        // its row ends is inset 1 px, so back-to-back calls read as separate
        // blocks instead of one continuous blob.
        const x1 = xOf(start) + (item.abutStart ? 1 : 0)
        const x2 = Math.max(x1 + 2, xOf(end))
        const barY = barTop + slot * (rowH + rowGap)
        const color = colors.get(agentKey(request)) || accent
        const queued = lane.slots != null && slot >= lane.slots
        ctx2.save()
        if (queued) {
          ctx2.globalAlpha = 0.55
          ctx2.strokeStyle = color
          ctx2.lineWidth = 1
          ctx2.setLineDash([2, 2])
          ctx2.strokeRect(x1 + 0.5, barY + 0.5, Math.max(2, x2 - x1) - 1, rowH - 1)
        } else if (whole) {
          // Nothing was ever streamed, so there is no honest 'generating' half:
          // draw the WHOLE bar hatched in the agent's colour rather than a dim
          // bar with an invisible sliver of the bright phase.
          ctx2.globalAlpha = 0.5
          ctx2.fillStyle = color
          ctx2.fillRect(x1, barY, Math.max(2, x2 - x1), rowH)
          ctx2.globalAlpha = 0.85
          ctx2.strokeStyle = color
          ctx2.lineWidth = 1
          for (let x = x1; x < x2; x += 4) {
            ctx2.beginPath()
            ctx2.moveTo(x, barY + rowH)
            ctx2.lineTo(Math.min(x + 3, x2), barY)
            ctx2.stroke()
          }
        } else {
          // Low alpha = waiting for the first token (queue + prefill + thinking),
          // full colour = generating.
          const split = request.first_chunk_at != null ? xOf(request.first_chunk_at) : x2
          ctx2.globalAlpha = 0.35
          ctx2.fillStyle = color
          ctx2.fillRect(x1, barY, Math.max(1, split - x1), rowH)
          ctx2.globalAlpha = 0.9
          ctx2.fillRect(split, barY, Math.max(1, x2 - split), rowH)
          if (request.ended_at == null) {
            // In-flight growing edge: a brighter cap that pulses with the clock.
            ctx2.globalAlpha = 0.55 + 0.35 * Math.abs(Math.sin(win.end / 420))
            ctx2.fillStyle = color
            ctx2.fillRect(x2 - 1.5, barY - 1, 2, rowH + 2)
          }
        }
        // 1 px darker outline in the bar's own colour: the edge of every request,
        // visible even when two bars touch.
        ctx2.globalAlpha = 0.95
        ctx2.strokeStyle = shadeColor(color, 0.45)
        ctx2.lineWidth = 1
        ctx2.strokeRect(x1 + 0.5, barY + 0.5, Math.max(2, x2 - x1) - 1, rowH - 1)
        ctx2.restore()
        hits.push({ x: x1, y: barY, w: Math.max(2, x2 - x1), h: rowH, request, lane })
      })

      // Idle local lane: no rows at all (only an in-flight count) — a flat zero
      // baseline plus a muted 'idle' label instead of an empty frame.
      if (!lane.bars.length && lane.kind === 'local') {
        const flatY = y + innerH - 4
        ctx2.save()
        ctx2.strokeStyle = stroke
        ctx2.globalAlpha = 0.7
        ctx2.lineWidth = 1
        ctx2.beginPath()
        ctx2.moveTo(gutter + 1, flatY + 0.5)
        ctx2.lineTo(gutter + plotW, flatY + 0.5)
        ctx2.stroke()
        ctx2.restore()
        ctx2.save()
        ctx2.fillStyle = dim
        ctx2.font = '9px sans-serif'
        ctx2.globalAlpha = 0.85
        ctx2.fillText('idle', gutter + plotW / 2 - 8, y + innerH / 2 + 3)
        ctx2.restore()
      }
    }

    // Right edge: the concurrency axis for this lane — bold 'peak N', then
    // muted 'of S slots' (local only) / bucket-axis. The request count lives in
    // the left detail and is never repeated here.
    ctx2.fillStyle = text
    ctx2.font = '600 10px sans-serif'
    ctx2.fillText(rightLabels[0], gutter + plotW + 6, y + 10)
    ctx2.fillStyle = dim
    ctx2.font = '9px sans-serif'
    for (let li = 1; li < rightLabels.length; li += 1) {
      ctx2.fillText(
        rightLabels[li], gutter + plotW + 6, y + 10 + li * 12
      )
    }

    // Lane label in the gutter: local/cloud first, then the lane's own name.
    ctx2.fillStyle = lane.kind === 'local' ? text : accent
    ctx2.font = '600 10px sans-serif'
    ctx2.fillText(truncateText(ctx2, lane.kind, gutter - 14), 8, y + 10)
    ctx2.fillStyle = text
    ctx2.font = '600 11px sans-serif'
    // Provider prefixes never make the gutter — a lane shows its model half.
    ctx2.fillText(truncateText(ctx2, laneModelShort(lane.label), gutter - 14), 8, y + 24)
    ctx2.fillStyle = dim
    ctx2.font = '10px sans-serif'
    ctx2.fillText(truncateText(ctx2, lane.detail, gutter - 14), 8, y + 36)
  }

  // Time grid and axis labels.
  ctx2.save()
  ctx2.strokeStyle = stroke
  ctx2.lineWidth = 1
  ctx2.globalAlpha = 0.6
  for (let i = 0; i <= 4; i += 1) {
    const x = gutter + (plotW * i) / 4
    ctx2.beginPath()
    ctx2.moveTo(x + 0.5, top)
    ctx2.lineTo(x + 0.5, height - axisH)
    ctx2.stroke()
  }
  ctx2.restore()
  ctx2.fillStyle = dim
  ctx2.font = '10px sans-serif'
  ctx2.textBaseline = 'top'
  const marks = [0, 1, 2, 3, 4]
  for (const i of marks) {
    const x = gutter + (plotW * i) / 4
    const offset = win.seconds * (1 - i / 4)
    const label = i === 4 ? 'now' : `-${fmtElapsed(offset)}`
    ctx2.fillText(label, i === 4 ? x - 18 : x + 2, height - axisH + 2)
  }
  ctx2.textBaseline = 'middle'
  return hits
}

function SwimLane({ snapshot, labels, windowSeconds, now }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const hitsRef = useRef([])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState(null)
  const { win, lanes } = useMemo(
    () => swimLanes(snapshot, windowSeconds, now),
    [snapshot, windowSeconds, now]
  )

  useEffect(() => {
    const element = wrapRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0] && entries[0].contentRect
      if (rect && rect.width > 0) setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width <= 0 || size.height <= 0) return
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    const ctx2 = canvas.getContext('2d')
    if (!ctx2) return
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0)
    hitsRef.current = drawSwimLane(ctx2, size.width, size.height, lanes, win, canvas, labels)
  }, [lanes, win, size, labels])

  const legend = useMemo(() => {
    // Every lane with per-request rows feeds the palette, so a cloud lane's
    // agent bars get legend colours just like a local lane's.
    const colors = agentColorMap(lanes.filter(lane => (lane.requests || []).length))
    const entries = [...colors.entries()].slice(0, 8)
    // snapshot.agents rows indexed by session id: the real title lives there,
    // so the legend never shows a bare date id when a title exists. Subagent
    // rows are NESTED under their parent as `children` (and deeper), so walk
    // the whole tree — a map of the roots alone left subagent lanes falling
    // back to 'default · session <id>' instead of their 'subagent · <goal>'
    // label, which is exactly what the By agent rows show for the same row.
    const agentRows = Array.isArray(snapshot && snapshot.agents) ? snapshot.agents : []
    const rowBySession = new Map()
    const visitAgentRow = row => {
      if (!row || typeof row !== 'object') return
      if (row.session_id && !rowBySession.has(row.session_id)) {
        rowBySession.set(row.session_id, row)
      }
      if (Array.isArray(row.children)) row.children.forEach(visitAgentRow)
    }
    agentRows.forEach(visitAgentRow)
    // Same label builder as the By agent rows, so the legend and the tree never
    // read differently. Two sessions can still share a title (e.g. two
    // untitled 'default' sessions) — disambiguate with the id tail.
    const seen = new Map()
    return entries.map(([key, color]) => {
      const [profile, session] = key.split('|')
      const agentRow = (session && rowBySession.get(session)) || null
      const row = {
        kind: (agentRow && agentRow.kind) || 'session',
        profile: (agentRow && agentRow.profile) || profile,
        session_id: session,
        title: agentRow && agentRow.title,
        label: agentRow && agentRow.label,
        source: agentRow && agentRow.source,
        // Subagent rows carry role + goal (agentLabel renders 'subagent · goal'
        // from these); a lane whose session belongs to a nested child agent must
        // read like the By agent row for that same agent.
        role: agentRow && agentRow.role,
        goal: agentRow && agentRow.goal
      }
      // agentLabel prefers the row's own title; the date id is the last resort.
      const base = agentLabel(row, labels || {}) || (session ? `session ${session.slice(0, 8)}` : profile)
      const label = `${profile} · ${base}`
      const n = (seen.get(label) || 0) + 1
      seen.set(label, n)
      return {
        key,
        color,
        label: n > 1 && session ? `${label} · ${session.slice(-6)}` : label
      }
    })
  }, [lanes, labels, snapshot])

  const onMove = event => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const hit = (hitsRef.current || []).find(item =>
      x >= item.x - 1 && x <= item.x + item.w + 1 && y >= item.y - 1 && y <= item.y + item.h + 1
    )
    if (hit) setHover({ x, y, text: requestTooltip(hit.request, labels) })
    else if (hover) setHover(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        ref: wrapRef,
        className: 'relative w-full',
        style: {
          height: '190px',
          padding: '4px',
          borderRadius: '8px',
          border: '1px solid var(--ui-stroke-secondary)',
          background: 'var(--ui-bg-quinary)'
        },
        onMouseMove: onMove,
        onMouseLeave: () => setHover(null),
        children: [
          jsx('canvas', {
            ref: canvasRef,
            className: 'block',
            style: { width: '100%', height: '100%' },
            role: 'img',
            'aria-label': 'Swim-lane timeline: one lane per server or cloud model with traffic, local lanes first; every lane uses the same encoding — one horizontal bar per request (low-alpha waiting for first token, full-colour generating, hatched when the response was not streamed, dashed queued beyond slots), separated by a 1 px gap and outlined so back-to-back requests stay distinct, stacked into rows so rows at any moment equal concurrent requests, with the peak concurrency labelled on the right'
          }),
          hover
            ? jsx('div', {
                className: 'pointer-events-none absolute z-10 rounded px-2 py-1 shadow-lg',
                style: {
                  left: `${Math.min(hover.x + 10, Math.max(8, size.width - 350))}px`,
                  top: `${Math.min(hover.y + 12, Math.max(8, size.height - 60))}px`,
                  maxWidth: '340px',
                  border: '1px solid var(--ui-stroke-secondary)',
                  background: 'var(--ui-bg-tertiary)',
                  fontSize: '0.6rem',
                  lineHeight: 1.6,
                  color: 'var(--ui-text-secondary)'
                },
                children: hover.text
              })
            : null
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5',
        style: { fontSize: '0.55rem', color: 'var(--ui-text-quaternary)' },
        children: [
          // ONE legend line for the whole chart — the section header carries no
          // encoding text. Swatches are drawn in ONE neutral colour (the UI
          // accent, the same for every entry — agent identity is carried by the
          // per-agent list below) with exactly the
          // alpha / hatch / dash styles the canvas paints, so each swatch is a
          // true preview of its bar; which agent is which is said by the
          // 'colour = agent' sentence, not by recolouring the swatches.
          // Each swatch renders ONLY when at least one drawn bar actually uses
          // that phase — a chart with no queued bar shows no 'queued (beyond
          // slots)' swatch, one with no streamed bar shows neither waiting nor
          // generating, one with no whole-response bar drops the hatch. The
          // 'colour = agent · rows…' sentence below always stays.
          ...(() => {
            const swatch = 'var(--ui-accent)'
            const phases = lanePhasePresence(lanes)
            const items = []
            if (phases.waiting) {
              items.push(jsx('span', {
                className: 'inline-flex items-center gap-1',
                children: [
                  jsx('span', {
                    style: { width: '10px', height: '6px', background: swatch, opacity: 0.35 }
                  }),
                  jsx('span', { children: 'waiting for first token' })
                ]
              }))
            }
            if (phases.generating) {
              items.push(jsx('span', {
                className: 'inline-flex items-center gap-1',
                children: [
                  jsx('span', {
                    style: { width: '10px', height: '6px', background: swatch, opacity: 0.9 }
                  }),
                  jsx('span', { children: 'generating' })
                ]
              }))
            }
            if (phases.whole) {
              items.push(jsx('span', {
                className: 'inline-flex items-center gap-1',
                children: [
                  jsx('span', {
                    style: {
                      width: '10px', height: '6px', opacity: 0.6,
                      background: `repeating-linear-gradient(135deg, ${swatch} 0 1px, transparent 1px 3px)`
                    }
                  }),
                  jsx('span', { children: 'not streamed (whole response)' })
                ]
              }))
            }
            if (phases.queued) {
              items.push(jsx('span', {
                className: 'inline-flex items-center gap-1',
                children: [
                  jsx('span', {
                    style: {
                      width: '10px', height: '6px',
                      border: `1px dashed ${swatch}`, boxSizing: 'border-box'
                    }
                  }),
                  jsx('span', { children: 'queued (beyond slots)' })
                ]
              }))
            }
            return items
          })(),
          jsx('span', {
            className: 'font-medium',
            children: 'colour = agent · rows = requests running at the same time'
          }),
          // The buckets line appears only when a lane actually fell back to it.
          lanes.some(lane => lane.ticks)
            ? jsx('span', { children: 'cloud lane = 15 s request buckets, no per-request rows' })
            : null,
          legend.map(entry =>
            jsxs('span', {
              className: 'inline-flex items-center gap-1',
              children: [
                jsx('span', {
                  className: 'rounded-full',
                  style: { width: '6px', height: '6px', background: entry.color }
                }),
                jsx('span', { children: entry.label })
              ]
            }, entry.key)
          ),
          legend.length >= 8
            ? jsx('span', { children: '+more agents' })
            : null
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// By agent — profile → session → subagents and cron runs.

function modelTone(laneId) {
  const text = String(laneId || '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 997
  return AGENT_PALETTE[hash % AGENT_PALETTE.length]
}

function aggregateModels(rows) {
  const byLane = new Map()
  for (const row of rows || []) {
    for (const model of row.models || []) {
      const existing = byLane.get(model.lane_id)
      if (!existing) {
        byLane.set(model.lane_id, { ...model })
        continue
      }
      existing.requests += model.requests || 0
      existing.in_flight += model.in_flight || 0
      existing.tokens_in += model.tokens_in || 0
      existing.tokens_out += model.tokens_out || 0
      existing.cached_tokens += model.cached_tokens || 0
    }
  }
  return [...byLane.values()].sort((a, b) => (b.requests || 0) - (a.requests || 0))
}

const AGENT_COLUMNS = [
  { key: 'flight', label: 'flight', width: 64 },
  { key: 'req', label: 'req', width: 56 },
  { key: 'tokens', label: 'tok in/out', width: 112 },
  { key: 'lat', label: 'lat', width: 48 },
  { key: 'ttft', label: 'ttft', width: 48 },
  { key: 'err', label: 'err', width: 32 }
]
const MIX_WIDTH = 96

// Fixed widths live in inline styles, not Tailwind classes: the desktop CSS
// bundle does not compile plugin.js, so w-16 / w-12 / h-1.5 / lg:inline-flex
// silently render nothing — which is why the chips and columns were invisible.
function colStyle(width, extra) {
  return {
    width: `${width}px`,
    flex: '0 0 auto',
    textAlign: 'right',
    fontSize: '0.6rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--ui-text-secondary)',
    ...extra
  }
}

function modelDotStyle(model) {
  return {
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    flex: '0 0 auto',
    background: model.local ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)'
  }
}

function cachedPctOf(node) {
  return node.tokens_in ? Math.round(((node.cached_tokens || 0) / node.tokens_in) * 100) : null
}

function tokenColText(node) {
  const pct = cachedPctOf(node)
  return `${fmtTokens(node.tokens_in)}/${fmtTokens(node.tokens_out)}${pct != null ? ` (${pct}%)` : ''}`
}

// One indented sub-row per model an agent used in the window: a local/cloud
// dot, the lane label, and the model's own columns. Per-model latency, TTFT and
// errors come from the snapshot's model entries (null renders as "—"), using the
// same formatters, data-col names and widths as the parent agent row.
function ModelSubRow({ model, now, depth }) {
  const inFlight = model.in_flight || 0
  return jsxs('div', {
    'data-model-row': model.lane_id || model.label || 'model',
    className: 'flex items-center gap-2',
    style: {
      marginLeft: `${depth ? 20 : 12}px`,
      paddingLeft: '8px',
      paddingRight: '8px',
      paddingTop: '1px',
      paddingBottom: '1px',
      borderLeft: '1px solid var(--ui-stroke-secondary)',
      fontSize: '0.6rem'
    },
    children: [
      jsx('span', {
        style: modelDotStyle(model),
        title: model.local ? 'local model server' : 'cloud provider'
      }),
      jsx('span', {
        className: 'min-w-0 flex-1 truncate',
        style: {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--ui-text-secondary)'
        },
        title: `${model.label} · ${model.local ? 'local' : 'cloud'}`,
        children: model.label
      }),
      jsx('span', {
        'data-col': 'flight',
        className: cn(inFlight > 0 && 'animate-pulse'),
        style: colStyle(64, inFlight > 0 ? { color: 'var(--ui-accent)', fontWeight: 600 } : null),
        title: 'in flight',
        children: inFlight ? String(inFlight) : '—'
      }),
      jsx('span', {
        'data-col': 'req',
        style: colStyle(56),
        title: 'requests in the window',
        children: `${fmtInt(model.requests)} req`
      }),
      jsx('span', {
        'data-col': 'tokens',
        style: colStyle(112),
        title: 'tokens in / out (cached %)',
        children: tokenColText(model)
      }),
      jsx('span', {
        'data-col': 'lat',
        style: colStyle(48),
        title: 'latency p50',
        children: fmtMs(model.latency_ms_p50)
      }),
      jsx('span', {
        'data-col': 'ttft',
        style: colStyle(48),
        title: 'TTFT p50',
        children: fmtMs(model.ttft_ms_p50)
      }),
      jsx('span', {
        'data-col': 'err',
        style: colStyle(32, {
          color: (model.errors_5m || 0) > 0 ? 'var(--ui-destructive)' : 'var(--ui-text-quaternary)'
        }),
        title: 'errors in the window',
        children: fmtInt(model.errors_5m)
      })
    ]
  })
}

function ModelMixBar({ models }) {
  const total = (models || []).reduce((sum, model) => sum + (model.requests || 0), 0)
  if (!total) return null
  return jsx('div', {
    className: 'flex shrink-0 overflow-hidden rounded-full',
    style: { width: `${MIX_WIDTH}px`, height: '6px', background: 'var(--ui-bg-tertiary)' },
    title: models.map(model => `${model.label}: ${model.requests}`).join(' · '),
    children: models.map(model =>
      jsx('span', {
        style: {
          width: `${((model.requests || 0) / total) * 100}%`,
          background: modelTone(model.lane_id)
        }
      }, model.lane_id)
    )
  })
}

// An agent row keeps only its totals across models; one model sub-row per model
// sits under it, so two models never read as two chips for one agent.
function AgentRow({ row, labels, now, depth }) {
  const inFlight = row.in_flight || 0
  const elapsed = inFlight ? elapsedOf(row.oldest_started_at, now) : null
  const models = Array.isArray(row.models) ? row.models : []
  const label = agentLabel(row, labels)
  // Row's own source from state.db first, session.list as fallback.
  const source = rowSource(row) || (sessionMeta(labels, row.session_id) || {}).source || ''
  // A stored session opens core-style through the SDK; subagent rows keep their
  // own label (their stored row is not a chat the user opened).
  const openable = row.kind !== 'subagent' && !!row.session_id && typeof host.openSession === 'function'
  const open = openable
    ? () => {
        try {
          host.openSession(row.session_id, { profile: row.profile })
        } catch {
          // A stale id leaves the row inert; the label still reads.
        }
      }
    : undefined
  const activity = row.kind === 'subagent' ? '' : sessionActivity(row, labels, now)
  return jsxs('div', {
    'data-agent-row': row.session_id || row.profile || 'agent',
    className: 'flex flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        onClick: open,
        role: open ? 'button' : undefined,
        title: open ? `Open ${row.session_id}` : undefined,
        style: {
          paddingLeft: `${depth ? 24 : 8}px`,
          paddingRight: '8px',
          paddingTop: '2px',
          paddingBottom: '2px',
          borderRadius: '4px',
          fontSize: '0.75rem',
          cursor: open ? 'pointer' : 'default',
          background: inFlight > 0 ? 'var(--ui-row-hover-background)' : 'transparent'
        },
        children: [
          jsx(StatusDot, {
            tone: inFlight > 0 ? 'good' : 'muted',
            className: cn('size-2 shrink-0', inFlight > 0 && 'animate-pulse')
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate',
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              // Root rows (session / cron) read bold whatever their kind;
              // subagent rows keep the lighter weight of the tree's second level.
              fontWeight: depth ? 400 : 600,
              color: inFlight > 0 ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)'
            },
            title: row.kind === 'subagent' && row.goal ? `${label} — goal: ${row.goal}` : (row.session_id ? `${label} — ${row.session_id}` : label),
            children: label
          }),
          row.kind === 'subagent' || row.kind === 'cron'
            ? jsx(Badge, { variant: 'outline', size: 'xs', children: row.kind })
            : source
              ? jsx(Badge, { variant: 'outline', size: 'xs', children: source })
              : null,
          routedChip(row),
          jsx(ModelMixBar, { models }),
          jsx('span', {
            'data-col': 'flight',
            style: colStyle(64),
            title: 'in flight · elapsed of the oldest in-flight request',
            children: inFlight ? `${inFlight} · ${elapsed || '—'}` : '—'
          }),
          jsx('span', {
            'data-col': 'req',
            style: colStyle(56),
            title: 'requests in the window',
            children: `${fmtInt(row.requests_5m)} req`
          }),
          jsx('span', {
            'data-col': 'tokens',
            style: colStyle(112),
            title: 'tokens in / out (cached %)',
            children: tokenColText(row)
          }),
          jsx('span', {
            'data-col': 'lat',
            style: colStyle(48),
            title: 'latency p50',
            children: fmtMs(row.latency_ms_p50)
          }),
          jsx('span', {
            'data-col': 'ttft',
            style: colStyle(48),
            title: 'TTFT p50',
            children: fmtMs(row.ttft_ms_p50)
          }),
          jsx('span', {
            'data-col': 'err',
            style: colStyle(32, {
              color: (row.errors_5m || 0) > 0 ? 'var(--ui-destructive)' : 'var(--ui-text-quaternary)'
            }),
            title: 'errors in the window',
            children: fmtInt(row.errors_5m)
          })
        ]
      }),
      activity
        ? jsx('span', {
            'data-session-meta': row.session_id,
            style: {
              paddingLeft: `${depth ? 24 : 8}px`,
              paddingRight: '8px',
              fontSize: '0.625rem',
              color: 'var(--ui-text-quaternary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            },
            title: row.session_id,
            children: activity
          })
        : null,
      models.map(model => jsx(ModelSubRow, { model, now, depth: true }, model.lane_id))
    ]
  })
}

function AgentTree({ agents, labels, now }) {
  const groups = useMemo(() => {
    const roots = agents.filter(row => !row.parent_session_id)
    const byProfile = new Map()
    for (const root of roots) {
      if (!byProfile.has(root.profile)) byProfile.set(root.profile, [])
      byProfile.get(root.profile).push(root)
    }
    for (const rows of byProfile.values()) {
      rows.sort((a, b) => (b.in_flight || 0) - (a.in_flight || 0) || (b.requests_5m || 0) - (a.requests_5m || 0))
    }
    return [...byProfile.entries()]
  }, [agents])

  if (!agents.length) {
    return jsx(EmptyState, {
      title: 'No model traffic in the last 5 minutes.',
      description: 'Rows appear the moment an agent starts talking to a model.',
      className: 'py-10'
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        style: {
          paddingLeft: '8px',
          paddingRight: '8px',
          fontSize: '0.55rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--ui-text-quaternary)'
        },
        children: [
          jsx('span', { className: 'min-w-0 flex-1', children: 'agent' }),
          jsx('span', {
            style: { width: `${MIX_WIDTH}px`, flex: '0 0 auto', textAlign: 'right' },
            title: 'Share of this row\'s requests per model. Each model lane is assigned one colour from a fixed 8-colour palette by hashing its lane id, so the same model keeps the same colour in every row; segment width is that model\'s share of the row\'s requests.',
            children: 'mix'
          }),
          ...AGENT_COLUMNS.map(col =>
            jsx('span', {
              style: { width: `${col.width}px`, flex: '0 0 auto', textAlign: 'right' },
              children: col.label
            }, col.key)
          )
        ]
      }),
      ...groups.map(([profile, roots]) => {
        const inFlight = roots.reduce((sum, row) => sum + (row.in_flight || 0), 0)
        const requests = roots.reduce((sum, row) => sum + (row.requests_5m || 0), 0)
        const tokensIn = roots.reduce((sum, row) => sum + (row.tokens_in || 0), 0)
        const tokensOut = roots.reduce((sum, row) => sum + (row.tokens_out || 0), 0)
        const cachedTokens = roots.reduce((sum, row) => sum + (row.cached_tokens || 0), 0)
        const models = aggregateModels(roots)
        const totals = { in_flight: inFlight, requests_5m: requests, tokens_in: tokensIn, tokens_out: tokensOut, cached_tokens: cachedTokens }
        return jsxs(
          'section',
          {
            className: 'flex flex-col gap-1',
            children: [
              jsxs('div', {
                'data-agent-row': `profile:${profile}`,
                className: 'flex flex-col',
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2',
                    style: {
                      paddingLeft: '8px',
                      paddingRight: '8px',
                      paddingTop: '2px',
                      paddingBottom: '2px',
                      fontSize: '0.75rem'
                    },
                    children: [
                      jsx('span', {
                        className: 'rounded-full',
                        style: { width: '8px', height: '8px', flex: '0 0 auto', background: profileTone(profile) }
                      }),
                      jsx('span', {
                        className: 'min-w-0 flex-1 truncate',
                        style: {
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 600,
                          color: 'var(--ui-text-primary)'
                        },
                        title: `${profile} · ${plural(roots.length, 'session')}`,
                        children: `${profile} · ${plural(roots.length, 'session')}`
                      }),
                      jsx(ModelMixBar, { models }),
                      jsx('span', {
                        'data-col': 'flight',
                        style: colStyle(64),
                        title: 'in flight across every session',
                        children: inFlight ? String(inFlight) : '—'
                      }),
                      jsx('span', {
                        'data-col': 'req',
                        style: colStyle(56),
                        title: 'requests in the window',
                        children: `${fmtInt(requests)} req`
                      }),
                      jsx('span', {
                        'data-col': 'tokens',
                        style: colStyle(112),
                        title: 'tokens in / out (cached %)',
                        children: tokenColText(totals)
                      }),
                      jsx('span', {
                        'data-col': 'lat',
                        style: colStyle(48),
                        title: 'latency p50',
                        children: '—'
                      }),
                      jsx('span', {
                        'data-col': 'ttft',
                        style: colStyle(48),
                        title: 'TTFT p50',
                        children: '—'
                      }),
                      jsx('span', {
                        'data-col': 'err',
                        style: colStyle(32),
                        title: 'errors in the window',
                        children: fmtInt(roots.reduce((sum, row) => sum + (row.errors_5m || 0), 0))
                      })
                    ]
                  }),
                  models.map(model => jsx(ModelSubRow, { model, now, depth: true }, `profile-${model.lane_id}`))
                ]
              }),
              roots.map(root =>
                jsxs(
                  'div',
                  {
                    className: 'flex flex-col gap-1',
                    children: [
                      jsx(AgentRow, { row: root, labels, now }),
                      (root.children || []).map(child =>
                        jsx(AgentRow, { row: child, labels, now, depth: true }, `${root.session_id}-${child.session_id}`)
                      )
                    ]
                  },
                  root.session_id
                )
              )
            ]
          },
          profile
        )
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// Routing (CAPACITY.md §9): the placement chip on a subagent row and the strip
// at the top of By model.  The snapshot carries no `state` field: armed, blocked
// by a backend, off and unavailable are the four real answers.

function routingState(routing) {
  if (!routing || typeof routing !== 'object') {
    return {
      label: 'unavailable',
      tone: 'muted',
      title: 'No routing block in this snapshot: capacity routing needs a Flightdeck build with capacity.py.'
    }
  }
  if (routing.armed) {
    const lanes = Array.isArray(routing.eligible_lanes) ? routing.eligible_lanes : []
    return {
      label: 'armed',
      tone: 'outline',
      title: lanes.length
        ? `Routing is armed: delegate_task spills to ${lanes.length} eligible local lane${lanes.length === 1 ? '' : 's'} (${lanes.map(lane => lane.name || lane.base_url).join(', ')}).`
        : 'Routing is armed: delegate_task spills to a local lane with free slots.'
    }
  }
  if (routing.blocked_by) {
    return {
      label: `blocked by ${routing.blocked_by}`,
      tone: 'warn',
      title: routing.message ||
        `Routing is blocked by ${routing.blocked_by}. Switch with \`/delegation flightdeck --now\`.`
    }
  }
  return {
    label: 'off',
    tone: 'muted',
    title: 'Routing is off. Enable it in Settings → Plugins → Flightdeck (route_delegation), then switch with `/delegation flightdeck --now` (or `hermes config set delegation.backend flightdeck`).'
  }
}

// A goal is often a whole brief path: the strip shows its first line, clipped,
// and the full goal rides in the row's tooltip.
function goalSnippet(goal) {
  const text = String(goal || '').split('\n')[0].trim()
  if (!text) return ''
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

function decisionTooltip(decision) {
  return [
    `${decision.action || 'skip'} ${decision.requested_lane || '—'} → ${decision.chosen_lane || 'unrouted'}`,
    decision.reason,
    decision.chosen_model ? `model: ${decision.chosen_model}` : null,
    decision.goal ? `goal: ${decision.goal}` : null
  ].filter(Boolean).join(' · ')
}

// The last five placements, one line each: time, from → to, reason, goal.
function RoutingStrip({ snapshot, now }) {
  const state = routingState(snapshot.routing)
  const decisions = (Array.isArray(snapshot.decisions) ? snapshot.decisions : []).slice(0, 5)
  return jsxs('div', {
    'data-routing-strip': state.label,
    className: 'flex flex-col gap-1 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        title: state.title,
        children: [
          jsx('span', {
            className: 'text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-tertiary)',
            children: 'Routing'
          }),
          jsx(Badge, { variant: state.tone, size: 'xs', title: state.title, children: state.label }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.625rem] text-(--ui-text-quaternary)',
            children: decisions.length
              ? `last ${decisions.length} placement${decisions.length === 1 ? '' : 's'}`
              : 'no placements in the retention window'
          })
        ]
      }),
      decisions.length
        ? jsx('div', {
            className: 'flex flex-col gap-0.5',
            children: decisions.map((decision, index) => jsxs('div', {
              'data-decision': index,
              className: 'flex items-baseline gap-2 text-[0.625rem]',
              title: decisionTooltip(decision),
              children: [
                jsx('span', {
                  className: 'shrink-0 tabular-nums text-(--ui-text-quaternary)',
                  children: fmtAgo(decision.decided_at, now)
                }),
                jsx('span', {
                  className: 'shrink-0 font-mono',
                  children: `${decision.requested_lane || '—'} → ${decision.chosen_lane || 'unrouted'}`
                }),
                jsx('span', {
                  className: 'min-w-0 flex-1 truncate text-(--ui-text-secondary)',
                  children: decision.reason || '—'
                }),
                jsx('span', {
                  className: 'min-w-0 flex-1 truncate text-(--ui-text-quaternary)',
                  children: goalSnippet(decision.goal)
                })
              ]
            }, `decision-${index}`))
          })
        : null
    ]
  })
}

// A subagent row's placement: the lane it actually ran on, the full reason in
// the tooltip.  Only rows the store matched to a decision carry `routed`.
function routedChip(row) {
  const routed = row && row.routed
  if (!routed) return null
  const action = routed.action || 'skip'
  const lane = routed.lane || routed.requested_lane || '—'
  const reason = routed.reason || ''
  const text = action === 'move'
    ? `routed → ${lane}${reason ? ` (${reason})` : ''}`
    : action === 'stay'
      ? `stay ${lane}${reason ? ` (${reason})` : ''}`
      : `unrouted${reason ? ` (${reason})` : ''}`
  const title = [
    reason,
    routed.model ? `model: ${routed.model}` : null,
    row.goal ? `goal: ${row.goal}` : null
  ].filter(Boolean).join(' · ')
  return jsxs('span', {
    'data-routed': lane,
    className: 'inline-flex shrink-0',
    title: title || text,
    children: [jsx(Badge, {
      variant: action === 'move' ? 'outline' : 'muted',
      size: 'xs',
      children: text
    })]
  })
}

// ---------------------------------------------------------------------------
// Page.

// The snapshot's own reason for an empty page, in the same vocabulary the
// backend uses (api._empty_reason). Only trusted when there is nothing to show.
const EMPTY_REASON_TEXT = {
  no_servers_configured: 'No model servers configured. Add servers in Settings → Plugins → Flightdeck, or turn on demo_mode to see sample data.',
  servers_unreachable: 'Configured servers are not reachable.',
  no_traffic: 'No model traffic yet. Rows appear the moment an agent talks to a model.'
}

function ModelView({ snapshot, labels, now, windowSeconds, onHide }) {
  // A declared cloud endpoint is a lane, not a local server: it has no gauge
  // and belongs in the cloud cards, never in the local capacity section.
  const servers = (Array.isArray(snapshot.servers) ? snapshot.servers : []).filter(
    server => server && server.kind !== 'cloud'
  )
  const models = Array.isArray(snapshot.models) ? snapshot.models : []
  const unreachable = Array.isArray(snapshot.unreachable) ? snapshot.unreachable : []
  // "Hidden means hidden everywhere": the same hidden_servers filter the idle
  // group uses (entries match by name or normalized base_url) drops a dead
  // server from this list and from its count. A row can also arrive already
  // flagged `hidden` from the backend.
  const hiddenServers = Array.isArray(snapshot.hidden_servers) ? snapshot.hidden_servers : []
  const hiddenKeys = hiddenServers.map(entry => String(entry || '').trim().toLowerCase()).filter(Boolean)
  const normalizeUrlKey = url => {
    let text = String(url || '').trim().toLowerCase().replace(/\/+$/, '')
    if (text.endsWith('/v1')) text = text.slice(0, -3).replace(/\/+$/, '')
    return text
  }
  const visibleUnreachable = unreachable.filter(item => {
    if (!item || item.hidden) return false
    const name = String(item.name || '').trim().toLowerCase()
    const url = normalizeUrlKey(item.base_url)
    return !hiddenKeys.some(entry =>
      (name && entry === name) || (url && normalizeUrlKey(entry) === url))
  })
  const idle = Array.isArray(snapshot.idle) ? snapshot.idle : []
  const source = snapshot.servers_source || 'none'
  const cloud = models.filter(model => model.lane === 'cloud')
  const orphan = models.filter(model => model.lane !== 'cloud' &&
    (model.metrics === 'none' || !model.server_name))
  const queued = servers.reduce((sum, server) => sum + (server.waiting || 0), 0)
  const used = servers.reduce((sum, server) => sum + (server.running || 0), 0)
  const total = servers.reduce((sum, server) => sum + (server.slots || 0), 0)
  // One honest sentence for "no cards": servers configured but dead, discovery
  // on and empty, or nothing declared at all — never "add one" while discovery
  // is already looking.
  const noServersText = servers.length
    ? null
    : unreachable.length
      ? `${unreachable.length} local server${unreachable.length === 1 ? '' : 's'} configured, none reachable`
      : source === 'discovered'
        ? "No local model servers found in any profile's providers. Declare one under Settings → Plugins → Flightdeck."
        : 'No local model server declared. Add one under Settings → Plugins → Flightdeck.'

  if (!servers.length && !models.length) {
    // Name the reason the backend gave for the empty page, when it still
    // matches the board (agents/servers arrived since the snapshot → generic copy).
    const reason = EMPTY_REASON_TEXT[snapshot && snapshot.empty_reason]
    const stillEmpty = !servers.length && !(snapshot && (snapshot.agents || []).length)
    return jsx(EmptyState, {
      title: unreachable.length
        ? 'No local servers reachable.'
        : source === 'discovered'
          ? 'No local model servers found.'
          : 'No model traffic in the last 5 minutes.',
      description: (reason && stillEmpty) ? reason
        : (noServersText || 'Declare a model server in Settings → Plugins, or start a session that calls a model.'),
      className: 'py-10'
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-4',
    children: [
      jsx(RoutingStrip, { snapshot, now }),
      jsx(Section, {
        label: 'Local servers',
        meta: servers.length
          ? `${servers.length} server${servers.length === 1 ? '' : 's'} · ${used}/${total} slots · ${queued} queued`
          : 'none reachable',
        children: jsxs('div', {
          className: 'flex flex-col gap-2',
          children: [
            servers.length
              ? jsx('div', {
                  className: 'grid gap-2 xl:grid-cols-2',
                  children: servers.map(server => jsx(ServerCard, { server, models, labels, now }, server.base_url || server.name))
                })
              : jsx('div', {
                  className: 'rounded-lg border border-dashed border-(--ui-stroke-secondary) px-3 py-4 text-[0.75rem] text-(--ui-text-quaternary)',
                  children: noServersText
                }),
            visibleUnreachable.length
              ? jsxs('details', {
                  'data-unreachable-group': visibleUnreachable.length,
                  className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                  children: [
                    jsx('summary', {
                      className: 'cursor-pointer select-none',
                      children: `${visibleUnreachable.length} server${visibleUnreachable.length === 1 ? '' : 's'} unreachable`
                    }),
                    jsx('div', {
                      className: 'flex flex-col gap-0.5 pt-1',
                      children: visibleUnreachable.map(item => {
                        // One row, never wider than the container: the reason is
                        // the collapsed one-liner, the raw per-endpoint dump goes
                        // in the tooltip with one endpoint per line.
                        const base = String(item.base_url || '')
                        const hostPort = base.replace(/^https?:\/\//, '').replace(/\/+$/, '')
                        const down = item.since != null
                          ? `down ${fmtDuration(Math.max(0, now / 1000 - item.since))}`
                          : null
                        return jsxs('div', {
                          'data-unreachable-row': item.base_url || item.name,
                          title: unreachableTooltip(item.error),
                          className: 'flex min-w-0 items-center gap-2',
                          children: [
                            jsx(StatusDot, { tone: 'bad', className: 'size-2 shrink-0' }),
                            jsx('span', {
                              className: 'min-w-0 flex-1 flex items-center gap-2',
                              style: { minWidth: 0, overflow: 'hidden' },
                              children: jsxs('span', {
                                className: 'min-w-0 truncate',
                                style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                                children: [
                                  jsx('span', {
                                    className: 'font-semibold text-(--ui-text-primary)',
                                    children: item.name || hostPort || 'server'
                                  }),
                                  hostPort
                                    ? jsx('span', {
                                        className: 'ml-2 font-mono text-[0.6rem] text-(--ui-text-quaternary)',
                                        children: hostPort
                                      })
                                    : null,
                                  jsx('span', {
                                    className: 'ml-2',
                                    children: unreachableReason(item.error)
                                  }),
                                  down
                                    ? jsx('span', {
                                        className: 'ml-2 tabular-nums text-(--ui-text-tertiary)',
                                        children: down
                                      })
                                    : null
                                ]
                              })
                            }),
                            onHide
                              ? jsx(Button, {
                                  variant: 'ghost',
                                  size: 'xs',
                                  'data-hide-unreachable': item.base_url || item.name,
                                  title: `Hide ${item.name || item.base_url} from every Flightdeck view`,
                                  onClick: () => onHide(item),
                                  children: 'hide'
                                })
                              : null
                          ]
                        }, item.base_url || item.name)
                      })
                    })
                  ]
                })
              : null,
            idle.length
              ? jsxs('details', {
                  className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                  children: [
                    jsx('summary', {
                      className: 'cursor-pointer select-none',
                      children: `Idle · not used by Hermes (${idle.length})`
                    }),
                    jsx('div', {
                      className: 'flex flex-col gap-0.5 pt-1',
                      children: idle.map(item =>
                        jsxs('div', {
                          className: 'flex items-baseline gap-2',
                          children: [
                            jsx('span', {
                              className: 'min-w-0 truncate font-mono text-[0.6rem]',
                              children: item.name || item.base_url
                            }),
                            jsx('span', {
                              className: 'min-w-0 flex-1 truncate font-mono text-[0.55rem]',
                              children: item.base_url
                            }),
                            onHide
                              ? jsx(Button, {
                                  variant: 'ghost',
                                  size: 'xs',
                                  title: `Hide ${item.name || item.base_url} from every Flightdeck view`,
                                  onClick: () => onHide(item),
                                  children: 'hide'
                                })
                              : null
                          ]
                        }, item.base_url || item.name)
                      )
                    })
                  ]
                })
              : null
          ]
        })
      }),
      servers.length || cloud.length
        ? jsx(Section, {
            label: 'Swim lane',
            meta: `last ${fmtDuration(windowSeconds)} · local lanes first, then cloud`,
            children: jsx(SwimLane, { snapshot, labels, windowSeconds, now })
          })
        : null,
      cloud.length
        ? jsx(Section, {
            label: 'Cloud lanes',
            meta: 'Hermes traffic only — hook rows, no server gauge',
            children: jsx('div', {
              className: 'grid gap-2 xl:grid-cols-2',
              children: cloud.map(model => jsx(CloudCard, { model, labels, now, windowSeconds, snapshot }, model.key))
            })
          })
        : null,
      orphan.length
        ? jsx(Section, {
            label: 'Local · no server metrics',
            meta: 'private base_url with no server card',
            children: jsx('div', {
              className: 'grid gap-2 xl:grid-cols-2',
              children: orphan.map(model => jsx(NoServerCard, { model, labels, now }, model.key))
            })
          })
        : null
    ]
  })
}

function AgentView({ snapshot, labels, now, windowSeconds }) {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
  return jsx(Section, {
    label: 'Agent tree',
    meta: `profile → session → subagents and cron runs · last ${fmtDuration(windowSeconds)}`,
    children: jsx(AgentTree, { agents, labels, now })
  })
}

function FlightdeckPage() {
  const view = useValue($view)
  const windowSeconds = Number(useValue($window))
  const now = useNow(1000)
  const snapshotQ = useSnapshot(windowSeconds)
  const snapshot = snapshotQ.data
  const profiles = useMemo(
    () => [...new Set((snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : []).map(row => row.profile))],
    [snapshot]
  )
  const labelQ = useSessionLabels(profiles)
  const labels = labelQ.data || {}
  const totals = (snapshot && snapshot.totals) || {}
  const reachableServers = snapshot && Array.isArray(snapshot.servers)
    ? snapshot.servers.filter(server => server && !server.error).length
    : 0
  const [hideError, setHideError] = useState(null)

  // Hide an idle server everywhere: append its base_url to the plugin setting
  // through the gateway's plugins.manage settings write, then refetch.
  const hideServer = async item => {
    const current = snapshot && Array.isArray(snapshot.hidden_servers) ? snapshot.hidden_servers : []
    const target = item.base_url || item.name
    const next = current.includes(target) ? current : [...current, target]
    try {
      await host.request('plugins.manage', {
        action: 'settings',
        key: 'flightdeck',
        values: { hidden_servers: next }
      })
      setHideError(null)
      snapshotQ.refetch()
    } catch (err) {
      setHideError(`Could not hide ${item.name || target}: ${err && err.message ? err.message : 'settings write failed'}`)
    }
  }

  const header = jsxs('div', {
    className: 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--ui-stroke-secondary) px-3 py-2',
    children: [
      jsx(Codicon, { name: 'pulse', size: 14, className: 'text-(--ui-accent)' }),
      jsx('h1', {
        className: 'text-[0.8125rem] font-semibold tracking-tight text-(--ui-text-primary)',
        children: 'Flightdeck'
      }),
      jsx('span', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
        children: 'live air-traffic control'
      }),
      // Seeded-sample-data marker: without it a demo snapshot reads as real
      // traffic on a machine that has none.
      snapshot && snapshot.demo
        ? jsx(Badge, {
            variant: 'muted',
            size: 'xs',
            title: 'Seeded sample data — turn off demo_mode in Settings → Plugins → Flightdeck',
            children: 'demo data'
          })
        : null,
      jsxs('div', {
        className: 'ml-auto flex flex-wrap items-center gap-2 text-[0.6875rem]',
        children: [
          jsx(Stat, { label: 'in flight', value: totals.in_flight != null ? totals.in_flight : '—', tone: 'bg-(--ui-accent)' }),
          jsx(Stat, { label: 'req/min', value: totals.requests_1m != null ? totals.requests_1m : '—' }),
          jsx(Stat, { label: 'req/5m', value: totals.requests_5m != null ? totals.requests_5m : '—' }),
          totals.errors_5m > 0
            ? jsx(Stat, { label: 'errors', value: totals.errors_5m, tone: 'bg-destructive' })
            : null,
          jsx(SegmentedControl, {
            options: [
              { id: 'model', label: 'By model' },
              { id: 'agent', label: 'By agent' }
            ],
            value: view,
            onChange: id => $view.set(id),
            sizing: 'content'
          }),
          jsx(SegmentedControl, {
            options: [
              { id: '60', label: '1m' },
              { id: '300', label: '5m' }
            ],
            value: String(windowSeconds),
            onChange: id => $window.set(id),
            sizing: 'content'
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'icon-xs',
            onClick: () => snapshotQ.refetch(),
            'aria-label': 'Refresh Flightdeck',
            children: jsx(Codicon, {
              name: 'refresh',
              size: 13,
              spinning: snapshotQ.isFetching && !snapshotQ.isLoading
            })
          })
        ]
      })
    ]
  })

  const subheader = jsxs('div', {
    className: 'flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 text-[0.65rem] text-(--ui-text-quaternary)',
    children: [
      jsx('span', {
        children: snapshot ? `as of ${fmtAgo(snapshot.generated_at, now)}` : 'waiting for the backend'
      }),
      snapshot
        ? jsx('span', {
            children: `· ${plural(reachableServers, 'server')} · ${plural(snapshot.models ? snapshot.models.length : 0, 'lane')} · ${plural(snapshot.agents ? snapshot.agents.length : 0, 'session')}`
          })
        : null,
      jsx('span', {
        children: `· window ${fmtDuration(windowSeconds)} · polls every ${POLL_MS / 1000}s`
      }),
      hideError
        ? jsx('span', { className: 'text-(--ui-destructive)', children: hideError })
        : null
    ]
  })

  let body
  if (snapshotQ.isError) {
    body = jsx('div', {
      className: 'p-6',
      children: jsx(ErrorState, {
        title: 'Flightdeck backend unavailable',
        description: 'The plugin API is not answering. Enable Flightdeck in config.yaml and restart the gateway, then retry.',
        children: jsx(Button, {
          variant: 'outline',
          size: 'sm',
          onClick: () => snapshotQ.refetch(),
          children: 'Retry'
        })
      })
    })
  } else if (!snapshot) {
    body = jsxs('div', {
      className: 'flex flex-col gap-2 p-3',
      children: [
        jsx(Skeleton, { className: 'h-24 w-full rounded-lg' }),
        jsx(Skeleton, { className: 'h-24 w-full rounded-lg' }),
        jsx(Skeleton, { className: 'h-40 w-full rounded-lg' })
      ]
    })
  } else {
    body = jsx('div', {
      className: 'flex flex-col gap-4 p-3',
      children:
        view === 'agent'
          ? jsx(AgentView, { snapshot, labels, now, windowSeconds })
          : jsx(ModelView, { snapshot, labels, now, windowSeconds, onHide: hideServer })
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [header, subheader, jsx(ScrollArea, { className: 'min-h-0 flex-1', children: body })]
  })
}

// ---------------------------------------------------------------------------
// Status chip — local servers only, at most three, then +N.

function FleetChip() {
  const serversQ = useServers()
  const data = serversQ.data
  if (data && data.show_chip === false) return null
  const servers = Array.isArray(data) ? data : (data && Array.isArray(data.servers) ? data.servers : [])
  const local = servers.filter(server => server && server.kind !== 'cloud' && server.healthy === true && !server.error)
  const navigate = () => host.navigate(ROUTE)

  if (!local.length) {
    const inFlight = data && data.totals ? data.totals.in_flight : null
    return jsxs('button', {
      type: 'button',
      onClick: navigate,
      className: 'inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
      children: [
        jsx(Codicon, { name: 'pulse', size: 11, className: 'text-(--ui-accent)' }),
        jsx('span', { children: inFlight != null ? `fleet ${inFlight} in flight` : 'fleet idle' })
      ]
    })
  }

  const shown = local.slice(0, 3)
  const extra = local.length - shown.length
  const queued = local.reduce((sum, server) => sum + (server.waiting || 0), 0)
  const parts = shown.map(server => `${server.name} ${server.running != null ? server.running : '—'}/${server.slots != null ? server.slots : '—'}`)
  if (extra > 0) parts.push(`+${extra}`)
  if (queued > 0) parts.push(`${queued} queued`)

  return jsxs('button', {
    type: 'button',
    onClick: navigate,
    title: 'Open Flightdeck',
    className: 'inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
    children: [
      jsx(Codicon, { name: 'pulse', size: 11, className: 'text-(--ui-accent)' }),
      jsx('span', { children: parts.join(' · ') })
    ]
  })
}

// ---------------------------------------------------------------------------

export default {
  id: ID,
  name: 'Flightdeck',
  register(ctx) {
    restRef = ctx.rest
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () => jsx(FlightdeckPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Flightdeck', codicon: 'pulse' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'flightdeck.open',
          label: 'Open Flightdeck',
          keywords: ['fleet', 'models', 'agents', 'capacity', 'servers', 'queue'],
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => jsx(FleetChip, {})
      }
    ])
  }
}
