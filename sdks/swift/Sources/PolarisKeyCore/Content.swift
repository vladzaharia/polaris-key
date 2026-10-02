// P4-13's content members, holds and revocation records (plans/P4-13.md §2.2–§2.4;
// WIRE-CONTRACT-V4 §2.4.1, §2.5.2, §2.5.3), ported to Swift by P4-23.
//
// Every function here reads a member BESIDE the claims, never as a claim: an unusable member is
// nil and never refuses the feed or record, so a malformed content member cannot stop app
// updates. Integer members follow V4 §3.1's token rule at their RFC 6901 pointers (pass the
// verified payload's `nonWireIntegers`; an object you built has none). Unknown members are
// ignored at every level, and a parsed value carries the known members only. Nothing here throws
// out of its public functions. client-core's `feed.ts` (`feedContent`, `withFeedContent`),
// `packs/claims.ts` (`holdsOf`) and `record.ts` (`revocationOf`, `verifyRevocation`,
// `newerRevocation`) are the reference; `feedContentCases`, `revocationCases` and `stampCases`
// pin every verdict.

import Foundation

// ── The feed's content members (§2.2) ────────────────────────────────────────────────────────

/// `packSets.releases[h]`: one pack release the rows' sets name.
public struct FeedPackRelease: Sendable, Equatable {
    public let pack: String
    public let version: String
    public let seq: Int

    public init(pack: String, version: String, seq: Int) {
        self.pack = pack
        self.version = version
        self.seq = seq
    }

    public var json: JSONValue {
        .object(["pack": .string(pack), "version": .string(version), "seq": .int(seq)])
    }
}

/// `packSets.rows[]`: one group's row for a level, platform, engine and variant.
public struct FeedPackRow: Sendable, Equatable {
    public let contentApi: Int
    public let platform: String
    /// `""` or `godot-<major>.<minor>`.
    public let engine: String
    public let variant: [String: String]
    /// A key of `sets`.
    public let set: String

    public init(contentApi: Int, platform: String, engine: String, variant: [String: String], set: String) {
        self.contentApi = contentApi
        self.platform = platform
        self.engine = engine
        self.variant = variant
        self.set = set
    }

    public var json: JSONValue {
        .object([
            "contentApi": .int(contentApi), "platform": .string(platform), "engine": .string(engine),
            "variant": .object(variant.mapValues(JSONValue.string)), "set": .string(set),
        ])
    }
}

/// `packSets.outlets[id].gates[h]`: a per-outlet halt or rollout of one release.
public struct FeedPackGate: Sendable, Equatable {
    public let halted: Bool
    public let rollout: FeedRollout?
    /// A key of `releases`, or nil.
    public let fallback: String?

    public init(halted: Bool, rollout: FeedRollout?, fallback: String?) {
        self.halted = halted
        self.rollout = rollout
        self.fallback = fallback
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "halted": .bool(halted), "fallback": fallback.map(JSONValue.string) ?? .null,
        ]
        if let rollout { o["rollout"] = .object(["bp": .int(rollout.bp), "salt": .string(rollout.salt)]) }
        return .object(o)
    }
}

/// `packSets.outlets[id]`: the outlet's narrowing (`pinned`) and gates.
public struct FeedPackOutlet: Sendable, Equatable {
    public let pinned: [String]?
    public let gates: [String: FeedPackGate]?

    public init(pinned: [String]? = nil, gates: [String: FeedPackGate]? = nil) {
        self.pinned = pinned
        self.gates = gates
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = [:]
        if let pinned { o["pinned"] = .array(pinned.map(JSONValue.string)) }
        if let gates { o["gates"] = .object(gates.mapValues(\.json)) }
        return .object(o)
    }
}

/// The feed's `packSets` member.
public struct FeedPackSets: Sendable, Equatable {
    public let releases: [String: FeedPackRelease]
    /// `packSetId` → the record hashes of its members.
    public let sets: [String: [String]]
    public let rows: [FeedPackRow]
    public let outlets: [String: FeedPackOutlet]?

