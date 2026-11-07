"""Flightdeck plugin entry: open the shared store, register observers and surfaces.

``register()`` is deliberately only: open store, close this process's stale rows,
seven observer hooks, one agent tool, one slash command (DESIGN §16.7). No
network, no threads, no gateway — the capability probe runs this in isolation.
"""

from __future__ import annotations

import logging

try:  # plugin loader: package context with the plugin dir on __path__
    from ._siblings import load as _load_sibling
except ImportError:  # imported as a top-level module (tests, tooling)
    from _siblings import load as _load_sibling

hooks = _load_sibling("hooks", __package__)
schemas = _load_sibling("schemas", __package__)
store = _load_sibling("store", __package__)
tools = _load_sibling("tools", __package__)

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Called once by the plugin loader."""
    conn = store.open_store()
    store.close_own_stale(conn)
    hooks.register_all(ctx, conn, None)
    ctx.register_tool(
        name="fleet_status", toolset="flightdeck", schema=schemas.FLEET_STATUS_SCHEMA,
        handler=tools.fleet_status, emoji="🛫",
        description="Live fleet capacity: free slots, queue, and who is holding each server.",
    )
    ctx.register_command(
        "fleet", tools.fleet_command,
        description="One-line fleet status: slots in use, queue, and the recommended lane.",
        args_hint="[1m|5m]",
    )
