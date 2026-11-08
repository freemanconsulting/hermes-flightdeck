# Flightdeck — design

**Live air-traffic control for Hermes agents and model servers.** See every agent, subagent and cron job
talking to a model right now, which model and server it is on, and how loaded each model server is —
slots in use, queue, prefill and decode tok/s, time to first token — by agent or by model.

Hackathon deadline 2026-11-11 16:00 CST. Build budget: 2 days, 3 parallel coding workers. This document
is the integration contract: file layout, function signatures, SQL, JSON shapes, and the exact Hermes
surfaces each piece touches, with `file:line` citations. It is not a survey; where the platform cannot do
something, §16 says so instead of designing around it.

Two design directions from Aubrey (2026-11-07) are baked in:

1. **Local model servers are the hero.** Local servers sort first in the By model view, in the status chip
   and in the demo script; the server-capacity card is the first thing on screen.
2. **Cloud lanes appear in the same views**, clearly labelled "Hermes traffic only", with numbers derived
   from hook rows alone (no server gauges). §7.4 says exactly what quota data is reachable and what is not.

---

## 1. What it is, in one screen

```
Flightdeck                                                    By agent | By model    1m | 5m
──────────────────────────────────────────────────────────────────────────────────────────────
 LOCAL SERVERS
 ┌ ds4  tensorfold  healthy ─────────────────────────────────────────────────────────────────┐
 │ slots  ████████░░  3/4    queue 0    decode 42.1 tok/s   prefill 3100 tok/s   p50 TTFT 210ms │
 │ held by: default/session "plugin design" (2, 41s) · default/subagent "metrics adapter" (1, 8s) │
 │ unattributed: 0                                                                              │
 │ ▁▂▃▅▇▆▄▃▂  decode sparkline (5m)                                                              │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌ GN100  tensorfold  healthy ───────────────────────────────────────────────────────────────┐
 │ slots  ██████████ 5/5    queue 2    decode 18.4 tok/s   prefill 900 tok/s                  │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
 CLOUD LANES (Hermes traffic only)
 ┌ anthropic / claude-opus-5-5 ──────────────────────────────────────────────────────────────┐
 │ 1 in flight  12 req/min  p50 TTFT 900ms  decode 42 tok/s  0 errors  0 × 429                      │
 │ quota: 42/100 req/min, resets in 37s (live session)                                          │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

Status chip: `ds4 3/4 · GN100 5/5 · 2 queued`. Agent tool: `fleet_status` returns the same numbers as JSON
so an agent (or Gerard) can pick a lane with spare capacity.

---

## 2. Platform facts we rely on (and where they are)

| Surface | What it gives us | Citation |
|---|---|---|
| `pre_api_request` hook | `session_id`, `task_id`, `turn_id`, `api_request_id`, `platform`, `model`, `provider`, `base_url`, `api_mode`, `api_call_count`, `retry_count`, `message_count`, `tool_count`, `approx_input_tokens`, `max_tokens`, `started_at` | `agent/turn_api_request.py:60-105`; docs `website/docs/developer-guide/observer-hooks.md:143-150` |
| `post_api_request` hook | same identity + `api_duration`, `ended_at`, **`first_chunk_at`**, `finish_reason`, `response_model`, `usage`, `assistant_content_chars`, `assistant_tool_call_count`, `context_length` | `agent/turn_response_intake.py:66-106` (first chunk at `:93`) |
| `api_request_error` hook | `status_code`, `retry_count`, `max_retries`, `retryable`, `reason`, `error={type,message}`, `ended_at` | `agent/api_request_hooks.py:163-198` |
| `pre/post_auxiliary_call` | distinct events for titling, compression, MoA, vision, plugin side questions; carry `aux_task`, `api_request_id`, `retry_count`, `model`, `provider`, `base_url`, `started_at`, `usage`, `finish_reason` | `agent/auxiliary_hooks.py:1-10, 95-118, 143-185` |
| `subagent_start` / `subagent_stop` | `parent_session_id`, `parent_turn_id`, `parent_subagent_id`, `child_session_id`, `child_subagent_id`, `child_role`, `child_goal`; stop adds `child_summary`, `duration_ms`, `status` | `tools/delegate_tool.py:353-362`; docs `observer-hooks.md:230-251` |
| `ctx.current_cron_execution()` | `job_id`, `job_name`, `execution_id`, `source`, `scheduled_instant`, `started_at`, `profile` — from any hook fired inside a cron run | `website/docs/developer-guide/plugins/index.md:1936-1958` |
| `ctx.register_hook(name, callback)` | observer registration | `hermes_cli/plugins.py:935-937` |
| `ctx.register_tool(name, toolset, schema, handler, …)` | agent tool | `hermes_cli/plugins.py:463-500`; schema shape `plugins/index.md:741-796` |
| `ctx.register_command(name, handler, description)` | slash command | `plugins/index.md:1756-1830` |
| `ctx.get_config(key, default)` | plugin settings under `plugins.entries.flightdeck.settings` | `hermes_cli/plugins.py:266-276` |
| `load_config_readonly()` | the profile's whole config (for provider auto-discovery) | `plugins/index.md:1054`; `hermes_cli/plugins.py:270` |
| `plugin_data_dir(name)` / `plugin_db(name)` | `<hermes home>/plugin-data/<name>/`, WAL SQLite | `plugins/plugin_storage.py:27-46`; docs `plugins/index.md:1153-1173` |
| `get_default_hermes_root()` | machine-wide root (`~/.hermes`) regardless of active profile — the shared-store anchor | `hermes_constants.py:302` |
| `profile_name_for_home(get_hermes_home())` | profile id of the process firing the hook | `hermes_constants.py:361, 194` |
| Desktop `ROUTES_AREA`, `SIDEBAR_NAV_AREA`, `STATUSBAR_AREAS`, `PALETTE_AREA` | page, nav row, chip, ⌘K command | `website/docs/developer-guide/desktop-plugin-sdk.md:235-255, 297-338, 359-387` |
| `ctx.rest` / `ctx.socket` | REST to `/api/plugins/flightdeck/` | `desktop-plugin-sdk.md:63-64, 2323-2355` |
| `useQuery`, `queryClient` | polling with dedupe/cache | `desktop-plugin-sdk.md:2067-2095` |
| UI kit + `var(--ui-*)` | native components and theme vars | `desktop-plugin-sdk.md:2097-2122, 2483-2494` |
| `dashboard/manifest.json` + `plugin_api.py` | Python backend mounted at `/api/plugins/<id>/` | `desktop-plugin-sdk.md:2124-2265` |
| `broadcast_plugin_event` | push to the desktop half (cut line, §9.3) | `desktop-plugin-sdk.md:2277-2321` |
| `session.list` RPC | session titles for tree labels (public RPC, no DB read) | `tui_gateway/contracts/sessions.py:221-249` |
| `session.stats` RPC | live session `rate_limit` buckets + `plan_gauge` | `tui_gateway/contracts/canonical.py:214-245`; `gateway/session_usage.py:53-75` |
| `delegation.status` RPC | live subagent tree (parent id, goal, model, started_at) | `tui_gateway/contracts/billing_delegation_pets.py:398-400` |
| `usage.bars` RPC | plan/topup dollar bars (subscription route) | `tui_gateway/contracts/billing_delegation_pets.py:55-74` |
| `hermes plugins validate` | capability probe, security scan, desktop surface lint | `hermes_cli/plugin_validate.py:407-458, 621-635`; `hermes_cli/plugin_validate_desktop.py:20-46` |

Prior art, studied and **not copied**: `bot-activity` (`plugin-catalog/bot-activity.yaml`) is the closest
shape — hooks in every profile writing one shared SQLite under `<root>/plugin-data/<name>/`, a bounded
writer queue, retention, and a Desktop page. Its store anchors the shared root at
`get_default_hermes_root() / "plugin-data" / PLUGIN_ID / DB_FILENAME` (`store.py:88-93`), opens WAL
(`store.py:104`), writes batches inside `BEGIN IMMEDIATE` (`store.py:375-378`), and prunes on a timer
(`store.py:232-239, 396-410`). Its `dashboard/plugin_api.py` loads plugin-root modules by path with
`_load_sibling()` because the dashboard mount imports that file standalone (`plugin_api.py:26-40`). We
adopt the *patterns* (shared root, WAL, `BEGIN IMMEDIATE`, path-loaded siblings, explicit stale-row
closure) and none of the code.

---

## 3. Repo layout

```
hermes-flightdeck/                 # the plugin directory; folder name == plugin id
├── plugin.yaml                    # manifest v2 (§4.1)
├── __init__.py                    # register(ctx): hooks, tool, slash command — nothing else
├── store.py                       # shared SQLite: schema, upserts, queries, sweeper (§5)
├── hooks.py                       # hook callbacks → store ops; profile/cron/subagent attribution (§6)
├── config.py                      # server declarations + auto-discovery from providers (§7.1-7.2)
├── servers.py                     # brief 02: probe()/normalize()/detect_kind()/token_rate() — stdlib only
├── poller.py                      # TTL cache + asyncio.to_thread probe fan-out (§7.3)
├── api.py                         # build_snapshot()/build_agents()/build_models()/fleet_status_text()
├── schemas.py                     # fleet_status tool schema
├── tools.py                       # fleet_status handler (JSON string)
├── dashboard/
│   ├── manifest.json              # {"name": "flightdeck", "api": "plugin_api.py"}
│   └── plugin_api.py              # FastAPI router; thin: parse params, call api.py
├── desktop/
│   └── plugin.js                  # page, nav, chip, palette; no JSX, SDK imports only (§10)
├── docs/
│   ├── DESIGN.md                  # this file
│   ├── METRICS.md                 # brief 02
│   ├── snapshot.example.json      # generated by tests/make_example.py — the UI worker's fixture
│   └── screenshots/
├── tests/
│   ├── conftest.py                # puts the repo root on sys.path
│   ├── fixtures/servers/<kind>/…  # brief 02
│   ├── test_servers.py            # brief 02
│   ├── test_store.py              # schema, upsert, stale closure, sweep, retention
│   ├── test_hooks.py              # hook kwargs → rows (fixture payloads from real call sites)
│   ├── test_api.py                # seeded DB → snapshot JSON shape and numbers
│   ├── make_example.py            # seeded temp DB → docs/snapshot.example.json
│   └── smoke_live.py              # optional: probe real servers, skip when absent
└── README.md                      # disclosure (§11.2)
```

**Module layout is flat on purpose.** The plugin loader auto-execs root-level `*.py` siblings as
`<plugin module>.<stem>` and sets them as attributes on the root module
(`plugins/plugin_loader.py:210-227`), so `from . import store` works everywhere inside the plugin and
`dashboard/plugin_api.py` uses the prior-art `_load_sibling("api.py")` path loader. A subpackage
directory would work only through relative imports and would break the standalone dashboard import.
**Integration note:** brief 02 writes `flightdeck/servers.py`; it lands at the plugin root as
`servers.py` (`git mv flightdeck/servers.py servers.py`, then `tests/test_servers.py` imports `servers`
instead of `flightdeck.servers`). Five minutes, done by worker B at integration.

---

## 4. Manifest and registration

### 4.1 `plugin.yaml`

```yaml
name: flightdeck
version: 0.1.0
manifest_version: 2
api_version: 1
description: Live air-traffic control for Hermes agents and model servers — every in-flight request,
  which agent holds it, and how loaded each local model server is.
