"""WIRE-CONTRACT-V5 §15.6.1: the codecs and rules of mode v, the vouch. Pure: no I/O, no clock the caller
does not hand in, no route. D is the device with no sign-in (the initiator); M is the signed-in device
nearby (the responder). The vectors are ``peer-matrix.json`` ``vouch``. Mirrors
``packages/client-core/src/peer/vouch.ts``.

What lives here: the ``VOUCH_REQ`` body (build, parse, verify), the ``VOUCH_RESULT`` body, M's reading
of the ``nearby/approve`` answer (:func:`finish_map`), the number-matching decoys (:func:`decoy_codes`),
the approver's advert instance, the failure budget, and :class:`VouchFlow`, the order guard both ends
run over the records of one session. What does not: the session itself (``peer_session.py``), the
routes, the adverts' sockets and the prompt. Failures carry a close code and never a value: the request
handle, ``sig``, ``h``, the nonces and the one-time keys appear in no message here.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Generic, List, NamedTuple, Optional, Sequence, TypeVar

from ..constants_generated import ErrorCode
from .b64url import b64url_decode, b64url_encode
from .device_keys import DeviceKeyPort, sign_device_proof
from .device_proof import DeviceProof, is_x25519_low_order, verify_device_proof
from .jws import _point_acceptable
from .peer_advert import base32_lower
from .peer_display import clean_label, clean_platform
from .peer_frame import RECORD
from .peer_payload import caps_intersection, parse_strict_object

__all__ = [
    "APPROVER_RENEW_SECONDS",
    "AbandonReason",
    "ApproveAnswer",
    "BuildVouchRequestOptions",
    "DecoyCodes",
    "FinishAction",
    "ParsedVouchRequest",
    "VOUCH_CAP",
    "VOUCH_FAILURE_LIMIT",
    "VOUCH_FAILURE_WINDOW_SECONDS",
    "VOUCH_HELD_BYTES",
    "VOUCH_HELD_RECORDS",
    "VOUCH_REQ_MAX",
    "VouchFailureBudget",
    "VouchFlow",
    "VouchRecord",
    "VouchRequest",
    "VouchVerdict",
    "approver_instance",
    "build_vouch_request",
    "build_vouch_result",
    "decoy_codes",
    "finish_map",
    "parse_vouch_request",
    "parse_vouch_result",
    "verify_vouch_request",
]

#: The capability both mode-v payloads list (rule 1).
VOUCH_CAP = "vouch/1"
#: A ``VOUCH_REQ`` body is at most this many bytes (rule 5).
VOUCH_REQ_MAX = 4096
#: Rule 12: records D holds before its person confirms the account.
VOUCH_HELD_RECORDS = 16
VOUCH_HELD_BYTES = 16 * 1024
#: Rule 2: the advert's listener and instance are renewed this often.
APPROVER_RENEW_SECONDS = 300
#: Rule 2: this many prompted failures within the window stop the advert.
VOUCH_FAILURE_LIMIT = 2
VOUCH_FAILURE_WINDOW_SECONDS = 600

# ``\Z`` rather than ``$``: ``$`` also matches before a final newline.
_REQUEST_RE = re.compile(r"nr_[A-Za-z0-9_-]{22}\Z")
_DEVICE_RE = re.compile(r"[A-Za-z0-9_-]{32}\Z")
_P25519 = 2**255 - 19
_Random = Callable[[int], bytes]


def _key32(v: Any) -> Optional[bytes]:
    """A canonical base64url of 32 bytes, decoded, or ``None``."""
    if not isinstance(v, str) or len(v) != 43:
        return None
    try:
        b = b64url_decode(v)
    except ValueError:
        return None
    return b if len(b) == 32 else None


def _agree_spelling(k: bytes) -> bool:
    """The one X25519 spelling the Worker registers: bit 255 clear and u below p (§15.8)."""
    return (k[31] & 0x80) == 0 and int.from_bytes(k, "little") < _P25519


# -- VOUCH_REQ ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class VouchHello:
    """What D's ``HELLO`` showed (display data), as M holds it."""

    platform: str
    label: Optional[str] = None


