"""Sibling imports must resolve from any cwd — the bug that emptied /servers.

The dashboard mount imports ``dashboard/plugin_api.py`` standalone by path, so a
bare ``import store`` / ``from . import store`` only works when the plugin root
happens to be on ``sys.path`` (pytest).  These tests run the venv python in a
foreign cwd with a temp ``HERMES_HOME`` and prove both entry points work.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"

SCRIPT = textwrap.dedent(r'''
    import asyncio
    import importlib.util
    import json
    import sys
    from pathlib import Path

    plugin_api_path = Path(sys.argv[1])
    plugin_root = plugin_api_path.parent.parent
    port = sys.argv[2]

    spec = importlib.util.spec_from_file_location(
        "flightdeck_dashboard_plugin_api", plugin_api_path)
    plugin_api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin_api)
    payload = asyncio.run(plugin_api.servers())

    # The agent-side entry: the plugin loader imports the package normally, so
    # a spec with the plugin dir on __path__ is the same context.
    agent_spec = importlib.util.spec_from_file_location(
        "flightdeck", plugin_root / "__init__.py",
        submodule_search_locations=[str(plugin_root)])
    agent = importlib.util.module_from_spec(agent_spec)
    sys.modules["flightdeck"] = agent
    agent_spec.loader.exec_module(agent)

    class Ctx:
        def __init__(self):
            self.hooks = []
            self.tools = []
            self.commands = []
            self.providers = []

        def register_hook(self, name, fn):
            self.hooks.append(name)
            return name

        def register_tool(self, **kwargs):
            self.tools.append(kwargs)

        def register_command(self, name, fn, **kwargs):
            self.commands.append(name)

        def register_delegation_provider(self, provider):
            self.providers.append(provider)

    ctx = Ctx()
    agent.register(ctx)

    bare = ("store", "api", "config", "poller", "servers", "hooks", "tools",
            "schemas", "_siblings")
    print(json.dumps({
        "servers": payload,
        "leaked": [name for name in bare if name in sys.modules],
        "one_store": agent.store is sys.modules.get("flightdeck_store"),
        "hooks": len(ctx.hooks),
        "tools": [tool.get("name") for tool in ctx.tools],
        "commands": ctx.commands,
    }))
''')


def _unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_servers_and_register_resolve_siblings_from_a_foreign_cwd(tmp_path):
    root = tmp_path / "hermes"
    root.mkdir()
    port = _unused_port()
    (root / "config.yaml").write_text(
        "providers:\n"
        "  loopback-test:\n"
        f"    api: http://127.0.0.1:{port}/v1\n"
        "    name: ds4\n"
        "plugins:\n"
        "  entries:\n"
        "    flightdeck:\n"
        "      settings:\n"
        "        probe_timeout_seconds: 0.2\n",
        encoding="utf-8",
    )
    cwd = tmp_path / "elsewhere"
    cwd.mkdir()
    env = dict(os.environ, HERMES_HOME=str(root))

    result = subprocess.run(
        [sys.executable, "-I", "-c", SCRIPT, str(PLUGIN_API), str(port)],
        cwd=str(cwd), env=env, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout.strip().splitlines()[-1])

    payload = data["servers"]
    assert data["leaked"] == [], f"imported from cwd: {data['leaked']}"

    # The configured loopback server must reach the handler, not vanish into
    # the swallowed ModuleNotFoundError that returned {"servers": [], ...}.
    listed = payload.get("servers") or []
    unreachable = payload.get("unreachable") or []
    assert listed or unreachable, payload
    urls = [item.get("base_url") for item in listed + unreachable]
    assert any(f"127.0.0.1:{port}" in str(url) for url in urls), payload

    assert data["one_store"] is True, "sibling got two module identities"
    assert data["hooks"] == 7
    assert data["tools"] == ["fleet_status"]
    assert data["commands"] == ["fleet"]
