"""The channel feed — WIRE-CONTRACT-V4 §2.3 and client steps 3–9 (plans/P3-01.md §2.3, §2.5).

A port of ``@polaris-key/client-core``'s ``feed.ts``: ``feed_claims`` (steps 4–6),
``verify_feed`` (steps 3–8), the floor, the reload path and step 9's write. Nothing here does
I/O or raises for a bad artifact.

Every pattern matches the whole string through :func:`~polaris_key.core.patterns._full_match`,
a required member must be present (``floor`` and ``live`` may be ``null``, never missing), an
optional member is absent or of its type (a present ``null`` is refused), and every integer
field is an integer claim (``_wire_int``: a plain integer token from the field's minimum to
2^53 − 1, which ``json.loads`` already distinguishes as ``int``).
"""

from __future__ import annotations

import dataclasses
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from ..constants_generated import CHANNEL_ALIASES, CHANNEL_NAME_PATTERN
from .jws import TrustSet, verify_jws
from .models import (
    CLOCK_SKEW_SECONDS,
    ISSUER,
    TYP_FEED,
    ChannelFeedDoc,
    FeedFloor,
    _wire_int,
)
from .outlets import (
    BINARY_UPDATES_ORDER,
    CAPABILITY_BOOLEANS,
    COMMERCE_VALUES,
    LISTING_URL_PREFIXES,
    OUTLET_ID_PATTERN,
    OUTLET_KINDS,
    OUTLET_UNKNOWN,
)
from .pack_claims import (
    ENGINE_PATTERN,
    VARIANT_AXIS_PATTERN,
    VARIANT_VALUE_PATTERN,
    VERSION_PATTERN,
    VOCAB_TOKEN_PATTERN,
    is_pack_id,
    variant_key,
)
from .patterns import _full_match
from .version import VERSION_SCHEMES, compare_versions, parse_version

__all__ = [
    "FEED_TTL_SECONDS",
    "MAX_FEED_TTL_SECONDS",
    "ROLLOUT_BUCKETS",
    "FEED_PLATFORM_PATTERN",
    "FeedFloor",
    "VerifyFeedResult",
    "CommittedFeed",
    "ReloadedFeeds",
    "feed_claims",
    "verify_feed",
    "feed_floor",
    "reload_feeds",
    "commit_feed",
    "bound_channels",
    "FeedContent",
    "feed_content",
    "with_feed_content",
]

#: ``expiresAt = issuedAt + FEED_TTL_SECONDS`` on the Worker.
FEED_TTL_SECONDS = 900
#: ``expiresAt ≤ issuedAt + MAX_FEED_TTL_SECONDS`` (``claims``).
MAX_FEED_TTL_SECONDS = 3600
#: A rollout's ``bp`` is out of this many buckets.
ROLLOUT_BUCKETS = 10_000
#: A target's ``platform``: ASCII, ``OUTLET_ID_PATTERN``'s shape.
FEED_PLATFORM_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,63}")

_CHANNEL_RE = re.compile(CHANNEL_NAME_PATTERN.lstrip("^").rstrip("$"))
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_SALT_RE = re.compile(r"[0-9a-f]{32}")
_MAX_LISTING_URL_BYTES = 2048


def _is_printable_ascii(v: str, maximum: int) -> bool:
    """``listingUrl``: 1–2048 bytes, each 0x21–0x7E, so bytes and characters count alike."""
    if len(v) < 1 or len(v) > maximum:
        return False
    return all(0x21 <= ord(c) <= 0x7E for c in v)


def _capabilities_ok(v: Any) -> bool:
    if not isinstance(v, dict):
        return False
    if "binaryUpdates" in v and not _in(v["binaryUpdates"], BINARY_UPDATES_ORDER):
        return False
    for key in CAPABILITY_BOOLEANS:
        if key in v and not isinstance(v[key], bool):
            return False
    if "commerce" in v and not _in(v["commerce"], COMMERCE_VALUES):
        return False
    return True


def _in(value: Any, vocabulary: Any) -> bool:
    """Membership for a JSON value: only a string can be a vocabulary word (``True`` is not
    ``1``, and an unhashable value is never one)."""
    return isinstance(value, str) and value in vocabulary


