// The requester half of nearby approval (CC-15.S3; WIRE-CONTRACT-V5 §15.6.1). Mirrors sdk-node's
// `connect/nearbyRequester.ts` with its fix round (CC-15.N6). A device with no sign-in (D) browses for
// approvers, dials a few, lists them by their `HELLO` and lets its person tap one. Only then does the code run
// on that session; the others close `peer_bye` before any code record, so no other approver ever prompts. D
// shows its code, sends `VOUCH_REQ` and reads `VOUCH_RESULT`. It calls no route: the host holds the request
// from `nearby/start` and polls.
//
// Rules this engine keeps:
//  - D connects out and never listens; it browses `_pkeypeer._tcp` for `m=v` with the product tag of the
//    current or the previous epoch, and dials only addresses the network judged by the mode-a rule;
//  - at most 4 approvers are dialled at once, picked at random and never in arrival order, each with a one-time
//    X25519 key that is wiped when the handshake ends; a session that ends before the choice is replaced while
//    the request lives (a bounded number of times per advert); the addresses of one approver are raced, two in
//    flight and 250 ms apart (§15.4.1);
//  - every session stops after `HELLO` (`holdSas`); the list has at most 8 entries, shows the reported label
//    and platform only, and is never chosen from for the person;
//  - the code on D's screen is D's confirmation, then `VOUCH_REQ` goes out;
//  - `0x0030` to `0x003F` are held, 16 records and 16 KiB, until the person confirms the signed-in account
//    (`confirmAccount`, rule 12); a decline or a close drops them all;
//  - a session held and not chosen for 20 s is closed `peer_bye` and replaced, so one approver cannot sit on a
//    dial slot (N8);
//  - one answer per request: once `VOUCH_RESULT` said `approved`, or `confirmAccount()` ran, no other approver
//    is dialled or chosen. `confirmAccount()` is for the session that was chosen (N1);
//  - the request and the label are checked when the request starts; `expiresIn` is at most 300 s (N10);
//  - the browse and the wait for `VOUCH_RESULT` end at `expiresIn` (300 s), then every session closes
//    `peer_bye`; the request handle, `sig`, `h` and the nonces are in no message, repr or error.

import Foundation

// MARK: - The dial race (§15.4.1)

/// Dialling several addresses of one approver (RFC 8305): in first-seen order, at most two attempts in flight,
/// a new one every 250 ms (at once when one fails). The first connection wins; a connection that arrives later
/// is closed before a byte is sent on it. Fails with the last error when none connects.
func nearbyDialRace(
    _ targets: [NearbyTarget], staggerSeconds: TimeInterval = 0.25, maxInFlight: Int = 2,
    timeoutSeconds: TimeInterval = 10, timer: @escaping NearbyTimer,
    dial: @escaping @Sendable (NearbyTarget) async throws -> any PeerBytePipe
) async throws -> any PeerBytePipe {
    let race = NearbyDialRace(
        targets: targets, stagger: staggerSeconds, maxInFlight: maxInFlight, timeout: timeoutSeconds, timer: timer,
        dial: dial)
    return try await race.run()
}

private final class NearbyDialRace: @unchecked Sendable {
    private struct State {
        var next = 0
        var inFlight = 0
        var over = false
        var last: Error = NearbyError.unavailable
        var stagger: (@Sendable () -> Void)?
        var overall: (@Sendable () -> Void)?
        var cont: CheckedContinuation<any PeerBytePipe, Error>?
    }

    private let targets: [NearbyTarget]
    private let stagger: TimeInterval
    private let maxInFlight: Int
    private let timeout: TimeInterval
    private let timer: NearbyTimer
    private let dial: @Sendable (NearbyTarget) async throws -> any PeerBytePipe
    private let state = LockedValue(State())

