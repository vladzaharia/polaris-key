// The relay half of Cloud Connect, socket side (CC-11.13; WIRE-CONTRACT-V5 §15.7). One WebSocket to the
// account room carries envelopes. Mirrors the socket half of sdk-node's `connect/relay.ts` and the Python
// port's `connect/relay.py`. The peer sessions that ride the socket are CC-11.14.
//
// D-4: the socket is `URLSessionWebSocketTask` (system proxies and trust). `ConnectRelayTests` proves that
// the close codes 4001, 4003, 4008 and 4009 reach this client through it.
//
// Rules this file keeps:
//  - a ticket is single use and lives 60 seconds, so every connect fetches a new one. The socket is opened
//    offering `pkey-relay.1` and then the ticket as subprotocols, and the client requires `pkey-relay.1`
//    echoed back (G14). The ticket is never logged, stored past the open or put in an error: this file
//    logs nothing, and a failed open reports no cause (G13). TLS is never off: only `wss:` opens, and
//    the server's certificate is judged by the system;
//  - a message is at most 65,564 bytes; an envelope that fails its layout, or a text frame, closes the
//    socket with 1002 and is never answered (G14); each running service has one socket;
//  - the room stamps `from`; this file never uses it for identity;
//  - reconnects back off exponentially with equal jitter and a floor, and the backoff resets only after the
//    socket stayed up 30 seconds. `Retry-After` is capped at 3,600 seconds. A product that turned the relay
//    off, or a spent quota, ends the loop with a typed error; 4009 (replaced) stops without fighting back;
//    4003 fetches the roster once and stops after three in a row; 4001 simply gets a new ticket; after five
//    attempts that never open the status is `unavailable` and a retry waits at least five minutes (G15).

import Foundation
import PolarisKeyCore

public let connectRelayMaxRetryAfterSeconds = 3600
public let connectRelayUnavailableAfter = 5
public let connectRelayUnavailableRetrySeconds: TimeInterval = 300
private let identityTtlSeconds = 30
private let certMarginSeconds = 60

/// The only `PeerChannel` mode that may cross the relay (G16).
public func assertRelayMode(_ mode: PeerNoiseMode) throws {
    if mode != .a {
        throw ConnectRelayError(.modeNotAllowed, "Mode \(mode.rawValue) never crosses the relay; it is LAN only.")
    }
}

// MARK: - The socket seam

public enum RelayFrame: Sendable, Equatable {
    case binary(Data)
    case text
}

/// The socket closed (or could not open). `code` is the close code, nil when there was none.
public struct RelaySocketClosed: Error, Sendable, Equatable {
    public let code: Int?
    public init(code: Int?) { self.code = code }
}

/// What the service uses of a WebSocket: binary messages in and out.
public protocol ConnectRelaySocket: Sendable {
    func send(_ data: Data) async throws
    /// Throws `RelaySocketClosed`.
    func receive() async throws -> RelayFrame
    func close(code: Int) async
}

public typealias ConnectRelayOpener =
    @Sendable (_ url: URL, _ protocols: [String]) async throws -> any ConnectRelaySocket

// MARK: - URLSessionWebSocketTask

/// The default opener. It offers the protocols, requires `pkey-relay.1` echoed back, caps messages at
/// 65,564 bytes and refuses any URL that is not `wss:`. `allowInsecureLoopback` accepts `ws:` to
/// 127.0.0.1 and ::1 only, for this SDK's own tests.
public func urlSessionRelayOpener(openSeconds: TimeInterval = 15, allowInsecureLoopback: Bool = false)
    -> ConnectRelayOpener
{
    { url, protocols in
        let host = url.host?.lowercased() ?? ""
        let loopback = host == "127.0.0.1" || host == "::1" || host == "localhost"
        guard url.scheme == "wss" || (allowInsecureLoopback && url.scheme == "ws" && loopback) else {
            throw RelaySocketClosed(code: nil)
        }
        return try await URLSessionRelaySocket.open(url: url, protocols: protocols, openSeconds: openSeconds)
    }
}