@dataclass(frozen=True)
class VouchRequest:
    """A verified request: exactly what M sends to ``nearby/approve`` (rule 5). ``request`` is the
    handle from ``nearby/start``: it is kept out of the repr."""

    request: str = field(repr=False)
    device_id: str
    sign_key: str
    agree_key: str
    label: Optional[str]
    platform: str

    def to_json(self) -> Dict[str, Any]:
        """The members, camelCase as on the wire (``label`` is ``None`` when D sent none)."""
        return {
            "request": self.request,
            "deviceId": self.device_id,
            "signKey": self.sign_key,
            "agreeKey": self.agree_key,
            "label": self.label,
            "platform": self.platform,
        }


@dataclass(frozen=True)
class BuildVouchRequestOptions:
    """Input of :func:`build_vouch_request`."""

    #: D's device keys; the proof is signed by its ``sign_key``.
    port: DeviceKeyPort
    slug: str
    #: This session's Noise handshake hash.
    h: bytes = field(repr=False)
    #: The handle from ``nearby/start``.
    request: str = field(repr=False)
    #: The ``X-PKey-Device`` value sent on ``start``.
    device_id: str
    #: The same ``label`` and ``platform`` D's ``HELLO`` carried.
    hello: VouchHello


def build_vouch_request(o: BuildVouchRequestOptions) -> bytes:
    """The ``VOUCH_REQ`` body D sends after it showed the code (rule 5). Raises ``ValueError`` on a
    malformed input; the message names no value."""
    if len(o.h) != 32 or _REQUEST_RE.match(o.request) is None:
        raise ValueError("vouch request: bad input")
    if _DEVICE_RE.match(o.device_id) is None:
        raise ValueError("vouch request: bad input")
    proof = sign_device_proof(
        o.port,
        purpose="vouch",
        product=o.slug,
        device_id=o.device_id,
        value="%s.%s" % (b64url_encode(bytes(o.h)), o.request),
    )
    keys = o.port.public_keys()
    if keys is None or keys.sign_key != proof.sign_key:
        raise ValueError("vouch request: keys changed")
    body: Dict[str, Any] = {
        "v": 1,
        "request": o.request,
        "deviceId": o.device_id,
        "signKey": keys.sign_key,
        "agreeKey": keys.agree_key,
    }
    if o.hello.label is not None:
        body["label"] = o.hello.label
    body["platform"] = o.hello.platform
    body["sig"] = proof.sig
    out = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(out) > VOUCH_REQ_MAX:
        raise ValueError("vouch request: too large")
    return out


@dataclass(frozen=True)
class ParsedVouchRequest:
    """A ``VOUCH_REQ`` body that passed every check that needs no session (rule 5), signature unread."""

    request: str = field(repr=False)
    device_id: str
    sign_key: str
    agree_key: str
    label: Optional[str]
    platform: str
    #: Unverified until :func:`verify_vouch_request`.
    sig: str = field(repr=False)


def parse_vouch_request(body: bytes) -> Optional[ParsedVouchRequest]:
    """Strict JSON, size, shape and key checks; ``None`` means close ``peer_bad_frame``."""
    if len(body) > VOUCH_REQ_MAX:
        return None
    o = parse_strict_object(body)
    if o is None:
        return None
    v = o.get("v")
    if isinstance(v, bool) or not isinstance(v, int) or v != 1:
        return None
    request, device_id = o.get("request"), o.get("deviceId")
    sign_key, agree_key = o.get("signKey"), o.get("agreeKey")
    label, platform, sig = o.get("label"), o.get("platform"), o.get("sig")
    if not isinstance(request, str) or _REQUEST_RE.match(request) is None:
        return None
    if not isinstance(device_id, str) or _DEVICE_RE.match(device_id) is None:
        return None
    sk = _key32(sign_key)
    if sk is None or not _point_acceptable(sk):
        return None
    ak = _key32(agree_key)
    if ak is None or is_x25519_low_order(ak) or not _agree_spelling(ak):
        return None
    if "label" in o and not isinstance(label, str):
        return None
    if not isinstance(platform, str) or not isinstance(sig, str):
        return None
    return ParsedVouchRequest(
        request=request,
        device_id=device_id,
        sign_key=str(sign_key),
        agree_key=str(agree_key),
        label=clean_label(label) if isinstance(label, str) else None,
        platform=clean_platform(platform),
        sig=sig,
    )


