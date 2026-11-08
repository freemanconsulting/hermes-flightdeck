"""Join the request-event store with live server samples into the §9.1 snapshot.

`build_snapshot()` is the page's one call.  It takes already-polled server
samples (`servers=`) or polls synchronously itself, reads the store's raw rows
through the pinned Brief A exports (`window_rows`, `in_flight_rows`,
`server_samples_since`) and derives every number in DESIGN §8.

Rules the backend guarantees (DESIGN §9.1): `label` is always `""`; `lane` is
`local` or `cloud`; `slots` is `None` for cloud and for kinds without a gauge;
`quota` is always `None` (the UI fills it from `session.stats`); numbers are
`None` when unknown, never `0`-as-unknown.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sqlite3
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
_MODULES: dict[str, Any] = {}

WINDOWS = {"1m": 60, "5m": 300}

#: The one clock every builder defaults to.  Tests monkeypatch this so seeded
#: rows and handler windows share a moment instead of racing the wall clock.
_now = time.time


# ---------------------------------------------------------------------------
# Plugin-root sibling loading (same path loader as poller.py / plugin_api.py)
# ---------------------------------------------------------------------------


def _load_sibling(name: str) -> Any:
    """Load a plugin-root module by path, once, under a plugin-scoped name.

    Returns None when the file does not exist yet (Brief A's store.py lands in
    parallel), so this module imports cleanly before integration.
    """
    module = _MODULES.get(name)
    if module is not None:
        return module
    module_name = f"flightdeck_{name}"
    module = sys.modules.get(module_name)
    if module is None:
        path = _ROOT / f"{name}.py"
        if not path.exists():
            return None
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    _MODULES[name] = module
    return module


def _store_module() -> Any:
    return _load_sibling("store")


def _poller_module() -> Any:
    return _load_sibling("poller")


def _config_module() -> Any:
    return _load_sibling("config")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _now_iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_base_url(url: str | None) -> str:
    """Match key: strip trailing `/` and `/v1`, lowercase scheme+host, keep port."""
    if not url:
        return ""
    text = str(url).strip().rstrip("/")
    if text.endswith("/v1"):
        text = text[:-3].rstrip("/")
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return text.lower()
    if not parts.scheme or not parts.netloc:
        return text.lower()
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{parts.path.rstrip('/')}"


def _dict_rows(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    columns = [description[0] for description in cursor.description or ()]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _sample_dict(sample: Any) -> dict[str, Any]:
    if isinstance(sample, dict):
        return dict(sample)
    fields = (
        "name", "title", "base_url", "kind", "healthy", "models", "running", "waiting", "slots",
        "decode_tps", "prefill_tps", "prompt_tokens_total", "cached_tokens_total",
        "generation_tokens_total", "sampled_at", "error",
        "kv_cache_usage", "kv_cache_usage_mean", "prefix_cache_hit_rate", "spec_accept_rate",
        "server_ttft_p50", "server_ttft_p95", "server_latency_p50", "server_latency_p95",
        "server_tpot_p50", "preemptions_total", "preemptions_delta", "disconnects_total",
        "disconnects_delta", "memory_bytes", "memory_peak_bytes",
    )
    return {field: getattr(sample, field, None) for field in fields}


def _host_port(url: str | None) -> str:
    """A URL's host:port — the last-resort card label (DESIGN §7.2)."""
    try:
        parts = urllib.parse.urlsplit(str(url or ""))
    except ValueError:
        return str(url or "")
    return parts.netloc or str(url or "")


