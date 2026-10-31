// The contact relay (CC-19.7; WIRE-CONTRACT-V5 §15.7 "Contact rooms", §15.10): a room joins the two devices of
// one link, who may belong to two accounts. Each contact has its own room, named by the `rid` both sides
// derive from the contact secret, and each session inside it is a `PeerChannel` in mode `c`. Mirrors
// sdk-node's `connect/contactRelay.ts`.
//
// Rules this file keeps:
//  - a contact ticket is asked for with the body `{"room":"c","rid":…}`; the answer must echo `room: "c"`,
//    else the Worker predates contact rooms and nothing is connected (`ConnectClient.relayTicket(room:rid:)`);
//  - the room speaks aliases, never device ids: `from`, `to` and `MEMBERS` carry SHA-256(rid || deviceId)[0..24].
//    This device computes its own and learns the peer's as the member that is not it; nothing here sees the
//    peer's device id, subject or certificate;
//  - the relay carries mode `c` here and nothing else; the Noise pin (the contact's agreeKey) names the peer;
//  - a room is kept for each contact marked reachable (at most 8); any other contact gets a short-lived room
//    for one dial, stopped when its last session ends. The Worker allows 30 contact tickets an hour per
//    device, so a reconnect backs off to minutes;
//  - an envelope that fails its layout closes the socket with 1002; a SEND to an offline peer is dropped by the
//    room silently, so a dial is made only to a peer `MEMBERS` lists;
//  - the contact secret lives in the room for its life and is released when the room stops. `Data` cannot be
//    zeroed in place; CryptoKit copies what it is given.

import Foundation
import PolarisKeyCore

/// What the contact relay needs: the LAN source (identity, contacts) plus a contact ticket.
public struct ConnectContactRelaySource: Sendable {
    public var lan: ConnectLanSource
    /// `POST relay/ticket` with `{room: "c", rid}`.
    public var ticket: @Sendable (_ rid: String) async -> ConnectRelayTicketResult

    public init(lan: ConnectLanSource, ticket: @escaping @Sendable (String) async -> ConnectRelayTicketResult) {
        self.lan = lan
        self.ticket = ticket
    }
}

private let contactBackoffBase: TimeInterval = 5
private let contactBackoffMax: TimeInterval = 600
private let contactMaxRoomSessions = 4

