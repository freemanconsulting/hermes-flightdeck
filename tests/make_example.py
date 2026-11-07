"""Generate docs/snapshot.example.json from a seeded temp DB (DESIGN §9.2).

The UI worker builds against this file from hour one, so it is real output of
``api.build_snapshot()`` over real rows — never hand-written JSON.  The seed is
deterministic (fixed epoch times) so regenerating gives the same numbers.

Run from the project root:
    /Users/openclaw/.hermes/hermes-agent/venv/bin/python tests/make_example.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import api  # noqa: E402

#: Fixed "now" so the example is reproducible: 2026-11-07T16:00:00Z.
NOW = 1794076800.0
OUTPUT = ROOT / "docs" / "snapshot.example.json"

# Minimal §5.1 schema: the in-test seeding helper Brief B uses until store.py
# lands (then the same rows go through store.open_store() unchanged).
SCHEMA = """
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

DS4 = "http://127.0.0.1:18010"
GN100 = "http://127.0.0.1:18009"
ANTHROPIC = "https://api.anthropic.com"
DS4_MODEL = "qwen38-27b-q4-q8kv-mtp3"
GN100_MODEL = "qwen38-flash-next-tf-fp4"
CLOUD_MODEL = "claude-opus-5-5"

FIELDS = (
    "id", "kind", "profile", "pid", "host", "session_id", "api_request_id", "platform",
    "model", "provider", "base_url", "cron_job_id", "cron_job_name", "parent_session_id",
    "subagent_id", "subagent_role", "started_at", "first_chunk_at", "ended_at", "status",
    "finish_reason", "status_code", "prompt_tokens", "cached_tokens", "completion_tokens",
    "reasoning_tokens", "total_tokens", "message_count", "approx_input_tokens", "max_tokens",
    "updated_at",
)


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def insert_request(conn: sqlite3.Connection, **values) -> None:
    row = {field: values.get(field) for field in FIELDS}
    for field, default in (("kind", "main"), ("profile", "default"), ("pid", 4242),
                           ("host", "studio"), ("platform", "desktop")):
        if row[field] is None:
            row[field] = default
    row["updated_at"] = values.get("updated_at", values["started_at"])
    conn.execute(
        f"INSERT OR REPLACE INTO requests ({', '.join(FIELDS)}) "
        f"VALUES ({', '.join('?' for _ in FIELDS)})",
        tuple(row[field] for field in FIELDS),
    )