def _percentile(values: list[float], pct: float) -> float | None:
    """Nearest-rank percentile; None on an empty list."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = max(0, min(len(ordered) - 1, math.ceil(pct / 100.0 * len(ordered)) - 1))
    return ordered[rank]


def _int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(float(value), digits)


#: A response is "streamed" only when its decode span is long enough to mean
#: something and covers most of the request.  Providers that return the whole
#: body at once set first_chunk_at ≈ ended_at, so completion/(ended-first) is a
#: bogus rate: those rows are non-streamed and carry no decode number at all
#: (DESIGN §8).
MIN_DECODE_SECONDS = 0.25
MIN_DECODE_SHARE = 0.10


def _decode_span(started: float | None, first: float | None,
                 ended: float | None) -> float | None:
    """Decode seconds for one row; ``None`` when the row is non-streamed."""
    if started is None or first is None or ended is None:
        return None
    if first < started or ended <= first:
        return None
    span = ended - first
    total = ended - started
    if span < MIN_DECODE_SECONDS or span < MIN_DECODE_SHARE * total:
        return None
    return span


def _latency(started: float | None, ended: float | None) -> float | None:
    """Whole-request seconds (ended - started), the number a non-streamed row reports."""
    if started is None or ended is None or ended <= started:
        return None
    return ended - started


def _open_conn() -> sqlite3.Connection:
    store = _store_module()
    if store is None:
        raise RuntimeError("store.py is not available yet; pass conn= explicitly")
    return store.open_store()


# ---------------------------------------------------------------------------
# Store reads (pinned Brief A exports, with an inline fallback before A lands)
# ---------------------------------------------------------------------------


def _window_rows(conn: sqlite3.Connection, since: float, limit: int = 5000) -> list[dict]:
    store = _store_module()
    if store is not None and hasattr(store, "window_rows"):
        return list(store.window_rows(conn, since, limit=limit))
    return _dict_rows(
        conn.execute(
            "SELECT * FROM requests WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?",
            (since, limit),
        )
    )


def _in_flight_rows(conn: sqlite3.Connection) -> list[dict]:
    store = _store_module()
    if store is not None and hasattr(store, "in_flight_rows"):
        return list(store.in_flight_rows(conn))
    return _dict_rows(
        conn.execute("SELECT * FROM requests WHERE status = 'in-flight' ORDER BY started_at")
    )


def _server_samples_since(conn: sqlite3.Connection, since: float) -> list[dict]:
    store = _store_module()
    if store is not None and hasattr(store, "server_samples_since"):
        return list(store.server_samples_since(conn, since))
    return _dict_rows(
        conn.execute(
            "SELECT * FROM server_samples WHERE ts >= ? ORDER BY ts", (since,)
        )
    )


def _last_good_sample_ts(conn: sqlite3.Connection, base_url: str) -> float | None:
    """Epoch of the newest healthy server_samples row for one server, or None."""
    try:
        rows = _dict_rows(conn.execute(
            "SELECT MAX(ts) AS ts FROM server_samples WHERE base_url = ? AND error IS NULL",
            (base_url,),
        ))
    except sqlite3.Error:
        return None
    return _num(rows[0].get("ts")) if rows else None


def _iso_epoch(iso: Any) -> float | None:
    """Epoch seconds from an ISO 8601 UTC string, or None."""
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _subagent_links(conn: sqlite3.Connection) -> dict[str, dict]:
    try:
        rows = _dict_rows(conn.execute("SELECT * FROM subagent_links"))
    except sqlite3.Error:
        return {}
    return {row.get("child_session_id") or "": row for row in rows}


def _settings(conn: sqlite3.Connection | None) -> dict:
    """config.load() settings (declared servers + poll knobs), or defaults."""
    config = _config_module()
    if config is not None and hasattr(config, "load"):
        try:
            return dict(config.load(conn=conn))
        except Exception:
            pass
    return {"servers": [], "poll_interval_seconds": 5, "probe_timeout_seconds": 2.0}


def _default_servers(conn: sqlite3.Connection | None) -> list[dict]:
    """Declared/auto-discovered servers from config.py, or [] before it lands."""
    return list(_settings(conn).get("servers") or [])


def _decisions(conn: sqlite3.Connection, now: float, retention_hours: float = 24) -> list[dict]:
    """Newest routing decisions inside the retention window (CAPACITY.md §6.2)."""
    store = _store_module()
    if store is None or not hasattr(store, "decisions_since"):
        return []
    try:
        return list(store.decisions_since(
            conn, float(now) - float(retention_hours) * 3600.0, limit=20))
    except sqlite3.Error:
        return []


def _routed_for_links(conn: sqlite3.Connection, links: dict[str, dict]) -> dict[str, dict]:
    """``child_session_id → routed``; {} when the store has no decisions table."""
    store = _store_module()
    if store is None or not hasattr(store, "decisions_for_links"):
        return {}
    try:
        return store.decisions_for_links(conn, links)
    except sqlite3.Error:
        return {}


def _routing(settings: dict) -> dict:
    """``capacity.arm_status`` for the page; a safe off block when capacity.py is absent."""
    capacity = _load_sibling("capacity")
    config = _config_module()
    if capacity is None or config is None:
        return {"armed": False, "backend": "default", "inner_backend": "default",
                "blocked_by": None, "message": "", "eligible_lanes": []}
    try:
        return capacity.arm_status(settings, config.delegation_section(),
                                   servers=settings.get("servers") or [])
    except Exception:
        return {"armed": False, "backend": "default", "inner_backend": "default",
                "blocked_by": None, "message": "", "eligible_lanes": []}


def routing_block(snapshot: dict) -> dict:
    """The snapshot's ``routing`` block plus the newest decision, for the tool/one-liner."""
    routing = dict(snapshot.get("routing") or {})
    last = (snapshot.get("decisions") or [None])[0]
    routing["last_decision"] = None if not last else {
        "action": last.get("action"),
        "lane": last.get("chosen_lane") or last.get("requested_lane"),
        "requested_lane": last.get("requested_lane"),
        "reason": last.get("reason"),
        "at": _now_iso(last.get("at")),
    }
    return routing


# ---------------------------------------------------------------------------
# Server cards
# ---------------------------------------------------------------------------


def _server_health(sample: dict) -> dict | None:
    """The card's ``health`` block: normalized engine fields, display-rounded.

    A card with no reported health field carries ``health: None`` — llama.cpp,
    Ollama and cloud lanes report none of these (DESIGN §9.1).  Bytes stay
    bytes; the UI formats GB.  ``preemptions_delta``/``disconnects_delta`` are
    None on a first sample (no interval yet) and the lifetime totals ride
    beside them.
    """
    health: dict[str, Any] = {}
    for field, digits in (
        ("kv_cache_usage", 4), ("kv_cache_usage_mean", 4),
        ("prefix_cache_hit_rate", 3), ("spec_accept_rate", 3),
        ("server_ttft_p50", 2), ("server_ttft_p95", 2),
        ("server_latency_p50", 2), ("server_latency_p95", 2),
        ("server_tpot_p50", 4),
    ):
        value = _num(sample.get(field))
        health[field] = None if value is None else round(value, digits)
    for field in ("preemptions_total", "preemptions_delta", "disconnects_total",
                  "disconnects_delta", "memory_bytes", "memory_peak_bytes"):
        health[field] = _int_or_none(sample.get(field))
    if all(value is None for value in health.values()):
        return None
    return health


