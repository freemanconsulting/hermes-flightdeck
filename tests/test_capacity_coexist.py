"""Coexistence and routing-off equivalence (CAPACITY.md §2, §10).

Flightdeck never writes ``delegation.backend``: with another backend active it
reports ``blocked_by`` and the exact switch command, and with routing off the
provider returns the requested route byte-for-byte like ``default``.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import capacity  # noqa: E402

DS4_URL = "http://127.0.0.1:18010/v1"
GN100_URL = "http://127.0.0.1:18009/v1"


def settings(**over):
    base = {
        "route_delegation": True, "inner_backend": "default", "reserve_slots": 0,
        "max_queue": 2, "routing_staleness_seconds": 20, "routing_ledger_seconds": 60,
        "routing_servers": [], "hidden_servers": [],
        "servers": [
            {"name": "ds4", "base_url": DS4_URL, "kind": "tensorfold"},
            {"name": "GN100", "base_url": GN100_URL, "kind": "tensorfold"},
        ],
    }
    base.update(over)
    return base


BACKENDS = [
    {"name": "default", "label": "Default", "available": True},
    {"name": "model_map", "label": "capacity-routing", "available": True},
]


def test_routing_off_is_never_armed():
    status = capacity.arm_status(settings(route_delegation=False),
                                 {"backend": "model_map"}, BACKENDS)
    assert status["armed"] is False
    assert status["blocked_by"] is None
    assert status["message"] == ""


def test_other_backend_active_is_blocked_with_switch_command():
    status = capacity.arm_status(settings(), {"backend": "model_map"}, BACKENDS)
    assert status["armed"] is False
    assert status["blocked_by"] == "model_map"
    assert "delegation.backend is 'model_map' (capacity-routing)" in status["message"]
    assert "Switch with `/delegation flightdeck --now`" in status["message"]
    assert "hermes config set delegation.backend flightdeck" in status["message"]


def test_default_backend_is_blocked_too():
    status = capacity.arm_status(settings(), {"backend": "default"}, BACKENDS)
    assert status["armed"] is False
    assert status["blocked_by"] == "default"
    assert "/delegation flightdeck --now" in status["message"]


def test_flightdeck_backend_with_default_inner_is_armed():
    status = capacity.arm_status(settings(), {"backend": "flightdeck"}, BACKENDS)
    assert status["armed"] is True
    assert status["blocked_by"] is None
    assert status["message"] == ""
    assert status["eligible_lanes"] == ["ds4", "GN100"]


def test_plugin_inner_backend_refuses_to_arm():
    status = capacity.arm_status(settings(inner_backend="model_map"),
                                 {"backend": "flightdeck"}, BACKENDS)
    assert status["armed"] is False
    assert status["blocked_by"] == "model_map"
    assert "inner_backend 'default'" in status["message"]


def test_eligible_lanes_honor_routing_servers():
    status = capacity.arm_status(settings(routing_servers=["GN100"]),
                                 {"backend": "flightdeck"}, BACKENDS)
    assert status["eligible_lanes"] == ["GN100"]


def test_provider_availability_only_for_default_inner():
    assert capacity.Provider(lambda: settings()).is_available() is True
    assert capacity.Provider(
        lambda: settings(inner_backend="model_map")).is_available() is False


def test_provider_identity():
    provider = capacity.Provider(lambda: settings())
    assert provider.name == "flightdeck"
    assert provider.display_name == "Flightdeck (capacity-aware)"
    assert provider.task_parameters({}) == {}
    assert provider.description({}) == ""


def test_routing_off_route_is_identical_to_default():
    config = {
        "backend": "flightdeck", "provider": "studio-ds4", "model": "ds4",
        "base_url": DS4_URL, "api_mode": "chat_completions", "service_tier": "priority",
        "reasoning_effort": "low", "label": "task",
    }
    provider = capacity.Provider(lambda: settings(route_delegation=False))
    route = provider.route_task({"index": 0, "goal": "metrics adapters"}, config)
    expected = {key: value for key, value in config.items() if key != "service_tier"}
    assert route == expected
    assert "service_tier" not in route
