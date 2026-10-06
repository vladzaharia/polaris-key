"""The app build's boot guard (``update.bootguard``; SDK parity pass §3.15).

A launch counts as FAILED until the host confirms it: call :meth:`BootGuard.mark_boot_attempt`
at startup (``client.boot()`` does) and :meth:`BootGuard.confirm_boot` once the app is healthy
(``client.boot()`` does that ``BOOT_OK_SECONDS`` after a ``ready`` outcome, or at once for
``waiting``, ``blocked`` and ``offline``, per ``stage-matrix.json``'s ``bootConfirmation``).
After :data:`~polaris_key.core.stages.MAX_FAILED_BOOTS` unconfirmed launches of the same build,
:func:`~polaris_key.core.stages.boot_guard_action` answers ``roll-back``:

* when an install driver can roll back (``rollback`` returns ``True``: a Velopack previous
  version, a kept previous binary) it does so and the journal records ``update_reverted`` and
  ``boot_rolled_back``; the outcome is ``rolled-back`` and the host should restart;
* otherwise the journal records ``boot_rolled_back`` with code ``no-previous`` once, and the
  outcome is ``rollback-unavailable``: the host keeps running and can show it.

The first confirmed launch of a new build records ``update_confirmed`` (from the build it
replaced). The slots are a small JSON file in the state directory, beside the token store; they
are unsigned and only ever change what this device reports, never what it is granted.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ..core.local_state import JsonStateFile
from ..core.stages import boot_guard_action

__all__ = ["BootGuard", "BootGuardOutcome", "NO_PREVIOUS"]

#: The event code ``boot_rolled_back`` carries when nothing could be rolled back to.
NO_PREVIOUS = "no-previous"


@dataclass(frozen=True)
class BootGuardOutcome:
    """What :meth:`BootGuard.mark_boot_attempt` decided.

    ``result`` is the stage machine's ``guard.done`` value (``ok``, ``applied`` or
    ``rolled-back``); ``kind`` adds ``rollback-unavailable`` (N failures, nothing to roll back
    to: the result is ``ok`` and the host keeps running). ``failed_boots`` is the count of
    unconfirmed launches BEFORE this one."""

    kind: str
    result: str
    failed_boots: int
    version: str
    previous: Optional[str] = None


class BootGuard:
    def __init__(
        self,
        directory: Optional[str],
        version: Callable[[], str],
        *,
        journal: Any = None,
    ) -> None:
        self._file = JsonStateFile(
            os.path.join(directory, "boot-guard.json") if directory else None,
            lambda: {},
        )
        self._version = version
        self.journal = journal
        #: Rolls the app back to its previous build; ``True`` when it did (an install driver
        #: sets it). ``None``: nothing can be rolled back to.
        self.rollback: Optional[Callable[[], bool]] = None
        #: Whether a verified update is staged for the next launch (a driver sets it).
        self.staged: Callable[[], bool] = lambda: False

    def state(self) -> dict:
        s = self._file.load()
        return dict(s) if isinstance(s, dict) else {}

    def mark_boot_attempt(self) -> BootGuardOutcome:
        """Count this launch as unconfirmed and decide (``boot_guard_action``)."""
        running = self._version()
        s = self.state()
        if s.get("version") != running:
            # A new build is running: its own count starts now, and the one it replaced is
            # the rollback target and the `fromRelease` of its confirmation.
            previous = s.get("version") if isinstance(s.get("version"), str) else None
            s = {"version": running, "previous": previous, "failedBoots": 0, "confirmed": False}
        failed = s.get("failedBoots") if isinstance(s.get("failedBoots"), int) else 0
        staged = False
        try:
            staged = bool(self.staged())
        except Exception:
            staged = False
        action = boot_guard_action(staged=staged, failed_boots=failed)
        previous = s.get("previous") if isinstance(s.get("previous"), str) else None
        if action == "roll-back":
            done = False
            if self.rollback is not None:
                try:
                    done = bool(self.rollback())
                except Exception:
                    done = False
            if done:
                self._record("update_reverted", release=previous or running, from_release=running)
                self._record("boot_rolled_back", release=previous or running, from_release=running)
                s["failedBoots"] = 0
                self._file.save(s)
                return BootGuardOutcome("rolled-back", "rolled-back", failed, running, previous)
            if not s.get("noPreviousReported"):
                self._record("boot_rolled_back", release=running, code=NO_PREVIOUS)
                s["noPreviousReported"] = True
            s["failedBoots"] = failed + 1
            self._file.save(s)
            return BootGuardOutcome("rollback-unavailable", "ok", failed, running, previous)
        s["failedBoots"] = failed + 1
        self._file.save(s)
        if action == "apply-staged":
            return BootGuardOutcome("applied", "applied", failed, running, previous)
        return BootGuardOutcome("ok", "ok", failed, running, previous)

    def confirm_boot(self) -> bool:
        """This launch is healthy: reset the count, and record ``update_confirmed`` the first
        time a new build is confirmed. Returns whether this was that first confirmation."""
        running = self._version()
        s = self.state()
        if s.get("version") != running:
            s = {"version": running, "previous": None, "failedBoots": 0, "confirmed": False}
        first = not s.get("confirmed")
        s["failedBoots"] = 0
        s["confirmed"] = True
        s.pop("noPreviousReported", None)
        self._file.save(s)
        previous = s.get("previous") if isinstance(s.get("previous"), str) else None
        if first and previous and previous != running:
            self._record("update_confirmed", release=running, from_release=previous)
        return first

    def failed_boots(self) -> int:
        n = self.state().get("failedBoots")
        return n if isinstance(n, int) else 0

    def _record(self, event: str, **kw: Any) -> None:
        if self.journal is None:
            return
        try:
            self.journal.record(event, **kw)
        except Exception:
            pass