def _server_cards(samples: list[dict], request_rows: list[dict], in_flight: list[dict],
                  sample_rows: list[dict], now: float) -> list[dict]:
    by_url: dict[str, list[dict]] = {}
    for row in in_flight:
        by_url.setdefault(normalize_base_url(row.get("base_url")), []).append(row)

    lane_rows: dict[str, list[dict]] = {}
    for row in request_rows:
        lane_rows.setdefault(normalize_base_url(row.get("base_url")), []).append(row)

    history: dict[str, list[dict]] = {}
    for row in sample_rows:
        history.setdefault(normalize_base_url(row.get("base_url")), []).append(row)

    cards = []
    for sample in samples:
        sample = _sample_dict(sample)
        base_url = normalize_base_url(sample.get("base_url"))
        held = by_url.get(base_url, [])
        past = sorted(history.get(base_url, []), key=lambda item: item.get("ts") or 0)
        last = past[-1] if past else {}

        running = _int_or_none(sample.get("running"))
        waiting = _int_or_none(sample.get("waiting"))
        slots = _int_or_none(sample.get("slots"))
        decode_tps = _num(sample.get("decode_tps"))
        prefill_tps = _num(sample.get("prefill_tps"))
        healthy = sample.get("healthy")
        # Unreachable: show the last good sample's gauges beside the error (§7.3).
        if sample.get("error"):
            if running is None:
                running = _int_or_none(last.get("running"))
            if waiting is None:
                waiting = _int_or_none(last.get("waiting"))
            if slots is None:
                slots = _int_or_none(last.get("slots"))
            if decode_tps is None:
                decode_tps = _num(last.get("decode_tps"))
            if prefill_tps is None:
                prefill_tps = _num(last.get("prefill_tps"))
            if healthy is None and last.get("healthy") is not None:
                healthy = bool(last.get("healthy"))

        held_agents: dict[tuple, dict] = {}
        for row in held:
            key = (row.get("profile") or "", row.get("session_id") or "")
            entry = held_agents.get(key)
            if entry is None:
                entry = held_agents[key] = {
                    "profile": key[0], "session_id": key[1], "label": "",
                    "kind": _row_kind(row), "model": row.get("model"),
                    "requests": 0, "oldest_started_at": None,
                }
            entry["requests"] += 1
            started = _num(row.get("started_at"))
            if started is not None and (entry["oldest_started_at"] is None or started < entry["oldest_started_at"]):
                entry["oldest_started_at"] = started

        in_flight_count = len(held)
        # The swim-lane's rows: in-flight plus ended in the last 60 s, newest
        # first, capped per server (DESIGN §9.1).
        lane = sorted(lane_rows.get(base_url, []),
                      key=lambda item: _num(item.get("started_at")) or 0, reverse=True)[:50]
        cards.append({
            "name": sample.get("name") or _host_port(base_url),
            "title": sample.get("title"),
            "aux": sample.get("aux"),
            "roles": list(sample.get("roles") or []),
            "base_url": base_url,
            "kind": sample.get("kind") or "unknown",
            "healthy": None if healthy is None else bool(healthy),
            "models": list(sample.get("models") or []),
            "running": running,
            "waiting": waiting,
            "slots": slots,
            "decode_tps": decode_tps,
            "prefill_tps": prefill_tps,
            "health": _server_health(sample),
            "in_flight": in_flight_count,
            "unattributed": None if running is None else max(0, running - in_flight_count),
            "over_attributed": None if running is None else max(0, in_flight_count - running),
            "agents": list(held_agents.values()),
            "requests": [_request_row(row) for row in lane],
            "samples": [[item.get("ts"), item.get("decode_tps"), item.get("prefill_tps")]
                        for item in past[-60:]],
            "error": sample.get("error"),
            "sampled_at": sample.get("sampled_at") or _now_iso(_num(last.get("ts"))),
        })
    return cards


def _row_kind(row: dict) -> str:
    if row.get("subagent_id"):
        return "subagent"
    if row.get("cron_job_id") or row.get("cron_job_name"):
        return "cron"
    return "session"


def _request_rows(conn: sqlite3.Connection, now: float) -> list[dict]:
    """Rows the swim-lane draws: every in-flight row plus rows ended in the last 60 s."""
    return _dict_rows(conn.execute(
        "SELECT * FROM requests WHERE status = 'in-flight' "
        "OR (ended_at IS NOT NULL AND ended_at >= ?) ORDER BY started_at DESC",
        (float(now) - 60.0,),
    ))


def _request_row(row: dict) -> dict:
    """One §9.1 `requests` entry — exactly the shape desktop/plugin.js reads."""
    return {
        "id": row.get("id"),
        "profile": row.get("profile") or "",
        "session_id": row.get("session_id"),
        "parent_session_id": row.get("parent_session_id"),
        "kind": _row_kind(row),
        "model": row.get("model"),
        "started_at": _num(row.get("started_at")),
        "first_chunk_at": _num(row.get("first_chunk_at")),
        "ended_at": _num(row.get("ended_at")),
        "status": row.get("status"),
        "prompt_tokens": _int_or_none(row.get("prompt_tokens")),
        "cached_tokens": _int_or_none(row.get("cached_tokens")),
        "completion_tokens": _int_or_none(row.get("completion_tokens")),
    }


def _is_private_url(base_url: str | None) -> bool:
    """Loopback/RFC1918/link-local endpoint: a local lane even with no card."""
    config = _config_module()
    if config is None:
        return False
    try:
        return bool(config.is_private_host(urllib.parse.urlsplit(str(base_url or "")).hostname))
    except ValueError:
        return False


def _lane_for(base_url: str | None, server_by_url: dict[str, dict]) -> str:
    """``local`` or ``cloud``: a server card decides, else the address does.

    A private or loopback base_url is a local lane even when no server card
    matched (the server may be declared in another profile or only in
    ``auxiliary``); it then renders as "no server metrics", never as cloud.
    """
    card = server_by_url.get(normalize_base_url(base_url))
    if card is not None:
        return "local" if card.get("kind") != "cloud" else "cloud"
    return "local" if _is_private_url(base_url) else "cloud"


def _server_name_for(base_url: str | None, server_by_url: dict[str, dict],
                     provider: str | None) -> str:
    card = server_by_url.get(normalize_base_url(base_url))
    if card is not None:
        return str(card.get("name") or card.get("base_url") or "")
    if provider:
        return str(provider)
    try:
        host = urllib.parse.urlsplit(str(base_url or "")).netloc
    except ValueError:
        host = ""
    return host or str(base_url or "")


# ---------------------------------------------------------------------------
# Model cards
# ---------------------------------------------------------------------------


