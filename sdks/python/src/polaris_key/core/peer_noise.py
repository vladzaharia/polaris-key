"""WIRE-CONTRACT-V5 §15.5 and §15.6: the Noise engine of ``pkey-peer/1``.

The Noise Protocol Framework (revision 34), patterns XX and XXpsk0 over 25519, AESGCM and
SHA256, on the ``cryptography`` package the SDK already depends on. The engine is synchronous and
pure: bytes in, bytes out, no I/O, and no clock (a caller passes time to the layers above).
Failures raise a :class:`NoiseError` whose ``code`` is all a caller may show or log; it carries no
key, payload or ciphertext. After any failure a handshake is dead and refuses further use.

The static key may be raw bytes or a key port (``public_key()`` and ``dh(remote)``), so a device
key that never leaves its store still takes part (G1). Secrets are held in ``bytearray`` and
wiped when they are replaced or the handshake ends.
"""

from __future__ import annotations

import hashlib
import hmac as _hmac
import os
import re
import threading
from typing import Any, Callable, List, Optional, Tuple, Union

from cryptography.exceptions import InvalidTag, UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .device_proof import is_x25519_low_order

__all__ = [
    "NOISE_MAX_MESSAGE",
    "CipherState",
    "NoiseError",
    "NoiseHandshake",
    "NoisePorts",
    "NoiseTransport",
    "hkdf_sha256",
    "hmac_sha256",
    "peer_noise_protocol",
    "peer_prologue",
    "peer_psk",
    "sha256",
]

#: A Noise message is at most 65,535 bytes (Noise §3), and a TCP frame carries one (§15.6).
NOISE_MAX_MESSAGE = 65535
_TAG = 16
_MAX_NONCE = (1 << 64) - 1

#: ``decrypt`` (a tag fails: wrong key, PSK, prologue or tampering), ``dh_zero`` (a DH output is
#: all zeros or refused), ``malformed`` (too short or too long), ``state`` (a call out of order, or
#: after a failure), ``nonce_exhausted``, ``bad_key`` (a key or PSK of the wrong length).
NOISE_ERROR_CODES = ("decrypt", "dh_zero", "malformed", "state", "nonce_exhausted", "bad_key")


class NoiseError(Exception):
    """A Noise refusal. Only ``code`` is for display; there is nothing secret in it."""

    def __init__(self, code: str) -> None:
        super().__init__("noise: " + code)
        self.code = code

    def __reduce__(self) -> Tuple[Any, ...]:
        return (NoiseError, (self.code,))


def _wipe(b: Optional[bytearray]) -> None:
    if b is not None:
        for i in range(len(b)):
            b[i] = 0


# -- Ports ----------------------------------------------------------------------------------------


