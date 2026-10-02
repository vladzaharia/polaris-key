// The content decision — plans/P4-13.md §2.6 (WIRE-CONTRACT-V4 §11.1), ported to Swift by P4-23.
//
// With `UpdateDecisionInput.content`, P3-01's app answer is refined by the pack composition
// (pins, holds, the feed's rows after the outlet's narrowing and gates, stored revocations and
// their usable replacements), the content blocks (`revoked-content` for a REQUIRED pack revoked
// without a fix; `content-floor` for a pack below its floor), `prestage` on a `binary` offer, and
// the `packs` answer. Pure and synchronous: the caller does every fetch, hash and signature
// check. client-core's `decide.ts` is the reference; `update-matrix.json#/contentRows` pins every
// rule.

import Foundation

// ── Inputs and outputs ───────────────────────────────────────────────────────────────────────

/// A pack and an exact release: a `packs` answer's `install` entry, a `prestage` entry, and a
/// content stamp's pin.
public struct PackTarget: Sendable, Equatable, Hashable {
    public let pack: String
    public let release: ReleasePin

    public init(pack: String, release: ReleasePin) {
        self.pack = pack
        self.release = release
    }

    public var json: JSONValue { .object(["pack": .string(pack), "release": release.json]) }
}

/// One entry of a `packs` answer's `set`: the effective release of a pack.
public struct PackSetMember: Sendable, Equatable, Hashable {
    public let pack: String
    public let sha256: String

    public init(pack: String, sha256: String) {
        self.pack = pack
        self.sha256 = sha256
    }

    public var json: JSONValue { .object(["pack": .string(pack), "sha256": .string(sha256)]) }
}

/// One `expects` entry of a content stamp.
public struct ContentExpectation: Sendable, Equatable {
    public let pack: String
    public let required: Bool
    public let delivery: String

    public init(pack: String, required: Bool, delivery: String) {
        self.pack = pack
        self.required = required
        self.delivery = delivery
    }
}

/// The running build's content stamp as the decision reads it, with its holds (`holdsOf`; nil
/// when unusable).
public struct UpdateContentStamp: Sendable, Equatable {
    public let contentApi: Int
    public let pins: [PackTarget]
    public let expects: [ContentExpectation]
    public let holds: [ContentHold]?

    public init(contentApi: Int, pins: [PackTarget], expects: [ContentExpectation], holds: [ContentHold]?) {
        self.contentApi = contentApi
        self.pins = pins
        self.expects = expects
        self.holds = holds
    }
}

/// One stored, verified revocation (the winner of `newerRevocation` for its target).
public struct ContentRevocationInput: Sendable, Equatable {
    public let target: String
    public let pack: String
    public let replacement: ReleasePin?
    /// False while a replacement is still unfetched (§2.5 step 12 retries it).
    public let replacementUsable: Bool

    public init(target: String, pack: String, replacement: ReleasePin?, replacementUsable: Bool) {
        self.target = target
        self.pack = pack
        self.replacement = replacement
        self.replacementUsable = replacementUsable
    }
}

/// `UpdateDecisionInput.content` (plans/P4-13.md §2.6 "Input").
public struct UpdateContentInput: Sendable, Equatable {
    public let stamp: UpdateContentStamp
    /// The pack state's active installs, embedded baselines included, by pack id.
    public let active: [String: ReleasePin]
    /// The host's variant preferences, per axis.
    public let axes: [String: [String]]
    public let revocations: [ContentRevocationInput]
    /// The rollout bucket of every gate salt; nil for a host that computed none.
    public let buckets: [String: Int?]

    public init(
        stamp: UpdateContentStamp, active: [String: ReleasePin], axes: [String: [String]],
        revocations: [ContentRevocationInput], buckets: [String: Int?]
    ) {
        self.stamp = stamp
        self.active = active
        self.axes = axes
        self.revocations = revocations
        self.buckets = buckets
    }

