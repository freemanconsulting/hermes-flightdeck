# Capacity-aware delegation — design (Flightdeck does more than watch)

Status: design for one build worker, ~4 h. Deadline 2026-11-11 16:00 CST. This file is the whole
brief; it touches no code. It answers every question in `.briefs/N-capacity-design.md` and pins the
interfaces so the worker does not have to re-research the seam.

**The feature, one line:** when Hermes delegates a subagent, Flightdeck places it on a **local** model
server with free slots (never a full one, never a cloud route), and shows the decision on the page —
a `routed → GN100 (ds4 full 4/4)` chip on the subagent row, a small decisions list, and a routing line
in `fleet_status` / `/fleet`.

---

## 1. The seam: what a delegation provider actually is (cited)

A delegation provider answers **"which route does this task take"** and nothing else. Core keeps the
whole lifecycle — spawn, isolation, roles, depth, concurrency, background units, stop fan-out, results,
`output_schema`, progress (`agent/delegation_provider.py:1-13`).

| Fact | Where |
|---|---|
| One provider is active per session: `delegation.backend` in config.yaml; unset = `default`. A configured backend that is not registered or reports unavailable **fails closed** — `delegate_task` returns a tool error naming the backend and the fix, and never quietly runs on another route. | `agent/delegation_registry.py:35-38, 107-134`; docs `delegation-provider-plugin.md:23-25` |
| The `default` strategy is itself a plugin (`plugins/delegation/default`), registered through the same public seam. Its `route_task` returns `dict(config)` minus `service_tier`. | `plugins/delegation/default/__init__.py:32-33` |
| `route_task(task, config)` receives **only** `{goal, context, index}` plus the values the model supplied for this provider's own `task_parameters`. No parent agent, no toolsets, no requested model/provider, no session id. | `tools/delegate_tool_routes.py:288-301` (payload built at `:299`); docs `:95` |
| A provider can return any of `model, provider, base_url, api_key, api_mode, request_overrides, reasoning_effort, service_tier, fallback_providers, profile, label`. Unknown keys are dropped. | `agent/delegation_provider.py:50-54`; `tools/delegate_tool_routes.py:103-106` |
| `request_overrides` reaches the child as its `request_overrides` dict, so a provider's `extra_body` can be carried. | `tools/delegate_tool_routes.py:217` → `tools/delegate_tool.py:283-303, 434` |
| `is_available()` MUST NOT make network calls; `False` fails delegation closed with a tool error naming the backend and the fix. | `agent/delegation_provider.py:81-84`; docs `:98` |
| A session routes on the backend its `delegate_task` schema was built from, pinned to the session row; a config edit does not apply to a running session until `/delegation <name> --now` or `/new`. | `agent/delegation_registry.py:8-11`; docs `:171-186`; `tools/delegate_tool_routes.py:312-313` (`pinned_backend`) |
| `ctx.delegation_backends.list_backends()` returns `{name, label, description, available, reason}` for every registered backend; `saved_backend()` returns config.yaml's `delegation.backend`. | `agent/delegation_backends.py:47-57, 135-144`; docs `:158-165` |
| A managed worker (kanban, safe mode, managed sessions) runs on the session config **frozen at creation**. | `tools/delegate_tool_routes.py:179` |
| Subagent identity: `subagent_id = f"sa-{task_index}-{hex}"`; `subagent_start` carries `child_session_id`, `child_goal`, `child_role`. | `tools/delegate_tool.py:249, 353-360`; `tools/delegate_tool_results.py:381-389` |

### 1.1 Is there a shadow/wrap-the-default pattern? **No — and that is the blocker.**

There is no composition seam. `agent.delegation_registry.get_provider(name)` can fetch another
provider object, but `agent.delegation_registry` is **not** in the public-import allowlist
(`hermes_cli/plugin_validate_private_imports.py:27-41`; `agent.delegation_provider` and
`agent.delegation_backends` are, `:30`). Importing it would add a "private core imports" caution line
to `hermes plugins validate` — a catalog rule 9 violation for a public plugin. `ctx.delegation_backends`
gives names, labels and availability only, never the provider object.

So Flightdeck **cannot** ask another backend for the requested route and then rewrite it. The private
prior art (`~/.hermes/plugins/capacity-routing/__init__.py:53-58`) does exactly that via
`delegation_registry.get_provider("model_map")`; it is a private plugin and can afford it. Flightdeck
cannot. Consequence, and it shapes the whole design:

