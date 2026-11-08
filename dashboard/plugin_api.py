"""Flightdeck dashboard backend, mounted at ``/api/plugins/flightdeck/`` (DESIGN §9).

Thin: parse the query, call ``api.py``, return.  Handlers that only touch SQLite
are plain ``def`` (FastAPI runs them in its threadpool); the poller path is
``async`` so a probe never blocks the threadpool.  No websocket in v1.

The mount imports this file standalone by path (``hermes_cli.web_server_dashboard``:
``spec_from_file_location`` -> ``exec_module`` -> ``app.include_router(router,
prefix="/api/plugins/flightdeck")``), so plugin-root siblings are loaded by path
through ``_load_sibling`` — never a bare ``import api`` that only works in tests.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger("flightdeck")
_WARN_AT = 0.0
WARN_INTERVAL_SECONDS = 60.0

_ROOT = Path(__file__).resolve().parent.parent
_MODULES: dict[str, Any] = {}
_LAST_SWEEP = 0.0
SWEEP_INTERVAL_SECONDS = 60.0

router = APIRouter()


def _warn(message: str, exc: BaseException | None = None) -> None:
    """WARNING at most once a minute: a broken sibling must not spam the log.

    The exception is passed in explicitly rather than relying on the ambient
    ``sys.exc_info()``: a second failure outside an ``except`` block would log
    ``NoneType: None`` at best, and a logging backend that subscripts the
    exception tuple turns that into a TypeError.  Logging must never raise out
    of a handled failure.
    """
    global _WARN_AT
    moment = time.monotonic()
    if moment - _WARN_AT < WARN_INTERVAL_SECONDS:
        return
    _WARN_AT = moment
    info = (type(exc), exc, exc.__traceback__) if exc is not None else None
    try:
        logger.warning(message, exc_info=info)
    except Exception:
        pass


def _load_sibling(name: str) -> Any:
    """Load a plugin-root module by path, once, under a plugin-scoped name."""
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


def _api() -> Any:
    module = _load_sibling("api")
    if module is None:
        raise HTTPException(status_code=503, detail="flightdeck api.py is unavailable")
    return module


def _demo() -> Any:
    module = _load_sibling("demo")
    if module is None:
        raise HTTPException(status_code=503, detail="flightdeck demo.py is unavailable")
    return module


@contextmanager
def _conn() -> Iterator[Any]:
    """One store connection per request, closed when the handler returns."""
    store = _load_sibling("store")
    if store is None:
        raise HTTPException(status_code=503, detail="flightdeck store.py is unavailable")
    conn = store.open_store()
    try:
        yield conn
    finally:
        conn.close()


def _window_seconds(window: str | None) -> int:
    """Window label or seconds to seconds. "60" is 1m, not a 5m fallback."""
    label = (window or "").strip().lower()
    if label in ("1m", "60", "60s"):
        return 60
    return 300


def _settings(conn: Any) -> dict:
    config = _load_sibling("config")
    if config is not None:
        try:
            return dict(config.load(conn=conn))
        except Exception as exc:
            _warn("flightdeck: settings load failed; serving an empty server list", exc)
    return {"servers": [], "poll_interval_seconds": 5, "probe_timeout_seconds": 2.0}


def _demo_mode() -> bool:
    """Demo mode from settings/env, read without opening the store.

    Checked before ``_conn()`` so demo mode never opens — let alone writes —
    the real requests.db, and still works when the store is unavailable.
    """
    try:
        return bool(_settings(None).get("demo_mode"))
    except Exception:
        return False


async def _poll(conn: Any, *, force: bool = False) -> dict:
    poller = _load_sibling("poller")
    if poller is None:
        return {}
    settings = _settings(conn)
    servers = list(settings.get("servers") or [])
    if not servers:
        return {}
    if force:
        poller.clear_cache()
    return await poller.poll(
        servers, ttl=settings.get("poll_interval_seconds", 5),
        timeout=settings.get("probe_timeout_seconds", 2.0), conn=conn,
    )


def _maybe_sweep(conn: Any) -> None:
    """Retention at most once per 60 s from the backend (DESIGN §9.2)."""
    global _LAST_SWEEP
    moment = time.monotonic()
    if moment - _LAST_SWEEP < SWEEP_INTERVAL_SECONDS:
        return
    _LAST_SWEEP = moment
    store = _load_sibling("store")
    if store is None or not hasattr(store, "sweep"):
        return
    settings = _settings(conn)
    try:
        store.sweep(conn, retention_hours=settings.get("retention_hours", 24),
                    rollup_days=settings.get("rollup_days", 7))
    except Exception as exc:
        # A sweep failure must never fail the page, but it must not vanish.
        _warn("flightdeck: store sweep failed", exc)


@router.get("/snapshot")
async def snapshot(window: str = Query("5m", description="1m or 5m")):
    """The page's one call: full §9.1 payload."""
    seconds = _window_seconds(window)
    if _demo_mode():
        return _demo().build_demo_snapshot(seconds)
    with _conn() as conn:
        _maybe_sweep(conn)
        settings = _settings(conn)
        samples = await _poll(conn)
        return _api().build_snapshot(seconds, servers=samples, conn=conn,
                                     servers_source=settings.get("servers_source"))


@router.get("/agents")
def agents(window: str = Query("5m", description="1m or 5m")):
    seconds = _window_seconds(window)
    if _demo_mode():
        payload = _demo().build_demo_snapshot(seconds)
        return {"agents": payload["agents"], "demo": True}
    with _conn() as conn:
        return _api().build_agents(seconds, conn=conn)


@router.get("/models")
async def models(window: str = Query("5m", description="1m or 5m")):
    seconds = _window_seconds(window)
    if _demo_mode():
        payload = _demo().build_demo_snapshot(seconds)
        return {"models": payload["models"], "servers": payload["servers"], "demo": True}
    with _conn() as conn:
        settings = _settings(conn)
        samples = await _poll(conn)
        return _api().build_models(seconds, servers=samples, conn=conn,
                                   servers_source=settings.get("servers_source"))


@router.get("/servers")
async def servers():
    """Chip call: server cards only, no hook join."""
    if _demo_mode():
        payload = _demo().build_demo_snapshot(300)
        return {"servers": payload["servers"], "unreachable": payload["unreachable"],
                "demo": True}
    with _conn() as conn:
        settings = _settings(conn)
        samples = await _poll(conn)
        return _api().build_servers(servers=samples, conn=conn,
                                    servers_source=settings.get("servers_source"))


@router.get("/request/{request_id}")
def request_detail(request_id: str):
    with _conn() as conn:
        payload = _api().build_request(request_id, conn=conn)
    if payload.get("request") is None:
        raise HTTPException(status_code=404, detail="request not found")
    return payload


@router.get("/health")
async def health():
    with _conn() as conn:
        samples = await _poll(conn)
        return _api().build_health(conn=conn, samples=samples)


@router.post("/refresh")
async def refresh():
    """Explicit click only: force a probe past the TTL."""
    with _conn() as conn:
        samples = await _poll(conn, force=True)
        return {"ok": True, "probed": len(samples)}
