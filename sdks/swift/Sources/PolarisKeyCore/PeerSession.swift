// WIRE-CONTRACT-V5 §15.5 and §15.6: one `pkey-peer/1` session, mode `a` (account) (CC-11.8). Swift
// mirror of client-core's `peer/session.ts` and the Python port's `core/peer_session.py`; modes
// `v` and `p` (the SAS) follow in CC-11.9.
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
    /// Only the account mode is implemented here.
    case mode
    case notOpen
    /// A record type the session owns (HELLO, CLOSE, REKEY, the SAS records).
    case ownedRecord
    case messageTooLarge
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

    private let mode: PeerNoiseMode = .a
    private let role: Role
    private let slug: String
    private let staticKey: any PeerNoiseStaticKey
    private let acct: PeerAccountContext
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

    private var asm = PeerRecordAssembler(mode: .a)
    private var hs: PeerNoiseHandshake?
    private var hsStep = 0
    private enum Phase { case handshake, hello, open, closed }
    private var phase = Phase.handshake
    private var tp: PeerNoiseTransport?
    private var peerCaps: [String] = []
    private var peerRing = 0
    private var caps: [String]
    private var sent = 0
    private var keyedAt: TimeInterval
    private var maxSend = peerMaxMessageBytes
    private var started = false
    private var transportDue: TimeInterval?
    private var certExpires: Int?
    private var peerCertJws = ""
    private var peerRemote: Data?
    private var pending: (remote: Data, deviceId: String?)?

    // One call at a time: a handshake step awaits the key port, and another call must not
    // interleave with it.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(
        role: Role, slug: String, staticKey: any PeerNoiseStaticKey, account: PeerAccountContext,
        caps: [String] = [], hello: (label: String?, platform: String, app: String, maxMessage: Int?),
        send: @escaping @Sendable (Data) -> Void, onEvent: @escaping @Sendable (PeerSessionEvent) -> Void,
        mode: PeerNoiseMode = .a, now: (@Sendable () -> Int)? = nil, mono: (@Sendable () -> TimeInterval)? = nil,
        rekeyMessages: Int = 1 << 20, rekeySeconds: TimeInterval = 3600
    ) throws {
        guard mode == .a else { throw PeerChannelError.mode }
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

    public nonisolated var description: String { "PeerChannel(mode: a)" }
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
        if let e = certExpires { waits.append(TimeInterval(e - now())) }
        return waits.min().map { max(0, $0) }
    }

    /// Enforce the deadlines: `peer_timeout` when the transport took over 30 s, `peer_expired` when
    /// the peer's certificate ran out.
    public func tick() async {
        await gate { [self] in
            if phase == .closed { return }
            if let d = transportDue, mono() >= d {
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
            guard role == .initiator, hs == nil, phase == .handshake, let key = acct.discKeys.first ?? nil else {
                throw Fail(.handshakeFailed)
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
            if !started && role == .responder { startClock() }
            if phase == .handshake { try await onHandshake(noise) } else { try await onTransport(noise) }
        }
    }

    /// Send one message of the host's, split into records. Only once the session is open.
    public func sendRecord(type: Int, body: Data) async throws {
        await acquire()
        defer { releaseGate() }
        guard phase == .open else { throw PeerChannelError.notOpen }
        guard !owned.contains(type) else { throw PeerChannelError.ownedRecord }
        guard body.count <= maxSend else { throw PeerChannelError.messageTooLarge }
        try emit(type, body)
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
        if wasUp && !byPeer && code != .handshakeFailed {
            try? emit(PeerRecordType.close, Data(#"{"code":"\#(code.rawValue)"}"#.utf8))
        }
        wipe()
        onEvent(.closed(code, byPeer: byPeer))
    }

    private func wipe() {
        tp?.send.wipe()
        tp?.receive.wipe()
    }

    private func startClock() {
        if started { return }
        started = true
        transportDue = mono() + peerTransportDeadlineSeconds
    }

    private func newHandshake(_ discKey: Data) async throws -> PeerNoiseHandshake {
        try PeerNoiseHandshake(
            role: role == .initiator ? .initiator : .responder, protocol: peerNoiseProtocol(mode),
            prologue: peerPrologue(slug: slug, mode: mode), staticKey: staticKey,
            psk: try peerPsk(discoveryKey: discKey, slug: slug))
    }

    private func ownPayload() throws -> Data {
        let held = acct.heldRing()
        return try PeerPayload.payload23(mode: mode, caps: caps, account: (acct.certJws, held?.epoch ?? 1))
    }

    private func admit(_ certJws: String, _ ringJws: String?, _ remote: Data) -> PeerDocs.PeerAdmission {
        PeerDocs.admitPeer(
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
            for k in acct.discKeys.prefix(2) {
                guard let k else { continue }
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
        guard verdict.ok, let certJws = verdict.cert, let ring = verdict.ring else { throw Fail(.handshakeFailed) }
        guard let remote = await h.remoteStatic else { throw Fail(.handshakeFailed) }
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
        peerCaps = verdict.caps
        if role == .initiator { sendNoise(try await h.writeMessage(try ownPayload())) }
        tp = try await h.transport()
        transportDue = nil
        keyedAt = mono()
        phase = .hello
        pending = (remote, cert.deviceId)
        try sendHello()
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
            phase = .open
            onEvent(
                .established(
                    PeerEstablished(
                        caps: caps, hello: hello, helloAuthenticated: true, remoteStatic: p.remote,
                        peerDeviceId: p.deviceId)))
            try pushRing()
            return
        }
        switch type {
        case PeerRecordType.hello:
            throw Fail(.peerBadFrame)
        case PeerRecordType.ping:
            try emit(PeerRecordType.pong, body)
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
            wipe()
            onEvent(.closed(knownClose.contains(code) ? PeerClosedReason(rawValue: code)! : .peerBadFrame, byPeer: true))
        case PeerRecordType.trust:
            guard let (o, _) = PeerPayload.parseStrictObject(body), case .string(let t)? = o["trust"] else {
                throw Fail(.peerBadFrame)
            }
            onEvent(.trustUnverified(jws: t))
        case PeerRecordType.ring:
            try onRing(body)
        default:
            // Everything else belongs to the host.
            onEvent(.record(type: type, body: body))
        }
    }

    private func pushRing() throws {
        guard let held = acct.heldRing(), held.epoch > peerRing else { return }
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        let q = String(decoding: (try? enc.encode(held.jws)) ?? Data(), as: UTF8.self)
        try emit(PeerRecordType.ring, Data(#"{"ring":\#(q)}"#.utf8))
    }

    private func onRing(_ body: Data) throws {
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
            try tp.send.encrypt(ad: Data(), PeerRecords.encode(PeerRecord(type: PeerRecordType.rekey, flags: 0, body: Data()))))
        try tp.send.rekey()
        sent = 0
        keyedAt = mono()
    }
}
