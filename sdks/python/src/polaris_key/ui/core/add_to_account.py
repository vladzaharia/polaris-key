"""``AddToAccountModel``: the state machine behind AddToAccount (UK-43.16).

A port of ``@polaris-key/ui-core``'s ``addToAccountModel.ts``. A license that a key activated is
floating; this adds it to an account. The person types a name and an email (they live only here,
never in the views' input), the browser confirms the email, and the license is attached::

    form -> busy -> added | owned | email-bound | other-account | failed   (invalid: a field is wrong)

The model runs over :class:`AddToAccountDriver`, three calls both gates implement over their SDK
primitives (:func:`driver_of`): sign in with the hints, keep this device's license, attach. A
sign-in that ends ``signedIn`` with no choice goes straight to attach, after a preview that writes
nothing. The hints only prefill the page: nothing here sends a code. ``attach`` carries no address;
the kit shows the account's email masked itself.

The calls block, so a host runs :meth:`AddToAccountModel.submit` off its UI thread; :meth:`cancel`
may be called from any thread while it runs (the late answer of the cancelled attempt is dropped).
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional

from ...constants_generated import ErrorCode
from ...core.errors import PolarisError
from .format import mask_email
from .ui_contract import context_of
from .ui_holders import add_to_account_view
from .ui_view import View

__all__ = [
    "AddToAccountDriver",
    "AddToAccountHints",
    "AddToAccountModel",
    "AddToAccountSnapshot",
    "AttachOutcome",
    "ChoiceComplete",
    "SignInWait",
    "driver_of",
]

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


@dataclass(frozen=True)
class AddToAccountHints:
    """The hints the sign-in carries: the typed email and name, and the purpose."""

    login_hint: str
    name_hint: str
    purpose: str = "attach"


@dataclass(frozen=True)
class SignInWait:
    """One answer of a sign-in's wait. ``outcome`` is ``pending``, ``signedIn`` (``email`` when the
    sign-in named it), ``choose`` (``grant``), ``cancelled`` or ``expired``."""

    outcome: str
    grant: Optional[str] = None
    email: Optional[str] = None


@dataclass(frozen=True)
class ChoiceComplete:
    """``outcome`` is ``signedIn`` when the choice completed; anything else is a failure."""

    outcome: str = "signedIn"


@dataclass(frozen=True)
class AttachOutcome:
    """``kind`` is ``ok`` or ``refused`` (``code`` is the wire code)."""

    kind: str = "ok"
    code: Optional[str] = None


class AddToAccountDriver:
    """The narrow interface both gates implement. ``sign_in`` answers a handle with ``wait()``
    (a :class:`SignInWait`), ``reopen()``, ``cancel()`` and, when the sign-in has one, ``user_code``."""

    def sign_in(self, hints: AddToAccountHints) -> Any:  # pragma: no cover - interface
        raise NotImplementedError

    def complete(self, grant: str, choice: Mapping[str, Any]) -> ChoiceComplete:  # pragma: no cover
        """Keep this device's license in the signed-in account (``{"kind": "keep"}``)."""
        raise NotImplementedError

    def attach(self, confirm: bool = True) -> Any:  # pragma: no cover - interface
        """``confirm=False`` previews (nothing is written); the default writes."""
        raise NotImplementedError


@dataclass
class AddToAccountSnapshot:
    step: str = "form"
    #: ``invalid``: the field to fix, ``name``, ``email`` or ``both``.
    field: Optional[str] = None
    #: ``other-account``: both emails, masked (never the full address).
    typed_email: Optional[str] = None
    signed_email: Optional[str] = None
    name: str = ""
    email: str = ""
    #: ``busy``: the code the person checks against the one Polaris Locker shows, when the sign-in
    #: has one.
    user_code: Optional[str] = None


