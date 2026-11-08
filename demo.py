"""Seeded demo snapshot for fresh installs (DESIGN §9.1, demo mode).

Judges and new users install Flightdeck with no local model servers and no
traffic; the real page would be empty.  Demo mode serves a realistic fleet
instead: the same deterministic rows ``tests/make_example.py`` seeds for the
example fixture, built through the real ``api.build_snapshot()`` in an
in-memory SQLite database, with every timestamp anchored to *now* so the page
looks live (generated_at is now, in-flight requests have plausible ages).

Nothing here touches the real store: the seed lives in ``sqlite3.connect(":memory:")``
and is closed before the snapshot is returned.  If the example generator is not
shipped (a trimmed install), the committed ``docs/snapshot.example.json`` is
shifted to now instead.  Either way the shape is identical to the real snapshot,
with ``demo: true`` and ``empty_reason: null``.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # plugin loader: package context
    from ._siblings import load as _load_sibling
except ImportError:  # loaded standalone by path (dashboard, plugin_api)
    import importlib.util as _util
    _siblings_module = sys.modules.get("flightdeck__siblings")
    if _siblings_module is None:
        _spec = _util.spec_from_file_location(
            "flightdeck__siblings", Path(__file__).resolve().parent / "_siblings.py")
        if _spec is None or _spec.loader is None:
            raise ImportError("cannot load flightdeck _siblings.py")
        _siblings_module = _util.module_from_spec(_spec)
        sys.modules["flightdeck__siblings"] = _siblings_module
        _spec.loader.exec_module(_siblings_module)
    _load_sibling = _siblings_module.load

_ROOT = Path(__file__).resolve().parent
_EXAMPLE = _ROOT / "docs" / "snapshot.example.json"

#: Demo routing is deliberately off: the seeded rows carry no routing decisions,
#: so an armed strip with no last placement would be a lie.
_DEMO_ROUTING = {
    "armed": False, "backend": "default", "inner_backend": "default",
    "blocked_by": None, "message": "", "eligible_lanes": [],
}

#: The demo fleet is anchored to a moment, not reseeded every poll: in-flight
#: rows then age as the page is watched.  Re-anchor before the oldest in-flight
#: row (12 s old at the anchor) leaves the 300 s window, so the page never empties.
_REANCHOR_SECONDS = 280.0
_ANCHOR: float | None = None


def _demo_anchor(now: float) -> float:
    global _ANCHOR
    if _ANCHOR is None or now < _ANCHOR or now - _ANCHOR >= _REANCHOR_SECONDS:
        _ANCHOR = now
    return _ANCHOR


def _api() -> Any:
    return _load_sibling("api", __package__)


def _load_make_example() -> Any:
    """The repo's example generator by path, or None when a trimmed install omits it."""
    path = _ROOT / "tests" / "make_example.py"
    if not path.exists():
        return None
    module_name = "flightdeck_demo_make_example"
    module = sys.modules.get(module_name)
    if module is None:
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    return module


def demo_sessions(now: float) -> dict[tuple[str, str], dict]:
    """Plausible session titles for the seeded rows, as state.db would return them."""
    return {
        ("default", "s1"): {"title": "Flightdeck hackathon", "source": "desktop",
                            "started_at": now - 3600.0},
        ("default", "s2"): {"title": "metrics adapters", "source": "subagent",
                            "started_at": now - 40.0},
        ("default", "cron-nightly-1"): {"title": "nightly-briefing", "source": "cron",
                                        "started_at": now - 20.0},
    }


def _apply_demo_titles(snapshot: dict, now: float) -> None:
    """Fill title/source/started_at/label on every demo agent row (roots and children)."""
    mapping = demo_sessions(now)

    def walk(node: dict) -> None:
        info = mapping.get((node.get("profile") or "", node.get("session_id") or ""))
        if info:
            node["title"] = info["title"]
            node["source"] = info["source"]
            node["started_at"] = info["started_at"]
            node["label"] = info["title"]
        for child in node.get("children") or []:
            walk(child)

    for node in snapshot.get("agents") or []:
        walk(node)


# ---------------------------------------------------------------------------
# Fallback: shift the committed example JSON when tests/make_example.py is absent
# ---------------------------------------------------------------------------

_EPOCH_KEYS = {
    "generated_at", "since", "started_at", "first_chunk_at", "ended_at",
    "oldest_started_at", "last_active_at", "at", "ts",
    "fetched_at", "reset_at",
}

