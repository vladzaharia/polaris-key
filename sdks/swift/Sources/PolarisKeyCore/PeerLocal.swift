// WIRE-CONTRACT-V5 §15.12: local links (account-free pairing). Swift mirror of client-core's `peer/local.ts`.
// Pure functions and small machines, no I/O: the code and its nameplate, the QR, the adverts, the
// `LOCAL_LINK` body, the link secret, the handshake capabilities, the joiner, the pairing window, the
// exchange guard, the pin, the trial order and the gate. The vectors are `peer-matrix.json` `local`; the
// session (`PeerSession.swift`) runs modes `q` and `l` over them, and CPace itself is `PeerCPace.swift`.
//
// A password, a QR secret and a link secret are key material: nothing here logs one or returns one inside
// an error. Time comes in as arguments (a monotonic clock, in seconds, for the window), so a machine never
// reads a clock of its own.

import Foundation

// ── Constants (§15.12) ───────────────────────────────────────────────────────────────

/// A pairing window stays open at most this long.
public let localPairSeconds = 300
/// A code is 8 digits: a 2-digit nameplate and a 6-digit password.
public let localCodeDigits = 8
/// The fifth failed guess closes the window.
public let localPairFailures = 5
public let localQrSecretBytes = 16
public let localJoinCandidates = 2
public let localJoinBrowseSeconds = 15
/// Local links one device holds for one product.
public let maxLocalLinks = 32
public let maxLiveLocalAdverts = 8
/// `maxContactSecrets` (72) plus `maxLocalLinks`.
public let maxLinkSecrets = 104
/// The pairing window admits at most this many C1s in any `localC1WindowSeconds`.
public let localC1PerWindow = 5
public let localC1WindowSeconds = 60
/// From the first byte (C1 included) to the transport.
public let localAttemptSeconds = 30
/// The joiner keeps at most this many matching `m=q` names while it joins.
public let localJoinKept = 8
public let localLinkBodyMax = 4096
/// The mandatory capability of mode `q`.
public let localCap = "local/1"
/// Message 1s a minute one source group may send a listener that holds no account key (§15.10).
public let localGroupPerMinute = 2

public enum PeerLocal {
    // ── The code (§15.12, "The code") ────────────────────────────────────────────────

    /// A source of random bytes that answers nil when it cannot supply `n` of them.
    public typealias DrawSource = (Int) -> Data?

    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// The nameplate: one byte at a time, 200 or more drawn again, then mod 100, and a nameplate in `inUse`
    /// drawn again unless all 100 are in use (then any is taken). Rejection sampling, so every nameplate is
    /// equally likely. Nil when the source runs out.
    public static func drawNameplate(_ source: DrawSource, inUse: [String] = []) -> String? {
        let used = Set(inUse)
        let all = used.count >= 100 && (0..<100).allSatisfy { used.contains(two($0)) }
        while true {
            guard let b = source(1), let x = b.first else { return nil }
            if x >= 200 { continue }
            let n = two(Int(x) % 100)
            if !all && used.contains(n) { continue }
            return n
        }
    }

    /// The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6, written with
    /// leading zeros. Nil when the source runs out.
    public static func drawPassword(_ source: DrawSource) -> String? {
        while true {
            guard let b = source(4), b.count == 4 else { return nil }
            let a = [UInt8](b)
            let n = UInt32(a[0]) << 24 | UInt32(a[1]) << 16 | UInt32(a[2]) << 8 | UInt32(a[3])
            if n >= 4_294_000_000 { continue }
            let d = String(n % 1_000_000)
            return String(repeating: "0", count: 6 - d.count) + d
        }
    }

