# @pkey-feature identity.account identity.attach
"""The account verbs (I-10a.14): ``subject()``, ``sign_out()``, ``open_account()`` and
``attach()``, over a mock Worker whose discovery names the Identity fragment's endpoints.

The same semantics as Node's ``identityAccount.test.ts`` and Swift's ``IdentityAccountTests``:
the pre-sign-out hooks run first, ``released`` decides whether the token goes, a missing endpoint
is the typed unsupported result before any request, a refusal of ``attach`` is a typed result
that keeps every piece of state, and the subject persists across a restart."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.core.caps import UnsupportedError
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity.account import (
    AttachConfirm,
    AttachOk,
    AttachRefused,
    identity_fragment_from,
)

from helpers import BASE_URL, PRODUCT, TOKEN, make_client

SUBJECT = "ps_" + "A" * 22
OTHER = "ps_" + "B" * 22
BASE = f"{BASE_URL}/{PRODUCT}"
ENDPOINTS = {
    "subject": f"{BASE}/identity/subject",
    "signout": f"{BASE}/identity/signout",
    "attach": f"{BASE}/identity/attach",
    "accountPortal": f"{BASE_URL}/#/p/{PRODUCT}",
}


def discovery(endpoints: Optional[Dict[str, str]] = None, identity: bool = True) -> Dict[str, Any]:
    ident: Dict[str, Any] = (
        {"enabled": True, "configured": True, "account": True, "endpoints": endpoints if endpoints is not None else ENDPOINTS}
        if identity
        else {"enabled": False}
    )
    return {
        "product": PRODUCT,
        "services": {"license": {"enabled": True}, "config": {"enabled": True}, "identity": ident},
    }


class Worker:
    """A mock Worker: discovery plus the three account routes, each answered from ``answers``."""

    def __init__(self, doc: Dict[str, Any], **answers: Any) -> None:
        self.doc = doc
        self.answers = answers
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, r: httpx.Request) -> httpx.Response:
        path = r.url.path
        self.calls.append(
            {
                "method": r.method,
                "path": path,
                "auth": r.headers.get("authorization"),
                "body": json.loads(r.content) if r.content else None,
            }
        )
        if path == f"/{PRODUCT}/.well-known/polaris.json":
            return httpx.Response(200, json=self.doc)
        name = path.rsplit("/", 1)[-1]
        a = self.answers.get(name)
        if a is None:
            return httpx.Response(404, json={"error": {"code": "not_found"}})
        return a(r) if callable(a) else a

    def account_calls(self) -> List[str]:
        return [c["path"].rsplit("/", 1)[-1] for c in self.calls if "/identity/" in c["path"]]


def client(worker: Worker, token: Optional[str] = TOKEN, **kw: Any) -> Any:
    store = InMemoryStore(PRODUCT)
    if token is not None:
        store.set_token(token)
    return make_client(worker, store=store, expected_services=["license", "config", "identity"], **kw)


def _subject_file(c: Any) -> Path:
    return Path(c.core.dirs.state) / "subject.json"


def ok(**body: Any) -> httpx.Response:
    return httpx.Response(200, json=body)


# ── Discovery fragment ───────────────────────────────────────────────────────────────


def test_the_identity_fragment_keeps_only_well_formed_members() -> None:
    f = identity_fragment_from(
        {
            "services": {
                "identity": {
                    "enabled": True,
                    "account": True,
                    "keyEntryLimit": 5,
                    "issuer": "https://x/identity",
                    "endpoints": {"subject": "https://x/s", "signout": "", "attach": 3},
                }
            }
        }
    )
    assert f == {
        "enabled": True,
        "configured": True,
        "account": True,
        "keyEntryLimit": 5,
        "issuer": "https://x/identity",
        "endpoints": {"subject": "https://x/s"},
    }


@pytest.mark.parametrize(
    "doc",
    [None, {}, {"services": {"identity": {"enabled": False}}}, {"services": {"identity": {"enabled": "true"}}}],
)
def test_no_fragment_while_identity_is_off_or_absent(doc: Any) -> None:
    assert identity_fragment_from(doc) is None


# ── subject() ────────────────────────────────────────────────────────────────────────


def test_subject_reads_and_persists_it_across_a_restart(tmp_path: Any) -> None:
    w = Worker(discovery(), subject=ok(subject=SUBJECT))
    c = client(w, state_dir=str(tmp_path))
    assert c.identity.subject() == SUBJECT
    assert w.calls[-1]["auth"] == f"Bearer {TOKEN}" and w.calls[-1]["method"] == "GET"
    assert json.loads(_subject_file(c).read_text()) == {"subject": SUBJECT}
    c.close()
    # A new client over the same state directory reads the stored subject without a request.
    again = client(Worker(discovery()), state_dir=str(tmp_path))
    assert again.identity._account.stored_subject() == SUBJECT
    again.close()


def test_a_key_only_device_has_a_null_subject_and_it_is_forgotten(tmp_path: Any) -> None:
    answers = [ok(subject=SUBJECT), ok(subject=None)]
    w = Worker(discovery(), subject=lambda r: answers.pop(0))
    c = client(w, state_dir=str(tmp_path))
    assert c.identity.subject() == SUBJECT
    assert c.identity.subject() is None
    assert not _subject_file(c).exists()
    c.close()


def test_subject_without_a_token_is_null_and_dials_nothing_more() -> None:
    w = Worker(discovery(), subject=ok(subject=SUBJECT))
    c = client(w, token=None)
    assert c.identity.subject() is None
    assert w.account_calls() == []


def test_a_malformed_subject_is_a_bad_response() -> None:
    c = client(Worker(discovery(), subject=ok(subject="not-a-subject")))
    with pytest.raises(PolarisError) as e:
        c.identity.subject()
    assert e.value.code == "bad_response"


def test_a_refused_subject_raises_the_wire_code() -> None:
    c = client(Worker(discovery(), subject=httpx.Response(401, json={"error": {"code": "unauthorized"}})))
    with pytest.raises(PolarisError) as e:
        c.identity.subject()
    assert e.value.code == "unauthorized"


# ── Unavailable ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.identity.subject(),
        lambda c: c.identity.sign_out(),
        lambda c: c.identity.open_account(),
        lambda c: c.identity.attach(True),
    ],
    ids=["subject", "sign_out", "open_account", "attach"],
)
def test_a_missing_endpoint_is_the_typed_unsupported_result_before_any_request(call: Callable[[Any], Any]) -> None:
    w = Worker(discovery(endpoints={}))
    c = client(w)
    with pytest.raises(UnsupportedError) as e:
        call(c)
    assert e.value.reason == "product" and e.value.feature == "identity.account"
    assert e.value.code == "service-unavailable"
    assert w.account_calls() == []


def test_identity_off_is_service_unavailable_before_any_request() -> None:
    w = Worker(discovery(identity=False))
    store = InMemoryStore(PRODUCT)
    store.set_token(TOKEN)
    c = make_client(w, store=store)
    with pytest.raises(PolarisError) as e:
        c.identity.sign_out()
    assert e.value.code == "service-unavailable"
    assert w.account_calls() == []


def test_an_endpoint_outside_this_product_is_refused_without_the_token() -> None:
    other = dict(ENDPOINTS, subject="https://evil.example/djdl/identity/subject")
    w = Worker(discovery(endpoints=other), subject=ok(subject=SUBJECT))
    c = client(w)
    with pytest.raises(PolarisError) as e:
        c.identity.subject()
    assert e.value.code == "bad_response"
    assert w.account_calls() == []


# ── sign_out() ───────────────────────────────────────────────────────────────────────


def test_sign_out_runs_the_hooks_first_then_released_true_drops_the_token(tmp_path: Any) -> None:
    order: List[str] = []

    def signout(r: httpx.Request) -> httpx.Response:
        order.append("POST signout")
        return ok(released=True)

    w = Worker(discovery(), subject=ok(subject=SUBJECT), signout=signout)
    c = client(w, state_dir=str(tmp_path))
    c.identity.subject()
    c.identity.on_before_sign_out(lambda: order.append("flush"))
    result = c.identity.sign_out()
    assert result.released is True
    assert order == ["flush", "POST signout"]
    assert c._tokens.current is None
    assert not _subject_file(c).exists()
    assert c.identity.current() is None
    c.close()


def test_released_false_keeps_the_token_and_forgets_the_subject(tmp_path: Any) -> None:
    w = Worker(discovery(), subject=ok(subject=SUBJECT), signout=ok(released=False))
    c = client(w, state_dir=str(tmp_path))
    c.identity.subject()
    assert c.identity.sign_out().released is False
    assert c._tokens.current == TOKEN
    assert not _subject_file(c).exists()
    assert w.calls[-1]["method"] == "POST" and w.calls[-1]["auth"] == f"Bearer {TOKEN}"
    c.close()


def test_a_hook_that_raises_stops_the_sign_out() -> None:
    w = Worker(discovery(), signout=ok(released=True))
    c = client(w)

    def boom() -> None:
        raise RuntimeError("flush failed")

    c.identity.on_before_sign_out(boom)
    with pytest.raises(RuntimeError):
        c.identity.sign_out()
    assert w.account_calls() == [] and c._tokens.current == TOKEN


def test_a_removed_hook_does_not_run() -> None:
    ran: List[str] = []
    w = Worker(discovery(), signout=ok(released=False))
    c = client(w)
    remove = c.identity.on_before_sign_out(lambda: ran.append("x"))
    remove()
    c.identity.sign_out()
    assert ran == []


def test_a_refused_sign_out_changes_nothing(tmp_path: Any) -> None:
    w = Worker(discovery(), subject=ok(subject=SUBJECT), signout=httpx.Response(401, json={"error": {"code": "unauthorized"}}))
    c = client(w, state_dir=str(tmp_path))
    c.identity.subject()
    with pytest.raises(PolarisError) as e:
        c.identity.sign_out()
    assert e.value.code == "unauthorized"
    assert c._tokens.current == TOKEN
    assert c.identity._account.stored_subject() == SUBJECT  # nothing was forgotten


def test_an_unnamed_refusal_is_sign_out_failed() -> None:
    w = Worker(discovery(), signout=httpx.Response(418, text="teapot"))
    c = client(w)
    with pytest.raises(PolarisError) as e:
        c.identity.sign_out()
    assert e.value.code == "sign-out-failed" and c._tokens.current == TOKEN


def test_sign_out_without_released_is_a_bad_response() -> None:
    c = client(Worker(discovery(), signout=ok()))
    with pytest.raises(PolarisError) as e:
        c.identity.sign_out()
    assert e.value.code == "bad_response" and c._tokens.current == TOKEN


def test_sign_out_with_no_token_forgets_without_a_request() -> None:
    w = Worker(discovery(), signout=ok(released=True))
    c = client(w, token=None)
    assert c.identity.sign_out().released is False
    assert w.account_calls() == []


# ── open_account() ───────────────────────────────────────────────────────────────────


def test_open_account_hands_the_portal_url_to_the_opener() -> None:
    opened: List[str] = []
    c = client(Worker(discovery()))
    c.identity._account._open_url = lambda u: opened.append(u) or True  # type: ignore[assignment]
    r = c.identity.open_account()
    assert (r.url, r.opened) == (ENDPOINTS["accountPortal"], True)
    assert opened == [ENDPOINTS["accountPortal"]]


def test_open_account_reports_an_opener_that_could_not() -> None:
    c = client(Worker(discovery()))
    c.identity._account._open_url = lambda u: False  # type: ignore[assignment]
    assert c.identity.open_account().opened is False


def test_an_unusable_portal_link_is_unavailable() -> None:
    c = client(Worker(discovery(endpoints=dict(ENDPOINTS, accountPortal="javascript:alert(1)"))))
    with pytest.raises(UnsupportedError):
        c.identity.open_account()


# ── attach() ─────────────────────────────────────────────────────────────────────────

NEW_TOKEN = "pkeyt_" + "n" * 43


def test_attach_preview_writes_nothing() -> None:
    w = Worker(discovery(), attach=ok(status="confirm", license={"id": "lic_1", "tierId": None, "name": "Ada"}))
    c = client(w)
    r = c.identity.attach(confirm=False)
    assert isinstance(r, AttachConfirm) and (r.license.id, r.license.tierId, r.license.name) == ("lic_1", None, "Ada")
    assert w.calls[-1]["body"] == {"confirm": False}
    assert c._tokens.current == TOKEN


def test_attach_confirm_rotates_the_token_and_stores_the_subject(tmp_path: Any) -> None:
    w = Worker(discovery(), attach=ok(token=NEW_TOKEN, schemaVersion=1, subject=SUBJECT, attached="claimed"))
    c = client(w, state_dir=str(tmp_path))
    r = c.identity.attach(confirm=True)
    assert isinstance(r, AttachOk) and (r.subject, r.attached) == (SUBJECT, "claimed")
    assert w.calls[-1]["body"] == {"confirm": True} and w.calls[-1]["auth"] == f"Bearer {TOKEN}"
    assert c._tokens.current == NEW_TOKEN
    assert json.loads(_subject_file(c).read_text()) == {"subject": SUBJECT}
    c.close()


def test_a_repeated_attach_has_no_attached() -> None:
    c = client(Worker(discovery(), attach=ok(token=NEW_TOKEN, subject=SUBJECT)))
    r = c.identity.attach(confirm=True)
    assert isinstance(r, AttachOk) and r.attached is None


@pytest.mark.parametrize(
    "status,code",
    [(403, "account_required"), (403, "license_owned"), (403, "license_email_bound"), (401, "unauthorized"), (404, "not_found")],
)
def test_a_refusal_is_a_typed_result_that_keeps_every_piece_of_state(status: int, code: str, tmp_path: Any) -> None:
    w = Worker(discovery(), subject=ok(subject=OTHER), attach=httpx.Response(status, json={"error": {"code": code}}))
    c = client(w, state_dir=str(tmp_path))
    c.identity.subject()
    r = c.identity.attach(confirm=True)
    assert isinstance(r, AttachRefused) and (r.code, r.status) == (code, status)
    assert c._tokens.current == TOKEN
    assert c.identity._account.stored_subject() == OTHER
    c.close()


def test_attach_without_a_token_raises_no_token() -> None:
    c = client(Worker(discovery(), attach=ok(token=NEW_TOKEN)), token=None)
    with pytest.raises(PolarisError) as e:
        c.identity.attach(confirm=True)
    assert e.value.code == "no-token"


def test_attach_without_a_token_in_the_answer_is_a_bad_response() -> None:
    c = client(Worker(discovery(), attach=ok(subject=SUBJECT)))
    with pytest.raises(PolarisError) as e:
        c.identity.attach(confirm=True)
    assert e.value.code == "bad_response" and c._tokens.current == TOKEN
