"""Make the project root importable when pytest runs from anywhere, and keep the
pytest temp dirs outside the real Hermes home.
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _safe_pytest_basetemp() -> str:
    """A fresh temp dir guaranteed NOT to live under the native ``~/.hermes``.

    Why this exists: tests point ``HERMES_HOME`` at a ``tmp_path`` and expect
    ``config._hermes_root()`` to be that dir. But Hermes' root rule
    (``hermes_constants._hermes_root_of``) returns the *native* ``~/.hermes``
    whenever the ``HERMES_HOME`` path resolves underneath it (normal or profile
    mode). When the OS temp dir is itself inside the Hermes home -- e.g.
    ``TMPDIR=~/.hermes/cache/scratch`` on main-llm -- pytest's ``tmp_path``
    lands under ``~/.hermes``, the root rule collapses it to the real home, and
    the tests read the user's real config instead of the fixture.

    Fixing it at the source: give pytest a base temp dir that provably sits
    outside ``~/.hermes``, so every ``tmp_path``/``tmp_path_factory`` root stays
    a genuinely separate root.

    Only used when the caller didn't pass ``--basetemp``; that flag always wins.
    """
    native_home = (Path.home() / ".hermes").resolve()

    def _is_safe(candidate: Path) -> bool:
        try:
            candidate = candidate.resolve()
        except OSError:
            return False
        if not candidate.is_dir() or not os.access(candidate, os.W_OK):
            return False
        try:
            candidate.relative_to(native_home)
        except ValueError:  # not under ~/.hermes -- good
            return True
        return False  # under the real Hermes home -- unusable

    # Prefer /tmp on POSIX when it is real and writable; otherwise whatever
    # tempfile.gettempdir() says (honours TMPDIR), as long as it escapes the home.
    candidates = []
    if os.name == "posix":
        candidates.append(Path("/tmp"))
    candidates.append(Path(tempfile.gettempdir()))

    for base in candidates:
        if _is_safe(base):
            return tempfile.mkdtemp(prefix="flightdeck-pytest-", dir=str(base))

    # TMPDIR (and /tmp) all resolve under ~/.hermes: build the run dir next to
    # the repo instead, which is outside the home only if the repo itself is.
    if not _is_safe(ROOT):
        raise RuntimeError(
            "cannot find a temp location outside the Hermes home "
            f"({native_home}); pass --basetemp explicitly"
        )
    return tempfile.mkdtemp(prefix="flightdeck-pytest-", dir=str(ROOT))


def pytest_configure(config):
    """Pin pytest's base temp dir outside the Hermes home (see _safe_pytest_basetemp)."""
    if getattr(config.option, "basetemp", None):
        return  # an explicit --basetemp is the user's call, even if it points at ~/.hermes
    basetemp = _safe_pytest_basetemp()
    config.option.basetemp = basetemp

    def _cleanup() -> None:
        shutil.rmtree(basetemp, ignore_errors=True)

    config.add_cleanup(_cleanup)
