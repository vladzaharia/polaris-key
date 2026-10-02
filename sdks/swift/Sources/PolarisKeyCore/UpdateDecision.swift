// The update decision — plans/P3-01.md §2.8 and §2.9 (WIRE-CONTRACT-V4 §11, informative).
//
// A pure, synchronous `decideUpdate` over the verified feed and record, the installed build, the
// outlet and the host's methods, with the pieces every SDK builds its inputs from: the rollout
// bucket, the effective capabilities and the outlet resolution. `update-matrix.json` pins every
// function here, row for row (`UpdateMatrixTests`), and `outlet-matrix.json` pins the compiled
// tables. client-core's `decide.ts` is the reference; this is an independent port.
//
// Nothing here imports Sparkle or sits behind `#if os(macOS)`: an iOS app (App Store, TestFlight,
// a marketplace) is a "decide only" host and needs exactly this. Nothing here does I/O or throws.

import CryptoKit
import Foundation

// ── The compiled tables (§2.9; `outlet-matrix.json#/kinds`, `#/platformNarrowing`, …) ─────────

/// The six capability fields of an install (P2b-01's `OutletCapabilities`).
public struct OutletCapabilities: Sendable, Equatable {
    /// `none`, `store` or `self`: who installs a new build.
    public var binaryUpdates: String
    public var codeUpdates: Bool
    public var dataUpdates: Bool
    public var channelSwitch: Bool
    /// `own`, `store-iap`, `steam` or `none`.
    public var commerce: String
    public var downloadedScripts: Bool

    public init(
        binaryUpdates: String, codeUpdates: Bool, dataUpdates: Bool, channelSwitch: Bool,
        commerce: String, downloadedScripts: Bool
    ) {
        self.binaryUpdates = binaryUpdates
        self.codeUpdates = codeUpdates
        self.dataUpdates = dataUpdates
        self.channelSwitch = channelSwitch
        self.commerce = commerce
        self.downloadedScripts = downloadedScripts
    }

    /// The six fields as a JSON object, as the matrices spell them.
    public var json: JSONValue {
        .object([
            "binaryUpdates": .string(binaryUpdates), "codeUpdates": .bool(codeUpdates),
            "dataUpdates": .bool(dataUpdates), "channelSwitch": .bool(channelSwitch),
            "commerce": .string(commerce), "downloadedScripts": .bool(downloadedScripts),
        ])
    }
}

private func caps(
    _ binary: String, _ code: Bool, _ data: Bool, _ channel: Bool, _ commerce: String,
    _ scripts: Bool
) -> OutletCapabilities {
    OutletCapabilities(
        binaryUpdates: binary, codeUpdates: code, dataUpdates: data, channelSwitch: channel,
        commerce: commerce, downloadedScripts: scripts)
}

/// The capability defaults per outlet kind (§2.9), `unknown` included: the ceiling every
/// narrowing starts from. Equal to `outlet-matrix.json#/kinds` by test.
public let OUTLET_CAPABILITY_DEFAULTS: [String: OutletCapabilities] = [
    "direct": caps("self", true, true, true, "own", true),
    "app-store": caps("store", false, true, false, "store-iap", false),
    "testflight": caps("store", false, true, false, "store-iap", false),
    "altstore": caps("store", false, true, false, "own", false),
    "altstore-pal": caps("store", false, true, false, "own", false),
    "play": caps("store", false, true, false, "store-iap", false),
    "play-testing": caps("store", false, true, false, "store-iap", false),
    "obtainium": caps("store", false, true, false, "own", false),
    "fdroid-repo": caps("store", false, true, false, "own", false),
    "ms-store": caps("store", false, true, false, "store-iap", false),
    "app-installer": caps("none", false, true, false, "own", false),
    "steam": caps("none", false, true, false, "steam", false),
    "itch": caps("none", false, true, false, "own", false),
    "flathub": caps("none", false, true, false, "own", false),
    "snap": caps("none", false, true, false, "own", false),
    "winget": caps("none", false, true, false, "own", false),
    "web": caps("none", false, true, false, "own", true),
    "unknown": caps("none", false, false, false, "none", false),
]