    init(
        targets: [NearbyTarget], stagger: TimeInterval, maxInFlight: Int, timeout: TimeInterval,
        timer: @escaping NearbyTimer, dial: @escaping @Sendable (NearbyTarget) async throws -> any PeerBytePipe
    ) {
        self.targets = targets
        self.stagger = stagger
        self.maxInFlight = maxInFlight
        self.timeout = timeout
        self.timer = timer
        self.dial = dial
    }

    func run() async throws -> any PeerBytePipe {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<any PeerBytePipe, Error>) in
            state.with { $0.cont = c }
            if targets.isEmpty { return finish(.failure(NearbyError.unavailable)) }
            let cancel = timer(timeout) { [self] in finish(.failure(NearbyError.unavailable)) }
            state.with { $0.overall = cancel }
            launch()
        }
    }

    /// End the race once, with a pipe or the last error.
    private func finish(_ r: Result<any PeerBytePipe, Error>) {
        let (cont, cancels) = state.with {
            s -> (CheckedContinuation<any PeerBytePipe, Error>?, [(@Sendable () -> Void)?]) in
            if s.over { return (nil, []) }
            s.over = true
            defer {
                s.cont = nil
                s.stagger = nil
                s.overall = nil
            }
            return (s.cont, [s.stagger, s.overall])
        }
        for c in cancels { c?() }
        guard let cont else {
            // Over already: a pipe that arrives now is not wanted.
            if case .success(let p) = r { Task { await p.close() } }
            return
        }
        cont.resume(with: r)
    }

    private func launch() {
        let step = state.with {
            s -> (old: (@Sendable () -> Void)?, attempt: NearbyTarget?, more: Bool, fail: Error?, over: Bool) in
            let old = s.stagger
            s.stagger = nil
            if s.over { return (old, nil, false, nil, true) }
            var pick: NearbyTarget?
            if s.next < targets.count && s.inFlight < maxInFlight {
                pick = targets[s.next]
                s.next += 1
                s.inFlight += 1
            }
            let more = s.next < targets.count
            let fail: Error? = (!more && pick == nil && s.inFlight == 0) ? s.last : nil
            return (old, pick, more, fail, false)
        }
        step.old?()
        if step.over { return }
        if step.more {
            // One attempt per call: the timer or a failure starts the next.
            let c = timer(stagger) { [self] in launch() }
            let kept = state.with { s -> Bool in
                if s.over { return false }
                s.stagger = c
                return true
            }
            if !kept { c() }
        }
        if let e = step.fail { finish(.failure(e)) }
        if let t = step.attempt {
            Task { [self] in
                do {
                    let pipe = try await dial(t)
                    won(pipe)
                } catch {
                    lost(error)
                }
            }
        }
    }

    private func won(_ pipe: any PeerBytePipe) {
        state.with { $0.inFlight -= 1 }
        finish(.success(pipe))
    }

    private func lost(_ error: Error) {
        let (over, exhausted, last) = state.with { s -> (Bool, Bool, Error) in
            s.inFlight -= 1
            s.last = error
            return (s.over, s.inFlight == 0 && s.next >= targets.count, s.last)
        }
        if over { return }
        if exhausted { finish(.failure(last)) } else { launch() }
    }
}

// MARK: - The API

/// What the requester reads of the client.
public struct NearbyRequesterSource: Sendable {
    public var slug: String
    /// Seconds since the epoch.
    public var now: @Sendable () -> Int
    /// D's device keys (made when none exist) and its `X-PKey-Device` value.
    public var signer: @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String)

    public init(
        slug: String, now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
        signer: @escaping @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String)
    ) {
        self.slug = slug
        self.now = now
        self.signer = signer
    }
}