def verify_vouch_request(
    *,
    slug: str,
    h: bytes,
    hello: VouchHello,
    body: bytes,
    hello_cleaned: bool = False,
) -> Optional[VouchRequest]:
    """M's whole check of a ``VOUCH_REQ`` (rule 5): the parse, the proof over this session's ``h``, and
    the equality of ``label`` and ``platform`` with ``HELLO``. ``None`` means close ``peer_bad_frame``
    and call no route.

    ``hello_cleaned`` says ``hello`` is the ``HELLO`` the session already cleaned (what
    ``PeerHello`` carries): it is compared as it is. Without it the label is cleaned again, and the
    cleaning is not idempotent (an invisible mark between a base and a combining mark can change a
    second time), so an honest D would be refused."""
    p = parse_vouch_request(body)
    if p is None:
        return None
    proven = verify_device_proof(
        DeviceProof(
            purpose="vouch",
            product=slug,
            device_id=p.device_id,
            value="%s.%s" % (b64url_encode(bytes(h)), p.request),
            token_hash="-",
            sign_key=p.sign_key,
            sig=p.sig,
        )
    )
    if not proven:
        return None
    if hello.label is None:
        hello_label: Optional[str] = None
    elif hello_cleaned:
        hello_label = hello.label
    else:
        hello_label = clean_label(hello.label)
    if p.label != hello_label:
        return None
    if p.platform != clean_platform(hello.platform):
        return None
    return VouchRequest(
        request=p.request,
        device_id=p.device_id,
        sign_key=p.sign_key,
        agree_key=p.agree_key,
        label=p.label,
        platform=p.platform,
    )


# -- VOUCH_RESULT -------------------------------------------------------------------------------

#: The three statuses ``VOUCH_RESULT`` carries.
VouchStatus = str
_STATUSES = ("approved", "denied", "expired")


def build_vouch_result(status: str) -> bytes:
    """The ``VOUCH_RESULT`` body M sends."""
    return json.dumps({"status": status}, separators=(",", ":")).encode("utf-8")


class VouchResultRead(NamedTuple):
    """D's reading of a ``VOUCH_RESULT``: ``status``, or ``refuse`` (a close code)."""

    status: Optional[str] = None
    refuse: Optional[str] = None


def parse_vouch_result(body: bytes) -> VouchResultRead:
    """D's reading of a ``VOUCH_RESULT`` (rule 6): display data only. An unknown status reads as
    ``denied``; a body that is not an object with a string ``status`` closes ``peer_bad_frame``."""
    o = parse_strict_object(body)
    status = None if o is None else o.get("status")
    if not isinstance(status, str):
        return VouchResultRead(refuse=ErrorCode.PEER_BAD_FRAME)
    return VouchResultRead(status=status if status in _STATUSES else "denied")


# -- M reads the answer of nearby/approve -------------------------------------------------------


@dataclass(frozen=True)
class ApproveAnswer:
    """What ``nearby/approve`` answered, plus M's fresh discovery read."""

    #: The HTTP status, or ``None`` when there was no answer.
    http: Optional[int]
    #: The body text, or ``None`` when none.
    body: Optional[str]
    #: M's fresh read: does discovery still name ``nearby`` and ``nearbyApprove``?
    discovery_nearby: bool
    #: True once M already answered a ``device_keys_required`` by registering its keys.
    keys_retried: bool = False


class FinishAction(NamedTuple):
    """One of ``send`` (a ``VOUCH_RESULT`` status; after any status but ``approved``, close
    ``peer_bye``), ``wait`` (``choice`` or ``keys``: show the licence choice or register keys, then call
    again) or ``close`` (send nothing and close ``peer_bye``; ``stop_advert`` when discovery lost
    ``nearby``)."""

    send: Optional[str] = None
    wait: Optional[str] = None
    close: bool = False
    stop_advert: bool = False


_STOP = FinishAction(close=True)
_STOP_ADVERT = FinishAction(close=True, stop_advert=True)


