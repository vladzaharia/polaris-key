// The Cloud Connect API an app calls (CC-11.15; WIRE-CONTRACT-V5 §15): `client.cloudConnect`. A facade over the
// identity client, the LAN service, the relay and the sessions they open. Mirrors sdk-node's
// `connect/cloudConnect.ts` and the Python port's `connect/cloud_connect.py`.
//
//  - `start()`: get the identity (making and registering the device keys on first use), listen and browse on
//    the LAN, then connect to the relay unless the host or the product turned it off;
//  - `peers()`: the person's other devices that can be reached now, with the paths they have;
//  - `devices()`: the person's devices as the Worker lists them (display data);
//  - `open(_:)`: a session to one device, LAN first, the relay after a bounded LAN attempt;
//  - `onChannel(_:)`: sessions other devices opened to this one, on either path;
//  - `stop()`: close the sessions, the relay and the LAN service. Bounded at 15 s (S6).
//
// Rules this file keeps:
//  - the order is LAN, then relay. The LAN attempt is bounded (`lanAttemptSeconds`, default 4); when it fails or
//    runs out of time and the relay is on, the relay is tried. A device not seen on the LAN goes straight to the
//    relay. `session.path` says which path was used;
//  - the relay stays off, with no socket and no ticket asked for, when the host turned it off and when discovery
//    says so: `services.connect.relay` is false, or the fragment names endpoints but no ticket (G21).
//    `status().relayReason` says which;
//  - the relay carries mode `a` only; `v` and `p` are not reachable through this API;
//  - an inbound session with no `onChannel` listener is closed (G9);
//  - host callbacks run on a private serial queue, never inline in a service: a callback that blocks cannot hang
//    `stop()` or sign-out (S6);
//  - a failure on one path is never swallowed: when no path works the last typed error is thrown.

import Foundation
import PolarisKeyCore