actor ConnectContactRoom: RelayRoom, CustomStringConvertible, CustomReflectable {
    private let src: ConnectContactRelaySource
    private let contact: ConnectLiveContact
    let rid: String
    let transient: Bool
    private let o: ConnectRelayOptions
    private let sleepFn: @Sendable (TimeInterval) async throws -> Void
    private let rand: @Sendable () -> Double
    private let clock: @Sendable () -> TimeInterval
    private let openSocket: ConnectRelayOpener
    private let limiter = HandshakeLimiter()
    private let onSession: @Sendable (ConnectSession) -> Void
    private let onIdle: @Sendable (String) -> Void

    private var state: ConnectRelayState = .idle
    private var error: ConnectRelayError?
    private var attempts = 0
    private var stopped = false
    private var started = false
    private var ws: (any ConnectRelaySocket)?
    private let liveSocket = LockedValue<(any ConnectRelaySocket)?>(nil)
    private var isOpen = false
    private var outbox: ConnectOutbox?
    private var pacer: ConnectPacer?
    private var ownAlias: Data?
    private var peerAlias: Data?
    private var links: [String: RelayLinkEntry] = [:]
    private var endedKeys: [String] = []
    private var runTask: Task<Void, Never>?
    private var sleeping: Task<Void, Error>?
    private var waiters: [Int: CheckedContinuation<Void, Error>] = [:]
    private var nextWaiter = 0
    private var lastLimit: Int?
    private var notMember = 0
    private var memberWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var nextMemberWaiter = 0

    init(
        source: ConnectContactRelaySource, contact: ConnectLiveContact, options: ConnectRelayOptions, transient: Bool,
        onSession: @escaping @Sendable (ConnectSession) -> Void, onIdle: @escaping @Sendable (String) -> Void
    ) {
        src = source
        self.contact = contact
        rid = PeerContacts.rid(secret: contact.secret)
        self.transient = transient
        o = options
        self.onSession = onSession
        self.onIdle = onIdle
        openSocket = options.opener ?? urlSessionRelayOpener(openSeconds: options.openSeconds)
        sleepFn = options.sleep ?? { s in try await Task.sleep(nanoseconds: UInt64(max(0, s) * 1_000_000_000)) }
        rand = options.random ?? { Double.random(in: 0..<1) }
        clock = options.clock ?? { ProcessInfo.processInfo.systemUptime }
    }

    nonisolated var description: String { "ConnectContactRoom()" }
    nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    var contactId: String { contact.id }
    var isPending: Bool { contact.pending }
    var status: ConnectRelayStatus { ConnectRelayStatus(state: state, error: error, attempts: attempts) }
    var peerOnline: Bool { peerAlias != nil }
    var hasSessions: Bool { !links.isEmpty }

    func start() {
        if started || stopped { return }
        started = true
        runTask = Task { await self.run() }
    }

    /// Resolves once the socket is open; throws the typed error when the loop is blocked.
    func ready(timeout: TimeInterval? = nil) async throws {
        if isOpen { return }
        if state == .blocked || state == .stopped || state == .off { throw error ?? Self.stoppedError }
        if !started { start() }
        nextWaiter += 1
        let id = nextWaiter
        let limit = timeout ?? o.openSeconds
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
            self.expire(id)
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in waiters[id] = c }
    }

    private func expire(_ id: Int) {
        guard let c = waiters.removeValue(forKey: id) else { return }
        c.resume(throwing: error ?? ConnectRelayError(.notConnected, "The relay is not connected."))
    }

    /// Ask the room who is in it; returns on the answer or after `timeout`.
    func refreshMembers(timeout: TimeInterval = 2) async {
        guard isOpen else { return }
        nextMemberWaiter += 1
        let id = nextMemberWaiter
        let t = Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            self.wakeMembers(id)
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            memberWaiters[id] = c
            sendEnv(.list)
        }
        t.cancel()
    }

    private func wakeMembers(_ id: Int) { memberWaiters.removeValue(forKey: id)?.resume() }

    /// Open a session to the contact in this room: the peer must be listed (a SEND to an absent one is dropped).
    func dial() async throws -> ConnectSession {
        try await ready()
        if peerAlias == nil { await refreshMembers() }
        guard let peer = peerAlias else { throw ConnectRelayError(.unknownPeer, "That contact is not online.") }
        let ident: PeerSource
        do { ident = try await src.lan.load() } catch {
            throw ConnectRelayError(.unknownPeer, "No Cloud Connect identity is held.")
        }
        guard let entry = try await makeLink(peer: peer, session: newSessionId(peer), role: .initiator, ident: ident)
        else { throw ConnectRelayError(.busy, "Too many relay sessions are open.") }
        do {
            return try await entry.handlers.opened(entry.link!)
        } catch let e as ConnectRelayError {
            throw e
        } catch {
            throw ConnectRelayError(.handshakeFailed, "The handshake failed.")
        }
    }

    func stop() async {
        if stopped { return }
        stopped = true
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
        for w in memberWaiters.values { w.resume() }
        memberWaiters = [:]
    }

    /// Force-stop: cancel the socket now, with no graceful close and no await on the actor.
    nonisolated func abort() {
        if let s = liveSocket.with({ v -> (any ConnectRelaySocket)? in
            defer { v = nil }
            return v
        }) {
            Task { await s.close(code: 1001) }
        }
        Task { await self.abortInActor() }
    }

    private func abortInActor() {
        stopped = true
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
            let granted = await src.ticket(rid)
            if stopped { return }
            switch granted {
            case .granted(let g):
                code = await session(g)
            case .relay(let e):
                error = e
                if [.disabled, .linksDisabled, .contactUnsupported, .quota].contains(e.reason) { return block(e) }
                waitS = TimeInterval(e.retryAfterSeconds ?? 0)
            case .unsupported:
                return block(ConnectRelayError(.disabled, "The product does not run Cloud Connect."))
            case .refused(let r):
                error = ConnectRelayError(.unavailable, "The relay could not be reached.")
                // Rate limited (30 contact tickets an hour per device): wait a minute at least.
                if r.code == ErrorCode.rateLimited { waitS = 60 }
            case .error:
                error = ConnectRelayError(.unavailable, "The relay could not be reached.")
            }
            if stopped { return }
            if let end = afterClose(code) { return block(end) }
            attempts += 1
            set(.backoff)
            await nap(max(backoff(), min(waitS, TimeInterval(connectRelayMaxRetryAfterSeconds))))
        }
    }

    private func nap(_ seconds: TimeInterval) async {
        let f = sleepFn
        let t = Task { try await f(seconds) }
        sleeping = t
        _ = await t.result
        sleeping = nil
    }

    private func afterClose(_ code: Int?) -> ConnectRelayError? {
        let limit = lastLimit
        lastLimit = nil
        guard let code else { return nil }
        if code == 4009 {
            return ConnectRelayError(.replaced, "Another socket took this room.", closeCode: code)
        }
        if code == 4003 {
            // The room is full, or links were switched off: a few tries, then stop.
            notMember += 1
            if notMember >= 3 {
                return ConnectRelayError(.notMember, "The room does not admit this device.", closeCode: code)
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
        let cap = min(contactBackoffMax, contactBackoffBase * pow(2, Double(min(max(attempts - 1, 0), 16))))
        return max(o.backoffMin, cap / 2 + rand() * cap / 2)
    }

    // MARK: One socket

    private func session(_ grant: RelayGrant) async -> Int? {
        let ident: PeerSource
        do { ident = try await src.lan.load() } catch {
            self.error = ConnectRelayError(.unavailable, "No Cloud Connect identity is held.")
            return nil
        }
        guard let own = try? PeerContacts.alias(rid: rid, deviceId: ident.deviceId) else { return nil }
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
        ownAlias = own
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
        let pinger = Task { await self.ping() }
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
        if isOpen && clock() - openedAt >= o.stableSeconds { attempts = 0 }
        isOpen = false
        ws = nil
        liveSocket.set(nil)
        outbox = nil
        pacer = nil
        peerAlias = nil
        ownAlias = nil
        deferred = []
        loseLinks()
        for m in memberWaiters.values { m.resume() }
        memberWaiters = [:]
        return code
    }

    private func ping() async {
        while !stopped && !Task.isCancelled && isOpen {
            do { try await sleepFn(o.pingSeconds) } catch { return }
            if !isOpen { return }
            sendEnv(.ping(Data((0..<8).map { _ in UInt8.random(in: 0...255) })))
            sendEnv(.list)
        }
    }

    private func sendEnv(_ m: PeerRelayMessage) {
        guard isOpen, let q = outbox, let d = try? PeerRelayEnvelope.encode(m) else { return }
        q.put(d, force: true)
    }

    /// False when the envelope is refused (the caller closes 1002).
    private func handle(_ data: Data) async -> Bool {
        guard let m = PeerRelayEnvelope.decode(.toClient, data) else { return false }
        switch m {
        case .recv(let from, let session, let noise):
            await received(from: from, session: session, noise: noise)
        case .members(let aliases):
            // The member that is not this device is the peer.
            let before = peerAlias
            peerAlias = aliases.first { $0 != ownAlias }
            if before != nil && peerAlias != before { loseLinks() }
            let ws = memberWaiters
            memberWaiters = [:]
            for c in ws.values { c.resume() }
            let held = deferred
            deferred = []
            for d in held { await received(from: d.from, session: d.session, noise: d.noise, canDefer: false) }
        case .gone(let d):
            if d == peerAlias {
                peerAlias = nil
                loseLinks()
            }
        case .limit(let reason):
            lastLimit = Int(reason)
            if reason == 1 { pacer?.halve() }
            let why: ConnectRelayReason = reason == 1 ? .rateLimited : reason == 4 ? .paused : .quota
            error = ConnectRelayError(
                why, why == .paused ? "The relay is paused." : "The relay is limiting this device.",
                scope: reason == 3 ? "product" : reason == 2 ? "person" : nil)
        case .ring, .pong, .send, .list, .ping:
            break  // a contact room never sends RING
        }
        return true
    }

    // MARK: Sessions

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

    /// First messages that arrived before the room named the peer; judged when `MEMBERS` comes.
    private var deferred: [(from: Data, session: UInt32, noise: Data)] = []

    func received(from: Data, session: UInt32, noise: Data, canDefer: Bool = true) async {
        let key = linkKey(from, session)
        if let known = links[key] {
            known.pipe.push(noise)
            return
        }
        if endedKeys.contains(key) { return }
        // A first message of a session: only the room's other member may open one.
        guard !stopped, isOpen, links.count < contactMaxRoomSessions else { return }
        // The room may not have told this device yet that the peer joined: ask, hold the message (bounded) and
        // judge it when `MEMBERS` comes. Never wait here: the answer arrives on the loop that calls this.
        if peerAlias == nil {
            if canDefer && deferred.count < 8 {
                deferred.append((from, session, noise))
                sendEnv(.list)
            }
            return
        }
        guard from == peerAlias else { return }
        guard let ident = try? await src.lan.load(), !stopped, isOpen else { return }
        if let known = links[key] {
            known.pipe.push(noise)
            return
        }
        guard let e = try? await makeLink(peer: from, session: session, role: .responder, ident: ident, first: noise)
        else { return }
        _ = e  // the session reaches the host through `onEstablished`
    }

    private func makeLink(
        peer: Data, session: UInt32, role: PeerChannel.Role, ident: PeerSource, first: Data? = nil
    ) async throws -> RelayLinkEntry? {
        if links.count >= o.maxSessions || links.count >= contactMaxRoomSessions { return nil }
        let key = linkKey(peer, session)
        let pipe = RelayPipe()
        let ref = contact.ref
        let notify = onSession
        let promote = src.lan.contactEstablished
        let h = ConnectSessionHandlers(
            role: role == .initiator ? "initiator" : "responder", path: "relay", contacts: [ref],
            onEstablished: { s in
                // The first handshake under a pending contact passed the pin: it replaces the held one.
                if ref.pending { Task { await promote?(ref) } }
                if role == .responder { notify(s) }
            },
            onEnded: { [weak self] in
                guard let self else { return }
                Task { await self.linkEnded(key) }
            })
        let entry = RelayLinkEntry(peer: peer, session: session, key: key, pipe: pipe, handlers: h)
        links[key] = entry
        if let first { pipe.push(first) }
        pipe.attach(svc: self, peer: peer, session: session)
        let opts = PeerChannelOptions.connectContact(
            ident, role: role, contacts: [PeerContactLink(secret: contact.secret, agreeKey: contact.agreeKey)],
            admission: role == .responder ? limiter : nil, caps: o.caps, label: o.label, now: src.lan.now,
            rekeyMessages: o.rekeyMessages, rekeySeconds: o.rekeySeconds)
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
        if links.isEmpty && transient { onIdle(contact.id + "|" + String(contact.pending)) }
    }

    private func loseLinks() { for e in links.values { e.pipe.lose() } }

    func sendSession(peer: Data, session: UInt32, noise: Data) {
        guard isOpen, let q = outbox,
            let d = try? PeerRelayEnvelope.encode(.send(to: peer, session: session, noise: noise))
        else { return }
        if !q.roomFor(noise.count + 128) {
            // A full queue ends this session `peer_busy`.
            for e in links.values where e.peer == peer && e.session == session {
                e.link?.closeSoon(.peerBusy)
                e.pipe.lose()
            }
            return
        }
        q.put(d, force: true)
    }

    func hasRoom(_ n: Int) -> Bool { outbox?.roomFor(n + reserved) ?? false }

    /// Send-queue room held for records that are encrypted but not yet in the queue.
    private var reserved = 0

    func reserve(_ n: Int) -> Bool {
        guard hasRoom(n) else { return false }
        reserved += n
        return true
    }

    func release(_ n: Int) { reserved = max(0, reserved - n) }

    // MARK: Bookkeeping

    private func set(_ s: ConnectRelayState) { state = s }

    private func flush(_ e: ConnectRelayError) {
        let w = waiters
        waiters = [:]
        for c in w.values { c.resume(throwing: e) }
    }
}

/// The contact rooms of one device: a room for each contact marked reachable (at most 8) and a short-lived
/// room for a single dial of any other (§15.7). It follows the contact list and the gate.
public actor ConnectContactRelay: CustomStringConvertible, CustomReflectable {
    private let src: ConnectContactRelaySource
    private let o: ConnectRelayOptions
    private var rooms: [String: ConnectContactRoom] = [:]
    private let sessionSubs = ContactRelaySubs()
    private var stopped = false
    private var unContacts: (@Sendable () -> Void)?
    private var running = false

    public init(source: ConnectContactRelaySource, options: ConnectRelayOptions = ConnectRelayOptions()) {
        src = source
        o = options
    }

    public nonisolated var description: String { "ConnectContactRelay()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    /// Called for each inbound session a contact opened to this device through a room.
    @discardableResult
    public nonisolated func onSession(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
        sessionSubs.add(fn)
    }

    /// Keep a room for each reachable contact now, and follow the list from here on.
    public func start() async {
        if stopped || running { return }
        running = true
        unContacts = src.lan.onContacts?({ [weak self] in
            guard let self else { return }
            Task { await self.refresh() }
        })
        await refresh()
    }

    /// Read the contacts again: rooms for new reachable contacts, none for removed or unmarked ones.
    public func refresh() async {
        if stopped { return }
        let contacts = (await src.lan.contacts?()) ?? []
        if stopped { return }
        let want = contacts.filter(\.reachable).prefix(maxLiveContactAdverts)
        var keep = Set<String>()
        for c in want {
            let k = "\(c.id)|\(c.pending)"
            keep.insert(k)
            if rooms[k] == nil { await open(c, transient: false) }
        }
        for (k, r) in rooms where !keep.contains(k) && !r.transient {
            rooms[k] = nil
            await r.stop()
        }
        // A contact that is gone takes its transient room too.
        let have = Set(contacts.map { "\($0.id)|\($0.pending)" })
        for (k, r) in rooms where !have.contains(k) {
            rooms[k] = nil
            await r.stop()
        }
    }

    @discardableResult
    private func open(_ c: ConnectLiveContact, transient: Bool) async -> ConnectContactRoom {
        let subs = sessionSubs
        let room = ConnectContactRoom(
            source: src, contact: c, options: o, transient: transient, onSession: { subs.fire($0) },
            onIdle: { [weak self] k in
                guard let self else { return }
                Task { await self.idle(k) }
            })
        rooms["\(c.id)|\(c.pending)"] = room
        await room.start()
        return room
    }

    private func idle(_ key: String) async {
        guard let r = rooms[key], r.transient else { return }
        rooms[key] = nil
        await r.stop()
    }

    /// The room statuses, by link id (for the host's status line).
    public func status() async -> [String: ConnectRelayStatus] {
        var out: [String: ConnectRelayStatus] = [:]
        for r in rooms.values { out[await r.contactId] = await r.status }
        return out
    }

    /// Open a session to a contact through its room (a short-lived one when it is not kept). Throws
    /// `ConnectRelayError`: `unknownPeer`, `busy`, `handshakeFailed`, `linksDisabled`, `contactUnsupported`, or
    /// the reason the relay is not connected.
    public func dial(_ id: String, pending: Bool = false) async throws -> ConnectSession {
        if stopped { throw ConnectContactRoom.stoppedError }
        let k = "\(id)|\(pending)"
        var room = rooms[k]
        if room == nil {
            let contacts = (await src.lan.contacts?()) ?? []
            guard let c = contacts.first(where: { $0.id == id && $0.pending == pending }) else {
                throw ConnectRelayError(.unknownPeer, "That is not a link on this device.")
            }
            room = await open(c, transient: true)
        }
        return try await room!.dial()
    }

    public func stop() async {
        if stopped { return }
        stopped = true
        unContacts?()
        unContacts = nil
        let rs = Array(rooms.values)
        rooms = [:]
        for r in rs { await r.stop() }
    }

    public nonisolated func abort() {
        Task { await self.abortInActor() }
    }

    private func abortInActor() {
        stopped = true
        unContacts?()
        unContacts = nil
        let rs = Array(rooms.values)
        rooms = [:]
        for r in rs { r.abort() }
    }
}

private final class ContactRelaySubs: Sendable {
    private struct S {
        var next = 0
        var fns: [(Int, @Sendable (ConnectSession) -> Void)] = []
    }
    private let state = LockedValue(S())
    func add(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.next += 1
            s.fns.append((s.next, fn))
            return s.next
        }
        return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
    }
    func fire(_ v: ConnectSession) { for f in state.with({ $0.fns.map(\.1) }) { f(v) } }
}
