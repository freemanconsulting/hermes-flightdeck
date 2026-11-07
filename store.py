"""Flightdeck shared request-event store.

One SQLite file per machine, shared by every profile:
``<hermes root>/plugin-data/flightdeck/requests.db``. Per-profile data dirs are
deliberately not used — the point is one fleet view across profiles.

Writes are synchronous and direct (no writer thread): these hooks fire once per
provider attempt, not per token, and a WAL upsert is sub-millisecond. Every write
runs under one module lock and inside ``BEGIN IMMEDIATE`` so concurrent hook
threads sharing the connection cannot interleave transactions.

Stdlib only. No ``state.db`` reads, no Hermes imports at module import time.
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

PLUGIN_ID = "flightdeck"
DB_FILENAME = "requests.db"
SCHEMA_VERSION = 1

# One connection is shared by hook threads (check_same_thread=False); this lock
# serialises the BEGIN IMMEDIATE write windows so two callbacks never interleave.
_LOCK = threading.RLock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  kind          TEXT NOT NULL,
  profile       TEXT NOT NULL,
  pid           INTEGER NOT NULL,
  host          TEXT NOT NULL,
  session_id    TEXT, task_id TEXT, turn_id TEXT, api_request_id TEXT,
  api_call_count INTEGER, retry_count INTEGER,
  aux_task      TEXT,
  platform      TEXT, model TEXT, provider TEXT, base_url TEXT, api_mode TEXT,
  cron_job_id   TEXT, cron_job_name TEXT, cron_execution_id TEXT,
  parent_session_id TEXT,
  subagent_id   TEXT, subagent_role TEXT,
  started_at    REAL NOT NULL, first_chunk_at REAL, ended_at REAL,
  status        TEXT NOT NULL,
  finish_reason TEXT, status_code INTEGER, error_type TEXT, error_message TEXT,
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER,
  reasoning_tokens INTEGER, total_tokens INTEGER,
  message_count INTEGER, approx_input_tokens INTEGER, max_tokens INTEGER,
  assistant_content_chars INTEGER, assistant_tool_call_count INTEGER, context_length INTEGER,
  updated_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_req_started ON requests(started_at);
CREATE INDEX IF NOT EXISTS ix_req_status  ON requests(status, started_at);
CREATE INDEX IF NOT EXISTS ix_req_base    ON requests(base_url, started_at);
CREATE INDEX IF NOT EXISTS ix_req_session ON requests(session_id, started_at);
CREATE INDEX IF NOT EXISTS ix_req_model   ON requests(model, provider, started_at);

CREATE TABLE IF NOT EXISTS subagent_links (
  child_session_id TEXT PRIMARY KEY, parent_session_id TEXT, parent_turn_id TEXT,
  subagent_id TEXT, role TEXT, goal TEXT,
  started_at REAL, stopped_at REAL,
  status TEXT
);

CREATE TABLE IF NOT EXISTS server_samples (
  ts REAL NOT NULL, base_url TEXT NOT NULL, name TEXT, kind TEXT,
  healthy INTEGER, running INTEGER, waiting INTEGER, slots INTEGER,
  decode_tps REAL, prefill_tps REAL, error TEXT,
  PRIMARY KEY (ts, base_url)
);

CREATE TABLE IF NOT EXISTS rollups_minute (
  bucket_ts INTEGER NOT NULL, profile TEXT NOT NULL, model TEXT NOT NULL,
  provider TEXT, base_url TEXT, kind TEXT,
  requests INTEGER, errors INTEGER, errors_429 INTEGER,
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
  ttft_sum_ms REAL, ttft_count INTEGER, decode_ms_sum REAL, decode_ms_count INTEGER,
  completion_sum INTEGER,
  PRIMARY KEY (bucket_ts, profile, model, provider, base_url)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

_COLUMNS = (
    "id", "schema_version", "kind", "profile", "pid", "host",
    "session_id", "task_id", "turn_id", "api_request_id", "api_call_count", "retry_count",
    "aux_task", "platform", "model", "provider", "base_url", "api_mode",
    "cron_job_id", "cron_job_name", "cron_execution_id",
    "parent_session_id", "subagent_id", "subagent_role",
    "started_at", "first_chunk_at", "ended_at", "status",
    "finish_reason", "status_code", "error_type", "error_message",
    "prompt_tokens", "cached_tokens", "completion_tokens", "reasoning_tokens", "total_tokens",
    "message_count", "approx_input_tokens", "max_tokens",
    "assistant_content_chars", "assistant_tool_call_count", "context_length", "updated_at",
)

_INSERT_SQL = (
    f"INSERT INTO requests ({', '.join(_COLUMNS)}) "
    f"VALUES ({', '.join('?' for _ in _COLUMNS)})"
)


# ─── path / connection ────────────────────────────────────────────────────────


def _hermes_root() -> Path:
    """Machine-wide Hermes root; honours a ``HERMES_HOME`` override.

    Imported lazily so the store works in tests and outside the Hermes tree.
    """
    try:
        from hermes_constants import get_default_hermes_root

        return Path(get_default_hermes_root())
    except Exception:
        env = os.environ.get("HERMES_HOME", "").strip()
        return Path(env).expanduser() if env else Path.home() / ".hermes"


def default_db_path() -> Path:
    """``<hermes root>/plugin-data/flightdeck/requests.db`` — one per machine."""
    return _hermes_root() / "plugin-data" / PLUGIN_ID / DB_FILENAME


def open_store(path: Optional[str | Path] = None) -> sqlite3.Connection:
    """Open (and create) the shared store: WAL, busy_timeout=2000, thread-safe."""
    db_path = Path(path) if path is not None else default_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=2.0)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # explicit BEGIN IMMEDIATE / commit control
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=2000")
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
                 (str(SCHEMA_VERSION),))


def _write(conn: sqlite3.Connection, fn):
    """Run *fn* inside one locked ``BEGIN IMMEDIATE`` window."""
    with _LOCK:
        conn.execute("BEGIN IMMEDIATE")
        try:
            result = fn()
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise


def meta_get(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row is not None else default


def meta_set(conn: sqlite3.Connection, key: str, value: Any) -> None:
    _write(conn, lambda: conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    ))


# ─── identity / row ids ──────────────────────────────────────────────────────


def _profile_name() -> str:
    try:
        from hermes_constants import get_hermes_home, profile_name_for_home

        return profile_name_for_home(get_hermes_home()) or "default"
    except Exception:
        return os.environ.get("HERMES_PROFILE", "").strip() or "default"


def _identity(profile: Optional[str] = None, pid: Optional[int] = None,
              host: Optional[str] = None) -> tuple[str, int, str]:
    return (
        profile or _profile_name(),
        int(pid) if pid is not None else os.getpid(),
        host or socket.gethostname(),
    )


def _row_id(profile: str, pid: int, api_request_id: Any, kind: str = "main") -> str:
    """``profile|pid|api_request_id`` (``|aux|`` for auxiliary). Never parsed."""
    request_id = str(api_request_id or "")
    if kind == "aux":
        return f"{profile}|{pid}|aux|{request_id}"
    return f"{profile}|{pid}|{request_id}"


def _num(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _usage_fields(usage: Any) -> dict[str, Optional[int]]:
    """CanonicalUsage dict → store buckets. ``prompt_tokens`` already sums input+cache."""
    empty = {"prompt_tokens": None, "cached_tokens": None, "completion_tokens": None,
             "reasoning_tokens": None, "total_tokens": None}
    if not isinstance(usage, dict):
        return empty
    prompt = _num(usage.get("prompt_tokens"))
    if prompt is None:
        prompt = _num(usage.get("input_tokens"))
    cached = _num(usage.get("cache_read_tokens"))
    if cached is None:
        cached = _num(usage.get("cached_tokens"))
    completion = _num(usage.get("output_tokens"))
    if completion is None:
        completion = _num(usage.get("completion_tokens"))
    total = _num(usage.get("total_tokens"))
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion
    return {
        "prompt_tokens": prompt,
        "cached_tokens": cached,
        "completion_tokens": completion,
        "reasoning_tokens": _num(usage.get("reasoning_tokens")),
        "total_tokens": total,
    }


def _clip(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text[:limit]


def _link_for(conn: sqlite3.Connection, session_id: Any) -> Optional[dict]:
    if not session_id:
        return None
    row = conn.execute(
        "SELECT parent_session_id, subagent_id, role FROM subagent_links "
        "WHERE child_session_id = ?", (str(session_id),),
    ).fetchone()
    return dict(row) if row is not None else None


def _upsert(conn: sqlite3.Connection, values: dict[str, Any], update: str) -> None:
    _write(conn, lambda: conn.execute(
        f"{_INSERT_SQL} ON CONFLICT(id) DO UPDATE SET {update}",
        tuple(values[column] for column in _COLUMNS),
    ))


# ─── request rows ────────────────────────────────────────────────────────────


_PRE_UPDATE = (
    "status = excluded.status, started_at = excluded.started_at, "
    "session_id = excluded.session_id, task_id = excluded.task_id, turn_id = excluded.turn_id, "
    "api_call_count = excluded.api_call_count, retry_count = excluded.retry_count, "
    "platform = excluded.platform, model = excluded.model, provider = excluded.provider, "
    "base_url = excluded.base_url, api_mode = excluded.api_mode, "
    "cron_job_id = excluded.cron_job_id, cron_job_name = excluded.cron_job_name, "
    "cron_execution_id = excluded.cron_execution_id, "
    "parent_session_id = COALESCE(requests.parent_session_id, excluded.parent_session_id), "
    "subagent_id = COALESCE(requests.subagent_id, excluded.subagent_id), "
    "subagent_role = COALESCE(requests.subagent_role, excluded.subagent_role), "
    "message_count = excluded.message_count, "
    "approx_input_tokens = excluded.approx_input_tokens, max_tokens = excluded.max_tokens, "
    "updated_at = excluded.updated_at"
)

_POST_UPDATE = (
    "status = excluded.status, ended_at = excluded.ended_at, "
    "first_chunk_at = COALESCE(excluded.first_chunk_at, requests.first_chunk_at), "
    "finish_reason = COALESCE(excluded.finish_reason, requests.finish_reason), "
    "prompt_tokens = COALESCE(excluded.prompt_tokens, requests.prompt_tokens), "
    "cached_tokens = COALESCE(excluded.cached_tokens, requests.cached_tokens), "
    "completion_tokens = COALESCE(excluded.completion_tokens, requests.completion_tokens), "
    "reasoning_tokens = COALESCE(excluded.reasoning_tokens, requests.reasoning_tokens), "
    "total_tokens = COALESCE(excluded.total_tokens, requests.total_tokens), "
    "message_count = COALESCE(excluded.message_count, requests.message_count), "
    "assistant_content_chars = COALESCE(excluded.assistant_content_chars, requests.assistant_content_chars), "
    "assistant_tool_call_count = COALESCE(excluded.assistant_tool_call_count, requests.assistant_tool_call_count), "
    "context_length = COALESCE(excluded.context_length, requests.context_length), "
    "updated_at = excluded.updated_at"
)

_ERROR_UPDATE = (
    "status = excluded.status, ended_at = excluded.ended_at, "
    "status_code = COALESCE(excluded.status_code, requests.status_code), "
    "error_type = COALESCE(excluded.error_type, requests.error_type), "
    "error_message = COALESCE(excluded.error_message, requests.error_message), "
    "retry_count = COALESCE(excluded.retry_count, requests.retry_count), "
    "updated_at = excluded.updated_at"
)


def _request_values(kind: str, kw: dict[str, Any], *, status: str,
                    started_at: Any = None, ended_at: Any = None,
                    first_chunk_at: Any = None, usage: Any = None,
                    finish_reason: Any = None, status_code: Any = None,
                    error_type: Any = None, error_message: Any = None) -> dict[str, Any]:
    profile, pid, host = _identity(kw.get("profile"), kw.get("pid"), kw.get("host"))
    session_id = kw.get("session_id")
    values = {column: None for column in _COLUMNS}
    values.update(
        id=_row_id(profile, pid, kw.get("api_request_id"), kind),
        schema_version=SCHEMA_VERSION,
        kind=kind,
        profile=profile,
        pid=pid,
        host=host,
        session_id=session_id,
        task_id=kw.get("task_id"),
        turn_id=kw.get("turn_id"),
        api_request_id=kw.get("api_request_id"),
        api_call_count=_num(kw.get("api_call_count")),
        retry_count=_num(kw.get("retry_count")),
        aux_task=kw.get("aux_task") or kw.get("task"),
        platform=kw.get("platform"),
        model=kw.get("model"),
        provider=kw.get("provider"),
        base_url=kw.get("base_url"),
        api_mode=kw.get("api_mode"),
        cron_job_id=kw.get("cron_job_id"),
        cron_job_name=kw.get("cron_job_name"),
        cron_execution_id=kw.get("cron_execution_id"),
        parent_session_id=kw.get("parent_session_id"),
        subagent_id=kw.get("subagent_id"),
        subagent_role=kw.get("subagent_role"),
        started_at=float(started_at if started_at is not None else kw.get("started_at") or time.time()),
        first_chunk_at=first_chunk_at if first_chunk_at is not None else kw.get("first_chunk_at"),
        ended_at=ended_at if ended_at is not None else kw.get("ended_at"),
        status=status,
        finish_reason=finish_reason if finish_reason is not None else kw.get("finish_reason"),
        status_code=_num(status_code if status_code is not None else kw.get("status_code")),
        error_type=error_type,
        error_message=_clip(error_message, 500),
        message_count=_num(kw.get("message_count")),
        approx_input_tokens=_num(kw.get("approx_input_tokens")),
        max_tokens=_num(kw.get("max_tokens")),
        assistant_content_chars=_num(kw.get("assistant_content_chars")),
        assistant_tool_call_count=_num(kw.get("assistant_tool_call_count")),
        context_length=_num(kw.get("context_length")),
        updated_at=time.time(),
    )
    values.update(_usage_fields(usage))
    return values


def record_pre(conn: sqlite3.Connection, **kw: Any) -> None:
    """``pre_api_request`` → in-flight row (upsert on the same request id)."""
    values = _request_values("main", kw, status="in-flight")
    link = _link_for(conn, kw.get("session_id"))
    if link is not None:
        values["parent_session_id"] = values["parent_session_id"] or link["parent_session_id"]
        values["subagent_id"] = values["subagent_id"] or link["subagent_id"]
        values["subagent_role"] = values["subagent_role"] or link["role"]
    _upsert(conn, values, _PRE_UPDATE)


def record_post(conn: sqlite3.Connection, **kw: Any) -> None:
    """``post_api_request`` → done row with usage buckets and TTFT inputs."""
    values = _request_values("main", kw, status="done", usage=kw.get("usage"))
    _upsert(conn, values, _POST_UPDATE)


def record_error(conn: sqlite3.Connection, **kw: Any) -> None:
    """``api_request_error`` → error row; a late error reopens an abandoned row."""
    error = kw.get("error") if isinstance(kw.get("error"), dict) else {}
    values = _request_values(
        "main", kw, status="error",
        status_code=kw.get("status_code"),
        error_type=kw.get("error_type") or error.get("type"),
        error_message=kw.get("error_message") or error.get("message"),
    )
    _upsert(conn, values, _ERROR_UPDATE)


def record_aux_pre(conn: sqlite3.Connection, **kw: Any) -> None:
    """``pre_auxiliary_call`` → in-flight auxiliary row (``profile|pid|aux|id``)."""
    values = _request_values("aux", kw, status="in-flight")
    _upsert(conn, values, _PRE_UPDATE)


def record_aux_post(conn: sqlite3.Connection, **kw: Any) -> None:
    """``post_auxiliary_call`` → done or error auxiliary row; usage may be null."""
    error = kw.get("error")
    status = "error" if (kw.get("error_type") or error) else "done"
    values = _request_values(
        "aux", kw, status=status, usage=kw.get("usage"),
        error_type=kw.get("error_type") or (type(error).__name__ if error else None),
        error_message=kw.get("error") if isinstance(error, str) else None,
    )
    _upsert(conn, values, _POST_UPDATE)


# ─── subagent links ─────────────────────────────────────────────────────────


_SUBAGENT_STATUS = {
    "completed": "done", "done": "done",
    "failed": "failed", "error": "failed",
    "interrupted": "interrupted",
}


def record_subagent_start(conn: sqlite3.Connection, **kw: Any) -> None:
    """``subagent_start`` → link row; exists before the child's first request."""
    started_at = kw.get("started_at")
    started_at = float(started_at) if started_at is not None else time.time()
    _write(conn, lambda: conn.execute(
        "INSERT INTO subagent_links (child_session_id, parent_session_id, parent_turn_id, "
        "subagent_id, role, goal, started_at, stopped_at, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'running') "
        "ON CONFLICT(child_session_id) DO UPDATE SET "
        "parent_session_id = COALESCE(excluded.parent_session_id, subagent_links.parent_session_id), "
        "parent_turn_id = COALESCE(excluded.parent_turn_id, subagent_links.parent_turn_id), "
        "subagent_id = COALESCE(excluded.subagent_id, subagent_links.subagent_id), "
        "role = COALESCE(excluded.role, subagent_links.role), "
        "goal = COALESCE(excluded.goal, subagent_links.goal), "
        "started_at = excluded.started_at, stopped_at = NULL, status = 'running'",
        (
            kw.get("child_session_id") or "",
            kw.get("parent_session_id"),
            kw.get("parent_turn_id"),
            kw.get("child_subagent_id") or kw.get("subagent_id"),
            kw.get("child_role") or kw.get("role"),
            _clip(kw.get("child_goal") or kw.get("goal"), 300),
            started_at,
        ),
    ))


