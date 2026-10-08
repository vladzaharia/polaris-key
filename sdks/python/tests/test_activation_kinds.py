# @pkey-feature license.refusals
# @pkey-feature license.activate
# @pkey-feature license.enroll
"""Typed activation results (SDK parity pass §3.1, SP-P01).

The body's ``error`` code decides the kind, never the status alone: an unknown 403 is
``refused`` with the server's code and never ``device-limit``. The bodies below are the ones
the Worker sends today (``services/license/activation.ts`` ``authorizationError``,
``services/license/enroll.ts``, ``core/deviceTrust.ts``).
"""

from __future__ import annotations

import httpx
import pytest

from polaris_key.devices.client import DeviceRefusedError
from polaris_key.license.endpoints import activation_result_from

from helpers import TOKEN, make_client

ROWS = [
    # (status, body, kind, code)
    (403, {"error": "device_limit", "message": "device limit reached", "limit": 3, "deviceCount": 3}, "device-limit", "device_limit"),
    (403, {"error": "fingerprint_required"}, "fingerprint-required", "fingerprint_required"),
    (403, {"error": {"code": "fingerprint_required"}}, "fingerprint-required", "fingerprint_required"),
    (409, {"error": "hardware_mismatch", "drift": 2, "changed": ["cpuModel"]}, "hardware-mismatch", "hardware_mismatch"),
    (403, {"error": "enroll_claimed", "message": "sign in to use it"}, "enroll-claimed", "enroll_claimed"),
    (403, {"error": "license_disabled"}, "license-disabled", "license_disabled"),
    (403, {"error": "license_expired"}, "license-expired", "license_expired"),
    (403, {"error": "attestation_required", "message": "attest"}, "attestation-required", "attestation_required"),
    (403, {"error": {"code": "attestation_required"}, "message": "attest"}, "attestation-required", "attestation_required"),
    (429, {"error": "rate_limited"}, "rate-limited", "rate_limited"),
    (401, {"error": "unauthorized"}, "unauthorized", "unauthorized"),
    (404, {"error": "enroll_disabled", "message": "enrollment is disabled"}, "enroll-disabled", "enroll_disabled"),
    # I-09's future codes and anything else: refused with the server's code, never device-limit.
    (403, {"error": "license_owned"}, "refused", "license_owned"),
    (403, {"error": "key_entry_limit"}, "refused", "key_entry_limit"),
    (403, {"error": "forbidden"}, "refused", "forbidden"),
    (404, {"error": "not_found"}, "refused", "not_found"),
    (400, {"error": "bad_request", "message": "missing device id"}, "refused", "bad_request"),
    (403, {}, "refused", "http-error"),
    (500, {"error": "enroll_failed"}, "error", "server-error"),
    (502, {}, "error", "server-error"),
]


@pytest.mark.parametrize("status,body,kind,code", ROWS)
def test_every_activation_answer_maps_by_its_code(status, body, kind, code) -> None:
    r = activation_result_from(status, body)
    assert r.kind == kind
    assert r.code == code


def test_refused_keeps_status_and_message() -> None:
    r = activation_result_from(400, {"error": "bad_request", "message": "missing device id"})
    assert (r.status, r.message) == (400, "missing device id")


def test_an_unknown_403_is_never_a_device_limit() -> None:
    for code in ("license_owned", "key_entry_limit", "something_new"):
        assert activation_result_from(403, {"error": code}).kind != "device-limit"


def test_rate_limited_reads_retry_after() -> None:
    c = make_client(lambda r: httpx.Response(429, json={"error": "rate_limited"}, headers={"retry-after": "30"}))
    r = c.license.activate_with_key("k")
    assert r.kind == "rate-limited" and r.retryAfterSeconds == 30
    c.close()


def test_a_transport_failure_is_network_error() -> None:
    def boom(_r):
        raise httpx.ConnectError("down")

    c = make_client(boom)
    r = c.license.activate_with_key("k")
    assert r.kind == "error" and r.code == "network-error" and r.status is None
    c.close()


def test_a_5xx_is_server_error_with_the_server_message() -> None:
    c = make_client(lambda r: httpx.Response(503, json={"error": "unavailable", "message": "try later"}))
    r = c.license.activate_with_key("k")
    assert (r.kind, r.code, r.status, r.message) == ("error", "server-error", 503, "try later")
    c.close()


def test_enroll_maps_enroll_claimed() -> None:
    c = make_client(lambda r: httpx.Response(403, json={"error": "enroll_claimed"}))
    assert c.license.enroll().kind == "enroll-claimed"
    c.close()


# @pkey-feature devices.manage
def test_roster_refusals_keep_the_server_code() -> None:
    c = make_client(lambda r: httpx.Response(403, json={"error": {"code": "forbidden"}}))
    c._tokens.set(TOKEN)
    for call in (lambda: c.devices.list(), lambda: c.devices.rename("x", "y"), lambda: c.devices.deauthorize("x")):
        with pytest.raises(DeviceRefusedError) as e:
            call()
        assert e.value.code == "forbidden" and e.value.status == 403
    c.close()


# @pkey-feature devices.register
def test_register_refusal_other_than_closed_is_refused() -> None:
    c = make_client(lambda r: httpx.Response(403, json={"error": "attestation_required"}))
    r = c.devices.register()
    assert r.kind == "refused" and r.code == "attestation_required"
    c.close()
    c = make_client(lambda r: httpx.Response(403, json={"error": "registration_closed"}))
    assert c.devices.register().kind == "registration-closed"
    c.close()