/// The platforms each kind serves (`outlet-matrix.json#/kinds/*/platforms`). `unknown` is every
/// platform.
public let OUTLET_PLATFORMS: [String: [String]] = [
    "direct": ["macos", "windows", "linux", "android", "ios"],
    "app-store": ["ios", "macos"],
    "testflight": ["ios", "macos"],
    "altstore": ["ios"],
    "altstore-pal": ["ios"],
    "play": ["android"],
    "play-testing": ["android"],
    "obtainium": ["android"],
    "fdroid-repo": ["android"],
    "ms-store": ["windows"],
    "app-installer": ["windows"],
    "steam": ["windows", "macos", "linux"],
    "itch": ["windows", "macos", "linux"],
    "flathub": ["linux"],
    "snap": ["linux"],
    "winget": ["windows"],
    "web": ["web"],
    "unknown": ["macos", "ios", "android", "windows", "linux", "web"],
]

/// Per platform, per kind: a narrowing applied before the subkind's and the feed's. On `ios`,
/// `direct` (Web Distribution) neither installs itself nor loads code (§2.9).
public let PLATFORM_NARROWING: [String: [String: [String: JSONValue]]] = [
    "ios": [
        "direct": [
            "binaryUpdates": .string("store"), "codeUpdates": .bool(false),
            "downloadedScripts": .bool(false),
        ]
    ]
]

private let PACKAGE_MANAGED: [String: JSONValue] = [
    "binaryUpdates": .string("none"), "codeUpdates": .bool(false),
]

/// How a `direct` install was put on the device narrows who updates it (S-06 notes b and c).
public let SUBKIND_NARROWING: [String: [String: JSONValue]] = [
    "homebrew": PACKAGE_MANAGED, "npm": PACKAGE_MANAGED, "pnpm": PACKAGE_MANAGED,
    "npx": PACKAGE_MANAGED, "scoop": PACKAGE_MANAGED, "chocolatey": PACKAGE_MANAGED,
    "flatpak": PACKAGE_MANAGED, "appimage": [:],
]

/// The prefixes a feed's `listingUrl` may start with, byte for byte, per kind. A kind not listed
/// carries no `listingUrl` (§2.9).
public let LISTING_URL_PREFIXES: [String: [String]] = [
    "app-store": ["https://apps.apple.com/", "itms-apps://apps.apple.com/"],
    "testflight": ["https://testflight.apple.com/join/"],
    "play": ["https://play.google.com/store/apps/details?id=", "market://details?id="],
    "play-testing": [
        "https://play.google.com/apps/testing/", "https://play.google.com/store/apps/details?id=",
        "market://details?id=",
    ],
    "ms-store": ["https://apps.microsoft.com/detail/", "ms-windows-store://pdp/?productid="],
]

// ── The rollout bucket (§2.8 "Bucket") ────────────────────────────────────────────────────────

/// `u32_be(SHA-256(UTF-8(salt) ‖ UTF-8(installId))[0..4]) mod 10000`: the feed's 32-character hex
/// salt hashed as text, then the SDK's device id (the value it sends as `X-PKey-Device`), with no
/// separator; the first four digest bytes read big-endian as an UNSIGNED integer. The device is
/// inside a rollout iff the bucket is below `bp` (`update-matrix.json#/bucketVectors`).
public func rolloutBucket(salt: String, installId: String) -> Int {
    let digest = Array(SHA256.hash(data: Data((salt + installId).utf8)))
    let u32 = UInt32(digest[0]) << 24 | UInt32(digest[1]) << 16 | UInt32(digest[2]) << 8
        | UInt32(digest[3])
    return Int(u32 % UInt32(ROLLOUT_BUCKETS))
}

// ── Capabilities (§2.9 "Narrowing") ───────────────────────────────────────────────────────────

