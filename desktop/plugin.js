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

// Semantic accents. Fixed hues (or the host's own semantic vars) that read on
// a white panel and on a near-black one alike; text and surfaces stay on the
// host theme vars.
const TONE_LOCAL = 'var(--ui-green, #1f8a65)'
const TONE_CLOUD = 'hsl(214 82% 56%)'
const TONE_QUEUED = 'var(--ui-red, #cf2d56)'
const TONE_AMBER = 'hsl(36 92% 50%)'
// The prefill line/dot of a throughput sparkline: a graphic, not text, so the
// tertiary tint (≥3:1 on both themes) keeps it a step behind the decode line.
const PREFILL_TONE = 'var(--ui-text-tertiary)'

// A compact agent label for chips, the legend, HELD BY rows and the By agent
// name: a session's title, a cron's job, a subagent's goal — cut to its first
// clause and first four words, at most SHORT_LABEL_MAX characters. The full
// label (agentLabel) always rides in a tooltip.
const SHORT_LABEL_MAX = 30
const SHORT_LEAD_WORDS = new Set([
  'write', 'list', 'explain', 'describe', 'give', 'create', 'make', 'draft', 'produce',
  'generate', 'summarize', 'summarise', 'compose', 'implement', 'please', 'briefly', 'a', 'an', 'the'
])
const SHORT_STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'and', 'or', 'that', 'which', 'why', 'how', 'what', 'in',
  'on', 'with', 'by', 'as', 'at', 'from', 'into', 'about', 'is', 'are', '&', '-', '—'
])

function shortenPhrase(text, dropLead) {
  let s = String(text || '').replace(/\s+/g, ' ').trim().replace(/^subagent\s*[:·-]\s*/i, '')
  if (dropLead) s = s.replace(/^in (?:about |under |roughly |around )?\d+\s*words?,?\s*/i, '')
  const clause = s.split(/[.;!?](?:\s|$)|:\s|\s[—–-]\s|,\s|\(|\n/)[0].trim()
  let words = (clause.length >= 2 ? clause : s).split(' ').filter(Boolean)
  if (dropLead) {
    while (words.length > 1 && (SHORT_LEAD_WORDS.has(words[0].toLowerCase()) || /^\d+-words?$/i.test(words[0]))) {
      words.shift()
    }
  }
  words = words.slice(0, 4)
  const trimStops = list => {
    while (list.length > 1 && SHORT_STOP_WORDS.has(list[list.length - 1].toLowerCase())) list.pop()
    return list
  }
  trimStops(words)
  let out = words.join(' ')
  if (out.length > SHORT_LABEL_MAX) {
    const parts = out.split(' ')
    while (parts.length > 1 && parts.join(' ').length > SHORT_LABEL_MAX - 1) parts.pop()
    trimStops(parts)
    out = parts.join(' ')
    if (out.length > SHORT_LABEL_MAX - 1) out = out.slice(0, SHORT_LABEL_MAX - 1)
    out = `${out}…`
  }
  return out
}

function shortAgentLabel(row, labels) {
  if (!row) return 'unknown'
  const title = rowTitle(row) || sessionTitle(labels, row.session_id)
  if (row.kind === 'subagent') {
    const goal = row.goal || title
    return (goal && shortenPhrase(goal, true)) || 'subagent'
  }
  if (row.kind === 'cron') {
    const base = row.cron_job || title
    return (base && shortenPhrase(base, false)) || 'cron run'
  }
  if (title) return shortenPhrase(title, false) || String(title).slice(0, SHORT_LABEL_MAX)
  const id = String(row.session_id || '')
  return id ? `session ${id.slice(0, 8)}` : 'session'
}

// The long form for a tooltip: the full label, then the goal when the label
// does not already carry it.
function fullAgentText(row, labels) {
  // A subagent's stored title is usually an echo of its goal ('Subagent: Write
  // a …'); print the goal once, and the title only when it says something new.
  if (row && row.kind === 'subagent' && row.goal) {
    const role = !row.role || row.role === 'leaf' ? 'subagent' : row.role
    const goal = String(row.goal)
    const title = rowTitle(row) || sessionTitle(labels, row.session_id)
    const core = String(title || '').replace(/^subagent\s*[:·-]\s*/i, '').replace(/[….\s]+$/, '').trim()
    const echo = !core || goal.replace(/\s+/g, ' ').startsWith(core.replace(/\s+/g, ' '))
    return echo ? `${role} · ${goal}` : `${role} · ${goal} · ${title}`
  }
  const label = agentLabel(row, labels)
  return row && row.goal && !label.includes(row.goal) ? `${label} — goal: ${row.goal}` : label
}

// Small uppercase section kicker used inside cards.
function kickerStyle(extra) {
  return {
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--ui-text-secondary)',
    ...extra
  }
}

// A big tabular number over a small muted label: the one stat face used by the
// tooltip card, By agent rows and the cloud cards.
function BigStat({ value, label, tone, title, size, col, align, width }) {
  return jsxs('div', {
    'data-col': col || undefined,
    title: title || undefined,
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      minWidth: 0,
      width: width != null ? `${width}px` : undefined,
      flex: width != null ? '0 0 auto' : undefined
    },
    children: [
      jsx('span', {
        style: {
          fontSize: size || '1.05rem',
          fontWeight: 600,
          lineHeight: 1.15,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          color: tone || 'var(--ui-text-primary)'
        },
        children: value
      }),
      jsx('span', {
        style: {
          fontSize: '0.6rem',
          lineHeight: 1.3,
          whiteSpace: 'nowrap',
          color: 'var(--ui-text-secondary)'
        },
        children: label
      })
    ]
  })
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

// Live subscription usage comes from the public model.options RPC, not the
// backend snapshot: catalog rule, plugins may only use public surfaces. The
// backend fills model.quota in demo mode only. Fail-open: a failed fetch is an
// empty Map, so a cloud card simply renders no quota line.
//
// The provider's usage check can fail intermittently (the Claude Code CLI takes
// longer than its 8 s timeout) and a failed snapshot carries no windows. Keep
// the last good reading per provider for 15 minutes so the card shows the most
// recent real numbers, labelled with when they were read; older than that, show
// nothing rather than a stale number. Persist across plugin reloads.
const LAST_GOOD_USAGE_KEY = 'flightdeck.lastGoodUsage'
const LAST_GOOD_USAGE_MAX_AGE_MS = 15 * 60 * 1000

let lastGoodUsage = null

function usageHasNumericWindows(usage) {
  if (!usage || typeof usage !== 'object') return false
  const hasNumeric = windows => Array.isArray(windows) && windows.some(window =>
    window && typeof window === 'object' && Number.isFinite(window.used_percent))
  if (hasNumeric(usage.windows)) return true
  if (Array.isArray(usage.accounts)) {
    return usage.accounts.some(row => row && typeof row === 'object' && hasNumeric(row.windows))
  }
  return false
}

function loadLastGoodUsage() {
  if (lastGoodUsage) return lastGoodUsage
  const map = new Map()
  try {
    const raw = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(LAST_GOOD_USAGE_KEY)
      : null
    if (raw) {
      const parsed = JSON.parse(raw)
      const now = Date.now()
      for (const [slug, entry] of Object.entries(parsed || {})) {
        if (!entry || !entry.usage || !Number.isFinite(entry.seenAt)) continue
        if (now - entry.seenAt > LAST_GOOD_USAGE_MAX_AGE_MS) continue
        map.set(String(slug).toLowerCase(), { usage: entry.usage, seenAt: entry.seenAt })
      }
    }
  } catch {}
  lastGoodUsage = map
  return lastGoodUsage
}

function saveLastGoodUsage(map) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const payload = {}
    for (const [slug, entry] of map) payload[slug] = { usage: entry.usage, seenAt: entry.seenAt }
    window.localStorage.setItem(LAST_GOOD_USAGE_KEY, JSON.stringify(payload))
  } catch {}
}

// Merge one model.options response into the usage map. A provider row with
// numeric windows is a good reading: remember it and show it. A provider that
// comes back without usable usage falls back to its last good reading (with a
// stale_since marker) while that reading is under 15 minutes old; a fresh
// reading clears the marker. `nowMs` is injectable for tests.
function mergeProviderUsage(result, nowMs = Date.now(), failed = false) {
  const good = loadLastGoodUsage()
  const map = new Map()
  const status = new Map()
  const providers = result && Array.isArray(result.providers) ? result.providers : []
  let changed = false
  for (const provider of providers) {
    if (!provider || !provider.slug) continue
    const slug = String(provider.slug).toLowerCase()
    if (usageHasNumericWindows(provider.usage)) {
      const previous = good.get(slug)
      // Same cached response object: keep the original reading time, so the
      // label ages from the fetch, not from every render.
      if (!previous || previous.usage !== provider.usage) {
        good.set(slug, { usage: provider.usage, seenAt: nowMs })
        changed = true
      }
      map.set(slug, provider.usage)
      status.set(slug, { status: 'ok', lastCheckedAt: nowMs, rowPresent: true })
      continue
    }
    const entry = good.get(slug)
    if (entry && nowMs - entry.seenAt <= LAST_GOOD_USAGE_MAX_AGE_MS) {
      map.set(slug, { ...entry.usage, stale_since: entry.seenAt })
    }
    // The row answered, but with no numeric window: Hermes has the provider
    // and has not read its limits yet. A row with no usage key at all is the
    // same story when there is no prior reading to fall back on.
    const hasUsage = provider.usage && typeof provider.usage === 'object'
    status.set(slug, {
      status: hasUsage || !entry ? 'pending' : 'absent',
      lastCheckedAt: nowMs,
      rowPresent: true
    })
  }
  // A provider row can vanish entirely on a failed fetch; fall back for those
  // too, so a whole provider doesn't blink out of the card.
  for (const [slug, entry] of good) {
    if (map.has(slug)) continue
    if (nowMs - entry.seenAt <= LAST_GOOD_USAGE_MAX_AGE_MS) {
      map.set(slug, { ...entry.usage, stale_since: entry.seenAt })
    }
  }
  // Providers from the last good map that this response dropped: absent, and
  // no row present, so a provider that never reports usage stays clean.
  for (const slug of good.keys()) {
    if (status.has(slug)) continue
    status.set(slug, { status: 'absent', lastCheckedAt: nowMs, rowPresent: false })
  }
  if (failed) {
    for (const [slug, entry] of status) {
      status.set(slug, { ...entry, status: 'error', lastCheckedAt: nowMs })
    }
  }
  map.status = status
  map.lastCheckedAt = nowMs
  map.error = !!failed
  if (changed) saveLastGoodUsage(good)
  return map
}

function useProviderUsage() {
  const query = useQuery({
    queryKey: [ID, 'provider-usage'],
    queryFn: () => host.request('model.options', {}),
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1
  })
  return mergeProviderUsage(query && query.data, Date.now(), !!(query && query.isError))
}

// ProviderUsage -> PlanUsage's shape. A provider-wide gauge is `windows`; a
// multi-entry credential pool leaves it empty and carries `accounts` instead,
// so the first account with numeric windows stands in. A lone account gets no
// title: its label is a credential-pool id, not a human name, and a bare line
// under the gauge reads like a stray token. Several accounts get a titled line
// only when the label is human; internal ids fall back to 'account N of M'. No
// numeric window anywhere means no quota line, never a fake gauge.
function providerUsageToQuota(usage) {
  if (!usage || typeof usage !== 'object') return null
  const toWindows = windows => (Array.isArray(windows) ? windows : [])
    .filter(window => window && typeof window === 'object')
    .map(window => {
      const used = Number.isFinite(window.used_percent) ? window.used_percent : null
      const resetMs = window.resets_at ? Date.parse(window.resets_at) : NaN
      return {
        label: window.label || '',
        used_percent: used,
        remaining_percent: used == null ? null : 100 - used,
        reset_at: Number.isFinite(resetMs) ? resetMs / 1000 : null,
        detail: window.scope === 'model' ? 'model-specific cap' : null
      }
    })
  let windows = toWindows(usage.windows)
  let title = null
  if (!windows.length && Array.isArray(usage.accounts)) {
    const accounts = usage.accounts.filter(row => row && typeof row === 'object')
    const index = accounts.findIndex(row => Array.isArray(row.windows) && row.windows.length)
    if (index >= 0) {
      const account = accounts[index]
      windows = toWindows(account.windows)
      if (accounts.length > 1) {
        const label = account.label == null ? '' : String(account.label).trim()
        const internal = !label || /^[a-z0-9]+(-[a-z0-9]+)*-\d+$/i.test(label) || /oauth/i.test(label)
        title = internal ? `account ${index + 1} of ${accounts.length}` : `account: ${label}`
      }
    }
  }
  if (!windows.some(window => Number.isFinite(window.used_percent))) return null
  // A stale reading carries when it was actually read, so PlanUsage can label
  // its age instead of passing old numbers off as current.
  const asOf = Number.isFinite(usage.stale_since) ? usage.stale_since / 1000 : null
  return { title, windows, as_of: asOf }
}

// Two cloud cards can report one subscription plan (the API lane and the
// subscription-direct lane). Their numbers match even though the two sources
// report the reset a minute apart (6:59 vs 7:00), so a fingerprint rounds the
// reset to five minutes and the used percent to a whole number. Only
// account-scope windows count: a model-specific cap is a per-model extra, not
// the plan itself. Null means no numeric account window — never group on it.
function planFingerprint(quota) {
  if (!quota || typeof quota !== 'object' || !Array.isArray(quota.windows)) return null
  const tokens = quota.windows
    .filter(window => window && typeof window === 'object')
    .filter(window => Number.isFinite(window.used_percent))
    .filter(window => window.detail !== 'model-specific cap')
    .map(window => {
      const reset = Number.isFinite(window.reset_at)
        ? Math.round(window.reset_at / 300) * 300
        : 'none'
      return `${Math.round(window.used_percent)}@${reset}`
    })
  if (!tokens.length) return null
  return tokens.sort().join('|')
}

