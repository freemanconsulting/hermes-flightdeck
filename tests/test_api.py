"""§9.1 snapshot shape, §8 formulas, poller TTL, and the dashboard routes.

Rows come from the deterministic seed in ``make_example.py`` (the in-test §5.1
helper), so the expected numbers are fixed and readable.
"""

from __future__ import annotations

import importlib.util
import json
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
import make_example  # noqa: E402
import poller  # noqa: E402

NOW = make_example.NOW
DS4 = make_example.DS4
GN100 = make_example.GN100


@pytest.fixture()
def conn(tmp_path):
    db = sqlite3.connect(str(tmp_path / "requests.db"))
    make_example.seed(db)
    try:
        yield db
    finally:
        db.close()


def snapshot(conn, **kw):
    kw.setdefault("servers", make_example.server_samples())
    kw.setdefault("now", NOW)
    return api.build_snapshot(300, conn=conn, **kw)


def card(snapshot_payload, name):
    return next(item for item in snapshot_payload["servers"] if item["name"] == name)


def model(snapshot_payload, key):
    return next(item for item in snapshot_payload["models"] if item["key"] == key)


# --- §9.1 shape -------------------------------------------------------------


def test_snapshot_shape_is_pinned(conn):
    payload = snapshot(conn)
    assert list(payload) == ["generated_at", "window", "totals", "servers", "models", "agents"]
    assert payload["window"] == {"seconds": 300, "since": NOW - 300}
    assert list(payload["totals"]) == ["in_flight", "requests_1m", "requests_5m", "errors_5m"]
    assert payload["totals"] == {"in_flight": 6, "requests_1m": 6, "requests_5m": 11, "errors_5m": 1}

    ds4 = card(payload, "ds4")
    assert list(ds4) == [
        "name", "base_url", "kind", "healthy", "models", "running", "waiting", "slots",
        "decode_tps", "prefill_tps", "in_flight", "unattributed", "over_attributed",
        "agents", "samples", "error", "sampled_at",
    ]
    assert ds4["base_url"] == DS4
    assert ds4["in_flight"] == 3
    assert ds4["agents"][0]["label"] == ""
    assert ds4["agents"][0]["requests"] == 2
    assert len(ds4["samples"]) == 3
    assert ds4["samples"][-1][:1] == [NOW]

    ds4_model = model(payload, f"ds4|{make_example.DS4_MODEL}")
    assert list(ds4_model) == [
        "key", "model", "provider", "base_url", "server_name", "kind", "lane", "in_flight",
        "requests_1m", "requests_5m", "errors_5m", "errors_429_5m", "ttft_ms_p50",
        "ttft_ms_p95", "decode_tps", "prefill_tps", "rate_kind", "tokens", "slots",
        "agents", "quota",
    ]
    assert ds4_model["lane"] == "local"
    assert ds4_model["quota"] is None
    assert ds4_model["agents"][0]["label"] == ""

    agent = payload["agents"][0]
    assert list(agent) == [
        "profile", "session_id", "label", "kind", "parent_session_id", "cron_job",
        "in_flight", "requests_5m", "errors_5m", "models", "oldest_started_at", "children",
    ]
    assert agent["label"] == ""
    assert agent["children"][0]["kind"] == "subagent"
    assert agent["children"][0]["role"] == "general"


# --- §8 formulas ------------------------------------------------------------


def test_unattributed_and_over_attributed_math(conn):
    payload = snapshot(conn)
    ds4 = card(payload, "ds4")
    assert (ds4["running"], ds4["in_flight"], ds4["unattributed"], ds4["over_attributed"]) == (3, 3, 0, 0)
    gn100 = card(payload, "GN100")
    assert (gn100["running"], gn100["in_flight"]) == (5, 2)
    assert gn100["unattributed"] == 3
    assert gn100["over_attributed"] == 0


def test_ttft_and_tokens_formulas(conn):
    payload = snapshot(conn)
    ds4_model = model(payload, f"ds4|{make_example.DS4_MODEL}")
    # Two finished requests: TTFT 200 ms and 100 ms -> p50 100, p95 200.
    assert ds4_model["ttft_ms_p50"] == 100.0
    assert ds4_model["ttft_ms_p95"] == 200.0
    assert ds4_model["tokens"] == {"prompt": 18000, "cached": 14000, "completion": 1200, "reasoning": 0}
    assert ds4_model["requests_5m"] == 6
    assert ds4_model["errors_5m"] == 1
    assert ds4_model["errors_429_5m"] == 1
    assert ds4_model["rate_kind"] == "decode"
    assert ds4_model["decode_tps"] == 42.1
    assert ds4_model["prefill_tps"] == 3100.0
    assert ds4_model["slots"] == {"used": 3, "total": 4, "queue": 0}


