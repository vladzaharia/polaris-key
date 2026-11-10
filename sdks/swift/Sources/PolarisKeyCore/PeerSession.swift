// WIRE-CONTRACT-V5 §15.5 and §15.6: one `pkey-peer/1` session, per mode (`a` account, `v` approver,
// `p` pair) (CC-11.8, CC-11.9). Swift mirror of client-core's `peer/session.ts` and the Python
// port's `core/peer_session.py`.
//
// Modes v and p: after HELLO the initiator (the device) commits to a nonce, the responder (the
// approver) answers with its own, the initiator reveals, and both show the same six-digit code.
// The host calls `confirmSas()` when the person agrees; until then host records from the peer are
// held (at most 16 and 16 KiB), and HELLO display data is unauthenticated (at most 4 KiB, with
// `platform` and `app` cleaned). A responder in these modes needs a
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
// Modes q and l (§15.12) are the account-free local links. Mode q is the pairing: XXpsk0 under a PSK from CPace
// (`PeerCPace.swift`, run by the caller before message 1), a fresh link key as the static key, then HELLO, the
// person's consent, CONFIRM each way and one LOCAL_LINK each way (`LocalExchange`); a side that reads the peer's
// LOCAL_LINK reports a `.localLink` event and closes `peer_bye`. Mode l is a later session: XXpsk0 under a
// link's secret, the link's own key as the static key, and the remote static key pinned to the stored peer link
// key. A responder that holds local links tries them after the account keys and the contacts, behind the same
// limiter; with no account key it asks the limiter's per-group budget first (§15.10, "Admission").
//
// Keys (G1): the device's static private key stays behind `PeerNoiseStaticKey`, whose `dh` the
// Noise engine calls. Nothing here prints a key, certificate, roster or record body (G19).

import Foundation

/// Seconds from the first byte to the transport.
public let peerTransportDeadlineSeconds: TimeInterval = 30
public let peerSasDeadlineSeconds: TimeInterval = 120
let peerPongsPerSecond = 16
/// Xfer records held between `established` and the transfer port being attached.
let peerXferHeldRecords = 32
/// §15.6: a HELLO in mode v or p (a peer not yet verified) is at most this many bytes.
let peerMaxUnverifiedHelloBytes = 4096
/// §15.6: bytes of host records held before the person's confirmation, modes v and p.
let peerMaxQueuedBytes = 16 * 1024
/// §15.6: a `platform` is shown as sent only when it is 1 to 32 of [A-Za-z0-9 ._+-]; else "Unknown".
let peerUnknownDisplay = "Unknown"

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
    /// Mode c: the index, in the channel's `contacts`, of the contact the peer is.
    public var contactIndex: Int? = nil
    /// Mode l: the index, in the channel's `locals`, of the link the peer is.
    public var localIndex: Int? = nil
}

