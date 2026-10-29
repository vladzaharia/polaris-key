"""``identity.choice.*`` (I-10a.17; WIRE-CONTRACT-V4 §12.5.1): the licence choice an app shows
itself after ``sign_in.start(channel="redirect", license_choice="app")`` settled ``choose``.
Mirrors ``@polaris-key/node``'s ``identity/choice.ts`` and Kotlin's ``IdentityChoice.kt``.

* ``licenses(grant)``            the licences the account can run this device on (a view)
* ``devices(grant, license_id)`` a full licence's seated devices, for Replace (a view)
* ``complete(grant, choice)``    the person's choice: ``license`` (+ ``replace_device_id``),
  ``keep``, ``create`` or ``key``; the device token is stored like a sign-in
* ``cancel(grant)``              give the grant up; no token, nothing stored

Each call dials the endpoint discovery names, never one it builds (and never one outside this
product), and raises the typed ``service-unavailable`` N/A (reason ``product``) before any request
when discovery has none (the session then ran in card mode and never issued a grant). The grant is
the credential: NO device bearer is sent, and the grant is never printed or put in an error.

A refusal the Worker answers (``invalid_grant``, ``license_choice_required``, ``not_found``,
``device_limit``, ``rate_limited``, ``license_owned``, ``key_entry_limit``, ...) is a RESULT, a
:class:`ChoiceRefused`, like ``attach``. After ``device_limit`` and ``license_choice_required`` it
carries the fresh ``view`` to choose from again. A refused ``complete`` keeps the device token, the
cache and the stored identity: only an ``ok`` completion changes state. A network failure or a 5xx
raises under the one taxonomy, the grant still spendable.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.context import CoreContext, wire_code_of
from ..core.errors import PolarisError
from ..core.manage import KeyEntries, read_key_entries
from .redirect import parse_token_answer
from .sign_in import SignInDeps

__all__ = [
    "ChoiceClient",
    "ChoiceCancelOk",
    "ChoiceCompleteOk",
    "ChoiceRefused",
    "ChoiceViewOk",
    "LicenseChoice",
    "LicenseChoiceView",
    "ReplaceView",
]

#: The person's explicit choice (the wire's ``LicenseChoiceInput``): one of
#: ``{"kind": "license", "licenseId": ..., "replaceDeviceId"?: ...}``, ``{"kind": "keep"}``,
#: ``{"kind": "create"}`` or ``{"kind": "key", "key": ...}``.
LicenseChoice = Dict[str, Any]

_ENDPOINTS = ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel")


@dataclass(frozen=True)
class LicenseChoiceView:
    """The licences a grant can choose from: ``state`` and ``choices`` (rows as served);
    ``raw`` is the Worker's view."""

    state: str
    choices: List[Dict[str, Any]]
    raw: Dict[str, Any] = field(repr=False, default_factory=dict)

    @property
    def license_ids(self) -> List[str]:
        return [c["id"] for c in self.choices if isinstance(c.get("id"), str)]


@dataclass(frozen=True)
class ReplaceView:
    """The devices seated on a full licence."""

    license_id: str
    devices: List[Dict[str, Any]]
    raw: Dict[str, Any] = field(repr=False, default_factory=dict)

    @property
    def device_ids(self) -> List[str]:
        return [d["id"] for d in self.devices if isinstance(d.get("id"), str)]


@dataclass(frozen=True)
class ChoiceViewOk:
    """A view call that succeeded: ``view`` is a :class:`LicenseChoiceView` or :class:`ReplaceView`."""

    view: Any
    kind: str = "ok"


@dataclass(frozen=True)
class ChoiceCancelOk:
    kind: str = "ok"


@dataclass(frozen=True)
class ChoiceCompleteOk:
    """The choice was made and the device holds a token."""

    #: The licence the device now runs on, or ``None`` on a device with none.
    license_id: Optional[str]
    #: The pairwise account subject (``ps_...``).
    subject: str
    scope: str
    #: After a ``key``: the licence's key-entry count.
    key_entries: Optional[KeyEntries] = None
    #: ``True`` after ``keep``: the device kept a licence outside the account, so ``attach`` may
    #: follow. Never set otherwise.
    attachable: bool = False
    kind: str = "ok"