author: freemanconsulting
license: MIT
homepage: https://github.com/freemanconsulting/hermes-flightdeck
tags: [observability, models, desktop, local-llm, fleet]
requires_hermes: ">=0.21.6"          # hooks exist; current release is v0.23.0 (git describe)
provides_hooks:
  - pre_api_request
  - post_api_request
  - api_request_error
  - pre_auxiliary_call
  - post_auxiliary_call
  - subagent_start
  - subagent_stop
provides_tools:
  - fleet_status
provides_middleware: []
requires_env: []
config_schema:
  servers:
    type: list
    default: []
    label: Model servers
    description: "JSON list of {name, base_url, kind}. kind: auto|tensorfold|vllm|sglang|llamacpp|ollama|openai|cloud. Empty = auto-discover from this profile's providers (loopback/private only)."
  poll_interval_seconds: {type: int, default: 5, label: Poll interval, description: "Seconds between probes of one server. Minimum 2."}
  probe_timeout_seconds: {type: float, default: 2.0, label: Probe timeout}
  stale_after_seconds: {type: int, default: 300, label: Abandoned after, description: "An in-flight row older than this is marked abandoned (a late post_api_request reopens it)."}
  retention_hours: {type: int, default: 24, label: Raw retention (hours)}
  rollup_days: {type: int, default: 7, label: Rollup retention (days)}
  show_cloud: {type: bool, default: true, label: Show cloud lanes}
  show_chip: {type: bool, default: true, label: Show the status-bar chip}
  show_quota: {type: bool, default: true, label: Show quota on cloud cards}
```

`config_schema` is validated at load and drives the Desktop settings form; `list` renders as a JSON
editor, so the server list needs no custom settings page (`plugins/index.md:990-1055`,
`hermes_cli/plugin_validate.py:131-161`). Every key is read with `ctx.get_config(key, default)`.

### 4.2 `dashboard/manifest.json`

```json
{"name": "flightdeck", "api": "plugin_api.py"}
```

Mounted at `/api/plugins/flightdeck/`; the Python half imports only when the plugin is in
`plugins.enabled` in that profile's `config.yaml` (`desktop-plugin-sdk.md:2268-2275`).

### 4.3 `__init__.py`

```python
def register(ctx) -> None:
    settings = config.load(ctx)          # servers, intervals, retention — plain dicts
    conn = store.open_store()            # shared DB; WAL; busy_timeout=2000
    store.close_own_stale(conn)          # rows from this pid that a crash left in-flight
    hooks.register_all(ctx, conn, settings)   # 7 register_hook calls, exactly the declared list
    ctx.register_tool("fleet_status", "flightdeck", schemas.FLEET_STATUS,
                      tools.fleet_status, description="Live fleet capacity and in-flight requests")
    ctx.register_command("fleet", handler=tools.fleet_text, description="Fleet capacity and in-flight requests")
```

`register()` must stay cheap and side-effect-free beyond opening the DB: the admission capability probe
runs it in isolation and diffs registrations against `provides_*` (`plugin_validate.py:407-458`). No
gateway, no network, no threads at registration. Hooks are observer-only and wrapped fail-open
(`observer-hooks.md:54-55, 271-283`).

---

## 5. Request-event store

One SQLite file, **one per machine**, shared by every profile:
`get_default_hermes_root() / "plugin-data" / "flightdeck" / "requests.db"` (`hermes_constants.py:302`).
Per-profile data dirs (`plugin_data_dir`) are deliberately *not* used for the event store — the whole
point is one fleet view across profiles. Settings stay per-profile in `config.yaml`.

Opened with `PRAGMA journal_mode=WAL`, `busy_timeout=2000`, `check_same_thread=False`. Writers use
`BEGIN IMMEDIATE` for the upsert; readers never hold a transaction open.

### 5.1 Schema

```sql
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,       -- profile|pid|api_request_id  (or profile|pid|aux|api_request_id)
  schema_version INTEGER NOT NULL DEFAULT 1,
  kind          TEXT NOT NULL,          -- 'main' | 'aux'
  profile       TEXT NOT NULL,
  pid           INTEGER NOT NULL,
  host          TEXT NOT NULL,
  session_id    TEXT, task_id TEXT, turn_id TEXT, api_request_id TEXT,
  api_call_count INTEGER, retry_count INTEGER,
  aux_task      TEXT,                   -- 'compression' | 'titling' | 'vision' | 'plugin_side_question' | …
  platform      TEXT, model TEXT, provider TEXT, base_url TEXT, api_mode TEXT,
  cron_job_id   TEXT, cron_job_name TEXT, cron_execution_id TEXT,
  parent_session_id TEXT,               -- from subagent_links at insert time
  subagent_id   TEXT, subagent_role TEXT,
  started_at    REAL NOT NULL, first_chunk_at REAL, ended_at REAL,
  status        TEXT NOT NULL,          -- 'in-flight' | 'done' | 'error' | 'abandoned'
  finish_reason TEXT, status_code INTEGER, error_type TEXT, error_message TEXT,  -- clipped 500 chars
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER,
  reasoning_tokens INTEGER, total_tokens INTEGER,
  message_count INTEGER, approx_input_tokens INTEGER, max_tokens INTEGER,
  assistant_content_chars INTEGER, assistant_tool_call_count INTEGER, context_length INTEGER,
  updated_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_req_started ON requests(started_at);
CREATE INDEX IF NOT EXISTS ix_req_status  ON requests(status, started_at);
CREATE INDEX IF NOT EXISTS ix_req_base    ON requests(base_url, started_at);
CREATE INDEX IF NOT EXISTS ix_req_session ON requests(session_id, started_at);
CREATE INDEX IF NOT EXISTS ix_req_model   ON requests(model, provider, started_at);

CREATE TABLE IF NOT EXISTS subagent_links (
  child_session_id TEXT PRIMARY KEY, parent_session_id TEXT, parent_turn_id TEXT,
  subagent_id TEXT, role TEXT, goal TEXT,        -- goal clipped 300 chars
  started_at REAL, stopped_at REAL,
  status TEXT                                    -- 'running' | 'done' | 'failed' | 'interrupted'
);

CREATE TABLE IF NOT EXISTS server_samples (     -- one row per server per poll, 24h retention
  ts REAL NOT NULL, base_url TEXT NOT NULL, name TEXT, kind TEXT,
  healthy INTEGER, running INTEGER, waiting INTEGER, slots INTEGER,
  decode_tps REAL, prefill_tps REAL, error TEXT,
  PRIMARY KEY (ts, base_url)
);