/// A local link the device holds (mode l, §15.12): the link's secret (the PSK), its own private key (the static
/// key of every session under it) and the peer's link public key (the remote static key must equal it).
public struct PeerLocalLink: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let secret: Data
    public let ownKey: Data
    public let peerKey: Data
    public init(secret: Data, ownKey: Data, peerKey: Data) {
        self.secret = secret
        self.ownKey = ownKey
        self.peerKey = peerKey
    }

    public var description: String { "PeerLocalLink(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// What a mode-q session needs (§15.12): the CPace outputs and this side's part of the exchange.
public struct PeerPairingOptions: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    /// `HKDF-SHA256(ISK)`, the Noise PSK (`PeerCPace.psk`). Released once the handshake is done.
    public var psk: Data
    /// The CPace ISK, 64 bytes: it makes the link secret. Released when the session ends.
    public var isk: Data
    /// The number of local links the device holds for the product (`maxLocalLinks` refuses a link).
    public var held: Int
    /// The categories this side's person approved.
    public var cats: [String]
    /// This device's label for the peer to show.
    public var label: String?
    /// Seconds already spent since the first byte (C1 and C2 ran before the session). At 30 or more the
    /// session starts no handshake and tries no tag.
    public var elapsed: TimeInterval
    /// A responder's permit to try message 1's tag (`LocalPairingWindow.beginGuess`): synchronous, it counts the
    /// guess before the tag is tried. The session never tries a tag without one, and the channel refuses a
    /// mode-q responder without it.
    public var permit: (@Sendable () -> Bool)?

    public init(
        psk: Data, isk: Data, held: Int, cats: [String], label: String? = nil, elapsed: TimeInterval = 0,
        permit: (@Sendable () -> Bool)? = nil
    ) {
        self.psk = psk
        self.isk = isk
        self.held = held
        self.cats = cats
        self.label = label
        self.elapsed = elapsed
        self.permit = permit
    }

    public var description: String { "PeerPairingOptions(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A contact the device holds (mode c): its secret (the PSK) and the peer's agreeKey.
public struct PeerContactLink: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let secret: Data
    /// The peer's agreeKey, 43 canonical base64url characters: the remote static key must equal it.
    public let agreeKey: String
    public init(secret: Data, agreeKey: String) {
        self.secret = secret
        self.agreeKey = agreeKey
    }

    public var description: String { "PeerContactLink(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// This device's side of the contact exchange (mode p, §15.10).
public struct PeerContactOffer: Sendable {
    public let agreeKey: String
    public let held: [String]
    public let label: String?
    public let cats: [String]
    public init(agreeKey: String, held: [String] = [], label: String? = nil, cats: [String]) {
        self.agreeKey = agreeKey
        self.held = held
        self.label = label
        self.cats = cats
    }
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
    /// Mode q, responder: its message 1 was judged (§15.12, "Failure accounting"). `opens` false is one failed
    /// guess: the window rotates the code, and the session closes silently.
    case guess(opens: Bool)
    /// Mode q: the peer's valid `LOCAL_LINK`, read in order. `secret` is the link secret (key material: store it,
    /// never log it) with `ownKey`, `peerKey` the two link public keys and `cats` the categories both sides
    /// listed. The host stores the link; the session closes `peer_bye`.
    case localLink(secret: Data, ownKey: Data, peerKey: Data, label: String?, cats: [String])
    /// Mode p with an exchange: the peer's valid `CONTACT`, read in order. `secret` is the new contact
    /// secret (key material: store it, never log it); `pending` is true for a peer the host holds.
    case contact(secret: Data, body: ContactBody, pending: Bool)
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
        case .contact: return "PeerSessionEvent.contact"
        case .guess(let o): return "PeerSessionEvent.guess(opens: \(o))"
        case .localLink: return "PeerSessionEvent.localLink"
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
    /// `handshakeHash()` before the session is established.
    case notEstablished
}

/// What `HandshakeLimiter.beginLocal` answers.
public enum LocalAdmission: Sendable {
    public enum Refusal: String, Sendable, Equatable { case group, shared }
    case refused(Refusal)
    /// `hit()` refunds the group's count, takes a waiting slot and returns its release; `miss()` spends the
    /// shared budget. Each is honoured once: the first of the two to be called settles the attempt.
    case admitted(hit: @Sendable () -> (@Sendable () -> Void), miss: @Sendable () -> Void)
}

/// The approver's admission: at most `maxPerMinute` handshakes a minute (default 5) and at most
/// `maxPending` sessions waiting on a code (default 4), on a monotonic clock. An attempt counts
/// only when `begin()` is called, which a session does when it starts.
public final class HandshakeLimiter: Sendable {
    private struct State: Sendable {
        var stamps: [TimeInterval] = []
        var pending = 0
        /// Per source group, the message 1s of the last minute (`beginLocal`).
        var groups: [String: [TimeInterval]] = [:]
    }
    private let maxPerMinute: Int
    private let maxPending: Int
    private let groupMax: Int
    private let mono: @Sendable () -> TimeInterval
    private let state = LockedValue(State())

    public init(
        maxPerMinute: Int = 5, maxPending: Int = 4, groupMax: Int = localGroupPerMinute,
        mono: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.maxPerMinute = maxPerMinute
        self.maxPending = maxPending
        self.groupMax = groupMax
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
        return release()
    }

    private func release() -> @Sendable () -> Void {
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

    /// The admission of a listener that holds no account key (§15.10, "Admission"): the group's budget
    /// (`groupMax` a minute, counted as the message 1 arrives) comes first, then the shared limit, which
    /// counts only failed trials (and the sessions waiting on message 3). A refusal costs no trial.
    public func beginLocal(group: String) -> LocalAdmission {
        let t = mono()
        let refusal = state.with { s -> LocalAdmission.Refusal? in
            s.stamps = s.stamps.filter { t - $0 < 60 }
            for (g, v) in s.groups {
                let live = v.filter { t - $0 < 60 }
                if live.isEmpty { s.groups[g] = nil } else { s.groups[g] = live }
            }
            if (s.groups[group] ?? []).count >= groupMax { return .group }
            if s.stamps.count >= maxPerMinute || s.pending >= maxPending { return .shared }
            s.groups[group, default: []].append(t)
            return nil
        }
        if let refusal { return .refused(refusal) }
        let settled = LockedValue(false)
        return .admitted(
            hit: { [self] in
                let first = settled.with { d -> Bool in
                    if d { return false }
                    d = true
                    return true
                }
                guard first else { return {} }
                state.with { s in
                    if var v = s.groups[group], let i = v.lastIndex(of: t) {
                        v.remove(at: i)
                        s.groups[group] = v
                    }
                    s.pending += 1
                }
                return release()
            },
            miss: { [self] in
                let first = settled.with { d -> Bool in
                    if d { return false }
                    d = true
                    return true
                }
                guard first else { return }
                let now = mono()
                state.with { $0.stamps.append(now) }
            })
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

    private var mode: PeerNoiseMode
    private let contacts: [PeerContactLink]
    private let locals: [PeerLocalLink]
    private var pair: PeerPairingOptions?
    /// Mode q: the pairing's order guard, and the flag that the exchange's own clock has begun.
    private var lx: LocalExchange?
    private var lxTimer = false
    private var localIdx = -1
    private var ownPub: Data?
    private let admissionGroup: String?
    private let offer: PeerContactOffer?
    private var exchange: PeerContacts.Exchange?
    private var contactIdx = -1
    private var contactDue: TimeInterval?
    private let role: Role
    private let slug: String
    private let staticKey: (any PeerNoiseStaticKey)?
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
    /// The transfer port (§15.11): the one reader and writer of the six xfer record types.
    private var xferSink: (@Sendable (Int, Data) -> Void)?
    private var xferHeld: [(type: Int, body: Data)] = []
    private var peerCertJws = ""
    private var peerRemote: Data?
    private var pending: (remote: Data, deviceId: String?)?
    /// Mode v: D stops after HELLO until its host calls `startSas()` (N9).
    private let holdSas: Bool
    /// The Noise handshake hash `h`, once the session is established (§15.6.1 binds the vouch to it).
    private var hash: Data?

    /// Mode v: this session's order guard (§15.6.1), negotiated when the session is `established`. nil in the
    /// other modes.
    public nonisolated let vouch: VouchFlow<VouchRecord>?

    // One call at a time: a handshake step awaits the key port, and another call must not
    // interleave with it.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(
        role: Role, slug: String, staticKey: (any PeerNoiseStaticKey)?, account: PeerAccountContext? = nil,
        admission: HandshakeLimiter? = nil, caps: [String] = [], contacts: [PeerContactLink] = [],
        locals: [PeerLocalLink] = [], pair: PeerPairingOptions? = nil, admissionGroup: String? = nil,
        exchange: PeerContactOffer? = nil,
        hello: (label: String?, platform: String, app: String, maxMessage: Int?),
        send: @escaping @Sendable (Data) -> Void, onEvent: @escaping @Sendable (PeerSessionEvent) -> Void,
        mode: PeerNoiseMode = .a, random: (@Sendable (Int) -> Data)? = nil, now: (@Sendable () -> Int)? = nil,
        mono: (@Sendable () -> TimeInterval)? = nil,
        rekeyMessages: Int = 1 << 20, rekeySeconds: TimeInterval = 3600, holdSas: Bool = false
    ) throws {
        guard (mode == .a) == (account != nil) else { throw PeerChannelError.mode }
        let (nC, nL) = (contacts.count, locals.count)
        // Mode l takes each link's own key from `locals`; every other mode needs the static key.
        if mode != .l && staticKey == nil { throw PeerChannelError.mode }
        if mode == .c {
            guard nC >= 1, nC <= maxContactSecrets, role != .initiator || nC == 1,
                role == .initiator || admission != nil
            else { throw PeerChannelError.mode }
            if nL > 0, role != .responder || nL > maxLocalLinks { throw PeerChannelError.mode }
        } else if mode == .l {
            guard nL >= 1, nL <= maxLocalLinks, role != .initiator || nL == 1, role == .initiator || admission != nil
            else { throw PeerChannelError.mode }
            if nC > 0, role != .responder || nC > maxContactSecrets { throw PeerChannelError.mode }
        } else if nC > 0 || nL > 0 {
            // The shared listener: a mode-a responder that also serves contacts and local links.
            guard mode == .a, role == .responder, nC <= maxContactSecrets, nL <= maxLocalLinks, admission != nil
            else { throw PeerChannelError.mode }
        }
        guard contacts.allSatisfy({ $0.secret.count == 32 }),
            locals.allSatisfy({ $0.secret.count == 32 && $0.ownKey.count == 32 && $0.peerKey.count == 32 })
        else { throw PeerChannelError.mode }
        if mode == .q {
            guard let pair, pair.psk.count == 32, pair.isk.count == 64, pair.held >= 0, pair.elapsed >= 0,
                role != .responder || pair.permit != nil, PeerLocal.validCats(pair.cats)
            else { throw PeerChannelError.mode }
        } else if pair != nil {
            throw PeerChannelError.mode
        }
        if admissionGroup != nil && role != .responder { throw PeerChannelError.mode }
        self.locals = locals
        self.pair = pair
        self.lx = pair.map { LocalExchange(held: $0.held, cats: $0.cats) }
        self.admissionGroup = admissionGroup
        if exchange != nil && mode != .p { throw PeerChannelError.mode }
        if (mode == .v || mode == .p) && role == .responder && admission == nil { throw PeerChannelError.mode }
        self.contacts = contacts
        self.offer = exchange
        self.exchange = exchange.map { PeerContacts.Exchange(own: $0.agreeKey, held: $0.held) }
        guard !holdSas || (mode == .v && role == .initiator) else { throw PeerChannelError.mode }
        self.holdSas = holdSas
        self.mode = mode
        self.asm = PeerRecordAssembler(mode: PeerRecordMode(rawValue: mode.rawValue)!)
        self.admission = admission
        self.random = random ?? { n in Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
        self.role = role
        self.slug = slug
        self.staticKey = staticKey
        self.acct = account
        // Mode q needs `local/1` on both sides (§15.12): the host cannot leave it out of its payload.
        if mode == .q {
            self.caps = caps.contains(localCap) ? caps : caps + [localCap]
            self.vouch = nil
        } else if mode == .v {
            // Both mode-v payloads list `vouch/1` (§15.6.1 rule 1); the host cannot leave it out.
            self.caps = caps.contains(vouchCap) ? caps : caps + [vouchCap]
            self.vouch = VouchFlow(role: role == .initiator ? .requester : .approver)
        } else {
            self.caps = caps
            self.vouch = nil
        }
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

    /// The Noise handshake hash `h`, a copy, once the session is `established` (§15.6.1 binds the vouch to
    /// it). Throws before that. It is a public value; the one-time keys never leave the handshake.
    public func handshakeHash() throws -> Data {
        guard let h = hash else { throw PeerChannelError.notEstablished }
        return Data(h)
    }

    /// Seconds until the next deadline (the transport's, the peer certificate's expiry), 0 when one
    /// is due, nil when there is none. The host calls `tick()` then.
    public func wakeIn() -> TimeInterval? {
        if phase == .closed { return nil }
        var waits: [TimeInterval] = []
        if let d = transportDue { waits.append(d - mono()) }
        if let d = sasDue { waits.append(d - mono()) }
        if let d = contactDue { waits.append(d - mono()) }
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
            } else if let d = contactDue, mono() >= d {
                contactDue = nil
                do {
                    if lx != nil { try await localStep(.timeoutExchange) } else { try await exchangeStep(.timeout) }
                } catch let f as Fail { await fail(f.code, byPeer: false) } catch {
                    await fail(.handshakeFailed, byPeer: false)
                }
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
            if let pair, pair.elapsed >= peerTransportDeadlineSeconds { throw Fail(.handshakeFailed) }
            var key: Data?
            if let acct {
                guard let k = acct.discKeys.first ?? nil else { throw Fail(.handshakeFailed) }
                key = k
            }
            startClock()
            if mode == .c { contactIdx = 0 }
            if mode == .l { localIdx = 0 }
            let h: PeerNoiseHandshake
            switch mode {
            case .l:
                h = try await newHandshake(
                    mode: .l, discKey: nil, psk: locals[0].secret, staticKey: try rawKey(locals[0].ownKey))
            case .q:
                h = try await newHandshake(mode: .q, discKey: nil, psk: pair?.psk)
            case .c:
                h = try await newHandshake(mode: mode, discKey: key, psk: contacts[0].secret)
            default:
                h = try await newHandshake(mode: mode, discKey: key, psk: nil)
            }
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
                if let admission, mode == .v || mode == .p {
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
        // A pairing carries no host records: the session owns every one it may send (§15.12).
        guard mode != .q, !owned.contains(type), !isXferType(type), !(type == PeerRecordType.confirm && mode == .p),
            !(type == PeerRecordType.contact && exchange != nil)
        else {
            throw PeerChannelError.ownedRecord
        }
        guard body.count <= maxSend else { throw PeerChannelError.messageTooLarge }
        try emit(type, body)
    }

    /// The transfer port (§15.11). Records of the six xfer types reach `onRecord` instead of the host's `record`
    /// event, and `sendRecord` refuses them; `sendXfer` is the writer. Only once the session is open with
    /// `xfer/1` among its capabilities, and once.
    public func attachXfer(_ onRecord: @escaping @Sendable (Int, Data) -> Void) throws {
        guard phase == .open, xferSink == nil, caps.contains(xferCap) else { throw PeerChannelError.notOpen }
        xferSink = onRecord
        let held = xferHeld
        xferHeld = []
        for r in held { onRecord(r.type, r.body) }
    }

    /// Send one xfer record. Only once the port is attached.
    public func sendXfer(type: Int, body: Data) async throws {
        await acquire()
        defer { releaseGate() }
        guard phase == .open, xferSink != nil, isXferType(type) else { throw PeerChannelError.notOpen }
        guard body.count <= maxSend else { throw PeerChannelError.messageTooLarge }
        try emit(type, body)
    }

    /// Mode v, `holdSas` initiator: the person chose this approver; send `SAS_COMMIT` now and start the 120 s
    /// code deadline over. Only once, only after `established`; any other call closes the session
    /// `peer_not_allowed`.
    public func startSas() async {
        await guarded { [self] in
            guard holdSas, phase == .sas, sasStep == 0, nD == nil else { throw Fail(.peerNotAllowed) }
            // The code deadline counts from the person's choice, not from the first byte: a session held
            // while the person looked at the list keeps its whole 120 s.
            sasDue = mono() + peerSasDeadlineSeconds
            try commitSas()
        }
    }

    /// Modes v and p: the person confirmed the code. Opens the session, sends `CONFIRM` in mode p
    /// and delivers the host records held meanwhile.
    public func confirmSas() async {
        await guarded { [self] in
            guard phase == .sasShown else { throw Fail(.peerNotAllowed) }
            phase = .open
            settle()
            if mode == .p { try emit(PeerRecordType.confirm, Data("{}".utf8)) }
            if exchange != nil {
                // The peer's CONTACT must follow within `contactExchangeSeconds` of this CONFIRM.
                contactDue = mono() + TimeInterval(contactExchangeSeconds)
                try await exchangeStep(.ownConfirm)
            }
            let q = queued
            queued = []
            for m in q { onEvent(.record(type: m.type, body: m.body)) }
        }
    }

    /// Mode q: the person agreed to pair. Sends `CONFIRM`, and `LOCAL_LINK` once the peer's `CONFIRM` has been
    /// read. Only once, only after `established`; any other call closes the session `peer_not_allowed`.
    public func confirmPairing() async {
        await guarded { [self] in
            guard lx != nil, phase == .sasShown else { throw Fail(.peerNotAllowed) }
            phase = .open
            try await localStep(.ownConfirm)
        }
    }

    /// Mode q: the person declined. Closes `peer_bye` (a decline after the person agreed is ignored).
    public func declinePairing() async {
        await guarded { [self] in
            guard lx != nil else { throw Fail(.peerNotAllowed) }
            try await localStep(.ownDecline)
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
        xferSink = nil
        xferHeld = []
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
        // The CPace outputs are key material: gone once the session is over (`Data` is released, not overwritten).
        pair?.psk = Data()
        pair?.isk = Data()
        ownPub = nil
    }

    private func startClock() {
        if started { return }
        started = true
        // Mode q: C1 and C2 ran before this session, so their time counts against both deadlines.
        let spent = pair?.elapsed ?? 0
        transportDue = mono() + max(0, peerTransportDeadlineSeconds - spent)
        if mode == .v || mode == .p { sasDue = mono() + peerSasDeadlineSeconds }
        // 120 s from the first byte until both CONFIRMs are done (§15.12).
        if mode == .q { sasDue = mono() + max(0, peerSasDeadlineSeconds - spent) }
    }

    private func rawKey(_ priv: Data) throws -> PeerNoiseRawStaticKey { try PeerNoiseRawStaticKey(privateKey: priv) }

    private static func systemRandom(_ n: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    private func newHandshake(
        mode: PeerNoiseMode, discKey: Data?, psk: Data? = nil, staticKey override: (any PeerNoiseStaticKey)? = nil
    ) async throws -> PeerNoiseHandshake {
        guard let key = override ?? staticKey else { throw Fail(.handshakeFailed) }
        return try PeerNoiseHandshake(
            role: role == .initiator ? .initiator : .responder, protocol: peerNoiseProtocol(mode),
            prologue: peerPrologue(slug: slug, mode: mode), staticKey: key,
            psk: mode == .a ? try peerPsk(discoveryKey: discKey ?? Data(), slug: slug) : psk)
    }

    private func ownPayload() throws -> Data {
        guard let acct, mode == .a else { return try PeerPayload.payload23(mode: mode, caps: caps) }
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
            // Message 1, tried in a fixed order (§15.5, §15.10, §15.12): the account's current then previous
            // discovery key (mode a), then each contact's secret and each local link's secret in the order of
            // `listenerTrialOrder` (no DH happens before the tag). The first tag that verifies decides the mode
            // and the secret; a failed tag on every one closes silently. The contact and local-link trials are
            // admitted by the limiter first, so a refused attempt tries no secret.
            var payload: Data?
            var accountTried = 0
            if mode == .q {
                // The pairing window's attempt: one secret, the code's PSK. A tag that fails is one failed guess
                // (§15.12): the host's window rotates the code. The permit counts the guess before the tag is
                // tried; without it, or past the attempt's 30 s, the tag is never tried.
                guard let pair, pair.elapsed < peerTransportDeadlineSeconds, let permit = pair.permit, permit()
                else { throw Fail(.handshakeFailed) }
                let h = try await newHandshake(mode: .q, discKey: nil, psk: pair.psk)
                do {
                    payload = try await h.readMessage(noise)
                    hs = h
                } catch is PeerNoiseError {
                    onEvent(.guess(opens: false))
                    throw Fail(.handshakeFailed)
                }
                onEvent(.guess(opens: true))
            } else if mode != .c && mode != .l {
                let keys: [Data?] = acct.map { Array($0.discKeys.prefix(2)) } ?? [nil]
                for k in keys {
                    if acct != nil && k == nil { continue }
                    accountTried += 1
                    do {
                        let h = try await newHandshake(mode: mode, discKey: k)
                        payload = try await h.readMessage(noise)
                        hs = h
                        break
                    } catch is PeerNoiseError {
                        continue
                    }
                }
            }
            if hs == nil && (!contacts.isEmpty || !locals.isEmpty) {
                // No account key held and a group known: the group's budget, then the shared limiter that only a
                // failed trial spends (§15.10, "Admission"). Otherwise the shared limiter counts the attempt as
                // it begins.
                var attempt: (hit: @Sendable () -> (@Sendable () -> Void), miss: @Sendable () -> Void)?
                if accountTried == 0, let group = admissionGroup, let admission {
                    switch admission.beginLocal(group: group) {
                    case .refused: throw Fail(.peerBusy)
                    case .admitted(let hit, let miss): attempt = (hit, miss)
                    }
                } else {
                    guard let r = admission?.begin() else { throw Fail(.peerBusy) }
                    release = r
                }
                var tried = 0
                let plan = PeerLocal.listenerTrialOrder(account: nil, contacts: contacts.count, locals: locals.count)
                for t in plan {
                    do {
                        let h: PeerNoiseHandshake
                        if t.kind == "c" {
                            h = try await newHandshake(mode: .c, discKey: nil, psk: contacts[t.index].secret)
                        } else {
                            h = try await newHandshake(
                                mode: .l, discKey: nil, psk: locals[t.index].secret,
                                staticKey: try rawKey(locals[t.index].ownKey))
                        }
                        payload = try await h.readMessage(noise)
                        hs = h
                        if t.kind == "c" {
                            contactIdx = t.index
                            mode = .c
                        } else {
                            localIdx = t.index
                            mode = .l
                        }
                        asm = PeerRecordAssembler(mode: PeerRecordMode(rawValue: mode.rawValue)!)
                        if let attempt { release = attempt.hit() }
                        break
                    } catch is PeerNoiseError {
                        tried += 1
                    }
                }
                // A miss costs the same whatever the host holds: dummy trials make up the difference.
                if hs == nil {
                    attempt?.miss()
                    for _ in 0..<PeerLocal.trialPadding(tried: tried + accountTried) {
                        // On the system's random keys, so a host's own key ports count only the real trials.
                        if let dummy = try? PeerNoiseHandshake(
                            role: .responder, protocol: peerNoiseProtocol(.l),
                            prologue: peerPrologue(slug: slug, mode: .l),
                            staticKey: PeerNoiseRawStaticKey(privateKey: Self.systemRandom(32)),
                            psk: Self.systemRandom(32))
                        {
                            _ = try? await dummy.readMessage(noise)
                        }
                    }
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
        if mode == .c {
            // The pin (§15.10): the peer must be the key the contact was made with. Nothing is sent.
            guard PeerContacts.pin(held: contacts[contactIdx].agreeKey, remoteStatic: remote) else {
                throw Fail(.peerRevoked)
            }
        }
        if mode == .l {
            // The pin (§15.12): the peer must be the key the link was made with. Nothing is sent.
            guard PeerLocal.pin(held: locals[localIdx].peerKey, remoteStatic: remote) else { throw Fail(.peerRevoked) }
        }
        if mode == .q {
            // A reflected handshake (the peer's static key is our own) ends silently, before the transport
            // (§15.12, "Link keys").
            guard let key = staticKey else { throw Fail(.handshakeFailed) }
            let own = try await key.publicKey()
            ownPub = own
            guard PeerLocal.pairingRemoteOk(own: own, remoteStatic: remote) else { throw Fail(.handshakeFailed) }
        }
        if mode == .a {
            guard let certJws = verdict.cert, let ring = verdict.ring else { throw Fail(.handshakeFailed) }
            peerDeviceId = try admitAccount(certJws, ring, remote)
        }
        peerCaps = verdict.caps
        if role == .initiator { sendNoise(try await h.writeMessage(try ownPayload())) }
        tp = try await h.transport()
        pair?.psk = Data()
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

    private static func parseHello(_ body: Data, mode: PeerNoiseMode) -> PeerHello? {
        // Modes v and p take a HELLO from a peer that is not yet verified: 4 KiB at most (§15.6).
        if mode != .a && body.count > peerMaxUnverifiedHelloBytes { return nil }
        guard let (o, nonWire) = PeerPayload.parseStrictObject(body),
            case .string(let platform)? = o["platform"], case .string(let app)? = o["app"],
            case .int(let mm)? = o["maxMessage"], wireInteger(mm, pointer: "/maxMessage", min: 1, in: nonWire)
        else { return nil }
        var label: String?
        if let l = o["label"] {
            guard case .string(let raw) = l else { return nil }
            // Display data from the peer, cleaned as a device label with NFC after the strip (§15.6).
            label = cleanDisplayLabel(raw)
        }
        // `app` is cleaned like `label`; `platform` is shown only in the narrow character set.
        let cleanApp = cleanDisplayLabel(app) ?? peerUnknownDisplay
        return PeerHello(label: label, platform: PeerDisplay.cleanPlatform(platform), app: cleanApp, maxMessage: mm)
    }

    private func onMessage(_ type: Int, _ body: Data) async throws {
        if phase == .hello {
            // The first record each way is HELLO; anything else is refused and closed.
            guard type == PeerRecordType.hello, let hello = Self.parseHello(body, mode: mode), let p = pending else {
                throw Fail(.peerBadFrame)
            }
            maxSend = min(peerMaxMessageBytes, hello.maxMessage)
            if let vouch {
                // Rule 1 (N7): without `vouch/1` on both sides, close before any SAS record.
                if case .close(let c) = vouch.negotiate(local: caps, remote: peerCaps) {
                    throw Fail(PeerClosedReason(c))
                }
            }
            if mode == .q {
                // `local/1` is mandatory (§15.12): without it, close before any consent prompt.
                let n = PeerLocal.negotiateLocalCaps(mode: .q, local: caps, remote: peerCaps)
                if let c = n.close, let code = PeerCloseCode(rawValue: c) { throw Fail(PeerClosedReason(code)) }
            }
            caps = PeerPayload.capsIntersection(caps, peerCaps)
            asm.xferAllowed = caps.contains(xferCap)
            hash = try await hs?.handshakeHash
            pending = nil
            let account = mode == .a
            let direct = account || mode == .c || mode == .l
            // Mode q has no code to compare: its person's consent follows (`confirmPairing`).
            phase = direct ? .open : mode == .q ? .sasShown : .sas
            // A contact responder's slot among the connections waiting for message 3 ends here.
            if direct { settle() }
            onEvent(
                .established(
                    PeerEstablished(
                        caps: caps, hello: hello, helloAuthenticated: account, remoteStatic: p.remote,
                        peerDeviceId: p.deviceId, contactIndex: mode == .c ? contactIdx : nil,
                        localIndex: mode == .l ? localIdx : nil)))
            if account {
                try pushRing()
            } else if direct {
                return
            } else if role == .initiator && !holdSas && mode != .q {
                // The device commits first, unless the host holds the code back until it picks this approver.
                try commitSas()
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
            xferSink = nil
            xferHeld = []
            wipe()
            onEvent(
                .closed(knownClose.contains(code) ? PeerClosedReason(rawValue: code)! : .peerBadFrame, byPeer: true))
        case PeerRecordType.confirm, PeerRecordType.contact, PeerRecordType.localLink:
            if lx != nil {
                // Mode q: the session owns both records. Only after the transport is up.
                guard phase == .sasShown || phase == .open else { throw Fail(.peerNotAllowed) }
                try await localStep(type == PeerRecordType.confirm ? .peerConfirm : .peerLink(body))
            } else if exchange != nil {
                // With the exchange on, the session owns both; only after the code is shown.
                guard phase == .sasShown || phase == .open else { throw Fail(.peerNotAllowed) }
                try await exchangeStep(type == PeerRecordType.confirm ? .peerConfirm : .peerContact(body))
            } else {
                try await hostRecord(type, body)
            }
        case PeerRecordType.trust:
            guard mode == .a else { throw Fail(.peerNotAllowed) }
            guard let (o, _) = PeerPayload.parseStrictObject(body), case .string(let t)? = o["trust"] else {
                throw Fail(.peerBadFrame)
            }
            onEvent(.trustUnverified(jws: t))
        case PeerRecordType.ring:
            try onRing(body)
        case PeerRecordType.sasCommit, PeerRecordType.sasNonce, PeerRecordType.sasReveal:
            try await onSas(type, body)
        default:
            try await hostRecord(type, body)
        }
    }

    /// Everything else belongs to the host, and only once the code is settled.
    private func hostRecord(_ type: Int, _ body: Data) async throws {
        if isXferType(type) {
            // Direct Transfer: the caps and `MORE` were judged by the assembler. Records that arrive between
            // `established` and the port being attached are held, a few at most.
            guard phase == .open, caps.contains(xferCap) else { throw Fail(.peerNotAllowed) }
            if let sink = xferSink { return sink(type, body) }
            if xferHeld.count >= peerXferHeldRecords { throw Fail(.peerBusy) }
            xferHeld.append((type, body))
            return
        }
        if phase == .sasShown {
            // The peer may confirm first: hold the record (bounded) until this side's person does.
            let heldBytes = queued.reduce(0) { $0 + $1.body.count }
            if queued.count >= 16 || heldBytes + body.count > peerMaxQueuedBytes { throw Fail(.peerBusy) }
            queued.append((type, body))
            return
        }
        guard phase == .open else { throw Fail(.peerNotAllowed) }
        onEvent(.record(type: type, body: body))
    }

    /// Run one event through the pairing exchange (mode q) and act on what it says.
    private func localStep(_ e: LocalExchangeEvent) async throws {
        guard var x = lx, let pair else { return }
        let r = x.step(e)
        lx = x
        if r.sends.contains(.confirm) { try emit(PeerRecordType.confirm, Data("{}".utf8)) }
        if r.sends.contains(.localLink) {
            try emit(PeerRecordType.localLink, try PeerLocal.buildLocalLink(label: pair.label, cats: pair.cats))
        }
        // Both CONFIRMs done: the 120 s deadline ends and the exchange's 30 s begins.
        if x.bothConfirmed && !lxTimer {
            lxTimer = true
            settle()
            contactDue = mono() + TimeInterval(contactExchangeSeconds)
        }
        if let stored = r.stored {
            guard let own = ownPub, let peer = await hs?.remoteStatic, let h = hash else {
                throw Fail(.handshakeFailed)
            }
            let secret = try PeerLocal.linkSecret(h: h, isk: pair.isk, keyA: own, keyB: peer)
            onEvent(.localLink(secret: secret, ownKey: own, peerKey: peer, label: stored.label, cats: stored.cats))
        }
        if let c = r.close { throw Fail(PeerClosedReason(c)) }
    }

    /// Run one event through the contact exchange and act on what it says.
    private func exchangeStep(_ e: ContactExchangeEvent) async throws {
        guard var x = exchange, let offer else { return }
        let r = x.step(e)
        exchange = x
        if let c = r.close { throw Fail(PeerClosedReason(c)) }
        // CONFIRM is sent by `confirmSas`; only CONTACT is the exchange's to send.
        if r.sends.contains("CONTACT") {
            try emit(
                PeerRecordType.contact,
                try PeerContacts.buildContact(agreeKey: offer.agreeKey, label: offer.label, cats: offer.cats))
        }
        if let (body, pending) = r.stored {
            if !x.waiting { contactDue = nil }
            guard let h = hs, let own = PeerContacts.key32(offer.agreeKey),
                let peer = PeerContacts.key32(body.agreeKey),
                let nD, let nM
            else { throw Fail(.peerBadFrame) }
            let secret = try PeerContacts.secret(
                h: try await h.handshakeHash, nD: nD, nM: nM, agreeKeyA: own, agreeKeyB: peer)
            onEvent(.contact(secret: secret, body: body, pending: pending))
        }
    }

    private func commitSas() throws {
        let n = random(32)
        nD = n
        try emit(PeerRecordType.sasCommit, try PeerSAS.body(.c, PeerSAS.commit(n)))
        sasStep = 1
    }

    private func onSas(_ type: Int, _ body: Data) async throws {
        guard phase == .sas, !sasDone else { throw Fail(.peerBadFrame) }
        let initiator = role == .initiator
        // Responder (the approver): COMMIT then REVEAL. Initiator (the device): NONCE.
        if type == PeerRecordType.sasCommit && !initiator && sasStep == 0 {
            guard let c = PeerSAS.parseBody(.c, body) else { throw Fail(.peerBadFrame) }
            // Mode v: the code deadline counts from D's choice, as D's does from `startSas()`; a session held
            // while D's person looked at the list keeps its whole 120 s on this end too.
            if mode == .v { sasDue = mono() + peerSasDeadlineSeconds }
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
        guard let acct, mode == .a else { throw Fail(.peerNotAllowed) }
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