def _claims_ok(doc: Dict[str, Any], expected_aud: str) -> bool:
    """Step 4: the claims of §2.3. True when they all hold."""
    schema_version = _wire_int(doc.get("schemaVersion"), 1)
    if schema_version is None or schema_version != 1:
        return False
    if not isinstance(doc.get("iss"), str) or doc["iss"] != ISSUER:
        return False
    if not isinstance(doc.get("aud"), str) or doc["aud"] != expected_aud:
        return False
    if _full_match(_CHANNEL_RE, doc.get("channel")) is None:
        return False
    selector = doc.get("selector")
    if not isinstance(selector, dict):
        return False
    if "platform" in selector and not isinstance(selector["platform"], str):
        return False
    if _wire_int(doc.get("seq"), 1) is None:
        return False
    issued_at = _wire_int(doc.get("issuedAt"), 0)
    expires_at = _wire_int(doc.get("expiresAt"), 1)
    if issued_at is None or expires_at is None:
        return False
    if not issued_at < expires_at:
        return False
    if expires_at > issued_at + MAX_FEED_TTL_SECONDS:
        return False

    app = doc.get("app")
    if not isinstance(app, dict):
        return False
    if not isinstance(app.get("deliverable"), str) or app["deliverable"] != "app":
        return False
    scheme = app.get("versionScheme")
    if not _in(scheme, VERSION_SCHEMES):
        return False

    def version(v: Any) -> bool:
        return isinstance(v, str) and parse_version(scheme, v) is not None

    targets = app.get("targets")
    if not isinstance(targets, list):
        return False

    platforms = set()
    for target in targets:
        if not isinstance(target, dict):
            return False
        platform = target.get("platform")
        if _full_match(FEED_PLATFORM_PATTERN, platform) is None:
            return False
        if platform in platforms:
            return False
        platforms.add(platform)
        if "platform" in selector and platform != selector["platform"]:
            return False

        release = target.get("release")
        if not isinstance(release, dict):
            return False
        if _full_match(_SHA256_RE, release.get("sha256")) is None:
            return False
        if _wire_int(release.get("seq"), 1) is None:
            return False
        if not version(release.get("version")):
            return False

        if "floor" not in target:
            return False
        floor = target["floor"]
        if floor is not None:
            if not isinstance(floor, dict):
                return False
            minimum = floor.get("minVersion")
            if not version(minimum):
                return False
            c = compare_versions(scheme, minimum, release["version"])
            if c is None or c > 0:
                return False
        if not isinstance(target.get("critical"), bool):
            return False

        outlets = target.get("outlets")
        if not isinstance(outlets, dict):
            return False
        for outlet_id, entry in outlets.items():
            if _full_match(OUTLET_ID_PATTERN, outlet_id) is None:
                return False
            if not isinstance(entry, dict):
                return False
            kind = entry.get("kind")
            if _full_match(OUTLET_ID_PATTERN, kind) is None or kind == OUTLET_UNKNOWN:
                return False
            if "live" not in entry:
                return False
            live = entry["live"]
            if live is not None:
                if not isinstance(live, dict):
                    return False
                if not version(live.get("version")):
                    return False
                if _wire_int(live.get("seq"), 1) is None:
                    return False
            if not isinstance(entry.get("halted"), bool):
                return False
            if "rollout" in entry:
                rollout = entry["rollout"]
                if not isinstance(rollout, dict):
                    return False
                bp = _wire_int(rollout.get("bp"), 0)
                if bp is None or bp > ROLLOUT_BUCKETS:
                    return False
                if _full_match(_SALT_RE, rollout.get("salt")) is None:
                    return False
            if "listingUrl" in entry:
                url = entry["listingUrl"]
                if not isinstance(url, str):
                    return False
                if kind in OUTLET_KINDS:
                    prefixes = LISTING_URL_PREFIXES.get(kind, ())
                    if not _is_printable_ascii(url, _MAX_LISTING_URL_BYTES):
                        return False
                    if not any(url.startswith(p) for p in prefixes):
                        return False
            if "capabilities" in entry and not _capabilities_ok(entry["capabilities"]):
                return False
    return True


def _alias_of(requested: str) -> Optional[str]:
    return CHANNEL_ALIASES.get(requested) if isinstance(requested, str) else None


