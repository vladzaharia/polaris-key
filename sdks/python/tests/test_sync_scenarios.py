# @pkey-feature sync.scenarios
# @pkey-feature sync.settings
"""``sync-scenarios.json`` (v3): the Cloud Sync client state machine and the setting routes.

Mirrors ``conformance/runners/node/syncScenarios.test.ts``. ``settingCases`` runs in full. While
``sync.scenarios`` is ``planned`` (D-12), the scenario replays run an allow-list, ``PORTED``, and skip the
rest by name with a reason; the flip to ``implemented`` deletes the list.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.cloud_sync.machine import CloudSyncMachine, relaunch
from polaris_key.cloud_sync.routes import synced_settings, user_setting_issues
from polaris_key.constants_generated import (
    SYNC_DEBOUNCE_MS,
    SYNC_MAX_CLOCK_SKEW_MS,
    SYNC_MAX_MUTATIONS,
    SYNC_MAX_VALUE_BYTES,
    SYNC_PENDING_DAYS,
    SYNC_SCENARIOS_VERSION,
    SYNC_SIGNOUT_FLUSH_MS,
)

_CORPUS: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "sync-scenarios.json").read_text()
)
_SCENARIOS: List[Dict[str, Any]] = _CORPUS["scenarios"]
_SETTING_CASES: List[Dict[str, Any]] = _CORPUS["settingCases"]

# Scenarios the Python machine port replays (D-12). Every corpus scenario is listed; the flip of
# `sync.scenarios` to implemented deletes this list and the skip.
PORTED = frozenset(
    (
        "optimistic-read-pending",
        "max-policy-optimistic",
        "debounce-slider",
        "clock-offset-folded",
        "clock-slow-precontact-restamp",
        "clock-fast-precontact-restamp",
        "lww-conflict-server-wins",
        "conflict-then-ok-one-push",
        "request-failure-keeps-journal",
        "conflict-rebase-new-mutation",
        "one-outstanding-cas",
        "account-switch-partition",
        "first-sign-in-empty-cloud",
        "first-sign-in-newer-and-older-cloud",
        "sign-out-local-edit-sign-in-other",
        "account-required-on-push",
        "relink-clears-binding",
        "key-activated-device-local-only",
        "merge-alias-subject-change",
        "unauthorized-pauses",
        "sign-out-flush-succeeds",
        "sign-out-flush-timeout",
        "sign-out-discard-unsynced",
        "pending-expire-after-30-days",
        "on-sign-out-keep",
        "journal-loss-new-client-id",
        "client-mismatch-regenerates",
        "cursor-expired-with-pending",
        "member-merge",
        "union-add-remove",
        "renamed-and-dropped-keys",
        "locked-key-refused",
        "invalid-stored-value",
        "rejected-result-reverts",
        "relaunch-commits-and-pushes",
        "open-setting-synced",
        "open-setting-too-large",
        "local-key-stays-local",
        "secret-key-refused",
        "platform-scope-target",
        "config-local-import-loses-to-cloud",
        "record-max-field-conflict",
        "attestation-required-blocks",
        "other-403-blocks",
        "writes-paused-keeps-journal",
        "quota-rejected-keeps-value",
        "quota-raised-retries",
        "quota-lowered-deletes-nothing",
        "terminal-rejection-reverts",
        "e2e-max-conflict-remerged",
        "e2e-min-server-wins",
        "e2e-merge-member-cells",
        "e2e-locked-keeps-journal",
        "e2e-unlock-pushes",
        "e2e-downgrade-refused",
        "e2e-legacy-plain-below-since",
        "server-mode-unchanged",
        "e2e-forged-plain-change-at-or-below-cursor",
        "e2e-forged-plain-needs-cursor-below-since",
        "e2e-forged-plain-sealed-key-latched",
        "e2e-conflict-plaintext-copy-refused",
    )
)
_SKIP = "not on the PORTED allow-list"


def test_corpus_constants() -> None:
    assert _CORPUS["syncScenariosVersion"] == SYNC_SCENARIOS_VERSION == 4
    assert _CORPUS["constants"] == {
        "debounceMs": SYNC_DEBOUNCE_MS,
        "signOutFlushMs": SYNC_SIGNOUT_FLUSH_MS,
        "pendingDays": SYNC_PENDING_DAYS,
        "maxMutationsPerPush": SYNC_MAX_MUTATIONS,
        "maxClockSkewMs": SYNC_MAX_CLOCK_SKEW_MS,
        "maxValueBytes": SYNC_MAX_VALUE_BYTES,
    }


def test_ported_names_exist() -> None:
    assert PORTED == {s["name"] for s in _SCENARIOS}


def _call(m: CloudSyncMachine, name: str, args: List[Any]) -> Dict[str, Any]:
    if name == "set":
        return m.set(args[0], args[1])
    if name == "clear":
        return m.clear(args[0])
    if name == "put":
        return m.put(args[0], args[1], args[2])
    if name == "add":
        return m.add(args[0], args[1], args[2])
    if name == "remove":
        return m.remove(args[0], args[1], args[2])
    if name == "flush":
        return m.flush()
    if name == "refresh":
        return m.refresh()
    raise AssertionError(f"unknown call {name}")


@pytest.mark.parametrize("sc", _SCENARIOS, ids=[s["name"] for s in _SCENARIOS])
def test_scenario(sc: Dict[str, Any]) -> None:
    if sc["name"] not in PORTED:
        pytest.skip(f"{sc['name']}: {_SKIP}")
    init = sc["init"]
    ids = list(init["clientIds"])

    def new_client_id() -> str:
        assert ids, "init.clientIds exhausted"
        return ids.pop(0)

    opts: Dict[str, Any] = {
        "product": _CORPUS["product"],
        "catalog": init["catalog"],
        "document": init["document"],
        "now": init["clock"]["now"],
        "offsetMs": init["clock"]["offsetMs"],
        "contacted": init["clock"]["contacted"],
        "subject": init["subject"],
        "network": init["network"],
        "onSignOut": init["options"]["onSignOut"],
        "encryption": init["encryption"],
        "hasRoot": init["hasRoot"],
        "newClientId": new_client_id,
    }
    licence = json.loads(json.dumps(init["licence"]))
    m = CloudSyncMachine(opts)
    if init["legacyLocal"] is not None:
        assert m.import_local(init["legacyLocal"]) == {"ok": True}, f"{sc['name']}: import"
    for i, step in enumerate(sc["steps"]):
        kind, raw = next(iter(step.items()))
        where = f"{sc['name']}, step {i + 1} ({kind})"
        if kind == "local":
            result = _call(m, raw["call"], raw.get("args") or [])
            if "expect" in raw:
                assert result == raw["expect"], where
        elif kind == "advance":
            m.advance(raw["ms"])
        elif kind == "network":
            m.set_network(raw["state"])
        elif kind == "respond":
            res = {"status": raw["status"], "body": raw["body"]} if "opened" in raw else raw
            m.receive(res, raw.get("opened"))
        elif kind == "root":
            m.set_root(raw.get("has") is True)
        elif kind == "signIn":
            m.sign_in(raw["subject"])
        elif kind == "signOut":
            m.sign_out(raw.get("discardUnsynced") is True)
        elif kind == "relaunch":
            m = relaunch(m, opts, "lost" if raw.get("journal") == "lost" else "kept")
        elif kind == "assert":
            requests = m.take_requests()
            events = m.take_events()
            if "requests" in raw:
                assert requests == raw["requests"], f"{where}: requests"
            if "events" in raw:
                assert events == raw["events"], f"{where}: events"
            for key, want in (raw.get("values") or {}).items():
                assert m.get(key) == want, f"{where}: values.{key}"
            for key, want in (raw.get("states") or {}).items():
                assert m.setting_state(key) == want, f"{where}: states.{key}"
            for key, want in (raw.get("records") or {}).items():
                collection, _, record_id = key.partition("/")
                assert m.record(collection, record_id) == want, f"{where}: records.{key}"
            if "journal" in raw:
                assert m.journal() == raw["journal"], f"{where}: journal"
            if "status" in raw:
                assert m.status() == raw["status"], f"{where}: status"
            if "encryptionSince" in raw:
                assert m.encryption_since() == raw["encryptionSince"], f"{where}: encryptionSince"
            if "licence" in raw:
                assert licence == raw["licence"], f"{where}: licence"
        else:
            raise AssertionError(f"{where}: unknown step")


@pytest.mark.parametrize("case", _SETTING_CASES, ids=[c["name"] for c in _SETTING_CASES])
def test_setting_cases(case: Dict[str, Any]) -> None:
    issues = [
        {"key": e["key"], "code": i["code"], "severity": i["severity"]}
        for e in case["entries"]
        for i in user_setting_issues(e)
    ]
    assert issues == case["issues"], f"{case['name']}: issues"
    if case["routes"] is None:
        assert any(i["severity"] == "error" for i in issues)
        return
    routes = synced_settings({"entries": case["entries"]})
    assert routes == case["routes"], f"{case['name']}: routes"
    for key in case["open"]:
        assert not any(r["key"] == key for r in routes), f"{case['name']}: {key} is open"