def seed(conn: sqlite3.Connection, now: float = NOW) -> None:
    """Deterministic rows: two local servers, a subagent, a cron run and a cloud lane."""
    conn.row_factory = sqlite3.Row
    create_schema(conn)

    # ds4: three in-flight rows (two in s1, one in subagent s2) plus history.
    insert_request(
        conn, id="default|4242|r1", session_id="s1", api_request_id="r1",
        model=DS4_MODEL, provider="main-llm", base_url=DS4 + "/v1",
        started_at=now - 12, status="in-flight", message_count=14,
        approx_input_tokens=9000, max_tokens=4096,
    )
    insert_request(
        conn, id="default|4242|r2", session_id="s1", api_request_id="r2",
        model=DS4_MODEL, provider="main-llm", base_url=DS4 + "/v1",
        started_at=now - 4, status="in-flight", message_count=16,
        approx_input_tokens=9500, max_tokens=4096,
    )
    insert_request(
        conn, id="default|4242|r3", session_id="s2", api_request_id="r3",
        model=DS4_MODEL, provider="main-llm", base_url=DS4 + "/v1",
        parent_session_id="s1", subagent_id="a1", subagent_role="general",
        started_at=now - 9, status="in-flight", message_count=6,
    )
    insert_request(
        conn, id="default|4242|d1", session_id="s1", api_request_id="d1",
        model=DS4_MODEL, provider="main-llm", base_url=DS4 + "/v1",
        started_at=now - 200, first_chunk_at=now - 199.8, ended_at=now - 198,
        status="done", finish_reason="stop", prompt_tokens=12000, cached_tokens=9000,
        completion_tokens=800, reasoning_tokens=0, total_tokens=12800,
    )
    insert_request(
        conn, id="default|4242|d2", session_id="s1", api_request_id="d2",
        model=DS4_MODEL, provider="main-llm", base_url=DS4 + "/v1",
        started_at=now - 100, first_chunk_at=now - 99.9, ended_at=now - 99,
        status="done", finish_reason="stop", prompt_tokens=6000, cached_tokens=5000,
        completion_tokens=400, reasoning_tokens=0, total_tokens=6400,
    )
    insert_request(
        conn, id="default|4242|e1", session_id="s1", api_request_id="e1",
        model=DS4_MODEL, provider="main-llm", base_url=DS4 + "/v1",
        started_at=now - 150, ended_at=now - 149.5, status="error", status_code=429,
        error_type="rate_limit", error_message="429 Too Many Requests",
    )

    # GN100: one in-flight row and one cron run holding a slot.
    insert_request(
        conn, id="default|4242|g1", session_id="s1", api_request_id="g1",
        model=GN100_MODEL, provider="gn100", base_url=GN100 + "/v1",
        started_at=now - 30, status="in-flight", message_count=22,
    )
    insert_request(
        conn, id="default|4242|k1", session_id="cron-nightly-1", api_request_id="k1",
        model=GN100_MODEL, provider="gn100", base_url=GN100 + "/v1",
        cron_job_id="job-nightly", cron_job_name="nightly-briefing",
        started_at=now - 20, status="in-flight", message_count=4,
    )
    insert_request(
        conn, id="default|4242|g2", session_id="s1", api_request_id="g2",
        model=GN100_MODEL, provider="gn100", base_url=GN100 + "/v1",
        started_at=now - 240, first_chunk_at=now - 239.5, ended_at=now - 236,
        status="done", finish_reason="stop", prompt_tokens=30000, cached_tokens=24000,
        completion_tokens=1500, reasoning_tokens=0, total_tokens=31500,
    )

    # Cloud lane: hook-derived only, no server gauge.
    insert_request(
        conn, id="default|4242|c1", session_id="s1", api_request_id="c1",
        model=CLOUD_MODEL, provider="anthropic", base_url=ANTHROPIC + "/v1",
        started_at=now - 6, status="in-flight", message_count=30,
    )
    insert_request(
        conn, id="default|4242|c2", session_id="s1", api_request_id="c2",
        model=CLOUD_MODEL, provider="anthropic", base_url=ANTHROPIC + "/v1",
        started_at=now - 120, first_chunk_at=now - 119.1, ended_at=now - 114,
        status="done", finish_reason="stop", prompt_tokens=18000, cached_tokens=12000,
        completion_tokens=900, reasoning_tokens=0, total_tokens=18900,
    )

    conn.execute(
        "INSERT OR REPLACE INTO subagent_links "
        "(child_session_id, parent_session_id, parent_turn_id, subagent_id, role, goal, "
        " started_at, stopped_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("s2", "s1", "t1", "a1", "general", "metrics adapters", now - 40, None, "running"),
    )

    for ts, decode, prefill in ((now - 10, 40.2, 2900.0), (now - 5, 42.1, 3100.0),
                                (now, 42.1, 3100.0)):
        conn.execute(
            "INSERT OR REPLACE INTO server_samples "
            "(ts, base_url, name, kind, healthy, running, waiting, slots, decode_tps, prefill_tps, error) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ts, DS4, "ds4", "tensorfold", 1, 3, 0, 4, decode, prefill, None),
        )
    for ts, decode, prefill in ((now - 10, 17.0, 850.0), (now - 5, 18.4, 900.0),
                                (now, 18.4, 900.0)):
        conn.execute(
            "INSERT OR REPLACE INTO server_samples "
            "(ts, base_url, name, kind, healthy, running, waiting, slots, decode_tps, prefill_tps, error) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ts, GN100, "GN100", "tensorfold", 1, 5, 2, 5, decode, prefill, None),
        )
    conn.commit()


def server_samples(now: float = NOW) -> list[dict]:
    """The polled samples the example snapshot is built from (declared servers)."""
    return [
        {"name": "ds4", "title": "Studio DeepSeek-V4.1-Flash (M5 Ultra, TensorFold fork)",
         "base_url": DS4, "kind": "tensorfold", "healthy": True,
         "models": [DS4_MODEL], "running": 3, "waiting": 0, "slots": 4,
         "decode_tps": 42.1, "prefill_tps": 3100.0,
         "sampled_at": api._now_iso(now), "error": None},
        {"name": "GN100", "title": "GN100 Qwen3.8-Flash-Next FP4 TensorFold (trial)",
         "base_url": GN100, "kind": "tensorfold", "healthy": True,
         "models": [GN100_MODEL], "running": 5, "waiting": 2, "slots": 5,
         "decode_tps": 18.4, "prefill_tps": 900.0,
         "sampled_at": api._now_iso(now), "error": None},
        {"name": "anthropic", "base_url": ANTHROPIC, "kind": "cloud", "healthy": None,
         "models": [], "running": None, "waiting": None, "slots": None,
         "decode_tps": None, "prefill_tps": None,
         "sampled_at": api._now_iso(now), "error": None},
    ]


def build_example(conn: sqlite3.Connection, now: float = NOW) -> dict:
    return api.build_snapshot(300, servers=server_samples(now), conn=conn, now=now)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="flightdeck-example-") as tmp:
        conn = sqlite3.connect(str(Path(tmp) / "requests.db"))
        try:
            seed(conn)
            snapshot = build_example(conn)
        finally:
            conn.close()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT} ({len(json.dumps(snapshot))} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