> **Flightdeck's provider is a standalone backend named `flightdeck` that computes the requested route
> itself from the `delegation` config section.** It is only computable when the route is the default
> one (`dict(config)`), so `inner_backend` must be `default`. Any other inner backend (a plugin's
> per-task `option` enum, profile routes) cannot be read through the public seam → Flightdeck refuses
> to arm with a clear message instead of guessing.

This is not a loss for the feature: the requested route is what the user configured
(`delegation.provider/model/base_url`), which is exactly the route Flightdeck needs to compare against
the live fleet. It does mean Flightdeck routing and `model_map`-style per-task options are mutually
exclusive — which the single-active-backend rule already forces (§2).

### 1.2 Catalog rules 9/11: confirmed public

`register_delegation_provider` is a documented `PluginContext` method (`hermes_cli/plugins_registrars.py:85`),
`agent.delegation_provider` is in the public allowlist (`plugin_validate_private_imports.py:30`), and the
manifest has **no capability key** for delegation providers. The validator's capability probe treats
`ctx.register_delegation_provider` as a no-op (`plugin_validate.py:256-268`) and only diffs
`provides_tools` / `provides_hooks` / `provides_middleware` (`:435-458`). Nothing to declare; nothing
to override. Rule 11 holds trivially: Flightdeck passes a `provider` **key**, never an `api_key`, so
core's credential resolver leases the key from the user's own provider config — Flightdeck reads no
credential and stores none.

---

## 2. Coexistence: one backend at a time, so nothing can fight

Aubrey's machine runs capacity-routing as `delegation.backend: model_map`. Two delegation providers
cannot both be active: `delegation.backend` names one, and a session pins it. "Fight" is therefore not
a race — it is a **switch**, and the design makes the switch explicit and never silent.

Rules:

1. **Opt-in, default off.** `route_delegation: false`. With routing off, the `flightdeck` backend
   behaves byte-for-byte like `default` (it returns the requested route unchanged, adds no
   `task_parameters`, no `description`), so a user can arm and disarm without switching backends and
   without a prompt-cache break.
2. **Flightdeck never writes `delegation.backend`.** It does not call
   `ctx.delegation_backends.set_global_backend`; the user (or `/delegation flightdeck --now`) does.
3. **Arming requires the backend.** `capacity.arm_status()` returns
   `{armed, backend, inner_backend, blocked_by, message}`. `armed` is true only when
   `route_delegation` is on **and** `delegation.backend == "flightdeck"` **and** `inner_backend == "default"`.
   When routing is on but another backend is active, `blocked_by` names it and `message` is the exact
   fix:

   ```text
   Flightdeck routing is on but delegation.backend is 'model_map' (capacity-routing).
   One delegation backend runs at a time. Switch with `/delegation flightdeck --now`
   (or `hermes config set delegation.backend flightdeck`), or turn route_delegation off.
   ```

   This is the "detects another active delegation provider and refuses to arm" requirement: the
   provider is simply not active, so there is nothing to fight over; the settings page, the page
   header and `/fleet` show the blocked state with the switch command.
4. **Runtime fail-closed only for the one real error.** `is_available()` is `True` when
   `inner_backend == "default"` (and the seam imports), `False` otherwise with:
   `"Flightdeck routing needs inner_backend 'default': a plugin backend's per-task options cannot be read through the public delegation seam. Set delegation.backends.flightdeck.inner_backend: default, or set route_delegation: false."`
   That fails `delegate_task` closed with a readable fix, per the seam's contract — never a silent
   wrong route. It makes no network call.
5. **No self-enabling, no config writes.** Documented in the README disclosure (§8.3).

Switching back is one command: `/delegation model_map --now` (or `hermes config set delegation.backend model_map`).
A session pinned to `model_map` keeps `model_map` until `--now` or `/new` (`delegation-provider-plugin.md:171-186`) —
the demo must use `--now`.

---

## 3. Eligibility and the decision algorithm (exact)

### 3.1 Eligible delegations

A task is **eligible** only when all of these hold. Anything else is *ineligible*: the requested route
is returned untouched and **no decision row is written** (no routing decision was made).

