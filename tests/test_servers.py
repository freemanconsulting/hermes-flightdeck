"""Fixture-driven tests for servers.py (the plugin-root metrics adapter).

Every kind test goes through detect_kind() and normalize() on real captured or
documented responses; no test reaches into helper internals.  Fixture
provenance is recorded in docs/METRICS.md: tensorfold-* are captured live from
this machine, the rest are built from official docs and source.
"""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from servers import (
    Snapshot,
    detect_kind,
    normalize,
    parse_prometheus,
    probe,
    token_rate,
)

FIXTURES = Path(__file__).parent / "fixtures" / "servers"


def load(kind_dir: str, filename: str) -> Any:
    """Load one fixture file; .json is parsed, anything else stays text."""
    path = FIXTURES / kind_dir / filename
    text = path.read_text()
    return json.loads(text) if path.suffix == ".json" else text


def responses_for(kind_dir: str, mapping: dict[str, str]):
    """Build a responses dict from {path: fixture filename}."""
    return {path: load(kind_dir, filename) for path, filename in mapping.items()}


# ---------------------------------------------------------------------------
# TensorFold: captured live from 127.0.0.1:18010 (ds4) and :18009 (GN100)
# ---------------------------------------------------------------------------


def test_tensorfold_ds4_live():
    responses = responses_for(
        "tensorfold-ds4", {"/health": "health.json", "/metrics": "metrics.txt"}
    )
    assert detect_kind(responses) == "tensorfold"

    snap = normalize("tensorfold", responses)
    assert isinstance(snap, Snapshot)
    assert snap.kind == "tensorfold"
    assert snap.healthy is True
    assert snap.models == ["ds4"]
    assert snap.running == 1
    assert snap.waiting == 0
    assert snap.slots == 4
    assert snap.decode_tps == 51.0
    assert snap.prefill_tps == 479.7
    assert snap.prompt_tokens_total == 199577631
    assert snap.cached_tokens_total == 184607107
    assert snap.generation_tokens_total == 2131780
    assert snap.sampled_at.endswith("Z")
    assert snap.error is None


def test_tensorfold_gn100_live():
    responses = responses_for(
        "tensorfold-gn100", {"/health": "health.json", "/metrics": "metrics.txt"}
    )
    assert detect_kind(responses) == "tensorfold"

    snap = normalize("tensorfold", responses)
    assert snap.healthy is True
    assert snap.models == ["qwen38-flash-next-tf-fp4"]
    assert snap.running == 0
    assert snap.waiting == 0
    assert snap.slots == 5
    assert snap.decode_tps == 0.0
    assert snap.prefill_tps == 0.0
    assert snap.prompt_tokens_total == 76374727
    assert snap.cached_tokens_total == 71627393
    assert snap.generation_tokens_total == 513870


def test_tensorfold_metrics_only_still_reports_load():
    responses = {"metrics": load("tensorfold-ds4", "metrics.txt")}
    assert detect_kind(responses) == "tensorfold"

    snap = normalize("tensorfold", responses)
    assert snap.running == 1  # tensorfold:requests_running fallback
    assert snap.waiting == 0
    assert snap.slots is None  # max_batch_size only lives in /health
    assert snap.decode_tps is None
    assert snap.models == []
    assert snap.healthy is True


# ---------------------------------------------------------------------------
# vLLM: docs-built (v0.33.0 names, v0.8.5 legacy names)
# ---------------------------------------------------------------------------


def test_vllm_current_names():
    responses = {
        "/metrics": load("vllm", "metrics.txt"),
        "/v1/models": load("openai", "v1_models.json"),
        "/health": "",
    }
    assert detect_kind(responses) == "vllm"

    snap = normalize("vllm", responses)
    assert snap.healthy is True
    assert snap.models == ["Qwen/Qwen3-8B", "Qwen/Qwen3-8B-embedding"]
    assert snap.running == 3
    assert snap.waiting == 2
    assert snap.prompt_tokens_total == 128734
    assert snap.cached_tokens_total == 98012
    assert snap.generation_tokens_total == 45211
    # vLLM reports no max_num_seqs gauge and no tok/s gauge.
    assert snap.slots is None
    assert snap.decode_tps is None
    assert snap.prefill_tps is None


def test_vllm_legacy_total_suffix():
    responses = {"metrics": load("vllm-legacy", "metrics.txt")}
    assert detect_kind(responses) == "vllm"

    snap = normalize("vllm", responses)
    assert snap.running == 1
    assert snap.waiting == 0
    assert snap.prompt_tokens_total == 2658
    assert snap.generation_tokens_total == 12877
    assert snap.cached_tokens_total is None  # no cached counter in that build
    assert snap.models == ["unsloth/Llama-3.2-1B-Instruct"]  # from model_name label


