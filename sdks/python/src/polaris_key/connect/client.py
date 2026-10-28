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
  lower epoch (stale) or a different subject (foreign) is refused with ``bad_response`` and the held
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
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, Tuple

from ..constants_generated import ErrorCode, Feature
from ..core.b64url import b64url_decode, b64url_encode
from ..core.context import CoreContext, refusal_error
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
    ring_expired,
    verify_peer_cert,
    verify_ring,
)
from ..core.token import TokenManager
from ..devices.client import DevicesClient
from ..devices.keys import DEVICE_KEYS_FILE, DeviceKeyStorage, DeviceKeyStore, FileDeviceKeyStorage
from .state import CONNECT_STATE_FILE, ConnectStateRecord, connect_storage, parse_connect_state

__all__ = ["ConnectClient", "ConnectDevice", "ConnectIdentity", "DiscoveryKeys", "PREV_DISC_KEY_SECONDS"]

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


def _refuse(reason: str) -> PolarisError:
    return PolarisError(ErrorCode.BAD_RESPONSE, f"The Cloud Connect identity was refused: {reason}.")


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
        need. Raises :class:`~polaris_key.core.errors.PolarisError`: ``service-unavailable`` (Connect
        off here), ``invalid-options`` (a memory-only key store the host did not allow), ``no-token``,
        the Worker's own refusals (``account_required``, ``device_keys_required``, ``ring_too_large``)
        and ``bad_response`` for an answer that fails verification."""
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
                raise _refuse("the device list is not in the contract shape")
            out: List[ConnectDevice] = []
            for d in rows:
                if (
                    not isinstance(d, dict)
                    or not isinstance(d.get("deviceId"), str)
                    or not isinstance(d.get("self"), bool)
                ):
                    raise _refuse("a device entry is not in the contract shape")
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
            if held is None:
                return None
            now = self._ctx.now()
            prev: Optional[bytes] = None
            if len(held.disc_keys) == 2 and held.prev_until is not None and now < held.prev_until:
                prev = b64url_decode(held.disc_keys[1])
            return DiscoveryKeys(b64url_decode(held.disc_keys[0]), prev)

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
        """Verify the answer and decide what to store. Raises ``bad_response`` on any refusal; nothing is
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
        self._ctx.require_service("connect", Feature.CONNECT_IDENTITY)

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
        raise _refuse("the answer is not in the contract shape")
    return body["ring"], body["certificate"], list(keys)
