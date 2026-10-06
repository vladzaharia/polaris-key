"""Install drivers: ``client.update.install(decision)`` (``update.driver``; SDK parity pass §3.16).

A driver takes the signed decision the update client made and gets the new build onto the
device. Three ship here, each with no hard dependency:

* :class:`VelopackDriver` — a PyInstaller or Briefcase app packaged with Velopack. It drives the
  ``velopack`` package's ``UpdateManager`` over the product's Velopack feed (discovery's
  ``update.endpoints.velopack``, through ``client.update.feed_url("velopack", …)``). Without the
  package installed it answers ``unsupported {dependency}``.
* :class:`SelfReplaceDriver` — a single-file executable (a PyInstaller ``--onefile`` CLI, a
  Nuitka binary): it downloads the decision's build with ``client.release.fetch`` (verified
  against the signed release record), keeps the running binary as ``<exe>.old`` and moves the
  new one into place; the next launch runs it. ``rollback()`` swaps the old one back, which the
  boot guard uses after repeated failed launches.
* :class:`StoreLinkDriver` — a ``store`` decision (App Store, Microsoft Store, Steam, …): opens
  the listing URL in the system browser.

Every driver records the update-health events (``update_downloaded``, ``update_applied``) in the
client's journal, so the staged-rollout auto-halt sees the fleet.

:class:`InstallOutcome` kinds: ``restart-required`` (the new build runs at the next launch),
``handed-off`` (an external updater took over and will restart the app), ``store-opened`` and
``unsupported`` (with a registry ``reason``: ``runtime``, ``outlet``, ``product``,
``dependency`` or ``version``, and a ``detail``).
"""

from __future__ import annotations

import os
import stat
import sys
import webbrowser
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Optional
from urllib.parse import urlsplit, urlunsplit

from ..constants_generated import UnsupportedReason
from ..core.models import UpdateCheck, UpdateDecision

if TYPE_CHECKING:  # pragma: no cover
    from ..client import PolarisKeyClient

__all__ = [
    "InstallOutcome",
    "InstallDriver",
    "VelopackDriver",
    "SelfReplaceDriver",
    "StoreLinkDriver",
    "decision_of",
]


@dataclass(frozen=True)
class InstallOutcome:
    kind: str
    reason: Optional[str] = None
    detail: Optional[str] = None
    #: Where the new build is, when the driver wrote it.
    path: Optional[str] = None
    #: The version the driver installed or handed off.
    version: Optional[str] = None


def unsupported(reason: str, detail: str) -> InstallOutcome:
    return InstallOutcome("unsupported", reason=reason, detail=detail)


def decision_of(target: Any) -> Optional[UpdateDecision]:
    if isinstance(target, UpdateCheck):
        return target.decision
    if isinstance(target, UpdateDecision):
        return target
    return None


