// The channel feed — WIRE-CONTRACT-V4 §2.3 and client steps 3–9 (plans/P3-01.md §2.3, §2.5).
//
// `feedClaims` is steps 4–6, `verifyFeed` steps 3–8 (with the `seq` floor of the canonical
// channel), `reloadFeeds` the reload path, and `commitFeed` step 9's write as a pure function over
// the `feeds` slice. Nothing here does I/O or throws: a refused feed is a typed refusal.
//
// The claims are checked over the decoded JSON tree, not a `Decodable` struct, because member
// presence is part of the contract (V4 §3): a required member is present (`floor` and `live` may
// be `null`, never missing), and an optional one is absent or of its type (a present `null` is
// refused). Every pattern goes through `wholeMatches` (ASCII classes, the whole string), every
// length counts UTF-8 bytes, and every integer field is an integer claim decided from its token
// at its RFC 6901 pointer (`wireInteger`). Only a payload that passes becomes a `ChannelFeedDoc`.
//
// client-core's `feed.ts` is the reference; this is an independent port, held to it by the
// corpus (`feedCases`) rather than by shared code.

import Foundation

// ── Constants (`@polaris-key/protocol/update` and `/distribution`) ────────────────────────────

/// `expiresAt = issuedAt + FEED_TTL_SECONDS` for every feed the Worker signs.
public let FEED_TTL_SECONDS = 900
/// A verifier refuses `expiresAt > issuedAt + MAX_FEED_TTL_SECONDS`.
public let MAX_FEED_TTL_SECONDS = 3600
/// `rolloutBucket`'s modulus, and the ceiling of a rollout's `bp`.
public let ROLLOUT_BUCKETS = 10_000
/// A target's `platform`: ASCII, `OUTLET_ID_PATTERN`'s shape. Unknown values that match are allowed.
public let FEED_PLATFORM_PATTERN = "[a-z][a-z0-9-]{0,63}"
/// A product outlet id, and an outlet kind's shape (P2b-02).
public let OUTLET_ID_PATTERN = "[a-z][a-z0-9-]{0,63}"
/// What `detectOutlet` answers when it cannot tell, and the outlet of a host that configured
/// none. Never a kind: nothing can declare it, and it never has a feed entry.
public let OUTLET_UNKNOWN = "unknown"
/// `binaryUpdates`, narrowest first.
public let BINARY_UPDATES_ORDER: [String] = ["none", "store", "self"]
/// The `commerce` vocabulary.
public let COMMERCE_VALUES: [String] = ["own", "store-iap", "steam", "none"]

private let SHA256_PATTERN = "[0-9a-f]{64}"
private let SALT_PATTERN = "[0-9a-f]{32}"
private let MAX_LISTING_URL_BYTES = 2048
private let CAPABILITY_BOOLEANS = ["codeUpdates", "dataUpdates", "channelSwitch", "downloadedScripts"]

// ── JSON helpers (package-internal) ───────────────────────────────────────────────────────────

extension JSONValue {
    /// The integer of a plain `.int` token. A `.double` is never an integer claim: the decoder
    /// made one only of a token with a fraction, an exponent or too many digits, which the
    /// verifier's `nonWireIntegers` names anyway.
    var exactInt: Int? {
        if case .int(let i) = self { return i }
        return nil
    }
}

/// RFC 6901 escaping of one reference token.
func pointerToken(_ raw: String) -> String {
    raw.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
}

func matchesWhole(_ pattern: String, _ value: String) -> Bool {
    wholeMatches(pattern, value) != nil
}

// ── The verified document ─────────────────────────────────────────────────────────────────────

/// `targets[].release`: the pin.
public struct FeedRelease: Sendable, Equatable {
    public let sha256: String
    public let seq: Int
    public let version: String

    public init(sha256: String, seq: Int, version: String) {
        self.sha256 = sha256
        self.seq = seq
        self.version = version
    }
}

/// `targets[].floor` when it is not null: this platform's floor.
public struct FeedTargetFloor: Sendable, Equatable {
    public let minVersion: String

    public init(minVersion: String) { self.minVersion = minVersion }
}

/// `outlets.*.live`: the newest release of the app live on that outlet for that platform.
public struct FeedLive: Sendable, Equatable {
    public let version: String
    public let seq: Int

    public init(version: String, seq: Int) {
        self.version = version
        self.seq = seq
    }
}

