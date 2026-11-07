"""Flightdeck hook callbacks: seven observers, each fail-open.

Payload kwarg names are the real call sites' (DESIGN §2): ``pre_api_request`` /
``post_api_request`` (agent/turn_api_request.py, turn_response_intake.py),
``api_request_error`` (agent/api_request_hooks.py), ``pre/post_auxiliary_call``
(agent/auxiliary_hooks.py), ``subagent_start`` (tools/delegate_tool.py),
``subagent_stop`` (tools/delegate_tool_results.py).

Every callback reads the cron identity and the profile once, writes one row, and
never raises — a store failure must not break a model call.
"""

from __future__ import annotations

import logging
import os
import socket
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

HOOK_NAMES = (
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "pre_auxiliary_call",
    "post_auxiliary_call",
    "subagent_start",
    "subagent_stop",
)


def _profile_name() -> str:
    try:
        from hermes_constants import get_hermes_home, profile_name_for_home

        return profile_name_for_home(get_hermes_home()) or "default"
    except Exception:
        return os.environ.get("HERMES_PROFILE", "").strip() or "default"


def _cron_identity(ctx: Any) -> dict:
    """``ctx.current_cron_execution()`` once; empty for ordinary turns."""
    try:
        execution = ctx.current_cron_execution() if ctx is not None else None
    except Exception:
        execution = None
    if execution is None:
        return {"cron_job_id": None, "cron_job_name": None, "cron_execution_id": None}
    return {
        "cron_job_id": getattr(execution, "job_id", None),
        "cron_job_name": getattr(execution, "job_name", None),
        "cron_execution_id": getattr(execution, "execution_id", None),
    }


def _context(ctx: Any) -> dict:
    """Per-callback identity: profile, pid, host, cron run (each read once)."""
    fields = {"profile": _profile_name(), "pid": os.getpid(), "host": socket.gethostname()}
    fields.update(_cron_identity(ctx))
    return fields


def _wrap(ctx: Any, conn: Any, fn: Callable[..., Any]) -> Callable[..., None]:
    """Fail-open callback: add identity, call *fn*, swallow every exception."""

    def callback(**kwargs: Any) -> None:
        try:
            payload = dict(kwargs)
            payload.update(_context(ctx))
            fn(conn, **payload)
        except Exception:
            logger.debug("flightdeck: %s hook failed", getattr(fn, "__name__", "hook"),
                         exc_info=True)

    callback.__name__ = f"flightdeck_{getattr(fn, '__name__', 'hook')}"
    return callback


def register_all(ctx: Any, conn: Any, settings: Optional[dict] = None) -> list:
    """Register the seven observer hooks; returns the registration handles."""
    try:
        from . import store as _store
    except ImportError:
        import store as _store
    handlers = {
        "pre_api_request": _store.record_pre,
        "post_api_request": _store.record_post,
        "api_request_error": _store.record_error,
        "pre_auxiliary_call": _store.record_aux_pre,
        "post_auxiliary_call": _store.record_aux_post,
        "subagent_start": _store.record_subagent_start,
        "subagent_stop": _store.record_subagent_stop,
    }
    handles = []
    for name in HOOK_NAMES:
        handles.append(ctx.register_hook(name, _wrap(ctx, conn, handlers[name])))
    return handles


__all__ = ["HOOK_NAMES", "register_all"]
