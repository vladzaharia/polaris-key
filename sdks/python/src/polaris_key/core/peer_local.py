"""WIRE-CONTRACT-V5 §15.12: local links (account-free pairing). Pure functions and small machines, no I/O: the
code and its nameplate, the QR, the adverts, the ``LOCAL_LINK`` body, the link secret, the handshake
capabilities, the joiner, the pairing window, the exchange guard, the pin, the trial order and the gate. The
vectors are ``peer-matrix.json`` ``local``; the session (:mod:`.peer_session`) runs modes ``q`` and ``l`` over
them, and CPace itself is :mod:`.peer_cpace`. Mirrors ``packages/client-core/src/peer/local.ts``.

A password, a QR secret and a link secret are key material: nothing here logs one or returns one inside an
error. Time comes in as arguments (a monotonic clock, in seconds, for the window), so a machine never reads a
clock of its own.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence

from .peer_advert import advert_epoch, base32_lower, is_instance_name, txt_entries
from .peer_contact import MAX_CONTACT_SECRETS, valid_cats
from .peer_display import clean_label
from .peer_noise import hkdf_sha256, hmac_sha256
from .peer_payload import caps_intersection, parse_strict_object

__all__ = [
    "DialBudget",
    "GATED_CALLS",
    "GATE_EFFECTS",
    "JoinPlan",
    "LOCAL_ATTEMPT_SECONDS",
    "LOCAL_C1_PER_WINDOW",
    "LOCAL_C1_WINDOW_SECONDS",
    "LOCAL_CAP",
    "LOCAL_CODE_DIGITS",
    "LOCAL_DIAL_BUDGET",
    "LOCAL_DIAL_BUDGET_SECONDS",
    "LOCAL_JOIN_BROWSE_SECONDS",
    "LOCAL_JOIN_CANDIDATES",
    "LOCAL_JOIN_KEPT",
    "LOCAL_LINK_BODY_MAX",
    "LOCAL_PAIR_FAILURES",
    "LOCAL_PAIR_SECONDS",
    "LOCAL_QR_SECRET_BYTES",
    "LocalExchange",
    "LocalLinkKey",
    "LocalPairingGate",
    "MAX_LINK_SECRETS",
    "MAX_LIVE_LOCAL_ADVERTS",
    "MAX_LOCAL_LINKS",
    "PairingWindow",
    "TRIAL_TOTAL",
    "TrialEntry",
    "browse_local_instance",
    "build_local_link",
    "display_code",
    "draw_nameplate",
    "draw_password",
    "listener_trial_order",
    "local_categories",
    "local_instance",
    "local_link_secret",
    "local_pairing_of",
    "local_pin",
    "make_qr",
    "negotiate_local_caps",
    "pairing_instance",
    "pairing_remote_ok",
    "parse_code",
    "parse_local_link",
    "parse_local_txt",
    "parse_qr",
    "random_byte_source",
    "trial_padding",
]

# -- Constants (§15.12) -----------------------------------------------------------------------------

#: A pairing window stays open at most this long.
LOCAL_PAIR_SECONDS = 300
#: A code is 8 digits: a 2-digit nameplate and a 6-digit password.
LOCAL_CODE_DIGITS = 8
#: The fifth failed guess closes the window.
LOCAL_PAIR_FAILURES = 5
LOCAL_QR_SECRET_BYTES = 16
LOCAL_JOIN_CANDIDATES = 2
LOCAL_JOIN_BROWSE_SECONDS = 15
#: Local links one device holds for one product.
MAX_LOCAL_LINKS = 32
MAX_LIVE_LOCAL_ADVERTS = 8
#: ``MAX_CONTACT_SECRETS`` (72) plus ``MAX_LOCAL_LINKS``.
MAX_LINK_SECRETS = 104
#: The pairing window admits at most this many C1s in any ``LOCAL_C1_WINDOW_SECONDS``.
LOCAL_C1_PER_WINDOW = 5
LOCAL_C1_WINDOW_SECONDS = 60
#: From the first byte (C1 included) to the transport.
LOCAL_ATTEMPT_SECONDS = 30
#: The joiner keeps at most this many matching ``m=q`` names while it joins.
LOCAL_JOIN_KEPT = 8
LOCAL_LINK_BODY_MAX = 4096
#: The mandatory capability of mode ``q``.
LOCAL_CAP = "local/1"

# -- The code (§15.12, "The code") ------------------------------------------------------------------

#: A source of random bytes that answers ``None`` when it cannot supply ``n`` of them (a stream of fixed
#: bytes in a vector; the system source never runs out).
DrawSource = Callable[[int], Optional[bytes]]


def random_byte_source(n: int) -> Optional[bytes]:
    """The operating system's random bytes as a :data:`DrawSource`."""
    import os

    return os.urandom(n)