def record_subagent_stop(conn: sqlite3.Connection, **kw: Any) -> None:
    """``subagent_stop`` → stopped_at + terminal status on the link row."""
    raw = str(kw.get("child_status") or kw.get("status") or "done").lower()
    status = _SUBAGENT_STATUS.get(raw, raw if raw in {"done", "failed", "interrupted"} else "done")
    stopped_at = kw.get("stopped_at")
    stopped_at = float(stopped_at) if stopped_at is not None else time.time()
    _write(conn, lambda: conn.execute(
        "INSERT INTO subagent_links (child_session_id, parent_session_id, parent_turn_id, "
        "subagent_id, role, goal, started_at, stopped_at, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(child_session_id) DO UPDATE SET "
        "stopped_at = excluded.stopped_at, status = excluded.status, "
        "parent_session_id = COALESCE(subagent_links.parent_session_id, excluded.parent_session_id), "
        "role = COALESCE(subagent_links.role, excluded.role), "
        "goal = COALESCE(subagent_links.goal, excluded.goal)",
        (
            kw.get("child_session_id") or "",
            kw.get("parent_session_id"),
            kw.get("parent_turn_id"),
            kw.get("child_subagent_id") or kw.get("subagent_id"),
            kw.get("child_role") or kw.get("role"),
            _clip(kw.get("child_goal") or kw.get("goal"), 300),
            stopped_at,
            stopped_at,
            status,
        ),
    ))


