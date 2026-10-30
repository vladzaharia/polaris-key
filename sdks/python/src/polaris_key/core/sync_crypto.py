"""Cloud Sync end-to-end crypto (U-38.3; WIRE-CONTRACT-V5 §13.10, §13.11): the HKDF labels, the
``pkey-sync-value/1`` envelope, blinded names, the ``pkey-sync-wrap/1`` HPKE wrap, the recovery
code and blob, and the adopt blob. Pure functions over ``cryptography``; no I/O, no state.

Mirrors ``packages/client-core/src/sync`` and is pinned by ``conformance/corpus/v2/sync-vectors.json``
(``hkdfCases``, ``envelopeCases``, ``blindCases``, ``wrapCases``, ``hpkeAnchor``,
``recoveryCodeCases``, ``adoptCases``). The chunker, chunk objects and manifest are in
:mod:`polaris_key.core.sync_files`; file streams are U-22.9.

Rules this module keeps:

* a root, a key and a recovery code are ``bytes`` / ``bytearray`` held by the caller; none is put
  in an exception, a ``repr`` or a log line, and no function here prints anything;
* every ``open`` answers ``None`` (or an ``EnvelopeInvalid`` reason) instead of raising on
  hostile input, and says nothing about which byte was wrong beyond the contract's reasons;
* comparisons of secrets and tags go through ``hmac.compare_digest``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Callable, List, Optional, Union

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .b64url import b64url_encode

__all__ = [
    "SYNC_ROOT_BYTES",
    "SYNC_KID_BYTES",
    "SYNC_VALUE_SALT_BYTES",
    "ENVELOPE_VERSION",
    "ENVELOPE_HEADER_BYTES",
    "ENVELOPE_FIXED_BYTES",
    "ENVELOPE_PAD_BLOCK",
    "ENVELOPE_OVERHEAD_BYTES",
    "HPKE_KEM_X25519",
    "HPKE_ENC_BYTES",
    "WRAP_CT_BYTES",
    "RECOVERY_CODE_BYTES",
    "RECOVERY_CODE_INVALID",
    "BLIND_KINDS",
    "BLIND_PREFIX",
    "hkdf",
    "derive_kid",
    "derive_coll_key",
    "derive_names_key",
    "derive_chunk_id_key",
    "derive_value_key",
    "derive_file_key",
    "derive_chunk_key",
    "aes_gcm_seal",
    "aes_gcm_open",
    "derive_recovery_key",
    "derive_adopt_key",
    "canonical_json",
    "seal_value",
    "open_value",
    "open_value_any_name",
    "OpenedValue",
    "blind",
    "is_blinded_name",
    "WrapContext",
    "SyncWrap",
    "wrap_info",
    "wrap_root",
    "unwrap_root",
    "new_recovery_code",
    "encode_recovery_code",
    "parse_recovery_code",
    "wrap_recovery",
    "unwrap_recovery",
    "AdoptFrom",
    "seal_adopt",
    "open_adopt",
    "DhFn",
    "hpke_seal",
    "hpke_open",
    "private_dh",
    "zero",
]

SYNC_ROOT_BYTES = 32
SYNC_KID_BYTES = 16
SYNC_VALUE_SALT_BYTES = 16

ENVELOPE_VERSION = 0x01
#: Version, kid and salt: the associated data.
ENVELOPE_HEADER_BYTES = 33
#: Header and tag.
ENVELOPE_FIXED_BYTES = 49
ENVELOPE_PAD_BLOCK = 64
#: Fixed bytes and at most one block of padding (``SYNC_E2E_OVERHEAD_BYTES``).
ENVELOPE_OVERHEAD_BYTES = 113

#: The ``kem`` member of a wrap: the HPKE KEM id as a JSON integer (0x0020, X25519).
HPKE_KEM_X25519 = 0x0020
_HPKE_KDF_SHA256 = 0x0001
_HPKE_AEAD_AES256GCM = 0x0002
HPKE_ENC_BYTES = 32
#: A wrapped root: the 32 bytes of ``R`` and the 16-byte tag.
WRAP_CT_BYTES = SYNC_ROOT_BYTES + 16

RECOVERY_CODE_BYTES = 16
_RECOVERY_CHECKSUM_BYTES = 4
_RECOVERY_CODE_CHARS = 32
_BLOB_VERSION = 0x01
#: The client error code for a bad checksum or a failed unwrap.
RECOVERY_CODE_INVALID = "recovery-code-invalid"

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ZERO_NONCE = bytes(12)

BLIND_KINDS = ("setting", "member", "record", "field", "element")
#: The prefix no declared key or collection name may carry.
BLIND_PREFIX = "x:"

Bytes = Union[bytes, bytearray, memoryview]


# ── HKDF-SHA256 (RFC 5869) ────────────────────────────────────────────────────────────────────


def _hmac(key: Bytes, data: Bytes) -> bytes:
    return hmac.new(bytes(key), bytes(data), hashlib.sha256).digest()


def hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: int = 32) -> bytes:
    """HKDF-SHA256 extract-and-expand; an empty ``salt`` is 32 zero bytes (RFC 5869 §2.2)."""
    if length < 1 or length > 255 * 32:
        raise ValueError("hkdf: bad length")
    prk = _hmac(bytes(salt) if len(salt) else bytes(32), ikm)
    return _expand(prk, bytes(info), length)


def _expand(prk: bytes, info: bytes, length: int) -> bytes:
    out = b""
    t = b""
    i = 1
    while len(out) < length:
        t = _hmac(prk, t + info + bytes([i]))
        out += t
        i += 1
    return out[:length]


def _check_root(root: Bytes) -> None:
    if len(root) != SYNC_ROOT_BYTES:
        raise ValueError("a root is 32 bytes")


def derive_kid(root: Bytes) -> bytes:
    """``kid = HKDF(R, ∅, "pkey-sync/1 kid", 16)``: in every envelope header, in the clear."""
    _check_root(root)
    return hkdf(root, b"", b"pkey-sync/1 kid", SYNC_KID_BYTES)


def derive_coll_key(root: Bytes, collection: str) -> bytes:
    """``K_coll(c)``; ``c`` is ``"$settings"`` or the concrete collection name."""
    _check_root(root)
    return hkdf(root, b"", b"pkey-sync/1 coll\0" + collection.encode("utf-8"))


def derive_names_key(root: Bytes) -> bytes:
    """``K_names``: keys every blinded name."""
    _check_root(root)
    return hkdf(root, b"", b"pkey-sync/1 names")


def derive_chunk_id_key(root: Bytes, collection: str) -> bytes:
    """``K_cid(c)``: keys the chunk ids of one collection."""
    _check_root(root)
    return hkdf(root, b"", b"pkey-sync/1 chunk-id\0" + collection.encode("utf-8"))


def derive_value_key(coll_key: Bytes, salt: Bytes) -> bytes:
    """``K_msg``: one per value (``salt`` is the envelope's 16 bytes)."""
    return hkdf(coll_key, salt, b"pkey-sync/1 value")


def derive_file_key(coll_key: Bytes, salt: Bytes) -> bytes:
    """``K_file``: one per file version (``salt`` is the stream header's 32 bytes)."""
    return hkdf(coll_key, salt, b"pkey-sync/1 file")


def derive_chunk_key(coll_key: Bytes, chunk_id: Bytes) -> bytes:
    """``K_chunk``: one per chunk id (its 32 raw bytes are the salt)."""
    return hkdf(coll_key, chunk_id, b"pkey-sync/1 chunk")


def derive_recovery_key(code: Bytes, ring_id: str) -> bytes:
    """``K_rec = HKDF(code16, ringId, "pkey-sync/1 recovery")``."""
    return hkdf(code, ring_id.encode("utf-8"), b"pkey-sync/1 recovery")


def derive_adopt_key(root: Bytes) -> bytes:
    """``K_adopt``: wraps a foreign or previous root under the current one."""
    _check_root(root)
    return hkdf(root, b"", b"pkey-sync/1 adopt")


# ── AES-256-GCM ───────────────────────────────────────────────────────────────────────────────


def _seal(key: bytes, nonce: bytes, aad: bytes, plain: bytes) -> bytes:
    return AESGCM(key).encrypt(nonce, plain, aad)


def _open(key: bytes, nonce: bytes, aad: bytes, sealed: bytes) -> Optional[bytes]:
    try:
        return AESGCM(key).decrypt(nonce, sealed, aad)
    except (InvalidTag, ValueError):
        return None


def aes_gcm_seal(key: Bytes, nonce: Bytes, aad: Bytes, plain: Bytes) -> bytes:
    """AES-256-GCM, 128-bit tag; the result is the ciphertext followed by the tag."""
    return _seal(bytes(key), bytes(nonce), bytes(aad), bytes(plain))


def aes_gcm_open(key: Bytes, nonce: Bytes, aad: Bytes, sealed: Bytes) -> Optional[bytes]:
    """The plaintext, or ``None`` when authentication fails."""
    return _open(bytes(key), bytes(nonce), bytes(aad), bytes(sealed))


# ── Canonical JSON ────────────────────────────────────────────────────────────────────────────


def _utf16_key(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


_MAX_SAFE_INT = 2**53


def _js_number(v: float) -> str:
    """ECMAScript ``Number::toString(v)`` for a finite float: the shortest round-trip digits
    (Python's ``repr`` has them), then decimal for 1e-6 <= |v| < 1e21 and ``e+N`` / ``e-N``
    otherwise, integral values included."""
    if v == 0:
        return "0"
    _, digits, exp = Decimal(repr(abs(v))).as_tuple()
    ds = "".join(str(d) for d in digits).rstrip("0")
    k = len(ds)
    assert isinstance(exp, int)  # finite values only: ``exp`` is never "n", "N" or "F"
    n = len(digits) + exp  # the decimal point sits n digits in: value = 0.ds * 10**n
    if k <= n <= 21:
        out = ds + "0" * (n - k)
    elif 0 < n <= 21:
        out = ds[:n] + "." + ds[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + ds
    else:
        e = n - 1
        mant = ds[0] + ("." + ds[1:] if k > 1 else "")
        out = mant + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return "-" + out if v < 0 else out


def _json_string(s: str) -> str:
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("canonical json: lone surrogate") from None
    return json.dumps(s, ensure_ascii=False)


def canonical_json(v: Any) -> str:
    """Canonical JSON (WIRE-CONTRACT-V5 §13.10.3), byte for byte what client-core writes: keys
    sorted by UTF-16 code unit at every level, no whitespace, non-ASCII text as itself, a number
    as ECMAScript ``Number::toString`` (an integral float too). Refused with ``ValueError``: a
    float that is not finite, an int beyond +-2**53 (no JavaScript number holds it), and a string
    or key with a lone surrogate."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        if abs(v) > _MAX_SAFE_INT:
            raise ValueError("canonical json: integer beyond 2**53")
        return str(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            raise ValueError("canonical json: not a finite number")
        return _js_number(v)
    if isinstance(v, str):
        return _json_string(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=_utf16_key)
        return "{" + ",".join(_json_string(k) + ":" + canonical_json(v[k]) for k in keys) + "}"
    raise TypeError("canonical json: unsupported type")


# ── pkey-sync-value/1 ─────────────────────────────────────────────────────────────────────────


def _pad(p: bytes) -> bytes:
    total = (len(p) // ENVELOPE_PAD_BLOCK) * ENVELOPE_PAD_BLOCK + ENVELOPE_PAD_BLOCK
    return p + b"\x80" + bytes(total - len(p) - 1)


def _unpad(p: bytes) -> Optional[bytes]:
    end = len(p)
    while end > 0 and p[end - 1] == 0:
        end -= 1
    if end == 0 or p[end - 1] != 0x80:
        return None
    return p[: end - 1]


def seal_value(
    root: Bytes,
    collection: str,
    name: str,
    value: Any,
    salt: Optional[Bytes] = None,
) -> bytes:
    """Seal ``value`` under ``name`` in ``collection``. ``salt`` (16 bytes) is fresh randomness
    unless a test fixes it."""
    s = os.urandom(SYNC_VALUE_SALT_BYTES) if salt is None else bytes(salt)
    if len(s) != SYNC_VALUE_SALT_BYTES:
        raise ValueError("salt length")
    kid = derive_kid(root)
    key = derive_value_key(derive_coll_key(root, collection), s)
    header = bytes([ENVELOPE_VERSION]) + kid + s
    plain = _pad(canonical_json({"k": name, "v": value}).encode("utf-8"))
    return header + _seal(key, _ZERO_NONCE, header, plain)


@dataclass(frozen=True)
class OpenedValue:
    """The result of :func:`open_value`: ``ok`` with ``name`` and ``value``, or ``reason`` (one of
    ``shape``, ``version``, ``kid``, ``auth``, ``padding``, ``json``, ``name``). The value is the
    caller's own data; it is left out of the ``repr``."""

    ok: bool
    name: Optional[str] = None
    value: Any = None
    reason: Optional[str] = None

    def __repr__(self) -> str:
        return f"OpenedValue(ok={self.ok!r}, reason={self.reason!r})"


def _bad(reason: str) -> OpenedValue:
    return OpenedValue(ok=False, reason=reason)


def open_value(
    root: Bytes,
    collection: str,
    name: str,
    envelope: Bytes,
    aliases: Optional[List[str]] = None,
) -> OpenedValue:
    """Open an envelope for ``name`` (or one of its ``aliases`` sources) in ``collection``. The
    checks run in the order of the reasons; ``kid`` is checked before any decryption, so a caller can
    look for another root. A match on an alias answers that alias as ``name``."""
    al = aliases or []
    return _open_envelope(root, collection, envelope, lambda k: k == name or k in al)


def open_value_any_name(root: Bytes, collection: str, envelope: Bytes) -> OpenedValue:
    """Open an envelope whose name the caller does not know yet (a blinded open key or merge member:
    the name is inside). It answers the envelope's own ``k``. The caller MUST check that ``k`` is the
    name it expected (for a blinded one, that ``blind(k)`` equals the served name) before it trusts the
    value; the same checks as :func:`open_value` run first."""
    return _open_envelope(root, collection, envelope, lambda _k: True)


def _open_envelope(root: Bytes, collection: str, envelope: Bytes, accepts: Callable[[str], bool]) -> OpenedValue:
    env = bytes(envelope)
    n = len(env)
    if n < ENVELOPE_FIXED_BYTES + ENVELOPE_PAD_BLOCK or (n - ENVELOPE_FIXED_BYTES) % ENVELOPE_PAD_BLOCK != 0:
        return _bad("shape")
    if env[0] != ENVELOPE_VERSION:
        return _bad("version")
    if not hmac.compare_digest(derive_kid(root), env[1 : 1 + SYNC_KID_BYTES]):
        return _bad("kid")
    header = env[:ENVELOPE_HEADER_BYTES]
    salt = env[1 + SYNC_KID_BYTES : ENVELOPE_HEADER_BYTES]
    key = derive_value_key(derive_coll_key(root, collection), salt)
    padded = _open(key, _ZERO_NONCE, header, env[ENVELOPE_HEADER_BYTES:])
    if padded is None:
        return _bad("auth")
    body = _unpad(padded)
    if body is None:
        return _bad("padding")
    try:
        parsed = json.loads(body.decode("utf-8"), parse_constant=_no_constant)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return _bad("json")
    if not isinstance(parsed, dict) or len(parsed) != 2 or "k" not in parsed or "v" not in parsed:
        return _bad("json")
    k = parsed["k"]
    if not isinstance(k, str):
        return _bad("json")
    if not accepts(k):
        return _bad("name")
    return OpenedValue(ok=True, name=k, value=parsed["v"])


def _no_constant(_: str) -> Any:
    raise ValueError("not JSON")


# ── Blinded names ─────────────────────────────────────────────────────────────────────────────


def blind(root: Bytes, kind: str, ctx: str, n: str) -> str:
    """``"x:" ‖ base64url(HMAC-SHA256(K_names, kind ‖ 0x00 ‖ ctx ‖ 0x00 ‖ n))``. ``ctx`` is the
    declared setting key or collection name that scopes the name; an element's ``n`` is its
    canonical JSON."""
    if kind not in BLIND_KINDS:
        raise ValueError("blind: unknown kind")
    mac = _hmac(derive_names_key(root), f"{kind}\0{ctx}\0{n}".encode("utf-8"))
    return BLIND_PREFIX + b64url_encode(mac)


def is_blinded_name(s: str) -> bool:
    if len(s) != 45 or not s.startswith(BLIND_PREFIX):
        return False
    return all(c.isascii() and (c.isalnum() or c in "-_") for c in s[2:])


# ── HPKE (RFC 9180) mode_base, KEM 0x0020, KDF 0x0001, AEAD 0x0002 ────────────────────────────

_KEM_SUITE = b"KEM" + HPKE_KEM_X25519.to_bytes(2, "big")
_HPKE_SUITE = (
    b"HPKE"
    + HPKE_KEM_X25519.to_bytes(2, "big")
    + _HPKE_KDF_SHA256.to_bytes(2, "big")
    + _HPKE_AEAD_AES256GCM.to_bytes(2, "big")
)
_V1 = b"HPKE-v1"

#: ``dh(peer_public) -> shared secret`` with a private key that stays inside its holder, or ``None``.
DhFn = Callable[[bytes], Optional[bytes]]


def _labeled_extract(suite: bytes, salt: bytes, label: str, ikm: bytes) -> bytes:
    return _hmac(salt if salt else bytes(32), _V1 + suite + label.encode("ascii") + ikm)


def _labeled_expand(suite: bytes, prk: bytes, label: str, info: bytes, length: int) -> bytes:
    return _expand(
        prk,
        length.to_bytes(2, "big") + _V1 + suite + label.encode("ascii") + info,
        length,
    )


def _shared_secret(dh: bytes, kem_context: bytes) -> bytes:
    prk = _labeled_extract(_KEM_SUITE, b"", "eae_prk", dh)
    return _labeled_expand(_KEM_SUITE, prk, "shared_secret", kem_context, 32)


def _key_schedule(secret: bytes, info: bytes) -> "tuple[bytes, bytes]":
    psk_id_hash = _labeled_extract(_HPKE_SUITE, b"", "psk_id_hash", b"")
    info_hash = _labeled_extract(_HPKE_SUITE, b"", "info_hash", info)
    context = b"\x00" + psk_id_hash + info_hash
    s = _labeled_extract(_HPKE_SUITE, secret, "secret", b"")
    return (
        _labeled_expand(_HPKE_SUITE, s, "key", context, 32),
        _labeled_expand(_HPKE_SUITE, s, "base_nonce", context, 12),
    )


def _raw_public(sk: X25519PrivateKey) -> bytes:
    return sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _x25519(sk: X25519PrivateKey, peer: bytes) -> Optional[bytes]:
    if len(peer) != HPKE_ENC_BYTES:
        return None
    try:
        out = sk.exchange(X25519PublicKey.from_public_bytes(peer))
    except ValueError:
        return None
    return None if not any(out) else out


def hpke_seal(
    recipient_public: Bytes,
    info: bytes,
    aad: bytes,
    plain: bytes,
    ephemeral_private: Optional[Bytes] = None,
) -> "tuple[bytes, bytes]":
    """``SealBase`` for one message: ``(enc, ct)``. ``ephemeral_private`` is for a test vector only."""
    pk_r = bytes(recipient_public)
    sk_e = (
        X25519PrivateKey.generate()
        if ephemeral_private is None
        else X25519PrivateKey.from_private_bytes(bytes(ephemeral_private))
    )
    enc = _raw_public(sk_e)
    dh = _x25519(sk_e, pk_r)
    if dh is None:
        raise ValueError("hpke: the recipient key is not usable")
    key, nonce = _key_schedule(_shared_secret(dh, enc + pk_r), info)
    return enc, _seal(key, nonce, aad, plain)


def hpke_open(
    dh: DhFn,
    recipient_public: Bytes,
    enc: Bytes,
    info: bytes,
    aad: bytes,
    ct: Bytes,
) -> Optional[bytes]:
    """``OpenBase``: the plaintext, or ``None`` for a bad ``enc``, a wrong key, info or aad, or
    tampering. ``dh`` does the X25519 with the recipient's private key (the device key port's
    ``dh``), so the private half is never read here."""
    e = bytes(enc)
    if len(e) != HPKE_ENC_BYTES:
        return None
    shared = dh(e)
    if shared is None or not any(shared):
        return None
    key, nonce = _key_schedule(_shared_secret(bytes(shared), e + bytes(recipient_public)), info)
    return _open(key, nonce, aad, bytes(ct))


def private_dh(private_key: Bytes) -> "tuple[DhFn, bytes]":
    """A ``dh`` function and public key for a raw X25519 private scalar (tests and vectors; a
    device's own key stays in its ``DeviceKeyPort``)."""
    sk = X25519PrivateKey.from_private_bytes(bytes(private_key))
    return (lambda peer: _x25519(sk, peer)), _raw_public(sk)


# ── The wrap (§13.11.1) ───────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WrapContext:
    product: str
    device_id: str
    ring_id: str
    #: At least 1.
    epoch: int


@dataclass(frozen=True)
class SyncWrap:
    """A ``pkey-sync-wrap/1`` as the routes carry it, in bytes."""

    kem: int
    enc: bytes
    ct: bytes


def _u32(n: int) -> bytes:
    if n < 0 or n > 0xFFFFFFFF:
        raise ValueError("epoch out of range")
    return n.to_bytes(4, "big")


def wrap_info(c: WrapContext) -> bytes:
    """``"pkey-sync/1 wrap\\0" ‖ product ‖ 0x00 ‖ deviceId ‖ 0x00 ‖ ringId ‖ 0x00 ‖ u32be(epoch)``."""
    return (
        b"pkey-sync/1 wrap\0"
        + c.product.encode("utf-8")
        + b"\0"
        + c.device_id.encode("utf-8")
        + b"\0"
        + c.ring_id.encode("utf-8")
        + b"\0"
        + _u32(c.epoch)
    )


def wrap_root(
    recipient_public: Bytes,
    c: WrapContext,
    kid: Bytes,
    root: Bytes,
    ephemeral_private: Optional[Bytes] = None,
) -> SyncWrap:
    """Wrap ``root`` to a device's agreement key. ``kid`` (16 bytes, of ``root``) is the aad."""
    _check_root(root)
    enc, ct = hpke_seal(recipient_public, wrap_info(c), bytes(kid), bytes(root), ephemeral_private)
    return SyncWrap(kem=HPKE_KEM_X25519, enc=enc, ct=ct)


def unwrap_root(
    dh: DhFn,
    recipient_public: Bytes,
    c: WrapContext,
    kid: Bytes,
    wrap: SyncWrap,
) -> Optional[bytes]:
    """The root in a wrap, or ``None``: an unknown ``kem``, a wrong key, context or ``kid``,
    tampering, or a plaintext that is not 32 bytes. The caller still checks that ``kid(R)`` equals
    the ring's ``rootKid``."""
    if wrap.kem != HPKE_KEM_X25519:
        return None
    root = hpke_open(dh, recipient_public, wrap.enc, wrap_info(c), bytes(kid), wrap.ct)
    return root if root is not None and len(root) == SYNC_ROOT_BYTES else None


# ── The recovery code (§13.11.4) ──────────────────────────────────────────────────────────────


def new_recovery_code() -> bytearray:
    """16 fresh random bytes."""
    return bytearray(os.urandom(RECOVERY_CODE_BYTES))


def _code_bytes(code: Bytes) -> bytes:
    return bytes(code) + hashlib.sha256(bytes(code)).digest()[:_RECOVERY_CHECKSUM_BYTES]


def encode_recovery_code(code: Bytes) -> str:
    """The text shown to the person: 8 groups of 4, upper case, joined by hyphens."""
    if len(code) != RECOVERY_CODE_BYTES:
        raise ValueError("a recovery code is 16 bytes")
    n = int.from_bytes(_code_bytes(code), "big")
    chars = "".join(_ALPHABET[(n >> (5 * (_RECOVERY_CODE_CHARS - 1 - i))) & 31] for i in range(_RECOVERY_CODE_CHARS))
    return "-".join(chars[i : i + 4] for i in range(0, _RECOVERY_CODE_CHARS, 4))


def parse_recovery_code(text: str) -> Optional[bytes]:
    """The 16-byte code in a typed or pasted string, or ``None``. It ignores case, spaces and
    hyphens, maps ``I`` and ``L`` to ``1`` and ``O`` to ``0``, and checks the length and the checksum."""
    clean = "".join(ch for ch in text if not (ch.isspace() or ch == "-")).upper()
    clean = clean.replace("I", "1").replace("L", "1").replace("O", "0")
    if len(clean) != _RECOVERY_CODE_CHARS:
        return None
    n = 0
    for ch in clean:
        v = _ALPHABET.find(ch)
        if v < 0:
            return None
        n = (n << 5) | v
    raw = n.to_bytes(RECOVERY_CODE_BYTES + _RECOVERY_CHECKSUM_BYTES, "big")
    code = raw[:RECOVERY_CODE_BYTES]
    return code if hmac.compare_digest(raw, _code_bytes(code)) else None


def _aad(label: str, ring_id: str, epoch: int, kid: Bytes) -> bytes:
    return label.encode("ascii") + ring_id.encode("utf-8") + _u32(epoch) + bytes(kid)


def _seal_blob(key: bytes, aad: bytes, root: Bytes, nonce: Optional[Bytes]) -> bytes:
    _check_root(root)
    n = os.urandom(12) if nonce is None else bytes(nonce)
    if len(n) != 12:
        raise ValueError("nonce length")
    return bytes([_BLOB_VERSION]) + n + _seal(key, n, aad, bytes(root))


def _open_blob(key: bytes, aad: bytes, blob: Bytes) -> Optional[bytes]:
    b = bytes(blob)
    if len(b) != 1 + 12 + SYNC_ROOT_BYTES + 16 or b[0] != _BLOB_VERSION:
        return None
    root = _open(key, b[1:13], aad, b[13:])
    return root if root is not None and len(root) == SYNC_ROOT_BYTES else None


def wrap_recovery(
    code: Bytes,
    ring_id: str,
    epoch: int,
    kid: Bytes,
    root: Bytes,
    nonce: Optional[Bytes] = None,
) -> bytes:
    """``recovery.ct``: the root sealed under the code. ``nonce`` is for a test vector only."""
    return _seal_blob(
        derive_recovery_key(code, ring_id),
        _aad("pkey-sync/1 recovery", ring_id, epoch, kid),
        root,
        nonce,
    )


def unwrap_recovery(code: Bytes, ring_id: str, epoch: int, kid: Bytes, blob: Bytes) -> Optional[bytes]:
    """The root, or ``None`` (a wrong code, ring, epoch or ``kid``, or tampering)."""
    return _open_blob(
        derive_recovery_key(code, ring_id),
        _aad("pkey-sync/1 recovery", ring_id, epoch, kid),
        blob,
    )


@dataclass(frozen=True)
class AdoptFrom:
    """The ring (``from_ring_id``, ``epoch``) and root ``kid`` that an adopt blob names."""

    from_ring_id: str
    epoch: int
    kid: bytes


def seal_adopt(
    current_root: Bytes,
    frm: AdoptFrom,
    old_root: Bytes,
    nonce: Optional[Bytes] = None,
) -> bytes:
    """Seal a foreign or previous root under ``K_adopt`` of the current root."""
    return _seal_blob(
        derive_adopt_key(current_root),
        _aad("pkey-sync/1 adopt", frm.from_ring_id, frm.epoch, frm.kid),
        old_root,
        nonce,
    )


def open_adopt(current_root: Bytes, frm: AdoptFrom, blob: Bytes) -> Optional[bytes]:
    """The adopted root, or ``None``."""
    return _open_blob(
        derive_adopt_key(current_root),
        _aad("pkey-sync/1 adopt", frm.from_ring_id, frm.epoch, frm.kid),
        blob,
    )


def zero(buf: Union[bytearray, memoryview, None]) -> None:
    """Best-effort overwrite of a mutable secret (CPython may keep other copies)."""
    if buf is not None:
        for i in range(len(buf)):
            buf[i] = 0

