"""Machine-wide discovery: every profile's config.yaml, not just the active one."""

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
