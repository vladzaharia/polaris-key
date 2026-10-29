"""WIRE-CONTRACT-V5 §15.5 and §15.6: one ``pkey-peer/1`` session, per mode (``a`` account, ``v``
approver, ``p`` pair). Mirrors ``packages/client-core/src/peer/session.ts``.

A pure, synchronous engine: it owns no socket and starts no timer or thread. Noise messages come in
through :meth:`PeerSession.receive` (already de-framed) and go out through the ``send`` callback; the
host's loop calls :meth:`PeerSession.tick` when :meth:`PeerSession.wake_in` says a deadline is due.
Clocks are injected (``now`` in epoch seconds, ``mono`` in monotonic seconds).

Order: Noise XXpsk0 with the payload rules of §15.5; each side verifies the other's certificate against
the remote static key and the held roster; then HELLO each way, which must be the first record. Nothing
is delivered to the host (``Record`` events) before that. Every failure ends the session; before the
transport exists nothing is sent, after it a CLOSE record names the code.

Modes ``v`` and ``p``: after HELLO the initiator (the device) commits to a nonce, the responder (the
approver) answers with its own, the initiator reveals, and both show the same six-digit code. The
host calls :meth:`PeerSession.confirm_sas` when the person agrees; until then host records from the
peer are held (at most 16 records and 16 KiB of bodies, then ``peer_busy``). HELLO display data is
unauthenticated there: a HELLO is at most 4 KiB, ``label`` and ``app`` are cleaned (NFC, controls and
bidi stripped, 64 code points; an empty ``app`` is "Unknown"), and a ``platform`` that is not at most 32 of
``A-Z a-z 0-9 space . _ + -`` is "Unknown". A responder in these modes needs a :class:`HandshakeLimiter`.

Keys: the device's static private key is handed to the Noise engine only, as bytes or a key port whose
``dh`` runs the static operations (G1). A session's repr names no key, and it cannot be pickled (G19).
"""

from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from .b64url import b64url_encode
from .device_label import normalize_device_label
from .jws import TrustSet
from .peer_cert import PeerSession as CertSession
from .peer_cert import admit_peer, replace_ring, ring_expired, verify_ring
from .peer_frame import (
    MAX_PEER_MESSAGE_BYTES,
    RECORD,
    PeerRecord,
    RecordAssembler,
    encode_record,
    parse_record,
    split_message,
)
from .peer_noise import (
    NoiseError,
    NoiseHandshake,
    NoisePorts,
    NoiseTransport,
    peer_noise_protocol,
    peer_prologue,
    peer_psk,
)
from .peer_payload import (
    caps_intersection,
    parse_handshake_payload,
    parse_strict_object,
    payload1,
    payload23,
)
from .peer_sas import (
    encode_sas_value,
    parse_sas_body,
    sas_body,
    sas_commit,
    sas_display,
    sas_reveal_ok,
    sas_value,
)

__all__ = [
    "AccountContext",
    "Closed",
    "Established",
    "HandshakeLimiter",
    "PeerHello",
    "PeerSession",
    "Record",
    "RingReceived",
    "RingWanted",
    "Sas",
    "SAS_DEADLINE_SECONDS",
    "SessionEvent",
    "TRANSPORT_DEADLINE_SECONDS",
    "TrustUnverified",
]

#: Seconds from the first byte to the transport.
TRANSPORT_DEADLINE_SECONDS = 30
SAS_DEADLINE_SECONDS = 120
_MAX_QUEUED = 16
#: §15.6: bytes of held records before the person's confirmation, modes v and p.
_MAX_QUEUED_BYTES = 16 * 1024
#: §15.6: a HELLO in mode v or p is at most this many bytes.
_MAX_UNVERIFIED_HELLO = 4096
#: §15.6: ``platform`` is shown as sent only when it is up to 32 of these characters; else "Unknown".
_PLATFORM_DISPLAY = re.compile(r"[A-Za-z0-9 ._+-]{1,32}")
_UNKNOWN_DISPLAY = "Unknown"
_MAX_SAFE_INTEGER = 2**53 - 1
_KNOWN_CLOSE = frozenset(
    {
        "peer_revoked",
        "peer_expired",
        "peer_bad_frame",
        "peer_unknown_critical",
        "peer_not_allowed",
        "peer_busy",
        "peer_bye",
        "peer_timeout",
    }
)
_OWNED = frozenset(
    {
        RECORD["HELLO"],
        RECORD["CLOSE"],
        RECORD["REKEY"],
        RECORD["SAS_COMMIT"],
        RECORD["SAS_NONCE"],
        RECORD["SAS_REVEAL"],
    }
)
_DEFAULT_PORTS = NoisePorts()
_NONE = b""