# ─── stale closure ──────────────────────────────────────────────────────────


def close_own_stale(conn: sqlite3.Connection, now: Optional[float] = None) -> int:
    """Mark this host+pid's crashed in-flight rows abandoned (started > 5 s ago)."""
    profile, pid, host = _identity()
    moment = float(now if now is not None else time.time())
    cursor = _write(conn, lambda: conn.execute(
        "UPDATE requests SET status = 'abandoned', updated_at = ? "
        "WHERE status = 'in-flight' AND host = ? AND pid = ? AND started_at < ?",
        (moment, host, pid, moment - 5.0),
    ))
    return cursor.rowcount


def close_stale(conn: sqlite3.Connection, stale_after: float = 300.0,
                now: Optional[float] = None) -> int:
    """Mark every in-flight row older than *stale_after* abandoned (any pid)."""
    moment = float(now if now is not None else time.time())
    cursor = _write(conn, lambda: conn.execute(
        "UPDATE requests SET status = 'abandoned', updated_at = ? "
        "WHERE status = 'in-flight' AND started_at < ?",
        (moment, moment - float(stale_after)),
    ))
    return cursor.rowcount


# ─── sweep: rollups + retention ─────────────────────────────────────────────


_ROLLUP_SQL = """
INSERT INTO rollups_minute (
  bucket_ts, profile, model, provider, base_url, kind, requests, errors, errors_429,
  prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens,
  ttft_sum_ms, ttft_count, decode_ms_sum, decode_ms_count, completion_sum
)
SELECT
  CAST(started_at / 60 AS INTEGER) * 60 AS bucket_ts,
  profile, COALESCE(model, '') AS model, provider, base_url,
  CASE WHEN COUNT(DISTINCT kind) = 1 THEN MIN(kind) ELSE 'mixed' END AS kind,
  COUNT(*) AS requests,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN status = 'error' AND status_code = 429 THEN 1 ELSE 0 END) AS errors_429,
  SUM(COALESCE(prompt_tokens, 0)), SUM(COALESCE(cached_tokens, 0)),
  SUM(COALESCE(completion_tokens, 0)), SUM(COALESCE(reasoning_tokens, 0)),
  SUM(CASE WHEN first_chunk_at IS NOT NULL AND started_at IS NOT NULL
           THEN (first_chunk_at - started_at) * 1000.0 ELSE 0 END),
  SUM(CASE WHEN first_chunk_at IS NOT NULL AND started_at IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN first_chunk_at IS NOT NULL AND ended_at IS NOT NULL
           THEN (ended_at - first_chunk_at) * 1000.0 ELSE 0 END),
  SUM(CASE WHEN first_chunk_at IS NOT NULL AND ended_at IS NOT NULL THEN 1 ELSE 0 END),
  SUM(COALESCE(completion_tokens, 0))
FROM requests
WHERE status IN ('done', 'error', 'abandoned') AND started_at < ?
GROUP BY bucket_ts, profile, model, provider, base_url
"""