    private static func isDigits(_ s: String, _ n: Int) -> Bool {
        let u = Array(s.utf8)
        return u.count == n && u.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    /// `4812 3456`: two groups of four, one space. Nil for anything but 8 digits.
    public static func displayCode(nameplate: String, password: String) -> String? {
        let digits = nameplate + password
        guard isDigits(digits, 8) else { return nil }
        return "\(digits.prefix(4)) \(digits.dropFirst(4))"
    }

    public struct ParsedCode: Sendable, Equatable {
        public let nameplate: String
        public let password: String
    }

    /// A typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits.
    public static func parseCode(_ text: String) -> ParsedCode? {
        let digits = String(text.unicodeScalars.filter { $0 != " " && $0 != "-" }.map(Character.init))
        guard isDigits(digits, 8) else { return nil }
        return ParsedCode(nameplate: String(digits.prefix(2)), password: String(digits.dropFirst(2)))
    }

    // ── The QR (§15.12, "The QR") ────────────────────────────────────────────────────

    private static let b32 = Array("abcdefghijklmnopqrstuvwxyz234567")

    private static func slugOK(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard (1...64).contains(u.count) else { return false }
        func alnum(_ c: UInt8) -> Bool { (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) }
        return alnum(u[0]) && u.dropFirst().allSatisfy { alnum($0) || $0 == 0x2d }
    }

    private static func isB32(_ s: String, _ n: Int) -> Bool {
        let u = Array(s.utf8)
        return u.count == n && u.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x32 && $0 <= 0x37) }
    }

    /// `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. Nil for a slug, instance or secret that breaks a rule.
    public static func makeQr(slug: String, instance: String, secret: Data) -> String? {
        guard slugOK(slug), PeerAdvert.isInstanceName(instance), secret.count == localQrSecretBytes else {
            return nil
        }
        return "PKP1:\(slug):\(instance.dropFirst(3)):\(PeerAdvert.base32Lower(secret))".uppercased()
    }

    public enum QrVerdict: Sendable, Equatable {
        case ok(slug: String, instance: String, secret: Data)
        case otherApp
        case invalid
    }

    /// The 16 bytes of 26 canonical base32 characters; nil when the two unused low bits are set.
    private static func decodeSecret(_ chars: String) -> Data? {
        var out: [UInt8] = []
        var acc = 0
        var bits = 0
        for c in chars {
            guard let v = b32.firstIndex(of: c) else { return nil }
            acc = (acc << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((acc >> (bits - 8)) & 0xff))
                bits -= 8
                acc &= (1 << bits) - 1
            }
        }
        return acc == 0 && out.count == 16 ? Data(out) : nil
    }

    private static func asciiFold(_ s: String) -> String {
        let folded = s.unicodeScalars.map { c -> Unicode.Scalar in
            c.value >= 0x41 && c.value <= 0x5a ? Unicode.Scalar(c.value + 32)! : c
        }
        return String(String.UnicodeScalarView(folded))
    }

    /// Read a scanned QR. ASCII case is folded and the text needs four fields split at `:`: `PKP1`, a slug,
    /// 16 base32 characters and 26 canonical ones. A well-formed slug that is not `own` answers `otherApp`;
    /// everything else wrong is `invalid`, and the slug is judged last.
    public static func parseQr(_ text: String, own: String) -> QrVerdict {
        let f = asciiFold(text).split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard f.count == 4, f[0] == "pkp1" else { return .invalid }
        let (slug, instance, secret) = (f[1], f[2], f[3])
        guard slugOK(slug), isB32(instance, 16), isB32(secret, 26), let bytes = decodeSecret(secret) else {
            return .invalid
        }
        if slug != own { return .otherApp }
        return .ok(slug: slug, instance: "p1-" + instance, secret: bytes)
    }

    /// The 10 bytes behind a `p1-` instance name (a window's CPace `sid`); nil for a name that is not 16
    /// base32 characters.
    public static func sid(ofInstance instance: String) -> Data? {
        guard PeerAdvert.isInstanceName(instance) else { return nil }
        var acc = 0
        var bits = 0
        var out: [UInt8] = []
        for c in instance.dropFirst(3) {
            guard let v = b32.firstIndex(of: c) else { return nil }
            acc = (acc << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((acc >> (bits - 8)) & 0xff))
                bits -= 8
                acc &= (1 << bits) - 1
            }
        }
        return out.count == 10 ? Data(out) : nil
    }

    // ── The adverts (§15.12, "The pairing window" and "Mode l") ─────────────────────

    /// The `m=q` instance: `p1-` and the 16 base32 characters of the window's 10 random bytes.
    public static func pairingInstance(sid: Data) -> String? {
        sid.count == 10 ? "p1-" + PeerAdvert.base32Lower(sid) : nil
    }

    private static func u64be(_ n: Int) -> Data {
        let u = UInt64(max(0, n))
        return Data((0..<8).map { UInt8((u >> UInt64(56 - 8 * $0)) & 0xff) })
    }

    /// The `m=l` instance of an advertiser in one epoch: `p1-` and the first 16 characters of the
    /// lower-case base32 of `HMAC-SHA256(secret, "pkey-peer/1 ldisc" || 0x00 || u64be(epoch) || key)`, with the
    /// advertiser's own link key so the two devices of a link differ.
    public static func localInstance(secret: Data, advertiserLinkKey: Data, epoch: Int) -> String {
        let mac = PeerNoiseHash.hmacSHA256(
            key: secret, Data("pkey-peer/1 ldisc".utf8) + [0] + u64be(epoch) + advertiserLinkKey)
        return "p1-" + String(PeerAdvert.base32Lower(mac).prefix(16))
    }

    /// A link the device holds, as a browser tests it: its secret and the peer's link key.
    public struct LinkKey: Sendable {
        public let secret: Data
        public let peerKey: Data
        public init(secret: Data, peerKey: Data) {
            self.secret = secret
            self.peerKey = peerKey
        }
    }

    public struct LocalHit: Sendable, Equatable {
        /// Index into the links as held.
        public let link: Int
        /// 0 the current epoch, 1 the previous one.
        public let epochBack: Int
    }

    /// Which held link an instance belongs to: the first of the first `maxLocalLinks`, in held order, that
    /// matches in the current or the previous epoch. At most 64 HMACs.
    public static func browseLocalInstance(_ instance: String, links: [LinkKey], now: Int) -> LocalHit? {
        guard PeerAdvert.isInstanceName(instance) else { return nil }
        let epoch = peerAdvertEpoch(now)
        for i in 0..<min(links.count, maxLocalLinks) {
            for back in 0...1 where epoch - back >= 0 {
                if localInstance(secret: links[i].secret, advertiserLinkKey: links[i].peerKey, epoch: epoch - back)
                    == instance
                {
                    return LocalHit(link: i, epochBack: back)
                }
            }
        }
        return nil
    }

    private static func txtEntries(_ entries: [String]) -> [String: String]? {
        var kv: [String: String] = [:]
        for e in entries {
            guard let at = e.firstIndex(of: "="), at != e.startIndex else { continue }
            let k = String(e[e.startIndex..<at])
            if kv[k] != nil { return nil }
            kv[k] = String(e[e.index(after: at)...])
        }
        return kv
    }

    public enum LocalTxtRefusal: String, Sendable, Equatable { case duplicate, version, mode }

    /// `v=1` and `m=l`. Entries split as `PeerAdvert.parseTxt` splits them; `h` and `n` are not read.
    public static func parseLocalTxt(_ entries: [String]) -> LocalTxtRefusal? {
        guard let kv = txtEntries(entries) else { return .duplicate }
        if kv["v"] != "1" { return .version }
        if kv["m"] != "l" { return .mode }
        return nil
    }

    public enum PairingTxtResult: Sendable, Equatable {
        /// A pairing window's advert (§15.12): `h` the product tag, `n` the nameplate.
        case ok(h: String, n: String)
        case refused(String)
    }

    /// A pairing window's advert: `v=1`, `m=q`, `h` 16 lower-case hex characters and `n` exactly two ASCII
    /// digits. Anything else is refused with the reason (`duplicate`, `version`, `mode`, `tag`, `nameplate`).
    public static func parsePairingTxt(_ entries: [String]) -> PairingTxtResult {
        guard let kv = txtEntries(entries) else { return .refused("duplicate") }
        if kv["v"] != "1" { return .refused("version") }
        if kv["m"] != "q" { return .refused("mode") }
        guard let h = kv["h"], isHex16(h) else { return .refused("tag") }
        guard let n = kv["n"], isDigits(n, 2) else { return .refused("nameplate") }
        return .ok(h: h, n: n)
    }

    private static func isHex16(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return u.count == 16 && u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    // ── The LOCAL_LINK body (§15.12, "The LOCAL_LINK body") ──────────────────────────

    private static func isCat(_ s: String) -> Bool {
        let u = Array(s.unicodeScalars)
        return (1...32).contains(u.count)
            && u.allSatisfy {
                ($0.value >= 0x61 && $0.value <= 0x7a) || ($0.value >= 0x30 && $0.value <= 0x39) || $0 == "-"
            }
    }

    /// At most 8 distinct categories, each `^[a-z0-9-]{1,32}$`.
    public static func validCats(_ c: [String]) -> Bool {
        c.count <= maxContactCats && c.allSatisfy(isCat) && Set(c).count == c.count
    }

    private static func clean(_ raw: String) -> String? {
        normalizeDeviceLabel(raw.precomposedStringWithCanonicalMapping)
    }

    /// A label as a person gives it to a link (`rename`): cleaned like a `HELLO` label; nil when nothing is left.
    public static func cleanLabel(_ raw: String) -> String? { clean(raw) }

    private static func quoted(_ s: String) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? enc.encode(s)) ?? Data(), as: UTF8.self)
    }

    public struct LinkBody: Sendable, Equatable {
        public let label: String?
        /// The categories the sender's person approved.
        public let cats: [String]
    }

    /// The bytes of a `LOCAL_LINK` body. Throws `PeerNoiseError.badKey` for a body the peer would refuse.
    public static func buildLocalLink(label: String?, cats: [String]) throws -> Data {
        guard validCats(cats) else { throw PeerNoiseError.badKey }
        var s = #"{"v":1"#
        if let label, let l = clean(label) { s += #","label":\#(quoted(l))"# }
        s += #","cats":[\#(cats.map(quoted).joined(separator: ","))]}"#
        let b = Data(s.utf8)
        guard b.count <= localLinkBodyMax else { throw PeerNoiseError.badKey }
        return b
    }

    /// Judge one `LOCAL_LINK` body: strict JSON of at most 4 KiB, `v` the integer 1, an optional label
    /// cleaned as a `HELLO` label (dropped when nothing is left), `cats` required. Unknown members are
    /// ignored; a key, id or certificate in the body is never read.
    public static func parseLocalLink(_ body: Data) -> LinkBody? {
        guard body.count <= localLinkBodyMax, let (o, nonWire) = PeerPayload.parseStrictObject(body),
            case .int(let v)? = o["v"], wireInteger(v, pointer: "/v", min: 1, in: nonWire), v == 1,
            case .array(let items)? = o["cats"]
        else { return nil }
        var cats: [String] = []
        for i in items {
            guard case .string(let c) = i else { return nil }
            cats.append(c)
        }
        guard validCats(cats) else { return nil }
        var label: String?
        if let l = o["label"] {
            guard case .string(let raw) = l else { return nil }
            label = clean(raw)
        }
        return LinkBody(label: label, cats: cats)
    }

    // ── The link secret (§15.12, "The link secret") ──────────────────────────────────

    private static func lessOrEqual(_ a: Data, _ b: Data) -> Bool {
        !Array(b).lexicographicallyPrecedes(Array(a))
    }

    /// `HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local" || 0x00 || lo || hi)`, 32 bytes: `h` is
    /// the mode-`q` handshake hash, `isk` the CPace ISK (64 bytes) and `lo`, `hi` the two link public keys
    /// by unsigned byte order.
    public static func linkSecret(h: Data, isk: Data, keyA: Data, keyB: Data) throws -> Data {
        guard keyA.count == 32, keyB.count == 32 else { throw PeerNoiseError.badKey }
        let (lo, hi) = lessOrEqual(keyA, keyB) ? (keyA, keyB) : (keyB, keyA)
        return PeerNoiseHash.hkdfSHA256(
            salt: h, ikm: isk, info: Data("pkey-peer/1 local".utf8) + [0] + lo + hi, length: 32)
    }

    /// A link's categories: the entries both sides listed, once each, in byte order.
    public static func categories(_ a: [String], _ b: [String]) -> [String] {
        PeerContacts.categories(a, b)
    }

    /// The id of a link on this device: `SHA-256("pkey-local/1" 0x00 peerKey)[0..12]` in base64url, 16
    /// characters. Derived from the peer's link key, a public key, and meaningful on this device only.
    public static func linkId(peerKey: Data) -> String {
        Base64URL.encode(PeerNoiseHash.sha256(Data("pkey-local/1".utf8), Data([0]), peerKey).prefix(12))
    }

    /// A one-way tag that tells two secrets apart without holding either.
    public static func linkTag(secret: Data) -> String {
        Base64URL.encode(PeerNoiseHash.sha256(Data("pkey-local-tag/1".utf8), Data([0]), secret).prefix(12))
    }

    // ── Handshake capabilities (§15.12 step 4) ───────────────────────────────────────

    public struct LocalCaps: Sendable, Equatable {
        public let caps: [String]
        /// Mode `q` without `local/1` in the session's capabilities: close, before any consent.
        public let close: String?
    }

    /// The session's capabilities of a mode-`q` or mode-`l` handshake.
    public static func negotiateLocalCaps(mode: PeerNoiseMode, local: [String], remote: [String]) -> LocalCaps {
        let caps = PeerPayload.capsIntersection(local, remote)
        return mode == .q && !caps.contains(localCap)
            ? LocalCaps(caps: caps, close: "peer_not_allowed") : LocalCaps(caps: caps, close: nil)
    }

    // ── The pin (§15.12, "Mode l" and "Link keys") ───────────────────────────────────

    /// Mode l: the remote static key must be the peer link key of the link whose secret opened the session.
    public static func pin(held: Data, remoteStatic: Data) -> Bool { held == remoteStatic }

    /// Mode q: a remote static key equal to this side's own link key ends the handshake silently, before the
    /// transport (a reflected handshake). True means the key is another's.
    public static func pairingRemoteOk(own: Data, remoteStatic: Data) -> Bool { own != remoteStatic }

    // ── The listener's trial order (§15.5 "One listener, one order") ─────────────────

    /// The trials a full miss costs: two account keys, 72 contact secrets and 32 local-link secrets.
    public static let trialTotal = 2 + maxContactSecrets + maxLocalLinks

    /// Dummy trials after a miss behind the limiter, so a silent close costs `trialTotal` trials.
    public static func trialPadding(tried: Int) -> Int { max(0, trialTotal - tried) }

    public struct TrialEntry: Sendable, Equatable {
        /// `a` an account discovery key, `c` a contact secret, `l` a local-link secret.
        public let kind: Character
        /// Index in the list as held (an absent account key keeps its slot).
        public let index: Int
    }

    /// The order a shared listener tries message 1 in: the account's keys (an absent one is skipped), then
    /// the contact secrets (at most `maxContactSecrets`), then the local-link secrets in held order (at most
    /// `maxLocalLinks`). `account` is nil, or one flag per key slot: true when the key is present.
    public static func listenerTrialOrder(account: [Bool]?, contacts: Int, locals: Int) -> [TrialEntry] {
        var out: [TrialEntry] = []
        for (i, present) in (account ?? []).prefix(2).enumerated() where present {
            out.append(TrialEntry(kind: "a", index: i))
        }
        for i in 0..<min(contacts, maxContactSecrets) { out.append(TrialEntry(kind: "c", index: i)) }
        for i in 0..<min(locals, maxLocalLinks) { out.append(TrialEntry(kind: "l", index: i)) }
        return out
    }
}