    /// The decoded form (`update-matrix.json#/contentRows/*/input/content`), or nil when a member
    /// is missing or mistyped. Shape only.
    public init?(json: JSONValue) {
        func pin(_ v: JSONValue?) -> ReleasePin? {
            guard let o = v?.objectValue, let sha = o["sha256"]?.stringValue, let seq = o["seq"]?.exactInt,
                let version = o["version"]?.stringValue
            else { return nil }
            return ReleasePin(sha256: sha, seq: seq, version: version)
        }
        guard let o = json.objectValue, let s = o["stamp"]?.objectValue,
            let contentApi = s["contentApi"]?.exactInt, let rawPins = s["pins"]?.arrayValue,
            let rawExpects = s["expects"]?.arrayValue, let rawActive = o["active"]?.objectValue,
            let rawAxes = o["axes"]?.objectValue, let rawRevs = o["revocations"]?.arrayValue,
            let rawBuckets = o["buckets"]?.objectValue
        else { return nil }
        var pins: [PackTarget] = []
        for p in rawPins {
            guard let po = p.objectValue, let pack = po["pack"]?.stringValue, let r = pin(po["release"]) else {
                return nil
            }
            pins.append(PackTarget(pack: pack, release: r))
        }
        var expects: [ContentExpectation] = []
        for e in rawExpects {
            guard let eo = e.objectValue, let pack = eo["pack"]?.stringValue,
                let required = eo["required"]?.boolValue, let delivery = eo["delivery"]?.stringValue
            else { return nil }
            expects.append(ContentExpectation(pack: pack, required: required, delivery: delivery))
        }
        var holds: [ContentHold]? = []
        switch s["holds"] {
        case nil: holds = []
        case .null?: holds = nil
        case .array(let list)?:
            var out: [ContentHold] = []
            for h in list {
                guard let ho = h.objectValue, let pack = ho["pack"]?.stringValue, let r = pin(ho["release"])
                else { return nil }
                out.append(ContentHold(pack: pack, release: r, reason: ho["reason"]?.stringValue))
            }
            holds = out
        default: return nil
        }
        var active: [String: ReleasePin] = [:]
        for (k, v) in rawActive {
            guard let p = pin(v) else { return nil }
            active[k] = p
        }
        var axes: [String: [String]] = [:]
        for (k, v) in rawAxes {
            guard let list = v.arrayValue else { return nil }
            axes[k] = list.compactMap(\.stringValue)
        }
        var revs: [ContentRevocationInput] = []
        for r in rawRevs {
            guard let ro = r.objectValue, let target = ro["target"]?.stringValue,
                let pack = ro["pack"]?.stringValue, let usable = ro["replacementUsable"]?.boolValue
            else { return nil }
            var replacement: ReleasePin?
            if let rep = ro["replacement"], rep != .null {
                guard let p = pin(rep) else { return nil }
                replacement = p
            }
            revs.append(ContentRevocationInput(target: target, pack: pack, replacement: replacement, replacementUsable: usable))
        }
        var buckets: [String: Int?] = [:]
        for (k, v) in rawBuckets { buckets[k] = .some(v.exactInt) }
        self.init(
            stamp: UpdateContentStamp(contentApi: contentApi, pins: pins, expects: expects, holds: holds),
            active: active, axes: axes, revocations: revs, buckets: buckets)
    }
}

// ── Row selection (§2.6 steps 1–4) ───────────────────────────────────────────────────────────

/// Row selection (plans/P4-13.md §2.6 steps 1–4): the candidate rows of `packSets` at
/// (`contentApi`, `platform`) whose `engine` equals `engine` exactly (no fallback to `""`),
/// grouped by their sorted axis names; in each group the row `selectVariant`'s rule picks (every
/// axis in `axes`, the lowest tuple of preference indexes over axis names in byte order). Returns
/// the feed target per pack: the record hash the selected rows' sets name, with a pack named by
/// two selected rows left out.
public func selectPackRows(
    _ packSets: FeedPackSets, contentApi: Int, platform: String, engine: String,
    axes: [String: [String]]
) -> [String: String] {
    var groups: [String: (set: String, key: [Int])] = [:]
    for row in packSets.rows {
        guard row.contentApi == contentApi, row.platform == platform, row.engine == engine else { continue }
        let names = row.variant.keys.sorted { compareUTF8Bytes($0, $1) < 0 }
        var key: [Int] = []
        var eligible = true
        for axis in names {
            guard let list = axes[axis], let k = list.firstIndex(of: row.variant[axis]!) else {
                eligible = false
                break
            }
            key.append(k)
        }
        if !eligible { continue }
        let group = names.joined(separator: "\u{0}")
        if let best = groups[group], !key.lexicographicallyPrecedes(best.key) { continue }
        groups[group] = (row.set, key)
    }
    var targets: [String: String] = [:]
    var twice = Set<String>()
    for (_, g) in groups {
        for h in packSets.sets[g.set] ?? [] {
            guard let rel = packSets.releases[h] else { continue }
            if targets[rel.pack] != nil { twice.insert(rel.pack) }
            targets[rel.pack] = h
        }
    }
    for p in twice { targets[p] = nil }
    return targets
}

