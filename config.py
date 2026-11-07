"""Flightdeck settings: declared servers, zero-setup discovery, poll knobs.

Per-profile settings live in ``plugins.entries.flightdeck.settings`` (DESIGN
§7.1); discovery reads every profile's provider list read-only (DESIGN §7.2)
and caches the result in the shared store's ``meta`` table for 60 s. Stdlib
only apart from the YAML parser Hermes already ships.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

try:  # plugin loader: package context
    from ._siblings import load as _load_sibling
except ImportError:  # loaded standalone by path (dashboard, plugin_api)
    import importlib.util as _util
    _siblings_module = sys.modules.get("flightdeck__siblings")
    if _siblings_module is None:
        _spec = _util.spec_from_file_location(
            "flightdeck__siblings", Path(__file__).resolve().parent / "_siblings.py")
        if _spec is None or _spec.loader is None:
            raise ImportError("cannot load flightdeck _siblings.py")
        _siblings_module = _util.module_from_spec(_spec)
        sys.modules["flightdeck__siblings"] = _siblings_module
        _spec.loader.exec_module(_siblings_module)
    _load_sibling = _siblings_module.load

logger = logging.getLogger(__name__)

PLUGIN_ID = "flightdeck"
DISCOVERY_CACHE_VERSION = 2
DISCOVERY_CACHE_KEY = f"discovery_cache:v{DISCOVERY_CACHE_VERSION}"
DISCOVERY_TTL_SECONDS = 60.0
DISCOVERY_EMPTY_TTL_SECONDS = 10.0
ROOT_PROFILE_LABEL = "default"

DEFAULTS: dict[str, Any] = {
    "servers": [],
    "hidden_servers": [],
    "auto_discover": True,
    "poll_interval_seconds": 5,
    "probe_timeout_seconds": 2.0,
    "stale_after_seconds": 300,
    "retention_hours": 24,
    "rollup_days": 7,
    "show_cloud": True,
    "show_chip": True,
    "show_quota": True,
}

_PRIVATE_NETS = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("100.64.0.0/10"),
    ipaddress.IPv6Network("fc00::/7"),
)


def normalize_base_url(url: Any) -> str:
    """Match key for a server/agent base_url.

    Strip a trailing ``/`` and a trailing ``/v1``, lowercase scheme+host, keep
    the port: ``http://127.0.0.1:18010/v1`` → ``http://127.0.0.1:18010``.
    """
    text = str(url or "").strip()
    if not text:
        return ""
    if "://" not in text:
        text = "http://" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return text.rstrip("/").lower()
    path = (parts.path or "").rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3].rstrip("/")
    host = (parts.hostname or "").lower()
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    if parts.username:
        netloc = f"{parts.username}@{netloc}"
    return urlunsplit((parts.scheme.lower(), netloc, path, "", ""))


def is_private_host(host: Any) -> bool:
    """Loopback, RFC1918, 100.64/10, ULA, ``localhost``, ``.local``, ``.tailscale.net``."""
    name = str(host or "").strip().lower().strip("[]")
    if not name:
        return False
    if name == "localhost" or name.endswith(".local") or name.endswith(".tailscale.net"):
        return True
    try:
        address = ipaddress.ip_address(name)
    except ValueError:
        return False
    if address.is_loopback or address.is_private or address.is_link_local:
        return True
    return any(address in network for network in _PRIVATE_NETS)


def _private_url(url: Any) -> bool:
    try:
        return is_private_host(urlsplit(str(url or "")).hostname)
    except ValueError:
        return False


def _as_int(value: Any, default: int, *, minimum: Optional[int] = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return max(result, minimum) if minimum is not None else result


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def host_port(url: Any) -> str:
    """A URL's host:port — the last-resort card label when nothing names it."""
    try:
        parts = urlsplit(str(url or ""))
    except ValueError:
        return str(url or "")
    return parts.netloc or str(url or "")


