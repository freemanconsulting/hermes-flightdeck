"""Capacity-aware delegation: place a subagent on a local server with free slots.

The feature is opt-in (``route_delegation`` off by default).  When armed, the
``flightdeck`` delegation backend computes the requested route itself (the
``delegation`` config section minus ``service_tier``, exactly what the bundled
``default`` backend returns), compares it with the live fleet, and may move the
task to a local server with free slots.  It never moves a task to a cloud route,
never rewrites a profile route or an explicit ``api_key`` route, and never
invents a model id (docs/CAPACITY.md §3).

No network of its own: the live fleet is the same TTL'd ``poller.poll_sync``
sample the page reads.  A store failure costs the decision trail, never the
delegation.  The process-global ledger survives a plugin re-exec, the same
shape as the private capacity-routing prior art.
"""

from __future__ import annotations

import logging
import math
import sys
import threading
import time
import types
from datetime import datetime
from typing import Any, Mapping, Optional

try:  # plugin loader: package context
    from ._siblings import load as _load_sibling
except ImportError:  # loaded standalone by path (tests, api.py)
    import importlib.util as _util
    from pathlib import Path

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

try:  # the public delegation seam (CAPACITY.md §1.2); absent on older Hermes
    from agent.delegation_provider import DelegationProvider, DelegationRouteError
    PROVIDER_AVAILABLE = True
except ModuleNotFoundError as exc:
    if exc.name != "agent.delegation_provider":
        raise
    DelegationProvider = object  # type: ignore[assignment,misc]
    DelegationRouteError = ValueError  # type: ignore[assignment,misc]
    PROVIDER_AVAILABLE = False

logger = logging.getLogger(__name__)

#: The seven routing settings (plugin.yaml config_schema, CAPACITY.md §8.2).
#: ``reserve_slots`` is 0 by Gerard's decision (CAPACITY.md §14 #4 was 1).
DEFAULT_SETTINGS: dict[str, Any] = {
    "route_delegation": False,
    "inner_backend": "default",
    "reserve_slots": 0,
    "max_queue": 2,
    "routing_staleness_seconds": 20,
    "routing_ledger_seconds": 60,
    "routing_servers": [],
}

_STATE_KEY = "flightdeck_capacity_state"
_INNER_MESSAGE = (
    "Flightdeck routing needs inner_backend 'default': a plugin backend's per-task options "
    "cannot be read through the public delegation seam. Set "
    "delegation.backends.flightdeck.inner_backend: default, or set route_delegation: false."
)