def sweep(conn: sqlite3.Connection, retention_hours: float = 24, rollup_days: float = 7,
          now: Optional[float] = None, *, stale_after: float = 300.0) -> dict:
    """Roll finished minutes up, prune raw rows/samples/rollups, close stale rows.

    Idempotent: re-rolling a bucket overwrites it with the same numbers, and a
    late post is corrected by the next sweep while the raw row still exists.
    The 60 s cadence guard lives in the backend (``meta.last_sweep``).
    """
    moment = float(now if now is not None else time.time())
    closed = close_stale(conn, stale_after, now=moment)
    cursor = _write(conn, lambda: conn.execute(_ROLLUP_SQL, (moment - 120.0,)))
    rolled = cursor.rowcount
    cursor = _write(conn, lambda: conn.execute(
        "DELETE FROM requests WHERE started_at < ?",
        (moment - float(retention_hours) * 3600.0,),
    ))
    deleted_rows = cursor.rowcount
    cursor = _write(conn, lambda: conn.execute(
        "DELETE FROM server_samples WHERE ts < ?",
        (moment - float(retention_hours) * 3600.0,),
    ))
    deleted_samples = cursor.rowcount
    cursor = _write(conn, lambda: conn.execute(
        "DELETE FROM rollups_minute WHERE bucket_ts < ?",
        (moment - float(rollup_days) * 86400.0,),
    ))
    deleted_rollups = cursor.rowcount
    meta_set(conn, "last_sweep", moment)
    return {
        "rolled_up": rolled,
        "closed_stale": closed,
        "deleted_rows": deleted_rows,
        "deleted_samples": deleted_samples,
        "deleted_rollups": deleted_rollups,
        "last_sweep": moment,
    }


