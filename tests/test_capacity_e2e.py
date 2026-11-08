"""Capacity routing end-to-end through the real delegation registry (CAPACITY.md §10).

A temp ``HERMES_HOME`` with the plugin symlinked in, real plugin discovery, real
``get_active_provider`` and real ``delegate_task``; only the poller's samples and
the child build/run are stubbed, so what the child is handed is what routing
decided.  No network, no real config, no real store.

The plugin root has a ``tools.py`` and ``tests/conftest.py`` puts it on
``sys.path``, which would shadow Hermes' ``tools`` package for the plugin
loader; ``_import_hermes_tools`` imports the real package by path first.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import sqlite3
import sys
import time
import types
from pathlib import Path

import hermes_yaml as yaml
import pytest

ROOT = Path(__file__).resolve().parent.parent
DS4_URL = "http://127.0.0.1:18010/v1"
GN100_URL = "http://127.0.0.1:18009/v1"


def _import_hermes_tools() -> None:
    """Cache Hermes' ``tools`` package before the plugin loader imports it."""
    module = sys.modules.get("tools")
    if module is not None and hasattr(module, "__path__"):
        return
    hermes = Path(importlib.import_module("hermes_cli.plugins").__file__).resolve().parent.parent
    sys.path.insert(0, str(hermes))
    try:
        importlib.import_module("tools.registry")
    finally:
        sys.path.remove(str(hermes))


def _load_by_path(name: str, filename: str):
    """Load one plugin-root module by path under its plugin-scoped name."""
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _config(route_delegation: bool = True) -> dict:
    """One temp config.yaml: declared servers, two providers, the flightdeck route."""
    return {
        "plugins": {
            "enabled": ["flightdeck"],
            "entries": {"flightdeck": {"settings": {
                "servers": [
                    {"name": "ds4", "base_url": DS4_URL, "kind": "tensorfold"},
                    {"name": "GN100", "base_url": GN100_URL, "kind": "tensorfold"},
                ],
                "route_delegation": route_delegation,
                "reserve_slots": 0,
                "max_queue": 2,
            }}},
        },
        "providers": {
            "studio-ds4": {"api": DS4_URL, "api_key": "test-key",
                           "default_model": "ds4", "models": {"ds4": {}}},
            "gb10-qwen": {"api": GN100_URL, "api_key": "test-key",
                          "default_model": "qwen38-flash-next-tf-fp4",
                          "models": {"qwen38-flash-next-tf-fp4": {}}},
        },
        "delegation": {"backend": "flightdeck", "provider": "studio-ds4", "model": "ds4",
                       "base_url": DS4_URL, "api_mode": "chat_completions"},
    }


def _home(tmp_path, monkeypatch, *, route_delegation: bool = True):
    """Temp HERMES_HOME with the plugin symlinked in; real discovery, real registry."""
    _import_hermes_tools()
    from hermes_cli import plugins as plugins_mod
    from hermes_cli.plugins import PluginManager

    home = tmp_path / ".hermes"
    plugin_dir = home / "plugins" / "flightdeck"
    plugin_dir.parent.mkdir(parents=True)
    plugin_dir.symlink_to(ROOT, target_is_directory=True)
    (home / "config.yaml").write_text(yaml.safe_dump(_config(route_delegation)), encoding="utf-8")
    # No bundled plugins: the flightdeck backend is the only provider this test needs.
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "os-home"))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(plugins_mod, "get_bundled_plugins_dir", lambda: bundled)
    manager = PluginManager()
    manager.discover_and_load()
    return home, manager


def _reset_ledger() -> None:
    """Clear the process-global placement ledger the plugin's capacity module owns."""
    sys.modules["flightdeck_capacity"].reset_state()


def _sample(name: str, url: str, slots: int, running: int) -> dict:
    return {"name": name, "base_url": url, "slots": slots, "running": running,
            "waiting": 0, "healthy": True, "sampled_at": time.time(), "error": None}


