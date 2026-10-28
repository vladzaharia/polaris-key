"""The Cloud Sync key ring client (U-38.3; WIRE-CONTRACT-V5 §13.10, §13.11). Create the ring, hold
its root ``R``, wrap ``R`` to another device, set the recovery code and recover from it, reset,
adopt, and seal and open values with the root's keys. Mirrors ``packages/sdk-node/src/keyring``.

Rules this module keeps:

* ``R`` lives in this object's memory only. It is never written to disk, returned, logged, put in an
  error or shown in a ``repr`` (the client, the codec and the held root show a marker; none can be
  pickled or copied). A restart gets it back through :meth:`KeyringClient.unlock`: the Worker keeps
  this device's wrap, and only the device's own agreement key opens it. The host decides what else
  may carry a root (nearby approval, a recovery code); this module offers the primitives.
* The device's agreement key never leaves its :class:`~polaris_key.core.device_keys.DeviceKeyPort`:
  a wrap is opened through the port's ``dh``, so no private half is read here.
* The recovery code is returned once, to the caller, and kept nowhere.
* A wrap is accepted only when ``kid(R)`` equals the ring's ``rootKid``.
* The first root this client acquires (create, recover, unlock) pins ``{ring_id, epoch, root_kid}``
  in the state directory (``keyring-pin.json``, owner-only, no secret; in memory when the client
  keeps no state). A served ring or wrap that differs is never opened: :meth:`KeyringClient.unlock`
  answers ``ring-changed``, and only the recovery code (:meth:`~KeyringClient.recover`) or an
  explicit :meth:`~KeyringClient.accept_ring_change` re-pins. Sign-out (:meth:`~KeyringClient.forget`)
  drops the pin.
* (CPython cannot promise to erase every copy of a secret; the zeroing here is best effort.)
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union
from urllib.parse import quote

from ..constants_generated import ErrorCode
from ..core import sync_crypto as sc
from ..core.b64url import b64url_decode, b64url_encode
from ..core.context import CoreContext, refusal_error
from ..core.device_keys import DeviceKeyPort
from ..core.errors import PolarisError
from ..core.local_state import JsonStateFile
from ..core.token import TokenManager

__all__ = [
    "KEM_WIRE_X25519_LEGACY",
    "AdoptRoot",
    "CreatedRing",
    "KeyringClient",
    "KeyringError",
    "KeyringRing",
    "KeyringState",
    "KeyringWrapInfo",
    "RecoveredRing",
    "RecoveryBlob",
    "RingPin",
    "SyncCodec",
    "UnlockResult",
]

#: The spelling an earlier Worker stored for DHKEM X25519. A reader accepts it; a writer sends the
#: contract's integer 32 (``sc.HPKE_KEM_X25519``).
KEM_WIRE_X25519_LEGACY = "x25519"

_HEX = re.compile(r"[0-9a-f]+\Z")
_RING_ID = re.compile(r"rg_[A-Za-z0-9_-]{22}\Z")
_DEVICE_ID_BAD = re.compile(r"[/?#\s]")

RootListener = Union[Callable[[bool], None], Any]


class KeyringError(PolarisError):
    """A refusal that is the client's own: no root (``sync-locked``), a bad recovery code
    (``recovery-code-invalid``), missing device keys, a bad argument. The text never holds a key."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message)


@dataclass(frozen=True)
class KeyringRing:
    ring_id: str
    epoch: int
    root_kid: str
    state: str
    created_at: int
    recovery_set: bool
    recovery_created_at: Optional[int] = None
    adopted: List[Dict[str, Any]] = field(default_factory=list)
    previous: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class KeyringWrapInfo:
    epoch: int
    kid: str
    kem: Union[int, str]
    enc: str
    ct: str
    by: Optional[str] = None


@dataclass(frozen=True)
class KeyringState:
    ring: Optional[KeyringRing]
    wrap: Optional[KeyringWrapInfo]


@dataclass(frozen=True)
class RingPin:
    """What this client pinned when it first acquired a root. It holds no secret."""

    ring_id: str
    epoch: int
    root_kid: str