/// `outlets.*.rollout`: a client-evaluated rollout.
public struct FeedRollout: Sendable, Equatable {
    /// Basis points out of `ROLLOUT_BUCKETS`.
    public let bp: Int
    /// 32 lowercase hex characters, hashed as text by `rolloutBucket`.
    public let salt: String

    public init(bp: Int, salt: String) {
        self.bp = bp
        self.salt = salt
    }
}

/// One outlet's entry in a target, keyed by the product's outlet id.
public struct FeedOutletEntry: Sendable, Equatable {
    public let kind: String
    public let live: FeedLive?
    public let halted: Bool
    public let rollout: FeedRollout?
    public let listingUrl: String?
    /// A narrowing of the kind's defaults (any subset of the six fields). Unknown keys are kept
    /// and ignored.
    public let capabilities: [String: JSONValue]?

    public init(
        kind: String, live: FeedLive?, halted: Bool, rollout: FeedRollout? = nil,
        listingUrl: String? = nil, capabilities: [String: JSONValue]? = nil
    ) {
        self.kind = kind
        self.live = live
        self.halted = halted
        self.rollout = rollout
        self.listingUrl = listingUrl
        self.capabilities = capabilities
    }
}

/// One platform's target.
public struct FeedTarget: Sendable, Equatable {
    public let platform: String
    public let release: FeedRelease
    public let floor: FeedTargetFloor?
    public let critical: Bool
    public let outlets: [String: FeedOutletEntry]

    public init(
        platform: String, release: FeedRelease, floor: FeedTargetFloor?, critical: Bool,
        outlets: [String: FeedOutletEntry]
    ) {
        self.platform = platform
        self.release = release
        self.floor = floor
        self.critical = critical
        self.outlets = outlets
    }
}

/// `app`.
public struct FeedApp: Sendable, Equatable {
    public let deliverable: String
    public let versionScheme: String
    public let targets: [FeedTarget]

    public init(deliverable: String, versionScheme: String, targets: [FeedTarget]) {
        self.deliverable = deliverable
        self.versionScheme = versionScheme
        self.targets = targets
    }
}

/// A verified `pkey-feed+jws` payload (WIRE-CONTRACT-V4 §2.3).
public struct ChannelFeedDoc: Sendable, Equatable {
    public let schemaVersion: Int
    public let iss: String
    public let aud: String
    /// The canonical channel (§2.3): it keys `feeds` and the floors, and is the decision's channel.
    public let channel: String
    /// `selector.platform`, when the Worker split the channel per platform.
    public let selectorPlatform: String?
    public let seq: Int
    public let issuedAt: Int
    public let expiresAt: Int
    public let app: FeedApp
    /// The payload as decoded, reserved members (`packSets`, …) included.
    public let json: JSONValue

    public init(
        schemaVersion: Int = 1, iss: String = POLARIS_ISSUER, aud: String, channel: String,
        selectorPlatform: String? = nil, seq: Int, issuedAt: Int, expiresAt: Int, app: FeedApp,
        json: JSONValue = .null
    ) {
        self.schemaVersion = schemaVersion
        self.iss = iss
        self.aud = aud
        self.channel = channel
        self.selectorPlatform = selectorPlatform
        self.seq = seq
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.app = app
        self.json = json
    }

    /// The typed view of a feed object, or nil when it lacks a member or a member has the
    /// wrong type. It checks SHAPE only — `feedClaims` is the contract; a payload that passed
    /// it always converts.
    public init?(json: JSONValue) {
        guard let o = json.objectValue,
            let schemaVersion = o["schemaVersion"]?.exactInt,
            let iss = o["iss"]?.stringValue, let aud = o["aud"]?.stringValue,
            let channel = o["channel"]?.stringValue,
            let selector = o["selector"]?.objectValue,
            let seq = o["seq"]?.exactInt, let issuedAt = o["issuedAt"]?.exactInt,
            let expiresAt = o["expiresAt"]?.exactInt,
            let app = o["app"]?.objectValue,
            let deliverable = app["deliverable"]?.stringValue,
            let scheme = app["versionScheme"]?.stringValue,
            let rawTargets = app["targets"]?.arrayValue
        else { return nil }
        var targets: [FeedTarget] = []
        for raw in rawTargets {
            guard let target = FeedTarget(json: raw) else { return nil }
            targets.append(target)
        }
        self.init(
            schemaVersion: schemaVersion, iss: iss, aud: aud, channel: channel,
            selectorPlatform: selector["platform"]?.stringValue, seq: seq, issuedAt: issuedAt,
            expiresAt: expiresAt,
            app: FeedApp(deliverable: deliverable, versionScheme: scheme, targets: targets),
            json: json)
    }
}