    public init(
        releases: [String: FeedPackRelease], sets: [String: [String]], rows: [FeedPackRow],
        outlets: [String: FeedPackOutlet]? = nil
    ) {
        self.releases = releases
        self.sets = sets
        self.rows = rows
        self.outlets = outlets
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "releases": .object(releases.mapValues(\.json)),
            "sets": .object(sets.mapValues { .array($0.map(JSONValue.string)) }),
            "rows": .array(rows.map(\.json)),
        ]
        if let outlets { o["outlets"] = .object(outlets.mapValues(\.json)) }
        return .object(o)
    }
}

/// One `packFloors` entry: the effective floor of a pack at a live level.
public struct FeedPackFloor: Sendable, Equatable {
    public let pack: String
    public let contentApi: Int
    public let minVersion: String
    public let versionScheme: String

    public init(pack: String, contentApi: Int, minVersion: String, versionScheme: String) {
        self.pack = pack
        self.contentApi = contentApi
        self.minVersion = minVersion
        self.versionScheme = versionScheme
    }

    public var json: JSONValue {
        .object([
            "pack": .string(pack), "contentApi": .int(contentApi), "minVersion": .string(minVersion),
            "versionScheme": .string(versionScheme),
        ])
    }
}

/// One `revocations` entry: a revocation record in force, by hash, and its target.
public struct FeedRevocation: Sendable, Equatable {
    /// The revocation record's hash.
    public let record: String
    public let pack: String
    /// The revoked pack record's hash.
    public let target: String
    /// The target's version and `seq`.
    public let version: String
    public let seq: Int

    public init(record: String, pack: String, target: String, version: String, seq: Int) {
        self.record = record
        self.pack = pack
        self.target = target
        self.version = version
        self.seq = seq
    }

    public var json: JSONValue {
        .object([
            "record": .string(record), "pack": .string(pack), "target": .string(target),
            "version": .string(version), "seq": .int(seq),
        ])
    }
}

/// `feedContent`'s answer: each member parsed, or nil when absent or unusable.
public struct FeedContent: Sendable, Equatable {
    public let packSets: FeedPackSets?
    public let packFloors: [FeedPackFloor]?
    public let revocations: [FeedRevocation]?

    public init(packSets: FeedPackSets?, packFloors: [FeedPackFloor]?, revocations: [FeedRevocation]?) {
        self.packSets = packSets
        self.packFloors = packFloors
        self.revocations = revocations
    }

    /// `{packSets, packFloors, revocations}`, each its value or `null` (`feedContentCases`'
    /// `expect.content`).
    public var json: JSONValue {
        .object([
            "packSets": packSets?.json ?? .null,
            "packFloors": packFloors.map { .array($0.map(\.json)) } ?? .null,
            "revocations": revocations.map { .array($0.map(\.json)) } ?? .null,
        ])
    }
}

/// A thrown marker for "this member is unusable", caught per member.
private struct Unusable: Error {}

private func need(_ ok: Bool) throws {
    if !ok { throw Unusable() }
}

/// An integer member at `pointer` by the token rule, else unusable.
private func int(_ v: JSONValue?, _ pointer: String, _ min: Int, _ nonWire: NonWireIntegers) throws -> Int {
    guard let i = v?.exactInt, wireInteger(i, pointer: pointer, min: min, in: nonWire) else {
        throw Unusable()
    }
    return i
}

private func string(_ v: JSONValue?, _ pattern: String) throws -> String {
    guard let s = v?.stringValue, packMatch(pattern, s) else { throw Unusable() }
    return s
}

private func sha256(_ v: JSONValue?) throws -> String {
    guard let s = v?.stringValue, isSha256Hex(s) else { throw Unusable() }
    return s
}

private func packId(_ v: JSONValue?) throws -> String {
    guard let s = v?.stringValue, isPackId(s) else { throw Unusable() }
    return s
}