final class URLSessionRelaySocket: NSObject, ConnectRelaySocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var openCont: CheckedContinuation<String?, Error>?
    private var openDone = false
    private var closeCode: Int?
    private var ended = false

    static func open(url: URL, protocols: [String], openSeconds: TimeInterval) async throws -> URLSessionRelaySocket {
        let s = URLSessionRelaySocket()
        let negotiated = try await s.begin(url: url, protocols: protocols, openSeconds: openSeconds)
        if negotiated != connectRelayProtocol {
            await s.close(code: 1002)
            throw RelaySocketClosed(code: 1002)
        }
        return s
    }

    private func begin(url: URL, protocols: [String], openSeconds: TimeInterval) async throws -> String? {
        let cfg = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url, protocols: protocols)
        task.maximumMessageSize = peerRelayMaxMessage
        lock.withLock {
            self.session = session
            self.task = task
        }
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<String?, Error>) in
            lock.withLock { openCont = c }
            task.resume()
            DispatchQueue.global().asyncAfter(deadline: .now() + openSeconds) { [weak self] in
                self?.finishOpen(.failure(RelaySocketClosed(code: nil)), cancel: true)
            }
        }
    }

    private func finishOpen(_ r: Result<String?, Error>, cancel: Bool = false) {
        let (c, t) = lock.withLock { () -> (CheckedContinuation<String?, Error>?, URLSessionWebSocketTask?) in
            if openDone { return (nil, nil) }
            openDone = true
            let c = openCont
            openCont = nil
            return (c, task)
        }
        guard let c else { return }
        if cancel { t?.cancel() }
        c.resume(with: r)
    }

    // The delegate. Nothing here sees or keeps the ticket, and the trust challenge is the system's.
    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
    ) {
        finishOpen(.success(`protocol`))
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        lock.withLock { self.closeCode = closeCode.rawValue }
        finishOpen(.failure(RelaySocketClosed(code: closeCode.rawValue)))
    }

    /// Never follow a redirect (B1, G13): the upgrade request carries the single-use ticket as a
    /// subprotocol, and a redirect would send it to whatever host the answer names. Completing with nil
    /// makes the 3xx the task's answer, so the open fails and nothing is sent to the new origin.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.withLock { ended = true }
        // No cause: a handshake error could carry the request.
        finishOpen(.failure(RelaySocketClosed(code: lock.withLock { closeCode })))
    }

    /// The close code the peer sent, given the OS a moment to deliver it.
    private func closedError() async -> RelaySocketClosed {
        for _ in 0..<25 {
            if let c = lock.withLock({ closeCode }) { return RelaySocketClosed(code: c) }
            if let t = lock.withLock({ task }), t.closeCode != .invalid {
                return RelaySocketClosed(code: t.closeCode.rawValue)
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return RelaySocketClosed(code: nil)
    }

    func send(_ data: Data) async throws {
        guard let t = lock.withLock({ task }) else { throw RelaySocketClosed(code: nil) }
        do { try await t.send(.data(data)) } catch { throw await closedError() }
    }

    func receive() async throws -> RelayFrame {
        guard let t = lock.withLock({ task }) else { throw RelaySocketClosed(code: nil) }
        do {
            switch try await t.receive() {
            case .data(let d): return .binary(d)
            case .string: return .text
            @unknown default: return .text
            }
        } catch { throw await closedError() }
    }

    func close(code: Int) async {
        let (t, s) = lock.withLock { (task, session) }
        t?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
        s?.finishTasksAndInvalidate()
    }
}

// MARK: - Status

public enum ConnectRelayState: String, Sendable, Equatable {
    case idle, connecting, open, backoff, unavailable, blocked, off, stopped
}

public struct ConnectRelayStatus: Sendable, Equatable {
    public let state: ConnectRelayState
    public let error: ConnectRelayError?
    /// Failed attempts since the last open.
    public let attempts: Int
}

public struct ConnectRelayOptions: Sendable {
    public var opener: ConnectRelayOpener?
    /// Sleep for the backoff and the ping interval; throws `CancellationError` when cancelled.
    public var sleep: (@Sendable (TimeInterval) async throws -> Void)?
    public var random: (@Sendable () -> Double)?
    /// Monotonic seconds.
    public var clock: (@Sendable () -> TimeInterval)?
    public var caps: [String]
    public var label: String?
    /// Reconnect backoff: base 1 s, doubling to 60 s, with equal jitter; never under `backoffMin`.
    public var backoffBase: TimeInterval
    public var backoffMax: TimeInterval
    public var backoffMin: TimeInterval
    /// How long a socket must stay open before the backoff resets.
    public var stableSeconds: TimeInterval
    public var pingSeconds: TimeInterval
    public var openSeconds: TimeInterval
    public var maxSessions: Int
    public var maxPendingPerPeer: Int
    public var handshakeSeconds: TimeInterval
    /// Makes the pacer for each socket (tests inject a clock). Default: 180/s with a burst of 360 (D-9).
    public var pacer: (@Sendable () -> ConnectPacer)?
    public var rekeyMessages: Int?
    public var rekeySeconds: TimeInterval?

    public init(
        opener: ConnectRelayOpener? = nil, sleep: (@Sendable (TimeInterval) async throws -> Void)? = nil,
        random: (@Sendable () -> Double)? = nil, clock: (@Sendable () -> TimeInterval)? = nil,
        caps: [String] = ["app/1"], label: String? = nil, backoffBase: TimeInterval = 1, backoffMax: TimeInterval = 60,
        backoffMin: TimeInterval = 0.5, stableSeconds: TimeInterval = 30, pingSeconds: TimeInterval = 25,
        openSeconds: TimeInterval = 15, maxSessions: Int = 64, maxPendingPerPeer: Int = 4,
        handshakeSeconds: TimeInterval = 30, pacer: (@Sendable () -> ConnectPacer)? = nil, rekeyMessages: Int? = nil,
        rekeySeconds: TimeInterval? = nil
    ) {
        self.opener = opener
        self.sleep = sleep
        self.random = random
        self.clock = clock
        self.caps = caps
        self.label = label
        self.backoffBase = backoffBase
        self.backoffMax = backoffMax
        self.backoffMin = backoffMin
        self.stableSeconds = stableSeconds
        self.pingSeconds = pingSeconds
        self.openSeconds = openSeconds
        self.maxSessions = maxSessions
        self.maxPendingPerPeer = maxPendingPerPeer
        self.handshakeSeconds = handshakeSeconds
        self.pacer = pacer
        self.rekeyMessages = rekeyMessages
        self.rekeySeconds = rekeySeconds
    }
}

private final class RelaySubs<T: Sendable>: Sendable {
    private struct S {
        var next = 0
        var fns: [(Int, @Sendable (T) -> Void)] = []
    }
    private let state = LockedValue(S())
    func add(_ fn: @escaping @Sendable (T) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.next += 1
            s.fns.append((s.next, fn))
            return s.next
        }
        return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
    }
    func fire(_ v: T) { for f in state.with({ $0.fns.map(\.1) }) { f(v) } }
}

