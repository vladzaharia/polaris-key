"""The update decision — plans/P3-01.md §2.8 and §2.9 (WIRE-CONTRACT-V4 §11, informative).

A port of ``@polaris-key/client-core``'s ``decide.ts``: a pure, synchronous ``decide_update``
over the verified feed and record, the installed build, the outlet and the host's methods,
with the pieces every SDK builds its inputs from: the rollout bucket, the effective
capabilities and the outlet resolution. ``update-matrix.json`` pins every function here, row
for row, in every SDK.

Nothing here does I/O or raises.
"""

from __future__ import annotations

import dataclasses
import hashlib
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .models import (
    CLOCK_SKEW_SECONDS,
    DecisionRelease,
    FeedOutletEntry,
    FeedTarget,
    ReleaseRecordBuild,
    UpdateDecision,
    UpdateDecisionInput,
    UpdateOutlet,
)
from .outlets import (
    BINARY_UPDATES_ORDER,
    CAPABILITY_BOOLEANS,
    OUTLET_CAPABILITY_DEFAULTS,
    OUTLET_ID_PATTERN,
    OUTLET_KINDS,
    OUTLET_SUBKINDS,
    OUTLET_UNKNOWN,
    PLATFORM_NARROWING,
    SUBKIND_NARROWING,
)
from ..constants_generated import BINARY_METHOD_VALUES
from .patterns import _full_match
from .release_record import _utf8
from .stages import BOOT_DECISIONS
from .version import compare_versions, parse_version

__all__ = [
    "BINARY_METHODS",
    "BOOT_DECISIONS",
    "OutletCapabilities",
    "ResolvedOutlet",
    "rollout_bucket",
    "effective_capabilities",
    "is_valid_host_outlet",
    "resolve_update_outlet",
    "feed_target",
    "outlet_entry",
    "decide_update",
    "boot_decision",
    "is_undismissable",
]

#: What a host can do with a ``binary`` decision (``BINARY_METHODS``), in order.
BINARY_METHODS = BINARY_METHOD_VALUES

_ROLLOUT_BUCKETS = 10_000


def _is_object(v: Any) -> bool:
    return isinstance(v, Mapping)


# ── The rollout bucket (§2.8 "Bucket") ──────────────────────────────────────────────────────


def rollout_bucket(salt: str, install_id: str) -> int:
    """``u32_be(SHA-256(UTF-8(salt) ‖ UTF-8(install_id))[0..4]) mod 10000``.

    The feed's 32-character hex salt hashed as TEXT, then the SDK's device id (the value it
    sends as ``X-PKey-Device``), with no separator; the first four digest bytes read
    big-endian as an UNSIGNED integer. The device is inside a rollout iff the bucket is below
    ``bp`` (``update-matrix.json#/bucketVectors``).
    """
    digest = hashlib.sha256(_utf8(salt + install_id)).digest()
    return int.from_bytes(digest[:4], "big") % _ROLLOUT_BUCKETS


# ── Capabilities (§2.9 "Narrowing") ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OutletCapabilities:
    """What an install may do, by the outlet it arrived through."""

    binaryUpdates: str
    codeUpdates: bool
    dataUpdates: bool
    channelSwitch: bool
    commerce: str
    downloadedScripts: bool

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def _narrow(caps: Dict[str, Any], n: Any) -> Dict[str, Any]:
    """Apply one narrowing: booleans AND, ``binaryUpdates`` the narrower of ``none`` <
    ``store`` < ``self``, ``commerce`` only ever to ``none``. A value outside its vocabulary is
    ignored; nothing widens."""
    if not _is_object(n):
        return caps
    out = dict(caps)
    for key in CAPABILITY_BOOLEANS:
        if key in n and isinstance(n[key], bool):
            out[key] = out[key] and n[key]
    if "binaryUpdates" in n:
        value = n["binaryUpdates"]
        if isinstance(value, str) and value in BINARY_UPDATES_ORDER:
            k = BINARY_UPDATES_ORDER.index(value)
            if k < BINARY_UPDATES_ORDER.index(out["binaryUpdates"]):
                out["binaryUpdates"] = BINARY_UPDATES_ORDER[k]
    if "commerce" in n and n["commerce"] == "none":
        out["commerce"] = "none"
    return out


