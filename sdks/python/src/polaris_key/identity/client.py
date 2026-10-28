"""The Identity sub-client: sign-in, and the account verbs.

* :attr:`IdentityClient.sign_in` ``.start(**opts)`` begins a sign-in and answers a
  :class:`~polaris_key.identity.sign_in.SignInSession` (device code, RFC 8628, for hosts that
  cannot complete a browser redirect: a CLI, a daemon, a game console, a kiosk). The session's
  ``wait()`` paces the polls; ``once=True`` polls exactly once. ``channel="redirect"`` answers a
  :class:`~polaris_key.identity.redirect.RedirectSession` (a host-supplied https redirect URI,
  ``complete(callback_url)``); its ``choose`` outcome is finished with :attr:`IdentityClient.choice`.

A ``ready`` poll stores the device token through Core's token manager and raises the same
acquisition event activation does, so the facade's forced sync runs exactly as it would
after ``license.activate_with_key()``, then reads and stores the account subject.

A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else. The
Worker's callback merges nothing (P1-06): a device on an anonymous enrolled licence is not
attached to the account by signing in, and nothing here offers or implies that it is.
The account verbs (``subject``, ``sign_out``, ``open_account``, ``attach``) live in
:mod:`polaris_key.identity.account`. Mirrors ``@polaris-key/node``'s ``identity/client.ts``.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from .account import (
    Account,
    AttachResult,
    BeforeSignOutHooks,
    OpenAccountResult,
    SignOutResult,
)
from .sign_in import (
    SLOW_DOWN_STEP_SECONDS,
    SignedInIdentity,
    SignInDeps,
    SignInNamespace,
    SignInSession,
    start_device_code,
)
from .choice import ChoiceClient
from .redirect import RedirectSession, start_redirect_sign_in
from ..core.context import CoreContext
from ..core.token import TokenManager

__all__ = [
    "ChoiceClient",
    "IdentityClient",
    "SignedInIdentity",
    "SignInNamespace",
    "SignInSession",
    "SLOW_DOWN_STEP_SECONDS",
]


class IdentityClient:
    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        on_acquired: Callable[[], None],
        *,
        profile: Optional[Callable[[], Any]] = None,
        discover: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        wipe_local: Optional[Callable[[], None]] = None,
        open_url: Optional[Callable[[str], bool]] = None,
        loaded_discovery: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        license_id: Optional[Callable[[], Optional[str]]] = None,
        emit: Optional[Callable[..., Any]] = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._on_acquired = on_acquired
        self._profile = profile
        #: The identity the last ``ready`` poll showed (this process).
        self._identity: Optional[SignedInIdentity] = None
        self._before_sign_out = BeforeSignOutHooks()
        self._account = Account(
            ctx,
            tokens,
            discover=discover or (lambda: None),
            hooks=self._before_sign_out,
            forget=self.forget,
            wipe_local=wipe_local or tokens.clear,
            open_url=open_url or _open_in_browser,
            emit=emit,
        )
        self._deps = SignInDeps(
            ctx,
            tokens,
            discovery=loaded_discovery or (lambda: None),
            on_acquired=on_acquired,
            store_identity=self._store_identity,
            fetch_subject=self._account.fetch_subject,
            license_id=license_id or (lambda: None),
            open_url=open_url or _open_in_browser,
            emit=emit or (lambda *a, **k: None),
            load_discovery=discover,
            write_subject=self._account.write_subject,
        )
        self._sign_in = SignInNamespace(self._start_sign_in, self._start_redirect)
        self._choice = ChoiceClient(self._deps)

    def _store_identity(self, who: Optional[SignedInIdentity]) -> None:
        self._identity = who

    def _start_sign_in(self, **opts: Any) -> SignInSession:
        return start_device_code(self._deps, **opts)

    def _start_redirect(self, **opts: Any) -> RedirectSession:
        return start_redirect_sign_in(self._deps, **opts)

    @property
    def choice(self) -> ChoiceClient:
        """``identity.choice.licenses/devices/complete/cancel``: the licence choice an app shows
        itself after a redirect sign-in settled ``choose`` (``license_choice="app"``). Each call
        raises the typed ``service-unavailable`` N/A when the product's discovery names no choice
        endpoint."""
        return self._choice

    @property
    def sign_in(self) -> SignInNamespace:
        """``identity.sign_in.start(**opts)``: begin a sign-in, answering a
        :class:`SignInSession`. Identity off: ``start`` raises ``service-unavailable`` before
        any request."""
        return self._sign_in

    def current(self) -> Optional[Dict[str, Any]]:
        """Who this device is signed in as: ``{"name", "email", "activatedAt"}`` from the
        verified licence document's signed profile when the token came from a sign-in, else
        the identity this process's sign-in showed; ``None`` when the device is not signed in."""
        if self._tokens.current is None:
            return None
        source = getattr(self._tokens, "source", None)
        profile = self._profile() if self._profile is not None else None
        if source == "signin" and profile is not None:
            return {
                "name": getattr(profile, "name", None),
                "email": getattr(profile, "email", None),
                "activatedAt": getattr(profile, "activatedAt", None),
            }
        if self._identity is not None:
            return {"name": self._identity.name, "email": self._identity.email, "activatedAt": None}
        return None

    def forget(self) -> None:
        """Forget the stored identity and subject (the facade calls it on every deactivation).
        The token and the licence are not touched."""
        self._identity = None
        self._account.forget_subject()

    def on_before_sign_out(self, hook: Callable[[], Any]) -> Callable[[], None]:
        """Register a function ``sign_out()`` calls first (Cloud Sync's flush registers one);
        returns its remover. A hook that raises stops the sign-out."""
        return self._before_sign_out.add(hook)

    def subject(self) -> Optional[str]:
        """The pairwise subject of the account signed in on this device, or ``None``
        (persisted, so it survives a restart). Raises the typed unsupported result when the
        product's discovery names no subject endpoint."""
        return self._account.subject()

    def sign_out(self) -> SignOutResult:
        """Sign out of the account (``POST signout``) after the pre-sign-out hooks. The device
        token goes only when the server released the device (``released=True``); a key-activated
        device keeps its licence and token."""
        return self._account.sign_out()

    def open_account(self) -> OpenAccountResult:
        """Open the product's account page in the browser."""
        return self._account.open_account()

    def attach(self, confirm: bool) -> AttachResult:
        """``attach(confirm=False)`` previews the device's licence; ``attach(confirm=True)``
        adds it to the signed-in account and rotates the token. A refusal is an
        :class:`~polaris_key.identity.account.AttachRefused`, never an auth failure."""
        return self._account.attach(confirm)


def _open_in_browser(url: str) -> bool:
    import webbrowser

    try:
        return bool(webbrowser.open(url))
    except Exception:
        return False