// The quota a cloud card shows: the snapshot's own block wins; live provider
// usage is the fallback. Resolved once per card in ModelView so grouping and
// rendering read the same quota.
function resolveCloudPlanUsage(model, usageMap) {
  return model.quota != null
    ? model.quota
    : providerUsageToQuota(providerUsageLookup(usageMap, model))
}

function quotaWindowCount(quota) {
  if (!quota || typeof quota !== 'object' || !Array.isArray(quota.windows)) return 0
  return quota.windows.filter(window => window && typeof window === 'object').length
}

// A short provider label for the shared-plan line (cloudProviderLabel).
function providerPlanLabel(provider) {
  return cloudProviderLabel(provider)
}

// The lane's provider may be an alias of the provider row model.options names.
function providerUsageLookup(usageMap, model) {
  if (!usageMap || !model) return null
  const names = [model.provider, ...(Array.isArray(model.provider_aliases) ? model.provider_aliases : [])]
  for (const name of names) {
    if (!name) continue
    const usage = usageMap.get(String(name).toLowerCase())
    if (usage) return usage
  }
  return null
}

// The outcome of the latest model.options call for this model's provider:
// 'ok' (numeric windows), 'pending' (row present, no numeric window yet),
// 'absent' (row missing or no usage key), 'error' (the call failed), plus when
// it was checked. `rowPresent` keeps a provider that never reports usage from
// getting a waiting line.
function providerUsageState(usageMap, model) {
  if (!usageMap || !model) return null
  if (usageMap.error) {
    return { status: 'error', lastCheckedAt: usageMap.lastCheckedAt, rowPresent: false }
  }
  const names = [model.provider, ...(Array.isArray(model.provider_aliases) ? model.provider_aliases : [])]
  for (const name of names) {
    if (!name) continue
    const entry = usageMap.status && usageMap.status.get(String(name).toLowerCase())
    if (entry) return entry
  }
  return { status: 'absent', lastCheckedAt: usageMap.lastCheckedAt, rowPresent: false }
}

// One muted line for a card with no quota to render, so 'no reading yet' never
// looks like a bug. Only a provider row that exists in model.options gets the
// waiting line; a provider that never reports usage stays clean. A failed call
// always gets its own line.
function planUsageWaitingLine(state) {
  if (!state) return null
  const waiting = state.status === 'pending' || (state.status === 'absent' && state.rowPresent)
  const failed = state.status === 'error'
  if (!waiting && !failed) return null
  const checked = fmtCheckedTime(state.lastCheckedAt)
  return {
    text: failed
      ? 'plan usage: could not ask Hermes (model.options failed)'
      : "plan usage: waiting for Hermes to read the provider's limits",
    title: `Flightdeck reads plan limits from Hermes' model.options (the same data as \`hermes usage\`). Hermes refreshes them in the background; last checked ${checked || 'unknown'}.`
  }
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
            className: 'text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)',
            children: label
          }),
          meta
            ? jsx('span', { className: 'text-[0.65rem] text-(--ui-text-secondary)', children: meta })
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
      jsx('span', { className: 'text-(--ui-text-secondary)', children: label })
    ]
  })
}

function Metric({ label, value, accent, title }) {
  return jsxs('span', {
    className: 'inline-flex items-baseline gap-1',
    title: title || undefined,
    children: [
      jsx('span', { className: 'text-(--ui-text-secondary)', children: label }),
      jsx('span', {
        className: cn('tabular-nums font-medium', accent ? 'text-(--ui-accent)' : 'text-(--ui-text-primary)'),
        children: value
      })
    ]
  })
}

// Engine health. Server-side numbers come from the server's own /metrics and
// cover ALL traffic hitting it, not just Hermes; every tooltip says so. KV
// cache, prefix hit and MTP acceptance are ring gauges in the card's hero row;
// the rest is one compact stats line. Missing fields are omitted, never zero.
const SERVER_SIDE_NOTE = "Server-side numbers from the server's own /metrics: they cover ALL traffic hitting the server, not just requests from this machine's Hermes."

function fmtHealthPct(value) {
  if (value == null) return null
  return `${Math.round(value * 100)}%`
}

function fmtHealthMem(bytes) {
  if (bytes == null) return null
  return `${(bytes / 1e9).toFixed(1)} GB`
}

// Seconds per output token as '15.9 ms' (one decimal under 100 ms).
function fmtTpot(seconds) {
  if (seconds == null) return null
  const ms = seconds * 1000
  return `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`
}

// Client disconnects ride in a tooltip only: a lifetime count on the card read
// like an error rate.
function droppedText(health) {
  if (!health || (health.disconnects_delta == null && health.disconnects_total == null)) return null
  const parts = []
  if (health.disconnects_delta != null) parts.push(`${fmtInt(health.disconnects_delta)} in the last sample interval`)
  if (health.disconnects_total != null) parts.push(`${fmtInt(health.disconnects_total)} since the server started`)
  return `Client connections dropped: ${parts.join(', ')}.`
}

const RING_SIZE = 44
const RING_STROKE = 4.5

// A ring gauge: the arc is the fraction, the number sits in the middle, the
// label and its plain-words sub-label sit beside it.
function RingGauge({ id, fraction, label, sub, title, tone }) {
  const value = Math.max(0, Math.min(1, Number(fraction) || 0))
  const centre = RING_SIZE / 2
  const radius = (RING_SIZE - RING_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  return jsxs('div', {
    'data-ring': id,
    title,
    style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
    children: [
      jsxs('div', {
        style: { position: 'relative', width: `${RING_SIZE}px`, height: `${RING_SIZE}px`, flex: '0 0 auto' },
        children: [
          jsxs('svg', {
            width: RING_SIZE,
            height: RING_SIZE,
            viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`,
            'aria-hidden': 'true',
            style: { display: 'block', transform: 'rotate(-90deg)' },
            children: [
              jsx('circle', {
                cx: centre, cy: centre, r: radius, fill: 'none',
                stroke: 'var(--ui-stroke-primary)', strokeWidth: RING_STROKE
              }),
              value > 0
                ? jsx('circle', {
                    'data-ring-arc': Math.round(value * 100),
                    cx: centre, cy: centre, r: radius, fill: 'none',
                    stroke: tone || TONE_LOCAL, strokeWidth: RING_STROKE, strokeLinecap: 'round',
                    strokeDasharray: `${(value * circumference).toFixed(2)} ${circumference.toFixed(2)}`
                  })
                : null
            ]
          }),
          jsx('span', {
            style: {
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.72rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.02em', color: 'var(--ui-text-primary)'
            },
            children: `${Math.round(value * 100)}%`
          })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.25 },
        children: [
          jsx('span', {
            style: { fontSize: '0.7rem', fontWeight: 500, whiteSpace: 'nowrap', color: 'var(--ui-text-primary)' },
            children: label
          }),
          jsx('span', {
            style: { fontSize: '0.6rem', whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)' },
            children: sub
          })
        ]
      })
    ]
  })
}

function serverHealthRings(health) {
  if (!health) return []
  const rings = []
  if (health.kv_cache_usage != null) {
    rings.push({
      id: 'kv', fraction: health.kv_cache_usage, label: 'KV cache', sub: 'in use',
      tone: health.kv_cache_usage >= 0.85 ? TONE_AMBER : TONE_LOCAL,
      title: `KV cache fill: how full the server's cache is right now. ${SERVER_SIDE_NOTE}`
    })
  }
  if (health.prefix_cache_hit_rate != null) {
    rings.push({
      id: 'prefix', fraction: health.prefix_cache_hit_rate, label: 'Prefix hit', sub: 'of prompt reused',
      tone: TONE_LOCAL,
      title: `Prefix cache hit rate: share of prompt-prefix lookups that found a cached match. ${SERVER_SIDE_NOTE}`
    })
  }
  if (health.spec_accept_rate != null) {
    rings.push({
      id: 'mtp', fraction: health.spec_accept_rate, label: 'MTP accept', sub: 'drafts accepted',
      tone: TONE_LOCAL,
      title: `MTP acceptance: share of drafted tokens the model accepted. ${SERVER_SIDE_NOTE}`
    })
  }
  return rings
}

// One compact line of label/value pairs behind a small kicker ('server',
// 'Hermes'). Each item is [muted, strong, muted, strong, ...] text parts so a
// pair like 'TTFT p50 760ms · p95 7.6s' stays one item.
function StatLine({ kicker, kickerTitle, items, data }) {
  if (!items.length) return null
  return jsxs('div', {
    'data-stat-line': data || kicker || '',
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: '14px', rowGap: '2px',
      minWidth: 0, fontSize: '0.65rem', lineHeight: 1.45
    },
    children: [
      kicker
        ? jsx('span', {
            title: kickerTitle || undefined,
            style: kickerStyle({ flex: '0 0 auto', minWidth: '3.4rem' }),
            children: kicker
          })
        : null,
      ...items.map(item => jsx('span', {
        'data-stat': item.id,
        title: item.title || undefined,
        style: { whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)' },
        children: item.parts.map((part, index) => jsx('span', {
          style: index % 2
            ? { fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: item.tone || 'var(--ui-text-primary)' }
            : undefined,
          children: part
        }, `${item.id}-${index}`))
      }, item.id))
    ]
  })
}

function serverStatItems(health) {
  if (!health) return []
  const items = []
  const p50 = health.server_ttft_p50 != null ? fmtMs(health.server_ttft_p50 * 1000) : null
  const p95 = health.server_ttft_p95 != null ? fmtMs(health.server_ttft_p95 * 1000) : null
  if (p50 != null || p95 != null) {
    const parts = []
    if (p50 != null) parts.push('TTFT p50 ', p50)
    if (p95 != null) parts.push(p50 != null ? ' · p95 ' : 'TTFT p95 ', p95)
    items.push({
      id: 'ttft', parts,
      title: "time to first token from the server's own /metrics histogram — p50 median and p95. Server-side numbers cover ALL traffic hitting the server, not just requests from this machine's Hermes"
    })
  }
  const tpot = fmtTpot(health.server_tpot_p50)
  if (tpot != null) {
    items.push({
      id: 'tpot', parts: ['time per token ', tpot],
      title: `Time per output token (median) from the server's own histogram. ${SERVER_SIDE_NOTE}`
    })
  }
  const mem = fmtHealthMem(health.memory_bytes)
  if (mem != null) {
    const peak = fmtHealthMem(health.memory_peak_bytes)
    items.push({
      id: 'mem', parts: ['memory ', mem],
      title: `Device memory the engine holds${peak ? ` (peak ${peak})` : ''}. ${SERVER_SIDE_NOTE}`
    })
  }
  const preempted = health.preemptions_delta != null ? health.preemptions_delta : health.preemptions_total
  if (preempted != null) {
    const lifetime = health.preemptions_total != null && health.preemptions_delta != null
      ? ` (${fmtInt(health.preemptions_total)} since the server started)`
      : ''
    const dropped = droppedText(health)
    items.push({
      id: 'preempt', parts: ['preemptions ', fmtInt(preempted)],
      tone: preempted > 0 ? TONE_AMBER : undefined,
      title: `Requests the engine preempted (evicted to free KV cache) in the last sample interval${lifetime}.${dropped ? ` ${dropped}` : ''} ${SERVER_SIDE_NOTE}`
    })
  }
  return items
}

// A plan window's allowance as one thin continuous bar, filled by the used
// percent. The fill escalates amber then red as the allowance runs out; a
// small non-zero reading keeps a visible sliver rather than vanishing.
function PlanBar({ percent, tone }) {
  const pct = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  const fill = pct >= 90 ? TONE_QUEUED : pct >= 75 ? TONE_AMBER : (tone || TONE_CLOUD)
  return jsx('div', {
    'data-plan-bar': Math.round(pct),
    title: `${Math.round(pct)}% of this allowance used`,
    style: {
      position: 'relative', height: '6px', borderRadius: '3px', overflow: 'hidden', minWidth: 0,
      background: 'var(--ui-stroke-secondary)'
    },
    children: pct > 0
      ? jsx('div', {
          style: {
            width: `${pct}%`, minWidth: '6px', height: '100%', borderRadius: '3px',
            background: fill, transition: 'width 500ms ease'
          }
        })
      : null
  })
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

// When the provider usage check last ran, as a plain clock time for a tooltip.
function fmtCheckedTime(ms) {
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function SlotBar({ total, running, waiting }) {
  if (total == null) {
    return jsx('span', { className: 'text-[0.65rem] text-(--ui-text-secondary)', children: 'no slot gauge' })
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

// Throughput sparkline, full card width. `caption` (left) names what the
// chart is; the legend and the decode max sit on the right of the same row.
// Strokes are screen pixels (non-scaling): 2 px decode over 1.5 px prefill,
// with an 0.18 area fill under decode so the shape reads at a glance.
const SPARK_VIEW_H = 30
const SPARK_PLOT_H = 36
const SPARK_DECODE_W = 2
const SPARK_PREFILL_W = 1.5
const SPARK_FILL_ALPHA = 0.18

function Sparkline({ samples, caption, captionTitle, span, tone }) {
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
    // Plot box SPARK_VIEW_H tall; the lines keep ~2 units of headroom so a
    // 2 px stroke at the max never clips at the top edge.
    const base = SPARK_VIEW_H - 1
    const rise = SPARK_VIEW_H - 4
    for (let i = 0; i < rows.length; i += 1) {
      const x = (i / (rows.length - 1)) * 100
      decode.push(`${x.toFixed(2)},${(base - (rows[i][1] / (maxDecode || 1)) * rise).toFixed(2)}`)
      prefill.push(`${x.toFixed(2)},${(base - (rows[i][2] / (maxPrefill || 1)) * rise).toFixed(2)}`)
    }
    return {
      decode: decode.join(' '), prefill: prefill.join(' '),
      area: `0,${SPARK_VIEW_H} ${decode.join(' ')} 100,${SPARK_VIEW_H}`, maxDecode, maxPrefill
    }
  }, [samples])

  if (!series) return null
  const line = tone || 'var(--ui-accent)'
  const dot = color => jsx('span', {
    style: { width: '6px', height: '6px', borderRadius: '999px', background: color, flex: '0 0 auto' }
  })
  return jsxs('div', {
    'data-sparkline': 'throughput',
    style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
    children: [
      jsxs('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0,
          fontSize: '0.6rem', fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-secondary)'
        },
        children: [
          jsx('span', {
            title: captionTitle || undefined,
            style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: caption || ''
          }),
          jsxs('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: '0 0 auto' },
            children: [dot(line), 'decode', dot(PREFILL_TONE), 'prefill']
          }),
          jsx('span', {
            style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
            children: `max ${fmtRate(series.maxDecode)} tok/s${span ? ` · ${span}` : ''}`
          })
        ]
      }),
      jsxs('svg', {
        viewBox: `0 0 100 ${SPARK_VIEW_H}`,
        preserveAspectRatio: 'none',
        style: { display: 'block', width: '100%', height: `${SPARK_PLOT_H}px` },
        'aria-hidden': 'true',
        children: [
          jsx('line', {
            x1: 0, y1: SPARK_VIEW_H - 0.5, x2: 100, y2: SPARK_VIEW_H - 0.5,
            stroke: 'var(--ui-stroke-secondary)', strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke'
          }),
          jsx('polygon', { 'data-spark-area': '', points: series.area, fill: line, opacity: SPARK_FILL_ALPHA }),
          // Prefill under decode, so the decode line always reads on top.
          jsx('polyline', {
            'data-spark-line': 'prefill',
            points: series.prefill,
            fill: 'none',
            stroke: PREFILL_TONE,
            strokeWidth: SPARK_PREFILL_W,
            vectorEffect: 'non-scaling-stroke',
            strokeLinejoin: 'round',
            strokeLinecap: 'round'
          }),
          jsx('polyline', {
            'data-spark-line': 'decode',
            points: series.decode,
            fill: 'none',
            stroke: line,
            strokeWidth: SPARK_DECODE_W,
            vectorEffect: 'non-scaling-stroke',
            strokeLinejoin: 'round',
            strokeLinecap: 'round'
          })
        ]
      })
    ]
  })
}

// Requests per 15 s bucket over the window. Bars, not a gauge: no track, no
// full-width fill, nothing that can read as utilization when nothing is in flight.
function RequestSparkline({ buckets, caption, captionTitle, tone }) {
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
    'data-sparkline': 'requests',
    style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
    children: [
      jsxs('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0,
          fontSize: '0.6rem', fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-secondary)'
        },
        children: [
          jsx('span', {
            title: captionTitle || undefined,
            style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: caption || ''
          }),
          jsx('span', { style: { flex: '0 0 auto' }, children: `max ${series.max} / 15s` })
        ]
      }),
      jsxs('svg', {
        viewBox: '0 0 100 20',
        preserveAspectRatio: 'none',
        style: { display: 'block', width: '100%', height: `${SPARK_PLOT_H}px` },
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
              fill: tone || 'var(--ui-accent)', opacity: bar.count > 0 ? 0.8 : 0
            }, `bucket-${bar.x}`)
          )
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// By model — local server cards first.

// The HELD BY section shared by the local server card and the cloud model
// card: one row per agent with an in-flight request right now. Agents whose
// requests all finished in the window are history (swim lane / By agent), not
// holders. Rows carry the short agent label; the full label rides in the row
// tooltip. Four rows fit; the rest go into the '+N more' tooltip.
function HeldBy({ agents, labels, now, rowBySession, unattributed, over }) {
  const held = (Array.isArray(agents) ? agents : []).filter(a => (a.requests || a.in_flight || 0) > 0)
  const shown = held.slice(0, 4)
  const rest = held.slice(4)
  const rowOf = agent => (rowBySession && rowBySession.get(agent.session_id)) || agent
  // A model column only earns its width when the holders use different models.
  const showModel = new Set(held.map(agent => agent.model).filter(Boolean)).size > 1
  return jsxs('div', {
    'data-held-by': held.length,
    style: {
      display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0,
      borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: '7px'
    },
    children: [
      jsx('span', { style: kickerStyle(), children: 'held by' }),
      held.length
        ? shown.map(agent => {
            const count = agent.requests || agent.in_flight || 0
            return jsxs(
              'div',
              {
                'data-held-row': agent.session_id || '',
                className: 'flex items-center gap-2 text-[0.6875rem]',
                title: fullAgentText(rowOf(agent), labels),
                children: [
                  jsx('span', {
                    style: { width: '6px', height: '6px', borderRadius: '999px', flex: '0 0 auto', background: profileTone(agent.profile) }
                  }),
                  jsx('span', {
                    style: {
                      flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)'
                    },
                    children: shortAgentLabel(rowOf(agent), labels)
                  }),
                  showModel && agent.model
                    ? jsx('span', {
                        title: agent.model,
                        style: {
                          flex: '0 1 auto', maxWidth: '9rem', overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap', fontSize: '0.6rem', color: 'var(--ui-text-secondary)'
                        },
                        children: laneModelShort(agent.model)
                      })
                    : null,
                  jsx('span', {
                    title: 'how long its oldest in-flight request has been open',
                    style: {
                      flex: '0 0 auto', minWidth: '3rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      color: 'var(--ui-text-secondary)'
                    },
                    children: elapsedOf(agent.oldest_started_at, now) || '—'
                  }),
                  count > 1
                    ? jsx(Badge, { variant: 'muted', size: 'xs', title: `${count} requests in flight`, children: `×${count}` })
                    : null
                ]
              },
              `${agent.session_id}-${agent.model || ''}`
            )
          })
        : jsx('span', {
            style: { fontSize: '0.6875rem', color: 'var(--ui-text-secondary)' },
            children: 'no in-flight request observed'
          }),
      rest.length
        ? jsx('span', {
            style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
            title: rest.map(agent => fullAgentText(rowOf(agent), labels)).join('\n'),
            children: `+${rest.length} more`
          })
        : null,
      unattributed > 0
        ? jsxs('div', {
            className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-secondary)',
            title: 'The server counts these as running, but no Hermes row on this machine matches them.',
            children: [
              jsx('span', {
                style: { width: '6px', height: '6px', borderRadius: '999px', flex: '0 0 auto', background: 'var(--ui-bg-tertiary)', boxShadow: 'inset 0 0 0 1px var(--ui-stroke-tertiary)' }
              }),
              jsx('span', { className: 'min-w-0 truncate', children: 'not observed by Flightdeck' }),
              jsx('span', { className: 'ml-auto tabular-nums', children: unattributed })
            ]
          })
        : null,
      over > 0
        ? jsx('span', {
            style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
            title: 'Hermes has these requests open, but the server does not count them as running yet (queued at the client, or closing).',
            children: `${plural(over, 'row')} the server does not count (queued or closing)`
          })
        : null
    ]
  })
}