// ── The composition ──────────────────────────────────────────────────────────────────────────

private struct Composition {
    var install: [PackTarget] = []
    var revoke: [String] = []
    var set: [PackSetMember] = []
    /// A required pack is revoked without a fix.
    var revokedRequired = false
    /// Some pack is below its floor.
    var floor = false
}

private struct ContentEnv {
    let content: UpdateContentInput
    /// The parsed `packSets`, or nil (absent, unusable, or treated as absent).
    let packSets: FeedPackSets?
    let floors: [FeedPackFloor]
    /// The outlet's narrowing and gates.
    let pinned: Set<String>
    let gates: [String: FeedPackGate]
    let dataUpdates: Bool
    let platform: String
    let engine: String

    var revoked: [String: ContentRevocationInput] {
        var out: [String: ContentRevocationInput] = [:]
        for r in content.revocations { out[r.target] = r }
        return out
    }
}

/// The feed targets at one level, after the outlet's narrowing and gates (§2.6 step 5).
private func feedTargets(_ env: ContentEnv, _ contentApi: Int, _ engine: String) -> [String: ReleasePin] {
    guard let sets = env.packSets else { return [:] }
    var out: [String: ReleasePin] = [:]
    let targets = selectPackRows(
        sets, contentApi: contentApi, platform: env.platform, engine: engine, axes: env.content.axes)
    for (pack, h0) in targets {
        if env.pinned.contains(pack) { continue }
        var h: String? = h0
        if let gate = env.gates[h0] {
            var out_ = gate.halted
            if !out_, let rollout = gate.rollout {
                let b: Int? = env.content.buckets[rollout.salt] ?? nil
                out_ = !(b.map { $0 < rollout.bp } ?? false)
            }
            if out_ { h = gate.fallback }
        }
        if let h, let r = sets.releases[h] { out[pack] = ReleasePin(sha256: h, seq: r.seq, version: r.version) }
    }
    return out
}

/// `rep(x)`: x when it is not revoked; else the revocation's replacement when usable, not itself
/// revoked, data updates are allowed and the pack is not narrowed; else nil.
private func replacementOf(
    _ x: ReleasePin?, _ revoked: [String: ContentRevocationInput], _ env: ContentEnv, narrowed: Bool
) -> ReleasePin? {
    guard let x else { return nil }
    guard let r = revoked[x.sha256] else { return x }
    if r.replacementUsable, let rep = r.replacement, revoked[rep.sha256] == nil, env.dataUpdates, !narrowed {
        return rep
    }
    return nil
}

