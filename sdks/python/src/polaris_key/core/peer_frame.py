"""WIRE-CONTRACT-V5 §15.6: TCP framing, records inside one Noise transport plaintext, the type table,
MORE reassembly and the order of checks. Pure bytes in, bytes out: no I/O, no clock."""

from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Tuple, Union

__all__ = [
    "FrameReader",
    "MAX_CHAIN_RECORDS",
    "MAX_FRAME",
    "MAX_PEER_MESSAGE_BYTES",
    "MAX_RECORD_BODY",
    "PeerRecord",
    "RECORD",
    "RECORD_TYPES",
    "RecordAssembler",
    "decode_frames",
    "encode_frame",
    "encode_record",
    "parse_record",
    "split_message",
]

# -- Frames -----------------------------------------------------------------------------------------

MAX_FRAME = 65535


def encode_frame(noise: bytes) -> bytes:
    """``u16be len || noise``, len 1 to 65,535."""
    if len(noise) < 1 or len(noise) > MAX_FRAME:
        raise ValueError("frame length")
    return len(noise).to_bytes(2, "big") + bytes(noise)


def decode_frames(stream: bytes) -> Union[Tuple[List[bytes], bytes], str]:
    """Cut a byte stream into frames: ``(frames, rest)``, a trailing partial frame being ``rest``.
    A zero length returns the code ``"peer_bad_frame"`` (the session closes), wherever it occurs."""
    frames: List[bytes] = []
    i = 0
    n = len(stream)
    while n - i >= 2:
        length = (stream[i] << 8) | stream[i + 1]
        if length == 0:
            return "peer_bad_frame"
        if n - i - 2 < length:
            break
        frames.append(bytes(stream[i + 2 : i + 2 + length]))
        i += 2 + length
    return frames, bytes(stream[i:])