/// Apply one narrowing: booleans AND, `binaryUpdates` the narrower of `none` < `store` < `self`,
/// `commerce` only ever to `none`. A value outside its vocabulary is ignored; nothing widens.
private func narrow(_ caps: OutletCapabilities, _ n: [String: JSONValue]?) -> OutletCapabilities {
    guard let n else { return caps }
    var out = caps
    if let b = n["codeUpdates"]?.boolValue { out.codeUpdates = out.codeUpdates && b }
    if let b = n["dataUpdates"]?.boolValue { out.dataUpdates = out.dataUpdates && b }
    if let b = n["channelSwitch"]?.boolValue { out.channelSwitch = out.channelSwitch && b }
    if let b = n["downloadedScripts"]?.boolValue {
        out.downloadedScripts = out.downloadedScripts && b
    }
    if let b = n["binaryUpdates"]?.stringValue, let k = BINARY_UPDATES_ORDER.firstIndex(of: b),
        let current = BINARY_UPDATES_ORDER.firstIndex(of: out.binaryUpdates), k < current
    {
        out.binaryUpdates = BINARY_UPDATES_ORDER[k]
    }
    if n["commerce"]?.stringValue == "none" { out.commerce = "none" }
    return out
}

/// The capabilities of an install: the compiled defaults for its outlet kind (`unknown` for a
/// kind outside the 17), narrowed by the platform, then the subkind, then the feed entry's
/// `capabilities` (`server`). The defaults are the ceiling (`update-matrix.json#/capabilityCases`).
public func effectiveCapabilities(
    _ kind: String, platform: String, subkind: String? = nil, server: [String: JSONValue]? = nil
) -> OutletCapabilities {
    var out = OUTLET_CAPABILITY_DEFAULTS[kind] ?? OUTLET_CAPABILITY_DEFAULTS[OUTLET_UNKNOWN]!
    out = narrow(out, PLATFORM_NARROWING[platform]?[kind])
    if let subkind { out = narrow(out, SUBKIND_NARROWING[subkind]) }
    return narrow(out, server)
}

// ── The decision's outlet (§2.8 "The outlet") ────────────────────────────────────────────────

/// A host's outlet option: a bare kind (`.kind("steam")` reads as `{id: "steam", kind: "steam"}`),
/// or the product's outlet id with its kind.
public enum HostOutlet: Sendable, Equatable {
    case kind(String)
    case outlet(id: String, kind: String, subkind: String? = nil)
}

/// The build stamp's outlet fields (P1-11; the v4 fields of plans/P3-01.md §8). `outletIds` are
/// the product's outlet identities, which outlet detection (`detectOutlet`) compares launcher
/// signals against; `resolveUpdateOutlet` does not read them.
public struct OutletStamp: Sendable, Equatable {
    public var outlet: String?
    public var outletKind: String?
    public var outletSubkind: String?
    public var outletIds: [String: String]

    public init(
        outlet: String? = nil, outletKind: String? = nil, outletSubkind: String? = nil,
        outletIds: [String: String] = [:]
    ) {
        self.outlet = outlet
        self.outletKind = outletKind
        self.outletSubkind = outletSubkind
        self.outletIds = outletIds
    }
}

/// A detection result (P3-11's `detectOutlet`).
public struct DetectedOutlet: Sendable, Equatable {
    /// One of the 17 kinds, or `unknown`.
    public var kind: String
    public var confidence: String?
    public var source: String?
    public var subkind: String?

    public init(kind: String, confidence: String? = nil, source: String? = nil, subkind: String? = nil) {
        self.kind = kind
        self.confidence = confidence
        self.source = source
        self.subkind = subkind
    }
}

/// The decision's outlet: the product's outlet id (nil when unknown) and its kind.
public struct UpdateOutlet: Sendable, Equatable {
    public var id: String?
    public var kind: String

    public init(id: String?, kind: String) {
        self.id = id
        self.kind = kind
    }
}

/// What `resolveUpdateOutlet` answers: the decision's `outlet` and `subkind`.
public struct ResolvedOutlet: Sendable, Equatable {
    public var id: String?
    public var kind: String
    public var subkind: String?

    public init(id: String?, kind: String, subkind: String?) {
        self.id = id
        self.kind = kind
        self.subkind = subkind
    }

    public var outlet: UpdateOutlet { UpdateOutlet(id: id, kind: kind) }
}

private func isKind(_ v: String?) -> Bool { v.map(OUTLET_KIND_VALUES.contains) ?? false }
private func isSubkind(_ v: String?) -> Bool { v.map(OUTLET_SUBKIND_VALUES.contains) ?? false }