# ---------------------------------------------------------------------------
# SGLang: docs-built (production_metrics example + server_info source shape)
# ---------------------------------------------------------------------------


def test_sglang():
    responses = {
        "/metrics": load("sglang", "metrics.txt"),
        "/get_server_info": load("sglang", "server_info.json"),
        "/health": "",
    }
    assert detect_kind(responses) == "sglang"

    snap = normalize("sglang", responses)
    assert snap.healthy is True
    assert snap.models == ["meta-llama/Llama-3.1-8B-Instruct"]
    assert snap.running == 162
    assert snap.waiting == 2826
    assert snap.slots == 128
    assert snap.decode_tps == pytest.approx(86.50814177726902)
    assert snap.prefill_tps is None  # no prefill throughput gauge
    assert snap.prompt_tokens_total == 8128902
    assert snap.generation_tokens_total == 7557572
    assert snap.cached_tokens_total is None  # only a cache_hit_rate gauge


def test_sglang_slots_from_server_args():
    info = load("sglang", "server_info.json")
    info.pop("max_running_requests")
    info["server_args"]["max_running_requests"] = 64
    responses = {"/metrics": load("sglang", "metrics.txt"), "/get_server_info": info}

    snap = normalize("sglang", responses)
    assert snap.slots == 64


# ---------------------------------------------------------------------------
# llama.cpp server: docs-built (README metric table + /slots + /health)
# ---------------------------------------------------------------------------


def test_llamacpp():
    responses = responses_for(
        "llamacpp",
        {
            "/metrics": "metrics.txt",
            "/slots": "slots.json",
            "/health": "health.json",
            "/v1/models": "v1_models.json",
        },
    )
    assert detect_kind(responses) == "llamacpp"

    snap = normalize("llamacpp", responses)
    assert snap.healthy is True
    assert snap.models == ["ggml-org/gemma-3-4b-it-GGUF:Q4_K_M"]
    assert snap.running == 2
    assert snap.waiting == 1
    assert snap.slots == 4  # len(/slots) == n_parallel
    assert snap.decode_tps == pytest.approx(52.54)
    assert snap.prefill_tps == pytest.approx(489.29)
    assert snap.prompt_tokens_total == 2658
    assert snap.generation_tokens_total == 12877
    assert snap.cached_tokens_total is None


def test_llamacpp_without_metrics_uses_slots():
    responses = responses_for("llamacpp", {"/slots": "slots.json", "/health": "health.json"})
    assert detect_kind(responses) == "llamacpp"

    snap = normalize("llamacpp", responses)
    assert snap.running == 2  # counted from is_processing
    assert snap.waiting is None
    assert snap.slots == 4
    assert snap.decode_tps is None
    assert snap.healthy is True


def test_llamacpp_unhealthy_health_body():
    responses = {
        "/health": {"error": {"code": 503, "message": "Loading model", "type": "unavailable_error"}},
        "/slots": load("llamacpp", "slots.json"),
    }
    assert detect_kind(responses) == "llamacpp"

    snap = normalize("llamacpp", responses)
    assert snap.healthy is False
    assert snap.running == 2


# ---------------------------------------------------------------------------
# Ollama: docs-built (/api/ps + /api/version)
# ---------------------------------------------------------------------------


def test_ollama():
    responses = responses_for(
        "ollama", {"/api/ps": "api_ps.json", "/api/version": "api_version.json"}
    )
    assert detect_kind(responses) == "ollama"

    snap = normalize("ollama", responses)
    assert snap.healthy is True
    assert snap.models == ["mistral:latest"]
    assert snap.running is None
    assert snap.waiting is None
    assert snap.slots is None
    assert snap.decode_tps is None
    assert snap.prompt_tokens_total is None


def test_ollama_no_models_loaded():
    responses = {"/api/ps": {"models": []}, "/api/version": {"version": "0.5.1"}}
    assert detect_kind(responses) == "ollama"

    snap = normalize("ollama", responses)
    assert snap.models == []
    assert snap.healthy is True


# ---------------------------------------------------------------------------
# Generic OpenAI-compatible: /v1/models only
# ---------------------------------------------------------------------------


def test_openai_compatible_models_only():
    responses = {"/v1/models": load("openai", "v1_models.json")}
    assert detect_kind(responses) == "openai"

    snap = normalize("openai", responses)
    assert snap.healthy is True
    assert snap.models == ["Qwen/Qwen3-8B", "Qwen/Qwen3-8B-embedding"]
    assert snap.running is None
    assert snap.waiting is None
    assert snap.slots is None
    assert snap.decode_tps is None
    assert snap.prompt_tokens_total is None