public struct NearbyRequestOptions: Sendable, CustomStringConvertible, CustomReflectable {
    /// The handle from `nearby/start` (`nr_…`).
    public var request: String
    /// This device's label in `HELLO` and `VOUCH_REQ` (display data; optional; at most 256 characters). It is
    /// shown on the approving device: name the device, and never use an account identifier (an email address,
    /// a user id) as the label.
    public var label: String?
    /// The `HELLO` platform (`VOUCH_REQ` carries the same).
    public var platform: String
    /// Seconds the request lives (default and most 300, from `nearby/start`'s `expiresIn`).
    public var expiresIn: TimeInterval
    public var handshakeSeconds: TimeInterval
    public var timer: NearbyTimer
    public var random: PeerRandom
    /// How the host's listeners (`onApprovers`, `onResult`, `onRecord`, `onClose`) are called: inline by
    /// default, or on the umbrella's serial queue so a callback that blocks cannot hold a close back.
    public var deliver: NearbyDeliver
    /// Seconds a held session nobody chose lives before it is replaced (default 20).
    public var idleSeconds: TimeInterval
    /// A short pause before a replacement dial (default 0.25 s).
    public var redialSeconds: TimeInterval

    public init(
        request: String, label: String? = nil, platform: String = "swift", expiresIn: TimeInterval = 300,
        handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds, timer: @escaping NearbyTimer = nearbySystemTimer,
        random: @escaping PeerRandom = peerSystemRandom, deliver: @escaping NearbyDeliver = nearbyInline,
        idleSeconds: TimeInterval = 20, redialSeconds: TimeInterval = 0.25
    ) {
        self.request = request
        self.label = label
        self.platform = platform
        self.expiresIn = expiresIn
        self.handshakeSeconds = handshakeSeconds
        self.timer = timer
        self.random = random
        self.deliver = deliver
        self.idleSeconds = idleSeconds
        self.redialSeconds = redialSeconds
    }

