"""Resolve plugin-root sibling modules by one identity, from any import context.

The plugin loader imports this package normally, the dashboard mount imports
``dashboard/plugin_api.py`` standalone by path, and tests import root modules
top-level.  A bare ``import store`` only works in the last case, so every
sibling import goes through ``load()``: relative when the caller is part of the
package (``__package__`` set), then the shared ``flightdeck_<name>`` alias, then
load by path.  No ``sys.path`` mutation, and one module object per sibling.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
_MODULES: dict[str, Any] = {}


def load(name: str, package: str | None = None) -> Any:
    """Return the plugin-root module *name*, importing it once.

    *package* is the caller's ``__package__``: pass it so a package-loaded
    caller (the plugin loader) resolves through a relative import.  The
    ``flightdeck_<name>`` alias wins over a fresh relative import when it is
    already registered, so a sibling never gets two module objects.
    """
    module = _MODULES.get(name)
    if module is not None:
        return module
    module_name = f"flightdeck_{name}"
    module = sys.modules.get(module_name)
    if module is None and package:
        try:
            module = importlib.import_module(f".{name}", package)
        except ImportError:
            module = None
        if module is not None:
            sys.modules.setdefault(module_name, module)
    if module is None:
        path = _ROOT / f"{name}.py"
        if not path.exists():
            raise ImportError(f"flightdeck sibling {name!r} not found at {path}")
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    _MODULES[name] = module
    return module
