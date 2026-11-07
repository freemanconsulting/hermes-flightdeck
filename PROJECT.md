# Flightdeck: live air-traffic control for Hermes agents and model servers

Hackathon entry: Hermes Agent Plugin Hackathon (Nous Research). **Deadline: 2026-11-11 17:00 EST (16:00 CST).**
Entry = PR adding `plugin-catalog/flightdeck.yaml` to NousResearch/hermes-agent (the X post's
"Hermes-Agent-Plugins" repo URL 404s; the catalog lives in hermes-agent `plugin-catalog/`, see its README),
plus a demo video under 90s on X tagging @NousResearch (Aubrey posts), plus the form (Aubrey submits).
Judging: usefulness, reliability, polish, creativity; favors plugins that do more than a prompt or skill could.

## One-line pitch
See every agent, subagent and cron job that is talking to a model right now, which model and server it is on,
and how loaded each model server is (slots in use, queue, prefill and decode tok/s, time to first token),
by agent or by model.

## Why it is different from what is listed
Existing entries: hermes-monitor / hermes-worker-monitor (Kanban worker health), hermes-telemetry (per-session
tokens/cost/latency + budgets), token-rate (one llama.cpp tok/s chip from a log), discord-tps (tok/s in Discord
presence), hermes-telemetry-dashboard (shared-metrics viewer). None joins the agent tree (profile → session →
subagents / cron runs) with the live capacity of each model server (vLLM, SGLang, llama.cpp, Ollama, TensorFold,
cloud) and per-request attribution.

## Shape (to be confirmed by docs/DESIGN.md)
- Observer hooks (pre/post_api_request, pre/post_auxiliary_call, session start/end) in every profile write
  request events to one shared local SQLite store.
- A poller reads each configured model server's `/metrics` or `/health` (adapters per server type).
- Backend API (plugin_api.py) joins both; Desktop plugin (desktop/plugin.js) renders By agent and By model
  pages, a status-bar chip ("ds4 3/4 · GN100 5/5 · 2 queued"), and an agent tool `fleet_status` so Hermes can
  pick a lane with free capacity.

## Working rules
- Subagents for this project run on **ds4** (`delegate_task option=general`), per Aubrey 2026-11-07. Not GN100.
- Repo: local git here (Forgejo post-commit pushes the current branch; never commit on main; work on
  `feature/*`). Public GitHub repo `freemanconsulting/hermes-flightdeck` created at submission time.
- Briefs live in `.briefs/` (untracked orchestration).
- Generic first: nothing Aubrey-specific in code or defaults (no hardcoded ports, hosts, profile names).
- Must pass `hermes plugins validate` (capabilities match, security scan, desktop surface rules, no core override,
  no credential reads, telemetry none).

## Status log
- 2026-11-07: project created; research/design (ds4) and metrics-adapter spike (ds4) dispatched.