def _normalize_servers(raw: Any) -> list[dict]:
    """Accept the settings list (or a JSON string) and return clean entries."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return []
    if not isinstance(raw, list):
        return []
    servers: list[dict] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        base_url = normalize_base_url(entry.get("base_url") or entry.get("url"))
        if not base_url or base_url in seen:
            continue
        seen.add(base_url)
        servers.append({
            "name": str(entry.get("name") or host_port(base_url)),
            "base_url": base_url,
            "kind": str(entry.get("kind") or "auto").strip().lower() or "auto",
        })
    return servers


_AUX_SUFFIX = re.compile(
    r"\.(?:gguf|safetensors|bin|fp\d+|bf\d+|int\d+|iq\d+(?:_\w+)?|q\d+(?:_\w+)?)$",
    re.IGNORECASE,
)


def short_model_name(model: Any) -> str:
    """The model's short label: ``Qwen3.5-9B.Q6_K.gguf`` → ``qwen3.5-9b``.

    Strips the path, the file format and a quantization suffix (repeatedly, so
    ``.Q6_K.gguf`` goes too).  An auxiliary endpoint is named after the model it
    serves, never after the role key that points at it (DESIGN §7.2).
    """
    text = str(model or "").strip()
    if not text:
        return ""
    text = Path(text.replace("\\", "/")).name
    for _ in range(4):
        stripped = _AUX_SUFFIX.sub("", text)
        if stripped == text:
            break
        text = stripped
    return text.lower()


def _normalize_hidden(raw: Any) -> list[str]:
    """Accept the settings list (or a JSON string) and return clean, unique names."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            raw = [raw]
    if not isinstance(raw, list):
        return []
    hidden: list[str] = []
    for entry in raw:
        text = str(entry or "").strip()
        if text and text not in hidden:
            hidden.append(text)
    return hidden


def _is_hidden_server(server: dict, hidden: list[str]) -> bool:
    """A server matches a ``hidden_servers`` entry by name or normalized base_url."""
    if not hidden:
        return False
    name = str(server.get("name") or "").strip().lower()
    url = normalize_base_url(server.get("base_url"))
    for entry in hidden:
        text = str(entry or "").strip()
        if not text:
            continue
        if name and text.lower() == name:
            return True
        if url and normalize_base_url(text) == url:
            return True
    return False


def _read_config() -> dict:
    try:
        from hermes_cli.config import load_config_readonly

        data = load_config_readonly()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _hermes_root() -> Path:
    """Machine-wide Hermes root; honours a ``HERMES_HOME`` override."""
    try:
        from hermes_constants import get_default_hermes_root

        return Path(get_default_hermes_root())
    except Exception:
        env = os.environ.get("HERMES_HOME", "").strip()
        return Path(env).expanduser() if env else Path.home() / ".hermes"


