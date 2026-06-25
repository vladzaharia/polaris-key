"""The Polaris Key client: a small, product-agnostic facade over enroll/fetch/verify/
cache/gate.

Offline-first — ``__init__``/``create`` apply the cached doc with no network;
``refresh()`` re-pulls (with a single ``/token`` re-acquire on 401) and re-applies.
Mirrors ``client.ts``.
"""

from __future__ import annotations

import dataclasses
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

import httpx

from .endpoints import (
    EnrollOk,
    EnrollResult,
    deauthorize,
    enroll_with_key,
    reacquire_token,
    report_snapshot,
)
from .fetch import (
    FetchBlocked,
    FetchDeviceCap,
    FetchError,
    FetchNotModified,
    FetchOk,
    FetchUnauthorized,
    fetch_managed_config,
)
from .license import (
    BlockedState,
    LicenseState,
    channel_for_version,
    is_usable,
    license_state,
)
from .models import DocProfile, ManagedEntry
from .store import CacheRecord, KeyringStore, Store
from .verify import TrustSet, verify_doc, verify_jws

__all__ = ["PolarisKeyClient", "RefreshResult"]

DEFAULT_BASE = "https://key.plrs.im"

# Sentinel distinguishing "leave unchanged" from "clear to None" in patch_cache.
_UNSET = object()


def _now_sec() -> int:
    return int(time.time())


def _default_config_dir() -> str:
    return os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config"
    )


@dataclass(frozen=True)
class RefreshResult:
    applied: bool
    unauthorized: bool = False
    blocked: bool = False
    deviceCap: bool = False


