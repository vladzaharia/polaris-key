# @pkey-feature connect.lan
"""``lan_verdict``, ``lan_group_key`` and the address helpers (WIRE-CONTRACT-V5 §15.4.1) beyond the
shared ``lanAddresses`` rows, which ``test_connect_peer_codecs.py`` runs."""

from __future__ import annotations

import pytest

from polaris_key.core.peer_lan_address import canon_ip, fold_mapped, lan_group_key, parse_address


def test_a_refused_key_has_no_group() -> None:
    assert lan_group_key(None) is None
    assert lan_group_key("10.0.0.1") is None


def test_text_helpers_for_learning() -> None:
    assert canon_ip("FE80:0:0:0:0:0:0:1") == "fe80::1"
    assert canon_ip("fe80::1%en0") is None  # a zone is split first
    assert fold_mapped("::ffff:a00:1") == "10.0.0.1"
    assert fold_mapped("fe80::1") == "fe80::1"
    assert parse_address("10.0.0.1\n") is None and parse_address("١٠.0.0.1") is None
    assert parse_address(None) is None  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "addr,cidr,want",
    [
        ("192.168.1.20", "192.168.1.9/24", True),
        ("192.168.2.20", "192.168.1.9/24", False),
        ("192.168.191.7", "192.168.191.205/23", True),
        ("192.168.190.7", "192.168.191.205/23", True),
        ("192.168.192.7", "192.168.191.205/23", False),
        ("10.0.0.1", "0.0.0.0/0", True),
        ("::ffff:192.168.1.20", "192.168.1.9/24", True),  # a mapped source counts as its IPv4 address
        ("fe80::7%en0", "fe80::1/64", True),
        ("fe80:0:0:1::7", "fe80::1/64", False),
        ("fd12::7", "fd12:0:0:0::5/64", True),
        ("fd12::7", "192.168.1.9/24", False),  # the family must match
        ("192.168.1.20", "fe80::1/64", False),
        ("192.168.1.20", "192.168.1.9/33", False),
        ("192.168.1.20", "192.168.1.9/", False),
        ("192.168.1.20", "192.168.1.9/+4", False),
        ("192.168.1.20", "192.168.1.9/٢٤", False),  # Arabic-Indic digits
        ("192.168.1.20", "192.168.1.9", False),
        ("192.168.1.20\n", "192.168.1.9/24", False),
    ],
)
def test_in_cidr(addr: str, cidr: str, want: bool) -> None:
    from polaris_key.core.peer_lan_address import in_cidr

    assert in_cidr(addr, cidr) is want