private func parseVariant(_ v: JSONValue?) throws -> [String: String] {
    guard let sel = v?.objectValue, sel.count <= 4 else { throw Unusable() }
    var out: [String: String] = [:]
    for (name, value) in sel {
        try need(packMatch(PackPatterns.variantAxis, name))
        out[name] = try string(value, PackPatterns.variantValue)
    }
    return out
}

private func parsePackSets(
    _ v: JSONValue, selector: JSONValue?, nonWire: NonWireIntegers
) throws -> FeedPackSets {
    guard let ps = v.objectValue, ps["releases"] != nil, ps["sets"] != nil, ps["rows"] != nil else {
        throw Unusable()
    }

    guard let rawReleases = ps["releases"]?.objectValue else { throw Unusable() }
    var releases: [String: FeedPackRelease] = [:]
    for (h, r) in rawReleases {
        guard isSha256Hex(h), let rel = r.objectValue else { throw Unusable() }
        let pack = try packId(rel["pack"])
        let version = try string(rel["version"], PackPatterns.version)
        let seq = try int(rel["seq"], "/packSets/releases/\(h)/seq", 1, nonWire)
        releases[h] = FeedPackRelease(pack: pack, version: version, seq: seq)
    }

    guard let rawSets = ps["sets"]?.objectValue else { throw Unusable() }
    var sets: [String: [String]] = [:]
    for (id, members) in rawSets {
        guard isSha256Hex(id), let list = members.arrayValue else { throw Unusable() }
        var packs = Set<String>()
        var out: [String] = []
        for m in list {
            guard let h = m.stringValue, let rel = releases[h] else { throw Unusable() }
            try need(packs.insert(rel.pack).inserted)
            out.append(h)
        }
        sets[id] = out
    }

    guard let rawRows = ps["rows"]?.arrayValue else { throw Unusable() }
    let platform: JSONValue? = selector?.objectValue?["platform"]
    var rows: [FeedPackRow] = []
    var keys = Set<String>()
    for (i, r) in rawRows.enumerated() {
        guard let row = r.objectValue else { throw Unusable() }
        let contentApi = try int(row["contentApi"], "/packSets/rows/\(i)/contentApi", 1, nonWire)
        guard let p = row["platform"]?.stringValue, matchesWhole(FEED_PLATFORM_PATTERN, p) else {
            throw Unusable()
        }
        if let platform { try need(row["platform"] == platform) }
        guard let engine = row["engine"]?.stringValue,
            engine.isEmpty || packMatch(PackPatterns.engine, engine)
        else { throw Unusable() }
        let variant = try parseVariant(row["variant"])
        guard let set = row["set"]?.stringValue, sets[set] != nil else { throw Unusable() }
        // A separator no field can contain.
        let key = "\(contentApi)\u{0}\(p)\u{0}\(engine)\u{0}\(variantKey(variant))"
        try need(keys.insert(key).inserted)
        rows.append(FeedPackRow(contentApi: contentApi, platform: p, engine: engine, variant: variant, set: set))
    }

    var outlets: [String: FeedPackOutlet]?
    if let rawOutlets = ps["outlets"] {
        guard let o = rawOutlets.objectValue else { throw Unusable() }
        var parsed: [String: FeedPackOutlet] = [:]
        for (id, e) in o {
            guard matchesWhole(OUTLET_ID_PATTERN, id), let entry = e.objectValue else { throw Unusable() }
            var pinned: [String]?
            if let rawPinned = entry["pinned"] {
                guard let list = rawPinned.arrayValue else { throw Unusable() }
                var seen = Set<String>()
                var out: [String] = []
                for p in list {
                    let pack = try packId(p)
                    try need(seen.insert(pack).inserted)
                    out.append(pack)
                }
                pinned = out
            }
            var gates: [String: FeedPackGate]?
            if let rawGates = entry["gates"] {
                guard let g = rawGates.objectValue else { throw Unusable() }
                var out: [String: FeedPackGate] = [:]
                for (h, gv) in g {
                    guard releases[h] != nil, let gate = gv.objectValue,
                        let halted = gate["halted"]?.boolValue
                    else { throw Unusable() }
                    let at = "/packSets/outlets/\(pointerToken(id))/gates/\(h)"
                    var rollout: FeedRollout?
                    if let rawRollout = gate["rollout"] {
                        guard let ro = rawRollout.objectValue else { throw Unusable() }
                        let bp = try int(ro["bp"], "\(at)/rollout/bp", 0, nonWire)
                        try need(bp <= ROLLOUT_BUCKETS)
                        guard let salt = ro["salt"]?.stringValue, matchesWhole("[0-9a-f]{32}", salt) else {
                            throw Unusable()
                        }
                        rollout = FeedRollout(bp: bp, salt: salt)
                    }
                    guard let rawFallback = gate["fallback"] else { throw Unusable() }
                    var fallback: String?
                    if rawFallback != .null {
                        guard let f = rawFallback.stringValue, releases[f] != nil else { throw Unusable() }
                        fallback = f
                    }
                    out[h] = FeedPackGate(halted: halted, rollout: rollout, fallback: fallback)
                }
                gates = out
            }
            parsed[id] = FeedPackOutlet(pinned: pinned, gates: gates)
        }
        outlets = parsed
    }
    return FeedPackSets(releases: releases, sets: sets, rows: rows, outlets: outlets)
}