private final class RelayHook: Sendable {
    private let fn = LockedValue<(@Sendable () -> Void)?>(nil)
    func set(_ f: @escaping @Sendable () -> Void) { fn.set(f) }
    func fire() { fn.current?() }
}

// MARK: - The service

public actor ConnectRelayService: CustomStringConvertible, CustomReflectable {
    /// Fetches a fresh single-use ticket; `ConnectClient.relayTicket` is one.
    public typealias Ticket = @Sendable () async -> ConnectRelayTicketResult

    let src: ConnectLanSource
    let ticket: Ticket
    let o: ConnectRelayOptions
    let docs: ConnectPeerDocs
    private let openSocket: ConnectRelayOpener
    private let sleepFn: @Sendable (TimeInterval) async throws -> Void
    private let rand: @Sendable () -> Double
    private let clock: @Sendable () -> TimeInterval
    private let stateSubs = RelaySubs<ConnectRelayStatus>()
    private let memberSubs = RelaySubs<[String]>()

    private var state: ConnectRelayState = .idle
    private var error: ConnectRelayError?
    private var attempts = 0
    var stopped = false
    private var started = false
    private var ws: (any ConnectRelaySocket)?
    /// The open socket, readable without the actor: `abort()` must work while the actor is busy.
    private let liveSocket = LockedValue<(any ConnectRelaySocket)?>(nil)
    private var isOpen = false
    private var memberSet: Set<String> = []
    private var lastLimit: Int?
    private var notMember = 0
    private var runTask: Task<Void, Never>?
    private var sleeping: Task<Void, Error>?
    private var outbox: ConnectOutbox?
    private var pacer: ConnectPacer?
    private var links: [String: RelayLinkEntry] = [:]
    private var endedKeys: [String] = []
    private let sessionSubs = RelaySubs<ConnectSession>()
    private var waiters: [Int: CheckedContinuation<Void, Error>] = [:]
    private var nextWaiter = 0
    private var held: (at: Int, gen: Int, src: PeerSource)?

    public init(
        source: ConnectLanSource, ticket: @escaping Ticket, options: ConnectRelayOptions = ConnectRelayOptions()
    ) {
        src = source
        self.ticket = ticket
        o = options
        openSocket = options.opener ?? urlSessionRelayOpener(openSeconds: options.openSeconds)
        sleepFn = options.sleep ?? { s in try await Task.sleep(nanoseconds: UInt64(max(0, s) * 1_000_000_000)) }
        rand = options.random ?? { Double.random(in: 0..<1) }
        clock = options.clock ?? { ProcessInfo.processInfo.systemUptime }
        let hook = RelayHook()
        docs = ConnectPeerDocs(
            source: ConnectPeerDocsSource(
                now: source.now, refresh: source.refresh, adoptRing: source.adoptRing, applyTrust: source.applyTrust),
            onStored: { hook.fire() })
        hook.set { [weak self] in
            guard let self else { return }
            Task { await self.stored() }
        }
    }

    public nonisolated var description: String { "ConnectRelayService()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    func stored() {
        src.changes.bump()
        held = nil
    }

    // MARK: Surface

    /// Begin connecting; use `ready()` to wait for the socket.
    public func start() {
        if started || stopped { return }
        started = true
        runTask = Task { await self.run() }
    }

    public var status: ConnectRelayStatus { ConnectRelayStatus(state: state, error: error, attempts: attempts) }

    @discardableResult
    public nonisolated func onState(_ fn: @escaping @Sendable (ConnectRelayStatus) -> Void) -> @Sendable () -> Void {
        stateSubs.add(fn)
    }

    /// Called when the room's member list changes (device ids of this person's online devices).
    @discardableResult
    public nonisolated func onMembers(_ fn: @escaping @Sendable ([String]) -> Void) -> @Sendable () -> Void {
        memberSubs.add(fn)
    }

    @discardableResult
    public nonisolated func onNotice(_ fn: @escaping @Sendable (ConnectNotice) -> Void) -> @Sendable () -> Void {
        docs.onNotice(fn)
    }

    /// The person's devices online in the room, as of the last MEMBERS (this device included).
    public func members() -> [String] { memberSet.sorted() }

    /// Ask the room who is online now; returns on the answer or after `timeout`.
    public func refreshMembers(timeout: TimeInterval = 2) async -> [String] {
        guard isOpen else { return members() }
        let gate = LockedValue(false)
        let wake = AsyncStream<Void>.makeStream()
        let off = onMembers { _ in
            if !gate.with({ g in
                let was = g
                g = true
                return was
            }) {
                wake.continuation.finish()
            }
        }
        sendEnv(.list)
        let t = Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            wake.continuation.finish()
        }
        for await _ in wake.stream {}
        t.cancel()
        off()
        return members()
    }

    /// Resolves once the socket is open; throws the typed error when the loop is blocked.
    public func ready(timeout: TimeInterval? = nil) async throws {
        if isOpen { return }
        if state == .blocked || state == .stopped || state == .off {
            throw error ?? Self.stoppedError
        }
        if !started { start() }
        nextWaiter += 1
        let id = nextWaiter
        let limit = timeout ?? o.openSeconds
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
            self.expire(id)
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            waiters[id] = c
        }
    }

    private func expire(_ id: Int) {
        guard let c = waiters.removeValue(forKey: id) else { return }
        c.resume(throwing: error ?? ConnectRelayError(.notConnected, "The relay is not connected."))
    }

    /// After a block (a quota), try again now; otherwise cut a backoff short.
    public func resume() {
        if stopped { return }
        if state == .blocked {
            error = nil
            attempts = 0
            started = true
            set(.idle)
            runTask = Task { await self.run() }
        } else {
            sleeping?.cancel()
        }
    }

    public func stop() async {
        if stopped { return }
        stopped = true
        docs.close()
        set(.stopped)
        loseLinks()
        let s = ws
        ws = nil
        isOpen = false
        outbox?.close()
        outbox = nil
        pacer = nil
        sleeping?.cancel()
        await s?.close(code: 1000)
        runTask?.cancel()
        await runTask?.value
        flush(Self.stoppedError)
    }

    /// Force-stop for a sign-out that cannot wait (D-12): cancel the socket now, with no graceful close and no
    /// await on the actor, then drop the sessions and the held identity. Safe beside a `stop()` that is stuck.
    public nonisolated func abort() {
        if let s = liveSocket.with({ v -> (any ConnectRelaySocket)? in
            defer { v = nil }
            return v
        }) {
            Task { await s.close(code: 1001) }
        }
        docs.close()
        Task { await self.abortInActor() }
    }

    private func abortInActor() {
        stopped = true
        held = nil
        set(.stopped)
        loseLinks()
        ws = nil
        isOpen = false
        outbox?.close()
        outbox = nil
        pacer = nil
        sleeping?.cancel()
        runTask?.cancel()
        flush(Self.stoppedError)
    }

    static let stoppedError = ConnectRelayError(.stopped, "The relay is stopped.")

    // MARK: The connect loop

    private func run() async {
        while !stopped && !Task.isCancelled {
            set(.connecting)
            var code: Int?
            var waitS: TimeInterval = 0
            let granted = await ticket()
            if stopped { return }
            switch granted {
            case .granted(let g):
                code = await session(g)
            case .relay(let e):
                error = e
                if e.reason == .disabled || e.reason == .quota { return block(e) }
                waitS = TimeInterval(e.retryAfterSeconds ?? 0)
            case .unsupported:
                return block(ConnectRelayError(.disabled, "The product does not run Cloud Connect."))
            case .refused, .error:
                error = ConnectRelayError(.unavailable, "The relay could not be reached.")
            }
            if stopped { return }
            if let end = afterClose(code) { return block(end) }
            attempts += 1
            var delay = max(backoff(), min(waitS, TimeInterval(connectRelayMaxRetryAfterSeconds)))
            if attempts >= connectRelayUnavailableAfter {
                set(.unavailable)
                delay = max(delay, connectRelayUnavailableRetrySeconds)
            } else {
                set(.backoff)
            }
            await nap(delay)
        }
    }

    private func nap(_ seconds: TimeInterval) async {
        let f = sleepFn
        let t = Task { try await f(seconds) }
        sleeping = t
        _ = await t.result
        sleeping = nil
    }

    /// What a close means for the loop: nil to reconnect, else the error that ends it.
    private func afterClose(_ code: Int?) -> ConnectRelayError? {
        let limit = lastLimit
        lastLimit = nil
        guard let code else { return nil }
        if code == 4009 {
            return ConnectRelayError(
                .replaced, "Another connection of this device took the relay socket.", closeCode: code)
        }
        if code == 4003 {
            // The roster this device holds is out of date: fetch it, and stop if it keeps happening.
            wantRing()
            notMember += 1
            if notMember >= 3 {
                return ConnectRelayError(.notMember, "The room does not know this device.", closeCode: code)
            }
            return nil
        }
        notMember = 0
        if code == 4008, let l = limit, l == 2 || l == 3 {
            return ConnectRelayError(
                .quota, "The relay quota is spent.", scope: l == 3 ? "product" : "person", closeCode: code)
        }
        return nil
    }

    private func block(_ e: ConnectRelayError) {
        error = e
        isOpen = false
        set(.blocked)
        flush(e)
    }

    func backoff() -> TimeInterval {
        let cap = min(o.backoffMax, o.backoffBase * pow(2, Double(min(max(attempts - 1, 0), 16))))
        // Equal jitter: half fixed, half random, never under the floor.
        return max(o.backoffMin, cap / 2 + rand() * cap / 2)
    }

    // MARK: One socket

    private func session(_ grant: RelayGrant) async -> Int? {
        let sock: any ConnectRelaySocket
        do {
            sock = try await openSocket(grant.url, [connectRelayProtocol, grant.ticket])
        } catch let e as RelaySocketClosed {
            error = ConnectRelayError(.unavailable, "The relay could not be reached.", closeCode: e.code)
            return e.code
        } catch {
            self.error = ConnectRelayError(.unavailable, "The relay could not be reached.")
            return nil
        }
        if stopped {
            await sock.close(code: 1000)
            return nil
        }
        ws = sock
        liveSocket.set(sock)
        isOpen = true
        let openedAt = clock()
        lastLimit = nil
        error = nil
        let q = ConnectOutbox()
        let pc = (o.pacer ?? { ConnectPacer() })()
        outbox = q
        pacer = pc
        set(.open)
        let w = waiters
        waiters = [:]
        for c in w.values { c.resume() }
        let writer = Task {
            while let d = await q.get() {
                do {
                    try await pc.acquire()
                    try await sock.send(d)
                } catch { break }
                q.sent()
            }
        }
        let pinger = Task { await self.ping(sock) }
        sendEnv(.list)
        var code: Int?
        loop: while true {
            do {
                switch try await sock.receive() {
                case .text:
                    await sock.close(code: 1002)
                    code = 1002
                    break loop
                case .binary(let d):
                    guard await handle(d) else {
                        await sock.close(code: 1002)
                        code = 1002
                        break loop
                    }
                }
            } catch let e as RelaySocketClosed {
                code = e.code
                break loop
            } catch {
                break loop
            }
        }
        writer.cancel()
        pinger.cancel()
        q.close()
        let was = isOpen
        if was && clock() - openedAt >= o.stableSeconds { attempts = 0 }
        isOpen = false
        ws = nil
        liveSocket.set(nil)
        outbox = nil
        pacer = nil
        memberSet = []
        loseLinks()
        if was { emitMembers() }
        return code
    }

    private func ping(_ sock: any ConnectRelaySocket) async {
        while !stopped && !Task.isCancelled && isOpen {
            do { try await sleepFn(o.pingSeconds) } catch { return }
            if !isOpen { return }
            var b = [UInt8](repeating: 0, count: 8)
            for i in 0..<8 { b[i] = UInt8.random(in: 0...255) }
            sendEnv(.ping(Data(b)))
            sendEnv(.list)
        }
    }

    private func sendEnv(_ m: PeerRelayMessage) {
        guard isOpen, let o = outbox, let d = try? PeerRelayEnvelope.encode(m) else { return }
        o.put(d, force: true)
    }

    /// The open sessions' room keys (tests).
    func openLinkIds() -> [(peer: Data, session: UInt32)] { links.values.map { ($0.peer, $0.session) } }

    func sendSession(peer: Data, session: UInt32, noise: Data) {
        // A session's traffic is never queued past the outbox cap (S4): when the queue is full the session
        // holding the most queued bytes (its own share) loses its session with `peer_busy`, whichever session
        // happens to write next; the others go on.
        let tag = linkTag(peer, session)
        let need = noise.count + 128
        if let q = outbox, !q.roomFor(need) {
            var victim = tag
            if let big = q.largest(), big.bytes > q.queued(tag: tag) { victim = big.tag }
            for e in links.values where linkTag(e.peer, e.session) == victim {
                e.link?.closeSoon(.peerBusy)
                e.pipe.lose()
            }
            q.purge(tag: victim)
            if victim == tag || !q.roomFor(need) { return }
        }
        guard isOpen, let q = outbox,
            let d = try? PeerRelayEnvelope.encode(.send(to: peer, session: session, noise: noise))
        else {
            return
        }
        q.put(d, force: true, tag: tag)
    }

    /// The outbox's per-session accounting key: a 64-bit FNV-1a over the peer and the session id, cheap enough
    /// for every record.
    private func linkTag(_ peer: Data, _ session: UInt32) -> Int {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in peer {
            h = (h ^ UInt64(b)) &* 0x100_0000_01b3
        }
        for shift in stride(from: 0, to: 32, by: 8) {
            h = (h ^ UInt64((session >> UInt32(shift)) & 0xff)) &* 0x100_0000_01b3
        }
        return Int(truncatingIfNeeded: h)
    }

    func hasRoom(_ n: Int) -> Bool { outbox?.roomFor(n) ?? false }

    /// False when the envelope is refused (the caller closes 1002).
    private func handle(_ data: Data) async -> Bool {
        guard let m = PeerRelayEnvelope.decode(.toClient, data) else { return false }
        switch m {
        case .recv(let from, let session, let noise):
            await received(from: from, session: session, noise: noise)
        case .members(let devices):
            memberSet = Set(devices.map { Base64URL.encode($0) })
            emitMembers()
        case .ring(let epoch):
            // The roster changed. Fetch the newer one under the normal replacement rules; the epoch is only
            // a hint of whether it is newer than the one held.
            let ident = try? await identity(force: false)
            if ident == nil || Int(epoch) > ident!.ringEpoch { wantRing() }
        case .gone(let d):
            memberSet.remove(Base64URL.encode(d))
            gone(d)
            emitMembers()
        case .limit(let reason):
            limit(Int(reason))
        case .pong, .send, .list, .ping:
            break
        }
        return true
    }

    private func limit(_ reason: Int) {
        lastLimit = reason
        if reason == 1 { pacer?.halve() }
        let why: ConnectRelayReason = reason == 1 ? .rateLimited : reason == 4 ? .paused : .quota
        let msg =
            why == .paused
            ? "The relay is paused."
            : why == .quota ? "The relay quota is spent." : "Slow down: the relay is rate limiting this device."
        let scope: String? = (reason == 2 || reason == 3) ? (reason == 3 ? "product" : "person") : nil
        error = ConnectRelayError(why, msg, scope: scope)
        set(state)
    }

    // MARK: Sessions (CC-11.14)

    /// Called for each inbound session once it is open and admitted.
    @discardableResult
    public nonisolated func onSession(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
        sessionSubs.add(fn)
    }

    /// Dial a device of the person over the relay and run the handshake. Throws `ConnectRelayError`:
    /// `unknownPeer`, `busy`, `handshakeFailed`, `wrongPeer`, or the reason the relay is not connected.
    public func dial(_ deviceId: String) async throws -> ConnectSession {
        try await ready()
        guard let peer = try? PeerAdvert.deviceIdBytes(deviceId) else {
            throw ConnectRelayError(.unknownPeer, "That is not a device id.")
        }
        let ident: PeerSource
        do { ident = try await identity(force: false) } catch {
            throw ConnectRelayError(.unknownPeer, "No Cloud Connect identity is held.")
        }
        if deviceId == ident.deviceId || !ident.roster.contains(deviceId) {
            throw ConnectRelayError(.unknownPeer, "That device is not one of this person's devices.")
        }
        guard let entry = try await makeLink(peer: peer, session: newSessionId(peer), role: .initiator, ident: ident)
        else {
            throw ConnectRelayError(.busy, "Too many relay sessions are open.")
        }
        do {
            let s = try await entry.handlers.opened(entry.link!)
            return try await checked(s, entry)
        } catch let e as ConnectRelayError {
            throw e
        } catch {
            throw ConnectRelayError(.handshakeFailed, "The handshake failed.")
        }
    }

    /// G8: the certificate names the peer; the room's stamp must agree.
    private func checked(_ s: ConnectSession, _ e: RelayLinkEntry) async throws -> ConnectSession {
        if s.peerDeviceId != Base64URL.encode(e.peer) {
            await s.close()
            throw ConnectRelayError(.wrongPeer, "The device that answered is not the one that was dialled.")
        }
        return s
    }

    func received(from: Data, session: UInt32, noise: Data) async {
        let key = linkKey(from, session)
        if let known = links[key] {
            known.pipe.push(noise)
            return
        }
        if endedKeys.contains(key) { return }
        // A first message of a session the peer opened. Only the person's own devices may.
        guard let ident = try? await identity(force: false), !stopped, isOpen else { return }
        let fromId = Base64URL.encode(from)
        if fromId == ident.deviceId || !ident.roster.contains(fromId) { return }
        if links.values.filter({ $0.peer == from && !$0.ended }).count >= o.maxPendingPerPeer { return }
        // Another message of the same session may have arrived while the identity loaded.
        if let known = links[key] {
            known.pipe.push(noise)
            return
        }
        guard let e = try? await makeLink(peer: from, session: session, role: .responder, ident: ident, first: noise)
        else { return }
        let h = e.handlers
        let link = e.link!
        Task {
            guard let s = try? await h.opened(link) else { return }
            await self.admitted(s, e)
        }
    }

    private func admitted(_ s: ConnectSession, _ e: RelayLinkEntry) async {
        guard let s = try? await checked(s, e), !stopped else { return }
        sessionSubs.fire(s)
    }

    private func linkKey(_ peer: Data, _ session: UInt32) -> String {
        peer.map { String(format: "%02x", $0) }.joined() + ":" + String(session)
    }

    private func newSessionId(_ peer: Data) -> UInt32 {
        while true {
            let n = UInt32.random(in: 0...UInt32.max)
            let k = linkKey(peer, n)
            if links[k] == nil && !endedKeys.contains(k) { return n }
        }
    }

    /// nil when the session table is full. The entry is in the table before anything is awaited, so a
    /// message that arrives while the link is built reaches its pipe.
    private func makeLink(
        peer: Data, session: UInt32, role: PeerChannel.Role, ident: PeerSource, first: Data? = nil
    ) async throws -> RelayLinkEntry? {
        if links.count >= o.maxSessions { return nil }
        try assertRelayMode(.a)
        let key = linkKey(peer, session)
        let pipe = RelayPipe()
        let docs = docs
        let h = ConnectSessionHandlers(
            role: role == .initiator ? "initiator" : "responder", path: "relay", onRing: { docs.onRing($0, $1) },
            onTrust: { docs.onTrust($0) }, onRingWanted: { docs.onRingWanted() },
            onEnded: { [weak self] in
                guard let self else { return }
                Task { await self.linkEnded(key) }
            })
        let entry = RelayLinkEntry(peer: peer, session: session, key: key, pipe: pipe, handlers: h)
        links[key] = entry
        if let first { pipe.push(first) }
        pipe.attach(svc: self, peer: peer, session: session)
        let epoch = ident.ringEpoch
        let ring: @Sendable () -> (jws: String, epoch: Int)? = {
            if let p = docs.pushed, p.epoch > epoch { return p }
            return nil
        }
        let opts = PeerChannelOptions.connectBase(
            ident, role: role, caps: o.caps, label: o.label, ring: ring, now: src.now, rekeyMessages: o.rekeyMessages,
            rekeySeconds: o.rekeySeconds)
        do {
            let link = try await PeerLink.make(
                pipe: pipe, options: opts, handlers: h.handlers, handshakeSeconds: o.handshakeSeconds)
            entry.link = link
            h.attach(RelayLinkFacade(link: link, svc: self))
            pipe.onOverflow = { link.closeSoon(.peerBusy) }
            Task { await link.run() }
            if role == .initiator { await link.start() }
        } catch {
            links[key] = nil
            throw error
        }
        return entry
    }

    func linkEnded(_ key: String) {
        links[key]?.ended = true
        links[key] = nil
        endedKeys.append(key)
        if endedKeys.count > 256 { endedKeys.removeFirst() }
    }

    func gone(_ device: Data) {
        for e in links.values where e.peer == device { e.pipe.lose() }
    }

    func loseLinks() {
        for e in links.values { e.pipe.lose() }
    }

    // MARK: Identity and documents

    func identity(force: Bool) async throws -> PeerSource {
        let now = src.now()
        if !force, let h = held, h.gen == src.changes.value, now - h.at < identityTtlSeconds,
            h.src.certExpiresAt - now > certMarginSeconds
        {
            return h.src
        }
        let gen = src.changes.value
        let v = try await src.load()
        held = (now, gen, v)
        return v
    }

    private func wantRing() { docs.onRingWanted() }

    // MARK: Bookkeeping

    private func set(_ s: ConnectRelayState) {
        state = s
        stateSubs.fire(status)
    }

    private func emitMembers() { memberSubs.fire(members()) }

    private func flush(_ e: ConnectRelayError) {
        let w = waiters
        waiters = [:]
        for c in w.values { c.resume(throwing: e) }
    }
}

