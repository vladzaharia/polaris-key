// What the LAN and relay transports share (CC-11.10; WIRE-CONTRACT-V5 §15.3, §15.5). Mirrors sdk-node's
// `connect/channel.ts` and the Python port's `connect/channel.py`: the account context and channel
// options a `PeerChannel` is built from, and the handling of the two documents a peer may push on an
// open session, `RING` and `TRUST`.
//
// Rules this file keeps:
//  - the device's X25519 private key never leaves the key port: the channel is given the
//    `PeerSource.staticKey` handle, whose `dh` calls the port;
//  - a pushed document is never trusted because a peer sent it. `RING` is re-verified and stored by the
//    identity client under its replacement rules; `TRUST` is verified against the usable pins and applied
//    by the trust custodian. Each outcome, stored or refused, is reported as a `ConnectNotice`; none is
//    dropped silently;
//  - the calls into the client (store a roster, apply trust, refresh identity) run one at a time on a
//    worker task, never on the link's event task.

import Foundation
import PolarisKeyCore

public let connectRefreshGapSeconds = 60
/// Pushed documents handled at once; the rest are refused as `busy`.
public let connectMaxDocsQueued = 8
private let maxRetries = 5

/// A pushed document's outcome. `type` is `ring` or `trust`; `outcome` is `stored` (a roster, with its
/// `epoch`), `applied` (trust) or `refused` (with a `reason`).
public struct ConnectNotice: Sendable, Equatable {
    public let type: String
    public let outcome: String
    public let epoch: Int?
    public let reason: String?

    public init(type: String, outcome: String, epoch: Int? = nil, reason: String? = nil) {
        self.type = type
        self.outcome = outcome
        self.epoch = epoch
        self.reason = reason
    }
}

/// The client calls pushed documents need. Every member but `now` may be nil (the document is then
/// refused as `unsupported`, or no refresh is made).
public struct ConnectPeerDocsSource: Sendable {
    public var now: @Sendable () -> Int
    /// Ask the Worker for a newer roster; throws on failure.
    public var refresh: (@Sendable () async throws -> Void)?
    /// Verify and store a pushed roster.
    public var adoptRing: (@Sendable (String) async -> RingAdoption)?
    /// Verify and apply a pushed trust manifest.
    public var applyTrust: (@Sendable (String) async -> PeerTrustResult)?

    public init(
        now: @escaping @Sendable () -> Int, refresh: (@Sendable () async throws -> Void)? = nil,
        adoptRing: (@Sendable (String) async -> RingAdoption)? = nil,
        applyTrust: (@Sendable (String) async -> PeerTrustResult)? = nil
    ) {
        self.now = now
        self.refresh = refresh
        self.adoptRing = adoptRing
        self.applyTrust = applyTrust
    }
}

extension PeerAccountContext {
    /// The account context of a session. `ring` is the newest roster a session handed up, if any.
    public init(source src: PeerSource, ring: @escaping @Sendable () -> (jws: String, epoch: Int)? = { nil }) {
        self.init(
            trust: src.trust, expectedAud: src.slug, certJws: src.certJws, ownSub: src.sub, ownDeviceId: src.deviceId,
            heldRing: { ring() ?? (src.ringJws, src.ringEpoch) },
            discKeys: [src.keys.current.bytes, src.keys.previous?.bytes])
    }
}

extension PeerChannelOptions {
    /// The options every channel of a transport shares (all but `role`). The same for LAN and relay.
    public static func connectBase(
        _ src: PeerSource, role: PeerChannel.Role, caps: [String] = ["app/1"], label: String? = nil,
        platform: String = connectPlatformName, ring: @escaping @Sendable () -> (jws: String, epoch: Int)? = { nil },
        now: (@Sendable () -> Int)? = nil, rekeyMessages: Int? = nil, rekeySeconds: TimeInterval? = nil
    ) -> PeerChannelOptions {
        PeerChannelOptions(
            role: role, slug: src.slug, staticKey: src.staticKey, account: PeerAccountContext(source: src, ring: ring),
            caps: caps, hello: (label, platform, src.slug, nil), mode: .a, now: now,
            rekeyMessages: rekeyMessages ?? (1 << 20), rekeySeconds: rekeySeconds ?? 3600)
    }
}