private func parsePackFloors(_ v: JSONValue, nonWire: NonWireIntegers) throws -> [FeedPackFloor] {
    guard let list = v.arrayValue else { throw Unusable() }
    var out: [FeedPackFloor] = []
    var keys = Set<String>()
    for (i, f) in list.enumerated() {
        guard let floor = f.objectValue else { throw Unusable() }
        let pack = try packId(floor["pack"])
        let contentApi = try int(floor["contentApi"], "/packFloors/\(i)/contentApi", 1, nonWire)
        let minVersion = try string(floor["minVersion"], PackPatterns.version)
        guard let scheme = floor["versionScheme"]?.stringValue else { throw Unusable() }
        try need(keys.insert("\(pack)\u{0}\(contentApi)").inserted)
        // A forward scheme makes that entry alone ignored.
        if !FEED_VERSION_SCHEMES.contains(scheme) { continue }
        out.append(FeedPackFloor(pack: pack, contentApi: contentApi, minVersion: minVersion, versionScheme: scheme))
    }
    return out
}

private func parseRevocations(_ v: JSONValue, nonWire: NonWireIntegers) throws -> [FeedRevocation] {
    guard let list = v.arrayValue else { throw Unusable() }
    var out: [FeedRevocation] = []
    var records = Set<String>()
    for (i, e) in list.enumerated() {
        guard let r = e.objectValue else { throw Unusable() }
        let record = try sha256(r["record"])
        let pack = try packId(r["pack"])
        let target = try sha256(r["target"])
        let version = try string(r["version"], PackPatterns.version)
        let seq = try int(r["seq"], "/revocations/\(i)/seq", 1, nonWire)
        try need(records.insert(record).inserted)
        out.append(FeedRevocation(record: record, pack: pack, target: target, version: version, seq: seq))
    }
    return out
}

private func member<T>(_ doc: [String: JSONValue], _ key: String, _ parse: (JSONValue) throws -> T) -> T? {
    guard let v = doc[key] else { return nil }
    return try? parse(v)
}

/// The feed's content members (plans/P4-13.md §2.2): `packSets`, `packFloors` and `revocations`,
/// each parsed, or nil when absent or unusable. Integer members follow V4 §3.1's token rule at
/// their RFC 6901 pointers (pass the verified payload's `nonWireIntegers`; omit when checking an
/// object you built). An unusable member never refuses the feed and never affects the other two.
/// A `packFloors` entry whose `versionScheme` is not in `FEED_VERSION_SCHEMES` is dropped alone.
public func feedContent(_ doc: JSONValue, nonWire: NonWireIntegers = []) -> FeedContent {
    guard let o = doc.objectValue else {
        return FeedContent(packSets: nil, packFloors: nil, revocations: nil)
    }
    return FeedContent(
        packSets: member(o, "packSets") { try parsePackSets($0, selector: o["selector"], nonWire: nonWire) },
        packFloors: member(o, "packFloors") { try parsePackFloors($0, nonWire: nonWire) },
        revocations: member(o, "revocations") { try parseRevocations($0, nonWire: nonWire) })
}

