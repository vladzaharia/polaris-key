"""The account verbs (identity.account, identity.attach; WIRE-CONTRACT-V4 §12.3, §12.6):
``subject()``, ``sign_out()``, ``open_account()`` and ``attach(confirm=...)``.
Mirrors ``@polaris-key/node``'s ``identity/account.ts`` and Swift's ``IdentityAccount.swift``.

Each call reads the endpoint it needs from discovery's Identity fragment (loaded on first use)
and never builds one. A product whose fragment names no such endpoint answers the typed
unsupported result (:class:`~polaris_key.core.caps.UnsupportedError`, reason ``product``, code
``service-unavailable``) before any request. An endpoint on another origin or product is
refused rather than followed: the device token goes only to the Worker that issued it.

The subject is persisted beside the identity (``subject.json`` in the state directory, in memory
when the client keeps no state), so it survives a restart; the sign-in flows write it on
``ready`` and :meth:`Account.forget` removes it. :meth:`Account.sign_out` runs the pre-sign-out
hooks first (Cloud Sync's flush registers one), then ``POST signout``; only ``released: true``
drops the device token, because only then did the server stop counting the device. A refused or
failed sign-out changes nothing local. A refused ``attach`` is a typed result, never a thrown
auth failure, and keeps the token, the cache and the identity.
"""

from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import httpx

from ..constants_generated import PAIRWISE_SUBJECT_PATTERN, ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.context import CoreContext, refusal_error, wire_code_of
from ..core.errors import PolarisError
from ..core.local_state import JsonStateFile
from ..core.manage import is_manage_url
from ..core.token import TokenManager

__all__ = [
    "Account",
    "AttachConfirm",
    "AttachLicense",
    "AttachOk",
    "AttachRefused",
    "AttachResult",
    "BeforeSignOutHooks",
    "OpenAccountResult",
    "SignOutResult",
    "identity_fragment_from",
]

_SUBJECT = re.compile(PAIRWISE_SUBJECT_PATTERN)


def _is_subject(v: Any) -> bool:
    return isinstance(v, str) and _SUBJECT.match(v) is not None


@dataclass(frozen=True)
class SignOutResult:
    """``identity.sign_out()``: whether the server released the device (the token then stopped
    working). ``False`` for a key-activated device, which keeps its licence and token."""

    released: bool


@dataclass(frozen=True)
class OpenAccountResult:
    """``identity.open_account()``: the portal page and whether the host's opener ran."""

    url: str
    opened: bool


@dataclass(frozen=True)
class AttachLicense:
    """The licence an ``attach(confirm=False)`` preview names."""

    id: str
    tierId: Optional[str] = None
    name: Optional[str] = None


@dataclass(frozen=True)
class AttachConfirm:
    """``confirm=False``: the device's own licence, written nowhere."""

    license: AttachLicense
    kind: str = "confirm"


@dataclass(frozen=True)
class AttachOk:
    """``confirm=True``: the licence is in the signed-in account, the token rotated and stored.
    ``attached`` is ``"claimed"`` when this call put it there, ``None`` when it already was. The
    caller syncs, as after ``activate``."""

    subject: Optional[str] = None
    attached: Optional[str] = None
    kind: str = "ok"


@dataclass(frozen=True)
class AttachRefused:
    """The Worker refused (``account_required``, ``license_owned``, ``license_email_bound``,
    ``unauthorized``, ``not_found``, ...). Nothing local changed. ``code`` is the wire code."""

    code: str
    status: int
    kind: str = "refused"


AttachResult = Any  # Union of the three above; kept loose for 3.9 compatibility.