def _two(n: int) -> str:
    return "%02d" % n


def draw_nameplate(source: DrawSource, in_use: Sequence[str] = ()) -> Optional[str]:
    """The nameplate: one byte at a time, 200 or more drawn again, then mod 100, and a nameplate in ``in_use``
    drawn again unless all 100 are in use (then any is taken). Rejection sampling, so every nameplate is
    equally likely. ``None`` when the source runs out."""
    used = set(in_use)
    everything = len(used) >= 100 and all(_two(i) in used for i in range(100))
    while True:
        b = source(1)
        if b is None:
            return None
        if b[0] >= 200:
            continue
        n = _two(b[0] % 100)
        if not everything and n in used:
            continue
        return n


def draw_password(source: DrawSource) -> Optional[str]:
    """The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6, written with
    leading zeros. ``None`` when the source runs out."""
    while True:
        b = source(4)
        if b is None:
            return None
        n = int.from_bytes(b[:4], "big")
        if n >= 4_294_000_000:
            continue
        return "%06d" % (n % 1_000_000)


def display_code(nameplate: str, password: str) -> str:
    """``4812 3456``: two groups of four, one space."""
    digits = nameplate + password
    if _DIGITS8.fullmatch(digits) is None:
        raise ValueError("code")
    return "%s %s" % (digits[:4], digits[4:])


_DIGITS8 = re.compile(r"[0-9]{8}")


def parse_code(text: str) -> Dict[str, Any]:
    """A typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits."""
    digits = text.replace(" ", "").replace("-", "")
    if _DIGITS8.fullmatch(digits) is None:
        return {"ok": False}
    return {"ok": True, "nameplate": digits[:2], "password": digits[2:]}


# -- The QR (§15.12, "The QR") ----------------------------------------------------------------------

_B32 = "abcdefghijklmnopqrstuvwxyz234567"
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
#: The base32 characters of an instance after ``p1-`` (16) and of the QR secret (26).
_INSTANCE_BODY = re.compile(r"[a-z2-7]{16}")
_SECRET = re.compile(r"[a-z2-7]{26}")
_FOLD = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}


def _ascii_fold(s: str) -> str:
    return s.translate(_FOLD)


def make_qr(slug: str, instance: str, secret: bytes) -> str:
    """``PKP1:<SLUG>:<INSTANCE>:<SECRET>`` in upper case."""
    if _SLUG.fullmatch(slug) is None:
        raise ValueError("slug")
    if not is_instance_name(instance):
        raise ValueError("instance")
    if len(secret) != LOCAL_QR_SECRET_BYTES:
        raise ValueError("secret")
    return ("PKP1:%s:%s:%s" % (slug, instance[3:], base32_lower(bytes(secret)))).upper()


def _decode_secret(chars: str) -> Optional[bytes]:
    """The 16 bytes of 26 canonical base32 characters; ``None`` when the two unused low bits are set."""
    acc = 0
    for c in chars:
        acc = (acc << 5) | _B32.index(c)
    if acc & 0b11:
        return None
    return (acc >> 2).to_bytes(16, "big")


def parse_qr(text: str, own: str) -> Dict[str, Any]:
    """Read a scanned QR. ASCII case is folded and the text needs four fields split at ``:``: ``PKP1``, a slug,
    16 base32 characters and 26 canonical ones. A well-formed slug that is not ``own`` answers
    ``{"result": "other-app"}``; everything else wrong is ``invalid``, and the slug is judged last."""
    invalid = {"result": "invalid"}
    f = _ascii_fold(text).split(":")
    if len(f) != 4 or f[0] != "pkp1":
        return invalid
    _, slug, instance, secret = f
    if _SLUG.fullmatch(slug) is None or _INSTANCE_BODY.fullmatch(instance) is None:
        return invalid
    if _SECRET.fullmatch(secret) is None:
        return invalid
    data = _decode_secret(secret)
    if data is None:
        return invalid
    if slug != own:
        return {"result": "other-app"}
    return {"result": "ok", "slug": slug, "instance": "p1-" + instance, "secret": data}