class AddToAccountModel:
    """The state machine; see the module docstring."""

    def __init__(
        self,
        driver: Optional[AddToAccountDriver] = None,
        base: Optional[Mapping[str, Any]] = None,
        device_kind: Optional[str] = None,
        on_change: Optional[Callable[[AddToAccountSnapshot], None]] = None,
    ) -> None:
        self._driver = driver
        #: Everything else the views read (identity, platform, services, ``licenseHolder``).
        self.base: Mapping[str, Any] = base or {}
        self._device_kind = device_kind
        self._on_change = on_change
        self._state = AddToAccountSnapshot()
        self._lock = threading.RLock()
        self._handle: Any = None
        # Bumped when an attempt ends, so a late answer from an old one is dropped.
        self._epoch = 0
        # The account sign-in finished: Try again then attaches again, with no second sign-in.
        self._signed_in = False
        # The email of the account that signed in, when the sign-in named it.
        self._signed_email: Optional[str] = None

    # -- state --

    @property
    def snapshot(self) -> AddToAccountSnapshot:
        with self._lock:
            return AddToAccountSnapshot(**self._state.__dict__)

    def _update(self, **changes: Any) -> None:
        with self._lock:
            for key, value in changes.items():
                setattr(self._state, key, value)
            state = AddToAccountSnapshot(**self._state.__dict__)
        if self._on_change is not None:
            self._on_change(state)

    def input(self) -> Dict[str, Any]:
        """The views' input: the base with the step on top. Name and email are not in it."""
        s = self.snapshot
        out: Dict[str, Any] = dict(self.base)
        if s.step == "busy" and s.user_code:
            out["deviceCode"] = {"phase": "waiting", "userCode": s.user_code}
        a: Dict[str, Any] = {"step": s.step}
        if s.field:
            a["field"] = s.field
        if s.step == "other-account" and s.typed_email:
            a["typedEmail"] = s.typed_email
        if s.step == "other-account" and s.signed_email:
            a["signedEmail"] = s.signed_email
        if self._device_kind:
            a["deviceKind"] = self._device_kind
        out["addToAccount"] = a
        return out

    def view(self) -> View:
        return add_to_account_view(context_of(self.input()))

    def set_field(self, field: str, value: str) -> None:
        """The person typed in a field (``name`` or ``email``); an ``invalid`` step goes back to
        ``form``."""
        if field not in ("name", "email"):
            raise ValueError("field is name or email")
        with self._lock:
            if self._state.step == "busy":
                return
            changes: Dict[str, Any] = {field: value}
            if self._state.step == "invalid":
                changes.update(step="form", field=None)
        self._update(**changes)

    @property
    def will_open_browser(self) -> bool:
        """True when Continue (or Try again) would start the browser sign-in right now: the fields
        are valid and no sign-in has finished. A gate arms its tab inside the press only then."""
        s = self.snapshot
        if s.step in ("busy", "other-account"):
            return False
        return s.name.strip() != "" and bool(_EMAIL.match(s.email.strip())) and not self._signed_in

    # -- actions --

    def submit(self) -> None:
        """Continue: check the fields, then sign in and attach."""
        s = self.snapshot
        if s.step == "busy":
            return
        name, email = s.name.strip(), s.email.strip()
        bad_name, bad_email = name == "", not _EMAIL.match(email)
        if bad_name or bad_email:
            self._update(step="invalid", field="both" if bad_name and bad_email else "name" if bad_name else "email")
            return
        self._run(name, email)

    def try_again(self) -> None:
        """Try again after ``failed``: the same attempt, kept fields included."""
        step = self.snapshot.step
        # A different account signed in: back to the form, the fields kept, to sign in again.
        if step == "other-account":
            self.cancel()
            return
        if step != "failed":
            return
        self.submit()

    def reopen(self) -> None:
        """Bring the browser tab back while the sign-in runs. Call it inside the press."""
        handle = self._handle
        if handle is not None:
            try:
                handle.reopen()
            except Exception:
                pass

    def cancel(self) -> None:
        """Cancel: back to the form with the fields kept, any sign-in in flight let go."""
        with self._lock:
            handle = self._handle
            self._end()
            self._signed_in = False
            self._signed_email = None
        self._update(step="form", field=None, user_code=None, typed_email=None, signed_email=None)
        if handle is not None:
            _quietly(handle.cancel)

    # -- the attempt --

    def _end(self) -> None:
        self._epoch += 1
        self._handle = None

    def _set(self, step: str, epoch: int) -> None:
        with self._lock:
            if epoch != self._epoch:
                return
        self._update(step=step, field=None, user_code=None)

    def _current(self, epoch: int) -> bool:
        with self._lock:
            return epoch == self._epoch

    def _run(self, name: str, email: str) -> None:
        driver = self._driver
        if driver is None:
            raise RuntimeError("ui-core AddToAccountModel: no driver")
        # Try again lets the previous sign-in go before it starts another.
        with self._lock:
            prev = self._handle
            self._end()
            epoch = self._epoch
        if prev is not None:
            _quietly(prev.cancel)
        self._update(step="busy", field=None, user_code=None)
        try:
            if not self._signed_in and not self._sign_in(driver, name, email, epoch):
                return
            if not self._current(epoch):
                return
            self._signed_in = True
            # Preview first: nothing is written until the account is the one the person typed.
            preview = driver.attach(False)
            if not self._current(epoch):
                return
            if preview.kind == "refused":
                if preview.code == "account_required":
                    self._signed_in = False
                self._set(_step_of(preview), epoch)
                return
            signed = self._signed_email
            if signed is not None and signed.strip().lower() != email.lower():
                # A different account signed in than the email typed: the license is added nowhere,
                # and Try again goes back to the form. Both emails are shown masked, never in full.
                self._signed_in = False
                if self._current(epoch):
                    self._update(
                        step="other-account",
                        field=None,
                        typed_email=mask_email(email),
                        signed_email=mask_email(signed),
                    )
                return
            result = driver.attach(True)
            if not self._current(epoch):
                return
            # No account session after all: Try again signs in again.
            if result.kind == "refused" and result.code == "account_required":
                self._signed_in = False
            self._set(_step_of(result), epoch)
        except Exception:
            self._set("failed", epoch)

    def _sign_in(self, driver: AddToAccountDriver, name: str, email: str, epoch: int) -> bool:
        """True when the account sign-in ended signed in; otherwise the step is already set."""
        handle = driver.sign_in(AddToAccountHints(login_hint=email, name_hint=name, purpose="attach"))
        if not self._current(epoch):
            _quietly(handle.cancel)
            return False
        with self._lock:
            self._handle = handle
        user_code = getattr(handle, "user_code", None)
        if user_code:
            self._update(user_code=user_code)
        while True:
            r = handle.wait()
            if not self._current(epoch):
                return False
            if r.outcome == "pending":
                continue
            if r.outcome == "signedIn":
                self._signed_email = r.email
                # Settled: nothing left to cancel on Try again.
                with self._lock:
                    self._handle = None
                return True
            if r.outcome == "choose":
                done = driver.complete(r.grant or "", {"kind": "keep"})
                if not self._current(epoch):
                    return False
                if done.outcome == "signedIn":
                    self._signed_email = None
                    return True
                self._set("failed", epoch)
                return False
            if r.outcome == "cancelled":
                self._set("form", epoch)
                return False
            # expired, or anything unknown.
            self._set("failed", epoch)
            return False


