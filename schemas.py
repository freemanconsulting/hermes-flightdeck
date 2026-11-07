"""Flightdeck tool and command schemas (DESIGN §11)."""

from __future__ import annotations

FLEET_STATUS_SCHEMA: dict = {
    "name": "fleet_status",
    "description": (
        "Live fleet capacity: which model servers have free slots, what is queued, "
        "and which agents are holding them. Use before picking a lane for heavy work."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "window": {"type": "string", "enum": ["1m", "5m"], "default": "5m"},
            "include_cloud": {"type": "boolean", "default": True},
        },
        "additionalProperties": False,
    },
}

__all__ = ["FLEET_STATUS_SCHEMA"]