# ─── server samples ─────────────────────────────────────────────────────────


_SAMPLE_COLUMNS = ("ts", "base_url", "name", "kind", "healthy", "running", "waiting",
                   "slots", "decode_tps", "prefill_tps", "error")


def record_server_sample(conn: sqlite3.Connection, **kw: Any) -> None:
    """One server_samples row per server per poll (PK ts+base_url)."""
    values = {column: kw.get(column) for column in _SAMPLE_COLUMNS}
    values["ts"] = float(values["ts"] if values["ts"] is not None else time.time())
    values["base_url"] = str(values["base_url"] or "")
    if values["healthy"] is not None:
        values["healthy"] = 1 if values["healthy"] else 0
    for key in ("running", "waiting", "slots"):
        values[key] = _num(values[key])
    for key in ("decode_tps", "prefill_tps"):
        if values[key] is not None:
            values[key] = float(values[key])
    values["error"] = _clip(values["error"], 500)
    _write(conn, lambda: conn.execute(
        f"INSERT OR REPLACE INTO server_samples ({', '.join(_SAMPLE_COLUMNS)}) "
        f"VALUES ({', '.join('?' for _ in _SAMPLE_COLUMNS)})",
        tuple(values[column] for column in _SAMPLE_COLUMNS),
    ))