// ── The joiner (§15.12, "The joiner") ────────────────────────────────────────────────

public enum LocalJoinInput: Sendable, Equatable {
    case code(nameplate: String)
    case qr(instance: String)
    case invalid
}

/// How one dial ended.
public enum LocalDialOutcome: String, Sendable, Equatable {
    case transport
    case beforeC2 = "before-c2"
    case afterC2 = "after-c2"
}

public enum LocalJoinResult: String, Sendable, Equatable {
    case transport
    case pairingCodeFailed = "pairing-code-failed"
    case pairingNotFound = "pairing-not-found"
}

/// The joiner's choices over one browse. A code or QR that did not parse browses nothing and answers
/// `pairing-code-failed`. Matching `m=q` adverts are kept once each in first-seen order, at most
/// `localJoinKept`, and the first `localJoinCandidates` are dialled, never redialled. The first session that
/// reaches the transport ends the dial.
public struct LocalJoinPlan: Sendable {
    private let input: LocalJoinInput
    public private(set) var kept: [String] = []
    private var dials = 0
    private var transport = false
    private var afterC2 = false

    public init(_ input: LocalJoinInput) { self.input = input }

    /// Whether anything is browsed at all.
    public var browses: Bool { input != .invalid }

    /// One `m=q` advert seen. `tagMatches` is whether its `h` is this product's tag of the current or
    /// previous epoch; `n` its nameplate. Returns whether it was kept.
    public mutating func see(instance: String, tagMatches: Bool, n: String) -> Bool {
        guard browses, tagMatches else { return false }
        let match: Bool
        switch input {
        case .code(let nameplate): match = n == nameplate
        case .qr(let i): match = instance == i
        case .invalid: match = false
        }
        if !match || kept.contains(instance) || kept.count >= localJoinKept { return false }
        kept.append(instance)
        return true
    }

