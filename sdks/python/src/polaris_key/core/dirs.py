"""Platform directories for one product: config (unchanged), data, cache and state.

Mirrors ``packages/sdk-node/src/core/dirs.ts`` (P1b-09 plan §5.4). Every option is a BASE and
the SDK appends ``<product>``, exactly as ``config_dir`` has always worked. The config base does
NOT move: it holds the token, the device id and ``managed.json``, and a developer's Node,
Python and Swift tools share it (plan D5). The three new bases live under a ``polaris-key``
vendor segment so they cannot collide with the host application's own folder (plan D6).

Resolution is PURE: nothing here creates a directory. :func:`exclude_from_backup` is the one
helper with a side effect, and it never raises.
"""

from __future__ import annotations

import ntpath
import os
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence

__all__ = [
    "CACHEDIR_TAG_SIGNATURE",
    "ProductDirs",
    "default_dir_bases",
    "exclude_from_backup",
    "resolve_dirs",
]

_VENDOR = "polaris-key"

#: A drive-absolute (``C:\``) or UNC (``\\server``) Windows path.
_WIN_ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")


@dataclass(frozen=True)
class ProductDirs:
    """The four directories of one product. Each already ends in ``<product>``."""

    config: str
    data: str
    cache: str
    state: str


def _path_for(platform: str):  # type: ignore[no-untyped-def]
    return ntpath if platform == "win32" else posixpath


def _xdg(env: Mapping[str, str], name: str) -> Optional[str]:
    """An XDG variable counts only when set, non-empty and absolute (the XDG spec)."""
    value = env.get(name)
    return value if value and posixpath.isabs(value) else None


def default_dir_bases(
    *,
    platform: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[str] = None,
) -> ProductDirs:
    """The default BASES (before ``<product>`` is appended) for this host. Every argument is
    a test seam."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    home = home if home is not None else os.path.expanduser("~")
    path = _path_for(platform)

    # Today's config base, on every OS (an empty XDG_CONFIG_HOME already meant ~/.config).
    config = env.get("XDG_CONFIG_HOME") or path.join(home, ".config")

    if platform == "darwin":
        support = path.join(home, "Library", "Application Support", _VENDOR)
        return ProductDirs(
            config=config,
            data=path.join(support, "data"),
            cache=path.join(home, "Library", "Caches", _VENDOR),
            state=path.join(support, "state"),
        )
    if platform == "win32":
        local = env.get("LOCALAPPDATA")
        if not (local and _WIN_ABSOLUTE.match(local)):
            local = ntpath.join(home, "AppData", "Local")
        root = ntpath.join(local, _VENDOR)
        return ProductDirs(
            config=config,
            data=ntpath.join(root, "data"),
            cache=ntpath.join(root, "cache"),
            state=ntpath.join(root, "state"),
        )
    return ProductDirs(
        config=config,
        data=path.join(_xdg(env, "XDG_DATA_HOME") or path.join(home, ".local", "share"), _VENDOR),
        cache=path.join(_xdg(env, "XDG_CACHE_HOME") or path.join(home, ".cache"), _VENDOR),
        state=path.join(_xdg(env, "XDG_STATE_HOME") or path.join(home, ".local", "state"), _VENDOR),
    )


def resolve_dirs(
    product_slug: str,
    *,
    config_dir: Optional[str] = None,
    data_dir: Optional[str] = None,
    cache_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    platform: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[str] = None,
) -> ProductDirs:
    """Each override base, else the platform default, with ``<product>`` appended. Creates
    nothing."""
    platform = platform or sys.platform
    path = _path_for(platform)
    bases = default_dir_bases(platform=platform, env=env, home=home)
    return ProductDirs(
        config=path.join(config_dir or bases.config, product_slug),
        data=path.join(data_dir or bases.data, product_slug),
        cache=path.join(cache_dir or bases.cache, product_slug),
        state=path.join(state_dir or bases.state, product_slug),
    )


#: The ``CACHEDIR.TAG`` signature line, which tar, borg and restic skip under
#: ``--exclude-caches`` (https://bford.info/cachedir/).
CACHEDIR_TAG_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55"

_CACHEDIR_TAG = (
    f"{CACHEDIR_TAG_SIGNATURE}\n"
    "# This file is a cache directory tag created by Polaris Key.\n"
    "# For information about cache directory tags, see https://bford.info/cachedir/\n"
)


def _default_run(args: Sequence[str]) -> None:
    subprocess.run(
        list(args),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=10,
    )


def _default_write_file(path: str, data: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        os.write(fd, data.encode("utf-8"))
    finally:
        os.close(fd)


def exclude_from_backup(
    path: str,
    *,
    platform: Optional[str] = None,
    run: Optional[Callable[[Sequence[str]], None]] = None,
    write_file: Optional[Callable[[str, str], None]] = None,
) -> str:
    """Mark an EXISTING directory (the caller creates it first, at 0700) as excluded from
    backups. Returns ``"excluded"``, ``"not-applicable"`` or ``"failed"``; never raises.

    * Every POSIX host gets a ``CACHEDIR.TAG``.
    * macOS also runs ``/usr/bin/tmutil addexclusion`` (a sticky per-item exclusion).
    * Windows is ``not-applicable``: it has no per-directory exclusion convention, and
      ``%LOCALAPPDATA%`` neither roams nor sits in OneDrive's known folders.
    """
    platform = platform or sys.platform
    if platform == "win32":
        return "not-applicable"
    run = run or _default_run
    write_file = write_file or _default_write_file
    try:
        try:
            write_file(posixpath.join(path, "CACHEDIR.TAG"), _CACHEDIR_TAG)
        except FileExistsError:
            pass
        if platform == "darwin":
            run(["/usr/bin/tmutil", "addexclusion", path])
        return "excluded"
    except Exception:
        return "failed"
