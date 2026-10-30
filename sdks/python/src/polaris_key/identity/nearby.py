"""The nearby sign-in route client (I-47.5; WIRE-CONTRACT-V5 §12.11.5). Mirrors the Node client's
``identity/nearby.ts`` (I-47.4).

Three calls, one per route, each answering a typed result and raising only for what is not an answer
(``network-error``, an answer that is not in the contract's shape, a local refusal):

* :meth:`NearbyRoutes.start` (D, the device with no way to sign in): ``POST …/identity/nearby/start`` with
  its two public keys and a ``nearby-start`` proof. The device's bearer goes with it when it holds a
  credential (Q8). A :class:`NearbyStarted` names the request handle, its lifetime and the poll interval.
* :meth:`NearbyRoutes.poll` (D): ``POST …/identity/nearby/poll``, proof ``nearby-poll`` over the handle by
  the key D sent on ``start``. The poll decides the outcome: a token is stored exactly as a device-code
  sign-in stores it (the token manager, the persisted subject, the acquisition sync) and answers
  ``signed_in``. Pacing is the caller's: the Worker answers ``slow_down`` inside the interval and a 503
  with ``Retry-After`` keeps the request.
* :meth:`NearbyRoutes.approve` (M, a signed-in device on D's network): ``POST …/identity/nearby/approve``
  with M's bearer, M's own device id and a ``nearby-approve`` proof by M's registered signing key. A 409
  ``device_keys_required`` registers M's keys once (``register_keys``) and retries once, never again.

A client uses an endpoint discovery names and never builds one: when discovery has no ``nearby`` member (or
not the endpoint), the call is :class:`NearbyUnavailable` and sends nothing. A 404 from ``start`` is the
same (it has no other 404: the operator's gate went off), and once ``start`` has said so, a later 404 from
``approve`` or ``poll`` is too. Any other 404 is a refusal like the rest: the Worker answers one body for
an unknown, decided, expired or other-product request, so ``expired`` versus ``unavailable`` is read from a
fresh discovery (:meth:`NearbyRoutes.answer_for_finish`, N11), never from the status.

Nothing here logs or prints the handle, a proof, the token or a key, and none of them is in a ``repr``.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

import httpx

from ..constants_generated import ErrorCode
from ..core.context import CoreContext, wire_code_of
from ..core.device_keys import DeviceKeyError, DeviceKeyPort, DeviceProofError, sign_device_proof
from ..core.device_proof import Ed25519VerifyPort
from ..core.errors import PolarisError
from ..core.models import HEADER_DEVICE
from .account import identity_fragment_from
from .redirect import parse_token_answer
from .sign_in import SignedInIdentity, SignInDeps

__all__ = [
    "NEARBY_POLL_INTERVAL_SECONDS",
    "NEARBY_REQUEST_PATTERN",
    "NearbyApproveAnswer",
    "NearbyApproveResult",
    "NearbyCredentials",
    "NearbyPollResult",
    "NearbyRefused",
    "NearbyRoutes",
    "NearbyStarted",
    "NearbyUnavailable",
]

#: §12.11.5: ``nr_`` and 22 base64url characters.
NEARBY_REQUEST_PATTERN = r"nr_[A-Za-z0-9_-]{22}\Z"
#: The poll interval ``start`` answers and ``poll`` enforces, seconds (§12.11.5).
NEARBY_POLL_INTERVAL_SECONDS = 3

_REQUEST = re.compile(NEARBY_REQUEST_PATTERN)
_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")


@dataclass(frozen=True)
class NearbyCredentials:
    """Who signs and sends a call: the ``X-PKey-Device`` value, the device's key port and, where the
    device holds one, its bearer. ``token`` is a secret and stays out of ``repr``."""

    device_id: str
    keys: DeviceKeyPort
    token: Optional[str] = field(default=None, repr=False)


@dataclass(frozen=True)
class NearbyStarted:
    """The ``201`` of ``start``. ``request`` is the handle (a secret: it is not in ``repr``). The public keys
    and device id are the ones the request was started with: ``poll`` signs with exactly these."""

    request: str = field(repr=False)
    expires_in: int
    interval: int
    sign_key: str
    agree_key: str
    device_id: str
    kind: str = "started"


@dataclass(frozen=True)
class NearbyUnavailable:
    """Nearby sign-in is not served here: discovery names no ``nearby`` member (or not the endpoint), or the
    Worker answered 404 to ``start``. Nothing was sent in the first case."""

    reason: str = "discovery"
    kind: str = "unavailable"


@dataclass(frozen=True)
class NearbyRefused:
    """The Worker refused: ``code`` is its wire code (``invalid_grant``, ``not_nearby``, ``rate_limited``, …)
    or ``http_<status>``, ``status`` the HTTP status. ``retry_after_seconds`` where it sent one."""

    code: str
    status: int
    retry_after_seconds: Optional[int] = None
    kind: str = "refused"


@dataclass(frozen=True)
class NearbyPollResult:
    """One poll's answer. ``kind``:

    * ``pending``: nobody has decided; poll again after ``interval``;
    * ``slow_down``: the poll came inside the interval; ``interval`` is the longer one;
    * ``retry``: a 503 with ``Retry-After``; the request is kept (``retry_after_seconds``);
    * ``timeout``: the request lapsed, or the token was already collected;
    * ``denied``: the person on M pressed Deny (``reason`` ``access_denied``);
    * ``signed_in``: the token was stored (``subject``, ``scope``, ``license_id``). The poll is the only
      source of a sign-in.
    """

    kind: str
    interval: Optional[int] = None
    retry_after_seconds: Optional[int] = None
    reason: Optional[str] = None
    subject: Optional[str] = None
    scope: Optional[str] = None
    license_id: Optional[str] = None
    #: ``signed_in``: the name and e-mail of the account the token answer shows (display data), or ``None``.
    identity: Optional[SignedInIdentity] = None


@dataclass(frozen=True)
class NearbyApproveAnswer:
    """``nearby/approve``'s answer as the finish step of the vouch reads it (§15.6.1 rule 6): ``http`` is the
    status (``None`` when there was no answer); ``body`` the text it reads (the success body as sent, or
    ``{"code": "<wire code>"}`` for a refusal, whether the Worker's code was flat or nested);
    ``discovery_nearby`` the fresh read of discovery (only taken for a 404; ``True`` otherwise);
    ``keys_retried`` whether M registered its keys for this call."""

    http: Optional[int]
    body: Optional[str]
    discovery_nearby: bool = True
    keys_retried: bool = False


@dataclass(frozen=True)
class NearbyApproveResult:
    """``approve``'s answer. ``kind``:

    * ``approved``: D is bound (``device_label`` is the label the Worker stored, or ``None``);
    * ``choose``: a licence choice is due, nothing was written (``choices`` is the answer's view);
    * ``denied``: the 204 of a ``deny``;
    * ``refused``: the Worker said no (``code``, ``status``): ``not_nearby``, ``device_limit``,
      ``account_required``, ``invalid_grant``, ``bad_request``, ``not_found``, a lost mint, …;
    * ``unavailable``: discovery names no ``nearby`` / ``nearbyApprove`` here (nothing was sent), or ``start``
      already learned the gate is off.

    ``answer`` is the same outcome in the shape the vouch's finish step reads."""

    kind: str
    device_label: Optional[str] = None
    choices: Optional[Dict[str, Any]] = None
    code: Optional[str] = None
    status: Optional[int] = None
    retry_after_seconds: Optional[int] = None
    answer: Optional[NearbyApproveAnswer] = None


def _json(res: httpx.Response) -> Dict[str, Any]:
    try:
        b = res.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


def _retry_after(res: httpx.Response) -> Optional[int]:
    """Whole seconds from ``Retry-After`` (delay-seconds), else the body's ``retryAfter``."""
    header = (res.headers.get("retry-after") or "").strip()
    if header.isdigit() and int(header) > 0:
        return int(header)
    body = _json(res).get("retryAfter")
    if isinstance(body, (int, float)) and not isinstance(body, bool) and math.isfinite(body) and body > 0:
        return int(math.ceil(body))
    return None


def _seconds(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def _refusal(res: httpx.Response) -> NearbyRefused:
    return NearbyRefused(
        code=wire_code_of(res) or f"http_{res.status_code}",
        status=res.status_code,
        retry_after_seconds=_retry_after(res),
    )


class NearbyRoutes:
    """The three nearby routes. Constructed by :class:`~polaris_key.identity.client.IdentityClient`; a
    host reaches them through the nearby session (D) and approver (M)."""

    #: A test seam for the conformance replay: it signs with a verifier that accepts a doctored proof.
    _verify: Optional[Ed25519VerifyPort] = None

    def __init__(
        self,
        deps: SignInDeps,
        *,
        refresh_discovery: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        register_keys: Optional[Callable[[NearbyCredentials], None]] = None,
    ) -> None:
        self._deps = deps
        self._ctx: CoreContext = deps.ctx
        #: A fresh read of discovery (``None`` when it could not be read). With none the held document is used.
        self._refresh = refresh_discovery
        #: Register M's keys with the Worker (``PUT …/devices/keys``): the answer to a 409 ``device_keys_required``.
        self._register_keys = register_keys
        self._gate_off = False

    def __repr__(self) -> str:
        return "<NearbyRoutes>"

    # ── Discovery ───────────────────────────────────────────────────────────────────
    def _named(self, doc: Optional[Dict[str, Any]], names: Any) -> Optional[str]:
        fragment = identity_fragment_from(doc)
        if fragment is None or fragment.get("nearby") is not True:
            return None
        base = self._ctx.url("")
        for name in names:
            url = fragment["endpoints"].get(name)
            if not url or not url.startswith(base):
                return None
        return fragment["endpoints"].get(names[0])

    def _url(self, fragment_names: Any, which: str) -> Optional[str]:
        """The endpoint ``which`` once every name in ``fragment_names`` is named."""
        try:
            doc = (self._deps.load_discovery or self._deps.discovery)()
        except PolarisError:
            return None
        if self._named(doc, fragment_names) is None:
            return None
        fragment = identity_fragment_from(doc)
        assert fragment is not None
        return fragment["endpoints"].get(which)  # type: ignore[no-any-return]

    def discovery_names_nearby(self, *, fresh: bool = True, endpoint: str = "nearbyApprove") -> bool:
        """Does discovery name ``nearby`` and ``endpoint``? Read afresh by default (N11): a failed read
        answers ``False``, never the held document, so a Worker that cannot be reached is not read as
        "the request lapsed"."""
        if fresh and self._refresh is not None:
            try:
                doc = self._refresh()
            except Exception:
                doc = None
            if doc is None:
                return False
        else:
            try:
                doc = (self._deps.load_discovery or self._deps.discovery)()
            except PolarisError:
                return False
        return self._named(doc, (endpoint,)) is not None

    # ── Signing and sending ─────────────────────────────────────────────────────────
    def _sign(self, creds: NearbyCredentials, purpose: str, value: str) -> str:
        """The ``pkey-proof/1`` signature (a base64url string) for ``purpose`` over ``value`` by ``creds``."""
        try:
            proof = sign_device_proof(
                creds.keys,
                purpose=purpose,
                product=self._ctx.product,
                device_id=creds.device_id,
                value=value,
                now=self._ctx.now(),
                verify=self._verify,
            )
        except DeviceProofError as e:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: the device proof could not be built.") from e
        except DeviceKeyError as e:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: the device keys cannot be used.") from e
        return proof.sig

    def _send(self, url: str, creds: NearbyCredentials, body: Dict[str, Any], bearer: bool) -> httpx.Response:
        """One POST. Straight to the HTTP client, because a 503 here is an answer (``Retry-After`` and the
        kept request), not a failure: only a transport failure raises (``network-error``, ``local-only``)."""
        extra = {HEADER_DEVICE: creds.device_id, "content-type": "application/json"}
        if bearer and creds.token:
            extra["authorization"] = f"Bearer {creds.token}"
        try:
            return self._ctx.http().request(
                "POST", url, headers=self._ctx.headers(extra), json=body, timeout=self._ctx.timeout
            )
        except (httpx.HTTPError, OSError) as e:
            raise PolarisError(
                ErrorCode.NETWORK_ERROR, f"POST nearby got no answer: {str(e) or type(e).__name__}"
            ) from e

    @staticmethod
    def _handle(request: Any) -> str:
        if not isinstance(request, str) or _REQUEST.match(request) is None:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: the request handle is malformed.")
        return request

    # ── D: start ────────────────────────────────────────────────────────────────────
    def start(self, creds: NearbyCredentials, *, device_name: Optional[str] = None) -> Any:
        """``POST …/nearby/start``. Answers :class:`NearbyStarted`, :class:`NearbyUnavailable` or
        :class:`NearbyRefused`. ``device_name`` is the per-call label (§12.7.1), else the client's, else the
        platform default; ``""`` sends none."""
        url = self._url(("nearbyStart", "nearbyPoll"), "nearbyStart")
        if url is None:
            return NearbyUnavailable()
        try:
            keys = creds.keys.ensure()
        except DeviceKeyError as e:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: the device keys cannot be used.") from e
        body: Dict[str, Any] = {"signKey": keys.sign_key, "agreeKey": keys.agree_key}
        label = self._ctx.device_label(device_name)
        if label:
            body["deviceName"] = label
        body["proof"] = self._sign(creds, "nearby-start", f"{keys.sign_key}.{keys.agree_key}")
        # Q8: the bearer goes with start when the device holds a credential.
        res = self._send(url, creds, body, bearer=True)
        if res.status_code == 404:
            # Start has no other 404: the product or the operator's gate turned nearby off.
            self._gate_off = True
            return NearbyUnavailable(reason="gate")
        if res.status_code != 201:
            return _refusal(res)
        b = _json(res)
        request = b.get("request")
        if (
            not isinstance(request, str)
            or _REQUEST.match(request) is None
            or not _seconds(b.get("expiresIn"))
            or not _seconds(b.get("interval"))
        ):
            raise PolarisError(ErrorCode.BAD_RESPONSE, "nearby start answered without a complete request.")
        self._gate_off = False
        return NearbyStarted(
            request=request,
            expires_in=int(math.ceil(b["expiresIn"])),
            interval=int(math.ceil(b["interval"])),
            sign_key=keys.sign_key,
            agree_key=keys.agree_key,
            device_id=creds.device_id,
        )

    # ── D: poll ─────────────────────────────────────────────────────────────────────
    def poll(self, creds: NearbyCredentials, started: NearbyStarted) -> Any:
        """``POST …/nearby/poll`` for ``started``, signed with the key D sent on ``start`` (a key that
        changed since is refused locally, never signed over). Answers :class:`NearbyPollResult`,
        :class:`NearbyUnavailable` or :class:`NearbyRefused`. The caller paces: at least ``interval`` seconds
        between calls; a ``slow_down`` carries the longer one."""
        url = self._url(("nearbyPoll",), "nearbyPoll")
        if url is None:
            return NearbyUnavailable()
        request = self._handle(started.request)
        now_keys = creds.keys.public_keys()
        if now_keys is None or now_keys.sign_key != started.sign_key or creds.device_id != started.device_id:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: the device keys changed since the request started.")
        body = {"request": request, "proof": self._sign(creds, "nearby-poll", request)}
        # A poll carries no bearer: D is not signed in until this answer.
        res = self._send(url, creds, body, bearer=False)
        status = res.status_code
        if status == 404:
            return NearbyUnavailable(reason="gate") if self._gate_off else _refusal(res)
        if status == 429:
            longer = _json(res).get("interval")
            return NearbyPollResult(
                kind="slow_down",
                interval=int(math.ceil(longer)) if isinstance(longer, (int, float)) and _seconds(longer) else started.interval + 5,
            )
        if status == 503:
            return NearbyPollResult(kind="retry", retry_after_seconds=_retry_after(res))
        if status != 200:
            return _refusal(res)
        b = _json(res)
        state = b.get("status")
        if state == "pending":
            return NearbyPollResult(kind="pending", interval=started.interval)
        if state == "timeout":
            return NearbyPollResult(kind="timeout")
        if state == "error":
            if b.get("reason") == "access_denied":
                return NearbyPollResult(kind="denied", reason="access_denied")
            raise PolarisError(ErrorCode.SIGN_IN_FAILED, "nearby sign-in failed.")
        return self._signed_in(res, b)

    def _signed_in(self, res: httpx.Response, raw: Dict[str, Any]) -> NearbyPollResult:
        """A token answer, stored as a device-code ``ready`` stores it: the token manager (a sign-in the
        person started), the persisted subject, the acquisition sync, the ``identity`` event."""
        answer = parse_token_answer(200, raw)
        if answer.kind != "token":
            raise PolarisError(ErrorCode.BAD_RESPONSE, "nearby poll answered without a complete sign-in.")
        assert answer.access_token is not None and answer.subject is not None
        deps = self._deps
        lic = answer.license
        shown = lic if isinstance(lic, dict) else {}
        name = shown.get("name") if isinstance(shown.get("name"), str) and shown.get("name") else None
        email = shown.get("email") if isinstance(shown.get("email"), str) and shown.get("email") else None
        identity = SignedInIdentity(name=name, email=email) if (name or email) else None
        deps.tokens.set(answer.access_token, "signin", person_initiated=True)
        deps.store_identity(identity)
        if deps.write_subject is not None:
            deps.write_subject(answer.subject)
        deps.on_acquired()
        deps.emit("identity", change="signed_in", subject=answer.subject)
        license_id = shown.get("id") if isinstance(shown.get("id"), str) else None
        return NearbyPollResult(
            kind="signed_in",
            subject=answer.subject,
            scope=answer.scope,
            license_id=license_id,
            identity=identity,
        )

    # ── M: approve ──────────────────────────────────────────────────────────────────
    def approve(
        self,
        creds: NearbyCredentials,
        *,
        request: str,
        device_id: str,
        sign_key: str,
        agree_key: str,
        decision: str = "approve",
        choice: Optional[Dict[str, Any]] = None,
    ) -> NearbyApproveResult:
        """``POST …/nearby/approve`` from M. ``request``, ``device_id``, ``sign_key`` and ``agree_key`` are
        exactly what D's verified ``VOUCH_REQ`` named (the Worker compares them with what D sent on
        ``start``); ``decision`` is ``"approve"`` or ``"deny"``; ``choice`` is ``{"kind": "license",
        "licenseId": …}`` or ``{"kind": "create"}`` after a ``choose``. A 409 ``device_keys_required``
        registers M's keys once and retries once."""
        if decision not in ("approve", "deny"):
            raise PolarisError(ErrorCode.INVALID_OPTIONS, 'nearby: decision must be "approve" or "deny".')
        if not (isinstance(sign_key, str) and _KEY.match(sign_key) and isinstance(agree_key, str) and _KEY.match(agree_key)):
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: D's keys are malformed.")
        if not isinstance(device_id, str) or not device_id:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "nearby: D's device id is missing.")
        request = self._handle(request)
        url = self._url(("nearbyApprove",), "nearbyApprove")
        if url is None:
            return NearbyApproveResult(kind="unavailable")
        if not creds.token:
            raise PolarisError(ErrorCode.NO_TOKEN, "Sign in before approving a nearby device.")
        body: Dict[str, Any] = {
            "request": request,
            "deviceId": device_id,
            "signKey": sign_key,
            "agreeKey": agree_key,
            "decision": decision,
        }
        if choice is not None:
            body["choice"] = choice
        body["proof"] = self._sign(creds, "nearby-approve", request)
        retried = False
        res = self._send(url, creds, body, bearer=True)
        if res.status_code == 409 and wire_code_of(res) == ErrorCode.DEVICE_KEYS_REQUIRED and self._register_keys:
            # M registers its keys first and retries ONCE; a second 409 is the answer.
            self._register_keys(creds)
            retried = True
            res = self._send(url, creds, body, bearer=True)
        return self._approve_result(res, decision, retried)

    def _approve_result(self, res: httpx.Response, decision: str, retried: bool) -> NearbyApproveResult:
        status = res.status_code
        b = _json(res)
        text: Optional[str] = res.text if res.content else None
        if status == 200 and b.get("status") == "approved":
            label = b.get("deviceLabel")
            return NearbyApproveResult(
                kind="approved",
                device_label=label if isinstance(label, str) else None,
                status=200,
                answer=NearbyApproveAnswer(200, text, True, retried),
            )
        if status == 200 and b.get("status") == "choose" and isinstance(b.get("choices"), dict):
            return NearbyApproveResult(
                kind="choose",
                choices=b["choices"],
                status=200,
                answer=NearbyApproveAnswer(200, text, True, retried),
            )
        if status == 204 and decision == "deny":
            return NearbyApproveResult(kind="denied", status=204, answer=NearbyApproveAnswer(204, None, True, retried))
        if status == 200 or status == 204:
            raise PolarisError(ErrorCode.BAD_RESPONSE, "nearby approve answered with an unexpected body.")
        r = _refusal(res)
        code = wire_code_of(res)
        flat = json.dumps({"code": code}) if code else None
        if status == 404 and self._gate_off:
            # start already learned the gate is off: this 404 is the same answer.
            return NearbyApproveResult(
                kind="unavailable", status=404, answer=NearbyApproveAnswer(404, flat, True, retried)
            )
        return NearbyApproveResult(
            kind="refused",
            code=r.code,
            status=r.status,
            retry_after_seconds=r.retry_after_seconds,
            answer=NearbyApproveAnswer(status, flat, True, retried),
        )

    def answer_for_finish(self, result: NearbyApproveResult) -> NearbyApproveAnswer:
        """The answer in the shape the vouch's finish step reads (§15.6.1 rule 6). A 404 reads discovery
        afresh first (N11): ``discovery_nearby`` is whether it still names ``nearby`` and ``nearbyApprove``.
        With the gate already known to be off it is ``False`` without a request."""
        a = result.answer or NearbyApproveAnswer(None, None, True, False)
        if a.http != 404:
            return a
        named = False if self._gate_off else self.discovery_names_nearby(fresh=True, endpoint="nearbyApprove")
        return NearbyApproveAnswer(a.http, a.body, named, a.keys_retried)