    /// The request handle is a secret (G19): no log line, repr or dump of the options prints it.
    public var description: String { "NearbyRequestOptions()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// One approver in the list. Unauthenticated display data: any device on the LAN can be listed.
public struct NearbyApproverInfo: Sendable, Equatable {
    public let id: String
    public let label: String?
    public let platform: String
}

public struct NearbyRecord: Sendable, Equatable {
    /// A Sync record type, `0x0030` to `0x003F`.
    public let type: Int
    public let body: Data
}

/// A small table of listeners; the engine calls them on its own task.
private final class NearbyListeners<T: Sendable>: Sendable {
    private struct S {
        var next = 0
        var fns: [(Int, @Sendable (T) -> Void)] = []
    }
    private let state = LockedValue(S())
    private let deliver: NearbyDeliver

    init(deliver: @escaping NearbyDeliver = nearbyInline) { self.deliver = deliver }

    func add(_ fn: @escaping @Sendable (T) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.next += 1
            s.fns.append((s.next, fn))
            return s.next
        }
        return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
    }

    func fire(_ v: T) {
        let fns = state.with { $0.fns.map(\.1) }
        for f in fns { deliver { f(v) } }
    }
}

public actor NearbyRequester: CustomStringConvertible, CustomReflectable {
    // MARK: Types

    private static let maxDials = 4
    private static let maxList = 8
    private static let expiresMax: TimeInterval = 300
    private static let triesPerAdvert = 3
    private static let labelMax = 256

    private struct Candidate {
        let instance: String
        let advert: NearbyAdvert
        var tries: Int
    }

    enum EntryEvent: Sendable {
        case session(PeerSessionEvent)
        case closed(PeerLinkClosed)
    }

    final class Entry: @unchecked Sendable {
        let id: String
        let instance: String
        let link: PeerLink
        let pipe: any PeerBytePipe
        let key: PeerOneTimeKey
        let events: AsyncStream<EntryEvent>.Continuation
        var hello: PeerHello?
        var code: Int?
        /// Resolved by the `sas` event, or by the end of the session.
        let codeBox = NearbyDeferred<Result<Int, NearbyError>>()
        var closed = false
        /// Cancels the idle clock.
        var idle: (@Sendable () -> Void)?

        init(
            id: String, instance: String, link: PeerLink, pipe: any PeerBytePipe, key: PeerOneTimeKey,
            events: AsyncStream<EntryEvent>.Continuation
        ) {
            self.id = id
            self.instance = instance
            self.link = link
            self.pipe = pipe
            self.key = key
            self.events = events
        }
    }

    // MARK: State

    private let src: NearbyRequesterSource
    private let o: NearbyRequestOptions
    private let network: any NearbyRequesterNetwork
    private var candidates: [String: Candidate] = [:]
    private var entries: [String: Entry] = [:]
    private var entryOrder: [String] = []
    /// Instances with a dial or a session in flight.
    private var active: Set<String> = []
    private var stopBrowse: (@Sendable () -> Void)?
    private var chosen: Entry?
    private var flow: VouchFlow<VouchRecord>?
    private var resultValue: VouchStatus?
    private var ended = false
    /// `approved` came, or the account was confirmed: this request has its answer.
    private var answered = false
    private var cancels: [@Sendable () -> Void] = []
    private var signer: (port: any DeviceKeyPort, deviceId: String)?
    private let pipes = LockedValue<[ObjectIdentifier: any PeerBytePipe]>([:])
    private let approversListeners: NearbyListeners<[NearbyApproverInfo]>
    private let resultListeners: NearbyListeners<VouchStatus>
    private let recordListeners: NearbyListeners<NearbyRecord>
    private let closeListeners: NearbyListeners<String>

    private init(_ src: NearbyRequesterSource, _ o: NearbyRequestOptions, _ network: any NearbyRequesterNetwork) {
        approversListeners = NearbyListeners(deliver: o.deliver)
        resultListeners = NearbyListeners(deliver: o.deliver)
        recordListeners = NearbyListeners(deliver: o.deliver)
        closeListeners = NearbyListeners(deliver: o.deliver)
        self.src = src
        self.o = o
        self.network = network
    }

    public nonisolated var description: String { "NearbyRequest()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    /// The request and the label are the host's input: refuse a bad one now, not at the tap.
    private static func checked(_ o: NearbyRequestOptions) throws -> TimeInterval {
        guard PeerVouch.isRequest(o.request) else { throw NearbyError.badInput }
        if let l = o.label, l.utf16.count > labelMax { throw NearbyError.badInput }
        guard o.expiresIn.isFinite, o.expiresIn > 0 else { throw NearbyError.badInput }
        return min(o.expiresIn, expiresMax)
    }

    /// Start browsing and dialling. The caller holds the request from `nearby/start`. Throws `NearbyError`.
    public static func start(
        source: NearbyRequesterSource, options: NearbyRequestOptions, network: any NearbyRequesterNetwork
    ) async throws -> NearbyRequester {
        let expires = try checked(options)
        let r = NearbyRequester(source, options, network)
        try await r.begin(expires)
        return r
    }

    private func begin(_ expires: TimeInterval) async throws {
        signer = try await src.signer()
        cancels.append(
            o.timer(expires) { [weak self] in
                guard let self else { return }
                Task { await self.stop("expired") }
            })
        do {
            let slug = src.slug
            let now = src.now
            stopBrowse = try network.browse(
                accept: { NearbyRequester.isApprover($0, slug: slug, now: now()) },
                onUp: { [weak self] ad in
                    guard let self else { return }
                    Task { await self.found(ad) }
                },
                onDown: { [weak self] instance in
                    guard let self else { return }
                    Task { await self.gone(instance) }
                })
        } catch {
            await close()
            throw (error as? NearbyError) ?? NearbyError.unavailable
        }
        // A close that landed while the browse started leaves nothing running.
        if ended {
            let s = stopBrowse
            stopBrowse = nil
            s?()
        }
    }

    // MARK: Reading

    /// The approvers that said `HELLO`, at most 8. Empty once the person chose or the request ended.
    public func approvers() -> [NearbyApproverInfo] {
        if chosen != nil || ended { return [] }
        return entryOrder.compactMap { entries[$0] }
            .filter { $0.hello != nil && !$0.closed }
            .prefix(Self.maxList)
            .map { NearbyApproverInfo(id: $0.id, label: $0.hello?.label, platform: $0.hello?.platform ?? "") }
    }

    /// What `VOUCH_RESULT` said. For display only: the host's poll is the authority.
    public func result() -> VouchStatus? { resultValue }

    public func isClosed() -> Bool { ended }

    @discardableResult
    public nonisolated func onApprovers(_ fn: @escaping @Sendable ([NearbyApproverInfo]) -> Void)
        -> @Sendable () -> Void
    { approversListeners.add(fn) }

    @discardableResult
    public nonisolated func onResult(_ fn: @escaping @Sendable (VouchStatus) -> Void) -> @Sendable () -> Void {
        resultListeners.add(fn)
    }

    /// Sync records, once the person confirmed the account.
    @discardableResult
    public nonisolated func onRecord(_ fn: @escaping @Sendable (NearbyRecord) -> Void) -> @Sendable () -> Void {
        recordListeners.add(fn)
    }

    /// The chosen session ended (or the request expired); with why: a close code, `connection_lost` or
    /// `expired`.
    @discardableResult
    public nonisolated func onClose(_ fn: @escaping @Sendable (String) -> Void) -> @Sendable () -> Void {
        closeListeners.add(fn)
    }

    private func list() { approversListeners.fire(approvers()) }

    // MARK: Browse and dial

    /// An approver advert of this product: `m=v` with the product tag of this epoch or the last. An advert of
    /// another product, or of mode a, is not ours.
    nonisolated static func isApprover(_ ad: NearbyAdvert, slug: String, now: Int) -> Bool {
        guard case .ok(let mode, let h) = PeerAdvert.parseTxt(ad.txt), mode == .v, let h else { return false }
        let epoch = peerAdvertEpoch(now)
        guard let a = try? PeerAdvert.productTag(slug: slug, epoch: epoch),
            let b = try? PeerAdvert.productTag(slug: slug, epoch: epoch - 1)
        else { return false }
        return h == a || h == b
    }

    private func found(_ ad: NearbyAdvert) async {
        if ended || answered || chosen != nil { return }
        guard Self.isApprover(ad, slug: src.slug, now: src.now()) else { return }
        candidates[ad.instance] = Candidate(
            instance: ad.instance, advert: ad, tries: candidates[ad.instance]?.tries ?? 0)
        pump()
    }

    private func gone(_ instance: String) { candidates[instance] = nil }

    /// Dial candidates at random until 4 are in flight.
    private func pump() {
        while !ended && !answered && chosen == nil && active.count < Self.maxDials {
            let free = candidates.values.filter { !active.contains($0.instance) && $0.tries < Self.triesPerAdvert }
                .sorted { $0.instance < $1.instance }
            if free.isEmpty { return }
            guard let at = try? PeerVouch.uniformBelow(free.count, o.random) else { return }
            let c = free[at]
            candidates[c.instance]?.tries += 1
            active.insert(c.instance)
            Task { await self.dial(c.advert) }
        }
    }

    private func dial(_ ad: NearbyAdvert) async {
        let pipe: any PeerBytePipe
        do {
            let targets = try await network.resolve(ad)
            let net = network
            pipe = try await nearbyDialRace(targets, timer: o.timer) { try await net.dial($0) }
        } catch {
            active.remove(ad.instance)
            later()
            return
        }
        if ended || answered || chosen != nil {
            await pipe.close()
            active.remove(ad.instance)
            return
        }
        guard let key = try? PeerOneTimeKey(random: o.random) else {
            await pipe.close()
            active.remove(ad.instance)
            return
        }
        let id = "ap_" + o.random(6).map { String(format: "%02x", $0) }.joined()
        let (stream, cont) = AsyncStream<EntryEvent>.makeStream()
        let opts = PeerChannelOptions(
            role: .initiator, slug: src.slug, staticKey: key, hello: (o.label, o.platform, src.slug, nil), mode: .v,
            holdSas: true)
        let link: PeerLink
        do {
            link = try await PeerLink.make(
                pipe: pipe, options: opts,
                handlers: PeerLinkHandlers(
                    onClosed: { cont.yield(.closed($0)) }, onSession: { cont.yield(.session($0)) }),
                handshakeSeconds: o.handshakeSeconds)
        } catch {
            key.wipe()
            cont.finish()
            await pipe.close()
            active.remove(ad.instance)
            return
        }
        // A close that landed while the link was being made.
        if ended || answered || chosen != nil {
            key.wipe()
            cont.finish()
            await link.close(.peerBye)
            await pipe.close()
            active.remove(ad.instance)
            return
        }
        let e = Entry(id: id, instance: ad.instance, link: link, pipe: pipe, key: key, events: cont)
        entries[id] = e
        entryOrder.append(id)
        pipes.with { $0[ObjectIdentifier(e)] = pipe }
        Task { [weak self] in
            for await ev in stream { await self?.event(e, ev) }
        }
        Task { await link.run() }
        await link.start()
    }

    /// A short pause before a replacement dial, so a refusing approver is not hammered.
    private func later() {
        cancels.append(
            o.timer(o.redialSeconds) { [weak self] in
                guard let self else { return }
                Task { await self.pump() }
            })
    }

    // MARK: A session's events

    private func event(_ e: Entry, _ ev: EntryEvent) async {
        switch ev {
        case .closed(let c): sessionEnded(e, c)
        case .session(let s):
            switch s {
            case .established(let est):
                // The one-time static key has done its work.
                e.key.wipe()
                e.hello = est.hello
                // Held and not chosen for 20 s: replaced, so one approver cannot sit on a dial slot.
                e.idle = o.timer(o.idleSeconds) { [weak self] in
                    guard let self else { return }
                    Task { await self.replace(e) }
                }
                list()
            case .sas(let code, _):
                e.code = code
                e.codeBox.resolve(.success(code))
            case .record(let type, let body):
                if e === chosen { record(type, body) }
            default:
                break
            }
        }
    }

    private func replace(_ e: Entry) async {
        e.idle = nil
        if e === chosen || e.closed || ended { return }
        // The advert gets its try back: this is not a failure of the approver.
        if let c = candidates[e.instance], c.tries > 0 { candidates[e.instance]?.tries -= 1 }
        await e.link.close(.peerBye)
    }

    private func record(_ type: Int, _ body: Data) {
        guard let flow else { return }
        switch flow.receive(VouchRecord(type: type, body: body)) {
        case .close(let c):
            if let ch = chosen { Task { await ch.link.close(c) } }
        case .ok(let out):
            for r in out { deliver(r) }
        }
    }

    private func deliver(_ r: VouchRecord) {
        if r.type == PeerRecordType.vouchResult {
            // Display only: an unknown status reads as `denied` (rule 6).
            guard case .status(let st) = PeerVouch.parseResult(r.body) else { return }
            resultValue = st
            if st == .approved { answered = true }
            resultListeners.fire(st)
        } else if r.type >= 0x0030 && r.type <= 0x003f {
            recordListeners.fire(NearbyRecord(type: r.type, body: r.body))
        }
    }

    private func sessionEnded(_ e: Entry, _ c: PeerLinkClosed) {
        if e.closed { return }
        e.closed = true
        e.idle?()
        e.idle = nil
        e.key.wipe()
        e.events.finish()
        entries[e.id] = nil
        entryOrder.removeAll { $0 == e.id }
        pipes.with { $0[ObjectIdentifier(e)] = nil }
        active.remove(e.instance)
        e.codeBox.resolve(.failure(.closed))
        if e === chosen {
            // The chosen session is over. Without an answer the request goes on: the person may choose again
            // from a fresh list.
            chosen = nil
            flow = nil
            if !ended {
                closeListeners.fire(c.code)
                if resultValue == nil && !answered { later() }
            }
        } else {
            list()
            if !ended && !answered { later() }
        }
    }

    // MARK: The person's choices

    /// The person tapped this approver. Starts the code on that session only and closes the others
    /// `peer_bye`; answers D's code to show (like `123 456`), and sends `VOUCH_REQ` once it is shown.
    public func choose(_ id: String) async throws -> String {
        if ended { throw NearbyError.closed }
        if answered { throw NearbyError.closed }
        if chosen != nil { throw NearbyError.notAvailable }
        guard let e = entries[id], e.hello != nil, !e.closed else { throw NearbyError.unknownApprover }
        guard let signer else { throw NearbyError.notAvailable }
        guard let flow = e.link.channel.vouch else { throw NearbyError.closed }
        chosen = e
        self.flow = flow
        e.idle?()
        e.idle = nil
        // The others close before any code record is sent on them: no other approver ever prompts.
        for other in entries.values where other !== e {
            let l = other.link
            Task { await l.close(.peerBye) }
        }
        list()
        await e.link.startSas()
        let code = try await e.codeBox.wait().get()
        // Showing the code is D's confirmation; then the request goes to the chosen approver.
        flow.codeShown()
        await e.link.channel.confirmSas()
        let h: Data
        let body: Data
        do {
            h = try await e.link.channel.handshakeHash()
            body = try await PeerVouch.buildRequest(
                port: signer.port, slug: src.slug, h: h, request: o.request, deviceId: signer.deviceId,
                hello: VouchHello(label: o.label, platform: o.platform))
        } catch {
            await e.link.close(.peerBye)
            throw NearbyError.closed
        }
        let rec = VouchRecord(type: PeerRecordType.vouchReq, body: body)
        if case .close(let c) = flow.send(rec) {
            await e.link.close(c)
            throw NearbyError.closed
        }
        do { try await e.link.sendRecord(type: rec.type, body: rec.body) } catch { throw NearbyError.closed }
        return PeerSAS.display(code)
    }

    /// The person confirmed that the signed-in account is theirs: held records go to `onRecord`. It counts for
    /// the session that was chosen and answered `approved`; it is not a standing consent, and after it (or
    /// after `approved`) no other approver can be chosen.
    public func confirmAccount() async throws {
        guard let flow else { throw NearbyError.notAvailable }
        answered = true
        switch flow.confirmAccount() {
        case .close(let c):
            await chosen?.link.close(c)
        case .ok(let out):
            for r in out { deliver(r) }
        }
    }

    /// The person declined, or the screen timed out: every held record is dropped and the session closes.
    public func declineAccount() async {
        guard let flow else { return }
        if case .close(let c) = flow.declineAccount() {
            await chosen?.link.close(c)
        } else {
            await chosen?.link.close(.peerBye)
        }
    }

    // MARK: The end

    /// End the request: the browse stops and every session closes `peer_bye`.
    public func close() async { await stop(nil) }

    /// Drop every socket now, with no goodbye (the sign-out bound's force path). Safe from any context.
    public nonisolated func destroy() {
        for p in pipes.current.values { Task { await p.close() } }
        Task { await self.stop(nil) }
    }

    private func stop(_ why: String?) async {
        if ended { return }
        let hadChosen = chosen != nil
        ended = true
        for c in cancels { c() }
        cancels = []
        if why != nil || hadChosen { closeListeners.fire(why ?? "peer_bye") }
        let browse = stopBrowse
        stopBrowse = nil
        // The sessions close before the browse is stopped: a browse that hangs cannot hold them up.
        let closes = entries.values.map { e -> Task<Void, Never> in
            let l = e.link
            return Task { await l.close(.peerBye) }
        }
        browse?()
        for t in closes { await t.value }
    }
}