class PolarisKeyClient:
    """Product-agnostic license + managed-config client."""

    def __init__(
        self,
        *,
        product_slug: str,
        version: str,
        trust: TrustSet,
        base_url: Optional[str] = None,
        channel: Optional[str] = None,
        store: Optional[Store] = None,
        config_dir: Optional[str] = None,
        client: Optional[httpx.Client] = None,
        local_overrides: Optional[dict] = None,
        env_prefix: str = "PKEY_CONFIG_",
        env: Optional[Mapping[str, str]] = None,
        trust_refresh: bool = True,
    ) -> None:
        self.product = product_slug
        self._base_url = (base_url or DEFAULT_BASE).rstrip("/")
        self._version = version
        self._channel = channel or channel_for_version(version)
        self._trust = trust
        self._trust_refresh = trust_refresh
        self._store: Store = store or KeyringStore(
            product_slug, config_dir or _default_config_dir()
        )
        # An injected transport/client (tests) or a lazily-created default.
        self._client = client
        self._owns_client = client is None

        # Layered-config inputs: local overrides win over env over remote-default,
        # but an ``enforced``/``hidden`` remote entry always wins over both.
        self._local_overrides: Dict[str, Any] = dict(local_overrides or {})
        self._env_prefix = env_prefix
        self._env: Mapping[str, str] = os.environ if env is None else env

        self._token: Optional[str] = None
        self._device_id = ""
        self._cache: Optional[CacheRecord] = None

    @classmethod
    def create(cls, **opts: Any) -> "PolarisKeyClient":
        c = cls(**opts)
        c.init()
        return c

    @property
    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=30.0)
        return self._client

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "PolarisKeyClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── Init ────────────────────────────────────────────────────────────────────
    def init(self) -> None:
        """Load token + device id + cached doc (no network)."""
        self._device_id = self._store.get_device_id()
        self._token = self._store.get_token()
        self._cache = self._store.read_cache()
        if self._cache and self._cache.trustedKeys:
            self._trust = {**self._trust, **self._cache.trustedKeys}

    # ── Gate / reads ────────────────────────────────────────────────────────────
    def status(self, now: Optional[int] = None) -> LicenseState:
        now = _now_sec() if now is None else now
        cache = self._cache
        return license_state(
            has_token=self._token is not None,
            doc=cache.doc if cache else None,
            now=now,
            last_sync_unauthorized=cache.lastSyncUnauthorized if cache else False,
            blocked=cache.blocked if cache else None,
            last_verified_at=cache.lastVerifiedAt if cache else None,
        )

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return is_usable(self.status(now).status)

    def get_config(self, key: str, fallback: Any = None) -> Any:
        """Resolve a config key through the layered precedence.

        For an ``enforced``/``hidden`` remote entry, the remote value wins. Otherwise
        ``local_overrides`` > env (``env_prefix + key`` with ``.`` -> ``__``) > remote
        ``value`` > ``fallback``.
        """
        value, _source = self._resolve_config(key, fallback)
        return value

    def _config_entry(self, key: str) -> Optional[ManagedEntry]:
        doc = self._cache.doc if self._cache else None
        if not doc:
            return None
        return doc.payload.config.get(key)

    def _env_value(self, key: str) -> Any:
        """Read ``env[env_prefix + key.replace('.','__')]``; JSON-parse if it parses."""
        env_key = self._env_prefix + key.replace(".", "__")
        if env_key not in self._env:
            return _UNSET
        raw = self._env[env_key]
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw

    def _resolve_config(self, key: str, fallback: Any = None) -> Tuple[Any, str]:
        """Return ``(value, source)`` per the layered-config precedence."""
        entry = self._config_entry(key)
        if entry is not None and entry.state in ("enforced", "hidden"):
            return entry.value, ("hidden" if entry.state == "hidden" else "enforced")
        if key in self._local_overrides:
            return self._local_overrides[key], "local"
        env_val = self._env_value(key)
        if env_val is not _UNSET:
            return env_val, "env"
        if entry is not None:
            return entry.value, "remote-default"
        return fallback, "fallback"

    def get_config_source(self, key: str) -> str:
        """One of ``enforced|hidden|local|env|remote-default|fallback``."""
        _value, source = self._resolve_config(key)
        return source

    def list_user_config(self) -> List[Dict[str, Any]]:
        """User-facing config: every key except ``hidden`` ones, resolved per layering.

        Each item is ``{key, value, enforced}`` where ``enforced`` reflects whether the
        remote entry locks the value (an ``enforced`` state).
        """
        doc = self._cache.doc if self._cache else None
        if not doc:
            return []
        out: List[Dict[str, Any]] = []
        for key, entry in doc.payload.config.items():
            if entry.state == "hidden":
                continue
            value, _source = self._resolve_config(key)
            out.append(
                {"key": key, "value": value, "enforced": entry.state == "enforced"}
            )
        return out

    def get_secret(self, key: str) -> Optional[str]:
        doc = self._cache.doc if self._cache else None
        if not doc:
            return None
        e = doc.payload.secrets.get(key)
        if e is not None and isinstance(e.value, str):
            return e.value
        return None

    def is_entitled(self, name: str) -> bool:
        doc = self._cache.doc if self._cache else None
        if not doc:
            return False
        e = doc.payload.entitlements.get(name)
        return bool(e is not None and e.value is True)

    def get_entitlements(self) -> Dict[str, Any]:
        doc = self._cache.doc if self._cache else None
        if not doc:
            return {}
        return {k: v.value for k, v in doc.payload.entitlements.items()}

    def get_profile(self) -> Optional[DocProfile]:
        doc = self._cache.doc if self._cache else None
        return doc.profile if doc else None

    # ── Enrollment ──────────────────────────────────────────────────────────────
    def activate_with_key(self, key: str) -> EnrollResult:
        r = enroll_with_key(
            base_url=self._base_url,
            product=self.product,
            key=key,
            device_id=self._device_id,
            client=self._http,
        )
        if isinstance(r, EnrollOk):
            self._token = r.token
            self._store.set_token(r.token)
            self.refresh(force=True)
        return r

    def deactivate(self) -> None:
        if self._token:
            deauthorize(
                base_url=self._base_url,
                product=self.product,
                token=self._token,
                client=self._http,
            )
        self._token = None
        self._cache = None
        self._store.clear_token()
        self._store.clear_cache()

    # ── Refresh ─────────────────────────────────────────────────────────────────
    def refresh(self, force: bool = False) -> RefreshResult:
        if not self._token:
            return RefreshResult(applied=False)
        result = self._fetch_and_apply(allow_reacquire=True)
        if result.applied or not result.unauthorized:
            report_snapshot(
                base_url=self._base_url,
                product=self.product,
                token=self._token,
                snapshot=self._report_snapshot_body(),
                client=self._http,
            )
        return result

    def _fetch_and_apply(self, allow_reacquire: bool) -> RefreshResult:
        if not self._token:
            return RefreshResult(applied=False)
        if self._trust_refresh:
            try:
                self._refresh_trust()
            except Exception:
                pass
        res = fetch_managed_config(
            base_url=self._base_url,
            product=self.product,
            token=self._token,
            device_id=self._device_id,
            version=self._version,
            channel=self._channel,
            etag=self._cache.etag if self._cache else None,
            client=self._http,
        )

        if isinstance(res, FetchNotModified):
            self._patch_cache(blocked=None, last_sync_unauthorized=False)
            return RefreshResult(applied=False)

        if isinstance(res, FetchUnauthorized):
            if allow_reacquire:
                re = reacquire_token(
                    base_url=self._base_url,
                    product=self.product,
                    token=self._token,
                    device_id=self._device_id,
                    client=self._http,
                )
                if isinstance(re, EnrollOk):
                    self._token = re.token
                    self._store.set_token(re.token)
                    return self._fetch_and_apply(allow_reacquire=False)
            self._patch_cache(last_sync_unauthorized=True)
            return RefreshResult(applied=False, unauthorized=True)

        if isinstance(res, FetchDeviceCap):
            return RefreshResult(applied=False, deviceCap=True)

        if isinstance(res, FetchBlocked):
            self._patch_cache(
                blocked=BlockedState(reason=res.reason, allowedRange=res.allowedRange)
            )
            return RefreshResult(applied=False, blocked=True)

        if isinstance(res, FetchOk):
            doc = verify_doc(
                res.jws,
                self._trust,
                expected_aud=self.product,
                device_id=self._device_id,
                last_accepted_issued_at=(
                    self._cache.lastAcceptedIssuedAt if self._cache else None
                ),
            )
            if doc is None:
                return RefreshResult(applied=False)
            self._cache = CacheRecord(
                doc=doc,
                etag=res.etag,
                lastAcceptedIssuedAt=doc.issuedAt,
                lastVerifiedAt=_now_sec(),
                lastSyncUnauthorized=False,
                blocked=None,
                trustedKeys=self._cache.trustedKeys if self._cache else None,
                lastTrustIssuedAt=self._cache.lastTrustIssuedAt if self._cache else None,
            )
            self._store.write_cache(self._cache)
            return RefreshResult(applied=True)

        # FetchError
        return RefreshResult(applied=False)

    def _refresh_trust(self) -> bool:
        res = self._http.get(
            f"{self._base_url}/{self.product}/.well-known/polaris-trust.jws",
            headers={"accept": "application/jose"},
        )
        if res.status_code != 200:
            return False
        verified = verify_jws(res.text, self._trust)
        if verified is None:
            return False
        doc = verified.payload
        if doc.get("aud") != self.product or doc.get("iss") != "key.plrs.im":
            return False
        if not isinstance(doc.get("issuedAt"), int) or not isinstance(
            doc.get("expiresAt"), int
        ):
            return False
        if doc["expiresAt"] < _now_sec():
            return False
        if self._cache and self._cache.lastTrustIssuedAt is not None:
            if doc["issuedAt"] <= self._cache.lastTrustIssuedAt:
                return False
        keys = doc.get("keys")
        if not isinstance(keys, list):
            return False
        next_keys: Dict[str, str] = {}
        for item in keys:
            if not isinstance(item, dict):
                continue
            if (
                item.get("alg") == "EdDSA"
                and item.get("kty") == "OKP"
                and item.get("crv") == "Ed25519"
            ):
                kid = item.get("kid")
                public_key = item.get("publicKey")
                if isinstance(kid, str) and isinstance(public_key, str):
                    next_keys[kid] = public_key
        if not next_keys:
            return False
        self._trust = {**self._trust, **next_keys}
        self._patch_cache(
            trusted_keys=self._trust, last_trust_issued_at=doc["issuedAt"]
        )
        return True

    def _patch_cache(
        self,
        *,
        blocked: Any = _UNSET,
        last_sync_unauthorized: Any = _UNSET,
        trusted_keys: Any = _UNSET,
        last_trust_issued_at: Any = _UNSET,
    ) -> None:
        """Update the bookkeeping fields, tolerating a doc-less cache.

        Mirrors ``patchCache``: when there's no cache yet, only persist the
        bookkeeping when something meaningful (a block or a 401) is being set; the gate
        tolerates a ``doc``-less cache. ``_UNSET`` means "leave that field unchanged".
        """
        if self._cache is None:
            sets_block = blocked is not _UNSET and blocked is not None
            sets_unauth = last_sync_unauthorized is True
            sets_trust = trusted_keys is not _UNSET or last_trust_issued_at is not _UNSET
            if sets_block or sets_unauth or sets_trust:
                self._cache = CacheRecord(
                    doc=None,
                    lastAcceptedIssuedAt=0,
                    blocked=blocked if blocked is not _UNSET else None,
                    lastSyncUnauthorized=(
                        last_sync_unauthorized
                        if last_sync_unauthorized is not _UNSET
                        else False
                    ),
                    trustedKeys=trusted_keys if trusted_keys is not _UNSET else None,
                    lastTrustIssuedAt=(
                        last_trust_issued_at
                        if last_trust_issued_at is not _UNSET
                        else None
                    ),
                )
                self._store.write_cache(self._cache)
            return
        # ``CacheRecord`` is replaced (not mutated) so a frozen record never raises
        # FrozenInstanceError; ``_UNSET`` fields keep their current value.
        changes: Dict[str, Any] = {}
        if blocked is not _UNSET:
            changes["blocked"] = blocked
        if last_sync_unauthorized is not _UNSET:
            changes["lastSyncUnauthorized"] = last_sync_unauthorized
        if trusted_keys is not _UNSET:
            changes["trustedKeys"] = trusted_keys
        if last_trust_issued_at is not _UNSET:
            changes["lastTrustIssuedAt"] = last_trust_issued_at
        self._cache = dataclasses.replace(self._cache, **changes)
        self._store.write_cache(self._cache)

    def _report_snapshot_body(self) -> Dict[str, Dict[str, Any]]:
        doc = self._cache.doc if self._cache else None
        config: Dict[str, Any] = {}
        entitlements: Dict[str, Any] = {}
        if doc:
            for k, v in doc.payload.config.items():
                config[k] = v.value
            for k, v in doc.payload.entitlements.items():
                entitlements[k] = v.value
        return {"config": config, "entitlements": entitlements}
