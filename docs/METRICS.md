# Model-server metrics: what each kind reports and how it normalizes

Flightdeck needs one reading per server: how many requests are running, how many are waiting, how many
slots exist, how fast tokens are moving, and how many tokens have been served. No two server kinds expose
that the same way. This file is the mapping from each kind's raw endpoints to the normalized `Snapshot`
in `flightdeck/servers.py`.

## Normalized fields

`Snapshot` (`flightdeck/servers.py`) is a dataclass. Every field a kind does not report is `None`;
`models` is `[]`. Nothing is ever guessed or defaulted to zero.

| Field | Meaning | Unit |
| --- | --- | --- |
| `name` | Display name: first model id, else `base_url` | — |
| `base_url` | Server root, no trailing slash | — |
| `kind` | `tensorfold` / `vllm` / `sglang` / `llamacpp` / `ollama` / `openai` / `unknown` | — |
| `healthy` | Server is up and serving; `False` when the health body is an error | bool |
| `models` | Model ids the server reports | — |
| `running` | Requests currently in prefill or decode | requests |
| `waiting` | Requests queued or deferred | requests |
| `slots` | Max concurrent slots / batch size | requests |
| `decode_tps` | Decode throughput | tokens/s |
| `prefill_tps` | Prefill throughput | tokens/s |
| `prompt_tokens_total` | Cumulative prompt (prefill) tokens | tokens |
| `cached_tokens_total` | Cumulative prompt tokens served from cache | tokens |
| `generation_tokens_total` | Cumulative generated (decode) tokens | tokens |
| `sampled_at` | When the snapshot was built, ISO 8601 UTC | — |
| `error` | Transport error text from `probe()`; `None` when clean | — |

`normalize()` never raises and never touches the network. `probe()` is the only function that does I/O,
and it never raises: transport failures land in `error`.

---

## TensorFold

Live on this machine: `http://127.0.0.1:18010` (ds4, v1.1.1, metal) and `http://127.0.0.1:18009`
(GN100, v1.1.4, cuda). Both endpoints are GET-only and cheap; capture fixtures sparingly.

### `/health` (JSON)

| Field | Normalized | Unit / notes |
| --- | --- | --- |
| `live.connections` | `running` | requests in prefill or decode |
| `live.waiting` | `waiting` | queued or held until a lane frees |
| `max_batch_size` | `slots` | max concurrent batch slots |
| `live.decode_tokens_per_second` | `decode_tps` | tokens/s, instantaneous |
| `live.prefill_tokens_per_second` | `prefill_tps` | tokens/s, instantaneous |
| `model_ids` (or `model`) | `models` | ids |
| `status` | `healthy` | `"ok"` → `True`; `error` body → `False` |

### `/metrics` (Prometheus, `tensorfold:*`)

| Metric | Normalized | Type |
| --- | --- | --- |
| `tensorfold:requests_running` | `running` (fallback) | gauge |
| `tensorfold:num_requests_running` | `running` (fallback, vLLM-compat alias, same value) | gauge |
| `tensorfold:requests_waiting` | `waiting` (fallback) | gauge |
| `tensorfold:num_requests_waiting` | `waiting` (fallback alias) | gauge |
| `tensorfold:prompt_tokens_total` | `prompt_tokens_total` | counter |
| `tensorfold:prompt_tokens_cached_total` | `cached_tokens_total` | counter |
| `tensorfold:generation_tokens_total` | `generation_tokens_total` | counter |
| `tensorfold:generation_tokens_running` | not mapped | gauge, tokens held by live streams |
| `tensorfold:kv_cache_usage_perc{stream="0"}` | not mapped | gauge, 0–1 |
| `tensorfold:kv_cache_usage_ratio{pool="0"}` | not mapped | gauge, 0–1 |

Quirks:

- Metrics carry **no `model_name` label**; model identity comes only from `/health`.
- The `*_total` counters count **finished requests only**, so they lag live traffic by one request.
  `generation_tokens_running` is the live gauge if you need in-flight occupancy.
- `/health` rates are instantaneous; `/metrics` counters are cumulative since server start. Never mix
  the two in one rate calculation.
- `warming: true` with `status: "ok"` means the model is still loading and the rates are zero. The
  snapshot stays `healthy=True`; the poller should render warming separately.