extension FeedTarget {
    init?(json: JSONValue) {
        guard let t = json.objectValue,
            let platform = t["platform"]?.stringValue,
            let release = t["release"]?.objectValue,
            let sha = release["sha256"]?.stringValue, let seq = release["seq"]?.exactInt,
            let version = release["version"]?.stringValue,
            let critical = t["critical"]?.boolValue,
            let rawOutlets = t["outlets"]?.objectValue
        else { return nil }
        var floor: FeedTargetFloor?
        switch t["floor"] {
        case .null?: floor = nil
        case .object(let f)?:
            guard let min = f["minVersion"]?.stringValue else { return nil }
            floor = FeedTargetFloor(minVersion: min)
        default: return nil
        }
        var outlets: [String: FeedOutletEntry] = [:]
        for (id, raw) in rawOutlets {
            guard let e = raw.objectValue, let kind = e["kind"]?.stringValue,
                let halted = e["halted"]?.boolValue
            else { return nil }
            var live: FeedLive?
            switch e["live"] {
            case .null?: live = nil
            case .object(let l)?:
                guard let v = l["version"]?.stringValue, let s = l["seq"]?.exactInt else { return nil }
                live = FeedLive(version: v, seq: s)
            default: return nil
            }
            var rollout: FeedRollout?
            if let r = e["rollout"] {
                guard let ro = r.objectValue, let bp = ro["bp"]?.exactInt,
                    let salt = ro["salt"]?.stringValue
                else { return nil }
                rollout = FeedRollout(bp: bp, salt: salt)
            }
            var listingUrl: String?
            if let u = e["listingUrl"] {
                guard let s = u.stringValue else { return nil }
                listingUrl = s
            }
            var capabilities: [String: JSONValue]?
            if let c = e["capabilities"] {
                guard let co = c.objectValue else { return nil }
                capabilities = co
            }
            outlets[id] = FeedOutletEntry(
                kind: kind, live: live, halted: halted, rollout: rollout, listingUrl: listingUrl,
                capabilities: capabilities)
        }
        self.init(
            platform: platform, release: FeedRelease(sha256: sha, seq: seq, version: version),
            floor: floor, critical: critical, outlets: outlets)
    }
}

// ── Steps 4–6: the claims, the channel binding and the selector ──────────────────────────────

/// Why `feedClaims` refused (steps 4, 5 and 6).
public enum FeedClaimsRefusal: String, Sendable, Equatable, CaseIterable {
    case claims, channel, selector
}

private func capabilitiesOk(_ value: JSONValue) -> Bool {
    guard let c = value.objectValue else { return false }
    if let b = c["binaryUpdates"] {
        guard let s = b.stringValue, BINARY_UPDATES_ORDER.contains(s) else { return false }
    }
    for key in CAPABILITY_BOOLEANS {
        if let v = c[key], v.boolValue == nil { return false }
    }
    if let v = c["commerce"] {
        guard let s = v.stringValue, COMMERCE_VALUES.contains(s) else { return false }
    }
    return true
}

/// `listingUrl`: 1–2048 bytes, each 0x21–0x7E, so bytes and characters count alike.
private func isPrintableAscii(_ v: String, max: Int) -> Bool {
    let n = v.utf8.count
    guard n >= 1, n <= max else { return false }
    return v.utf8.allSatisfy { $0 >= 0x21 && $0 <= 0x7E }
}

