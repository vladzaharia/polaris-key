// WIRE-CONTRACT-V5 §15.6.1: the codecs and rules of mode v, the vouch (CC-15.S1). Swift mirror of
// client-core's `peer/vouch.ts`. Pure: no I/O, no clock the caller does not hand in, no route. D is the
// device with no sign-in (the initiator); M is the signed-in device nearby (the responder). The vectors
// are `peer-matrix.json` `vouch`.
//
// What lives here: the `VOUCH_REQ` body (build, parse, verify), the `VOUCH_RESULT` body, M's reading of
// the `nearby/approve` answer (`PeerVouch.finishMap`), the number-matching decoys (`PeerVouch.decoyCodes`),
// the approver's advert instance, the failure budget, and `VouchFlow`, the order guard both ends run over
// the records of one session. What does not: the session itself (`PeerSession.swift`), the routes, the
// adverts' sockets and the prompt. Failures carry a close code and never a value: the request handle,
// `sig`, `h`, the nonces and the one-time keys appear in no message here (G19).

import Foundation

/// The capability both mode-v payloads list (rule 1).
public let vouchCap = "vouch/1"
/// A `VOUCH_REQ` body is at most this many bytes (rule 5).
public let vouchReqMax = 4096
/// Rule 12: records D holds before its person confirms the account.
public let vouchHeldRecords = 16
public let vouchHeldBytes = 16 * 1024
/// Rule 2: the advert's listener and instance are renewed this often.
public let approverRenewSeconds = 300
/// Rule 2: this many prompted failures within the window stop the advert.
public let vouchFailureLimit = 2
public let vouchFailureWindowSeconds: TimeInterval = 600

// MARK: - Display data from a peer that is not yet verified

/// WIRE-CONTRACT-V5 §15.6 and §15.6.1: display data from a peer that is not yet verified (a mode v or p
/// `HELLO`, a `VOUCH_REQ`) is cleaned the same way wherever it is read. One place, so the session and the
/// vouch codecs cannot drift apart. Mirrors client-core's `peer/display.ts`.
public enum PeerDisplay {
    /// NFC, then the device-label cleaning (§12.7.1): nil when nothing is left.
    public static func cleanLabel(_ raw: String) -> String? {
        normalizeDeviceLabel(raw.precomposedStringWithCanonicalMapping)
    }

    /// The platform as sent when it is 1 to 32 of [A-Za-z0-9 ._+-], else "Unknown".
    public static func cleanPlatform(_ raw: String) -> String {
        let u = Array(raw.utf8)
        let ok =
            (1...32).contains(u.count)
            && u.allSatisfy { c in
                (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x20
                    || c == 0x2E || c == 0x5F || c == 0x2B || c == 0x2D
            }
        return ok ? raw : peerUnknownDisplay
    }

    /// The app name, cleaned like a label; "Unknown" when nothing is left.
    public static func cleanApp(_ raw: String) -> String { cleanLabel(raw) ?? peerUnknownDisplay }

    /// Scalar-wise equality: Swift's `String ==` is canonical equivalence, which would merge two labels
    /// that differ on the wire.
    static func same(_ a: String?, _ b: String?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (let x?, let y?): return Array(x.unicodeScalars) == Array(y.unicodeScalars)
        default: return false
        }
    }
}

// MARK: - Randomness

/// CSPRNG bytes (`SystemRandomNumberGenerator`).
public func peerSystemRandom(_ n: Int) -> Data {
    var g = SystemRandomNumberGenerator()
    return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
}

/// A source of random bytes; a test injects a fixed one.
public typealias PeerRandom = @Sendable (Int) -> Data

// MARK: - The types

/// What D's `HELLO` showed (display data), as M holds it.
public struct VouchHello: Sendable, Equatable {
    public let label: String?
    public let platform: String

    public init(label: String? = nil, platform: String) {
        self.label = label
        self.platform = platform
    }
}

