// Local links, `client.cloudConnect.localLinks` (CC-29.11; WIRE-CONTRACT-V5 §15.12): two devices of one app on one LAN pair by
// an 8-digit code or a QR with no account, and open sessions to each other later on that LAN. One device shows (`pair`,
// the responder), the other types or scans (`join`, the initiator); CPace turns the code into a key, mode `q` runs Noise
// over it, both people confirm, and each side stores a link in `pkey.connect.local.v1` (`LocalLinkState.swift`).
// Mirrors sdk-node's `connect/localLinks.ts`.
//
//   pair(_:)            show a code and a QR and wait for the other device (the responder)
//   join(_:)            type or scan the other device's code (the initiator)
//   list()              the links this device holds
//   rename(_:_:)        change the label on this device only; it is never sent
//   remove(_:)          forget a link: its keys and secret go, open sessions hear `peer_revoked`
//   setReachable(_:_:)  advertise the link's `m=l` name on the LAN (at most 8), or stop
//   open(_:)            a session to the peer, found by its advert on the LAN (no relay)
//   onLink(_:)          called with each session a local link opened to this device
//   localPairing()      the cached discovery answer the calls are gated on
//   dialsLeft(_:)       the dials a join of the code typed so far may still make (2, 1, 0, or nil)
//   onChange(_:)        called after the links or the gate changed; re-read `list()` and `localPairing()`
//
// Rules this file keeps:
//  - `pair`, `join` and every accept and dial need the cached discovery answer `localPairing: true` (§15.12 "Gates");
//    without it they throw the typed N/A `LocalPairingOff` (code `local-pairing-off`), and a read that clears it
//    closes the window and every join;
//  - one window per device and product, and a device that holds `maxLocalLinks` answers `local-links-full` before
//    anything is advertised or dialled (`cap` `stored`); the slot is taken before the first await;
//  - `open`, the `m=l` adverts and the mode-`l` answer need the same cached answer; a read that clears it withdraws the
//    adverts and ends the open sessions with `peer_bye`, and the links stay on disk, inert. Managing links (`list`,
//    `rename`, `remove`, `setReachable`) is never gated;
//  - the joiner's dials are counted per typed nameplate across joins, per product, in memory, and so are the nameplates
//    the shower's windows closed with in the last 300 s (a renewed window skips them) and the renewal floor (30 s
//    after a window ended `too-many-tries` or after a second wrong-code window within 10 minutes);
//  - a cancelled `join` throws `CancellationError`: it is never a failure, refunds no dial and zeroes the key material;
//  - `open` makes one dial per link at a time, waits 3 to 5 s after a dial that failed (doubled for each failure in a
//    row, up to 60 s), and adopts a session only once the link is known to be held;
//  - a session whose link is forgotten ends `peer_revoked`; a session with no handler is closed.

import Foundation
import PolarisKeyCore