def _model_cards(rows: list[dict], server_cards: list[dict], now: float,
                 window_seconds: int = 300) -> list[dict]:
    server_by_url = {normalize_base_url(card["base_url"]): card for card in server_cards}
    bucket_seconds = 15
    bucket_count = max(1, int(window_seconds) // bucket_seconds)
    since = now - float(window_seconds)
    groups: dict[tuple, list[dict]] = {}
    aliases: dict[tuple, list[str]] = {}
    for row in rows:
        base_url = normalize_base_url(row.get("base_url"))
        provider = str(row.get("provider") or "")
        # Local lanes group by endpoint + model: callers report different
        # provider names for the same local server (custom vs studio-ds4).
        # Cloud lanes keep the provider in the key; it is their identity.
        lane = _lane_for(base_url, server_by_url)
        key = (row.get("model") or "", "" if lane == "local" else provider, base_url)
        groups.setdefault(key, []).append(row)
        if lane == "local" and provider and provider not in aliases.setdefault(key, []):
            aliases[key].append(provider)

    cards = []
    for (model, key_provider, base_url), items in groups.items():
        server = server_by_url.get(base_url)
        lane = _lane_for(base_url, server_by_url)
        provider_aliases = aliases.get((model, key_provider, base_url), [])
        provider = key_provider or (provider_aliases[0] if provider_aliases else "")
        server_name = _server_name_for(base_url, server_by_url, provider)

        in_flight = sum(1 for row in items if row.get("status") == "in-flight")
        requests_1m = sum(1 for row in items if (_num(row.get("started_at")) or 0) >= now - 60)
        requests_5m = sum(1 for row in items if (_num(row.get("started_at")) or 0) >= now - 300)
        errors_5m = sum(1 for row in items if row.get("status") == "error"
                         and (_num(row.get("started_at")) or 0) >= now - 300)
        errors_429_5m = sum(1 for row in items if _int_or_none(row.get("status_code")) == 429
                            and (_num(row.get("started_at")) or 0) >= now - 300)

        ttfts = []
        latencies = []
        decode_seconds = 0.0
        decode_tokens = 0.0
        prefill_seconds = 0.0
        prefill_tokens = 0.0
        streamed = 0
        non_streamed = 0
        for row in items:
            started = _num(row.get("started_at"))
            first = _num(row.get("first_chunk_at"))
            ended = _num(row.get("ended_at"))
            completion = _num(row.get("completion_tokens"))
            prompt = _num(row.get("prompt_tokens"))
            cached = _num(row.get("cached_tokens")) or 0.0
            latency = _latency(started, ended)
            if latency is not None:
                latencies.append(latency * 1000.0)
            span = _decode_span(started, first, ended)
            if span is not None and started is not None and first is not None:
                streamed += 1
                ttfts.append((first - started) * 1000.0)
                if completion is not None:
                    decode_seconds += span
                    decode_tokens += completion
                if prompt is not None and first > started:
                    prefill_seconds += first - started
                    prefill_tokens += max(0.0, prompt - cached)
            elif ended is not None and started is not None and ended > started:
                # Whole-response row: no TTFT, no decode rate. Its honest number
                # is latency (ended - started), reported separately.
                non_streamed += 1

        decode_tps = None
        prefill_tps = None
        rate_kind = None
        if server is not None and server.get("decode_tps") is not None:
            decode_tps = server.get("decode_tps")
            rate_kind = "decode"
        elif decode_seconds > 0:
            decode_tps = decode_tokens / decode_seconds
            rate_kind = "decode"
        if server is not None and server.get("prefill_tps") is not None:
            prefill_tps = server.get("prefill_tps")
        elif prefill_seconds > 0:
            prefill_tps = prefill_tokens / prefill_seconds

        buckets = [0] * bucket_count
        for row in items:
            started = _num(row.get("started_at"))
            if started is None or started < since:
                continue
            index = int((started - since) / bucket_seconds)
            buckets[min(max(index, 0), bucket_count - 1)] += 1

        tokens = {
            "prompt": sum(_int_or_none(row.get("prompt_tokens")) or 0 for row in items),
            "cached": sum(_int_or_none(row.get("cached_tokens")) or 0 for row in items),
            "completion": sum(_int_or_none(row.get("completion_tokens")) or 0 for row in items),
            "reasoning": sum(_int_or_none(row.get("reasoning_tokens")) or 0 for row in items),
        }

        slots = None
        if lane == "local" and server is not None and server.get("slots") is not None:
            slots = {
                "used": server.get("running"),
                "total": server.get("slots"),
                "queue": server.get("waiting"),
            }

        held: dict[tuple, dict] = {}
        for row in items:
            if row.get("status") != "in-flight":
                continue
            key = (row.get("profile") or "", row.get("session_id") or "")
            entry = held.get(key)
            if entry is None:
                entry = held[key] = {"profile": key[0], "session_id": key[1], "label": "", "in_flight": 0}
            entry["in_flight"] += 1

        cards.append({
            "key": f"{server_name}|{model}",
            "model": model,
            "provider": provider,
            "provider_aliases": provider_aliases,
            "base_url": base_url,
            "server_name": server_name,
            "kind": server.get("kind") if server is not None else ("local" if lane == "local" else "cloud"),
            "metrics": "server" if server is not None else "none",
            "lane": lane,
            "in_flight": in_flight,
            "requests_1m": requests_1m,
            "requests_5m": requests_5m,
            "errors_5m": errors_5m,
            "errors_429_5m": errors_429_5m,
            "streamed": streamed,
            "non_streamed": non_streamed,
            "requests_buckets": buckets,
            "ttft_ms_p50": _round(_percentile(ttfts, 50), 1),
            "ttft_ms_p95": _round(_percentile(ttfts, 95), 1),
            "latency_ms_p50": _round(_percentile(latencies, 50), 1),
            "latency_ms_p95": _round(_percentile(latencies, 95), 1),
            "decode_tps": _round(decode_tps, 1),
            "prefill_tps": _round(prefill_tps, 1),
            "rate_kind": rate_kind,
            "tokens": tokens,
            "slots": slots,
            "agents": list(held.values()),
            "quota": None,
        })

    cards.sort(key=lambda card: (card["lane"] != "local", -(card["in_flight"] or 0),
                                 -(card["requests_5m"] or 0), card["key"]))
    return cards


# ---------------------------------------------------------------------------
# Agent tree
# ---------------------------------------------------------------------------


def _agent_models(items: list[dict], server_by_url: dict[str, dict]) -> list[dict]:
    """Per-node model breakdown: one entry per model lane used in the window.

    Local lanes are labelled by the server card's short name plus the model
    (``studio-ds4 · ds4``); cloud lanes by ``provider/model``.  ``lane_id`` is
    the normalized base_url for a local lane and ``cloud:<provider>`` for a
    cloud lane, so the UI can merge chips across sessions and profile rows.
    """
    grouped: dict[str, dict] = {}
    # Timing/error samples per lane, kept out of the returned dicts and
    # finalized into p50/error counts after the loop.
    timings: dict[str, dict] = {}
    for row in items:
        base_url = normalize_base_url(row.get("base_url"))
        # Same rule as ``_lane_for``: a card decides by kind, else the address
        # does.  A cloud card (anthropic) is not local just because it exists.
        local = _lane_for(base_url, server_by_url) == "local"
        model = str(row.get("model") or "")
        provider = str(row.get("provider") or "")
        if local:
            lane_id = base_url or "local:unknown"
            server_name = _server_name_for(base_url, server_by_url, provider)
            label = f"{server_name} · {model}" if model else server_name
        else:
            lane_id = f"cloud:{provider}" if provider else "cloud:unknown"
            label = f"{provider}/{model}" if provider and model else (model or provider or "cloud")
        entry = grouped.get(lane_id)
        if entry is None:
            entry = grouped[lane_id] = {
                "lane_id": lane_id, "label": label, "local": local,
                "requests": 0, "in_flight": 0,
                "tokens_in": 0, "tokens_out": 0, "cached_tokens": 0,
            }
            timings[lane_id] = {"latencies": [], "ttfts": [], "errors": 0}
        entry["requests"] += 1
        if row.get("status") == "in-flight":
            entry["in_flight"] += 1
        if row.get("status") == "error":
            timings[lane_id]["errors"] += 1
        entry["tokens_in"] += _int_or_none(row.get("prompt_tokens")) or 0
        entry["tokens_out"] += _int_or_none(row.get("completion_tokens")) or 0
        entry["cached_tokens"] += _int_or_none(row.get("cached_tokens")) or 0
        # Same formulas as the node-level latency/ttft in ``_agent_tree``.
        row_started = _num(row.get("started_at"))
        first = _num(row.get("first_chunk_at"))
        ended = _num(row.get("ended_at"))
        latency = _latency(row_started, ended)
        if latency is not None:
            timings[lane_id]["latencies"].append(latency * 1000.0)
        if row_started is not None and first is not None and first >= row_started:
            timings[lane_id]["ttfts"].append((first - row_started) * 1000.0)
    for lane_id, entry in grouped.items():
        sample = timings[lane_id]
        entry["latency_ms_p50"] = _round(_percentile(sample["latencies"], 50), 1)
        entry["ttft_ms_p50"] = _round(_percentile(sample["ttfts"], 50), 1)
        entry["errors_5m"] = sample["errors"]
    return sorted(grouped.values(), key=lambda entry: (-entry["in_flight"], -entry["requests"],
                                                       entry["label"]))


def _agent_tree(rows: list[dict], links: dict[str, dict],
                server_by_url: dict[str, dict] | None = None,
                routed: dict[str, dict] | None = None) -> list[dict]:
    server_by_url = server_by_url or {}
    routed = routed or {}
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        groups.setdefault((row.get("profile") or "", row.get("session_id") or ""), []).append(row)

    nodes: dict[tuple, dict] = {}
    for key, items in groups.items():
        profile, session_id = key
        in_flight_rows = [row for row in items if row.get("status") == "in-flight"]
        started = [_num(row.get("started_at")) for row in in_flight_rows]
        started = [value for value in started if value is not None]
        # Last activity is the last request this session finished (or its start
        # while still in flight) inside the window — a real timestamp, not a
        # "requests in the window" guess.
        active = [_num(row.get("ended_at")) if row.get("ended_at") is not None else _num(row.get("started_at"))
                  for row in items]
        active = [value for value in active if value is not None]
        parent = next((row.get("parent_session_id") for row in items if row.get("parent_session_id")), None)
        cron_job = next((row.get("cron_job_name") or row.get("cron_job_id") for row in items
                         if row.get("cron_job_name") or row.get("cron_job_id")), None)
        ttfts: list[float] = []
        latencies: list[float] = []
        for row in items:
            row_started = _num(row.get("started_at"))
            first = _num(row.get("first_chunk_at"))
            ended = _num(row.get("ended_at"))
            latency = _latency(row_started, ended)
            if latency is not None:
                latencies.append(latency * 1000.0)
            if row_started is not None and first is not None and first >= row_started:
                ttfts.append((first - row_started) * 1000.0)
        nodes[key] = {
            "profile": profile,
            "session_id": session_id,
            "label": "",
            "kind": _row_kind(items[0]),
            "parent_session_id": parent,
            "cron_job": cron_job,
            "in_flight": len(in_flight_rows),
            "requests_5m": len(items),
            "errors_5m": sum(1 for row in items if row.get("status") == "error"),
            "models": _agent_models(items, server_by_url),
            "oldest_started_at": min(started) if started else None,
            "last_active_at": max(active) if active else None,
            "tokens_in": sum(_int_or_none(row.get("prompt_tokens")) or 0 for row in items),
            "tokens_out": sum(_int_or_none(row.get("completion_tokens")) or 0 for row in items),
            "cached_tokens": sum(_int_or_none(row.get("cached_tokens")) or 0 for row in items),
            "latency_ms_p50": _round(_percentile(latencies, 50), 1),
            "ttft_ms_p50": _round(_percentile(ttfts, 50), 1),
            "children": [],
        }

    roots: list[dict] = []
    for key, node in nodes.items():
        parent_key = (node["profile"], node["parent_session_id"] or "")
        if node["parent_session_id"] and parent_key in nodes:
            link = links.get(node["session_id"] or "") or {}
            child = dict(node)
            child.pop("children", None)
            child["role"] = link.get("role") or node.get("kind")
            child["goal"] = link.get("goal") or ""
            nodes[parent_key]["children"].append(child)
        else:
            roots.append(node)

    roots.sort(key=lambda node: (-node["in_flight"], -node["requests_5m"], node["session_id"]))
    for node in roots:
        node["children"].sort(key=lambda child: (-child["in_flight"], -child["requests_5m"],
                                                 child["session_id"] or ""))
    # Only subagent nodes carry `routed`; root sessions and cron nodes never do.
    if routed:
        for node in roots:
            if node.get("kind") == "subagent":
                info = routed.get(node.get("session_id") or "")
                if info:
                    node["routed"] = dict(info)
            for child in node.get("children") or []:
                info = routed.get(child.get("session_id") or "")
                if info:
                    child["routed"] = dict(info)
    return roots


# ---------------------------------------------------------------------------
# Public builders
# ---------------------------------------------------------------------------


def _requested_urls_since(conn: sqlite3.Connection, since: float) -> set[str]:
    """Normalized base_urls that served at least one Hermes request since *since*."""
    rows = _dict_rows(conn.execute(
        "SELECT DISTINCT base_url FROM requests WHERE started_at >= ?", (float(since),)))
    return {normalize_base_url(row.get("base_url")) for row in rows if row.get("base_url")}


def _sample_hidden(sample: dict, hidden: list[str]) -> bool:
    """A sample matches a ``hidden_servers`` entry by normalized base_url or name."""
    if not hidden:
        return False
    url = normalize_base_url(sample.get("base_url"))
    name = str(sample.get("name") or "").strip().lower()
    for entry in hidden:
        text = str(entry or "").strip()
        if not text:
            continue
        if name and text.lower() == name:
            return True
        if url and normalize_base_url(text) == url:
            return True
    return False


def build_snapshot(window_seconds: int = 300, *, servers: Any = None,
                   conn: sqlite3.Connection | None = None, now: float | None = None,
                   servers_source: str | None = None,
                   hidden_servers: list[str] | None = None,
                   retention_hours: int | None = None,
                   routing: dict | None = None) -> dict:
    """The §9.1 snapshot.  ``servers`` is already-polled samples (dict or list);
    None means poll the declared servers synchronously; [] means no server cards.
    ``servers_source`` overrides the derived source — /servers passes
    ``discovered`` so dead servers fold out of the chip too (DESIGN §7.2).
    ``hidden_servers`` filters passed samples by name or base_url; the live path
    is already filtered by ``config.load``.  ``retention_hours`` bounds the
    idle-server check (default 24).  ``routing`` pins the routing block (tests,
    dashboard) instead of reading config.yaml; None computes it."""
    conn = conn if conn is not None else _open_conn()
    now = _now() if now is None else float(now)
    since = now - float(window_seconds)

    settings_hidden: list[str] = []
    if servers is None:
        settings = _settings(conn)
        settings_hidden = list(settings.get("hidden_servers") or [])
        declared = list(settings.get("servers") or [])
        derived_source = str(settings.get("servers_source") or "declared")
        poller = _poller_module()
        if poller is not None and declared:
            samples = list(poller.poll_sync(
                declared, ttl=settings.get("poll_interval_seconds", 5),
                timeout=settings.get("probe_timeout_seconds", 2.0), conn=conn,
            ).values())
        else:
            samples = []
        if retention_hours is None:
            retention_hours = settings.get("retention_hours", 24)
    elif isinstance(servers, dict):
        samples = [_sample_dict(value) for value in servers.values()]
        derived_source = "declared"
    else:
        samples = [_sample_dict(value) for value in servers]
        derived_source = "declared"
    servers_source = derived_source if servers_source is None else str(servers_source)
    hidden_list = list(hidden_servers or [])
    if servers is None and not hidden_list:
        hidden_list = settings_hidden
    if hidden_list:
        samples = [sample for sample in samples if not _sample_hidden(sample, hidden_list)]

    rows = _window_rows(conn, since)
    in_flight = _in_flight_rows(conn)
    sample_rows = _server_samples_since(conn, since)

    server_cards = _server_cards(samples, _request_rows(conn, now), in_flight, sample_rows, now)
    # Dead-server noise (DESIGN §7.2): a discovered server that is unreachable
    # and served no request in the window is not a card — it is one line in
    # `unreachable`. Declared servers always stay in `servers`.
    unreachable: list[dict] = []
    if servers_source != "declared":
        requested = {normalize_base_url(row.get("base_url")) for row in rows}
        kept = []
        for card in server_cards:
            if card.get("error") and normalize_base_url(card["base_url"]) not in requested:
                unreachable.append({
                    "name": card["name"],
                    "base_url": card["base_url"],
                    "error": card["error"],
                    "since": (_last_good_sample_ts(conn, card["base_url"])
                              or _iso_epoch(card.get("sampled_at"))),
                })
            else:
                kept.append(card)
        server_cards = kept
    # Idle servers (DESIGN §9.1): a discovered server with no Hermes request in
    # the retention window and no running/waiting slot is not a card — it is one
    # row in the collapsed "Idle · not used by Hermes" group. Declared servers
    # always stay as cards.
    idle: list[dict] = []
    if servers_source != "declared":
        retention = float(retention_hours if retention_hours is not None else 24)
        requested_recently = _requested_urls_since(conn, now - retention * 3600.0)
        kept = []
        for card in server_cards:
            busy = (card.get("running") or 0) > 0 or (card.get("waiting") or 0) > 0
            if card.get("kind") != "cloud" and not busy and normalize_base_url(card["base_url"]) not in requested_recently:
                idle.append({
                    "name": card["name"],
                    "title": card.get("title"),
                    "base_url": card["base_url"],
                    "kind": card.get("kind"),
                })
            else:
                kept.append(card)
        server_cards = kept
    model_cards = _model_cards(rows, server_cards, now, window_seconds)
    links = _subagent_links(conn)
    routed = _routed_for_links(conn, links)
    agent_nodes = _agent_tree(rows, links,
                              {normalize_base_url(card["base_url"]): card for card in server_cards},
                              routed=routed)
    decisions = _decisions(conn, now, float(retention_hours if retention_hours is not None else 24))
    routing_value = _routing(_settings(conn)) if routing is None else dict(routing)

    totals = {
        "in_flight": len(in_flight),
        "requests_1m": sum(1 for row in rows if (_num(row.get("started_at")) or 0) >= now - 60),
        "requests_5m": sum(1 for row in rows if (_num(row.get("started_at")) or 0) >= now - 300),
        "errors_5m": sum(1 for row in rows if row.get("status") == "error"
                         and (_num(row.get("started_at")) or 0) >= now - 300),
    }

    return {
        "generated_at": now,
        "window": {"seconds": int(window_seconds), "since": since},
        "totals": totals,
        "servers_source": servers_source,
        "servers": server_cards,
        "unreachable": unreachable,
        "idle": idle,
        "hidden_servers": hidden_list,
        "models": model_cards,
        "agents": agent_nodes,
        "decisions": decisions,
        "routing": routing_value,
    }


def build_agents(window_seconds: int = 300, *, conn: sqlite3.Connection | None = None,
                 now: float | None = None) -> dict:
    conn = conn if conn is not None else _open_conn()
    now = _now() if now is None else float(now)
    rows = _window_rows(conn, now - float(window_seconds))
    # Labels need the server cards' short names; the settings list is enough
    # (no probe) and matches the page's snapshot cards.
    server_by_url = {
        normalize_base_url(server.get("base_url")): server
        for server in (_settings(conn).get("servers") or [])
        if server.get("base_url")
    }
    return {"agents": _agent_tree(rows, _subagent_links(conn), server_by_url,
                                  routed=_routed_for_links(conn, _subagent_links(conn)))}

def build_models(window_seconds: int = 300, *, servers: Any = None,
                 conn: sqlite3.Connection | None = None, now: float | None = None,
                 servers_source: str | None = None) -> dict:
    snapshot = build_snapshot(window_seconds, servers=servers, conn=conn, now=now,
                              servers_source=servers_source)
    return {"models": snapshot["models"], "servers": snapshot["servers"]}


def build_servers(*, servers: Any = None, conn: sqlite3.Connection | None = None,
                  now: float | None = None, servers_source: str | None = None) -> dict:
    """Chip call: reachable server cards only, dead ones folded into `unreachable`.

    The same §7.2 rule as the page: a server that is unreachable and served no
    request in the window is noise, so a chip never shows a dead port as a fleet
    member.  Defaults to the discovered rule; the dashboard passes the real
    source so a declared server keeps its card.
    """
    snapshot = build_snapshot(300, servers=servers, conn=conn, now=now,
                              servers_source=servers_source or "discovered")
    return {"servers": snapshot["servers"], "unreachable": snapshot["unreachable"]}


def build_request(request_id: str, *, conn: sqlite3.Connection | None = None) -> dict:
    """One row plus the derived per-request numbers (hover detail)."""
    conn = conn if conn is not None else _open_conn()
    rows = _dict_rows(conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)))
    if not rows:
        return {"request": None}
    row = rows[0]
    started = _num(row.get("started_at"))
    first = _num(row.get("first_chunk_at"))
    ended = _num(row.get("ended_at"))
    prompt = _num(row.get("prompt_tokens"))
    cached = _num(row.get("cached_tokens")) or 0.0
    completion = _num(row.get("completion_tokens"))
    derived: dict[str, Any] = {
        "streamed": False, "ttft_ms": None, "latency_ms": None,
        "prefill_tps": None, "decode_tps": None, "rate_kind": None,
    }
    latency = _latency(started, ended)
    if latency is not None:
        derived["latency_ms"] = _round(latency * 1000.0, 1)
    span = _decode_span(started, first, ended)
    if span is not None and started is not None and first is not None:
        ttft = first - started
        derived["streamed"] = True
        derived["ttft_ms"] = _round(ttft * 1000.0, 1)
        if prompt is not None and ttft > 0:
            derived["prefill_tps"] = _round(max(0.0, prompt - cached) / ttft, 1)
        if completion is not None:
            derived["decode_tps"] = _round(completion / span, 1)
            derived["rate_kind"] = "decode"
    # A non-streamed row has no TTFT and no decode rate; `latency_ms` is its
    # honest number. Never completion/(ended-started) labelled as decode.
    return {"request": row, "derived": derived}