/// Step 4: every claim of §2.3. True when they all hold.
private func feedClaimsHold(
    _ doc: [String: JSONValue], expectedAud: String, nonWire: NonWireIntegers
) -> Bool {
    func int(_ v: JSONValue?, _ pointer: String, _ min: Int) -> Int? {
        guard let i = v?.exactInt, wireInteger(i, pointer: pointer, min: min, in: nonWire)
        else { return nil }
        return i
    }

    guard let schema = int(doc["schemaVersion"], "/schemaVersion", 1), schema == 1 else {
        return false
    }
    guard doc["iss"]?.stringValue == POLARIS_ISSUER else { return false }
    guard doc["aud"]?.stringValue == expectedAud else { return false }
    guard let channel = doc["channel"]?.stringValue, matchesWhole(CHANNEL_NAME_PATTERN, channel)
    else { return false }
    guard let selector = doc["selector"]?.objectValue else { return false }
    let selectorPlatform: String?
    if let p = selector["platform"] {
        guard let s = p.stringValue else { return false }
        selectorPlatform = s
    } else {
        selectorPlatform = nil
    }
    guard int(doc["seq"], "/seq", 1) != nil,
        let issuedAt = int(doc["issuedAt"], "/issuedAt", 0),
        let expiresAt = int(doc["expiresAt"], "/expiresAt", 1)
    else { return false }
    guard issuedAt < expiresAt, expiresAt <= saturatingAdd(issuedAt, MAX_FEED_TTL_SECONDS)
    else { return false }

    guard let app = doc["app"]?.objectValue else { return false }
    guard app["deliverable"]?.stringValue == "app" else { return false }
    guard let scheme = app["versionScheme"]?.stringValue, FEED_VERSION_SCHEMES.contains(scheme)
    else { return false }
    func version(_ v: JSONValue?) -> String? {
        guard let s = v?.stringValue, parseVersion(scheme, s) != nil else { return nil }
        return s
    }
    guard let targets = app["targets"]?.arrayValue else { return false }

    var platforms = Set<String>()
    for (i, rawTarget) in targets.enumerated() {
        let at = "/app/targets/\(i)"
        guard let target = rawTarget.objectValue else { return false }
        guard let platform = target["platform"]?.stringValue,
            matchesWhole(FEED_PLATFORM_PATTERN, platform)
        else { return false }
        // ASCII by the pattern, so `Set<String>` compares bytes here.
        guard platforms.insert(platform).inserted else { return false }
        if let sp = selectorPlatform, platform != sp { return false }

        guard let release = target["release"]?.objectValue else { return false }
        guard let sha = release["sha256"]?.stringValue, matchesWhole(SHA256_PATTERN, sha) else {
            return false
        }
        guard int(release["seq"], "\(at)/release/seq", 1) != nil else { return false }
        guard let pinVersion = version(release["version"]) else { return false }

        switch target["floor"] {
        case nil:
            return false
        case .null?:
            break
        case .object(let floor)?:
            guard let min = version(floor["minVersion"]),
                let c = compareVersions(scheme, min, pinVersion), c <= 0
            else { return false }
        default:
            return false
        }
        guard target["critical"]?.boolValue != nil else { return false }

        guard let outlets = target["outlets"]?.objectValue else { return false }
        for (id, rawEntry) in outlets {
            let pointer = "\(at)/outlets/\(pointerToken(id))"
            guard matchesWhole(OUTLET_ID_PATTERN, id) else { return false }
            guard let entry = rawEntry.objectValue else { return false }
            guard let kind = entry["kind"]?.stringValue, matchesWhole(OUTLET_ID_PATTERN, kind),
                kind != OUTLET_UNKNOWN
            else { return false }
            switch entry["live"] {
            case nil:
                return false
            case .null?:
                break
            case .object(let live)?:
                guard version(live["version"]) != nil,
                    int(live["seq"], "\(pointer)/live/seq", 1) != nil
                else { return false }
            default:
                return false
            }
            guard entry["halted"]?.boolValue != nil else { return false }
            if let rawRollout = entry["rollout"] {
                guard let rollout = rawRollout.objectValue,
                    let bp = int(rollout["bp"], "\(pointer)/rollout/bp", 0), bp <= ROLLOUT_BUCKETS,
                    let salt = rollout["salt"]?.stringValue, matchesWhole(SALT_PATTERN, salt)
                else { return false }
            }
            if let rawUrl = entry["listingUrl"] {
                guard let url = rawUrl.stringValue else { return false }
                if OUTLET_KIND_VALUES.contains(kind) {
                    let prefixes = LISTING_URL_PREFIXES[kind] ?? []
                    guard isPrintableAscii(url, max: MAX_LISTING_URL_BYTES) else { return false }
                    // Byte for byte: the URL is printable ASCII here.
                    guard prefixes.contains(where: { url.utf8.starts(with: $0.utf8) }) else {
                        return false
                    }
                }
            }
            if let caps = entry["capabilities"], !capabilitiesOk(caps) { return false }
        }
    }
    return true
}