def feed_claims(
    payload: Any,
    *,
    expected_aud: str,
    channel: str,
    platform: Optional[str] = None,
) -> Optional[str]:
    """Client steps 4–6 over a verified feed payload.

    Returns ``None`` when all three pass (the claim is then the canonical channel), else
    ``"claims"``, ``"channel"`` (the claim is ``latest``, or neither the requested name nor,
    when that name is an alias, ``CHANNEL_ALIASES[requested]``) or ``"selector"``. ``channel``
    is the name the client REQUESTED. Never raises.
    """
    if not isinstance(payload, dict):
        return "claims"
    try:
        if not _claims_ok(payload, expected_aud):
            return "claims"
    except Exception:
        return "claims"
    claim = payload["channel"]
    if claim == "latest":
        return "channel"
    if claim != channel and claim != _alias_of(channel):
        return "channel"
    selector = payload["selector"]
    for key in selector:
        if key != "platform":
            return "selector"
    if "platform" in selector and platform is not None and selector["platform"] != platform:
        return "selector"
    return None


# ── The verifier around the claims (client steps 3–8), the floor and the reload path ────────


@dataclass(frozen=True)
class VerifyFeedResult:
    """``verify_feed``'s answer: ``ok`` with the decoded ``feed``, or the refusal ``reason``
    by client step (``feedCases`` ``expect.reason``): ``jws``, ``claims``, ``channel``,
    ``selector``, ``freshness``, ``not-newer`` or ``rollback``. ``channel`` is the canonical
    channel, present only when the feed passed step 5 (a refusal at step 6, 7 or 8): the first
    key of §2.5's fallback order."""

    ok: bool
    feed: Optional[ChannelFeedDoc] = None
    reason: Optional[str] = None
    channel: Optional[str] = None
    #: On ``ok``: ``feed_content`` over the payload (plans/P4-13.md §2.5 step 10).
    content: Optional["FeedContent"] = None


def _refuse(reason: str, channel: Optional[str] = None) -> VerifyFeedResult:
    return VerifyFeedResult(ok=False, reason=reason, channel=channel)


def verify_feed(
    jws: str,
    *,
    trust: TrustSet,
    expected_aud: str,
    channel: str,
    platform: str,
    now: Optional[int] = None,
    check_freshness: bool = True,
    floors: Optional[Mapping[str, FeedFloor]] = None,
) -> VerifyFeedResult:
    """Client steps 3–8 (plans/P3-01.md §2.5).

    ``verify_jws`` with the EFFECTIVE product trust set and ``typ`` ``pkey-feed+jws``; the
    claims; the channel binding against the REQUESTED ``channel``; the selector; freshness at
    ``now`` (the effective clock) on the network path; and the ``seq`` floor of the CANONICAL
    channel, ``floors[claim]``, read only after step 5 has bound the claim. ``floors`` is keyed
    by each committed feed's own ``channel`` claim; no alias is ever resolved here. Never
    raises.
    """
    try:
        v = verify_jws(jws, trust, typ=TYP_FEED, require_typ=True)
    except Exception:
        v = None
    if v is None:
        return _refuse("jws")
    refusal = feed_claims(
        v.payload, expected_aud=expected_aud, channel=channel, platform=platform
    )
    if refusal in ("claims", "channel"):
        return _refuse(refusal)
    try:
        feed = ChannelFeedDoc.from_dict(v.payload)
    except Exception:
        return _refuse("claims")
    # From here on the claim is the canonical channel (step 5).
    claim = feed.channel
    if refusal == "selector":
        return _refuse("selector", claim)
    if check_freshness:
        t = int(time.time()) if now is None else now
        if feed.issuedAt > t + CLOCK_SKEW_SECONDS or feed.expiresAt <= t - CLOCK_SKEW_SECONDS:
            return _refuse("freshness", claim)
    if floors is not None and claim in floors:
        floor = floors[claim]
        if feed.seq < floor.seq:
            return _refuse("rollback", claim)
        if feed.seq == floor.seq and feed.issuedAt <= floor.issuedAt:
            return _refuse("not-newer", claim)
    return VerifyFeedResult(ok=True, feed=feed, content=feed_content(v.payload))


def feed_floor(feed: Any) -> FeedFloor:
    """The floor a committed feed sets for its canonical channel."""
    return FeedFloor(seq=feed.seq, issuedAt=feed.issuedAt)