def _step_of(result: Any) -> str:
    """The step an attach answer lands on."""
    if result.kind == "ok":
        return "added"
    if result.code == "license_owned":
        return "owned"
    if result.code == "license_email_bound":
        return "email-bound"
    # ``account_required`` and anything else: Try again.
    return "failed"


def _quietly(fn: Callable[[], Any]) -> None:
    try:
        fn()
    except Exception:
        pass


class _Handle:
    """A running SDK sign-in as the model sees it: ``wait`` answers :class:`SignInWait`."""

    def __init__(self, session: Any) -> None:
        self._session = session
        self.user_code: Optional[str] = getattr(session, "user_code", None)

    def wait(self) -> SignInWait:
        o = self._session.wait()
        kind = o.kind
        if kind == "signed_in":
            ident = getattr(o, "identity", None)
            email = getattr(ident, "email", None)
            return SignInWait("signedIn", email=email if isinstance(email, str) and email else None)
        if kind == "choose":
            return SignInWait("choose", grant=o.grant)
        if kind in ("cancelled", "expired", "pending"):
            return SignInWait(kind)
        # An outcome this model does not handle (activated, ...) is a failed attempt.
        return SignInWait("expired")

    def reopen(self) -> Any:
        return self._session.reopen()

    def cancel(self) -> None:
        self._session.cancel()


class _SdkDriver(AddToAccountDriver):
    def __init__(self, identity: Any) -> None:
        self._identity = identity

    def sign_in(self, hints: AddToAccountHints) -> _Handle:
        opts: Dict[str, Any] = {
            "login_hint": hints.login_hint,
            "name_hint": hints.name_hint,
            "purpose": hints.purpose,
            "license_choice": "app",
        }
        start = self._identity.sign_in.start
        try:
            # The SDK picks the redirect: loopback, a registered scheme, or a claimed HTTPS link.
            session = start(channel="redirect", **opts)
        except PolarisError as e:
            if e.code != ErrorCode.REDIRECT_UNAVAILABLE:
                raise
            # Headless, or no class applies: the person confirms a code instead (nothing was sent).
            session = start(channel="device-code", **opts)
        return _Handle(session)

    def complete(self, grant: str, choice: Mapping[str, Any]) -> ChoiceComplete:
        result = self._identity.choice.complete(grant, dict(choice))
        return ChoiceComplete("signedIn" if getattr(result, "kind", None) == "ok" else "refused")

    def attach(self, confirm: bool = True) -> Any:
        return self._identity.attach(confirm)


def driver_of(identity: Any) -> AddToAccountDriver:
    """The driver over ``client.identity``: sign in with channel ``redirect`` and no redirect URI
    (the SDK picks the platform's), falling back to a device code where the redirect is
    unavailable; keep with ``identity.choice.complete``; attach with ``identity.attach``."""
    return _SdkDriver(identity)