// The model a local server runs, for the card header — never a repeat of the
// server's own name. The title's first clause wins (minus the name and any
// word the kind badge already says); else the served model id, unless that id
// only restates the server name. '' when nothing new is left.
const SERVER_MODEL_SHORT_MAX = 36

function serverModelShort(server) {
  if (!server) return ''
  const name = String(server.name || '').trim()
  const squash = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const squashedName = squash(name)
  const kind = squash(server.kind)
  const title = String(server.title || '').trim()
  let text = ''
  if (title && !/^helper model\b/i.test(title)) {
    text = title.split(/\s+[-–—·]\s+|\s*\(|:\s|,\s/)[0].trim()
    text = text.split(/\s+/).filter(word => {
      const squashed = squash(word)
      return squashed && squashed !== kind && squashed !== squashedName
    }).join(' ')
  }
  if (!text) {
    const served = Array.isArray(server.models) && server.models.length ? String(server.models[0]) : ''
    text = served ? modelDisplayName(served).replace(/\.gguf$/i, '') : ''
    if (squashedName && squash(text).includes(squashedName)) return ''
  }
  if (!text || squash(text) === squashedName) return ''
  return text.length > SERVER_MODEL_SHORT_MAX ? `${text.slice(0, SERVER_MODEL_SHORT_MAX - 1)}…` : text
}

// A server with nothing from Hermes in the window — no row in flight or
// finished, nothing running or queued — folds to one line until clicked. An
// erroring server never folds: its state is the news.
function isQuietServer(server) {
  if (!server || server.error || server.healthy === false) return false
  if ((server.in_flight || 0) > 0 || (server.running || 0) > 0 || (server.waiting || 0) > 0) return false
  if (Array.isArray(server.requests) && server.requests.length) return false
  if (Array.isArray(server.agents) && server.agents.some(agent => (agent.requests || agent.in_flight || 0) > 0)) return false
  return true
}

function windowRequests(model, windowSeconds) {
  if (!model) return null
  return windowSeconds <= 60 ? model.requests_1m : model.requests_5m
}

const BUTTON_RESET = {
  background: 'transparent', border: 0, padding: 0, margin: 0, font: 'inherit', color: 'inherit',
  textAlign: 'left', cursor: 'pointer'
}

function ServerCard({ server, models, labels, now, snapshot, windowSeconds = 300 }) {
  const [expanded, setExpanded] = useState(false)
  const verdict = serverVerdict(server)
  const quiet = isQuietServer(server)
  const modelShort = serverModelShort(server)
  // The URL and the full free-text title live in the header tooltip.
  const tooltip = [server.title, server.base_url].filter(Boolean).join('\n')
  const sampled = server.sampled_at ? Date.parse(server.sampled_at) / 1000 : null
  const span = fmtDuration(windowSeconds)
  const headerName = jsxs('span', {
    'data-server-title': server.name,
    style: {
      minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize: '0.8125rem', letterSpacing: '-0.01em'
    },
    children: [
      jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)' }, children: server.name }),
      modelShort
        ? jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: ` · ${modelShort}` })
        : null
    ]
  })
  const kindBadges = [
    server.kind ? jsx(Badge, { variant: 'outline', size: 'xs', children: server.kind }, 'kind') : null,
    server.aux
      ? jsx(Badge, { variant: 'muted', size: 'xs', title: server.title || 'auxiliary helper model', children: 'aux' }, 'aux')
      : null
  ]

  if (quiet && !expanded) {
    return jsx('article', {
      'data-server-card': server.name,
      'data-compact': 'true',
      className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary)',
      children: jsxs('button', {
        type: 'button',
        'aria-expanded': 'false',
        'data-expand-server': server.name,
        title: `${tooltip ? `${tooltip}\n` : ''}No Hermes requests in the last ${span}. Click for the full card.`,
        onClick: () => setExpanded(true),
        style: {
          ...BUTTON_RESET, display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minWidth: 0,
          padding: '7px 12px', fontSize: '0.6875rem'
        },
        children: [
          jsx(StatusDot, { tone: verdict.tone, className: 'size-2 shrink-0' }),
          headerName,
          ...kindBadges,
          jsx('span', {
            style: {
              marginLeft: 'auto', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)'
            },
            children: `idle · no Hermes requests in ${span}`
          }),
          jsx(Badge, { variant: verdict.variant, size: 'xs', children: verdict.label }),
          jsx(Codicon, { name: 'chevron-down', size: 12, className: 'shrink-0 text-(--ui-text-secondary)' })
        ]
      })
    })
  }

  const agents = Array.isArray(server.agents) ? server.agents : []
  const unattributed = server.unattributed || 0
  const over = server.over_attributed || 0
  const rowBySession = snapshot ? agentRowBySession(snapshot) : null
  // The server object carries no TTFT of its own; the busiest model lane on it
  // does, and that is the honest number to show next to the server's rates.
  const serverModels = Array.isArray(models) ? models.filter(m => m.server_name === server.name) : []
  const busiest = serverModels.slice().sort((a, b) => (b.in_flight || 0) - (a.in_flight || 0))[0]
  const ttft = server.ttft_ms_p50 != null ? server.ttft_ms_p50 : busiest ? busiest.ttft_ms_p50 : null
  const latency = server.latency_ms_p50 != null ? server.latency_ms_p50 : busiest ? busiest.latency_ms_p50 : null
  // A server whose rows are mostly whole-response has no honest TTFT; its
  // busiest lane's latency is the number to show instead.
  const wholeResponse = busiest ? (busiest.non_streamed || 0) > (busiest.streamed || 0) : false
  const requestCount = serverModels.length
    ? serverModels.reduce((sum, model) => sum + (windowRequests(model, windowSeconds) || 0), 0)
    : (Array.isArray(server.requests) ? server.requests.length : null)
  const rings = serverHealthRings(server.health)
  const statItems = serverStatItems(server.health)
  const aliases = busiest && busiest.provider_aliases && busiest.provider_aliases.length > 1
    ? ` · providers: ${busiest.provider_aliases.join(', ')}`
    : ''
  const hermesItems = [
    {
      id: 'in-flight', parts: ['in flight ', fmtInt(server.in_flight || 0)],
      tone: (server.in_flight || 0) > 0 ? TONE_LOCAL : undefined,
      title: "requests this machine's Hermes has open on this server right now"
    },
    requestCount != null
      ? { id: 'requests', parts: [`req / ${span} `, fmtInt(requestCount)], title: `requests Hermes sent this server in the last ${span}` }
      : null,
    latency != null
      ? {
          id: 'latency', parts: ['latency p50 ', fmtMs(latency)],
          title: "request duration (median) as observed by this machine's Hermes — only the requests Hermes sent, unlike the server-side numbers above"
        }
      : null,
    ttft != null || wholeResponse
      ? {
          id: 'ttft', parts: ['TTFT p50 ', wholeResponse ? 'not streamed' : fmtMs(ttft)],
          title: `time to first token (median) as observed by this machine's Hermes — only the requests Hermes sent, unlike the server's own /metrics quantiles above${wholeResponse ? '; not applicable: this server returns whole responses' : ''}${aliases}`
        }
      : null
  ].filter(Boolean)
  const rateCaption = server.decode_tps != null || server.prefill_tps != null
    ? `now decode ${fmtRate(server.decode_tps)} · prefill ${fmtRate(server.prefill_tps)} tok/s`
    : 'decode / prefill'
  const dropped = droppedText(server.health)

  return jsxs('article', {
    'data-server-card': server.name,
    'data-compact': 'false',
    className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary)',
    style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, padding: '10px 12px' },
    children: [
      jsxs('div', {
        title: tooltip || undefined,
        style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
        children: [
          jsx(StatusDot, {
            tone: verdict.tone,
            className: cn('size-2 shrink-0', server.in_flight > 0 && 'animate-pulse')
          }),
          headerName,
          ...kindBadges,
          jsx(Badge, { variant: verdict.variant, size: 'xs', children: verdict.label }),
          jsx('span', {
            title: server.error ? 'the last probe failed' : 'when Flightdeck last read this server',
            style: { marginLeft: 'auto', flex: '0 0 auto', fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
            children: server.error ? 'unreachable' : sampled != null ? `live · ${fmtAgo(sampled, now)}` : 'live'
          }),
          quiet
            ? jsx('button', {
                type: 'button',
                'aria-expanded': 'true',
                'aria-label': `Fold ${server.name} to one line`,
                title: 'Fold to one line',
                onClick: () => setExpanded(false),
                style: { ...BUTTON_RESET, display: 'inline-flex', flex: '0 0 auto', color: 'var(--ui-text-secondary)' },
                children: jsx(Codicon, { name: 'chevron-up', size: 12 })
              })
            : null
        ]
      }),
      jsxs('div', {
        'data-hero': '',
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '24px', rowGap: '10px', minWidth: 0 },
        children: [
          jsxs('div', {
            'data-slots-meter': '',
            style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'baseline', gap: '6px' },
                children: [
                  jsx('span', {
                    style: {
                      fontSize: '1.5rem', fontWeight: 600, lineHeight: 1, letterSpacing: '-0.02em',
                      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: 'var(--ui-text-primary)'
                    },
                    children: `${server.running != null ? server.running : '—'} / ${server.slots != null ? server.slots : '—'}`
                  }),
                  jsx('span', {
                    title: 'Requests the server can run at once; more than this wait in its queue.',
                    style: { fontSize: '0.65rem', color: 'var(--ui-text-secondary)' },
                    children: 'slots'
                  }),
                  server.waiting > 0
                    ? jsx(Badge, { variant: 'warn', size: 'xs', children: `${server.waiting} queued` })
                    : null
                ]
              }),
              jsx(SlotBar, { total: server.slots, running: server.running, waiting: server.waiting })
            ]
          }),
          ...rings.map(ring => jsx(RingGauge, { ...ring }, ring.id))
        ]
      }),
      jsx(StatLine, {
        kicker: 'server',
        kickerTitle: `${SERVER_SIDE_NOTE}${dropped ? ` ${dropped}` : ''}`,
        items: statItems
      }),
      jsx(StatLine, {
        kicker: 'Hermes',
        kickerTitle: "Observed by this machine's Hermes: only the requests it sent to this server.",
        items: hermesItems
      }),
      jsx(HeldBy, { agents, labels, now, rowBySession, unattributed, over }),
      // The chart is the card's footer: pinned to the bottom so cards that
      // share a grid row line their charts up.
      jsx('div', {
        'data-card-chart': 'server',
        style: { minWidth: 0, marginTop: 'auto' },
        children: jsx(Sparkline, {
          samples: server.samples,
          caption: rateCaption,
          captionTitle: "the server's own decode and prefill throughput right now; the chart is its recent history",
          span: '5m',
          tone: TONE_LOCAL
        }) || jsx('span', {
          style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
          children: `decode / prefill · no throughput in the last 5m`
        })
      })
    ]
  })
}

