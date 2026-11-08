"""Capacity-aware delegation decision table (CAPACITY.md §10).

Every case is a pure ``decide()`` call with injected samples, servers and provider
routes: no network, no config.yaml, no real poller.  The ledger is reset per case
so the batch counters never leak between tests.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import capacity  # noqa: E402

NOW = 1762540800.0
DS4_URL = "http://127.0.0.1:18010/v1"
GN100_URL = "http://127.0.0.1:18009/v1"
GN200_URL = "http://127.0.0.1:18011/v1"


def servers():
    return [
        {"name": "ds4", "base_url": DS4_URL, "kind": "tensorfold", "models": ["ds4"]},
        {"name": "GN100", "base_url": GN100_URL, "kind": "tensorfold",
         "models": ["qwen38-flash-next-tf-fp4"]},
    ]


def routes():
    return {
        "http://127.0.0.1:18010": {
            "provider": "studio-ds4", "base_url": DS4_URL, "default_model": "ds4",
            "models": ["ds4"], "extra_body": None, "profiles": ["default"], "aux": False},
        "http://127.0.0.1:18009": {
            "provider": "gb10-qwen", "base_url": GN100_URL,
            "default_model": "qwen38-flash-next-tf-fp4",
            "models": ["qwen38-flash-next-tf-fp4"], "extra_body": None,
            "profiles": ["default"], "aux": False},
    }


def sample(name, url, slots, running, waiting=0, healthy=True, age=0.0, error=None):
    return {"name": name, "base_url": url, "slots": slots, "running": running,
            "waiting": waiting, "healthy": healthy, "sampled_at": NOW - age, "error": error}


def samples(ds4=None, gn100=None):
    out = {}
    if ds4 is not None:
        out["http://127.0.0.1:18010"] = ds4
    if gn100 is not None:
        out["http://127.0.0.1:18009"] = gn100
    return out


def settings(**over):
    base = {
        "route_delegation": True, "inner_backend": "default", "reserve_slots": 0,
        "max_queue": 2, "routing_staleness_seconds": 20, "routing_ledger_seconds": 60,
        "routing_servers": [], "hidden_servers": [],
    }
    base.update(over)
    return base


def delegation(**over):
    base = {"backend": "flightdeck", "provider": "studio-ds4", "model": "ds4",
            "base_url": DS4_URL, "api_mode": "chat_completions"}
    base.update(over)
    return base


def run(task=None, config=None, samples_=None, settings_=None, now=NOW,
        servers_=None, provider_routes_=None) -> tuple[dict, Any]:
    capacity.reset_state()
    return capacity.decide(
        task or {"index": 0, "goal": "metrics adapters"},
        config if config is not None else delegation(),
        samples=samples_ if samples_ is not None else samples(
            sample("ds4", DS4_URL, 4, 4), sample("GN100", GN100_URL, 5, 1)),
        servers=servers_ if servers_ is not None else servers(),
        provider_routes=provider_routes_ if provider_routes_ is not None else routes(),
        settings=settings_ or settings(), now=now)


# ─── free / full / all full ────────────────────────────────────────────────


def test_free_requested_lane_stays():
    route, decision = run(samples_=samples(
        sample("ds4", DS4_URL, 4, 2), sample("GN100", GN100_URL, 5, 1)))
    assert route == delegation()
    assert decision["action"] == "stay"
    assert decision["chosen_lane"] == "ds4"
    assert decision["reason"] == "2 of 4 slots free, queue empty"


def test_full_requested_lane_spills_to_most_free():
    route, decision = run()
    assert decision["action"] == "move"
    assert decision["requested_lane"] == "ds4"
    assert decision["chosen_lane"] == "GN100"
    assert decision["reason"] == "ds4 full 4/4, model qwen38-flash-next-tf-fp4"
    assert route["provider"] == "gb10-qwen"
    assert route["model"] == "qwen38-flash-next-tf-fp4"
    assert route["base_url"] == GN100_URL
    assert route["api_mode"] == "chat_completions"
    assert route["fallback_providers"] == [
        {"provider": "studio-ds4", "model": "ds4", "base_url": DS4_URL}]
    assert route["label"].startswith("task→GN100")


def test_all_local_full_unchanged():
    route, decision = run(samples_=samples(
        sample("ds4", DS4_URL, 4, 4), sample("GN100", GN100_URL, 5, 5)))
    assert route == delegation()
    assert decision["action"] == "skip"
    assert decision["chosen_lane"] is None
    assert decision["reason"] == "all local lanes full: ds4 4/4, GN100 5/5"


# ─── stale / missing / error / no gauge ───────────────────────────────────


def test_stale_sample_unchanged():
    route, decision = run(samples_=samples(
        sample("ds4", DS4_URL, 4, 2, age=42), sample("GN100", GN100_URL, 5, 1)))
    assert route == delegation()
    assert decision["action"] == "skip"
    assert decision["stale"] is True
    assert decision["reason"] == "stale sample: ds4 42s old"


def test_missing_sample_unchanged():
    route, decision = run(samples_=samples(gn100=sample("GN100", GN100_URL, 5, 1)))
    assert route == delegation()
    assert decision["reason"] == "no sample for ds4"


def test_error_sample_unchanged():
    route, decision = run(samples_=samples(
        sample("ds4", DS4_URL, 4, 2, error="connection refused"),
        sample("GN100", GN100_URL, 5, 1)))
    assert route == delegation()
    assert decision["reason"] == "unreachable: ds4 (connection refused)"


def test_no_slot_gauge_unchanged():
    route, decision = run(samples_=samples(
        sample("ds4", DS4_URL, None, 2), sample("GN100", GN100_URL, 5, 1)))
    assert route == delegation()
    assert decision["reason"] == "no slot gauge on ds4"


# ─── never cloud / profile / api_key / hidden / routing_servers ───────────


def test_explicit_cloud_route_untouched():
    route, decision = run(config=delegation(
        provider="anthropic", model="claude-opus-5-5", base_url="https://api.anthropic.com/v1"))
    assert route["base_url"] == "https://api.anthropic.com/v1"
    assert decision is None


def test_profile_route_untouched():
    route, decision = run(config=delegation(profile="worker"))
    assert route["profile"] == "worker"
    assert decision is None


def test_api_key_route_untouched():
    route, decision = run(config=delegation(api_key="sk-explicit"))
    assert route["api_key"] == "sk-explicit"
    assert decision is None


def test_empty_route_untouched():
    route, decision = run(config={})
    assert route == {}
    assert decision is None


def test_hidden_lane_untouched():
    route, decision = run(settings_=settings(hidden_servers=["ds4"]))
    assert route == delegation()
    assert decision is None


def test_routing_servers_excludes_requested_lane():
    route, decision = run(settings_=settings(routing_servers=["GN100"]))
    assert route == delegation()
    assert decision is None


# ─── queue / reserve / batch / tie-break / model ──────────────────────────


def test_queued_over_max_queue_skips():
    route, decision = run(samples_=samples(
        sample("ds4", DS4_URL, 4, 4, waiting=2), sample("GN100", GN100_URL, 5, 1)))
    assert route == delegation()
    assert decision["action"] == "skip"
    assert decision["reason"] == "ds4 queue 2"


def test_reserve_slots_honored():
    route, decision = run(
        samples_=samples(sample("ds4", DS4_URL, 4, 3), sample("GN100", GN100_URL, 5, 1)),
        settings_=settings(reserve_slots=1))
    assert decision["action"] == "move"
    assert decision["chosen_lane"] == "GN100"
    assert decision["reason"] == "ds4 3/4, reserve 1, model qwen38-flash-next-tf-fp4"


def test_batch_fan_out_spreads():
    capacity.reset_state()
    ds4_sample = sample("ds4", DS4_URL, 4, 2)
    gn100_sample = sample("GN100", GN100_URL, 5, 1)
    actions = []
    for index in range(3):
        route, decision = capacity.decide(
            {"index": index, "goal": "metrics adapters"}, delegation(),
            samples=samples(ds4_sample, gn100_sample), servers=servers(),
            provider_routes=routes(), settings=settings(), now=NOW)
        actions.append((decision["action"], decision["chosen_lane"]))
    assert actions == [("stay", "ds4"), ("stay", "ds4"), ("move", "GN100")]


def test_tie_break_is_deterministic():
    servers_ = servers() + [
        {"name": "GN200", "base_url": GN200_URL, "kind": "tensorfold", "models": ["qwen38"]}]
    routes_ = routes()
    routes_["http://127.0.0.1:18011"] = {
        "provider": "gb10-qwen", "base_url": GN200_URL, "default_model": "qwen38",
        "models": ["qwen38"], "extra_body": None, "profiles": ["default"], "aux": False}
    samples_ = samples(sample("ds4", DS4_URL, 4, 4),
                       sample("GN100", GN100_URL, 5, 4, waiting=1))
    samples_["http://127.0.0.1:18011"] = sample("GN200", GN200_URL, 5, 4, waiting=0)

    def pick():
        capacity.reset_state()
        route, decision = capacity.decide(
            {"index": 0, "goal": "metrics adapters"}, delegation(),
            samples=samples_, servers=servers_, provider_routes=routes_,
            settings=settings(), now=NOW)
        return decision["chosen_lane"]

    assert pick() == "GN200"
    assert pick() == "GN200"


def test_requested_model_not_served_uses_target_default():
    route, decision = run(config=delegation(model="other-model"))
    assert decision["chosen_lane"] == "GN100"
    assert route["model"] == "qwen38-flash-next-tf-fp4"


def test_target_without_model_skips():
    routes_ = routes()
    routes_["http://127.0.0.1:18009"] = {
        "provider": "gb10-qwen", "base_url": GN100_URL, "default_model": None,
        "models": [], "extra_body": None, "profiles": ["default"], "aux": False}
    route, decision = run(
        samples_=samples(sample("ds4", DS4_URL, 4, 4), sample("GN100", GN100_URL, 5, 1)),
        config=delegation(model="other-model"),
        servers_=[
            {"name": "ds4", "base_url": DS4_URL, "kind": "tensorfold", "models": ["ds4"]},
            {"name": "GN100", "base_url": GN100_URL, "kind": "tensorfold", "models": []},
        ],
        provider_routes_=routes_)
    assert route["model"] == "other-model"
    assert decision["action"] == "skip"
    assert decision["reason"] == "no model on GN100"


def test_no_model_candidate_outranks_all_full_reason():
    # ds4 is full and GN200 is full, but GN200 is the only lane with free
    # slots and it has no determinable model.  The reason must name the real
    # blocker (CAPACITY.md §4), not the full lanes that could never take it.
    routes_ = routes()
    routes_[GN200_URL] = {
        "provider": "gb10-qwen", "base_url": GN200_URL, "default_model": None,
        "models": [], "extra_body": None, "profiles": ["default"], "aux": False}
    route, decision = run(
        samples_={DS4_URL: sample("ds4", DS4_URL, 4, 4),
                  GN100_URL: sample("GN100", GN100_URL, 5, 5),
                  GN200_URL: sample("GN200", GN200_URL, 4, 1)},
        config=delegation(model="other-model"),
        servers_=[
            {"name": "ds4", "base_url": DS4_URL, "kind": "tensorfold", "models": ["ds4"]},
            {"name": "GN100", "base_url": GN100_URL, "kind": "tensorfold", "models": []},
            {"name": "GN200", "base_url": GN200_URL, "kind": "tensorfold", "models": []},
        ],
        provider_routes_=routes_)
    assert route["model"] == "other-model"
    assert decision["action"] == "skip"
    assert decision["reason"] == "no model on GN200"


def test_extra_body_carried_only_from_target_entry():
    routes_ = routes()
    routes_["http://127.0.0.1:18009"]["extra_body"] = {
        "chat_template_kwargs": {"enable_thinking": False}}
    capacity.reset_state()
    route, decision = capacity.decide(
        {"index": 0, "goal": "metrics adapters"}, delegation(),
        samples=samples(sample("ds4", DS4_URL, 4, 4), sample("GN100", GN100_URL, 5, 1)),
        servers=servers(), provider_routes=routes_, settings=settings(), now=NOW)
    assert decision["chosen_lane"] == "GN100"
    assert route["request_overrides"] == {
        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}


def test_decision_lanes_carry_sampled_slots():
    _route, decision = run()
    assert decision["lanes"] == [
        {"name": "ds4", "slots": 4.0, "running": 4.0, "waiting": 0.0, "queue": 0.0,
         "free": 0, "stale": False},
        {"name": "GN100", "slots": 5.0, "running": 1.0, "waiting": 0.0, "queue": 0.0,
         "free": 4, "stale": False},
    ]
