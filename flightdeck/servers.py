"""Read live load from model servers and normalize it into one snapshot.

Stdlib only (urllib + json), no async, no third-party dependencies.

Public API
----------
parse_prometheus(text) -> dict[str, list[tuple[dict[str, str], float]]]
detect_kind(responses) -> str
normalize(kind, responses) -> Snapshot
probe(base_url, timeout=2.0) -> Snapshot
token_rate(prev_total, cur_total, seconds) -> float | None

``responses`` is a plain dict mapping request path -> body, where a body is a
str, bytes, or an already-parsed JSON object.  ``probe`` builds that dict from
GETs; ``normalize`` never touches the network, so tests run on fixtures.

Every field a server kind does not report is ``None`` (``models`` is ``[]``).
``probe`` never raises: transport failures land in ``Snapshot.error``.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

__all__ = [
    "Snapshot",
    "parse_prometheus",
    "detect_kind",
    "normalize",
    "probe",
    "token_rate",
]

# Probe order is fixed and safe: every path is a GET and none of them mutate
# server state.  See docs/METRICS.md for the signature each one contributes.
PROBE_PATHS = ("/health", "/metrics", "/api/ps", "/v1/models")

# Extra endpoints fetched only after the kind is known.
KIND_EXTRAS = {
    "llamacpp": ("/slots",),
    "sglang": ("/get_server_info",),
    "ollama": ("/api/version",),
}

USER_AGENT = "flightdeck/0.1 (+model-server metrics adapter)"


@dataclass
class Snapshot:
    """One normalized reading of one model server."""

    name: str = ""
    base_url: str = ""
    kind: str = "unknown"
    healthy: bool | None = None
    models: list[str] = field(default_factory=list)
    running: int | None = None
    waiting: int | None = None
    slots: int | None = None
    decode_tps: float | None = None
    prefill_tps: float | None = None
    prompt_tokens_total: int | None = None
    cached_tokens_total: int | None = None
    generation_tokens_total: int | None = None
    sampled_at: str = ""
    error: str | None = None


# ---------------------------------------------------------------------------
# Prometheus text format
# ---------------------------------------------------------------------------

_ESCAPES = {"n": "\n", "t": "\t", "\\": "\\", '"': '"'}


def _split_labels(text: str) -> dict[str, str]:
    """Parse the inside of a Prometheus label block: a="1",b="x,y"."""
    labels: dict[str, str] = {}
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in ", \t":
            i += 1
        if i >= n:
            break
        eq = text.find("=", i)
        if eq < 0:
            break
        key = text[i:eq].strip()
        k = eq + 1
        while k < n and text[k] in " \t":
            k += 1
        if k < n and text[k] == '"':
            k += 1
            buf: list[str] = []
            while k < n:
                ch = text[k]
                if ch == "\\" and k + 1 < n:
                    buf.append(_ESCAPES.get(text[k + 1], text[k + 1]))
                    k += 2
                    continue
                if ch == '"':
                    k += 1
                    break
                buf.append(ch)
                k += 1
            labels[key] = "".join(buf)
        else:
            end = text.find(",", k)
            if end < 0:
                end = n
            labels[key] = text[k:end].strip()
            k = end
        i = k
    return labels


def parse_prometheus(text: str) -> dict[str, list[tuple[dict[str, str], float]]]:
    """Parse Prometheus exposition text into name -> [(labels, value), ...].

    HELP/TYPE comment lines are skipped.  Histogram buckets, _sum and _count
    companions are kept as separate names so callers can pick what they need.
    A sample with an unparseable value is dropped rather than raising.
    """
    out: dict[str, list[tuple[dict[str, str], float]]] = {}
    if not text:
        return out
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "{" in line:
            head, rest = line.split("{", 1)
            close = rest.rfind("}")
            if close < 0:
                continue
            labels = _split_labels(rest[:close])
            tail = rest[close + 1 :].strip()
        else:
            parts = line.split()
            if len(parts) < 2:
                continue
            head, labels, tail = parts[0], {}, parts[1]
        name = head.strip()
        if not name:
            continue
        fields = tail.split()
        if not fields:
            continue
        try:
            value = float(fields[0])
        except ValueError:
            continue
        out.setdefault(name, []).append((labels, value))
    return out


# ---------------------------------------------------------------------------
# Body / metric helpers
# ---------------------------------------------------------------------------


def _text(body: Any) -> str:
    if body is None:
        return ""
    if isinstance(body, bytes):
        return body.decode("utf-8", "replace")
    if isinstance(body, str):
        return body
    return json.dumps(body)


def _json(body: Any) -> Any:
    if body is None:
        return None
    if isinstance(body, (dict, list)):
        return body
    text = _text(body).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _metrics(responses: dict[str, Any]) -> dict[str, list[tuple[dict[str, str], float]]]:
    for key in ("/metrics", "metrics"):
        if key in responses:
            return parse_prometheus(_text(responses[key]))
    for key, body in responses.items():
        if key.endswith("/metrics"):
            return parse_prometheus(_text(body))
    return {}


def _sum(metrics, name: str) -> float | None:
    """Sum every sample of one metric name (across label sets)."""
    samples = metrics.get(name)
    if not samples:
        return None
    return sum(value for _, value in samples)


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sum_int(metrics, *names: str) -> int | None:
    for name in names:
        total = _sum(metrics, name)
        if total is not None:
            return int(total)
    return None


def _sum_float(metrics, *names: str) -> float | None:
    for name in names:
        total = _sum(metrics, name)
        if total is not None:
            return float(total)
    return None


def _label_values(metrics, label: str = "model_name") -> list[str]:
    seen: list[str] = []
    for samples in metrics.values():
        for labels, _ in samples:
            value = labels.get(label)
            if value and value not in seen:
                seen.append(value)
    return seen


def _is_error_body(body: Any) -> bool:
    parsed = _json(body)
    return isinstance(parsed, dict) and "error" in parsed


def _models_from_v1(body: Any) -> list[str]:
    parsed = _json(body)
    if not isinstance(parsed, dict):
        return []
    data = parsed.get("data")
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if isinstance(item, dict):
            ident = item.get("id") or item.get("model")
            if isinstance(ident, str) and ident:
                out.append(ident)
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def detect_kind(responses: dict[str, Any]) -> str:
    """Pick the server kind from response signatures alone.

    Order matters: the /health shape is checked before the /metrics prefix so
    TensorFold (which serves both) is never mistaken for vLLM, and llama.cpp's
    plain {"status": "ok"} is checked before the generic OpenAI signature.
    """
    health = _json(responses.get("/health"))
    if isinstance(health, dict):
        if isinstance(health.get("live"), dict) or "max_batch_size" in health:
            return "tensorfold"
        if health.get("status") == "ok":
            return "llamacpp"

    metrics = _metrics(responses)
    if any(name.startswith("tensorfold:") for name in metrics):
        return "tensorfold"
    if any(name.startswith("vllm:") for name in metrics):
        return "vllm"
    if any(name.startswith("sglang:") for name in metrics):
        return "sglang"
    if any(name.startswith("llamacpp:") for name in metrics):
        return "llamacpp"

    ps = _json(responses.get("/api/ps"))
    if isinstance(ps, dict) and isinstance(ps.get("models"), list):
        return "ollama"
    version = _json(responses.get("/api/version"))
    if isinstance(version, dict) and "version" in version:
        return "ollama"

    slots = _json(responses.get("/slots"))
    if isinstance(slots, list) and slots and isinstance(slots[0], dict) and "is_processing" in slots[0]:
        return "llamacpp"

    for path in ("/get_server_info", "/server_info"):
        info = _json(responses.get(path))
        if isinstance(info, dict) and ("max_total_num_tokens" in info or "server_args" in info):
            return "sglang"

    models = _json(responses.get("/v1/models"))
    if isinstance(models, dict) and isinstance(models.get("data"), list):
        return "openai"

    return "unknown"


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def normalize(kind: str, responses: dict[str, Any]) -> Snapshot:
    """Turn raw endpoint bodies into one Snapshot.  Missing data stays None."""
    snap = Snapshot(kind=kind or "unknown", sampled_at=_now())
    handler = _NORMALIZERS.get(snap.kind)
    if handler is None:
        snap.models = _models_from_v1(responses.get("/v1/models"))
        return snap
    handler(responses, snap)
    if not snap.name:
        snap.name = snap.models[0] if snap.models else snap.kind
    return snap


def _normalize_tensorfold(responses: dict[str, Any], snap: Snapshot) -> None:
    health = _json(responses.get("/health"))
    metrics = _metrics(responses)
    live = health.get("live") if isinstance(health, dict) else None
    live = live if isinstance(live, dict) else {}

    snap.running = _int(live.get("connections"))
    if snap.running is None:
        snap.running = _sum_int(metrics, "tensorfold:requests_running", "tensorfold:num_requests_running")
    snap.waiting = _int(live.get("waiting"))
    if snap.waiting is None:
        snap.waiting = _sum_int(metrics, "tensorfold:requests_waiting", "tensorfold:num_requests_waiting")
    snap.slots = _int(health.get("max_batch_size")) if isinstance(health, dict) else None
    snap.decode_tps = _float(live.get("decode_tokens_per_second"))
    snap.prefill_tps = _float(live.get("prefill_tokens_per_second"))
    snap.prompt_tokens_total = _sum_int(metrics, "tensorfold:prompt_tokens_total")
    snap.cached_tokens_total = _sum_int(metrics, "tensorfold:prompt_tokens_cached_total")
    snap.generation_tokens_total = _sum_int(metrics, "tensorfold:generation_tokens_total")

    if isinstance(health, dict):
        ids = health.get("model_ids")
        if isinstance(ids, list):
            snap.models = [str(x) for x in ids if isinstance(x, str) and x]
        elif isinstance(health.get("model"), str):
            snap.models = [health["model"]]
        if health.get("status") == "ok":
            snap.healthy = True
        elif "error" in health:
            snap.healthy = False
        elif health.get("status"):
            snap.healthy = False
    elif metrics:
        snap.healthy = True


def _normalize_vllm(responses: dict[str, Any], snap: Snapshot) -> None:
    metrics = _metrics(responses)
    snap.running = _sum_int(metrics, "vllm:num_requests_running")
    snap.waiting = _sum_int(metrics, "vllm:num_requests_waiting")
    # vLLM >= ~0.9 dropped the _total suffix; older builds still emit it.
    snap.prompt_tokens_total = _sum_int(metrics, "vllm:prompt_tokens", "vllm:prompt_tokens_total")
    snap.cached_tokens_total = _sum_int(
        metrics, "vllm:prompt_tokens_cached", "vllm:prefix_cache_hits", "vllm:prefix_cache_hits_total"
    )
    snap.generation_tokens_total = _sum_int(
        metrics, "vllm:generation_tokens", "vllm:generation_tokens_total"
    )
    snap.models = _models_from_v1(responses.get("/v1/models")) or _label_values(metrics)
    # vLLM exposes no max_num_seqs gauge and no tok/s gauge: both are derived
    # from counters by the poller (see token_rate / docs/METRICS.md).
    if "/health" in responses:
        snap.healthy = not _is_error_body(responses["/health"])
    elif metrics:
        snap.healthy = True


def _normalize_sglang(responses: dict[str, Any], snap: Snapshot) -> None:
    metrics = _metrics(responses)
    info = _json(responses.get("/get_server_info")) or _json(responses.get("/server_info"))
    info = info if isinstance(info, dict) else {}
    raw_args = info.get("server_args")
    args: dict[str, Any] = raw_args if isinstance(raw_args, dict) else {}

    snap.running = _sum_int(metrics, "sglang:num_running_reqs")
    snap.waiting = _sum_int(metrics, "sglang:num_queue_reqs")
    snap.decode_tps = _sum_float(metrics, "sglang:gen_throughput")
    snap.prompt_tokens_total = _sum_int(metrics, "sglang:prompt_tokens_total")
    snap.generation_tokens_total = _sum_int(metrics, "sglang:generation_tokens_total")
    # SGLang reports no cached-token counter and no prefill tok/s gauge; the
    # poller derives both (cache_hit_rate * prompt_tokens, counter rate).
    snap.slots = _int(info.get("max_running_requests"))
    if snap.slots is None:
        snap.slots = _int(args.get("max_running_requests"))
    snap.models = _label_values(metrics)
    if not snap.models and isinstance(info.get("model_path"), str):
        snap.models = [info["model_path"]]
    if "/health" in responses:
        snap.healthy = not _is_error_body(responses["/health"])
    elif metrics:
        snap.healthy = True


def _normalize_llamacpp(responses: dict[str, Any], snap: Snapshot) -> None:
    metrics = _metrics(responses)
    slots = _json(responses.get("/slots"))
    slots = slots if isinstance(slots, list) else []

    snap.running = _sum_int(metrics, "llamacpp:requests_processing")
    if snap.running is None and slots:
        snap.running = sum(1 for s in slots if isinstance(s, dict) and s.get("is_processing"))
    snap.waiting = _sum_int(metrics, "llamacpp:requests_deferred")
    snap.slots = len(slots) if slots else None
    snap.decode_tps = _sum_float(metrics, "llamacpp:predicted_tokens_seconds")
    snap.prefill_tps = _sum_float(metrics, "llamacpp:prompt_tokens_seconds")
    snap.prompt_tokens_total = _sum_int(metrics, "llamacpp:prompt_tokens_total")
    snap.generation_tokens_total = _sum_int(metrics, "llamacpp:tokens_predicted_total")
    # llama.cpp keeps prompt caches per slot but never counts cached tokens.

    snap.models = _models_from_v1(responses.get("/v1/models"))
    if not snap.models:
        props = _json(responses.get("/props"))
        if isinstance(props, dict) and isinstance(props.get("model_path"), str):
            snap.models = [props["model_path"]]
    if "/health" in responses:
        health = _json(responses["/health"])
        if isinstance(health, dict) and health.get("status") == "ok":
            snap.healthy = True
        elif _is_error_body(responses["/health"]):
            snap.healthy = False
    elif metrics:
        snap.healthy = True


def _normalize_ollama(responses: dict[str, Any], snap: Snapshot) -> None:
    ps = _json(responses.get("/api/ps"))
    if isinstance(ps, dict) and isinstance(ps.get("models"), list):
        names = []
        for item in ps["models"]:
            if isinstance(item, dict):
                ident = item.get("name") or item.get("model")
                if isinstance(ident, str) and ident:
                    names.append(ident)
        snap.models = names
    version = _json(responses.get("/api/version"))
    if isinstance(version, dict) and "version" in version:
        snap.healthy = True
    elif isinstance(ps, dict):
        snap.healthy = True
    # Ollama has no Prometheus endpoint: no running/waiting/slots/tok counters.


def _normalize_openai(responses: dict[str, Any], snap: Snapshot) -> None:
    models = _json(responses.get("/v1/models"))
    snap.models = _models_from_v1(models)
    if isinstance(models, dict) and isinstance(models.get("data"), list):
        snap.healthy = True
    # Generic OpenAI-compatible servers expose model ids only: no load data.


_NORMALIZERS = {
    "tensorfold": _normalize_tensorfold,
    "vllm": _normalize_vllm,
    "sglang": _normalize_sglang,
    "llamacpp": _normalize_llamacpp,
    "ollama": _normalize_ollama,
    "openai": _normalize_openai,
}


# ---------------------------------------------------------------------------
# Rates from counters
# ---------------------------------------------------------------------------


def token_rate(prev_total: int | None, cur_total: int | None, seconds: float | None) -> float | None:
    """tok/s between two counter samples: (cur - prev) / seconds.

    Returns None when either sample is missing, the window is not positive, or
    the counter went backwards (server restart) instead of inventing a number.
    """
    if prev_total is None or cur_total is None or seconds is None or seconds <= 0:
        return None
    delta = cur_total - prev_total
    if delta < 0:
        return None
    return delta / seconds


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------


def _get(url: str, timeout: float) -> tuple[str | None, int | None, str | None]:
    """GET one URL.  Returns (body, status, transport_error); never raises."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            return body, int(response.status), None
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - body is optional on HTTP errors
            body = ""
        return body, int(exc.code), None
    except Exception as exc:  # noqa: BLE001 - probe must never raise
        return None, None, f"{type(exc).__name__}: {exc}"