// Plan usage from the snapshot's `quota` block (the backend fills it; may be
// null). One row per window, as in the video: label on the left, '42% used ·
// resets 3:10 PM' on the right, one thin bar under them. A window with a null
// used_percent still shows its label and reset, never a fake fill.
// `unavailable_reason` is one honest muted line; a null quota renders nothing
// at all unless the live usage check has a pending/absent/error state, which
// gets one muted waiting line.
function PlanUsage({ quota, state, tone }) {
  if (!quota || typeof quota !== 'object') {
    const waiting = planUsageWaitingLine(state)
    return waiting
      ? jsx('span', {
          style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
          title: waiting.title,
          children: waiting.text
        })
      : null
  }
  const windows = Array.isArray(quota.windows)
    ? quota.windows.filter(w => w && typeof w === 'object')
    : []
  if (!windows.length && !quota.unavailable_reason) return null
  const labelTexts = windows.map((window, index) => window.label || `window ${index + 1}`)
  const planText = [
    quota.plan ? quota.title ? `${quota.plan} · ${quota.title}` : quota.plan : (quota.title || null),
    quota.source ? `via ${quota.source}` : null,
    quota.fetched_at != null ? `updated ${fmtAgo(quota.fetched_at, Date.now() / 1000)}` : null
  ].filter(Boolean).join(' · ')
  return jsxs('div', {
    'data-plan-usage': windows.length,
    style: { display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0 },
    children: [
      windows.length
        ? jsxs('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 },
            children: [
              jsx('span', { style: kickerStyle({ flex: '0 0 auto' }), children: 'plan usage' }),
              // The plan/title rides next to the kicker, so a title-only quota
              // ('account 1 of 2') never renders as a stray value under a bar.
              planText
                ? jsx('span', {
                    title: planText,
                    style: {
                      minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontSize: '0.6rem', color: 'var(--ui-text-secondary)'
                    },
                    children: `· ${planText}`
                  })
                : null
            ]
          })
        : null,
      windows.map((window, index) => {
        const used = Number.isFinite(window.used_percent)
          ? Math.max(0, Math.min(100, window.used_percent))
          : null
        const reset = fmtResetTime(window.reset_at)
        const modelCap = window.detail === 'model-specific cap'
        return jsxs('div', {
          'data-plan-window': labelTexts[index],
          style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
          children: [
            jsxs('div', {
              style: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0, fontSize: '0.65rem' },
              children: [
                jsx('span', {
                  title: labelTexts[index],
                  style: { flex: '0 0 auto', minWidth: 'max-content', whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)' },
                  children: labelTexts[index]
                }),
                modelCap
                  ? jsx('span', {
                      title: 'Weekly limit for this model family only; the account limit is the Current week row.',
                      style: { flex: '0 0 auto', whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)' },
                      children: '· model cap'
                    })
                  : window.detail
                    ? jsx('span', {
                        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)' },
                        children: window.detail
                      })
                    : null,
                jsxs('span', {
                  'data-plan-text': '',
                  style: {
                    marginLeft: 'auto', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-secondary)'
                  },
                  children: used == null
                    ? [reset ? `no usage reported · resets ${reset}` : 'no usage reported']
                    : [
                        jsx('span', {
                          style: { fontWeight: 600, color: 'var(--ui-text-primary)' },
                          children: `${Math.round(used)}%`
                        }, 'pct'),
                        reset ? ` used · resets ${reset}` : ' used'
                      ]
                })
              ]
            }),
            used == null ? null : jsx(PlanBar, { percent: used, tone })
          ]
        }, `${window.label || 'window'}-${index}`)
      }),
      quota.as_of != null && Number.isFinite(quota.as_of)
        ? jsx('span', {
            style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
            title: "The provider's usage check did not answer on the last refresh; showing the most recent good reading.",
            children: `as of ${fmtResetTime(quota.as_of)} (last refresh failed)`
          })
        : null,
      quota.unavailable_reason
        ? jsx('span', {
            style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
            children: `plan usage unavailable: ${quota.unavailable_reason}`
          })
        : null
    ]
  })
}

// A cloud lane's provider as a short label: the subscription-direct lane is
// DirectSDK, a vendor's metered API is API, the ChatGPT-plan lane is Codex.
// Anything else keeps its slug; the full provider/model rides in the tooltip.
function cloudProviderLabel(provider) {
  const slug = String(provider || '').trim()
  const key = slug.toLowerCase()
  if (!key) return 'provider'
  if (key.includes('directsdk')) return 'DirectSDK'
  if (key.includes('codex')) return 'Codex'
  if (key === 'anthropic' || key === 'openai' || key === 'gemini' || key === 'google' || key === 'xai') return 'API'
  return slug
}

