"""Offline activation bundles (§7) and the transportless profile.

The corpus's ``bundleCases`` pin the VERIFIER's numbered order across four SDKs; this suite
pins the HOST half — step 5's atomic cache write, what the gate reads afterwards, and the
local-only mode that makes an air-gapped install possible in the first place.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

from polaris_key.core.bundle import (
    BUNDLE_CLAIMS_REJECTED,
    BUNDLE_JWS_REJECTED,
    BUNDLE_TRUST_REJECTED,
    INNER_DOC_REJECTED,
)
from polaris_key.core.errors import PolarisError
from polaris_key.core.store import CACHE_FORMAT_VERSION
from polaris_key.devices.store import FileStore, InMemoryStore
from polaris_key.local import create_bundle_client, create_local_client

from helpers import (
    ATTACKER_PEM,
    ATTACKER_PUB,
    BASE_URL,
    DAY,
    KID,
    NOW,
    PRODUCT,
    PUBKEY_RAW,
    ROTATED_PEM,
    ROTATED_PUB,
    TRUST,
    key_entry,
    make_client,
    routes,
    sign_bundle,
    sign_config,
    sign_license,
    sign_manifest,
)


def _local(**kw: Any):
    return create_local_client(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=kw.pop("store", None) or InMemoryStore(PRODUCT),
        **kw,
    )


# ── step 5: the atomic write ────────────────────────────────────────────────────────
def test_a_valid_bundle_activates_with_zero_network(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    bundle = sign_bundle(
        device_id,
        docs={
            "license": sign_license(device_id),
            "config": sign_config(device_id),
        },
    )
    client, imported = create_bundle_client(
        bundle=bundle,
        now=NOW,
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=FileStore(PRODUCT, str(tmp_path)),
    )
    assert imported.imported == ["license", "config"]
    assert client.status().status == "ok"
    assert client.get_sync_state().activation == "bundle"
    assert client.config.get_config("run.concurrency") == 4
    # No token is created — a bundle-activated install has no credential.
    assert client.core.store.get_token() is None
    client.close()

    # And the state survives a restart, because the WRITE is what the gate reads back.
    reloaded = _local(store=FileStore(PRODUCT, str(tmp_path)))
    assert reloaded.status().status == "ok"
    assert reloaded.get_sync_state().activation == "bundle"
    reloaded.close()


def test_the_write_persists_only_signed_artifacts(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    lic = sign_license(device_id)
    trust_jws = sign_manifest([key_entry(KID, PUBKEY_RAW)])
    bundle = sign_bundle(device_id, docs={"license": lic}, trust_jws=trust_jws)
    client = _local(store=FileStore(PRODUCT, str(tmp_path)))
    result = client.import_bundle(bundle, NOW)
    client.close()

    raw = json.loads(
        open(os.path.join(str(tmp_path), PRODUCT, "managed.json"), encoding="utf-8").read()
    )
    assert raw["v"] == CACHE_FORMAT_VERSION
    assert raw["docs"] == {"license": lic}
    assert raw["trustJws"] == trust_jws
    assert raw["importedBundle"] == {
        "bundleId": result.bundleId,
        "importedAt": NOW,
    }
    # No ETags: these documents did not come from a conditional GET, and inventing
    # validators would make the next online sync send an `If-None-Match` the server never
    # issued.
    assert raw["etags"] == {}


def test_import_REPLACES_rather_than_merges(tmp_path) -> None:
    """Importing a bundle is a re-provisioning: a stale licence slice surviving an
    air-gapped re-import would be a device running on a licence its operator deliberately
    replaced."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    client = make_client(
        routes(
            license_jws=sign_license(device_id, licenseId="lic_OLD"),
            config_jws=sign_config(device_id),
        ),
        store=FileStore(PRODUCT, str(tmp_path)),
    )
    client.license.activate_with_key("k")
    assert client._cache.license_doc().licenseId == "lic_OLD"

    bundle = sign_bundle(
        device_id,
        issued=NOW + 100,
        docs={"license": sign_license(device_id, issued=NOW + 100, licenseId="lic_NEW")},
    )
    client.import_bundle(bundle, NOW + 100)
    assert client._cache.license_doc().licenseId == "lic_NEW"
    assert client._cache.config_doc() is None, "the old config slice did not survive"
    client.close()


