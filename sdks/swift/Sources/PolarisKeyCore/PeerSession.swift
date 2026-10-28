// WIRE-CONTRACT-V5 §15.5 and §15.6: one `pkey-peer/1` session, per mode (`a` account, `v` approver,
// `p` pair) (CC-11.8, CC-11.9). Swift mirror of client-core's `peer/session.ts` and the Python
// port's `core/peer_session.py`.
//
// Modes v and p: after HELLO the initiator (the device) commits to a nonce, the responder (the
// approver) answers with its own, the initiator reveals, and both show the same six-digit code.
// The host calls `confirmSas()` when the person agrees; until then host records from the peer are
// held (at most 16), and HELLO display data is unauthenticated. A responder in these modes needs a
// `HandshakeLimiter`.
//
// An engine that owns no socket and starts no timer: Noise messages come in through `receive`
// (already de-framed) and go out through `send`; the host's loop calls `tick()` when `wakeIn()`
// says a deadline is due. Clocks are injected (`now` in epoch seconds, `mono` in monotonic
// seconds).
//
// Order: Noise XXpsk0 with the payload rules of §15.5; each side verifies the other's certificate
// against the remote static key and the held roster; then HELLO each way, which must be the first
// record. Nothing is delivered to the host (`.record`) before that. Every failure ends the
// session; before the transport exists nothing is sent, after it a CLOSE record names the code.
//
// Keys (G1): the device's static private key stays behind `PeerNoiseStaticKey`, whose `dh` the
// Noise engine calls. Nothing here prints a key, certificate, roster or record body (G19).

import Foundation

/// Seconds from the first byte to the transport.
public let peerTransportDeadlineSeconds: TimeInterval = 30
public let peerSasDeadlineSeconds: TimeInterval = 120
let peerPongsPerSecond = 16

/// Why a session ended: a close code, or `handshake_failed` (nothing is sent for that one).
public enum PeerClosedReason: String, Sendable, Equatable {
    case peerRevoked = "peer_revoked"
    case peerExpired = "peer_expired"
    case peerBadFrame = "peer_bad_frame"
    case peerUnknownCritical = "peer_unknown_critical"
    case peerNotAllowed = "peer_not_allowed"
    case peerBusy = "peer_busy"
    case peerBye = "peer_bye"
    case peerTimeout = "peer_timeout"
    case handshakeFailed = "handshake_failed"

    init(_ c: PeerCloseCode) { self = PeerClosedReason(rawValue: c.rawValue)! }
}

/// The peer's HELLO: display data (authenticated in mode a, by the certificate that opened the
/// session).
public struct PeerHello: Sendable, Equatable {
    public let label: String?
    public let platform: String
    public let app: String
    public let maxMessage: Int

    public init(label: String?, platform: String, app: String, maxMessage: Int) {
        self.label = label
        self.platform = platform
        self.app = app
        self.maxMessage = maxMessage
    }
}

/// What mode a needs: this device's certificate, roster view and trust.
public struct PeerAccountContext: Sendable, CustomStringConvertible, CustomReflectable {
    public var trust: TrustSet
    /// `aud`: the product slug.
    public var expectedAud: String
    /// This device's `pkey-peer+jws`.
    public var certJws: String
    public var ownSub: String
    public var ownDeviceId: String
    /// The held roster and its epoch, read at use.
    public var heldRing: @Sendable () -> (jws: String, epoch: Int)?
    /// The delivered discovery keys, newest first. The initiator uses the first; the responder
    /// tries the first two. An absent (nil) previous key is skipped.
    public var discKeys: [Data?]

    public init(
        trust: TrustSet, expectedAud: String, certJws: String, ownSub: String, ownDeviceId: String,
        heldRing: @escaping @Sendable () -> (jws: String, epoch: Int)?, discKeys: [Data?]
    ) {
        self.trust = trust
        self.expectedAud = expectedAud
        self.certJws = certJws
        self.ownSub = ownSub
        self.ownDeviceId = ownDeviceId
        self.heldRing = heldRing
        self.discKeys = discKeys
    }