# -- The adverts (§15.12, "The pairing window" and "Mode l") ----------------------------------------


def pairing_instance(sid: bytes) -> str:
    """The ``m=q`` instance: ``p1-`` and the 16 base32 characters of the window's 10 random bytes."""
    if len(sid) != 10:
        raise ValueError("sid")
    return "p1-" + base32_lower(bytes(sid))


def local_instance(secret: bytes, advertiser_link_key: bytes, epoch: int) -> str:
    """The ``m=l`` instance of an advertiser in one epoch: ``p1-`` and the first 16 characters of the
    lower-case base32 of ``HMAC-SHA256(secret, "pkey-peer/1 ldisc" || 0x00 || u64be(epoch) || key)``, with the
    advertiser's own link key so the two devices of a link differ."""
    mac = hmac_sha256(
        bytes(secret), b"pkey-peer/1 ldisc\x00" + epoch.to_bytes(8, "big") + bytes(advertiser_link_key)
    )
    return "p1-" + base32_lower(mac)[:16]


class LocalLinkKey(NamedTuple):
    """A link the device holds, as a browser tests it: its secret and the peer's link key."""

    secret: bytes
    peer_key: bytes

    def __repr__(self) -> str:
        return "LocalLinkKey(<redacted>)"

    def __str__(self) -> str:
        return "LocalLinkKey(<redacted>)"


def browse_local_instance(
    instance: str, links: Sequence[LocalLinkKey], now_seconds: int
) -> Optional[Dict[str, int]]:
    """Which held link an instance belongs to: the first of the first ``MAX_LOCAL_LINKS``, in held order, that
    matches in the current or the previous epoch. At most 64 HMACs. ``{"link": index, "epochBack": 0|1}``."""
    if not is_instance_name(instance):
        return None
    epoch = advert_epoch(now_seconds)
    for i, link in enumerate(links[:MAX_LOCAL_LINKS]):
        for back in (0, 1):
            if epoch - back < 0:
                continue
            if local_instance(link.secret, link.peer_key, epoch - back) == instance:
                return {"link": i, "epochBack": back}
    return None


def parse_local_txt(entries: Sequence[str]) -> Dict[str, Any]:
    """``v=1`` and ``m=l``. Entries split as :func:`~polaris_key.core.peer_advert.txt_entries` splits them;
    ``h`` and ``n`` are not read."""
    kv = txt_entries(entries)
    if kv is None:
        return {"ok": False, "reason": "duplicate"}
    if kv.get("v") != "1":
        return {"ok": False, "reason": "version"}
    if kv.get("m") != "l":
        return {"ok": False, "reason": "mode"}
    return {"ok": True, "mode": "l"}


# -- The LOCAL_LINK body (§15.12, "The LOCAL_LINK body") --------------------------------------------


def build_local_link(cats: Sequence[str], label: Optional[str] = None) -> bytes:
    """The bytes of a ``LOCAL_LINK`` body. Raises ``ValueError`` for a body the peer would refuse."""
    if not valid_cats(list(cats)):
        raise ValueError("cats")
    cleaned = clean_label(label) if label is not None else None
    body: Dict[str, Any] = {"v": 1}
    if cleaned is not None:
        body["label"] = cleaned
    body["cats"] = list(cats)
    out = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(out) > LOCAL_LINK_BODY_MAX:
        raise ValueError("size")
    return out


def parse_local_link(body: bytes) -> Dict[str, Any]:
    """Judge one ``LOCAL_LINK`` body: strict JSON of at most 4 KiB, ``v`` the integer 1, an optional label
    cleaned as a ``HELLO`` label (dropped when nothing is left), ``cats`` required. Unknown members are
    ignored; a key, id or certificate in the body is never read. ``{"ok": True, "label"?, "cats"}`` or
    ``{"ok": False}``."""
    no: Dict[str, Any] = {"ok": False}
    if len(body) > LOCAL_LINK_BODY_MAX:
        return no
    o = parse_strict_object(bytes(body))
    if o is None:
        return no
    v = o.get("v")
    if isinstance(v, bool) or not isinstance(v, int) or v != 1:
        return no
    label = o.get("label")
    if "label" in o and not isinstance(label, str):
        return no
    cats = o.get("cats")
    if not isinstance(cats, list) or not valid_cats(cats):
        return no
    clean = clean_label(label) if isinstance(label, str) else None
    out: Dict[str, Any] = {"ok": True}
    if clean is not None:
        out["label"] = clean
    out["cats"] = list(cats)
    return out


