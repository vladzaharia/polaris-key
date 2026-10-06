# @pkey-feature core.copy
"""``polaris_key.copy`` over the generated catalog (SDK parity pass §3.2, ``core.copy``; SP-22).

The truth is ``conformance/parity/copy.en.json``: every error code, gate status and activation
result reads its entry from there, an unknown code reads ``fallback`` naming it, placeholders are
filled (or dropped), the activation result and the error code of the same name stay apart, and a
host English override wins for its keys only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Iterator

import pytest

from polaris_key import copy
from polaris_key.copy_generated import COPY_ACTIVATION, COPY_CODES, COPY_GATE
from polaris_key.license.endpoints import ActivationDeviceLimit, ActivationUnauthorized

ROOT = Path(__file__).resolve().parents[3]
COPY_EN = json.loads((ROOT / "conformance" / "parity" / "copy.en.json").read_text("utf-8"))


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    copy.reset_overrides()
    yield
    copy.reset_overrides()


def _filled(text: str, code: str) -> str:
    # What message() does with no params: {code} becomes the code, every other placeholder
    # (and the space before it) is dropped.
    return re.sub(r"( ?)\{(\w+)\}", lambda m: f"{m.group(1)}{code}" if m.group(2) == "code" else "", text)


def test_generated_tables_equal_the_corpus() -> None:
    for table, gen in (("codes", COPY_CODES), ("gate", COPY_GATE), ("activation", COPY_ACTIVATION)):
        assert {k: (v.title, v.message) for k, v in gen.items()} == {
            k: (v["title"], v["message"]) for k, v in COPY_EN[table].items()
        }, table
    assert tuple(copy.COPY_FALLBACK) == (COPY_EN["fallback"]["title"], COPY_EN["fallback"]["message"])


def test_every_error_code_reads_the_codes_table() -> None:
    for code, entry in COPY_EN["codes"].items():
        assert copy.title(code) == entry["title"], code
        assert copy.message(code) == _filled(entry["message"], code), code
        assert "{" not in copy.message(code)


def test_every_gate_status_reads_the_gate_table() -> None:
    for status, entry in COPY_EN["gate"].items():
        assert copy.title(status) == entry["title"], status
        assert copy.message(status) == _filled(entry["message"], status), status


def test_every_activation_result_reads_the_activation_table() -> None:
    for kind, entry in COPY_EN["activation"].items():
        assert copy.activation_title(kind) == entry["title"], kind
        assert copy.activation_message(kind, code="x_code") == _filled(entry["message"], "x_code"), kind
        # camelCase (the §3.1 kind as other SDKs spell it) resolves to the same entry
        camel = kind.split("-")[0] + "".join(p.title() for p in kind.split("-")[1:])
        assert copy.activation_title(camel) == entry["title"], camel


def test_activation_result_and_error_code_stay_apart() -> None:
    assert copy.message("unauthorized") == COPY_EN["codes"]["unauthorized"]["message"]
    assert copy.title("unauthorized") == "Not signed in"
    assert copy.activation_message("unauthorized") == COPY_EN["activation"]["unauthorized"]["message"]
    assert copy.activation_title("unauthorized") == "Key not accepted"
    # "ok" is a gate status for message() and an activation result for activation_message()
    assert copy.message("ok") == COPY_EN["gate"]["ok"]["message"]
    assert copy.activation_message("ok") == COPY_EN["activation"]["ok"]["message"]
    # a code only in the activation table still resolves through message(), last in line
    assert copy.message("device-limit") == COPY_EN["activation"]["device-limit"]["message"]
    assert copy.describe_error(ActivationUnauthorized()) == COPY_EN["activation"]["unauthorized"]["message"]


def test_fallback_names_the_code_never_a_body() -> None:
    fb = COPY_EN["fallback"]
    assert copy.message("brand-new-code") == fb["message"].replace("{code}", "brand-new-code")
    assert copy.title("brand-new-code") == fb["title"]
    assert copy.GENERIC is copy.COPY_FALLBACK
    assert not copy.has_copy("brand-new-code")
    assert copy.has_copy("unauthorized") and copy.has_copy("grace") and copy.has_copy("device-limit")
    assert copy.describe_error(None) == copy.message("unknown")


def test_placeholders_fill_or_drop() -> None:
    owned = COPY_EN["codes"]["license_owned"]["message"]
    assert "{product}" in owned
    assert copy.message("license_owned", params={"product": "Acme"}) == owned.replace("{product}", "Acme")
    assert copy.message("license_owned") == owned.replace(" {product}", "")
    refused = COPY_EN["activation"]["refused"]["message"]
    assert copy.activation_message("refused", code="weird_code") == refused.replace("{code}", "weird_code")
    assert copy.message("bad_request", "missing key") == COPY_EN["codes"]["bad_request"]["message"] + " (missing key)"


def test_describe_error_refused_and_params() -> None:
    refused_known = SimpleNamespace(kind="refused", code="not_entitled")
    assert copy.describe_error(refused_known) == COPY_EN["codes"]["not_entitled"]["message"]
    refused_unknown = SimpleNamespace(kind="refused", code="weird_code")
    assert copy.describe_error(refused_unknown) == COPY_EN["activation"]["refused"]["message"].replace(
        "{code}", "weird_code"
    )
    limit = ActivationDeviceLimit(limit=3, deviceCount=3)
    assert copy.describe_error(limit) == _filled(COPY_EN["activation"]["device-limit"]["message"], "device_limit")
    assert copy.describe_error(SimpleNamespace(code="rate_limited")) == COPY_EN["codes"]["rate_limited"]["message"]


def test_host_override_wins_for_its_keys_only() -> None:
    copy.register_locale("en", {"rate_limited": ("Slow down", "Hold on a second, {code}.")})
    assert copy.title("rate_limited") == "Slow down"
    assert copy.message("rate_limited") == "Hold on a second, rate_limited."
    # every other key keeps the generated text
    assert copy.message("forbidden") == COPY_EN["codes"]["forbidden"]["message"]
    # an override for an activation kind reaches activation_message too
    copy.register_locale("en", {"device-limit": ("Full", "No seats left.")})
    assert copy.activation_message("deviceLimit") == "No seats left."
    copy.reset_overrides()
    assert copy.title("rate_limited") == COPY_EN["codes"]["rate_limited"]["title"]


def test_other_locale_falls_back_to_english() -> None:
    copy.register_locale("fr", {"cancelled": ("Annulé", "Annulé.")})
    assert copy.message("cancelled", locale="fr-CA") == "Annulé."
    assert copy.title("cancelled", locale="fr_FR") == "Annulé"
    assert copy.message("ok", locale="fr") == copy.message("ok")
    assert copy.message("cancelled") == COPY_EN["codes"]["cancelled"]["message"]