def probe(base_url: str, timeout: float = 2.0) -> Snapshot:
    """GET a server's probe endpoints and return a normalized Snapshot.

    Order: /health, /metrics, /api/ps, /v1/models, then one kind-specific extra
    (/slots, /get_server_info, /api/version).  All GETs, all bounded by
    ``timeout``.  Failures are recorded in ``error``; nothing is raised.
    """
    base = (base_url or "").rstrip("/")
    responses: dict[str, str] = {}
    transport_errors: list[str] = []
    statuses: list[int] = []

    for path in PROBE_PATHS:
        body, status, err = _get(base + path, timeout)
        if err is not None:
            transport_errors.append(f"{path}: {err}")
            continue
        if status is not None:
            statuses.append(status)
        if body is not None:
            responses[path] = body

    kind = detect_kind(responses)
    for path in KIND_EXTRAS.get(kind, ()):
        body, status, err = _get(base + path, timeout)
        if err is not None:
            transport_errors.append(f"{path}: {err}")
            continue
        if status is not None:
            statuses.append(status)
        if body is not None:
            responses[path] = body

    try:
        snap = normalize(kind, responses)
    except Exception as exc:  # noqa: BLE001 - probe must never raise
        snap = Snapshot(kind=kind, sampled_at=_now(), error=f"normalize failed: {exc}")

    snap.base_url = base
    if not snap.models:
        snap.name = base or snap.kind
    elif snap.name == snap.kind:
        snap.name = snap.models[0]

    if transport_errors:
        snap.error = "; ".join(transport_errors)
    elif statuses and all(status >= 400 for status in statuses):
        snap.error = f"all probe endpoints returned HTTP >=400 ({statuses[0]})"
    return snap