    /// The next advert to dial, or nil when the dial has ended.
    public func next() -> String? {
        if transport || dials >= localJoinCandidates || dials >= kept.count { return nil }
        return kept[dials]
    }

    /// The dial of `next()` ended this way.
    public mutating func ended(_ outcome: LocalDialOutcome) {
        dials += 1
        if outcome == .transport { transport = true } else if outcome == .afterC2 { afterC2 = true }
    }

    /// The answer once no dial is left (or the browse ran out).
    public func result() -> LocalJoinResult {
        if input == .invalid { return .pairingCodeFailed }
        if transport { return .transport }
        return afterC2 ? .pairingCodeFailed : .pairingNotFound
    }
}

/// At most this many dials per nameplate in any `localDialBudgetSeconds`, across joins.
public let localDialBudget = 2
public let localDialBudgetSeconds = 300

/// The joiner's dials per typed nameplate across joins, in memory, per product (§15.12). A person who retypes
/// a code meets the same budget as one join: a fake advert that answers a dial gets one guess, so retries
/// must not multiply the dials. A QR names its instance and is never limited.
public struct LocalDialBudget: Sendable {
    private var dialled: [String: [Double]] = [:]

    public init() {}

    private mutating func recent(_ nameplate: String, _ t: Double) -> [Double] {
        let kept = (dialled[nameplate] ?? []).filter { t - $0 < Double(localDialBudgetSeconds) }
        dialled[nameplate] = kept
        return kept
    }

