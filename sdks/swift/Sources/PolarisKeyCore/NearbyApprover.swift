// The approver half of nearby approval (CC-15.S2; WIRE-CONTRACT-V5 §15.4, §15.6.1). Mirrors sdk-node's
// `connect/nearbyApprover.ts` with its red-team fixes (CC-15.N6). A signed-in device (M) advertises under
// a random instance, lets a nearby device (D) with no sign-in connect in mode v, shows three codes and,
// when the person picks the one D shows, hands the verified `VOUCH_REQ` to the host. The host calls
// `nearby/approve` and gives the answer back; this engine maps it to `VOUCH_RESULT`. It calls no route.
//
// Rules this engine keeps:
//  - the advert is `p1-` + 10 random bytes in base32 with `v=1`, `m=v` and the product tag; it has a
//    listener of its own, and the instance and the port are both new at every listen and every 300 s (the
//    old listener closes at once; a session past the transport stays);
//  - it stands only while the device is signed in, discovery names `nearby` and `nearbyApprove`, and the
//    host opened the prompt or allowed background approval (`background: true`, required with
//    `prompt: false`); it stops on `pause()`, on `stop()`, when the device signs out, when discovery loses
//    `nearby`, when a renewal fails and when the failure budget is spent (two prompted failures in 10
//    minutes). `stop()`, a sign-out, a lost discovery and a failed renewal are final: no later call brings
//    the advert back. A budget stop is cleared by `reopen()` or `setPrompt(true)` only; `pause()` works
//    from `advertising` only, and `resume()` only from the host's own pause, after signedIn and discovery
//    are read again (B1);
//  - `stop()` and the sign-out do not wait for a renewal or a queued call: the state, the listener, the
//    advert and the sessions go down at once, and `destroy()` drops the sockets (B2b);
//  - a failed renewal halts the advert and says so through `onStopped` (B3);
//  - accept is the network's gate (the mode-a address rule and the pending limits); here one waiting
//    session per source address and two per group;
//  - one prompt at a time, held until the picked session finishes or closes. A session that reaches the
//    code stage meanwhile waits with no code shown and its 120 s deadline running. With the prompt closed a
//    session only raises a notice. A prompt that was shown and whose peer then closes before the person
//    answered counts as a failure (N4);
//  - the host's callbacks run on the engine's task, after the state they report is settled: they must
//    return at once (the umbrella hands them to its own queue);
//  - a wrong pick, "None of these match", the host's close and the deadline end the session before
//    `VOUCH_REQ` is delivered, and no route is called;
//  - `finish()` is refused unless the person picked the right code on this session and `VOUCH_REQ`
//    verified (no silent approval, N12); records for Sync go out only after `approved`;
//  - the request handle, `sig`, `h`, the nonces and the one-time keys are in no message, repr or error; the
//    one-time static key is wiped when the handshake ends.

import Foundation

public enum NearbyStopReason: String, Sendable, Equatable {
    case budget
    case signedOut = "signed-out"
    case discovery
    case host
}

public struct NearbyApproverStatus: Sendable, Equatable {
    public enum State: String, Sendable, Equatable { case advertising, paused, stopped }

    public let state: State
    /// Why it stopped, when it did.
    public let reason: NearbyStopReason?
    public let prompt: Bool
}

/// A session that wants approval while the prompt is closed: no code, no pick.
public struct ApprovalNotice: Sendable, Equatable {
    public let label: String?
    public let platform: String
}

/// What the approver reads of the client, at start and at each renewal.
public struct NearbyApproverSource: Sendable {
    public var slug: String
    /// Seconds since the epoch.
    public var now: @Sendable () -> Int
    /// This device is signed in on the product.
    public var signedIn: @Sendable () async -> Bool
    /// A fresh read of discovery: it names `nearby` and `nearbyApprove` (§12.11.6).
    public var nearbyServed: @Sendable () async -> Bool

    public init(
        slug: String, now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
        signedIn: @escaping @Sendable () async -> Bool, nearbyServed: @escaping @Sendable () async -> Bool
    ) {
        self.slug = slug
        self.now = now
        self.signedIn = signedIn
        self.nearbyServed = nearbyServed
    }
}