def build_health(*, conn: sqlite3.Connection | None = None, servers: Any = None,
                 samples: Any = None, now: float | None = None) -> dict:
    conn = conn if conn is not None else _open_conn()
    store = _store_module()
    if store is not None and hasattr(store, "health"):
        base = dict(store.health(conn))
    else:
        base = {"ok": True, "db_path": "", "rows": 0, "in_flight": 0, "abandoned_5m": 0,
                "errors": 0, "last_sweep": None}
    declared = servers if servers is not None else _default_servers(conn)
    sample_list = list(samples.values()) if isinstance(samples, dict) else list(samples or [])
    base["servers_declared"] = len(declared or [])
    base["servers_probed"] = len(sample_list)
    base["server_errors"] = sum(1 for sample in sample_list if _sample_dict(sample).get("error"))
    return base


# ---------------------------------------------------------------------------
# fleet_status (§11.1) and the one-liner (§11.2)
# ---------------------------------------------------------------------------


def _verdict(lane: dict) -> str:
    if lane.get("error"):
        return "unreachable"
    slots = lane.get("slots")
    if not slots or slots.get("total") is None or slots.get("used") is None:
        return "unknown"
    free = max(0, int(slots["total"]) - int(slots["used"]))
    if free > 0:
        return "spare" if not lane.get("queue") else "busy"
    return "saturated"


