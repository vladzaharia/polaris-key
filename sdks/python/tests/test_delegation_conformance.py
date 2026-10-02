# @pkey-feature packs.delegation
"""P4-19's corpus sections (plans/P4-19.md §4.2, §4.3) through the Python port, as the Node
runner (``conformance/runners/node/suites.ts``) drives them, against the SAME files and ids:

=====================  ==================================================  =======================
``delegationCases``    §2.3's delegated steps 12–16, ``record_revoked``,   ``verify_release_record``,
                       delegation revocations, the feed entry ``kind``     ``verify_revocation``,
                                                                           ``record_revoked``,
                                                                           ``verify_feed``
``dataOnlyCases``      §2.5's data-only rule and Amendment A1              ``data_only_refusal``
                       (``content/cases.json``)
=====================  ==================================================  =======================
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.constants_generated import DATA_ONLY_HEAD_BYTES, DATA_ONLY_TAIL_BYTES
from polaris_key.core.feed import verify_feed
from polaris_key.core.release_record import (
    ReleaseRecordPin,
    record_revoked,
    verify_release_record,
    verify_revocation,
)
from polaris_key.update.packs.dataonly import data_only_refusal

_V2 = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
_CORPUS: Dict[str, Any] = json.loads((_V2 / "cases.json").read_text(encoding="utf-8"))
_CONTENT: Dict[str, Any] = json.loads((_V2 / "content" / "cases.json").read_text(encoding="utf-8"))

_DELEGATION: List[Dict[str, Any]] = _CORPUS["delegationCases"]
_DATA_ONLY: List[Dict[str, Any]] = _CONTENT["dataOnlyCases"]


def test_has_every_vector_of_the_plan() -> None:
    assert len(_DELEGATION) == 46
    assert len(_DATA_ONLY) == 76


def _want(c: Dict[str, Any]) -> str:
    return "ok" if c["expect"]["verify"] == "ok" else c["expect"]["step"]


@pytest.mark.parametrize(
    "case", _DELEGATION, ids=[f"{c['mode']} {c['id']} -> {_want(c)}" for c in _DELEGATION]
)
def test_delegation_case(case: Dict[str, Any]) -> None:
    want = case["expect"]
    if case["mode"] == "feed":
        r = verify_feed(
            case["jws"],
            trust=case["trust"],
            expected_aud=case["expectedAud"],
            channel=case["channel"],
            platform=case["platform"],
            now=case["now"],
            check_freshness=case["checkFreshness"],
        )
        assert r.ok, f"{case['id']}: {case['description']} (refused: {r.reason})"
        assert r.content is not None
        assert r.content.to_dict() == want["content"], case["description"]
        return
    if case["mode"] == "revocation":
        rv = verify_revocation(
            case["jws"],
            release_keys=case["releaseKeys"],
            product_trust=case["productTrust"],
            expected_aud=case["expectedAud"],
            entry=case["entry"],
        )
        if want["verify"] == "fail":
            assert not rv.ok, case["description"]
            assert rv.step == want["step"], case["description"]
            return
        assert rv.ok, f"{case['id']}: {case['description']} (refused at {rv.step})"
        got = rv.revocation.to_dict()
        assert {k: got[k] for k in ("pack", "target", "replacement", "reason", "issuedAt")} == want[
            "revocation"
        ]
        return
    pin = case.get("pin")
    delegation = case.get("delegation")
    r = verify_release_record(
        case["jws"],
        release_keys=case["releaseKeys"],
        product_trust=case["productTrust"],
        expected_aud=case["expectedAud"],
        expected_hash=case["expectedHash"],
        pin=ReleaseRecordPin(**pin) if pin else None,
        delegation=delegation if case["mode"] == "record" and isinstance(delegation, str) else None,
    )
    if want["verify"] == "fail":
        assert not r.ok, case["description"]
        assert r.step == want["step"], case["description"]
        return
    assert r.ok, f"{case['id']}: {case['description']} (refused at {r.step})"
    assert r.record is not None and r.record.kind == want["kind"]
    got_delegation = None if r.delegation is None else r.delegation.to_dict()
    assert got_delegation == want["delegation"], case["description"]
    if "revoked" in case:
        got = record_revoked(
            case["expectedHash"],
            None if r.delegation is None else r.delegation.sha256,
            set(case["revoked"]),
        )
        assert got == want["revoked"], case["description"]


def _file(c: Dict[str, Any]) -> bytes:
    if "content" in c:
        return base64.b64decode(c["content"], validate=True)
    head = base64.b64decode(c["head"], validate=True)
    fill = c.get("tailFill")
    tail = bytes([fill["byte"]]) * fill["length"] if fill else base64.b64decode(c["tail"], validate=True)
    return head + tail


@pytest.mark.parametrize(
    "case",
    _DATA_ONLY,
    ids=[f"{c['id']} -> {'ok' if c['expect']['ok'] else c['expect']['rule']}" for c in _DATA_ONLY],
)
def test_data_only_case(case: Dict[str, Any]) -> None:
    f = _file(case)
    rule = data_only_refusal(
        case["path"],
        f[:DATA_ONLY_HEAD_BYTES],
        f[max(0, len(f) - DATA_ONLY_TAIL_BYTES) :],
        f,
    )
    got = {"ok": True} if rule is None else {"ok": False, "rule": rule}
    assert got == case["expect"], case["description"]