@dataclass(frozen=True)
class UnlockResult:
    """``kind`` is ``unlocked`` (with ``ring_id`` and ``epoch``), ``locked`` (with ``reason``:
    ``no-ring``, ``no-wrap`` or ``unusable-wrap``) or ``ring-changed``: the served ring is not the
    pinned one (``pinned``, ``served``, and the wrapping device in ``served_by``). Nothing was opened
    or replaced; confirm with the person, then ``recover(code)`` or ``accept_ring_change()``."""

    kind: str
    ring_id: Optional[str] = None
    epoch: Optional[int] = None
    reason: Optional[str] = None
    pinned: Optional[RingPin] = None
    served: Optional[RingPin] = None
    served_by: Optional[str] = None
    served_created_at: Optional[int] = None


@dataclass(frozen=True)
class CreatedRing:
    ring_id: str
    epoch: int
    root_kid: str
    #: The recovery code, shown once, when the ring was made with one. Not in the ``repr``.
    recovery_code: Optional[str] = field(default=None, repr=False)


@dataclass(frozen=True)
class RecoveredRing:
    ring_id: str
    epoch: int
    #: False when the Worker refused this device's own wrap, or one already stood.
    wrap_deposited: bool


@dataclass(frozen=True)
class RecoveryBlob:
    ct: str
    epoch: int
    kid: str


@dataclass(frozen=True)
class AdoptRoot:
    """A root the host holds for an earlier or merged ring, for :meth:`KeyringClient.adopt`."""

    ring_id: str
    epoch: int
    root: bytes = field(repr=False)


class _Held:
    """One root with its ring, kept in a zeroable buffer. Shows nothing but the ring."""

    __slots__ = ("ring_id", "epoch", "kid", "root")

    def __init__(self, ring_id: str, epoch: int, kid: bytes, root: bytes) -> None:
        self.ring_id = ring_id
        self.epoch = epoch
        self.kid = kid
        self.root = bytearray(root)

    def zero(self) -> None:
        sc.zero(self.root)

    def __repr__(self) -> str:
        return f"<held root ring={self.ring_id} epoch={self.epoch}>"

    def __reduce__(self) -> Any:
        raise TypeError("a held root cannot be pickled")

    def __copy__(self) -> Any:
        raise TypeError("a held root cannot be copied")

    def __deepcopy__(self, memo: Any) -> Any:
        raise TypeError("a held root cannot be copied")


class SyncCodec:
    """What the E2E machine's host seals and opens with. It holds no key itself: every call reads
    the ring's current root and refuses with ``sync-locked`` once the ring is locked."""

    def __init__(self, ring: "KeyringClient") -> None:
        self._ring = ring

    @property
    def kid(self) -> Optional[str]:
        """The current root's ``kid``, lowercase hex; ``None`` while locked."""
        h = self._ring._held
        return h.kid.hex() if h is not None else None

    @property
    def locked(self) -> bool:
        return self._ring._held is None

    def seal(self, collection: str, name: str, value: Any) -> bytes:
        return sc.seal_value(self._ring._need().root, collection, name, value)

    def open(
        self,
        collection: str,
        name: str,
        envelope: bytes,
        aliases: Optional[List[str]] = None,
    ) -> sc.OpenedValue:
        """Tries the current root, then any adopted root whose ``kid`` the envelope names."""
        cur = self._ring._need()
        last = sc.open_value(cur.root, collection, name, envelope, aliases)
        if last.ok or last.reason != "kid":
            return last
        kid = bytes(envelope[1 : 1 + sc.SYNC_KID_BYTES])
        for o in list(self._ring._others):
            if o.kid != kid:
                continue
            last = sc.open_value(o.root, collection, name, envelope, aliases)
            if last.ok or last.reason != "kid":
                return last
        return last

    def blind(self, kind: str, ctx: str, name: str) -> str:
        return sc.blind(self._ring._need().root, kind, ctx, name)

    def __repr__(self) -> str:
        return f"<SyncCodec locked={self.locked}>"

    def __reduce__(self) -> Any:
        raise TypeError("a codec cannot be pickled")


def _unhex(s: Any) -> Optional[bytes]:
    if not isinstance(s, str) or len(s) % 2 != 0 or _HEX.match(s) is None:
        return None
    return bytes.fromhex(s)


def _unb64(s: Any, size: Optional[int] = None) -> Optional[bytes]:
    if not isinstance(s, str) or s == "":
        return None
    try:
        out = b64url_decode(s)
    except ValueError:
        return None
    return out if size is None or len(out) == size else None