def _ttft_for_server(snapshot: dict, name: str) -> float | None:
    candidates = [card for card in snapshot.get("models", [])
                  if card.get("server_name") == name and card.get("ttft_ms_p50") is not None]
    if not candidates:
        return None
    candidates.sort(key=lambda card: -(card.get("requests_5m") or 0))
    return candidates[0]["ttft_ms_p50"]


def _latency_for_server(snapshot: dict, name: str) -> float | None:
    """p50 whole-request latency of the busiest lane on a server — the honest
    number for a server whose responses are not streamed."""
    candidates = [card for card in snapshot.get("models", [])
                  if card.get("server_name") == name and card.get("latency_ms_p50") is not None]
    if not candidates:
        return None
    candidates.sort(key=lambda card: -(card.get("requests_5m") or 0))
    return candidates[0]["latency_ms_p50"]


def fleet_status(snapshot: dict | None = None, *, window_seconds: int = 300,
                 servers: Any = None, conn: sqlite3.Connection | None = None,
                 now: float | None = None) -> dict:
    """§11.1 JSON: lanes with a verdict, cloud traffic, and the pick."""
    if snapshot is None:
        snapshot = build_snapshot(window_seconds, servers=servers, conn=conn, now=now)

    lanes = []
    for card in snapshot.get("servers", []):
        if card.get("kind") == "cloud":
            continue  # cloud traffic is the `cloud` list, not a lane
        if card.get("error"):
            continue  # unreachable servers are noise, not lanes (§7.2)
        slots = None
        if card.get("slots") is not None:
            slots = {"used": card.get("running"), "total": card.get("slots")}
        free_slots = None
        if slots is not None and slots["used"] is not None and slots["total"] is not None:
            free_slots = max(0, int(slots["total"]) - int(slots["used"]))
        lane = {
            "name": card.get("name"),
            "kind": card.get("kind"),
            "healthy": card.get("healthy"),
            "lane": "local",
            "slots": slots,
            "queue": card.get("waiting"),
            "free_slots": free_slots,
            "decode_tps": card.get("decode_tps"),
            "prefill_tps": card.get("prefill_tps"),
            "in_flight": card.get("in_flight"),
            "unattributed": card.get("unattributed"),
            "ttft_ms_p50": _ttft_for_server(snapshot, card.get("name") or ""),
            "latency_ms_p50": _latency_for_server(snapshot, card.get("name") or ""),
            "error": card.get("error"),
        }
        lane["verdict"] = _verdict(lane)
        lanes.append(lane)

    cloud = []
    for card in snapshot.get("models", []):
        if card.get("lane") != "cloud":
            continue
        cloud.append({
            "provider": card.get("provider"),
            "model": card.get("model"),
            "in_flight": card.get("in_flight"),
            "requests_5m": card.get("requests_5m"),
            "errors_429_5m": card.get("errors_429_5m"),
            "ttft_ms_p50": card.get("ttft_ms_p50"),
            "verdict": "busy" if (card.get("in_flight") or 0) > 0 else "spare",
        })

    pick = None
    for lane in lanes:
        if lane["verdict"] == "spare":
            reason = f"{lane['free_slots']} of {lane['slots']['total']} slots free, queue empty"
            if lane.get("ttft_ms_p50") is not None:
                reason += f", p50 TTFT {int(round(lane['ttft_ms_p50']))}ms"
            elif lane.get("latency_ms_p50") is not None:
                reason += f", p50 latency {int(round(lane['latency_ms_p50']))}ms"
            pick = {"lane": lane["name"], "reason": reason}
            break

    return {"as_of": _now_iso(snapshot.get("generated_at")), "lanes": lanes,
            "cloud": cloud, "pick": pick, "routing": routing_block(snapshot)}