def identity_fragment_from(manifest: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The Identity fragment of a discovery document (WIRE-CONTRACT-V4 §12.6), or ``None``
    while Identity is off or absent. Endpoints are kept only when they are non-empty strings: a
    client uses an endpoint the document names and never builds one. ``account``,
    ``keyEntryLimit`` and ``issuer`` are read the same way (anything malformed is dropped)."""
    services = manifest.get("services") if isinstance(manifest, dict) else None
    raw = services.get("identity") if isinstance(services, dict) else None
    if not isinstance(raw, dict) or raw.get("enabled") is not True:
        return None
    endpoints: Dict[str, str] = {}
    if isinstance(raw.get("endpoints"), dict):
        for k, v in raw["endpoints"].items():
            if isinstance(v, str) and v != "":
                endpoints[k] = v
    out: Dict[str, Any] = {
        "enabled": True,
        "configured": raw.get("configured") is not False,
        "endpoints": endpoints,
    }
    if isinstance(raw.get("issuer"), str) and raw["issuer"]:
        out["issuer"] = raw["issuer"]
    if raw.get("account") is True:
        out["account"] = True
    limit = raw.get("keyEntryLimit")
    if isinstance(limit, int) and not isinstance(limit, bool) and limit >= 1:
        out["keyEntryLimit"] = limit
    return out


class BeforeSignOutHooks:
    """The functions ``sign_out()`` calls before it signs out, in registration order. A hook
    that raises stops the sign-out: nothing was signed out."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hooks: List[Callable[[], Any]] = []

    def add(self, hook: Callable[[], Any]) -> Callable[[], None]:
        """Register a hook; returns its remover."""
        with self._lock:
            self._hooks.append(hook)

        def remove() -> None:
            with self._lock:
                try:
                    self._hooks.remove(hook)
                except ValueError:
                    pass

        return remove

    def run(self) -> None:
        with self._lock:
            hooks = list(self._hooks)
        for hook in hooks:
            hook()


class Account:
    """The account verbs. Constructed by :class:`~polaris_key.identity.client.IdentityClient`."""

    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        *,
        discover: Callable[[], Optional[Dict[str, Any]]],
        hooks: BeforeSignOutHooks,
        forget: Callable[[], None],
        wipe_local: Callable[[], None],
        open_url: Callable[[str], bool],
        emit: Optional[Callable[..., Any]] = None,
    ) -> None:
        self._ctx = ctx
        #: ``client.events.emit``: the ``identity`` event kind (signed out, subject changed).
        self._emit = emit
        self._tokens = tokens
        #: The discovery document: the loaded one, else loads it once.
        self._discover = discover
        self._hooks = hooks
        self._forget = forget
        self._wipe_local = wipe_local
        self._open_url = open_url
        state_dir = ctx.local_state_dir()
        self._file = JsonStateFile(
            os.path.join(state_dir, "subject.json") if state_dir else None, lambda: {}
        )

    # ── The stored subject ──────────────────────────────────────────────────────────
    def stored_subject(self) -> Optional[str]:
        """The persisted subject, or ``None``. A value that is not a pairwise subject reads as
        none."""
        v = self._file.load()
        s = v.get("subject") if isinstance(v, dict) else None
        return s if _is_subject(s) else None

    def write_subject(self, subject: Optional[str]) -> None:
        """Persist the subject (a sign-in's ``ready``, or :meth:`subject`); ``None`` removes it."""
        if subject is None:
            if self._file.path is None:
                self._file.save({})
            else:
                try:
                    os.unlink(self._file.path)
                except OSError:
                    pass
        else:
            self._file.save({"subject": subject})

    def forget_subject(self) -> None:
        self.write_subject(None)

    # ── Endpoints ───────────────────────────────────────────────────────────────────
    def _endpoint(self, name: str, *, scoped: bool = True) -> str:
        """The discovery endpoint, else the typed N/A. Nothing is dialled before this answers
        (bar discovery itself, loaded once when the session has none)."""
        doc = self._discover()
        self._ctx.require_service("identity", Feature.IDENTITY_ACCOUNT)
        fragment = identity_fragment_from(doc)
        url = fragment["endpoints"].get(name) if fragment else None
        if not url:
            raise UnsupportedError(
                Unsupported(
                    Feature.IDENTITY_ACCOUNT,
                    UnsupportedReason.PRODUCT,
                    f"this product's discovery names no identity {name} endpoint",
                ),
                ErrorCode.SERVICE_UNAVAILABLE,
            )
        if scoped and not url.startswith(self._ctx.url("")):
            raise PolarisError(
                ErrorCode.BAD_RESPONSE, "an identity endpoint points outside this product."
            )
        return url

    def _bearer(self) -> str:
        token = self._tokens.current
        if not token:
            raise PolarisError(
                ErrorCode.NO_TOKEN, "Activate or sign in before using the account."
            )
        return token

    def _call(
        self, method: str, url: str, token: str, body: Optional[Dict[str, Any]] = None
    ) -> httpx.Response:
        headers = {"authorization": f"Bearer {token}"}
        if body is not None:
            headers["content-type"] = "application/json"
        return self._ctx.request(
            method, url, headers=self._ctx.headers(headers), **({"json": body} if body is not None else {})
        )

    @staticmethod
    def _json(res: httpx.Response) -> Dict[str, Any]:
        try:
            b = res.json()
        except ValueError:
            return {}
        return b if isinstance(b, dict) else {}

    # ── The verbs ───────────────────────────────────────────────────────────────────
    def subject(self) -> Optional[str]:
        """The pairwise subject of the account signed in on this device, or ``None`` (a
        key-only device, or one with no token). The answer is persisted, so it survives a
        restart."""
        before = self.stored_subject()
        now = self.fetch_subject()
        if now != before and self._emit is not None:
            self._emit("identity", change="subject_changed", subject=now)
        return now

    def fetch_subject(self) -> Optional[str]:
        """Ask the Worker for the subject and persist the answer; no event (a sign-in raises its
        own)."""
        url = self._endpoint("subject")
        token = self._tokens.current
        if not token:
            self.write_subject(None)
            return None
        res = self._call("GET", url, token)
        if res.status_code != 200:
            raise refusal_error(res, "subject")
        body = self._json(res)
        if "subject" in body and body["subject"] is None:
            self.write_subject(None)
            return None
        v = body.get("subject")
        if not _is_subject(v):
            raise PolarisError(
                ErrorCode.BAD_RESPONSE, "the subject endpoint answered without a subject."
            )
        self.write_subject(v)
        return v  # type: ignore[no-any-return]

    def sign_out(self) -> SignOutResult:
        """Sign out: run the pre-sign-out hooks, ``POST signout``, then forget the identity. On
        ``released: true`` the device token, cache and licence state go too; on ``false`` (a
        key-only activation) the device keeps its licence and token. A refusal or failure
        raises and changes nothing."""
        url = self._endpoint("signout")
        token = self._tokens.current
        if not token:
            self._forget()
            return SignOutResult(released=False)
        self._hooks.run()
        res = self._call("POST", url, token)
        if res.status_code != 200:
            err = refusal_error(res, "sign-out")
            if err.code == ErrorCode.HTTP_ERROR:
                err = PolarisError(ErrorCode.SIGN_OUT_FAILED, str(err), status=res.status_code)
            raise err
        released = self._json(res).get("released")
        if not isinstance(released, bool):
            raise PolarisError(
                ErrorCode.BAD_RESPONSE, "the signout endpoint answered without `released`."
            )
        self._forget()
        if released:
            self._wipe_local()
        if self._emit is not None:
            self._emit("identity", change="signed_out", released=released)
        return SignOutResult(released=released)

    def open_account(self) -> OpenAccountResult:
        """Open the product's page in the customer portal (discovery's ``accountPortal``) in
        the host's browser."""
        url = self._endpoint("accountPortal", scoped=False)
        if not is_manage_url(url):
            raise UnsupportedError(
                Unsupported(
                    Feature.IDENTITY_ACCOUNT,
                    UnsupportedReason.PRODUCT,
                    "this product's discovery names no usable account portal link",
                ),
                ErrorCode.SERVICE_UNAVAILABLE,
            )
        return OpenAccountResult(url=url, opened=bool(self._open_url(url)))

    def attach(self, confirm: bool) -> AttachResult:
        """``POST identity/attach``. ``confirm=False`` previews the device's licence and writes
        nothing; ``confirm=True`` puts it in the signed-in account, rotates and stores the
        token. A refusal is a typed :class:`AttachRefused` that keeps every piece of state."""
        url = self._endpoint("attach")
        token = self._bearer()
        res = self._call("POST", url, token, {"confirm": bool(confirm)})
        if res.status_code != 200:
            return AttachRefused(
                code=wire_code_of(res) or f"http_{res.status_code}", status=res.status_code
            )
        body = self._json(res)
        if body.get("status") == "confirm":
            lic = body.get("license") if isinstance(body.get("license"), dict) else {}
            return AttachConfirm(
                license=AttachLicense(
                    id=lic.get("id") if isinstance(lic.get("id"), str) else "",
                    tierId=lic.get("tierId") if isinstance(lic.get("tierId"), str) else None,
                    name=lic.get("name") if isinstance(lic.get("name"), str) else None,
                )
            )
        new_token = body.get("token")
        if not isinstance(new_token, str) or not new_token:
            raise PolarisError(ErrorCode.BAD_RESPONSE, "attach answered without a token.")
        self._tokens.set(new_token, "activate")
        subject = body.get("subject") if _is_subject(body.get("subject")) else None
        before = self.stored_subject()
        self.write_subject(subject)
        if subject is not None and subject != before and self._emit is not None:
            self._emit("identity", change="subject_changed", subject=subject)
        return AttachOk(
            subject=subject, attached="claimed" if body.get("attached") == "claimed" else None
        )