/// True when `host` is a valid host outlet option: a kind among the 17, an id matching
/// `OUTLET_ID_PATTERN`, and a subkind (when given) among `OUTLET_SUBKINDS`. An SDK raises
/// `invalid-options` at construction for any other value.
public func isValidHostOutlet(_ host: HostOutlet) -> Bool {
    switch host {
    case .kind(let kind):
        return isKind(kind)
    case .outlet(let id, let kind, let subkind):
        return isKind(kind) && matchesWhole(OUTLET_ID_PATTERN, id) && (subkind == nil || isSubkind(subkind))
    }
}

/// The decision's outlet, in §2.8's order: a host value wins; else the stamp's kind (its
/// `outletKind`, or its `outlet` when it has none; a kind outside the 17 is no kind), moved by a
/// detection result when there is one; else `{id: nil, kind: "unknown", subkind: nil}`
/// (`update-matrix.json#/outletCases`). Nil when `host` is present but invalid: the SDK raises
/// `invalid-options` for it.
public func resolveUpdateOutlet(
    host: HostOutlet? = nil, stamp: OutletStamp? = nil, detected: DetectedOutlet? = nil
) -> ResolvedOutlet? {
    if let host {
        guard isValidHostOutlet(host) else { return nil }
        switch host {
        case .kind(let kind): return ResolvedOutlet(id: kind, kind: kind, subkind: nil)
        case .outlet(let id, let kind, let subkind):
            return ResolvedOutlet(id: id, kind: kind, subkind: subkind)
        }
    }
    let rawKind = stamp?.outletKind ?? stamp?.outlet
    let kind = isKind(rawKind) ? rawKind : nil
    let id = stamp?.outlet.flatMap { matchesWhole(OUTLET_ID_PATTERN, $0) ? $0 : nil }
    let subkind = isSubkind(stamp?.outletSubkind) ? stamp?.outletSubkind : nil
    if let detected {
        return detected.kind == kind
            ? ResolvedOutlet(id: id, kind: detected.kind, subkind: detected.subkind)
            : ResolvedOutlet(id: nil, kind: detected.kind, subkind: detected.subkind)
    }
    if let kind { return ResolvedOutlet(id: id, kind: kind, subkind: subkind) }
    return ResolvedOutlet(id: nil, kind: OUTLET_UNKNOWN, subkind: nil)
}

// ── Inputs and outputs (§2.8) ─────────────────────────────────────────────────────────────────

/// The installed build.
public struct InstalledBuild: Sendable, Equatable {
    /// The running version (the stamp's `version`; after a sidecar code update, the code's).
    public var version: String
    /// The executable's version; nil means `version`.
    public var binaryVersion: String?
    /// Informational in v4.
    public var buildNumber: String?
    /// A `Platform` value.
    public var platform: String
    /// The device's `Arch` value.
    public var arch: String
    /// The installed build's format; nil when unknown (any format is offered).
    public var format: String?
    /// `godot-<major>.<minor>`; nil outside Godot.
    public var engine: String?

    public init(
        version: String, binaryVersion: String? = nil, buildNumber: String? = nil,
        platform: String, arch: String, format: String? = nil, engine: String? = nil
    ) {
        self.version = version
        self.binaryVersion = binaryVersion
        self.buildNumber = buildNumber
        self.platform = platform
        self.arch = arch
        self.format = format
        self.engine = engine
    }
}

/// An update the host staged and verified, with the `UpdateCheck.channel` it was staged under.
public struct StagedUpdate: Sendable, Equatable {
    public var version: String
    public var channel: String

    public init(version: String, channel: String) {
        self.version = version
        self.channel = channel
    }
}

/// `UpdateDecisionInput`.
public struct UpdateDecisionInput: Sendable, Equatable {
    /// The effective clock, epoch seconds.
    public var now: Int
    public var feed: ChannelFeedDoc
    /// The verified, cross-checked record the target for `installed.platform` pins; nil if absent
    /// or refused.
    public var record: ReleaseRecordDoc?
    public var installed: InstalledBuild
    public var outlet: UpdateOutlet
    public var subkind: String?
    public var staged: StagedUpdate?
    public var skipVersion: String?
    /// `rolloutBucket` for the salt of this outlet's rollout; nil when the host computed none.
    public var bucket: Int?
    /// A subset of `BINARY_METHOD_VALUES`: what this host can do.
    public var methods: [String]
    /// The content decision's inputs (plans/P4-13.md §2.6). Nil: every answer is P3-01's.
    public var content: UpdateContentInput?

