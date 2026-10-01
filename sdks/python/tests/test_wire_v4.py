# @pkey-feature core.verify
"""Unit proofs of the wire contract v4 verifier rules in this SDK (WIRE-CONTRACT-V4 §1–§3).

The corpus pins the verdicts (``jwsCases``, the v3 claim cases, the pointer sets); these pin
the helpers in isolation: the whole-string pattern helper, the v3 semver parser on it, the
integer-claim helper and the Ed25519 byte pre-checks.
"""

from __future__ import annotations

import re

import pytest

from polaris_key.core.b64url import b64url_decode
from polaris_key.core.jws import SMALL_ORDER_ENCODINGS, _parse_strict_json, ed25519_prechecks
from polaris_key.core.models import MAX_WIRE_INTEGER, _wire_int
from polaris_key.core.patterns import _full_match
from polaris_key.core.semver import compare_semver, parse_semver

TERMINATORS = ["\n", "\r\n", "\r", "\u0085", "\u2028", "\u2029"]


@pytest.mark.parametrize("terminator", TERMINATORS, ids=[repr(t) for t in TERMINATORS])
def test_full_match_refuses_a_trailing_line_terminator(terminator: str) -> None:
    pattern = re.compile(r"[a-z][a-z0-9-]{0,63}")
    assert _full_match(pattern, "direct") is not None
    assert _full_match(pattern, "direct" + terminator) is None


def test_full_match_refuses_non_strings() -> None:
    assert _full_match(re.compile(r"[0-9]+"), 5) is None


def test_semver_is_whole_string_and_ascii() -> None:
    assert parse_semver("1.2.3") is not None
    assert parse_semver("1.2.3\n") is None
    assert parse_semver("١.٢.٣") is None
    assert compare_semver("1.2.3", "1.2.4") == -1


def test_wire_int_is_the_token_rule() -> None:
    assert _wire_int(0, 0) == 0
    assert _wire_int(MAX_WIRE_INTEGER, 1) == MAX_WIRE_INTEGER
    for bad in (True, 7.0, 7.5, MAX_WIRE_INTEGER + 1, -1, "7", None):
        assert _wire_int(bad, 0) is None
    assert _wire_int(0, 1) is None


def test_ed25519_prechecks_refuse_small_order_keys_and_r() -> None:
    good = b64url_decode("H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U")
    assert ed25519_prechecks(good, good + b"\x00" * 32)
    for enc in SMALL_ORDER_ENCODINGS:
        assert not ed25519_prechecks(enc, good + b"\x00" * 32)
        assert not ed25519_prechecks(good, enc + b"\x00" * 32)
    big_s = (2**252 + 27742317777372353535851937790883648493).to_bytes(32, "little")
    assert not ed25519_prechecks(good, good + big_s)


@pytest.mark.parametrize(
    "text",
    [b'{"a":NaN}', b'{"a":1e400}', b'{"a":"\\ud800"}', b'{"a\\u0000b":1}', b"[1]",
     b"\xef\xbb\xbf{}", b'{"a":' + b"[" * 64 + b"]" * 64 + b"}",
     b'{"a":0e1000000}', b'{"a":-0.0e1234567}', b'{"a":0,"b":0E+1234567}'],
)
def test_strict_json_refusals(text: bytes) -> None:
    with pytest.raises(Exception):
        _parse_strict_json(text)


def test_strict_json_keeps_values() -> None:
    assert _parse_strict_json(b'{"a":[7.0,1e-7,0e5,0e999999],"\\u00e9":1,"e\\u0301":2}')["a"][0] == 7.0