class NoisePorts:
    """The crypto the engine calls. The defaults use ``cryptography``; a test subclasses one hook."""

    def public_key(self, private_key: bytes) -> bytes:
        try:
            return X25519PrivateKey.from_private_bytes(bytes(private_key)).public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        except (ValueError, UnsupportedAlgorithm):
            raise NoiseError("bad_key") from None

    def dh(self, private_key: bytes, public_key: bytes) -> Optional[bytes]:
        """The shared secret, or None when the backend refuses the point."""
        try:
            return X25519PrivateKey.from_private_bytes(bytes(private_key)).exchange(
                X25519PublicKey.from_public_bytes(bytes(public_key))
            )
        except (ValueError, UnsupportedAlgorithm):
            return None

    def seal(self, key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> bytes:
        return AESGCM(bytes(key)).encrypt(nonce, bytes(plaintext), bytes(aad))

    def open(self, key: bytes, nonce: bytes, aad: bytes, ciphertext: bytes) -> Optional[bytes]:
        try:
            return AESGCM(bytes(key)).decrypt(nonce, bytes(ciphertext), bytes(aad))
        except InvalidTag:
            return None

    def random(self, length: int) -> bytes:
        return os.urandom(length)


_DEFAULT_PORTS = NoisePorts()


# -- Hash and KDF ---------------------------------------------------------------------------------


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return _hmac.new(bytes(key), bytes(data), hashlib.sha256).digest()


def hkdf_sha256(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    """HKDF-SHA256 (RFC 5869). An empty salt is HashLen zero bytes, as the RFC defines."""
    prk = hmac_sha256(salt if len(salt) else bytes(32), ikm)
    t = b""
    out = b""
    i = 1
    while len(out) < length:
        t = hmac_sha256(prk, t + info + bytes([i]))
        out += t
        i += 1
    return out[:length]


# -- Protocol names, prologue, PSK (§15.5) --------------------------------------------------------


def peer_noise_protocol(mode: str) -> str:
    """The Noise protocol name of a mode: XXpsk0 for ``a`` (R-1), plain XX for ``v`` and ``p``."""
    return "Noise_XXpsk0_25519_AESGCM_SHA256" if mode == "a" else "Noise_XX_25519_AESGCM_SHA256"


def peer_prologue(slug: str, mode: str) -> bytes:
    """``"pkey-peer/1" || 0x00 || slug || 0x00 || mode || 0x00``."""
    return b"pkey-peer/1\x00" + slug.encode("utf-8") + b"\x00" + mode.encode("utf-8") + b"\x00"


def peer_psk(disc_key: bytes, slug: str) -> bytes:
    """The mode-a PSK: HKDF-SHA256, empty salt, the 32-byte discovery key as input keying material
    and ``"pkey-peer/1 psk" || 0x00 || slug`` as info, 32 bytes out (V5 §15.5 pins this order)."""
    if len(disc_key) != 32:
        raise NoiseError("bad_key")
    return hkdf_sha256(b"", bytes(disc_key), b"pkey-peer/1 psk\x00" + slug.encode("utf-8"), 32)


# -- CipherState ----------------------------------------------------------------------------------


def _nonce(n: int) -> bytes:
    return bytes(4) + n.to_bytes(8, "big")


class CipherState:
    """One direction of the transport, or the handshake's cipher. Calls run one at a time (a lock),
    so two threads never share a nonce. A failed read does not advance the counter (Noise §5.1)."""

    def __init__(self, k: Optional[bytes], ports: NoisePorts = _DEFAULT_PORTS) -> None:
        self._k: Optional[bytearray] = bytearray(k) if k is not None else None
        self._n = 0
        self._ports = ports
        self._lock = threading.Lock()

    def has_key(self) -> bool:
        return self._k is not None

    def set_key(self, k: bytes) -> None:
        with self._lock:
            _wipe(self._k)
            self._k = bytearray(k)
            self._n = 0

    def encrypt(self, ad: bytes, plaintext: bytes) -> bytes:
        with self._lock:
            if self._k is None:
                return bytes(plaintext)
            if self._n == _MAX_NONCE:
                raise NoiseError("nonce_exhausted")
            if len(plaintext) + _TAG > NOISE_MAX_MESSAGE:
                raise NoiseError("malformed")
            nonce = _nonce(self._n)
            self._n += 1
            return self._ports.seal(bytes(self._k), nonce, ad, plaintext)

    def decrypt(self, ad: bytes, ciphertext: bytes) -> bytes:
        with self._lock:
            if self._k is None:
                return bytes(ciphertext)
            if self._n == _MAX_NONCE:
                raise NoiseError("nonce_exhausted")
            if len(ciphertext) < _TAG or len(ciphertext) > NOISE_MAX_MESSAGE:
                raise NoiseError("malformed")
            pt = self._ports.open(bytes(self._k), _nonce(self._n), ad, ciphertext)
            if pt is None:
                raise NoiseError("decrypt")
            self._n += 1
            return pt

    def rekey(self) -> None:
        """REKEY (Noise §4.2): ``k = ENCRYPT(k, 2^64 - 1, "", zeros(32))[0..32]``. The counter stays."""
        with self._lock:
            if self._k is None:
                raise NoiseError("state")
            out = self._ports.seal(bytes(self._k), _nonce(_MAX_NONCE), b"", bytes(32))
            _wipe(self._k)
            self._k = bytearray(out[:32])

    def wipe(self) -> None:
        with self._lock:
            _wipe(self._k)
            self._k = None

    def __repr__(self) -> str:
        return "CipherState()"

    def __reduce__(self) -> Any:
        raise TypeError("CipherState cannot be pickled")


class NoiseTransport:
    """The two directions of a finished handshake."""

    __slots__ = ("send", "receive")

    def __init__(self, send: CipherState, receive: CipherState) -> None:
        self.send = send
        self.receive = receive

    def __repr__(self) -> str:
        return "NoiseTransport()"

    def __reduce__(self) -> Any:
        raise TypeError("NoiseTransport cannot be pickled")


# -- HandshakeState -------------------------------------------------------------------------------

#: Message token lists of XX, initiator first.
_XX: Tuple[Tuple[str, ...], ...] = (("e",), ("e", "ee", "s", "es"), ("s", "se"))
_PROTOCOL = re.compile(r"Noise_XX(psk0)?_25519_AESGCM_SHA256\Z")
_DH_PAIR = {"ee": ("e", "e"), "es": ("e", "s"), "se": ("s", "e")}

StaticKey = Union[bytes, bytearray, Any]


class NoiseHandshake:
    """One handshake. Alternate :meth:`write_message` and :meth:`read_message` as the role dictates
    (the initiator writes first); after the third message :meth:`transport` yields the two ciphers.
    Any ``NoiseError`` kills the handshake.

    ``static_key`` is 32 raw bytes, or a key port with ``public_key()`` and ``dh(remote)`` (G1).
    ``ephemeral_key`` fixes the ephemeral private key (known-answer tests only; loaded through
    ``from_private_bytes``); the default is random.
    """

    def __init__(
        self,
        role: str,
        protocol: str,
        prologue: bytes,
        static_key: StaticKey,
        psk: Optional[bytes] = None,
        ephemeral_key: Optional[bytes] = None,
        ports: Optional[NoisePorts] = None,
    ) -> None:
        m = _PROTOCOL.match(protocol)
        if m is None or role not in ("initiator", "responder"):
            raise NoiseError("state")
        self._uses_psk = m.group(1) is not None
        if self._uses_psk != (psk is not None):
            raise NoiseError("bad_key")
        if psk is not None and len(psk) != 32:
            raise NoiseError("bad_key")
        if isinstance(static_key, (bytes, bytearray)):
            if len(static_key) != 32:
                raise NoiseError("bad_key")
            self._s_raw: Optional[bytearray] = bytearray(static_key)
            self._s_port: Any = None
        else:
            if not (hasattr(static_key, "public_key") and hasattr(static_key, "dh")):
                raise NoiseError("bad_key")
            self._s_raw = None
            self._s_port = static_key
        if ephemeral_key is not None and len(ephemeral_key) != 32:
            raise NoiseError("bad_key")
        self._ports = ports if ports is not None else _DEFAULT_PORTS
        self._initiator = role == "initiator"
        self._psk: Optional[bytearray] = bytearray(psk) if psk is not None else None
        self._e: Optional[bytearray] = bytearray(ephemeral_key) if ephemeral_key is not None else None
        self._re: Optional[bytes] = None
        self._rs: Optional[bytes] = None
        self._s_pub: Optional[bytes] = None
        self._index = 0
        self._dead = False
        self._cs = CipherState(None, self._ports)
        name = protocol.encode("ascii")
        self._h = name + bytes(32 - len(name)) if len(name) <= 32 else sha256(name)
        self._ck = self._h
        self._mix_hash(prologue)

    # -- state ------------------------------------------------------------------------------------

    @property
    def finished(self) -> bool:
        """True once all three messages are written and read."""
        return self._index == len(_XX)

    @property
    def remote_static(self) -> Optional[bytes]:
        """The peer's static public key, once its ``s`` token has been read."""
        return self._rs

    @property
    def handshake_hash(self) -> bytes:
        """The handshake hash ``h``: the channel binding, once finished."""
        if not self.finished:
            raise NoiseError("state")
        return self._h

    def __repr__(self) -> str:
        return "NoiseHandshake()"

    def __reduce__(self) -> Any:
        raise TypeError("NoiseHandshake cannot be pickled")

    # -- symmetric state --------------------------------------------------------------------------

    def _mix_hash(self, data: bytes) -> None:
        self._h = sha256(self._h, data)

    def _kdf(self, ikm: bytes, outputs: int) -> List[bytes]:
        temp = hmac_sha256(self._ck, ikm)
        o1 = hmac_sha256(temp, b"\x01")
        o2 = hmac_sha256(temp, o1 + b"\x02")
        if outputs == 2:
            return [o1, o2]
        return [o1, o2, hmac_sha256(temp, o2 + b"\x03")]

    def _mix_key(self, ikm: bytes) -> None:
        ck, k = self._kdf(ikm, 2)
        self._ck = ck
        self._cs.set_key(k)

    def _mix_key_and_hash(self, ikm: bytes) -> None:
        ck, th, k = self._kdf(ikm, 3)
        self._ck = ck
        self._mix_hash(th)
        self._cs.set_key(k)

    def _encrypt_and_hash(self, pt: bytes) -> bytes:
        ct = self._cs.encrypt(self._h, pt)
        self._mix_hash(ct)
        return ct

    def _decrypt_and_hash(self, ct: bytes) -> bytes:
        pt = self._cs.decrypt(self._h, ct)
        self._mix_hash(ct)
        return pt

    def _static_public(self) -> bytes:
        if self._s_pub is None:
            if self._s_port is not None:
                pub = self._s_port.public_key()
                if not isinstance(pub, (bytes, bytearray)) or len(pub) != 32:
                    raise NoiseError("bad_key")
                self._s_pub = bytes(pub)
            else:
                self._s_pub = self._ports.public_key(bytes(self._s_raw or b""))
        return self._s_pub

    def _dh(self, token: str) -> None:
        """One DH token: this side's private key of the kind against the peer's public key."""
        pair = _DH_PAIR[token]
        mine = pair[0] if self._initiator else pair[1]
        theirs = pair[1] if self._initiator else pair[0]
        remote = self._re if theirs == "e" else self._rs
        if remote is None:
            raise NoiseError("state")
        # The backend may refuse a low-order point or return zeros; both abort (§15.5).
        if is_x25519_low_order(remote):
            raise NoiseError("dh_zero")
        out: Optional[bytes]
        try:
            if mine == "e":
                if self._e is None:
                    raise NoiseError("state")
                out = self._ports.dh(bytes(self._e), remote)
            elif self._s_port is not None:
                out = self._s_port.dh(remote)
            else:
                out = self._ports.dh(bytes(self._s_raw or b""), remote)
        except NoiseError:
            raise
        except Exception:
            out = None
        if out is None or len(out) != 32 or not any(out):
            raise NoiseError("dh_zero")
        self._mix_key(bytes(out))

    # -- messages ---------------------------------------------------------------------------------

    def _tokens(self) -> List[str]:
        t = list(_XX[self._index])
        if self._index == 0 and self._uses_psk:
            t.insert(0, "psk")
        return t

    def _guard(self, turn: bool, fn: Callable[[], bytes]) -> bytes:
        if self._dead or self.finished or self._initiator != turn:
            raise NoiseError("state")
        try:
            return fn()
        except NoiseError:
            self._kill()
            raise
        except Exception:
            self._kill()
            raise NoiseError("state") from None

    def _kill(self) -> None:
        self._dead = True
        self._cs.wipe()
        _wipe(self._e)
        _wipe(self._psk)
        _wipe(self._s_raw)

    def write_message(self, payload: bytes) -> bytes:
        """Write the next handshake message carrying ``payload``."""

        def run() -> bytes:
            wire = b""
            for t in self._tokens():
                if t == "psk":
                    self._mix_key_and_hash(bytes(self._psk or b""))
                elif t == "e":
                    if self._e is None:
                        self._e = bytearray(self._ports.random(32))
                    pub = self._ports.public_key(bytes(self._e))
                    wire += pub
                    self._mix_hash(pub)
                    if self._uses_psk:
                        self._mix_key(pub)
                elif t == "s":
                    wire += self._encrypt_and_hash(self._static_public())
                else:
                    self._dh(t)
            wire += self._encrypt_and_hash(bytes(payload))
            if len(wire) > NOISE_MAX_MESSAGE:
                raise NoiseError("malformed")
            self._index += 1
            return wire

        return self._guard(self._index % 2 == 0, run)

    def read_message(self, message: bytes) -> bytes:
        """Read the next handshake message; returns its payload."""

        def run() -> bytes:
            msg = bytes(message)
            if len(msg) > NOISE_MAX_MESSAGE:
                raise NoiseError("malformed")
            off = 0
            for t in self._tokens():
                if t == "psk":
                    self._mix_key_and_hash(bytes(self._psk or b""))
                elif t == "e":
                    if len(msg) < off + 32:
                        raise NoiseError("malformed")
                    self._re = msg[off : off + 32]
                    off += 32
                    self._mix_hash(self._re)
                    if self._uses_psk:
                        self._mix_key(self._re)
                elif t == "s":
                    n = 32 + _TAG if self._cs.has_key() else 32
                    if len(msg) < off + n:
                        raise NoiseError("malformed")
                    self._rs = self._decrypt_and_hash(msg[off : off + n])
                    off += n
                else:
                    self._dh(t)
            payload = self._decrypt_and_hash(msg[off:])
            self._index += 1
            return payload

        return self._guard(self._index % 2 == 1, run)

    def transport(self) -> NoiseTransport:
        """The transport ciphers of a finished handshake: ``send`` for this side's writes, ``receive``
        for its reads. The handshake object is spent afterwards."""
        if self._dead or not self.finished:
            raise NoiseError("state")
        k1, k2 = self._kdf(b"", 2)
        a = CipherState(k1, self._ports)
        b = CipherState(k2, self._ports)
        self._kill()
        return NoiseTransport(a, b) if self._initiator else NoiseTransport(b, a)