@dataclass(frozen=True)
class CommittedFeed:
    """One committed feed that survived the reload path."""

    #: The compact JWS, verbatim, as the cache holds it.
    jws: str
    feed: ChannelFeedDoc
    #: ``feed_content`` over it (plans/P4-13.md §2.5).
    content: Optional["FeedContent"] = None


@dataclass(frozen=True)
class ReloadedFeeds:
    #: The survivors, keyed by canonical channel.
    feeds: Dict[str, CommittedFeed]
    #: ``floors[k] = feed_floor(feeds[k])``: what ``verify_feed`` reads at step 8. Never
    #: persisted.
    floors: Dict[str, FeedFloor]


def reload_feeds(
    cached: Optional[Mapping[str, Any]],
    *,
    trust: TrustSet,
    expected_aud: str,
    platform: str,
) -> ReloadedFeeds:
    """The reload path (plans/P3-01.md §2.5): every ``feeds[k]`` of the cache goes through
    steps 3–6 with ``k`` as the requested name, no freshness and no floor, and its claim must
    equal ``k``. Each survivor gives ``floors[k]``; anything that fails is absent, so a
    committed feed whose key left the effective trust set is dropped with its floor. Run on
    cache load and whenever the effective trust set changes. Never raises."""
    out = ReloadedFeeds(feeds={}, floors={})
    if not isinstance(cached, Mapping):
        return out
    for k, jws in cached.items():
        if not isinstance(k, str) or not isinstance(jws, str):
            continue
        r = verify_feed(
            jws,
            trust=trust,
            expected_aud=expected_aud,
            channel=k,
            platform=platform,
            check_freshness=False,
        )
        if not r.ok or r.feed is None or r.feed.channel != k:
            continue
        out.feeds[k] = CommittedFeed(jws=jws, feed=r.feed, content=r.content)
        out.floors[k] = feed_floor(r.feed)
    return out


def commit_feed(
    feeds: Mapping[str, str], *, requested: str, claim: str, jws: str
) -> Dict[str, str]:
    """Step 9's write as a pure function over the ``feeds`` slice: ``feeds[claim] = jws``, and
    when the claim is not the requested name (an alias answer) the same write removes
    ``feeds[requested]``. Every other entry stays. Returns a new map."""
    out = dict(feeds)
    if claim != requested:
        out.pop(requested, None)
    out[claim] = jws
    return out


def bound_channels(requested: str) -> List[str]:
    """The keys a request binds to (step 5): the requested name and, when it is an alias, its
    target. Only step 2's comparison and §2.5's fallback order use this; no key, floor or
    decision channel is ever chosen through it."""
    alias = _alias_of(requested)
    return [requested] if alias is None or alias == requested else [requested, alias]


# ── P4-13: the feed's content members (plans/P4-13.md §2.2, WIRE-CONTRACT-V4 §2.4.1) ─────────
#
# Parsed BESIDE the claims, never as a claim: an unusable member is ``None`` and never refuses
# the feed, so a malformed content member cannot stop app updates. Each member is independent.
# Unknown members are ignored at every level, and the parsed value carries the known ones only.
# Python needs no non-wire pointer set: ``_wire_int`` is the token rule at every pointer.


@dataclass(frozen=True)
class FeedContent:
    """The feed's three content members, each the parsed value (plain JSON) or ``None`` when
    absent or unusable."""

    packSets: Optional[Dict[str, Any]] = None
    packFloors: Optional[List[Dict[str, Any]]] = None
    revocations: Optional[List[Dict[str, Any]]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "packSets": self.packSets,
            "packFloors": self.packFloors,
            "revocations": self.revocations,
        }


class _Unusable(Exception):
    """This member is unusable; caught per member."""


def _no() -> Any:
    raise _Unusable()


def _int(x: Any, minimum: int) -> int:
    v = _wire_int(x, minimum)
    return _no() if v is None else v


def _parse_variant(v: Any) -> Dict[str, str]:
    if not isinstance(v, dict) or len(v) > 4:
        _no()
    out: Dict[str, str] = {}
    for name, value in v.items():
        if _full_match(VARIANT_AXIS_PATTERN, name) is None:
            _no()
        if _full_match(VARIANT_VALUE_PATTERN, value) is None:
            _no()
        out[name] = value
    return out