    public init(
        now: Int, feed: ChannelFeedDoc, record: ReleaseRecordDoc?, installed: InstalledBuild,
        outlet: UpdateOutlet, subkind: String? = nil, staged: StagedUpdate? = nil,
        skipVersion: String? = nil, bucket: Int? = nil, methods: [String] = [BinaryMethod.download],
        content: UpdateContentInput? = nil
    ) {
        self.now = now
        self.feed = feed
        self.record = record
        self.installed = installed
        self.outlet = outlet
        self.subkind = subkind
        self.staged = staged
        self.skipVersion = skipVersion
        self.bucket = bucket
        self.methods = methods
        self.content = content
    }
}

/// A decision's `release`: `{version, seq}`, plus `sha256` on `code-ready` and `binary`.
public struct DecisionRelease: Sendable, Equatable {
    public let version: String
    public let seq: Int
    public let sha256: String?

    public init(version: String, seq: Int, sha256: String? = nil) {
        self.version = version
        self.seq = seq
        self.sha256 = sha256
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["version": .string(version), "seq": .int(seq)]
        if let sha256 { o["sha256"] = .string(sha256) }
        return .object(o)
    }
}

/// `UpdateDecision` (§2.8 "Outputs", extended by plans/P4-13.md §2.6): each action carries
/// exactly its members. Reasons and methods are the generated vocabularies (`UpdateNoneReason`,
/// `UpdateBlockedReason`, `BinaryMethod`). `contentBlock` (`content-floor` or `revoked-content`)
/// is present only when a content block made the answer: on `binary`, `store` and `platform` it
/// makes the offer mandatory; on `blocked` it rides only on `app-floor`.
public enum UpdateDecision: Sendable, Equatable {
    case none(reason: String, behind: Bool, discardStaged: Bool)
    case codeReady(release: DecisionRelease, critical: Bool, discardStaged: Bool)
    case binary(
        method: String, release: DecisionRelease, build: String, mandatory: Bool, critical: Bool,
        prestage: [PackTarget], discardStaged: Bool, contentBlock: String? = nil)
    case store(
        release: DecisionRelease, listingUrl: String?, mandatory: Bool, critical: Bool,
        discardStaged: Bool, contentBlock: String? = nil)
    case platform(
        release: DecisionRelease, mandatory: Bool, critical: Bool, discardStaged: Bool,
        contentBlock: String? = nil)
    case blocked(reason: String, discardStaged: Bool, contentBlock: String? = nil)
    /// plans/P4-13.md §2.6: install exact releases and unmount revoked packs. `set` is the
    /// effective release of every known pack; the lists are sorted by pack-id bytes.
    case packs(install: [PackTarget], revoke: [String], set: [PackSetMember], discardStaged: Bool)

    /// The `UpdateAction` value.
    public var action: String {
        switch self {
        case .none: UpdateAction.none
        case .codeReady: UpdateAction.codeReady
        case .binary: UpdateAction.binary
        case .store: UpdateAction.store
        case .platform: UpdateAction.platform
        case .blocked: UpdateAction.blocked
        case .packs: UpdateAction.packs
        }
    }

    /// The answer's `contentBlock`, when it has one.
    public var contentBlock: String? {
        switch self {
        case .binary(_, _, _, _, _, _, _, let b), .store(_, _, _, _, _, let b),
            .platform(_, _, _, _, let b), .blocked(_, _, let b):
            b
        default: nil
        }
    }

    /// Drop what the host staged: on every answer except `stale` and `code-ready` when something
    /// is staged.
    public var discardStaged: Bool {
        switch self {
        case .none(_, _, let d), .codeReady(_, _, let d), .binary(_, _, _, _, _, _, let d, _),
            .store(_, _, _, _, let d, _), .platform(_, _, _, let d, _), .blocked(_, let d, _),
            .packs(_, _, _, let d):
            d
        }
    }