# -- The link secret (§15.12, "The link secret") ----------------------------------------------------


def local_link_secret(h: bytes, isk: bytes, key_a: bytes, key_b: bytes) -> bytes:
    """``HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local" || 0x00 || lo || hi)``, 32 bytes: ``h`` is
    the mode-``q`` handshake hash, ``isk`` the CPace ISK (64 bytes) and ``lo``, ``hi`` the two link public
    keys by unsigned byte order."""
    a, b = bytes(key_a), bytes(key_b)
    if len(a) != 32 or len(b) != 32:
        raise ValueError("key")
    lo, hi = (a, b) if a <= b else (b, a)
    return hkdf_sha256(bytes(h), bytes(isk), b"pkey-peer/1 local\x00" + lo + hi, 32)


#: A link's categories: the entries both sides listed, once each, in byte order.
local_categories = caps_intersection


# -- Handshake capabilities (§15.12 step 4) ---------------------------------------------------------


def negotiate_local_caps(mode: str, local: Sequence[str], remote: Sequence[str]) -> Dict[str, Any]:
    """The session's capabilities of a mode-``q`` or mode-``l`` handshake. Mode ``q`` without ``local/1`` in
    them: ``close`` is ``peer_not_allowed``, before any consent."""
    caps = caps_intersection(local, remote)
    if mode == "q" and LOCAL_CAP not in caps:
        return {"caps": caps, "close": "peer_not_allowed"}
    return {"caps": caps}


# -- The joiner (§15.12, "The joiner") --------------------------------------------------------------


class JoinPlan:
    """The joiner's choices over one browse. ``input`` is ``{"kind": "code", "nameplate"}``, ``{"kind": "qr",
    "instance"}`` or ``{"kind": "invalid"}``. A code or QR that did not parse browses nothing and answers
    ``pairing-code-failed``. Matching ``m=q`` adverts are kept once each in first-seen order, at most
    ``LOCAL_JOIN_KEPT``, and the first ``LOCAL_JOIN_CANDIDATES`` are dialled, never redialled. The first
    session that reaches the transport ends the dial."""

    def __init__(self, input: Dict[str, Any]) -> None:  # noqa: A002 - mirrors the vectors
        self._input = input
        self._kept: List[str] = []
        self._dials = 0
        self._transport = False
        self._after_c2 = False

    @property
    def browses(self) -> bool:
        """Whether anything is browsed at all."""
        return self._input["kind"] != "invalid"

    @property
    def kept(self) -> List[str]:
        return list(self._kept)

    def see(self, instance: str, tag_matches: bool, n: str) -> bool:
        """One ``m=q`` advert seen. ``tag_matches`` is whether its ``h`` is this product's tag of the current or
        previous epoch; ``n`` its nameplate. Returns whether it was kept."""
        if not self.browses or not tag_matches:
            return False
        match = n == self._input["nameplate"] if self._input["kind"] == "code" else instance == self._input["instance"]
        if not match or instance in self._kept or len(self._kept) >= LOCAL_JOIN_KEPT:
            return False
        self._kept.append(instance)
        return True

    def next(self) -> Optional[str]:
        """The next advert to dial, or ``None`` when the dial has ended."""
        if self._transport or self._dials >= LOCAL_JOIN_CANDIDATES:
            return None
        return self._kept[self._dials] if self._dials < len(self._kept) else None

    def ended(self, outcome: str) -> None:
        """The dial of :meth:`next` ended: ``transport``, ``before-c2`` or ``after-c2``."""
        self._dials += 1
        if outcome == "transport":
            self._transport = True
        elif outcome == "after-c2":
            self._after_c2 = True

    def result(self) -> str:
        """The answer once no dial is left (or the browse ran out)."""
        if self._input["kind"] == "invalid":
            return "pairing-code-failed"
        if self._transport:
            return "transport"
        return "pairing-code-failed" if self._after_c2 else "pairing-not-found"