def _parse_pack_sets(v: Any, selector: Any) -> Dict[str, Any]:
    if not isinstance(v, dict):
        _no()
    if "releases" not in v or "sets" not in v or "rows" not in v:
        _no()

    if not isinstance(v["releases"], dict):
        _no()
    releases: Dict[str, Dict[str, Any]] = {}
    for h, rel in v["releases"].items():
        if _full_match(_SHA256_RE, h) is None or not isinstance(rel, dict):
            _no()
        if not is_pack_id(rel.get("pack")):
            _no()
        if _full_match(VERSION_PATTERN, rel.get("version")) is None:
            _no()
        seq = _int(rel.get("seq"), 1)
        releases[h] = {"pack": rel["pack"], "version": rel["version"], "seq": seq}

    if not isinstance(v["sets"], dict):
        _no()
    sets: Dict[str, List[str]] = {}
    for set_id, members in v["sets"].items():
        if _full_match(_SHA256_RE, set_id) is None or not isinstance(members, list):
            _no()
        packs = set()
        listed: List[str] = []
        for m in members:
            if not isinstance(m, str) or m not in releases:
                _no()
            pack = releases[m]["pack"]
            if pack in packs:
                _no()
            packs.add(pack)
            listed.append(m)
        sets[set_id] = listed

    if not isinstance(v["rows"], list):
        _no()
    platform = selector.get("platform") if isinstance(selector, dict) and "platform" in selector else None
    has_platform = isinstance(selector, dict) and "platform" in selector
    rows: List[Dict[str, Any]] = []
    keys = set()
    for row in v["rows"]:
        if not isinstance(row, dict):
            _no()
        content_api = _int(row.get("contentApi"), 1)
        if _full_match(FEED_PLATFORM_PATTERN, row.get("platform")) is None:
            _no()
        if has_platform and row["platform"] != platform:
            _no()
        engine = row.get("engine")
        if not isinstance(engine, str) or (engine != "" and _full_match(ENGINE_PATTERN, engine) is None):
            _no()
        variant = _parse_variant(row.get("variant"))
        if not isinstance(row.get("set"), str) or row["set"] not in sets:
            _no()
        key = (content_api, row["platform"], engine, variant_key(variant))
        if key in keys:
            _no()
        keys.add(key)
        rows.append(
            {
                "contentApi": content_api,
                "platform": row["platform"],
                "engine": engine,
                "variant": variant,
                "set": row["set"],
            }
        )

    out: Dict[str, Any] = {"releases": releases, "sets": sets, "rows": rows}
    if "outlets" in v:
        if not isinstance(v["outlets"], dict):
            _no()
        outlets: Dict[str, Dict[str, Any]] = {}
        for outlet_id, entry in v["outlets"].items():
            if _full_match(OUTLET_ID_PATTERN, outlet_id) is None or not isinstance(entry, dict):
                _no()
            parsed: Dict[str, Any] = {}
            if "pinned" in entry:
                pinned = entry["pinned"]
                if not isinstance(pinned, list):
                    _no()
                seen = set()
                for p in pinned:
                    if not is_pack_id(p) or p in seen:
                        _no()
                    seen.add(p)
                parsed["pinned"] = list(pinned)
            if "gates" in entry:
                if not isinstance(entry["gates"], dict):
                    _no()
                gates: Dict[str, Dict[str, Any]] = {}
                for h, gate in entry["gates"].items():
                    if h not in releases or not isinstance(gate, dict):
                        _no()
                    if not isinstance(gate.get("halted"), bool):
                        _no()
                    pg: Dict[str, Any] = {"halted": gate["halted"]}
                    if "rollout" in gate:
                        ro = gate["rollout"]
                        if not isinstance(ro, dict):
                            _no()
                        bp = _int(ro.get("bp"), 0)
                        if bp > ROLLOUT_BUCKETS:
                            _no()
                        if _full_match(_SALT_RE, ro.get("salt")) is None:
                            _no()
                        pg["rollout"] = {"bp": bp, "salt": ro["salt"]}
                    if "fallback" not in gate:
                        _no()
                    fallback = gate["fallback"]
                    if fallback is not None and (not isinstance(fallback, str) or fallback not in releases):
                        _no()
                    pg["fallback"] = fallback
                    gates[h] = pg
                parsed["gates"] = gates
            outlets[outlet_id] = parsed
        out["outlets"] = outlets
    return out