def test_null_is_not_zero(conn):
    payload = snapshot(conn)
    cloud = model(payload, f"anthropic|{make_example.CLOUD_MODEL}")
    assert cloud["lane"] == "cloud"
    assert cloud["slots"] is None
    assert cloud["quota"] is None
    assert cloud["decode_tps"] is not None  # derived from the finished row, not a gauge

    unknown = {"name": "ollama", "base_url": "http://127.0.0.1:11434", "kind": "ollama",
               "healthy": True, "models": [], "running": None, "waiting": None, "slots": None,
               "decode_tps": None, "prefill_tps": None, "sampled_at": api._now_iso(NOW),
               "error": None}
    payload = snapshot(conn, servers=[unknown])
    card_unknown = card(payload, "ollama")
    assert card_unknown["unattributed"] is None
    assert card_unknown["over_attributed"] is None
    assert card_unknown["samples"] == []
    status = api.fleet_status(payload)
    assert status["lanes"][0]["verdict"] == "unknown"
    assert status["pick"] is None


def test_unreachable_shows_last_good_sample(conn):
    payload = snapshot(conn, servers=[
        {"name": "GN100", "base_url": GN100, "kind": "tensorfold", "healthy": None,
         "models": [], "running": None, "waiting": None, "slots": None,
         "decode_tps": None, "prefill_tps": None, "sampled_at": api._now_iso(NOW),
         "error": "connect failed"},
    ])
    gn100 = card(payload, "GN100")
    assert gn100["error"] == "connect failed"
    assert gn100["running"] == 5  # last good sample in server_samples
    assert gn100["slots"] == 5
    assert api.fleet_status(payload)["lanes"][0]["verdict"] == "unreachable"


def test_request_detail_derives_per_request_numbers(conn):
    payload = api.build_request("default|4242|d1", conn=conn)
    assert payload["request"]["id"] == "default|4242|d1"
    assert payload["derived"]["ttft_ms"] == 200.0
    assert payload["derived"]["prefill_tps"] == 15000.0
    assert payload["derived"]["decode_tps"] == 444.4
    assert payload["derived"]["rate_kind"] == "decode"
    assert api.build_request("nope", conn=conn)["request"] is None


# --- §11 fleet_status -------------------------------------------------------


def test_fleet_status_json_and_pick(conn):
    status = api.fleet_status(snapshot(conn))
    assert json.loads(json.dumps(status))["as_of"].endswith("Z")
    assert [lane["name"] for lane in status["lanes"]] == ["ds4", "GN100"]
    assert [lane["verdict"] for lane in status["lanes"]] == ["spare", "saturated"]
    assert status["lanes"][0]["slots"] == {"used": 3, "total": 4}
    assert status["lanes"][0]["free_slots"] == 1
    assert status["lanes"][1]["queue"] == 2
    assert status["pick"]["lane"] == "ds4"
    assert "1 of 4 slots free" in status["pick"]["reason"]
    assert status["cloud"] == [{
        "provider": "anthropic", "model": make_example.CLOUD_MODEL, "in_flight": 1,
        "requests_5m": 2, "errors_429_5m": 0, "ttft_ms_p50": 900.0, "verdict": "busy",
    }]


def test_fleet_status_text_one_liner(conn):
    assert api.fleet_status_text(snapshot(conn)) == (
        "ds4 3/4 · GN100 5/5 (2 queued) · anthropic 1 in flight · pick: ds4"
    )


def test_build_health_shape(conn):
    health = api.build_health(conn=conn, servers=make_example.server_samples(),
                              samples=make_example.server_samples())
    assert health["ok"] is True
    assert health["rows"] == 11
    assert health["in_flight"] == 6
    assert health["servers_declared"] == 3
    assert health["servers_probed"] == 3
    assert health["server_errors"] == 0


# --- poller ----------------------------------------------------------------


def _fake_probe(monkeypatch, responses):
    calls = []

    def probe(base_url, timeout=2.0):
        calls.append(base_url)
        return responses[len(calls) - 1]

    monkeypatch.setattr(poller._servers_module(), "probe", probe)
    return calls


