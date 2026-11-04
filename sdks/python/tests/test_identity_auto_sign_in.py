# @pkey-feature identity.autosignin
"""``identity.auto_sign_in()`` and ``identity.nearby.available()`` (I-47.3).

Rung 1 counts only a token that came from a sign-in (a device-code sign-in, a redirect, the licence choice,
an attach), together with a licence; a key activation, an enrolment or a device an account sign-out left
activated is not one. ``sign_out()`` sets the explicit-sign-out flag once the Worker accepted it, the next
sign-in the person starts clears it, and it survives a restart and fails closed. Python has no platform
identity, so the answers are ``signed_in``, ``needs_sign_in`` (``signed_out`` or ``no_credential``) and
``unavailable``. The same semantics as Swift's ``AutoSignInTests`` and Kotlin's ``AutoSignInTest``."""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, Optional

import httpx
import pytest
from helpers import PRODUCT, TOKEN, make_client
from test_identity_account import BASE, ENDPOINTS, NEW_TOKEN, SUBJECT, Worker, discovery, ok
from test_identity_session import READY, START, make, queue

from polaris_key import AsyncClient, PolarisError
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity import (
    AutoSignInNeedsSignIn,
    AutoSignInSignedIn,
    AutoSignInUnavailable,
)

LICENSE_ID = "lic_auto_1"


def _licensed(c: Any, licence: Optional[str] = LICENSE_ID) -> Any:
    """The licence the facade holds (a signed-in device syncs one; the document is not the subject here)."""
    c.license.get_license_id = lambda: licence
    return c


def _state(c: Any, name: str) -> str:
    return os.path.join(c.core.dirs.state, name)


def _signed_in_worker(**extra: Any) -> Worker:
    return Worker(
        discovery(),
        start=ok(**START),
        poll=queue(READY),
        subject=ok(subject=SUBJECT),
        signout=ok(released=False),
        **extra,
    )


def nearby_discovery(**fragment: Any) -> Dict[str, Any]:
    doc = discovery()
    ident = doc["services"]["identity"]
    ident["nearby"] = True
    ident["endpoints"] = {
        **ENDPOINTS,
        "nearbyStart": f"{BASE}/identity/nearby/start",
        "nearbyApprove": f"{BASE}/identity/nearby/approve",
        "nearbyPoll": f"{BASE}/identity/nearby/poll",
    }
    ident.update(fragment)
    return doc


# ── The ladder ───────────────────────────────────────────────────────────────────────


def test_a_fresh_device_needs_a_sign_in_with_no_credential() -> None:
    c = make(Worker(discovery()))
    r = c.identity.auto_sign_in()
    assert isinstance(r, AutoSignInNeedsSignIn)
    assert (r.kind, r.reason, r.link_handle) == ("needs_sign_in", "no_credential", None)


def test_identity_off_is_unavailable() -> None:
    c = make(Worker(discovery(identity=False)))
    r = c.identity.auto_sign_in()
    assert isinstance(r, AutoSignInUnavailable)
    assert (r.kind, r.code) == ("unavailable", "service-unavailable")