// MARK: - Sessions over the room

final class RelayLinkEntry: @unchecked Sendable {
    let peer: Data
    let session: UInt32
    let key: String
    let pipe: RelayPipe
    let handlers: ConnectSessionHandlers
    var link: PeerLink?
    var ended = false

    init(peer: Data, session: UInt32, key: String, pipe: RelayPipe, handlers: ConnectSessionHandlers) {
        self.peer = peer
        self.session = session
        self.key = key
        self.pipe = pipe
        self.handlers = handlers
    }
}

/// A session's byte pipe inside the room: `PeerLink` writes length-framed Noise messages, which go out one
/// per SEND envelope without the frame; RECV payloads come back framed. The room has no flow control, so a
/// peer that sends faster than the host reads ends with `peer_busy` at the queue cap.
final class RelayPipe: PeerBytePipe, @unchecked Sendable {
    private struct State {
        var q: [Data] = []
        var bytes = 0
        var waiter: CheckedContinuation<Data?, Never>?
        var closed = false
        var svc: ConnectRelayService?
        var peer = Data()
        var session: UInt32 = 0
    }
    private let state = LockedValue(State())
    private let budget: ConnectQueueBudget
    init(budget: ConnectQueueBudget = .shared) { self.budget = budget }
    var onOverflow: (@Sendable () -> Void)?
    var remoteAddress: String { "relay" }