    /// Whether a join of this nameplate may browse and dial now, and the dials already spent.
    public mutating func check(_ nameplate: String, _ t: Double) -> (allowed: Bool, used: Int) {
        let used = recent(nameplate, t).count
        return (used < localDialBudget, used)
    }

    /// The join made `dials` dials.
    public mutating func spend(_ nameplate: String, _ t: Double, dials: Int) {
        dialled[nameplate] = recent(nameplate, t) + [Double](repeating: t, count: dials)
    }
}

// ── The pairing window (§15.12, "The pairing window") ────────────────────────────────

public enum LocalWindowResult: String, Sendable, Equatable {
    case opened
    case alreadyOpen = "already-open"
    case closed
    case busy
    case limited
    case refused
    case attempt
    case transport
    case failed
    case tooManyTries = "too-many-tries"
}

public enum LocalWindowClosed: String, Sendable, Equatable {
    case expired
    case tooManyTries = "too-many-tries"
    case stored
    case person
}

public struct LocalWindowOutcome: Sendable, Equatable {
    public var result: LocalWindowResult?
    /// The id of the attempt a C1 admitted.
    public var id: Int?
    /// The error the host hears: the fifth failed guess.
    public var host: String?
    /// The password and the QR secret rotate now. The window is `rotating` (busy, uncounted) until the host
    /// has made the new code and QR secret and computed both generators, and calls `rotated`.
    public var rotate: Bool