def _read_yaml_config(path: Path) -> dict:
    """Parse one config.yaml read-only; unreadable or non-mapping files are {}.

    PyYAML is a Hermes dependency, so it is the only parser used. If it is ever
    missing, skip the YAML profiles rather than importing Hermes core (catalog
    rule 9: public surfaces only).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return {}
    try:
        import yaml
    except ImportError:
        logger.debug("flightdeck: PyYAML unavailable; skipping %s", path)
        return {}
    try:
        data = yaml.safe_load(text)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _config_sources(config: Optional[dict] = None) -> list[tuple[str, dict]]:
    """(profile label, config) for the root and every profile, root first.

    Reads the files directly with a YAML safe load — never ``load_config_readonly``,
    which would touch the active profile's cache. A supplied *config* stands in for
    the root config.yaml so callers and tests can pin it without touching disk.
    """
    root = _hermes_root()
    sources: list[tuple[str, dict]] = []
    root_data = config if isinstance(config, dict) else _read_yaml_config(root / "config.yaml")
    if root_data:
        sources.append((ROOT_PROFILE_LABEL, root_data))
    try:
        profile_dirs = sorted((path for path in (root / "profiles").iterdir() if path.is_dir()),
                              key=lambda path: path.name)
    except Exception:
        profile_dirs = []
    for directory in profile_dirs:
        data = _read_yaml_config(directory / "config.yaml")
        if data:
            sources.append((directory.name, data))
    return sources


def _union_servers(sources: list[tuple[str, dict]], *, declared: bool) -> list[dict]:
    """Dedupe servers by base_url across profiles; first name wins, profiles accumulate."""
    servers: list[dict] = []
    by_url: dict[str, dict] = {}
    for profile, data in sources:
        if declared:
            entries = _normalize_servers(_settings_from_config(data).get("servers"))
        else:
            providers = data.get("providers")
            entries = []
            if isinstance(providers, dict):
                for key, entry in providers.items():
                    if not isinstance(entry, dict):
                        continue
                    api = entry.get("api") or entry.get("base_url")
                    if not api or not _private_url(api):
                        continue
                    base_url = normalize_base_url(api)
                    if base_url:
                        # The provider KEY is the short, stable label; the
                        # provider `name:` is often long prose, so it rides
                        # along as the tooltip title only (DESIGN §7.2).
                        prose = str(entry.get("name") or "").strip()
                        entries.append({
                            "name": str(key),
                            "title": prose if prose and prose != str(key) else None,
                            "key": str(key),
                            "base_url": base_url,
                            "kind": "auto",
                        })
            # Auxiliary lanes are private endpoints too, and often the only
            # place a small local model appears (e.g. 127.0.0.1:18436).
            auxiliary = data.get("auxiliary")
            if isinstance(auxiliary, dict):
                for key, entry in auxiliary.items():
                    if not isinstance(entry, dict):
                        continue
                    urls = [entry.get("base_url")]
                    chain = entry.get("fallback_chain")
                    if isinstance(chain, list):
                        for item in chain:
                            if isinstance(item, dict):
                                urls.append(item.get("base_url"))
                    for api in urls:
                        if not api or not _private_url(api):
                            continue
                        base_url = normalize_base_url(api)
                        if base_url:
                            # Name an auxiliary-only endpoint after the model it
                            # serves, never after the role key: "vision" is not a
                            # server.  Provider keys still win (dedupe below).
                            entries.append({
                                "name": short_model_name(entry.get("model")) or host_port(base_url),
                                "title": None,
                                "key": str(key),
                                "aux": True,
                                "roles": [str(key)],
                                "base_url": base_url,
                                "kind": "auto",
                            })
        for entry in entries:
            base_url = entry.get("base_url") or ""
            if not base_url:
                continue
            existing = by_url.get(base_url)
            if existing is not None:
                if profile not in existing["profiles"]:
                    existing["profiles"].append(profile)
                if not existing.get("title") and entry.get("title"):
                    existing["title"] = entry["title"]
                if existing.get("aux") and entry.get("aux"):
                    for role in entry.get("roles") or []:
                        if role not in existing.setdefault("roles", []):
                            existing["roles"].append(role)
                elif existing.get("aux") and not entry.get("aux"):
                    # A provider key names the same endpoint: it wins over the
                    # auxiliary role label.
                    existing["name"] = entry["name"]
                    existing["title"] = entry.get("title")
                    existing["key"] = entry.get("key")
                    existing.pop("aux", None)
                    existing.pop("roles", None)
                continue
            server = dict(entry)
            server["profiles"] = [profile]
            by_url[base_url] = server
            servers.append(server)
    for server in servers:
        if server.get("aux"):
            roles = ", ".join(server.get("roles") or [])
            server["title"] = f"helper model for: {roles} · {host_port(server.get('base_url'))}"
    return servers


def _declared_servers(config: Optional[dict] = None) -> list[dict]:
    """Union of ``plugins.entries.flightdeck.settings.servers`` across every profile."""
    return _union_servers(_config_sources(config), declared=True)


def _settings_from_config(config: dict) -> dict:
    entries = ((config.get("plugins") or {}).get("entries") or {})
    entry = entries.get(PLUGIN_ID) if isinstance(entries, dict) else None
    settings = entry.get("settings") if isinstance(entry, dict) else None
    return settings if isinstance(settings, dict) else {}


def _settings_from_ctx(ctx: Any) -> dict:
    if ctx is None or not hasattr(ctx, "get_config"):
        return {}
    settings: dict[str, Any] = {}
    for key, default in DEFAULTS.items():
        try:
            settings[key] = ctx.get_config(key, default)
        except Exception:
            settings[key] = default
    return settings


def _cached_discovery_servers(payload: Any) -> Optional[list[dict]]:
    """Validate a cached discovery payload; ``None`` means "ignore the cache".

    The cache row is written by whichever build the live dashboard loaded, so
    a payload from an older build (e.g. auxiliary rows named after the role key
    with no ``aux``/``roles``) must never be served.  The key is versioned and
    the shape is checked: both guards are needed because a stale row can be
    rewritten by an old process still running in the background.
    """
    if not isinstance(payload, dict):
        return None
    if payload.get("version") != DISCOVERY_CACHE_VERSION:
        return None
    servers = payload.get("servers")
    if not isinstance(servers, list):
        return None
    for server in servers:
        if not isinstance(server, dict):
            return None
        if not str(server.get("base_url") or "").strip():
            return None
        if not str(server.get("name") or "").strip():
            return None
        if server.get("aux") and not server.get("roles"):
            return None
    return servers


def discover(conn: Any = None, *, config: Optional[dict] = None,
             now: Optional[float] = None) -> list[dict]:
    """Provider base_urls from every profile's config; private addresses only.

    The union covers the root config.yaml and every ``profiles/*/config.yaml``,
    deduped by normalized base_url with the first display name winning and the
    referencing profiles recorded under ``profiles``. Cached in ``meta`` for
    60 s when *conn* is given; an empty result is retried after 10 s so a fixed
    config shows up quickly.
    """
    moment = float(now if now is not None else time.time())
    _store = None
    if conn is not None:
        _store = _load_sibling("store", __package__)
        cached = _store.meta_get(conn, DISCOVERY_CACHE_KEY)
        if cached:
            try:
                payload = json.loads(cached)
                cached_servers = _cached_discovery_servers(payload)
                if cached_servers is not None:
                    age = moment - float(payload.get("at", 0))
                    ttl = (DISCOVERY_TTL_SECONDS if cached_servers
                           else DISCOVERY_EMPTY_TTL_SECONDS)
                    if age < ttl:
                        return cached_servers
            except (TypeError, ValueError, AttributeError):
                pass
    servers = _union_servers(_config_sources(config), declared=False)
    if _store is not None:
        try:
            _store.meta_set(conn, DISCOVERY_CACHE_KEY, json.dumps(
                {"version": DISCOVERY_CACHE_VERSION, "at": moment, "servers": servers}))
        except Exception:
            logger.debug("flightdeck: discovery cache write failed", exc_info=True)
    return servers


def load(ctx: Any = None, conn: Any = None, *, now: Optional[float] = None) -> dict:
    """Settings with defaults applied; declared servers win, else discovery.

    Declared servers are the union across every profile's config.yaml; the
    remaining knobs come from *ctx* (or the active profile's config).
    """
    raw = _settings_from_ctx(ctx) if ctx is not None else _settings_from_config(_read_config())
    settings = dict(DEFAULTS)
    settings.update({key: value for key, value in raw.items() if key in DEFAULTS})
    hidden = _normalize_hidden(settings.get("hidden_servers"))
    servers = _declared_servers()
    source = "declared" if servers else "none"
    if not servers and _as_bool(settings.get("auto_discover"), True):
        servers = discover(conn, now=now)
        # "discovered" even when the search found nothing: the UI needs to tell
        # "discovery is on and found no servers" from "nothing declared".
        source = "discovered"
    # Hidden servers never render: no card, no chip, no fleet_status lane.
    servers = [server for server in servers if not _is_hidden_server(server, hidden)]
    return {
        "servers": servers,
        "servers_source": source,
        "hidden_servers": hidden,
        "auto_discover": _as_bool(settings.get("auto_discover"), True),
        "poll_interval_seconds": _as_int(settings.get("poll_interval_seconds"), 5, minimum=2),
        "probe_timeout_seconds": _as_float(settings.get("probe_timeout_seconds"), 2.0),
        "stale_after_seconds": _as_int(settings.get("stale_after_seconds"), 300, minimum=5),
        "retention_hours": _as_int(settings.get("retention_hours"), 24, minimum=1),
        "rollup_days": _as_int(settings.get("rollup_days"), 7, minimum=1),
        "show_cloud": _as_bool(settings.get("show_cloud"), True),
        "show_chip": _as_bool(settings.get("show_chip"), True),
        "show_quota": _as_bool(settings.get("show_quota"), True),
    }


def server_for_url(servers: list[dict], base_url: Any) -> Optional[dict]:
    """The declared server a request's base_url belongs to (normalized match)."""
    target = normalize_base_url(base_url)
    if not target:
        return None
    for server in servers or []:
        if normalize_base_url(server.get("base_url")) == target:
            return server
    return None


__all__ = [
    "DEFAULTS", "DISCOVERY_CACHE_KEY", "DISCOVERY_TTL_SECONDS",
    "normalize_base_url", "is_private_host", "discover", "load", "server_for_url",
]