def effective_capabilities(
    kind: str,
    *,
    platform: str,
    subkind: Optional[str] = None,
    server: Optional[Mapping[str, Any]] = None,
) -> OutletCapabilities:
    """The capabilities of an install: the compiled defaults for its outlet kind (``unknown``
    for a kind outside the 17), narrowed by the platform, then the subkind, then the feed
    entry's ``capabilities`` (``server``). The defaults are the ceiling
    (``update-matrix.json#/capabilityCases``)."""
    table = OUTLET_CAPABILITY_DEFAULTS
    base = table[kind] if isinstance(kind, str) and kind in table else table[OUTLET_UNKNOWN]
    caps: Dict[str, Any] = dict(base)
    by_platform = PLATFORM_NARROWING.get(platform) if isinstance(platform, str) else None
    if by_platform is not None and isinstance(kind, str) and kind in by_platform:
        caps = _narrow(caps, by_platform[kind])
    if isinstance(subkind, str) and subkind in SUBKIND_NARROWING:
        caps = _narrow(caps, SUBKIND_NARROWING[subkind])
    caps = _narrow(caps, server)
    return OutletCapabilities(**caps)


# ── The decision's outlet (§2.8 "The outlet") ───────────────────────────────────────────────


@dataclass(frozen=True)
class ResolvedOutlet:
    """What ``resolve_update_outlet`` answers: the decision's ``outlet`` and ``subkind``."""

    id: Optional[str]
    kind: str
    subkind: Optional[str] = None

    @property
    def outlet(self) -> UpdateOutlet:
        return UpdateOutlet(id=self.id, kind=self.kind)

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "subkind": self.subkind}


def _is_kind(v: Any) -> bool:
    return isinstance(v, str) and v in OUTLET_KINDS


def _is_subkind(v: Any) -> bool:
    return isinstance(v, str) and v in OUTLET_SUBKINDS


def _as_mapping(v: Any) -> Optional[Mapping[str, Any]]:
    """A host value as a mapping: a ``dict`` as is, a dataclass instance through ``asdict``."""
    if isinstance(v, Mapping):
        return v
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return dataclasses.asdict(v)
    return None


def is_valid_host_outlet(host: Any) -> bool:
    """True when ``host`` is a valid host outlet option: a bare kind (``"steam"``), or
    ``{"id": <outlet id>, "kind": <kind>, "subkind"?: <subkind or None>}``. An SDK raises
    ``invalid-options`` at construction for any other value."""
    if isinstance(host, str):
        return _is_kind(host)
    m = _as_mapping(host)
    if m is None:
        return False
    if not _is_kind(m.get("kind")):
        return False
    if _full_match(OUTLET_ID_PATTERN, m.get("id")) is None:
        return False
    if m.get("subkind") is not None:
        return _is_subkind(m.get("subkind"))
    return True


def resolve_update_outlet(
    *,
    host: Any = None,
    stamp: Optional[Mapping[str, Any]] = None,
    detected: Any = None,
) -> Optional[ResolvedOutlet]:
    """The decision's outlet, in §2.8's order: a host value wins; else the stamp's kind (its
    ``outletKind``, or its ``outlet`` when it has none; a kind outside the 17 is no kind),
    moved by a detection result when there is one; else ``{id: None, kind: "unknown",
    subkind: None}`` (``update-matrix.json#/outletCases``). ``None`` when ``host`` is present
    but invalid: the SDK raises ``invalid-options`` for it. Never raises."""
    if host is not None:
        if not is_valid_host_outlet(host):
            return None
        if isinstance(host, str):
            return ResolvedOutlet(id=host, kind=host, subkind=None)
        m = _as_mapping(host) or {}
        return ResolvedOutlet(id=m["id"], kind=m["kind"], subkind=m.get("subkind"))
    s: Mapping[str, Any] = stamp if isinstance(stamp, Mapping) else {}
    raw_kind = s["outletKind"] if "outletKind" in s else s.get("outlet")
    kind = raw_kind if _is_kind(raw_kind) else None
    outlet_id = s.get("outlet") if _full_match(OUTLET_ID_PATTERN, s.get("outlet")) else None
    subkind = s.get("outletSubkind") if _is_subkind(s.get("outletSubkind")) else None
    d = _as_mapping(detected)
    if d is not None:
        dk = d.get("kind")
        ds = d.get("subkind")
        if dk == kind:
            return ResolvedOutlet(id=outlet_id, kind=dk, subkind=ds)
        return ResolvedOutlet(id=None, kind=dk, subkind=ds)
    if kind is not None:
        return ResolvedOutlet(id=outlet_id, kind=kind, subkind=subkind)
    return ResolvedOutlet(id=None, kind=OUTLET_UNKNOWN, subkind=None)


# ── The decision (§2.8 "Algorithm") ─────────────────────────────────────────────────────────


def feed_target(targets: Sequence[FeedTarget], platform: str) -> Optional[FeedTarget]:
    """The feed's target for ``platform``, if there is one."""
    for t in targets:
        if t.platform == platform:
            return t
    return None