#: At most this many dials per nameplate in any ``LOCAL_DIAL_BUDGET_SECONDS``, across joins.
LOCAL_DIAL_BUDGET = 2
LOCAL_DIAL_BUDGET_SECONDS = 300


class DialBudget:
    """The joiner's dials per typed nameplate across joins, in memory, per product (§15.12). A person who
    retypes a code meets the same budget as one join: a fake advert that answers a dial gets one guess, so
    retries must not multiply the dials. A QR names its instance and is never limited."""

    def __init__(self) -> None:
        self._dialled: Dict[str, List[float]] = {}

    def _recent(self, nameplate: str, t: float) -> List[float]:
        kept = [d for d in self._dialled.get(nameplate, []) if t - d < LOCAL_DIAL_BUDGET_SECONDS]
        self._dialled[nameplate] = kept
        return kept

    def check(self, nameplate: str, t: float) -> Dict[str, Any]:
        """Whether a join of this nameplate may browse and dial now, and the dials already spent."""
        used = len(self._recent(nameplate, t))
        return {"allowed": used < LOCAL_DIAL_BUDGET, "used": used}

    def spend(self, nameplate: str, t: float, dials: int) -> None:
        """The join made ``dials`` dials."""
        self._recent(nameplate, t).extend([t] * dials)


# -- The pairing window (§15.12, "The pairing window") ----------------------------------------------


def _out(result: Optional[str] = None, **kw: Any) -> Dict[str, Any]:
    o: Dict[str, Any] = {"rotate": False}
    if result is not None:
        o["result"] = result
    o.update(kw)
    return o