# ─── settings ────────────────────────────────────────────────────────────────


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def _as_int(value: Any, default: int, *, minimum: Optional[int] = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return max(result, minimum) if minimum is not None else result


def _normalize_settings(settings: Any) -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    if isinstance(settings, Mapping):
        merged.update(dict(settings))
    merged["route_delegation"] = _as_bool(merged.get("route_delegation"), False)
    merged["inner_backend"] = str(merged.get("inner_backend") or "default").strip().lower() or "default"
    merged["reserve_slots"] = _as_int(merged.get("reserve_slots"), 0, minimum=0)
    merged["max_queue"] = _as_int(merged.get("max_queue"), 2, minimum=0)
    merged["routing_staleness_seconds"] = _as_int(
        merged.get("routing_staleness_seconds"), 20, minimum=5)
    merged["routing_ledger_seconds"] = _as_int(merged.get("routing_ledger_seconds"), 60, minimum=0)
    routing = merged.get("routing_servers")
    merged["routing_servers"] = [str(item).strip() for item in routing
                                 if str(item).strip()] if isinstance(routing, list) else []
    return merged


def _backend(config: Any) -> str:
    """``delegation.backend`` normalized; blank/non-string means ``default``."""
    raw = config.get("backend") if isinstance(config, Mapping) else None
    return str(raw).strip().lower() if isinstance(raw, str) and raw.strip() else "default"


def _label_for(backends: Any, name: str) -> str:
    for entry in backends or []:
        if isinstance(entry, Mapping) and entry.get("name") == name:
            label = str(entry.get("label") or "").strip()
            return label if label and label != name else ""
    return ""


def arm_status(settings: Any, config: Any = None, backends: Any = None, *,
               servers: Any = None) -> dict[str, Any]:
    """``{armed, backend, inner_backend, blocked_by, message, eligible_lanes}``.

    Armed only when routing is on, ``delegation.backend`` is ``flightdeck`` and
    ``inner_backend`` is ``default``.  When routing is on but another backend is
    active, ``blocked_by`` names it and ``message`` is the exact switch command;
    Flightdeck never writes ``delegation.backend`` itself (CAPACITY.md §2).
    """
    settings = _normalize_settings(settings)
    backend = _backend(config)
    inner = settings["inner_backend"]
    eligible = []
    if servers is None:
        servers = settings.get("servers")
    if servers is not None:
        config_module = _load_sibling("config", __package__)
        eligible = [str(lane.get("name") or lane.get("base_url") or "")
                    for lane in config_module.eligible_lanes(servers, settings)]
    base = {"armed": False, "backend": backend, "inner_backend": inner,
            "blocked_by": None, "message": "", "eligible_lanes": eligible}
    if not settings["route_delegation"]:
        return base
    if backend != "flightdeck":
        label = _label_for(backends, backend)
        suffix = f" ({label})" if label else ""
        message = (
            f"Flightdeck routing is on but delegation.backend is '{backend}'{suffix}.\n"
            f"One delegation backend runs at a time. Switch with `/delegation flightdeck --now`\n"
            f"(or `hermes config set delegation.backend flightdeck`), or turn route_delegation off."
        )
        return {**base, "blocked_by": backend, "message": message}
    if inner != "default":
        return {**base, "blocked_by": inner, "message": _INNER_MESSAGE}
    return {**base, "armed": True}


# ─── process-global ledger ──────────────────────────────────────────────────


class _Ledger:
    """Ledger + batch counters; survives a plugin re-exec (CAPACITY.md §3.2)."""

    def __init__(self) -> None:
        self.ledger: list[dict[str, Any]] = []  # [{ts, lane, batch}]
        self.batch_id = 0
        self.last_index: Optional[int] = None
        self.batch_counts: dict[str, int] = {}
        self.lock = threading.RLock()


def _state() -> _Ledger:
    """The process-global ledger, kept in ``sys.modules`` so a re-exec keeps it."""
    module = sys.modules.get(_STATE_KEY)
    if module is None:
        module = types.ModuleType(_STATE_KEY)
        module.__dict__["state"] = _Ledger()
        sys.modules[_STATE_KEY] = module
    return module.__dict__["state"]


def reset_state() -> None:
    """Clear the ledger and batch counters (tests and manual dry runs)."""
    state = _state()
    with state.lock:
        state.ledger.clear()
        state.batch_id = 0
        state.last_index = None
        state.batch_counts = {}


def _batch_for(task: Mapping[str, Any]) -> int:
    """A batch starts when ``task.index`` resets or goes backwards."""
    state = _state()
    index = task.get("index")
    if not isinstance(index, int):
        index = None
    new_batch = state.last_index is None or index is None or index <= state.last_index
    if new_batch:
        state.batch_id += 1
        state.batch_counts = {}
    state.last_index = index
    return state.batch_id


def _prior_counts(state: _Ledger, seconds: float, batch_id: int) -> dict[str, int]:
    cutoff = time.time() - float(seconds)
    state.ledger[:] = [entry for entry in state.ledger if entry["ts"] >= cutoff]
    counts: dict[str, int] = {}
    for entry in state.ledger:
        if entry["batch"] != batch_id:
            counts[entry["lane"]] = counts.get(entry["lane"], 0) + 1
    return counts


def _record_placement(state: _Ledger, lane: str, batch_id: int) -> None:
    state.batch_counts[lane] = state.batch_counts.get(lane, 0) + 1
    state.ledger.append({"ts": time.time(), "lane": lane, "batch": batch_id})


# ─── samples and numbers ────────────────────────────────────────────────────


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _epoch(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _normalize(url: Any) -> str:
    config_module = _load_sibling("config", __package__)
    return config_module.normalize_base_url(url)


def _sample_for(lane: Mapping[str, Any], samples: Any) -> Optional[dict]:
    """The live sample for a lane, matched by normalized base_url."""
    if not isinstance(samples, Mapping):
        return None
    target = _normalize(lane.get("base_url"))
    for key, sample in samples.items():
        if isinstance(sample, Mapping) and _normalize(sample.get("base_url") or key) == target:
            return dict(sample)
    return None


def _fresh(sample: Mapping[str, Any], staleness: float, now: float) -> tuple[bool, Optional[float]]:
    """``(fresh, age)``; a sample with no ``sampled_at`` cannot prove freshness."""
    sampled = _epoch(sample.get("sampled_at"))
    if sampled is None:
        return False, None
    age = float(now) - sampled
    return age <= float(staleness), age


def _free(lane_name: str, sample: Mapping[str, Any], state: _Ledger,
          batch_id: int, seconds: float, reserve: int) -> Optional[int]:
    slots = _num(sample.get("slots"))
    if slots is None:
        return None
    running = _num(sample.get("running")) or 0
    waiting = _num(sample.get("waiting")) or 0
    prior = _prior_counts(state, seconds, batch_id)
    used = running + waiting + prior.get(lane_name, 0) + state.batch_counts.get(lane_name, 0)
    return int(slots - used - reserve)


def _ttft(sample: Mapping[str, Any]) -> Optional[float]:
    value = _num(sample.get("ttft_ms_p50"))
    return value if value is not None else None


# ─── server / route mapping ────────────────────────────────────────────────


def _entry_for_provider(provider_routes: Mapping[str, Any], provider: Any) -> Optional[dict]:
    if not provider:
        return None
    for entry in (provider_routes or {}).values():
        if isinstance(entry, Mapping) and entry.get("provider") == provider:
            return dict(entry)
    return None


def lane_for_route(route: Mapping[str, Any], servers: Any,
                   provider_routes: Mapping[str, Any]) -> Optional[dict]:
    """The server card the requested route points at, or ``None`` (cloud/unknown)."""
    base_url = route.get("base_url")
    if not base_url:
        entry = _entry_for_provider(provider_routes, route.get("provider"))
        base_url = entry.get("base_url") if entry else None
    target = _normalize(base_url)
    if not target:
        return None
    config_module = _load_sibling("config", __package__)
    return config_module.server_for_url(list(servers or []), target)


def route_for_lane(lane: Mapping[str, Any], requested: Mapping[str, Any],
                   provider_routes: Mapping[str, Any]) -> Optional[dict]:
    """The route a placement on *lane* produces, or ``None`` when no model is known.

    Never invents a model id: the requested model if the lane serves it, else the
    provider entry's ``default_model``, else the model the server reports serving,
    else the entry's first model (CAPACITY.md §4).
    """
    entry = provider_routes.get(_normalize(lane.get("base_url"))) or {}
    lane_models = [str(model) for model in (lane.get("models") or [])]
    entry_models = [str(model) for model in (entry.get("models") or [])]
    requested_model = requested.get("model")
    model = None
    if requested_model and requested_model in (entry_models or lane_models):
        model = requested_model
    elif entry.get("default_model"):
        model = str(entry["default_model"])
    elif lane_models:
        model = lane_models[0]
    elif entry_models:
        model = entry_models[0]
    if not model:
        return None
    provider = entry.get("provider") or lane.get("key")
    base_url = entry.get("base_url") or lane.get("base_url")
    return {"provider": provider, "model": model, "base_url": base_url,
            "extra_body": entry.get("extra_body")}


def _fallback(requested: Mapping[str, Any]) -> list[dict]:
    """Where the task would have gone anyway: the requested route, trimmed."""
    entry = {key: requested[key] for key in ("provider", "model", "base_url")
             if requested.get(key)}
    return [entry] if entry else []


def _route_reason(name: str, sample: Mapping[str, Any], free: int, reserve: int,
                  queue: int) -> str:
    slots = _num(sample.get("slots"))
    running = _num(sample.get("running")) or 0
    waiting = _num(sample.get("waiting")) or 0
    if queue >= 0 and free <= 0 and (running + waiting) >= (slots or 0):
        return f"{name} full {int(running)}/{int(slots or 0)}"
    if free <= 0 and reserve:
        return f"{name} {int(running)}/{int(slots or 0)}, reserve {reserve}"
    if queue:
        return f"{name} queue {queue}"
    free_text = f"{free} of {int(slots or 0)} slots free"
    return f"{free_text}, queue {'empty' if queue == 0 else queue}"


def _lanes_json(servers: Any, samples: Any, settings: Mapping[str, Any],
                state: _Ledger, batch_id: int, now: float) -> list[dict]:
    config_module = _load_sibling("config", __package__)
    lanes = []
    for lane in config_module.eligible_lanes(servers, settings):
        name = str(lane.get("name") or lane.get("base_url") or "")
        sample = _sample_for(lane, samples)
        if sample is None:
            lanes.append({"name": name, "slots": None, "running": None, "waiting": None,
                          "queue": None, "free": None, "stale": True})
            continue
        fresh, _age = _fresh(sample, settings["routing_staleness_seconds"], now)
        lanes.append({
            "name": name,
            "slots": _num(sample.get("slots")),
            "running": _num(sample.get("running")),
            "waiting": _num(sample.get("waiting")),
            "queue": _num(sample.get("waiting")),
            "free": _free(name, sample, state, batch_id, settings["routing_ledger_seconds"],
                          settings["reserve_slots"]),
            "stale": not fresh,
        })
    return lanes


# ─── the decision ──────────────────────────────────────────────────────────


def _decision(**kw: Any) -> dict[str, Any]:
    return kw


def decide(task: Mapping[str, Any], config: Any, *, samples: Any, servers: Any,
           provider_routes: Any, settings: Any, state: Any = None,
           now: Optional[float] = None) -> tuple[dict, Optional[dict]]:
    """``(route, decision|None)`` for one task (CAPACITY.md §3).

    An ineligible task returns the requested route untouched and no decision: no
    routing decision was made.  A skip decision records why the requested route
    stayed, and returns that route unchanged.
    """
    settings = _normalize_settings(settings)
    requested = {key: value for key, value in (config or {}).items() if key != "service_tier"}
    if not arm_status(settings, config)["armed"]:
        return requested, None
    if not requested or requested.get("profile") or requested.get("api_key"):
        return requested, None
    lane = lane_for_route(requested, servers, provider_routes)
    if lane is None:
        return requested, None
    config_module = _load_sibling("config", __package__)
    if str(lane.get("kind") or "").lower() == "cloud":
        return requested, None
    if not config_module._private_url(lane.get("base_url")):
        return requested, None
    if config_module._is_hidden_server(lane, settings.get("hidden_servers") or []):
        return requested, None
    if settings["routing_servers"] and not config_module._is_hidden_server(
            lane, settings["routing_servers"]):
        return requested, None

    moment = float(now if now is not None else time.time())
    ledger: _Ledger = state if state is not None else _state()
    batch_id = _batch_for(task)
    req_name = str(lane.get("name") or lane.get("base_url") or "")
    sample = _sample_for(lane, samples)
    lanes = _lanes_json(servers, samples, settings, ledger, batch_id, moment)

    def skip(reason: str, stale: bool = False) -> tuple[dict, dict]:
        return requested, _decision(
            decided_at=moment, batch_id=batch_id, task_index=task.get("index"),
            goal=task.get("goal"), action="skip", requested_lane=req_name,
            requested_provider=requested.get("provider"), requested_model=requested.get("model"),
            chosen_lane=None, chosen_provider=None, chosen_model=None,
            reason=reason, stale=stale, lanes=lanes)

    if sample is None:
        return skip(f"no sample for {req_name}")
    if sample.get("error"):
        return skip(f"unreachable: {req_name} ({sample.get('error')})")
    fresh, age = _fresh(sample, settings["routing_staleness_seconds"], moment)
    if not fresh:
        age_text = "unknown age" if age is None else f"{int(age)}s old"
        return skip(f"stale sample: {req_name} {age_text}", stale=True)
    if sample.get("healthy") is False:
        return skip(f"unhealthy sample: {req_name}")
    slots = _num(sample.get("slots"))
    if slots is None:
        return skip(f"no slot gauge on {req_name}")

    queue = int(_num(sample.get("waiting")) or 0)
    free = _free(req_name, sample, ledger, batch_id, settings["routing_ledger_seconds"],
                 settings["reserve_slots"])
    if free is not None and free >= 1:
        reason = _route_reason(req_name, sample, free, settings["reserve_slots"], queue)
        _record_placement(ledger, req_name, batch_id)
        return requested, _decision(
            decided_at=moment, batch_id=batch_id, task_index=task.get("index"),
            goal=task.get("goal"), action="stay", requested_lane=req_name,
            requested_provider=requested.get("provider"), requested_model=requested.get("model"),
            chosen_lane=req_name, chosen_provider=requested.get("provider"),
            chosen_model=requested.get("model"), reason=reason, stale=False, lanes=lanes)

    if queue >= settings["max_queue"]:
        return skip(f"{req_name} queue {queue}")

    targets: list[tuple[tuple, dict, dict, int]] = []
    no_model: list[str] = []
    for candidate in config_module.eligible_lanes(servers, settings):
        if settings["routing_servers"] and not config_module._is_hidden_server(
                candidate, settings["routing_servers"]):
            continue
        candidate_sample = _sample_for(candidate, samples)
        if candidate_sample is None or candidate_sample.get("error"):
            continue
        candidate_fresh, _age = _fresh(candidate_sample, settings["routing_staleness_seconds"], moment)
        if not candidate_fresh or candidate_sample.get("healthy") is False:
            continue
        if _num(candidate_sample.get("slots")) is None:
            continue
        candidate_name = str(candidate.get("name") or candidate.get("base_url") or "")
        candidate_free = _free(candidate_name, candidate_sample, ledger, batch_id,
                               settings["routing_ledger_seconds"], settings["reserve_slots"])
        if candidate_free is None or candidate_free < 1:
            continue
        target_route = route_for_lane(candidate, requested, provider_routes)
        if target_route is None:
            no_model.append(candidate_name)
            continue
        candidate_queue = int(_num(candidate_sample.get("waiting")) or 0)
        ttft = _ttft(candidate_sample)
        targets.append((
            (-candidate_free, candidate_queue, ttft if ttft is not None else math.inf, candidate_name),
            candidate, target_route, candidate_free))

    if not targets:
        # A lane with no determinable model is excluded before the full/free
        # reason is chosen (CAPACITY.md §4): it was the only lane with capacity,
        # so "all local lanes full" would name the wrong lane and hide the real
        # blocker.  Only when no candidate was excluded for its model does the
        # full list explain the skip.
        if no_model:
            return skip(f"no model on {', '.join(no_model)}")
        full = [lane for lane in lanes if lane.get("free") is not None and lane["free"] <= 0]
        if full:
            return skip("all local lanes full: " + ", ".join(
                f"{lane['name']} {int(lane['running'] or 0)}/{int(lane['slots'] or 0)}"
                for lane in full))
        return skip("no local lane with free slots")

    targets.sort(key=lambda item: item[0])
    _key, chosen, chosen_route, chosen_free = targets[0]
    chosen_name = str(chosen.get("name") or chosen.get("base_url") or "")
    reason = _route_reason(req_name, sample, free or 0, settings["reserve_slots"], queue)
    if chosen_route["model"] != requested.get("model"):
        reason += f", model {chosen_route['model']}"
    route = dict(requested)
    route.update(
        provider=chosen_route["provider"],
        model=chosen_route["model"],
        base_url=chosen_route["base_url"],
        api_mode=requested.get("api_mode") or "chat_completions",
        label=f"{requested.get('label') or 'task'}→{chosen_name} ({reason})"[:80],
        fallback_providers=_fallback(requested),
    )
    if chosen_route.get("extra_body") is not None:
        route["request_overrides"] = {"extra_body": chosen_route["extra_body"]}
    _record_placement(ledger, chosen_name, batch_id)
    return route, _decision(
        decided_at=moment, batch_id=batch_id, task_index=task.get("index"),
        goal=task.get("goal"), action="move", requested_lane=req_name,
        requested_provider=requested.get("provider"), requested_model=requested.get("model"),
        chosen_lane=chosen_name, chosen_provider=chosen_route["provider"],
        chosen_model=chosen_route["model"], reason=reason, stale=False, lanes=lanes)


# ─── the delegation provider ──────────────────────────────────────────────


class Provider(DelegationProvider):
    """The ``flightdeck`` delegation backend (CAPACITY.md §2, §5).

    ``settings_fn`` returns the plugin settings (``config.load``) at route time.
    With routing off it returns the requested route unchanged and adds no
    ``task_parameters``/``description``, so it is byte-identical to ``default``.
    """

    def __init__(self, settings_fn=None, conn=None):
        self._settings_fn = settings_fn
        self._conn = conn

    @property
    def name(self) -> str:
        return "flightdeck"

    @property
    def display_name(self) -> str:
        return "Flightdeck (capacity-aware)"

    @property
    def summary(self) -> str:
        return "Places subagents on a local server with free slots; never cloud."

    def _settings(self) -> dict[str, Any]:
        try:
            raw = self._settings_fn() if self._settings_fn is not None else {}
        except Exception:
            logger.debug("flightdeck: routing settings unavailable", exc_info=True)
            raw = {}
        return _normalize_settings(raw)

    def is_available(self) -> bool:
        """True only for ``inner_backend: default``; makes no network call."""
        if not PROVIDER_AVAILABLE:
            return False
        return self._settings()["inner_backend"] == "default"

    def route_task(self, task: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, Any]:
        requested = {key: value for key, value in (config or {}).items() if key != "service_tier"}
        try:
            settings = self._settings()
            if not arm_status(settings, config)["armed"]:
                return requested
            servers = list(settings.get("servers") or [])
            config_module = _load_sibling("config", __package__)
            provider_routes = config_module.provider_routes()
            samples: dict[str, Any] = {}
            try:
                poller = _load_sibling("poller", __package__)
                samples = poller.poll_sync(
                    servers, ttl=settings.get("poll_interval_seconds", 5),
                    timeout=settings.get("probe_timeout_seconds", 2.0), conn=self._conn)
            except Exception:
                logger.debug("flightdeck: routing poll failed", exc_info=True)
            route, decision = decide(
                task, config, samples=samples, servers=servers,
                provider_routes=provider_routes, settings=settings)
            if decision is not None and self._conn is not None:
                try:
                    store = _load_sibling("store", __package__)
                    store.record_decision(self._conn, **decision)
                except Exception:
                    logger.debug("flightdeck: decision write failed", exc_info=True)
            return route
        except Exception:
            logger.debug("flightdeck: routing decision failed; requested route kept", exc_info=True)
            return requested


__all__ = [
    "DEFAULT_SETTINGS", "PROVIDER_AVAILABLE", "Provider",
    "arm_status", "decide", "lane_for_route", "route_for_lane", "reset_state",
]
