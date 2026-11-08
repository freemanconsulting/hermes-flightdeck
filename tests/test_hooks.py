"""Hook tests: real call-site payloads in, rows out; fail-open; p95 < 5 ms.

Fixture kwargs are copied from the real call sites named in DESIGN §2:
``pre_api_request`` (agent/turn_api_request.py:80-105), ``post_api_request``
(agent/turn_response_intake.py:76-106), ``api_request_error``
(agent/api_request_hooks.py:176-198), ``pre/post_auxiliary_call``
(agent/auxiliary_hooks.py:132-185), ``subagent_start`` (tools/delegate_tool.py:356-362),
``subagent_stop`` (tools/delegate_tool_results.py:382-393).
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
import types
from pathlib import Path

import pytest

import hooks
import store

ROOT = Path(__file__).resolve().parent.parent
NOW = 1762540800.0


class FakeCronExecution:
    job_id = "job-7"
    job_name = "nightly sweep"
    execution_id = "exec-9"
    source = "builtin"
    scheduled_instant = "2026-11-07T06:00:00Z"
    started_at = "2026-11-07T06:00:01Z"
    profile = "default"


class FakeCtx:
    def __init__(self, settings=None, cron=None):
        self.hooks: list[tuple[str, object]] = []
        self.tools: list[dict] = []
        self.commands: list[tuple[str, object, dict]] = []
        self.providers: list[object] = []
        self._settings = settings or {}
        self._cron = cron

    def get_config(self, key, default=None):
        return self._settings.get(key, default)

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))
        return object()

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)
        return object()

    def register_command(self, name, handler, **kwargs):
        self.commands.append((name, handler, kwargs))
        return object()

    def register_delegation_provider(self, provider):
        self.providers.append(provider)
        return object()

    def current_cron_execution(self):
        return self._cron


@pytest.fixture()
def conn(tmp_path):
    connection = store.open_store(tmp_path / "requests.db")
    yield connection
    connection.close()


@pytest.fixture()
def ctx():
    return FakeCtx()


def pre_payload(**over):
    payload = {
        "task_id": "task-1", "turn_id": "turn-1", "api_request_id": "req-1",
        "session_id": "s1", "user_message": "hi", "conversation_history": [],
        "platform": "cli", "model": "qwen38-27b-q4-q8kv-mtp3", "provider": "main-llm",
        "base_url": "http://127.0.0.1:18008/v1", "api_mode": "chat",
        "api_call_count": 1, "retry_count": 0, "request_messages": [],
        "system_prompt": "sys", "message_count": 4, "tool_count": 2,
        "approx_input_tokens": 1200, "request_char_count": 4800, "max_tokens": 4096,
        "started_at": NOW, "middleware_trace": [], "request": {"method": "POST"},
        "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def post_payload(**over):
    payload = {
        "task_id": "task-1", "turn_id": "turn-1", "api_request_id": "req-1",
        "session_id": "s1", "platform": "cli", "model": "qwen38-27b-q4-q8kv-mtp3",
        "provider": "main-llm", "base_url": "http://127.0.0.1:18008/v1", "api_mode": "chat",
        "api_call_count": 1, "api_duration": 1.5, "started_at": NOW, "ended_at": NOW + 1.5,
        "first_chunk_at": NOW + 0.2, "finish_reason": "stop",
        "message_count": 4, "response_model": "qwen38-27b-q4-q8kv-mtp3",
        "response": {"model": "qwen38-27b-q4-q8kv-mtp3", "finish_reason": "stop"},
        "usage": {"input_tokens": 1000, "output_tokens": 200, "cache_read_tokens": 600,
                  "cache_write_tokens": 0, "reasoning_tokens": 0, "request_count": 1,
                  "prompt_tokens": 1600, "total_tokens": 1800},
        "context_length": 65536, "assistant_message": {"role": "assistant"},
        "assistant_content_chars": 800, "assistant_tool_call_count": 1,
        "moa_references": [], "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def error_payload(**over):
    payload = {
        "task_id": "task-1", "turn_id": "turn-1", "api_request_id": "req-1",
        "session_id": "s1", "platform": "cli", "model": "qwen38-27b-q4-q8kv-mtp3",
        "provider": "main-llm", "base_url": "http://127.0.0.1:18008/v1", "api_mode": "chat",
        "api_call_count": 1, "api_duration": 0.4, "started_at": NOW, "ended_at": NOW + 0.4,
        "status_code": 429, "retry_count": 1, "max_retries": 3, "retryable": True,
        "reason": "rate_limit", "error": {"type": "RateLimitError", "message": "slow down"},
        "request": {"method": "POST"}, "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def aux_pre_payload(**over):
    payload = {
        "task": "compression", "api_request_id": "aux-1", "session_id": "s1",
        "model": "claude-haiku-5", "provider": "anthropic",
        "base_url": "https://api.anthropic.com", "api_mode": "chat",
        "started_at": NOW, "message_count": 12, "approx_input_tokens": 9000,
        "max_tokens": 2000, "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def aux_post_payload(**over):
    payload = {
        "task": "compression", "api_request_id": "aux-1", "session_id": "s1",
        "model": "claude-haiku-5", "provider": "anthropic",
        "base_url": "https://api.anthropic.com", "api_mode": "chat",
        "started_at": NOW, "ended_at": NOW + 0.3, "api_duration": 0.3,
        "finish_reason": "stop", "usage": None, "message_count": 12,
        "assistant_content_chars": 300, "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def subagent_start_payload(**over):
    payload = {
        "parent_session_id": "p1", "parent_turn_id": "t1", "parent_subagent_id": None,
        "child_session_id": "c1", "child_subagent_id": "sa1",
        "child_role": "general", "child_goal": "metrics adapters",
        "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def subagent_stop_payload(**over):
    payload = {
        "parent_session_id": "p1", "parent_turn_id": "t1", "child_session_id": "c1",
        "child_role": "general", "child_summary": "done", "child_status": "completed",
        "tool_call_history": [], "duration_ms": 1200, "telemetry_schema_version": 1,
    }
    payload.update(over)
    return payload


def test_register_all_registers_seven_hooks_in_order(ctx, conn):
    handles = hooks.register_all(ctx, conn, None)
    assert [name for name, _ in ctx.hooks] == list(hooks.HOOK_NAMES)
    assert len(handles) == 7


def test_pre_callback_writes_in_flight_row(ctx, conn):
    hooks.register_all(ctx, conn, None)
    callback = dict(ctx.hooks)["pre_api_request"]
    callback(**pre_payload())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["id"] == f"default|{os.getpid()}|req-1"
    assert row["status"] == "in-flight"
    assert row["model"] == "qwen38-27b-q4-q8kv-mtp3"
    assert row["base_url"] == "http://127.0.0.1:18008/v1"
    assert row["message_count"] == 4


def test_post_callback_closes_row(ctx, conn):
    hooks.register_all(ctx, conn, None)
    callbacks = dict(ctx.hooks)
    callbacks["pre_api_request"](**pre_payload())
    callbacks["post_api_request"](**post_payload())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["status"] == "done"
    assert row["prompt_tokens"] == 1600
    assert row["completion_tokens"] == 200
    assert row["first_chunk_at"] == NOW + 0.2


def test_error_callback(ctx, conn):
    hooks.register_all(ctx, conn, None)
    callbacks = dict(ctx.hooks)
    callbacks["pre_api_request"](**pre_payload())
    callbacks["api_request_error"](**error_payload())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["status"] == "error"
    assert row["status_code"] == 429
    assert row["error_type"] == "RateLimitError"


def test_aux_callbacks(ctx, conn):
    hooks.register_all(ctx, conn, None)
    callbacks = dict(ctx.hooks)
    callbacks["pre_auxiliary_call"](**aux_pre_payload())
    callbacks["post_auxiliary_call"](**aux_post_payload())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["id"].endswith("|aux|aux-1")
    assert row["kind"] == "aux"
    assert row["status"] == "done"
    assert row["aux_task"] == "compression"
    assert row["prompt_tokens"] is None


def test_subagent_callbacks(ctx, conn):
    hooks.register_all(ctx, conn, None)
    callbacks = dict(ctx.hooks)
    callbacks["subagent_start"](**subagent_start_payload())
    link = conn.execute("SELECT * FROM subagent_links WHERE child_session_id = 'c1'").fetchone()
    assert link["status"] == "running"
    assert link["goal"] == "metrics adapters"

    callbacks["pre_api_request"](**pre_payload(session_id="c1", api_request_id="child-1"))
    row = conn.execute("SELECT * FROM requests WHERE api_request_id = 'child-1'").fetchone()
    assert row["parent_session_id"] == "p1"
    assert row["subagent_id"] == "sa1"
    assert row["subagent_role"] == "general"

    callbacks["subagent_stop"](**subagent_stop_payload())
    link = conn.execute("SELECT * FROM subagent_links WHERE child_session_id = 'c1'").fetchone()
    assert link["status"] == "done"
    assert link["stopped_at"] is not None


def test_cron_identity_copied_onto_rows(conn):
    ctx = FakeCtx(cron=FakeCronExecution())
    hooks.register_all(ctx, conn, None)
    dict(ctx.hooks)["pre_api_request"](**pre_payload())
    row = conn.execute("SELECT * FROM requests").fetchone()
    assert row["cron_job_id"] == "job-7"
    assert row["cron_job_name"] == "nightly sweep"
    assert row["cron_execution_id"] == "exec-9"


def test_profile_read_per_callback(monkeypatch, ctx, conn):
    monkeypatch.setattr(hooks, "_profile_name", lambda: "work")
    hooks.register_all(ctx, conn, None)
    dict(ctx.hooks)["pre_api_request"](**pre_payload())
    assert conn.execute("SELECT profile FROM requests").fetchone()[0] == "work"


def test_callbacks_never_raise_on_missing_kwargs(ctx, conn):
    hooks.register_all(ctx, conn, None)
    for name, callback in ctx.hooks:
        callback()  # no kwargs at all
        callback(unknown_field=object(), api_request_id=None, session_id=None)
    # Empty payloads still produce rows rather than exceptions: main and aux ids
    # collapse to two rows, and the subagent callbacks write two link rows.
    assert conn.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM subagent_links").fetchone()[0] == 1


def test_callback_swallows_store_failure(monkeypatch, ctx, conn):
    def boom(*args, **kwargs):
        raise RuntimeError("store exploded")

    monkeypatch.setattr(store, "record_pre", boom)
    hooks.register_all(ctx, conn, None)
    dict(ctx.hooks)["pre_api_request"](**pre_payload())  # must not raise


def test_p95_callback_under_5ms_on_seeded_10k_rows(ctx, conn):
    for index in range(10_000):
        store.record_pre(conn, **pre_payload(
            api_request_id=f"seed-{index}", session_id=f"s{index % 40}",
            started_at=NOW - index * 0.1))
    assert conn.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 10_000

    hooks.register_all(ctx, conn, None)
    callbacks = dict(ctx.hooks)
    durations = []
    for index in range(200):
        request_id = f"live-{index}"
        began = time.perf_counter()
        callbacks["pre_api_request"](**pre_payload(api_request_id=request_id,
                                                   started_at=NOW + index * 0.01))
        callbacks["post_api_request"](**post_payload(api_request_id=request_id,
                                                     started_at=NOW + index * 0.01,
                                                     ended_at=NOW + index * 0.01 + 1.5,
                                                     first_chunk_at=NOW + index * 0.01 + 0.2))
        durations.append((time.perf_counter() - began) * 1000.0)

    durations.sort()
    p95 = durations[int(round(0.95 * (len(durations) - 1)))]
    assert p95 < 5.0, f"p95 callback time {p95:.2f} ms exceeds the 5 ms gate"


def _load_plugin_init(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    package_name = "flightdeck_plugin_under_test"
    package = types.ModuleType(package_name)
    package.__path__ = [str(ROOT)]
    sys.modules[package_name] = package
    spec = importlib.util.spec_from_file_location(
        f"{package_name}.__init__", ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_register_opens_store_and_registers_everything(monkeypatch, tmp_path):
    module = _load_plugin_init(monkeypatch, tmp_path)
    ctx = FakeCtx()
    module.register(ctx)
    assert [name for name, _ in ctx.hooks] == list(hooks.HOOK_NAMES)
    assert [tool["name"] for tool in ctx.tools] == ["fleet_status"]
    assert [command[0] for command in ctx.commands] == ["fleet"]
    assert (tmp_path / "plugin-data" / "flightdeck" / "requests.db").exists()


def test_register_closes_own_stale_rows(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    conn = store.open_store()
    store.record_pre(conn, **pre_payload(started_at=NOW - 600))
    conn.close()
    module = _load_plugin_init(monkeypatch, tmp_path)
    module.register(FakeCtx())
    conn = store.open_store()
    assert conn.execute("SELECT status FROM requests").fetchone()[0] == "abandoned"
    conn.close()
