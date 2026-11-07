"""Store tests: schema, upserts, closure, sweep, retention, query shapes.

Owner boundary: store functions in → query results out. No hook callbacks here.
"""

from __future__ import annotations

import os
import socket
import time

import pytest

import store

NOW = 1762540800.0


@pytest.fixture()
def conn(tmp_path):
    connection = store.open_store(tmp_path / "requests.db")
    yield connection
    connection.close()


def pre_kwargs(**over):
    kwargs = {
        "task_id": "task-1", "turn_id": "turn-1", "api_request_id": "req-1",
        "session_id": "s1", "user_message": "hi", "conversation_history": [],
        "platform": "cli", "model": "qwen38-27b-q4-q8kv-mtp3", "provider": "main-llm",
        "base_url": "http://127.0.0.1:18008/v1", "api_mode": "chat",
        "api_call_count": 1, "retry_count": 0, "request_messages": [],
        "system_prompt": "sys", "message_count": 4, "tool_count": 2,
        "approx_input_tokens": 1200, "request_char_count": 4800, "max_tokens": 4096,
        "started_at": NOW, "middleware_trace": [], "request": {"method": "POST"},
        "profile": "default", "pid": 4242, "host": "testhost",
    }
    kwargs.update(over)
    return kwargs


def post_kwargs(**over):
    kwargs = {
        "task_id": "task-1", "turn_id": "turn-1", "api_request_id": "req-1",
        "session_id": "s1", "platform": "cli", "model": "qwen38-27b-q4-q8kv-mtp3",
        "provider": "main-llm", "base_url": "http://127.0.0.1:18008/v1", "api_mode": "chat",
        "api_call_count": 1, "api_duration": 1.5, "started_at": NOW, "ended_at": NOW + 1.5,
        "first_chunk_at": NOW + 0.2, "finish_reason": "stop",
        "message_count": 4, "response_model": "qwen38-27b-q4-q8kv-mtp3",
        "response": {"model": "qwen38-27b-q4-q8kv-mtp3"},
        "usage": {"input_tokens": 1000, "output_tokens": 200, "cache_read_tokens": 600,
                  "cache_write_tokens": 0, "reasoning_tokens": 0, "request_count": 1,
                  "prompt_tokens": 1600, "total_tokens": 1800},
        "context_length": 65536, "assistant_message": {"role": "assistant"},
        "assistant_content_chars": 800, "assistant_tool_call_count": 1,
        "moa_references": [], "profile": "default", "pid": 4242, "host": "testhost",
    }
    kwargs.update(over)
    return kwargs


def error_kwargs(**over):
    kwargs = {
        "task_id": "task-1", "turn_id": "turn-1", "api_request_id": "req-1",
        "session_id": "s1", "platform": "cli", "model": "qwen38-27b-q4-q8kv-mtp3",
        "provider": "main-llm", "base_url": "http://127.0.0.1:18008/v1", "api_mode": "chat",
        "api_call_count": 1, "api_duration": 0.4, "started_at": NOW, "ended_at": NOW + 0.4,
        "status_code": 429, "retry_count": 1, "max_retries": 3, "retryable": True,
        "reason": "rate_limit", "error": {"type": "RateLimitError", "message": "slow down"},
        "request": {"method": "POST"}, "profile": "default", "pid": 4242, "host": "testhost",
    }
    kwargs.update(over)
    return kwargs