def test_an_unreachable_worker_says_nothing_about_identity() -> None:
    def down(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    c = make_client(down, expected_services=["license", "config", "identity"])
    assert c.identity.auto_sign_in().reason == "no_credential"


def test_a_device_code_sign_in_is_rung_1(clock, tmp_path: Any) -> None:
    c = _licensed(make(_signed_in_worker(), state_dir=str(tmp_path)))
    assert c.identity.sign_in.start().wait().kind == "signed_in"
    r = c.identity.auto_sign_in()
    assert isinstance(r, AutoSignInSignedIn)
    assert (r.kind, r.subject, r.license_id) == ("signed_in", SUBJECT, LICENSE_ID)
    # Nothing in the answer carries the token.
    assert "pkeyt_" not in repr(r)


def test_a_signed_in_device_without_a_licence_is_not_rung_1(clock, tmp_path: Any) -> None:
    c = _licensed(make(_signed_in_worker(), state_dir=str(tmp_path)), licence=None)
    c.identity.sign_in.start().wait()
    assert c.identity.auto_sign_in().reason == "no_credential"


def test_a_token_of_unknown_provenance_is_not_a_sign_in() -> None:
    # The store holds a token this process never saw obtained: could be a key activation.
    c = _licensed(make(Worker(discovery()), token=TOKEN))
    assert c.identity.auto_sign_in().reason == "no_credential"


@pytest.mark.parametrize("source", ["activate", "enroll", "register"])
def test_a_key_enrolment_or_registration_is_not_a_sign_in(source: str) -> None:
    c = _licensed(make(Worker(discovery())))
    c._tokens.set("pkeyt_other", source)
    assert c._tokens.provenance == ("key" if source == "activate" else "register")
    assert c.identity.auto_sign_in().reason == "no_credential"


def test_a_reacquire_leaves_the_provenance_alone(clock, tmp_path: Any) -> None:
    c = _licensed(make(_signed_in_worker(), state_dir=str(tmp_path)))
    c.identity.sign_in.start().wait()
    c._tokens.set("pkeyt_rotated", "reacquire")
    assert c._tokens.provenance == "signin"
    assert c.identity.auto_sign_in().kind == "signed_in"


def test_an_attach_makes_the_token_a_sign_in() -> None:
    w = Worker(
        discovery(), attach=ok(token=NEW_TOKEN, subject=SUBJECT, attached="claimed"), subject=ok(subject=SUBJECT)
    )
    c = _licensed(make(w, token=TOKEN))
    assert c.identity.auto_sign_in().reason == "no_credential"
    c.identity.attach(confirm=True)
    assert c._tokens.provenance == "signin"
    assert c.identity.auto_sign_in().kind == "signed_in"


def test_the_provenance_survives_a_restart_and_goes_with_the_token(clock, tmp_path: Any) -> None:
    store = InMemoryStore(PRODUCT)
    w = _signed_in_worker()
    c = make_client(w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path))
    c.identity.sign_in.start().wait()
    c.close()
    again = _licensed(
        make_client(w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path))
    )
    assert again.identity.auto_sign_in().kind == "signed_in"
    again._tokens.clear()
    assert again._tokens.provenance is None
    again.close()


def test_the_unconfirmed_provenance_is_written_before_the_token(tmp_path: Any) -> None:
    store = InMemoryStore(PRODUCT)
    c = _licensed(
        make_client(
            Worker(discovery()),
            store=store,
            expected_services=["license", "config", "identity"],
            state_dir=str(tmp_path),
        )
    )
    seen = []
    set_token = store.set_token
    store.set_token = lambda t: (seen.append(c._tokens.provenance), set_token(t))[1]  # type: ignore[method-assign]
    c._tokens.set("pkeyt_nearby", "signin", provenance="unconfirmed")
    assert seen == ["unconfirmed"]
    # Not a sign-in until confirmed; the explicit sign-out is left as it was; a re-acquire keeps the mark.
    assert c._tokens.unconfirmed and c.identity.auto_sign_in().reason == "no_credential"
    c._tokens.set_explicit_sign_out(True)
    c._tokens.set("pkeyt_rotated", "reacquire")
    assert c._tokens.provenance == "unconfirmed" and c._tokens.explicit_sign_out is True
    c._tokens.confirm_sign_in()
    assert (c._tokens.provenance, c._tokens.explicit_sign_out, c._tokens.unconfirmed) == ("signin", False, False)
    c.close()


def test_a_failed_store_write_keeps_the_unconfirmed_mark_over_the_old_token(tmp_path: Any) -> None:
    store = InMemoryStore(PRODUCT)
    c = make_client(
        Worker(discovery()), store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path)
    )
    c._tokens.set("pkeyt_nearby", "signin", provenance="unconfirmed")

    def boom(_t: str) -> None:
        raise OSError("write failed")

    store.set_token = boom  # type: ignore[method-assign]
    with pytest.raises(OSError):
        c._tokens.set("pkeyt_other", "register")
    assert c._tokens.provenance == "unconfirmed"
    c.close()


