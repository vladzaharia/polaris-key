// One Cloud Connect session as the host sees it (CC-11.10; WIRE-CONTRACT-V5 §15.5, §15.6). Mirrors
// `ConnectSession` and `routeRecord` in sdk-node's `connect/session.ts` and the Python port's
// `connect/session.py`.
//
// The engine (`PeerChannel`) and its pipe binding (`PeerLink`) run behind the link; this class is the
// thread-safe handle the host holds: `send`, `receive`, `onMessage`, `onClose` and `close`.
//
// Rules this file keeps:
//  - the host sees only the APP range (0x0100 to 0x7FFF). An APP-critical type (0x8100 to 0xFFFD) it
//    cannot understand closes the session with `peer_unknown_critical`; other types the session does
//    not own are ignored (G9);
//  - messages the host has not read yet are bounded (G10): the pipe pauses at 4 MiB queued and resumes
//    under 1 MiB; at 8 MiB, or at 256 queued messages, the session closes with `peer_busy`; all
//    sessions together hold at most 32 MiB (`ConnectQueueBudget`);
//  - every failure is a typed `ConnectLanError`; nothing reaches the host before the session is open;
//  - a session's description names its peer and path, never its keys.

import Foundation
import PolarisKeyCore

/// The first APP record type; `send` defaults to it.
public let connectAppDefaultType = 0x0100
public let connectMaxQueuedMessages = 256
/// A peer that sends faster than the host reads: pause at 4 MiB queued, resume under 1 MiB, close with
/// `peer_busy` at 8 MiB.
public let connectQueuePauseBytes = 4 * 1024 * 1024
public let connectQueueResumeBytes = 1024 * 1024
public let connectQueueMaxBytes = 8 * 1024 * 1024
/// All sessions of a process together.
public let connectTotalQueueBytes = 32 * 1024 * 1024

public struct ConnectMessage: Sendable, Equatable {
    public let type: Int
    public let body: Data
}

/// Why a session ended: a session close code (`peer_bye`, `peer_revoked`, ...), or `connection_lost`
/// when the pipe went away.
public struct ConnectSessionClosed: Sendable, Equatable {
    public let code: String
    public let byPeer: Bool
}

/// The bytes all sessions together may hold unread.
public final class ConnectQueueBudget: Sendable {
    private let limit: Int
    private let used_ = LockedValue(0)

    public init(limit: Int = connectTotalQueueBytes) { self.limit = limit }

    public var used: Int { used_.current }

    func reserve(_ n: Int) -> Bool {
        used_.with { u in
            if u + n > limit { return false }
            u += n
            return true
        }
    }

    func release(_ n: Int) { used_.with { $0 = max(0, $0 - n) } }

    static let shared = ConnectQueueBudget()
}

/// What a session needs of its link: send, close and pause. `PeerLink` is one; a relay session is
/// another.
public protocol ConnectSessionLink: Sendable {
    func sendRecord(type: Int, body: Data) async throws
    func close(_ code: PeerCloseCode) async
    /// Close from a callback that cannot await.
    func closeSoon(_ code: PeerCloseCode)
    /// Stop or resume reading. Links without flow control ignore it.
    func pause(_ on: Bool)
}

extension PeerLink: ConnectSessionLink {}

public final class ConnectSession: Sendable, CustomStringConvertible, CustomReflectable {
    private struct Waiter {
        let id: Int
        let cont: CheckedContinuation<ConnectMessage, Error>
    }
    private struct State {
        var queue: [ConnectMessage] = []
        var bytes = 0
        var paused = false
        var closed: ConnectSessionClosed?
        var nextId = 0
        var onMessage: [(id: Int, fn: @Sendable (ConnectMessage) -> Void)] = []
        var onClose: [(id: Int, fn: @Sendable (ConnectSessionClosed) -> Void)] = []
        var waiters: [Waiter] = []
    }

    public let peerDeviceId: String
    public let caps: [String]
    public let hello: PeerHello
    public let role: String
    public let remoteAddress: String
    public let path: String
    private let link: any ConnectSessionLink
    private let budget: ConnectQueueBudget
    private let state = LockedValue(State())

    public init(
        link: any ConnectSessionLink, peerDeviceId: String, caps: [String], hello: PeerHello, role: String,
        remoteAddress: String, path: String = "lan", budget: ConnectQueueBudget? = nil
    ) {
        self.link = link
        self.peerDeviceId = peerDeviceId
        self.caps = caps
        self.hello = hello
        self.role = role
        self.remoteAddress = remoteAddress
        self.path = path
        self.budget = budget ?? .shared
    }

    public var description: String { "ConnectSession(peer: \(peerDeviceId), path: \(path), role: \(role))" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }

    public var closed: ConnectSessionClosed? { state.with { $0.closed } }

    // MARK: Host calls

    /// Send one message (up to the peer's `maxMessage`, at most 1 MiB) as an APP record.
    public func send(_ body: Data, type: Int = connectAppDefaultType) async throws {
        guard type >= 0x0100, type <= 0x7FFF else {
            throw ConnectLanError(.badType, "Application types are 0x0100 to 0x7FFF.")
        }
        try await sendRecord(type: type, body: body)
    }

    /// Send a record of any type the session does not own (a peer document, a later transfer type).
    /// The engine refuses HELLO, CLOSE, REKEY and SAS records.
    public func sendRecord(type: Int, body: Data) async throws {
        if closed != nil { throw ConnectLanError(.closed, "The session is closed.") }
        do {
            try await link.sendRecord(type: type, body: body)
        } catch PeerChannelError.messageTooLarge {
            throw ConnectLanError(.tooLarge, "The message is larger than the peer accepts.")
        } catch let e as ConnectRelayError {
            throw e
        } catch {
            throw ConnectLanError(.closed, "The session is closed.")
        }
    }

    /// The next message. Waits until one arrives; throws `ConnectLanError` (`closed`) when the session
    /// closes with none waiting, and `CancellationError` when the task is cancelled.
    public func receive() async throws -> ConnectMessage {
        enum Step {
            case got(ConnectMessage, resume: Bool)
            case closed
            case wait
        }
        let id = state.with { s -> Int in
            s.nextId += 1
            return s.nextId
        }
        let step: Step = state.with { s in
            if !s.queue.isEmpty {
                let m = s.queue.removeFirst()
                s.bytes -= m.body.count
                let resume = s.paused && s.bytes < connectQueueResumeBytes
                if resume { s.paused = false }
                return .got(m, resume: resume)
            }
            return s.closed != nil ? .closed : .wait
        }
        switch step {
        case .got(let m, let resume):
            budget.release(m.body.count)
            if resume { link.pause(false) }
            return m
        case .closed:
            throw ConnectLanError(.closed, "The session is closed.")
        case .wait:
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<ConnectMessage, Error>) in
                    let late: Error? = state.with { s in
                        if s.closed != nil { return ConnectLanError(.closed, "The session is closed.") }
                        s.waiters.append(Waiter(id: id, cont: c))
                        return nil
                    }
                    if let late { c.resume(throwing: late) }
                }
            } onCancel: {
                let w = state.with { s -> Waiter? in
                    guard let i = s.waiters.firstIndex(where: { $0.id == id }) else { return nil }
                    return s.waiters.remove(at: i)
                }
                w?.cont.resume(throwing: CancellationError())
            }
        }
    }

    /// Called for each message instead of queueing it. Returns the unsubscribe.
    @discardableResult
    public func onMessage(_ fn: @escaping @Sendable (ConnectMessage) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.nextId += 1
            s.onMessage.append((s.nextId, fn))
            return s.nextId
        }
        return { [state] in state.with { $0.onMessage.removeAll { $0.id == id } } }
    }

    /// Called once when the session ends; at once if it already has. Returns the unsubscribe.
    @discardableResult
    public func onClose(_ fn: @escaping @Sendable (ConnectSessionClosed) -> Void) -> @Sendable () -> Void {
        let (id, done) = state.with { s -> (Int, ConnectSessionClosed?) in
            s.nextId += 1
            if s.closed == nil { s.onClose.append((s.nextId, fn)) }
            return (s.nextId, s.closed)
        }
        if let done { fn(done) }
        return { [state] in state.with { $0.onClose.removeAll { $0.id == id } } }
    }

    /// Close with `peer_bye` (or `peer_busy`); the CLOSE record is sent first.
    public func close(_ code: PeerCloseCode = .peerBye) async {
        precondition(code == .peerBye || code == .peerBusy, "close code")
        await link.close(code)
    }

    // MARK: The link's calls

    func deliver(_ m: ConnectMessage) {
        enum Out {
            case none
            case subs([@Sendable (ConnectMessage) -> Void])
            case waiter(CheckedContinuation<ConnectMessage, Error>)
            case busy
            case pause
        }
        let out: Out = state.with { s in
            if s.closed != nil { return .none }
            if !s.onMessage.isEmpty { return .subs(s.onMessage.map(\.fn)) }
            if !s.waiters.isEmpty { return .waiter(s.waiters.removeFirst().cont) }
            let over =
                s.queue.count >= connectMaxQueuedMessages || s.bytes + m.body.count > connectQueueMaxBytes
                || !budget.reserve(m.body.count)
            if over { return .busy }
            s.queue.append(m)
            s.bytes += m.body.count
            if !s.paused && s.bytes > connectQueuePauseBytes {
                s.paused = true
                return .pause
            }
            return .none
        }
        switch out {
        case .none: break
        case .subs(let fns): for f in fns { f(m) }
        case .waiter(let c): c.resume(returning: m)
        case .busy: link.closeSoon(.peerBusy)
        case .pause: link.pause(true)
        }
    }

    func ended(_ c: ConnectSessionClosed) {
        let (dropped, subs, waiters, first) = state.with {
            s -> (Int, [@Sendable (ConnectSessionClosed) -> Void], [Waiter], Bool) in
            if s.closed != nil { return (0, [], [], false) }
            s.closed = c
            let d = s.bytes
            s.queue.removeAll()
            s.bytes = 0
            let w = s.waiters
            s.waiters = []
            return (d, s.onClose.map(\.fn), w, true)
        }
        guard first else { return }
        budget.release(dropped)
        for w in waiters { w.cont.resume(throwing: ConnectLanError(.closed, "The session is closed.")) }
        for f in subs { f(c) }
    }
}