def test_poller_ttl_cache_and_floor(monkeypatch):
    calls = _fake_probe(monkeypatch, [
        {"name": "ds4", "base_url": DS4, "kind": "tensorfold", "healthy": True,
         "sampled_at": api._now_iso(NOW)},
        {"name": "ds4", "base_url": DS4, "kind": "tensorfold", "healthy": True,
         "sampled_at": api._now_iso(NOW)},
    ])
    poller.clear_cache()
    servers = [{"name": "ds4", "base_url": DS4, "kind": "tensorfold"}]
    first = poller.poll_sync(servers, ttl=5.0)
    second = poller.poll_sync(servers, ttl=5.0)
    assert len(calls) == 1
    assert first[DS4]["name"] == "ds4"
    assert second == first
    # ttl=0 is floored to 2 s, so an immediate re-poll still hits the cache.
    poller.poll_sync(servers, ttl=0.0)
    assert len(calls) == 1
    poller.clear_cache()
    poller.poll_sync(servers, ttl=5.0)
    assert len(calls) == 2


def test_poller_counter_delta_rates(monkeypatch):
    _fake_probe(monkeypatch, [
        {"name": "vllm", "base_url": "http://127.0.0.1:18008", "kind": "vllm",
         "generation_tokens_total": 100, "prompt_tokens_total": 1000,
         "sampled_at": api._now_iso(NOW - 5)},
        {"name": "vllm", "base_url": "http://127.0.0.1:18008", "kind": "vllm",
         "generation_tokens_total": 200, "prompt_tokens_total": 2000,
         "sampled_at": api._now_iso(NOW)},
    ])
    poller.clear_cache()
    servers = [{"name": "vllm", "base_url": "http://127.0.0.1:18008", "kind": "vllm"}]
    poller.poll_sync(servers, ttl=5.0)
    # Age the cache past the TTL so the next poll probes again and sees the delta.
    poller._CACHE["http://127.0.0.1:18008"]["at"] -= 10
    sample = poller.poll_sync(servers, ttl=5.0)["http://127.0.0.1:18008"]
    assert sample["decode_tps"] == 20.0
    assert sample["prefill_tps"] == 200.0


def test_poller_skips_cloud_and_writes_samples(conn, monkeypatch):
    calls = _fake_probe(monkeypatch, [
        {"name": "ds4", "base_url": DS4, "kind": "tensorfold", "healthy": True,
         "running": 3, "waiting": 0, "slots": 4, "decode_tps": 42.1,
         "sampled_at": api._now_iso(NOW)},
    ])
    poller.clear_cache()
    servers = [
        {"name": "anthropic", "base_url": "https://api.anthropic.com", "kind": "cloud"},
        {"name": "ds4", "base_url": DS4, "kind": "tensorfold"},
    ]
    result = poller.poll_sync(servers, conn=conn)
    assert calls == [DS4]
    assert list(result) == [DS4]
    rows = conn.execute("SELECT * FROM server_samples WHERE base_url = ?", (DS4,)).fetchall()
    assert any(row["decode_tps"] == 42.1 for row in rows)


# --- dashboard routes -------------------------------------------------------


def test_plugin_api_router_routes():
    path = ROOT / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("flightdeck_plugin_api_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["flightdeck_plugin_api_test"] = module
    spec.loader.exec_module(module)
    routes = {(route.path, tuple(sorted(route.methods))) for route in module.router.routes}
    assert routes == {
        ("/snapshot", ("GET",)),
        ("/agents", ("GET",)),
        ("/models", ("GET",)),
        ("/servers", ("GET",)),
        ("/request/{request_id}", ("GET",)),
        ("/health", ("GET",)),
        ("/refresh", ("POST",)),
    }


def test_plugin_api_handlers_answer_from_the_store(conn, monkeypatch):
    """Handlers parse, call api.py, return — exercised without the live mount."""
    import asyncio
    import contextlib

    path = ROOT / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("flightdeck_plugin_api_handlers", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["flightdeck_plugin_api_handlers"] = module
    spec.loader.exec_module(module)

    @contextlib.contextmanager
    def fake_conn():
        yield conn

    async def fake_poll(conn, force=False):
        return {sample["base_url"]: sample for sample in make_example.server_samples()}

    monkeypatch.setattr(module, "_conn", fake_conn)
    monkeypatch.setattr(module, "_poll", fake_poll)
    monkeypatch.setattr(module, "_maybe_sweep", lambda conn: None)

    payload = asyncio.run(module.snapshot("5m"))
    assert list(payload) == ["generated_at", "window", "totals", "servers", "models", "agents"]
    assert payload["totals"]["in_flight"] == 6

    assert len(module.agents("1m")["agents"]) == 2
    assert len(asyncio.run(module.models("5m"))["models"]) == 3
    assert [card["name"] for card in asyncio.run(module.servers())["servers"]] == ["ds4", "GN100", "anthropic"]
    assert module.request_detail("default|4242|d1")["derived"]["ttft_ms"] == 200.0
    assert asyncio.run(module.health())["rows"] == 11
    assert asyncio.run(module.refresh()) == {"ok": True, "probed": 3}