def test_schema_creates(conn):
    tables = {row["name"] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
    assert {"requests", "subagent_links", "server_samples", "rollups_minute", "meta"} <= tables
    assert store.meta_get(conn, "schema_version") == "1"
    indexes = {row["name"] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index'").fetchall()}
    assert {"ix_req_started", "ix_req_status", "ix_req_base", "ix_req_session", "ix_req_model"} <= indexes


def test_row_id_rules(conn):
    store.record_pre(conn, **pre_kwargs())
    store.record_aux_pre(conn, **pre_kwargs(api_request_id="aux-1", aux_task="compression"))
    ids = {row["id"] for row in conn.execute("SELECT id FROM requests").fetchall()}
    assert ids == {"default|4242|req-1", "default|4242|aux|aux-1"}


def test_pre_post_upsert_closes_row(conn):
    store.record_pre(conn, **pre_kwargs())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["status"] == "in-flight"
    assert row["kind"] == "main"
    assert row["message_count"] == 4
    assert row["approx_input_tokens"] == 1200
    assert row["max_tokens"] == 4096
    assert row["ended_at"] is None

    store.record_post(conn, **post_kwargs())
    rows = conn.execute("SELECT * FROM requests").fetchall()
    assert len(rows) == 1  # upsert, not a second row
    row = rows[0]
    assert row["status"] == "done"
    assert row["ended_at"] == NOW + 1.5
    assert row["first_chunk_at"] == NOW + 0.2
    assert row["finish_reason"] == "stop"
    assert row["prompt_tokens"] == 1600
    assert row["cached_tokens"] == 600
    assert row["completion_tokens"] == 200
    assert row["total_tokens"] == 1800
    assert row["assistant_content_chars"] == 800
    assert row["assistant_tool_call_count"] == 1
    assert row["context_length"] == 65536


def test_error_path(conn):
    store.record_pre(conn, **pre_kwargs())
    store.record_error(conn, **error_kwargs(error_message="x" * 900))
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["status"] == "error"
    assert row["status_code"] == 429
    assert row["error_type"] == "RateLimitError"
    assert len(row["error_message"]) == 500
    assert row["retry_count"] == 1


def test_error_without_pre_inserts_row(conn):
    store.record_error(conn, **error_kwargs())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["status"] == "error"
    assert row["model"] == "qwen38-27b-q4-q8kv-mtp3"


def test_close_stale_marks_abandoned_and_late_post_reopens(conn):
    store.record_pre(conn, **pre_kwargs(started_at=NOW - 400))
    assert store.close_stale(conn, stale_after=300.0, now=NOW) == 1
    assert conn.execute("SELECT status FROM requests").fetchone()[0] == "abandoned"

    store.record_post(conn, **post_kwargs())
    assert conn.execute("SELECT status FROM requests").fetchone()[0] == "done"


def test_late_error_reopens_abandoned(conn):
    store.record_pre(conn, **pre_kwargs(started_at=NOW - 400))
    store.close_stale(conn, stale_after=300.0, now=NOW)
    store.record_error(conn, **error_kwargs())
    assert conn.execute("SELECT status FROM requests").fetchone()[0] == "error"


def test_close_own_stale_only_own_pid_and_host(conn):
    store.record_pre(conn, **pre_kwargs(api_request_id="own", pid=os.getpid(),
                                        host=socket.gethostname(), started_at=NOW - 10))
    store.record_pre(conn, **pre_kwargs(api_request_id="other", pid=1, host="elsewhere",
                                        started_at=NOW - 10))
    assert store.close_own_stale(conn, now=NOW) == 1
    rows = {row["api_request_id"]: row["status"] for row in conn.execute(
        "SELECT api_request_id, status FROM requests").fetchall()}
    assert rows == {"own": "abandoned", "other": "in-flight"}


def test_sweep_rolls_up_minutes_and_prunes(conn):
    store.record_pre(conn, **pre_kwargs(started_at=NOW - 3700))
    store.record_post(conn, **post_kwargs(started_at=NOW - 3700,
                                          first_chunk_at=NOW - 3699.8,
                                          ended_at=NOW - 3698.5))
    store.record_pre(conn, **pre_kwargs(api_request_id="fresh", started_at=NOW - 30))
    store.record_server_sample(conn, ts=NOW - 3700, base_url="http://127.0.0.1:18010",
                               name="ds4", kind="tensorfold", healthy=True, running=1,
                               waiting=0, slots=4, decode_tps=42.1, prefill_tps=3100.0)
    conn.execute("INSERT INTO rollups_minute (bucket_ts, profile, model, requests) "
                 "VALUES (?, 'default', 'old', 1)", (int(NOW - 8 * 86400),))

    result = store.sweep(conn, retention_hours=1, rollup_days=7, now=NOW)

    assert result["deleted_rows"] == 1
    assert result["deleted_samples"] == 1
    assert result["deleted_rollups"] == 1
    assert result["last_sweep"] == NOW
    rollups = conn.execute("SELECT * FROM rollups_minute WHERE model != 'old'").fetchall()
    assert len(rollups) == 1
    rollup = rollups[0]
    assert rollup["bucket_ts"] == int((NOW - 3700) // 60) * 60
    assert rollup["requests"] == 1
    assert rollup["prompt_tokens"] == 1600
    assert rollup["completion_sum"] == 200
    assert rollup["ttft_count"] == 1
    assert rollup["ttft_sum_ms"] == pytest.approx(200.0, abs=1.0)
    assert rollup["decode_ms_count"] == 1
    assert rollup["decode_ms_sum"] == pytest.approx(1300.0, abs=2.0)
    remaining = conn.execute("SELECT api_request_id FROM requests").fetchall()
    assert [row["api_request_id"] for row in remaining] == ["fresh"]


def test_retention_boundary(conn):
    store.record_pre(conn, **pre_kwargs(api_request_id="keep", started_at=NOW - 23 * 3600))
    store.record_pre(conn, **pre_kwargs(api_request_id="drop", started_at=NOW - 25 * 3600))
    store.sweep(conn, retention_hours=24, now=NOW)
    ids = [row["api_request_id"] for row in conn.execute("SELECT api_request_id FROM requests")]
    assert ids == ["keep"]


def test_queries_and_health(conn):
    store.record_pre(conn, **pre_kwargs(api_request_id="a", started_at=NOW - 10))
    store.record_post(conn, **post_kwargs(api_request_id="a", started_at=NOW - 10,
                                          first_chunk_at=NOW - 9.8, ended_at=NOW - 8))
    store.record_pre(conn, **pre_kwargs(api_request_id="b", session_id="s2",
                                        started_at=NOW - 5))
    store.record_error(conn, **error_kwargs(api_request_id="c", session_id="s2",
                                            started_at=NOW - 4))
    store.record_server_sample(conn, ts=NOW - 5, base_url="http://127.0.0.1:18010",
                               name="ds4", kind="tensorfold", healthy=True, running=2,
                               waiting=1, slots=4, decode_tps=42.1, prefill_tps=3100.0)

    window = store.window_rows(conn, NOW - 60)
    assert len(window) == 3
    assert window[0]["api_request_id"] == "c"  # newest first

    in_flight = store.in_flight_rows(conn)
    assert [row["api_request_id"] for row in in_flight] == ["b"]

    agents = store.agent_nodes(conn, NOW - 60)
    by_session = {row["session_id"]: row for row in agents}
    assert by_session["s1"]["requests"] == 1
    assert by_session["s1"]["in_flight"] == 0
    assert by_session["s2"]["requests"] == 2
    assert by_session["s2"]["in_flight"] == 1
    assert by_session["s2"]["errors"] == 1
    assert by_session["s2"]["models"] == ["qwen38-27b-q4-q8kv-mtp3"]

    models = store.model_nodes(conn, NOW - 60)
    assert len(models) == 1
    assert models[0]["requests"] == 3
    assert models[0]["errors"] == 1
    assert models[0]["errors_429"] == 1
    assert models[0]["prompt_tokens"] == 1600
    assert models[0]["ttft_ms_p50"] == pytest.approx(200.0, abs=1.0)
    assert models[0]["ttft_ms_p95"] == pytest.approx(200.0, abs=1.0)

    samples = store.server_samples_since(conn, NOW - 60)
    assert len(samples) == 1 and samples[0]["name"] == "ds4"

    health = store.health(conn)
    assert health["ok"] is True
    assert health["rows"] == 3
    assert health["in_flight"] == 1
    assert health["errors"] == 0
    assert health["db_path"].endswith("requests.db")


def test_health_counts_recent_errors(conn):
    store.record_error(conn, **error_kwargs(started_at=time.time() - 10))
    assert store.health(conn)["errors"] == 1


def test_subagent_link_and_attribution(conn):
    store.record_subagent_start(conn, parent_session_id="p1", parent_turn_id="t1",
                                child_session_id="c1", child_subagent_id="sa1",
                                child_role="general", child_goal="metrics adapters")
    store.record_pre(conn, **pre_kwargs(session_id="c1", api_request_id="child-req"))
    row = conn.execute("SELECT * FROM requests WHERE api_request_id = 'child-req'").fetchone()
    assert row["parent_session_id"] == "p1"
    assert row["subagent_id"] == "sa1"
    assert row["subagent_role"] == "general"

    agents = store.agent_nodes(conn, NOW - 60)
    assert agents[0]["kind"] == "subagent"
    assert agents[0]["goal"] == "metrics adapters"

    store.record_subagent_stop(conn, child_session_id="c1", child_status="completed",
                               duration_ms=1200)
    link = conn.execute("SELECT * FROM subagent_links WHERE child_session_id = 'c1'").fetchone()
    assert link["status"] == "done"
    assert link["stopped_at"] is not None


def test_subagent_stop_status_mapping(conn):
    for child, raw, expected in (("c-done", "completed", "done"), ("c-fail", "failed", "failed"),
                                 ("c-int", "interrupted", "interrupted")):
        store.record_subagent_start(conn, parent_session_id="p", child_session_id=child)
        store.record_subagent_stop(conn, child_session_id=child, child_status=raw)
        assert conn.execute("SELECT status FROM subagent_links WHERE child_session_id = ?",
                            (child,)).fetchone()[0] == expected


def test_subagent_stop_without_start_inserts(conn):
    store.record_subagent_stop(conn, parent_session_id="p9", child_session_id="c9",
                               child_status="failed", duration_ms=10)
    link = conn.execute("SELECT * FROM subagent_links WHERE child_session_id = 'c9'").fetchone()
    assert link["status"] == "failed" and link["parent_session_id"] == "p9"


def test_aux_rows(conn):
    store.record_aux_pre(conn, **pre_kwargs(api_request_id="aux-1", aux_task="compression",
                                            session_id="s1", started_at=NOW))
    store.record_aux_post(conn, api_request_id="aux-1", aux_task="compression",
                          session_id="s1", started_at=NOW, ended_at=NOW + 0.3,
                          finish_reason="stop", usage=None, profile="default", pid=4242,
                          host="testhost")
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["kind"] == "aux"
    assert row["aux_task"] == "compression"
    assert row["status"] == "done"
    assert row["prompt_tokens"] is None  # streaming aux call reports no usage

    store.record_aux_post(conn, api_request_id="aux-2", aux_task="titling", session_id="s1",
                          started_at=NOW, ended_at=NOW + 0.1, error="boom",
                          profile="default", pid=4242, host="testhost")
    row = conn.execute("SELECT * FROM requests WHERE api_request_id = 'aux-2'").fetchone()
    assert row["status"] == "error"
    assert row["error_message"] == "boom"


def test_usage_mapping_prefers_canonical_prompt_total(conn):
    store.record_pre(conn, **pre_kwargs())
    store.record_post(conn, **post_kwargs(usage={
        "input_tokens": 100, "cache_read_tokens": 50, "cache_write_tokens": 10,
        "output_tokens": 20, "prompt_tokens": 160, "total_tokens": 180,
    }))
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert (row["prompt_tokens"], row["cached_tokens"], row["completion_tokens"],
            row["total_tokens"]) == (160, 50, 20, 180)


def test_meta_roundtrip(conn):
    store.meta_set(conn, "last_sweep", 123.5)
    assert store.meta_get(conn, "last_sweep") == "123.5"
    assert store.meta_get(conn, "missing", "fallback") == "fallback"