@dataclass(frozen=True)
class ChoiceRefused:
    """Why the Worker said no, as a result. Only the members the answer carried are set."""

    #: The wire code: ``invalid_grant``, ``license_choice_required``, ``not_found``,
    #: ``device_limit``, ``rate_limited``, ``license_owned``, ``key_entry_limit``, ...
    code: str
    http_status: int
    #: ``rate_limited``: seconds to wait.
    retry_after_seconds: Optional[int] = None
    #: ``device_limit`` and ``license_choice_required``: the fresh view to choose from again.
    view: Optional[LicenseChoiceView] = None
    #: ``device_limit``, ``key_entry_limit``: the portal link that frees a seat or an entry.
    manage_url: Optional[str] = None
    #: ``license_owned``: where to sign in to the account that owns the licence.
    sign_in_url: Optional[str] = None
    #: ``key_entry_limit``.
    key_entries: Optional[KeyEntries] = None
    kind: str = "refused"


def _is_rec(v: Any) -> bool:
    return isinstance(v, dict)


def _license_view(v: Any) -> Optional[LicenseChoiceView]:
    if _is_rec(v) and isinstance(v.get("state"), str) and isinstance(v.get("choices"), list):
        return LicenseChoiceView(
            state=v["state"], choices=[c for c in v["choices"] if _is_rec(c)], raw=v
        )
    return None


def _replace_view(v: Any) -> Optional[ReplaceView]:
    if _is_rec(v) and isinstance(v.get("licenseId"), str) and isinstance(v.get("devices"), list):
        return ReplaceView(
            license_id=v["licenseId"], devices=[d for d in v["devices"] if _is_rec(d)], raw=v
        )
    return None


def _body(res: httpx.Response) -> Any:
    try:
        return res.json()
    except ValueError:
        return None