    /// The decision as the wire and the matrices spell it, with exactly its action's members.
    public var json: JSONValue {
        var o: [String: JSONValue] = ["action": .string(action), "discardStaged": .bool(discardStaged)]
        switch self {
        case .none(let reason, let behind, _):
            o["reason"] = .string(reason)
            o["behind"] = .bool(behind)
        case .codeReady(let release, let critical, _):
            o["release"] = release.json
            o["critical"] = .bool(critical)
        case .binary(let method, let release, let build, let mandatory, let critical, let prestage, _, _):
            o["method"] = .string(method)
            o["release"] = release.json
            o["build"] = .string(build)
            o["mandatory"] = .bool(mandatory)
            o["critical"] = .bool(critical)
            o["prestage"] = .array(prestage.map(\.json))
        case .store(let release, let listingUrl, let mandatory, let critical, _, _):
            o["release"] = release.json
            o["listingUrl"] = listingUrl.map(JSONValue.string) ?? .null
            o["mandatory"] = .bool(mandatory)
            o["critical"] = .bool(critical)
        case .platform(let release, let mandatory, let critical, _, _):
            o["release"] = release.json
            o["mandatory"] = .bool(mandatory)
            o["critical"] = .bool(critical)
        case .blocked(let reason, _, _):
            o["reason"] = .string(reason)
        case .packs(let install, let revoke, let set, _):
            o["install"] = .array(install.map(\.json))
            o["revoke"] = .array(revoke.map(JSONValue.string))
            o["set"] = .array(set.map(\.json))
        }
        if let contentBlock { o["contentBlock"] = .string(contentBlock) }
        return .object(o)
    }
}

// ── The decision (§2.8 "Algorithm") ───────────────────────────────────────────────────────────

/// The feed's target for `platform`, if there is one.
public func feedTarget(_ targets: [FeedTarget], platform: String) -> FeedTarget? {
    targets.first { $0.platform == platform }
}

/// The install's entry in a target (§2.8 step 3): `outlets[outlet.id]` when that entry's kind is
/// the outlet's kind; otherwise the ONE entry of that kind, if exactly one has it; otherwise
/// none. `unknown` never has an entry. A host computes the rollout bucket from this entry's salt.
public func outletEntry(_ target: FeedTarget?, outlet: UpdateOutlet) -> FeedOutletEntry? {
    guard let target, outlet.kind != OUTLET_UNKNOWN else { return nil }
    if let id = outlet.id, let byId = target.outlets[id], byId.kind == outlet.kind { return byId }
    let ofKind = target.outlets.values.filter { $0.kind == outlet.kind }
    return ofKind.count == 1 ? ofKind.first : nil
}

private func archRank(_ b: ReleaseRecordBuild, _ arch: String) -> Int {
    b.arch == arch ? 0 : (b.arch == "universal" ? 1 : 2)
}

/// The device's own arch before `universal`, `universal` before `any`; ties by build id in
/// ascending byte order (build ids are ASCII by `BUILD_ID_PATTERN`).
private func pickBuild(_ builds: [ReleaseRecordBuild], arch: String) -> ReleaseRecordBuild? {
    var best: ReleaseRecordBuild?
    for b in builds {
        guard let current = best else {
            best = b
            continue
        }
        let r = archRank(b, arch) - archRank(current, arch)
        if r < 0 || (r == 0 && Array(b.id.utf8).lexicographicallyPrecedes(Array(current.id.utf8))) {
            best = b
        }
    }
    return best
}

/// §2.8 "Eligible builds": exactly one `payload` artifact, the installed platform, and the
/// device's arch, `universal` or `any`. A `requires.engine` that is not a string, or a
/// `requires.minBinary` that does not parse under the feed's scheme, is never eligible.
private func eligible(_ b: ReleaseRecordBuild, platform: String, arch: String, scheme: String) -> Bool {
    guard b.artifacts.filter({ $0.role == "payload" }).count == 1 else { return false }
    guard b.platform == platform else { return false }
    guard b.arch == arch || b.arch == "universal" || b.arch == "any" else { return false }
    if let req = b.requires {
        if let engine = req["engine"], engine.stringValue == nil { return false }
        if let min = req["minBinary"] {
            guard let s = min.stringValue, parseVersion(scheme, s) != nil else { return false }
        }
    }
    return true
}