# ── the gate semantics a bundle produces ────────────────────────────────────────────
def test_a_config_only_bundle_grants_nothing() -> None:
    """§7: ``docs.license`` is optional by design — a config-only product (D-08) air-gaps
    with a bundle carrying only ``docs.config`` + ``trust``. Importing it has NO activation
    effect: for a licence-enabled product the gate stays ``needs-activation``."""
    client = _local()
    device_id = client.core.device_id
    bundle = sign_bundle(device_id, docs={"config": sign_config(device_id)})
    result = client.import_bundle(bundle, NOW)
    assert result.imported == ["config"]
    assert client.get_sync_state().activation is None
    assert client.status().status == "needs-activation"
    assert client.config.get_config("run.concurrency") == 4, "settings still landed"
    client.close()


def test_a_config_only_bundle_on_a_config_only_product_is_not_applicable() -> None:
    client = _local(expected_services=["config"])
    device_id = client.core.device_id
    client.import_bundle(
        sign_bundle(device_id, docs={"config": sign_config(device_id)}), NOW
    )
    assert client.status().status == "not-applicable"
    assert client.is_licensed() is True
    client.close()


def test_grace_is_the_revocation_lever_for_a_bundle_install() -> None:
    """§4.3, stated rather than pretended otherwise: a device that never reconnects learns
    nothing new and runs out at ``graceUntil``."""
    client = _local()
    device_id = client.core.device_id
    issued = NOW - 40 * DAY
    client.import_bundle(
        sign_bundle(
            device_id,
            issued=issued,
            expires=NOW + DAY,
            docs={"license": sign_license(device_id, issued=issued)},
        ),
        NOW,
    )
    assert client.status(now=issued + 10).status == "ok"
    assert client.status(now=issued + 2 * 3600).status == "grace"
    assert client.status(now=issued + 31 * DAY).status == "expired"
    client.close()


