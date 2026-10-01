"""The Release + Update sub-clients — the truth store and the feed over it (D-05, §R1).

Release owns what the software IS (changelog, install script, artifacts); Update owns the
FEED (version check, appcast). They are two services precisely because a product can want
a changelog without wanting Sparkle — and both are OFF in the suite default, so this suite
is also where the D-21 fail-closed refusal is exercised end to end.
"""

from __future__ import annotations

from typing import Any, Dict

import httpx
import pytest

from polaris_key.core.errors import PolarisError

from helpers import BASE_URL, PRODUCT, TOKEN, discovery_doc, make_client

CHANGELOG = {
    "entries": [
        {
            "version": "2.1.0",
            "tag": "v2.1.0",
            "date": "2026-08-01",
            "summary": "Faster",
            "url": "https://example/rel/2.1.0",
        },
        {"version": "2.0.0", "tag": "v2.0.0", "date": None, "summary": "", "url": ""},
    ]
}


def _feed_routes(**overrides: Any):
    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        path = r.url.path
        if path in overrides:
            value = overrides[path]
            return value(r) if callable(value) else value
        if path == f"{p}/release/changelog":
            return httpx.Response(200, json=CHANGELOG)
        if path == f"{p}/update/version":
            return httpx.Response(
                200,
                json={"version": "2.1.0", "tag": "v2.1.0", "url": "https://example/rel/2.1.0"},
            )
        return httpx.Response(404)

    return handler


# ── D-21 fail-closed ────────────────────────────────────────────────────────────────
def test_both_services_refuse_until_the_product_says_it_runs_them() -> None:
    """A client that has not been told the service exists must not probe for it."""
    c = make_client(_feed_routes())
    for call in (
        lambda: c.release.changelog(),
        lambda: c.release.install_url(),
        lambda: c.release.download_url("2.1.0", "djdl", "arm64"),
        lambda: c.update.check(),
    ):
        with pytest.raises(PolarisError) as exc:
            call()
        assert exc.value.code == "service-unavailable"
    c.close()


def test_discovery_unlocks_them() -> None:
    handler = _feed_routes(
        **{
            f"/{PRODUCT}/.well-known/polaris.json": httpx.Response(
                200, json=discovery_doc(release=True, update=True)
            )
        }
    )
    c = make_client(handler)
    c.discover()
    assert [e.version for e in c.release.changelog()] == ["2.1.0", "2.0.0"]
    assert c.update.check().version == "2.1.0"
    c.close()


# ── Release ─────────────────────────────────────────────────────────────────────────
# @pkey-feature release.changelog
def test_changelog_decodes_entries() -> None:
    c = make_client(_feed_routes(), expected_services=["release"])
    entries = c.release.changelog()
    assert entries[0].tag == "v2.1.0" and entries[0].date == "2026-08-01"
    assert entries[1].date is None
    c.close()


def test_a_changelog_body_without_entries_is_empty_not_a_crash() -> None:
    c = make_client(
        _feed_routes(**{f"/{PRODUCT}/release/changelog": httpx.Response(200, json={})}),
        expected_services=["release"],
    )
    assert c.release.changelog() == []
    c.close()


# @pkey-feature release.download
def test_install_and_download_urls_are_built_not_fetched() -> None:
    c = make_client(_feed_routes(), expected_services=["release"])
    assert c.release.install_url() == f"{BASE_URL}/{PRODUCT}/release/install.sh"
    assert (
        c.release.download_url("2.1.0", "djdl", "arm64")
        == f"{BASE_URL}/{PRODUCT}/release/dl/2.1.0/djdl-arm64"
    )
    assert (
        c.release.download_url("2.1.0", "djdl", "arm64", dmg=True)
        == f"{BASE_URL}/{PRODUCT}/release/dl/2.1.0/djdl-arm64.dmg"
    )
    assert c.release.download_url("2.1.0", "djdl", "arm64", checksum=True).endswith(
        "?checksum=sha256"
    )
    c.close()