public struct NearbyApproverOptions: Sendable {
    /// The "Approve a nearby device" screen is open. Without it a session raises `onNotice` only.
    public var prompt: Bool
    /// The person allowed background approval (and the system permission is granted). Required with
    /// `prompt: false`; with it the advert stands while the screen is closed and a session raises
    /// `onNotice`. Without it, closing the screen (`setPrompt(false)`) pauses the advert.
    public var background: Bool
    /// This device's label in `HELLO` (display data; optional). It is shown on the other device, so name
    /// the device ("Ana's laptop"); never use an account identifier (an email address, a user id).
    public var label: String?
    /// The `HELLO` platform.
    public var platform: String
    public var onNotice: (@Sendable (ApprovalNotice) -> Void)?
    /// Called when the advert stops on its own (everything but the host's own `pause`/`stop`).
    public var onStopped: (@Sendable (NearbyStopReason) -> Void)?
    /// Seconds between advert renewals (default 300).
    public var renewSeconds: TimeInterval
    /// Seconds a session stays open after the person's pick (default 300, rule 8).
    public var keepOpenSeconds: TimeInterval
    /// Seconds to wait for `VOUCH_REQ` after the right pick (default 30).
    public var requestWaitSeconds: TimeInterval
    /// Sessions at once (default 8).
    public var maxSessions: Int
    /// The handshake window of a link (default 30 s).
    public var handshakeSeconds: TimeInterval
    public var timer: NearbyTimer
    /// Monotonic seconds (limiter, failure budget).
    public var mono: @Sendable () -> TimeInterval
    /// CSPRNG bytes (instance, decoys, one-time keys).
    public var random: PeerRandom

    public init(
        prompt: Bool, background: Bool = false, label: String? = nil, platform: String = "swift",
        onNotice: (@Sendable (ApprovalNotice) -> Void)? = nil,
        onStopped: (@Sendable (NearbyStopReason) -> Void)? = nil, renewSeconds: TimeInterval = 300,
        keepOpenSeconds: TimeInterval = 300, requestWaitSeconds: TimeInterval = 30, maxSessions: Int = 8,
        handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds, timer: @escaping NearbyTimer = nearbySystemTimer,
        mono: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        random: @escaping PeerRandom = peerSystemRandom
    ) {
        self.prompt = prompt
        self.background = background
        self.label = label
        self.platform = platform
        self.onNotice = onNotice
        self.onStopped = onStopped
        self.renewSeconds = renewSeconds
        self.keepOpenSeconds = keepOpenSeconds
        self.requestWaitSeconds = requestWaitSeconds
        self.maxSessions = maxSessions
        self.handshakeSeconds = handshakeSeconds
        self.timer = timer
        self.mono = mono
        self.random = random
    }
}

/// How a session ended, as the host's `onClose` hears it.
public struct NearbyClosed: Sendable, Equatable {
    /// A `peer_*` close code, or `connection_lost`.
    public let code: String
    public let byPeer: Bool
}

public enum NearbyPick: Sendable, Equatable {
    /// The right code: D's verified request, exactly what `nearby/approve` gets.
    case request(VouchRequest)
    /// A wrong code: the session closed, nothing was delivered and no route is called.
    case mismatch
    /// The request did not verify, or the session ended: it closed `peer_bad_frame`.
    case invalid
}

public enum NearbyFinish: Sendable, Equatable {
    /// `VOUCH_RESULT` went out with this status. After `approved` the session stays open for records.
    case sent(VouchStatus)
    /// Nothing sent yet: show the licence choice, then call `finish` again.
    case waitChoice
    /// Nothing sent yet: register this device's keys (§15.8), then call `finish` again.
    case waitKeys
    /// Nothing sent; the session closed `peer_bye`.
    case closed
}

