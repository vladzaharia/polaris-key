"""The Cloud Connect identity client (CC-10.1; WIRE-CONTRACT-V5 §15.2, §15.3, §15.4, §15.8):
``client.connect``. On first need it makes this device's keys and registers them
(``devices.register_keys``), fetches ``GET /<p>/connect/identity`` (the roster, this device's
certificate and K_disc), verifies both documents against the effective product set, and keeps them as
``pkey.connect.v1`` in the state directory (:mod:`.state`). Mirrors ``packages/sdk-node/src/connect``.
The LAN, transport and relay halves follow in later slices and read this state.

Rules this module keeps:

* the keys never leave the :class:`~polaris_key.core.device_keys.DeviceKeyPort`; a memory-only port
  refuses unless the host opts in (``allow_ephemeral_keys``), because every restart would be a key
  change and the Worker allows 4 a day;
* a roster or certificate that does not verify is never stored. A roster that is expired, for another
  subject or device, certifies other keys than this device's, or would replace the held roster with a
  lower epoch (stale) or a different subject (foreign) is refused with ``peer-cert-invalid`` and the held
  state is unchanged;
* K_disc is stored exactly as the latest answer delivered it, never merged with older answers. The
  previous key is dropped when the roster lost a device or changed a device's keys since the held one
  (the Worker drops it for a leave; this is the same rule on the client), after :meth:`leave`, and 24
  hours after it was first seen;
* K_disc is in no return value, ``repr``, error or log except :meth:`ConnectClient.discovery_keys`,
  which hands out bytes for the advert code.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Callable, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx

from ..constants_generated import ErrorCode, Feature
from ..core.b64url import b64url_decode, b64url_encode
from ..core.context import CoreContext, refusal_error, wire_code_of
from ..core.device_keys import (
    DeviceKeyError,
    DeviceKeyPort,
    DeviceKeyStoreError,
    DeviceKeysUnreadableError,
    DeviceKeyUnsupportedError,
    DevicePublicKeys,
)
from ..core.errors import PolarisError
from ..core.jws import TrustSet
from ..core.peer_cert import (
    MAX_RING_DEVICES,
    PEER_CERT_RENEW_SECONDS,
    PeerCert,
    PeerDeviceKeys,
    Ring,
    replace_ring,
    ring_expired,
    verify_peer_cert,
    verify_ring,
)
from ..core.token import TokenManager
from ..devices.client import DevicesClient
from ..devices.keys import DEVICE_KEYS_FILE, DeviceKeyStorage, DeviceKeyStore, FileDeviceKeyStorage
from .errors import RELAY_PROTOCOL, LanError, RelayError
from .state import CONNECT_STATE_FILE, ConnectStateRecord, connect_storage, keys_after_ring, parse_connect_state

__all__ = [
    "ConnectClient",
    "ConnectDevice",
    "ConnectIdentity",
    "DiscoveryKeys",
    "PREV_DISC_KEY_SECONDS",
    "PeerSource",
    "RelayGrant",
    "RingAdoption",
]

_TICKET = re.compile(r"pkeyrt_[A-Za-z0-9_-]{32}\Z")

#: The Worker keeps the previous K_disc for 24 hours after a bump (§15.4).
PREV_DISC_KEY_SECONDS = 86_400

_DISC_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")


@dataclass(frozen=True)
class ConnectIdentity:
    """What the host sees of the held identity. No K_disc, no private key."""

    #: The pairwise subject (``ps_...``) the roster belongs to.
    sub: str
    device_id: str
    #: The roster's epoch.
    epoch: int
    #: Every device of the person: id and public keys.
    devices: Tuple[PeerDeviceKeys, ...]
    #: This device's ``pkey-peer+jws`` (shown to peers in a handshake; not secret).
    certificate: str
    certificate_expires_at: int
    #: The held ``pkey-ring+jws`` (sent to a peer that asks for ``RING``).
    ring: str
    ring_expires_at: int


@dataclass(frozen=True)
class ConnectDevice:
    """One of the person's devices, display data only (``GET /<p>/connect/devices``)."""

    device_id: str
    label: Optional[str]
    platform: Optional[str]
    last_seen: Optional[int]
    self: bool


