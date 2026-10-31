"""The Identity sub-client: sign-in, and the account verbs.

* :attr:`IdentityClient.sign_in` ``.start(**opts)`` begins a sign-in and answers a
  :class:`~polaris_key.identity.sign_in.SignInSession` (device code, RFC 8628, for hosts that
  cannot complete a browser redirect: a CLI, a daemon, a game console, a kiosk). The session's
  ``wait()`` paces the polls; ``once=True`` polls exactly once. ``channel="redirect"`` answers a
  :class:`~polaris_key.identity.redirect.RedirectSession` (a host-supplied https redirect URI,
  ``complete(callback_url)``); its ``choose`` outcome is finished with :attr:`IdentityClient.choice`.

* :meth:`IdentityClient.auto_sign_in` answers whether this device already holds a sign-in (rung 1 of the
  automatic ladder; :mod:`polaris_key.identity.auto_sign_in`), and :attr:`IdentityClient.nearby`
  ``.available(role=...)`` whether nearby sign-in can run here.

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

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
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
from .auto_sign_in import (
    AutoSignInNeedsSignIn,
    AutoSignInResult,
    AutoSignInSignedIn,
    AutoSignInUnavailable,
    NearbyNamespace,
    run_auto_sign_in,
)
from .choice import ChoiceClient
from .nearby import NearbyCredentials, NearbyRoutes
from .nearby_approver import start_nearby_approver
from .nearby_session import NearbyDeps, NearbySignInSession, start_nearby_sign_in
from .redirect import RedirectSession, start_redirect_sign_in
from ..core.context import CoreContext
from ..core.token import TokenManager

__all__ = [
    "AutoSignInNeedsSignIn",
    "AutoSignInResult",
    "AutoSignInSignedIn",
    "AutoSignInUnavailable",
    "ChoiceClient",
    "NearbyNamespace",
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
        on_forget: Optional[Callable[[], Any]] = None,
        nearby_runtime: Optional[Callable[[str], bool]] = None,
        refresh_discovery: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        register_nearby_keys: Optional[Callable[[NearbyCredentials], None]] = None,
        nearby_signer: Optional[Callable[[], Any]] = None,
        cloud_nearby: Optional[Callable[[], Any]] = None,
        keyring: Optional[Callable[[], Any]] = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._on_acquired = on_acquired
        self._profile = profile
        #: The identity the last ``ready`` poll showed (this process).
        self._identity: Optional[SignedInIdentity] = None
        self._before_sign_out = BeforeSignOutHooks()
        #: Runs after the identity is forgotten (the facade drops the key ring's root and pin).
        self._on_forget: Callable[[], Any] = on_forget or (lambda: None)
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
        self._sign_in = SignInNamespace(self._start_sign_in, self._start_redirect, self._start_nearby_sign_in)
        self._choice = ChoiceClient(self._deps)
        self._discover = discover or (lambda: None)
        self._license_id = license_id or (lambda: None)
        self._nearby = NearbyNamespace(ctx, self._discover, nearby_runtime, self._start_nearby_approver)
        self._nearby_signer = nearby_signer
        self._cloud_nearby = cloud_nearby
        self._keyring = keyring
        self._nearby_runtime = nearby_runtime
        #: The nearby route client (``nearby/start``, ``poll``, ``approve``): the session (D) and the
        #: approver (M) of later slices drive it; a host does not call it.
        self._nearby_routes = NearbyRoutes(
            self._deps, refresh_discovery=refresh_discovery, register_keys=register_nearby_keys
        )

    def _nearby_credentials(self) -> NearbyCredentials:
        """D's (and M's) device id, key port and bearer for the nearby routes."""
        if self._nearby_signer is None:
            raise UnsupportedError(
                Unsupported(
                    Feature.IDENTITY_NEARBY,
                    UnsupportedReason.RUNTIME,
                    "this client has no device keys for nearby sign-in",
                ),
                ErrorCode.NEARBY_UNSUPPORTED,
            )
        port, device_id = self._nearby_signer()
        return NearbyCredentials(device_id=device_id, keys=port, token=self._tokens.current)

    def _start_nearby_sign_in(self, **opts: Any) -> NearbySignInSession:
        nearby = self._cloud_nearby
        deps = NearbyDeps(
            routes=self._nearby_routes,
            creds=self._nearby_credentials,
            nearby=nearby if nearby is not None else (lambda: None),
            supported=lambda role: self._nearby_runtime is not None
            and nearby is not None
            and bool(self._nearby_runtime(role)),
            keyring=self._keyring,
            sign_out=self.sign_out,
            confirm=self._confirm_nearby,
            drop_local=self._drop_nearby,
        )
        return start_nearby_sign_in(deps, self._deps, **opts)

    def _confirm_nearby(self, subject: str) -> None:
        """The person confirmed the nearby account: the token is a sign-in (the explicit sign-out ends),
        the subject is stored and the event goes out, so Cloud Sync and Connect start now and not before
        (V5 §12.11.5 rule 9)."""
        self._tokens.confirm_sign_in()
        self._account.write_subject(subject)
        self._deps.emit("identity", change="signed_in", subject=subject)

    def _drop_nearby(self) -> None:
        """An unconfirmed nearby sign-in ended: the token, its mark and the stored identity go, whatever
        the Worker answered to the sign-out."""
        self._tokens.clear()
        self.forget()

    def _start_nearby_approver(self, handler: Callable[[Any], None], **opts: Any) -> Any:
        nearby = self._cloud_nearby() if self._cloud_nearby is not None else None
        if nearby is None or self._nearby_runtime is None or not self._nearby_runtime("approver"):
            raise UnsupportedError(
                Unsupported(
                    Feature.IDENTITY_NEARBY,
                    UnsupportedReason.RUNTIME,
                    "this runtime cannot advertise to nearby devices",
                ),
                ErrorCode.NEARBY_UNSUPPORTED,
            )
        if "label" not in opts:
            # This device's name in the other device's list (§12.7.1); never an account identifier.
            opts["label"] = self._ctx.device_label(None) or None
        return start_nearby_approver(
            nearby=nearby,
            routes=self._nearby_routes,
            creds=self._nearby_credentials,
            handler=handler,
            keyring=self._keyring,
            **opts,
        )

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
    def nearby(self) -> NearbyNamespace:
        """``client.identity.nearby.available(role=...)``: whether nearby sign-in can run on this device
        (see :class:`~polaris_key.identity.auto_sign_in.NearbyNamespace`)."""
        return self._nearby

    def auto_sign_in(self, options: Optional[Dict[str, Any]] = None) -> AutoSignInResult:
        """The automatic sign-in ladder: ``AutoSignInSignedIn`` when this device holds a sign-in and
        a licence (rung 1, no network), ``AutoSignInNeedsSignIn`` (``signed_out`` after an explicit
        sign-out, else ``no_credential``) or ``AutoSignInUnavailable`` when Identity is off. Python
        has no platform identity, so the platform rungs do not exist and ``options`` is accepted for
        parity and ignored. Never raises for a missing session. The regular form is
        :attr:`sign_in`."""
        return run_auto_sign_in(
            self._ctx,
            self._tokens,
            self._account,
            license_id=self._license_id,
            discover=self._discover,
        )

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
        self._on_forget()

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