def test_an_unconfirmed_token_is_dropped_at_load_and_rung_1_needs_sign_in(tmp_path: Any) -> None:
    store = InMemoryStore(PRODUCT)
    w = Worker(discovery())
    c = make_client(w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path))
    c._tokens.set("pkeyt_nearby", "signin", provenance="unconfirmed")
    c._tokens.set_explicit_sign_out(True)
    c.close()
    # A restart finds the mark: the token goes before anything reads it, and the sign-out reason stays.
    again = _licensed(
        make_client(w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path))
    )
    assert again._tokens.current is None and store.get_token() is None
    assert again._tokens.provenance is None and again._tokens.explicit_sign_out is True
    assert again.identity.auto_sign_in().reason == "signed_out"
    assert not [x for x in w.calls if x["method"] == "POST"]  # the drop was local: the Worker was not told
    again.close()


# ── The explicit sign-out flag ───────────────────────────────────────────────────────


def test_sign_out_sets_the_flag_and_rung_1_stops_counting(clock, tmp_path: Any) -> None:
    c = _licensed(make(_signed_in_worker(), state_dir=str(tmp_path)))
    c.identity.sign_in.start().wait()
    assert c.identity.sign_out().released is False  # a key-only device keeps its token
    assert c._tokens.current is not None
    assert c._tokens.provenance == "key"
    r = c.identity.auto_sign_in()
    assert (r.kind, r.reason) == ("needs_sign_in", "signed_out")


def test_a_released_sign_out_is_signed_out_and_clears_the_token(clock, tmp_path: Any) -> None:
    w = Worker(
        discovery(), start=ok(**START), poll=queue(READY), subject=ok(subject=SUBJECT), signout=ok(released=True)
    )
    c = _licensed(make(w, state_dir=str(tmp_path)))
    c.identity.sign_in.start().wait()
    c.identity.sign_out()
    assert c._tokens.current is None and c._tokens.provenance is None
    assert c.identity.auto_sign_in().reason == "signed_out"


def test_the_flag_survives_a_restart_and_a_sign_in_clears_it(clock, tmp_path: Any) -> None:
    store = InMemoryStore(PRODUCT)
    opts: Dict[str, Any] = dict(
        store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path)
    )
    w = _signed_in_worker()
    c = make_client(w, **opts)
    c.identity.sign_in.start().wait()
    c.identity.sign_out()
    c.close()
    again = _licensed(make_client(w, **opts))
    assert again.identity.auto_sign_in().reason == "signed_out"
    assert again._tokens.explicit_sign_out is True
    # The next sign-in the person starts ends it.
    w.answers["poll"] = queue(READY)
    again.identity.sign_in.start().wait()
    assert again._tokens.explicit_sign_out is False
    assert again.identity.auto_sign_in().kind == "signed_in"
    assert not os.path.exists(_state(again, "explicit-sign-out"))
    again.close()


def test_deactivate_sets_the_flag_and_a_restart_does_not_sign_in(clock, tmp_path: Any) -> None:
    store = InMemoryStore(PRODUCT)
    opts: Dict[str, Any] = dict(
        store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path)
    )
    w = _signed_in_worker()
    c = _licensed(make_client(w, **opts))
    c.identity.sign_in.start().wait()
    c.deactivate()
    assert c._tokens.explicit_sign_out is True
    c.close()
    again = _licensed(make_client(w, **opts))
    r = again.identity.auto_sign_in()
    assert (r.kind, r.reason) == ("needs_sign_in", "signed_out")
    # The person's next sign-in ends it.
    w.answers["poll"] = queue(READY)
    again.identity.sign_in.start().wait()
    assert again._tokens.explicit_sign_out is False
    again.close()


def test_a_sign_out_with_no_token_still_sets_the_flag() -> None:
    c = make(Worker(discovery()))
    c.identity.sign_out()
    assert c.identity.auto_sign_in().reason == "signed_out"


def test_a_refused_sign_out_does_not_set_the_flag(clock, tmp_path: Any) -> None:
    w = Worker(
        discovery(),
        start=ok(**START),
        poll=queue(READY),
        subject=ok(subject=SUBJECT),
        signout=httpx.Response(401, json={"error": {"code": "unauthorized"}}),
    )
    c = _licensed(make(w, state_dir=str(tmp_path)))
    c.identity.sign_in.start().wait()
    with pytest.raises(PolarisError):
        c.identity.sign_out()
    assert c._tokens.explicit_sign_out is False
    assert c.identity.auto_sign_in().kind == "signed_in"