| # | Condition | Why |
|---|---|---|
| 1 | `route_delegation` is on and `arm_status().armed` | opt-in (§2) |
| 2 | The requested route is non-empty (it does not inherit the parent's route) | a provider cannot see the parent (`:95`), so it cannot know what it would be moving |
| 3 | The requested route has no `profile` | a profile route decides its own model and credentials; never rewritten |
| 4 | The requested route has no explicit `api_key` | moving an endpoint with a pinned key is wrong |
| 5 | The requested route resolves to a **local** server card (`kind != "cloud"`, base_url loopback/private, not in `hidden_servers`) | never cloud; hidden means hidden everywhere |
| 6 | That server is in `routing_servers` (empty = every local server) | the user's eligible list |
| 7 | The requested lane has a fresh, healthy sample with a slot gauge | no gauge or stale sample = no decision (§5) |

The requested route is `{k: v for k, v in config.items() if k != "service_tier"}` — exactly what the
`default` backend returns (`plugins/delegation/default/__init__.py:32-33`). `inner_backend` is not read
at route time; it is an arm-time gate (§2.4).

### 3.2 Free slots

```text
free(lane) = slots - running - waiting - ledger(lane, routing_ledger_seconds) - batch(lane) - reserve_slots
```

- `slots`, `running`, `waiting` come from the live sample (§5). `slots is None` → the lane has no gauge:
  it is never a placement target, and if it is the requested lane the task stays untouched with a
  `skip` decision ("no slot gauge on ds4").
- `ledger(lane, N)` counts placements this process made in the last N seconds (default 60) from
  earlier batches; `batch(lane)` counts placements in the current batch. Both make a fan-out spread
  instead of stacking on one lane. Process-global state module (survives plugin re-exec), same shape
  as the prior art's `_state()` (`~/.hermes/plugins/capacity-routing/router.py:66-88`), no hardcoded lanes.
- `reserve_slots` (default 1, min 0) is headroom kept free on **every** lane: a lane is a placement
  target only when `free >= 1`. With reserve 1 and ds4 at 3/4 (1 free), `free = 0` → move.
- A batch starts when `task.index` resets or goes backwards (`router.py:137-150`); `index` is in the
  payload (`:299`).

### 3.3 Decision

```text
if free(req_lane) >= 1:                     action = stay,  chosen = req_lane
elif req_lane.queue >= max_queue:           action = skip,  chosen = None   # don't deepen a queue
else:
    targets = eligible local lanes with a fresh healthy sample, a gauge, free >= 1
    targets.sort(key = (-free, queue, ttft_ms_p50 or inf, name))             # deterministic tie-break
    action = move if targets else skip;  chosen = targets[0] if targets else None
```

- **Tie-break:** most free slots, then shortest queue, then lowest p50 TTFT, then name — so the same
  fleet always produces the same pick (tests assert it).
- **All full → fall through unchanged.** No lane with `free >= 1` means no move: the requested route
  is returned as-is and a `skip` decision is recorded ("all local lanes full: ds4 4/4, GN100 5/5").
  Queueing on the least-loaded lane was considered and rejected: moving a task to a full server gains
  nothing, hides the queue, and drops the requested route's own fallback chain. `max_queue` is the
  only queue policy: a requested lane whose queue is already `max_queue` deep is not kept.
- **Never cloud.** Cloud lanes are not candidates at any step; a cloud requested route is ineligible
  (§3.1 #5). There is no setting to allow it.
- **Batch fan-out:** each placement increments `batch(chosen)` before the next task is routed, so a
  3-task batch against ds4 with 2 free slots lands ds4, GN100, GN100 (or ds4, ds4, GN100 with
  reserve 0) — never three on one lane.

### 3.4 The route a move produces

```python
route = dict(requested)                        # keeps reasoning_effort, service_tier, label, ...
route.update(provider=<lane provider key>, model=<model the lane serves>,
             base_url=<lane base_url>, api_mode=requested.api_mode or "chat_completions",
             label=f"{requested.get('label') or 'task'}→{lane['name']} ({reason})"[:80],
             fallback_providers=[{provider, model, base_url} of the requested route])
if entry.extra_body: route["request_overrides"] = {"extra_body": entry.extra_body}
```

`fallback_providers` points back at where the task would have gone anyway, so a failed placement
falls back to the requested lane rather than to nothing. `extra_body` is carried only from the target
provider's own entry, only the `extra_body` key, never another override.

---

## 4. Server → provider/model mapping (generic, nothing hardcoded)

A lane is a server card; a child needs a `provider` key, a `model`, a `base_url`. The bridge is the
user's own provider config, read the same way discovery already reads it.

**New in `config.py`:** `provider_routes(config=None) -> dict[str, dict]`, keyed by normalized
`base_url`, built from `_config_sources()` (root profile first, then `profiles/*` sorted — the same
order and read-only YAML load as `_union_servers`, `config.py:308-400`):

```python
{"http://127.0.0.1:18010": {
    "provider": "studio-ds4", "base_url": "http://127.0.0.1:18010/v1",
    "default_model": "ds4", "models": ["ds4"], "extra_body": None, "profiles": ["default"]}}
```

From each profile's `providers.<key>`: `api` (or `base_url`) → normalized base_url; `default_model`;
`models` keys; `extra_body`. A provider key on a base_url wins over an auxiliary-only entry, same
rule as `_union_servers` (`:368-396`). Nothing about Aubrey's machine is in code: the keys, ports and
model ids all come from the user's config.

**`lane_for_route(route, servers, provider_routes)`** — the requested lane:
`base = route.base_url or provider_routes[route.provider].base_url`; normalize; match a server card by
normalized `base_url` (the same match `api.server_for_url` already does, `config.py:526`). No base_url
or no card → `None` → ineligible (cloud or unknown, untouched).

**`route_for_lane(lane, requested, provider_routes)`** — the target route's model:

```text
entry = provider_routes[lane.base_url]            # lane["key"] is the provider key (config.py:334)
model = requested.model if requested.model in (entry.models or lane.models)
        else entry.default_model
        else first(lane.models)                   # the model the server reports serving
        else first(entry.models)
        else None                                 # no model → skip ("no model on GN100")
```

If the model changes, the reason and the chip say so (`routed → GN100 (ds4 full 4/4, model
qwen38-flash-next-tf-fp4)`). A lane whose model cannot be determined is not a target — Flightdeck
never invents a model id.

---

## 5. Data path: the live sample, TTL'd, no network in the hot path

`route_task` is synchronous and called once per task, before any child is built
(`tools/delegate_tool.py:613`). It reads the fleet like this:

```python
samples = poller.poll_sync(servers, ttl=poll_interval_seconds, timeout=probe_timeout_seconds, conn=conn)
```

- `poller.poll_sync` (`poller.py:248-260`) is the sync wrapper for a non-loop caller and spawns its
  own thread when a loop is already running. It fans out with `asyncio.gather`, reuses the per-base_url
  cache younger than `ttl` (`:206-224`), and writes one `server_samples` row per server per poll
  (`:153-185`). So the **hot path is a memory read**; a cold cache costs at most one probe per server
  (`probe_timeout_seconds`, 2 s), in parallel, once per batch — not per task.
- **Staleness:** a sample whose `sampled_at` is older than `routing_staleness_seconds` (default 20,
  floor 5) is not used for a decision. Because `poll_sync` returns the cached sample with its original
  `sampled_at`, staleness is visible from the same call: stale after the TTL'd poll → `skip`
  ("stale sample: ds4 42s old"). Never route on a number the page would grey out.
- **Unprobeable requested lane** (`sample.error`, or no sample) → `skip`, untouched. Flightdeck does
  not move a task off a server it cannot see.
- The provider holds the store connection opened in `register()` (`store.open_store()`, WAL,
  `check_same_thread=False`, `store.py:132-142`); every write is fail-open like the hooks
  (`hooks.py:82-95`). A store failure costs the trail, never the delegation.

---

## 6. The decision record and how it reaches the page

### 6.1 Store: a new table (not `requests`)

`requests` is per-LLM-request and has no pre-spawn identity; a decision happens **before** the child
session exists and has no request row. Reusing it would fake a request. New table, `SCHEMA_VERSION`
bumps to 2 (`store.py:28`, `:145-148` — `CREATE TABLE IF NOT EXISTS` is the migration):

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decided_at REAL NOT NULL,        -- epoch seconds
  profile TEXT, host TEXT, pid INTEGER,
  batch_id INTEGER, task_index INTEGER,
  goal TEXT,                       -- clipped to 300 chars, the same rule as subagent_links.goal
  action TEXT,                     -- stay | move | skip
  requested_lane TEXT, requested_provider TEXT, requested_model TEXT,
  chosen_lane TEXT, chosen_provider TEXT, chosen_model TEXT,
  reason TEXT,                     -- "ds4 full 4/4", "1 of 4 slots free, queue empty"
  stale INTEGER,                   -- 1 when the sample used was stale
  lanes_json TEXT                  -- [{name, slots, running, waiting, queue, free, stale}] at decision time
);
CREATE INDEX IF NOT EXISTS ix_dec_at   ON decisions(decided_at);
CREATE INDEX IF NOT EXISTS ix_dec_goal ON decisions(goal, decided_at);
```

`store.py` gains `record_decision(conn, **kw)`, `decisions_since(conn, since, limit=20)`,
`last_decision(conn)` and `decisions_for_links(conn, links, window=60.0)` (the join, §6.3).
`goal` is clipped identically to `subagent_links.goal` (`store.py:441`) so the join is exact.

**Retention:** `sweep()` (`store.py:548-583`) deletes decisions older than `retention_hours` (24 h) and
keeps at most 2000 rows (`DELETE FROM decisions WHERE id NOT IN (SELECT id FROM decisions ORDER BY id DESC LIMIT 2000)`),
returning `deleted_decisions`. Same 24 h as raw requests; the trail is a page, not an archive.

### 6.2 API: `snapshot["decisions"]` and `snapshot["routing"]`

`api.build_snapshot` (`api.py:783`) gains two keys, always present:

```json
"decisions": [
  {"id": 41, "at": 1762540800.1, "action": "move", "task_index": 0,
   "requested_lane": "ds4", "chosen_lane": "GN100", "requested_model": "ds4",
   "chosen_model": "qwen38-flash-next-tf-fp4", "reason": "ds4 full 4/4", "stale": false,
   "goal": "metrics adapters", "lanes": [{"name": "ds4", "slots": 4, "running": 4, "queue": 0, "free": -1},
                                         {"name": "GN100", "slots": 5, "running": 0, "queue": 0, "free": 4}]}
],
"routing": {"armed": true, "backend": "flightdeck", "inner_backend": "default",
            "blocked_by": null, "message": "", "eligible_lanes": ["ds4", "GN100"]}
```

`decisions` is the newest 20 (newest first) from `decisions_since`; `routing` is `capacity.arm_status()`
computed once per snapshot. Both are `[]`/`{armed: false, …}` when the plugin has no decisions yet, so
the UI never guesses.

### 6.3 Per-subagent `routed`: the join

The decision has `goal` + `decided_at`; the subagent link has `goal` + `started_at`
(`store.py:420-444`), written a few milliseconds after the decision (`tools/delegate_tool.py:353-360`).
`api._agent_tree` (`api.py:687-751`) gains a `decisions=None` parameter and, after children are
attached (`:734-745`), attaches:

```json
"routed": {"action": "move", "lane": "GN100", "requested_lane": "ds4",
           "reason": "ds4 full 4/4", "model": "qwen38-flash-next-tf-fp4", "at": 1762540800.1}
```

Match rule: same `goal`, `|decided_at - started_at| <= 60 s`, nearest `decided_at` wins; no match → no
`routed` key (the decisions list still shows the decision). Duplicate goals in one batch are
disambiguated by time; the 60 s window bounds a mis-join to one row, and the chip's tooltip carries the
goal so a wrong join is visible rather than silent. Only subagent nodes get `routed`; root sessions and
cron nodes never do.

---

## 7. `fleet_status` and `/fleet` explain the pick

`tools.fleet_status` (`tools.py:142-158`) gains a `routing` block:

```json
"routing": {"armed": true, "backend": "flightdeck", "inner_backend": "default",
            "blocked_by": null, "message": "",
            "last_decision": {"action": "move", "lane": "GN100", "requested_lane": "ds4",
                              "reason": "ds4 full 4/4", "at": "2026-11-07T20:13:22Z"}}
```

`/fleet` (`tools.py:161-168`) appends one clause when the newest decision is under 5 minutes old:
`· routed: GN100 (ds4 full 4/4)`, or `· unrouted: all local lanes full`, or
`· routing off: delegation.backend is model_map` when blocked. The existing 160-char cap drops trailing
lanes before the pick (`docs/DESIGN.md:783`), so the routing clause is appended **after** the pick and
counted in the cap.

`pick` itself is unchanged: it is the fleet's recommendation, not the router's. When routing is armed
and the pick differs from the last decision's lane, that is honest and visible — the pick is advice,
the decision is what happened.

---

## 8. Manifest, settings, disclosure

### 8.1 `plugin.yaml`

- **Capabilities: nothing to add.** No manifest key exists for delegation providers; the probe treats
  `register_delegation_provider` as a no-op and diffs only tools/hooks/middleware
  (`plugin_validate.py:256-268, 435-458`). `provides_tools: [fleet_status]` and the seven
  `provides_hooks` stay exactly as they are (`plugin.yaml:5-14`).
- **`requires_hermes`:** keep `">=0.21.6"` and guard the import exactly as capacity-routing does
  (`~/.hermes/plugins/capacity-routing/__init__.py:17-26`): `ModuleNotFoundError` on
  `agent.delegation_provider` → one warning, routing unavailable, every other surface works. That keeps
  the catalog entry's promise truthful ("installs and works; routing needs 0.22.5+"). Add a
  `known_issues` line to the entry (§8.3). If Aubrey prefers a hard floor, bump to `">=0.22.5"` in both
  `plugin.yaml` and `plugin-catalog/flightdeck.yaml` — one line, his call.
- **`register()` stays probe-safe:** open store, stale close, hooks, tool, command, and the provider
  registration — no network, no thread, no gateway (`docs/DESIGN.md:1011-1013`).

### 8.2 `config_schema` additions

```yaml
route_delegation:
  type: boolean
  default: false
  description: "Place delegated subagents on a local server with free slots. Off = the flightdeck backend behaves exactly like default."
inner_backend:
  type: string
  default: default
  description: "The route Flightdeck places within. Only 'default' is readable through the public delegation seam; any other value refuses to arm."
reserve_slots:
  type: integer
  default: 1
  minimum: 0
  description: "Slots kept free on every lane; a lane needs free - reserve >= 1 to receive a subagent."
max_queue:
  type: integer
  default: 2
  minimum: 0
  description: "Never keep a subagent on a lane whose queue is already this deep."
routing_staleness_seconds:
  type: integer
  default: 20
  minimum: 5
  description: "A server sample older than this is not used for a routing decision."
routing_ledger_seconds:
  type: integer
  default: 60
  minimum: 0
  description: "How long a placement counts against a lane's free slots, so batches spread."
routing_servers:
  type: array
  description: "Servers eligible for placement, by name or base_url. Empty = every local server."
  items:
    type: string
```

All of these are read through `ctx.get_config(key, default)` at route time (documented plugin
settings path, `docs/DESIGN.md:61`), so a managed worker's frozen snapshot applies consistently.

### 8.3 README disclosure text (append to the existing Disclosure block)

> **Capacity routing (opt-in, off by default).** Flightdeck registers a delegation backend named
> `flightdeck`. It only places a subagent when `route_delegation` is on **and** `delegation.backend` is
> `flightdeck`; it never writes `delegation.backend` itself and never enables itself. It reads the same
> live server samples it already polls (at most one TTL'd probe per server per batch, no new network
> path), places a subagent only on a local server with free slots, never on a cloud provider, and never
> rewrites a profile route, an explicit `api_key` route or a route that inherits the parent's. Each
> routing decision — goal, requested and chosen lane, reason, the slot numbers it used — is recorded in
> the same local SQLite file (24 h, max 2000 rows) and shown on the page. One delegation backend runs at
> a time: if another is active, Flightdeck shows the switch command and does not arm.

Catalog entry: add to `known_issues`
`"Capacity routing needs delegation.backend: flightdeck and inner_backend: default; another delegation backend cannot be composed with through the public seam."`

---

## 9. UI (Desktop, `desktop/plugin.js` — another worker owns this file right now)

Three small additions, no new endpoints:

1. **The chip.** In `AgentRow` (after the `kind` badge, before `ModelMixBar`), when `row.routed` exists:

   ```javascript
   jsx(Badge, { variant: 'outline', size: 'xs', 'data-routed': row.routed.lane,
                title: `${row.routed.reason} · goal: ${row.goal || ''}`,
                children: row.routed.action === 'move'
                  ? `routed → ${row.routed.lane} (${row.routed.requested_lane} ${row.routed.reason})`
                  : row.routed.action === 'stay'
                    ? `stay ${row.routed.lane} (${row.routed.reason})`
                    : `unrouted (${row.routed.reason})` })
   ```

   Muted tone for `stay`/`skip`, normal for `move`; never a hardcoded color (`var(--ui-*)` only).
   `data-routed` is the test hook.
2. **The decisions list.** A collapsible "Routing decisions" section at the bottom of `AgentView`
   (newest 20 from `snapshot.decisions`): `<time> <action> <requested → chosen> <reason> · <goal[:60]>`,
   with the lane numbers in the tooltip. Empty state: "No routing decisions yet — delegation.backend is
   not flightdeck." One line per decision, no scrolling, capped at 20.
3. **The routing line.** In the page header beside the window picker: `routing: on · flightdeck` or
   `routing: off — delegation.backend is model_map` (from `snapshot.routing`), with the message as the
   tooltip. This is where the coexistence refusal is visible.

Integration point: the plugin.js worker is editing `AgentRow`/`AgentView` now. The patch is additive
(one badge, one component, one line); hand it over after their edit lands, or as a patch against
`function AgentRow` / `function AgentView` by name, not line.

---

## 10. Tests

`tests/test_capacity.py` — table-driven `decide()` with injected `samples`, `servers`,
`provider_routes`, settings and a fresh state module; no network, no store:

| Case | Expect |
|---|---|
| requested lane 1 free, reserve 1 | `move` to the most-free lane |
| requested lane 2 free, reserve 1 | `stay` |
| all local lanes full | `skip`, route unchanged |
| requested sample stale (age > staleness) | `skip`, route unchanged |
| requested sample error / missing | `skip`, route unchanged |
| requested lane no slot gauge | `skip` ("no slot gauge") |
| requested route is cloud | ineligible, untouched, no decision |
| requested route has `profile` | untouched |
| requested route has `api_key` | untouched |
| requested route empty (inherits parent) | untouched |
| requested lane in `hidden_servers` | untouched |
| requested lane queue >= max_queue | `skip` |
| 3-task batch, ds4 2 free, reserve 0 | ds4, ds4, GN100 (ledger/batch spread) |
| two lanes equal free, different queue/TTFT | deterministic tie-break, asserted twice |
| requested model not served by target | target's `default_model` |
| target has no determinable model | `skip` |
| target provider has `extra_body` | `request_overrides.extra_body` carried |
| any move | `fallback_providers` = the requested route |

`tests/test_capacity_coexist.py` — the arm matrix: `route_delegation` on/off × `delegation.backend`
`default`/`model_map`/`flightdeck` × `inner_backend` `default`/`model_map`; assert `armed`, `blocked_by`,
the message text, and `is_available()` (True only for inner `default`, no network).

`tests/test_capacity_e2e.py` — the real registry, real `delegate_task`, child construction stubbed
(template: `hermes-agent/tests/tools/test_delegation_backends.py`): temp `HERMES_HOME` with
`plugins.enabled: [flightdeck]`, `delegation.backend: flightdeck`, `route_delegation: true`;
`poller.poll_sync` monkeypatched to a fixed two-server sample; assert the child was handed the chosen
lane's `provider`/`model`/`base_url`, the decision row exists, and `build_snapshot()` carries the
`routed` chip on the child. The seam allows this — it is exactly what the Hermes test does.

`tests/test_store.py`: decision write, `decisions_since` order, 24 h prune + 2000-row cap.
`tests/test_api.py`: `decisions`/`routing` always present, `routed` attached only to subagent nodes.
`hermes plugins validate .` stays green (probe no-op, no new capabilities).

---

## 11. Demo beat (≤15 s of the 90 s video)

Pre-set before recording: `delegation.backend: flightdeck`, `route_delegation: true`, ds4 loaded to 4/4
(three in-flight requests), GN100 idle.

1. **(0-4 s)** By model: ds4 slot bar full, GN100 5/5 free — "ds4 is full."
2. **(4-6 s)** Terminal: `/delegation flightdeck --now` — one line, the switch is visible.
3. **(6-11 s)** Ask the agent to delegate two tasks. The By agent tree fills; each subagent row shows
   `routed → GN100 (ds4 full 4/4)`.
4. **(11-15 s)** `/fleet`: `ds4 4/4 · GN100 2/5 · pick: GN100 · routed: GN100 (ds4 full 4/4)`; cut to
   the decisions list, two rows.

One sentence over it: "It didn't just watch the fleet — it placed the work."

---

## 12. Risks and the cut line

Drop in this order; **core** never cut:

1. The decisions list (the chip and `/fleet` clause still tell the story).
2. The `fleet_status` routing block (keep the `/fleet` clause).
3. Batch spreading / ledger (a batch may stack on one lane; correctness unaffected).
4. `reserve_slots` (hardcode 0).
5. `routing_servers` eligibility list (all local servers).
6. The staleness refresh (keep skip-on-stale; lose the fresh poll, so a cold cache always skips).
7. `inner_backend` as a setting (hardcode `default`; the arm message stays).

**Core:** the provider + eligibility + never-cloud + the decision record + the chip + `hermes plugins
validate` green + the demo dry run.

Other risks:

- **Routing is off by default and needs a backend switch.** That is the seam's shape, not a bug; the
  demo pre-sets it and the page shows the blocked state honestly. Say it in the video's one sentence
  ("one delegation backend at a time").
- **No composition with `model_map`.** Documented blocker (§1.1); the fix is a core seam (a public
  `route_preview(backend, task)` or provider handles), not something Flightdeck can work around.
- **Goal-join fragility.** Duplicate goals in one batch, or a subagent spawned before the plugin was
  enabled, show no chip. The decisions list is the authoritative trail; the chip is a convenience.
- **`poll_sync` on a cold cache** adds up to `probe_timeout_seconds` (2 s) to the first task of a batch.
  Bounded and disclosed; if it bites, the cut is to read the newest `server_samples` row only.
- **Prompt cache:** Flightdeck adds no `task_parameters` and no `description`, so switching
  `default` → `flightdeck` produces byte-identical `delegate_task` bytes — no cache break. Keep it that
  way; a per-task `option` param would break it and is out of scope.
- **Managed workers (kanban) freeze their config at creation** (`tools/delegate_tool_routes.py:179`),
  so a kanban worker's own `delegate_task` calls route on the backend frozen when it started. Cron runs
  route normally. Neither the kanban job nor the cron job itself is ever placed — only their
  `delegate_task` children are, and only when the seam is active in that process.
- **`hermes plugins validate` surprises:** the probe runs `register()` in isolation; keep the provider
  import inside `register()` and guarded, and run validate on day 1.

---

## 13. Build order (files, one worker)

| # | File | Work |
|---|---|---|
| 1 | `capacity.py` (new) | `arm_status`, `decide`, `lane_for_route`, `route_for_lane`, ledger state. ~350 lines, no network of its own. |
| 2 | `store.py` | `decisions` table, `record_decision`, `decisions_since`, `last_decision`, `decisions_for_links`, sweep prune, `SCHEMA_VERSION = 2`. |
| 3 | `config.py` | `provider_routes()`, `eligible_lanes()`. |
| 4 | `__init__.py` | register the provider (guarded import), pass `ctx.get_config`. |
| 5 | `api.py` | `decisions` + `routing` in `build_snapshot`, `routed` in `_agent_tree`. |
| 6 | `tools.py` | `fleet_status` routing block, `/fleet` clause. |
| 7 | `plugin.yaml` | the seven settings; `requires_hermes` decision. |
| 8 | `desktop/plugin.js` | chip, decisions list, routing line (other worker's file — additive patch). |
| 9 | `README.md` | disclosure paragraph, catalog `known_issues` line. |
| 10 | tests | §10. |

Pinned exports for the worker:

```python
capacity.arm_status(settings, config=None, backends=None) -> dict
capacity.decide(task, config, *, samples, servers, provider_routes, settings, state=None) -> (route, decision|None)
capacity.Provider(settings_fn)            # DelegationProvider, name "flightdeck"
store.record_decision(conn, **kw) -> int
store.decisions_since(conn, since, limit=20) -> list[dict]
store.last_decision(conn) -> dict | None
store.decisions_for_links(conn, links, window=60.0) -> dict[str, dict]   # child_session_id -> routed
config.provider_routes(config=None) -> dict[str, dict]
config.eligible_lanes(servers, settings) -> list[dict]
```

---

## 14. Open questions for Aubrey

1. **`requires_hermes`:** keep `>=0.21.6` with a guarded import (recommended, truthful) or bump to
   `>=0.22.5`? One line either way.
2. **Demo backend:** switch to `delegation.backend: flightdeck` for the video (and switch back after),
   or leave capacity-routing armed and show only the blocked message? Recommended: switch — the
   placement is the beat.
3. **`max_queue` default 2** — is a 2-deep queue acceptable on ds4, or should a full ds4 always fall
   through regardless of queue depth (default 0)?
4. **`reserve_slots` default 1** — ds4 keeps one slot free for interactive chat today via capacity-routing's
   `reserve: 1`; same number here, but it is a generic setting now, not a ds4 rule.