StaticKey = Union[bytes, bytearray, Any]


@dataclass(frozen=True)
class PeerHello:
    """The peer's HELLO: display data (authenticated in mode a, by the certificate that opened the session)."""

    platform: str
    app: str
    max_message: int
    label: Optional[str] = None


@dataclass(frozen=True)
class AccountContext:
    """What mode a needs: this device's certificate, roster view and trust."""

    trust: TrustSet
    #: ``aud``: the product slug.
    expected_aud: str
    #: This device's ``pkey-peer+jws``.
    cert_jws: str
    own_sub: str
    own_device_id: str
    #: The held roster as ``(jws, epoch)``, read at use; ``None`` when there is none.
    held_ring: Callable[[], Optional[Tuple[str, int]]]
    #: The delivered discovery keys, newest first. The initiator uses the first; the responder tries
    #: the first two. An absent (``None``) previous key is skipped.
    disc_keys: Sequence[Optional[bytes]] = field(repr=False, default=())

    def __repr__(self) -> str:
        return "AccountContext()"

    def __reduce__(self) -> Any:
        raise TypeError("AccountContext cannot be pickled")


@dataclass(frozen=True)
class Sas:
    """Modes v and p: the code both screens show; the host calls ``confirm_sas()`` when the person agrees."""

    code: int
    display: str
    type: str = "sas"


@dataclass(frozen=True)
class Established:
    """The handshake and the HELLO exchange are done (modes v and p still need the SAS)."""

    caps: List[str]
    hello: PeerHello
    hello_authenticated: bool
    remote_static: bytes
    #: The admitted certificate's device id.
    peer_device_id: Optional[str] = None
    type: str = "established"


@dataclass(frozen=True)
class Record:
    """A record the host owns, delivered only once the session is open. The host must close on an
    APP_CRITICAL type (0x8100 to 0xFFFD) it does not understand."""

    record_type: int
    body: bytes = field(repr=False)
    type: str = "record"


@dataclass(frozen=True)
class RingReceived:
    """A roster that replaced the held one at ``epoch``; the host stores it."""

    jws: str = field(repr=False)
    epoch: int = 0
    type: str = "ring"


@dataclass(frozen=True)
class TrustUnverified:
    """A ``TRUST`` document the peer sent. Not verified here; the host verifies it (V4 §1)."""

    jws: str = field(repr=False)
    type: str = "trust-unverified"


@dataclass(frozen=True)
class RingWanted:
    """The peer is on a newer roster than the held one, or none is held: fetch it."""

    type: str = "ring-wanted"


@dataclass(frozen=True)
class Closed:
    code: str
    by_peer: bool
    type: str = "closed"


SessionEvent = Union[Established, Sas, Record, RingReceived, TrustUnverified, RingWanted, Closed]


