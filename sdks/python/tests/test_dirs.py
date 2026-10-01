# @pkey-feature core.store
"""Platform directories (P1b-09 plan §5.4): each OS's table, the XDG edge cases, the legacy
config base equal to today's, and the never-raising backup-exclusion helper."""

from __future__ import annotations

import os
from typing import List

from polaris_key.core.context import CoreContext
from polaris_key.core.dirs import (
    CACHEDIR_TAG_SIGNATURE,
    ProductDirs,
    default_dir_bases,
    exclude_from_backup,
    resolve_dirs,
)
from polaris_key.devices.store import InMemoryStore


def test_linux_table() -> None:
    assert resolve_dirs("djdl", platform="linux", env={}, home="/home/ada") == ProductDirs(
        config="/home/ada/.config/djdl",
        data="/home/ada/.local/share/polaris-key/djdl",
        cache="/home/ada/.cache/polaris-key/djdl",
        state="/home/ada/.local/state/polaris-key/djdl",
    )


def test_linux_absolute_xdg_variables_are_honoured() -> None:
    env = {
        "XDG_CONFIG_HOME": "/x/config",
        "XDG_DATA_HOME": "/x/data",
        "XDG_CACHE_HOME": "/x/cache",
        "XDG_STATE_HOME": "/x/state",
    }
    assert resolve_dirs("djdl", platform="linux", env=env, home="/home/ada") == ProductDirs(
        config="/x/config/djdl",
        data="/x/data/polaris-key/djdl",
        cache="/x/cache/polaris-key/djdl",
        state="/x/state/polaris-key/djdl",
    )


def test_linux_empty_or_relative_xdg_variables_are_ignored() -> None:
    env = {
        "XDG_CONFIG_HOME": "",
        "XDG_DATA_HOME": "relative/data",
        "XDG_CACHE_HOME": "",
        "XDG_STATE_HOME": "./state",
    }
    dirs = resolve_dirs("djdl", platform="linux", env=env, home="/home/ada")
    assert dirs.config == "/home/ada/.config/djdl"
    assert dirs.data == "/home/ada/.local/share/polaris-key/djdl"
    assert dirs.cache == "/home/ada/.cache/polaris-key/djdl"
    assert dirs.state == "/home/ada/.local/state/polaris-key/djdl"


def test_macos_table_ignores_xdg_except_config() -> None:
    env = {"XDG_DATA_HOME": "/x/data", "XDG_CACHE_HOME": "/x/cache"}
    assert resolve_dirs("djdl", platform="darwin", env=env, home="/Users/ada") == ProductDirs(
        config="/Users/ada/.config/djdl",
        data="/Users/ada/Library/Application Support/polaris-key/data/djdl",
        cache="/Users/ada/Library/Caches/polaris-key/djdl",
        state="/Users/ada/Library/Application Support/polaris-key/state/djdl",
    )


def test_windows_table() -> None:
    env = {"LOCALAPPDATA": "C:\\Users\\ada\\AppData\\Local", "XDG_DATA_HOME": "/x/data"}
    assert resolve_dirs("djdl", platform="win32", env=env, home="C:\\Users\\ada") == ProductDirs(
        config="C:\\Users\\ada\\.config\\djdl",
        data="C:\\Users\\ada\\AppData\\Local\\polaris-key\\data\\djdl",
        cache="C:\\Users\\ada\\AppData\\Local\\polaris-key\\cache\\djdl",
        state="C:\\Users\\ada\\AppData\\Local\\polaris-key\\state\\djdl",
    )


def test_windows_missing_localappdata_falls_back() -> None:
    bases = default_dir_bases(platform="win32", env={}, home="C:\\Users\\ada")
    assert bases.data == "C:\\Users\\ada\\AppData\\Local\\polaris-key\\data"


def test_overrides_are_bases() -> None:
    assert resolve_dirs(
        "djdl",
        config_dir="/o/config",
        data_dir="/o/data",
        cache_dir="/o/cache",
        state_dir="/o/state",
        platform="linux",
        env={},
        home="/home/ada",
    ) == ProductDirs(
        config="/o/config/djdl",
        data="/o/data/djdl",
        cache="/o/cache/djdl",
        state="/o/state/djdl",
    )


def test_the_legacy_config_base_equals_todays_on_every_os() -> None:
    for platform, home, sep in (
        ("linux", "/home/ada", "/"),
        ("darwin", "/Users/ada", "/"),
        ("win32", "C:\\Users\\ada", "\\"),
    ):
        assert default_dir_bases(platform=platform, env={}, home=home).config == f"{home}{sep}.config"
        assert (
            default_dir_bases(platform=platform, env={"XDG_CONFIG_HOME": "/xdg"}, home=home).config
            == "/xdg"
        )


def test_core_context_exposes_dirs_and_creates_nothing(tmp_path) -> None:
    base = str(tmp_path)
    core = CoreContext(
        product_slug="djdl",
        version="1.0.0",
        trust={},
        store=InMemoryStore("djdl"),
        config_dir=os.path.join(base, "config"),
        data_dir=os.path.join(base, "data"),
        cache_dir=os.path.join(base, "cache"),
        state_dir=os.path.join(base, "state"),
    )
    try:
        assert core.dirs == ProductDirs(
            config=os.path.join(base, "config", "djdl"),
            data=os.path.join(base, "data", "djdl"),
            cache=os.path.join(base, "cache", "djdl"),
            state=os.path.join(base, "state", "djdl"),
        )
        for d in (core.dirs.config, core.dirs.data, core.dirs.cache, core.dirs.state):
            assert not os.path.exists(d)
    finally:
        core.close()


# ── exclude_from_backup ─────────────────────────────────────────────────────────────
def test_posix_writes_a_cachedir_tag_and_an_existing_tag_is_fine(tmp_path) -> None:
    ran: List[List[str]] = []
    assert exclude_from_backup(str(tmp_path), platform="linux", run=ran.append) == "excluded"
    tag = (tmp_path / "CACHEDIR.TAG").read_text(encoding="utf-8")
    assert tag.startswith(CACHEDIR_TAG_SIGNATURE)
    assert exclude_from_backup(str(tmp_path), platform="linux", run=ran.append) == "excluded"
    assert ran == []


def test_macos_also_runs_tmutil() -> None:
    ran: List[List[str]] = []
    written: List[str] = []
    path = "/Users/ada/Library/Application Support/polaris-key/data/djdl"
    result = exclude_from_backup(
        path,
        platform="darwin",
        run=lambda args: ran.append(list(args)),
        write_file=lambda p, d: written.append(p),
    )
    assert result == "excluded"
    assert ran == [["/usr/bin/tmutil", "addexclusion", path]]
    assert written[0].endswith("CACHEDIR.TAG")


def test_windows_is_not_applicable() -> None:
    assert exclude_from_backup("C:\\x", platform="win32") == "not-applicable"


def test_a_failing_step_is_failed_not_a_raise() -> None:
    def _boom(args) -> None:  # noqa: ANN001
        raise RuntimeError("tmutil: permission denied")

    assert (
        exclude_from_backup("/nope", platform="darwin", run=_boom, write_file=lambda p, d: None)
        == "failed"
    )
    assert exclude_from_backup("/does/not/exist/anywhere", platform="linux") == "failed"