- `memory` is `{}` on ds4 and populated on GN100; it is not normalized.

Detection signature: `/health` JSON containing a `live` object or `max_batch_size`, or `/metrics` text
with any `tensorfold:` name.

---

## vLLM

Cited: <https://docs.vllm.ai/en/stable/usage/metrics/> (stable = v0.33.0, checked 2026-11-07) and the
legacy list at <https://docs.vllm.ai/en/v0.8.5/design/v1/metrics.html>.

### `/metrics` (Prometheus, `vllm:*`)

| Metric | Normalized | Type |
| --- | --- | --- |
| `vllm:num_requests_running` | `running` | gauge |
| `vllm:num_requests_waiting` | `waiting` | gauge |
| `vllm:num_requests_waiting_by_reason{reason}` | not mapped | gauge, sums to `waiting` |
| `vllm:prompt_tokens` (legacy `vllm:prompt_tokens_total`) | `prompt_tokens_total` | counter |
| `vllm:prompt_tokens_cached` (legacy: none; `vllm:prefix_cache_hits` in some builds) | `cached_tokens_total` | counter |
| `vllm:generation_tokens` (legacy `vllm:generation_tokens_total`) | `generation_tokens_total` | counter |
| `vllm:kv_cache_usage_perc` | not mapped | gauge, 0–1 |

Quirks:

- **The `_total` suffix was dropped** in newer releases. Both spellings are accepted; the parser reads
  the modern name first and falls back to the legacy one.
- Every sample carries a `model_name` label; `normalize()` sums across label sets and uses the label
  values as the `models` fallback when `/v1/models` is absent.
- **No slot gauge.** `--max-num-seqs` is a launch argument, not a metric, so `slots` is `None` unless the
  poller knows the launch config.
- **No tok/s gauge.** Both rates must be derived from counters (see *Rates*).
- `/health` returns HTTP 200 with an empty body; `/metrics` lives on the OpenAI-compatible server.
- Multi-model servers sum across models; per-model load needs the label sets, not the snapshot.

Detection signature: `/metrics` text with any `vllm:` name.

---

## SGLang

Cited: <https://docs.sglang.ai/references/production_metrics.html> and
<https://docs.sglang.ai/docs/basic_usage/native_api> (checked 2026-11-07); `server_info` shape from
`build_server_info` in
<https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/server_utils.py>.

### `/metrics` (Prometheus, `sglang:*`, needs `--enable-metrics`)

| Metric | Normalized | Type |
| --- | --- | --- |
| `sglang:num_running_reqs` | `running` | gauge |
| `sglang:num_queue_reqs` | `waiting` | gauge |
| `sglang:gen_throughput` | `decode_tps` | gauge, tokens/s |
| `sglang:prompt_tokens_total` | `prompt_tokens_total` | counter |
| `sglang:generation_tokens_total` | `generation_tokens_total` | counter |
| `sglang:cache_hit_rate` | not mapped | gauge, 0–1 |
| `sglang:num_used_tokens` | not mapped | gauge, tokens held in KV cache |
| `sglang:token_usage` | not mapped | gauge, 0–1 |

### `/get_server_info` (or `/server_info`)

| Field | Normalized | Notes |
| --- | --- | --- |
| `max_running_requests` | `slots` | also accepted from `server_args.max_running_requests` |
| `model_path` | `models` (fallback) | used when the metrics carry no `model_name` label |

Quirks:

- **No prefill tok/s gauge**; derive it from the `prompt_tokens_total` counter.
- **No cached-token counter**; `cache_hit_rate * prompt_tokens_total` approximates it. The snapshot
  leaves `cached_tokens_total` as `None` rather than presenting an approximation as a measurement.
- `num_queue_reqs` can exceed `max_running_requests`: the queue is unbounded.
- `/health` returns 200 with an empty body. `/ready` is the better readiness probe (503 while starting,
  paused, unhealthy or shutting down); `/health_generate` forces a token and is too expensive to poll.
- Current docs name the endpoint `/server_info`; `/get_server_info` still works and both are accepted.

Detection signature: `/metrics` text with any `sglang:` name, or `/get_server_info` JSON with
`max_total_num_tokens` / `server_args`.