@dataclass(frozen=True)
class DiscoveryKeys:
    """K_disc as bytes, newest first (§15.4). A device advertises under ``current`` only."""

    current: bytes = field(repr=False)
    previous: Optional[bytes] = field(repr=False)

    def __repr__(self) -> str:
        return "<DiscoveryKeys>"

    def __reduce__(self) -> Any:
        raise TypeError("discovery keys cannot be pickled")


@dataclass(frozen=True)
class RelayGrant:
    """The ticket answer (§15.7), checked. The ticket is single use and never in a ``repr``."""

    ticket: str = field(repr=False)
    url: str
    protocol: str
    #: Seconds since the epoch.
    expires_at: int

    def __repr__(self) -> str:
        return "<RelayGrant>"

    def __reduce__(self) -> Any:
        raise TypeError("a relay grant cannot be pickled")


@dataclass(frozen=True)
class RingAdoption:
    """What storing a peer-pushed roster answers: ``stored`` with the new ``epoch``, or a ``reason``."""

    stored: bool
    epoch: Optional[int] = None
    reason: Optional[str] = None


class _StaticKey:
    """The device's static key as Noise sees it: ``public_key()`` and ``dh()``; the private half stays in the port."""

    def __init__(self, port: DeviceKeyPort, agree_public: bytes) -> None:
        self._port = port
        self._pub = agree_public

    def public_key(self) -> bytes:
        return self._pub

    def dh(self, remote: bytes) -> Optional[bytes]:
        return self._port.dh(remote)

    def __repr__(self) -> str:
        return "<StaticKey>"

    def __reduce__(self) -> Any:
        raise TypeError("a static key handle cannot be pickled")


@dataclass(frozen=True)
class PeerSource:
    """A snapshot of what a LAN or relay session reads of the held identity (the Node ``LanIdentity``).
    K_disc and the certificate are in it, so it has no ``repr`` and cannot be pickled."""

    slug: str
    trust: TrustSet = field(repr=False)
    sub: str
    device_id: str
    cert_jws: str = field(repr=False)
    cert_expires_at: int = 0
    ring_jws: str = field(repr=False, default="")
    ring_epoch: int = 0
    #: Every roster device id, this one included.
    roster: Tuple[str, ...] = ()
    #: K_disc, newest first.
    keys: DiscoveryKeys = field(repr=False, default=None)  # type: ignore[assignment]
    #: The device's X25519 public key.
    agree_public: bytes = field(repr=False, default=b"")
    #: The static key handle for Noise (``public_key()`` and ``dh()``).
    static_key: Any = field(repr=False, default=None)

    def __repr__(self) -> str:
        return "<PeerSource>"

    def __reduce__(self) -> Any:
        raise TypeError("a peer source cannot be pickled")