# The demo cloud lane's quota, in exactly the §9.1 shape the desktop plugin
# reads from the public gateway method `model.options` (provider
# `usage.windows`): 5-hour window 42% used resetting in ~2h, weekly window
# 18% used.  Timestamps are placeholders — _shift() moves fetched_at/reset_at
# with the demo clock so they stay plausible ("resets in ~2h") next to the
# shifted generated_at.
_DEMO_QUOTA = {
    "provider": "anthropic",
    "plan": "pro",
    "title": "Claude Pro",
    "source": "claude-cli",
    "fetched_at": 0.0,
    "unavailable_reason": None,
    "windows": [
        {"label": "5-hour", "used_percent": 42.0, "remaining_percent": 58.0,
         "reset_at": 0.0, "detail": None},
        {"label": "weekly", "used_percent": 18.0, "remaining_percent": 82.0,
         "reset_at": None, "detail": None},
    ],
}


def _shift_iso(value: str, delta: float) -> str:
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        shifted = moment.timestamp() + delta
        return datetime.fromtimestamp(shifted, timezone.utc).isoformat(
            timespec="seconds").replace("+00:00", "Z")
    except ValueError:
        return value


def _shift(value: Any, delta: float, key: str = "") -> Any:
    """Shift every epoch-looking field in the example snapshot by *delta*."""
    if key == "sampled_at" and isinstance(value, str):
        return _shift_iso(value, delta)
    if key in _EPOCH_KEYS and isinstance(value, (int, float)) and not isinstance(value, bool):
        return value + delta
    if isinstance(value, dict):
        return {name: _shift(item, delta, name) for name, item in value.items()}
    if isinstance(value, list):
        if len(value) == 3 and isinstance(value[0], (int, float)) and 1e9 < value[0] < 2e9:
            return [value[0] + delta, value[1], value[2]]  # a [ts, decode, prefill] sample
        return [_shift(item, delta) for item in value]
    return value


def _demo_from_json(window_seconds: int, now: float, anchor: float | None = None) -> dict:
    payload = json.loads(_EXAMPLE.read_text(encoding="utf-8"))
    start = now if anchor is None else float(anchor)
    delta = start - float(payload.get("generated_at") or start)
    shifted = _shift(payload, delta)
    shifted["generated_at"] = now
    shifted["window"] = {"seconds": int(window_seconds), "since": now - float(window_seconds)}
    # Demo cloud lane: the same quota shape the desktop plugin reads live from
    # `model.options` — 5-hour 42% used resetting in ~2h, weekly 18% used.
    # Reset stamps ride the shift above so they stay ~2h ahead of `now`.
    for entry in shifted.get("models", []):
        if isinstance(entry, dict) and entry.get("lane") == "cloud" and entry.get("quota") is None:
            entry["quota"] = _DEMO_QUOTA
    # Canonical §9.1 key order, so the fallback passes the same shape pin.
    return {
        "generated_at": now,
        "demo": True,
        "empty_reason": None,
        "window": shifted["window"],
        "totals": shifted.get("totals", {}),
        "servers_source": shifted.get("servers_source", "declared"),
        "servers": shifted.get("servers", []),
        "unreachable": shifted.get("unreachable", []),
        "idle": shifted.get("idle", []),
        "hidden_servers": shifted.get("hidden_servers", []),
        "models": shifted.get("models", []),
        "agents": shifted.get("agents", []),
        "decisions": shifted.get("decisions", []),
        "routing": shifted.get("routing", dict(_DEMO_ROUTING)),
    }


def _demo_quota(now: float) -> dict:
    """``_DEMO_QUOTA`` with stamps anchored to *now* (5-hour resets in ~2h)."""
    quota = dict(_DEMO_QUOTA)
    quota["fetched_at"] = now - 120.0
    quota["windows"] = [dict(window) for window in _DEMO_QUOTA["windows"]]
    quota["windows"][0]["reset_at"] = now + 7200.0
    return quota


def build_demo_snapshot(window_seconds: int = 300, *, now: float | None = None,
                        anchor: float | None = None) -> dict:
    """A live-looking seeded snapshot; never reads or writes the real store.

    *anchor* pins the demo fleet's start moment (tests); None uses the shared
    anchor so in-flight ages grow between polls and re-anchor before the oldest
    row leaves the window.
    """
    moment = time.time() if now is None else float(now)
    start = _demo_anchor(moment) if anchor is None else float(anchor)
    make_example = _load_make_example()
    if make_example is not None:
        conn = sqlite3.connect(":memory:")
        try:
            make_example.seed(conn, now=start)
            snapshot = _api().build_snapshot(
                window_seconds, servers=make_example.server_samples(start),
                conn=conn, now=moment, routing=_DEMO_ROUTING,
                session_info=demo_sessions(start),
                # Pin the demo quota: the seeded cloud lane gets the same shape
                # the desktop plugin reads live from `model.options`, and no
                # real account state is consulted (the demo must not depend on
                # this machine's account).
                quota_cache={"anthropic": _demo_quota(moment)},
            )
        finally:
            conn.close()
    else:
        snapshot = _demo_from_json(window_seconds, moment, start)
    snapshot["demo"] = True
    snapshot["empty_reason"] = None
    _apply_demo_titles(snapshot, start)
    return snapshot


__all__ = ["build_demo_snapshot", "demo_sessions"]