    func attach(svc: ConnectRelayService, peer: Data, session: UInt32) {
        state.with {
            $0.svc = svc
            $0.peer = peer
            $0.session = session
        }
    }

    /// A RECV payload (an unframed Noise message).
    func push(_ noise: Data) {
        guard let framed = try? PeerFrame.encode(noise) else { return }
        enum R {
            case none
            case hand(CheckedContinuation<Data?, Never>)
            case overflow
        }
        let r: R = state.with { s in
            if s.closed { return .none }
            if let w = s.waiter {
                s.waiter = nil
                return .hand(w)
            }
            if s.bytes + framed.count > connectQueueMaxBytes { return .overflow }
            // The total over all sessions holds too (G10): bytes the room sent that the host has not read.
            if !budget.reserve(framed.count) { return .overflow }
            s.q.append(framed)
            s.bytes += framed.count
            return .none
        }
        switch r {
        case .none: break
        case .hand(let w): w.resume(returning: framed)
        case .overflow: onOverflow?()
        }
    }

    /// The socket is gone or the room dropped the peer: the link sees the end of the stream.
    func lose() {
        let w = state.with { s -> CheckedContinuation<Data?, Never>? in
            s.closed = true
            budget.release(s.bytes)
            s.q = []
            s.bytes = 0
            defer { s.waiter = nil }
            return s.waiter
        }
        w?.resume(returning: nil)
    }