def test_an_entitled_feed_forwards_the_device_token() -> None:
    """When Release's access mode is ``entitled`` the server refuses without a device
    token; this client forwards the bearer when one is held and a public feed ignores it."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["auth"] = r.headers.get("authorization")
        return httpx.Response(200, json=CHANGELOG)

    c = make_client(handler, expected_services=["release"])
    c.release.changelog()
    assert seen["auth"] is None, "no credential held ⇒ no bearer invented"
    c._tokens.set(TOKEN)
    c.release.changelog()
    assert seen["auth"] == f"Bearer {TOKEN}"
    c.close()


def test_a_403_reports_the_entitlement_refusal_rather_than_retrying() -> None:
    c = make_client(
        _feed_routes(
            **{
                f"/{PRODUCT}/release/changelog": httpx.Response(
                    403, json={"error": {"code": "channel_not_allowed"}}
                )
            }
        ),
        expected_services=["release"],
    )
    with pytest.raises(PolarisError) as exc:
        c.release.changelog()
    assert exc.value.code == "channel_not_allowed"
    c.close()


# @pkey-feature release.changelog
@pytest.mark.parametrize(
    "body, code",
    [
        ({"error": {"code": "unauthorized"}}, "unauthorized"),
        ({"error": "download_auth_required"}, "download_auth_required"),
        ({}, "unauthorized"),
    ],
)
def test_a_401_surfaces_the_refusal_body_code(body: Dict[str, Any], code: str) -> None:
    """``entitled`` answers the nested v3 shape; ``authenticated``/``licensed`` keep the flat
    v2 one. Either way the host learns WHY (pinned by the release-changelog transcript)."""
    c = make_client(
        _feed_routes(**{f"/{PRODUCT}/release/changelog": httpx.Response(401, json=body)}),
        expected_services=["release"],
    )
    with pytest.raises(PolarisError) as exc:
        c.release.changelog()
    assert exc.value.code == code
    c.close()


def test_a_null_summary_stays_none() -> None:
    """The Worker answers ``summary: null`` for a release body with no prose; it must not
    become the string ``"None"``."""
    entry = {"version": "1.0.0", "tag": "v1.0.0", "date": None, "summary": None, "url": "u"}
    c = make_client(
        _feed_routes(
            **{f"/{PRODUCT}/release/changelog": httpx.Response(200, json={"entries": [entry]})}
        ),
        expected_services=["release"],
    )
    assert c.release.changelog()[0].summary is None
    c.close()


# ── Update ──────────────────────────────────────────────────────────────────────────
# @pkey-feature update.check
def test_version_check_compares_against_the_HOST_application_version() -> None:
    """``updateAvailable`` is computed from the host app's version, not the SDK's — the
    SDK ships INSIDE the thing being updated. And the comparison is the same
    ``compare_semver`` the server's build gate uses, so a version check can never tell a
    user to update to a build the gate then blocks."""
    c = make_client(_feed_routes(), expected_services=["update"])
    check = c.update.check()
    assert check.version == "2.1.0" and check.updateAvailable is True
    c.close()

    ahead = make_client(_feed_routes(), expected_services=["update"], version="9.0.0")
    assert ahead.update.check().updateAvailable is False
    ahead.close()


# @pkey-feature update.check
def test_version_check_passes_the_channel_through() -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["url"] = str(r.url)
        return httpx.Response(200, json={"version": "2.1.0", "tag": "v", "url": "u"})

    c = make_client(handler, expected_services=["update"])
    c.update.check(channel="beta")
    assert "channel=beta" in seen["url"]
    c.close()


def test_version_check_403_is_an_entitlement_refusal() -> None:
    c = make_client(
        _feed_routes(
            **{
                f"/{PRODUCT}/update/version": httpx.Response(
                    403, json={"error": {"code": "channel_not_allowed"}}
                )
            }
        ),
        expected_services=["update"],
    )
    with pytest.raises(PolarisError) as exc:
        c.update.check()
    assert exc.value.code == "channel_not_allowed"
    c.close()


def test_appcast_url_is_none_before_discovery_has_run() -> None:
    """A host asking "where is my feed?" before discovery is a SEQUENCING question, not an
    error — so the fail-closed answer is expressed as a value."""
    c = make_client(_feed_routes(), expected_services=["update"])
    assert c.update.appcast_url() is None
    c.close()


def test_appcast_url_after_discovery() -> None:
    handler = _feed_routes(
        **{
            f"/{PRODUCT}/.well-known/polaris.json": httpx.Response(
                200, json=discovery_doc(update=True)
            )
        }
    )
    c = make_client(handler)
    c.discover()
    assert c.update.appcast_url() == f"{BASE_URL}/{PRODUCT}/update/appcast.xml"
    assert c.update.appcast_url(arch="x86_64").endswith("?arch=x86_64")
    assert "/update/beta/appcast.xml" in c.update.appcast_url(channel="beta")
    c.close()