    public static let none = LocalWindowOutcome(result: nil, id: nil, host: nil, rotate: false)
}

public enum LocalWindowHolder: String, Sendable, Equatable { case attempt, session, rotating }

public struct LocalWindowState: Sendable, Equatable {
    public let open: Bool
    public let holder: LocalWindowHolder?
    /// Guesses counted: counted when permitted, refunded when one opens.
    public let failures: Int
    public let rotations: Int
    public let closed: LocalWindowClosed?
}

/// The shower's window over events with a monotonic time in seconds. A C1 that is admitted hands out an
/// attempt id; one attempt holds the window from its C1 until its guess or `localAttemptSeconds`.
///
/// A guess is counted before its tag is tried. The session asks `beginGuess(id, t)`, a synchronous permit
/// given once, to the holder's own attempt only, while the window is open; it counts the failure now (the
/// fifth closes the window once its verdict is in), and an attempt that was not permitted, a stale, expired
/// or closed one, answers false and its tag is never tried. A guess that opens is refunded (`guessOpened`)
/// and the attempt becomes the session; one that does not, and a permitted attempt whose connection ends
/// (`abandon`) or runs out its 30 s, is a failed guess (`guessFailed`): the password and the QR secret
/// rotate. The window is `rotating` until `rotated`, which the host calls once the new secrets and both
/// generators are ready (§15.12, step 6), so a C1 never meets the old password or a generator that is
/// still being made.
///
/// A refused C1 and an attempt that never reached its guess count nothing; a session that ends without a
/// link also rotates and holds the window until `rotated`. At most 5 C1s a minute are admitted, counted
/// when admitted; a busy C1 is never counted. The window expires `localPairSeconds` after it opened, which
/// closes a connection that has not reached the transport (the host closes it) and leaves a session
/// running. Attempt ids never repeat, so a connection of a closed window cannot touch the next one.
public struct LocalPairingWindow: Sendable {
    private var isOpen = false
    private var openedAt = 0.0
    private var holder: LocalWindowHolder?
    private var attempt: (id: Int, at: Double, guessed: Bool)?
    private var nextId = 1
    private var failures = 0
    private var rotations = 0
    private var closedFor: LocalWindowClosed?
    private var admits: [Double] = []

    public init() {}

    public var state: LocalWindowState {
        LocalWindowState(open: isOpen, holder: holder, failures: failures, rotations: rotations, closed: closedFor)
    }

    /// Apply the clocks: the window's expiry and an attempt's deadline.
    @discardableResult
    public mutating func tick(_ t: Double) -> LocalWindowOutcome {
        var out = LocalWindowOutcome.none
        if isOpen && t - openedAt >= Double(localPairSeconds) {
            isOpen = false
            closedFor = .expired
            // A counted guess stays counted; there is no window left to rotate.
            if holder == .attempt { drop() }
            if holder == .rotating { holder = nil }
        }
        if holder == .attempt, let a = attempt, t - a.at >= Double(localAttemptSeconds) {
            if a.guessed { out = failed() } else { drop() }
        }
        return out
    }

    private mutating func drop() {
        attempt = nil
        holder = nil
    }

    private func isHolder(_ id: Int) -> Bool { isOpen && holder == .attempt && attempt?.id == id }

    /// One window per device per product: an open window, or a session still running, answers `already-open`.
    public mutating func open(_ t: Double) -> LocalWindowOutcome {
        tick(t)
        if isOpen || holder == .session { return LocalWindowOutcome(result: .alreadyOpen, rotate: false) }
        isOpen = true
        openedAt = t
        holder = nil
        attempt = nil
        failures = 0
        rotations = 0
        closedFor = nil
        admits = []
        return LocalWindowOutcome(result: .opened, rotate: false)
    }