#if canImport(Network)

    public let cloudConnectLanAttemptSeconds: TimeInterval = 4
    public let cloudConnectStopSeconds: TimeInterval = 15
    /// How long `start()` may take before it tears down what it brought up and throws.
    let cloudConnectStartSeconds: TimeInterval = 30

    public struct CloudPeer: Sendable, Equatable {
        public let deviceId: String
        /// Seen on this network right now.
        public let lan: Bool
        /// Online in the relay room right now.
        public let relay: Bool
    }

    public struct CloudConnectStatus: Sendable {
        public let running: Bool
        /// `off`, `on` or `failed` (see `lanError`).
        public let lan: String
        public let lanError: ConnectLanError?
        /// `off`, or the relay's state: `connecting`, `open`, `backoff`, `unavailable`, `blocked`, ...
        public let relay: String
        public let relayError: ConnectRelayError?
        /// Why the relay is `off`: `host` (turned off), `product` (discovery says no relay) or `no_ticket`
        /// (discovery names endpoints but no ticket); nil while it is on.
        public let relayReason: String?
    }

    public struct CloudConnectOptions: Sendable {
        public var lan: Bool
        public var relay: Bool
        public var lanOptions: ConnectLanOptions
        public var relayOptions: ConnectRelayOptions
        public var lanAttemptSeconds: TimeInterval

        public init(
            lan: Bool = true, relay: Bool = true, lanOptions: ConnectLanOptions = ConnectLanOptions(),
            relayOptions: ConnectRelayOptions = ConnectRelayOptions(),
            lanAttemptSeconds: TimeInterval = cloudConnectLanAttemptSeconds
        ) {
            self.lan = lan
            self.relay = relay
            self.lanOptions = lanOptions
            self.relayOptions = relayOptions
            self.lanAttemptSeconds = lanAttemptSeconds
        }
    }

    /// Why `start()` could not bring Cloud Connect up: the identity's own answer.
    public enum CloudConnectError: Error, Sendable, CustomStringConvertible {
        case unsupported(Unsupported)
        case refused(ConnectRefusal)
        case failed(code: String, message: String)

        public var code: String {
            switch self {
            case .unsupported: return ErrorCode.unsupported
            case .refused(let r): return r.code
            case .failed(let c, _): return c
            }
        }

        public var description: String { "CloudConnectError(\(code))" }
    }

    /// `nil` when discovery allows the relay, else why not (G21). An unknown discovery allows it: the ticket route
    /// answers for itself. The parser drops a null endpoint, so a fragment that lists endpoints and lacks `ticket`
    /// reads as a null ticket.
    func cloudConnectRelayWanted(_ doc: ProductDiscoveryDocument?) -> String? {
        guard let f = doc?.services[.connect] else { return nil }
        if f.extras["relay"] == .bool(false) { return "product" }
        if !f.endpoints.isEmpty && f.endpoints["ticket"] == nil { return "no_ticket" }
        return nil
    }

    private final class Listeners<T: Sendable>: Sendable {
        private struct S {
            var next = 0
            var fns: [(Int, @Sendable (T) -> Void)] = []
        }
        private let state = LockedValue(S())
        var isEmpty: Bool { state.with { $0.fns.isEmpty } }
        func add(_ fn: @escaping @Sendable (T) -> Void) -> @Sendable () -> Void {
            let id = state.with { s -> Int in
                s.next += 1
                s.fns.append((s.next, fn))
                return s.next
            }
            return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
        }
        var all: [@Sendable (T) -> Void] { state.with { $0.fns.map(\.1) } }
    }

    public final class CloudConnect: Sendable {
        let core: CloudConnectCore
        private let channelListeners = Listeners<ConnectSession>()
        private let noticeListeners = Listeners<ConnectNotice>()
        private let statusBox = LockedValue(
            CloudConnectStatus(
                running: false, lan: "off", lanError: nil, relay: "off", relayError: nil, relayReason: nil))
        private let queue = DispatchQueue(label: "im.plrs.key.cloud-connect.callbacks")

        /// `discovery` returns the loaded discovery document; `applyTrust` verifies, applies and persists a trust
        /// manifest a peer pushed (`CoreContext.applyPeerTrust`); `now` is epoch seconds.
        public init(
            connect: ConnectClient, discovery: @escaping @Sendable () async -> ProductDiscoveryDocument? = { nil },
            applyTrust: (@Sendable (String) async -> PeerTrustResult)? = nil,
            now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) }
        ) {
            let channel = channelListeners
            let notices = noticeListeners
            let box = statusBox
            let q = queue
            core = CloudConnectCore(
                connect: connect, discovery: discovery, applyTrust: applyTrust, now: now,
                emit: Emit(
                    inbound: { s in
                        let subs = channel.all
                        if subs.isEmpty { return false }  // nobody to hand it to (G9)
                        for f in subs { q.async { f(s) } }
                        return true
                    },
                    notice: { n in for f in notices.all { q.async { f(n) } } },
                    status: { box.set($0) }))
        }

        /// For tests: hand a session in as an inbound one.
        func deliverInbound(_ s: ConnectSession) async { await core.inbound(s) }

        /// The state now: whether it runs, and what each transport is doing.
        public func status() -> CloudConnectStatus { statusBox.current }

        /// Get the identity and bring the transports up. A LAN service that cannot start is not fatal while the
        /// relay is on (`status().lanError` says why); with the relay off the LAN error is thrown. Throws
        /// `CloudConnectError` for the identity's refusals.
        public func start(options: CloudConnectOptions = CloudConnectOptions()) async throws {
            try await core.start(options)
        }

        /// Close the sessions, the relay socket and the LAN service, including a `start()` still in flight. Safe to
        /// call more than once, and before `start`. Never throws and never waits past 15 s: a transport that has not
        /// closed by then is force-cancelled (listener, browser and relay socket, no graceful close) and its
        /// discovery key is dropped, so a sign-out is never held up by Connect.
        public func stop() async { await core.stop(timeout: cloudConnectStopSeconds) }

        /// The person's other devices that can be reached now, with the paths each has.
        public func peers() async -> [CloudPeer] { await core.peers() }

        /// Ask the relay room who is online now, so `peers()` includes devices that joined since.
        public func refreshPeers() async -> [CloudPeer] { await core.refreshPeers() }

        /// The person's devices, as the Worker lists them (display data only).
        public func devices() async -> ConnectDevicesResult { await core.devices() }

        /// A session to one of the person's devices. LAN first when the device was seen on the network, the relay
        /// after a failed or timed-out LAN attempt (unless `relay` is false). Throws `ConnectLanError` or
        /// `ConnectRelayError`; `session.path` tells which path an open session took.
        public func open(_ deviceId: String, relay: Bool = true, lanAttemptSeconds: TimeInterval? = nil) async throws
            -> ConnectSession
        {
            try await core.open(deviceId, relay: relay, lanAttempt: lanAttemptSeconds)
        }

        /// Called with each session another device opened to this one, on either path. Without a listener an
        /// inbound session is closed (G9). Returns the unsubscribe.
        @discardableResult
        public func onChannel(_ listener: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
            channelListeners.add(listener)
        }

        /// Called when a roster or trust manifest a peer pushed is stored, applied or refused.
        @discardableResult
        public func onNotice(_ listener: @escaping @Sendable (ConnectNotice) -> Void) -> @Sendable () -> Void {
            noticeListeners.add(listener)
        }
    }

    struct Emit: Sendable {
        let inbound: @Sendable (ConnectSession) -> Bool
        let notice: @Sendable (ConnectNotice) -> Void
        let status: @Sendable (CloudConnectStatus) -> Void
    }

    /// Runs `op` for at most `seconds`; true when it finished first.
    func connectBounded(_ seconds: TimeInterval, _ op: @escaping @Sendable () async -> Void) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let once = LockedValue(false)
            let claim: @Sendable () -> Bool = {
                once.with {
                    let w = $0
                    $0 = true
                    return !w
                }
            }
            Task {
                await op()
                if claim() { c.resume(returning: true) }
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if claim() { c.resume(returning: false) }
            }
        }
    }

    actor CloudConnectCore {
        private let connect: ConnectClient
        private let discovery: @Sendable () async -> ProductDiscoveryDocument?
        private let applyTrust: (@Sendable (String) async -> PeerTrustResult)?
        private let now: @Sendable () -> Int
        private let emit: Emit

        private var lan: ConnectLanService?
        private var relay: ConnectRelayService?
        private var lanFailed: ConnectLanError?
        private var relayReason: String?
        private var relayStatus: ConnectRelayStatus?
        private var selfId = ""
        private var running = false
        private var starting: Task<Void, Error>?
        private var stopping = false
        private var generation = 0
        private var unsub: [@Sendable () -> Void] = []
        private var sessions: [ObjectIdentifier: ConnectSession] = [:]
        private var lanAttempt = cloudConnectLanAttemptSeconds

        init(
            connect: ConnectClient, discovery: @escaping @Sendable () async -> ProductDiscoveryDocument?,
            applyTrust: (@Sendable (String) async -> PeerTrustResult)?, now: @escaping @Sendable () -> Int, emit: Emit
        ) {
            self.connect = connect
            self.discovery = discovery
            self.applyTrust = applyTrust
            self.now = now
            self.emit = emit
        }

        private func publish() {
            emit.status(
                CloudConnectStatus(
                    running: running, lan: lan != nil ? "on" : lanFailed != nil ? "failed" : "off", lanError: lanFailed,
                    relay: relayStatus.map { $0.state.rawValue } ?? "off", relayError: relayStatus?.error,
                    relayReason: relayStatus == nil ? relayReason : nil))
        }

        func start(_ o: CloudConnectOptions, timeout: TimeInterval = cloudConnectStartSeconds) async throws {
            if stopping { throw ConnectLanError(.notStarted, "Cloud Connect is stopping.") }
            let gen = generation
            let t: Task<Void, Error>
            if let existing = starting {
                t = existing
            } else {
                if running { return }
                t = Task { try await self.bringUp(o, gen) }
                starting = t
            }
            // The bound covers everything start() waits on: a listener that never becomes ready, a stuck fetch.
            let outcome = await Self.race(timeout, { try await t.value }, late: { _ in })
            if starting == t { starting = nil }
            switch outcome {
            case .value: return
            case .failed(let e): throw e
            case .timedOut:
                if gen == generation {
                    t.cancel()
                    await teardown(timeout: cloudConnectStopSeconds, waitFor: nil)
                }
                throw ConnectLanError(.connectFailed, "Cloud Connect took too long to start.")
            }
        }

        /// A later `stop()` or a timed-out `start()` moved the generation on: whatever this run brought up is its own to
        /// close, and nothing it made is kept.
        private func bringUp(_ o: CloudConnectOptions, _ gen: Int) async throws {
            switch await connect.identity() {
            case .ready(let i): selfId = i.deviceId
            case .unsupported(let u): throw CloudConnectError.unsupported(u)
            case .refused(let r): throw CloudConnectError.refused(r)
            case .error(let c, let m): throw CloudConnectError.failed(code: c, message: m)
            }
            guard gen == generation else { throw CancellationError() }
            lanAttempt = o.lanAttemptSeconds
            lanFailed = nil
            relayReason = nil
            let reason = o.relay ? cloudConnectRelayWanted(await discovery()) : "host"
            guard gen == generation else { throw CancellationError() }
            let relayOn = reason == nil
            let src = ConnectLanSource.client(connect, now: now, applyTrust: applyTrust)
            if o.lan {
                do {
                    let svc = try await ConnectLanService.start(src, options: o.lanOptions)
                    guard gen == generation else {
                        await svc.stop()
                        throw CancellationError()
                    }
                    lan = svc
                    unsub.append(
                        svc.onSession { [weak self] s in
                            guard let self else { return }
                            Task { await self.inbound(s) }
                        })
                    unsub.append(svc.onNotice { [emit] n in emit.notice(n) })
                    unsub.append(
                        svc.onError { [weak self] e in
                            guard let self else { return }
                            Task { await self.lanProblem(e) }
                        })
                } catch let e as ConnectLanError {
                    guard gen == generation else { throw CancellationError() }
                    lanFailed = e
                    if !relayOn {
                        publish()
                        throw e
                    }
                }
            }
            if relayOn {
                let c = connect
                let r = ConnectRelayService(source: src, ticket: { await c.relayTicket() }, options: o.relayOptions)
                relay = r
                unsub.append(
                    r.onSession { [weak self] s in
                        guard let self else { return }
                        Task { await self.inbound(s) }
                    })
                unsub.append(r.onNotice { [emit] n in emit.notice(n) })
                unsub.append(
                    r.onState { [weak self] st in
                        guard let self else { return }
                        Task { await self.relayChanged(st) }
                    })
                await r.start()
                guard gen == generation else {
                    await r.stop()
                    throw CancellationError()
                }
                relayStatus = await r.status
            } else {
                relayReason = reason
            }
            guard gen == generation else { throw CancellationError() }
            running = true
            publish()
        }

        /// A `start()` is in flight (tests).
        var startInFlight: Bool { starting != nil }

        private func lanProblem(_ e: ConnectLanError) {
            lanFailed = e
            publish()
        }

        private func relayChanged(_ st: ConnectRelayStatus) {
            if relay == nil { return }
            relayStatus = st
            publish()
        }

        /// Close everything, including a start that is still in flight (which is awaited inside the bound, so a
        /// sign-out never leaves a service behind it). Returns after `timeout` whatever a transport is doing; what
        /// has not closed by then is force-cancelled (D-12).
        func stop(timeout: TimeInterval) async {
            if starting == nil && !running && lan == nil && relay == nil { return }
            stopping = true
            defer { stopping = false }
            await teardown(timeout: timeout, waitFor: starting)
        }

        private func teardown(timeout: TimeInterval, waitFor t: Task<Void, Error>?) async {
            generation += 1
            running = false
            for u in unsub { u() }
            unsub = []
            let (l, r) = (lan, relay)
            lan = nil
            relay = nil
            let open = Array(sessions.values)
            sessions = [:]
            relayStatus = nil
            publish()
            let closed = await connectBounded(timeout) {
                if let t { _ = try? await t.value }
                for s in open { await s.close() }
                await r?.stop()
                await l?.stop()
            }
            if !closed {
                // Not graceful, and not waited for: the listener, the browser and the relay socket go now, and
                // the services let go of the discovery key.
                l?.abort()
                r?.abort()
                t?.cancel()
            }
        }

        private func snapshot() -> [CloudPeer] {
            var out: [String: (Bool, Bool)] = [:]
            // Reads are cached below: the services are actors, so the snapshot is taken in `refresh`.
            for p in lanPeers { out[p.deviceId] = (true, false) }
            for d in relayMembers where d != selfId { out[d] = (out[d]?.0 ?? false, true) }
            return out.map { CloudPeer(deviceId: $0.key, lan: $0.value.0, relay: $0.value.1) }.sorted {
                $0.deviceId < $1.deviceId
            }
        }

        private var lanPeers: [ConnectLanPeer] = []
        private var relayMembers: [String] = []

        func peers() async -> [CloudPeer] {
            lanPeers = await lan?.currentPeers() ?? []
            relayMembers = await relay?.members() ?? []
            return snapshot()
        }

        func refreshPeers() async -> [CloudPeer] {
            if let r = relay { relayMembers = await r.refreshMembers() }
            lanPeers = await lan?.currentPeers() ?? []
            return snapshot()
        }

        func devices() async -> ConnectDevicesResult { await connect.listDevices() }

        func inbound(_ s: ConnectSession) async {
            if !running || !emit.inbound(s) {
                await s.close()  // nobody to hand it to (G9)
                return
            }
            track(s)
        }

        private func track(_ s: ConnectSession) {
            let id = ObjectIdentifier(s)
            sessions[id] = s
            s.onClose { [weak self] _ in
                guard let self else { return }
                Task { await self.untrack(id) }
            }
        }

        private func untrack(_ id: ObjectIdentifier) { sessions[id] = nil }

        func open(_ deviceId: String, relay relayOpt: Bool, lanAttempt attempt: TimeInterval?) async throws
            -> ConnectSession
        {
            if !running { throw ConnectLanError(.notStarted, "Cloud Connect is not started.") }
            let (lan, relay) = (self.lan, self.relay)
            let relayOK = relay != nil && relayOpt
            var lanError: Error?
            if let lan, let peer = await lan.currentPeers().first(where: { $0.deviceId == deviceId }) {
                let outcome = await Self.race(
                    attempt ?? lanAttempt, { try await lan.connect(peer) }, late: { await $0.close() })
                switch outcome {
                case .value(let s):
                    track(s)
                    return s
                case .failed(let e):
                    if !relayOK { throw e }
                    lanError = e
                case .timedOut:
                    let e = ConnectLanError(.connectFailed, "The LAN attempt took too long; trying the relay.")
                    if !relayOK { throw e }
                    lanError = e
                }
            }
            guard relayOK, let relay else {
                if let lanError { throw lanError }
                if relay == nil || !relayOpt {
                    throw ConnectLanError(
                        .unknownPeer, "That device was not found on this network, and the relay is off.")
                }
                throw ConnectRelayError(.notConnected, "The relay is not connected.")
            }
            let s = try await relay.dial(deviceId)
            track(s)
            return s
        }

        enum Race<T: Sendable>: Sendable {
            case value(T)
            case failed(Error)
            case timedOut
        }

        /// `op` against a deadline. A value that arrives after the deadline goes to `late` (the caller has moved on).
        static func race<T: Sendable>(
            _ seconds: TimeInterval, _ op: @escaping @Sendable () async throws -> T,
            late: @escaping @Sendable (T) async -> Void
        ) async -> Race<T> {
            await withCheckedContinuation { (c: CheckedContinuation<Race<T>, Never>) in
                let once = LockedValue(false)
                let claim: @Sendable () -> Bool = {
                    once.with {
                        let w = $0
                        $0 = true
                        return !w
                    }
                }
                Task {
                    do {
                        let v = try await op()
                        if claim() { c.resume(returning: .value(v)) } else { await late(v) }
                    } catch {
                        if claim() { c.resume(returning: .failed(error)) }
                    }
                }
                Task {
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    if claim() { c.resume(returning: .timedOut) }
                }
            }
        }
    }
#endif