def finish_map(r: ApproveAnswer) -> FinishAction:
    """Rule 6's table. Anything it does not list closes."""
    if r.http is None:
        return _STOP
    o = None if r.body is None else parse_strict_object(r.body.encode("utf-8", "surrogatepass"))
    code = o.get("code") if o is not None and isinstance(o.get("code"), str) else None
    status = o.get("status") if o is not None else None
    if r.http == 200:
        if status == "approved":
            return FinishAction(send="approved")
        return FinishAction(wait="choice") if status == "choose" else _STOP
    if r.http == 204:
        return FinishAction(send="denied")
    if r.http == 403:
        # D hears ``denied`` for both, so a session holder cannot tell which refusal an account hit.
        return FinishAction(send="denied") if code in ("not_nearby", "device_limit") else _STOP
    if r.http == 404:
        # The 404 is ambiguous (rule 6): ``expired`` only while discovery still names the routes.
        return FinishAction(send="expired") if r.discovery_nearby else _STOP_ADVERT
    if r.http == 409:
        if code == "device_keys_required":
            return _STOP if r.keys_retried else FinishAction(wait="keys")
        return FinishAction(wait="choice") if code == "license_choice_required" else _STOP
    return _STOP


# -- randomness: decoys, positions and the advert instance --------------------------------------

#: Draws that may be rejected before a generator that cannot produce a value is given up on.
_MAX_DRAWS = 256