    /// A C1 arrived; `valid` is whether it passed the frame and share checks.
    public mutating func c1(_ t: Double, valid: Bool) -> LocalWindowOutcome {
        tick(t)
        if !isOpen { return LocalWindowOutcome(result: .closed, rotate: false) }
        if holder != nil { return LocalWindowOutcome(result: .busy, rotate: false) }
        admits = admits.filter { t - $0 < Double(localC1WindowSeconds) }
        if admits.count >= localC1PerWindow { return LocalWindowOutcome(result: .limited, rotate: false) }
        admits.append(t)
        if !valid { return LocalWindowOutcome(result: .refused, rotate: false) }
        let id = nextId
        nextId += 1
        holder = .attempt
        attempt = (id, t, false)
        return LocalWindowOutcome(result: .attempt, id: id, rotate: false)
    }

    /// The permit to try message 1's tag. True once, for the holder's own attempt, while the window is open
    /// and the attempt's 30 s have not run out; the guess is counted now. False otherwise: the session must
    /// not try the tag.
    public mutating func beginGuess(_ id: Int, _ t: Double) -> Bool {
        tick(t)
        guard isHolder(id), attempt?.guessed == false else { return false }
        attempt?.guessed = true
        failures += 1
        return true
    }

    /// The permitted guess opened: the count is refunded and the attempt is the session.
    public mutating func guessOpened(_ id: Int, _ t: Double) -> LocalWindowOutcome {
        tick(t)
        guard isHolder(id), attempt?.guessed == true else { return .none }
        failures -= 1
        attempt = nil
        holder = .session
        return LocalWindowOutcome(result: .transport, rotate: false)
    }

    /// The permitted guess did not open.
    public mutating func guessFailed(_ id: Int, _ t: Double) -> LocalWindowOutcome {
        tick(t)
        guard isHolder(id), attempt?.guessed == true else { return .none }
        return failed()
    }

    private mutating func failed() -> LocalWindowOutcome {
        attempt = nil
        if failures >= localPairFailures {
            isOpen = false
            closedFor = .tooManyTries
            holder = nil
            return LocalWindowOutcome(result: .tooManyTries, host: "pairing-code-failed", rotate: false)
        }
        rotations += 1
        holder = .rotating
        return LocalWindowOutcome(result: .failed, rotate: true)
    }

    /// Message 1 of `id`: the permit, then the verdict. Not permitted: nothing is tried, nothing changes.
    public mutating func msg1(_ id: Int, _ t: Double, opens: Bool) -> LocalWindowOutcome? {
        guard beginGuess(id, t) else { return nil }
        return opens ? guessOpened(id, t) : guessFailed(id, t)
    }

    /// The attempt's connection closed or timed out. A permitted guess with no verdict is failed.
    public mutating func abandon(_ id: Int, _ t: Double) -> LocalWindowOutcome {
        tick(t)
        guard isHolder(id) else { return .none }
        if attempt?.guessed == true { return failed() }
        drop()
        return .none
    }

    /// The new code, QR secret and both generators are ready: the window takes the next C1.
    public mutating func rotated(_ t: Double) {
        tick(t)
        if holder == .rotating { holder = nil }
    }

    /// The held session ended. A stored link closes the window; any other end rotates and holds the window
    /// until `rotated`.
    public mutating func sessionEnd(_ t: Double, stored: Bool) -> LocalWindowOutcome {
        tick(t)
        guard holder == .session else { return .none }
        holder = nil
        if stored {
            isOpen = false
            closedFor = .stored
            return .none
        }
        if !isOpen { return .none }
        rotations += 1
        holder = .rotating
        return LocalWindowOutcome(result: nil, rotate: true)
    }

    /// The person closed the window.
    @discardableResult
    public mutating func close(_ t: Double) -> LocalWindowOutcome {
        tick(t)
        if isOpen {
            isOpen = false
            closedFor = .person
            if holder == .attempt || holder == .rotating { drop() }
        }
        return .none
    }
}

// ── The gate (§15.12, "Gates") ───────────────────────────────────────────────────────

/// The cached discovery answer for local pairing.
public enum LocalGateState: String, Sendable, Equatable { case on, off, none }
/// What a read that left a cached `true` behind makes the host do.
public enum LocalGateEffect: String, Sendable, Equatable, CaseIterable {
    case closeWindows = "close-windows"
    case withdrawAdverts = "withdraw-adverts"
    case endSessions = "end-sessions"
}

extension PeerLocal {
    /// `services.connect.localPairing` of a discovery body: true only as the boolean `true` while
    /// `services.connect.enabled` is the boolean `true`. A body of any other shape, a disabled service and an
    /// absent member all read as false.
    public static func localPairingOf(_ body: JSONValue?) -> Bool {
        guard case .object(let root)? = body, case .object(let services)? = root["services"],
            case .object(let connect)? = services["connect"]
        else { return false }
        return connect["enabled"] == .bool(true) && connect["localPairing"] == .bool(true)
    }
}