def outlet_entry(target: Optional[FeedTarget], outlet: UpdateOutlet) -> Optional[FeedOutletEntry]:
    """The install's entry in a target (§2.8 step 3): ``outlets[outlet.id]`` when that entry's
    kind is the outlet's kind; otherwise the ONE entry of that kind, if exactly one has it;
    otherwise none. ``unknown`` never has an entry. A host computes the rollout bucket from
    this entry's salt."""
    if target is None or outlet.kind == OUTLET_UNKNOWN:
        return None
    outlets = target.outlets
    if outlet.id is not None and outlet.id in outlets:
        by_id = outlets[outlet.id]
        if by_id.kind == outlet.kind:
            return by_id
    of_kind = [e for e in outlets.values() if e.kind == outlet.kind]
    return of_kind[0] if len(of_kind) == 1 else None


def _arch_rank(b: ReleaseRecordBuild, arch: str) -> int:
    return 0 if b.arch == arch else (1 if b.arch == "universal" else 2)


def _pick_build(builds: Sequence[ReleaseRecordBuild], arch: str) -> Optional[ReleaseRecordBuild]:
    """The device's own arch before ``universal``, ``universal`` before ``any``; ties by build
    id in ascending order. Build ids are ASCII (``BUILD_ID_PATTERN``), so this is byte order."""
    best: Optional[ReleaseRecordBuild] = None
    for b in builds:
        if best is None:
            best = b
            continue
        r = _arch_rank(b, arch) - _arch_rank(best, arch)
        if r < 0 or (r == 0 and b.id < best.id):
            best = b
    return best


def _eligible(b: ReleaseRecordBuild, platform: str, arch: str, scheme: str) -> bool:
    """§2.8 "Eligible builds": exactly one ``payload`` artifact, the installed platform, and
    the device's arch, ``universal`` or ``any``. A ``requires.engine`` that is not a string, or
    a ``requires.minBinary`` that does not parse under the feed's scheme, is never eligible."""
    payloads = sum(1 for a in b.artifacts if a.role == "payload")
    if payloads != 1:
        return False
    if b.platform != platform:
        return False
    if b.arch != arch and b.arch not in ("universal", "any"):
        return False
    req = b.requires
    if _is_object(req):
        if "engine" in req and not isinstance(req["engine"], str):
            return False
        if "minBinary" in req and (
            not isinstance(req["minBinary"], str)
            or parse_version(scheme, req["minBinary"]) is None
        ):
            return False
    return True