class InstallDriver:
    """The driver interface. ``install`` is required; ``rollback`` and ``staged`` are optional
    (the boot guard uses them when present)."""

    def install(
        self,
        client: "PolarisKeyClient",
        decision: UpdateDecision,
        *,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> InstallOutcome:  # pragma: no cover - interface
        raise NotImplementedError

    rollback: Optional[Callable[[], bool]] = None

    def staged(self) -> bool:
        return False


def _record(client: "PolarisKeyClient", event: str, version: str) -> None:
    journal = getattr(client, "update_journal", None)
    if journal is None:
        return
    try:
        journal.record(event, release=version, from_release=client.core.version)
    except Exception:
        pass


# ── Store link ───────────────────────────────────────────────────────────────────────
class StoreLinkDriver(InstallDriver):
    """Opens a ``store`` decision's listing URL (``open`` defaults to ``webbrowser.open``)."""

    def __init__(self, open_url: Optional[Callable[[str], Any]] = None) -> None:
        self._open = open_url or webbrowser.open

    def install(self, client, decision, *, on_progress=None):  # type: ignore[no-untyped-def]
        if decision.action != "store":
            return unsupported(UnsupportedReason.OUTLET, f"a {decision.action} decision is not a store hand-off")
        url = decision.listingUrl
        if not url:
            return unsupported(UnsupportedReason.PRODUCT, "the decision names no store listing URL")
        if urlsplit(url).scheme not in ("https", "http", "itms-apps", "ms-windows-store", "steam", "market"):
            return unsupported(UnsupportedReason.PRODUCT, "the listing URL has an unexpected scheme")
        self._open(url)
        version = decision.release.version if decision.release is not None else None
        return InstallOutcome("store-opened", detail=url, version=version)


# ── Single-file self-replace ─────────────────────────────────────────────────────────
class SelfReplaceDriver(InstallDriver):
    """Replace a single-file executable with the decision's verified build.

    ``executable`` defaults to ``sys.executable`` in a frozen app (PyInstaller, Nuitka, cx_Freeze
    set ``sys.frozen``); an interpreter running a script is ``unsupported {runtime}`` (update it
    with pip or your package manager instead). The previous binary is kept at ``<exe>.old``."""

    def __init__(self, executable: Optional[str] = None) -> None:
        if executable is None and getattr(sys, "frozen", False):
            executable = sys.executable
        self.executable = executable

    def install(self, client, decision, *, on_progress=None):  # type: ignore[no-untyped-def]
        exe = self.executable
        if not exe:
            return unsupported(
                UnsupportedReason.RUNTIME,
                "not a frozen single-file executable; update the package with its installer",
            )
        if decision.action != "binary" or decision.release is None:
            return unsupported(UnsupportedReason.OUTLET, f"a {decision.action} decision has no binary to install")
        new = exe + ".new"
        got = client.release.fetch(decision, to=new, on_progress=on_progress)
        mode = os.stat(exe).st_mode if os.path.exists(exe) else 0o755
        os.chmod(got.path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        old = exe + ".old"
        try:
            if os.path.exists(old):
                os.unlink(old)
        except OSError:
            pass
        # Windows lets a running executable be renamed but not overwritten; POSIX allows both.
        # Rename first, then move the new file in, so a crash between the two leaves the old
        # binary recoverable at `.old` rather than nothing at all.
        if os.path.exists(exe):
            os.replace(exe, old)
        os.replace(got.path, exe)
        version = decision.release.version
        _record(client, "update_applied", version)
        return InstallOutcome("restart-required", path=exe, version=version)

    def rollback(self) -> bool:  # type: ignore[override]
        exe = self.executable
        if not exe or not os.path.exists(exe + ".old"):
            return False
        try:
            bad = exe + ".bad"
            if os.path.exists(exe):
                os.replace(exe, bad)
            os.replace(exe + ".old", exe)
            try:
                os.unlink(bad)
            except OSError:
                pass
            return True
        except OSError:
            return False


# ── Velopack ─────────────────────────────────────────────────────────────────────────
class VelopackDriver(InstallDriver):
    """Drive Velopack's ``UpdateManager`` over the product's Velopack feed.

    ``velopack_channel`` is the channel the app was packed with (``win-x64``, ``osx-arm64``,
    ``linux-x64``…). ``restart`` (default ``True``) applies and restarts at once
    (``handed-off``); ``False`` waits for the app to exit and then applies
    (``restart-required``). ``manager_factory(url, channel)`` builds the manager; the default
    imports the ``velopack`` package (``pip install velopack``).

    Licensed or entitled delivery: Velopack fetches the package itself and does not carry the
    device bearer; a product that gates its app bytes needs the Worker's Velopack route to serve
    them (S-11 §5.2; parity pass wire item W9)."""

    def __init__(
        self,
        velopack_channel: str,
        *,
        restart: bool = True,
        manager_factory: Optional[Callable[[str, str], Any]] = None,
    ) -> None:
        self.velopack_channel = velopack_channel
        self.restart = restart
        self._factory = manager_factory

    def _manager(self, url: str) -> Any:
        if self._factory is not None:
            return self._factory(url, self.velopack_channel)
        import velopack  # type: ignore[import-not-found]

        opts = velopack.UpdateOptions()
        try:
            opts.ExplicitChannel = self.velopack_channel
        except Exception:
            pass
        return velopack.UpdateManager(url, opts)

    def install(self, client, decision, *, on_progress=None):  # type: ignore[no-untyped-def]
        from ..core.caps import Unsupported

        if decision.action not in ("binary", "code-ready"):
            return unsupported(UnsupportedReason.OUTLET, f"a {decision.action} decision is not a Velopack update")
        feed = client.update.feed_url("velopack", velopack_channel=self.velopack_channel)
        if isinstance(feed, Unsupported):
            return unsupported(feed.reason, feed.detail or "no Velopack feed")
        # Velopack wants the folder that holds `releases.<channel>.json`.
        parts = urlsplit(feed)
        folder = urlunsplit((parts.scheme, parts.netloc, parts.path.rsplit("/", 1)[0] + "/", "", ""))
        try:
            manager = self._manager(folder)
        except ImportError:
            return unsupported(UnsupportedReason.DEPENDENCY, "the velopack package is not installed")
        info = manager.check_for_updates()
        if not info:
            return unsupported(UnsupportedReason.PRODUCT, "the Velopack feed offers no newer package")
        version = decision.release.version if decision.release is not None else None

        def progress(pct: Any) -> None:
            if on_progress is not None:
                try:
                    on_progress(int(pct), 100)
                except Exception:
                    pass

        try:
            manager.download_updates(info, progress)
        except TypeError:
            manager.download_updates(info)
        if version:
            _record(client, "update_downloaded", version)
            _record(client, "update_applied", version)
        if self.restart:
            manager.apply_updates_and_restart(info)
            return InstallOutcome("handed-off", version=version)
        manager.wait_exit_then_apply_updates(info)
        return InstallOutcome("restart-required", version=version)