/// A verified request: exactly what M sends to `nearby/approve` (rule 5).
public struct VouchRequest: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    public let request: String
    public let deviceId: String
    public let signKey: String
    public let agreeKey: String
    public let label: String?
    public let platform: String

    /// The handle is a secret (G19): a log line or a repr never prints it.
    public var description: String { "VouchRequest()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A `VOUCH_REQ` body that passed every check that needs no session (rule 5), signature unread.
public struct ParsedVouchRequest: Sendable, Equatable {
    public let request: String
    public let deviceId: String
    public let signKey: String
    public let agreeKey: String
    public let label: String?
    public let platform: String
    /// Unverified until `PeerVouch.verifyRequest`.
    public let sig: String
}

public enum VouchStatus: String, Sendable, Equatable {
    case approved, denied, expired
}

public enum VouchError: Error, Sendable, Equatable {
    /// An input to `buildRequest` is malformed, or the keys changed while signing.
    case badInput
    case tooLarge
}

/// The answer of `nearby/approve` as the host read it (rule 6).
public struct VouchApproveAnswer: Sendable, Equatable {
    /// The HTTP status, or nil when there was no answer.
    public let http: Int?
    /// The body text, or nil when none.
    public let body: String?
    /// M's fresh read: does discovery still name `nearby` and `nearbyApprove`?
    public let discoveryNearby: Bool
    /// True once M already answered a `device_keys_required` by registering its keys.
    public let keysRetried: Bool

    public init(http: Int?, body: String?, discoveryNearby: Bool, keysRetried: Bool = false) {
        self.http = http
        self.body = body
        self.discoveryNearby = discoveryNearby
        self.keysRetried = keysRetried
    }
}

public enum VouchFinishAction: Sendable, Equatable {
    /// Send this `VOUCH_RESULT`. After any status but `approved`, close `peer_bye`.
    case send(VouchStatus)
    /// Nothing yet: show the licence choice, or register keys (§15.8), then call again.
    case waitChoice
    case waitKeys
    /// Send nothing and close `peer_bye`; `stopAdvert` when discovery lost `nearby`.
    case close(stopAdvert: Bool)
}

/// The three codes M shows and where the real one stands.
public struct VouchDecoys: Sendable, Equatable {
    /// Three distinct codes, each in [0, 10^6), the real one among them.
    public let codes: [Int]
    /// Where the real code stands in `codes`.
    public let index: Int
}

// MARK: - The codecs

public enum PeerVouch {
    // MARK: VOUCH_REQ

    private static func isRequest(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return u.count == 25 && u[0] == 0x6E && u[1] == 0x72 && u[2] == 0x5F && u[3...].allSatisfy(urlSafe)
    }

    private static func isDeviceId(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return u.count == 32 && u.allSatisfy(urlSafe)
    }

    private static func urlSafe(_ c: UInt8) -> Bool {
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F
    }

    private static func quoted(_ s: String) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? enc.encode(s)) ?? Data(), as: UTF8.self)
    }

    /// The `VOUCH_REQ` body D sends after it showed the code (rule 5). `h` is this session's handshake
    /// hash; `request` the handle from `nearby/start`; `deviceId` the `X-PKey-Device` value sent on
    /// `start`; `hello` what D's `HELLO` carried. Throws `VouchError` on a malformed input.
    public static func buildRequest(
        port: any DeviceKeyPort, slug: String, h: Data, request: String, deviceId: String, hello: VouchHello
    ) async throws -> Data {
        guard h.count == 32, isRequest(request), isDeviceId(deviceId) else { throw VouchError.badInput }
        let proof: DeviceProof
        do {
            proof = try await DeviceProofs.sign(
                port, purpose: .vouch, product: slug, deviceId: deviceId,
                value: "\(Base64URL.encode(h)).\(request)")
        } catch { throw VouchError.badInput }
        guard let keys = try await port.publicKeys(), keys.signKey == proof.signKey else {
            throw VouchError.badInput
        }
        var s = #"{"v":1,"request":\#(quoted(request)),"deviceId":\#(quoted(deviceId)),"#
        s += #""signKey":\#(quoted(keys.signKey)),"agreeKey":\#(quoted(keys.agreeKey)),"#
        if let l = hello.label { s += #""label":\#(quoted(l)),"# }
        s += #""platform":\#(quoted(hello.platform)),"sig":\#(quoted(proof.sig))}"#
        let body = Data(s.utf8)
        guard body.count <= vouchReqMax else { throw VouchError.tooLarge }
        return body
    }

    /// Strict JSON, size, shape and key checks; nil means close `peer_bad_frame`.
    public static func parseRequest(_ body: Data) -> ParsedVouchRequest? {
        guard body.count <= vouchReqMax, let (o, nonWire) = PeerPayload.parseStrictObject(body),
            case .int(let v)? = o["v"], wireInteger(v, pointer: "/v", min: 1, in: nonWire), v == 1,
            case .string(let request)? = o["request"], isRequest(request),
            case .string(let deviceId)? = o["deviceId"], isDeviceId(deviceId),
            case .string(let signKey)? = o["signKey"], let sk = DeviceProofs.raw32(signKey),
            Ed25519Strict.acceptablePoint(sk),
            case .string(let agreeKey)? = o["agreeKey"], DeviceProofs.agreeKeyOK(agreeKey),
            case .string(let platform)? = o["platform"], case .string(let sig)? = o["sig"]
        else { return nil }
        var label: String?
        if let l = o["label"] {
            guard case .string(let raw) = l else { return nil }
            label = PeerDisplay.cleanLabel(raw)
        }
        return ParsedVouchRequest(
            request: request, deviceId: deviceId, signKey: signKey, agreeKey: agreeKey, label: label,
            platform: PeerDisplay.cleanPlatform(platform), sig: sig)
    }

    /// M's whole check of a `VOUCH_REQ` (rule 5): the parse, the proof over this session's `h`, and the
    /// equality of `label` and `platform` with `HELLO`. nil means close `peer_bad_frame` and call no route.
    ///
    /// `helloCleaned`: `hello` is the `HELLO` the session already cleaned (what `PeerHello` carries): it is
    /// compared as it is. Without it the label is cleaned again, and the cleaning is not idempotent (an
    /// invisible mark between a base and a combining mark can change a second time), so an honest D would
    /// be refused.
    public static func verifyRequest(
        slug: String, h: Data, hello: VouchHello, helloCleaned: Bool = false, body: Data
    ) -> VouchRequest? {
        guard let p = parseRequest(body) else { return nil }
        let proof = DeviceProof(
            fields: DeviceProofFields(
                purpose: DeviceProofPurpose.vouch.rawValue, product: slug, deviceId: p.deviceId,
                value: "\(Base64URL.encode(h)).\(p.request)", tokenHash: "-"),
            signKey: p.signKey, sig: p.sig)
        guard DeviceProofs.verify(proof) else { return nil }
        let helloLabel = hello.label.flatMap { helloCleaned ? $0 : PeerDisplay.cleanLabel($0) }
        guard PeerDisplay.same(p.label, helloLabel),
            PeerDisplay.same(p.platform, PeerDisplay.cleanPlatform(hello.platform))
        else { return nil }
        return VouchRequest(
            request: p.request, deviceId: p.deviceId, signKey: p.signKey, agreeKey: p.agreeKey, label: p.label,
            platform: p.platform)
    }

    // MARK: VOUCH_RESULT

    /// The `VOUCH_RESULT` body M sends.
    public static func buildResult(_ status: VouchStatus) -> Data { Data(#"{"status":"\#(status.rawValue)"}"#.utf8) }

    public enum ResultReading: Sendable, Equatable {
        case status(VouchStatus)
        case refuse(PeerCloseCode)
    }

    /// D's reading of a `VOUCH_RESULT` (rule 6): display data only. An unknown status reads as `denied`; a
    /// body that is not an object with a string `status` closes `peer_bad_frame`.
    public static func parseResult(_ body: Data) -> ResultReading {
        guard let (o, _) = PeerPayload.parseStrictObject(body), case .string(let s)? = o["status"] else {
            return .refuse(.peerBadFrame)
        }
        return .status(VouchStatus(rawValue: s) ?? .denied)
    }

    // MARK: M reads the answer of nearby/approve

    /// Rule 6's table. Anything it does not list closes.
    public static func finishMap(_ r: VouchApproveAnswer) -> VouchFinishAction {
        guard let http = r.http else { return .close(stopAdvert: false) }
        let o = r.body.flatMap { PeerPayload.parseStrictObject(Data($0.utf8))?.object }
        var code: String?
        if case .string(let c)? = o?["code"] { code = c }
        var status: String?
        if case .string(let s)? = o?["status"] { status = s }
        switch http {
        case 200:
            if status == "approved" { return .send(.approved) }
            return status == "choose" ? .waitChoice : .close(stopAdvert: false)
        case 204:
            return .send(.denied)
        case 403:
            // D hears `denied` for both, so a session holder cannot tell which refusal an account hit.
            return code == "not_nearby" || code == "device_limit" ? .send(.denied) : .close(stopAdvert: false)
        case 404:
            // The 404 is ambiguous (rule 6): `expired` only while discovery still names the routes.
            return r.discoveryNearby ? .send(.expired) : .close(stopAdvert: true)
        case 409:
            if code == "device_keys_required" { return r.keysRetried ? .close(stopAdvert: false) : .waitKeys }
            return code == "license_choice_required" ? .waitChoice : .close(stopAdvert: false)
        default:
            return .close(stopAdvert: false)
        }
    }

    // MARK: Randomness: decoys, positions and the advert instance

    /// Draws that may be rejected before a generator that cannot produce a value is given up on.
    private static let maxDraws = 256

    /// A uniform integer in [0, n) by rejection sampling over 32-bit draws; never `x % n` alone.
    static func uniformBelow(_ n: Int, _ random: PeerRandom) throws -> Int {
        let limit = (Int(UInt32.max) + 1) / n * n
        for _ in 0..<maxDraws {
            let b = [UInt8](random(4))
            guard b.count == 4 else { break }
            let x = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
            if x < limit { return x % n }
        }
        throw VouchError.badInput
    }

    /// The three codes M shows (rule 4): the session's `real` code and two decoys by rejection sampling,
    /// distinct, and the real one at a uniform position by a partial Fisher-Yates shuffle.
    public static func decoyCodes(real: Int, random: PeerRandom = peerSystemRandom) throws -> VouchDecoys {
        guard (0..<1_000_000).contains(real) else { throw VouchError.badInput }
        var slots: [(code: Int, real: Bool)] = [(real, true)]
        // A source that keeps repeating a code is given up on, not looped on.
        var tries = 0
        while slots.count < 3 {
            if tries >= maxDraws { throw VouchError.badInput }
            tries += 1
            let code = try uniformBelow(1_000_000, random)
            if !slots.contains(where: { $0.code == code }) { slots.append((code, false)) }
        }
        var i = 2
        while i > 0 {
            let j = try uniformBelow(i + 1, random)
            slots.swapAt(i, j)
            i -= 1
        }
        return VouchDecoys(codes: slots.map(\.code), index: slots.firstIndex(where: { $0.real })!)
    }

    /// The approver's advert instance (rule 2): `p1-` and 10 CSPRNG bytes in base32, 16 characters.
    public static func approverInstance(random: PeerRandom = peerSystemRandom) -> String {
        "p1-" + PeerAdvert.base32Lower(random(10))
    }
}

// MARK: - The failure budget (rule 2)

/// M counts the failures of sessions whose prompt was shown (a wrong pick, "None of these match", a 120 s
/// timeout, a peer that closes before the person answered) against a monotonic clock. The second within
/// 10 minutes stops the advert, and it stays stopped until the person reopens "Approve a nearby device".
/// A session that was only queued, or shown the passive notice, counts for nothing: the caller does not
/// report it.
public final class VouchFailureBudget: Sendable {
    private struct State: Sendable {
        var at: [TimeInterval] = []
        var halted = false
    }
    private let state = LockedValue(State())
    private let mono: @Sendable () -> TimeInterval

    /// `mono` is monotonic seconds.
    public init(mono: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.mono = mono
    }

    /// Record one failure; true when the advert must stop now.
    public func fail() -> Bool {
        let now = mono()
        return state.with { s in
            s.at = s.at.filter { now - $0 < vouchFailureWindowSeconds }
            s.at.append(now)
            if s.at.count >= vouchFailureLimit { s.halted = true }
            return s.halted
        }
    }

    /// True while the advert must stay off.
    public var stopped: Bool { state.with { $0.halted } }

    /// The person reopened "Approve a nearby device": the count starts again.
    public func reopen() {
        state.with {
            $0.at = []
            $0.halted = false
        }
    }
}

// MARK: - The order guard (rules 1, 4, 5, 7, 8, 12)

public protocol VouchRecordLike: Sendable {
    var type: Int { get }
    var body: Data { get }
}

public struct VouchRecord: VouchRecordLike, Equatable {
    public let type: Int
    public let body: Data

    public init(type: Int, body: Data) {
        self.type = type
        self.body = body
    }
}

public enum VouchVerdict<R: VouchRecordLike>: Sendable {
    /// Records to hand on now: this one, or ones held earlier, in order. May be empty.
    case ok(deliver: [R])
    case close(PeerCloseCode)
}

public enum VouchRole: Sendable, Equatable { case requester, approver }
public enum VouchAbandon: Sendable, Equatable { case wrongPick, noneMatch, stop, timeout }

/// One end's order guard over the vouch records of one session. D is the `requester`, M the `approver`.
/// Every record is checked in both directions: `receive` for what arrives, `send` for what this end is
/// about to send, with the same codes (rule 7). After a close verdict the flow is dead and answers with that
/// code again.
///
/// - `VOUCH_REQ`: D to M, once, after D showed the code. M's flow holds it until the person's right pick
///   (`picked`), so a wrong pick, "None of these match", a timeout or a stop (`abandon`) never delivers it.
/// - `VOUCH_RESULT`: M to D, at most once, after a verified `VOUCH_REQ`.
/// - `0x0030` to `0x003F`: M to D, only after an `approved` result; D holds them (16 records, 16 KiB, then
///   `peer_busy`) until its person confirms the account (`confirmAccount`, rule 12).
///
/// No silent approval (rule 10): `mayFinish` is true only after the right pick and a verified request, which
/// is when `nearby/approve` may be called.
public final class VouchFlow<R: VouchRecordLike>: @unchecked Sendable {
    public let role: VouchRole
    private struct State {
        var dead: PeerCloseCode?
        var negotiated = false
        var shown = false
        var picked = false
        var requestSeen = false
        var requestSent = false
        var held: R?
        var verified = false
        var resultSent = false
        var resultSeen = false
        var status: VouchStatus?
        var confirmed = false
        var queue: [R] = []
        var queueBytes = 0
    }
    private let state = LockedValue(State())

    public init(role: VouchRole) { self.role = role }

    private static func isSync(_ t: Int) -> Bool { t >= 0x0030 && t <= 0x003f }

    private func close(_ s: inout State, _ code: PeerCloseCode) -> VouchVerdict<R> {
        if s.dead == nil { s.dead = code }
        s.held = nil
        s.queue = []
        s.queueBytes = 0
        return .close(s.dead!)
    }

    /// Rule 1: both payloads list `vouch/1`; call once, when the session is `established`.
    public func negotiate(local: [String], remote: [String]) -> VouchVerdict<R> {
        state.with { s in
            if let d = s.dead { return .close(d) }
            if !PeerPayload.capsIntersection(local, remote).contains(vouchCap) { return close(&s, .peerNotAllowed) }
            s.negotiated = true
            return .ok(deliver: [])
        }
    }

    /// This side's screen shows the code (D: the code; M: the three codes).
    public func codeShown() { state.with { $0.shown = true } }

    /// M: the person picked the code D shows. Hands over the held request, if it arrived.
    public func picked() -> VouchVerdict<R> {
        state.with { s in
            if let d = s.dead { return .close(d) }
            if role != .approver || !s.negotiated || !s.shown { return close(&s, .peerNotAllowed) }
            s.picked = true
            let out = s.held.map { [$0] } ?? []
            s.held = nil
            return .ok(deliver: out)
        }
    }

    /// M: the session ends before a right pick; the request is never delivered (rule 4).
    public func abandon(_ reason: VouchAbandon) -> VouchVerdict<R> {
        state.with { s in close(&s, reason == .timeout ? .peerTimeout : .peerBye) }
    }

    /// M: the delivered request verified (`PeerVouch.verifyRequest`).
    public func verified() {
        state.with { s in if s.picked && s.requestSeen { s.verified = true } }
    }

    /// M: may `nearby/approve` be called for this session? (rule 10; N12)
    public var mayFinish: Bool {
        state.with { $0.dead == nil && $0.verified && !$0.resultSent && role == .approver }
    }

    /// D: the person confirmed the signed-in account; held records are handed over (rule 12).
    public func confirmAccount() -> VouchVerdict<R> {
        state.with { s in
            if let d = s.dead { return .close(d) }
            s.confirmed = true
            let out = s.queue
            s.queue = []
            s.queueBytes = 0
            return .ok(deliver: out)
        }
    }

    /// D: the person declined, or the screen timed out: every held record is dropped (rule 12).
    public func declineAccount() -> VouchVerdict<R> {
        state.with { s in close(&s, .peerBye) }
    }

    /// A record arrived from the peer.
    public func receive(_ r: R) -> VouchVerdict<R> {
        state.with { s in
            if let d = s.dead { return .close(d) }
            if r.type == PeerRecordType.vouchReq { return receiveRequest(&s, r) }
            if r.type == PeerRecordType.vouchResult { return receiveResult(&s, r) }
            if Self.isSync(r.type) { return receiveSync(&s, r) }
            return .ok(deliver: [r])
        }
    }

    private func receiveRequest(_ s: inout State, _ r: R) -> VouchVerdict<R> {
        if role != .approver || !s.negotiated { return close(&s, .peerNotAllowed) }
        if s.requestSeen { return close(&s, .peerBadFrame) }
        s.requestSeen = true
        if s.picked { return .ok(deliver: [r]) }
        s.held = r
        return .ok(deliver: [])
    }

    private func receiveResult(_ s: inout State, _ r: R) -> VouchVerdict<R> {
        if role != .requester || !s.negotiated || !s.requestSent { return close(&s, .peerNotAllowed) }
        if s.resultSeen { return close(&s, .peerBadFrame) }
        switch PeerVouch.parseResult(r.body) {
        case .refuse(let c): return close(&s, c)
        case .status(let st):
            s.resultSeen = true
            s.status = st
            return .ok(deliver: [r])
        }
    }

    private func receiveSync(_ s: inout State, _ r: R) -> VouchVerdict<R> {
        if role != .requester || !s.negotiated || s.status != .approved { return close(&s, .peerNotAllowed) }
        if s.confirmed { return .ok(deliver: [r]) }
        if s.queue.count >= vouchHeldRecords || s.queueBytes + r.body.count > vouchHeldBytes {
            return close(&s, .peerBusy)
        }
        s.queue.append(r)
        s.queueBytes += r.body.count
        return .ok(deliver: [])
    }

    /// This end is about to send a record. The sender's checks are the receiver's.
    public func send(_ r: R) -> VouchVerdict<R> {
        state.with { s in
            if let d = s.dead { return .close(d) }
            if r.type == PeerRecordType.vouchReq {
                if role != .requester || !s.negotiated || !s.shown { return close(&s, .peerNotAllowed) }
                if s.requestSent { return close(&s, .peerBadFrame) }
                s.requestSent = true
                return .ok(deliver: [r])
            }
            if r.type == PeerRecordType.vouchResult {
                if role != .approver || !s.verified { return close(&s, .peerNotAllowed) }
                if s.resultSent { return close(&s, .peerBadFrame) }
                switch PeerVouch.parseResult(r.body) {
                case .refuse(let c): return close(&s, c)
                case .status(let st):
                    s.resultSent = true
                    s.status = st
                    return .ok(deliver: [r])
                }
            }
            if Self.isSync(r.type) {
                if role != .approver || s.status != .approved { return close(&s, .peerNotAllowed) }
                return .ok(deliver: [r])
            }
            return .ok(deliver: [r])
        }
    }
}