function CloudCard({ model, labels, now, windowSeconds, snapshot, usageMap, planUsage, sharedWith }) {
  const quotaQ = useQuota(model.provider)
  // The snapshot's own quota block wins; the live session.stats gauge is only
  // a fallback for a lane the snapshot has no quota for.
  const quota = model.quota != null ? null : quotaLine(quotaQ.data, model.provider)
  const plan = model.quota != null ? null : planLine(quotaQ.data)
  // Live subscription usage comes from the public model.options RPC; the
  // backend fills model.quota in demo mode only, so a demo quota wins.
  // ModelView resolves this once per card and passes it in; a direct call
  // (tests, other callers) resolves it here.
  const resolvedPlanUsage = planUsage === undefined
    ? resolveCloudPlanUsage(model, usageMap)
    : planUsage
  const planUsageState = providerUsageState(usageMap, model)
  // `now` is ms (useNow); the tok/s series wants seconds.
  const winEnd = now / 1000
  const samples = cloudSamplesFromRequests(model.requests || [], winEnd - windowSeconds, winEnd)
  const bucketValue = Array.isArray(model.requests_buckets)
    && model.requests_buckets.some(n => Number(n) > 0)
  const rowBySession = agentRowBySession(snapshot)
  // Only agents with a request in flight right now are holders; finished rows
  // in the window are swim-lane history. The oldest in-flight start comes from
  // the card's own request rows (cloud agent entries carry no timestamp).
  const oldestByAgent = new Map()
  for (const row of model.requests || []) {
    if (row.status !== 'in-flight' || row.started_at == null) continue
    const key = `${row.profile || ''}|${row.session_id || ''}`
    const oldest = oldestByAgent.get(key)
    if (oldest == null || row.started_at < oldest) oldestByAgent.set(key, row.started_at)
  }
  const heldRows = (Array.isArray(model.agents) ? model.agents : [])
    .filter(agent => (agent.in_flight || agent.requests || 0) > 0)
    .map(agent => ({
      ...agent,
      oldest_started_at: agent.oldest_started_at != null
        ? agent.oldest_started_at
        : oldestByAgent.get(`${agent.profile || ''}|${agent.session_id || ''}`)
    }))
  const inFlight = model.in_flight || 0
  const tokens = model.tokens || {}
  const streamed = model.streamed || 0
  const nonStreamed = model.non_streamed || 0
  const wholeResponse = nonStreamed > streamed
  const cachedPct = tokens.prompt ? Math.round((tokens.cached || 0) / tokens.prompt * 100) : null
  const span = fmtDuration(windowSeconds)
  const requestsInWindow = windowRequests(model, windowSeconds)
  const providerLabel = cloudProviderLabel(model.provider)
  const fullLabel = fullModelLabel(model.provider, model.model)
  const headerTitle = [
    fullLabel,
    model.base_url,
    "Hermes traffic only: every number on this card comes from this machine's Hermes requests; the provider publishes no server load."
  ].filter(Boolean).join('\n')
  const detailItems = [
    model.latency_ms_p50 != null
      ? { id: 'latency', parts: ['latency p50 ', fmtMs(model.latency_ms_p50)], title: 'request duration (median)' }
      : null,
    !wholeResponse && model.decode_tps != null
      ? { id: 'decode', parts: ['decode ', `${fmtRate(model.decode_tps)} tok/s`], title: 'output tokens per second while streaming' }
      : null,
    tokens.prompt
      ? {
          id: 'input', parts: ['in ', `${tokenText(tokens.prompt)}${cachedPct ? ` · ${cachedPct}% cached` : ''}`],
          title: 'prompt tokens sent to the model; the cached share was reused, not reprocessed'
        }
      : null,
    tokens.completion
      ? { id: 'output', parts: ['out ', tokenText(tokens.completion)], title: 'completion tokens generated' }
      : null,
    model.errors_5m
      ? {
          id: 'errors', parts: ['errors ', `${fmtInt(model.errors_5m)}${model.errors_429_5m ? ` · ${model.errors_429_5m} × 429` : ''}`],
          tone: TONE_QUEUED, title: 'failed requests in the window; 429s are rate limits'
        }
      : null
  ].filter(Boolean)
  const chart = samples.length
    ? jsx(Sparkline, {
        samples,
        caption: `decode / prefill · ${span} · Hermes-observed`,
        captionTitle: "Computed from this machine's Hermes requests only; the provider does not publish server throughput.",
        tone: TONE_CLOUD
      })
    : bucketValue
      ? jsx(RequestSparkline, {
          buckets: model.requests_buckets,
          caption: `requests, last ${span}`,
          captionTitle: "This machine's Hermes requests per 15 s; the provider does not publish server load.",
          tone: TONE_CLOUD
        })
      : null

  return jsxs('article', {
    'data-cloud-card': model.key || fullLabel,
    className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary)',
    style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, padding: '10px 12px' },
    children: [
      jsxs('div', {
        title: headerTitle,
        style: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 },
        children: [
          jsx(StatusDot, {
            tone: inFlight > 0 ? 'good' : 'muted',
            className: cn('size-2 shrink-0', inFlight > 0 && 'animate-pulse')
          }),
          jsx(Codicon, { name: 'cloud', size: 12, className: 'shrink-0 text-(--ui-text-secondary)' }),
          jsx('span', {
            title: fullLabel,
            style: {
              minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: '0.8125rem', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ui-text-primary)'
            },
            children: modelDisplayName(model.model || model.provider)
          }),
          jsx('span', {
            'data-provider-label': providerLabel,
            title: headerTitle,
            style: {
              flex: '0 0 auto', whiteSpace: 'nowrap', fontSize: '0.6rem', fontWeight: 500,
              padding: '1px 6px', borderRadius: '999px', color: 'var(--ui-text-secondary)',
              boxShadow: 'inset 0 0 0 1px var(--ui-stroke-secondary)'
            },
            children: providerLabel
          })
        ]
      }),
      jsxs('div', {
        'data-cloud-stats': '',
        style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: '12px', minWidth: 0 },
        children: [
          jsx(BigStat, {
            col: 'in-flight', value: fmtInt(inFlight), label: 'in flight', size: '1.35rem',
            tone: inFlight > 0 ? TONE_CLOUD : undefined, title: 'requests running right now'
          }),
          jsx(BigStat, {
            col: 'requests', value: fmtInt(requestsInWindow), label: `req / ${windowSeconds <= 60 ? '1 min' : '5 min'}`,
            size: '1.35rem', title: `requests Hermes sent this lane in the last ${windowSeconds <= 60 ? 'minute' : '5 minutes'}`
          }),
          jsx(BigStat, {
            col: 'ttft',
            value: wholeResponse ? 'not streamed' : fmtMs(model.ttft_ms_p50),
            label: 'TTFT p50',
            size: wholeResponse ? '0.95rem' : '1.35rem',
            title: wholeResponse
              ? 'time to first token (median) — not applicable: this lane returns whole responses'
              : 'time to first token (median)'
          })
        ]
      }),
      jsx(StatLine, { data: 'cloud-detail', items: detailItems }),
      sharedWith
        ? jsx('span', {
            style: { fontSize: '0.65rem', color: 'var(--ui-text-secondary)' },
            title: 'Same subscription as the other card; usage counts once.',
            children: `shared plan with ${modelDisplayName(sharedWith.model || sharedWith.provider)} (${providerPlanLabel(sharedWith.provider)})`
          })
        : jsx(PlanUsage, { quota: resolvedPlanUsage, state: planUsageState, tone: TONE_CLOUD }),
      quota || plan
        ? jsxs('div', {
            className: 'flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[0.65rem] text-(--ui-text-secondary)',
            children: [
              quota ? jsx('span', { className: 'tabular-nums', children: quota }) : null,
              plan ? jsx('span', { className: 'tabular-nums', children: plan }) : null
            ]
          })
        : null,
      jsx(HeldBy, { agents: heldRows, labels, now, rowBySession }),
      jsx('div', {
        'data-card-chart': 'cloud',
        style: { minWidth: 0, marginTop: 'auto' },
        children: chart || jsx('span', {
          title: "Computed from this machine's Hermes requests only; the provider does not publish server throughput.",
          style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
          children: `decode / prefill · ${span} · Hermes-observed · no streamed output yet`
        })
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
            className: 'ml-auto truncate font-mono text-[0.6rem] text-(--ui-text-secondary)',
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
        className: 'flex items-center gap-2 text-[0.65rem] text-(--ui-text-secondary)',
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

function requestTooltip(request, labels, snapshot, lane) {
  // Line 1 is the same agent label By agent shows: the row's own title, or a
  // subagent's role + goal. The date id is never a tooltip line.
  const agentRow = agentRowBySession(snapshot).get(request.session_id)
  const agent = agentRow
    ? agentLabel(agentRow, labels || {})
    : (sessionTitle(labels || {}, request.session_id) || 'session')
  const ttft = request.first_chunk_at != null && request.started_at != null
    ? Math.max(0, request.first_chunk_at - request.started_at) * 1000
    : null
  const genEnd = request.ended_at != null ? request.ended_at : Date.now() / 1000
  const genSpan = request.first_chunk_at != null ? Math.max(0, genEnd - request.first_chunk_at) : null
  // A generating span under half a second makes tok/s meaningless (a whole
  // response's span is ~0 s and once read as 60,337 tok/s); skip the rate.
  const generating = genSpan != null && genSpan >= 0.5 && request.completion_tokens != null
    ? request.completion_tokens / genSpan
    : null
  const inFlightRow = request.ended_at == null
  const whole = !inFlightRow && isWholeResponse(request)
  const waitingSoFar = inFlightRow && request.first_chunk_at == null && request.started_at != null
    ? Math.max(0, Date.now() / 1000 - request.started_at) * 1000
    : null
  const timing = waitingSoFar != null
    ? `waiting for first token · ${fmtMs(waitingSoFar)} so far`
    : whole
    ? `whole response after ${fmtMs(ttft)} (not streamed)`
    : (generating != null
        ? `first token after ${fmtMs(ttft)} · generated ${fmtInt(request.completion_tokens)} tok at ${fmtRate(generating)} tok/s`
        : `first token after ${fmtMs(ttft)}${request.completion_tokens != null ? ` · generated ${fmtInt(request.completion_tokens)} tok` : ''}`)
  const inFlight = request.ended_at == null
  const status = inFlight ? 'running' : (/error/i.test(String(request.status || '')) ? 'error' : 'finished')
  return [
    agent,
    `${request.model || 'model unknown'} on ${(lane && lane.label) || 'lane'}`,
    timing,
    `${tokenText(request.prompt_tokens)} in / ${tokenText(request.completion_tokens)} out`,
    status
  ].join('\n')
}

// The facts the hover card shows for one request bar: a short name, model on
// lane, and five numbers. Same sources as requestTooltip (its text form rides
// on the card's aria-label).
function requestCardFacts(request, labels, snapshot, lane, rowBySession) {
  const map = rowBySession || agentRowBySession(snapshot)
  const agentRow = map.get(request.session_id) ||
    { kind: request.kind, profile: request.profile, session_id: request.session_id }
  const nowS = Date.now() / 1000
  const inFlight = request.ended_at == null
  // 'Not streamed' is a verdict on a FINISHED row only. An in-flight row with
  // no first chunk yet is still waiting: its wait so far, generating '—'.
  const whole = !inFlight && isWholeResponse(request)
  const end = inFlight ? nowS : request.ended_at
  const firstAt = request.first_chunk_at != null ? request.first_chunk_at : null
  const waited = request.started_at != null
    ? Math.max(0, (whole || firstAt == null ? end : firstAt) - request.started_at)
    : null
  const genSpan = !whole && firstAt != null ? Math.max(0, end - firstAt) : null
  const rate = genSpan != null && genSpan >= 0.5 && request.completion_tokens != null
    ? request.completion_tokens / genSpan
    : null
  const errored = /error/i.test(String(request.status || ''))
  const cachedPct = request.prompt_tokens && request.cached_tokens
    ? Math.round((request.cached_tokens / request.prompt_tokens) * 100)
    : null
  const full = fullAgentText(agentRow, labels || {})
  const short = shortAgentLabel(agentRow, labels || {})
  return {
    name: short,
    full: full !== short ? full : null,
    modelLine: `${modelDisplayName(request.model || 'model unknown')} · ${laneModelShort(lane && lane.label)}${lane && lane.kind ? ` (${lane.kind})` : ''}`,
    waited: waited != null ? fmtMs(waited * 1000) : '—',
    waitedLabel: whole ? 'whole response' : (firstAt == null && inFlight ? 'waiting so far' : 'waited for 1st token'),
    generating: whole ? 'not streamed' : (genSpan != null ? fmtMs(genSpan * 1000) : '—'),
    generatingLabel: rate != null ? `generating · ${fmtRate(rate)} tok/s` : 'generating',
    tokensIn: fmtTokens(request.prompt_tokens),
    tokensInLabel: cachedPct ? `tokens in · ${cachedPct}% cached` : 'tokens in',
    tokensOut: fmtTokens(request.completion_tokens),
    status: inFlight ? 'running' : (errored ? 'error' : 'finished'),
    statusTone: inFlight ? TONE_LOCAL : (errored ? TONE_QUEUED : 'var(--ui-text-secondary)')
  }
}

const REQUEST_CARD_W = 268

function RequestCard({ facts, color, text, left, top }) {
  return jsxs('div', {
    role: 'tooltip',
    'data-request-card': facts.name,
    'aria-label': text,
    style: {
      position: 'absolute',
      zIndex: 20,
      pointerEvents: 'none',
      left: `${left}px`,
      top: `${top}px`,
      width: `${REQUEST_CARD_W}px`,
      boxSizing: 'border-box',
      padding: '10px 12px',
      borderRadius: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      background: 'var(--ui-bg-elevated, var(--ui-bg-editor))',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
            children: [
              jsx('span', { style: { width: '8px', height: '8px', borderRadius: '2px', flex: '0 0 auto', background: color } }),
              jsx('span', {
                style: {
                  fontSize: '0.8125rem', fontWeight: 650, color: 'var(--ui-text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0
                },
                children: facts.name
              })
            ]
          }),
          jsx('span', {
            style: {
              fontSize: '0.65rem', color: 'var(--ui-text-secondary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            },
            children: facts.modelLine
          })
        ]
      }),
      jsxs('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '12px', rowGap: '6px' },
        children: [
          jsx(BigStat, { value: facts.waited, label: facts.waitedLabel, size: '0.95rem' }),
          jsx(BigStat, { value: facts.generating, label: facts.generatingLabel, size: '0.95rem' }),
          jsx(BigStat, { value: facts.tokensIn, label: facts.tokensInLabel, size: '0.95rem' }),
          jsx(BigStat, { value: facts.tokensOut, label: 'tokens out', size: '0.95rem' }),
          jsx(BigStat, { value: facts.status, label: 'status', size: '0.95rem', tone: facts.statusTone })
        ]
      }),
      facts.full
        ? jsx('span', {
            style: {
              fontSize: '0.65rem', lineHeight: 1.35, color: 'var(--ui-text-secondary)',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: '6px'
            },
            children: facts.full
          })
        : null
    ]
  })
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
// THIS is the single streamed predicate: the canvas hatches a FINISHED bar
// exactly when this is true (an in-flight row with no first chunk is still
// waiting, drawn low-alpha), and the lane's 'n streamed' count is the rows
// where it is false.
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
    // Hatched 'not streamed' is a verdict on a FINISHED row; an in-flight row
    // with no first chunk yet is still waiting and draws low-alpha.
    const whole = request.ended_at != null && isWholeResponse(request)
    rows.push({ request, start, end, slot, whole, abutStart })
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
      const first = bar.request ? bar.request.first_chunk_at : null
      // An in-flight bar with no first chunk is all waiting, no generating.
      if (first == null) { present.waiting = true; continue }
      if (first > bar.start) present.waiting = true
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

// Swim-lane geometry shared by the draw and the container: the plot starts
// SWIM_LANE_TOP px down and the time axis takes SWIM_LANE_AXIS_H at the bottom.
// Each lane wants LANE_TARGET_H px, so the container grows with the lane count
// (no lane is ever drawn past the canvas) and never shrinks below the old fixed
// 190 px for one or two lanes. SWIM_LANE_MIN_LANE_H is the draw's floor.
const SWIM_LANE_TOP = 4
const SWIM_LANE_AXIS_H = 16
const LANE_TARGET_H = 64
const SWIM_LANE_MIN_H = 190
const SWIM_LANE_MIN_LANE_H = 40
// A request row is tall enough to carry a name chip; a lane grows with its
// peak concurrency (capped) so stacked rows never shrink below chip height.
const SWIM_ROW_TARGET_H = 15
const SWIM_ROW_GAP = 2
const SWIM_LANE_MAX_H = 150

function laneWantHeight(lane) {
  const peak = Math.max(1, (lane && lane.concurrency) || 1)
  return Math.min(SWIM_LANE_MAX_H, Math.max(LANE_TARGET_H, 14 + peak * (SWIM_ROW_TARGET_H + SWIM_ROW_GAP)))
}

// Accepts the lanes (each lane's own height) or a bare count (uniform lanes).
function swimLaneHeight(lanesOrCount) {
  const lanes = Array.isArray(lanesOrCount) ? lanesOrCount : null
  const count = lanes ? lanes.length : (lanesOrCount || 0)
  if (!count) return SWIM_LANE_MIN_H
  const want = lanes
    ? lanes.reduce((sum, lane) => sum + laneWantHeight(lane), 0)
    : count * LANE_TARGET_H
  return Math.max(SWIM_LANE_MIN_H, SWIM_LANE_TOP + SWIM_LANE_AXIS_H + want)
}

// One name chip on the canvas: a pill on the theme surface at CHIP_BG_ALPHA
// (so the label reads on any bar colour), a 1 px agent-colour border, an
// agent-colour dot, then the label in 12 px semibold primary text. Falls back
// to plain rects on a context with no roundRect.
const CHIP_FONT_PX = 12
const CHIP_BG_ALPHA = 0.92
const CHIP_PAD_L = 7
const CHIP_DOT = 6
const CHIP_DOT_GAP = 5
const CHIP_PAD_R = 8
// Everything in a chip that is not label text: the width is this plus the
// measured label.
const CHIP_CHROME_W = CHIP_PAD_L + CHIP_DOT + CHIP_DOT_GAP + CHIP_PAD_R

function drawChip(ctx2, x, y, w, h, color, text, theme) {
  const r = h / 2
  ctx2.save()
  ctx2.globalAlpha = CHIP_BG_ALPHA
  ctx2.fillStyle = theme.surface
  ctx2.beginPath()
  if (typeof ctx2.roundRect === 'function') {
    ctx2.roundRect(x, y, w, h, r)
    ctx2.fill()
  } else {
    ctx2.fillRect(x, y, w, h)
  }
  ctx2.globalAlpha = 1
  ctx2.strokeStyle = color
  ctx2.lineWidth = 1
  if (typeof ctx2.roundRect === 'function') {
    ctx2.beginPath()
    ctx2.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5)
    ctx2.stroke()
  } else {
    ctx2.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }
  ctx2.fillStyle = color
  if (typeof ctx2.arc === 'function') {
    ctx2.beginPath()
    ctx2.arc(x + CHIP_PAD_L + CHIP_DOT / 2, y + h / 2, CHIP_DOT / 2, 0, Math.PI * 2)
    ctx2.fill()
  } else {
    ctx2.fillRect(x + CHIP_PAD_L, y + h / 2 - CHIP_DOT / 2, CHIP_DOT, CHIP_DOT)
  }
  ctx2.fillStyle = theme.text
  ctx2.font = theme.chipFont
  ctx2.textBaseline = 'middle'
  ctx2.fillText(text, x + CHIP_PAD_L + CHIP_DOT + CHIP_DOT_GAP, y + h / 2 + 0.5)
  ctx2.restore()
}

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