def record_server_samples(conn: sqlite3.Connection, samples: Iterable[Any]) -> int:
    """Batch form of :func:`record_server_sample` (dicts or Snapshot-like objects)."""
    count = 0
    for sample in samples or ():
        if isinstance(sample, dict):
            record_server_sample(conn, **sample)
        else:
            record_server_sample(conn, **{
                column: getattr(sample, column, None) for column in _SAMPLE_COLUMNS
            })
        count += 1
    return count


# ─── queries ────────────────────────────────────────────────────────────────


def _rows(cursor: sqlite3.Cursor) -> list[dict]:
    return [dict(row) for row in cursor.fetchall()]


def window_rows(conn: sqlite3.Connection, since: float, limit: int = 5000) -> list[dict]:
    """Newest rows started since *since*; bounded, no transaction held open."""
    return _rows(conn.execute(
        "SELECT * FROM requests WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?",
        (float(since), int(limit)),
    ))


def in_flight_rows(conn: sqlite3.Connection) -> list[dict]:
    return _rows(conn.execute(
        "SELECT * FROM requests WHERE status = 'in-flight' ORDER BY started_at",
    ))


def agent_nodes(conn: sqlite3.Connection, since: float) -> list[dict]:
    """Flat per-agent rows (profile, session, parent, cron) for api.py's tree."""
    rows = _rows(conn.execute(
        "SELECT profile, session_id, parent_session_id, cron_job_id, cron_job_name, "
        "COUNT(*) AS requests, "
        "SUM(CASE WHEN status = 'in-flight' THEN 1 ELSE 0 END) AS in_flight, "
        "SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, "
        "MIN(started_at) AS oldest_started_at, "
        "GROUP_CONCAT(DISTINCT model) AS models_raw "
        "FROM requests WHERE started_at >= ? "
        "GROUP BY profile, session_id, parent_session_id, cron_job_id "
        "ORDER BY in_flight DESC, requests DESC",
        (float(since),),
    ))
    links = {row["child_session_id"]: dict(row) for row in conn.execute(
        "SELECT * FROM subagent_links").fetchall()}
    for row in rows:
        link = links.get(row.get("session_id") or "")
        row["models"] = [m for m in (row.pop("models_raw") or "").split(",") if m]
        row["subagent_id"] = link["subagent_id"] if link else None
        row["subagent_role"] = link["role"] if link else None
        row["goal"] = link["goal"] if link else None
        row["kind"] = ("cron" if row.get("cron_job_id")
                       else "subagent" if (row.get("parent_session_id") or link)
                       else "session")
    return rows