def _parse_pack_floors(v: Any) -> List[Dict[str, Any]]:
    if not isinstance(v, list):
        _no()
    out: List[Dict[str, Any]] = []
    keys = set()
    for f in v:
        if not isinstance(f, dict) or not is_pack_id(f.get("pack")):
            _no()
        content_api = _int(f.get("contentApi"), 1)
        if _full_match(VERSION_PATTERN, f.get("minVersion")) is None:
            _no()
        if not isinstance(f.get("versionScheme"), str):
            _no()
        key = (f["pack"], content_api)
        if key in keys:
            _no()
        keys.add(key)
        # A forward scheme makes that entry alone ignored.
        if f["versionScheme"] not in VERSION_SCHEMES:
            continue
        out.append(
            {
                "pack": f["pack"],
                "contentApi": content_api,
                "minVersion": f["minVersion"],
                "versionScheme": f["versionScheme"],
            }
        )
    return out


def _parse_revocations(v: Any) -> List[Dict[str, Any]]:
    if not isinstance(v, list):
        _no()
    out: List[Dict[str, Any]] = []
    records = set()
    for e in v:
        if not isinstance(e, dict):
            _no()
        if _full_match(_SHA256_RE, e.get("record")) is None:
            _no()
        if not is_pack_id(e.get("pack")):
            _no()
        if _full_match(_SHA256_RE, e.get("target")) is None:
            _no()
        if _full_match(VERSION_PATTERN, e.get("version")) is None:
            _no()
        seq = _int(e.get("seq"), 1)
        if e["record"] in records:
            _no()
        records.add(e["record"])
        # plans/P4-19.md §2.7: `kind` absent (a pack record target) or `delegation`; any other
        # vocabulary token is a forward value whose entry is dropped alone; anything else makes
        # the member unusable.
        kind: Optional[str] = None
        if "kind" in e:
            if _full_match(VOCAB_TOKEN_PATTERN, e["kind"]) is None:
                _no()
            if e["kind"] != "delegation":
                continue
            kind = "delegation"
        entry: Dict[str, Any] = {
            "record": e["record"],
            "pack": e["pack"],
            "target": e["target"],
            "version": e["version"],
            "seq": seq,
        }
        if kind is not None:
            entry["kind"] = kind
        out.append(entry)
    return out


def _member(doc: Mapping[str, Any], key: str, parse: Callable[[Any], Any]) -> Any:
    if key not in doc:
        return None
    try:
        return parse(doc[key])
    except Exception:
        return None


def feed_content(doc: Any) -> FeedContent:
    """The feed's content members (plans/P4-13.md §2.2): ``packSets``, ``packFloors`` and
    ``revocations``, each parsed, or ``None`` when absent or unusable. ``doc`` is the verified
    payload (``ChannelFeedDoc.raw``). An unusable member never refuses the feed and never affects
    the other two. A ``packFloors`` entry whose ``versionScheme`` is not in
    ``FEED_VERSION_SCHEMES`` is dropped alone. Never raises."""
    if isinstance(doc, ChannelFeedDoc):
        doc = doc.raw
    if not isinstance(doc, dict):
        return FeedContent()
    return FeedContent(
        packSets=_member(doc, "packSets", lambda v: _parse_pack_sets(v, doc.get("selector"))),
        packFloors=_member(doc, "packFloors", _parse_pack_floors),
        revocations=_member(doc, "revocations", _parse_revocations),
    )


def with_feed_content(feed: ChannelFeedDoc, content: FeedContent) -> ChannelFeedDoc:
    """The feed as the decision reads it: ``feed`` with each content member of its payload
    replaced by ``content``'s parsed value, or removed when that is ``None``."""
    raw = {k: v for k, v in feed.raw.items() if k not in ("packSets", "packFloors", "revocations")}
    if content.packSets is not None:
        raw["packSets"] = content.packSets
    if content.packFloors is not None:
        raw["packFloors"] = content.packFloors
    if content.revocations is not None:
        raw["revocations"] = content.revocations
    return dataclasses.replace(feed, raw=raw)