@pytest.fixture
def polled(monkeypatch):
    """The poller's live fleet: ds4 full 4/4, GN100 1/5.  Fresh relative to now."""
    # Reuse the module the capacity module already cached: a fresh load would
    # leave its sibling cache pointing at the old object and the stub inert.
    poller = sys.modules.get("flightdeck_poller") or _load_by_path(
        "flightdeck_poller", "poller.py")
    samples = {"http://127.0.0.1:18010": _sample("ds4", DS4_URL, 4, 4),
               "http://127.0.0.1:18009": _sample("GN100", GN100_URL, 5, 1)}
    monkeypatch.setattr(poller, "poll_sync",
                        lambda servers, ttl=5.0, timeout=2.0, conn=None: dict(samples))
    return samples


@pytest.fixture
def recorded(monkeypatch):
    """Record what each child is built with; children 'complete' immediately."""
    from tools import delegate_tool as dt
    built = []

    def build(**kwargs):
        built.append(kwargs)
        return types.SimpleNamespace(tool_progress_callback=None, model=kwargs.get("model"))

    monkeypatch.setattr(dt, "_build_child_preserving_parent_tools", build)
    monkeypatch.setattr(dt, "_run_single_child", lambda task_index, goal, child=None,
                        parent_agent=None, **kw: {
                            "task_index": task_index, "status": "completed", "summary": "ok",
                            "api_calls": 1, "duration_seconds": 0})
    return built


def _parent():
    return types.SimpleNamespace(session_id="root", model="parent-model", provider="openrouter",
                                 tool_progress_callback=None, _delegate_spinner=None,
                                 request_overrides={}, _safe_print=lambda line: None)


def _decisions(home: Path) -> list[tuple]:
    conn = sqlite3.connect(str(home / "plugin-data" / "flightdeck" / "requests.db"))
    try:
        return conn.execute(
            "SELECT action, requested_lane, chosen_lane, reason FROM decisions "
            "ORDER BY id").fetchall()
    finally:
        conn.close()


def test_route_task_spills_to_the_free_lane_when_the_requested_lane_is_full(
        tmp_path, monkeypatch, polled):
    home, manager = _home(tmp_path, monkeypatch)
    try:
        _reset_ledger()
        from agent.delegation_registry import get_active_provider
        from tools.delegate_tool_config import _load_config

        provider = get_active_provider(_load_config())
        assert provider.name == "flightdeck"
        route = provider.route_task({"index": 0, "goal": "metrics adapters"}, _load_config())
        assert route["provider"] == "gb10-qwen"
        assert route["model"] == "qwen38-flash-next-tf-fp4"
        assert route["base_url"] == GN100_URL
        assert route["api_mode"] == "chat_completions"
        assert route["fallback_providers"] == [
            {"provider": "studio-ds4", "model": "ds4", "base_url": DS4_URL}]
        assert route["label"].startswith("task→GN100")
        # The placement is in the shared store, so the page's routed chip can find it.
        assert _decisions(home) == [
            ("move", "ds4", "GN100", "ds4 full 4/4, model qwen38-flash-next-tf-fp4")]
    finally:
        manager.unload()


def test_delegate_task_builds_the_child_on_the_spilled_lane(
        tmp_path, monkeypatch, polled, recorded):
    _, manager = _home(tmp_path, monkeypatch)
    try:
        _reset_ledger()
        from tools.delegate_tool import delegate_task

        out = json.loads(delegate_task(tasks=[{"goal": "metrics adapters"}],
                                       parent_agent=_parent()))
        assert out["results"][0]["status"] == "completed"
        built = recorded[0]
        assert built["model"] == "qwen38-flash-next-tf-fp4"
        assert built["override_base_url"] == GN100_URL
        # A provider key outside Hermes' built-ins resolves as "custom"; the route
        # the child was built from still names the lane's provider.
        assert built["routing_cfg"]["provider"] == "gb10-qwen"
    finally:
        manager.unload()


def test_routing_off_returns_the_request_unchanged(tmp_path, monkeypatch, polled):
    home, manager = _home(tmp_path, monkeypatch, route_delegation=False)
    try:
        _reset_ledger()
        from agent.delegation_registry import get_active_provider
        from tools.delegate_tool_config import _load_config

        requested = _load_config()
        route = get_active_provider(requested).route_task(
            {"index": 0, "goal": "metrics adapters"}, requested)
        assert route == requested
        assert route["provider"] == "studio-ds4" and route["model"] == "ds4"
        assert _decisions(home) == []
    finally:
        manager.unload()
