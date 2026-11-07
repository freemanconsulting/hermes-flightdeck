# Flightdeck

Live air-traffic control for Hermes agents and model servers: see every in-flight LLM
request, which profile/session/subagent/cron job holds it, and how loaded each local model
server is (slots in use, queue, prefill/decode tok/s, time to first token) — by agent and by
model.

Flightdeck is a Hermes plugin: observer hooks write request rows to one shared local SQLite
store, a poller reads each configured model server's metrics, and the Desktop plugin renders
the fleet. `fleet_status` lets an agent pick a lane with free capacity.

## Install

```bash
hermes plugins install .            # from this checkout
hermes plugins enable flightdeck
```

Model servers can be declared per profile in Settings → Plugins (Flightdeck → `servers`), or
left empty to auto-discover them from your provider config. Discovery reads every profile's
`config.yaml` read-only — the root profile and every profile under `profiles/*` — and unions
their private provider URLs, deduped by base_url, with the profiles that reference each server
shown on the card. Only loopback and private addresses are probed by default; declare a public
URL explicitly if you want it polled.

## Disclosure

Flightdeck records LLM request metadata — ids, profile, session, model, provider, base_url,
start/first-chunk/end times, token counts, finish reason and error status — into one local
SQLite file shared by every profile at `<hermes root>/plugin-data/flightdeck/requests.db`
(24 h raw, 7 d per-minute rollups, 24 h server samples). It stores no message text, no prompts,
no tool arguments and no credentials. It makes GET-only requests to the model server endpoints
you declare in its settings, or that it auto-discovers from your own provider config (loopback
and private addresses only by default), at most once per server per poll interval (5 s by
default, 2 s floor, 2 s timeout). It reads every profile's `config.yaml` read-only — the root
profile and every profile under `profiles/*` — to find those providers and its own declared
server settings; it never writes to them. No telemetry, no network calls to third-party
services, no shell commands, no credential reads. Quota shown on cloud cards comes from the
public `session.stats` RPC for the focused session only, and is labelled as such.

## Layout

- `store.py` — shared SQLite request/sample store and rollups
- `hooks.py` — observer hooks that write request rows
- `config.py` — declared servers, machine-wide discovery, poll knobs
- `poller.py` — GET-only server probes
- `api.py` — snapshot/agents/models/servers payloads
- `dashboard/`, `desktop/` — dashboard API and Desktop page
- `tools.py` — the `fleet_status` agent tool

Design and admission-rule compliance: `docs/DESIGN.md`.
