# @pkey-feature core.discover
"""Capability resolution + discovery — wire contract v3, D-21.

Three sources, in strictly decreasing precedence: a discovery document loaded this session
> the host's ``expected_services`` > the suite default (licence + config). The point of
parsing discovery at all is that the SDK GATES sub-client availability on it, so a service
that is not advertised must not be reachable.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from polaris_key.core.errors import PolarisError
from polaris_key.discovery import (
    DEFAULT_SERVICES,
    SERVICE_SLUGS,
    DiscoveryError,
    DiscoveryInvalid,
    DiscoveryNotFound,
    DiscoveryOk,
    appcast_url_from,
    copy_services,
    parse_discovery,
    services_from_list,
)

from helpers import BASE_URL, PRODUCT, discovery_doc, make_client, routes


# ── the fallbacks ───────────────────────────────────────────────────────────────────
def test_the_default_is_license_plus_config_and_nothing_else() -> None:
    """Distribution and identity are OFF in the default, so their sub-clients refuse until
    something says otherwise — the fail-closed half of D-21 applied to the genuinely new
    surfaces. Licence and Config are ON, because every product ran them before the suite
    existed and an offline-first client must not lose its gate to an unreachable control
    plane."""
    c = make_client(routes())
    caps = c.capabilities()
    assert caps["license"]["enabled"] and caps["config"]["enabled"]
    assert not caps["release"]["enabled"]
    assert not caps["update"]["enabled"]
    assert not caps["identity"]["enabled"]
    c.close()


def test_expected_services_beats_the_default() -> None:
    c = make_client(routes(), expected_services=["config", "release"])
    caps = c.capabilities()
    assert caps["config"]["enabled"] and caps["release"]["enabled"]
    assert not caps["license"]["enabled"]
    c.close()


def test_an_empty_expectation_turns_everything_off() -> None:
    """Deliberately distinct from saying nothing: a build that names NO services expects
    none, and every sub-client refuses."""
    c = make_client(routes(), expected_services=[])
    assert all(not v["enabled"] for v in c.capabilities().values())
    with pytest.raises(PolarisError) as exc:
        c.release.changelog()
    assert exc.value.code == "service-unavailable"
    c.close()


def test_the_capability_map_is_a_copy_not_the_shared_constant() -> None:
    """A caller that mutated a slice of the exported default would silently change every
    client in the process."""
    c = make_client(routes())
    caps = c.capabilities()
    caps["license"]["enabled"] = False
    assert c.capabilities()["license"]["enabled"] is True
    assert DEFAULT_SERVICES["license"]["enabled"] is True
    c.close()


def test_services_from_list_and_copy_cover_every_slug() -> None:
    assert set(services_from_list(["license"])) == set(SERVICE_SLUGS)
    assert set(copy_services({})) == set(SERVICE_SLUGS)
    assert services_from_list(["nope"])["license"]["enabled"] is False


# ── discovery, once loaded, wins ────────────────────────────────────────────────────
def test_discovery_installs_the_real_capability_map() -> None:
    doc = discovery_doc(license=False, config=True, release=True, update=True)
    c = make_client(routes(discovery=doc))
    result = c.discover()
    assert isinstance(result, DiscoveryOk)
    caps = c.capabilities()
    assert not caps["license"]["enabled"]
    assert caps["config"]["enabled"]
    assert caps["release"]["enabled"] and caps["update"]["enabled"]
    c.close()


def test_a_slug_the_document_omits_reads_as_disabled() -> None:
    """Fail-closed: an omitted slug is DISABLED, not "unknown, assume on"."""
    result = parse_discovery({"product": PRODUCT, "services": {"config": {"enabled": True}}}, PRODUCT)
    assert isinstance(result, DiscoveryOk)
    assert result.services["config"]["enabled"] is True
    assert result.services["license"]["enabled"] is False


def test_a_truthy_non_boolean_enabled_does_not_read_as_on() -> None:
    """The classic version of this bug: the string ``"false"`` is truthy."""
    result = parse_discovery(
        {"product": PRODUCT, "services": {"license": {"enabled": "false"}}}, PRODUCT
    )
    assert isinstance(result, DiscoveryOk)
    assert result.services["license"]["enabled"] is False


@pytest.mark.parametrize(
    "body",
    [
        "not-an-object",
        {"services": {}},  # no product
        {"product": "other", "services": {}},  # wrong product
        {"product": PRODUCT, "services": "nope"},  # malformed services
        {"product": PRODUCT, "services": {"license": "nope"}},
        {"product": PRODUCT, "services": {}, "trust": "nope"},
    ],
)
def test_a_malformed_document_is_REJECTED_not_defaulted(body: Any) -> None:
    """Silently substituting the permissive default is exactly how a fail-closed gate
    becomes a fail-open one."""
    assert isinstance(parse_discovery(body, PRODUCT), DiscoveryInvalid)


def test_the_document_is_allowed_to_grow() -> None:
    """A product publishing richer onboarding metadata must not be rejected by an SDK that
    predates it — the fields the SDK consumes are validated, the rest is preserved."""
    result = parse_discovery(
        {
            "product": PRODUCT,
            "name": "DJDL",
            "protocolVersion": 3,
            "onboarding": {"steps": ["a", "b"]},
            "services": {"config": {"enabled": True, "endpoints": {"document": "/x"}}},
        },
        PRODUCT,
    )
    assert isinstance(result, DiscoveryOk)
    assert result.manifest["onboarding"] == {"steps": ["a", "b"]}
    assert result.manifest["services"]["config"]["endpoints"] == {"document": "/x"}


def test_discovery_404_and_error_shapes() -> None:
    c = make_client(routes())  # no discovery route configured -> 404
    assert isinstance(c.discover(), DiscoveryNotFound)
    c.close()

    def exploding(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    c2 = make_client(exploding)
    result = c2.discover()
    assert isinstance(result, DiscoveryError) and result.status == 0
    c2.close()


def test_a_failed_discovery_leaves_the_fallback_intact() -> None:
    """An offline-first client must not be told it has no licence service simply because
    the control plane is unreachable."""
    def exploding(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    c = make_client(exploding, expected_services=["license"])
    c.discover()
    assert c.capabilities()["license"]["enabled"] is True
    c.close()


# ── the appcast URL comes from the published fragment ───────────────────────────────
def test_appcast_url_is_taken_from_discovery() -> None:
    doc = discovery_doc(update=True)
    assert (
        appcast_url_from(doc) == f"{BASE_URL}/{PRODUCT}/update/appcast.xml"
    )
    assert (
        appcast_url_from(doc, arch="x86_64")
        == f"{BASE_URL}/{PRODUCT}/update/appcast.xml?arch=x86_64"
    )
    # `/update/<channel>/appcast.xml` is a PATH, not a query parameter (§R1).
    assert (
        appcast_url_from(doc, channel="beta")
        == f"{BASE_URL}/{PRODUCT}/update/beta/appcast.xml"
    )
    # `stable` IS the published feed, so it is not re-pathed.
    assert appcast_url_from(doc, channel="stable") == f"{BASE_URL}/{PRODUCT}/update/appcast.xml"


def test_appcast_url_is_none_when_update_is_disabled() -> None:
    assert appcast_url_from(discovery_doc(update=False)) is None
    assert appcast_url_from({"product": PRODUCT, "services": {}}) is None