/// The feed as the decision reads it: `feed` with each content member replaced by `content`'s
/// parsed value, or removed when that is nil. `decideUpdate` re-reads the members from the
/// feed's own payload, so a caller holding a payload whose pointers it cannot carry hands it this
/// copy.
public func withFeedContent(_ feed: ChannelFeedDoc, _ content: FeedContent) -> ChannelFeedDoc {
    var o = feed.json.objectValue ?? [:]
    o["packSets"] = content.packSets?.json
    o["packFloors"] = content.packFloors.map { .array($0.map(\.json)) }
    o["revocations"] = content.revocations.map { .array($0.map(\.json)) }
    return ChannelFeedDoc(
        schemaVersion: feed.schemaVersion, iss: feed.iss, aud: feed.aud, channel: feed.channel,
        selectorPlatform: feed.selectorPlatform, seq: feed.seq, issuedAt: feed.issuedAt,
        expiresAt: feed.expiresAt, app: feed.app, json: .object(o))
}

// ── Holds (§2.4) ─────────────────────────────────────────────────────────────────────────────

/// One `content.holds` entry: a compatible pack held at an exact release.
public struct ContentHold: Sendable, Equatable {
    public let pack: String
    public let release: ReleasePin
    public let reason: String?

    public init(pack: String, release: ReleasePin, reason: String? = nil) {
        self.pack = pack
        self.release = release
        self.reason = reason
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["pack": .string(pack), "release": release.json]
        if let reason { o["reason"] = .string(reason) }
        return .object(o)
    }
}

/// The holds of an app record's `content` or a content stamp (plans/P4-13.md §2.4), read beside
/// the claims: `holds` absent reads `[]`; otherwise it must be an array of 0–256 entries, each
/// `{pack: a pack id, unique and not pinned, release {sha256, seq ≥ 1 by token, version},
/// reason?: string}`. Anything else reads nil (unusable: the device then takes no feed target for
/// any unpinned pack, decision 9). `pointer` is where the content object sits: `/content` in a
/// record, `""` in a stamp, for the token rule over `nonWire`.
public func holdsOf(
    _ content: JSONValue?, nonWire: NonWireIntegers = [], pointer: String = "/content"
) -> [ContentHold]? {
    guard let c = content?.objectValue else { return nil }
    guard let raw = c["holds"] else { return [] }
    guard let holds = raw.arrayValue, holds.count <= MAX_CONTENT_PINS else { return nil }
    var pinned = Set<String>()
    for p in c["pins"]?.arrayValue ?? [] {
        if let pack = p.objectValue?["pack"]?.stringValue { pinned.insert(pack) }
    }
    var seen = Set<String>()
    var out: [ContentHold] = []
    for (i, h) in holds.enumerated() {
        guard let o = h.objectValue, let pack = o["pack"]?.stringValue, isPackId(pack) else { return nil }
        if pinned.contains(pack) || !seen.insert(pack).inserted { return nil }
        guard let r = o["release"]?.objectValue, let sha = r["sha256"]?.stringValue, isSha256Hex(sha),
            let seq = r["seq"]?.exactInt,
            wireInteger(seq, pointer: "\(pointer)/holds/\(i)/release/seq", min: 1, in: nonWire),
            let version = r["version"]?.stringValue, packMatch(PackPatterns.version, version)
        else { return nil }
        var reason: String?
        if let rv = o["reason"] {
            guard let s = rv.stringValue else { return nil }
            reason = s
        }
        out.append(ContentHold(pack: pack, release: ReleasePin(sha256: sha, seq: seq, version: version), reason: reason))
    }
    return out
}