class _Fail(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _default_now() -> int:
    return int(time.time())


class HandshakeLimiter:
    """The approver's admission: at most ``max_per_minute`` handshakes a minute (default 5) and at most
    ``max_pending`` sessions waiting on a code (default 4), on a monotonic clock. An attempt counts only
    when :meth:`begin` is called, which a session does when it starts."""

    def __init__(
        self,
        max_per_minute: int = 5,
        max_pending: int = 4,
        mono: Optional[Callable[[], float]] = None,
    ) -> None:
        self._max = max_per_minute
        self._max_pending = max_pending
        self._mono = mono or time.monotonic
        self._stamps: List[float] = []
        self._pending = 0
        self._lock = threading.Lock()

    def begin(self) -> Optional[Callable[[], None]]:
        """A release function when one more session may start now; ``None`` when refused."""
        with self._lock:
            t = self._mono()
            self._stamps = [x for x in self._stamps if t - x < 60]
            if len(self._stamps) >= self._max or self._pending >= self._max_pending:
                return None
            self._stamps.append(t)
            self._pending += 1
        done = [False]

        def release() -> None:
            with self._lock:
                if not done[0]:
                    done[0] = True
                    self._pending -= 1

        return release


class PeerSession:
    """One session. ``mode`` is ``a`` (``account`` required), or ``v`` / ``p`` (a one-time ``static_key``;
    a responder also needs ``admission``).

    ``static_key`` is the device's agree key in mode a: 32 raw bytes or a key port (``public_key()`` and
    ``dh(remote)``). ``send(noise)`` takes one Noise message (the host frames it); ``on_event`` takes
    :data:`SessionEvent` values and runs on the caller's thread, inside whichever call produced it.
    """

    def __init__(
        self,
        *,
        role: str,
        slug: str,
        static_key: StaticKey,
        account: Optional[AccountContext] = None,
        admission: Optional[HandshakeLimiter] = None,
        send: Callable[[bytes], None],
        on_event: Callable[[Any], None],
        hello: Dict[str, Any],
        mode: str = "a",
        caps: Sequence[str] = (),
        ports: Optional[NoisePorts] = None,
        now: Optional[Callable[[], int]] = None,
        mono: Optional[Callable[[], float]] = None,
        rekey_messages: int = 1 << 20,
        rekey_seconds: float = 3600,
    ) -> None:
        if mode not in ("a", "v", "p"):
            raise ValueError("mode")
        if role not in ("initiator", "responder"):
            raise ValueError("role")
        if (mode == "a") != (account is not None):
            raise ValueError("account context")
        if mode != "a" and role == "responder" and admission is None:
            raise ValueError("an approver needs an admission limiter")
        self._mode = mode
        self._role = role
        self._slug = slug
        self._static = static_key
        self._acct = account
        self._admission = admission
        self._release: Optional[Callable[[], None]] = None
        self._send = send
        self._on_event = on_event
        self._hello = dict(hello)
        self._caps: List[str] = list(caps)
        self._ports = ports
        self._rng = ports if ports is not None else _DEFAULT_PORTS
        self._now = now or _default_now
        self._mono = mono or time.monotonic
        self._rekey_messages = rekey_messages
        self._rekey_seconds = rekey_seconds
        self._lock = threading.RLock()
        self._asm = RecordAssembler(mode)
        self._hs: Optional[NoiseHandshake] = None
        self._hs_step = 0
        self._phase = "hs"  # hs | hello | sas | sas-shown | open | closed
        self._sas_due: Optional[float] = None  # monotonic
        self._n_d: Optional[bytes] = None
        self._n_m: Optional[bytes] = None
        self._commit: Optional[str] = None
        self._sas_done = False
        self._sas_step = 0
        self._queued: List[Tuple[int, bytes]] = []
        self._tp: Optional[NoiseTransport] = None
        self._peer_caps: List[str] = []
        self._peer_ring = 0
        self._sent = 0
        self._keyed_at = self._mono()
        self._max_send = MAX_PEER_MESSAGE_BYTES
        self._started = False
        self._transport_due: Optional[float] = None  # monotonic
        self._cert_expires: Optional[int] = None  # epoch seconds
        self._peer_cert_jws = ""
        self._peer_remote: Optional[bytes] = None
        self._pending: Optional[Tuple[bytes, Optional[str]]] = None

    def __repr__(self) -> str:
        return "PeerSession(mode=%r, role=%r, phase=%r)" % (self._mode, self._role, self._phase)

    def __reduce__(self) -> Any:
        raise TypeError("PeerSession cannot be pickled")

    # -- state ------------------------------------------------------------------------------------

    @property
    def is_open(self) -> bool:
        return self._phase == "open"

    @property
    def closed(self) -> bool:
        return self._phase == "closed"

    def wake_in(self) -> Optional[float]:
        """Seconds until the next deadline (the transport's, the peer certificate's expiry), 0 when one
        is due, ``None`` when there is none. The host calls :meth:`tick` then."""
        if self._phase == "closed":
            return None
        waits: List[float] = []
        if self._transport_due is not None:
            waits.append(self._transport_due - self._mono())
        if self._sas_due is not None:
            waits.append(self._sas_due - self._mono())
        if self._cert_expires is not None:
            waits.append(float(self._cert_expires - self._now()))
        return max(0.0, min(waits)) if waits else None

    def tick(self) -> None:
        """Enforce the deadlines: ``peer_timeout`` when the transport took over 30 s (or, in modes v and
        p, the person took over 120 s), ``peer_expired`` when the peer's certificate ran out."""
        with self._lock:
            if self._phase == "closed":
                return
            if (self._transport_due is not None and self._mono() >= self._transport_due) or (
                self._sas_due is not None and self._mono() >= self._sas_due
            ):
                self._fail("peer_timeout", False)
            elif self._cert_expires is not None and self._now() >= self._cert_expires:
                self._fail("peer_expired", False)

    # -- public calls -----------------------------------------------------------------------------

    def start(self) -> None:
        """Initiator only: write message 1."""
        with self._lock:

            def go() -> None:
                if self._role != "initiator" or self._hs is not None or self._phase != "hs":
                    raise _Fail("handshake_failed")
                key: Optional[bytes] = None
                if self._acct is not None:
                    keys = list(self._acct.disc_keys)
                    key = keys[0] if keys else None
                    if key is None:
                        raise _Fail("handshake_failed")
                self._start_clock()
                self._hs = self._new_handshake(key)
                self._send(self._hs.write_message(payload1()))
                self._hs_step = 1

            self._guard(go)

    def receive(self, noise: bytes) -> None:
        """One Noise message from the peer (a de-framed TCP frame, or a relay ``RECV`` body)."""
        with self._lock:

            def go() -> None:
                if self._phase == "closed":
                    return
                if not self._started and self._role == "responder":
                    # An approver counts the attempt only now that a session starts.
                    if self._admission is not None:
                        self._release = self._admission.begin()
                        if self._release is None:
                            raise _Fail("peer_busy")
                    self._start_clock()
                if self._phase == "hs":
                    self._on_handshake(bytes(noise))
                else:
                    self._on_transport(bytes(noise))

            self._guard(go)

    def send_record(self, type_: int, body: bytes) -> None:
        """Send one message of the host's, split into records. Only once the session is open."""
        with self._lock:
            if self._phase != "open":
                raise RuntimeError("session not open")
            if type_ in _OWNED or (type_ == RECORD["CONFIRM"] and self._mode == "p"):
                raise ValueError("record owned by the session")
            if len(body) > self._max_send:
                raise ValueError("message too large")
            self._emit(type_, bytes(body))

    def confirm_sas(self) -> None:
        """Modes v and p: the person confirmed the code. Opens the session, sends ``CONFIRM`` in mode p
        and delivers the host records held meanwhile."""
        with self._lock:

            def go() -> None:
                if self._phase != "sas-shown":
                    raise _Fail("peer_not_allowed")
                self._phase = "open"
                self._settle()
                if self._mode == "p":
                    self._emit(RECORD["CONFIRM"], b"{}")
                q, self._queued = self._queued, []
                for t, b in q:
                    self._event(Record(t, b))

            self._guard(go)

    def close(self, code: str = "peer_bye") -> None:
        """Close with a code; sends CLOSE when the transport exists."""
        with self._lock:
            self._guard(lambda: self._fail(code, False))

    # -- internals --------------------------------------------------------------------------------

    def _guard(self, fn: Callable[[], None]) -> None:
        try:
            fn()
        except _Fail as e:
            self._fail(e.code, False)
        except NoiseError:
            self._fail("handshake_failed" if self._tp is None else "peer_bad_frame", False)
        except Exception:
            self._fail("handshake_failed", False)

    def _event(self, e: Any) -> None:
        self._on_event(e)

    def _fail(self, code: str, by_peer: bool) -> None:
        if self._phase == "closed":
            return
        was_up = self._tp is not None
        self._phase = "closed"
        self._transport_due = None
        self._cert_expires = None
        self._settle()
        self._queued = []
        if was_up and not by_peer and code != "handshake_failed":
            try:
                self._emit(RECORD["CLOSE"], json.dumps({"code": code}, separators=(",", ":")).encode("utf-8"))
            except Exception:
                pass  # the connection is gone anyway
        self._wipe()
        try:
            self._event(Closed(code, by_peer))
        except Exception:
            pass

    def _settle(self) -> None:
        """The person confirmed, or the session ended: the code deadline and the limiter slot end."""
        self._sas_due = None
        if self._release is not None:
            self._release()
            self._release = None

    def _wipe(self) -> None:
        if self._tp is not None:
            self._tp.send.wipe()
            self._tp.receive.wipe()

    def _start_clock(self) -> None:
        if self._started:
            return
        self._started = True
        self._transport_due = self._mono() + TRANSPORT_DEADLINE_SECONDS
        if self._mode != "a":
            self._sas_due = self._mono() + SAS_DEADLINE_SECONDS

    def _new_handshake(self, disc_key: Optional[bytes]) -> NoiseHandshake:
        return NoiseHandshake(
            self._role,
            peer_noise_protocol(self._mode),
            peer_prologue(self._slug, self._mode),
            self._static,
            psk=peer_psk(disc_key, self._slug) if self._mode == "a" and disc_key is not None else None,
            ports=self._ports,
        )

    def _own_payload(self) -> bytes:
        if self._acct is None:
            return payload23(self._mode, self._caps)
        held = self._acct.held_ring()
        return payload23(self._mode, self._caps, {"cert": self._acct.cert_jws, "ring": held[1] if held else 1})

    def _admit(self, cert_jws: str, ring_jws: Optional[str], remote: bytes) -> Any:
        a = self._acct
        assert a is not None
        return admit_peer(
            cert_jws,
            ring_jws,
            trust=a.trust,
            expected_aud=a.expected_aud,
            now=self._now(),
            session=CertSession(
                mode="a", remote_static=b64url_encode(remote), own_sub=a.own_sub, own_device_id=a.own_device_id
            ),
        )

    def _on_handshake(self, noise: bytes) -> None:
        if self._role == "responder" and self._hs is None:
            # Message 1: try the current then the previous discovery key; a failed tag closes silently.
            payload: Optional[bytes] = None
            acct = self._acct
            for k in list(acct.disc_keys)[:2] if acct is not None else [None]:
                if acct is not None and k is None:
                    continue
                try:
                    h = self._new_handshake(k)
                    payload = h.read_message(noise)
                except NoiseError:
                    continue
                self._hs = h
                break
            if self._hs is None or payload is None:
                raise _Fail("handshake_failed")
            if not parse_handshake_payload(self._mode, 1, payload).ok:
                raise _Fail("handshake_failed")
            self._send(self._hs.write_message(self._own_payload()))
            self._hs_step = 2
            return
        hs = self._hs
        if hs is None:
            raise _Fail("handshake_failed")
        message = 2 if self._role == "initiator" else 3
        if self._hs_step != (1 if self._role == "initiator" else 2):
            raise _Fail("handshake_failed")
        payload = hs.read_message(noise)
        verdict = parse_handshake_payload(self._mode, message, payload)
        if not verdict.ok or verdict.caps is None:
            raise _Fail("handshake_failed")
        remote = hs.remote_static
        if remote is None:
            raise _Fail("handshake_failed")
        peer_device_id: Optional[str] = None
        if self._mode == "a":
            if verdict.cert is None or verdict.ring is None:
                raise _Fail("handshake_failed")
            peer_device_id = self._admit_account(verdict.cert, verdict.ring, remote)
        self._peer_caps = list(verdict.caps)
        if self._role == "initiator":
            self._send(hs.write_message(self._own_payload()))
        self._tp = hs.transport()
        self._transport_due = None
        self._keyed_at = self._mono()
        self._phase = "hello"
        self._pending = (remote, peer_device_id)
        self._send_hello()

    def _admit_account(self, cert: str, peer_ring: int, remote: bytes) -> str:
        a = self._acct
        assert a is not None
        held = a.held_ring()
        if held is not None:
            # A held roster that is expired, unverifiable or another account's must not admit: ask for
            # a fresh one and refuse. Only a device with no roster at all (first run) admits.
            v = verify_ring(held[0], trust=a.trust, expected_aud=a.expected_aud)
            if not v.ok or v.ring is None or ring_expired(v.ring, self._now()) or v.ring.sub != a.own_sub:
                self._event(RingWanted())
                raise _Fail("handshake_failed")
        else:
            self._event(RingWanted())
        adm = self._admit(cert, held[0] if held else None, remote)
        if not adm.admit or adm.cert is None:
            raise _Fail("peer_revoked" if adm.reason == "peer_revoked" else "handshake_failed")
        self._peer_cert_jws = cert
        self._peer_remote = remote
        if adm.cert.expires_at - self._now() <= 0:
            raise _Fail("peer_expired")
        self._cert_expires = adm.cert.expires_at
        self._peer_ring = peer_ring
        if adm.ring_sync == "request":
            self._event(RingWanted())
        return adm.cert.device_id

    def _send_hello(self) -> None:
        h = self._hello
        body: Dict[str, Any] = {}
        if h.get("label") is not None:
            body["label"] = h["label"]
        body["platform"] = h["platform"]
        body["app"] = h["app"]
        body["maxMessage"] = h.get("max_message", MAX_PEER_MESSAGE_BYTES)
        self._emit(RECORD["HELLO"], json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    def _on_transport(self, noise: bytes) -> None:
        tp = self._tp
        if tp is None:
            raise _Fail("handshake_failed")
        plain = tp.receive.decrypt(_NONE, noise)
        rec = parse_record(plain)
        if rec is None:
            raise _Fail("peer_bad_frame")
        r = self._asm.push(rec)
        if r.kind == "close":
            raise _Fail(r.code)
        if r.kind != "message":
            return
        self._on_message(r.type, r.body)

    def _parse_hello(self, body: bytes) -> Optional[PeerHello]:
        # Modes v and p take a HELLO from a peer that is not yet verified: 4 KiB at most (§15.6).
        if self._mode != "a" and len(body) > _MAX_UNVERIFIED_HELLO:
            return None
        o = parse_strict_object(body)
        if o is None:
            return None
        platform, app, label, mm = o.get("platform"), o.get("app"), o.get("label"), o.get("maxMessage")
        if not isinstance(platform, str) or not isinstance(app, str):
            return None
        if "label" in o and not isinstance(label, str):
            return None
        if isinstance(mm, bool) or not isinstance(mm, int) or mm < 1 or mm > _MAX_SAFE_INTEGER:
            return None
        # Display data from an unauthenticated peer: NFC, controls and bidi stripped, 64 code points. An
        # ``app`` with nothing left, and a ``platform`` that is not a known shape, show as "Unknown".
        clean = normalize_device_label(unicodedata.normalize("NFC", label)) if isinstance(label, str) else None
        shown_app = normalize_device_label(unicodedata.normalize("NFC", app)) or _UNKNOWN_DISPLAY
        shown_platform = platform if _PLATFORM_DISPLAY.fullmatch(platform) else _UNKNOWN_DISPLAY
        return PeerHello(shown_platform, shown_app, mm, clean)

    def _on_message(self, type_: int, body: bytes) -> None:
        if self._phase == "hello":
            # The first record each way is HELLO; anything else is refused and closed.
            if type_ != RECORD["HELLO"]:
                raise _Fail("peer_bad_frame")
            hello = self._parse_hello(body)
            if hello is None or self._pending is None:
                raise _Fail("peer_bad_frame")
            self._max_send = min(MAX_PEER_MESSAGE_BYTES, hello.max_message)
            self._caps = caps_intersection(self._caps, self._peer_caps)
            remote, device_id = self._pending
            self._pending = None
            account = self._mode == "a"
            self._phase = "open" if account else "sas"
            self._event(Established(list(self._caps), hello, account, remote, device_id))
            if account:
                self._push_ring()
            elif self._role == "initiator":
                # The device commits first.
                self._n_d = self._rng.random(32)
                self._emit(RECORD["SAS_COMMIT"], sas_body("c", sas_commit(self._n_d)))
                self._sas_step = 1
            return
        if type_ == RECORD["HELLO"]:
            raise _Fail("peer_bad_frame")
        if type_ == RECORD["PING"]:
            self._emit(RECORD["PONG"], body)
            return
        if type_ == RECORD["PONG"]:
            return
        if type_ == RECORD["REKEY"]:
            assert self._tp is not None
            self._tp.receive.rekey()
            return
        if type_ == RECORD["CLOSE"]:
            o = parse_strict_object(body)
            code = o.get("code") if o is not None else None
            self._phase = "closed"
            self._transport_due = None
            self._cert_expires = None
            self._wipe()
            self._event(Closed(code if isinstance(code, str) and code in _KNOWN_CLOSE else "peer_bad_frame", True))
            return
        if type_ == RECORD["TRUST"]:
            o = parse_strict_object(body)
            trust = o.get("trust") if o is not None else None
            if not isinstance(trust, str):
                raise _Fail("peer_bad_frame")
            self._event(TrustUnverified(trust))
            return
        if type_ == RECORD["RING"]:
            self._on_ring(body)
            return
        if type_ in (RECORD["SAS_COMMIT"], RECORD["SAS_NONCE"], RECORD["SAS_REVEAL"]):
            self._on_sas(type_, body)
            return
        # Everything else belongs to the host, and only once the code is settled.
        if self._phase == "sas-shown":
            # The peer may confirm first: hold the record (bounded) until this side's person does.
            held = sum(len(b) for _, b in self._queued)
            if len(self._queued) >= _MAX_QUEUED or held + len(body) > _MAX_QUEUED_BYTES:
                raise _Fail("peer_busy")
            self._queued.append((type_, body))
            return
        if self._phase != "open":
            raise _Fail("peer_not_allowed")
        self._event(Record(type_, body))

    def _on_sas(self, type_: int, body: bytes) -> None:
        if self._phase != "sas" or self._sas_done:
            raise _Fail("peer_bad_frame")
        initiator = self._role == "initiator"
        # Responder (the approver): COMMIT then REVEAL. Initiator (the device): NONCE.
        if type_ == RECORD["SAS_COMMIT"] and not initiator and self._sas_step == 0:
            c = parse_sas_body("c", body)
            if c is None:
                raise _Fail("peer_bad_frame")
            self._commit = encode_sas_value(c)
            self._n_m = self._rng.random(32)
            self._emit(RECORD["SAS_NONCE"], sas_body("nM", self._n_m))
            self._sas_step = 1
            return
        if type_ == RECORD["SAS_NONCE"] and initiator and self._sas_step == 1:
            n_m = parse_sas_body("nM", body)
            if n_m is None or self._n_d is None:
                raise _Fail("peer_bad_frame")
            self._n_m = n_m
            self._emit(RECORD["SAS_REVEAL"], sas_body("nD", self._n_d))
            self._finish_sas()
            return
        if type_ == RECORD["SAS_REVEAL"] and not initiator and self._sas_step == 1:
            n_d = parse_sas_body("nD", body)
            # sas_reveal_ok compares the commitment in constant time.
            if n_d is None or self._commit is None or not sas_reveal_ok(self._commit, encode_sas_value(n_d)):
                raise _Fail("peer_bad_frame")
            self._n_d = n_d
            self._finish_sas()
            return
        raise _Fail("peer_bad_frame")

    def _finish_sas(self) -> None:
        assert self._hs is not None and self._n_d is not None and self._n_m is not None
        code = sas_value(self._hs.handshake_hash, self._n_d, self._n_m, self._mode)
        self._sas_done = True
        self._phase = "sas-shown"
        self._event(Sas(code, sas_display(code)))

    def _push_ring(self) -> None:
        assert self._acct is not None
        held = self._acct.held_ring()
        if held is not None and held[1] > self._peer_ring:
            self._emit(RECORD["RING"], json.dumps({"ring": held[0]}, separators=(",", ":")).encode("utf-8"))

    def _on_ring(self, body: bytes) -> None:
        a = self._acct
        assert a is not None
        o = parse_strict_object(body)
        ring = o.get("ring") if o is not None else None
        if not isinstance(ring, str):
            raise _Fail("peer_bad_frame")
        held = a.held_ring()
        r = replace_ring(
            held[0] if held else None, ring, trust=a.trust, expected_aud=a.expected_aud, now=self._now()
        )
        # A roster that is stale, older or another account's changes nothing.
        if not r.replace or r.ring is None or r.ring.sub != a.own_sub:
            return
        self._event(RingReceived(ring, r.ring.epoch))
        # The new roster may have dropped this peer.
        assert self._peer_remote is not None
        if not self._admit(self._peer_cert_jws, ring, self._peer_remote).admit:
            raise _Fail("peer_revoked")

    def _emit(self, type_: int, body: bytes) -> None:
        """Seal records onto the wire, in order, so a REKEY never interleaves."""
        tp = self._tp
        if tp is None or (self._phase == "closed" and type_ != RECORD["CLOSE"]):
            raise RuntimeError("closed")
        self._maybe_rekey(tp)
        for plain in split_message(type_, body):
            self._send(tp.send.encrypt(_NONE, plain))
            self._sent += 1

    def _maybe_rekey(self, tp: NoiseTransport) -> None:
        if self._sent < self._rekey_messages and self._mono() - self._keyed_at < self._rekey_seconds:
            return
        self._send(tp.send.encrypt(_NONE, encode_record(PeerRecord(RECORD["REKEY"], 0, b""))))
        tp.send.rekey()
        self._sent = 0
        self._keyed_at = self._mono()
