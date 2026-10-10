"""``license.entitled_channels()`` — the Worker's answer for the same document (P1b-07).

The fixture table below is the SAME table every SDK's channel test runs (Node
test/channels.test.ts, Swift ChannelsTests.swift, React test/channels.test.ts), so for one
``channels`` entitlement every SDK returns one list. The expectations are the Worker's own
``entitledChannels`` (packages/worker/src/core/licensing/entitlements.ts): the string values in order,
as granted (no alias rewriting, no deduplication), and ``["stable"]`` when the entitlement is
absent or not an array. There is no corpus case for this yet (P0-04 D11), so identical unit
fixtures are the proof.
"""

# @pkey-feature license.channels

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, List

import pytest

from polaris_key.core.models import ManagedEntry
from polaris_key.license.client import LicenseClient

_ABSENT = object()

#: (name, the ``channels`` entitlement's value (_ABSENT ⇒ absent), the expected list)
FIXTURES = [
    ("absent", _ABSENT, ["stable"]),
    ("stable only", ["stable"], ["stable"]),
    ("beta", ["beta"], ["beta"]),
    ("order kept", ["pr-42", "stable", "beta"], ["pr-42", "stable", "beta"]),
    ("aliases are raw grants", ["staging", "latest"], ["staging", "latest"]),
    ("duplicates kept", ["beta", "beta"], ["beta", "beta"]),
    ("non-strings dropped", ["beta", 7, None, True, {"a": 1}, "pr"], ["beta", "pr"]),
    ("empty array", [], []),
    ("a string, not an array", "beta", ["stable"]),
    ("null", None, ["stable"]),
    ("an object", {"beta": True}, ["stable"]),
]


def _license_with(channels: Any) -> LicenseClient:
    entitlements = {"polarisVpn": ManagedEntry(state="enforced", value=True, updated_at=1)}
    if channels is not _ABSENT:
        entitlements["channels"] = ManagedEntry(state="enforced", value=channels, updated_at=1)
    doc = SimpleNamespace(entitlements=entitlements)
    cache = SimpleNamespace(license_doc=lambda: doc)
    return LicenseClient(None, cache, None, None, lambda _src: None)  # type: ignore[arg-type]


@pytest.mark.parametrize("name, value, want", FIXTURES, ids=[f[0] for f in FIXTURES])
def test_entitled_channels(name: str, value: Any, want: List[str]) -> None:
    assert _license_with(value).entitled_channels() == want


def test_no_licence_document_is_the_stable_floor() -> None:
    cache = SimpleNamespace(license_doc=lambda: None)
    c = LicenseClient(None, cache, None, None, lambda _src: None)  # type: ignore[arg-type]
    assert c.entitled_channels() == ["stable"]