function drawSwimLane(ctx2, width, height, lanes, win, canvas, labels, rowBySession) {
  const style = getComputedStyle(canvas)
  const accent = style.getPropertyValue('--ui-accent').trim() || 'currentColor'
  // Canvas text: lane names and the peak label in the primary text colour,
  // everything else (lane detail, axis, 'of N slots', idle) in the secondary
  // text colour — never the tertiary/quaternary tints, which fall under 4.5:1
  // on the light theme.
  const dim = style.getPropertyValue('--ui-text-secondary').trim() || 'currentColor'
  const stroke = style.getPropertyValue('--ui-stroke-secondary').trim() || 'currentColor'
  const text = style.getPropertyValue('--ui-text-primary').trim() || 'currentColor'
  const localTone = style.getPropertyValue('--ui-green').trim() || '#1f8a65'
  const family = style.fontFamily || 'sans-serif'
  const theme = {
    surface: style.getPropertyValue('--ui-bg-elevated').trim() || style.getPropertyValue('--ui-bg-editor').trim() || '#ffffff',
    text: style.getPropertyValue('--ui-text-primary').trim() || 'currentColor',
    chipFont: `600 ${CHIP_FONT_PX}px ${family}`
  }
  const placed = []
  const chipHits = []

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
  const axisH = SWIM_LANE_AXIS_H
  const top = SWIM_LANE_TOP
  const plotW = Math.max(40, width - gutter - right)
  const xOf = t => gutter + ((Math.max(win.start, Math.min(win.end, t)) - win.start) / win.seconds) * plotW
  const hits = []

  ctx2.clearRect(0, 0, width, height)
  ctx2.textBaseline = 'middle'
  ctx2.textAlign = 'left'

  if (!lanes.length) {
    ctx2.fillStyle = dim
    ctx2.font = '11px sans-serif'
    ctx2.fillText('no local or cloud traffic in this window', gutter, height / 2)
    return hits
  }

  // Fill the canvas with the lanes: the container was sized from each lane's
  // wanted height, so every lane fits; heights scale proportionally. The floor
  // only guards a stale tiny canvas.
  const wants = lanes.map(laneWantHeight)
  const wantTotal = wants.reduce((sum, h) => sum + h, 0) || 1
  const laneScale = (height - top - axisH) / wantTotal
  const laneHs = wants.map(h => Math.max(SWIM_LANE_MIN_LANE_H, h * laneScale))
  // Every lane with per-request rows feeds the palette, so a cloud lane's
  // agent bars get legend colours just like a local lane's.
  const colors = agentColorMap(lanes.filter(lane => (lane.requests || []).length))

  let laneY = top
  for (let li = 0; li < lanes.length; li += 1) {
    const lane = lanes[li]
    const laneH = laneHs[li]
    const y = laneY
    laneY += laneH
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
    const rowGap = SWIM_ROW_GAP
    const rowH = Math.max(3, Math.min(16, (innerH - 8 - rowGap * (peak - 1)) / peak))
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
        ctx2.fillStyle = dim
        ctx2.font = '8px sans-serif'
        ctx2.fillText(String(tick.count), x1, baseY - tickH - 6)
        ctx2.fillStyle = accent
      }
      ctx2.restore()
    } else {
      // Per-request bars, stacked into sub-rows by overlap: rows stacked at any
      // x = concurrent requests at that moment.
      const laneHitStart = hits.length
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

      // Name chips: at most one per agent per lane. In-flight bars go first,
      // right-aligned at the growing edge (a just-started bar lets its chip
      // extend left over the row's own history); a finished bar gets a chip
      // only when the whole chip fits inside it. Chips never overlap.
      if (rowH >= 9) {
        // 12 px text needs an 18 px pill; on thin stacked rows the pill may
        // overhang its bar into the row gaps, never another chip.
        const chipH = rowH >= 12 ? 18 : 16
        const named = new Set()
        const candidates = hits.slice(laneHitStart)
          .map(hit => ({ hit, live: hit.request.ended_at == null }))
          .sort((a, b) => (Number(b.live) - Number(a.live)) || (b.hit.w - a.hit.w))
        ctx2.font = theme.chipFont
        for (const { hit, live } of candidates) {
          const key = agentKey(hit.request)
          if (named.has(key)) continue
          if (!live && hit.w < 48) break
          const row = (rowBySession && rowBySession.get(hit.request.session_id)) ||
            { kind: hit.request.kind, profile: hit.request.profile, session_id: hit.request.session_id }
          const room = live ? Math.min(210, Math.max(80, plotW * 0.4)) : hit.w - 6
          const chipText = truncateText(ctx2, shortAgentLabel(row, labels || {}), room - CHIP_CHROME_W)
          // A stub like 'Depl…' names nothing: a cut label needs a few real
          // characters (more on a finished bar, which is optional anyway).
          const cut = chipText.endsWith('…')
          if (chipText.length < 3 || (cut && chipText.length < (live ? 6 : 10))) continue
          const w = Math.ceil(ctx2.measureText(chipText).width) + CHIP_CHROME_W
          if (w > room + 1) continue
          const x = Math.max(gutter + 2, hit.x + hit.w - 3 - w)
          const chipY = Math.round(Math.max(y + 1, Math.min(y + innerH - chipH - 1, hit.y + hit.h / 2 - chipH / 2)))
          const rect = { x, y: chipY, w, h: chipH }
          const clash = placed.some(p =>
            rect.x < p.x + p.w + 2 && p.x < rect.x + rect.w + 2 && rect.y < p.y + p.h && p.y < rect.y + rect.h)
          if (clash) continue
          placed.push(rect)
          named.add(key)
          drawChip(ctx2, x, chipY, w, chipH, colors.get(key) || accent, chipText, theme)
          chipHits.push({ ...rect, request: hit.request, lane, chip: true })
        }
      }

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
    // Kind dot + kind word in the semantic tone: local green, cloud blue.
    ctx2.fillStyle = lane.kind === 'local' ? localTone : TONE_CLOUD
    ctx2.fillRect(8, y + 7, 6, 6)
    ctx2.font = '600 10px sans-serif'
    ctx2.fillText(truncateText(ctx2, lane.kind, gutter - 28), 19, y + 10)
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
  for (let i = 0; i < 4; i += 1) {
    const x = gutter + (plotW * i) / 4
    ctx2.beginPath()
    ctx2.moveTo(x + 0.5, top)
    ctx2.lineTo(x + 0.5, height - axisH)
    ctx2.stroke()
  }
  // 'now' is the amber edge every in-flight bar grows into.
  ctx2.strokeStyle = TONE_AMBER
  ctx2.globalAlpha = 0.9
  ctx2.lineWidth = 1.5
  ctx2.beginPath()
  ctx2.moveTo(gutter + plotW, top)
  ctx2.lineTo(gutter + plotW, height - axisH)
  ctx2.stroke()
  ctx2.restore()
  ctx2.fillStyle = dim
  ctx2.font = '10px sans-serif'
  ctx2.textBaseline = 'top'
  const marks = [0, 1, 2, 3, 4]
  for (const i of marks) {
    const x = gutter + (plotW * i) / 4
    const offset = win.seconds * (1 - i / 4)
    const label = i === 4 ? 'now' : `-${fmtElapsed(offset)}`
    if (i === 4) {
      ctx2.fillStyle = TONE_AMBER
      ctx2.font = '600 10px sans-serif'
    }
    ctx2.fillText(label, i === 4 ? x - 18 : x + 2, height - axisH + 2)
  }
  ctx2.textBaseline = 'middle'
  // Chips sit on top of bars, so they hit-test first.
  return chipHits.concat(hits)
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
  const rowBySession = useMemo(() => agentRowBySession(snapshot), [snapshot])
  const laneColors = useMemo(
    () => agentColorMap(lanes.filter(lane => (lane.requests || []).length)),
    [lanes]
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
    hitsRef.current = drawSwimLane(ctx2, size.width, size.height, lanes, win, canvas, labels, rowBySession)
  }, [lanes, win, size, labels, rowBySession])

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
    // Same short label as the chips and the By agent rows, so the legend and
    // the tree never read differently. The profile prefix only appears when
    // the chart mixes profiles. Two sessions can still share a title (e.g. two
    // untitled 'default' sessions) — disambiguate with the id tail.
    const seen = new Map()
    const profiles = new Set(entries.map(([key]) => key.split('|')[0]))
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
      // shortAgentLabel prefers the row's own title; the date id is the last resort.
      const base = shortAgentLabel(row, labels || {}) || (session ? `session ${session.slice(0, 8)}` : profile)
      const label = profiles.size > 1 ? `${profile} · ${base}` : base
      const n = (seen.get(label) || 0) + 1
      seen.set(label, n)
      return {
        key,
        color,
        full: fullAgentText(row, labels || {}),
        label: n > 1 && session ? `${label} · ${session.slice(-6)}` : label
      }
    })
  }, [lanes, labels, snapshot])

  const onMove = event => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    // Hit boxes are in canvas space; the canvas sits inside a 4 px padding +
    // 1 px border.
    const cx = x - 5
    const cy = y - 5
    const hit = (hitsRef.current || []).find(item =>
      cx >= item.x - 1 && cx <= item.x + item.w + 1 && cy >= item.y - 1 && cy <= item.y + item.h + 1
    )
    if (hit) {
      if (!hover || hover.request !== hit.request || Math.abs(hover.x - x) > 2 || Math.abs(hover.y - y) > 2) {
        setHover({ x, y, request: hit.request, lane: hit.lane })
      }
    } else if (hover) setHover(null)
  }

  // The hover card: near the pointer, flipped to the left/up when it would
  // run off the panel, clamped inside it horizontally.
  const boxH = swimLaneHeight(lanes)
  const card = (() => {
    if (!hover || !hover.request) return null
    const facts = requestCardFacts(hover.request, labels, snapshot, hover.lane, rowBySession)
    const panelW = size.width + 10 || 600
    const cardH = facts.full ? 168 : 138
    let left = hover.x + 14
    if (left + REQUEST_CARD_W > panelW - 4) left = hover.x - 14 - REQUEST_CARD_W
    left = Math.max(4, Math.min(left, panelW - REQUEST_CARD_W - 4))
    let top = hover.y + 14
    if (top + cardH > boxH + 40) top = hover.y - 14 - cardH
    top = Math.max(4, top)
    return jsx(RequestCard, {
      facts,
      color: laneColors.get(agentKey(hover.request)) || 'var(--ui-accent)',
      text: requestTooltip(hover.request, labels, snapshot, hover.lane),
      left,
      top
    })
  })()

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        ref: wrapRef,
        className: 'relative w-full',
        style: {
          position: 'relative',
          height: `${boxH}px`,
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
          card
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5',
        style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' },
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
              title: entry.full !== entry.label ? entry.full : undefined,
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
// By agent (UI v2) — one card per root agent, not a wide table. A row is
// dot · short name · kind badge on the left, big right-aligned numbers that
// always fit (in flight, requests, tokens in/out) on the right, a muted
// secondary line (source, activity, latency/TTFT p50, errors — each only when
// known) and compact model chips under the name. Subagents nest under their
// parent behind a left rule, at most AGENT_CHILD_LIMIT then '+N more'. The full
// goal / title, session id and per-model breakdown live in the hover card,
// never inline.

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

// Right-hand number columns: fixed widths so the columns line up across every
// row and nested subagent, and so the block's total width is known (≈250 px):
// the name column takes the rest and ellipsises — nothing ever pushes the
// numbers off-screen.
const AGENT_STAT_W = { flight: 72, req: 60, tokens: 92 }
const AGENT_STAT_GAP = 12
const AGENT_CHILD_LIMIT = 4
const AGENT_CARD_W = 340
// Subagent rows sit SUBAGENT_INDENT px in from the parent card's edge behind a
// 2 px rule in the parent's accent colour, on a lighter wash than the card.
// The container's right margin plus the row's right padding equals a parent
// row's right padding, so the number columns stay on the parent's right edge.
const SUBAGENT_INDENT = 20
const SUBAGENT_RULE_W = 2
const SUBAGENT_GUTTER_R = 6
const AGENT_ROW_PAD_R = 10
const SUBAGENT_BG = 'color-mix(in srgb, var(--ui-bg-editor) 62%, transparent)'

function cachedPctOf(node) {
  return node && node.tokens_in ? Math.round(((node.cached_tokens || 0) / node.tokens_in) * 100) : null
}

function tokenPairText(node) {
  if (!node || (node.tokens_in == null && node.tokens_out == null)) return '—'
  return `${fmtTokens(node.tokens_in)}/${fmtTokens(node.tokens_out)}`
}

function agentKindOf(row) {
  return row && (row.kind === 'subagent' || row.kind === 'cron') ? row.kind : 'session'
}

// A model chip's name: a local lane by its server (the swim lane's gutter
// label, so a chip reads against its lane), a cloud lane by its short model.
function modelChipName(model) {
  const label = String((model && model.label) || '')
  if (model && model.local) {
    const server = label.split(' · ')[0].trim()
    if (server) return server
  }
  return modelDisplayName(label || (model && model.lane_id) || 'model')
}

function ModelChip({ model }) {
  const inFlight = model.in_flight || 0
  const tone = model.local ? TONE_LOCAL : TONE_CLOUD
  return jsxs('span', {
    'data-model-row': model.lane_id || model.label || 'model',
    'data-model-local': model.local ? 'local' : 'cloud',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      minWidth: 0,
      maxWidth: '100%',
      height: '18px',
      boxSizing: 'border-box',
      padding: '0 7px',
      borderRadius: '999px',
      border: `1px solid ${inFlight > 0 ? tone : 'var(--ui-stroke-secondary)'}`,
      fontSize: '0.65rem',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      color: 'var(--ui-text-secondary)'
    },
    children: [
      jsx('span', {
        style: { width: '6px', height: '6px', borderRadius: '999px', flex: '0 0 auto', background: tone }
      }),
      jsx('span', {
        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 550 },
        children: modelChipName(model)
      }),
      jsx('span', {
        style: { flex: '0 0 auto', color: 'var(--ui-text-secondary)', fontVariantNumeric: 'tabular-nums' },
        children: `· ${fmtInt(model.requests)} req${inFlight ? ` · ${inFlight} live` : ''}`
      })
    ]
  })
}