def _percentile(sorted_values: list[float], fraction: float) -> Optional[float]:
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    index = int(round(fraction * (len(sorted_values) - 1)))
    return sorted_values[min(max(index, 0), len(sorted_values) - 1)]


def model_nodes(conn: sqlite3.Connection, since: float) -> list[dict]:
    """Flat per-model rows with token sums and TTFT p50/p95 over the window."""
    rows = _rows(conn.execute(
        "SELECT model, provider, base_url, "
        "COUNT(*) AS requests, "
        "SUM(CASE WHEN status = 'in-flight' THEN 1 ELSE 0 END) AS in_flight, "
        "SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, "
        "SUM(CASE WHEN status = 'error' AND status_code = 429 THEN 1 ELSE 0 END) AS errors_429, "
        "SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens, "
        "SUM(COALESCE(cached_tokens, 0)) AS cached_tokens, "
        "SUM(COALESCE(completion_tokens, 0)) AS completion_tokens, "
        "SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens, "
        "MIN(started_at) AS oldest_started_at "
        "FROM requests WHERE started_at >= ? "
        "GROUP BY model, provider, base_url "
        "ORDER BY in_flight DESC, requests DESC",
        (float(since),),
    ))
    ttft_rows = _rows(conn.execute(
        "SELECT model, provider, base_url, (first_chunk_at - started_at) * 1000.0 AS ttft_ms "
        "FROM requests WHERE started_at >= ? AND first_chunk_at IS NOT NULL "
        "ORDER BY started_at DESC LIMIT 5000",
        (float(since),),
    ))
    groups: dict[tuple, list[float]] = {}
    for row in ttft_rows:
        if row["ttft_ms"] is None:
            continue
        groups.setdefault((row["model"], row["provider"], row["base_url"]), []).append(
            float(row["ttft_ms"]))
    for row in rows:
        values = sorted(groups.get((row["model"], row["provider"], row["base_url"]), []))
        row["ttft_ms_p50"] = _percentile(values, 0.50)
        row["ttft_ms_p95"] = _percentile(values, 0.95)
        row["ttft_count"] = len(values)
        row["key"] = f"{row['model']}|{row['provider']}|{row['base_url']}"
    return rows


