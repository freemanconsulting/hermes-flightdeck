"""Request-driven TTL poller for model servers (DESIGN §7.3).

No background thread: a poll runs only when a REST call or the agent tool asks,
so an idle gateway stays idle.  Per server, a cached sample younger than ``ttl``
is returned as-is; otherwise ``servers.probe`` runs in a worker thread and the
sample is cached and written to ``server_samples`` (one row per server per poll).

Counter-only kinds (vLLM, SGLang prefill) get their tok/s from two samples via
``servers.token_rate``: the window is the ``sampled_at`` delta, never the
configured interval, so a slow poll cannot inflate the rate.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
_MODULES: dict[str, Any] = {}

#: Minimum poll interval (DESIGN §7.3: 5 s default, 2 s floor).
TTL_FLOOR = 2.0


def _load_sibling(name: str) -> Any:
    """Load a plugin-root module by path, once, under a plugin-scoped name.

    The dashboard mount imports ``plugin_api.py`` standalone and the plugin
    loader owns root-level modules, so a plain ``import servers`` would resolve
    differently in each context.  Loading by path keeps one module identity
    (and one poller cache) everywhere.
    """
    module = _MODULES.get(name)
    if module is not None:
        return module
    module_name = f"flightdeck_{name}"
    module = sys.modules.get(module_name)
    if module is None:
        path = _ROOT / f"{name}.py"
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    _MODULES[name] = module
    return module


def _servers_module() -> Any:
    return _load_sibling("servers")


# base_url -> {"at": monotonic seconds, "sample": dict}
_CACHE: dict[str, dict[str, Any]] = {}
# base_url -> last probed sample dict (for counter-delta rates)
_LAST: dict[str, dict[str, Any]] = {}
# base_url -> asyncio.Lock (stampede guard when two views poll at once)
_LOCKS: dict[str, asyncio.Lock] = {}


def _epoch(iso: str | None) -> float | None:
    """Epoch seconds from an ISO 8601 UTC string, or None."""
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _sample_dict(snap: Any) -> dict[str, Any]:
    """Snapshot (dataclass) -> plain dict; dicts pass through."""
    if isinstance(snap, dict):
        return dict(snap)
    fields = (
        "name", "title", "base_url", "kind", "healthy", "models", "running", "waiting", "slots",
        "decode_tps", "prefill_tps", "prompt_tokens_total", "cached_tokens_total",
        "generation_tokens_total", "sampled_at", "error",
    )
    return {field: getattr(snap, field, None) for field in fields}


def _derive_rates(prev: dict[str, Any] | None, cur: dict[str, Any]) -> None:
    """Fill decode/prefill tok/s from counter deltas when the kind has no gauge."""
    if prev is None:
        return
    seconds = _epoch(cur.get("sampled_at"))
    prev_seconds = _epoch(prev.get("sampled_at"))
    if seconds is None or prev_seconds is None:
        return
    window = seconds - prev_seconds
    token_rate = _servers_module().token_rate
    if cur.get("decode_tps") is None:
        cur["decode_tps"] = token_rate(
            prev.get("generation_tokens_total"), cur.get("generation_tokens_total"), window
        )
    if cur.get("prefill_tps") is None:
        cur["prefill_tps"] = token_rate(
            prev.get("prompt_tokens_total"), cur.get("prompt_tokens_total"), window
        )


def _write_sample(conn: sqlite3.Connection | None, sample: dict[str, Any]) -> None:
    """One row in ``server_samples`` per server per poll (DESIGN §5.1)."""
    if conn is None:
        return
    store = _load_sibling("store")
    if store is not None and hasattr(store, "record_server_sample"):
        store.record_server_sample(conn, **sample)
        return
    ts = _epoch(sample.get("sampled_at"))
    if ts is None:
        return
    healthy = sample.get("healthy")
    conn.execute(
        "INSERT OR REPLACE INTO server_samples "
        "(ts, base_url, name, kind, healthy, running, waiting, slots, decode_tps, prefill_tps, error) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            ts,
            sample.get("base_url") or "",
            sample.get("name"),
            sample.get("kind"),
            None if healthy is None else int(bool(healthy)),
            sample.get("running"),
            sample.get("waiting"),
            sample.get("slots"),
            sample.get("decode_tps"),
            sample.get("prefill_tps"),
            sample.get("error"),
        ),
    )
    conn.commit()


def _probeable(server: dict[str, Any]) -> bool:
    """Cloud lanes are hook-derived and never probed; only http(s) URLs are."""
    if (server.get("kind") or "").lower() == "cloud":
        return False
    base_url = (server.get("base_url") or "").strip().lower()
    return base_url.startswith("http://") or base_url.startswith("https://")


def _apply_server_fields(sample: dict[str, Any], server: dict[str, Any]) -> None:
    """The server entry owns the card label, tooltip and aux flag; a probe's name
    is a model id or a URL and must never overwrite them (DESIGN §7.2)."""
    if server.get("name"):
        sample["name"] = server["name"]
    if server.get("title"):
        sample["title"] = server["title"]
    if server.get("aux"):
        sample["aux"] = True
        sample["roles"] = list(server.get("roles") or [])


async def _one(server: dict[str, Any], ttl: float, timeout: float,
                conn: sqlite3.Connection | None) -> tuple[str, dict[str, Any]]:
    base_url = (server.get("base_url") or "").rstrip("/")
    lock = _LOCKS.setdefault(base_url, asyncio.Lock())
    async with lock:
        cached = _CACHE.get(base_url)
        if cached is not None and (time.monotonic() - cached["at"]) < ttl:
            sample = dict(cached["sample"])
            _apply_server_fields(sample, server)
            return base_url, sample

        snap = await asyncio.to_thread(_servers_module().probe, base_url, timeout)
        sample = _sample_dict(snap)
        sample["base_url"] = base_url
        _apply_server_fields(sample, server)
        _derive_rates(_LAST.get(base_url), sample)
        _LAST[base_url] = sample
        _CACHE[base_url] = {"at": time.monotonic(), "sample": sample}
        try:
            _write_sample(conn, sample)
        except sqlite3.Error:
            # A store write failure must never break the live reading.
            pass
        return base_url, sample


async def poll(servers: list[dict], ttl: float = 5.0, timeout: float = 2.0,
               conn: sqlite3.Connection | None = None) -> dict[str, dict]:
    """Probe every declared server (TTL-cached, fanned out) -> {base_url: sample}.

    Cloud lanes and non-http URLs are skipped: a public URL is only ever probed
    when the user declared it as a server, never through auto-discovery.
    """
    ttl = max(float(ttl), TTL_FLOOR)
    targets = [server for server in servers or [] if _probeable(server)]
    if not targets:
        return {}
    results = await asyncio.gather(*(_one(server, ttl, timeout, conn) for server in targets))
    return dict(results)


def poll_sync(servers: list[dict], ttl: float = 5.0, timeout: float = 2.0,
              conn: sqlite3.Connection | None = None) -> dict[str, dict]:
    """Sync wrapper for the agent tool / slash command (no running loop there)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(poll(servers, ttl=ttl, timeout=timeout, conn=conn))
    # A loop is already running in this thread: run the poll in its own thread.
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(
            lambda: asyncio.run(poll(servers, ttl=ttl, timeout=timeout, conn=conn))
        ).result()


def clear_cache() -> None:
    """Drop cached samples (tests, and an explicit refresh past the TTL)."""
    _CACHE.clear()
    _LAST.clear()