function ModelChips({ models }) {
  if (!models || !models.length) return null
  return jsx('div', {
    'data-model-chips': String(models.length),
    style: { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 },
    children: models.map(model => jsx(ModelChip, { model }, model.lane_id || model.label))
  })
}

// The three big numbers. 'idle' (small, muted) instead of a zero in flight.
function AgentNumbers({ node, inFlight, elapsed, compact }) {
  const size = compact ? '0.95rem' : '1.15rem'
  const flightValue = inFlight > 0
    ? jsxs('span', {
        children: [
          String(inFlight),
          elapsed
            ? jsx('span', {
                style: { fontSize: '0.65rem', fontWeight: 500, marginLeft: '4px', color: 'var(--ui-text-secondary)' },
                children: elapsed
              })
            : null
        ]
      })
    : jsx('span', { style: { fontSize: '0.75rem', fontWeight: 500 }, children: 'idle' })
  return jsxs('div', {
    'data-agent-numbers': 'true',
    style: { display: 'flex', alignItems: 'flex-start', gap: `${AGENT_STAT_GAP}px`, flex: '0 0 auto' },
    children: [
      jsx(BigStat, {
        col: 'flight',
        align: 'right',
        width: AGENT_STAT_W.flight,
        size,
        value: flightValue,
        tone: inFlight > 0 ? TONE_LOCAL : 'var(--ui-text-secondary)',
        label: inFlight > 0 && elapsed ? 'in flight · oldest' : 'in flight'
      }),
      jsx(BigStat, {
        col: 'req',
        align: 'right',
        width: AGENT_STAT_W.req,
        size,
        value: fmtInt(node.requests_5m != null ? node.requests_5m : node.requests),
        label: 'requests'
      }),
      jsx(BigStat, {
        col: 'tokens',
        align: 'right',
        width: AGENT_STAT_W.tokens,
        size,
        value: tokenPairText(node),
        label: 'tok in/out'
      })
    ]
  })
}

// The muted line under the name: only parts that are known. Joined with
// middots; one line, ellipsised.
function agentSecondaryParts(row, labels, now, childCount) {
  const parts = []
  if (row.kind === 'subagent' && row.role && row.role !== 'leaf') {
    parts.push(jsx('span', { children: row.role }))
  }
  const source = row.kind === 'subagent' ? '' : (rowSource(row) || (sessionMeta(labels, row.session_id) || {}).source || '')
  if (source) parts.push(jsx('span', { 'data-agent-source': source, children: source }))
  if (childCount) parts.push(jsx('span', { children: plural(childCount, 'subagent') }))
  const activity = row.kind === 'subagent' ? '' : sessionActivity(row, labels, now)
  if (activity) parts.push(jsx('span', { 'data-session-meta': row.session_id, children: activity }))
  if (row.latency_ms_p50 != null) {
    parts.push(jsx('span', { 'data-col': 'lat', children: `latency p50 ${fmtMs(row.latency_ms_p50)}` }))
  }
  if (row.ttft_ms_p50 != null) {
    parts.push(jsx('span', { 'data-col': 'ttft', children: `TTFT p50 ${fmtMs(row.ttft_ms_p50)}` }))
  }
  if ((row.errors_5m || 0) > 0) {
    parts.push(jsx('span', {
      'data-col': 'err',
      style: { color: TONE_QUEUED, fontWeight: 600 },
      children: plural(row.errors_5m, 'error')
    }))
  }
  return parts
}

function SecondaryLine({ parts }) {
  if (!parts || !parts.length) return null
  const children = []
  parts.forEach((part, i) => {
    if (i) children.push(' · ')
    children.push(part)
  })
  return jsxs('div', {
    'data-agent-secondary': 'true',
    style: {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '0.65rem',
      lineHeight: 1.35,
      color: 'var(--ui-text-secondary)'
    },
    children
  })
}

function agentOpener(row) {
  // A stored session opens core-style through the SDK; a subagent's stored row
  // is not a chat the user opened, so it stays inert.
  const openable = row.kind !== 'subagent' && !!row.session_id && typeof host.openSession === 'function'
  if (!openable) return undefined
  return () => {
    try {
      host.openSession(row.session_id, { profile: row.profile })
    } catch {
      // A stale id leaves the row inert; the label still reads.
    }
  }
}

function AgentRow({ row, labels, now, depth, childCount, onHover, hovered, accent }) {
  const inFlight = row.in_flight || 0
  const elapsed = inFlight ? elapsedOf(row.oldest_started_at, now) : null
  const models = Array.isArray(row.models) ? row.models : []
  const short = shortAgentLabel(row, labels)
  const full = fullAgentText(row, labels)
  const kind = agentKindOf(row)
  const open = agentOpener(row)
  const parts = agentSecondaryParts(row, labels, now, childCount)
  const hoverProps = onHover
    ? {
        onMouseEnter: event => onHover(row, event),
        onMouseMove: event => onHover(row, event),
        onMouseLeave: () => onHover(null)
      }
    : {}
  return jsx('div', {
    'data-agent-row': row.session_id || row.profile || 'agent',
    'data-agent-kind': kind,
    'data-agent-depth': depth ? '1' : '0',
    style: depth
      ? {
          minWidth: 0,
          borderLeft: `${SUBAGENT_RULE_W}px solid ${accent || 'var(--ui-accent)'}`,
          borderRadius: '0 6px 6px 0',
          background: SUBAGENT_BG
        }
      : { minWidth: 0 },
    children: jsxs('div', {
      onClick: open,
      onKeyDown: open
        ? event => {
            if (event && (event.key === 'Enter' || event.key === ' ')) {
              if (event.preventDefault) event.preventDefault()
              open()
            }
          }
        : undefined,
      role: open ? 'button' : undefined,
      tabIndex: open ? 0 : undefined,
      'aria-label': open ? `Open ${full}` : full,
      ...hoverProps,
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: `${AGENT_STAT_GAP}px`,
        minWidth: 0,
        padding: depth
          ? `5px ${AGENT_ROW_PAD_R - SUBAGENT_GUTTER_R}px 5px 10px`
          : `9px ${AGENT_ROW_PAD_R}px 8px 10px`,
        borderRadius: depth ? '0 6px 6px 0' : '6px',
        cursor: open ? 'pointer' : 'default',
        background: hovered ? 'var(--ui-row-hover-background)' : 'transparent'
      },
      children: [
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: '1 1 auto' },
          children: [
            jsxs('div', {
              style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
              children: [
                jsx('span', {
                  'aria-hidden': 'true',
                  style: {
                    width: depth ? '6px' : '8px',
                    height: depth ? '6px' : '8px',
                    borderRadius: '999px',
                    flex: '0 0 auto',
                    background: inFlight > 0 ? TONE_LOCAL : 'var(--ui-text-tertiary)',
                    boxShadow: inFlight > 0 ? `0 0 0 3px color-mix(in srgb, ${TONE_LOCAL} 22%, transparent)` : 'none'
                  }
                }),
                jsx('span', {
                  'data-agent-name': short,
                  'data-agent-full': full,
                  style: {
                    minWidth: 0,
                    flex: '0 1 auto',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    // Subagents: 0.95 of the parent's size, one weight step down.
                    fontSize: depth ? `${(0.875 * 0.95).toFixed(4)}rem` : '0.875rem',
                    fontWeight: depth ? 500 : 600,
                    color: inFlight > 0 || !depth ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)'
                  },
                  children: short
                }),
                jsx('span', {
                  'data-agent-badge': kind,
                  style: { flex: '0 0 auto', display: 'inline-flex' },
                  children: jsx(Badge, { variant: kind === 'session' ? 'muted' : 'outline', size: 'xs', children: kind })
                }),
                row.routed
                  ? jsx('span', {
                      style: { flex: '0 1 auto', minWidth: 0, maxWidth: '45%', overflow: 'hidden', display: 'inline-flex' },
                      children: routedChip(row)
                    })
                  : null
              ]
            }),
            jsx(SecondaryLine, { parts }),
            jsx(ModelChips, { models })
          ]
        }),
        jsx(AgentNumbers, { node: row, inFlight, elapsed, compact: !!depth })
      ]
    })
  })
}

// The hover card: everything the row leaves out — the full goal / title, the
// session id, every number, and one line per model.
function agentCardFacts(row, labels, now, parent) {
  const short = shortAgentLabel(row, labels)
  const full = fullAgentText(row, labels)
  const kind = agentKindOf(row)
  const source = row.kind === 'subagent' ? '' : (rowSource(row) || (sessionMeta(labels, row.session_id) || {}).source || '')
  const activity = row.kind === 'subagent' ? '' : sessionActivity(row, labels, now)
  const inFlight = row.in_flight || 0
  const cached = cachedPctOf(row)
  return {
    name: short,
    // The parent link lives only here, in the hover card — never inline.
    parentOf: parent ? `subagent of ${shortAgentLabel(parent, labels)}` : null,
    full: full !== short ? full : null,
    meta: [kind, source, row.session_id, activity].filter(Boolean).join(' · '),
    stats: [
      { label: 'in flight', value: inFlight ? `${inFlight}${row.oldest_started_at != null && elapsedOf(row.oldest_started_at, now) ? ` · ${elapsedOf(row.oldest_started_at, now)}` : ''}` : 'idle' },
      { label: 'requests', value: fmtInt(row.requests_5m) },
      { label: 'errors', value: fmtInt(row.errors_5m || 0) },
      { label: cached ? `tokens in · ${cached}% cached` : 'tokens in', value: fmtTokens(row.tokens_in) },
      { label: 'tokens out', value: fmtTokens(row.tokens_out) },
      { label: 'latency p50', value: fmtMs(row.latency_ms_p50) },
      { label: 'TTFT p50', value: fmtMs(row.ttft_ms_p50) }
    ],
    models: (Array.isArray(row.models) ? row.models : []).map(model => ({
      key: model.lane_id || model.label,
      local: !!model.local,
      name: modelChipName(model),
      full: model.label || model.lane_id || 'model',
      line: [
        `${fmtInt(model.requests)} req`,
        model.in_flight ? `${model.in_flight} in flight` : null,
        `${tokenPairText(model)} tok`,
        model.latency_ms_p50 != null ? `p50 ${fmtMs(model.latency_ms_p50)}` : null,
        model.ttft_ms_p50 != null ? `TTFT ${fmtMs(model.ttft_ms_p50)}` : null,
        (model.errors_5m || 0) > 0 ? plural(model.errors_5m, 'error') : null
      ].filter(Boolean).join(' · ')
    })),
    hint: agentOpener(row) ? 'click to open the session' : null
  }
}

function AgentCard({ facts, left, top, above, width }) {
  return jsxs('div', {
    role: 'tooltip',
    'data-agent-card': facts.name,
    style: {
      position: 'absolute',
      zIndex: 20,
      pointerEvents: 'none',
      left: `${left}px`,
      top: `${top}px`,
      transform: above ? 'translateY(-100%)' : undefined,
      width: `${width}px`,
      boxSizing: 'border-box',
      padding: '10px 12px',
      borderRadius: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      background: 'var(--ui-bg-elevated, var(--ui-bg-editor))',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
        children: [
          jsx('span', {
            style: {
              fontSize: '0.8125rem', fontWeight: 650, color: 'var(--ui-text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            },
            children: facts.name
          }),
          facts.parentOf
            ? jsx('span', {
                'data-agent-card-parent': 'true',
                style: {
                  fontSize: '0.625rem', fontWeight: 500, color: 'var(--ui-text-secondary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                },
                children: facts.parentOf
              })
            : null,
          jsx('span', {
            style: {
              fontSize: '0.625rem', color: 'var(--ui-text-secondary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            },
            children: facts.meta
          })
        ]
      }),
      facts.full
        ? jsx('span', {
            'data-agent-card-full': 'true',
            style: {
              fontSize: '0.7rem', lineHeight: 1.4, color: 'var(--ui-text-secondary)',
              display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              overflowWrap: 'anywhere'
            },
            children: facts.full
          })
        : null,
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: '10px', rowGap: '6px' },
        children: facts.stats.map(stat => jsx(BigStat, { value: stat.value, label: stat.label, size: '0.9rem' }, stat.label))
      }),
      facts.models.length
        ? jsx('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: '3px',
              borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: '6px'
            },
            children: facts.models.map(model =>
              jsxs('div', {
                'data-card-model': model.key,
                style: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0, fontSize: '0.65rem' },
                children: [
                  jsx('span', {
                    style: {
                      width: '6px', height: '6px', borderRadius: '999px', flex: '0 0 auto', alignSelf: 'center',
                      background: model.local ? TONE_LOCAL : TONE_CLOUD
                    }
                  }),
                  jsx('span', {
                    style: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--ui-text-secondary)' },
                    children: model.name
                  }),
                  jsx('span', {
                    style: { flex: '0 0 auto', color: 'var(--ui-text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
                    children: model.line
                  })
                ]
              }, model.key)
            )
          })
        : null,
      facts.hint
        ? jsx('span', { style: { fontSize: '0.6rem', color: 'var(--ui-text-secondary)' }, children: facts.hint })
        : null
    ]
  })
}

