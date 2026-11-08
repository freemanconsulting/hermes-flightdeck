"""Cloud-provider quota (DESIGN §7.4, §9.1).

The backend no longer imports Hermes internals: live plan usage is read by the
desktop plugin from the public gateway method ``model.options``.  The backend
only carries ``quota`` for demo mode, injected explicitly through
``quota_cache``.  These tests pin that injection path, the null default, the
``quota`` dict shape, and the demo snapshot's 5-hour window.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

import demo  # noqa: E402
import make_example  # noqa: E402
from test_api import conn, model, snapshot  # noqa: E402,F401

NOW = make_example.NOW
FETCHED_AT = 1762603200.0  # 2026-11-08T12:00:00Z, unix seconds
RESET_AT = 1762610400.0    # 2026-11-08T14:00:00Z, unix seconds


def _quota(provider="anthropic", *, windows=None, unavailable_reason=None):
    """A §9.1 quota dict in the shape the desktop plugin reads live."""
    return {
        "provider": provider,
        "plan": "pro",
        "title": "Claude Pro",
        "source": "claude-cli",
        "fetched_at": FETCHED_AT,
        "unavailable_reason": unavailable_reason,
        "windows": windows if windows is not None else [
            {"label": "5-hour", "used_percent": 42.0, "remaining_percent": 58.0,
             "reset_at": RESET_AT, "detail": None},
        ],
    }


def _cloud_model(payload):
    return model(payload, f"anthropic|{make_example.CLOUD_MODEL}")


# --- injected quota_cache ---------------------------------------------------

def test_injected_quota_cache_fills_cloud_entry_shape(conn):
    payload = snapshot(conn, quota_cache={"anthropic": _quota()})
    quota = _cloud_model(payload)["quota"]

    assert list(quota) == ["provider", "plan", "title", "source", "fetched_at",
                           "unavailable_reason", "windows"]
    assert (quota["provider"], quota["plan"], quota["title"], quota["source"]) == (
        "anthropic", "pro", "Claude Pro", "claude-cli")
    assert quota["fetched_at"] == FETCHED_AT
    assert quota["unavailable_reason"] is None

    window = quota["windows"][0]
    assert list(window) == ["label", "used_percent", "remaining_percent", "reset_at", "detail"]
    assert window["label"] == "5-hour"
    assert window["used_percent"] == 42.0
    assert window["remaining_percent"] == 58.0
    assert window["reset_at"] == RESET_AT
    assert isinstance(window["reset_at"], float)
    assert window["detail"] is None


def test_injected_unavailable_quota_carries_reason(conn):
    payload = snapshot(conn, quota_cache={
        "anthropic": _quota(windows=[], unavailable_reason="not signed in")})
    quota = _cloud_model(payload)["quota"]

    assert quota["unavailable_reason"] == "not signed in"
    assert quota["windows"] == []


def test_quota_cache_none_leaves_cloud_quota_null(conn):
    payload = snapshot(conn, quota_cache=None)
    assert _cloud_model(payload)["quota"] is None


def test_default_snapshot_has_null_cloud_quota(conn):
    payload = snapshot(conn)  # quota_cache defaults to None
    assert _cloud_model(payload)["quota"] is None


def test_local_models_always_have_null_quota(conn):
    payload = snapshot(conn, quota_cache={"anthropic": _quota()})
    local = model(payload, f"ds4|{make_example.DS4_MODEL}")

    assert local["lane"] == "local"
    assert local["quota"] is None
    # The injection is live (the cloud lane got a quota); local lanes never take it.
    assert _cloud_model(payload)["quota"] is not None


# --- demo -------------------------------------------------------------------

def test_demo_cloud_quota_has_the_live_shape():
    payload = demo.build_demo_snapshot(300, now=NOW, anchor=NOW)
    cloud = next(entry for entry in payload["models"] if entry["lane"] == "cloud")

    quota = cloud["quota"]
    assert list(quota) == ["provider", "plan", "title", "source", "fetched_at",
                           "unavailable_reason", "windows"]
    assert quota["provider"] == "anthropic"
    assert quota["unavailable_reason"] is None
    labels = [window["label"] for window in quota["windows"]]
    assert "5-hour" in labels
    five_hour = next(window for window in quota["windows"] if window["label"] == "5-hour")
    assert five_hour["used_percent"] == 42.0
    assert five_hour["remaining_percent"] == 58.0
    assert isinstance(five_hour["reset_at"], float)


def test_demo_local_entries_have_null_quota():
    payload = demo.build_demo_snapshot(300, now=NOW, anchor=NOW)
    local = [entry for entry in payload["models"] if entry["lane"] == "local"]

    assert local
    assert all(entry["quota"] is None for entry in local)