/// The pack composition (§2.6 "Composition, per pack p").
private func compose(_ env: ContentEnv) -> Composition {
    let content = env.content
    let stamp = content.stamp
    let L = stamp.contentApi
    let revoked = env.revoked
    func isRevoked(_ x: ReleasePin?) -> Bool { x.map { revoked[$0.sha256] != nil } ?? false }

    var pins: [String: ReleasePin] = [:]
    for p in stamp.pins { pins[p.pack] = p.release }
    var holds: [String: ReleasePin] = [:]
    for h in stamp.holds ?? [] { holds[h.pack] = h.release }
    var required = Set<String>()
    var essential = Set<String>()
    for e in stamp.expects {
        if e.required { required.insert(e.pack) }
        if e.delivery == "essential" { essential.insert(e.pack) }
    }
    let active = content.active
    let targets = feedTargets(env, L, env.engine)

    var known = Set<String>()
    known.formUnion(pins.keys)
    known.formUnion(holds.keys)
    known.formUnion(stamp.expects.map(\.pack))
    known.formUnion(active.keys)
    known.formUnion(targets.keys)

    var out = Composition()
    for p in known.sorted(by: { compareUTF8Bytes($0, $1) < 0 }) {
        let narrowed = env.pinned.contains(p)
        let base: ReleasePin?
        if let pin = pins[p] {
            base = pin
        } else if let hold = holds[p] {
            base = hold
        } else if narrowed || stamp.holds == nil || !env.dataUpdates || env.packSets == nil {
            base = nil
        } else {
            base = targets[p]
        }

        let act = active[p]
        var cand = replacementOf(base, revoked, env, narrowed: narrowed)
        if cand == nil, isRevoked(act) { cand = replacementOf(act, revoked, env, narrowed: narrowed) }

        let wanted = act != nil || required.contains(p) || essential.contains(p)
        var install = false
        if let c = cand, c.sha256 != act?.sha256, wanted {
            install = pins[p] != nil || holds[p] != nil || act == nil || isRevoked(act) || c.seq > act!.seq
        }
        if install { out.install.append(PackTarget(pack: p, release: cand!)) }
        let eff: ReleasePin? = install ? cand : (act != nil && !isRevoked(act) ? act : cand)
        if let eff { out.set.append(PackSetMember(pack: p, sha256: eff.sha256)) }

        let noFix = cand == nil && (isRevoked(act) || (isRevoked(base) && act == nil))
        if noFix && required.contains(p) { out.revokedRequired = true }
        if noFix && !required.contains(p) && act != nil { out.revoke.append(p) }

        if !noFix && (act != nil || required.contains(p)) {
            if let f = env.floors.first(where: { $0.pack == p && $0.contentApi == L }) {
                let c = eff.flatMap { compareVersions(f.versionScheme, $0.version, f.minVersion) }
                if c == nil || c! < 0 { out.floor = true }
            }
        }
    }
    return out
}

/// §2.6 "Prestage": the new level's required and essential packs, minus the build's embeds.
private func prestageOf(_ env: ContentEnv, _ input: UpdateDecisionInput, buildId: String) -> [PackTarget] {
    guard let record = input.record, let rc = record.json.objectValue?["content"]?.objectValue,
        let L2 = rc["contentApi"]?.exactInt, L2 != env.content.stamp.contentApi
    else { return [] }
    let rawBuild = (record.json.objectValue?["builds"]?.arrayValue ?? [])
        .compactMap(\.objectValue).first { $0["id"]?.stringValue == buildId }
    let embeds = Set((rawBuild?["embeds"]?.arrayValue ?? []).compactMap(\.stringValue))
    let engine = rawBuild?["requires"]?.objectValue?["engine"]?.stringValue ?? env.engine
    let revoked = env.revoked

    var pins: [String: ReleasePin] = [:]
    for p in rc["pins"]?.arrayValue ?? [] {
        guard let po = p.objectValue, let pack = po["pack"]?.stringValue, let r = po["release"]?.objectValue,
            let sha = r["sha256"]?.stringValue, let seq = r["seq"]?.exactInt, let v = r["version"]?.stringValue
        else { continue }
        pins[pack] = ReleasePin(sha256: sha, seq: seq, version: v)
    }
    let recordHolds = holdsOf(.object(rc), nonWire: record.nonWireIntegers, pointer: "/content")
    var holds: [String: ReleasePin] = [:]
    for h in recordHolds ?? [] { holds[h.pack] = h.release }
    let targets = recordHolds == nil || !env.dataUpdates ? [:] : feedTargets(env, L2, engine)
    let active = env.content.active

    var out: [PackTarget] = []
    for e in rc["expects"]?.arrayValue ?? [] {
        guard let eo = e.objectValue, let p = eo["pack"]?.stringValue else { continue }
        let required = eo["required"]?.boolValue == true
        if !(required || eo["delivery"]?.stringValue == "essential") || embeds.contains(p) { continue }
        let narrowed = env.pinned.contains(p)
        guard let release = replacementOf(pins[p] ?? holds[p] ?? targets[p], revoked, env, narrowed: narrowed)
        else { continue }
        if let act = active[p], act.sha256 == release.sha256 { continue }
        out.append(PackTarget(pack: p, release: release))
    }
    return out.sorted { compareUTF8Bytes($0.pack, $1.pack) < 0 }
}