/// Client steps 4–6 over a verified feed payload: the claims (`.claims`), the channel binding
/// (`.channel`: the claim is never `latest`, and equals the requested name or, when that name is
/// an alias, `CHANNEL_ALIASES[requested]`) and the selector (`.selector`). Nil when all three
/// pass; the claim is then the canonical channel.
///
/// - Parameters:
///   - channel: the channel name the client REQUESTED (it may be an alias).
///   - platform: the client's platform; when given, a `selector.platform` must equal it.
///   - nonWire: the verified payload's `nonWireIntegers`; empty when checking a value you built.
public func feedClaims(
    _ payload: JSONValue, expectedAud: String, channel requested: String, platform: String?,
    nonWire: NonWireIntegers = []
) -> FeedClaimsRefusal? {
    guard let doc = payload.objectValue,
        feedClaimsHold(doc, expectedAud: expectedAud, nonWire: nonWire),
        let claim = doc["channel"]?.stringValue,
        let selector = doc["selector"]?.objectValue
    else { return .claims }
    if claim == "latest" { return .channel }
    if claim != requested && claim != CHANNEL_ALIASES[requested] { return .channel }
    for key in selector.keys where key != "platform" { return .selector }
    if let sp = selector["platform"]?.stringValue, let platform, sp != platform {
        return .selector
    }
    return nil
}

// ── Steps 3–8: the verifier, and the floor ────────────────────────────────────────────────────

/// The `seq` floor of one canonical channel: the committed feed's `seq` and `issuedAt`.
public struct FeedFloor: Sendable, Equatable {
    public let seq: Int
    public let issuedAt: Int

    public init(seq: Int, issuedAt: Int) {
        self.seq = seq
        self.issuedAt = issuedAt
    }
}

/// The floor a committed feed sets for its canonical channel.
public func feedFloor(_ feed: ChannelFeedDoc) -> FeedFloor {
    FeedFloor(seq: feed.seq, issuedAt: feed.issuedAt)
}

/// Why `verifyFeed` refused, by client step (`feedCases` `expect.reason`).
public enum FeedRefusal: String, Sendable, Equatable, CaseIterable {
    case jws, claims, channel, selector, freshness
    case notNewer = "not-newer"
    case rollback
}

public struct VerifyFeedOptions: Sendable {
    /// The EFFECTIVE product trust set (pins ∪ manifest keys), as for documents (step 3).
    public var trust: TrustSet
    /// The product: `aud` must equal it.
    public var expectedAud: String
    /// The channel name the client REQUESTED (it may be an alias); step 5 binds the claim to it.
    public var channel: String
    /// The client's platform (step 6). Nil skips only the platform comparison (Core's load path,
    /// which does not know the update client's platform); an unknown selector key still refuses.
    public var platform: String?
    /// The effective clock, epoch seconds. Defaults to the system clock.
    public var now: Int?
    /// Step 7, on the network path only (the default). False on the reload path.
    public var checkFreshness: Bool
    /// The floors, keyed by CANONICAL channel. Step 8 reads `floors[claim]` only after step 5 has
    /// bound the claim; it never looks up the requested name or resolves an alias itself.
    public var floors: [String: FeedFloor]

    public init(
        trust: TrustSet, expectedAud: String, channel: String, platform: String?,
        now: Int? = nil, checkFreshness: Bool = true, floors: [String: FeedFloor] = [:]
    ) {
        self.trust = trust
        self.expectedAud = expectedAud
        self.channel = channel
        self.platform = platform
        self.now = now
        self.checkFreshness = checkFreshness
        self.floors = floors
    }
}

public enum VerifyFeedResult: Sendable, Equatable {
    case ok(ChannelFeedDoc)
    /// `channel` is the canonical channel, present only when the feed passed step 5 (a refusal at
    /// step 6, 7 or 8): the first key of §2.5's fallback order.
    case refused(FeedRefusal, channel: String?)

    public var feed: ChannelFeedDoc? {
        if case .ok(let feed) = self { return feed }
        return nil
    }

    public var refusal: FeedRefusal? {
        if case .refused(let reason, _) = self { return reason }
        return nil
    }
}