/// One session asking for approval, as the host's handler sees it.
public final class NearbyApproval: @unchecked Sendable, CustomStringConvertible, CustomReflectable {
    /// What D's `HELLO` showed. Unauthenticated display data: any device on the network can send any label,
    /// and the cleaning leaves some invisible blanks, so a label can look empty or like another device's.
    /// Show it as "reported by the device" beside the platform and the codes, never as proof of who is
    /// asking; the person's pick of the matching code is the only check.
    public let label: String?
    public let platform: String
    /// The three codes, in the order to show them, each like `123 456`.
    public let codes: [String]

    private let approver: NearbyApprover
    fileprivate let live: NearbyApprover.Live

    fileprivate init(approver: NearbyApprover, live: NearbyApprover.Live, codes: [String]) {
        self.approver = approver
        self.live = live
        self.label = live.hello?.label
        self.platform = live.hello?.platform ?? ""
        self.codes = codes
    }

    /// The person picked this code. The right one delivers D's `VOUCH_REQ`, which is verified here. A wrong
    /// code closes the session, calls no route and answers `.mismatch`; a request that does not verify
    /// closes it and answers `.invalid`.
    public func pick(_ code: String) async throws -> NearbyPick { try await approver.pick(live, code) }

    /// "None of these match": the session closes, nothing is delivered and no route is called.
    public func decline() async { await approver.decline(live) }

    /// Give the answer of `nearby/approve` back; sends `VOUCH_RESULT` (rule 6).
    public func finish(_ answer: VouchApproveAnswer) async throws -> NearbyFinish {
        try await approver.finish(live, answer)
    }

    /// After `approved`: a Sync record (`0x0030` to `0x003F`) to D.
    public func sendRecord(type: Int, body: Data) async throws { try await approver.send(live, type, body) }

    /// The host leaves: the session closes `peer_bye`. Before a pick this counts for nothing.
    public func close() async { await approver.end(live, .peerBye) }

    /// Called once when the session ends (at once if it already has). Returns the unsubscribe.
    @discardableResult
    public func onClose(_ fn: @escaping @Sendable (NearbyClosed) -> Void) -> @Sendable () -> Void {
        live.addCloser(fn)
    }