class PairingWindow:
    """The shower's window over events with a monotonic time in seconds. A C1 that is admitted hands out an
    attempt id; one attempt holds the window from its C1 until its guess or ``LOCAL_ATTEMPT_SECONDS``.

    A guess is counted before its tag is tried. The session asks :meth:`begin_guess`, a synchronous permit
    given once, to the holder's own attempt only, while the window is open; it counts the failure now (the
    fifth closes the window once its verdict is in), and an attempt that was not permitted, a stale, expired
    or closed one, answers ``False`` and its tag is never tried. A guess that opens is refunded
    (:meth:`guess_opened`) and the attempt becomes the session; one that does not, and a permitted attempt
    whose connection ends (:meth:`abandon`) or runs out its 30 s, is a failed guess (:meth:`guess_failed`):
    the password and the QR secret rotate. The window is ``rotating`` until :meth:`rotated`, which the host
    calls once the new secrets and both generators are ready (§15.12, step 6), so a C1 never meets the old
    password or a generator that is still being made.

    A refused C1 and an attempt that never reached its guess count nothing; a session that ends without a
    link also rotates and holds the window until ``rotated``. At most 5 C1s a minute are admitted, counted
    when admitted; a busy C1 is never counted. The window expires ``LOCAL_PAIR_SECONDS`` after it opened,
    which closes a connection that has not reached the transport (the host closes it) and leaves a session
    running. Attempt ids never repeat, so a connection of a closed window cannot touch the next one.

    Every call answers a dict: ``rotate`` (the host makes a new code now), and when there is one ``result``,
    ``id`` and ``host``. :attr:`state` is the window's own bookkeeping."""

    def __init__(self) -> None:
        self._open = False
        self._opened_at = 0.0
        self._holder: Optional[str] = None
        self._attempt: Optional[Dict[str, Any]] = None
        self._next_id = 1
        self._failures = 0
        self._rotations = 0
        self._closed: Optional[str] = None
        self._admits: List[float] = []

    @property
    def state(self) -> Dict[str, Any]:
        return {
            "open": self._open,
            "holder": self._holder,
            "failures": self._failures,
            "rotations": self._rotations,
            "closed": self._closed,
        }

    def tick(self, t: float) -> Dict[str, Any]:
        """Apply the clocks: the window's expiry and an attempt's deadline."""
        out = _out()
        if self._open and t - self._opened_at >= LOCAL_PAIR_SECONDS:
            self._open = False
            self._closed = "expired"
            # A counted guess stays counted; there is no window left to rotate.
            if self._holder == "attempt":
                self._drop()
            if self._holder == "rotating":
                self._holder = None
        a = self._attempt
        if self._holder == "attempt" and a is not None and t - a["at"] >= LOCAL_ATTEMPT_SECONDS:
            if a["guessed"]:
                out = self._failed()
            else:
                self._drop()
        return out

    def _drop(self) -> None:
        self._attempt = None
        self._holder = None

    def _is_holder(self, id: int) -> bool:  # noqa: A002
        return self._open and self._holder == "attempt" and self._attempt is not None and self._attempt["id"] == id

    def open(self, t: float) -> Dict[str, Any]:
        """One window per device per product: an open window, or a session still running, answers
        ``already-open``."""
        self.tick(t)
        if self._open or self._holder == "session":
            return _out("already-open")
        self._open = True
        self._opened_at = t
        self._holder = None
        self._attempt = None
        self._failures = 0
        self._rotations = 0
        self._closed = None
        self._admits = []
        return _out("opened")

    def c1(self, t: float, valid: bool) -> Dict[str, Any]:
        """A C1 arrived; ``valid`` is whether it passed the frame and share checks."""
        self.tick(t)
        if not self._open:
            return _out("closed")
        if self._holder is not None:
            return _out("busy")
        self._admits = [a for a in self._admits if t - a < LOCAL_C1_WINDOW_SECONDS]
        if len(self._admits) >= LOCAL_C1_PER_WINDOW:
            return _out("limited")
        self._admits.append(t)
        if not valid:
            return _out("refused")
        aid = self._next_id
        self._next_id += 1
        self._holder = "attempt"
        self._attempt = {"id": aid, "at": t, "guessed": False}
        return _out("attempt", id=aid)

    def begin_guess(self, id: int, t: float) -> bool:  # noqa: A002
        """The permit to try message 1's tag. ``True`` once, for the holder's own attempt, while the window is
        open and the attempt's 30 s have not run out; the guess is counted now. ``False`` otherwise: the
        session must not try the tag."""
        self.tick(t)
        if not self._is_holder(id) or self._attempt is None or self._attempt["guessed"]:
            return False
        self._attempt["guessed"] = True
        self._failures += 1
        return True

    def guess_opened(self, id: int, t: float) -> Dict[str, Any]:  # noqa: A002
        """The permitted guess opened: the count is refunded and the attempt is the session."""
        self.tick(t)
        if not self._is_holder(id) or self._attempt is None or not self._attempt["guessed"]:
            return _out()
        self._failures -= 1
        self._attempt = None
        self._holder = "session"
        return _out("transport")

    def guess_failed(self, id: int, t: float) -> Dict[str, Any]:  # noqa: A002
        """The permitted guess did not open."""
        self.tick(t)
        if not self._is_holder(id) or self._attempt is None or not self._attempt["guessed"]:
            return _out()
        return self._failed()

    def _failed(self) -> Dict[str, Any]:
        self._attempt = None
        if self._failures >= LOCAL_PAIR_FAILURES:
            self._open = False
            self._closed = "too-many-tries"
            self._holder = None
            return _out("too-many-tries", host="pairing-code-failed")
        self._rotations += 1
        self._holder = "rotating"
        o = _out("failed")
        o["rotate"] = True
        return o

    def msg1(self, id: int, t: float, opens: bool) -> Optional[Dict[str, Any]]:  # noqa: A002
        """Message 1 of ``id``: the permit, then the verdict. Not permitted: nothing is tried, nothing
        changes (``None``)."""
        if not self.begin_guess(id, t):
            return None
        return self.guess_opened(id, t) if opens else self.guess_failed(id, t)

    def abandon(self, id: int, t: float) -> Dict[str, Any]:  # noqa: A002
        """The attempt's connection closed or timed out. A permitted guess with no verdict is failed."""
        self.tick(t)
        if not self._is_holder(id) or self._attempt is None:
            return _out()
        if self._attempt["guessed"]:
            return self._failed()
        self._drop()
        return _out()

    def rotated(self, t: float) -> None:
        """The new code, QR secret and both generators are ready: the window takes the next C1."""
        self.tick(t)
        if self._holder == "rotating":
            self._holder = None

    def session_end(self, t: float, stored: bool) -> Dict[str, Any]:
        """The held session ended. A stored link closes the window; any other end rotates and holds the window
        until :meth:`rotated`."""
        self.tick(t)
        if self._holder != "session":
            return _out()
        self._holder = None
        if stored:
            self._open = False
            self._closed = "stored"
            return _out()
        if not self._open:
            return _out()
        self._rotations += 1
        self._holder = "rotating"
        o = _out()
        o["rotate"] = True
        return o

    def close(self, t: float) -> Dict[str, Any]:
        """The person closed the window."""
        self.tick(t)
        if self._open:
            self._open = False
            self._closed = "person"
            if self._holder in ("attempt", "rotating"):
                self._drop()
        return _out()