/// Client steps 3–8 (plans/P3-01.md §2.5): `verify` with the effective trust set and `typ`
/// `pkey-feed+jws`, the claims, the channel binding, the selector, freshness on the network
/// path, and the `seq` floor of the canonical channel. Never throws.
public func verifyFeed(_ jws: String, options opts: VerifyFeedOptions) -> VerifyFeedResult {
    guard let v = JWSVerifier.verify(jws, trust: opts.trust, typ: .feed, requireTyp: true) else {
        return .refused(.jws, channel: nil)
    }
    // A payload that does not decode fails at the claims step (V4 §3).
    guard let payload = try? JSONDecoder().decode(JSONValue.self, from: v.payload) else {
        return .refused(.claims, channel: nil)
    }
    let refusal = feedClaims(
        payload, expectedAud: opts.expectedAud, channel: opts.channel, platform: opts.platform,
        nonWire: v.nonWireIntegers)
    if refusal == .claims { return .refused(.claims, channel: nil) }
    if refusal == .channel { return .refused(.channel, channel: nil) }
    guard let feed = ChannelFeedDoc(json: payload) else { return .refused(.claims, channel: nil) }
    // From here on the claim is the canonical channel (step 5).
    let channel = feed.channel
    if refusal == .selector { return .refused(.selector, channel: channel) }
    if opts.checkFreshness {
        let now = opts.now ?? Int(Date().timeIntervalSince1970)
        if feed.issuedAt > saturatingAdd(now, CLOCK_SKEW_SECONDS)
            || feed.expiresAt <= saturatingAdd(now, -CLOCK_SKEW_SECONDS)
        {
            return .refused(.freshness, channel: channel)
        }
    }
    if let floor = opts.floors[channel] {
        if feed.seq < floor.seq { return .refused(.rollback, channel: channel) }
        if feed.seq == floor.seq && feed.issuedAt <= floor.issuedAt {
            return .refused(.notNewer, channel: channel)
        }
    }
    return .ok(feed)
}

// ── The reload path and step 9 ────────────────────────────────────────────────────────────────

/// One committed feed that survived the reload path.
public struct CommittedFeed: Sendable, Equatable {
    /// The compact JWS, verbatim, as the cache holds it.
    public let jws: String
    public let feed: ChannelFeedDoc
}

/// The survivors of the reload path, keyed by canonical channel, and the floors they set.
public struct ReloadedFeeds: Sendable, Equatable {
    public var feeds: [String: CommittedFeed] = [:]
    /// `floors[k] = feedFloor(feeds[k])`: what `verifyFeed` reads at step 8. Never persisted.
    public var floors: [String: FeedFloor] = [:]

    public init() {}
}

/// The reload path (plans/P3-01.md §2.5): every `feeds[k]` goes through steps 3–6 with `k` as
/// the requested name, no freshness and no floor, and its claim must equal `k`. Each survivor
/// gives `floors[k]`; anything that fails is absent, so a committed feed whose key left the
/// effective trust set is dropped together with its floor. Never throws.
public func reloadFeeds(
    _ cached: [String: String], trust: TrustSet, expectedAud: String, platform: String?
) -> ReloadedFeeds {
    var out = ReloadedFeeds()
    for (k, jws) in cached {
        let r = verifyFeed(
            jws,
            options: VerifyFeedOptions(
                trust: trust, expectedAud: expectedAud, channel: k, platform: platform,
                checkFreshness: false))
        guard let feed = r.feed, feed.channel == k else { continue }
        out.feeds[k] = CommittedFeed(jws: jws, feed: feed)
        out.floors[k] = feedFloor(feed)
    }
    return out
}

/// Step 9's write over the `feeds` slice: `feeds[claim] = jws`, and when the claim is not the
/// requested name (an alias answer) the same write removes `feeds[requested]`. Every other entry
/// stays.
public func commitFeed(
    _ feeds: [String: String], requested: String, claim: String, jws: String
) -> [String: String] {
    var next = feeds
    if claim != requested { next[requested] = nil }
    next[claim] = jws
    return next
}

/// The keys a request binds to (step 5): the requested name and, when it is an alias, its
/// target. Only step 2's comparison and §2.5's fallback order use this; no key, floor or
/// decision channel is ever chosen through it.
public func boundChannels(_ requested: String) -> [String] {
    guard let alias = CHANNEL_ALIASES[requested], alias != requested else { return [requested] }
    return [requested, alias]
}