class ChoiceClient:
    """``client.identity.choice``. Constructed by
    :class:`~polaris_key.identity.client.IdentityClient`."""

    def __init__(self, deps: SignInDeps) -> None:
        self._deps = deps

    @property
    def _ctx(self) -> CoreContext:
        return self._deps.ctx

    def licenses(self, grant: str) -> Any:
        """The licences the account can run this device on: a :class:`ChoiceViewOk` holding a
        :class:`LicenseChoiceView`, or a :class:`ChoiceRefused`. Counts against the grant's read
        budget."""
        res = self._post("choiceLicenses", {"grant": grant})
        if res.status_code != 200:
            return self._refusal(res, "choice licenses")
        view = _license_view(_body(res))
        if view is None:
            raise _unreadable("licenses")
        return ChoiceViewOk(view=view)

    def devices(self, grant: str, license_id: str) -> Any:
        """The devices seated on a full licence, for Replace: a :class:`ChoiceViewOk` holding a
        :class:`ReplaceView`. A licence outside the grant's view is refused with ``not_found``."""
        res = self._post("choiceDevices", {"grant": grant, "licenseId": license_id})
        if res.status_code != 200:
            return self._refusal(res, "choice devices")
        view = _replace_view(_body(res))
        if view is None:
            raise _unreadable("devices")
        return ChoiceViewOk(view=view)

    def complete(self, grant: str, choice: Optional[LicenseChoice] = None) -> Any:
        """Finish with the person's choice. On ``ok`` the device token is stored, the stored
        identity is forgotten (a choice answers no name or e-mail), the subject is persisted and
        the acquisition sync runs, exactly as after a sign-in. The grant is spent on ``ok``; a
        refusal the person can fix (``device_limit``, ``license_choice_required``, a wrong key)
        leaves it open. ``choice=None`` sends no ``choice`` member: the Worker answers
        ``license_choice_required`` with the view to choose from (the 409 transcript step)."""
        deps = self._deps
        body: Dict[str, Any] = {"grant": grant}
        if choice is not None:
            body["choice"] = choice
        # ``keep`` is proven by the device's own token (the Worker reads it as held); every other
        # choice is made on the grant alone.
        held = deps.tokens.current if choice is not None and choice.get("kind") == "keep" else None
        res = self._post("choiceComplete", body, held)
        if res.status_code != 200:
            return self._refusal(res, "choice complete")
        raw = _body(res)
        answer = parse_token_answer(200, raw)
        if answer.kind != "token":
            raise PolarisError(
                ErrorCode.BAD_RESPONSE,
                "choice complete answered without a complete sign-in.",
                status=200,
            )
        assert answer.access_token is not None and answer.subject is not None
        entries = read_key_entries(raw)
        deps.tokens.set(answer.access_token, "signin")
        deps.store_identity(None)
        if deps.write_subject is not None:
            deps.write_subject(answer.subject)
        deps.on_acquired()
        deps.emit("identity", change="signed_in", subject=answer.subject)
        lic = answer.license
        license_id = lic.get("id") if isinstance(lic, dict) and isinstance(lic.get("id"), str) else None
        return ChoiceCompleteOk(
            license_id=license_id,
            subject=answer.subject,
            scope=answer.scope or "",
            key_entries=entries,
            attachable=isinstance(choice, dict) and choice.get("kind") == "keep",
        )

    def cancel(self, grant: str) -> Any:
        """Give the grant up (``204``). Nothing is stored; the sign-in is over."""
        res = self._post("choiceCancel", {"grant": grant})
        if res.status_code in (200, 204):
            return ChoiceCancelOk()
        return self._refusal(res, "choice cancel")

    # ── Plumbing ────────────────────────────────────────────────────────────────────
    def _endpoint(self, name: str) -> str:
        """The discovery endpoint, else the typed N/A. Nothing is dialled before this answers
        (bar discovery itself, loaded once when the session has none)."""
        deps = self._deps
        doc = deps.load_discovery() if deps.load_discovery is not None else deps.discovery()
        self._ctx.require_service("identity", Feature.IDENTITY_CHOICE)
        services = doc.get("services") if isinstance(doc, dict) else None
        fragment = services.get("identity") if isinstance(services, dict) else None
        endpoints = fragment.get("endpoints") if isinstance(fragment, dict) else None
        url = endpoints.get(name) if isinstance(endpoints, dict) else None
        if not isinstance(url, str) or url == "":
            raise UnsupportedError(
                Unsupported(
                    Feature.IDENTITY_CHOICE,
                    UnsupportedReason.PRODUCT,
                    f"this product's discovery names no identity {name} endpoint",
                ),
                ErrorCode.SERVICE_UNAVAILABLE,
            )
        if not url.startswith(self._ctx.url("")):
            raise PolarisError(
                ErrorCode.BAD_RESPONSE, "an identity endpoint points outside this product."
            )
        return url

    def _post(
        self, name: str, body: Dict[str, Any], bearer: Optional[str] = None
    ) -> httpx.Response:
        url = self._endpoint(name)
        ctx = self._ctx
        # No authorization header but for `keep`: the grant in the body is the credential. A 5xx
        # raises `server-error` and no answer `network-error` (CoreContext.request).
        extra = {"content-type": "application/json"}
        if bearer:
            extra["authorization"] = "Bearer " + bearer
        return ctx.request(
            "POST",
            url,
            headers=ctx.headers(extra),
            content=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        )

    def _refusal(self, res: httpx.Response, what: str) -> ChoiceRefused:
        """A non-2xx answer (a 5xx never gets here): the Worker's refusal as a result."""
        b = _body(res)
        b = b if isinstance(b, dict) else {}
        retry_body = b.get("retryAfter")
        retry: Optional[int] = None
        if (
            isinstance(retry_body, (int, float))
            and not isinstance(retry_body, bool)
            and math.isfinite(retry_body)
            and retry_body > 0
        ):
            retry = int(math.ceil(retry_body))
        if retry is None:
            header = (res.headers.get("retry-after") or "").strip()
            if header.isdigit() and int(header) > 0:
                retry = int(header)
        manage = b.get("manageUrl")
        sign_in = b.get("signInUrl")
        return ChoiceRefused(
            code=wire_code_of(res) or f"http_{res.status_code}",
            http_status=res.status_code,
            retry_after_seconds=retry,
            view=_license_view(b.get("view")),
            manage_url=manage if isinstance(manage, str) else None,
            sign_in_url=sign_in if isinstance(sign_in, str) else None,
            key_entries=read_key_entries({"keyEntries": b.get("keyEntries")}),
        )


def _unreadable(what: str) -> PolarisError:
    return PolarisError(
        ErrorCode.BAD_RESPONSE, f"choice {what} answered without a readable view.", status=200
    )