def test_a_flag_that_cannot_be_read_is_signed_out(tmp_path: Any) -> None:
    c = make(Worker(discovery()), state_dir=str(tmp_path))
    # A directory where the flag file belongs: it exists and cannot be read.
    os.makedirs(_state(c, "explicit-sign-out"))
    assert c._tokens.explicit_sign_out is True
    assert c.identity.auto_sign_in().reason == "signed_out"


def test_a_failed_flag_write_never_stops_the_sign_out(tmp_path: Any) -> None:
    w = Worker(discovery(), signout=ok(released=False))
    c = make(w, token=TOKEN, state_dir=str(tmp_path))
    # A directory where the flag file belongs: the write fails.
    os.makedirs(_state(c, "explicit-sign-out"))
    assert c.identity.sign_out().released is False
    assert c._tokens.explicit_sign_out is True  # still set for this process


def test_the_state_files_hold_no_secret(clock, tmp_path: Any) -> None:
    c = make(_signed_in_worker(), state_dir=str(tmp_path))
    c.identity.sign_in.start().wait()
    c.identity.sign_out()
    for name, value in (("token-provenance", "key"), ("explicit-sign-out", "1")):
        with open(_state(c, name)) as f:
            assert f.read() == value


# ── identity.nearby.available() ──────────────────────────────────────────────────────


def _nearby(doc: Dict[str, Any], supported: Any = lambda role: True) -> Any:
    c = make(Worker(doc))
    c.identity.nearby._runtime_supported = supported
    return c


def test_available_needs_discovery_the_roles_endpoints_and_the_runtime() -> None:
    c = _nearby(nearby_discovery())
    assert c.identity.nearby.available(role="requester") is True
    assert c.identity.nearby.available(role="approver") is True


def test_available_is_false_when_the_runtime_cannot_take_part() -> None:
    assert (
        _nearby(nearby_discovery(), supported=lambda role: role == "approver").identity.nearby.available(
            role="requester"
        )
        is False
    )
    # With no runtime wired the answer is false, never an error.
    assert _nearby(nearby_discovery(), supported=None).identity.nearby.available(role="approver") is False

    def boom(role: str) -> bool:
        raise RuntimeError("no")

    assert _nearby(nearby_discovery(), supported=boom).identity.nearby.available(role="approver") is False


def test_available_is_false_while_discovery_has_no_nearby() -> None:
    doc = nearby_discovery()
    del doc["services"]["identity"]["nearby"]
    assert _nearby(doc).identity.nearby.available(role="requester") is False
    assert _nearby(discovery()).identity.nearby.available(role="approver") is False
    assert _nearby(discovery(identity=False)).identity.nearby.available(role="approver") is False


def test_available_checks_only_the_endpoints_of_the_role() -> None:
    doc = nearby_discovery()
    del doc["services"]["identity"]["endpoints"]["nearbyApprove"]
    c = _nearby(doc)
    assert c.identity.nearby.available(role="approver") is False
    assert c.identity.nearby.available(role="requester") is True
    doc = nearby_discovery()
    del doc["services"]["identity"]["endpoints"]["nearbyPoll"]
    assert _nearby(doc).identity.nearby.available(role="requester") is False


def test_available_refuses_an_endpoint_outside_this_product() -> None:
    doc = nearby_discovery()
    doc["services"]["identity"]["endpoints"]["nearbyApprove"] = "https://evil.test/nearby/approve"
    assert _nearby(doc).identity.nearby.available(role="approver") is False


def test_available_is_false_when_the_worker_is_unreachable() -> None:
    def down(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    c = make_client(down, expected_services=["license", "config", "identity"])
    c.identity.nearby._runtime_supported = lambda role: True
    assert c.identity.nearby.available(role="requester") is False


def test_an_unknown_role_is_invalid_options() -> None:
    with pytest.raises(PolarisError) as e:
        _nearby(nearby_discovery()).identity.nearby.available(role="both")
    assert e.value.code == "invalid-options"


# ── The AsyncClient mirror ───────────────────────────────────────────────────────────


def test_the_async_client_mirrors_both_calls() -> None:
    async def run() -> None:
        c = _nearby(nearby_discovery())
        a = AsyncClient(c)
        r = await a.identity.auto_sign_in()
        assert r.kind == "needs_sign_in"
        assert await a.identity.nearby.available(role="approver") is True
        assert await a.identity.nearby.available(role="requester") is True

    asyncio.run(run())