CREATE TABLE IF NOT EXISTS rollups_minute (      -- 7d retention
  bucket_ts INTEGER NOT NULL, profile TEXT NOT NULL, model TEXT NOT NULL,
  provider TEXT, base_url TEXT, kind TEXT,
  requests INTEGER, errors INTEGER, errors_429 INTEGER,
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
  ttft_sum_ms REAL, ttft_count INTEGER, decode_ms_sum REAL, decode_ms_count INTEGER,
  completion_sum INTEGER,
  PRIMARY KEY (bucket_ts, profile, model, provider, base_url)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version, last_sweep
```

### 5.2 One row per LLM request

| Hook | Store op | Row effect |
|---|---|---|
| `pre_api_request` | `record_pre` | `INSERT … ON CONFLICT(id) DO UPDATE`: `status='in-flight'`, `started_at`, identity/runtime fields, `message_count`, `approx_input_tokens`, `max_tokens` |
| `post_api_request` | `record_post` | update `status='done'`, `ended_at`, `first_chunk_at`, `finish_reason`, `usage` buckets, `assistant_content_chars`, `assistant_tool_call_count`, `context_length` |
| `api_request_error` | `record_error` | update `status='error'`, `ended_at`, `status_code`, `error_type`, `error_message`, `retry_count`, `retryable` |
| `pre_auxiliary_call` | `record_aux_pre` | `kind='aux'`, `aux_task`, identity/runtime, `started_at`, `status='in-flight'` |
| `post_auxiliary_call` | `record_aux_post` | `status='done'` or `'error'`, `ended_at`, `usage` (may be null — streaming), `finish_reason` |
| `subagent_start` | `record_subagent_start` | row in `subagent_links` |
| `subagent_stop` | `record_subagent_stop` | `stopped_at`, `status` |

Row id is `f"{profile}|{pid}|{api_request_id}"` (`|aux|` for auxiliary) — `api_request_id` is opaque and
must not be parsed (`observer-hooks.md:80, 87-88`); `pid` keeps two processes from colliding on a reused
id. Usage field mapping from `CanonicalUsage` (`agent/usage_pricing.py:65-73`):
`prompt_tokens=input_tokens`, `cached_tokens=cache_read_tokens`, `completion_tokens=output_tokens`,
`reasoning_tokens=reasoning_tokens`, `total_tokens=total_tokens`.

Writes are **synchronous and direct**, no writer thread: these hooks fire once per provider attempt, not
per token, and a WAL upsert is sub-millisecond. Gate: if measured p95 hook callback time exceeds 5 ms in
`tests/test_hooks.py` on a seeded 10k-row DB, add a bounded queue + daemon writer (bot-activity's shape,
`store.py:254-271, 396-410`). Cut line, not v1.

### 5.3 In-flight rows and crashed processes

An in-flight request is a row with `status='in-flight'`, `started_at` set, `ended_at` NULL. That is the
only representation; there is no separate table and no in-memory registry, so the Desktop sees the same
truth the store holds and a crashed process leaves evidence rather than a phantom.

Closure, in three layers:

1. **Startup, own pid** — `close_own_stale(conn)` marks `status='abandoned'` for rows with the same
   `host`+`pid` and `started_at < now - 5`, called once in `register()`.
2. **Sweeper, any pid** — `close_stale(conn, stale_after)` marks `status='abandoned'` for every
   `status='in-flight'` row with `started_at < now - stale_after` (default 300 s). Runs from the backend
   at most once per 60 s, guarded by `meta.last_sweep`.
3. **Late arrival** — a `post_api_request` or `api_request_error` after closure overwrites `status` to
   `done`/`error` on the same id. `abandoned` is therefore provisional, and a request that legitimately
   runs longer than `stale_after_seconds` (a 1800 s local generation) shows gray for a while and then
   flips to done. The UI renders abandoned rows gray, never red, and the health line counts them.

## 6. Attribution: subagent → parent, cron run → job, profile and labels

- **Subagent → parent**: `subagent_start` gives `parent_session_id`/`child_session_id`/`child_role`/
  `child_goal` (`tools/delegate_tool.py:353-362`). `record_subagent_start` writes `subagent_links`;
  `record_pre`/`record_aux_pre` look up `session_id` in `subagent_links` and fill `parent_session_id`,
  `subagent_id`, `subagent_role` at insert. The link row exists before the child's first request, so the
  join is always available for in-process delegation. If a child runs in another profile, the link row is
  still in the shared store, so attribution survives. No `state.db` read, no `async_delegations` table.
- **Cron run → job**: `ctx.current_cron_execution()` inside the hook callback returns the frozen
  `CronExecution` for the run (`plugins/index.md:1936-1958`); `hooks.py` copies `job_id`, `job_name`,
  `execution_id` onto every row it writes while that value is non-None. Documented limit: subagents
  spawned by `delegate_task` get `None` (`plugins/index.md:1949`), so a subagent row under a cron run
  carries its parent session but no cron id — the tree shows it under the parent session, which is
  correct, and never guesses a job.
- **Profile**: `profile_name_for_home(get_hermes_home())` at hook time (`hermes_constants.py:361, 194`),
  which honours a `HERMES_HOME` override (multiplexed cron tick, routed gateway turn).
- **Session label**: not in any hook. The Desktop half joins `session.list` per profile via
  `host.requestProfile(route, 'session.list', {})` (`sessions.py:221-249`, `desktop-plugin-sdk.md:1432`)
  and falls back to `session <id[:8]>`. `session.list` denies subagent/kanban sources
  (`sessions.py:248-249`), which is why subagent labels come from `child_goal`/`child_role` instead.

---

## 7. Model servers

### 7.1 Declaring servers

`config_schema.servers` is a JSON list, edited in Settings → Plugins. The lists declared in
every profile are unioned by normalized base_url (first name wins, referencing profiles
recorded); when any profile declares servers they win over auto-discovery:

```json
[
  {"name": "ds4", "base_url": "http://127.0.0.1:18010", "kind": "auto"},
  {"name": "GN100", "base_url": "http://127.0.0.1:18009", "kind": "tensorfold"},
  {"name": "anthropic", "base_url": "https://api.anthropic.com", "kind": "cloud"}
]
```

`kind: auto` runs `detect_kind()` from brief 02 (`servers.py`); `kind: cloud` skips probing entirely and
the card is hook-derived. `base_url` is normalized for matching: strip trailing `/`, strip a trailing
`/v1`, lowercase scheme+host, keep port — so `agent.base_url` (`http://127.0.0.1:18010/v1`) matches the
declared server (`http://127.0.0.1:18010`).

### 7.2 Zero-setup auto-discovery

When `servers` is empty (or `auto_discover: true`), `config.py` reads **every profile's**
`config.yaml` — the root profile's `<hermes root>/config.yaml` and each
`<hermes root>/profiles/*/config.yaml` — with a read-only YAML safe load (never
`load_config_readonly()`, which would touch the active profile's cache), and takes every
`providers.<key>.api` as a base_url. Servers are deduped by normalized base_url: the first
provider key found wins (root first, then profiles in sorted order) and each server records the
profiles that reference it under `profiles` for the UI tooltip. Unreadable files are skipped
silently. Only **loopback and private addresses** are probed by default (`127.0.0.0/8`, `::1`,
`localhost`, RFC1918, `100.64/10`, `.local`, `.tailscale.net`) — probing a cloud endpoint on every
poll is waste and looks like abuse; a public URL must be declared explicitly. Discovery is cached
in `meta` for 60 s so a config read does not run per poll; an empty result is retried after 10 s so
a fixed config shows up quickly.

**Card names.** A card's `name` is a short, stable, human label, never a model id or a URL. Order:
the declared server name; else the provider **key** from config (`studio-ds4`, `gb10-qwen` — short
and unique); else `host:port`. The provider's `name:` field is often long prose, so it rides along
as `title` for the card tooltip only. The served model id(s) live in `models`. A probe result never
overwrites `name` or `title`: the server entry owns both.

**Dead-server noise.** A discovered (not declared) server that is unreachable AND served no request
in the window is not a card: it goes to `snapshot["unreachable"]` as
`{name, base_url, error, since}` (`since` = the last good sample's epoch, else the failed probe's
`sampled_at`). Declared servers always stay in `servers`, reachable or not. `fleet_status` lanes and
`fleet_status_text` skip unreachable servers; the status chip shows healthy local servers only.
`/servers` (`build_servers`) applies the same rule and returns `unreachable` too, so a chip or any
consumer of that endpoint never sees a dead port as a fleet member; the dashboard passes the real
`servers_source`, so a declared server keeps its card.

### 7.3 Polling

`poller.py`:

```python
async def poll(servers: list[dict], *, ttl: float, timeout: float) -> dict[str, dict]
```

Per server: if the cached sample is younger than `ttl` (`poll_interval_seconds`, default 5, floor 2),
return it; else `await asyncio.to_thread(servers.probe, base_url, timeout)` and cache. All servers fan out
with `asyncio.gather`, so N servers cost one poll interval, not N. A per-base_url `asyncio.Lock` prevents
a stampede when two views poll at once. Every sample is written to `server_samples` (one row per server per
poll). `probe()` never raises; transport errors land in `Snapshot.error` and the card shows
"unreachable since <ts>" with the last good sample. No background thread: the poller runs only when a REST
call or the tool asks, which keeps an idle gateway idle.

Brief 02 owns the per-kind parsers, the detection signatures, the live-vs-docs fixture provenance and the
counter-delta rate rule; see `docs/METRICS.md`. The interface we consume is exactly:

```python
Snapshot(name, base_url, kind, healthy, models, running, waiting, slots, decode_tps, prefill_tps,
         prompt_tokens_total, cached_tokens_total, generation_tokens_total, sampled_at, error)
probe(base_url, timeout=2.0) -> Snapshot
detect_kind(responses) -> str          # never returns 'cloud'
token_rate(prev_total, cur_total, seconds) -> float | None
```

`None` means "this kind does not report it" and is never rendered as zero. Counter-only kinds get their
tok/s from two `server_samples` rows via `token_rate()`; the window is `sampled_at` deltas, never the
configured interval (`docs/METRICS.md`, "Rates").

### 7.4 Cloud lanes and quota — what is reachable, and what is not

Cloud lanes (Anthropic, OpenAI/Codex, the Haiku compression route, any provider whose base_url is not a
declared local server) appear in the same By model list, sorted after local servers, labelled
**"Hermes traffic only"**. Their numbers come from hook rows: in-flight count, requests/min, TTFT p50,
output tok/s, tokens, errors and 429s. No server gauges, no slot bar — the card says "no server gauge"
rather than drawing an empty one.

**Quota: hooks cannot see it.** Provider rate-limit headers are parsed into `agent._rate_limit_state`
(`agent/agent_init.py:497`, `agent/rate_limit_tracker.py:89-105`) and are not part of any hook payload —
`post_api_request` carries `usage` and the sanitized response body only (`agent/api_request_hooks.py:142-161`),
and `_usage_summary_for_api_request_hook` normalizes token buckets, nothing else. There is no
`native_usage`/`native_cost` field in any hook payload. So:

- **Per-request quota is not available.** We do not derive it, estimate it, or scrape it.
- **Live-session quota is available through a public RPC**: `session.stats` returns
  `rate_limit = dataclasses.asdict(RateLimitState)` — `requests_min`, `requests_hour`, `tokens_min`,
  `tokens_hour`, each `{limit, remaining, reset_seconds, captured_at}`, plus `provider` and
  `plan_gauge {id,label,used_bp,resets_at_ms}` (`canonical.py:236`, `gateway/session_usage.py:53-75`).
  The Desktop half calls it with `host.request('session.stats', {session_id})` for the focused session
  and shows a quota line on the cloud card **only** when `rate_limit.provider` matches that card's
  provider, labelled `quota: 42/100 req/min, resets in 37s (live session)`. It is a last-captured value,
  not a live gauge, and the label says so.
- **Plan allowance** (`plan_gauge`, the subscription route's usage window) rides the same RPC and is
  shown as `plan: 24.8% used, resets 3h` on the subscription card when present.
- **`usage.bars`** (`billing_delegation_pets.py:55-74`) gives dollar plan/topup bars for the Nous portal;
  it is a v1.1 nicety, not v1 (cut line, §12).

---

## 8. Derived numbers and formulas

All times are epoch seconds; all rates are per second unless labelled.

| Number | Formula | Notes |
|---|---|---|
| In-flight per model | `COUNT(*) WHERE status='in-flight' GROUP BY (model, provider, base_url)` | hook rows only |
| In-flight per agent | same, grouped by `(profile, session_id, parent_session_id, cron_job_id)` | |
| Running / waiting | server gauge (`Snapshot.running`, `.waiting`) | local servers only |
| **Unattributed** | `max(0, running - in_flight_rows_for_base_url)` | the share of server slots no Flightdeck row claims: other profiles without the plugin, other machines, non-Hermes clients. Rendered as a gray row "not observed by Flightdeck". |
| Over-attributed | `max(0, in_flight_rows - running)` | rows the server does not count (queued, or done-but-not-closed); shown as a footnote, not an error |
| TTFT | `first_chunk_at - started_at` (ms) | `None` when `first_chunk_at` is null, or when the row is non-streamed (below) — `auxiliary_hooks.py:143-185` has no first-chunk field |
| Prefill tok/s | `(prompt_tokens - cached_tokens) / TTFT_seconds` | `None` when TTFT ≤ 0 or prompt null; cached prompt is not prefill work |
| **Streamed vs non-streamed** | streamed iff `(ended_at - first_chunk_at) >= 0.25 s` **and** `>= 0.10 × (ended_at - started_at)` | providers that return the whole body at once set `first_chunk_at ≈ ended_at`, so a decode rate there is meaningless; such a row is non-streamed and carries no decode number |
| Decode tok/s | `completion_tokens / (ended_at - first_chunk_at)` over streamed rows only | `None` when no streamed rows; never `completion_tokens / (ended_at - started_at)` labelled decode |
| Latency | `ended_at - started_at` (ms) | the honest number for a non-streamed row; p50/p95 over finished rows, shown in place of TTFT when most rows are non-streamed |
| Requests per 15 s bucket | `COUNT(*) WHERE started_at in [since + 15·i, since + 15·(i+1))` | the cloud card's sparkline; `ceil(window / 15)` buckets, sum equals the window request count |
| Rolling 1m/5m | `COUNT(*) WHERE started_at >= now - 60/300` | rows, not tokens; per model, per agent, per server |
| Error rate | `COUNT(status='error') / COUNT(*)` over the window | 429s counted separately by `status_code=429` |
| Capacity | `slots` (max batch/slots) from the server | `None` for kinds that do not report it; no invented denominator |
| Slot utilization | `running / slots` | only when both are known |
| Queue | `waiting` | unbounded for SGLang (`docs/METRICS.md`) — never shown as a percentage of slots |
| p50/p95 TTFT | sorted TTFT list over the window, `LIMIT 5000` newest rows | bounded query; no percentile SQL extension |
| Cache-hit ratio | `Δ cached_tokens_total / Δ prompt_tokens_total` from two samples | `None` when the prompt delta is 0 |

---

## 9. Backend API

`dashboard/plugin_api.py` is thin: parse, call `api.py`, return. Handlers are plain `def` where they touch
SQLite so FastAPI runs them in its threadpool; the poller path is `async`. All routes are relative to
`/api/plugins/flightdeck/`.

| Route | Returns | Notes |
|---|---|---|
| `GET /snapshot?window=5m` | the full payload below | the page's one call; `window` ∈ `1m`, `5m` |
| `GET /agents?window=5m` | `{agents: [...]}` | By agent only |
| `GET /models?window=5m` | `{models: [...], servers: [...]}` | By model only |
| `GET /servers` | `{servers: [...]}` | chip, no hook join |
| `GET /request/{id}` | one row + derived per-request numbers | hover detail |
| `GET /health` | `{ok, db_path, rows, in_flight, abandoned_5m, last_sweep, servers_declared, servers_probed, errors}` | for the footer and for us |
| `POST /refresh` | `{ok: true, probed: n}` | explicit click only; forces a probe past the TTL |
| `GET /profiles` | `{profiles: [{name, enabled, last_row_at}]}` | **cut line** (§12); reads each profile's `config.yaml` read-only |

### 9.1 Snapshot JSON (pinned — the UI worker builds against this)

```json
{
  "generated_at": 1762540800.123,
  "window": {"seconds": 300, "since": 1762540500.123},
  "totals": {"in_flight": 5, "requests_1m": 18, "requests_5m": 63, "errors_5m": 3},
  "servers_source": "discovered",
  "servers": [
    {
      "name": "ds4", "title": "Studio DeepSeek-V4.1-Flash (M5 Ultra, TensorFold fork)",
      "base_url": "http://127.0.0.1:18010", "kind": "tensorfold",
      "healthy": true, "models": ["qwen38-27b-q4-q8kv-mtp3"],
      "running": 3, "waiting": 0, "slots": 4,
      "decode_tps": 42.1, "prefill_tps": 3100.0,
      "health": {
        "kv_cache_usage": 0.34, "kv_cache_usage_mean": 0.31,
        "prefix_cache_hit_rate": 0.91, "spec_accept_rate": 0.72,
        "server_ttft_p50": 0.82, "server_ttft_p95": 3.1,
        "server_latency_p50": 4.6, "server_latency_p95": 12.4,
        "server_tpot_p50": 0.024,
        "preemptions_total": 2, "preemptions_delta": 0,
        "disconnects_total": 21, "disconnects_delta": 1,
        "memory_bytes": 226966809104, "memory_peak_bytes": 229918256328
      },
      "in_flight": 3, "unattributed": 0, "over_attributed": 0,
      "agents": [{"profile": "default", "session_id": "s1", "label": "", "kind": "session",
                  "model": "qwen38-27b-q4-q8kv-mtp3", "requests": 2, "oldest_started_at": 1762540759.0}],
      "requests": [{"id": "default|4242|r2", "profile": "default", "session_id": "s1",
                    "parent_session_id": null, "kind": "session", "model": "qwen38-27b-q4-q8kv-mtp3",
                    "started_at": 1762540796.0, "first_chunk_at": null, "ended_at": null,
                    "status": "in-flight", "prompt_tokens": null, "cached_tokens": null,
                    "completion_tokens": null}],
      "samples": [[1762540740.0, 40.2, 2900.0], [1762540745.0, 42.1, 3100.0]],
      "error": null, "sampled_at": "2026-11-07T16:00:00Z"
    }
  ],
  "unreachable": [
    {"name": "studio-worker", "base_url": "http://127.0.0.1:18012",
     "error": "/health: URLError ... (connection refused)", "since": 1762540700.0}
  ],
  "idle": [
    {"name": "studio-worker", "title": null, "base_url": "http://127.0.0.1:18012",
     "kind": "tensorfold"}
  ],
  "hidden_servers": ["gb10-qwen"],
  "models": [
    {
      "key": "ds4|qwen38-27b-q4-q8kv-mtp3", "model": "qwen38-27b-q4-q8kv-mtp3",
      "provider": "main-llm", "base_url": "http://127.0.0.1:18008/v1",
      "server_name": "ds4", "kind": "tensorfold", "lane": "local",
      "in_flight": 2, "requests_1m": 12, "requests_5m": 41,
      "errors_5m": 2, "errors_429_5m": 1,
      "streamed": 9, "non_streamed": 1,
      "requests_buckets": [0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 3, 4, 3, 2, 1, 0, 2, 3, 4, 1],
      "ttft_ms_p50": 210.0, "ttft_ms_p95": 900.0,
      "latency_ms_p50": 4200.0, "latency_ms_p95": 12700.0,
      "decode_tps": 42.1, "prefill_tps": 3100.0, "rate_kind": "decode",
      "tokens": {"prompt": 812000, "cached": 640000, "completion": 21000, "reasoning": 0},
      "slots": {"used": 3, "total": 4, "queue": 0},
      "agents": [{"profile": "default", "session_id": "s1", "label": "", "in_flight": 2}],
      "quota": null
    }
  ],
  "agents": [
    {
      "profile": "default", "session_id": "s1", "label": "", "kind": "session",
      "parent_session_id": null, "cron_job": null,
      "in_flight": 1, "requests_5m": 9, "errors_5m": 0,
      "models": [
        {"lane_id": "http://127.0.0.1:18010", "label": "ds4 · qwen38-27b-q4-q8kv-mtp3",
         "local": true, "requests": 5, "in_flight": 2,
         "tokens_in": 18000, "tokens_out": 1200, "cached_tokens": 14000},
        {"lane_id": "cloud:anthropic", "label": "anthropic/claude-opus-5-5",
         "local": false, "requests": 2, "in_flight": 1,
         "tokens_in": 18000, "tokens_out": 900, "cached_tokens": 12000}
      ],
      "oldest_started_at": 1762540759.0,
      "tokens_in": 66000, "tokens_out": 3600, "cached_tokens": 50000,
      "latency_ms_p50": 2000.0, "ttft_ms_p50": 200.0,
      "children": [{"session_id": "s2", "label": "", "kind": "subagent",
                    "role": "general", "goal": "metrics adapters", "in_flight": 1, "requests_5m": 4,
                    "routed": {"action": "move", "lane": "GN100", "requested_lane": "ds4",
                               "reason": "ds4 full 4/4, model qwen38-flash-next-tf-fp4",
                               "model": "qwen38-flash-next-tf-fp4", "at": 1762540790.0}}]
    }
  ],
  "decisions": [
    {"id": 1, "at": 1762540790.0, "action": "move", "task_index": 0,
     "requested_lane": "ds4", "chosen_lane": "GN100",
     "requested_model": "ds4", "chosen_model": "qwen38-flash-next-tf-fp4",
     "reason": "ds4 full 4/4, model qwen38-flash-next-tf-fp4", "stale": false,
     "goal": "metrics adapters",
     "lanes": [{"name": "ds4", "slots": 4, "running": 4, "waiting": 0, "queue": 0, "free": 0, "stale": false},
               {"name": "GN100", "slots": 5, "running": 1, "waiting": 0, "queue": 0, "free": 4, "stale": false}]}
  ],
  "routing": {
    "armed": true, "backend": "flightdeck", "inner_backend": "default",
    "blocked_by": null, "message": "", "eligible_lanes": ["ds4", "GN100"]
  }
}
```

Rules the backend guarantees: `label` is always `""` (the UI fills it from `session.list` /
`child_goal`); `lane` ∈ `local`|`cloud`; `slots` is `null` for cloud and for kinds without a gauge;
`quota` is always `null` from the backend (the UI fills it from `session.stats`); numbers are `null` when
unknown, never `0`-as-unknown. `name` is the short card label (declared name → provider key → host:port);
`title` is `null` or the provider's prose name, for the card tooltip only. `unreachable` is always present
(`[]` when none): discovered servers that are unreachable and served no request in the window, as
`{name, base_url, error, since}` — the UI renders one per row: dot · name · `host:port` · the collapsed
reason (`error` split on `"; "`, one class per endpoint → plain words: "connection reset", "timed out",
"connection refused", "HTTP 404", "host not found"; mixed → first + " (+n more)") · `down <age>` from
`since`, omitted when null — with `min-width:0` + ellipsis so a row never overflows. The raw per-endpoint
`error` lives only in the row `title`, one endpoint per line. Each row has a hide button that appends the
`base_url` to settings `hidden_servers` (same mechanism as the idle group). Declared servers never move there. `servers_source` is
`declared`|`discovered`|`none` — `discovered` even when discovery found nothing, so the UI can tell
"discovery is on and empty" from "nothing declared".

`demo` is always present: `true` only when demo mode served a seeded snapshot, so the UI can badge
it and never mistake it for live traffic. `empty_reason` is always present and `null` whenever the
page has content; otherwise it says why a fresh install is empty — `no_servers_configured` (nothing
declared and discovery found nothing), `servers_unreachable` (servers were probed but none answered
and no request is in the window), or `no_traffic` (reachable server cards, but no Hermes request in
the window and nothing in flight). Agent rows also carry `title`, `source` and `started_at` from the
owning profile's `state.db` `sessions` table (`label` is the title, `""` when there is none), so the
tree labels itself without a `session.list` round-trip; a missing db, table or column leaves those
fields null rather than raising.

`decisions` is always present (`[]` when none): the newest 20 routing decisions inside the
retention window, newest first, each `{id, at, action, task_index, requested_lane, chosen_lane,
requested_model, chosen_model, reason, stale, goal, lanes}` with `lanes` the sampled slots at
decision time. `routing` is always present: `{armed, backend, inner_backend, blocked_by, message,
eligible_lanes}`; `armed` is true only when routing is on, `delegation.backend` is `flightdeck`
and `inner_backend` is `default`. A subagent node carries `routed` (`{action, lane,
requested_lane, reason, model, at}`) only when a decision joins its link by goal within 60 s;
root sessions and cron nodes never do.

`idle` is always present (`[]` when none): discovered **non-cloud** servers with no Hermes request in the
retention window (`retention_hours`, default 24 h) and no running/waiting slot, as
`{name, title, base_url, kind}` — the collapsed "Idle · not used by Hermes" group. Declared servers never
move there; a cloud card never does either. `hidden_servers` echoes the filter the snapshot ran with
(settings `hidden_servers`, or the caller's list): entries match a sample by `name` or by normalized
`base_url`, and a matched sample never becomes a server card, a model card's server metrics, or an
`idle` row. It is always present (`[]` when nothing is hidden), so the UI can show "N hidden" without
guessing. `unreachable` rows honour the same filter client-side (name or normalized `base_url`): a
hidden entry drops that server from the collapsed "N servers unreachable" list **and** from its count.

**Server card names** follow §7.2, including the aux-only rule: an endpoint that appears only in a
profile's `auxiliary` block is named after **the model it serves** (`short_model_name`:
`Qwen3.5-9B.Q6_K.gguf` → `qwen3.5-9b`) or, when it serves no model id, `host:port` — never after the
role key, because `vision` or `compression` is a role, not a server. Such a config entry carries
`aux: true` and `roles: [<role key>, …]`, and its `title` is `helper model for: <roles> · host:port`.
A provider key on the same normalized `base_url` wins: it replaces the aux label and drops `aux`/`roles`
from the merged entry, so `aux` only survives on an endpoint no provider declares. `aux` is a config /
discovery field — a snapshot server card does not carry it (its `name`/`title` already encode the rule).

**`node.models`** is the per-node model breakdown: one chip per model lane the node used in the window,
`{lane_id, label, local, requests, in_flight, tokens_in, tokens_out, cached_tokens}`. `local` means the
lane is **not cloud** — the same rule as a model card's `lane` and `_lane_for`: a server card decides by
`kind`, else a private/loopback `base_url` is local and anything else is cloud. A cloud card existing
does not make its lane local (`api.anthropic.com` is `local: false`). `lane_id` is the normalized
`base_url` for a local lane and `cloud:<provider>` for a cloud lane, so chips merge across sessions and
profile rows; `label` is `<server name> · <model>` (`ds4 · qwen38-27b-q4-q8kv-mtp3`) or
`<provider>/<model>` (`anthropic/claude-opus-5-5`). Counts and tokens are summed over the node's rows
(unknown tokens count as `0`); chips sort by `in_flight` desc, `requests` desc, `label`. The node's own
`tokens_in`/`tokens_out`/`cached_tokens` are the same sums over every row, cloud lanes included, so they
equal the chip sums. A child node carries the same fields as a root node plus `role` and `goal`.

Each model card carries `streamed` / `non_streamed` (finished rows split by the §8 rule), `ttft_ms_p50/p95`
(streamed rows only, `null` when none), `latency_ms_p50/p95` (all finished rows), and `requests_buckets`
(requests per 15 s bucket over the window, `ceil(window/15)` integers summing to the window count). A
non-streamed lane has `decode_tps: null` and the UI shows `latency p50` in place of `TTFT`; there is no
whole-request rate labelled decode.

`requests` (per server card) is the swim-lane's per-request rows: **every in-flight row for that server
plus every row that ended in the last 60 s**, newest first by `started_at`, capped at 50 per server. Each
row is `{id, profile, session_id, parent_session_id, kind, model, started_at, first_chunk_at, ended_at,
status, prompt_tokens, cached_tokens, completion_tokens}`; `kind` ∈ `session`|`subagent`|`cron`; times are
epoch seconds; token counts are `null` when unknown. Cloud model entries carry no `requests` — the swim-lane
draws local servers only (`kind !== "cloud"`), so cloud lanes stay hook-derived cards.

### 9.2 Polling, caching, retention

- Page: `useQuery` with `refetchInterval: 5000`, `staleTime: 4000` — one call per window per view.
- Chip: `refetchInterval: 10000` against `/servers`.
- Quota: `refetchInterval: 15000` against `session.stats`, only when a cloud card is on screen.
- Server probes: TTL `poll_interval_seconds` (5 s) per server; a page poll therefore costs at most one
  probe per server.
- Raw rows: 24 h (`retention_hours`). Per-minute rollups: 7 d (`rollup_days`). Server samples: 24 h.
  Sweeper runs at most once per 60 s from the backend: rollup minutes older than 2 minutes into
  `rollups_minute`, delete raw older than retention, delete rollups older than 7 d, close stale.
- `docs/snapshot.example.json` is generated by `tests/make_example.py` from a seeded temp DB (real rows,
  not hand-written JSON) and is the UI worker's fixture from hour one.

### 9.3 Websocket

Not in v1. `broadcast_plugin_event('flightdeck', 'changed', {...})` after a poll plus
`ctx.socket('/events')` is the cheap upgrade (`desktop-plugin-sdk.md:2277-2321, 2323-2355`), and it is a
cut line, not a requirement: 5 s polling is already live enough for a 90 s demo and never drops.

---

## 10. Desktop UI

`desktop/plugin.js`, disk-loaded uncompiled: `jsx()`/`jsxs()` only, imports limited to
`@hermes/plugin-sdk` and `react/jsx-runtime` (`desktop-plugin-sdk.md:150-155, 2451-2455`). No eval, no
dynamic import, no DOM reach, no webview, no script injection — the admission lint refuses all of them
(`plugin_validate_desktop.py:20-46`). Colors come from `var(--ui-*)` and `getComputedStyle` on canvas
(`desktop-plugin-sdk.md:2116-2122`); no hardcoded colors.

### 10.1 Contributions

```javascript
export default {
  id: 'flightdeck',
  name: 'Flightdeck',
  register(ctx) {
    ctx.registerMany([
      {id:'page', area:ROUTES_AREA, data:{path:'/flightdeck'}, render:()=>jsx(FlightdeckPage,{})},
      {id:'nav',  area:SIDEBAR_NAV_AREA, data:{path:'/flightdeck', label:'Flightdeck', codicon:'pulse'}},
      {id:'open', area:PALETTE_AREA, data:{id:'flightdeck.open', label:'Open Flightdeck',
        keywords:['fleet','models','agents','capacity'], run:()=>host.navigate('/flightdeck')}},
      {id:'chip', area:STATUSBAR_AREAS.right, order:120, render:()=>jsx(FleetChip,{})}
    ])
  }
}
```

### 10.2 By agent

Tree: profile → session → subagents and cron runs, each row live. A row is
`<StatusDot/> <label> <model> <elapsed> <in-flight badge> <5m request count>`; in-flight rows pulse and
show the oldest request's elapsed seconds. Cron nodes are labelled `cron: <job_name>`; subagent nodes
`<role> · <goal>`. Sessions with no stored title show `session <id[:8]>`. Labels resolve client-side:
`host.requestProfile(route, 'session.list', {})` per profile, joined by `session_id`; subagent labels come
from `child_goal`/`child_role` in the snapshot. Empty state: "No model traffic in the last 5 minutes."

### 10.3 By model — local first

Local server cards first, then cloud lanes, then a "no server" section for models whose base_url matches
no declared server (still hook-derived). Each **local** card:

- header: name, kind badge, health dot, `base_url` in mono;
- **slot bar**: `running/slots` filled cells + `waiting` queue count, or "no slot gauge" when `slots` is
  null (Ollama, OpenAI-compatible, llama.cpp without `--slots`);
- live rates: decode and prefill tok/s, p50 TTFT;
- **held by**: one row per in-flight agent (`label`, `elapsed`, `model`), then a gray
  "unattributed: n" row when the server counts more requests than Flightdeck sees;
- decode/prefill sparkline over the last 5 minutes from `samples`.

Each **cloud** card: provider/model header with a `Hermes traffic only` badge, in-flight count,
`req/min`, `p50 TTFT` (or `latency p50` when most rows are non-streamed), `decode` tok/s (`—` when
non-streamed), `input … tok · n% cached`, `output … tok`, errors and 429s, and the quota line from §7.4
when `session.stats` matches. No slot bar and no utilization gauge: the footer is a **requests, last 5m**
sparkline (requests per 15 s bucket from window rows) beside the plain req/min figure, so a quiet lane
never reads as a full bar.

### 10.4 Status chip

`STATUSBAR_AREAS.right`, `order: 120`: `ds4 3/4 · GN100 5/5 · 2 queued`, local servers first, at most
three, then `+N`; with no servers, `fleet 4 in flight`. Click navigates to `/flightdeck`. Hidden when
`show_chip` is false or the plugin is disabled.

### 10.5 The "wow" element — two options, pick one

**Option A (primary): the swim-lane timeline.** A canvas, x = last 60 s, one lane per local server, one
bar per request. Each bar is **split at `first_chunk_at`**: a dim prefill segment and a bright decode
segment, colored by agent (`profileColor`), with in-flight bars growing to the right edge. You can see,
in one glance, which agent is prefill-heavy, which server is queueing, and which request is stuck in
decode. It uses only real row timings and it is the thing a screenshot cannot fake. Canvas needs a
`ResizeObserver` and width/height attributes, not CSS (`desktop-plugin-sdk.md:2464-2465`).

**Option B (fallback): the slot grid.** One square per slot per local server, filled by the agent color
holding it, queue cells outlined beside the grid, cells lighting up as rows arrive. Cheaper to draw and
still pops, but it shows less: no prefill/decode split, no history.

Build A; if the canvas is not working by hour 8 of day 2, ship B. Both are cut-line-managed (§12).

---

## 11. Agent tool and slash command

### 11.1 `fleet_status`

Schema (`schemas.py`): `{"name": "fleet_status", "description": "Live fleet capacity: which model servers
have free slots, what is queued, and which agents are holding them. Use before picking a lane for heavy
work.", "parameters": {"type": "object", "properties": {"window": {"type": "string", "enum": ["1m","5m"],
"default": "5m"}, "include_cloud": {"type": "boolean", "default": true}}}}`.

Handler returns a JSON string (handlers always return JSON, `plugins/index.md:819-838`):

```json
{
  "as_of": "2026-11-07T16:00:00Z",
  "lanes": [
    {"name": "ds4", "kind": "tensorfold", "healthy": true, "lane": "local",
     "slots": {"used": 3, "total": 4}, "queue": 0, "free_slots": 1,
     "decode_tps": 42.1, "prefill_tps": 3100.0, "in_flight": 3, "unattributed": 0,
     "ttft_ms_p50": 210.0, "verdict": "spare"},
    {"name": "GN100", "kind": "tensorfold", "healthy": true, "lane": "local",
     "slots": {"used": 5, "total": 5}, "queue": 2, "free_slots": 0,
     "decode_tps": 18.4, "prefill_tps": 900.0, "in_flight": 5, "unattributed": 0,
     "ttft_ms_p50": 1400.0, "verdict": "saturated"}
  ],
  "cloud": [
    {"provider": "anthropic", "model": "claude-opus-5-5", "in_flight": 1, "requests_5m": 4,
     "errors_429_5m": 0, "ttft_ms_p50": 900.0, "verdict": "busy"}
  ],
  "pick": {"lane": "ds4", "reason": "1 of 4 slots free, queue empty, p50 TTFT 210ms"}
}
```

`verdict` ∈ `spare` (free slots and empty queue), `busy` (free slots, queue > 0), `saturated` (no free
slots), `unreachable` (`error` set), `unknown` (no gauge). `pick` is `null` when nothing has spare
capacity. The handler calls `api.build_snapshot()` directly — no HTTP hop, no gateway.

### 11.2 Slash command — yes, it is worth it

`/fleet` returns one line: `ds4 3/4 · GN100 5/5 (q 2) · anthropic/claude-opus-5-5 1 in flight · pick: ds4`.
Healthy local servers as `name used/total (q N)` (queue shown only when non-zero), then cloud lanes
with in-flight > 0 or requests in the window as `provider/model N in flight`, then `pick: <name>`.
Unreachable servers never appear. Capped near 160 chars by dropping trailing lanes before the pick.
Ten lines of code reusing `fleet_status_text()`, and it makes the plugin usable from Telegram, Discord and
the CLI without the Desktop. Worth it.

---

## 12. Admission-rule compliance (all 18)

| # | Rule | How Flightdeck satisfies it |
|---|---|---|
| 1 | Human-merged gate | One PR adding `plugin-catalog/flightdeck.yaml`; nothing in code. |
| 2 | Exact SHA pins | Entry pins the submission commit; repo is public and cloneable. |
| 3 | No self-updating code | No updater, no remote `plugin.js`, no release downloader. Network calls are GET probes to the user's own model servers — data, never code. |
| 4 | SHA bumps are new PRs | Process; `version` bumps in the same PR. |
| 5 | Owner submission | `freemanconsulting` owns the repo; Aubrey submits. |
| 6 | Declared capabilities match reality | `provides_hooks` = the 7 registered hooks exactly; `provides_tools` = `[fleet_status]`; `provides_middleware`/`requires_env` empty. Verified by the capability probe (`plugin_validate.py:407-458`). |
| 7 | Install scanner | Run `hermes plugins validate . --install-deps`; expected findings: none dangerous. No shell, no subprocess, no credential reads, no hardcoded non-loopback addresses. Read every caution line before the PR. |
| 8 | Desktop stays inside the SDK | `plugin.js` imports only the SDK and `react/jsx-runtime`; no eval/dynamic import/script injection/app DOM reach/webview; canvas only, theme vars only. |
| 9 | No core overrides | Only `ctx.register_hook`/`register_tool`/`register_command`; documented imports (`load_config_readonly`, `plugin_data_dir`, `get_default_hermes_root`, `profile_name_for_home`). No private method calls, no `sys.modules` writes, no core table writes. **No `state.db` reads at all** — attribution comes from hooks and labels from public RPCs. |
| 10 | Dependency policy | Stdlib only; no `python_dependencies`, no `pyproject.toml` deps. |
| 11 | Credentials through Hermes | No credentials needed: local servers need none, cloud traffic is observed, not called. Quota comes from a public RPC, never from `auth.json`/`.env`. |
| 12 | Approvals and unattended runs | Hooks are observer-only and fail-open; no prompts, no blocking, no spawn. Probes are GET-only with 2 s timeouts and a 5 s floor. |
| 13 | Risky behaviour disclosed | README + entry description: GET probes to declared/auto-discovered model server endpoints (loopback/private only by default), one shared SQLite under `plugin-data/flightdeck`, 24 h/7 d retention, no message text stored, no telemetry, no credential reads, no shell. Reads every profile's `config.yaml` read-only to find model servers and its own declared settings; disclosed here and in the README. |
| 14 | Compatibility metadata truthful | `requires_hermes: ">=0.21.6"` in both `plugin.yaml` and the entry; current release v0.23.0. |
| 15 | No skins or forks | Original. |
| 16 | One listing per lineage | Original; no fork of a listed plugin. |
| 17 | No unscannable payloads | Pure Python/JS source; fixtures are text; no binaries, no bytecode, no archives. |
| 18 | Password managers | Not applicable; no login backend. |

### 12.1 README disclosure text (paste into README.md)

> **Disclosure.** Flightdeck records LLM request metadata — ids, profile, session, model, provider,
> base_url, start/first-chunk/end times, token counts, finish reason and error status — into one local
> SQLite file shared by every profile at `<hermes root>/plugin-data/flightdeck/requests.db` (24 h raw,
> 7 d per-minute rollups, 24 h server samples). It stores no message text, no prompts, no tool arguments
> and no credentials. It makes GET-only requests to the model server endpoints you declare in its
> settings, or that it auto-discovers from your own provider config (loopback and private addresses only
> by default), at most once per server per poll interval (5 s by default, 2 s floor, 2 s timeout). It
> reads every profile's `config.yaml` read-only — the root profile and every profile under
> `profiles/*` — to find those providers and its own declared server settings; it never writes to
> them. No telemetry, no network calls to third-party services, no shell commands, no credential reads.
> Quota shown on cloud cards comes from the public `session.stats` RPC for the focused session only,
> and is labelled as such.

### 12.2 Catalog entry draft (`plugin-catalog/flightdeck.yaml`)

```yaml
name: flightdeck
title: Flightdeck
repo: https://github.com/freemanconsulting/hermes-flightdeck
sha: <40-hex at submission>
version: "0.1.0"
description: "Live air-traffic control for Hermes agents and model servers: every in-flight LLM request, which profile/session/subagent/cron job holds it, and each local model server's slots, queue, prefill and decode throughput, by agent or by model. Disclosure — observer hooks record request metadata (ids, model, provider, base_url, timings, token counts, finish reason, error status) into one local SQLite file shared by all profiles under plugin-data/flightdeck (24h raw, 7d per-minute rollups, no message text); the poller makes GET-only requests to the model server endpoints you declare or that auto-discovery finds in your own provider config (loopback/private only by default), at most once per server per poll interval; reads every profile's config.yaml read-only to find model servers and its own settings; no telemetry, no credential reads, no shell commands."
maintainer: freemanconsulting
tier: community
category: desktop
requires_hermes: ">=0.21.6"
docs_url: https://github.com/freemanconsulting/hermes-flightdeck
screenshots:
  - https://raw.githubusercontent.com/freemanconsulting/hermes-flightdeck/<sha>/docs/screenshots/by-agent.png
  - https://raw.githubusercontent.com/freemanconsulting/hermes-flightdeck/<sha>/docs/screenshots/by-model.png
  - https://raw.githubusercontent.com/freemanconsulting/hermes-flightdeck/<sha>/docs/screenshots/swim-lane.png
readme: true
platforms: []
known_issues:
  - "Provider rate-limit headers are not in any hook payload; quota is shown only for the focused live session (session.stats) and the plan allowance, never per request."
  - "Auxiliary (compression/titling) requests carry no first-chunk time, so they show no TTFT."
  - "A request that runs longer than stale_after_seconds shows as abandoned until its post_api_request arrives."
capabilities:
  provides_tools: [fleet_status]
  provides_hooks:
    - pre_api_request
    - post_api_request
    - api_request_error
    - pre_auxiliary_call
    - post_auxiliary_call
    - subagent_start
    - subagent_stop
  provides_middleware: []
  requires_env: []
```

---

## 13. Work split — 3 parallel briefs with pinned interfaces

Worker A and B start immediately; C starts against `docs/snapshot.example.json` (generated by A+B's
`tests/make_example.py` in the first hours, seeded from fixture rows, not hand-written).

### Brief A — store + hooks (files: `store.py`, `hooks.py`, `config.py`, `tests/test_store.py`, `tests/test_hooks.py`)

Exports, pinned:

```python
open_store(path=None) -> sqlite3.Connection          # shared root, WAL, busy_timeout
record_pre(conn, **kw); record_post(conn, **kw); record_error(conn, **kw)
record_aux_pre(conn, **kw); record_aux_post(conn, **kw)
record_subagent_start(conn, **kw); record_subagent_stop(conn, **kw)
close_own_stale(conn); close_stale(conn, stale_after=300.0, now=None) -> int
sweep(conn, retention_hours=24, rollup_days=7, now=None) -> dict
window_rows(conn, since, limit=5000) -> list[dict]
in_flight_rows(conn) -> list[dict]
agent_nodes(conn, since) -> list[dict]              # flat rows; tree built in api.py
model_nodes(conn, since) -> list[dict]
server_samples_since(conn, since) -> list[dict]
health(conn) -> dict
```

`hooks.py`: `register_all(ctx, conn, settings)` — 7 `ctx.register_hook` calls, each callback wrapped
fail-open, each reading `ctx.current_cron_execution()` once and `profile_name_for_home(get_hermes_home())`
once. No network, no threads, no exceptions escaping.

### Brief B — poller + API (files: `poller.py`, `api.py`, `dashboard/plugin_api.py`, `dashboard/manifest.json`, `tests/test_api.py`, `tests/make_example.py`, plus the relocated `servers.py`)

Pinned: `api.build_snapshot(window_seconds=300, *, servers=None, conn=None) -> dict` returning exactly
§9.1; `api.build_agents`, `api.build_models`, `api.build_servers`, `api.fleet_status_text(snapshot) -> str`.
`poller.poll(servers, ttl, timeout)` as §7.3. Routes exactly §9. Depends on A's query functions and on
brief 02's `servers.py`; it must not import `store` internals beyond the listed exports.

### Brief C — Desktop UI (files: `desktop/plugin.js`, `docs/screenshots/`)

Pinned: consumes only `ctx.rest('/snapshot?window=…')`, `/servers`, `session.list` via
`host.requestProfile`, and `session.stats`; renders §10.1-10.5. No backend edits, no new endpoints.
Builds against `docs/snapshot.example.json` until the live backend answers.

### Integration points (no coordination needed)

1. `servers.py` relocates from `flightdeck/servers.py` to the plugin root; `tests/test_servers.py` imports
   `servers`. (Worker B, 5 min.)
2. `docs/snapshot.example.json` is the only file C reads that A/B write.
3. `plugin.yaml` capabilities are frozen in §4.1; nobody adds a hook without updating it.

### Test plan

| Test | Asserts |
|---|---|
| `tests/test_store.py` | schema creates; pre→post upsert closes the row; error path; `close_stale` marks abandoned and a late post reopens; sweep rolls up minutes and prunes; retention boundaries |
| `tests/test_hooks.py` | fixture hook payloads (kwargs copied from `turn_api_request.py:80-105`, `turn_response_intake.py:76-106`, `api_request_hooks.py:176-198`, `auxiliary_hooks.py:132-185`, `delegate_tool.py:356-362`) produce the expected rows; hook callbacks never raise on missing kwargs; p95 callback < 5 ms on 10k rows |
| `tests/test_api.py` | seeded DB → §9.1 shape; `unattributed` math; TTFT/prefill/decode formulas; `null` vs `0`; cloud card has `slots: null`; `fleet_status` JSON parses and `pick` is sane |
| `tests/test_servers.py` | brief 02 |
| `hermes plugins validate . --install-deps` | all checks pass; read every warning |
| Desktop load | plugin appears in Capabilities → Plugins, page renders, no error toast, chip shows |
| `tests/smoke_live.py` | optional: probe declared servers if present, skip otherwise |

Run: `hermes-agent/venv/bin/python -m pytest -q tests/` and `hermes plugins validate .`.

### Demo script (90 s, shot list)

| Time | Shot | What is on screen |
|---|---|---|
| 0-8 | Problem | "You have five agents and four model servers. Which one is busy?" Desktop with Flightdeck open, By model, local first |
| 8-22 | Local capacity | ds4 card: slot bar filling, queue count, decode/prefill tok/s moving, p50 TTFT. GN100 card at 5/5 with a queue |
| 22-38 | Held by | The "held by" rows: which agent holds each slot, elapsed time growing; then the gray "unattributed" row explained in one sentence |
| 38-55 | By agent | Tree: profile → session → subagent rows, live dots, model per row; a cron run labelled `cron: …` |
| 55-70 | Wow | Swim-lane: bars growing, prefill dim / decode bright, colored by agent; one prefill-heavy request visible |
| 70-82 | Cloud lanes | Anthropic/Codex cards in the same list, "Hermes traffic only", TTFT/tok/s/errors, quota line labelled live-session |
| 82-90 | Agent tool | `fleet_status` called in chat, JSON with `pick: ds4`; chip visible in the status bar |

---

## 14. Risks and cut lines

Drop in this order when short. Never cut items marked **core**.

1. `/profiles` panel and multi-profile enablement (shell command display) — cut first, zero demo impact.
2. `usage.bars` plan dollar line on the subscription card.
3. Swim-lane canvas → slot grid (§10.5 Option B).
4. Cron attribution (rows still show under the session; only the `cron:` label is lost).
5. Auxiliary rows (compression/titling) — cloud cards lose the Haiku lane, the demo keeps Anthropic.
6. Auto-discovery (keep the declared list; the demo declares servers anyway).
7. Websocket push (§9.3).
8. Per-minute rollups (keep 24 h raw; 5 m windows still work, 7 d history is lost).

**Core, never cut:** the 7 hooks + shared store, By model local cards with slot bar and held-by,
By agent tree, status chip, `fleet_status`, `hermes plugins validate` green, the demo dry run.

Other risks:

- **Hook payload drift** — kwargs are additive and callbacks take `**kwargs`; a renamed field would show
  as a null column, not a crash. `tests/test_hooks.py` fixtures are the tripwire.
- **SQLite contention** across profiles — `busy_timeout=2000` plus `BEGIN IMMEDIATE`; if p95 hook time
  exceeds 5 ms, the queue+writer upgrade is a known, bounded change.
- **Long requests mislabelled abandoned** — provisional by design, self-corrects on the late post; the UI
  renders gray and the health line counts it.
- **`hermes plugins validate` surprises** — run it on day 1, not day 2. The capability probe is the one
  that bites (register() must not need a gateway).

---

## 15. Open questions for Aubrey

1. **Server list scope.** v1 keeps the list in per-profile `config.yaml` settings (the documented plugin
   settings path). A machine-wide list needs a shared `servers.json` under `plugin-data/flightdeck` — say
   if you want that instead; it is ~30 min and one more disclosed file.
2. **Quota line.** Show it (live-session only, labelled) or drop it? It is the only quota data the
   platform exposes, and it is per-session, not per-provider.
3. **Plan dollar bars** (`usage.bars`) on the subscription card — needs portal sign-in; default off?
4. **Demo profile.** Which profile has the most traffic on demo day? The demo should run there so the
   tree is populated; hooks only exist where the plugin is enabled.
5. **Catalog identity.** Maintainer name and repo owner on the entry (`freemanconsulting`?), and whether
   the public repo should be created before or after the pin.
6. **Chip content.** Local servers only (current design) or cloud lanes too? Local-only keeps the chip
   short and matches direction (1).

---

## 16. Platform blockers (design-affecting, not worked around)

1. **No hook carries provider rate-limit headers or cost.** `agent._rate_limit_state` is populated from
   response headers (`agent/rate_limit_tracker.py:89-105`) but never enters a hook payload; `usage` is
   token buckets only (`agent/api_request_hooks.py:35-60`). Per-request quota is therefore impossible
   without reading agent internals, which rule 9 forbids. §7.4 uses the public `session.stats` RPC and
   labels it honestly.
2. **`post_auxiliary_call` has no `first_chunk_at`, and streaming auxiliary calls report no `usage`**
   (`agent/auxiliary_hooks.py:143-185`). Aux rows show no TTFT and sometimes no tokens; the cloud card
   for compression shows request counts and duration, not throughput.
3. **`session.list` denies subagent and kanban sources** (`tui_gateway/contracts/sessions.py:248-249`),
   so subagent labels must come from `subagent_start`'s `child_goal`/`child_role`. We capture them; a
   subagent spawned before the plugin was enabled has no label and shows its id.
4. **`ctx.current_cron_execution()` is `None` for `delegate_task` subagents** (`plugins/index.md:1949`).
   A subagent row under a cron run keeps its parent session but loses the cron label; we show the parent
   and never guess.
5. **Plugin settings are per-profile** (`plugins.entries.<id>.settings`), so the server list is per
   profile. A machine-wide fleet needs a shared file; that is a design choice (§15.1), not a platform
   gap we can close today.
6. **No hook carries session titles.** Labels come from the public `session.list` RPC joined in the
   Desktop half; sessions that have no stored row (a brand-new chat, a cron run's first turn) show
   `session <id[:8]>` until the row exists.
7. **The capability probe runs `register()` in isolation** (`plugin_validate.py:407-458`). Anything
   `register()` needs at load time (a gateway, a network call, a thread) becomes an admission failure.
   The design keeps `register()` to DB-open + registrations.