---

## llama.cpp server

Cited: <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md> (master, checked
2026-11-07).

### `/metrics` (Prometheus, `llamacpp:*`, needs `--metrics`)

| Metric | Normalized | Type |
| --- | --- | --- |
| `llamacpp:requests_processing` | `running` | gauge |
| `llamacpp:requests_deferred` | `waiting` | gauge |
| `llamacpp:predicted_tokens_seconds` | `decode_tps` | gauge, tokens/s |
| `llamacpp:prompt_tokens_seconds` | `prefill_tps` | gauge, tokens/s |
| `llamacpp:prompt_tokens_total` | `prompt_tokens_total` | counter |
| `llamacpp:tokens_predicted_total` | `generation_tokens_total` | counter |
| `llamacpp:n_busy_slots_per_decode` | not mapped | gauge, slot occupancy per decode call |

### `/slots` and `/health`

| Source | Normalized | Notes |
| --- | --- | --- |
| `len(/slots)` | `slots` | equals `--parallel` / `n_parallel` |
| `is_processing` count | `running` (fallback when metrics are off) | per-slot boolean |
| `/health` `{"status": "ok"}` | `healthy=True` | 503 with an `error` body → `False` |
| `/v1/models` (or `/props.model_path`) | `models` | ids |

Quirks:

- **`/metrics` is opt-in.** Without `--metrics` it returns HTTP 501 with a JSON `error` body — a
  signature, not a transport failure. `probe()` keeps the body and does not set `error`.
- In **router mode** `/metrics` requires `?model=<id>` and returns 400 without it; a router is not a
  single server and should be polled per model.
- `predicted_tokens_seconds` / `prompt_tokens_seconds` are **averages since server start**, not
  instantaneous rates. They lag a burst; use counter deltas when the poller needs a live rate.
- `/slots` is disabled by `--no-slots`; idle slots are included, so `len()` is the concurrency cap.
- **No cached-token counter.** Prompt caches are per slot and never counted.

Detection signature: `/metrics` text with any `llamacpp:` name, `/slots` JSON list whose items have
`is_processing`, or `/health` JSON `{"status": "ok"}` with no richer signature.

---

## Ollama

Cited: <https://github.com/ollama/ollama/blob/main/docs/api.md> (`/api/ps`, `/api/version`, checked
2026-11-07).

| Endpoint | Normalized | Notes |
| --- | --- | --- |
| `/api/ps` | `models` | **loaded** models only; `name` / `model` |
| `/api/ps` `size`, `size_vram`, `expires_at`, `details` | not mapped | memory footprint and keep-alive |
| `/api/version` | `healthy=True` | version string |

Quirks: **Ollama has no Prometheus endpoint and no load counters.** `running`, `waiting`, `slots`,
`decode_tps`, `prefill_tps` and all token totals are `None`. Concurrency is the `OLLAMA_NUM_PARALLEL`
environment variable and is not exposed. Load has to come from request-side telemetry.

Detection signature: `/api/ps` JSON with a `models` list, or `/api/version` JSON with `version`.

---

## Generic OpenAI-compatible

| Endpoint | Normalized | Notes |
| --- | --- | --- |
| `/v1/models` | `models` | `data[].id` |
| `/v1/models` | `healthy=True` | a `data` list means the server answered |

Quirks: model ids and liveness only. No load, no slots, no token counters. This is the fallback kind for
anything that speaks the OpenAI API without a metrics surface.

Detection signature: `/v1/models` JSON with a `data` list and no stronger signature above.

---

## Cloud providers

No server metrics at all: no `/metrics`, no queue, no slots. A cloud lane can only be described from
request-side telemetry (observer events: request start/end, token counts, latency). `detect_kind()` never
returns `cloud`; a cloud base_url is configured explicitly and its snapshot stays empty.

---

## Rates: tok/s when a server only exposes counters

Some kinds report a rate gauge; others only report cumulative counters. `token_rate(prev_total,
cur_total, seconds)` implements the counter path:

```
tps = (cur_total - prev_total) / seconds_between_samples
```

It returns `None` when either sample is missing, the window is not positive, or the counter went
backwards (server restart) — never a fabricated number.