    func read() async throws -> Data? {
        await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            let ready: Data?? = state.with { s in
                if !s.q.isEmpty {
                    let d = s.q.removeFirst()
                    s.bytes -= d.count
                    budget.release(d.count)
                    return .some(d)
                }
                if s.closed { return .some(nil) }
                s.waiter = c
                return nil
            }
            if let ready { c.resume(returning: ready) }
        }
    }

    func write(_ bytes: Data) async throws {
        let (svc, peer, session) = state.with { ($0.svc, $0.peer, $0.session) }
        guard let svc, bytes.count > 2 else { return }
        await svc.sendSession(peer: peer, session: session, noise: bytes.dropFirst(2))
    }

    func close() async { lose() }
}

/// What a `ConnectSession` needs of its link, with the relay's queue check before anything is encrypted.
struct RelayLinkFacade: ConnectSessionLink {
    let link: PeerLink
    let svc: ConnectRelayService

    func sendRecord(type: Int, body: Data) async throws {
        // Refuse before the engine encrypts: a message dropped after encryption would break the stream.
        guard await svc.hasRoom(body.count + 128 * (body.count / 60000 + 1)) else {
            throw ConnectRelayError(.rateLimited, "The relay queue is full; slow down.")
        }
        try await link.sendRecord(type: type, body: body)
    }

    func close(_ code: PeerCloseCode) async { await link.close(code) }
    func closeSoon(_ code: PeerCloseCode) { link.closeSoon(code) }
    func pause(_ on: Bool) { link.pause(on) }
}
