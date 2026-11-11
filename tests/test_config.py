"""Machine-wide discovery: every profile's config.yaml, not just the active one."""

import json
import logging
import sys
from pathlib import Path

import config
import store


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _root(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


class _Ctx:
    """Plugin context stub: no per-profile settings, defaults only."""

    def get_config(self, key, default=None):
        return default


def test_discover_unions_every_profile(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", """
providers:
  root-loopback:
    api: http://127.0.0.1:18010/v1
    name: ds4
""")
    _write(root / "profiles" / "alpha" / "config.yaml", """
providers:
  duplicate:
    api: http://127.0.0.1:18010/v1
    name: ds4 duplicate
  public:
    api: https://api.anthropic.com/v1
    name: anthropic
""")
    _write(root / "profiles" / "beta" / "config.yaml", """
providers:
  new-private:
    api: http://192.168.1.50:18009/v1
    name: GN100
""")

    servers = config.discover(config=None)

    assert [server["name"] for server in servers] == ["root-loopback", "new-private"]
    assert [server["title"] for server in servers] == ["ds4", "GN100"]
    assert [server["key"] for server in servers] == ["root-loopback", "new-private"]
    assert [server["base_url"] for server in servers] == [
        "http://127.0.0.1:18010", "http://192.168.1.50:18009",
    ]
    assert servers[0]["profiles"] == ["default", "alpha"]
    assert servers[1]["profiles"] == ["beta"]


def test_discovery_name_is_the_provider_key_and_title_is_the_prose(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", """
providers:
  studio-ds4:
    api: http://127.0.0.1:18010/v1
    name: Studio DeepSeek-V4.1-Flash (M5 Ultra, TensorFold fork 72a552ed, thinking on, greedy)
""")

    servers = config.discover(config=None)

    assert servers[0]["name"] == "studio-ds4"  # short, stable, unique
    assert servers[0]["key"] == "studio-ds4"
    assert servers[0]["title"].startswith("Studio DeepSeek")  # tooltip only
    assert servers[0]["profiles"] == ["default"]


def test_declared_servers_union_across_profiles_wins_over_discovery(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", """
providers:
  discovered:
    api: http://127.0.0.1:18010/v1
    name: discovered ds4
plugins:
  entries:
    flightdeck:
      settings:
        servers:
          - name: ds4
            base_url: http://127.0.0.1:18010/v1
""")
    _write(root / "profiles" / "alpha" / "config.yaml", """
plugins:
  entries:
    flightdeck:
      settings:
        servers:
          - name: GN100
            base_url: http://127.0.0.1:18009
""")
    _write(root / "profiles" / "beta" / "config.yaml", """
plugins:
  entries:
    flightdeck:
      settings:
        servers:
          - name: ds4 again
            base_url: http://127.0.0.1:18010
""")

    settings = config.load(ctx=_Ctx())

    assert settings["servers_source"] == "declared"
    assert [server["name"] for server in settings["servers"]] == ["ds4", "GN100"]
    assert settings["servers"][0]["profiles"] == ["default", "beta"]
    assert settings["servers"][1]["profiles"] == ["alpha"]


def test_empty_discovery_cache_expires_after_ten_seconds(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    conn = store.open_store(root / "requests.db")
    try:
        assert config.discover(conn, now=100.0) == []
        _write(root / "config.yaml", """
providers:
  late:
    api: http://127.0.0.1:18010/v1
    name: ds4
""")
        assert config.discover(conn, now=105.0) == []  # still inside the 10 s empty TTL
        assert config.discover(conn, now=111.0)[0]["name"] == "late"
    finally:
        conn.close()


def test_discover_collects_auxiliary_private_base_urls(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", """
providers:
  main:
    api: http://127.0.0.1:18010/v1
    name: ds4
auxiliary:
  vision:
    model: Qwen3.5-9B.Q6_K.gguf
    base_url: http://127.0.0.1:18436/v1
    fallback_chain:
      - base_url: http://192.168.1.60:18011/v1
      - base_url: https://api.openai.com/v1
""")

    servers = config.discover(config=None)

    assert [server["base_url"] for server in servers] == [
        "http://127.0.0.1:18010", "http://127.0.0.1:18436", "http://192.168.1.60:18011",
    ]
    # Named after the model it serves, never after the auxiliary role key.
    assert servers[1]["name"] == "qwen3.5-9b"
    assert servers[1]["aux"] is True
    assert servers[1]["title"] == "helper model for: vision · 127.0.0.1:18436"
    assert servers[2]["name"] == "qwen3.5-9b"
    assert servers[2]["title"] == "helper model for: vision · 192.168.1.60:18011"


def test_hidden_servers_filter_cards_by_name_or_base_url(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", """
providers:
  ds4:
    api: http://127.0.0.1:18010/v1
  GN100:
    api: http://127.0.0.1:18009/v1
""")

    class _HiddenCtx:
        def get_config(self, key, default=None):
            if key == "hidden_servers":
                return ["GN100"]
            return default

    settings = config.load(ctx=_HiddenCtx())

    assert [server["name"] for server in settings["servers"]] == ["ds4"]
    assert settings["hidden_servers"] == ["GN100"]


def test_auxiliary_label_loses_to_a_provider_key(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", """
providers:
  studio-ds4:
    api: http://127.0.0.1:18010/v1
    name: Studio DeepSeek
auxiliary:
  title_generation:
    model: Qwen3.5-9B.Q6_K.gguf
    base_url: http://127.0.0.1:18010/v1
""")

    servers = config.discover(config=None)

    assert servers[0]["name"] == "studio-ds4"
    assert "aux" not in servers[0]


# The real machine's auxiliary block: provider `custom`, a GGUF model name and
# `/v1` base_urls, with the same endpoint shared by many role keys.
_REAL_AUX_ROLES = (
    "skills_hub", "approval", "mcp", "title_generation", "tts_audio_tags",
    "triage_specifier", "profile_describer", "monitor", "web_extract",
    "flush_memories", "session_search",
)


def _real_auxiliary_yaml() -> str:
    lanes = "\n".join(
        f"  {role}:\n    provider: custom\n    model: Qwen3.5-9B.Q6_K.gguf\n"
        f"    base_url: http://127.0.0.1:18436/v1\n    api_key: ''\n    timeout: 30"
        for role in _REAL_AUX_ROLES
    )
    return "auxiliary:\n" + lanes + "\n"


def test_auxiliary_custom_provider_lanes_name_the_model_once(tmp_path, monkeypatch):
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", _real_auxiliary_yaml())

    servers = config.discover(config=None)

    helper = [server for server in servers if server["base_url"] == "http://127.0.0.1:18436"]
    assert len(helper) == 1  # one endpoint, one card, however many roles use it
    assert helper[0]["name"] == "qwen3.5-9b"  # the model, never the role key
    assert helper[0]["aux"] is True
    assert helper[0]["roles"] == list(_REAL_AUX_ROLES)
    assert helper[0]["title"] == (
        "helper model for: " + ", ".join(_REAL_AUX_ROLES) + " · 127.0.0.1:18436"
    )


def test_stale_discovery_cache_shape_is_ignored(tmp_path, monkeypatch):
    """A cache row from an older build (role-key name, no aux/roles) is not served."""
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", _real_auxiliary_yaml())
    conn = store.open_store(root / "requests.db")
    try:
        stale = {"at": 100.0, "servers": [{
            "name": "skills_hub", "title": None, "key": "skills_hub",
            "base_url": "http://127.0.0.1:18436", "kind": "auto",
            "profiles": ["default"],
        }]}
        store.meta_set(conn, config.DISCOVERY_CACHE_KEY, json.dumps(stale))

        servers = config.discover(conn, now=100.5)  # inside the 60 s TTL

        assert servers[0]["name"] == "qwen3.5-9b"
        assert servers[0]["aux"] is True
        payload = json.loads(store.meta_get(conn, config.DISCOVERY_CACHE_KEY))
        assert payload["version"] == config.DISCOVERY_CACHE_VERSION
        assert payload["servers"][0]["name"] == "qwen3.5-9b"
    finally:
        conn.close()


# --- YAML parsing uses ruamel.yaml, not PyYAML --------------------------------
# Hermes ships ruamel.yaml and NOT PyYAML, so the discovery path must work in an
# environment where `import yaml` fails.  Blocking `sys.modules["yaml"]` makes
# any PyYAML import raise ImportError exactly as it would on a real Hermes venv.

_PY_YAML = """
providers:
  ds4:
    api: http://127.0.0.1:18010/v1
    name: Studio DeepSeek
plugins:
  entries:
    flightdeck:
      settings:
        servers:
          - name: ds4
            base_url: http://127.0.0.1:18010/v1
"""


def _block_pyyaml(monkeypatch):
    """Make `import yaml` raise ImportError even if PyYAML is installed."""
    monkeypatch.setitem(sys.modules, "yaml", None)


def test_read_yaml_config_parses_without_pyyaml(tmp_path, monkeypatch):
    _block_pyyaml(monkeypatch)
    path = tmp_path / "config.yaml"
    path.write_text(_PY_YAML, encoding="utf-8")

    data = config._read_yaml_config(path)

    assert data["providers"]["ds4"]["api"] == "http://127.0.0.1:18010/v1"
    servers = data["plugins"]["entries"]["flightdeck"]["settings"]["servers"]
    assert servers[0]["base_url"] == "http://127.0.0.1:18010/v1"
    # typ="safe" gives plain containers — callers do json.dumps/duck-typing on them
    assert type(data) is dict
    assert type(servers) is list
    assert type(servers[0]) is dict


def test_discovery_and_declared_servers_work_without_pyyaml(tmp_path, monkeypatch):
    """The snapshot's server union yields the declared server with PyYAML blocked."""
    _block_pyyaml(monkeypatch)
    root = _root(tmp_path, monkeypatch)
    _write(root / "config.yaml", _PY_YAML)

    assert config._read_yaml_config(root / "config.yaml") != {}
    # _declared_servers() is the union config.load()/the snapshot builds cards from
    assert [server["name"] for server in config._declared_servers()] == ["ds4"]
    assert config._declared_servers()[0]["base_url"] == "http://127.0.0.1:18010"

    discovered = config.discover(config=None)
    assert [server["name"] for server in discovered] == ["ds4"]


def test_malformed_yaml_returns_empty_and_warns_once(tmp_path, monkeypatch, caplog):
    """A broken config.yaml is {} — but never silently: one WARNING names the file."""
    monkeypatch.setattr(config, "_WARNED_UNREADABLE", set())
    path = tmp_path / "config.yaml"
    path.write_text("providers:\n  ds4: [unclosed\n", encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger=config.logger.name):
        assert config._read_yaml_config(path) == {}
        assert config._read_yaml_config(path) == {}  # second read stays quiet

    warnings = [rec for rec in caplog.records if rec.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert str(path) in warnings[0].getMessage()
    assert "invalid YAML" in warnings[0].getMessage()


def test_non_mapping_yaml_returns_empty_and_warns(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(config, "_WARNED_UNREADABLE", set())
    path = tmp_path / "config.yaml"
    path.write_text("- just\n- a\n- list\n", encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger=config.logger.name):
        assert config._read_yaml_config(path) == {}

    warnings = [rec for rec in caplog.records if rec.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "not a mapping" in warnings[0].getMessage()


def test_missing_and_empty_config_files_are_silent(tmp_path, caplog):
    """Absent and blank files are normal states: {} and no WARNING."""
    with caplog.at_level(logging.WARNING, logger=config.logger.name):
        assert config._read_yaml_config(tmp_path / "nope" / "config.yaml") == {}
        empty = tmp_path / "config.yaml"
        empty.write_text("   \n", encoding="utf-8")
        assert config._read_yaml_config(empty) == {}
    assert not [rec for rec in caplog.records if rec.levelno == logging.WARNING]