    public var description: String { "NearbyApproval()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A code the person picked: `123 456`, `123456`; nil when it is neither.
private func nearbyCodeValue(_ code: String) -> Int? {
    let digits = code.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }
    guard digits.count == 6, digits.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else { return nil }
    return Int(String(String.UnicodeScalarView(digits)))
}

public actor NearbyApprover: CustomStringConvertible, CustomReflectable {
    // MARK: Types

    /// One advert generation: a listener, its registration and its handshake limiter.
    final class Generation: @unchecked Sendable {
        let limiter: HandshakeLimiter
        var handle: (any NearbyAdvertHandle)?
        var retired = false
        init(limiter: HandshakeLimiter) { self.limiter = limiter }
    }

    enum LiveEvent: Sendable {
        case session(PeerSessionEvent)
        case closed(PeerLinkClosed)
    }

    /// One inbound session. Mutated only inside the approver, except the close list.
    final class Live: @unchecked Sendable {
        let link: PeerLink
        let pipe: any NearbyInboundPipe
        let key: PeerOneTimeKey
        let gen: Generation
        let flow: VouchFlow<VouchRecord>
        let events: AsyncStream<LiveEvent>.Continuation
        var hello: PeerHello?
        var sas: Int?
        var established = false
        var noticed = false
        var shown = false
        var picked = false
        var keysRetried = false
        var dead = false
        /// This engine ended the session (a pick, a close, the host, a pause): not the peer's doing.
        var local = false
        var pickTask: Task<NearbyPick, Error>?
        let request = NearbyDeferred<NearbyPick>()
        var cancels: [@Sendable () -> Void] = []
        private let closers = LockedValue<[(id: Int, fn: @Sendable (NearbyClosed) -> Void)]>([])
        private let closedBox = LockedValue<NearbyClosed?>(nil)
        private let nextId = LockedValue(0)

        init(
            link: PeerLink, pipe: any NearbyInboundPipe, key: PeerOneTimeKey, gen: Generation,
            flow: VouchFlow<VouchRecord>, events: AsyncStream<LiveEvent>.Continuation
        ) {
            self.link = link
            self.pipe = pipe
            self.key = key
            self.gen = gen
            self.flow = flow
            self.events = events
        }

        func addCloser(_ fn: @escaping @Sendable (NearbyClosed) -> Void) -> @Sendable () -> Void {
            let id = nextId.with {
                $0 += 1
                return $0
            }
            if let done = closedBox.current {
                fn(done)
                return {}
            }
            closers.with { $0.append((id, fn)) }
            return { [closers] in closers.with { $0.removeAll { $0.id == id } } }
        }

        func finishClosers(_ c: NearbyClosed) {
            closedBox.set(c)
            let fns = closers.with { cs -> [@Sendable (NearbyClosed) -> Void] in
                defer { cs = [] }
                return cs.map(\.fn)
            }
            for f in fns { f(c) }
        }
    }

    // MARK: State

    private let src: NearbyApproverSource
    private let handler: @Sendable (NearbyApproval) -> Void
    private let o: NearbyApproverOptions
    private let network: any NearbyApproverNetwork
    private let budget: VouchFailureBudget
    private var live: [ObjectIdentifier: Live] = [:]
    private var order: [ObjectIdentifier] = []
    private var queue: [Live] = []
    private var active: Live?
    private var gen: Generation?
    private var cancelRenew: (@Sendable () -> Void)?
    private var prompt: Bool
    private let background: Bool
    private var state = NearbyApproverStatus.State.stopped
    private var reason: NearbyStopReason?
    /// A stop that nothing undoes: `stop()`, a sign-out, lost discovery, a failed renewal.
    private let finalFlag = LockedValue(false)
    /// Bumped by every halt; an `advertise` or a check that began before it gives up.
    private var epoch = 0
    private let statusBox: LockedValue<NearbyApproverStatus>
    private let pipes = LockedValue<[ObjectIdentifier: any PeerBytePipe]>([:])
    // One serial call at a time (pause, resume, setPrompt, reopen, a renewal): a host read that suspends
    // must not let another of them start in between. `stop()` never waits here.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private init(
        _ src: NearbyApproverSource, _ handler: @escaping @Sendable (NearbyApproval) -> Void,
        _ o: NearbyApproverOptions, _ network: any NearbyApproverNetwork
    ) {
        self.src = src
        self.handler = handler
        self.o = o
        self.network = network
        self.prompt = o.prompt
        self.background = o.background
        self.budget = VouchFailureBudget(mono: o.mono)
        self.statusBox = LockedValue(NearbyApproverStatus(state: .stopped, reason: nil, prompt: o.prompt))
    }

