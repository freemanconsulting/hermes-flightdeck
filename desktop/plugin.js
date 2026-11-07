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

// Real plurals: "1 server", "2 servers" — never "2 server(s)".
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function profileTone(name) {
  return profileColor(name) || 'var(--ui-accent)'
}

// A row's display label. Snapshot labels are always ""; sessions resolve from
// session.list, subagents from role + goal, cron runs from the job name.
function agentLabel(row, labels) {
  if (!row) return 'unknown'
  if (row.kind === 'cron') return row.cron_job ? `cron: ${row.cron_job}` : 'cron run'
  if (row.kind === 'subagent') {
    const role = row.role || 'subagent'
    return row.goal ? `${role} · ${row.goal}` : role
  }
  const title = labels[row.session_id]
  if (title) return title
  const id = String(row.session_id || '')
  return id ? `session ${id.slice(0, 8)}` : 'session'
}

function serverVerdict(server) {
  if (!server) return { label: 'unknown', variant: 'outline', tone: 'muted' }
  if (server.error || server.healthy === false) return { label: 'unreachable', variant: 'destructive', tone: 'bad' }
  if (server.slots == null) return { label: 'no slot gauge', variant: 'outline', tone: 'muted' }
  const used = server.running != null ? server.running : 0
  if (server.waiting > 0) return { label: 'queueing', variant: 'warn', tone: 'warn' }
  if (used >= server.slots) return { label: 'saturated', variant: 'warn', tone: 'warn' }
  if (server.slots > 0 && used / server.slots >= 0.5) return { label: 'busy', variant: 'default', tone: 'good' }
  return { label: 'spare', variant: 'success', tone: 'good' }
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
        routes = host.profileRoutes() || []
      } catch {
        routes = []
      }
      const out = {}
      for (const profile of profiles) {
        const route = routes.find(r => r && (r.profile === profile || r.targetProfile === profile || r.name === profile))
        try {
          const res = route
            ? await host.requestProfile(route, 'session.list', {})
            : await host.requestProfile(profile, 'session.list', {})
          const rows = res && Array.isArray(res.sessions) ? res.sessions : []
          for (const session of rows) {
            if (session && session.id) out[session.id] = session.title || ''
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
    return { decode: decode.join(' '), prefill: prefill.join(' '), area: `0,26 ${decode.join(' ')} 100,26` }
  }, [samples])

  if (!series) return null
  return jsxs('svg', {
    viewBox: '0 0 100 26',
    preserveAspectRatio: 'none',
    className: 'h-6 w-full',
    'aria-hidden': 'true',
    children: [
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
}

// Requests per 15 s bucket over the window. Bars, not a gauge: no track, no
// full-width fill, nothing that can read as utilization when nothing is in flight.
function RequestSparkline({ buckets }) {
  const series = useMemo(() => {
    if (!Array.isArray(buckets) || !buckets.length) return null
    const max = Math.max(...buckets, 1)
    const step = 100 / buckets.length
    const width = Math.max(1, step * 0.62)
    return buckets.map((count, i) => ({
      x: i * step + (step - width) / 2,
      width,
      height: Math.max(count > 0 ? 1.5 : 0, (count / max) * 18),
      count
    }))
  }, [buckets])

  if (!series) return null
  return jsxs('svg', {
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
      series.map(bar =>
        jsx('rect', {
          x: bar.x, y: 20 - bar.height, width: bar.width, height: bar.height,
          fill: 'var(--ui-accent)', opacity: bar.count > 0 ? 0.7 : 0
        }, `bucket-${bar.x}`)
      )
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
          wholeResponse
            ? jsx(Metric, {
                label: 'latency p50',
                value: fmtMs(latency),
                title: 'request duration (median) — this server returns whole responses'
              })
            : jsx(Metric, {
                label: 'p50 TTFT',
                value: fmtMs(ttft),
                title: 'time to first token (median)'
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

function CloudCard({ model, labels, now, windowSeconds }) {
  const quotaQ = useQuota(model.provider)
  const quota = quotaLine(quotaQ.data, model.provider)
  const plan = planLine(quotaQ.data)
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
          wholeResponse
            ? jsx(Metric, {
                label: 'latency p50',
                value: fmtMs(model.latency_ms_p50),
                title: 'request duration (median) — this lane returns whole responses'
              })
            : jsx(Metric, {
                label: 'p50 TTFT',
                value: fmtMs(model.ttft_ms_p50),
                title: 'time to first token (median)'
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
            className: 'min-w-0 flex-1 flex flex-col gap-0.5',
            children: [
              jsx('span', {
                className: 'text-[0.6rem] text-(--ui-text-quaternary)',
                children: `requests, last ${fmtDuration(windowSeconds)}`
              }),
              jsx(RequestSparkline, { buckets: model.requests_buckets })
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
                  ? model.agents.map(a => agentLabel(a, labels)).join(' · ')
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
            children: `${model.provider} / ${model.model}`
          }),
          jsx(Badge, { variant: 'outline', size: 'xs', children: 'no server gauge' }),
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
          wholeResponse
            ? jsx(Metric, {
                label: 'latency p50',
                value: fmtMs(model.latency_ms_p50),
                title: 'request duration (median) — this lane returns whole responses'
              })
            : jsx(Metric, {
                label: 'p50 TTFT',
                value: fmtMs(model.ttft_ms_p50),
                title: 'time to first token (median)'
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

function drawSwimLane(ctx2, width, height, servers, windowSeconds, now, canvas, labels) {
  const style = getComputedStyle(canvas)
  const accent = style.getPropertyValue('--ui-accent').trim() || 'currentColor'
  const dim = style.getPropertyValue('--ui-text-quaternary').trim() || 'currentColor'
  const stroke = style.getPropertyValue('--ui-stroke-secondary').trim() || 'currentColor'
  const text = style.getPropertyValue('--ui-text-tertiary').trim() || 'currentColor'

  const gutter = 124
  const axisH = 16
  const top = 4
  const plotW = Math.max(40, width - gutter - 10)
  const nowSec = now / 1000
  const since = nowSec - windowSeconds
  const xOf = t => gutter + ((Math.max(since, Math.min(nowSec, t)) - since) / windowSeconds) * plotW

  ctx2.clearRect(0, 0, width, height)
  ctx2.textBaseline = 'middle'

  const lanes = (Array.isArray(servers) ? servers : []).filter(server => server && server.kind !== 'cloud')
  if (!lanes.length) {
    ctx2.fillStyle = text
    ctx2.font = '11px sans-serif'
    ctx2.fillText('no local servers declared', gutter, height / 2)
    return
  }

  const laneH = Math.max(46, (height - top - axisH) / lanes.length)

  for (let li = 0; li < lanes.length; li += 1) {
    const server = lanes[li]
    const y = top + li * laneH
    const innerH = laneH - 6

    ctx2.fillStyle = 'transparent'
    ctx2.strokeStyle = stroke
    ctx2.lineWidth = 1
    ctx2.strokeRect(gutter + 0.5, y + 0.5, plotW - 1, innerH - 1)

    // Throughput history: decode bright area + line, prefill dim line.
    const samples = Array.isArray(server.samples)
      ? server.samples.filter(s => Array.isArray(s) && s.length >= 3 && s[0] >= since)
      : []
    if (samples.length >= 2) {
      let maxDecode = 0
      let maxPrefill = 0
      for (const s of samples) {
        if (s[1] > maxDecode) maxDecode = s[1]
        if (s[2] > maxPrefill) maxPrefill = s[2]
      }
      const baseY = y + innerH - 4
      const plotH = innerH - 12
      const decodePath = []
      const prefillPath = []
      for (const s of samples) {
        const x = xOf(s[0])
        decodePath.push([x, baseY - (maxDecode > 0 ? (s[1] / maxDecode) * plotH : 0)])
        prefillPath.push([x, baseY - (maxPrefill > 0 ? (s[2] / maxPrefill) * plotH : 0)])
      }
      ctx2.save()
      ctx2.globalAlpha = 0.12
      ctx2.fillStyle = accent
      ctx2.beginPath()
      ctx2.moveTo(decodePath[0][0], baseY)
      for (const point of decodePath) ctx2.lineTo(point[0], point[1])
      ctx2.lineTo(decodePath[decodePath.length - 1][0], baseY)
      ctx2.closePath()
      ctx2.fill()
      ctx2.restore()

      ctx2.save()
      ctx2.globalAlpha = 0.4
      ctx2.strokeStyle = dim
      ctx2.lineWidth = 1
      ctx2.beginPath()
      prefillPath.forEach((point, i) => (i ? ctx2.lineTo(point[0], point[1]) : ctx2.moveTo(point[0], point[1])))
      ctx2.stroke()
      ctx2.restore()

      ctx2.save()
      ctx2.strokeStyle = accent
      ctx2.lineWidth = 1.5
      ctx2.beginPath()
      decodePath.forEach((point, i) => (i ? ctx2.lineTo(point[0], point[1]) : ctx2.moveTo(point[0], point[1])))
      ctx2.stroke()
      ctx2.restore()
    }

    // Per-request bars when the backend ships them; otherwise in-flight agent
    // bars from oldest_started_at.
    const requests = Array.isArray(server.requests) ? server.requests : null
    if (requests && requests.length) {
      const visible = requests
        .filter(r => r && r.started_at != null && (r.ended_at == null || r.ended_at >= since))
        .slice(0, 14)
      visible.forEach((request, ri) => {
        const start = Math.max(since, request.started_at)
        const end = request.ended_at != null ? Math.min(nowSec, request.ended_at) : nowSec
        const x1 = xOf(start)
        const x2 = Math.max(x1 + 2, xOf(end))
        const barY = y + 14 + ri * 9
        const barH = 6
        const color = profileTone(request.profile)
        const split = request.first_chunk_at != null ? xOf(request.first_chunk_at) : x1
        ctx2.save()
        ctx2.globalAlpha = 0.35
        ctx2.fillStyle = color
        ctx2.fillRect(x1, barY, Math.max(1, split - x1), barH)
        ctx2.globalAlpha = 0.9
        ctx2.fillRect(split, barY, Math.max(1, x2 - split), barH)
        ctx2.restore()
      })
    } else {
      const agents = Array.isArray(server.agents)
        ? server.agents.filter(a => a && a.oldest_started_at != null && (a.requests || a.in_flight || 0) > 0).slice(0, 4)
        : []
      agents.forEach((agent, ai) => {
        const start = Math.max(since, agent.oldest_started_at)
        const x1 = xOf(start)
        const x2 = gutter + plotW
        const barY = y + 16 + ai * 15
        const barH = 7
        ctx2.save()
        ctx2.globalAlpha = 0.85
        ctx2.fillStyle = profileTone(agent.profile)
        ctx2.fillRect(x1, barY, Math.max(2, x2 - x1), barH)
        ctx2.restore()
        ctx2.fillStyle = text
        ctx2.font = '10px sans-serif'
        const labelText = `${agentLabel(agent, labels || {})} · ${elapsedOf(agent.oldest_started_at, now) || '—'}`
        const room = gutter + plotW - x1 - 6
        if (room < 90) {
          ctx2.textAlign = 'right'
          ctx2.fillText(truncateText(ctx2, labelText, Math.max(40, x1 - gutter - 6)), x1 - 4, barY - 5)
          ctx2.textAlign = 'left'
        } else {
          ctx2.fillText(truncateText(ctx2, labelText, Math.max(40, room)), x1 + 4, barY - 5)
        }
      })
      if (!agents.length) {
        ctx2.fillStyle = dim
        ctx2.font = '10px sans-serif'
        ctx2.fillText('no in-flight request', gutter + 6, y + 20)
      }
    }

    // Lane label in the gutter.
    ctx2.fillStyle = text
    ctx2.font = '600 11px sans-serif'
    ctx2.fillText(truncateText(ctx2, server.name || 'server', gutter - 14), 8, y + 14)
    ctx2.fillStyle = dim
    ctx2.font = '10px sans-serif'
    ctx2.fillText(
      truncateText(
        ctx2,
        `${server.kind || 'server'} · ${server.running != null ? server.running : '—'}/${server.slots != null ? server.slots : '—'}`,
        gutter - 14
      ),
      8,
      y + 28
    )
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
    const offset = windowSeconds * (1 - i / 4)
    const label = i === 4 ? 'now' : `-${fmtElapsed(offset)}`
    ctx2.fillText(label, i === 4 ? x - 18 : x + 2, height - axisH + 2)
  }
}

function SwimLane({ servers, labels, windowSeconds, now }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

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
    drawSwimLane(ctx2, size.width, size.height, servers, windowSeconds, now, canvas, labels)
  }, [servers, windowSeconds, now, size, labels])

  return jsx('div', {
    ref: wrapRef,
    className: 'h-[190px] w-full rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) p-1',
    children: jsx('canvas', {
      ref: canvasRef,
      className: 'block h-full w-full',
      role: 'img',
      'aria-label': 'Swim-lane timeline: decode and prefill throughput per local server with in-flight agent bars over the selected window'
    })
  })
}

// ---------------------------------------------------------------------------
// By agent — profile → session → subagents and cron runs.

function AgentRow({ row, labels, now, depth }) {
  const inFlight = row.in_flight || 0
  const elapsed = elapsedOf(row.oldest_started_at, now)
  const models = Array.isArray(row.models) ? row.models : []
  return jsxs('div', {
    className: cn(
      'flex items-center gap-2 rounded-[4px] py-1 pr-2 text-[0.75rem] transition-colors',
      depth ? 'ml-5 border-l border-(--ui-stroke-secondary) pl-2' : 'px-2',
      inFlight > 0 ? 'bg-(--ui-row-hover-background)' : 'hover:bg-(--ui-row-hover-background)'
    ),
    children: [
      jsx(StatusDot, {
        tone: inFlight > 0 ? 'good' : 'muted',
        className: cn('size-2 shrink-0', inFlight > 0 && 'animate-pulse')
      }),
      jsx('span', {
        className: cn('min-w-0 truncate', inFlight > 0 ? 'font-medium text-(--ui-text-primary)' : 'text-(--ui-text-secondary)'),
        children: agentLabel(row, labels)
      }),
      row.kind === 'subagent' || row.kind === 'cron'
        ? jsx(Badge, { variant: 'outline', size: 'xs', children: row.kind })
        : null,
      models.length
        ? jsx('span', {
            className: 'hidden min-w-0 truncate font-mono text-[0.6rem] text-(--ui-text-quaternary) sm:inline',
            children: models.join(' · ')
          })
        : null,
      jsx('span', {
        className: 'ml-auto shrink-0 tabular-nums text-(--ui-text-tertiary)',
        children: elapsed || '—'
      }),
      jsx(Badge, {
        variant: inFlight > 0 ? 'success' : 'muted',
        size: 'xs',
        children: `${inFlight} in flight`
      }),
      jsx('span', {
        className: 'w-16 shrink-0 text-right tabular-nums text-(--ui-text-quaternary)',
        children: `${row.requests_5m || 0} req/5m`
      })
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
    children: groups.map(([profile, roots]) => {
      const inFlight = roots.reduce((sum, row) => sum + (row.in_flight || 0), 0)
      const requests = roots.reduce((sum, row) => sum + (row.requests_5m || 0), 0)
      return jsxs(
        'section',
        {
          className: 'flex flex-col gap-1',
          children: [
            jsxs('div', {
              className: 'flex items-center gap-2 px-2',
              children: [
                jsx('span', {
                  className: 'size-2 rounded-full',
                  style: { background: profileTone(profile) }
                }),
                jsx('span', {
                  className: 'text-[0.75rem] font-semibold text-(--ui-text-primary)',
                  children: profile
                }),
                jsx('span', {
                  className: 'text-[0.65rem] tabular-nums text-(--ui-text-quaternary)',
                  children: `${plural(roots.length, 'session')} · ${inFlight} in flight · ${requests} req/5m`
                })
              ]
            }),
            roots.map(root =>
              jsxs(
                'div',
                {
                  className: 'flex flex-col gap-0.5',
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
  })
}

// ---------------------------------------------------------------------------
// Page.

function ModelView({ snapshot, labels, now, windowSeconds }) {
  // A declared cloud endpoint is a lane, not a local server: it has no gauge
  // and belongs in the cloud cards, never in the local capacity section.
  const servers = (Array.isArray(snapshot.servers) ? snapshot.servers : []).filter(
    server => server && server.kind !== 'cloud'
  )
  const models = Array.isArray(snapshot.models) ? snapshot.models : []
  const unreachable = Array.isArray(snapshot.unreachable) ? snapshot.unreachable : []
  const source = snapshot.servers_source || 'none'
  const cloud = models.filter(model => model.lane === 'cloud')
  const orphan = models.filter(model => model.lane !== 'cloud' && !model.server_name)
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
    return jsx(EmptyState, {
      title: unreachable.length
        ? 'No local servers reachable.'
        : source === 'discovered'
          ? 'No local model servers found.'
          : 'No model traffic in the last 5 minutes.',
      description: noServersText || 'Declare a model server in Settings → Plugins, or start a session that calls a model.',
      className: 'py-10'
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-4',
    children: [
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
            unreachable.length
              ? jsxs('details', {
                  className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                  children: [
                    jsx('summary', {
                      className: 'cursor-pointer select-none',
                      children: `${unreachable.length} server${unreachable.length === 1 ? '' : 's'} unreachable`
                    }),
                    jsx('div', {
                      className: 'flex flex-col gap-0.5 pt-1',
                      children: unreachable.map(item =>
                        jsxs('div', {
                          className: 'flex items-baseline gap-2',
                          children: [
                            jsx('span', {
                              className: 'min-w-0 truncate font-mono text-[0.6rem]',
                              children: item.base_url
                            }),
                            jsx('span', {
                              className: 'min-w-0 flex-1 truncate',
                              children: item.error || 'unreachable'
                            }),
                            item.since != null
                              ? jsx('span', {
                                  className: 'shrink-0 tabular-nums',
                                  children: fmtAgo(item.since, now)
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
      servers.length
        ? jsx(Section, {
            label: 'Swim lane',
            meta: `last ${fmtDuration(windowSeconds)} · decode bright, prefill dim, bars = oldest in-flight request per agent`,
            children: jsx(SwimLane, { servers, labels, windowSeconds, now })
          })
        : null,
      cloud.length
        ? jsx(Section, {
            label: 'Cloud lanes',
            meta: 'Hermes traffic only — hook rows, no server gauge',
            children: jsx('div', {
              className: 'grid gap-2 xl:grid-cols-2',
              children: cloud.map(model => jsx(CloudCard, { model, labels, now, windowSeconds }, model.key))
            })
          })
        : null,
      orphan.length
        ? jsx(Section, {
            label: 'No server',
            meta: 'base_url matches no declared server',
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
      })
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
          : jsx(ModelView, { snapshot, labels, now, windowSeconds })
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
