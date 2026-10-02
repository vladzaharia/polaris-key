# @pkey-feature core.caps
"""``client.supports()``, the typed ``Unsupported`` and the ``caps`` report key (P1b-10).

The table is generated from ``sdks/python/parity.json`` (``CAPABILITIES``); these tests read
the answers through the client and the engine, and pin the engine's order with fake tables.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import httpx
import pytest

import polaris_key
from polaris_key import (
    CAPABILITIES,
    FEATURE_VALUES,
    CapabilityNa,
    CapabilityRow,
    ErrorCode,
    Feature,
    PolarisError,
    Supported,
    Unsupported,
    UnsupportedError,
    UnsupportedReason,
)
from polaris_key.core.caps import (
    RUNTIME,
    evaluate_support,
    supported_features,
    validate_detectors,
)
from polaris_key.discovery import DiscoveryOk
from polaris_key.devices.store import FileStore, InMemoryStore, KeyringStore

from helpers import PRODUCT, TOKEN, discovery_doc, make_client, routes


def _offline(_r: httpx.Request) -> httpx.Response:
    return httpx.Response(404)


# ── The result types ────────────────────────────────────────────────────────────────


def test_result_types_and_error_carry_the_three_fields() -> None:
    assert Supported(Feature.CORE_VERIFY).supported is True
    u = Unsupported(Feature.CONFIG_SECRET, UnsupportedReason.RUNTIME, "no secrets here")
    assert u.supported is False
    err = UnsupportedError(u)
    assert isinstance(err, PolarisError)
    assert err.code == ErrorCode.UNSUPPORTED == "unsupported"
    assert (err.feature, err.reason, err.detail) == (u.feature, u.reason, u.detail)
    assert err.unsupported == u
    assert polaris_key.UnsupportedError is UnsupportedError


# ── Through the client ──────────────────────────────────────────────────────────────


def test_config_secret_is_supported_in_python() -> None:
    c = make_client(_offline)
    assert c.supports(Feature.CONFIG_SECRET) == Supported(Feature.CONFIG_SECRET)


def test_a_planned_feature_is_version() -> None:
    c = make_client(_offline)
    assert CAPABILITIES[Feature.IDENTITY_OIDC].status == "planned"
    r = c.supports(Feature.IDENTITY_OIDC)
    assert isinstance(r, Unsupported) and r.reason == UnsupportedReason.VERSION
    assert "does not implement" in r.detail


def test_ui_kit_is_a_runtime_na_on_a_headless_sdk() -> None:
    c = make_client(_offline)
    r = c.supports(Feature.UI_KIT)
    assert isinstance(r, Unsupported) and r.reason == UnsupportedReason.RUNTIME


def test_an_unknown_feature_is_version() -> None:
    c = make_client(_offline)
    r = c.supports("future.feature")
    assert isinstance(r, Unsupported) and r.reason == UnsupportedReason.VERSION
    assert "does not know" in r.detail


def test_a_service_disabled_in_discovery_is_product() -> None:
    c = make_client(routes(discovery=discovery_doc(license=True, config=True, update=False)))
    assert isinstance(c.discover(), DiscoveryOk)
    r = c.supports(Feature.UPDATE_DECIDE)
    assert isinstance(r, Unsupported) and r.reason == UnsupportedReason.PRODUCT
    assert "update" in r.detail
    # Core features never answer product.
    assert c.supports(Feature.CORE_VERIFY).supported

    on = make_client(routes(discovery=discovery_doc(license=True, config=True, update=True)))
    assert isinstance(on.discover(), DiscoveryOk)
    assert on.supports(Feature.UPDATE_DECIDE) == Supported(Feature.UPDATE_DECIDE)


def test_expected_services_decide_product_before_discovery() -> None:
    off = make_client(_offline, expected_services=["license", "config"])
    assert off.supports(Feature.RELEASE_CHANGELOG).reason == UnsupportedReason.PRODUCT  # type: ignore[union-attr]
    on = make_client(_offline, expected_services=["license", "config", "release"])
    assert on.supports(Feature.RELEASE_CHANGELOG).supported


class _FakeKeyring:
    def __init__(self, module: str = "keyring.backends.macOS") -> None:
        cls = type("Keyring", (), {})
        cls.__module__ = module
        self.backend = cls()
        self.reads = 0

    def get_keyring(self) -> Any:
        return self.backend

    def get_password(self, *_a: Any) -> Optional[str]:
        self.reads += 1
        return None


def _missing() -> Any:
    raise ImportError("No module named 'keyring'")


def test_a_missing_keyring_extra_is_a_dependency_na_for_core_store(tmp_path: Any) -> None:
    c = make_client(_offline, store=KeyringStore(PRODUCT, str(tmp_path), load_keyring=_missing))
    r = c.supports(Feature.CORE_STORE)
    assert isinstance(r, Unsupported) and r.reason == UnsupportedReason.DEPENDENCY
    assert "keyring" in r.detail
    assert Feature.CORE_STORE not in c.caps()


def test_a_fail_backend_is_a_dependency_na_and_a_usable_one_is_supported(tmp_path: Any) -> None:
    fail = make_client(
        _offline,
        store=KeyringStore(PRODUCT, str(tmp_path / "a"), load_keyring=lambda: _FakeKeyring("keyring.backends.fail")),
    )
    assert fail.supports(Feature.CORE_STORE).reason == UnsupportedReason.DEPENDENCY  # type: ignore[union-attr]

    ring = _FakeKeyring()
    ok = make_client(_offline, store=KeyringStore(PRODUCT, str(tmp_path / "b"), load_keyring=lambda: ring))
    before = ring.reads
    assert ok.supports(Feature.CORE_STORE) == Supported(Feature.CORE_STORE)
    # supports() never reads the keyring: it only asks whether one can be used.
    assert ring.reads == before


def test_a_host_chosen_store_is_supported(tmp_path: Any) -> None:
    assert make_client(_offline, store=FileStore(PRODUCT, str(tmp_path))).supports(Feature.CORE_STORE).supported
    assert make_client(_offline, store=InMemoryStore(PRODUCT)).supports(Feature.CORE_STORE).supported


def test_caps_lists_exactly_the_supported_ids_in_registry_order() -> None:
    c = make_client(_offline)
    caps = c.caps()
    assert caps == [f for f in FEATURE_VALUES if isinstance(c.supports(f), Supported)]
    assert Feature.CORE_VERIFY in caps and Feature.UI_KIT not in caps
    assert Feature.IDENTITY_OIDC not in caps
    # The default services: license + config on, update off.
    assert Feature.LICENSE_GATE in caps and Feature.UPDATE_DECIDE not in caps


def test_every_report_carries_caps() -> None:
    bodies: List[Dict[str, Any]] = []

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/devices/report"):
            bodies.append(json.loads(r.content))
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    store = InMemoryStore(PRODUCT)
    store.set_token(TOKEN)
    c = make_client(handler, store=store)
    assert c.devices.report() is True
    assert c.devices.report() is True
    assert len(bodies) == 2
    for body in bodies:
        assert body["caps"] == c.caps()


# ── The engine, against fake tables ─────────────────────────────────────────────────


def _row(status: str, service: str = "core", *na: CapabilityNa) -> CapabilityRow:
    return CapabilityRow(status, service, tuple(na))


def _eval(feature: str, table: Dict[str, CapabilityRow], **kw: Any):
    kw.setdefault("services_enabled", lambda _s: True)
    kw.setdefault("detectors", {})
    return evaluate_support(feature, table=table, runtime="python", **kw)


def test_engine_order_runtime_then_version_then_product_then_detectors() -> None:
    table = {
        "a.rt": _row("planned", "update", CapabilityNa("python", "runtime")),
        "a.pl": _row("planned", "update"),
        "a.pr": _row("implemented", "update", CapabilityNa("python", "dependency")),
        "a.dep": _row("implemented", "core", CapabilityNa("python", "dependency")),
        "a.other": _row("implemented", "core", CapabilityNa("web", "runtime")),
        "a.na": _row("na", "core", CapabilityNa("python", "outlet")),
    }
    off = lambda _s: False  # noqa: E731
    dep = {("a.pr", "dependency"): lambda: "gone", ("a.dep", "dependency"): lambda: "gone"}
    assert _eval("a.rt", table, services_enabled=off).reason == UnsupportedReason.RUNTIME  # type: ignore[union-attr]
    assert _eval("a.pl", table, services_enabled=off).reason == UnsupportedReason.VERSION  # type: ignore[union-attr]
    assert _eval("a.pr", table, services_enabled=off, detectors=dep).reason == UnsupportedReason.PRODUCT  # type: ignore[union-attr]
    assert _eval("a.dep", table, detectors=dep) == Unsupported("a.dep", "dependency", "gone")
    assert _eval("a.dep", table, detectors={("a.dep", "dependency"): lambda: None}) == Supported("a.dep")
    # Another runtime's N/A does not apply here.
    assert _eval("a.other", table) == Supported("a.other")
    # An SDK-wide na holds whatever its reason.
    assert _eval("a.na", table).reason == UnsupportedReason.OUTLET  # type: ignore[union-attr]
    # A core feature never answers product.
    assert _eval("a.dep", table, services_enabled=off, detectors={("a.dep", "dependency"): lambda: None}).supported


def test_detector_validation_refuses_a_mismatched_table() -> None:
    table = {"a.dep": _row("implemented", "core", CapabilityNa("python", "dependency"))}
    validate_detectors({("a.dep", "dependency"): lambda: None}, table=table)
    with pytest.raises(ValueError, match="no detector"):
        validate_detectors({}, table=table)
    with pytest.raises(ValueError, match="no table entry"):
        validate_detectors(
            {("a.dep", "dependency"): lambda: None, ("a.x", "outlet"): lambda: None}, table=table
        )
    # Another runtime's conditional N/A needs no detector here.
    validate_detectors({}, table={"a.y": _row("implemented", "core", CapabilityNa("web", "outlet"))})


def test_the_generated_table_and_the_clients_detectors_agree() -> None:
    assert RUNTIME == "python"
    assert CAPABILITIES[Feature.CORE_STORE].na == (CapabilityNa("python", "dependency"),)
    make_client(_offline)  # validate_detectors runs in the constructor


def test_supported_features_follows_registry_order() -> None:
    picked = {FEATURE_VALUES[3], FEATURE_VALUES[0]}
    got = supported_features(
        lambda f: Supported(f) if f in picked else Unsupported(f, "version", "x")
    )
    assert got == [FEATURE_VALUES[0], FEATURE_VALUES[3]]