def _retry_after_seconds(header: Optional[str]) -> Optional[int]:
    """Whole seconds from a ``Retry-After`` header: delay-seconds or an HTTP date, never negative."""
    text = (header or "").strip()
    if not text:
        return None
    if re.fullmatch(r"[0-9]+(\.[0-9]+)?", text):
        return int(-(-float(text) // 1))
    try:
        at = parsedate_to_datetime(text).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0, int(-(-(at - time.time()) // 1)))


def _malformed(reason: str) -> PolarisError:
    """An answer that is not in the contract's shape (``bad_response``), apart from one that fails verification."""
    return PolarisError(ErrorCode.BAD_RESPONSE, f"The Cloud Connect identity was refused: {reason}.")


def _refuse(reason: str) -> PolarisError:
    return PolarisError(ErrorCode.PEER_CERT_INVALID, f"The Cloud Connect identity was refused: {reason}.")


def _valid_disc_key(v: Any) -> bool:
    if not isinstance(v, str) or _DISC_KEY.match(v) is None:
        return False
    try:
        raw = b64url_decode(v)
    except ValueError:
        return False
    return len(raw) == 32 and b64url_encode(raw) == v


def _same_device(a: PeerDeviceKeys, b: PeerDeviceKeys) -> bool:
    return a.device_id == b.device_id and a.sign_key == b.sign_key and a.agree_key == b.agree_key


def _same_devices(a: Tuple[PeerDeviceKeys, ...], b: Tuple[PeerDeviceKeys, ...]) -> bool:
    return len(a) == len(b) and all(_same_device(x, y) for x, y in zip(a, b))


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


class ConnectClient:
    """``client.connect``. Sync; every call is serialised."""

    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        devices: DevicesClient,
        trust: Callable[[], TrustSet],
        *,
        device_keys: Optional[DeviceKeyPort] = None,
        allow_ephemeral_keys: bool = False,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._devices = devices
        self._trust = trust
        self._port = device_keys
        self._allow_ephemeral = allow_ephemeral_keys is True
        self._storage: Optional[DeviceKeyStorage] = None
        self._lock = threading.RLock()

    def __repr__(self) -> str:
        return "<ConnectClient>"

    def __reduce__(self) -> Any:
        raise TypeError("a Cloud Connect client cannot be pickled")

    def use_device_keys(self, keys: DeviceKeyPort) -> None:
        """Use these device keys from now on."""
        with self._lock:
            self._port = keys
            self._storage = None

    # ── Public API ───────────────────────────────────────────────────────────────────────────

    def identity(self, *, refresh: bool = False) -> ConnectIdentity:
        """The held identity, fetching it first when none is held, when it is nearing its end (the
        certificate has less than ``PEER_CERT_RENEW_SECONDS`` left, or the roster expired), when this
        device's keys changed, or when ``refresh`` is set. Makes and registers the device keys on first
        need. Raises :class:`~polaris_key.core.errors.PolarisError`: ``connect-unavailable`` (Connect
        off here), ``invalid-options`` (a memory-only key store the host did not allow), ``no-token``,
        the Worker's own refusals (``account_required``, ``device_keys_required``, ``ring_too_large``)
        and ``peer-cert-invalid`` for an answer that fails verification."""
        with self._lock:
            return self._identity(refresh)

    def current(self) -> Optional[ConnectIdentity]:
        """The held identity as it stands, verified again now; ``None`` when none is held, it does not
        verify any more or its roster expired. Sends nothing and makes no keys."""
        with self._lock:
            held = self._load()
            if held is None:
                return None
            ring, cert = self._verify_held(held)
            if ring is None or cert is None or ring_expired(ring, self._ctx.now()):
                return None
            return self._view(held, ring, cert)

    def list_devices(self) -> List[ConnectDevice]:
        """``GET /<p>/connect/devices``: the person's devices, display data only."""
        with self._lock:
            self._available()
            self._require_token()
            port = self._use_port()
            self._register_if_needed(port, self._load())
            res = self._get("connect/devices", "connect devices")
            try:
                body = res.json()
            except Exception:
                body = None
            rows = body.get("devices") if isinstance(body, dict) else None
            if not isinstance(rows, list) or len(rows) > MAX_RING_DEVICES:
                raise _malformed("the device list is not in the contract shape")
            out: List[ConnectDevice] = []
            for d in rows:
                if (
                    not isinstance(d, dict)
                    or not isinstance(d.get("deviceId"), str)
                    or not isinstance(d.get("self"), bool)
                ):
                    raise _malformed("a device entry is not in the contract shape")
                out.append(
                    ConnectDevice(
                        device_id=d["deviceId"],
                        label=d["label"] if isinstance(d.get("label"), str) else None,
                        platform=d["platform"] if isinstance(d.get("platform"), str) else None,
                        last_seen=d["lastSeen"] if _is_int(d.get("lastSeen")) else None,
                        self=d["self"],
                    )
                )
            return out

    def discovery_keys(self) -> Optional[DiscoveryKeys]:
        """K_disc as bytes for the advert code, or ``None`` when none is held. The previous key is left
        out once 24 hours have passed since it was first seen."""
        with self._lock:
            held = self._load()
            # After a pushed roster removed a device the Worker replaced K_disc; this copy is not used
            # (not for adverts, not for browsing) until an identity fetch brings the new one.
            if held is None or held.keys_stale:
                return None
            now = self._ctx.now()
            prev: Optional[bytes] = None
            if len(held.disc_keys) == 2 and held.prev_until is not None and now < held.prev_until:
                prev = b64url_decode(held.disc_keys[1])
            return DiscoveryKeys(b64url_decode(held.disc_keys[0]), prev)

    def relay_ticket(self) -> RelayGrant:
        """``POST /<p>/connect/relay/ticket``: a single-use ``pkeyrt_`` ticket for the WebSocket. Raises
        :class:`RelayError`: ``disabled``, ``paused`` (with ``retry_after_seconds``), ``quota`` (with the
        ``scope``), ``ticket_invalid`` (a ticket that is not in the contract shape); and
        :class:`~polaris_key.core.errors.PolarisError` for ``no-token`` and the Worker's other refusals."""
        # The Worker answers ``device_keys_required`` for a device without registered keys, and 404 when
        # the operator's launch gate is off; identity() is what registers and checks discovery.
        token = self._require_token()
        what = "connect relay ticket"
        url = self._ctx.url("connect/relay/ticket")
        try:
            # Straight to the HTTP client: ``ctx.request`` turns a 503 into ``server-error`` and drops
            # ``Retry-After``, which is what a paused relay answers with.
            res = self._ctx.http().request(
                "POST",
                url,
                headers=self._ctx.headers({"authorization": f"Bearer {token}"}),
                timeout=self._ctx.timeout,
            )
        except (httpx.HTTPError, OSError) as e:
            raise PolarisError(
                ErrorCode.NETWORK_ERROR, f"POST connect/relay/ticket got no answer: {str(e) or type(e).__name__}"
            ) from e
        if not (200 <= res.status_code < 300):
            wire = wire_code_of(res)
            retry = _retry_after_seconds(res.headers.get("retry-after"))
            status = res.status_code
            if wire == ErrorCode.RELAY_DISABLED:
                raise RelayError(
                    "disabled", "This product has its relay off.", retry_after_seconds=retry, status=status
                )
            if wire == ErrorCode.RELAY_PAUSED:
                raise RelayError(
                    "paused", "The relay is paused; try again later.", retry_after_seconds=retry, status=status
                )
            if wire == ErrorCode.RELAY_QUOTA_EXCEEDED:
                try:
                    body = res.json()
                except Exception:
                    body = None
                scope = body.get("scope") if isinstance(body, dict) else None
                raise RelayError(
                    "quota",
                    "The relay quota is spent.",
                    retry_after_seconds=retry,
                    status=status,
                    scope=scope if scope in ("person", "product") else None,
                )
            if wire == ErrorCode.RELAY_TICKET_INVALID:
                raise RelayError(
                    "ticket_invalid", "The relay refused the device.", retry_after_seconds=retry, status=status
                )
            raise refusal_error(res, what)
        try:
            body = res.json()
        except Exception:
            body = None
        return self._grant(body)

    def _grant(self, body: Any) -> RelayGrant:
        """The ticket answer, shape-checked, and bound to this Worker: the ticket goes only to the
        Worker's own host over ``wss:`` and only for the protocol this client speaks."""

        def bad() -> RelayError:
            return RelayError("ticket_invalid", "The relay ticket answer is not in the contract shape.")

        if not isinstance(body, dict):
            raise bad()
        ticket, url = body.get("ticket"), body.get("url")
        protocol, expires = body.get("protocol"), body.get("expiresAt")
        if (
            not isinstance(ticket, str)
            or _TICKET.match(ticket) is None
            or not isinstance(url, str)
            or protocol != RELAY_PROTOCOL
            or not isinstance(expires, int)
            or isinstance(expires, bool)
            or abs(expires) > 2**53 - 1
        ):
            raise bad()
        try:
            target = urlsplit(url)
            home = urlsplit(self._ctx.base_url)
            same_host = (target.hostname, target.port) == (home.hostname, home.port)
        except ValueError:
            raise bad() from None
        if target.scheme != "wss" or not same_host or target.hostname is None:
            raise bad()
        return RelayGrant(ticket, url, protocol, expires)

    def peer_source(self) -> PeerSource:
        """A snapshot of the held identity for a LAN or relay session: slug, trust, subject, device id,
        certificate, roster, K_disc newest first and the key port. Raises :class:`LanError`
        (``no_identity`` without a verified identity, ``no_keys`` without K_disc or device keys)."""
        with self._lock:
            ident = self.current()
            if ident is None:
                raise LanError("no_identity", "No Cloud Connect identity is held; call identity() first.")
            keys = self.discovery_keys()
            port = self._port
            pub = port.public_keys() if port is not None else None
            if keys is None or port is None or pub is None:
                raise LanError("no_keys", "The device keys or K_disc are not held.")
            agree = b64url_decode(pub.agree_key)
            return PeerSource(
                slug=self._ctx.product,
                trust=self._trust(),
                sub=ident.sub,
                device_id=ident.device_id,
                cert_jws=ident.certificate,
                cert_expires_at=ident.certificate_expires_at,
                ring_jws=ident.ring,
                ring_epoch=ident.epoch,
                roster=tuple(d.device_id for d in ident.devices),
                keys=keys,
                agree_public=agree,
                static_key=_StaticKey(port, agree),
            )

    def adopt_ring(self, jws: str) -> RingAdoption:
        """Store a roster a peer pushed, under the identity fetch's rules (§15.3): it must verify, be for
        the held subject, have a higher epoch than the held one, not be expired, and still list this
        device with the keys it registered. The certificate is kept; the next ``identity()`` fetches the
        one that goes with the new epoch. A roster that dropped a device marks K_disc stale."""
        with self._lock:
            held = self._load()
            if held is None:
                return RingAdoption(False, reason="no_identity")
            now = self._ctx.now()
            trust = self._trust()
            aud = self._ctx.product
            held_ring, held_cert = self._verify_held(held)
            subject = held_ring.sub if held_ring is not None else (held_cert.sub if held_cert is not None else None)
            if subject is None:
                return RingAdoption(False, reason="held_unverified")
            r = replace_ring(held.ring, jws, trust=trust, expected_aud=aud, now=now)
            if not r.replace or r.ring is None:
                return RingAdoption(False, reason=r.reason)
            ring = r.ring
            if ring.sub != subject:
                return RingAdoption(False, reason="other_subject")
            mine = held.registered
            if mine is None or not any(
                d.device_id == self._ctx.device_id and d.sign_key == mine[0] and d.agree_key == mine[1]
                for d in ring.devices
            ):
                return RingAdoption(False, reason="device_not_in_roster")
            keys = keys_after_ring(held.disc_keys, held_ring, ring) if held_ring is not None else list(held.disc_keys)
            removed = held_ring is not None and not all(
                any(_same_device(n, d) for n in ring.devices) for d in held_ring.devices
            )
            rec = ConnectStateRecord(
                product=held.product,
                device_id=held.device_id,
                ring=jws,
                certificate=held.certificate,
                disc_keys=keys,
                prev_until=held.prev_until if len(keys) == 2 else None,
                epoch=ring.epoch,
                registered=held.registered,
                stored_at=now,
                keys_stale=removed or held.keys_stale,
            )
            try:
                self._store().update(lambda _cur: rec.to_bytes())
            except DeviceKeyError as e:
                raise self._store_error(e) from e
            return RingAdoption(True, epoch=ring.epoch)

    def leave(self) -> None:
        """Forget the held roster, certificate and K_disc (sign-out, leaving the person's devices). The
        device keys are untouched, and so is the Worker's roster. The next identity starts without a
        previous K_disc."""
        with self._lock:
            try:
                store = self._store()
                # Nothing on disk means nothing to forget: do not make the directory or a lock for it.
                if store.persistence == "durable" and not os.path.exists(
                    os.path.join(self._ctx.dirs.state, CONNECT_STATE_FILE)
                ):
                    return
                store.clear()
            except DeviceKeyError as e:
                raise self._store_error(e) from e

    # ── Identity ─────────────────────────────────────────────────────────────────────────────

    def _identity(self, refresh: bool) -> ConnectIdentity:
        self._available()
        self._require_token()
        port = self._use_port()
        mine = self._ensure_keys(port)
        now = self._ctx.now()
        held = self._load()
        held_ring: Optional[Ring] = None
        held_cert: Optional[PeerCert] = None
        if held is not None:
            held_ring, held_cert = self._verify_held(held)
        if (
            not refresh
            and held is not None
            and held_ring is not None
            and held_cert is not None
            and not held.keys_stale
            and self._fresh(held, held_ring, held_cert, mine, now)
        ):
            return self._view(held, held_ring, held_cert)

        registered_now = self._register_if_needed(port, held)
        try:
            res = self._get("connect/identity", "connect identity")
        except PolarisError as e:
            if registered_now or e.code != ErrorCode.DEVICE_KEYS_REQUIRED:
                raise
            # The Worker forgot the keys (a purge): register once more and ask again.
            self._register(port)
            res = self._get("connect/identity", "connect identity")
        try:
            body = res.json()
        except Exception:
            body = None
        answer = _parse_answer(body)
        rec, view = self._accept(answer, mine, held_ring, held, now)
        try:
            self._store().update(lambda _cur: rec.to_bytes())
        except DeviceKeyError as e:
            raise self._store_error(e) from e
        return view

    def _accept(
        self,
        answer: Tuple[str, str, List[str]],
        mine: DevicePublicKeys,
        held_ring: Optional[Ring],
        held: Optional[ConnectStateRecord],
        now: int,
    ) -> Tuple[ConnectStateRecord, ConnectIdentity]:
        """Verify the answer and decide what to store. Raises ``peer-cert-invalid`` on any refusal; nothing is
        written before this returns."""
        ring_jws, cert_jws, disc_keys = answer
        trust = self._trust()
        aud = self._ctx.product
        r = verify_ring(ring_jws, trust=trust, expected_aud=aud)
        if not r.ok or r.ring is None:
            raise _refuse(f"the roster does not verify ({r.reason})")
        c = verify_peer_cert(cert_jws, trust=trust, expected_aud=aud, now=now)
        if not c.ok or c.cert is None:
            raise _refuse(f"the certificate does not verify ({c.reason})")
        ring, cert = r.ring, c.cert
        if ring_expired(ring, now):
            raise _refuse("the roster is expired")
        if cert.sub != ring.sub:
            raise _refuse("the certificate and roster name different subjects")
        if cert.device_id != self._ctx.device_id:
            raise _refuse("the certificate is for another device")
        if cert.sign_key != mine.sign_key or cert.agree_key != mine.agree_key:
            raise _refuse("the certificate certifies other keys than this device's")
        if cert.ring_epoch != ring.epoch:
            raise _refuse("the certificate and roster are at different epochs")
        me = PeerDeviceKeys(cert.device_id, cert.sign_key, cert.agree_key)
        if not any(_same_device(d, me) for d in ring.devices):
            raise _refuse("this device is not in the roster")

        # The held roster is replaced only by a newer one of the same subject (§15.3). An expired held
        # roster counts as none. The same epoch may be refreshed, never changed.
        prior = held_ring if held_ring is not None and not ring_expired(held_ring, now) else None
        if prior is not None:
            if prior.sub != ring.sub:
                raise _refuse("the roster is for another subject")
            if ring.epoch < prior.epoch:
                raise _refuse("the roster is stale")
            if ring.epoch == prior.epoch and not _same_devices(ring.devices, prior.devices):
                raise _refuse("the roster differs at the held epoch")

        keys = list(disc_keys)
        if len(keys) == 2 and prior is not None and ring.epoch > prior.epoch:
            # A leave, or a device that changed its keys, takes the previous key away (§15.4).
            intact = all(any(_same_device(n, d) for n in ring.devices) for d in prior.devices)
            if not intact:
                keys = [keys[0]]
        same_epoch_prev = (
            held is not None
            and prior is not None
            and prior.epoch == ring.epoch
            and len(held.disc_keys) == 2
            and len(keys) == 2
            and held.disc_keys[1] == keys[1]
        )
        prev_until: Optional[int] = None
        if len(keys) == 2:
            prev_until = (
                held.prev_until
                if same_epoch_prev and held is not None and held.prev_until is not None
                else now + PREV_DISC_KEY_SECONDS
            )
        rec = ConnectStateRecord(
            product=aud,
            device_id=self._ctx.device_id,
            ring=ring_jws,
            certificate=cert_jws,
            disc_keys=keys,
            prev_until=prev_until,
            epoch=ring.epoch,
            registered=(mine.sign_key, mine.agree_key),
            stored_at=now,
        )
        return rec, self._view(rec, ring, cert)

    @staticmethod
    def _fresh(held: ConnectStateRecord, ring: Ring, cert: PeerCert, mine: DevicePublicKeys, now: int) -> bool:
        """Whether the held identity can be used as it is."""
        return (
            held.registered == (mine.sign_key, mine.agree_key)
            and cert.sign_key == mine.sign_key
            and cert.agree_key == mine.agree_key
            and not ring_expired(ring, now)
            and cert.expires_at - now > PEER_CERT_RENEW_SECONDS
            and cert.ring_epoch == ring.epoch
        )

    def _verify_held(self, held: ConnectStateRecord) -> Tuple[Optional[Ring], Optional[PeerCert]]:
        """Each half of the held record verified on its own: a lapsed certificate must not cost the
        roster that the next replacement is judged against."""
        trust = self._trust()
        aud = self._ctx.product
        r = verify_ring(held.ring, trust=trust, expected_aud=aud)
        c = verify_peer_cert(held.certificate, trust=trust, expected_aud=aud, now=self._ctx.now())
        return (r.ring if r.ok else None), (c.cert if c.ok else None)

    @staticmethod
    def _view(rec: ConnectStateRecord, ring: Ring, cert: PeerCert) -> ConnectIdentity:
        return ConnectIdentity(
            sub=ring.sub,
            device_id=rec.device_id,
            epoch=ring.epoch,
            devices=ring.devices,
            certificate=rec.certificate,
            certificate_expires_at=cert.expires_at,
            ring=rec.ring,
            ring_expires_at=ring.expires_at,
        )

    # ── Keys, state and transport ────────────────────────────────────────────────────────────

    def _available(self) -> None:
        """Connect must be on for this product (discovery's ``connect`` member, else the build's
        ``expected_services``), refused as the typed ``product`` N/A."""
        self._ctx.require_service("connect", Feature.CONNECT_IDENTITY, ErrorCode.CONNECT_UNAVAILABLE)

    def _use_port(self) -> DeviceKeyPort:
        if self._port is None:
            self._port = DeviceKeyStore(FileDeviceKeyStorage(os.path.join(self._ctx.dirs.state, DEVICE_KEYS_FILE)))
        port = self._port
        if port.persistence() == "memory" and not self._allow_ephemeral:
            raise PolarisError(
                ErrorCode.INVALID_OPTIONS,
                "The device keys are held in memory only, so every restart would register a new pair. "
                "Use a durable key store or set allow_ephemeral_keys.",
            )
        return port

    def _ensure_keys(self, port: DeviceKeyPort) -> DevicePublicKeys:
        try:
            return port.ensure()
        except DeviceKeyError as e:
            raise self._keys_error(e) from e

    def _register_if_needed(self, port: DeviceKeyPort, held: Optional[ConnectStateRecord]) -> bool:
        """Register the port's keys unless the held record says this pair was already registered. True
        when a registration was sent."""
        mine = self._ensure_keys(port)
        if held is not None and held.registered == (mine.sign_key, mine.agree_key):
            return False
        self._register(port)
        return True

    def _register(self, port: DeviceKeyPort) -> None:
        try:
            self._devices.register_keys(port, allow_ephemeral=self._allow_ephemeral)
        except DeviceKeyError as e:
            raise self._keys_error(e) from e

    def _require_token(self) -> str:
        token = self._tokens.current
        if not token:
            raise PolarisError(ErrorCode.NO_TOKEN, "Register or sign in before using Cloud Connect.")
        return token

    def _get(self, path: str, what: str) -> Any:
        token = self._require_token()
        res = self._ctx.request(
            "GET", self._ctx.url(path), headers=self._ctx.headers({"authorization": f"Bearer {token}"})
        )
        if not (200 <= res.status_code < 300):
            raise refusal_error(res, what)
        return res

    def _store(self) -> DeviceKeyStorage:
        if self._storage is not None:
            return self._storage
        port = self._port
        persistence = "memory" if port is not None and port.persistence() == "memory" else "durable"
        self._storage = connect_storage(self._ctx.dirs.state, persistence)
        return self._storage

    def _load(self) -> Optional[ConnectStateRecord]:
        try:
            raw = self._store().get()
        except DeviceKeyError as e:
            raise self._store_error(e) from e
        if raw is None:
            return None
        try:
            rec = parse_connect_state(bytes(raw))
        finally:
            for i in range(len(raw)):
                raw[i] = 0
        if rec is None:
            raise PolarisError(
                ErrorCode.STORE_FAILED, "The Cloud Connect state record is unreadable; leave() clears it."
            )
        # A record for another product or device is not this device's state.
        if rec.product == self._ctx.product and rec.device_id == self._ctx.device_id:
            return rec
        return None

    @staticmethod
    def _store_error(e: BaseException) -> PolarisError:
        what = str(e) if isinstance(e, DeviceKeyStoreError) else "store fault"
        return PolarisError(ErrorCode.STORE_FAILED, f"The Cloud Connect state could not be used: {what}")

    @staticmethod
    def _keys_error(e: DeviceKeyError) -> PolarisError:
        if isinstance(e, DeviceKeyUnsupportedError):
            return PolarisError(ErrorCode.INVALID_OPTIONS, str(e))
        if isinstance(e, (DeviceKeysUnreadableError, DeviceKeyStoreError)):
            return PolarisError(ErrorCode.STORE_FAILED, f"The device keys could not be used: {e}")
        return PolarisError(ErrorCode.STORE_FAILED, "The device keys could not be used.")


def _parse_answer(body: Any) -> Tuple[str, str, List[str]]:
    """The identity answer's shape: two strings and one or two canonical discovery keys."""
    keys = body.get("discKeys") if isinstance(body, dict) else None
    if (
        not isinstance(body, dict)
        or not isinstance(body.get("ring"), str)
        or not isinstance(body.get("certificate"), str)
        or not isinstance(keys, list)
        or not 1 <= len(keys) <= 2
        or not all(_valid_disc_key(k) for k in keys)
        or (len(keys) == 2 and keys[0] == keys[1])
    ):
        raise _malformed("the answer is not in the contract shape")
    return body["ring"], body["certificate"], list(keys)