/// The key of the install's entry in a target (`outletEntry`'s rule), or nil.
private func outletEntryId(_ target: FeedTarget?, _ outlet: UpdateOutlet) -> String? {
    guard let target, outlet.kind != OUTLET_UNKNOWN else { return nil }
    if let id = outlet.id, let byId = target.outlets[id], byId.kind == outlet.kind { return id }
    let ofKind = target.outlets.filter { $0.value.kind == outlet.kind }
    return ofKind.count == 1 ? ofKind.first!.key : nil
}

/// §2.6 "Order": the content refinement of P3-01's answer `app`.
func decideContent(
    _ input: UpdateDecisionInput, _ content: UpdateContentInput, _ app: UpdateDecision
) -> UpdateDecision {
    let feed = input.feed
    let target = feedTarget(feed.app.targets, platform: input.installed.platform)
    let entry = outletEntry(target, outlet: input.outlet)
    let entryId = outletEntryId(target, input.outlet)
    let caps = effectiveCapabilities(
        input.outlet.kind, platform: input.installed.platform, subkind: input.subkind,
        server: entry?.capabilities)
    let fc = feedContent(feed.json, nonWire: feed.nonWireIntegers)
    let outlet: FeedPackOutlet? = entryId.flatMap { fc.packSets?.outlets?[$0] }
    func env(_ packSets: FeedPackSets?) -> ContentEnv {
        ContentEnv(
            content: content, packSets: packSets, floors: fc.packFloors ?? [],
            pinned: Set(packSets != nil ? (outlet?.pinned ?? []) : []),
            gates: packSets != nil ? (outlet?.gates ?? [:]) : [:], dataUpdates: caps.dataUpdates,
            platform: input.installed.platform, engine: input.installed.engine ?? "")
    }
    let discard = input.staged != nil

    // 1. Stale or unknown version: only revoked required content can change the answer.
    if case .none(let reason, _, _) = app,
        reason == UpdateNoneReason.stale || reason == UpdateNoneReason.unknownVersion
    {
        if compose(env(nil)).revokedRequired {
            return .blocked(reason: UpdateBlockedReason.revokedContent, discardStaged: discard)
        }
        return app
    }

    let full = env(fc.packSets)
    let c = compose(full)
    let block: String? =
        c.revokedRequired
        ? UpdateBlockedReason.revokedContent : c.floor ? UpdateBlockedReason.contentFloor : nil

    switch app {
    // 2. The app floor.
    case .blocked(let reason, let d, _):
        return block == nil ? app : .blocked(reason: reason, discardStaged: d, contentBlock: block)
    // 3. Offers.
    case .binary(let method, let release, let build, let mandatory, let critical, _, let d, _):
        let prestage = prestageOf(full, input, buildId: build)
        // A content block makes the offer mandatory; a binary supersedes content otherwise.
        return .binary(
            method: method, release: release, build: build, mandatory: block != nil || mandatory,
            critical: critical, prestage: prestage, discardStaged: d, contentBlock: block)
    case .store(let release, let listingUrl, let mandatory, let critical, let d, _):
        if let block {
            return .store(
                release: release, listingUrl: listingUrl, mandatory: true, critical: critical,
                discardStaged: d, contentBlock: block)
        }
        if mandatory { return app }
    case .platform(let release, let mandatory, let critical, let d, _):
        if let block {
            return .platform(
                release: release, mandatory: true, critical: critical, discardStaged: d, contentBlock: block)
        }
        if mandatory { return app }
    default:
        break
    }

    // 4. A content block.
    if let block { return .blocked(reason: block, discardStaged: discard) }

    // 5. code-ready.
    if case .codeReady = app { return app }

    // 6. packs.
    if caps.dataUpdates && (!c.install.isEmpty || !c.revoke.isEmpty) {
        return .packs(install: c.install, revoke: c.revoke, set: c.set, discardStaged: discard)
    }

    // 7. Otherwise P3-01's answer.
    return app
}