class FrameReader:
    """A stateful reader over a socket's chunks. ``push`` returns frames, or None after a zero length.
    One growing buffer and an offset: every byte is copied in once and out once, so a peer that
    trickles a frame one byte at a time costs linear work (``copied`` counts the bytes moved)."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._start = 0
        self.copied = 0

    def push(self, chunk: bytes) -> Optional[List[bytes]]:
        if self._start and self._start >= len(self._buf) // 2:
            # Drop the consumed prefix only once it is at least half the buffer, so the cost is amortised.
            self.copied += len(self._buf) - self._start
            del self._buf[: self._start]
            self._start = 0
        self._buf += chunk
        self.copied += len(chunk)
        frames: List[bytes] = []
        buf = self._buf
        while len(buf) - self._start >= 2:
            s = self._start
            length = (buf[s] << 8) | buf[s + 1]
            if length == 0:
                self._buf = bytearray()
                self._start = 0
                return None
            if len(buf) - s - 2 < length:
                break
            frames.append(bytes(buf[s + 2 : s + 2 + length]))
            self.copied += length
            self._start += 2 + length
        if self._start == len(buf):
            self._buf = bytearray()
            self._start = 0
        return frames


# -- Records ----------------------------------------------------------------------------------------

MAX_PEER_MESSAGE_BYTES = 1_048_576
#: A Noise message is at most 65,535 bytes; 16 are the tag and 3 the record header.
MAX_RECORD_BODY = 65535 - 16 - 3
#: Records in one MORE chain: a full 1 MiB message in the smallest records, plus one.
MAX_CHAIN_RECORDS = -(-MAX_PEER_MESSAGE_BYTES // MAX_RECORD_BODY) + 1

RECORD: Dict[str, int] = {
    "HELLO": 0x8001,
    "RING": 0x0002,
    "TRUST": 0x0003,
    "PING": 0x0004,
    "PONG": 0x0005,
    "CANDIDATES": 0x0006,
    "VOUCH_REQ": 0x8010,
    "VOUCH_RESULT": 0x8011,
    "CONFIRM": 0x8012,
    "CONTACT": 0x0013,
    "SAS_COMMIT": 0x8014,
    "SAS_NONCE": 0x8015,
    "SAS_REVEAL": 0x8016,
    "KEYRING_WRAP": 0x0030,
    "REKEY": 0x80FE,
    "CLOSE": 0x80FF,
}


class _Row(NamedTuple):
    start: int
    end: int
    name: str
    modes: str
    body_len: Optional[int] = None


#: The type table (modes: ``a``, ``v``, ``p``, ``c``).
RECORD_TYPES: Tuple[_Row, ...] = (
    _Row(0x8001, 0x8001, "HELLO", "avpc"),
    _Row(0x0002, 0x0002, "RING", "a"),
    _Row(0x0003, 0x0003, "TRUST", "a"),
    _Row(0x0004, 0x0004, "PING", "avpc", 8),
    _Row(0x0005, 0x0005, "PONG", "avpc", 8),
    _Row(0x0006, 0x0006, "CANDIDATES", "a"),
    _Row(0x8010, 0x8010, "VOUCH_REQ", "v"),
    _Row(0x8011, 0x8011, "VOUCH_RESULT", "v"),
    _Row(0x8012, 0x8012, "CONFIRM", "p"),
    _Row(0x0013, 0x0013, "CONTACT", "p"),
    _Row(0x8014, 0x8014, "SAS_COMMIT", "vp"),
    _Row(0x8015, 0x8015, "SAS_NONCE", "vp"),
    _Row(0x8016, 0x8016, "SAS_REVEAL", "vp"),
    _Row(0x0020, 0x0025, "XFER", "ac"),
    _Row(0x0030, 0x003F, "SYNC", "v"),
    _Row(0x0100, 0x7FFF, "APP", "ac"),
    _Row(0x8100, 0xFFFD, "APP_CRITICAL", "ac"),
    _Row(0x80FE, 0x80FE, "REKEY", "avpc", 0),
    _Row(0x80FF, 0x80FF, "CLOSE", "avpc"),
)


class PeerRecord(NamedTuple):
    type: int
    flags: int
    body: bytes


def parse_record(plain: bytes) -> Optional[PeerRecord]:
    """A record from a Noise plaintext; None (the session closes with ``peer_bad_frame``) when it is
    shorter than the three header bytes or sets a flag bit other than MORE."""
    if len(plain) < 3 or (plain[2] & 0xFE) != 0:
        return None
    return PeerRecord((plain[0] << 8) | plain[1], plain[2], bytes(plain[3:]))


def encode_record(r: PeerRecord) -> bytes:
    if not 0 <= r.type <= 0xFFFF or not 0 <= r.flags <= 0xFF:
        raise ValueError("record header")
    return r.type.to_bytes(2, "big") + bytes([r.flags]) + bytes(r.body)


def split_message(type_: int, body: bytes) -> List[bytes]:
    """A message split into records, MORE on all but the last."""
    if len(body) > MAX_PEER_MESSAGE_BYTES:
        raise ValueError("message size")
    out: List[bytes] = []
    at = 0
    while True:
        end = min(len(body), at + MAX_RECORD_BODY)
        out.append(encode_record(PeerRecord(type_, 1 if end < len(body) else 0, body[at:end])))
        at = end
        if at >= len(body):
            return out


class Assembled(NamedTuple):
    """One result of :meth:`RecordAssembler.push`: ``kind`` is ``message`` (``type`` and ``body`` set),
    ``pending``, ``ignored`` or ``close`` (``code`` set)."""

    kind: str
    type: int = 0
    body: bytes = b""
    code: str = ""


_PENDING = Assembled("pending")
_IGNORED = Assembled("ignored")


def _bad(code: str) -> Assembled:
    return Assembled("close", code=code)


class RecordAssembler:
    """Reads records in order, in a session of one mode (the checks run in the order §15.6 lists)."""

    def __init__(self, mode: str) -> None:
        if mode not in ("a", "v", "p", "c"):
            raise ValueError("mode")
        self._mode = mode
        self._open: Optional[Tuple[int, List[bytes], int]] = None  # type, parts, size
        #: Set once a non-critical unknown type opened a chain that is being dropped.
        self._dropping: Optional[int] = None

    def push(self, r: PeerRecord) -> Assembled:
        if (r.flags & 0xFE) != 0:
            return _bad("peer_bad_frame")
        more = (r.flags & 1) != 0
        if self._dropping is not None:
            if self._dropping != r.type:
                return _bad("peer_bad_frame")
            if not more:
                self._dropping = None
            return _IGNORED
        if self._open is not None and self._open[0] != r.type:
            return _bad("peer_bad_frame")
        row = next((t for t in RECORD_TYPES if t.start <= r.type <= t.end), None)
        if row is None:
            if (r.type & 0x8000) != 0:
                return _bad("peer_unknown_critical")
            if more:
                self._dropping = r.type
            return _IGNORED
        if self._mode not in row.modes:
            return _bad("peer_not_allowed")
        # An empty MORE record is accepted (corpus `more-empty-parts`), so the chain's record count
        # is what bounds the work.
        size = (self._open[2] if self._open else 0) + len(r.body)
        if size > MAX_PEER_MESSAGE_BYTES:
            return _bad("peer_bad_frame")
        parts = self._open[1] if self._open else []
        if len(parts) >= MAX_CHAIN_RECORDS:
            return _bad("peer_bad_frame")
        parts.append(r.body)
        if more:
            self._open = (r.type, parts, size)
            return _PENDING
        self._open = None
        body = b"".join(parts)
        if row.body_len is not None and len(body) != row.body_len:
            return _bad("peer_bad_frame")
        return Assembled("message", r.type, body)
