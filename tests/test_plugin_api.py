"""Dashboard backend: the sweep error path must log, never raise, never crash twice."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"


@pytest.fixture()
def plugin_api():
    """Load the dashboard file the way the live mount does: standalone by path."""
    name = "flightdeck_plugin_api_test"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _Recorder:
    def __init__(self, raises: bool = False):
        self.calls: list[tuple[str, object]] = []
        self._raises = raises

    def warning(self, message, exc_info=None):
        if self._raises:
            raise RuntimeError("logging backend is broken")
        self.calls.append((message, exc_info))


class _FakeStore:
    def __init__(self, exc: BaseException):
        self.exc = exc

    def sweep(self, conn, **kwargs):
        raise self.exc


class _FakeConfig:
    def load(self, conn=None):
        return {"retention_hours": 24, "rollup_days": 7}


def test_maybe_sweep_logs_the_exception_and_never_raises(plugin_api, monkeypatch):
    boom = ValueError("rollup bucket already exists")
    modules = {"store": _FakeStore(boom), "config": _FakeConfig()}
    monkeypatch.setattr(plugin_api, "_load_sibling", lambda name: modules.get(name))
    recorder = _Recorder()
    monkeypatch.setattr(plugin_api, "logger", recorder)

    for _ in range(2):  # a second sweep must not raise either
        plugin_api._LAST_SWEEP = 0.0
        plugin_api._WARN_AT = 0.0
        plugin_api._maybe_sweep(None)

    assert [message for message, _ in recorder.calls] == [
        "flightdeck: store sweep failed", "flightdeck: store sweep failed"]
    assert recorder.calls[0][1][1] is boom  # the exception rides along explicitly


def test_warn_survives_a_broken_logging_backend(plugin_api, monkeypatch):
    monkeypatch.setattr(plugin_api, "logger", _Recorder(raises=True))
    plugin_api._WARN_AT = 0.0

    plugin_api._warn("flightdeck: store sweep failed", ValueError("boom"))  # no raise


@pytest.mark.parametrize("window, seconds", [
    ("1m", 60), ("60", 60), ("60s", 60),
    ("5m", 300), ("300", 300),
    ("", 300), (None, 300), ("bogus", 300),
])
def test_window_seconds_maps_one_minute_and_five_minutes(plugin_api, window, seconds):
    assert plugin_api._window_seconds(window) == seconds
