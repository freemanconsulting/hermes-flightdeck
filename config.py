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
    # Opt-in demo: serve a seeded, live-looking snapshot instead of the real
    # store.  Off by default; FLIGHTDECK_DEMO=1 also turns it on.
    "demo_mode": False,
    # Capacity routing (CAPACITY.md §8.2).  Off by default; opt-in only.
    "route_delegation": False,
    "inner_backend": "default",
    "reserve_slots": 0,
    "max_queue": 2,
    "routing_staleness_seconds": 20,
    "routing_ledger_seconds": 60,
    "routing_servers": [],
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


def _demo_env() -> bool:
    """``FLIGHTDECK_DEMO=1`` (or true/yes/on) turns demo mode on without settings."""
    return _as_bool(os.environ.get("FLIGHTDECK_DEMO"), False)


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


def _load_yaml(text: str) -> Any:
    """Parse YAML text with ruamel's safe loader — the parser Hermes ships.

    ``ruamel.yaml`` is a Hermes core dependency and a public package; we import
    it directly rather than through a Hermes-internal shim (catalog rule 9:
    public surfaces only). ``typ="safe"`` returns plain dict/list/scalar types.
    Platforms without the libyaml C extension (e.g. Windows ARM64) raise at
    construction/parse time, so retry with ``pure=True``.
    """
    from ruamel.yaml import YAML

    try:
        return YAML(typ="safe").load(text)
    except Exception:
        # Only a missing/broken C extension is retried pure; a parse error is
        # raised identically by both parsers and re-raised by the retry.
        return YAML(typ="safe", pure=True).load(text)


def _read_yaml_config(path: Path) -> dict:
    """Parse one config.yaml read-only; unreadable or non-mapping files are {}.

    A failure is never silent: every path that yields {} without the file simply
    being absent/empty gets one WARNING (deduped per path) naming the file.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except Exception as exc:
        _warn_unreadable(path, f"unreadable ({exc.__class__.__name__})")
        return {}
    if not text.strip():
        return {}
    try:
        data = _load_yaml(text)
    except Exception as exc:
        _warn_unreadable(path, f"invalid YAML ({exc.__class__.__name__})")
        return {}
    if not isinstance(data, dict):
        if data is not None:
            _warn_unreadable(path, f"top-level is {type(data).__name__}, not a mapping")
        return {}
    return data


_WARNED_UNREADABLE: set[str] = set()


def _warn_unreadable(path: Path, why: str) -> None:
    """One WARNING per path (then DEBUG) so a broken config is seen but not spammed."""
    key = str(path)
    if key in _WARNED_UNREADABLE:
        logger.debug("flightdeck: config %s skipped: %s", path, why)
        return
    _WARNED_UNREADABLE.add(key)
    logger.warning(
        "flightdeck: skipping config file %s — %s; no server cards, fleet_status "
        "lanes, or capacity routes will come from it", path, why)


def _config_sources(config: Optional[dict] = None) -> list[tuple[str, dict]]:
    """(profile label, config) for the root and every profile, root first.

    Reads the files directly with the ruamel safe loader — never
    ``load_config_readonly``, which would touch the active profile's cache. A
    supplied *config* stands in for the root config.yaml so callers and tests can
    pin it without touching disk.
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
        "demo_mode": _as_bool(settings.get("demo_mode"), False) or _demo_env(),
        "route_delegation": _as_bool(settings.get("route_delegation"), False),
        "inner_backend": str(settings.get("inner_backend") or "default").strip().lower() or "default",
        "reserve_slots": _as_int(settings.get("reserve_slots"), 0, minimum=0),
        "max_queue": _as_int(settings.get("max_queue"), 2, minimum=0),
        "routing_staleness_seconds": _as_int(settings.get("routing_staleness_seconds"), 20, minimum=5),
        "routing_ledger_seconds": _as_int(settings.get("routing_ledger_seconds"), 60, minimum=0),
        "routing_servers": _normalize_hidden(settings.get("routing_servers")),
    }


#: Hermes refuses to run a model whose context window is below this
#: (``MINIMUM_CONTEXT_LENGTH = 64_000``, hermes-agent/agent/model_metadata.py).
#: A server below it can serve a dashboard lane but can never host a delegated
#: subagent — its context is too small for a real task.
MIN_ROUTING_CONTEXT = 64000