    public var description: String { "PeerAccountContext()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

public struct PeerEstablished: Sendable, Equatable {
    public let caps: [String]
    public let hello: PeerHello
    public let helloAuthenticated: Bool
    public let remoteStatic: Data
    /// The admitted certificate's device id.
    public let peerDeviceId: String?
}

public enum PeerSessionEvent: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    /// The handshake and the HELLO exchange are done and the session is open.
    case established(PeerEstablished)
    /// Modes v and p: the code both screens show; the host calls `confirmSas()` when the person
    /// agrees.
    case sas(code: Int, display: String)
    /// A record the host owns, delivered only once the session is open. The host must close on an
    /// APP_CRITICAL type (0x8100 to 0xFFFD) it does not understand.
    case record(type: Int, body: Data)
    /// A roster that replaced the held one at `epoch`; the host stores it.
    case ring(jws: String, epoch: Int)
    /// A `TRUST` document the peer sent. Not verified here; the host verifies it (V4 §1).
    case trustUnverified(jws: String)
    /// The peer is on a newer roster than the held one, or none is held: fetch it.
    case ringWanted
    case closed(PeerClosedReason, byPeer: Bool)

    public var description: String {
        switch self {
        case .established: return "PeerSessionEvent.established"
        case .sas: return "PeerSessionEvent.sas"
        case .record(let t, _): return "PeerSessionEvent.record(type: \(t))"
        case .ring(_, let e): return "PeerSessionEvent.ring(epoch: \(e))"
        case .trustUnverified: return "PeerSessionEvent.trustUnverified"
        case .ringWanted: return "PeerSessionEvent.ringWanted"
        case .closed(let c, let b): return "PeerSessionEvent.closed(\(c.rawValue), byPeer: \(b))"
        }
    }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

public enum PeerChannelError: Error, Sendable, Equatable {
    /// The account context or the admission limiter does not fit the mode and role.
    case mode
    case notOpen
    /// A record type the session owns (HELLO, CLOSE, REKEY, the SAS records).
    case ownedRecord
    case messageTooLarge
}

/// The approver's admission: at most `maxPerMinute` handshakes a minute (default 5) and at most
/// `maxPending` sessions waiting on a code (default 4), on a monotonic clock. An attempt counts
/// only when `begin()` is called, which a session does when it starts.
public final class HandshakeLimiter: Sendable {
    private struct State: Sendable {
        var stamps: [TimeInterval] = []
        var pending = 0
    }
    private let maxPerMinute: Int
    private let maxPending: Int
    private let mono: @Sendable () -> TimeInterval
    private let state = LockedValue(State())

    public init(
        maxPerMinute: Int = 5, maxPending: Int = 4,
        mono: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.maxPerMinute = maxPerMinute
        self.maxPending = maxPending
        self.mono = mono
    }

    /// A release function when one more session may start now; nil when refused.
    public func begin() -> (@Sendable () -> Void)? {
        let t = mono()
        let ok = state.with { s -> Bool in
            s.stamps = s.stamps.filter { t - $0 < 60 }
            if s.stamps.count >= maxPerMinute || s.pending >= maxPending { return false }
            s.stamps.append(t)
            s.pending += 1
            return true
        }
        guard ok else { return nil }
        let done = LockedValue(false)
        return { [state] in
            let first = done.with { d -> Bool in
                if d { return false }
                d = true
                return true
            }
            if first { state.with { $0.pending -= 1 } }
        }
    }
}

private struct Fail: Error {
    let code: PeerClosedReason
    init(_ code: PeerClosedReason) { self.code = code }
}

private let knownClose: Set<String> = Set(PeerCloseCode.allCases.map(\.rawValue))
private let owned: Set<Int> = [
    PeerRecordType.hello, PeerRecordType.close, PeerRecordType.rekey, PeerRecordType.sasCommit,
    PeerRecordType.sasNonce, PeerRecordType.sasReveal,
]

public actor PeerChannel: CustomStringConvertible, CustomReflectable {
    public enum Role: Sendable { case initiator, responder }

    private let mode: PeerNoiseMode
    private let role: Role
    private let slug: String
    private let staticKey: any PeerNoiseStaticKey
    private let acct: PeerAccountContext?
    private let admission: HandshakeLimiter?
    private let random: @Sendable (Int) -> Data
    private var release: (@Sendable () -> Void)?
    private let sendNoise: @Sendable (Data) -> Void
    private let onEvent: @Sendable (PeerSessionEvent) -> Void
    private let helloLabel: String?
    private let helloPlatform: String
    private let helloApp: String
    private let helloMax: Int
    private let now: @Sendable () -> Int
    private let mono: @Sendable () -> TimeInterval
    private let rekeyMessages: Int
    private let rekeySeconds: TimeInterval

    private var asm: PeerRecordAssembler
    private var hs: PeerNoiseHandshake?
    private var hsStep = 0
    private enum Phase { case handshake, hello, sas, sasShown, open, closed }
    private var phase = Phase.handshake
    private var tp: PeerNoiseTransport?
    private var peerCaps: [String] = []
    private var peerRing = 0
    private var caps: [String]
    private var sent = 0
    private var pongWindow: TimeInterval = -.infinity
    private var pongs = 0
    private var keyedAt: TimeInterval
    private var maxSend = peerMaxMessageBytes
    private var started = false
    private var transportDue: TimeInterval?
    private var certExpires: Int?
    private var sasDue: TimeInterval?
    private var nD: Data?
    private var nM: Data?
    private var commit: String?
    private var sasDone = false
    private var sasStep = 0
    private var queued: [(type: Int, body: Data)] = []
    private var peerCertJws = ""
    private var peerRemote: Data?
    private var pending: (remote: Data, deviceId: String?)?

    // One call at a time: a handshake step awaits the key port, and another call must not
    // interleave with it.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(
        role: Role, slug: String, staticKey: any PeerNoiseStaticKey, account: PeerAccountContext? = nil,
        admission: HandshakeLimiter? = nil, caps: [String] = [],
        hello: (label: String?, platform: String, app: String, maxMessage: Int?),
        send: @escaping @Sendable (Data) -> Void, onEvent: @escaping @Sendable (PeerSessionEvent) -> Void,
        mode: PeerNoiseMode = .a, random: (@Sendable (Int) -> Data)? = nil, now: (@Sendable () -> Int)? = nil,
        mono: (@Sendable () -> TimeInterval)? = nil,
        rekeyMessages: Int = 1 << 20, rekeySeconds: TimeInterval = 3600
    ) throws {
        guard (mode == .a) == (account != nil) else { throw PeerChannelError.mode }
        guard mode == .a || role == .initiator || admission != nil else { throw PeerChannelError.mode }
        self.mode = mode
        self.asm = PeerRecordAssembler(mode: PeerRecordMode(rawValue: mode.rawValue)!)
        self.admission = admission
        self.random = random ?? { n in Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
        self.role = role
        self.slug = slug
        self.staticKey = staticKey
        self.acct = account
        self.caps = caps
        self.helloLabel = hello.label
        self.helloPlatform = hello.platform
        self.helloApp = hello.app
        self.helloMax = hello.maxMessage ?? peerMaxMessageBytes
        self.sendNoise = send
        self.onEvent = onEvent
        let n = now ?? { Int(Date().timeIntervalSince1970) }
        let m = mono ?? { ProcessInfo.processInfo.systemUptime }
        self.now = n
        self.mono = m
        self.rekeyMessages = rekeyMessages
        self.rekeySeconds = rekeySeconds
        self.keyedAt = m()
    }

    public nonisolated var description: String { "PeerChannel()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    // MARK: State

    /// The transport ciphers, for tests that speak to a session as a raw peer.
    var transportForTesting: PeerNoiseTransport? { tp }

    public var isOpen: Bool { phase == .open }
    public var closed: Bool { phase == .closed }

    /// Seconds until the next deadline (the transport's, the peer certificate's expiry), 0 when one
    /// is due, nil when there is none. The host calls `tick()` then.
    public func wakeIn() -> TimeInterval? {
        if phase == .closed { return nil }
        var waits: [TimeInterval] = []
        if let d = transportDue { waits.append(d - mono()) }
        if let d = sasDue { waits.append(d - mono()) }
        if let e = certExpires { waits.append(TimeInterval(e - now())) }
        return waits.min().map { max(0, $0) }
    }

    /// Enforce the deadlines: `peer_timeout` when the transport took over 30 s, `peer_expired` when
    /// the peer's certificate ran out.
    public func tick() async {
        await gate { [self] in
            if phase == .closed { return }
            if (transportDue.map { mono() >= $0 } ?? false) || (sasDue.map { mono() >= $0 } ?? false) {
                await fail(.peerTimeout, byPeer: false)
            } else if let e = certExpires, now() >= e {
                await fail(.peerExpired, byPeer: false)
            }
        }
    }

    // MARK: Calls

    /// Initiator only: write message 1.
    public func start() async {
        await guarded { [self] in
            guard role == .initiator, hs == nil, phase == .handshake else { throw Fail(.handshakeFailed) }
            var key: Data?
            if let acct {
                guard let k = acct.discKeys.first ?? nil else { throw Fail(.handshakeFailed) }
                key = k
            }
            startClock()
            let h = try await newHandshake(key)
            hs = h
            sendNoise(try await h.writeMessage(PeerPayload.payload1()))
            hsStep = 1
        }
    }

    /// One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body).
    public func receive(_ noise: Data) async {
        await guarded { [self] in
            if phase == .closed { return }
            if !started && role == .responder {
                // An approver counts the attempt only now that a session starts.
                if let admission {
                    guard let r = admission.begin() else { throw Fail(.peerBusy) }
                    release = r
                }
                startClock()
            }
            if phase == .handshake { try await onHandshake(noise) } else { try await onTransport(noise) }
        }
    }

    /// Send one message of the host's, split into records. Only once the session is open.
    public func sendRecord(type: Int, body: Data) async throws {
        await acquire()
        defer { releaseGate() }
        guard phase == .open else { throw PeerChannelError.notOpen }
        guard !owned.contains(type), !(type == PeerRecordType.confirm && mode == .p) else {
            throw PeerChannelError.ownedRecord
        }
        guard body.count <= maxSend else { throw PeerChannelError.messageTooLarge }
        try emit(type, body)
    }

    /// Modes v and p: the person confirmed the code. Opens the session, sends `CONFIRM` in mode p
    /// and delivers the host records held meanwhile.
    public func confirmSas() async {
        await guarded { [self] in
            guard phase == .sasShown else { throw Fail(.peerNotAllowed) }
            phase = .open
            settle()
            if mode == .p { try emit(PeerRecordType.confirm, Data("{}".utf8)) }
            let q = queued
            queued = []
            for m in q { onEvent(.record(type: m.type, body: m.body)) }
        }
    }

    /// Close with a code; sends CLOSE when the transport exists.
    public func close(_ code: PeerCloseCode = .peerBye) async {
        await gate { [self] in await fail(PeerClosedReason(code), byPeer: false) }
    }

    // MARK: The gate

    private func acquire() async {
        if busy {
            await withCheckedContinuation { waiters.append($0) }
        } else {
            busy = true
        }
    }

    private func releaseGate() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }

    private func gate(_ body: () async -> Void) async {
        await acquire()
        await body()
        releaseGate()
    }

    private func guarded(_ body: () async throws -> Void) async {
        await gate { [self] in
            do {
                try await body()
            } catch let f as Fail {
                await fail(f.code, byPeer: false)
            } catch is PeerNoiseError {
                await fail(tp == nil ? .handshakeFailed : .peerBadFrame, byPeer: false)
            } catch {
                await fail(.handshakeFailed, byPeer: false)
            }
        }
    }

    // MARK: Internals

    private func fail(_ code: PeerClosedReason, byPeer: Bool) async {
        if phase == .closed { return }
        let wasUp = tp != nil
        phase = .closed
        transportDue = nil
        certExpires = nil
        settle()
        queued = []
        if wasUp && !byPeer && code != .handshakeFailed {
            try? emit(PeerRecordType.close, Data(#"{"code":"\#(code.rawValue)"}"#.utf8))
        }
        wipe()
        onEvent(.closed(code, byPeer: byPeer))
    }

    /// The person confirmed, or the session ended: the code deadline and the limiter slot end.
    private func settle() {
        sasDue = nil
        release?()
        release = nil
    }

    private func wipe() {
        tp?.send.wipe()
        tp?.receive.wipe()
    }

    private func startClock() {
        if started { return }
        started = true
        transportDue = mono() + peerTransportDeadlineSeconds
        if mode != .a { sasDue = mono() + peerSasDeadlineSeconds }
    }

    private func newHandshake(_ discKey: Data?) async throws -> PeerNoiseHandshake {
        try PeerNoiseHandshake(
            role: role == .initiator ? .initiator : .responder, protocol: peerNoiseProtocol(mode),
            prologue: peerPrologue(slug: slug, mode: mode), staticKey: staticKey,
            psk: mode == .a ? try peerPsk(discoveryKey: discKey ?? Data(), slug: slug) : nil)
    }

    private func ownPayload() throws -> Data {
        guard let acct else { return try PeerPayload.payload23(mode: mode, caps: caps) }
        let held = acct.heldRing()
        return try PeerPayload.payload23(mode: mode, caps: caps, account: (acct.certJws, held?.epoch ?? 1))
    }

    private func admit(_ certJws: String, _ ringJws: String?, _ remote: Data) -> PeerDocs.PeerAdmission {
        guard let acct else { return .refused(reason: "cert-invalid") }
        return PeerDocs.admitPeer(
            certJws: certJws, heldRing: ringJws,
            options: VerifyPeerCertOptions(
                trust: acct.trust, expectedAud: acct.expectedAud, now: now(),
                session: PeerSession(
                    mode: .a, remoteStatic: Base64URL.encode(remote), ownSub: acct.ownSub,
                    ownDeviceId: acct.ownDeviceId)))
    }

    private func onHandshake(_ noise: Data) async throws {
        if role == .responder && hs == nil {
            // Message 1: try the current then the previous discovery key; a failed tag closes
            // silently.
            var payload: Data?
            let keys: [Data?] = acct.map { Array($0.discKeys.prefix(2)) } ?? [nil]
            for k in keys {
                if acct != nil && k == nil { continue }
                do {
                    let h = try await newHandshake(k)
                    payload = try await h.readMessage(noise)
                    hs = h
                    break
                } catch is PeerNoiseError {
                    continue
                }
            }
            guard let h = hs, let payload else { throw Fail(.handshakeFailed) }
            guard PeerPayload.parse(mode: mode, message: 1, payload).ok else { throw Fail(.handshakeFailed) }
            sendNoise(try await h.writeMessage(try ownPayload()))
            hsStep = 2
            return
        }
        guard let h = hs else { throw Fail(.handshakeFailed) }
        let message = role == .initiator ? 2 : 3
        guard hsStep == (role == .initiator ? 1 : 2) else { throw Fail(.handshakeFailed) }
        let payload = try await h.readMessage(noise)
        let verdict = PeerPayload.parse(mode: mode, message: message, payload)
        guard verdict.ok else { throw Fail(.handshakeFailed) }
        guard let remote = await h.remoteStatic else { throw Fail(.handshakeFailed) }
        var peerDeviceId: String?
        if mode == .a {
            guard let certJws = verdict.cert, let ring = verdict.ring else { throw Fail(.handshakeFailed) }
            peerDeviceId = try admitAccount(certJws, ring, remote)
        }
        peerCaps = verdict.caps
        if role == .initiator { sendNoise(try await h.writeMessage(try ownPayload())) }
        tp = try await h.transport()
        transportDue = nil
        keyedAt = mono()
        phase = .hello
        pending = (remote, peerDeviceId)
        try sendHello()
    }

    private func admitAccount(_ certJws: String, _ ring: Int, _ remote: Data) throws -> String {
        guard let acct else { throw Fail(.handshakeFailed) }
        let held = acct.heldRing()
        if let held {
            // A held roster that is expired, unverifiable or another account's must not admit: ask
            // for a fresh one and refuse. Only a device with no roster at all (first run) admits.
            guard case .ok(let r) = PeerDocs.verifyRing(held.jws, trust: acct.trust, expectedAud: acct.expectedAud),
                !PeerDocs.ringExpired(r, now: now()), r.sub == acct.ownSub
            else {
                onEvent(.ringWanted)
                throw Fail(.handshakeFailed)
            }
        } else {
            onEvent(.ringWanted)
        }
        let adm = admit(certJws, held?.jws, remote)
        guard case .admit(let cert, let sync) = adm else {
            if case .refused(let reason) = adm, reason == "peer_revoked" { throw Fail(.peerRevoked) }
            throw Fail(.handshakeFailed)
        }
        peerCertJws = certJws
        peerRemote = remote
        if cert.expiresAt - now() <= 0 { throw Fail(.peerExpired) }
        certExpires = cert.expiresAt
        peerRing = ring
        if sync == .request { onEvent(.ringWanted) }
        return cert.deviceId
    }

    private func sendHello() throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        func q(_ s: String) -> String { String(decoding: (try? enc.encode(s)) ?? Data(), as: UTF8.self) }
        var s = "{"
        if let l = helloLabel { s += #""label":\#(q(l)),"# }
        s += #""platform":\#(q(helloPlatform)),"app":\#(q(helloApp)),"maxMessage":\#(helloMax)}"#
        try emit(PeerRecordType.hello, Data(s.utf8))
    }

    private func onTransport(_ noise: Data) async throws {
        guard let tp else { throw Fail(.handshakeFailed) }
        let plain = try tp.receive.decrypt(ad: Data(), noise)
        guard let rec = PeerRecords.parse(plain) else { throw Fail(.peerBadFrame) }
        switch asm.push(rec) {
        case .close(let c): throw Fail(PeerClosedReason(c))
        case .message(let type, let body): try await onMessage(type, body)
        case .pending, .ignored: return
        }
    }

    private static func parseHello(_ body: Data) -> PeerHello? {
        guard let (o, nonWire) = PeerPayload.parseStrictObject(body),
            case .string(let platform)? = o["platform"], case .string(let app)? = o["app"],
            case .int(let mm)? = o["maxMessage"], wireInteger(mm, pointer: "/maxMessage", min: 1, in: nonWire)
        else { return nil }
        var label: String?
        if let l = o["label"] {
            guard case .string(let raw) = l else { return nil }
            // Display data from the peer: NFC, controls and bidi stripped, 64 code points.
            label = normalizeDeviceLabel(raw.precomposedStringWithCanonicalMapping)
        }
        return PeerHello(label: label, platform: platform, app: app, maxMessage: mm)
    }

    private func onMessage(_ type: Int, _ body: Data) async throws {
        if phase == .hello {
            // The first record each way is HELLO; anything else is refused and closed.
            guard type == PeerRecordType.hello, let hello = Self.parseHello(body), let p = pending else {
                throw Fail(.peerBadFrame)
            }
            maxSend = min(peerMaxMessageBytes, hello.maxMessage)
            caps = PeerPayload.capsIntersection(caps, peerCaps)
            pending = nil
            let account = mode == .a
            phase = account ? .open : .sas
            onEvent(
                .established(
                    PeerEstablished(
                        caps: caps, hello: hello, helloAuthenticated: account, remoteStatic: p.remote,
                        peerDeviceId: p.deviceId)))
            if account {
                try pushRing()
            } else if role == .initiator {
                // The device commits first.
                let n = random(32)
                nD = n
                try emit(PeerRecordType.sasCommit, try PeerSAS.body(.c, PeerSAS.commit(n)))
                sasStep = 1
            }
            return
        }
        switch type {
        case PeerRecordType.hello:
            throw Fail(.peerBadFrame)
        case PeerRecordType.ping:
            // Answer at most `peerPongsPerSecond` a second: a peer that pings faster than that gets no reply.
            let t = mono()
            if t - pongWindow >= 1 {
                pongWindow = t
                pongs = 0
            }
            pongs += 1
            if pongs <= peerPongsPerSecond { try emit(PeerRecordType.pong, body) }
        case PeerRecordType.pong:
            return
        case PeerRecordType.rekey:
            try tp?.receive.rekey()
        case PeerRecordType.close:
            var code = ""
            if let (o, _) = PeerPayload.parseStrictObject(body), case .string(let c)? = o["code"] { code = c }
            phase = .closed
            transportDue = nil
            certExpires = nil
            settle()
            queued = []
            wipe()
            onEvent(
                .closed(knownClose.contains(code) ? PeerClosedReason(rawValue: code)! : .peerBadFrame, byPeer: true))
        case PeerRecordType.trust:
            guard let (o, _) = PeerPayload.parseStrictObject(body), case .string(let t)? = o["trust"] else {
                throw Fail(.peerBadFrame)
            }
            onEvent(.trustUnverified(jws: t))
        case PeerRecordType.ring:
            try onRing(body)
        case PeerRecordType.sasCommit, PeerRecordType.sasNonce, PeerRecordType.sasReveal:
            try await onSas(type, body)
        default:
            // Everything else belongs to the host, and only once the code is settled.
            if phase == .sasShown {
                // The peer may confirm first: hold the record (bounded) until this side's person does.
                if queued.count >= 16 { throw Fail(.peerBusy) }
                queued.append((type, body))
                return
            }
            guard phase == .open else { throw Fail(.peerNotAllowed) }
            onEvent(.record(type: type, body: body))
        }
    }

    private func onSas(_ type: Int, _ body: Data) async throws {
        guard phase == .sas, !sasDone else { throw Fail(.peerBadFrame) }
        let initiator = role == .initiator
        // Responder (the approver): COMMIT then REVEAL. Initiator (the device): NONCE.
        if type == PeerRecordType.sasCommit && !initiator && sasStep == 0 {
            guard let c = PeerSAS.parseBody(.c, body) else { throw Fail(.peerBadFrame) }
            commit = try PeerSAS.encodeValue(c)
            let n = random(32)
            nM = n
            try emit(PeerRecordType.sasNonce, try PeerSAS.body(.nM, n))
            sasStep = 1
            return
        }
        if type == PeerRecordType.sasNonce && initiator && sasStep == 1 {
            guard let n = PeerSAS.parseBody(.nM, body), let d = nD else { throw Fail(.peerBadFrame) }
            nM = n
            try emit(PeerRecordType.sasReveal, try PeerSAS.body(.nD, d))
            try await finishSas()
            return
        }
        if type == PeerRecordType.sasReveal && !initiator && sasStep == 1 {
            // `revealOK` compares the commitment in constant time.
            guard let d = PeerSAS.parseBody(.nD, body), let c = commit,
                PeerSAS.revealOK(commit: c, nD: try PeerSAS.encodeValue(d))
            else { throw Fail(.peerBadFrame) }
            nD = d
            try await finishSas()
            return
        }
        throw Fail(.peerBadFrame)
    }

    private func finishSas() async throws {
        guard let h = hs, let d = nD, let m = nM else { throw Fail(.peerBadFrame) }
        let code = PeerSAS.value(handshakeHash: try await h.handshakeHash, nD: d, nM: m, mode: mode)
        sasDone = true
        phase = .sasShown
        onEvent(.sas(code: code, display: PeerSAS.display(code)))
    }

    private func pushRing() throws {
        guard let acct, let held = acct.heldRing(), held.epoch > peerRing else { return }
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        let q = String(decoding: (try? enc.encode(held.jws)) ?? Data(), as: UTF8.self)
        try emit(PeerRecordType.ring, Data(#"{"ring":\#(q)}"#.utf8))
    }

    private func onRing(_ body: Data) throws {
        guard let acct else { throw Fail(.peerNotAllowed) }
        guard let (o, _) = PeerPayload.parseStrictObject(body), case .string(let ring)? = o["ring"] else {
            throw Fail(.peerBadFrame)
        }
        let r = PeerDocs.replaceRing(
            held: acct.heldRing()?.jws, new: ring, trust: acct.trust, expectedAud: acct.expectedAud, now: now())
        // A roster that is stale, older or another account's changes nothing.
        guard case .replace(let next) = r, next.sub == acct.ownSub else { return }
        onEvent(.ring(jws: ring, epoch: next.epoch))
        // The new roster may have dropped this peer.
        guard let remote = peerRemote else { throw Fail(.handshakeFailed) }
        guard case .admit = admit(peerCertJws, ring, remote) else { throw Fail(.peerRevoked) }
    }

    /// Seal records onto the wire, in order, so a REKEY never interleaves.
    private func emit(_ type: Int, _ body: Data) throws {
        guard let tp, !(phase == .closed && type != PeerRecordType.close) else { throw PeerChannelError.notOpen }
        try maybeRekey(tp)
        for plain in try PeerRecords.split(type: type, body: body) {
            sendNoise(try tp.send.encrypt(ad: Data(), plain))
            sent += 1
        }
    }

    private func maybeRekey(_ tp: PeerNoiseTransport) throws {
        if sent < rekeyMessages && mono() - keyedAt < rekeySeconds { return }
        sendNoise(
            try tp.send.encrypt(
                ad: Data(), PeerRecords.encode(PeerRecord(type: PeerRecordType.rekey, flags: 0, body: Data()))))
        try tp.send.rekey()
        sent = 0
        keyedAt = mono()
    }
}