# -- The gate (§15.12, "Gates") ---------------------------------------------------------------------

#: What a read that left a cached ``true`` behind makes the host do.
GATE_EFFECTS = ("close-windows", "withdraw-adverts", "end-sessions")
#: The calls the gate holds back; managing links (``list``, ``rename``, ``remove``, ``set-reachable``) is never
#: gated.
GATED_CALLS = (
    "pair",
    "join",
    "advertise-q",
    "advertise-l",
    "browse-q",
    "browse-l",
    "dial-l",
    "answer-l",
)


def local_pairing_of(body: Any) -> bool:
    """``services.connect.localPairing`` of a discovery body: true only as the boolean ``true`` while
    ``services.connect.enabled`` is the boolean ``true``. A body of any other shape, a disabled service and an
    absent member all read as false."""

    def member(o: Any, key: str) -> Any:
        return o.get(key) if isinstance(o, dict) else None

    connect = member(member(body, "services"), "connect")
    return member(connect, "enabled") is True and member(connect, "localPairing") is True


class LocalPairingGate:
    """The SDK's enforcement of the operator gate from the discovery document it cached. No cached document is
    off, and offline a cached ``true`` keeps working. A successful read replaces the answer, a not-found
    clears it, an error changes nothing; a read that leaves a cached ``true`` behind returns the effects the
    host must carry out."""

    def __init__(self, cached: str = "none") -> None:
        self._cached = cached

    @property
    def state(self) -> str:
        """``on``, ``off`` or ``none``."""
        return self._cached

    @property
    def allowed(self) -> bool:
        return self._cached == "on"

    def read_ok(self, body: Any) -> List[str]:
        """A successful discovery read."""
        return self._set("on" if local_pairing_of(body) else "off")

    def read_not_found(self) -> List[str]:
        """A not-found discovery read: the cached answer is cleared."""
        return self._set("none")

    def read_error(self) -> List[str]:
        """A failed read (offline, an error status): nothing changes."""
        return []

    def _set(self, nxt: str) -> List[str]:
        was = self._cached
        self._cached = nxt
        return list(GATE_EFFECTS) if was == "on" and nxt != "on" else []

    def check(self) -> str:
        """``local-pairing-off`` for a gated call while the gate is not on, else ``ok``."""
        return "ok" if self.allowed else "local-pairing-off"


# -- The pairing exchange (§15.12, "Consent and LOCAL_LINK") ----------------------------------------


