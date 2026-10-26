# @pkey-feature identity.keyentry
"""I-10a.13: the key-entry outcomes of an activation (keyEntries, key-entry-limit, license-owned).

The recorded conversations are pinned by ``test_transcripts.py``; this file pins the readers and
the rule that neither refusal touches the client's state.
"""

from __future__ import annotations

import pytest

from polaris_key.core.manage import KeyEntries, read_key_entries
from polaris_key.license.endpoints import (
    ActivationKeyEntryLimit,
    ActivationLicenseOwned,
    activation_result_from,
)


@pytest.mark.parametrize(
    "body,want",
    [
        ({"keyEntries": {"used": 1, "limit": 2}}, KeyEntries(1, 2)),
        ({"keyEntries": {"used": 2, "limit": 1}}, KeyEntries(2, 1)),
        ({"error": {"code": "x", "keyEntries": {"used": 0, "limit": 3}}}, KeyEntries(0, 3)),
        ({}, None),
        ({"keyEntries": None}, None),
        ({"keyEntries": {"used": 1}}, None),
        ({"keyEntries": {"used": -1, "limit": 2}}, None),
        ({"keyEntries": {"used": True, "limit": 2}}, None),
        ({"keyEntries": {"used": "1", "limit": 2}}, None),
        ({"keyEntries": [1, 2]}, None),
        ("nope", None),
        (None, None),
    ],
)
def test_read_key_entries(body, want) -> None:
    assert read_key_entries(body) == want


def test_key_entry_limit_is_typed() -> None:
    r = activation_result_from(
        403,
        {
            "error": "key_entry_limit",
            "manageUrl": "https://key.plrs.im/activate?product=djdl",
            "keyEntries": {"used": 2, "limit": 2},
        },
    )
    assert isinstance(r, ActivationKeyEntryLimit)
    assert r.kind == "key-entry-limit" and r.code == "key_entry_limit"
    assert r.manage_url == "https://key.plrs.im/activate?product=djdl"
    assert r.key_entries == KeyEntries(2, 2)


def test_key_entry_limit_drops_a_bad_link() -> None:
    r = activation_result_from(403, {"error": "key_entry_limit", "manageUrl": "javascript:x"})
    assert isinstance(r, ActivationKeyEntryLimit)
    assert r.manage_url is None and r.key_entries is None


def test_license_owned_is_typed() -> None:
    r = activation_result_from(
        403, {"error": "license_owned", "signInUrl": "https://key.plrs.im/signin?product=djdl"}
    )
    assert isinstance(r, ActivationLicenseOwned)
    assert r.kind == "license-owned" and r.sign_in_url == "https://key.plrs.im/signin?product=djdl"
    assert activation_result_from(403, {"error": "license_owned", "signInUrl": "x"}).sign_in_url is None
