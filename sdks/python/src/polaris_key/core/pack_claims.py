"""The pack claims shared by the release record (step 14) and the content stamp
(plans/P4-01.md §2.3, §2.4, §2.8; WIRE-CONTRACT-V4 §2.5.1, §2.5.2). Pure, never raises.

A port of ``@polaris-key/client-core``'s ``packs/claims.ts`` and ``packs/variant.ts``. One
:func:`object_ref` checks every object ref (``full``, ``files``, ``gaps``, ``patch``), so the
corpus's object-ref cases on ``full`` stand for every site; :func:`is_pack_id` is the one
pack-id rule (``deliverable`` of a pack record, ``pins[].pack``, ``expects[].pack``,
``builds[].embeds[]``).

The patterns are restated from ``packages/shared-protocol/src/packs.ts`` (they are not in the
generated constants) and every one runs through :func:`polaris_key.core.patterns._full_match`,
so a trailing newline never matches.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

from ..constants_generated import MAX_CONTENT_PINS
from .models import _wire_int
from .patterns import _full_match

__all__ = [
    "PACK_TYPE_PATTERN",
    "VOCAB_TOKEN_PATTERN",
    "OBJECT_FORMAT_PATTERN",
    "HANDLER_PREFIX_PATTERN",
    "ENTITLEMENT_PATTERN",
    "VARIANT_AXIS_PATTERN",
    "VARIANT_VALUE_PATTERN",
    "ENGINE_PATTERN",
    "SHA256_PATTERN",
    "VERSION_PATTERN",
    "is_pack_id",
    "object_ref",
    "content_claims",
    "utf8_length",
    "compare_bytes",
    "variant_key",
    "is_sha256",
]

# ── packages/shared-protocol/src/packs.ts, restated ─────────────────────────────────────────
#: A pack's ``type``: ``<family>.<kind>``, e.g. ``godot.pck``, ``files.tree``.
PACK_TYPE_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}")
#: Every extensible vocabulary token: activation, layout, codec, delta method and scope, delivery.
VOCAB_TOKEN_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}")
#: A side object's ``format``: ``<name>/<version>``, e.g. ``pkey-files/1``.
OBJECT_FORMAT_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}/[1-9][0-9]{0,8}")
#: A ``godot.pck`` handler prefix, ``res://…/``, at most 256 bytes.
HANDLER_PREFIX_PATTERN = re.compile(r"res://([A-Za-z0-9_][A-Za-z0-9 ._@+-]*/)+")
#: The licence flag that gates a pack's objects.
ENTITLEMENT_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
#: A variant axis name.
VARIANT_AXIS_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,15}")
#: A variant axis value, compared by bytes.
VARIANT_VALUE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,34}")
#: ``requires.engine``: ``godot-<major>.<minor>``.
ENGINE_PATTERN = re.compile(r"godot-[0-9]+\.[0-9]+")

#: ``@polaris-key/manifest``'s ``DELIVERABLE_ID_PATTERN``, restated.
_DELIVERABLE_RE = re.compile(r"[a-z][a-z0-9-]*(\.[a-z0-9-]+)*")
#: P2-04's ``VERSION_RE``.
VERSION_PATTERN = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+-]{0,63}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def is_sha256(value: Any) -> bool:
    """64 lowercase hex characters."""
    return _full_match(SHA256_PATTERN, value) is not None


def utf8_length(s: str) -> int:
    """UTF-8 length of a string (a lone surrogate counts 3 bytes, as JavaScript's does)."""
    return len(s.encode("utf-8", "surrogatepass"))


def compare_bytes(a: str, b: str) -> int:
    """Compare two strings by their UTF-8 bytes (equal to code-point order)."""
    if a == b:
        return 0
    x = a.encode("utf-8", "surrogatepass")
    y = b.encode("utf-8", "surrogatepass")
    return -1 if x < y else 1


def variant_key(variant: Mapping[str, str]) -> str:
    """The variant key (plans/P4-01.md §2.3): the ``axis=value`` pairs sorted by axis-name bytes
    and joined with ``;`` (``locale=fr;texture=astc``), and ``""`` for ``{}``."""
    axes = sorted(variant.keys(), key=lambda s: s.encode("utf-8", "surrogatepass"))
    return ";".join(f"{axis}={variant[axis]}" for axis in axes)


def is_pack_id(value: Any) -> bool:
    """A pack id (plans/P4-01.md §2.3): a string matching ``DELIVERABLE_ID_PATTERN``, at most 64
    bytes, and not ``app``."""
    return (
        isinstance(value, str)
        and value != "app"
        and utf8_length(value) <= 64
        and _full_match(_DELIVERABLE_RE, value) is not None
    )


def object_ref(value: Any, min_bytes: int, min_size: int) -> bool:
    """An object ref ``{sha256, bytes, size, codec}`` (plans/P4-01.md §2.3): ``sha256`` 64
    lowercase hex; ``bytes`` and ``size`` integer claims from ``min_bytes`` and ``min_size``;
    ``codec`` a ``VOCAB_TOKEN_PATTERN`` string; ``codec: "none"`` only with ``bytes == size``.
    An unknown codec verifies (the object is unusable, never the record invalid).

    Python needs no pointer set: ``json.loads`` gives a ``float`` for every token that is not a
    plain integer, so :func:`_wire_int` is the integer rule at every pointer."""
    if not isinstance(value, dict):
        return False
    if not is_sha256(value.get("sha256")):
        return False
    if _wire_int(value.get("bytes"), min_bytes) is None:
        return False
    if _wire_int(value.get("size"), min_size) is None:
        return False
    if _full_match(VOCAB_TOKEN_PATTERN, value.get("codec")) is None:
        return False
    if value["codec"] == "none" and value["bytes"] != value["size"]:
        return False
    return True


def content_claims(value: Any) -> bool:
    """The ``content`` claims (plans/P4-01.md §2.4): an object with an integer ``contentApi`` ≥
    1, ``pins`` (0–256 objects, ``pack`` a unique pack id, ``release {sha256, seq ≥ 1,
    version}``) and ``expects`` (0–256 objects, ``pack`` a unique pack id, a boolean
    ``required``, a ``VOCAB_TOKEN_PATTERN`` ``delivery``). Unknown members are ignored. Never
    raises."""
    try:
        if not isinstance(value, dict):
            return False
        if _wire_int(value.get("contentApi"), 1) is None:
            return False
        pins = value.get("pins")
        if not isinstance(pins, list) or len(pins) > MAX_CONTENT_PINS:
            return False
        pinned = set()
        for pin in pins:
            if not isinstance(pin, dict) or not is_pack_id(pin.get("pack")):
                return False
            if pin["pack"] in pinned:
                return False
            pinned.add(pin["pack"])
            r = pin.get("release")
            if not isinstance(r, dict):
                return False
            if not is_sha256(r.get("sha256")):
                return False
            if _wire_int(r.get("seq"), 1) is None:
                return False
            if _full_match(VERSION_PATTERN, r.get("version")) is None:
                return False
        expects = value.get("expects")
        if not isinstance(expects, list) or len(expects) > MAX_CONTENT_PINS:
            return False
        expected = set()
        for e in expects:
            if not isinstance(e, dict) or not is_pack_id(e.get("pack")):
                return False
            if e["pack"] in expected:
                return False
            expected.add(e["pack"])
            if not isinstance(e.get("required"), bool):
                return False
            if _full_match(VOCAB_TOKEN_PATTERN, e.get("delivery")) is None:
                return False
        return True
    except Exception:
        return False

