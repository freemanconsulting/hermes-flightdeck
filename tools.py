"""Flightdeck agent tool and slash command (DESIGN §11).

Both handlers are thin: they call ``api.build_snapshot()`` / ``api.fleet_status_text()``
lazily (api.py is Brief B's file and may not exist yet) and return JSON / one line.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Optional

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

logger = logging.getLogger(__name__)

_WINDOWS = {"1m": 60, "5m": 300}


def _api():
    return _load_sibling("api", __package__)


def _demo():
    return _load_sibling("demo", __package__)


def _demo_mode() -> bool:
    """config.load()'s demo_mode, or False when config.py is unavailable."""
    try:
        return bool(_load_sibling("config", __package__).load().get("demo_mode"))
    except Exception:
        return False


def _window_seconds(window: Any) -> int:
    return _WINDOWS.get(str(window or "5m").strip().lower(), 300)


def _num_or_none(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _verdict(lane: dict) -> str:
    if lane.get("error"):
        return "unreachable"
    slots = lane.get("slots") or {}
    total = _num_or_none(slots.get("total"))
    used = _num_or_none(slots.get("used"))
    queue = _num_or_none(lane.get("queue"))
    if total is None or used is None:
        return "unknown"
    free = total - used
    if free <= 0:
        return "saturated"
    if queue and queue > 0:
        return "busy"
    return "spare"


def _lane(server: dict, models: list[dict]) -> dict:
    running = _num_or_none(server.get("running"))
    total = _num_or_none(server.get("slots"))
    slots = {"used": running, "total": total}
    free = None if (running is None or total is None) else max(0.0, total - running)
    ttfts = [_num_or_none(model.get("ttft_ms_p50")) for model in models]
    ttfts = [value for value in ttfts if value is not None]
    lane = {
        "name": server.get("name") or server.get("base_url"),
        "kind": server.get("kind"),
        "healthy": server.get("healthy"),
        "lane": "local",
        "slots": slots,
        "queue": _num_or_none(server.get("waiting")),
        "free_slots": free,
        "decode_tps": server.get("decode_tps"),
        "prefill_tps": server.get("prefill_tps"),
        "in_flight": server.get("in_flight"),
        "unattributed": server.get("unattributed"),
        "ttft_ms_p50": min(ttfts) if ttfts else None,
        "error": server.get("error"),
    }
    lane["verdict"] = _verdict(lane)
    return lane


def _cloud_lanes(models: list[dict]) -> list[dict]:
    cloud = []
    for model in models or []:
        if model.get("lane") != "cloud":
            continue
        in_flight = _num_or_none(model.get("in_flight"))
        cloud.append({
            "provider": model.get("provider"),
            "model": model.get("model"),
            "in_flight": model.get("in_flight"),
            "requests_5m": model.get("requests_5m"),
            "errors_429_5m": model.get("errors_429_5m"),
            "ttft_ms_p50": model.get("ttft_ms_p50"),
            "verdict": "busy" if (in_flight and in_flight > 0) else "spare",
        })
    return cloud


def _pick(lanes: list[dict]) -> Optional[dict]:
    candidates = [
        lane for lane in lanes
        if lane.get("verdict") in {"spare", "busy"}
        and (_num_or_none(lane.get("free_slots")) or 0) > 0
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda lane: (
        -(_num_or_none(lane.get("free_slots")) or 0),
        _num_or_none(lane.get("ttft_ms_p50")) or 0.0,
    ))
    best = candidates[0]
    free = int(_num_or_none(best.get("free_slots")) or 0)
    total = int(_num_or_none((best.get("slots") or {}).get("total")) or 0)
    queue = int(_num_or_none(best.get("queue")) or 0)
    ttft = _num_or_none(best.get("ttft_ms_p50"))
    reason = f"{free} of {total} slots free, queue {'empty' if queue == 0 else queue}"
    if ttft is not None:
        reason += f", p50 TTFT {int(ttft)}ms"
    return {"lane": best.get("name"), "reason": reason}


def _iso(epoch: Any) -> Optional[str]:
    value = _num_or_none(epoch)
    if value is None:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def fleet_status(window: str = "5m", include_cloud: bool = True, **_: Any) -> str:
    """Agent tool: JSON lanes with free capacity and a recommended pick."""
    try:
        if _demo_mode():
            snapshot = _demo().build_demo_snapshot(_window_seconds(window))
        else:
            snapshot = _api().build_snapshot(window_seconds=_window_seconds(window))
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"fleet snapshot unavailable: {exc}"})
    servers = snapshot.get("servers") or []
    models = snapshot.get("models") or []
    lanes = [_lane(server, [m for m in models if m.get("server_name") == server.get("name")])
             for server in servers]
    payload = {
        "as_of": _iso(snapshot.get("generated_at")),
        "lanes": lanes,
        "cloud": _cloud_lanes(models) if include_cloud else [],
        "pick": _pick(lanes),
        "routing": _api().routing_block(snapshot),
    }
    if snapshot.get("demo"):
        payload["demo"] = True
    return json.dumps(payload, default=str)


def fleet_command(raw_args: str = "", **_: Any) -> str:
    """``/fleet``: one line, e.g. ``ds4 3/4 · GN100 5/5 (2 queued) · pick: ds4``."""
    window = "1m" if "1m" in str(raw_args or "").split() else "5m"
    try:
        if _demo_mode():
            snapshot = _demo().build_demo_snapshot(_window_seconds(window))
        else:
            snapshot = _api().build_snapshot(window_seconds=_window_seconds(window))
        return _api().fleet_status_text(snapshot)
    except Exception as exc:
        return f"flightdeck: fleet status unavailable ({exc})"


__all__ = ["fleet_status", "fleet_command"]