    public nonisolated var description: String { "NearbyApprover()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    /// Start advertising. The caller has checked that the device is signed in and that discovery names
    /// `nearby`; both are read again at every renewal. Throws `NearbyError`.
    public static func start(
        source: NearbyApproverSource, handler: @escaping @Sendable (NearbyApproval) -> Void,
        options: NearbyApproverOptions, network: any NearbyApproverNetwork
    ) async throws -> NearbyApprover {
        // Without the prompt, background approval must be allowed explicitly.
        guard options.prompt || options.background else { throw NearbyError.badInput }
        let a = NearbyApprover(source, handler, options, network)
        try await a.advertise()
        return a
    }

    public nonisolated func status() -> NearbyApproverStatus { statusBox.current }

    private func publish() {
        statusBox.set(NearbyApproverStatus(state: state, reason: reason, prompt: prompt))
    }

    private var isFinal: Bool { finalFlag.current }

    // MARK: The handle

    /// Final, and not queued: the state, the listener, the advert and the sessions go down at once, so a
    /// renewal that hangs on the host's reads cannot hold a sign-out back.
    public func stop() async {
        finalFlag.set(true)
        await halt(.stopped, .host)
    }

    /// Drop everything now, with no goodbye (the sign-out bound's force path). Safe from any context.
    public nonisolated func destroy() {
        finalFlag.set(true)
        for p in pipes.current.values { Task { await p.close() } }
        Task { await self.stop() }
    }

    /// Stop advertising and close live sessions until `resume()`. Works from `advertising` only.
    public func pause() async {
        await acquire()
        defer { releaseGate() }
        if isFinal || state != .advertising { return }
        await halt(.paused, .host)
    }

    /// Start again after the host's own `pause()`. It reads sign-in and discovery again first, and does
    /// nothing after a stop, a sign-out or a spent budget.
    public func resume() async throws {
        await acquire()
        defer { releaseGate() }
        if isFinal || state != .paused || reason != .host { return }
        try await restart()
    }

    /// The "Approve a nearby device" screen opens (true) or closes (false). Opening it also counts the failure
    /// budget from zero and starts a stopped (budget) or paused advert again; closing it ends the prompt that
    /// is showing and, without `background`, pauses the advert.
    public func setPrompt(_ open: Bool) async throws {
        await acquire()
        defer { releaseGate() }
        if isFinal || open == prompt { return }
        prompt = open
        publish()
        if !open {
            // The screen closed: the prompt that is showing ends, and the others go passive.
            let current = active
            active = nil
            if let current, !current.picked { await end(current, .peerBye) }
            for l in queue { l.noticed = false }
            // Without background approval nothing stands for a closed screen.
            if !background && state == .advertising { await halt(.paused, .host) }
            pump()
            return
        }
        budget.reopen()
        if (state == .stopped && reason == .budget) || (state == .paused && reason == .host) {
            try await restart()
        }
        pump()
    }

    /// Count the failure budget from zero and start a budget-stopped advert again.
    public func reopen() async throws {
        await acquire()
        defer { releaseGate() }
        if isFinal { return }
        budget.reopen()
        if state == .stopped && reason == .budget { try await restart() }
    }

    // MARK: The serial gate

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

    /// A host read that may hang or fail: past 15 s, or on a throw, it reads as "no".
    private func check(_ read: @escaping @Sendable () async -> Bool) async -> Bool {
        await nearbyBounded(15, timer: o.timer, read)
    }

    /// Start the advert again from a pause or a budget stop, after reading sign-in and discovery again. A
    /// stop, or a halt that landed meanwhile, wins.
    private func restart() async throws {
        if budget.stopped {
            if state == .paused { await halt(.stopped, .budget) }
            return
        }
        let epoch = self.epoch
        let signedIn = src.signedIn
        let signed = await check { await signedIn() }
        if isFinal || epoch != self.epoch { return }
        if !signed { return await halt(.stopped, .signedOut) }
        let served = src.nearbyServed
        let ok = await check { await served() }
        if isFinal || epoch != self.epoch { return }
        if !ok { return await halt(.stopped, .discovery) }
        try await advertise()
    }

    // MARK: The advert

    /// A new listener, port and instance; the old generation retires. Starts the renewal clock.
    private func advertise() async throws {
        let epoch = self.epoch
        let g = Generation(limiter: HandshakeLimiter(maxPerMinute: 5, maxPending: 4, mono: o.mono))
        let instance = PeerVouch.approverInstance(random: o.random)
        let tag = try PeerAdvert.productTag(slug: src.slug, epoch: peerAdvertEpoch(src.now()))
        let handle = try await network.open(instance: instance, txt: ["v=1", "m=v", "h=\(tag)"]) {
            [weak self] pipe in
            guard let self else {
                Task { await pipe.close() }
                return
            }
            Task { await self.accept(g, pipe) }
        }
        g.handle = handle
        if epoch != self.epoch {
            // A stop landed while this was starting: what it made is torn down, not kept.
            g.retired = true
            await handle.stop()
            return
        }
        let old = gen
        gen = g
        state = .advertising
        reason = nil
        publish()
        if let old { await retire(old) }
        cancelRenew?()
        cancelRenew = o.timer(o.renewSeconds) { [weak self] in
            guard let self else { return }
            Task { await self.renew() }
        }
    }

    private func renew() async {
        await acquire()
        defer { releaseGate() }
        guard state == .advertising else { return }
        let epoch = self.epoch
        let signedIn = src.signedIn
        let signed = await check { await signedIn() }
        if epoch != self.epoch { return }
        if !signed { return await halt(.stopped, .signedOut) }
        let served = src.nearbyServed
        let ok = await check { await served() }
        if epoch != self.epoch { return }
        if !ok { return await halt(.stopped, .discovery) }
        do {
            try await advertise()
        } catch {
            // The advert cannot be renewed (the network interface went away, the port is gone): it must not
            // stand on, unrenewed and unchecked. It stops, and the host hears why.
            if epoch == self.epoch { await halt(.stopped, .discovery) }
        }
    }

    /// The old listener accepts nothing more; a connection short of the transport is closed.
    private func retire(_ g: Generation) async {
        g.retired = true
        let cut = live.values.filter { $0.gen === g && !$0.established }.map(\.pipe)
        for p in cut { Task { await p.close() } }
        await g.handle?.stop()
    }

    /// Take everything down. The state, the listener and the session closes are started before the first
    /// suspension, so a caller that does not wait still has them done.
    private func halt(_ newState: NearbyApproverStatus.State, _ why: NearbyStopReason) async {
        epoch += 1
        if newState == .stopped && why != .budget { finalFlag.set(true) }
        cancelRenew?()
        cancelRenew = nil
        let g = gen
        gen = nil
        state = newState
        reason = why
        publish()
        var work: [Task<Void, Never>] = []
        if let g {
            g.retired = true
            let handle = g.handle
            work.append(Task { await handle?.stop() })
            // A connection short of the transport is dropped; the sessions past it hear `peer_bye`.
            for l in live.values where l.gen === g && !l.established {
                let p = l.pipe
                work.append(Task { await p.close() })
            }
        }
        for l in live.values { if let t = startEnd(l, .peerBye) { work.append(t) } }
        queue = []
        active = nil
        for t in work { await t.value }
        // The host's own stop and pause need no word back.
        if why != .host { o.onStopped?(why) }
    }

    // MARK: Sessions

    private func accept(_ g: Generation, _ pipe: any NearbyInboundPipe) async {
        if g.retired || state != .advertising || isFinal || live.count >= o.maxSessions {
            await pipe.close()
            return
        }
        let key: PeerOneTimeKey
        do { key = try PeerOneTimeKey(random: o.random) } catch {
            await pipe.close()
            return
        }
        let (stream, cont) = AsyncStream<LiveEvent>.makeStream()
        let opts = PeerChannelOptions(
            role: .responder, slug: src.slug, staticKey: key, admission: g.limiter,
            hello: (o.label, o.platform, src.slug, nil), mode: .v, mono: o.mono)
        let handlers = PeerLinkHandlers(
            onClosed: { cont.yield(.closed($0)) }, onSession: { cont.yield(.session($0)) })
        let link: PeerLink
        do {
            link = try await PeerLink.make(
                pipe: pipe, options: opts, handlers: handlers, handshakeSeconds: o.handshakeSeconds)
        } catch {
            key.wipe()
            cont.finish()
            await pipe.close()
            return
        }
        // A stop or a renewal may have landed while the link was being made.
        guard !g.retired, state == .advertising, !isFinal, let flow = link.channel.vouch else {
            key.wipe()
            cont.finish()
            await link.close(.peerBye)
            await pipe.close()
            return
        }
        let l = Live(link: link, pipe: pipe, key: key, gen: g, flow: flow, events: cont)
        let id = ObjectIdentifier(l)
        live[id] = l
        pipes.with { $0[id] = pipe }
        Task { [weak self] in
            for await e in stream { await self?.event(l, e) }
        }
        Task { await link.run() }
    }

    private func event(_ l: Live, _ e: LiveEvent) async {
        switch e {
        case .closed(let c): closed(l, c)
        case .session(let s):
            switch s {
            case .established(let est):
                l.pipe.established()
                // The one-time static key has done its work.
                l.key.wipe()
                l.hello = est.hello
                l.established = true
            case .sas(let code, _):
                l.sas = code
                queue.append(l)
                pump()
            case .record(let type, let body):
                record(l, type, body)
            default:
                break
            }
        }
    }

    private func record(_ l: Live, _ type: Int, _ body: Data) {
        switch l.flow.receive(VouchRecord(type: type, body: body)) {
        case .close(let c):
            if let t = startEnd(l, c) { Task { await t.value } }
        case .ok(let out):
            for r in out {
                if r.type == PeerRecordType.vouchReq {
                    Task { await self.verify(l, r.body) }
                } else if r.type >= 0x8100 && r.type <= 0xfffd {
                    if let t = startEnd(l, .peerUnknownCritical) { Task { await t.value } }
                }
            }
        }
    }

    private func verify(_ l: Live, _ body: Data) async {
        var ok: VouchRequest?
        if let hello = l.hello, body.count <= vouchReqMax, let h = try? await l.link.channel.handshakeHash() {
            ok = PeerVouch.verifyRequest(
                slug: src.slug, h: h, hello: VouchHello(label: hello.label, platform: hello.platform),
                // `HELLO` was cleaned when the session read it; cleaning it again is not idempotent.
                helloCleaned: true, body: body)
        }
        guard let ok else {
            l.request.resolve(.invalid)
            await end(l, .peerBadFrame)
            return
        }
        l.flow.verified()
        l.request.resolve(.request(ok))
    }

    private func closed(_ l: Live, _ c: PeerLinkClosed) {
        if l.dead { return }
        l.dead = true
        l.key.wipe()
        l.pipe.settle()
        for f in l.cancels { f() }
        l.cancels = []
        let id = ObjectIdentifier(l)
        live[id] = nil
        pipes.with { $0[id] = nil }
        queue.removeAll { $0 === l }
        l.request.resolve(.invalid)
        l.events.finish()
        // A prompt that was shown and ended before the person answered, by anything but this engine (the
        // 120 s deadline, the peer closing or the connection dropping), counts (rule 2).
        if l.shown && !l.picked && !l.local { failure() }
        l.finishClosers(NearbyClosed(code: c.code, byPeer: c.byPeer))
        if active === l {
            active = nil
            pump()
        }
    }

    /// Start closing a session with `code`; nil when it is down already. The mark that this engine ended it
    /// is set before the first suspension.
    private func startEnd(_ l: Live, _ code: PeerCloseCode) -> Task<Void, Never>? {
        if l.dead { return nil }
        l.local = true
        let link = l.link
        return Task { await link.close(code) }
    }

    /// Close a session with `code`; returns when it is down.
    func end(_ l: Live, _ code: PeerCloseCode) async {
        if let t = startEnd(l, code) { await t.value }
    }

    /// Count one prompted failure; the second in the window stops the advert.
    private func failure() {
        guard budget.fail() else { return }
        Task { await self.haltForBudget() }
    }

    private func haltForBudget() async {
        await acquire()
        defer { releaseGate() }
        if state == .advertising { await halt(.stopped, .budget) }
    }

    // MARK: The prompt, one at a time

    private func pump() {
        if state != .advertising { return }
        if !prompt {
            for l in queue where !l.noticed {
                l.noticed = true
                o.onNotice?(ApprovalNotice(label: l.hello?.label, platform: l.hello?.platform ?? ""))
            }
            return
        }
        if active != nil { return }
        guard let next = queue.first(where: { !$0.shown && !$0.dead }), let sas = next.sas else { return }
        guard let decoys = try? PeerVouch.decoyCodes(real: sas, random: o.random) else {
            if let t = startEnd(next, .peerBye) { Task { await t.value } }
            return
        }
        active = next
        next.shown = true
        next.flow.codeShown()
        handler(NearbyApproval(approver: self, live: next, codes: decoys.codes.map(PeerSAS.display)))
    }

    /// The prompt is over (a pick, a decline): the next waiting session may show its codes.
    private func release(_ l: Live) {
        queue.removeAll { $0 === l }
        if active === l { active = nil }
        pump()
    }

    /// A session ended before the right pick: nothing is delivered and no route is called.
    private func abandon(_ l: Live, _ why: VouchAbandon) async {
        let v = l.flow.abandon(why)
        release(l)
        if l.dead { return }
        if case .close(let c) = v { await end(l, c) } else { await end(l, .peerBye) }
    }

    fileprivate func pick(_ l: Live, _ code: String) async throws -> NearbyPick {
        if let t = l.pickTask { return try await t.value }
        let t = Task { try await self.doPick(l, code) }
        l.pickTask = t
        return try await t.value
    }

    private func doPick(_ l: Live, _ code: String) async throws -> NearbyPick {
        if l.dead { throw NearbyError.closed }
        guard let sas = l.sas, !l.picked else { throw NearbyError.notPicked }
        if nearbyCodeValue(code) != sas {
            failure()
            await abandon(l, .wrongPick)
            return .mismatch
        }
        if case .close(let c) = l.flow.picked() {
            await end(l, c)
            return .invalid
        }
        l.picked = true
        l.pipe.settle()
        // The prompt slot stays with this session until it finishes or closes: the next waiting session
        // shows no code meanwhile. The session stays for records after `approved`, and no longer than 300 s
        // past the pick.
        l.cancels.append(
            o.timer(o.keepOpenSeconds) { [weak self] in
                guard let self else { return }
                Task { await self.end(l, .peerBye) }
            })
        // The person's pick is M's confirmation; the held `VOUCH_REQ` is delivered from here on.
        await l.link.channel.confirmSas()
        if l.dead { return .invalid }
        let wait = o.timer(o.requestWaitSeconds) { [weak self] in
            guard let self else { return }
            Task { await self.end(l, .peerTimeout) }
        }
        let result = await l.request.wait()
        wait()
        return result
    }

    fileprivate func decline(_ l: Live) async {
        if l.dead || l.picked { return }
        failure()
        await abandon(l, .noneMatch)
    }

    fileprivate func finish(_ l: Live, _ a: VouchApproveAnswer) async throws -> NearbyFinish {
        if l.dead { throw NearbyError.closed }
        // No silent approval: the right pick on this session and a verified request, or nothing.
        guard l.flow.mayFinish else { throw NearbyError.notPicked }
        let act = PeerVouch.finishMap(
            VouchApproveAnswer(
                http: a.http, body: a.body, discoveryNearby: a.discoveryNearby, keysRetried: l.keysRetried))
        switch act {
        case .send(let status):
            let rec = VouchRecord(type: PeerRecordType.vouchResult, body: PeerVouch.buildResult(status))
            if case .close(let c) = l.flow.send(rec) {
                await end(l, c)
                throw NearbyError.closed
            }
            do { try await l.link.sendRecord(type: rec.type, body: rec.body) } catch { throw NearbyError.closed }
            // Finished: the next waiting session may show its codes.
            release(l)
            if status != .approved { await end(l, .peerBye) }
            return .sent(status)
        case .waitKeys:
            l.keysRetried = true
            return .waitKeys
        case .waitChoice:
            return .waitChoice
        case .close(let stopAdvert):
            release(l)
            await end(l, .peerBye)
            if stopAdvert { Task { await self.haltForDiscovery() } }
            return .closed
        }
    }

    private func haltForDiscovery() async {
        await acquire()
        defer { releaseGate() }
        await halt(.stopped, .discovery)
    }

    fileprivate func send(_ l: Live, _ type: Int, _ body: Data) async throws {
        if l.dead { throw NearbyError.closed }
        guard type >= 0x0030 && type <= 0x003f else { throw NearbyError.badType }
        if case .close(let c) = l.flow.send(VouchRecord(type: type, body: body)) {
            await end(l, c)
            throw NearbyError.notPicked
        }
        do {
            try await l.link.sendRecord(type: type, body: body)
        } catch PeerChannelError.messageTooLarge {
            throw NearbyError.tooLarge
        } catch {
            throw NearbyError.closed
        }
    }
}