/// The SDK's enforcement of the operator gate from the discovery document it cached. No cached document is
/// off, and offline a cached `true` keeps working. A successful read replaces the answer, a not-found
/// clears it, an error changes nothing; a read that leaves a cached `true` behind returns the effects the
/// host must carry out.
public struct LocalPairingGate: Sendable, Equatable {
    public private(set) var state: LocalGateState

    public init(_ state: LocalGateState = .none) { self.state = state }

    public var allowed: Bool { state == .on }

    /// A successful discovery read, from the body as JSON.
    public mutating func readOk(body: JSONValue?) -> [LocalGateEffect] {
        set(PeerLocal.localPairingOf(body) ? .on : .off)
    }

    /// A successful discovery read: `connectEnabled` and `localPairing` are `services.connect.enabled` and
    /// `services.connect.localPairing`, each true only as the boolean `true`.
    public mutating func readOk(connectEnabled: Bool, localPairing: Bool) -> [LocalGateEffect] {
        set(connectEnabled && localPairing ? .on : .off)
    }

    /// A not-found discovery read: the cached answer is cleared.
    public mutating func readNotFound() -> [LocalGateEffect] { set(.none) }

    /// A failed read (offline, an error status): nothing changes.
    public func readError() -> [LocalGateEffect] { [] }

    private mutating func set(_ next: LocalGateState) -> [LocalGateEffect] {
        let was = state
        state = next
        return was == .on && next != .on ? LocalGateEffect.allCases : []
    }
}

// ── The pairing exchange (§15.12, "Consent and LOCAL_LINK") ──────────────────────────

public enum LocalExchangeEvent: Sendable, Equatable {
    case ownConfirm
    case ownDecline
    case peerConfirm
    case peerLink(Data)
    /// 120 s from the first byte ran out.
    case timeoutConfirm
    /// `contactExchangeSeconds` after both `CONFIRM`s ran out.
    case timeoutExchange
}

public struct LocalExchangeStep: Sendable, Equatable {
    public enum Send: Sendable, Equatable { case confirm, localLink }
    /// The records this step makes the side send.
    public var sends: [Send] = []
    public var close: PeerCloseCode?
    /// The peer's `LOCAL_LINK`, valid, read in order: the host stores the link.
    public var stored: PeerLocal.LinkBody?
}

/// One side's order guard over the records of the pairing (§15.12, "Order of checks"). A `LOCAL_LINK` goes
/// out once this side has sent its `CONFIRM` and read the peer's; the peer's arrives only after both. The
/// first valid `LOCAL_LINK` is stored and the side closes `peer_bye`; after any close nothing happens, so a
/// second `LOCAL_LINK` is never answered.
public struct LocalExchange: Sendable {
    private var ownConfirmed = false
    private var peerConfirmed = false
    private var linkSent = false
    private var dead = false
    private let held: Int
    private let cats: [String]

    /// `held` is the number of local links the device holds; `cats` are this side's approved ones.
    public init(held: Int, cats: [String]) {
        self.held = held
        self.cats = cats
    }

    /// Both `CONFIRM`s are done (this side's sent, the peer's read), and no link has closed the session.
    public var bothConfirmed: Bool { !dead && ownConfirmed && peerConfirmed }

    public mutating func step(_ e: LocalExchangeEvent) -> LocalExchangeStep {
        var r = LocalExchangeStep()
        if dead { return r }
        func end(_ r: inout LocalExchangeStep, _ close: PeerCloseCode) -> LocalExchangeStep {
            dead = true
            r.close = close
            return r
        }
        func maybeLink(_ r: inout LocalExchangeStep) {
            if ownConfirmed && peerConfirmed && !linkSent {
                linkSent = true
                r.sends.append(.localLink)
            }
        }
        switch e {
        case .ownConfirm:
            if ownConfirmed { return r }
            ownConfirmed = true
            r.sends.append(.confirm)
            maybeLink(&r)
            return r
        case .ownDecline:
            // A decline after this side's CONFIRM is not an event: the person already agreed.
            return ownConfirmed ? r : end(&r, .peerBye)
        case .peerConfirm:
            if peerConfirmed { return end(&r, .peerBadFrame) }
            peerConfirmed = true
            maybeLink(&r)
            return r
        case .peerLink(let body):
            if !ownConfirmed || !peerConfirmed { return end(&r, .peerBadFrame) }
            guard let v = PeerLocal.parseLocalLink(body) else { return end(&r, .peerBadFrame) }
            if held >= maxLocalLinks { return end(&r, .peerNotAllowed) }
            r.stored = PeerLocal.LinkBody(label: v.label, cats: PeerLocal.categories(cats, v.cats))
            return end(&r, .peerBye)
        case .timeoutConfirm:
            return ownConfirmed && peerConfirmed ? r : end(&r, .peerTimeout)
        case .timeoutExchange:
            return ownConfirmed && peerConfirmed ? end(&r, .peerTimeout) : r
        }
    }
}