#if canImport(Network)

    /// A dial to one link is not repeated sooner than this (seconds): a base, with jitter, doubled after each failure
    /// up to the cap.
    private let dialCooldownSeconds = 3.0
    private let dialCooldownJitterSeconds = 2.0
    private let dialBackoffCapSeconds = 60.0

    /// What a scanned QR's text is for this product (`LocalLinks.readQr`).
    package enum LocalQrRead: Sendable, Equatable {
        case thisProduct, otherProduct, notACode
    }

    public final class LocalLinks: Sendable {
        let core: LocalLinksCore

        init(connect: ConnectClient) {
            core = LocalLinksCore(connect: connect)
            // The gate moved or a link was forgotten: sessions that no longer have a footing end.
            let c = core
            _ = connect.localChanges.add { Task { await c.reconcile() } }
            // A read that took a cached `true` away: close the window, every join and every session.
            connect.localGateEffects.set { effects in
                if effects.contains(.closeWindows) || effects.contains(.endSessions) { Task { await c.closeAll() } }
            }
        }

        /// For the transfer service: every session a link opens or receives, and the peer key of a link that was
        /// removed.
        func hook(
            adopt: @escaping @Sendable (ConnectSession) -> Void, removed: @escaping @Sendable (Data) -> Void,
            takesSessions: @escaping @Sendable () -> Bool
        ) {
            core.hooks.adopt.set(adopt)
            core.hooks.removed.set(removed)
            core.hooks.takesSessions.set(takesSessions)
        }

        /// The cached discovery answer `services.connect.localPairing` (§15.9, §15.12): true only while the product's
        /// setting, `launch.localPairing` and the service are on. False before discovery.
        public func localPairing() -> Bool { core.connect.localPairing() }

        /// How many dials a join of the code typed so far may still make: 2, 1 or 0, from the first two digits alone;
        /// nil until the text (spaces and hyphens ignored) starts with two digits. It reads those two digits, keeps
        /// nothing and spends nothing.
        public func dialsLeft(_ text: String) -> Int? { core.dialsLeft(text) }

        /// What a scanned QR's text is for this product, judged locally (nothing is dialled or spent): a pairing code of
        /// this product's, another product's, or no pairing code at all.
        package func readQr(_ text: String) -> LocalQrRead {
            switch PeerLocal.parseQr(text, own: core.connect.core.product) {
            case .ok: return .thisProduct
            case .otherApp: return .otherProduct
            case .invalid: return .notACode
            }
        }

        /// Called after the links or the gate changed: a pairing was stored, a link was renamed, forgotten, re-marked
        /// or seen, or the `localPairing` answer flipped. It carries no data: read `list()` and `localPairing()`
        /// again. Returns the unsubscribe. Never gated: it works with the gate off and with no cached document.
        @discardableResult
        public func onChange(_ fn: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
            core.connect.localView.add(fn)
        }

        /// The local links this device holds. Listing is not gated. Throws `LocalPairingError` (`store-failed`) for
        /// an unreadable record.
        public func list() async throws -> [LocalLinkInfo] { try await core.list() }

        /// Show a code and a QR and wait for the other device (the responder). Throws `LocalPairingOff` while the gate
        /// is off, `LocalPairingError` (`local-links-full`, cap `stored`) at the cap, and `ConnectLanError` `badType`
        /// for options that break a rule or when this product already has a window open. The handle closes the window
        /// (`stop()`) and makes the next one (`renew()`); the window also closes by itself after `seconds` (at most
        /// 300), after the fifth failed guess, once a link is made and when the gate goes off, and `onEnd` says which.
        /// For 30 s after a window ended `too-many-tries`, or after the second window within 10 minutes that ended
        /// after a failed guess, it throws `peer-closed` with reason `cooldown`.
        public func pair(_ options: LocalPairOptions) async throws -> LocalPairHandle { try await core.pair(options) }

        /// Type or scan the other device's code (the initiator). Returns the link when both people confirmed and both
        /// devices stored it. Throws `LocalPairingError`:
        ///  - `pairing-code-failed`, reason `invalid` (the code did not parse), `otherApp` (the QR was not this app's),
        ///    `spent` (the dials for this code are spent) or `wrong` (an attempt failed after the other device answered);
        ///  - `pairing-not-found` (no matching advert in 15 s, or every attempt ended before an answer);
        ///  - `peer-closed`, reason `declined` (the other device said no), `timeout` or `closed`.
        /// `LocalPairingOff` and `local-links-full` (cap `stored`) are thrown before anything is browsed. Cancelling
        /// the task stops the browse, closes the dial and zeroes the key material, and throws `CancellationError`: it
        /// is no failure and refunds no dial.
        public func join(_ options: LocalJoinOptions) async throws -> LocalPaired { try await core.join(options) }

        /// Change a link's label on this device only; it is never sent. False when `id` names no link. Throws
        /// `ConnectLanError` `badType` for a label that is empty once cleaned or longer than 64.
        public func rename(_ id: String, _ label: String) async throws -> Bool { try await core.rename(id, label) }

        /// Advertise a link's `m=l` name on the LAN (at most 8 at once), or stop. False when `id` names no link. A new
        /// link is reachable already; turning a ninth on throws `LocalPairingError` (`local-links-full`). The adverts
        /// run while `cloudConnect.start()` does and the gate is on.
        public func setReachable(_ id: String, _ reachable: Bool) async throws -> Bool {
            try await core.setReachable(id, reachable)
        }

        /// Forget a link: its keys and secret leave the record before this returns, an open session under it is closed
        /// `peer_revoked`, a handshake in progress under it is closed before the host sees it, and the partial files
        /// kept for its peer are deleted. False when `id` names no link.
        public func remove(_ id: String) async throws -> Bool { try await core.remove(id) }

        /// Called with each session a local link opened to this device. Returns the unsubscribe.
        @discardableResult
        public func onLink(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
            core.listeners.add(fn)
        }

        /// A session to the peer of a link, found by its `m=l` advert on the LAN (mode `l`; the relay is never used).
        /// Throws `LocalPairingOff` while the gate is off, `ConnectLanError` `notStarted` before
        /// `cloudConnect.start()`, `unknownPeer` for an id that is no link or a peer not seen on this network,
        /// `busy` for a dial too soon after a failed one, and `handshakeFailed` when the peer does not answer under the
        /// link (it forgot it: "Not reachable").
        public func open(_ id: String) async throws -> ConnectSession { try await core.open(id) }

        /// Whether a link is held. @internal
        func has(_ id: String) async -> Bool { await core.has(id) }

        // MARK: Wiring (CloudConnect.start and stop)

        func attach(lan: ConnectLanService?) async { await core.attach(lan: lan) }
        func detach() async { await core.detach() }
    }

    final class LocalLinkHooks: Sendable {
        let adopt = LockedValue<(@Sendable (ConnectSession) -> Void)?>(nil)
        let removed = LockedValue<(@Sendable (Data) -> Void)?>(nil)
        /// Whether something else (Direct Transfer's offer handler) takes sessions when no `onLink` listener does.
        let takesSessions = LockedValue<(@Sendable () -> Bool)?>(nil)
    }

    /// A join in flight: stopped by a read that clears the gate or by the host's cancel, even before its first await
    /// returns. The first reason stays.
    private final class JoinHandle: @unchecked Sendable {
        let lock = NSLock()
        var why: LocalJoinStop?
        var joiner: LocalJoiner?

        /// Record `w` (the first wins) and answer the joiner, if it exists yet.
        func stop(_ w: LocalJoinStop) -> LocalJoiner? {
            lock.withLock {
                if why == nil { why = w }
                return joiner
            }
        }
    }

    actor LocalLinksCore {
        nonisolated let connect: ConnectClient
        nonisolated let listeners = LinkListeners()
        nonisolated let hooks = LocalLinkHooks()
        private var lan: ConnectLanService?
        private var unsub: [@Sendable () -> Void] = []
        private var sessions: [ObjectIdentifier: ConnectSession] = [:]
        private var shower: LocalShower?
        /// The window that is being opened: the slot is taken before the first await.
        private var starting = false
        /// Bumped by `closeAll`: a window that began opening before it must not outlive it.
        private var epoch = 0
        private var joins: [ObjectIdentifier: JoinHandle] = [:]
        /// One dial per link at a time: a second `open` for the same link joins it.
        private var dials: [String: Task<ConnectSession, Error>] = [:]
        /// Per link: no dial before `until` (monotonic seconds), and the failures in a row.
        private var cool: [String: (until: TimeInterval, fails: Int)] = [:]
        nonisolated let mono: @Sendable () -> TimeInterval
        private let jitter: @Sendable () -> Double

        init(
            connect: ConnectClient,
            mono: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
            jitter: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
        ) {
            self.connect = connect
            self.mono = mono
            self.jitter = jitter
        }

        /// The dials left for the typed text; the clock is the one the dial cooldown uses.
        nonisolated func dialsLeft(_ text: String) -> Int? {
            LocalDialBudgets.of(connect.core.product).dialsLeft(text, mono())
        }

        private func requireOn(_ what: String) throws {
            if !connect.localPairing() { throw LocalPairingOff(what) }
        }

        private func source() async throws -> LocalSource {
            let c = connect
            let store: LocalLinkStore
            do { store = try await c.localLinkStore() } catch {
                throw LocalPairingError(ErrorCode.storeFailed, "The local links could not be used.")
            }
            return LocalSource(
                slug: c.core.product, now: { Int(Date().timeIntervalSince1970) }, allowed: { c.localPairing() },
                store: store, notify: { c.notifyLocals() })
        }

        func list() async throws -> [LocalLinkInfo] {
            ConnectLocals.info(try await source().store.rows())
        }

        func has(_ id: String) async -> Bool {
            guard let rows = try? await source().store.rows() else { return false }
            return rows.contains { $0.id == id }
        }

        func pair(_ o: LocalPairOptions) async throws -> LocalPairHandle {
            try requireOn("pair")
            try checkLocalOptions(o.base)
            guard o.seconds > 0 else { throw ConnectLanError(.badType, "seconds must be above 0.") }
            let first = try await window(o, replacing: nil)
            await first.reveal()
            return LocalPairHandle(
                first,
                again: { [weak self] cur in
                    guard let self else { throw ConnectLanError(.closed, "The window closed.") }
                    return try await self.window(o, replacing: cur)
                })
        }

        /// Open a window; `replacing` is the one a renewal closes first (it makes no `onEnd`). The slot is taken before
        /// the first await and kept across the replacement.
        private func window(_ o: LocalPairOptions, replacing: LocalShower?) async throws -> LocalShower {
            try requireOn("pair")
            if starting || (shower?.isOpenFlag.current == true && shower !== replacing) {
                throw ConnectLanError(.badType, "A pairing window is already open.")
            }
            starting = true
            defer { starting = false }
            let mine = epoch
            let src = try await source()
            if try await src.store.count() >= maxLocalLinks {
                throw LocalPairingError(
                    ErrorCode.localLinksFull, "This device holds the most local links it can.", cap: .stored)
            }
            await replacing?.close(nil)
            // The SDK's floor under new windows (after a hard end, 30 s), checked once the window a renewal replaces
            // has ended and been counted.
            let floors = LocalRenewFloors.of(src.slug)
            let floor = floors.check((o.base.mono ?? mono)())
            if !floor.allowed {
                throw LocalPairingError(
                    ErrorCode.peerClosed,
                    "Too many failed tries. Wait \(floor.retryIn) s before opening another window.",
                    reason: .cooldown)
            }
            let s = try await LocalShower.start(
                src, o, nameplates: LocalNameplates.of(src.slug), floors: floors,
                onEnd: { [weak self] in Task { await self?.showerEnded() } })
            shower = s
            // The gate was cleared while the window was opening: it closes before anyone sees a code.
            if mine != epoch || !connect.localPairing() {
                await s.close(.off)
                throw LocalPairingOff("pair")
            }
            return s
        }

        private func showerEnded() {
            if let s = shower, !s.isOpenFlag.current { shower = nil }
        }

        func join(_ o: LocalJoinOptions) async throws -> LocalPaired {
            try requireOn("join")
            try checkLocalOptions(o.base)
            if (o.code == nil) == (o.qr == nil) {
                throw ConnectLanError(.badType, "Give exactly one of code and qr.")
            }
            guard o.browseSeconds > 0 else { throw ConnectLanError(.badType, "browseSeconds must be above 0.") }
            // Cancelled before the call: nothing is browsed, dialled or spent.
            try Task.checkCancellation()
            // Registered before the first await, so a gate-clearing read or a cancel can stop it.
            let handle = JoinHandle()
            let key = ObjectIdentifier(handle)
            joins[key] = handle
            defer { joins[key] = nil }
            do {
                return try await withTaskCancellationHandler {
                    try await self.runJoin(o, handle)
                } onCancel: {
                    if let j = handle.stop(.cancelled) { Task { await j.cancel(.cancelled) } }
                }
            } catch {
                // The host's cancel is a `CancellationError` whatever the join was doing when it noticed.
                if handle.lock.withLock({ handle.why }) == .cancelled { throw CancellationError() }
                throw error
            }
        }

        private func runJoin(_ o: LocalJoinOptions, _ handle: JoinHandle) async throws -> LocalPaired {
            let src = try await source()
            if try await src.store.count() >= maxLocalLinks {
                throw LocalPairingError(
                    ErrorCode.localLinksFull, "This device holds the most local links it can.", cap: .stored)
            }
            if let why = handle.lock.withLock({ handle.why }) {
                if why == .cancelled { throw CancellationError() }
                throw LocalPairingOff("join")
            }
            if !connect.localPairing() { throw LocalPairingOff("join") }
            let j = LocalJoiner(src, LocalDialBudgets.of(src.slug), o)
            if let why = handle.lock.withLock({ () -> LocalJoinStop? in
                handle.joiner = j
                return handle.why
            }) {
                await j.cancel(why)
            }
            return try await j.run()
        }

        // MARK: Managing links

        func rename(_ id: String, _ label: String) async throws -> Bool {
            guard let clean = PeerLocal.cleanLabel(label), label.unicodeScalars.count <= 64 else {
                throw ConnectLanError(.badType, "The label is not valid.")
            }
            return try await change(id) { r, _ in
                var r = r
                r.label = clean
                return r
            } == .found
        }

        func setReachable(_ id: String, _ reachable: Bool) async throws -> Bool {
            var refused = false
            let outcome = try await change(id) { r, rows in
                // At most `maxLiveLocalAdverts` links are advertised: a ninth is refused, not left silently unadvertised
                // (§15.12, "Reachable by default").
                if reachable && !r.reachable && rows.filter(\.reachable).count >= maxLiveLocalAdverts { return nil }
                var r = r
                r.reachable = reachable
                return r
            }
            if outcome == .refused { refused = true }
            if refused {
                throw LocalPairingError(
                    ErrorCode.localLinksFull,
                    "Eight local links are already reachable on this network; turn one off first.", cap: .reachable)
            }
            return outcome == .found
        }

        private enum Changed: Sendable { case found, missing, refused }

        /// `f` answers the row's new value, or nil to refuse the change.
        private func change(_ id: String, _ f: @escaping @Sendable (LocalLinkRow, [LocalLinkRow]) -> LocalLinkRow?)
            async throws -> Changed
        {
            let store = try await source().store
            let outcome = try await store.update { rows -> (next: [LocalLinkRow]?, result: Changed) in
                guard rows.contains(where: { $0.id == id }) else { return (nil, .missing) }
                var refused = false
                let next = rows.map { r -> LocalLinkRow in
                    guard r.id == id else { return r }
                    guard let v = f(r, rows) else {
                        refused = true
                        return r
                    }
                    return v
                }
                return refused ? (nil, .refused) : (next, .found)
            }
            if outcome == .found { connect.notifyLocals() }
            return outcome
        }

        func remove(_ id: String) async throws -> Bool {
            let store = try await source().store
            let gone = try await store.update { rows -> (next: [LocalLinkRow]?, result: [Data]) in
                guard let hit = rows.first(where: { $0.id == id }) else { return (nil, []) }
                return (rows.filter { $0.id != id }, [Base64URL.decode(hit.peerKey) ?? Data()])
            }
            if gone.isEmpty { return false }
            // The listener drops the link before this returns: a dial or a handshake that starts after `await remove()`
            // cannot use it.
            await lan?.forgetLocal(id)
            connect.notifyLocals()
            await reconcile()
            for k in gone { hooks.removed.current?(k) }
            return true
        }

        // MARK: Wiring

        func attach(lan: ConnectLanService?) async {
            await detach()
            self.lan = lan
            if let lan {
                unsub.append(
                    lan.onLocalSession { [weak self] s in
                        guard let self else { return }
                        Task { await self.inbound(s) }
                    })
            }
        }

        func detach() async {
            for u in unsub { u() }
            unsub = []
            lan = nil
            let mine = Array(sessions.values)
            for s in mine { await s.close(.peerBye) }
            // Only what this call ended: a session of a newer attach is left alone.
            for s in mine { sessions[ObjectIdentifier(s)] = nil }
        }

        private func inbound(_ s: ConnectSession) async {
            // The handshake may have begun before the link was forgotten or the gate went off: the session is delivered
            // only while the link (same secret) is held and the gate is on.
            guard await stillHeld(s) else { return }
            // A session nobody will take is closed (G9): no `onLink` listener and no transfer handler.
            if listeners.isEmpty && !(hooks.takesSessions.current?() ?? false) {
                await s.close(.peerBye)
                return
            }
            track(s)
            listeners.fire(s)
        }

        private func track(_ s: ConnectSession) {
            let id = ObjectIdentifier(s)
            sessions[id] = s
            hooks.adopt.current?(s)
            s.onClose { [weak self] _ in
                guard let self else { return }
                Task { await self.untrack(id) }
            }
        }

        private func untrack(_ id: ObjectIdentifier) { sessions[id] = nil }

        /// Close `s` (`peer_revoked`, or `peer_bye` when the gate is off) unless its link is still held.
        private func stillHeld(_ s: ConnectSession) async -> Bool {
            guard let ref = s.local else { return true }
            let on = connect.localPairing()
            if on, let store = try? await source().store, let rows = try? await store.rows(),
                rows.contains(where: {
                    $0.id == ref.id && PeerLocal.linkTag(secret: Base64URL.decode($0.secret) ?? Data()) == ref.tag
                })
            {
                return true
            }
            await s.close(on ? .peerRevoked : .peerBye)
            return false
        }

        /// The gate or the list moved: a closed gate ends every session (`peer_bye`), a forgotten link's ends
        /// `peer_revoked`.
        func reconcile() async {
            if sessions.isEmpty { return }
            if !connect.localPairing() {
                for s in Array(sessions.values) { await s.close(.peerBye) }
                return
            }
            let held = Set(
                ((try? await source().store.rows()) ?? []).map {
                    "\($0.id)|\(PeerLocal.linkTag(secret: Base64URL.decode($0.secret) ?? Data()))"
                })
            for s in Array(sessions.values) {
                if let l = s.local, !held.contains("\(l.id)|\(l.tag)") { await s.close(.peerRevoked) }
            }
        }

        /// The gate was cleared by a discovery read: close the window and every join, and end every open session with
        /// `peer_bye` (§15.12 "Gates"). The adverts are withdrawn by the LAN service, which the client tells at the same
        /// time.
        func closeAll() async {
            epoch += 1
            for j in Array(joins.values) { await j.stop(.closed)?.cancel(.closed) }
            await shower?.close(.off)
            for s in Array(sessions.values) { await s.close(.peerBye) }
        }

        // MARK: open

        func open(_ id: String) async throws -> ConnectSession {
            // One dial per link at a time; a caller that comes while one runs gets the same session.
            if let live = dials[id] { return try await live.value }
            let run = Task { try await self.dial(id) }
            dials[id] = run
            defer { if dials[id] == run { dials[id] = nil } }
            return try await run.value
        }

        private func dial(_ id: String) async throws -> ConnectSession {
            try requireOn("open")
            guard let rows = try? await source().store.rows(), rows.contains(where: { $0.id == id }) else {
                throw ConnectLanError(.unknownPeer, "That is not a local link on this device.")
            }
            guard let lan else { throw ConnectLanError(.notStarted, "Cloud Connect is not started.") }
            // A dial that failed is not repeated at once, and the wait grows with each failure in a row: a peer that
            // closes on a message 1 (it is busy, or it forgot the link) is not hammered.
            let cooling = cool[id]
            if let c = cooling, mono() < c.until {
                throw ConnectLanError(.busy, "That device did not answer a moment ago; try again shortly.")
            }
            let s: ConnectSession
            do {
                s = try await lan.connectLocal(id)
            } catch {
                // The gate was cleared while the dial ran.
                if !connect.localPairing() { throw LocalPairingOff("open") }
                // Only a dial that reached the network is held off: "not seen yet" is no attempt.
                var reached = true
                if let e = error as? ConnectLanError, [.unknownPeer, .notStarted, .notListening].contains(e.reason) {
                    reached = false
                }
                if !reached { throw error }
                let fails = (cooling?.fails ?? 0) + 1
                let base = dialCooldownSeconds + dialCooldownJitterSeconds * jitter()
                cool[id] = (mono() + min(dialBackoffCapSeconds, base * pow(2, Double(fails - 1))), fails)
                throw error
            }
            cool[id] = nil
            // Adopted (Direct Transfer takes it) and tracked only once the link is known to be held.
            guard await stillHeld(s) else {
                if !connect.localPairing() { throw LocalPairingOff("open") }
                throw ConnectLanError(.unknownPeer, "That link was removed.")
            }
            track(s)
            return s
        }
    }
#endif
