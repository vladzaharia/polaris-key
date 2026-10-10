# @pkey-feature license.signedinuser
"""The signed-in user reader (WIRE-CONTRACT-V4 §3.2, plans/SP-54.md): total, never raises.

The corpus rows replay in test_conformance.py; these cover the decoder and client surface.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from polaris_key import DocProfile, SignedInUser, license_user
from polaris_key.license.client import LicenseClient

SUBJECT = "ps_" + "A1_-" * 5 + "bc"


def test_subject_shape_is_the_generated_pattern() -> None:
    assert len(SUBJECT) == 25
    assert license_user({"profile": {"user": {"subject": SUBJECT}}}) == SignedInUser(SUBJECT)


@pytest.mark.parametrize(
    "doc",
    [
        None,
        "x",
        [],
        {},
        {"profile": None},
        {"profile": "x"},
        {"profile": {}},
        {"profile": {"user": None}},
        {"profile": {"user": []}},
        {"profile": {"user": "ps_" + "a" * 22}},
        {"profile": {"user": {}}},
        {"profile": {"user": {"subject": 7}}},
        {"profile": {"user": {"subject": "ps_" + "a" * 21}}},
        {"profile": {"user": {"subject": "ps_" + "a" * 23}}},
        {"profile": {"user": {"subject": "ps_" + "a" * 22 + "\n"}}},
        {"profile": {"user": {"subject": "ps_" + "é" * 22}}},
        {"profile": {"user": {"subject": "us_" + "a" * 22}}},
        object(),
    ],
)
def test_malformed_or_absent_is_none(doc: Any) -> None:
    assert license_user(doc) is None


def test_unknown_members_are_ignored() -> None:
    raw = {"name": "N", "user": {"subject": SUBJECT, "extra": 1}}
    assert DocProfile.from_any(raw).user == SignedInUser(SUBJECT)  # type: ignore[union-attr]


def test_profile_without_user_has_none_and_round_trips() -> None:
    p = DocProfile.from_any({"name": "N", "email": "e@x.io"})
    assert p is not None and p.user is None and "user" not in p.to_dict()
    q = DocProfile.from_any({"name": "N", "user": {"subject": SUBJECT}})
    assert q is not None and DocProfile.from_any(q.to_dict()) == q


def test_client_reader_is_none_without_a_document() -> None:
    assert LicenseClient.get_license_user(SimpleNamespace(doc=None)) is None  # type: ignore[arg-type]
    doc = SimpleNamespace(profile=DocProfile(email="holder@x.io", user=SignedInUser(SUBJECT)))
    assert LicenseClient.get_license_user(SimpleNamespace(doc=doc)) == SignedInUser(SUBJECT)  # type: ignore[arg-type]
    key = SimpleNamespace(profile=DocProfile(email="holder@x.io"))
    assert LicenseClient.get_license_user(SimpleNamespace(doc=key)) is None  # type: ignore[arg-type]