def server_samples_since(conn: sqlite3.Connection, since: float) -> list[dict]:
    return _rows(conn.execute(
        "SELECT * FROM server_samples WHERE ts >= ? ORDER BY ts",
        (float(since),),
    ))


def health(conn: sqlite3.Connection) -> dict:
    """Footer/health numbers; server counts are added by api.py."""
    moment = time.time()
    db_path = ""
    try:
        for row in conn.execute("PRAGMA database_list").fetchall():
            if row["name"] == "main":
                db_path = row["file"] or ""
    except Exception:
        db_path = ""
    counts = conn.execute(
        "SELECT COUNT(*) AS rows, "
        "SUM(CASE WHEN status = 'in-flight' THEN 1 ELSE 0 END) AS in_flight, "
        "SUM(CASE WHEN status = 'abandoned' AND started_at >= ? THEN 1 ELSE 0 END) AS abandoned_5m, "
        "SUM(CASE WHEN status = 'error' AND started_at >= ? THEN 1 ELSE 0 END) AS errors "
        "FROM requests",
        (moment - 300.0, moment - 300.0),
    ).fetchone()
    return {
        "ok": True,
        "db_path": db_path,
        "rows": int(counts["rows"] or 0),
        "in_flight": int(counts["in_flight"] or 0),
        "abandoned_5m": int(counts["abandoned_5m"] or 0),
        "errors": int(counts["errors"] or 0),
        "last_sweep": _float_or_none(meta_get(conn, "last_sweep")),
        "schema_version": _num(meta_get(conn, "schema_version")) or SCHEMA_VERSION,
    }


def _float_or_none(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


__all__ = [
    "PLUGIN_ID", "DB_FILENAME", "SCHEMA_VERSION", "default_db_path", "open_store",
    "meta_get", "meta_set",
    "record_pre", "record_post", "record_error", "record_aux_pre", "record_aux_post",
    "record_subagent_start", "record_subagent_stop",
    "record_server_sample", "record_server_samples",
    "close_own_stale", "close_stale", "sweep",
    "window_rows", "in_flight_rows", "agent_nodes", "model_nodes",
    "server_samples_since", "health",
]