// The profile summary above its cards: totals in the same number columns and
// the profile's model chips (the old MIX bar, as words).
function ProfileRow({ profile, roots }) {
  const sum = key => roots.reduce((total, row) => total + (row[key] || 0), 0)
  const subagents = roots.reduce((total, row) => total + ((row.children || []).length), 0)
  const totals = {
    requests_5m: sum('requests_5m'),
    tokens_in: sum('tokens_in'),
    tokens_out: sum('tokens_out'),
    cached_tokens: sum('cached_tokens')
  }
  const inFlight = sum('in_flight')
  const errors = sum('errors_5m')
  const models = aggregateModels(roots)
  const parts = [jsx('span', { children: plural(roots.length, 'session') })]
  if (subagents) parts.push(jsx('span', { children: plural(subagents, 'subagent') }))
  if (errors > 0) {
    parts.push(jsx('span', { 'data-col': 'err', style: { color: TONE_QUEUED, fontWeight: 600 }, children: plural(errors, 'error') }))
  }
  return jsx('div', {
    'data-agent-row': `profile:${profile}`,
    'data-agent-kind': 'profile',
    style: { minWidth: 0 },
    children: jsxs('div', {
      'aria-label': `${profile} · ${plural(roots.length, 'session')}`,
      style: { display: 'flex', alignItems: 'flex-start', gap: `${AGENT_STAT_GAP}px`, minWidth: 0, padding: '2px 11px 4px 11px' },
      children: [
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: '1 1 auto' },
          children: [
            jsxs('div', {
              style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
              children: [
                jsx('span', {
                  'aria-hidden': 'true',
                  style: { width: '8px', height: '8px', borderRadius: '2px', flex: '0 0 auto', background: profileTone(profile) }
                }),
                jsx('span', {
                  'data-agent-name': profile,
                  style: kickerStyle({ fontSize: '0.65rem', color: 'var(--ui-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }),
                  children: profile
                }),
                jsx('span', {
                  'data-agent-badge': 'profile',
                  style: { flex: '0 0 auto', display: 'inline-flex' },
                  children: jsx(Badge, { variant: 'outline', size: 'xs', children: 'profile' })
                })
              ]
            }),
            jsx(SecondaryLine, { parts }),
            jsx(ModelChips, { models })
          ]
        }),
        jsx(AgentNumbers, { node: totals, inFlight, elapsed: null, compact: true })
      ]
    })
  })
}

function AgentTree({ agents, labels, now }) {
  const [hover, setHover] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const boxRef = useRef(null)
  const groups = useMemo(() => {
    const roots = agents.filter(row => !row.parent_session_id)
    const byProfile = new Map()
    for (const root of roots) {
      if (!byProfile.has(root.profile)) byProfile.set(root.profile, [])
      byProfile.get(root.profile).push(root)
    }
    const busyFirst = (a, b) => (b.in_flight || 0) - (a.in_flight || 0) || (b.requests_5m || 0) - (a.requests_5m || 0)
    for (const rows of byProfile.values()) rows.sort(busyFirst)
    return [...byProfile.entries()].map(([profile, rows]) => [
      profile,
      rows.map(root => ({ root, children: [...(root.children || [])].sort(busyFirst) }))
    ])
  }, [agents])

  if (!agents.length) {
    return jsx(EmptyState, {
      title: 'No model traffic in the last 5 minutes.',
      description: 'Rows appear the moment an agent starts talking to a model.',
      className: 'py-10'
    })
  }

  // Row-anchored hover card: under the row (or above it near the bottom of the
  // window), following the pointer horizontally, clamped to the panel.
  const onHover = (row, event) => {
    if (!row) {
      setHover(null)
      return
    }
    const box = boxRef.current
    const target = event && event.currentTarget
    if (!box || !target || typeof target.getBoundingClientRect !== 'function') return
    const b = box.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    const x = (event.clientX != null ? event.clientX : r.left) - b.left
    const viewH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : Infinity
    const above = r.bottom + 260 > viewH && r.top - 260 > 0
    const next = { row, x, top: above ? r.top - b.top - 4 : r.bottom - b.top + 4, above, width: b.width }
    setHover(prev =>
      prev && prev.row === row && prev.above === above && Math.abs(prev.x - x) < 16 ? prev : next)
  }
  const toggle = id => setExpanded(prev => {
    const nextSet = new Set(prev)
    if (nextSet.has(id)) nextSet.delete(id)
    else nextSet.add(id)
    return nextSet
  })

  // child row → its parent row, for the hover card's 'subagent of …' caption.
  const parentByChild = new Map()
  for (const [, entries] of groups) {
    for (const { root, children } of entries) {
      for (const child of children) parentByChild.set(child, root)
    }
  }
  const cardW = hover ? Math.min(AGENT_CARD_W, Math.max(200, hover.width - 8)) : AGENT_CARD_W
  const card = hover
    ? jsx(AgentCard, {
        facts: agentCardFacts(hover.row, labels, now, parentByChild.get(hover.row) || null),
        left: Math.max(0, Math.min(hover.x - 40, hover.width - cardW)),
        top: hover.top,
        above: hover.above,
        width: cardW
      })
    : null

  return jsxs('div', {
    ref: boxRef,
    'data-agent-tree': 'true',
    style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 },
    children: [
      ...groups.map(([profile, entries]) =>
        jsxs(
          'section',
          {
            'data-agent-profile': profile,
            style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
            children: [
              jsx(ProfileRow, { profile, roots: entries.map(entry => entry.root) }),
              ...entries.map(({ root, children }) => {
                const id = root.session_id || root.profile
                const open = expanded.has(id)
                const shown = open ? children : children.slice(0, AGENT_CHILD_LIMIT)
                const hidden = children.length - shown.length
                const live = (root.in_flight || 0) > 0 || children.some(child => (child.in_flight || 0) > 0)
                // The parent's accent: its profile colour, the same tone as the
                // profile marker above the card.
                const accent = profileTone(root.profile)
                return jsxs(
                  'div',
                  {
                    'data-agent-card-row': id,
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      minWidth: 0,
                      borderRadius: '10px',
                      border: '1px solid var(--ui-stroke-secondary)',
                      boxShadow: live ? `inset 3px 0 0 ${TONE_LOCAL}` : 'none',
                      background: 'var(--ui-bg-quinary, transparent)',
                      paddingBottom: children.length ? '8px' : 0
                    },
                    children: [
                      jsx(AgentRow, {
                        row: root,
                        labels,
                        now,
                        childCount: children.length,
                        onHover,
                        hovered: !!hover && hover.row === root
                      }),
                      children.length
                        ? jsxs('div', {
                            'data-subagents': String(children.length),
                            style: {
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '3px',
                              minWidth: 0,
                              marginLeft: `${SUBAGENT_INDENT}px`,
                              marginRight: `${SUBAGENT_GUTTER_R}px`
                            },
                            children: [
                              ...shown.map(child =>
                                jsx(AgentRow, {
                                  row: child,
                                  labels,
                                  now,
                                  depth: true,
                                  accent,
                                  onHover,
                                  hovered: !!hover && hover.row === child
                                }, `${id}-${child.session_id}`)
                              ),
                              hidden > 0 || open
                                ? jsx('button', {
                                    type: 'button',
                                    'data-more-subagents': hidden > 0 ? String(hidden) : 'less',
                                    onClick: () => toggle(id),
                                    style: {
                                      alignSelf: 'flex-start',
                                      margin: '2px 0 0 0',
                                      padding: '1px 8px',
                                      borderRadius: '999px',
                                      border: '1px solid var(--ui-stroke-secondary)',
                                      background: 'transparent',
                                      cursor: 'pointer',
                                      fontSize: '0.65rem',
                                      color: 'var(--ui-text-secondary)'
                                    },
                                    children: hidden > 0 ? `+${hidden} more` : 'show fewer'
                                  })
                                : null
                            ]
                          })
                        : null
                    ]
                  },
                  id
                )
              })
            ]
          },
          profile
        )
      ),
      card
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
// Off and unavailable have nothing to place: one muted line, no card chrome.
function RoutingStrip({ snapshot, now }) {
  const state = routingState(snapshot.routing)
  const decisions = (Array.isArray(snapshot.decisions) ? snapshot.decisions : []).slice(0, 5)
  if (state.label === 'off' || state.label === 'unavailable') {
    return jsx('div', {
      'data-routing-strip': state.label,
      title: state.title,
      className: 'text-[0.625rem] text-(--ui-text-secondary)',
      children: state.label === 'off'
        ? 'Capacity routing: off · places subagents on a local server with free slots when enabled'
        : 'Capacity routing: unavailable · needs a Flightdeck build with capacity.py'
    })
  }
  return jsxs('div', {
    'data-routing-strip': state.label,
    className: 'flex flex-col gap-1 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        title: state.title,
        children: [
          jsx('span', {
            className: 'text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)',
            children: 'Routing'
          }),
          jsx(Badge, { variant: state.tone, size: 'xs', title: state.title, children: state.label }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.625rem] text-(--ui-text-secondary)',
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
                  className: 'shrink-0 tabular-nums text-(--ui-text-secondary)',
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
                  className: 'min-w-0 flex-1 truncate text-(--ui-text-secondary)',
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

function ModelView({ snapshot, labels, now, windowSeconds, onHide, usageMap }) {
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
  // Resolve each cloud card's quota once, then group cards that report the same
  // plan numbers. The card with more windows keeps the full bars (the Fable cap
  // is an extra window, not a second plan); the rest show one shared-plan line.
  const cloudCards = cloud.map(model => ({ model, planUsage: resolveCloudPlanUsage(model, usageMap) }))
  const planGroups = new Map()
  for (const card of cloudCards) {
    const fingerprint = planFingerprint(card.planUsage)
    if (fingerprint == null) continue
    const group = planGroups.get(fingerprint)
    if (group) group.push(card)
    else planGroups.set(fingerprint, [card])
  }
  const sharedPlanByKey = new Map()
  for (const group of planGroups.values()) {
    if (group.length < 2) continue
    let primary = group[0]
    for (const card of group.slice(1)) {
      if (quotaWindowCount(card.planUsage) > quotaWindowCount(primary.planUsage)) primary = card
    }
    for (const card of group) {
      if (card !== primary) sharedPlanByKey.set(card.model.key, primary.model)
    }
  }
  const orphan = models.filter(model => model.lane !== 'cloud' &&
    (model.metrics === 'none' || !model.server_name))
  const activeServers = servers.filter(server => !isQuietServer(server))
  const quietServers = servers.filter(isQuietServer)
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
      servers.length || cloud.length
        ? jsx(Section, {
            label: 'Swim lane',
            meta: `last ${fmtDuration(windowSeconds)} · local lanes first, then cloud`,
            children: jsx(SwimLane, { snapshot, labels, windowSeconds, now })
          })
        : null,
      jsx(Section, {
        label: 'Local servers',
        meta: servers.length
          ? `${servers.length} server${servers.length === 1 ? '' : 's'} · ${used}/${total} slots · ${queued} queued`
          : 'none reachable',
        children: jsxs('div', {
          className: 'flex flex-col gap-2',
          children: [
            servers.length
              ? jsxs('div', {
                  style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
                  children: [
                    // Servers with Hermes traffic get full cards, two-up when
                    // the panel is wide; quiet ones fold to one line below.
                    activeServers.length
                      ? jsx('div', {
                          'data-server-grid': activeServers.length,
                          style: {
                            display: 'grid', gap: '8px', minWidth: 0,
                            gridTemplateColumns: 'repeat(auto-fill, minmax(min(520px, 100%), 1fr))'
                          },
                          children: activeServers.map(server => jsx(ServerCard, {
                            server, models, labels, now, snapshot, windowSeconds
                          }, server.base_url || server.name))
                        })
                      : null,
                    quietServers.length
                      ? jsx('div', {
                          'data-quiet-servers': quietServers.length,
                          style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
                          children: quietServers.map(server => jsx(ServerCard, {
                            server, models, labels, now, snapshot, windowSeconds
                          }, server.base_url || server.name))
                        })
                      : null
                  ]
                })
              : jsx('div', {
                  className: 'rounded-lg border border-dashed border-(--ui-stroke-secondary) px-3 py-4 text-[0.75rem] text-(--ui-text-secondary)',
                  children: noServersText
                }),
            visibleUnreachable.length
              ? jsxs('details', {
                  'data-unreachable-group': visibleUnreachable.length,
                  className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[0.6875rem] text-(--ui-text-secondary)',
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
                                        className: 'ml-2 font-mono text-[0.6rem] text-(--ui-text-secondary)',
                                        children: hostPort
                                      })
                                    : null,
                                  jsx('span', {
                                    className: 'ml-2',
                                    children: unreachableReason(item.error)
                                  }),
                                  down
                                    ? jsx('span', {
                                        className: 'ml-2 tabular-nums text-(--ui-text-secondary)',
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
                  className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[0.6875rem] text-(--ui-text-secondary)',
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
      cloud.length
        ? jsx(Section, {
            label: 'Cloud lanes',
            meta: "only this machine's Hermes requests; providers don't publish server load",
            children: jsx('div', {
              'data-cloud-grid': cloudCards.length,
              style: {
                display: 'grid', gap: '8px', minWidth: 0,
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))'
              },
              children: cloudCards.map(card => jsx(CloudCard, {
                model: card.model, labels, now, windowSeconds, snapshot,
                planUsage: card.planUsage, usageMap,
                sharedWith: sharedPlanByKey.get(card.model.key) || null
              }, card.model.key))
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
        : null,
      jsx(RoutingStrip, { snapshot, now })
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
  const usageMap = useProviderUsage()
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
        className: 'text-[0.6875rem] text-(--ui-text-secondary)',
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
    className: 'flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 text-[0.65rem] text-(--ui-text-secondary)',
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
          : jsx(ModelView, { snapshot, labels, now, windowSeconds, onHide: hideServer, usageMap })
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