def delegation_section(config: Optional[dict] = None) -> dict:
    """The ``delegation`` config section, read-only; {} when absent."""
    data = config if isinstance(config, dict) else _read_config()
    section = data.get("delegation")
    return dict(section) if isinstance(section, dict) else {}


def _model_names(raw: Any) -> list[str]:
    if isinstance(raw, dict):
        return [str(key) for key in raw]
    if isinstance(raw, list):
        return [str(item) for item in raw if str(item).strip()]
    return []


def provider_routes(config: Optional[dict] = None) -> dict[str, dict]:
    """Provider key, models and extra_body per normalized base_url (CAPACITY.md §4).

    Built from every profile's ``providers.<key>``; an auxiliary-only endpoint
    is included too, but a provider key on the same base_url wins.  A lane with
    no provider key is never a routing target (it has no route personality).
    """
    routes: dict[str, dict] = {}
    sources = _config_sources(config)
    for profile, data in sources:
        providers = data.get("providers")
        if not isinstance(providers, dict):
            continue
        for key, entry in providers.items():
            if not isinstance(entry, dict):
                continue
            api = entry.get("api") or entry.get("base_url")
            if not api:
                continue
            base_url = normalize_base_url(api)
            if not base_url:
                continue
            models = _model_names(entry.get("models"))
            existing = routes.get(base_url)
            if existing is not None:
                if profile not in existing["profiles"]:
                    existing["profiles"].append(profile)
                if not existing["models"] and models:
                    existing["models"] = models
                if not existing["default_model"] and entry.get("default_model"):
                    existing["default_model"] = str(entry["default_model"])
                if existing["extra_body"] is None and isinstance(entry.get("extra_body"), dict):
                    existing["extra_body"] = dict(entry["extra_body"])
                continue
            routes[base_url] = {
                "provider": str(key),
                "base_url": str(api),
                "default_model": str(entry.get("default_model") or "") or None,
                "models": models,
                "extra_body": dict(entry["extra_body"]) if isinstance(entry.get("extra_body"), dict) else None,
                "profiles": [profile],
                "aux": False,
            }
    # Auxiliary-only endpoints: a provider key on the same base_url wins.
    for profile, data in sources:
        auxiliary = data.get("auxiliary")
        if not isinstance(auxiliary, dict):
            continue
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
                if not api:
                    continue
                base_url = normalize_base_url(api)
                if not base_url:
                    continue
                model = short_model_name(entry.get("model"))
                models = [model] if model else []
                existing = routes.get(base_url)
                if existing is not None:
                    if profile not in existing["profiles"]:
                        existing["profiles"].append(profile)
                    if not existing["models"] and models:
                        existing["models"] = models
                    continue
                routes[base_url] = {
                    "provider": None,
                    "base_url": str(api),
                    "default_model": model or None,
                    "models": models,
                    "extra_body": dict(entry["extra_body"]) if isinstance(entry.get("extra_body"), dict) else None,
                    "profiles": [profile],
                    "aux": True,
                }
    return routes


def eligible_lanes(servers: list[dict], settings: dict) -> list[dict]:
    """Local server cards routing may use: not cloud, private URL, not hidden, in routing_servers.

    Also never an auxiliary-only discovery card and never a server whose known
    context is below MIN_ROUTING_CONTEXT — both can render on the page but can
    never host a delegated subagent.
    """
    routing = _normalize_hidden(settings.get("routing_servers") if isinstance(settings, dict) else None)
    hidden = _normalize_hidden(settings.get("hidden_servers") if isinstance(settings, dict) else None)
    lanes: list[dict] = []
    for server in servers or []:
        if not isinstance(server, dict):
            continue
        if str(server.get("kind") or "").lower() == "cloud":
            continue
        # Auxiliary-only discovery cards (config.py _union_servers) are
        # dashboards over a task endpoint, not delegation routes; routing to
        # one would hand a child an aux *task name* as its provider.
        if server.get("aux"):
            continue
        # A server whose known context is below Hermes' floor cannot host a
        # subagent no matter how many slots it has. Unknown context stays
        # eligible — we never exclude on a number we don't have.
        context = server.get("context_tokens")
        if isinstance(context, (int, float)) and not isinstance(context, bool) \
                and int(context) < MIN_ROUTING_CONTEXT:
            continue
        if not _private_url(server.get("base_url")):
            continue
        if _is_hidden_server(server, hidden):
            continue
        if routing and not _is_hidden_server(server, routing):
            continue
        lanes.append(server)
    return lanes


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
    "delegation_section", "provider_routes", "eligible_lanes",
]