/// The holds of a content stamp file (plans/P4-13.md §2.4): strict JSON, then `holdsOf` at the
/// stamp's top level with its own non-wire pointers. `parseContentStamp`'s result is unchanged and
/// carries no holds; a host that runs the content decision reads them with this. Nil when the
/// stamp does not parse or its holds are unusable.
public func stampHolds(_ input: [UInt8]) -> [ContentHold]? {
    let data = Data(input)
    guard let nonWire = StrictJSON.validate(data),
        let value = try? JSONDecoder().decode(JSONValue.self, from: data)
    else { return nil }
    return holdsOf(value, nonWire: nonWire, pointer: "")
}

public func stampHolds(_ text: String) -> [ContentHold]? { stampHolds(Array(text.utf8)) }

// ── The revocation record (§2.3) ─────────────────────────────────────────────────────────────

/// A usable revocation body, as `revocationOf` reads it.
public struct RevocationBody: Sendable, Equatable {
    /// The revoked pack (the record's `deliverable`).
    public let pack: String
    /// The revoked pack record's hash (`revokes`).
    public let target: String
    public let replacement: ReleasePin?
    public let reason: String
    public let issuedAt: Int

    public init(pack: String, target: String, replacement: ReleasePin?, reason: String, issuedAt: Int) {
        self.pack = pack
        self.target = target
        self.replacement = replacement
        self.reason = reason
        self.issuedAt = issuedAt
    }

    /// `{pack, target, replacement, reason, issuedAt}` (`revocationCases`' `expect.revocation`).
    public var json: JSONValue {
        .object([
            "pack": .string(pack), "target": .string(target),
            "replacement": replacement?.json ?? .null, "reason": .string(reason),
            "issuedAt": .int(issuedAt),
        ])
    }
}

/// The revocation body (plans/P4-13.md §2.3), read beside the claims: usable when `kind` is
/// `revocation`, `deliverable` is a pack id, `revokes` is 64 lowercase hex, `replacement` is
/// absent or `{sha256: 64 hex and not revokes, seq: an integer ≥ 1 by token, version}`, and
/// `reason` is a string of 1–`REVOCATION_REASON_MAX_BYTES` bytes. `builds` and `content` are
/// ignored. Nil when unusable.
public func revocationOf(_ doc: JSONValue, nonWire: NonWireIntegers = []) -> RevocationBody? {
    guard let o = doc.objectValue, o["kind"]?.stringValue == "revocation",
        let pack = o["deliverable"]?.stringValue, isPackId(pack),
        let revokes = o["revokes"]?.stringValue, isSha256Hex(revokes)
    else { return nil }
    var replacement: ReleasePin?
    if let raw = o["replacement"] {
        guard let r = raw.objectValue, let sha = r["sha256"]?.stringValue, isSha256Hex(sha),
            sha != revokes, let seq = r["seq"]?.exactInt,
            wireInteger(seq, pointer: "/replacement/seq", min: 1, in: nonWire),
            let version = r["version"]?.stringValue, packMatch(PackPatterns.version, version)
        else { return nil }
        replacement = ReleasePin(sha256: sha, seq: seq, version: version)
    }
    guard let reason = o["reason"]?.stringValue else { return nil }
    let bytes = reason.utf8.count
    guard bytes >= 1, bytes <= REVOCATION_REASON_MAX_BYTES else { return nil }
    guard let issuedAt = o["issuedAt"]?.exactInt else { return nil }
    return RevocationBody(pack: pack, target: revokes, replacement: replacement, reason: reason, issuedAt: issuedAt)
}

/// What `newerRevocation` ranks: an `issuedAt` and a record hash.
public protocol RankedRevocation {
    var issuedAt: Int { get }
    var record: String { get }
}