/// The HELLO `platform` of this process.
public let connectPlatformName: String = {
    #if os(macOS)
        return "macos"
    #elseif os(iOS)
        return "ios"
    #elseif os(tvOS)
        return "tvos"
    #elseif os(visionOS)
        return "visionos"
    #else
        return "swift"
    #endif
}()

/// Handles `RING`, `TRUST` and "a peer is on a newer roster". Jobs run one at a time on a worker task;
/// `timer(seconds, fn)` schedules a deferred retry and returns its cancel (default: a `Task` sleep).
public final class ConnectPeerDocs: Sendable, CustomStringConvertible, CustomReflectable {
    public typealias Timer = @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> @Sendable () -> Void

    private struct State {
        var queued: Set<String> = []
        var lastRefresh: Int?
        var retry: (@Sendable () -> Void)?
        var tries = 0
        var fns: [(id: Int, fn: @Sendable (ConnectNotice) -> Void)] = []
        var nextId = 0
        /// The newest roster a session handed up, held until an identity load catches up.
        var pushed: (jws: String, epoch: Int)?
        /// `close()` ran: nothing queued or armed runs any more (G18, the sign-out order).
        var closed = false
        /// The last second a `busy` notice was emitted, by kind: the rest are dropped, not reported.
        var lastBusy: [String: Int] = [:]
    }

    /// A queued job. `always` jobs (the drain marker) run even after `close()`.
    private struct Job: Sendable {
        let always: Bool
        let fn: @Sendable () async -> Void
    }

    private let src: ConnectPeerDocsSource
    private let onStored: @Sendable () -> Void
    private let timer: Timer
    private let state = LockedValue(State())
    private let jobs: AsyncStream<Job>.Continuation
    private let worker: Task<Void, Never>

    public init(
        source: ConnectPeerDocsSource, onStored: @escaping @Sendable () -> Void = {}, timer: Timer? = nil
    ) {
        src = source
        self.onStored = onStored
        self.timer =
            timer ?? { s, fn in
                let t = Task {
                    try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
                    if !Task.isCancelled { fn() }
                }
                return { t.cancel() }
            }
        let (stream, cont) = AsyncStream<Job>.makeStream()
        jobs = cont
        let st = state
        worker = Task {
            for await j in stream {
                if !j.always && st.with({ $0.closed }) { continue }
                await j.fn()
            }
        }
    }

    public var description: String { "ConnectPeerDocs()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }

    /// The newest roster a session handed up, if any.
    public var pushed: (jws: String, epoch: Int)? { state.with { $0.pushed } }

    @discardableResult
    public func onNotice(_ fn: @escaping @Sendable (ConnectNotice) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.nextId += 1
            s.fns.append((s.nextId, fn))
            return s.nextId
        }
        return { [state] in state.with { $0.fns.removeAll { $0.id == id } } }
    }

    /// Stop a pending retry and the worker.
    public func close() {
        let cancel = state.with { s -> (@Sendable () -> Void)? in
            s.closed = true
            let r = s.retry
            s.retry = nil
            return r
        }
        cancel?()
        jobs.finish()
    }