| Kind | decode tok/s | prefill tok/s |
| --- | --- | --- |
| TensorFold | `/health` gauge | `/health` gauge |
| SGLang | `sglang:gen_throughput` gauge | derive from `prompt_tokens_total` |
| llama.cpp | `predicted_tokens_seconds` gauge (smoothed) | `prompt_tokens_seconds` gauge (smoothed) |
| vLLM | derive from `generation_tokens` | derive from `prompt_tokens` |
| Ollama / OpenAI / cloud | unavailable | unavailable |

Polling rules:

- Keep at least two samples per server; the first poll has no rate. A 2–5 s interval is enough for a
  status chip and cheap for a production server.
- Use `sampled_at` from the two snapshots as the window, not the configured interval, so a slow poll does
  not inflate the rate.
- Cache-hit ratio for the window is `Δ cached_tokens_total / Δ prompt_tokens_total`; it is meaningful
  only when the prompt delta is non-zero.
- Never mix a `/health` instantaneous rate with a `/metrics` counter delta.

---

## Auto-detection

`detect_kind(responses)` reads signatures only — no network. `probe()` fills `responses` in this order,
each with the same short timeout: `/health`, `/metrics`, `/api/ps`, `/v1/models`, then one kind-specific
extra (`/slots` for llama.cpp, `/get_server_info` for SGLang, `/api/version` for Ollama).

| Kind | Signature |
| --- | --- |
| `tensorfold` | `/health` JSON with `live` object or `max_batch_size`; or `tensorfold:` metrics |
| `vllm` | `vllm:` metrics |
| `sglang` | `sglang:` metrics; or `/get_server_info` JSON with `max_total_num_tokens` / `server_args` |
| `llamacpp` | `llamacpp:` metrics; or `/slots` list with `is_processing`; or `/health` `{"status":"ok"}` |
| `ollama` | `/api/ps` JSON with `models`; or `/api/version` JSON with `version` |
| `openai` | `/v1/models` JSON with `data` list |
| `unknown` | nothing matched |

Order matters: the `/health` shape is checked before the `/metrics` prefix so TensorFold is never
mistaken for vLLM (it serves both), and llama.cpp's plain `{"status":"ok"}` is checked before the generic
OpenAI signature (llama.cpp also serves `/v1/models`).

`probe()` records transport errors (connection refused, timeout, DNS) in `error` and keeps HTTP error
bodies as signatures. If every probe endpoint returns HTTP >= 400, `error` says so.

---

## Fixture provenance

`tests/fixtures/servers/<kind>/...`, loaded by `tests/test_servers.py`.

| Fixture dir | Kind | Provenance |
| --- | --- | --- |
| `tensorfold-ds4/` | tensorfold | **captured live** 2026-11-07 from `http://127.0.0.1:18010` (`/health`, `/metrics`) |
| `tensorfold-gn100/` | tensorfold | **captured live** 2026-11-07 from `http://127.0.0.1:18009` (`/health`, `/metrics`) |
| `vllm/` | vllm | built from docs: v0.33.0 metric names and label shape |
| `vllm-legacy/` | vllm | built from docs: v0.8.5 `_total` names |
| `sglang/` | sglang | built from docs: `production_metrics` example output + `server_info` source shape |
| `llamacpp/` | llamacpp | built from docs: README metric table, `/slots` example, `/health` contract |
| `ollama/` | ollama | built from docs: `/api/ps` and `/api/version` example bodies |
| `openai/` | openai | built from docs: `/v1/models` standard body |

No fixture is invented beyond the documented names, labels and formats. Live captures are the only
fixtures with real traffic numbers.

---

## What each kind cannot give

- **Running / waiting:** Ollama, generic OpenAI-compatible and cloud providers report neither. Ollama's
  `/api/ps` shows loaded models, not requests.
- **Slots:** vLLM (launch argument only), Ollama, OpenAI-compatible, cloud.
- **Prefill tok/s:** vLLM and SGLang need counter deltas; Ollama and OpenAI-compatible have nothing.
- **Cached tokens:** llama.cpp and SGLang report no cached-token counter; SGLang only a hit-rate gauge.
- **Per-model load:** TensorFold reports one model per server with no labels; vLLM and SGLang sum across
  models in the snapshot.
