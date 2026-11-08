"""Demo mode and empty-state tests (DESIGN §9.1).

Demo mode must serve a live-looking seeded snapshot with the exact real shape,
never touch the real store, and carry plausible session titles.  A non-demo
fresh install must say why its page is empty via ``empty_reason``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

import api  # noqa: E402
import config  # noqa: E402
import demo  # noqa: E402
import make_example  # noqa: E402

NOW = make_example.NOW


@pytest.fixture()
def conn(tmp_path):
    db = sqlite3.connect(str(tmp_path / "requests.db"))
    make_example.seed(db)
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def empty_conn(tmp_path):
    """Seeded schema with every request and server sample removed."""
    db = sqlite3.connect(str(tmp_path / "empty.db"))
    make_example.seed(db)
    db.execute("DELETE FROM requests")
    db.execute("DELETE FROM server_samples")
    db.commit()
    try:
        yield db
    finally:
        db.close()


def _unreachable_sample():
    return {"name": "studio-worker", "base_url": "http://127.0.0.1:18012",
            "kind": "unknown", "healthy": None, "models": [], "running": None,
            "waiting": None, "slots": None, "decode_tps": None, "prefill_tps": None,
            "sampled_at": api._now_iso(NOW), "error": "connection refused"}


# --- demo setting ------------------------------------------------------------


def test_demo_mode_setting_and_env(monkeypatch):
    class Ctx:
        def __init__(self, values):
            self.values = values

        def get_config(self, key, default=None):
            return self.values.get(key, default)

    assert config.load(ctx=Ctx({"demo_mode": True})).get("demo_mode") is True
    assert config.load(ctx=Ctx({})).get("demo_mode") is False
    monkeypatch.setenv("FLIGHTDECK_DEMO", "1")
    assert config.load(ctx=Ctx({})).get("demo_mode") is True
    monkeypatch.delenv("FLIGHTDECK_DEMO")
    assert config.load(ctx=Ctx({})).get("demo_mode") is False


# --- demo snapshot -----------------------------------------------------------


def test_demo_snapshot_passes_the_real_shape_pin(conn):
    real = api.build_snapshot(300, servers=make_example.server_samples(), conn=conn, now=NOW)
    payload = demo.build_demo_snapshot(300, now=NOW, anchor=NOW)
    assert list(payload) == list(real)
    assert payload["demo"] is True
    assert payload["empty_reason"] is None
    assert payload["servers_source"] == "declared"
    assert payload["totals"]["in_flight"] == 6


def test_demo_snapshot_timestamps_are_fresh_and_ages_grow():
    payload = demo.build_demo_snapshot(300, now=NOW, anchor=NOW)
    assert payload["generated_at"] == NOW
    assert payload["window"] == {"seconds": 300, "since": NOW - 300}

    in_flight = [row for card in payload["servers"] for row in card["requests"]
                 if row["status"] == "in-flight"]
    assert in_flight
    assert all(row["started_at"] >= NOW - 300 and NOW - row["started_at"] > 0
               for row in in_flight)

    later = demo.build_demo_snapshot(300, now=NOW + 5, anchor=NOW)
    later_rows = [row for card in later["servers"] for row in card["requests"]
                  if row["status"] == "in-flight"]
    assert later["generated_at"] == NOW + 5
    assert later["window"]["since"] == NOW + 5 - 300
    # The fleet is anchored, so rows do not move; their in-flight ages grow.
    assert [row["started_at"] for row in later_rows] == \
        [row["started_at"] for row in in_flight]
    assert [later["generated_at"] - row["started_at"] for row in later_rows] == \
        [payload["generated_at"] - row["started_at"] + 5 for row in in_flight]


def test_demo_snapshot_has_plausible_session_titles():
    payload = demo.build_demo_snapshot(300, now=NOW, anchor=NOW)
    root = next(node for node in payload["agents"] if node["session_id"] == "s1")
    assert root["title"] == "Flightdeck hackathon"
    assert root["label"] == "Flightdeck hackathon"
    assert root["source"] == "desktop"
    assert root["started_at"] == NOW - 3600
    child = root["children"][0]
    assert child["title"] == "metrics adapters" and child["label"] == "metrics adapters"
    assert child["source"] == "subagent"


def test_demo_snapshot_never_opens_or_writes_the_real_store(monkeypatch, tmp_path):
    def raiser(*_args, **_kwargs):
        raise AssertionError("demo mode opened the real store")

    monkeypatch.setattr(demo._api(), "_open_conn", raiser)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    payload = demo.build_demo_snapshot(300, now=NOW, anchor=NOW)
    assert payload["demo"] is True
    assert not (tmp_path / "plugin-data" / "flightdeck" / "requests.db").exists()


def test_plugin_api_routes_serve_demo_without_opening_store(monkeypatch):
    path = ROOT / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("flightdeck_demo_routes", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["flightdeck_demo_routes"] = module
    spec.loader.exec_module(module)
    monkeypatch.setenv("FLIGHTDECK_DEMO", "1")

    def raiser(*_args, **_kwargs):
        raise AssertionError("demo route opened the store")

    monkeypatch.setattr(module, "_conn", raiser)
    payload = asyncio.run(module.snapshot("5m"))
    assert payload["demo"] is True and payload["empty_reason"] is None
    assert payload["agents"][0]["title"] == "Flightdeck hackathon"
    assert module.agents("1m")["demo"] is True
    assert asyncio.run(module.models("5m"))["demo"] is True
    assert asyncio.run(module.servers())["demo"] is True


# --- empty_reason ------------------------------------------------------------


def test_empty_reason_no_servers_configured(empty_conn):
    payload = api.build_snapshot(300, servers=[], conn=empty_conn, now=NOW,
                                 routing=demo._DEMO_ROUTING)
    assert payload["empty_reason"] == "no_servers_configured"
    assert payload["servers"] == [] and payload["agents"] == []


def test_empty_reason_no_traffic(empty_conn):
    payload = api.build_snapshot(300, servers=make_example.server_samples(),
                                 conn=empty_conn, now=NOW, routing=demo._DEMO_ROUTING)
    assert payload["servers"]
    assert payload["empty_reason"] == "no_traffic"


def test_empty_reason_servers_unreachable(empty_conn):
    payload = api.build_snapshot(300, servers=[_unreachable_sample()], conn=empty_conn,
                                 now=NOW, servers_source="discovered",
                                 routing=demo._DEMO_ROUTING)
    assert payload["servers"] == [] and payload["unreachable"]
    assert payload["empty_reason"] == "servers_unreachable"


def test_empty_reason_is_null_when_traffic_exists(conn):
    payload = api.build_snapshot(300, servers=[], conn=conn, now=NOW,
                                 routing=demo._DEMO_ROUTING)
    assert payload["agents"]
    assert payload["empty_reason"] is None
