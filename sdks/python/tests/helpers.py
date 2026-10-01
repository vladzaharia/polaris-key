"""Shared fixtures for the wire-v3 suites: signed documents, trust manifests, offline
bundles, and a mock control plane routed at the v3 paths.

Every fixture signs with the SAME committed test key the conformance corpus uses, so a
document built here and a vector out of ``cases.json`` are the same kind of object.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from polaris_key.client import PolarisKeyClient
from polaris_key.core.b64url import b64url_encode
from polaris_key.core.jws import sign_jws
from polaris_key.core.models import TYP_BUNDLE, TYP_CONFIG, TYP_LICENSE, TYP_TRUST
from polaris_key.devices.store import InMemoryStore

PRODUCT = "djdl"
KID = "pkey-test-prod-2026"
PUBKEY_RAW = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
PRIVATE_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n"
    "-----END PRIVATE KEY-----"
)
TRUST = {KID: PUBKEY_RAW}
#: v3 device credentials carry the `pkeyt_` prefix (§6/§8).
TOKEN = "pkeyt_" + "t" * 43
BASE_URL = "https://key.example"
NOW = int(time.time())
DAY = 86_400


def new_keypair():
    """A fresh Ed25519 keypair (the vendor key is never involved in attack fixtures)."""
    sk = Ed25519PrivateKey.generate()
    pem = sk.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    raw = sk.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return pem, b64url_encode(raw)


ATTACKER_PEM, ATTACKER_PUB = new_keypair()
ROTATED_PEM, ROTATED_PUB = new_keypair()


# ── Signed artifacts ────────────────────────────────────────────────────────────────
def license_payload(device_id: str, *, issued: int = NOW, **over: Any) -> Dict[str, Any]:
    """A ``pkey-license+jws`` payload (§2.1): the shared envelope + grants."""
    d: Dict[str, Any] = {
        "iss": "key.plrs.im",
        "aud": PRODUCT,
        "deviceId": device_id,
        "issuedAt": issued,
        "expiresAt": issued + 3600,
        "graceUntil": issued + 30 * DAY,
        "licenseId": "lic_v3",
        "profile": {
            "name": "Grace Hopper",
            "firstName": "Grace",
            "email": "grace@example.com",
            "activatedAt": issued - 1000,
        },
        "entitlements": {
            "polarisVpn": {"state": "enforced", "value": True, "updatedAt": 0},
            "license.tier": {"state": "enforced", "value": "pro", "updatedAt": 0},
        },
    }
    d.update(over)
    return d


def config_payload(device_id: str, *, issued: int = NOW, **over: Any) -> Dict[str, Any]:
    """A ``pkey-config+jws`` payload (§2.2): the shared envelope + config/secrets, and NO
    licence fields whatsoever."""
    d: Dict[str, Any] = {
        "iss": "key.plrs.im",
        "aud": PRODUCT,
        "deviceId": device_id,
        "issuedAt": issued,
        "expiresAt": issued + 3600,
        "graceUntil": issued + 30 * DAY,
        "schemaVersion": 4,
        "config": {
            "run.concurrency": {"state": "enforced", "value": 4, "updatedAt": 1699990000},
            "ui.theme": {"state": "default", "value": "light", "updatedAt": 1699990000},
        },
        "secrets": {
            "proxy.subscriptionUrl": {
                "state": "hidden",
                "value": "https://vpn.example.com/sub/abc",
                "updatedAt": 1699990000,
            }
        },
    }
    d.update(over)
    return d


def manifest_payload(
    keys: List[Dict[str, Any]], *, issued: int = NOW, **over: Any
) -> Dict[str, Any]:
    d: Dict[str, Any] = {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "iss": "key.plrs.im",
        "issuedAt": issued,
        "expiresAt": issued + 3600,
        "jwksUrl": f"{BASE_URL}/{PRODUCT}/.well-known/jwks.json",
        "cacheSeconds": 3600,
        "keys": keys,
    }
    d.update(over)
    return d


def key_entry(kid: str, pub: str, status: str = "active") -> Dict[str, Any]:
    return {
        "kid": kid,
        "alg": "EdDSA",
        "kty": "OKP",
        "crv": "Ed25519",
        "publicKey": pub,
        "status": status,
    }


def sign_license(device_id: str, *, issued: int = NOW, pem: str = PRIVATE_PEM,
                 kid: str = KID, **over: Any) -> str:
    return sign_jws(license_payload(device_id, issued=issued, **over), pem, kid, TYP_LICENSE)


def sign_config(device_id: str, *, issued: int = NOW, pem: str = PRIVATE_PEM,
                kid: str = KID, **over: Any) -> str:
    return sign_jws(config_payload(device_id, issued=issued, **over), pem, kid, TYP_CONFIG)


def sign_manifest(keys: List[Dict[str, Any]], *, issued: int = NOW,
                  pem: str = PRIVATE_PEM, kid: str = KID, **over: Any) -> str:
    return sign_jws(manifest_payload(keys, issued=issued, **over), pem, kid, TYP_TRUST)


def sign_bundle(
    device_id: str,
    *,
    issued: int = NOW,
    expires: Optional[int] = None,
    docs: Optional[Dict[str, str]] = None,
    trust_jws: Optional[str] = None,
    bundle_id: str = "01JBUNDLETEST0000000000000",
    pem: str = PRIVATE_PEM,
    kid: str = KID,
    typ: Optional[str] = TYP_BUNDLE,
    **over: Any,
) -> str:
    """A ``pkey-bundle+jws`` (§7): up to three inner compact JWSs + the import window."""
    payload: Dict[str, Any] = {
        "bundleId": bundle_id,
        "aud": PRODUCT,
        "deviceId": device_id,
        "issuedAt": issued,
        "expiresAt": expires if expires is not None else issued + 30 * DAY,
        "docs": docs if docs is not None else {"license": sign_license(device_id, issued=issued)},
        "trust": trust_jws
        if trust_jws is not None
        else sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=issued),
    }
    payload.update(over)
    return sign_jws(payload, pem, kid, typ)


# ── A mock control plane at the v3 paths ────────────────────────────────────────────
def routes(
    *,
    license_jws: Any = None,
    config_jws: Any = None,
    trust_jws: Any = None,
    license_status: int = 200,
    config_status: int = 200,
    register_status: int = 200,
    devices: Optional[List[Dict[str, Any]]] = None,
    discovery: Optional[Dict[str, Any]] = None,
    seen: Optional[Dict[str, Any]] = None,
) -> Callable[[httpx.Request], httpx.Response]:
    """A mock Worker speaking wire v3. Values may be callables of the request.

    Everything not explicitly routed 404s, which is exactly what a product that has not
    enabled a service looks like on the wire (hide-don't-reveal).
    """
    log: Dict[str, Any] = seen if seen is not None else {}
    log.setdefault("paths", [])

    def body_of(value: Any, r: httpx.Request) -> str:
        return value(r) if callable(value) else value

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        log["paths"].append(path)
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate" or path == f"{p}/license/enroll":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/license/token":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/devices/register":
            if register_status != 200:
                return httpx.Response(register_status, json={"error": {"code": "registration_closed"}})
            return httpx.Response(
                200, json={"token": TOKEN, "deviceId": r.headers.get("X-PKey-Device", "")}
            )
        if path == f"{p}/.well-known/polaris-trust.jws":
            if trust_jws is None:
                return httpx.Response(404)
            return httpx.Response(200, text=body_of(trust_jws, r))
        if path == f"{p}/.well-known/polaris.json":
            if discovery is None:
                return httpx.Response(404)
            return httpx.Response(200, json=discovery)
        if path == f"{p}/license/document":
            if license_status != 200:
                return httpx.Response(license_status)
            if license_jws is None:
                return httpx.Response(404)
            return httpx.Response(
                200, text=body_of(license_jws, r), headers={"etag": "lic-etag"}
            )
        if path == f"{p}/config/document":
            if config_status != 200:
                return httpx.Response(config_status)
            if config_jws is None:
                return httpx.Response(404)
            return httpx.Response(
                200, text=body_of(config_jws, r), headers={"etag": "cfg-etag"}
            )
        if path == f"{p}/devices":
            return httpx.Response(200, json={"devices": devices or []})
        if path.startswith(f"{p}/devices/") and r.method in ("PATCH", "DELETE"):
            return httpx.Response(200, json={"ok": True})
        if path in (f"{p}/devices/report", f"{p}/license/deauthorize"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    return handler


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="")


def make_client(
    handler, *, store=None, trust=None, client=None, version="1.0.0", **kw
) -> PolarisKeyClient:
    """A ``PolarisKeyClient`` wired to a mock transport. Nothing here touches the network."""
    c = PolarisKeyClient(
        product_slug=PRODUCT,
        version=version,
        trust=TRUST if trust is None else trust,
        base_url=BASE_URL,
        store=store if store is not None else InMemoryStore(PRODUCT),
        client=client if client is not None else mock_client(handler),
        **kw,
    )
    c.init()
    return c


def discovery_doc(**enabled: bool) -> Dict[str, Any]:
    """A minimal ``/.well-known/polaris.json`` naming which services are on."""
    services: Dict[str, Any] = {}
    for slug in ("license", "config", "release", "distribution", "update", "identity"):
        if slug in enabled:
            fragment: Dict[str, Any] = {"enabled": enabled[slug]}
            if slug == "update" and enabled[slug]:
                fragment["endpoints"] = {
                    "appcast": f"{BASE_URL}/{PRODUCT}/update/appcast.xml"
                }
            services[slug] = fragment
    return {"product": PRODUCT, "protocolVersion": 4, "services": services}