/// A verified revocation: its body, its record hash and the pin it was verified with.
public struct VerifiedRevocation: Sendable, Equatable, RankedRevocation {
    public let pack: String
    public let target: String
    public let replacement: ReleasePin?
    public let reason: String
    public let issuedAt: Int
    /// The revocation record's hash.
    public let record: String
    /// The target's version and `seq` (the record's own `version` and `seq`).
    public let version: String
    public let seq: Int

    public init(
        pack: String, target: String, replacement: ReleasePin?, reason: String, issuedAt: Int,
        record: String, version: String, seq: Int
    ) {
        self.pack = pack
        self.target = target
        self.replacement = replacement
        self.reason = reason
        self.issuedAt = issuedAt
        self.record = record
        self.version = version
        self.seq = seq
    }

    public var body: RevocationBody {
        RevocationBody(pack: pack, target: target, replacement: replacement, reason: reason, issuedAt: issuedAt)
    }
}

public struct VerifyRevocationOptions: Sendable {
    /// The PINNED release keys only, never the Worker's trust set.
    public var releaseKeys: TrustSet
    /// The effective product trust set: a release key whose bytes are in it is refused.
    public var productTrust: TrustSet
    public var expectedAud: String
    /// The feed's `revocations` entry (or a stored entry's equivalent).
    public var entry: FeedRevocation

    public init(releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String, entry: FeedRevocation) {
        self.releaseKeys = releaseKeys
        self.productTrust = productTrust
        self.expectedAud = expectedAud
        self.entry = entry
    }
}

/// Why `verifyRevocation` refused, by step (`revocationCases` `expect.step`).
public enum RevocationStep: String, Sendable, Equatable, CaseIterable {
    case hash, jws, claims
    case crossCheck = "cross-check"
    case revocation
}

public enum VerifyRevocationResult: Sendable, Equatable {
    case ok(VerifiedRevocation)
    case refused(RevocationStep)

    public var revocation: VerifiedRevocation? {
        if case .ok(let r) = self { return r }
        return nil
    }

    public var step: RevocationStep? {
        if case .refused(let s) = self { return s }
        return nil
    }
}

/// Verify a revocation record against a feed entry (plans/P4-13.md §2.3): V4 §3.5 steps 12–14
/// with `entry.record` as the pin hash, step 15 with the pin `{kind: "revocation", deliverable:
/// entry.pack, version: entry.version, seq: entry.seq}`, and step 16 (`revocation`): the body is
/// usable (`revocationOf`) and `revokes == entry.target`.
public func verifyRevocation(_ jws: String, options opts: VerifyRevocationOptions) -> VerifyRevocationResult {
    let entry = opts.entry
    let r = verifyReleaseRecord(
        jws,
        options: VerifyReleaseRecordOptions(
            releaseKeys: opts.releaseKeys, productTrust: opts.productTrust,
            expectedAud: opts.expectedAud, expectedHash: entry.record,
            pin: ReleaseRecordPin(kind: "revocation", deliverable: entry.pack, version: entry.version, seq: entry.seq)))
    let record: ReleaseRecordDoc
    switch r {
    case .refused(let step): return .refused(RevocationStep(rawValue: step.rawValue)!)
    case .ok(let rec): record = rec
    }
    guard let body = revocationOf(record.json, nonWire: record.nonWireIntegers), body.target == entry.target
    else { return .refused(.revocation) }
    return .ok(
        VerifiedRevocation(
            pack: body.pack, target: body.target, replacement: body.replacement, reason: body.reason,
            issuedAt: body.issuedAt, record: entry.record, version: record.version, seq: record.seq))
}

/// The winner of two verified revocations of one target (plans/P4-13.md §2.3, decision 18): the
/// higher `issuedAt`, else the higher record hash by bytes. The Worker ranks superseding
/// revocations with this same function. Revocations are permanent: superseding changes the
/// replacement or reason, never the revoked status.
public func newerRevocation<T: RankedRevocation>(_ a: T, _ b: T) -> T {
    if a.issuedAt != b.issuedAt { return a.issuedAt > b.issuedAt ? a : b }
    return compareUTF8Bytes(a.record, b.record) >= 0 ? a : b
}
