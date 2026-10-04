# @pkey-feature update.content packs.revoke packs.delta.feed
"""P4-13's corpus sections (plans/P4-13.md §4.2, §4.3) through the Python port, as the Node
runner (``conformance/runners/node/suites.ts``) drives them, against the SAME files and ids:

=====================  ==================================================  =======================
``feedContentCases``   §2.2's content members, every case                  ``verify_feed``,
                                                                           ``feed_content``
``revocationCases``    §2.3's steps 12–16, superseding                     ``verify_revocation``,
                                                                           ``verify_release_record``,
                                                                           ``newer_revocation``
``contentRows``        ``update-matrix.json``, §2.6's content decision     ``decide_update``,
                                                                           ``boot_decision``,
                                                                           ``pack_set_id``
=====================  ==================================================  =======================
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core.b64url import b64url_decode
from polaris_key.constants_generated import UpdateAction, UpdateBlockedReason
from polaris_key.core.decide import boot_decision, decide_update
from polaris_key.core.feed import feed_content, verify_feed, with_feed_content
from polaris_key.core.models import ChannelFeedDoc, UpdateDecisionInput
from polaris_key.core.release_record import (
    ReleaseRecordPin,
    newer_revocation,
    revocation_of,
    verify_release_record,
    verify_revocation,
)
from polaris_key.update.packs import pack_set_id

_V2 = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
_CORPUS: Dict[str, Any] = json.loads((_V2 / "cases.json").read_text(encoding="utf-8"))
_MATRIX: Dict[str, Any] = json.loads((_V2 / "update-matrix.json").read_text(encoding="utf-8"))

_FEED_CONTENT: List[Dict[str, Any]] = _CORPUS["feedContentCases"]
_REVOCATIONS: List[Dict[str, Any]] = _CORPUS["revocationCases"]
_ROWS: List[Dict[str, Any]] = _MATRIX["contentRows"]
_BY_ID = {c["id"]: c for c in _REVOCATIONS}


def test_has_every_vector_of_the_plan() -> None:
    assert len(_FEED_CONTENT) == 76
    assert len(_REVOCATIONS) == 27
    assert len(_ROWS) == 44


# ── feedContentCases (plans/P4-13.md §2.2) ──────────────────────────────────────────────────


@pytest.mark.parametrize("case", _FEED_CONTENT, ids=[c["id"] for c in _FEED_CONTENT])
def test_feed_content_case(case: Dict[str, Any]) -> None:
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
    # plans/P4-29.md §4.1: `expect.content` holds P4-13's three members; the delta menu is
    # compared with `expect.deltas ?? null` on every case.
    want_deltas = case["expect"].get("deltas")
    got = r.content.to_dict()
    assert got.pop("deltas") == want_deltas, case["description"]
    assert got == case["expect"]["content"], case["description"]
    # The same reading over the decoded payload, and through the decision's copy.
    assert r.feed is not None
    again = feed_content(r.feed.raw).to_dict()
    assert again.pop("deltas") == want_deltas
    assert again == case["expect"]["content"]
    assert feed_content(with_feed_content(r.feed, r.content).raw) == r.content


# ── revocationCases (plans/P4-13.md §2.3) ───────────────────────────────────────────────────


def _verify(case: Dict[str, Any]) -> Any:
    return verify_revocation(
        case["jws"],
        release_keys=case["releaseKeys"],
        product_trust=case["productTrust"],
        expected_aud=case["expectedAud"],
        entry=case["entry"],
    )


@pytest.mark.parametrize(
    "case",
    _REVOCATIONS,
    ids=[f"{c['id']} -> {'ok' if c['expect']['verify'] == 'ok' else c['expect']['step']}" for c in _REVOCATIONS],
)
def test_revocation_case(case: Dict[str, Any]) -> None:
    want = case["expect"]
    if case["mode"] == "replacement":
        r = verify_release_record(
            case["jws"],
            release_keys=case["releaseKeys"],
            product_trust=case["productTrust"],
            expected_aud=case["expectedAud"],
            expected_hash=case["expectedHash"],
            pin=ReleaseRecordPin(**case["pin"]),
        )
        if want["verify"] == "ok":
            assert r.ok, f"{case['id']}: {case['description']} (refused at {r.step})"
            assert r.record is not None and r.record.kind == want["kind"]
        else:
            assert not r.ok, case["description"]
            assert r.step == want["step"], case["description"]
        return
    r = _verify(case)
    if want["verify"] == "fail":
        assert not r.ok, case["description"]
        assert r.step == want["step"], case["description"]
        return
    assert r.ok, f"{case['id']}: {case['description']} (refused at {r.step})"
    got = r.revocation.to_dict()
    assert {k: got[k] for k in ("pack", "target", "replacement", "reason", "issuedAt")} == want[
        "revocation"
    ]
    # The body alone reads the same.
    body = revocation_of(json.loads(_payload(case["jws"])))
    assert body is not None and body.to_dict() == want["revocation"]
    if "supersedes" in want:
        o = _verify(_BY_ID[want["supersedes"]])
        assert o.ok
        win = newer_revocation(r.revocation, o.revocation)
        assert win is newer_revocation(o.revocation, r.revocation)
        assert win.record == _BY_ID[want["winner"]]["entry"]["record"]


def _payload(jws: str) -> str:
    return b64url_decode(jws.split(".")[1]).decode("utf-8")


# ── contentRows (plans/P4-13.md §2.6) ───────────────────────────────────────────────────────


@pytest.mark.parametrize("row", _ROWS, ids=[r["name"] for r in _ROWS])
def test_content_row(row: Dict[str, Any]) -> None:
    decision = decide_update(UpdateDecisionInput.from_dict(row["input"]))
    assert decision.to_dict() == row["expect"]["decision"]
    assert boot_decision(decision) == row["expect"]["boot"]
    if "packSetId" in row["expect"]:
        assert decision.action == UpdateAction.PACKS
        entries = [{"packId": x["pack"], "releaseSha256": x["sha256"]} for x in decision.set or ()]
        assert pack_set_id(entries) == row["expect"]["packSetId"]


def test_required_exactly_on_the_revoked_content_rows() -> None:
    # Decision 4: a revocation of REQUIRED content is the only thing that stops play.
    for row in _ROWS:
        d = row["expect"]["decision"]
        revoked = (
            d.get("reason") == UpdateBlockedReason.REVOKED_CONTENT
            or d.get("contentBlock") == UpdateBlockedReason.REVOKED_CONTENT
        )
        assert (row["expect"]["boot"] == "required") == revoked, row["name"]


def test_every_row_feed_has_usable_floors() -> None:
    for row in _ROWS:
        assert feed_content(ChannelFeedDoc.from_dict(row["input"]["feed"])).packFloors is not None


def test_no_content_input_is_p3_01() -> None:
    # Without `content` every answer is P3-01's: the content members alone change nothing.
    for row in _ROWS:
        inp = dict(row["input"])
        del inp["content"]
        d = decide_update(UpdateDecisionInput.from_dict(inp))
        assert d.action != UpdateAction.PACKS
        assert d.contentBlock is None