def decide_update(inp: UpdateDecisionInput) -> UpdateDecision:
    """The update decision (plans/P3-01.md §2.8): the first of eleven rules that applies
    decides. Synchronous and total; each answer carries exactly the members §2.8's output table
    lists (:meth:`UpdateDecision.to_dict`), so decisions compare by value.
    ``update-matrix.json#/rows`` pins every rule."""
    feed = inp.feed
    scheme = feed.app.versionScheme

    def cmp(a: Any, b: Any) -> Optional[int]:
        return compare_versions(scheme, a, b)

    staged = inp.staged

    def discard(action: str) -> bool:
        return staged is not None and action != "code-ready"

    def none(reason: str) -> UpdateDecision:
        return UpdateDecision(
            action="none",
            reason=reason,
            behind=reason == "behind",
            discardStaged=discard("none"),
        )

    def blocked() -> UpdateDecision:
        return UpdateDecision(action="blocked", reason="app-floor", discardStaged=discard("blocked"))

    # 1. Stale: freeze, and keep what is staged.
    if inp.now >= feed.expiresAt + CLOCK_SKEW_SECONDS:
        return UpdateDecision(action="none", reason="stale", behind=False, discardStaged=False)

    # 2. Unknown version.
    run = inp.installed.version
    bin_ = inp.installed.binaryVersion if inp.installed.binaryVersion is not None else run
    if parse_version(scheme, run) is None or parse_version(scheme, bin_) is None:
        return none("unknown-version")

    # 3. Setup.
    target = feed_target(feed.app.targets, inp.installed.platform)
    entry = outlet_entry(target, inp.outlet)
    caps = effective_capabilities(
        inp.outlet.kind,
        platform=inp.installed.platform,
        subkind=inp.subkind,
        server=entry.capabilities if entry is not None else None,
    )
    floor_cmp = (
        cmp(bin_, target.floor.minVersion)
        if target is not None and target.floor is not None
        else None
    )
    below_floor = floor_cmp is not None and floor_cmp < 0

    # 4. The offer: the pin (version, seq, sha256) for a self-updating outlet, else the live one.
    offer: Any = None
    if entry is not None and target is not None:
        if caps.binaryUpdates == "self":
            offer = (
                target.release
                if entry.live is not None
                and entry.live.seq == target.release.seq
                and inp.record is not None
                else None
            )
        else:
            offer = entry.live
    if offer is None or entry is None or target is None:
        return blocked() if below_floor else none("not-available")

    # 5. Behind: no downgrade, and the floor is suppressed.
    run_cmp = cmp(offer.version, run)
    if run_cmp is not None and run_cmp < 0:
        return none("behind")

    # 6. Up to date.
    bin_cmp = cmp(offer.version, bin_)
    newer_run = run_cmp is not None and run_cmp > 0
    newer_bin = bin_cmp is not None and bin_cmp > 0
    if not newer_run and not (below_floor and newer_bin):
        return blocked() if below_floor else none("up-to-date")

    # 7. Halted.
    if entry.halted:
        return blocked() if below_floor else none("halted")

    # 8. Rollout: a critical release and a below-floor device bypass it; a null bucket is out.
    if entry.rollout is not None and not below_floor and not target.critical:
        bucket = inp.bucket
        if not (bucket is not None and bucket < entry.rollout.bp):
            return none("out-of-bucket")

    critical = target.critical
    short = DecisionRelease(version=offer.version, seq=offer.seq)

    # 9. Platform.
    if caps.binaryUpdates == "none":
        return UpdateDecision(
            action="platform",
            release=short,
            mandatory=below_floor,
            critical=critical,
            discardStaged=discard("platform"),
        )

    # 10. Store.
    if caps.binaryUpdates == "store":
        return UpdateDecision(
            action="store",
            release=short,
            listingUrl=entry.listingUrl,
            mandatory=below_floor,
            critical=critical,
            discardStaged=discard("store"),
        )

    # 11. Self-updating outlets. The offer is the pin here, so it carries its sha256.
    full = DecisionRelease(version=offer.version, seq=offer.seq, sha256=offer.sha256)
    not_skipped = offer.version != inp.skipVersion

    # a. code-ready.
    if (
        not below_floor
        and newer_run
        and caps.codeUpdates
        and staged is not None
        and staged.channel == feed.channel
        and staged.version == offer.version
        and not_skipped
    ):
        return UpdateDecision(action="code-ready", release=full, critical=critical, discardStaged=False)

    record_builds = (inp.record.builds or ()) if inp.record is not None else ()
    builds: List[ReleaseRecordBuild] = [
        b
        for b in record_builds
        if _eligible(b, inp.installed.platform, inp.installed.arch, scheme)
    ]
    engine = inp.installed.engine

    def is_code_pack(b: ReleaseRecordBuild) -> bool:
        if b.format != "pck":
            return False
        req: Mapping[str, Any] = b.requires if _is_object(b.requires) else {}
        if not isinstance(req.get("engine"), str) or engine is None:
            return False
        if req["engine"] != engine:
            return False
        if "minBinary" not in req:
            return True
        c = cmp(bin_, req["minBinary"])
        return c is not None and c >= 0

    code_packs = [b for b in builds if is_code_pack(b)]
    fmt = inp.installed.format
    binaries = [b for b in builds if b.format != "pck" and (fmt is None or b.format == fmt)]
    methods = inp.methods

    def binary(method: str, build: ReleaseRecordBuild) -> UpdateDecision:
        return UpdateDecision(
            action="binary",
            method=method,
            release=full,
            build=build.id,
            mandatory=below_floor,
            critical=critical,
            prestage=(),
            discardStaged=discard("binary"),
        )

    # b. sidecar-pck.
    if (
        not below_floor
        and newer_run
        and caps.codeUpdates
        and "sidecar-pck" in methods
        and not_skipped
        and code_packs
    ):
        picked = _pick_build(code_packs, inp.installed.arch)
        assert picked is not None
        return binary("sidecar-pck", picked)

    # c. native, then download.
    pick = _pick_build(binaries, inp.installed.arch)
    if newer_bin and pick is not None:
        if "native" in methods:
            return binary("native", pick)
        if "download" in methods:
            return binary("download", pick)

    # d. Otherwise.
    if below_floor:
        return blocked()
    if not not_skipped:
        return none("skipped")
    if pick is None:
        return none("no-build")
    return none("no-method")


def boot_decision(decision: UpdateDecision) -> str:
    """The stage machine's ``decide.done`` for a decision (§2.8 "bootDecision"). No v4 answer
    stops play: ``none``, and a ``platform`` answer that is not mandatory, give ``none``; every
    other answer gives ``optional``, and a mandatory offer or a ``blocked`` answer is a prompt
    the player cannot dismiss over a game that keeps running. ``required`` comes from no v4
    answer."""
    if decision.action == "none":
        return "none"
    if decision.action == "platform" and not decision.mandatory:
        return "none"
    return "optional"


def is_undismissable(decision: UpdateDecision) -> bool:
    """True when the host must render ``decision`` as a prompt the player cannot dismiss: a
    mandatory ``binary``, ``store`` or ``platform`` answer, and every ``blocked`` answer
    (§2.8). A UI helper shows it persistently and never covers the running app with it."""
    if decision.action == "blocked":
        return True
    if decision.action in ("binary", "store", "platform"):
        return decision.mandatory is True
    return False
