# @pkey-feature license.manage
"""PX-W8 (WIRE-CONTRACT-V4 §5.3): the refusal link helpers and the device-limit result.

The same table as client-core ``test/manage.test.ts``, so every SDK builds byte-identical
links.
"""

from __future__ import annotations

import pytest

from polaris_key import (
    MANAGE_URL_MAX_LENGTH,
    is_manage_url,
    manage_form_encode,
    read_manage_url,
    with_manage_key,
    with_manage_return,
)

FREE = "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64"
ACTIVATE = "https://key.plrs.im/activate?product=djdl"


@pytest.mark.parametrize(
    "body,want",
    [
        ({"manageUrl": FREE}, FREE),
        ({"manageUrl": ACTIVATE}, ACTIVATE),
        (
            {"manageUrl": "http://localhost:8787/activate?product=djdl"},
            "http://localhost:8787/activate?product=djdl",
        ),
        ({"error": {"code": "x", "manageUrl": FREE}}, FREE),
        ({"manageUrl": "javascript:alert(1)"}, None),
        ({"manageUrl": "http://key.plrs.im/activate"}, None),
        ({"manageUrl": "https://user:pw@key.plrs.im/activate"}, None),
        ({"manageUrl": "/activate?product=djdl"}, None),
        ({"manageUrl": "https:key.plrs.im/activate"}, None),
        ({"manageUrl": "https://key.plrs.im\\@evil.example/activate"}, None),
        ({"manageUrl": "https://key.plrs.im\\evil/activate"}, None),
        ({"manageUrl": "https://key.plrs.im/a b"}, None),
        ({"manageUrl": 7}, None),
        ({"error": "device_limit", "limit": 1, "deviceCount": 1}, None),
        ("device_limit", None),
        (None, None),
    ],
)
def test_read_manage_url(body, want):
    assert read_manage_url(body) == want


def test_length_cap():
    assert MANAGE_URL_MAX_LENGTH == 2048
    base = "https://key.plrs.im/activate?product="
    exact = base + "a" * (MANAGE_URL_MAX_LENGTH - len(base))
    assert is_manage_url(exact)
    assert read_manage_url({"manageUrl": exact + "a"}) is None


def test_with_manage_return():
    assert (
        with_manage_return(FREE, "myapp://done")
        == "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64&return=myapp%3A%2F%2Fdone"
    )
    assert (
        with_manage_return(ACTIVATE, "https://app.example/a b")
        == "https://key.plrs.im/activate?product=djdl&return=https%3A%2F%2Fapp.example%2Fa+b"
    )
    assert (
        with_manage_return(ACTIVATE + "#key=k", "x")
        == "https://key.plrs.im/activate?product=djdl&return=x#key=k"
    )
    assert (
        with_manage_return("https://key.plrs.im/#/p/djdl/free-device?return=old", "new")
        == "https://key.plrs.im/#/p/djdl/free-device?return=new"
    )
    assert (
        with_manage_return("https://key.plrs.im/#/p/djdl/free-device", "new")
        == "https://key.plrs.im/#/p/djdl/free-device?return=new"
    )
    assert with_manage_return("javascript:alert(1)", "x") == "javascript:alert(1)"
    assert with_manage_return(FREE, "") == FREE


def test_with_manage_key():
    assert (
        with_manage_key(ACTIVATE, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
        == "https://key.plrs.im/activate?product=djdl#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"
    )
    assert (
        with_manage_key(
            "https://key.plrs.im/activate?product=djdl&next=free-device#key=old", "k y"
        )
        == "https://key.plrs.im/activate?product=djdl&next=free-device#key=k+y"
    )
    assert with_manage_key(FREE, "pkey_x") == FREE
    assert (
        with_manage_key("https://key.plrs.im/signin?product=djdl", "k")
        == "https://key.plrs.im/signin?product=djdl"
    )
    assert with_manage_key("javascript:alert(1)", "k") == "javascript:alert(1)"
    assert with_manage_key(ACTIVATE, "") == ACTIVATE


def test_form_encode():
    assert manage_form_encode("aZ09*-._ ~/:é") == "aZ09*-._+%7E%2F%3A%C3%A9"
