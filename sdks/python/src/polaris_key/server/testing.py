"""Test helpers for an app that gates routes with ``polaris_key.server``: sign license documents
with a throwaway key, get the matching pins and a clock you control, with no network.

    kit = create_test_kit(product="acme")
    polaris = PolarisKey(**kit.options())                    # kit pins and clock, trust refresh off
    headers = kit.signed_headers(entitlements={"export.pdf": True})
    client.get("/api/export", headers=headers)               # 200

    kit.headers_for("license_stale")                         # the headers that make a gate answer 401 license_stale
    kit.headers_for("not_entitled")                          # a license that grants nothing: 403
    rotated = kit.trust.add_key("rotated-2027")              # a key only the trust manifest vouches for
    polaris = PolarisKey(**kit.options(**kit.trust.options()))  # refresh on, served by kit.trust

Never import this from production code: the key it makes signs anything.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Literal, Mapping, Optional, Union

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ..core.b64url import b64url_encode
from ..core.jws import sign_jws
from ..core.models import HEADER_DEVICE, ISSUER, TYP_LICENSE, TYP_TRUST
from ._verdict import HEADER_LICENSE

__all__ = ["PolarisTestKit", "TestClock", "TestTrust", "TestTrustedKey", "TestVerdict", "create_test_kit"]

HOUR = 3600
DAY = 86_400
#: A pairwise subject (``ps_`` and 22 base64url characters): what ``user=`` defaults to.
SAMPLE_SUBJECT = "ps_" + "A" * 22
_START = 1_700_000_000

#: What :meth:`PolarisTestKit.headers_for` can produce: a refusal's code, or a request that passes.
TestVerdict = Literal[
    "license_required", "license_invalid", "license_stale", "not_entitled", "sign_in_required", "ok"
]
#: A holder: ``{"name": ..., "email": ...}``.
Holder = Mapping[str, str]


class TestClock:
    """A clock the test moves; pass ``kit.clock.now`` (``kit.options()`` already does)."""

    __test__ = False

    def __init__(self, start: int) -> None:
        self._now = start

    def now(self) -> float:
        return float(self._now)

    def set(self, seconds: int) -> None:
        self._now = seconds

    def advance(self, seconds: int) -> None:
        self._now += seconds


def _new_key() -> "tuple[str, str]":
    sk = Ed25519PrivateKey.generate()
    pem = sk.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    raw = sk.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return pem, b64url_encode(raw)


@dataclass
class TestTrustedKey:
    """A key only the fake trust manifest vouches for: its documents verify once the core has
    fetched the manifest (``kit.trust.options()``), and are ``license_invalid`` before."""

    __test__ = False

    kid: str
    _pem: str
    _sign: Callable[..., str]

    def sign(self, **options: Any) -> str:
        return self._sign(self._pem, self.kid, **options)


class TestTrust:
    """The fake trust service: an ``httpx`` client that answers ``/<product>/.well-known/polaris-trust.jws``."""

    __test__ = False

    def __init__(self, kit: "PolarisTestKit") -> None:
        self._kit = kit
        self._extra: List[Dict[str, str]] = []
        self._seq = 0
        #: Requests it has seen, in order (URLs).
        self.calls: List[str] = []
        #: True: every fetch fails like an unreachable Polaris Key. Default False.
        self.offline = False
        #: Pass as the core's ``http_client``. Any other URL answers 404.
        self.http_client = httpx.Client(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        if self.offline:
            raise httpx.ConnectError("fetch failed (kit.trust.offline)", request=request)
        kit = self._kit
        if f"/{kit.product}/.well-known/polaris-trust.jws" not in url:
            return httpx.Response(404, text="not found")
        issued = int(kit.clock.now()) + self._seq
        self._seq += 1
        entries = [{"kid": kit.kid, "publicKey": kit._public}, *self._extra]
        keys = [
            {"kid": k["kid"], "alg": "EdDSA", "kty": "OKP", "crv": "Ed25519", "publicKey": k["publicKey"], "status": "active"}
            for k in entries
        ]
        manifest = {
            "schemaVersion": 1,
            "aud": kit.product,
            "iss": ISSUER,
            "issuedAt": issued,
            "expiresAt": issued + 300,
            "jwksUrl": f"https://key.plrs.im/{kit.product}/.well-known/jwks.json",
            "cacheSeconds": 300,
            "keys": keys,
        }
        return httpx.Response(200, text=sign_jws(manifest, kit._pem, kit.kid, TYP_TRUST))

    def add_key(self, kid: Optional[str] = None) -> TestTrustedKey:
        """Publish a second signing key in the manifest and return it."""
        name = kid or f"pkey-test-extra-{len(self._extra) + 1}"
        pem, public = _new_key()
        self._extra.append({"kid": name, "publicKey": public})
        return TestTrustedKey(name, pem, self._kit._sign_with)

    def options(self) -> Dict[str, Any]:
        """``{"trust_refresh": True, "http_client": ...}``, for ``PolarisKey(**kit.options(**kit.trust.options()))``."""
        return {"trust_refresh": True, "http_client": self.http_client}


class PolarisTestKit:
    """A product, a signing key, a clock and a fake trust service. Build it with :func:`create_test_kit`."""

    __test__ = False

    def __init__(self, product: str, kid: str, now: int, base_url: str) -> None:
        self.product = product
        self.kid = kid
        self.device_id = "dev_test"
        self.clock = TestClock(now)
        self._pem, self._public = _new_key()
        #: ``kid`` -> raw Ed25519 public key (base64url): the pins.
        self.pinned_keys: Dict[str, str] = {kid: self._public}
        #: The configuration ``pkey sdk`` would write, with the kit's pins.
        self.config: Dict[str, Any] = {
            "product_slug": product,
            "base_url": base_url,
            "trust": dict(self.pinned_keys),
        }
        self.trust = TestTrust(self)

    def _sign_with(
        self,
        pem: str,
        kid: str,
        *,
        entitlements: Optional[Mapping[str, Any]] = None,
        tier: Optional[str] = None,
        holder: Union[Holder, None, bool] = True,
        user: Union[str, None, bool] = True,
        device_id: Optional[str] = None,
        license_id: str = "lic_test",
        issued_at: Optional[int] = None,
        expires_in: int = HOUR,
        grace_for: int = 30 * DAY,
        aud: Optional[str] = None,
    ) -> str:
        issued = int(self.clock.now()) if issued_at is None else issued_at
        expires = issued + expires_in
        grants: Dict[str, Any] = {
            name: {"state": "enforced", "value": value, "updatedAt": issued}
            for name, value in (entitlements or {}).items()
        }
        if tier is not None:
            grants["license.tier"] = {"state": "enforced", "value": tier, "updatedAt": issued}
        profile: Dict[str, Any] = {"activatedAt": issued}
        if holder is True:
            holder = {"name": "Test Holder", "email": "holder@example.com"}
        if holder:
            name = holder["name"]  # type: ignore[index]
            profile.update(name=name, firstName=name.split(" ")[0], email=holder["email"])  # type: ignore[index]
        if user is True:
            user = SAMPLE_SUBJECT
        if user:
            profile["user"] = {"subject": user}
        doc = {
            "iss": ISSUER,
            "aud": aud or self.product,
            "deviceId": device_id or self.device_id,
            "issuedAt": issued,
            "expiresAt": expires,
            "graceUntil": expires + grace_for,
            "licenseId": license_id,
            "profile": profile,
            "entitlements": grants,
        }
        return sign_jws(doc, pem, kid, TYP_LICENSE)

    def sign(self, **options: Any) -> str:
        """Sign a license document. Keywords: ``entitlements`` (name -> ``True`` or a value), ``tier``,
        ``holder`` (``{"name", "email"}`` or ``None``), ``user`` (a pairwise subject or ``None`` for
        nobody signed in; a sample subject by default), ``device_id``, ``license_id``, ``issued_at``
        (the clock's now), ``expires_in`` (3600), ``grace_for`` (30 days) and ``aud``."""
        return self._sign_with(self._pem, self.kid, **options)

    def headers(self, jws: str, device_id: Optional[str] = None) -> Dict[str, str]:
        """The request headers a client sends: ``X-PKey-License`` and ``X-PKey-Device``."""
        return {HEADER_LICENSE: jws, HEADER_DEVICE: device_id or self.device_id}

    def signed_headers(self, **options: Any) -> Dict[str, str]:
        """:meth:`sign` and :meth:`headers` in one step."""
        return self.headers(self.sign(**options))

    def options(self, **extra: Any) -> Dict[str, Any]:
        """Keyword arguments for ``PolarisKey(**kit.options())``: the kit's config and clock, trust refresh off."""
        return {"config": self.config, "trust_refresh": False, "clock": self.clock.now, **extra}

    def headers_for(self, verdict: TestVerdict, **options: Any) -> Dict[str, str]:
        """The headers that make a gate answer ``verdict`` (``{}`` for ``license_required``).
        ``options`` shape the document like :meth:`sign`: ``"ok"`` signs exactly what you pass
        (grant the entitlement the route needs); ``"not_entitled"`` and ``"sign_in_required"`` sign
        a license with no entitlements and nobody signed in unless you say otherwise."""
        if verdict == "license_required":
            return {}
        if verdict == "license_invalid":
            # A real signature over the real payload, broken: no key can verify it.
            jws = self.sign(**options)
            return self.headers(jws[:-1] + ("B" if jws[-1] == "A" else "A"))
        if verdict == "license_stale":
            # Past expires_at plus the 300 s skew, still inside the grace window.
            return self.headers(self.sign(**{"issued_at": int(self.clock.now()) - 2 * HOUR, "expires_in": HOUR, **options}))
        if verdict in ("not_entitled", "sign_in_required"):
            return self.headers(self.sign(**{"user": None, **options}))
        if verdict == "ok":
            return self.headers(self.sign(**options))
        raise ValueError(
            f"headers_for: {verdict!r} is not a verdict; use license_required, license_invalid, "
            "license_stale, not_entitled, sign_in_required or ok"
        )


def create_test_kit(
    product: str = "test-product",
    *,
    kid: str = "pkey-test-2026",
    now: Optional[int] = None,
    base_url: str = "https://key.plrs.im",
) -> PolarisTestKit:
    """A throwaway key and clock for ``product``. ``now`` is epoch seconds (default: the real time)."""
    return PolarisTestKit(product, kid, int(time.time()) if now is None else now, base_url)