def fleet_status_text(snapshot: dict | None = None, *, window_seconds: int = 300,
                      servers: Any = None, conn: sqlite3.Connection | None = None,
                      now: float | None = None) -> str:
    """§11.2 one-liner: `ds4 3/4 · GN100 5/5 (q 2) · anthropic/claude-opus-5-5 1 in flight · pick: ds4`.

    Healthy local servers only, then cloud lanes with traffic in the window,
    then the pick.  Capped near 160 chars by dropping trailing lanes.
    """
    status = fleet_status(snapshot, window_seconds=window_seconds, servers=servers,
                          conn=conn, now=now)
    lane_parts = []
    for lane in status["lanes"]:
        if lane.get("healthy") is not True:
            continue
        slots = lane.get("slots")
        if slots and slots.get("total") is not None and slots.get("used") is not None:
            text = f"{lane['name']} {slots.get('used')}/{slots['total']}"
            if lane.get("queue"):
                text += f" (q {lane['queue']})"
        else:
            text = f"{lane['name']} {lane.get('in_flight') or 0} in flight"
        lane_parts.append(text)
    for card in status["cloud"]:
        window_requests = card.get("requests_1m") if window_seconds <= 60 else card.get("requests_5m")
        if (card.get("in_flight") or 0) > 0 or (window_requests or 0) > 0:
            lane_parts.append(f"{card['provider']}/{card['model']} {card['in_flight']} in flight")
    tail = [f"pick: {status['pick']['lane']}" if status["pick"] else "pick: none"]
    routing = status.get("routing") or {}
    last = routing.get("last_decision")
    clause = ""
    if routing.get("blocked_by"):
        if routing.get("backend") != "flightdeck":
            clause = f"routing off: delegation.backend is {routing.get('backend')}"
        else:
            clause = f"routing off: inner_backend is {routing.get('inner_backend')}"
    elif routing.get("armed") and last:
        generated = snapshot.get("generated_at") if snapshot else None
        moment = float(generated) if isinstance(generated, (int, float)) and not isinstance(
            generated, bool) else _now()
        at = last.get("at")
        age = moment - float(at) if isinstance(at, (int, float)) else None
        if age is not None and age <= 300:
            if last.get("action") == "skip":
                clause = f"unrouted: {last.get('reason') or 'no free local lane'}"
            else:
                clause = f"routed: {last.get('lane')} ({last.get('reason')})"
    if clause:
        tail.append(clause)
    # Under ~160 chars: drop the least important lane, keeping pick and routing.
    parts = lane_parts + tail
    while len(" · ".join(parts)) > 160 and lane_parts:
        lane_parts.pop()
        parts = lane_parts + tail
    return " · ".join(parts)


def dumps(value: Any) -> str:
    """JSON string helper for the agent tool / slash command."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