def _uniform_below(n: int, random: _Random) -> int:
    """A uniform integer in [0, n) by rejection sampling over 32-bit draws; never ``x % n`` alone."""
    limit = (2**32 // n) * n
    for _ in range(_MAX_DRAWS):
        x = int.from_bytes(random(4), "big")
        if x < limit:
            return x % n
    raise ValueError("vouch: random source")


@dataclass(frozen=True)
class DecoyCodes:
    #: Three distinct codes, each in [0, 10^6), the real one among them.
    codes: List[int]
    #: Where the real code stands in ``codes``.
    index: int


def decoy_codes(real: int, random: _Random = os.urandom) -> DecoyCodes:
    """The three codes M shows (rule 4): the session's ``real`` code and two decoys by rejection
    sampling, distinct, and the real one at a uniform position by a partial Fisher-Yates shuffle."""
    if isinstance(real, bool) or not isinstance(real, int) or real < 0 or real >= 1_000_000:
        raise ValueError("vouch: code")
    slots: List[List[Any]] = [[real, True]]
    # A source that keeps repeating a code is given up on, not looped on.
    tries = 0
    while len(slots) < 3:
        if tries >= _MAX_DRAWS:
            raise ValueError("vouch: random source")
        tries += 1
        code = _uniform_below(1_000_000, random)
        if not any(s[0] == code for s in slots):
            slots.append([code, False])
    for i in (2, 1):
        j = _uniform_below(i + 1, random)
        slots[i], slots[j] = slots[j], slots[i]
    return DecoyCodes([s[0] for s in slots], next(i for i, s in enumerate(slots) if s[1]))


def approver_instance(random: _Random = os.urandom) -> str:
    """The approver's advert instance (rule 2): ``p1-`` and 10 CSPRNG bytes in base32, 16 characters."""
    return "p1-" + base32_lower(random(10))


# -- the failure budget (rule 2) ----------------------------------------------------------------


class VouchFailureBudget:
    """M counts the failures of sessions whose prompt was shown (a wrong pick, "None of these match", a
    120 s timeout) against a monotonic clock. The second within 10 minutes stops the advert, and it
    stays stopped until the person reopens "Approve a nearby device". A session that was only queued, or
    shown the passive notice, counts for nothing: the caller does not report it."""

    def __init__(self, mono: Callable[[], float]) -> None:
        self._mono = mono
        self._at: List[float] = []
        self._halted = False

    def fail(self) -> bool:
        """Record one failure; true when the advert must stop now."""
        now = self._mono()
        self._at = [t for t in self._at if now - t < VOUCH_FAILURE_WINDOW_SECONDS]
        self._at.append(now)
        if len(self._at) >= VOUCH_FAILURE_LIMIT:
            self._halted = True
        return self._halted

    @property
    def stopped(self) -> bool:
        """True while the advert must stay off."""
        return self._halted

    def reopen(self) -> None:
        """The person reopened "Approve a nearby device": the count starts again."""
        self._at = []
        self._halted = False


# -- the order guard (rules 1, 4, 5, 7, 8, 12) --------------------------------------------------


class VouchRecord(NamedTuple):
    type: int
    body: bytes


R = TypeVar("R")


@dataclass(frozen=True)
class VouchVerdict(Generic[R]):
    """``ok`` with the records to hand on now (this one, or ones held earlier, in order; may be empty),
    or not ``ok`` with the close code."""

    ok: bool
    deliver: Sequence[R] = ()
    close: Optional[str] = None


#: ``requester`` (D) or ``approver`` (M).
VouchRole = str
#: ``wrong-pick``, ``none-match``, ``stop`` or ``timeout``.
AbandonReason = str


def _is_sync(t: int) -> bool:
    return 0x0030 <= t <= 0x003F


class VouchFlow(Generic[R]):
    """One end's order guard over the vouch records of one session. D is the ``requester``, M the
    ``approver``. Every record is checked in both directions: :meth:`receive` for what arrives,
    :meth:`send` for what this end is about to send, with the same codes (rule 7). After a close verdict
    the flow is dead and answers with that code again. A record is any object with ``type`` and ``body``.

    - ``VOUCH_REQ``: D to M, once, after D showed the code. M's flow holds it until the person's right
      pick (:meth:`picked`), so a wrong pick, "None of these match", a timeout or a stop
      (:meth:`abandon`) never delivers it.
    - ``VOUCH_RESULT``: M to D, at most once, after a verified ``VOUCH_REQ``.
    - ``0x0030`` to ``0x003F``: M to D, only after an ``approved`` result; D holds them (16 records,
      16 KiB, then ``peer_busy``) until its person confirms the account (:meth:`confirm_account`, rule 12).

    No silent approval (rule 10): :attr:`may_finish` is true only after the right pick and a verified
    request, which is when ``nearby/approve`` may be called."""

    def __init__(self, role: str) -> None:
        if role not in ("requester", "approver"):
            raise ValueError("role")
        self.role = role
        self._dead: Optional[str] = None
        self._negotiated = False
        self._shown = False
        self._picked = False
        self._request_seen = False
        self._request_sent = False
        self._held: Optional[R] = None
        self._verified = False
        self._result_sent = False
        self._result_seen = False
        self._status: Optional[str] = None
        self._confirmed = False
        self._queue: List[R] = []
        self._queue_bytes = 0

    def _close(self, code: str) -> VouchVerdict[R]:
        if self._dead is None:
            self._dead = code
        self._held = None
        self._queue = []
        self._queue_bytes = 0
        return VouchVerdict(False, close=self._dead)

    def _gone(self) -> Optional[VouchVerdict[R]]:
        return None if self._dead is None else VouchVerdict(False, close=self._dead)

    def negotiate(self, local: Sequence[str], remote: Sequence[str]) -> VouchVerdict[R]:
        """Rule 1: both payloads list ``vouch/1``; call once, when the session is ``established``."""
        gone = self._gone()
        if gone is not None:
            return gone
        if VOUCH_CAP not in caps_intersection(local, remote):
            return self._close(ErrorCode.PEER_NOT_ALLOWED)
        self._negotiated = True
        return VouchVerdict(True)

    def code_shown(self) -> None:
        """This side's screen shows the code (D: the code; M: the three codes)."""
        self._shown = True

    def picked(self) -> VouchVerdict[R]:
        """M: the person picked the code D shows. Hands over the held request, if it arrived."""
        gone = self._gone()
        if gone is not None:
            return gone
        if self.role != "approver" or not self._negotiated or not self._shown:
            return self._close(ErrorCode.PEER_NOT_ALLOWED)
        self._picked = True
        out: List[R] = [] if self._held is None else [self._held]
        self._held = None
        return VouchVerdict(True, out)

    def abandon(self, reason: str) -> VouchVerdict[R]:
        """M: the session ends before a right pick; the request is never delivered (rule 4)."""
        return self._close(ErrorCode.PEER_TIMEOUT if reason == "timeout" else ErrorCode.PEER_BYE)

    def verified(self) -> None:
        """M: the delivered request verified (:func:`verify_vouch_request`)."""
        if self._picked and self._request_seen:
            self._verified = True

    @property
    def may_finish(self) -> bool:
        """M: may ``nearby/approve`` be called for this session? (rule 10; N12)"""
        return self._dead is None and self._verified and not self._result_sent and self.role == "approver"

    def confirm_account(self) -> VouchVerdict[R]:
        """D: the person confirmed the signed-in account; held records are handed over (rule 12)."""
        gone = self._gone()
        if gone is not None:
            return gone
        self._confirmed = True
        out = self._queue
        self._queue = []
        self._queue_bytes = 0
        return VouchVerdict(True, out)

    def decline_account(self) -> VouchVerdict[R]:
        """D: the person declined, or the screen timed out: every held record is dropped (rule 12)."""
        return self._close(ErrorCode.PEER_BYE)

    def receive(self, r: R) -> VouchVerdict[R]:
        """A record arrived from the peer."""
        gone = self._gone()
        if gone is not None:
            return gone
        t = r.type  # type: ignore[attr-defined]
        if t == RECORD["VOUCH_REQ"]:
            return self._receive_request(r)
        if t == RECORD["VOUCH_RESULT"]:
            return self._receive_result(r)
        if _is_sync(t):
            return self._receive_sync(r)
        return VouchVerdict(True, [r])

    def _receive_request(self, r: R) -> VouchVerdict[R]:
        if self.role != "approver" or not self._negotiated:
            return self._close(ErrorCode.PEER_NOT_ALLOWED)
        if self._request_seen:
            return self._close(ErrorCode.PEER_BAD_FRAME)
        self._request_seen = True
        if self._picked:
            return VouchVerdict(True, [r])
        self._held = r
        return VouchVerdict(True)

    def _receive_result(self, r: R) -> VouchVerdict[R]:
        if self.role != "requester" or not self._negotiated or not self._request_sent:
            return self._close(ErrorCode.PEER_NOT_ALLOWED)
        if self._result_seen:
            return self._close(ErrorCode.PEER_BAD_FRAME)
        got = parse_vouch_result(r.body)  # type: ignore[attr-defined]
        if got.refuse is not None:
            return self._close(got.refuse)
        self._result_seen = True
        self._status = got.status
        return VouchVerdict(True, [r])

    def _receive_sync(self, r: R) -> VouchVerdict[R]:
        if self.role != "requester" or not self._negotiated or self._status != "approved":
            return self._close(ErrorCode.PEER_NOT_ALLOWED)
        if self._confirmed:
            return VouchVerdict(True, [r])
        size = len(r.body)  # type: ignore[attr-defined]
        if len(self._queue) >= VOUCH_HELD_RECORDS or self._queue_bytes + size > VOUCH_HELD_BYTES:
            return self._close(ErrorCode.PEER_BUSY)
        self._queue.append(r)
        self._queue_bytes += size
        return VouchVerdict(True)

    def send(self, r: R) -> VouchVerdict[R]:
        """This end is about to send a record. The sender's checks are the receiver's."""
        gone = self._gone()
        if gone is not None:
            return gone
        t = r.type  # type: ignore[attr-defined]
        if t == RECORD["VOUCH_REQ"]:
            if self.role != "requester" or not self._negotiated or not self._shown:
                return self._close(ErrorCode.PEER_NOT_ALLOWED)
            if self._request_sent:
                return self._close(ErrorCode.PEER_BAD_FRAME)
            self._request_sent = True
            return VouchVerdict(True, [r])
        if t == RECORD["VOUCH_RESULT"]:
            if self.role != "approver" or not self._verified:
                return self._close(ErrorCode.PEER_NOT_ALLOWED)
            if self._result_sent:
                return self._close(ErrorCode.PEER_BAD_FRAME)
            got = parse_vouch_result(r.body)  # type: ignore[attr-defined]
            if got.refuse is not None:
                return self._close(got.refuse)
            self._result_sent = True
            self._status = got.status
            return VouchVerdict(True, [r])
        if _is_sync(t):
            if self.role != "approver" or self._status != "approved":
                return self._close(ErrorCode.PEER_NOT_ALLOWED)
            return VouchVerdict(True, [r])
        return VouchVerdict(True, [r])
