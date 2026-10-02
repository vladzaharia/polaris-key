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
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from .feed import feed_content
from .models import (
    CLOCK_SKEW_SECONDS,
    DecisionRelease,
    FeedOutletEntry,
    FeedTarget,
    PackTarget,
    ReleasePin,
    ReleaseRecordBuild,
    UpdateContentInput,
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
from .pack_claims import holds_of
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
    "select_pack_rows",
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


def _outlet_entry_id(target: Optional[FeedTarget], outlet: UpdateOutlet) -> Optional[str]:
    """The key of the install's entry in a target (``outlet_entry``'s rule), or ``None``."""
    if target is None or outlet.kind == OUTLET_UNKNOWN:
        return None
    outlets = target.outlets
    if outlet.id is not None and outlet.id in outlets:
        if outlets[outlet.id].kind == outlet.kind:
            return outlet.id
    of_kind = [k for k, e in outlets.items() if e.kind == outlet.kind]
    return of_kind[0] if len(of_kind) == 1 else None


def decide_update(inp: UpdateDecisionInput) -> UpdateDecision:
    """The update decision (plans/P3-01.md §2.8, extended by plans/P4-13.md §2.6 when
    ``content`` is given): P3-01's eleven rules give the app answer; with ``content``, the pack
    composition, the content blocks and ``prestage`` refine it in §2.6's order. Synchronous and
    total; each answer carries exactly the members the output tables list
    (:meth:`UpdateDecision.to_dict`), so decisions compare by value.
    ``update-matrix.json#/rows`` and ``#/contentRows`` pin every rule."""
    app = _decide_app(inp)
    if inp.content is None:
        return app
    return _decide_content(inp, inp.content, app)


def _decide_app(inp: UpdateDecisionInput) -> UpdateDecision:
    """P3-01's decision, unchanged (plans/P3-01.md §2.8)."""
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
    """The stage machine's ``decide.done`` for a decision (plans/P3-01.md §2.8 "bootDecision",
    amended by plans/P4-13.md §2.6 and decision 4). Floors never stop play; a CI-signed
    revocation of a REQUIRED pack can:

    * ``blocked {revoked-content}``, or any answer with ``contentBlock: "revoked-content"``,
      gives ``required``: the boot stops at a confirmed ``blocked {update-required}`` (a revoked
      required pack cannot be mounted, so continuing would end in an error and a rollback loop);
    * ``packs`` gives ``none`` (the boot's fetch applies it);
    * ``blocked {content-floor}``, and any answer with ``contentBlock: "content-floor"``, give
      ``optional``;
    * otherwise P3-01's rule: ``none``, and a ``platform`` answer that is not mandatory, give
      ``none``; every other answer gives ``optional``, a prompt over a game that keeps running.
    """
    if (
        decision.action == "blocked" and decision.reason == "revoked-content"
    ) or decision.contentBlock == "revoked-content":
        return "required"
    if decision.action == "packs":
        return "none"
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


# ── P4-13: the content decision (plans/P4-13.md §2.6) ────────────────────────────────────────


def _bkey(s: str) -> bytes:
    return s.encode("utf-8", "surrogatepass")


def select_pack_rows(
    pack_sets: Mapping[str, Any],
    *,
    content_api: int,
    platform: str,
    engine: str,
    axes: Mapping[str, Sequence[str]],
) -> Dict[str, str]:
    """Row selection (plans/P4-13.md §2.6 steps 1–4): the candidate rows of ``pack_sets`` at
    (``content_api``, ``platform``) whose ``engine`` equals ``engine`` exactly (no fallback to
    ``""``), grouped by their sorted axis names; in each group the row ``select_variant``'s rule
    picks (every axis in ``axes``, the lowest tuple of preference indexes over axis names in byte
    order). Returns the feed target per pack: the record hash the selected rows' sets name, with
    a pack named by two selected rows left out. Never raises."""
    groups: Dict[Tuple[str, ...], Tuple[str, List[int]]] = {}
    for row in pack_sets.get("rows", ()):
        if (
            row["contentApi"] != content_api
            or row["platform"] != platform
            or row["engine"] != engine
        ):
            continue
        names = sorted(row["variant"].keys(), key=_bkey)
        key: List[int] = []
        eligible = True
        for axis in names:
            lst = axes.get(axis) if isinstance(axes, Mapping) else None
            k = -1
            if isinstance(lst, (list, tuple)):
                for j, value in enumerate(lst):
                    if value == row["variant"][axis]:
                        k = j
                        break
            if k < 0:
                eligible = False
                break
            key.append(k)
        if not eligible:
            continue
        group = tuple(names)
        best = groups.get(group)
        if best is None or key < best[1]:
            groups[group] = (row["set"], key)
    targets: Dict[str, str] = {}
    twice: Set[str] = set()
    sets = pack_sets.get("sets", {})
    releases = pack_sets.get("releases", {})
    for set_id, _key in groups.values():
        for h in sets.get(set_id, ()):
            if h not in releases:
                continue
            pack = releases[h]["pack"]
            if pack in targets:
                twice.add(pack)
            targets[pack] = h
    for pack in twice:
        del targets[pack]
    return targets


@dataclass
class _Composition:
    install: List[PackTarget]
    revoke: List[str]
    set: List[Dict[str, str]]
    #: A required pack is revoked without a fix.
    revoked_required: bool = False
    #: Some pack is below its floor.
    floor: bool = False


@dataclass
class _ContentEnv:
    content: UpdateContentInput
    #: The parsed ``packSets``, or ``None`` (absent, unusable, or treated as absent).
    pack_sets: Optional[Dict[str, Any]]
    floors: List[Dict[str, Any]]
    #: The outlet's narrowing and gates.
    pinned: Set[str]
    gates: Mapping[str, Any]
    data_updates: bool
    platform: str
    engine: str


def _pin_from(sets: Mapping[str, Any], h: str) -> ReleasePin:
    r = sets["releases"][h]
    return ReleasePin(sha256=h, seq=r["seq"], version=r["version"])


def _as_pin(v: Any) -> Optional[ReleasePin]:
    if isinstance(v, ReleasePin):
        return v
    if isinstance(v, Mapping):
        return ReleasePin(sha256=v["sha256"], seq=v["seq"], version=v["version"])
    return None


def _feed_targets(env: _ContentEnv, content_api: int, engine: str) -> Dict[str, ReleasePin]:
    """The feed targets at one level, after the outlet's narrowing and gates (§2.6 step 5)."""
    out: Dict[str, ReleasePin] = {}
    sets = env.pack_sets
    if sets is None:
        return out
    targets = select_pack_rows(
        sets,
        content_api=content_api,
        platform=env.platform,
        engine=engine,
        axes=env.content.axes,
    )
    for pack, h0 in targets.items():
        if pack in env.pinned:
            continue
        h: Optional[str] = h0
        if h0 in env.gates:
            gate = env.gates[h0]
            out_ = gate["halted"]
            if not out_ and gate.get("rollout") is not None:
                b = env.content.buckets.get(gate["rollout"]["salt"])
                out_ = not (
                    isinstance(b, int) and not isinstance(b, bool) and b < gate["rollout"]["bp"]
                )
            if out_:
                h = gate["fallback"]
        if h is not None and h in sets["releases"]:
            out[pack] = _pin_from(sets, h)
    return out


def _replacer(
    env: _ContentEnv, narrowed: bool
) -> Tuple[Callable[[Optional[ReleasePin]], bool], Callable[[Optional[ReleasePin]], Optional[ReleasePin]]]:
    """``is_revoked(x)`` and ``rep(x)`` (§2.6): ``x`` when not revoked; else the revocation's
    replacement when usable, not itself revoked, with data updates on and the pack not
    narrowed; else ``None``."""
    revoked = {r.target: r for r in env.content.revocations}

    def is_revoked(x: Optional[ReleasePin]) -> bool:
        return x is not None and x.sha256 in revoked

    def rep(x: Optional[ReleasePin]) -> Optional[ReleasePin]:
        if x is None:
            return None
        if not is_revoked(x):
            return x
        r = revoked[x.sha256]
        if (
            r.replacementUsable
            and r.replacement is not None
            and not is_revoked(r.replacement)
            and env.data_updates
            and not narrowed
        ):
            return r.replacement
        return None

    return is_revoked, rep


def _compose(env: _ContentEnv) -> _Composition:
    """The pack composition (§2.6 "Composition, per pack p")."""
    content = env.content
    stamp = content.stamp
    level = stamp["contentApi"]
    pins: Dict[str, ReleasePin] = {}
    for p in stamp.get("pins") or ():
        pin = _as_pin(p["release"])
        if pin is not None:
            pins[p["pack"]] = pin
    # ``holds`` absent reads ``[]``; a present ``None`` is unusable (decision 9).
    hold_list = stamp.get("holds", [])
    holds: Dict[str, ReleasePin] = {}
    for h in hold_list or ():
        pin = _as_pin(h["release"])
        if pin is not None:
            holds[h["pack"]] = pin
    required: Set[str] = set()
    essential: Set[str] = set()
    for e in stamp.get("expects") or ():
        if e.get("required") is True:
            required.add(e["pack"])
        if e.get("delivery") == "essential":
            essential.add(e["pack"])
    active = content.active
    targets = _feed_targets(env, level, env.engine)

    known: Set[str] = set(pins) | set(holds) | {e["pack"] for e in stamp.get("expects") or ()}
    known |= set(active) | set(targets)

    out = _Composition(install=[], revoke=[], set=[])
    for p in sorted(known, key=_bkey):
        narrowed = p in env.pinned
        is_revoked, rep = _replacer(env, narrowed)
        base: Optional[ReleasePin]
        if p in pins:
            base = pins[p]
        elif p in holds:
            base = holds[p]
        elif narrowed or hold_list is None or not env.data_updates or env.pack_sets is None:
            base = None
        else:
            base = targets.get(p)

        act = active.get(p)
        cand = rep(base)
        if cand is None and is_revoked(act):
            cand = rep(act)

        wanted = act is not None or p in required or p in essential
        install = (
            cand is not None
            and (act is None or cand.sha256 != act.sha256)
            and wanted
            and (
                p in pins
                or p in holds
                or act is None
                or is_revoked(act)
                or cand.seq > act.seq
            )
        )
        if install:
            assert cand is not None
            out.install.append(PackTarget(pack=p, release=cand))
        eff: Optional[ReleasePin]
        if install:
            eff = cand
        elif act is not None and not is_revoked(act):
            eff = act
        else:
            eff = cand
        if eff is not None:
            out.set.append({"pack": p, "sha256": eff.sha256})

        no_fix = cand is None and (is_revoked(act) or (is_revoked(base) and act is None))
        if no_fix and p in required:
            out.revoked_required = True
        if no_fix and p not in required and act is not None:
            out.revoke.append(p)

        if not no_fix and (act is not None or p in required):
            f = next((x for x in env.floors if x["pack"] == p and x["contentApi"] == level), None)
            if f is not None:
                c = (
                    None
                    if eff is None
                    else compare_versions(f["versionScheme"], eff.version, f["minVersion"])
                )
                if c is None or c < 0:
                    out.floor = True
    return out


def _prestage_of(env: _ContentEnv, inp: UpdateDecisionInput, build_id: str) -> Tuple[PackTarget, ...]:
    """§2.6 "Prestage": the new level's required and essential packs, minus the build's
    embeds."""
    record = inp.record
    rc = record.raw.get("content") if record is not None else None
    if record is None or not isinstance(rc, dict):
        return ()
    level2 = rc.get("contentApi")
    if level2 == env.content.stamp["contentApi"]:
        return ()
    raw_builds = record.raw.get("builds")
    build = next(
        (b for b in raw_builds if isinstance(b, dict) and b.get("id") == build_id),
        None,
    ) if isinstance(raw_builds, list) else None
    embeds = set(build["embeds"]) if build is not None and isinstance(build.get("embeds"), list) else set()
    req = build.get("requires") if build is not None and isinstance(build.get("requires"), dict) else {}
    engine = req["engine"] if isinstance(req.get("engine"), str) else env.engine

    pins: Dict[str, ReleasePin] = {}
    for p in rc.get("pins") or ():
        pin = _as_pin(p.get("release"))
        if pin is not None:
            pins[p["pack"]] = pin
    record_holds = holds_of(rc)
    holds: Dict[str, ReleasePin] = {}
    for h in record_holds or ():
        holds[h["pack"]] = ReleasePin(**h["release"])
    targets = (
        {}
        if record_holds is None or not env.data_updates
        else _feed_targets(env, level2, engine)
    )
    active = env.content.active

    out: List[PackTarget] = []
    for e in rc.get("expects") or ():
        p = e["pack"]
        if not (e.get("required") is True or e.get("delivery") == "essential") or p in embeds:
            continue
        _is_revoked, rep = _replacer(env, p in env.pinned)
        base = pins.get(p) or holds.get(p) or targets.get(p)
        release = rep(base)
        if release is None:
            continue
        act = active.get(p)
        if act is not None and act.sha256 == release.sha256:
            continue
        out.append(PackTarget(pack=p, release=release))
    out.sort(key=lambda t: _bkey(t.pack))
    return tuple(out)


def _decide_content(
    inp: UpdateDecisionInput, content: UpdateContentInput, app: UpdateDecision
) -> UpdateDecision:
    """§2.6 "Order": the content refinement of P3-01's answer ``app``."""
    feed = inp.feed
    target = feed_target(feed.app.targets, inp.installed.platform)
    entry = outlet_entry(target, inp.outlet)
    entry_id = _outlet_entry_id(target, inp.outlet)
    caps = effective_capabilities(
        inp.outlet.kind,
        platform=inp.installed.platform,
        subkind=inp.subkind,
        server=entry.capabilities if entry is not None else None,
    )
    fc = feed_content(feed.raw)
    outlets = (fc.packSets or {}).get("outlets")
    outlet = (
        outlets[entry_id]
        if fc.packSets is not None
        and isinstance(outlets, dict)
        and entry_id is not None
        and entry_id in outlets
        else None
    )

    def env(pack_sets: Optional[Dict[str, Any]]) -> _ContentEnv:
        return _ContentEnv(
            content=content,
            pack_sets=pack_sets,
            floors=list(fc.packFloors or ()),
            pinned=set((outlet or {}).get("pinned") or ()) if pack_sets is not None else set(),
            gates=((outlet or {}).get("gates") or {}) if pack_sets is not None else {},
            data_updates=caps.dataUpdates,
            platform=inp.installed.platform,
            engine=inp.installed.engine if inp.installed.engine is not None else "",
        )

    discard = inp.staged is not None

    # 1. Stale or unknown version: only revoked required content can change the answer.
    if app.action == "none" and app.reason in ("stale", "unknown-version"):
        if _compose(env(None)).revoked_required:
            return UpdateDecision(action="blocked", reason="revoked-content", discardStaged=discard)
        return app

    full = env(fc.packSets)
    c = _compose(full)
    block: Optional[str] = (
        "revoked-content" if c.revoked_required else ("content-floor" if c.floor else None)
    )

    # 2. The app floor.
    if app.action == "blocked":
        return app if block is None else dataclasses.replace(app, contentBlock=block)

    # 3. Offers.
    if app.action in ("binary", "store", "platform"):
        with_prestage = (
            dataclasses.replace(app, prestage=_prestage_of(full, inp, app.build or ""))
            if app.action == "binary"
            else app
        )
        if block is not None:
            return dataclasses.replace(with_prestage, mandatory=True, contentBlock=block)
        if app.mandatory or app.action == "binary":
            return with_prestage

    # 4. A content block.
    if block is not None:
        return UpdateDecision(action="blocked", reason=block, discardStaged=discard)

    # 5. code-ready.
    if app.action == "code-ready":
        return app

    # 6. packs.
    if caps.dataUpdates and (c.install or c.revoke):
        return UpdateDecision(
            action="packs",
            install=tuple(c.install),
            revoke=tuple(c.revoke),
            set=tuple(c.set),
            discardStaged=discard,
        )

    # 7. Otherwise P3-01's answer.
    return app
