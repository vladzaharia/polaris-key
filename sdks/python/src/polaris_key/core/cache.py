"""The verified cache — wire contract v3 §4.1. Core owns this record; no service module
ever writes it.

THE LOAD PROCEDURE IS THE SECURITY BOUNDARY

Every load re-verifies EVERYTHING, in this order:

1. a record whose ``v != 3`` is DISCARDED, never migrated — one network round trip is the
   right price for not carrying poisoned state forward, and an air-gapped install
   re-imports its bundle;
2. ``pinRevocations`` (the evidence for each tombstoned pin) against the pins, in ascending
   manifest ``issuedAt`` → the usable pins;
3. ``trustJws`` against the USABLE pins only, freshness off → the effective set;
4. each entry of ``docs`` against THAT set, freshness off, full §3 claim validation
   including ``aud`` and ``deviceId``;
5. ``bundle`` (an offline activation) on the bundle RELOAD profile; only when its licence
   document is byte-identical to the cached one does it count as ``activation="bundle"``;
6. every derived counter — the per-type anti-replay floors, ``lastVerifiedAt``, the
   monotonic clock floor — computed from what verified, never read from the file.

Any artifact that fails is treated as ABSENT and dropped from the in-memory record, so a
failed licence document yields ``needs-activation`` rather than a partial state. That is
the whole of R2-03/R4-01/R4-02/R4-03: there is no unsigned field left to poison, and
forging one now requires forging a signature.

WHY WRITES ARE READ-MODIFY-WRITE OF THE WHOLE RECORD

The record has independent slices — two documents, two ETags, a trust manifest, an imported
bundle — updated by different call sites at different times. Serialising every mutation
through :meth:`CacheManager.patch` is what keeps a config write from clobbering a licence
slice that landed moments earlier in the same sync pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Generic, Optional, Tuple, TypeVar

from .bundle import inspect_bundle
from .models import BlockedState, ConfigDoc, LicenseDoc
from .store import CacheRecord
from .verify import verify_config_doc, verify_license_doc

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .context import CoreContext
    from .trust import TrustManager

__all__ = ["CachedDoc", "LoadedCache", "CacheManager"]

T = TypeVar("T")

#: Sentinel distinguishing "leave unchanged" from "clear to None" in :meth:`patch`.
_UNSET = object()


@dataclass(frozen=True)
class CachedDoc(Generic[T]):
    """One re-verified document slice: the decoded payload plus the artifact it came
    from. The host persists the SIGNED artifact, never the decoded object (§4.1)."""

    jws: str
    doc: T


@dataclass(frozen=True)
class LoadedBundle:
    """The cached offline bundle (§7), when it re-verified on the reload profile."""

    bundleId: str
    #: The documents it carried, in §7 order.
    docs: Tuple[str, ...]
    #: The signed fact behind ``activation="bundle"`` (with no token held): it carried a
    #: licence document byte-identical to the cached one.
    activates: bool


@dataclass
class LoadedCache:
    """What a load produced. Every field is DERIVED from a signature checked moments ago."""

    license: Optional[CachedDoc] = None
    config: Optional[CachedDoc] = None
    #: Present ⇒ the cached offline bundle (§7) re-verified on the reload profile.
    bundle: Optional[LoadedBundle] = None
    lastSyncUnauthorized: bool = False
    blocked: Optional[BlockedState] = None
    #: Epoch MILLIseconds of the last verification, derived from the newest document's
    #: signed ``issuedAt`` — offline, the server's own statement of when it minted is the
    #: only trustworthy "last checked" signal there is (R4-04).
    lastVerifiedAt: Optional[int] = None


class CacheManager:
    def __init__(self, ctx: "CoreContext", trust: "TrustManager") -> None:
        self._ctx = ctx
        self._trust = trust
        self._record: Optional[CacheRecord] = None
        self._loaded = LoadedCache()

    @property
    def state(self) -> LoadedCache:
        return self._loaded

    @property
    def record(self) -> Optional[CacheRecord]:
        return self._record

    def etag(self, slice_name: str) -> Optional[str]:
        """The ETag held for one document, or ``None``. Non-security: it is a
        conditional-request validator, and the worst a forged one achieves is an
        unnecessary 200."""
        if self._record is None:
            return None
        return self._record.etags.get(slice_name)

    def update_slices(self) -> Dict[str, Dict[str, str]]:
        """The wire v4 update slices AS STORED: ``{"feeds": …, "releaseRecords": …}``, signed
        JWSs and nothing else, never a floor. They are UNVERIFIED here — the update client
        re-verifies every entry before using it (plans/P3-01.md §2.5, "Reload path") and derives
        the floors from what survives. Copies, so a caller cannot edit the record behind
        :meth:`patch`'s back."""
        rec = self._record
        return {
            "feeds": dict(rec.feeds) if rec is not None else {},
            "releaseRecords": dict(rec.releaseRecords) if rec is not None else {},
        }

    def keep_update_slices(
        self, *, feeds: Dict[str, str], release_records: Dict[str, str]
    ) -> None:
        """Replace the update slices with what the reload path kept. In memory only, like
        :meth:`_drop_slice`: an entry that failed verification is absent for this session and
        rewritten out on the next patch, never erased from disk on a read path."""
        if self._record is None:
            return
        self._record.feeds = dict(feeds)
        self._record.releaseRecords = dict(release_records)

    def license_doc(self) -> Optional[LicenseDoc]:
        return self._loaded.license.doc if self._loaded.license else None

    def config_doc(self) -> Optional[ConfigDoc]:
        return self._loaded.config.doc if self._loaded.config else None

    # ── Load ────────────────────────────────────────────────────────────────────────
    def load(self, now: Optional[int] = None) -> LoadedCache:
        """Re-verify the whole record and derive every counter from it (§4.1)."""
        self._trust.reset()
        self._loaded = LoadedCache()

        rec = self._ctx.store.read_cache()
        # `CacheRecord.from_dict` already refuses a record from another cache version, so
        # a v1/v2 record arrives here as `None`.
        if rec is None:
            self._record = None
            return self._loaded
        self._record = rec

        # §4.1: the tombstones first, so the manifest, the documents and the bundle all verify
        # against the usable pins. Evidence that no longer verifies is dropped on the next write.
        self._trust.load_evidence(rec.pinRevocations)
        self._keep_evidence()

        if rec.trustJws and not self._trust.load_cached(rec.trustJws, now=now):
            # Drop it in memory too, so a later patch cannot write it back.
            self._record.trustJws = None

        trust = self._trust.effective
        newest = 0

        license_jws = rec.docs.get("license")
        if license_jws:
            doc = verify_license_doc(
                license_jws,
                trust,
                expected_aud=self._ctx.product,
                device_id=self._ctx.device_id,
                last_accepted_issued_at=None,
                now=now,
                # A cached document is EXPECTED to be past its short `expiresAt`; its
                # signed outer bound is `graceUntil`, which the gate enforces against the
                # monotonic floor (§4.2). Asserting freshness here would delete offline
                # grace outright.
                check_freshness=False,
            )
            if doc is None:
                self._drop_slice("license")
            else:
                self._loaded.license = CachedDoc(jws=license_jws, doc=doc)
                self._ctx.raise_floor(doc.issuedAt)
                newest = max(newest, doc.issuedAt)

        config_jws = rec.docs.get("config")
        if config_jws:
            doc = verify_config_doc(
                config_jws,
                trust,
                expected_aud=self._ctx.product,
                device_id=self._ctx.device_id,
                last_accepted_issued_at=None,
                now=now,
                check_freshness=False,
            )
            if doc is None:
                self._drop_slice("config")
            else:
                self._loaded.config = CachedDoc(jws=config_jws, doc=doc)
                self._ctx.raise_floor(doc.issuedAt)
                newest = max(newest, doc.issuedAt)

        self._loaded.bundle = self._reload_bundle(now)
        # A cached manifest may have tombstoned a pin whose evidence the record lacked.
        self._keep_evidence()
        self._loaded.lastSyncUnauthorized = self._record.lastSyncUnauthorized is True
        self._loaded.blocked = self._record.blocked
        self._loaded.lastVerifiedAt = newest * 1000 if newest > 0 else None
        return self._loaded

    def _reload_bundle(self, now: Optional[int]) -> Optional[LoadedBundle]:
        """§7 reload profile: the cached bundle's own signature and claims, without the import
        window, against the usable pins; its inner documents against its own manifest's set
        with no floor. It activates only when its licence document is the cached one, byte for
        byte — otherwise a stale bundle could vouch for a licence it never carried."""
        jws = self._record.bundle if self._record is not None else None
        if not isinstance(jws, str):
            return None
        result = inspect_bundle(
            jws,
            pinned=self._ctx.pinned_trust,
            tombstones=self._trust.revoked_pins,
            product=self._ctx.product,
            device_id=self._ctx.device_id,
            now=self._ctx.now() if now is None else now,
            floors={"license": None, "config": None},
            profile="reload",
        )
        if not result.ok:
            return None
        docs = result.bundle.docs
        lic = docs.get("license")
        return LoadedBundle(
            bundleId=result.bundle.bundleId,
            docs=tuple(n for n in ("license", "config") if n in docs),
            activates=lic is not None
            and self._loaded.license is not None
            and lic.jws == self._loaded.license.jws,
        )

    def _keep_evidence(self) -> None:
        """The ``pinRevocations`` slice in memory follows the custodian's evidence."""
        if self._record is not None:
            self._record.pinRevocations = self._trust.pin_revocations

    def trust_jws(self) -> Optional[str]:
        """The cached trust manifest JWS as held (verified on load, or dropped)."""
        t = self._record.trustJws if self._record is not None else None
        return t if isinstance(t, str) else None

    def bundle_jws(self) -> Optional[str]:
        """The cached bundle JWS as stored (unverified), for the byte-identical re-import check."""
        b = self._record.bundle if self._record is not None else None
        return b if isinstance(b, str) else None

    def _drop_slice(self, slice_name: str) -> None:
        """In-memory only: a slice that failed verification is absent for the rest of this
        session and is rewritten out on the next patch. Not erased from disk eagerly — a
        read path that deleted files would turn a transient key-rotation gap into data
        loss."""
        if self._record is None:
            return
        self._record.docs.pop(slice_name, None)
        self._record.etags.pop(slice_name, None)

    # ── Apply ───────────────────────────────────────────────────────────────────────
    def apply_license(
        self, jws: str, doc: LicenseDoc, etag: Optional[str] = None
    ) -> None:
        """Record a freshly verified licence document: artifact + ETag in the record,
        payload in the derived state, ``issuedAt`` into the floor. In memory only —
        :meth:`flush` persists."""
        self._loaded.license = CachedDoc(jws=jws, doc=doc)
        self._ctx.raise_floor(doc.issuedAt)
        self._stage("license", jws, etag)

    def apply_config(self, jws: str, doc: ConfigDoc, etag: Optional[str] = None) -> None:
        self._loaded.config = CachedDoc(jws=jws, doc=doc)
        self._ctx.raise_floor(doc.issuedAt)
        self._stage("config", jws, etag)

    def revoke_slice(self, slice_name: str) -> None:
        """Remove one document slice (artifact, ETag and derived state) in memory, for the
        next :meth:`flush` to persist. Called when the server has said, in
        so many words, that this device must no longer hold it: a hard 401 for the slice it
        answered, or a 403 build block for the licence. The monotonic floor is NOT lowered —
        the dropped document's ``issuedAt`` stays a signed lower bound on real time."""
        rec = self._ensure_record()
        rec.docs.pop(slice_name, None)
        rec.etags.pop(slice_name, None)
        if slice_name == "license":
            self._loaded.license = None
        elif slice_name == "config":
            self._loaded.config = None

    def _stage(self, slice_name: str, jws: str, etag: Optional[str]) -> None:
        rec = self._ensure_record()
        rec.docs[slice_name] = jws
        if etag:
            rec.etags[slice_name] = etag
        else:
            rec.etags.pop(slice_name, None)

    def mark_verified(self, at_ms: Optional[int] = None) -> None:
        """Mark the last verification time from a successful authenticated exchange
        (including a 304 — content unchanged still means freshness renewed, §5)."""
        from .context import now_ms

        self._loaded.lastVerifiedAt = now_ms() if at_ms is None else at_ms

    # ── Write ───────────────────────────────────────────────────────────────────────
    def patch(
        self,
        *,
        trust_jws: Any = _UNSET,
        blocked: Any = _UNSET,
        last_sync_unauthorized: Any = _UNSET,
        pin_revocations: Any = _UNSET,
        feeds: Any = _UNSET,
        release_records: Any = _UNSET,
    ) -> None:
        """Read-modify-write the whole record. The ONLY mutation path (§4.1): a service
        module that wrote the file directly could not be prevented from writing a
        half-record."""
        rec = self._ensure_record()
        if trust_jws is not _UNSET:
            rec.trustJws = trust_jws
        if blocked is not _UNSET:
            rec.blocked = blocked
            self._loaded.blocked = blocked
        if last_sync_unauthorized is not _UNSET:
            rec.lastSyncUnauthorized = last_sync_unauthorized is True
            self._loaded.lastSyncUnauthorized = last_sync_unauthorized is True
        if pin_revocations is not _UNSET:
            rec.pinRevocations = dict(pin_revocations or {})
        if feeds is not _UNSET:
            rec.feeds = dict(feeds or {})
        if release_records is not _UNSET:
            rec.releaseRecords = dict(release_records or {})
        self._ctx.store.write_cache(rec)

    def flush(self, **patch: Any) -> None:
        """Persist whatever ``apply_*`` staged, with an optional patch folded into the
        same write. Two document outcomes settling in one sync pass share ONE write, so
        neither can clobber the other's slice."""
        self.patch(**patch)

    def replace(self, record: CacheRecord) -> None:
        """Replace the record wholesale, atomically. Only ``import_bundle`` uses this: §7
        step 5 is an all-or-nothing write of a verified bundle's contents, and merging it
        into whatever was there before would let a stale slice survive an air-gapped
        re-provisioning.

        The wire v4 update slices are the one exception (as in the Node and React SDKs): they
        are signed public documents, not grants, and they carry each channel's ``seq`` floor.
        Dropping them would let a replayed older feed past the floor, so they are carried into
        the new record and re-verified, like everything else, before any use."""
        carried = self._carried_update_slices()
        record.feeds = {**record.feeds, **carried["feeds"]}
        record.releaseRecords = {**record.releaseRecords, **carried["releaseRecords"]}
        # The pin evidence is the other exception: security state, not a grant (§4.1). The
        # custodian's evidence (which includes any the new record's manifest added) is written.
        record.pinRevocations = self._trust.pin_revocations
        self._record = record
        self._ctx.store.write_cache(record)

    def clear(self) -> None:
        """Wipe everything, in memory and on disk — except the update slices (see
        :meth:`replace`): a deactivation removes every credential and grant, not the feeds'
        ``seq`` floors."""
        carried = self._carried_update_slices()
        self._record = None
        self._loaded = LoadedCache()
        self._trust.reset()
        self._ctx.reset_floor()
        evidence = self._trust.pin_revocations
        if not carried["feeds"] and not carried["releaseRecords"] and not evidence:
            self._ctx.store.clear_cache()
            return
        self._record = CacheRecord(
            feeds=carried["feeds"],
            releaseRecords=carried["releaseRecords"],
            pinRevocations=evidence,
        )
        self._ctx.store.write_cache(self._record)

    def _carried_update_slices(self) -> Dict[str, Dict[str, str]]:
        return self.update_slices()

    def _ensure_record(self) -> CacheRecord:
        if self._record is None:
            self._record = CacheRecord()
        return self._record

    def snapshot(self) -> Dict[str, Any]:
        """The on-disk shape, for tests and diagnostics."""
        return (self._record or CacheRecord()).to_dict()