def test_an_online_token_supersedes_a_bundle(tmp_path) -> None:
    """§7: once the device is online-activated the bundle is history."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    client = make_client(
        routes(license_jws=sign_license(device_id, issued=NOW + 100)),
        store=FileStore(PRODUCT, str(tmp_path)),
        expected_services=["license"],
    )
    client.import_bundle(
        sign_bundle(device_id, docs={"license": sign_license(device_id)}), NOW
    )
    assert client.get_sync_state().activation == "bundle"
    client.license.activate_with_key("k")
    assert client.get_sync_state().activation == "token"
    client.close()


# ── refusals, attributed to the step ────────────────────────────────────────────────
@pytest.mark.parametrize(
    "build,reason",
    [
        (lambda d: sign_bundle(d, pem=ATTACKER_PEM), BUNDLE_JWS_REJECTED),
        (lambda d: sign_bundle(d, typ=None), BUNDLE_JWS_REJECTED),
        (lambda d: sign_bundle("someone-else"), BUNDLE_CLAIMS_REJECTED),
        (lambda d: sign_bundle(d, aud="other-product"), BUNDLE_CLAIMS_REJECTED),
        (lambda d: sign_bundle(d, issued=NOW - 90 * DAY, expires=NOW - 60 * DAY), BUNDLE_CLAIMS_REJECTED),
        (lambda d: sign_bundle(d, docs={}), BUNDLE_CLAIMS_REJECTED),
        (lambda d: sign_bundle(d, bundle_id=""), BUNDLE_CLAIMS_REJECTED),
        (
            lambda d: sign_bundle(
                d, trust_jws=sign_manifest([key_entry(KID, ATTACKER_PUB)])
            ),
            BUNDLE_TRUST_REJECTED,
        ),
        (
            lambda d: sign_bundle(d, docs={"license": sign_license(d, pem=ATTACKER_PEM)}),
            INNER_DOC_REJECTED,
        ),
        (
            lambda d: sign_bundle(d, docs={"license": sign_license("some-other-device")}),
            INNER_DOC_REJECTED,
        ),
    ],
)
def test_a_refusal_names_the_step_and_writes_nothing(build, reason: str, tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    client = _local(store=FileStore(PRODUCT, str(tmp_path)))
    with pytest.raises(PolarisError) as exc:
        client.import_bundle(build(device_id), NOW)
    assert exc.value.code == reason
    assert exc.value.message, "the operator gets a human-readable remedy too"
    assert store.read_cache() is None, "all-or-nothing: nothing was written"
    assert client.status().status == "needs-activation"
    client.close()


def test_a_bundle_may_ship_a_rotated_key_but_never_its_own_roots() -> None:
    """Step 3 verifies the inner manifest against the PINS — which is what stops a bundle
    from shipping its own roots — while still letting a legitimately ROTATED key inside it
    sign the documents at step 4."""
    client = _local()
    device_id = client.core.device_id
    rotated_manifest = sign_manifest(
        [key_entry(KID, PUBKEY_RAW), key_entry("rot", ROTATED_PUB)]
    )
    bundle = sign_bundle(
        device_id,
        trust_jws=rotated_manifest,
        docs={"license": sign_license(device_id, pem=ROTATED_PEM, kid="rot")},
    )
    assert client.import_bundle(bundle, NOW).imported == ["license"]
    assert client.status().status == "ok"
    client.close()


# ── the transportless profile ───────────────────────────────────────────────────────
def test_local_only_refuses_every_network_call_at_the_DIAL() -> None:
    """The refusal is before a URL is built or a header is assembled, so a local-only
    build cannot make a request even by accident."""
    client = _local()
    # A credential is held, so the roster calls get past their own guard and reach the
    # dial — which is where the refusal has to live.
    client._tokens.set("pkeyt_" + "x" * 43)
    for call in (
        lambda: client.license.activate_with_key("k"),
        lambda: client.license.enroll(),
        lambda: client.devices.register(),
        lambda: client.devices.list(),
        lambda: client.devices.rename("x", None),
        lambda: client.devices.deauthorize("x"),
        lambda: client.discover(),
        lambda: client.core.http(),
    ):
        with pytest.raises(PolarisError) as exc:
            call()
        assert exc.value.code == "local-only"
    client.close()


def test_local_only_sync_is_a_silent_no_op_without_a_credential() -> None:
    client = _local()
    assert client.sync().applied is False
    client.close()


def test_local_only_sync_refuses_LOUDLY_once_a_credential_exists() -> None:
    """A transportless client holding a credential must not silently pretend to sync."""
    client = _local()
    client._tokens.set("pkeyt_" + "x" * 43)
    with pytest.raises(PolarisError) as exc:
        client.sync()
    assert exc.value.code == "local-only"
    client.close()


def test_local_only_deactivate_still_works() -> None:
    """It treats the refusal exactly as it treats being offline, because the local wipe
    was always the part that mattered."""
    client = _local()
    device_id = client.core.device_id
    client.import_bundle(
        sign_bundle(device_id, docs={"license": sign_license(device_id)}), NOW
    )
    assert client.status().status == "ok"
    client.license.deactivate()
    assert client.status().status == "needs-activation"
    client.close()


def test_local_only_reads_still_work() -> None:
    client = _local(local_overrides={"ui.theme": "solarized"}, env={})
    device_id = client.core.device_id
    client.import_bundle(
        sign_bundle(device_id, docs={"config": sign_config(device_id)}), NOW
    )
    assert client.config.get_config("run.concurrency") == 4
    assert client.config.get_config("ui.theme") == "solarized"
    assert client.config.get_secret("proxy.subscriptionUrl") is not None
    client.close()


@pytest.mark.parametrize(
    "banned", ["client", "refresh_interval_seconds", "local_only"]
)
def test_local_only_rejects_contradictory_options(banned: str) -> None:
    """Supplying a transport to a transportless client is a contradiction, and a polling
    timer on one is a thread whose entire job is to raise."""
    with pytest.raises(TypeError):
        create_local_client(
            product_slug=PRODUCT,
            version="1.0.0",
            trust=TRUST,
            store=InMemoryStore(PRODUCT),
            **{banned: True},
        )


def test_an_ordinary_client_never_dials_during_a_bundle_import() -> None:
    """The air-gapped path is offline for a NORMAL client too — nothing about
    ``import_bundle`` touches the transport."""

    def exploding(r: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected network call to {r.url.path}")

    client = make_client(exploding)
    device_id = client.core.device_id
    client.import_bundle(
        sign_bundle(device_id, docs={"license": sign_license(device_id)}), NOW
    )
    assert client.status().status == "ok"
    client.close()