class LocalExchange:
    """One side's order guard over the records of the pairing (§15.12, "Order of checks"). A ``LOCAL_LINK``
    goes out once this side has sent its ``CONFIRM`` and read the peer's; the peer's arrives only after both.
    The first valid ``LOCAL_LINK`` is stored and the side closes ``peer_bye``; after any close nothing
    happens, so a second ``LOCAL_LINK`` is never answered.

    ``held`` is the number of local links the device holds; ``cats`` are this side's approved ones.
    :meth:`step` takes ``{"event": ...}`` (``own-confirm``, ``own-decline``, ``peer-confirm``, ``peer-link``
    with a ``body`` of bytes, ``timeout-confirm``, ``timeout-exchange``) and answers ``{"sends": [...],
    "close"?, "stored"?}``."""

    def __init__(self, held: int, cats: Sequence[str]) -> None:
        self._held = held
        self._cats = list(cats)
        self._own_confirmed = False
        self._peer_confirmed = False
        self._link_sent = False
        self._dead = False

    @property
    def both_confirmed(self) -> bool:
        """Both ``CONFIRM``s are done (this side's sent, the peer's read), and no link has closed the session."""
        return not self._dead and self._own_confirmed and self._peer_confirmed

    def step(self, e: Dict[str, Any]) -> Dict[str, Any]:
        r: Dict[str, Any] = {"sends": []}
        if self._dead:
            return r

        def end(close: str) -> Dict[str, Any]:
            self._dead = True
            r["close"] = close
            return r

        def maybe_link() -> None:
            if self._own_confirmed and self._peer_confirmed and not self._link_sent:
                self._link_sent = True
                r["sends"].append("LOCAL_LINK")

        ev = e.get("event")
        if ev == "own-confirm":
            if self._own_confirmed:
                return r
            self._own_confirmed = True
            r["sends"].append("CONFIRM")
            maybe_link()
            return r
        if ev == "own-decline":
            # A decline after this side's CONFIRM is not an event: the person already agreed.
            return r if self._own_confirmed else end("peer_bye")
        if ev == "peer-confirm":
            if self._peer_confirmed:
                return end("peer_bad_frame")
            self._peer_confirmed = True
            maybe_link()
            return r
        if ev == "peer-link":
            if not self._own_confirmed or not self._peer_confirmed:
                return end("peer_bad_frame")
            v = parse_local_link(e["body"])
            if not v["ok"]:
                return end("peer_bad_frame")
            if self._held >= MAX_LOCAL_LINKS:
                return end("peer_not_allowed")
            stored: Dict[str, Any] = {}
            if "label" in v:
                stored["label"] = v["label"]
            stored["cats"] = local_categories(self._cats, v["cats"])
            r["stored"] = stored
            return end("peer_bye")
        if ev == "timeout-confirm":
            return r if self._own_confirmed and self._peer_confirmed else end("peer_timeout")
        if ev == "timeout-exchange":
            return end("peer_timeout") if self._own_confirmed and self._peer_confirmed else r
        raise ValueError("event")


# -- The pin (§15.12, "Mode l" and "Link keys") -----------------------------------------------------


def local_pin(held: bytes, remote_static: bytes) -> bool:
    """Mode l: the remote static key must be the peer link key of the link whose secret opened the session.
    The initiator asks after message 2, the responder after message 3; a ``False`` ends the session as
    ``peer_revoked`` with nothing sent."""
    import hmac

    return hmac.compare_digest(bytes(held), bytes(remote_static))


def pairing_remote_ok(own: bytes, remote_static: bytes) -> bool:
    """Mode q: a remote static key equal to this side's own link key ends the handshake silently, before the
    transport (a reflected handshake). ``True`` means the key is another's."""
    import hmac

    return not hmac.compare_digest(bytes(own), bytes(remote_static))


# -- The listener's trial order (§15.5 "One listener, one order") -----------------------------------

#: The trials a full miss costs: two account keys, 72 contact secrets and 32 local-link secrets.
TRIAL_TOTAL = 2 + MAX_CONTACT_SECRETS + MAX_LOCAL_LINKS


def trial_padding(tried: int) -> int:
    """Dummy trials after a miss behind the limiter, so a silent close costs ``TRIAL_TOTAL`` trials."""
    return max(0, TRIAL_TOTAL - tried)


class TrialEntry(NamedTuple):
    #: ``a`` an account discovery key, ``c`` a contact secret, ``l`` a local-link secret.
    kind: str
    #: Position in the list as held (an absent account key keeps its slot).
    at: int


def listener_trial_order(account: Optional[Sequence[Any]], contacts: int, locals_: int) -> List[TrialEntry]:
    """The order a shared listener tries message 1 in: the account's keys (an absent one is skipped), then the
    contact secrets (at most ``MAX_CONTACT_SECRETS``), then the local-link secrets in held order (at most
    ``MAX_LOCAL_LINKS``): at most ``MAX_LINK_SECRETS`` secrets after the account keys. The contact and
    local-link trials sit behind the contact limiter; the account keys do not."""
    out: List[TrialEntry] = []
    for at, k in enumerate(list(account or [])[:2]):
        if k is not None:
            out.append(TrialEntry("a", at))
    for i in range(min(contacts, MAX_CONTACT_SECRETS)):
        out.append(TrialEntry("c", i))
    for i in range(min(locals_, MAX_LOCAL_LINKS)):
        out.append(TrialEntry("l", i))
    return out