    /// Resolves once every job queued before this call has run (for tests and orderly shutdown).
    public func drain() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let r = jobs.yield(Job(always: true, fn: { c.resume() }))
            if case .terminated = r { c.resume() }
        }
    }

    // What a link reports; hand these to `PeerLinkHandlers`.

    public func onRing(_ jws: String, _ epoch: Int) {
        state.with { s in
            if s.pushed == nil || epoch > s.pushed!.epoch { s.pushed = (jws, epoch) }
        }
        ring(jws)
    }

    public func onTrust(_ jws: String) { trust(jws) }

    public func onRingWanted() { wantRing() }

    /// A roster a peer pushed (already verified once by the session).
    public func ring(_ jws: String) {
        run("ring", jws) { [self] in
            guard let adopt = src.adoptRing else {
                return emit(ConnectNotice(type: "ring", outcome: "refused", reason: "unsupported"))
            }
            let r = await adopt(jws)
            guard r.stored else {
                return emit(ConnectNotice(type: "ring", outcome: "refused", reason: r.reason))
            }
            emit(ConnectNotice(type: "ring", outcome: "stored", epoch: r.epoch))
            onStored()
            // The certificate and K_disc that go with the new roster come from the Worker. If the
            // minute's slot is taken, or the fetch fails, it is tried again.
            _ = await want(retry: true)
        }
    }

    /// A trust manifest a peer pushed (not verified by the session).
    public func trust(_ jws: String) {
        run("trust", jws) { [self] in
            guard let apply = src.applyTrust else {
                return emit(ConnectNotice(type: "trust", outcome: "refused", reason: "unsupported"))
            }
            let r = await apply(jws)
            emit(
                r.applied
                    ? ConnectNotice(type: "trust", outcome: "applied")
                    : ConnectNotice(type: "trust", outcome: "refused", reason: r.reason))
        }
    }

    /// A peer is on a newer roster, or the relay said the roster changed: fetch it (a fresh
    /// `identity(refresh:)`, verified under the normal replacement rules). At most one a minute.
    public func wantRing() {
        if isClosed { return }
        jobs.yield(Job(always: false, fn: { [self] in _ = await want(retry: false) }))
    }

    /// True when a fetch started.
    func want(retry: Bool) async -> Bool {
        guard let refresh = src.refresh, !isClosed else { return false }
        let t = src.now()
        enum Gate {
            case go
            case wait(Int)
        }
        let gate: Gate = state.with { s in
            if let last = s.lastRefresh, t - last < connectRefreshGapSeconds {
                return .wait(last + connectRefreshGapSeconds - t)
            }
            s.lastRefresh = t
            return .go
        }
        if case .wait(let gap) = gate {
            if retry { defer_(TimeInterval(gap)) }
            return false
        }
        do {
            try await refresh()
            if isClosed { return true }  // a sign-out ran meanwhile: nothing is stored or retried
            state.with { $0.tries = 0 }
            onStored()
        } catch {
            let n = state.with { s -> Int in
                s.tries += 1
                return s.tries
            }
            if retry && n <= maxRetries && !isClosed { defer_(TimeInterval(connectRefreshGapSeconds)) }
        }
        return true
    }

    private var isClosed: Bool { state.with { $0.closed } }

    private func defer_(_ seconds: TimeInterval) {
        let armed = state.with { s -> Bool in
            if s.retry != nil || s.closed { return false }
            return true
        }
        guard armed else { return }
        let cancel = timer(max(1, seconds)) { [self] in
            state.with { $0.retry = nil }
            jobs.yield(Job(always: false, fn: { [self] in _ = await want(retry: true) }))
        }
        state.with { s in
            if s.closed { cancel() } else { s.retry = cancel }
        }
    }

    /// One at a time, at most `connectMaxDocsQueued` waiting, and a document already waiting is not
    /// queued twice: the excess is refused visibly, not worked on.
    private func run(_ kind: String, _ jws: String, _ job: @escaping @Sendable () async -> Void) {
        let key = kind + ":" + jws
        let now = src.now()
        enum Gate {
            case run
            case busy(notify: Bool)
            case closed
        }
        let gate: Gate = state.with { s in
            if s.closed { return .closed }
            // One slot is kept for RING: a flood of TRUST documents cannot starve a roster (G11).
            let nonRing = s.queued.filter { !$0.hasPrefix("ring:") }.count
            let full = kind == "ring" ? s.queued.count >= connectMaxDocsQueued : nonRing >= connectMaxDocsQueued - 1
            if s.queued.contains(key) || full {
                // At most one busy notice per kind per second; the rest are dropped, not reported.
                let notify = s.lastBusy[kind] != now
                s.lastBusy[kind] = now
                return .busy(notify: notify)
            }
            s.queued.insert(key)
            return .run
        }
        switch gate {
        case .closed: return
        case .busy(let notify):
            if notify { emit(ConnectNotice(type: kind, outcome: "refused", reason: "busy")) }
        case .run:
            jobs.yield(
                Job(
                    always: false,
                    fn: { [self] in
                        await job()
                        _ = state.with { $0.queued.remove(key) }
                    }))
        }
    }

    private func emit(_ n: ConnectNotice) {
        let fns = state.with { $0.fns.map(\.fn) }
        for f in fns { f(n) }
    }
}