def _is_x25519(kem: Any) -> bool:
    return (isinstance(kem, int) and not isinstance(kem, bool) and kem == sc.HPKE_KEM_X25519) or (
        kem == KEM_WIRE_X25519_LEGACY
    )


def _bad_arg(what: str) -> KeyringError:
    return KeyringError(ErrorCode.INVALID_ARGUMENT, what)


def _locked() -> KeyringError:
    return KeyringError(ErrorCode.SYNC_LOCKED, "This device holds no root for the key ring; unlock it first.")


def _device_ok(device_id: Any) -> bool:
    return isinstance(device_id, str) and device_id != "" and _DEVICE_ID_BAD.search(device_id) is None


class KeyringClient:
    """``client.keyring``. Sync; every call is one request or none."""

    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        *,
        device_keys: Optional[DeviceKeyPort] = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._keys = device_keys
        self._lock = threading.RLock()
        #: The current root; zeroed on :meth:`lock`.
        self._held: Optional[_Held] = None
        #: Roots of earlier or merged rings, to open data sealed under them.
        self._others: List[_Held] = []
        self._ring: Optional[KeyringRing] = None
        self._listeners: List[RootListener] = []
        self.codec = SyncCodec(self)
        state_dir = ctx.local_state_dir()
        self._pin_file = JsonStateFile(os.path.join(state_dir, "keyring-pin.json") if state_dir else None, lambda: {})

    def __repr__(self) -> str:
        h = self._held
        return f"<KeyringClient unlocked={h is not None} ring={h.ring_id if h else None}>"

    def __reduce__(self) -> Any:
        raise TypeError("a key ring client cannot be pickled")

    def use_device_keys(self, keys: DeviceKeyPort) -> None:
        """Use these device keys from now on (the port ``devices.register_keys`` takes)."""
        self._keys = keys

    def attach(self, machine: RootListener) -> Callable[[], None]:
        """Feed a sync machine: a callable taking a bool, or an object with ``set_root(bool)``. It
        is told now, and on every unlock and lock. Returns a detach function."""
        with self._lock:
            self._listeners.append(machine)
            self._tell(machine)

        def detach() -> None:
            with self._lock:
                if machine in self._listeners:
                    self._listeners.remove(machine)

        return detach

    @property
    def unlocked(self) -> bool:
        return self._held is not None

    def lock(self) -> None:
        """Forget every root held in memory (sign-out, quit). Server rows and wraps are untouched."""
        with self._lock:
            if self._held is not None:
                self._held.zero()
            for o in self._others:
                o.zero()
            self._held = None
            self._others = []
            self._ring = None
            self._notify()

    def forget(self) -> None:
        """Sign-out: forget every root in memory and drop the pin, so the next person on this device
        starts clean. The identity and licence sign-out paths call it."""
        self.lock()
        if self._pin_file.path is None:
            self._pin_file.save({})
        else:
            try:
                os.unlink(self._pin_file.path)
            except OSError:
                pass

    def pin(self) -> Optional[RingPin]:
        """The pinned ring, or ``None`` before this client first acquired a root."""
        v = self._pin_file.load()
        if not isinstance(v, dict) or v.get("product") != self._ctx.product:
            return None
        if not (isinstance(v.get("ringId"), str) and type(v.get("epoch")) is int and isinstance(v.get("rootKid"), str)):
            return None
        # The pin never depends on the subject the Worker serves: only forget() drops it.
        return RingPin(v["ringId"], v["epoch"], v["rootKid"])

    def _write_pin(self, ring_id: str, epoch: int, root_kid: str) -> None:
        self._pin_file.save(
            {
                "product": self._ctx.product,
                "ringId": ring_id,
                "epoch": epoch,
                "rootKid": root_kid,
            }
        )

    # ── Reads ─────────────────────────────────────────────────────────────────────────────────

    def read(self) -> KeyringState:
        """``GET /<p>/devices/keyring``: the ring, and this device's own wrap."""
        res = self._request("GET", "devices/keyring")
        state = _parse_state(_json(res))
        if state is None:
            raise PolarisError(
                ErrorCode.BAD_RESPONSE, "The key ring answer is not in the contract shape.", status=res.status_code
            )
        self._ring = state.ring
        return state

    def unlock(self) -> UnlockResult:
        """Open this device's wrap and hold the root. A device with no ring, no wrap, or a wrap it
        cannot use stays locked (a result, not an error); a ring that is not the pinned one is
        ``ring-changed`` and is not opened; a network or server failure raises."""
        return self._unlock(None)

    def accept_ring_change(self, confirmed: RingPin) -> UnlockResult:
        """The person confirmed that the ring they were shown (``served`` of a ``ring-changed``
        answer) is theirs: open this device's wrap for it and pin it. If the Worker now serves a
        different ring, the answer is ``ring-changed`` again. Call it only from confirmed UI.
        A wrap that does not open leaves the pin as it was."""
        return self._unlock(confirmed)

    def _unlock(self, accept: Optional[RingPin]) -> UnlockResult:
        state = self.read()
        ring, wrap = state.ring, state.wrap
        if ring is None:
            return UnlockResult("locked", reason="no-ring")
        pinned = self.pin()
        expected = accept if accept is not None else pinned
        if expected is not None and (
            expected.ring_id != ring.ring_id or expected.epoch != ring.epoch or expected.root_kid != ring.root_kid
        ):
            return UnlockResult(
                "ring-changed",
                pinned=pinned or expected,
                served=RingPin(ring.ring_id, ring.epoch, ring.root_kid),
                served_by=wrap.by if wrap is not None else None,
                served_created_at=ring.created_at,
            )
        if wrap is None:
            return UnlockResult("locked", reason="no-wrap")
        keys = self._keys
        kid = _unhex(ring.root_kid)
        enc = _unb64(wrap.enc, sc.HPKE_ENC_BYTES)
        ct = _unb64(wrap.ct)
        if (
            keys is None
            or kid is None
            or enc is None
            or ct is None
            or wrap.kid != ring.root_kid
            or wrap.epoch != ring.epoch
            or not _is_x25519(wrap.kem)
        ):
            return UnlockResult("locked", reason="unusable-wrap")
        mine = keys.public_keys()
        agree = _unb64(mine.agree_key, 32) if mine is not None else None
        if agree is None:
            return UnlockResult("locked", reason="unusable-wrap")
        root = sc.unwrap_root(
            keys.dh,
            agree,
            self._wrap_context(ring.ring_id, ring.epoch),
            kid,
            sc.SyncWrap(kem=sc.HPKE_KEM_X25519, enc=enc, ct=ct),
        )
        if root is None or sc.derive_kid(root) != kid:
            return UnlockResult("locked", reason="unusable-wrap")
        self._hold(_Held(ring.ring_id, ring.epoch, kid, root))
        return UnlockResult("unlocked", ring_id=ring.ring_id, epoch=ring.epoch)

    # ── Writes ────────────────────────────────────────────────────────────────────────────────

    def create(self, recovery: bool = True) -> CreatedRing:
        """Make the ring: a fresh root, a wrap to this device and (by default) a recovery blob. The
        root is held on success. ``keyring_conflict`` (a ring exists) leaves nothing held: call
        :meth:`unlock` instead."""
        return self._make_ring("devices/keyring", recovery)

    def reset(self, recovery: bool = True) -> CreatedRing:
        """Start over: a new ring and root, optionally a new recovery code. The server keeps the
        old ring as ``previous`` for 30 days; a root this device held is kept in memory for
        :meth:`adopt`."""
        return self._make_ring("devices/keyring/reset", recovery)

    def wrap_to(self, device_id: str, agree_key: Union[bytes, str]) -> None:
        """Wrap the root to another device of the same person (``PUT .../wraps/{deviceId}``).
        ``agree_key`` is that device's X25519 key (raw bytes or base64url), from the nearby approval:
        the host decides when to call this, and the Worker accepts a wrap only from a device that
        holds one itself."""
        h = self._need()
        if not _device_ok(device_id):
            raise _bad_arg("A device id is required.")
        pub = _unb64(agree_key, 32) if isinstance(agree_key, str) else bytes(agree_key)
        if pub is None or len(pub) != 32:
            raise _bad_arg("The agreement key must be 32 bytes.")
        try:
            w = sc.wrap_root(pub, self._wrap_context(h.ring_id, h.epoch, device_id), h.kid, h.root)
        except ValueError:
            raise _bad_arg("The agreement key is not usable.") from None
        self._send(
            "PUT",
            f"devices/keyring/wraps/{quote(device_id, safe='')}",
            {"epoch": h.epoch, "kid": h.kid.hex(), **_wire_wrap(w)},
        )

    def remove_wrap(self, device_id: str) -> None:
        """``DELETE .../wraps/{deviceId}``: the Worker removes a device's own wrap only."""
        if not _device_ok(device_id):
            raise _bad_arg("A device id is required.")
        self._send("DELETE", f"devices/keyring/wraps/{quote(device_id, safe='')}")

    def set_recovery_code(self) -> str:
        """Make a new recovery code, seal the root under it and store the blob. The previous code
        stops working. Returns the code to show the person; it is kept nowhere."""
        h = self._need()
        code = sc.new_recovery_code()
        try:
            blob = sc.wrap_recovery(code, h.ring_id, h.epoch, h.kid, h.root)
            self._send(
                "PUT",
                "devices/keyring/recovery",
                {"ct": b64url_encode(blob), "epoch": h.epoch, "kid": h.kid.hex()},
            )
            return sc.encode_recovery_code(code)
        finally:
            sc.zero(code)

    def recovery_blob(self) -> RecoveryBlob:
        """``GET .../recovery``: the sealed blob (5 reads a day per device; the account is emailed)."""
        res = self._request("GET", "devices/keyring/recovery")
        body = _json(res)
        ct, epoch, kid = body.get("ct"), body.get("epoch"), body.get("kid")
        if not (isinstance(ct, str) and type(epoch) is int and isinstance(kid, str)):
            raise PolarisError(
                ErrorCode.BAD_RESPONSE, "The recovery answer is not in the contract shape.", status=res.status_code
            )
        return RecoveryBlob(ct=ct, epoch=epoch, kid=kid)

    def recover(self, code_text: str) -> RecoveredRing:
        """Recover the root from the typed or pasted recovery code. The code is checked before any
        request; a bad checksum or a failed unwrap is ``recovery-code-invalid``. On success the root
        is held, and this device deposits its own wrap so the next start unlocks without the code
        (``wrap_deposited`` is False when the Worker refused or a wrap already stood)."""

        def invalid() -> KeyringError:
            return KeyringError(sc.RECOVERY_CODE_INVALID, "The recovery code is not valid for this key ring.")

        code = sc.parse_recovery_code(code_text) if isinstance(code_text, str) else None
        if code is None:
            raise invalid()
        ring = self.read().ring
        if ring is None or not ring.recovery_set:
            raise PolarisError(ErrorCode.NOT_FOUND, "There is no recovery code for this key ring.")
        kid = _unhex(ring.root_kid)
        if kid is None:
            raise PolarisError(ErrorCode.BAD_RESPONSE, "Bad ring kid.")
        blob = self.recovery_blob()
        if blob.epoch != ring.epoch or blob.kid != ring.root_kid:
            raise PolarisError(ErrorCode.BAD_RESPONSE, "The recovery blob does not belong to the current ring.")
        raw = _unb64(blob.ct)
        if raw is None:
            raise invalid()
        root = sc.unwrap_recovery(code, ring.ring_id, ring.epoch, kid, raw)
        if root is None or sc.derive_kid(root) != kid:
            raise invalid()
        self._hold(_Held(ring.ring_id, ring.epoch, kid, root))
        return RecoveredRing(ring.ring_id, ring.epoch, self._deposit_own_wrap())

    def adopt(self, source: Union[str, AdoptRoot]) -> None:
        """Adopt an earlier or merged root under the current one (``POST .../adopt``). Give the id
        of a ring whose root this client holds (kept by :meth:`reset` or :meth:`open_adopted`), or
        an :class:`AdoptRoot` for a root the host has. The root is sealed under ``K_adopt`` of the
        current root."""
        h = self._need()
        old: Optional[_Held] = None
        owned = False
        if isinstance(source, str):
            old = next((o for o in self._others if o.ring_id == source), None)
        elif _RING_ID.match(source.ring_id) and len(source.root) == sc.SYNC_ROOT_BYTES:
            old = _Held(source.ring_id, source.epoch, sc.derive_kid(source.root), source.root)
            owned = True
        try:
            if old is None or _RING_ID.match(old.ring_id) is None or not old.epoch >= 1:
                raise _bad_arg("No root is held for that ring.")
            blob = sc.seal_adopt(h.root, sc.AdoptFrom(old.ring_id, old.epoch, old.kid), old.root)
            self._send(
                "POST",
                "devices/keyring/adopt",
                {
                    "fromRingId": old.ring_id,
                    "epoch": old.epoch,
                    "kid": old.kid.hex(),
                    "ct": b64url_encode(blob),
                },
            )
        finally:
            if owned and old is not None:
                old.zero()

    def open_adopted(self) -> List[str]:
        """Open the ring's ``adopted`` candidates with the current root and keep the roots they
        hold, so ``codec.open`` reads data sealed under them. Returns the ring ids it opened; a
        candidate that does not open (or names a different ``kid``) is skipped."""
        h = self._need()
        ring = self._ring or self.read().ring
        opened: List[str] = []
        for a in ring.adopted if ring is not None else []:
            kid, ct = _unhex(a.get("kid")), _unb64(a.get("ct"))
            if kid is None or ct is None or not isinstance(a.get("ringId"), str):
                continue
            root = sc.open_adopt(h.root, sc.AdoptFrom(a["ringId"], int(a["epoch"]), kid), ct)
            if root is None:
                continue
            if sc.derive_kid(root) != kid:
                continue
            with self._lock:
                for o in [o for o in self._others if o.ring_id == a["ringId"]]:
                    o.zero()
                self._others = [o for o in self._others if o.ring_id != a["ringId"]]
                self._others.append(_Held(a["ringId"], int(a["epoch"]), kid, root))
            opened.append(a["ringId"])
        return opened

    # ── Internals ─────────────────────────────────────────────────────────────────────────────

    def _need(self) -> _Held:
        h = self._held
        if h is None:
            raise _locked()
        return h

    def _hold(self, h: _Held) -> None:
        with self._lock:
            # Pinned first: no root is held without a pin.
            self._write_pin(h.ring_id, h.epoch, h.kid.hex())
            cur = self._held
            if cur is not None:
                # A root for a ring is never replaced by another for the same ring and epoch (§13.11.1).
                if cur.ring_id == h.ring_id and cur.epoch == h.epoch:
                    h.zero()
                    return
                self._others.append(cur)
            self._held = h
            self._notify()

    def _tell(self, m: RootListener) -> None:
        present = self._held is not None
        fn = getattr(m, "set_root", None)
        (fn if callable(fn) else m)(present)

    def _notify(self) -> None:
        for m in list(self._listeners):
            self._tell(m)

    def _wrap_context(self, ring_id: str, epoch: int, device_id: Optional[str] = None) -> sc.WrapContext:
        return sc.WrapContext(self._ctx.product, device_id or self._ctx.device_id, ring_id, epoch)

    def _agree_key(self) -> bytes:
        if self._keys is None:
            raise KeyringError(
                ErrorCode.DEVICE_KEYS_REQUIRED,
                "Device keys are needed for the key ring; give the client a DeviceKeyPort.",
            )
        pub = _unb64(self._keys.ensure().agree_key, 32)
        if pub is None:
            raise KeyringError(ErrorCode.DEVICE_KEYS_INVALID, "The device agreement key is not usable.")
        return pub

    def _make_ring(self, path: str, with_recovery: bool) -> CreatedRing:
        agree = self._agree_key()
        root = bytearray(os.urandom(sc.SYNC_ROOT_BYTES))
        code: Optional[bytearray] = None
        try:
            kid = sc.derive_kid(root)
            ring_id = "rg_" + b64url_encode(os.urandom(16))
            epoch = 1
            wrap = sc.wrap_root(agree, self._wrap_context(ring_id, epoch), kid, root)
            body: Dict[str, Any] = {"ringId": ring_id, "rootKid": kid.hex(), "wrap": _wire_wrap(wrap)}
            if with_recovery:
                code = sc.new_recovery_code()
                body["recovery"] = {"ct": b64url_encode(sc.wrap_recovery(code, ring_id, epoch, kid, root))}
            self._send("POST", path, body)
            shown = sc.encode_recovery_code(code) if code is not None else None
            self._hold(_Held(ring_id, epoch, kid, bytes(root)))
            self._ring = None
            return CreatedRing(ring_id=ring_id, epoch=epoch, root_kid=kid.hex(), recovery_code=shown)
        finally:
            sc.zero(root)
            sc.zero(code)

    def _deposit_own_wrap(self) -> bool:
        """After a recovery: store this device's own wrap. Never raises; False when it could not."""
        try:
            self.wrap_to(self._ctx.device_id, self._agree_key())
            return True
        except Exception:
            return False

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        token = self._tokens.current
        if not token:
            raise KeyringError(ErrorCode.NO_TOKEN, "Activate, register or sign in before using the key ring.")
        headers = self._ctx.headers({"authorization": f"Bearer {token}"})
        kwargs: Dict[str, Any] = {}
        if body is not None:
            headers["content-type"] = "application/json"
            kwargs["content"] = json.dumps(body, separators=(",", ":")).encode("utf-8")
        res = self._ctx.request(method, self._ctx.url(path), headers=headers, **kwargs)
        if not (200 <= res.status_code < 300):
            raise refusal_error(res, "key ring")
        return res

    def _send(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> None:
        """A write whose answer carries nothing the client reads (201 or 204)."""
        self._request(method, path, body)


def _wire_wrap(w: sc.SyncWrap) -> Dict[str, Any]:
    return {"kem": sc.HPKE_KEM_X25519, "enc": b64url_encode(w.enc), "ct": b64url_encode(w.ct)}


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _json(res: Any) -> Dict[str, Any]:
    try:
        body = res.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _parse_state(body: Dict[str, Any]) -> Optional[KeyringState]:
    if "ring" not in body or "wrap" not in body:
        return None
    ring: Optional[KeyringRing] = None
    r = body["ring"]
    if r is not None:
        if (
            not isinstance(r, dict)
            or not isinstance(r.get("ringId"), str)
            or not _is_int(r.get("epoch"))
            or not isinstance(r.get("rootKid"), str)
            or not isinstance(r.get("state"), str)
            or not _is_int(r.get("createdAt"))
            or not isinstance(r.get("recovery"), dict)
            or not isinstance(r["recovery"].get("set"), bool)
            or not isinstance(r.get("adopted"), list)
        ):
            return None
        adopted: List[Dict[str, Any]] = []
        for a in r["adopted"]:
            if (
                not isinstance(a, dict)
                or not isinstance(a.get("ringId"), str)
                or not _is_int(a.get("epoch"))
                or not isinstance(a.get("kid"), str)
                or not isinstance(a.get("ct"), str)
            ):
                return None
            adopted.append({"ringId": a["ringId"], "epoch": a["epoch"], "kid": a["kid"], "ct": a["ct"]})
        p = r.get("previous")
        previous: Optional[Dict[str, Any]] = None
        if p is not None:
            if (
                not isinstance(p, dict)
                or not isinstance(p.get("ringId"), str)
                or not isinstance(p.get("kid"), str)
                or not _is_int(p.get("until"))
            ):
                return None
            previous = {"ringId": p["ringId"], "kid": p["kid"], "until": p["until"]}
        rc = r["recovery"].get("createdAt")
        ring = KeyringRing(
            ring_id=r["ringId"],
            epoch=r["epoch"],
            root_kid=r["rootKid"],
            state=r["state"],
            created_at=r["createdAt"],
            recovery_set=r["recovery"]["set"],
            recovery_created_at=rc if _is_int(rc) else None,
            adopted=adopted,
            previous=previous,
        )
    wrap: Optional[KeyringWrapInfo] = None
    w = body["wrap"]
    if w is not None:
        if (
            not isinstance(w, dict)
            or not _is_int(w.get("epoch"))
            or not isinstance(w.get("kid"), str)
            or not (isinstance(w.get("kem"), str) or _is_int(w.get("kem")))
            or not isinstance(w.get("enc"), str)
            or not isinstance(w.get("ct"), str)
        ):
            return None
        wrap = KeyringWrapInfo(
            epoch=w["epoch"],
            kid=w["kid"],
            kem=w["kem"],
            enc=w["enc"],
            ct=w["ct"],
            by=w["by"] if isinstance(w.get("by"), str) else None,
        )
    return KeyringState(ring=ring, wrap=wrap)
