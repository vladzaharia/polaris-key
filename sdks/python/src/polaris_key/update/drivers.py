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
from urllib.parse import urlsplit

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
    """Velopack integration; automatic installation is currently disabled.

    The manager API cannot expose the exact applied bytes for signed-record verification.

    ``velopack_channel``, ``restart`` and ``manager_factory`` remain accepted for source
    compatibility. The factory is not called and no download, apply or journal event occurs.
    Feed discovery still returns its existing typed unsupported result when unavailable.
    """

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
        # The manager does not expose the exact package it applies. Feed checksums and
        # versions cannot substitute for authorization by the pinned release key.
        # Refuse before constructing a manager (checking may itself download bytes).
        return unsupported(
            UnsupportedReason.RUNTIME,
            "Velopack installation is disabled until the exact applied package can be verified "
            "against the pinned-key-signed release record (version, size and SHA-256).",
        )