/// A record the engine hands up: the APP range goes to the host's session; an APP-critical type
/// (0x8100 to 0xFFFD) the host cannot understand closes the session; the rest is ignored.
func routeConnectRecord(link: any ConnectSessionLink, session: ConnectSession?, type: Int, body: Data) {
    if type >= 0x0100 && type <= 0x7FFF {
        session?.deliver(ConnectMessage(type: type, body: body))
    } else if type >= 0x8100 && type <= 0xFFFD {
        link.closeSoon(.peerUnknownCritical)
    }
}

/// The link callbacks that make a `ConnectSession`: it is built when the peer is admitted, APP records
/// are routed to it, and the link's close ends it. Build the link with `handlers`, then `opened(link)`.
public final class ConnectSessionHandlers: Sendable {
    private let role: String
    private let path: String
    private let budget: ConnectQueueBudget?
    private let box = LockedValue<ConnectSession?>(nil)
    private let linkBox = LockedValue<(any ConnectSessionLink)?>(nil)
    private let onEstablishedFn: (@Sendable (ConnectSession) -> Void)?
    private let onRingFn: (@Sendable (String, Int) -> Void)?
    private let onTrustFn: (@Sendable (String) -> Void)?
    private let onRingWantedFn: (@Sendable () -> Void)?
    private let onEndedFn: (@Sendable () -> Void)?

    public init(
        role: String, path: String = "lan", budget: ConnectQueueBudget? = nil,
        onEstablished: (@Sendable (ConnectSession) -> Void)? = nil, onRing: (@Sendable (String, Int) -> Void)? = nil,
        onTrust: (@Sendable (String) -> Void)? = nil, onRingWanted: (@Sendable () -> Void)? = nil,
        onEnded: (@Sendable () -> Void)? = nil
    ) {
        self.role = role
        self.path = path
        self.budget = budget
        onEstablishedFn = onEstablished
        onRingFn = onRing
        onTrustFn = onTrust
        onRingWantedFn = onRingWanted
        onEndedFn = onEnded
    }

    /// Give the handlers the link they route for. Call once, right after the link is made and before
    /// `run()`.
    public func attach(_ link: any ConnectSessionLink) { linkBox.set(link) }

    public var handlers: PeerLinkHandlers {
        PeerLinkHandlers(
            onEstablished: { [self] e, address in
                guard let id = e.peerDeviceId, let link = linkBox.current else { return }
                let s = ConnectSession(
                    link: link, peerDeviceId: id, caps: e.caps, hello: e.hello, role: role, remoteAddress: address,
                    path: path, budget: budget)
                box.set(s)
                onEstablishedFn?(s)
            },
            onRecord: { [self] t, b in
                guard let link = linkBox.current else { return }
                routeConnectRecord(link: link, session: box.current, type: t, body: b)
            },
            onRing: onRingFn, onTrust: onTrustFn, onRingWanted: onRingWantedFn,
            onClosed: { [self] c in box.current?.ended(ConnectSessionClosed(code: c.code, byPeer: c.byPeer)) },
            onEnded: onEndedFn)
    }

    /// Await a link's admission: the `ConnectSession`, or a `ConnectLanError` (`handshakeFailed` with
    /// `closeCode`) when the peer was not admitted.
    public func opened(_ link: PeerLink) async throws -> ConnectSession {
        do {
            _ = try await link.opened()
        } catch let r as PeerLinkRefused {
            throw ConnectLanError(.handshakeFailed, "The peer was not admitted.", closeCode: r.closeCode)
        }
        guard let s = box.current else { throw ConnectLanError(.handshakeFailed, "The peer was not admitted.") }
        return s
    }
}