/// The update decision (plans/P3-01.md §2.8, extended by plans/P4-13.md §2.6 when `content` is
/// given): P3-01's eleven rules give the app answer; with `content`, the pack composition, the
/// content blocks and `prestage` refine it in §2.6's order. Synchronous and total; each answer
/// has exactly the members the output tables list, so decisions compare by value.
/// `update-matrix.json#/rows` and `#/contentRows` pin every rule.
public func decideUpdate(_ input: UpdateDecisionInput) -> UpdateDecision {
    let app = decideApp(input)
    guard let content = input.content else { return app }
    return decideContent(input, content, app)
}

/// P3-01's decision, unchanged (plans/P3-01.md §2.8).
private func decideApp(_ input: UpdateDecisionInput) -> UpdateDecision {
    let feed = input.feed
    let scheme = feed.app.versionScheme
    func cmp(_ a: String, _ b: String) -> Int? { compareVersions(scheme, a, b) }
    let staged = input.staged
    func discard(_ codeReady: Bool = false) -> Bool { staged != nil && !codeReady }
    func none(_ reason: String) -> UpdateDecision {
        .none(reason: reason, behind: reason == UpdateNoneReason.behind, discardStaged: discard())
    }
    func blocked() -> UpdateDecision {
        .blocked(reason: UpdateBlockedReason.appFloor, discardStaged: discard())
    }

    // 1. Stale: freeze, and keep what is staged.
    if input.now >= saturatingAdd(feed.expiresAt, CLOCK_SKEW_SECONDS) {
        return .none(reason: UpdateNoneReason.stale, behind: false, discardStaged: false)
    }

    // 2. Unknown version.
    let run = input.installed.version
    let bin = input.installed.binaryVersion ?? run
    guard parseVersion(scheme, run) != nil, parseVersion(scheme, bin) != nil else {
        return none(UpdateNoneReason.unknownVersion)
    }

    // 3. Setup.
    let target = feedTarget(feed.app.targets, platform: input.installed.platform)
    let entry = outletEntry(target, outlet: input.outlet)
    let caps = effectiveCapabilities(
        input.outlet.kind, platform: input.installed.platform, subkind: input.subkind,
        server: entry?.capabilities)
    var belowFloor = false
    if let floor = target?.floor, let c = cmp(bin, floor.minVersion), c < 0 { belowFloor = true }

    // 4. The offer.
    var offer: (version: String, seq: Int, sha256: String?)?
    if let entry, let target {
        if caps.binaryUpdates == "self" {
            if let live = entry.live, live.seq == target.release.seq, input.record != nil {
                offer = (target.release.version, target.release.seq, target.release.sha256)
            }
        } else if let live = entry.live {
            offer = (live.version, live.seq, nil)
        }
    }
    guard let offer, let entry, let target else {
        return belowFloor ? blocked() : none(UpdateNoneReason.notAvailable)
    }

    // 5. Behind: no downgrade, and the floor is suppressed.
    let runCmp = cmp(offer.version, run)
    if let c = runCmp, c < 0 { return none(UpdateNoneReason.behind) }

    // 6. Up to date.
    let newerRun = (runCmp ?? 0) > 0
    let newerBin = (cmp(offer.version, bin) ?? 0) > 0
    if !newerRun && !(belowFloor && newerBin) {
        return belowFloor ? blocked() : none(UpdateNoneReason.upToDate)
    }

    // 7. Halted.
    if entry.halted { return belowFloor ? blocked() : none(UpdateNoneReason.halted) }

    // 8. Rollout: a critical release and a below-floor device bypass it; a nil bucket is out.
    if let rollout = entry.rollout, !belowFloor, !target.critical {
        guard let bucket = input.bucket, bucket < rollout.bp else {
            return none(UpdateNoneReason.outOfBucket)
        }
    }

    let critical = target.critical
    let short = DecisionRelease(version: offer.version, seq: offer.seq)

    // 9. Platform.
    if caps.binaryUpdates == "none" {
        return .platform(
            release: short, mandatory: belowFloor, critical: critical, discardStaged: discard())
    }

    // 10. Store.
    if caps.binaryUpdates == "store" {
        return .store(
            release: short, listingUrl: entry.listingUrl, mandatory: belowFloor,
            critical: critical, discardStaged: discard())
    }

    // 11. Self-updating outlets. The offer is the pin here, so it carries its sha256.
    let full = DecisionRelease(version: offer.version, seq: offer.seq, sha256: offer.sha256)
    let notSkipped = offer.version != input.skipVersion

    // a. code-ready.
    if !belowFloor, newerRun, caps.codeUpdates, let staged, staged.channel == feed.channel,
        staged.version == offer.version, notSkipped
    {
        return .codeReady(release: full, critical: critical, discardStaged: false)
    }

    let builds = (input.record?.builds ?? []).filter {
        eligible($0, platform: input.installed.platform, arch: input.installed.arch, scheme: scheme)
    }
    let engine = input.installed.engine
    let codePacks = builds.filter { b in
        guard b.format == "pck", let engine,
            let required = b.requires?["engine"]?.stringValue, required == engine
        else { return false }
        guard let min = b.requires?["minBinary"]?.stringValue else { return true }
        guard let c = cmp(bin, min) else { return false }
        return c >= 0
    }
    let format = input.installed.format
    let binaries = builds.filter { $0.format != "pck" && (format == nil || $0.format == format) }
    func binary(_ method: String, _ build: ReleaseRecordBuild) -> UpdateDecision {
        .binary(
            method: method, release: full, build: build.id, mandatory: belowFloor,
            critical: critical, prestage: [], discardStaged: discard())
    }

    // b. sidecar-pck.
    if !belowFloor, newerRun, caps.codeUpdates, input.methods.contains(BinaryMethod.sidecarPck),
        notSkipped, let pck = pickBuild(codePacks, arch: input.installed.arch)
    {
        return binary(BinaryMethod.sidecarPck, pck)
    }

    // c. native, then download.
    let pick = pickBuild(binaries, arch: input.installed.arch)
    if newerBin, let pick {
        if input.methods.contains(BinaryMethod.native) { return binary(BinaryMethod.native, pick) }
        if input.methods.contains(BinaryMethod.download) {
            return binary(BinaryMethod.download, pick)
        }
    }

    // d. Otherwise.
    if belowFloor { return blocked() }
    if !notSkipped { return none(UpdateNoneReason.skipped) }
    if pick == nil { return none(UpdateNoneReason.noBuild) }
    return none(UpdateNoneReason.noMethod)
}