# ---------------------------------------------------------------------------
# Detection edge cases
# ---------------------------------------------------------------------------


def test_detect_kind_empty_and_garbage():
    assert detect_kind({}) == "unknown"
    assert detect_kind({"": "not a server"}) == "unknown"
    assert detect_kind({"/health": {"error": {"code": 404}}}) == "unknown"


def test_normalize_unknown_reports_nothing():
    snap = normalize("unknown", {})
    assert snap.kind == "unknown"
    assert snap.healthy is None
    assert snap.models == []
    assert snap.running is None
    assert snap.slots is None


def test_normalize_does_not_raise_on_bad_bodies():
    snap = normalize("vllm", {"/metrics": "{{{ not prometheus", "/health": "not json"})
    assert snap.kind == "vllm"
    assert snap.running is None
    assert snap.healthy is True  # non-error body at /health


# ---------------------------------------------------------------------------
# parse_prometheus (public API, exercised on fixture text)
# ---------------------------------------------------------------------------


def test_parse_prometheus_labels_and_values():
    parsed = parse_prometheus(load("tensorfold-ds4", "metrics.txt"))
    assert parsed["tensorfold:requests_running"] == [({}, 1.0)]
    assert parsed["tensorfold:prompt_tokens_total"] == [({}, 199577631.0)]
    assert parsed["tensorfold:kv_cache_usage_ratio"] == [({"pool": "0"}, pytest.approx(0.052803))]
    assert parsed["tensorfold:kv_cache_usage_perc"] == [({"stream": "0"}, pytest.approx(0.052803))]
    assert len(parsed["tensorfold:request_latency_seconds_bucket"]) == 14


def test_parse_prometheus_escapes_and_special_values():
    text = (
        '# HELP x:y A "quoted" help line\n'
        "# TYPE x:y gauge\n"
        'x:y{a="b\\"c",d="line\\nbreak"} NaN\n'
        "x:y 1.5e+06 1710000000000\n"
        "x:y{empty=\"\"} +Inf\n"
    )
    parsed = parse_prometheus(text)
    samples = parsed["x:y"]
    assert samples[0][0] == {"a": 'b"c', "d": "line\nbreak"}
    assert samples[0][1] != samples[0][1]  # NaN
    assert samples[1] == ({}, 1500000.0)  # trailing timestamp ignored
    assert samples[2] == ({"empty": ""}, float("inf"))


# ---------------------------------------------------------------------------
# token_rate: how counter-only kinds get tok/s
# ---------------------------------------------------------------------------


def test_token_rate():
    assert token_rate(1000, 1600, 10.0) == pytest.approx(60.0)
    assert token_rate(None, 1600, 10.0) is None
    assert token_rate(1000, 1600, 0) is None
    assert token_rate(1600, 1000, 10.0) is None  # counter reset, not a rate


# ---------------------------------------------------------------------------
# probe(): real HTTP against a fixture-backed server, and a dead port
# ---------------------------------------------------------------------------


class _FixtureHandler(BaseHTTPRequestHandler):
    routes = {
        "/health": ("health.json", "application/json"),
        "/metrics": ("metrics.txt", "text/plain"),
    }

    def do_GET(self):  # noqa: N802 - stdlib handler naming
        entry = self.routes.get(self.path)
        if entry is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        filename, content_type = entry
        body = (FIXTURES / "tensorfold-ds4" / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # keep pytest output clean
        pass


@pytest.fixture()
def fixture_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_probe_matches_normalize(fixture_server):
    snap = probe(fixture_server, timeout=2.0)
    expected = normalize(
        "tensorfold",
        responses_for("tensorfold-ds4", {"/health": "health.json", "/metrics": "metrics.txt"}),
    )

    assert snap.kind == "tensorfold"
    assert snap.base_url == fixture_server
    assert snap.error is None
    assert snap.running == expected.running == 1
    assert snap.slots == expected.slots == 4
    assert snap.decode_tps == expected.decode_tps == 51.0
    assert snap.prompt_tokens_total == expected.prompt_tokens_total
    assert snap.models == ["ds4"]
    assert snap.name == "ds4"


def test_probe_dead_port_returns_error_snapshot():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    snap = probe(f"http://127.0.0.1:{port}", timeout=0.5)

    assert isinstance(snap, Snapshot)
    assert snap.kind == "unknown"
    assert snap.error is not None
    assert snap.healthy is None
    assert snap.running is None