/// The stage machine's `decide.done` for a decision (plans/P3-01.md §2.8 "bootDecision", amended
/// by plans/P4-13.md §2.6 and decision 4). Floors never stop play; a CI-signed revocation of a
/// REQUIRED pack can:
///
/// - `blocked {revoked-content}`, or any answer with `contentBlock: "revoked-content"`, gives
///   `required`: the boot stops at a confirmed `blocked {update-required}` (a revoked required
///   pack cannot be mounted, so continuing would end in an error and a rollback loop);
/// - `packs` gives `none` (the boot's fetch applies it);
/// - `blocked {content-floor}`, and any answer with `contentBlock: "content-floor"`, give
///   `optional`;
/// - otherwise P3-01's rule: `none`, and a `platform` answer that is not mandatory, give `none`;
///   every other answer gives `optional`, a prompt over a game that keeps running.
public func bootDecision(_ decision: UpdateDecision) -> BootEvent.Decision {
    if case .blocked(let reason, _, _) = decision, reason == UpdateBlockedReason.revokedContent {
        return .required
    }
    if decision.contentBlock == UpdateBlockedReason.revokedContent { return .required }
    switch decision {
    case .packs: return .none
    case .none: return .none
    case .platform(_, let mandatory, _, _, _) where !mandatory: return .none
    default: return .optional
    }
}

/// True when the host must render `decision` as a prompt the player cannot dismiss — over a
/// game that keeps running: a mandatory `binary`, `store` or `platform` answer, and every
/// `blocked` answer (§2.8). Any UI helper honours it.
public func isUndismissable(_ decision: UpdateDecision) -> Bool {
    switch decision {
    case .blocked: return true
    case .binary(_, _, _, let mandatory, _, _, _, _), .store(_, _, let mandatory, _, _, _),
        .platform(_, let mandatory, _, _, _):
        return mandatory
    default: return false
    }
}
