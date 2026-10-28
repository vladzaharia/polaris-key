// The LAN half of Cloud Connect (CC-11.12; WIRE-CONTRACT-V5 §15.4 to §15.6): advertise this device
// under the account instance name, browse for the person's other devices, accept inbound TCP and dial.
// Mirrors sdk-node's `connect/lan.ts` and the Python port's `connect/lan.py`.
//
// Rules this file keeps:
//  - the advert is `p1-` plus HMAC(K_disc, epoch, deviceId) with `v=1`, `m=a` and nothing else; it is
//    renewed at every 15-minute epoch boundary and when K_disc changes, and uses only the newest key (G4);
//  - a browse hit is kept only if it matches a roster device (never this one) under the current or
//    previous epoch and either delivered key; the match is one dictionary lookup (`ConnectBrowseIndex`),
//    and a name that does not match never enters the browse table;
//  - the listener starts a handshake only when this device holds a verified identity. A failed tag closes
//    the socket without a word (G2, in the engine);
//  - unauthenticated sockets are bounded (G7): 32 in total and 4 per address are the listener's
//    (`BonjourListener`); the 30 s and 16 KiB limits are `PeerLink`'s; a socket stops counting when its
//    session is admitted (`markAuthenticated`);
//  - the device dials only RFC 1918, fe80::/10 and fc00::/7 addresses (loopback only on opt-in, for tests),
//    checked on the connected path before the first byte (G6, D-10); the certificate's device must be the
//    one dialled, or the session closes `wrong_peer` (G8);
//  - the X25519 private key never leaves the key port (G1): the channel gets `PeerSource.staticKey`;
//  - Local Network refused is `ConnectLanReason.permissionDenied` (`nearby-permission-denied`, D-8);
//  - the identity load and every client call are `async`: nothing blocks a thread.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

#if canImport(Network)
    import Network

    public let connectLanMaxSessions = 64
    private let identityTtlSeconds = 30
    private let certMarginSeconds = 60

    /// Browse names to roster devices: one dictionary per (15-minute epoch, key pair, roster), so a
    /// forged `p1-` name costs one lookup and no HMAC. Rebuilt (at most 2 epochs x 2 keys x 127 devices
    /// = 508 HMACs) when the epoch, the keys or the roster change. First match wins in the order
    /// current epoch, newest key, roster order.
    final class ConnectBrowseIndex: Sendable {
        struct Hit: Equatable, Sendable {
            let deviceId: String
            /// 0 the current epoch, 1 the previous one.
            let epochBack: Int
            /// 0 the newest discovery key, 1 the previous one.
            let keyIndex: Int
        }
        typealias NameFn = @Sendable (_ key: Data, _ epoch: Int, _ deviceId: String) throws -> String

        private struct Built {
            var epoch: Int
            var table: [String: ConnectBrowseIndex.Hit]
        }
        private struct State {
            var keys: [Data] = []
            var roster: [String] = []
            var loaded = false
            var built: Built?
        }
        private let state = LockedValue(State())
        private let name: NameFn
        /// How many times the dictionary was built (a test reads it).
        let builds = LockedValue(0)

        init(
            name: @escaping NameFn = { try PeerAdvert.accountInstance(discoveryKey: $0, epoch: $1, deviceId: $2) }
        ) { self.name = name }

        /// The identity just loaded; a change of keys or roster drops the dictionary.
        @discardableResult
        func update(_ ident: PeerSource) -> Bool {
            update(keys: ident.keys.all.map(\.bytes), roster: ident.roster.filter { $0 != ident.deviceId })
        }

        @discardableResult
        func update(keys: [Data], roster: [String]) -> Bool {
            state.with { s in
                if s.loaded && s.keys == keys && s.roster == roster { return false }
                s.keys = keys
                s.roster = roster
                s.loaded = true
                s.built = nil
                return true
            }
        }

        /// Forget the keys and the dictionary (stop and abort).
        func clear() {
            state.with { s in
                s.keys = []
                s.roster = []
                s.loaded = false
                s.built = nil
            }
        }

        /// True while the index holds discovery-key bytes (a test reads it).
        var holdsKeys: Bool { state.with { !$0.keys.isEmpty || $0.built != nil } }

        func lookup(_ instance: String, now: Int) -> Hit? {
            guard PeerAdvert.isInstanceName(instance) else { return nil }
            return state.with { s in
                guard s.loaded else { return nil }
                ensure(&s, now: now)
                return s.built?.table[instance]
            }
        }

        /// Bring the dictionary to `now`'s epoch; true when it had to be rebuilt (a new epoch counts), so the
        /// caller re-runs the browse filter.
        func refresh(now: Int) -> Bool {
            state.with { s in
                guard s.loaded else { return false }
                return ensure(&s, now: now)
            }
        }

        @discardableResult
        private func ensure(_ s: inout State, now: Int) -> Bool {
            let epoch = peerAdvertEpoch(now)
            if s.built?.epoch == epoch { return false }
            var table: [String: Hit] = [:]
            for epochBack in 0...1 {
                for (i, key) in s.keys.prefix(2).enumerated() {
                    for deviceId in s.roster.prefix(128) {
                        guard let n = try? name(key, epoch - epochBack, deviceId), table[n] == nil else { continue }
                        table[n] = Hit(deviceId: deviceId, epochBack: epochBack, keyIndex: i)
                    }
                }
            }
            s.built = Built(epoch: epoch, table: table)
            builds.with { $0 += 1 }
            return true
        }
    }

    /// A counter every holder of a cached identity reads: it moves when the identity changes anywhere (a refresh,
    /// a pushed roster, a sign-out), so the LAN and relay services drop their 30 s copies together (N8).
    public final class ConnectIdentityEpoch: Sendable {
        private let n = LockedValue(0)
        public init() {}
        public var value: Int { n.current }
        public func bump() { n.with { $0 &+= 1 } }
    }

    /// What the LAN service needs of the client. `load` reads the held identity (it may touch the key store);
    /// `now` is epoch seconds. `refresh` asks the Worker for a newer roster (throws on failure); `adoptRing`
    /// stores a roster a peer pushed and `applyTrust` applies a trust manifest a peer pushed: each may be nil
    /// (the document is then refused as `unsupported`).
    public struct ConnectLanSource: Sendable {
        public var load: @Sendable () async throws -> PeerSource
        public var now: @Sendable () -> Int
        public var refresh: (@Sendable () async throws -> Void)?
        public var adoptRing: (@Sendable (String) async -> RingAdoption)?
        public var applyTrust: (@Sendable (String) async -> PeerTrustResult)?
        /// Moves when the identity changes; the services share it so one's change reaches the other.
        public var changes: ConnectIdentityEpoch

        public init(
            load: @escaping @Sendable () async throws -> PeerSource, now: @escaping @Sendable () -> Int,
            refresh: (@Sendable () async throws -> Void)? = nil,
            adoptRing: (@Sendable (String) async -> RingAdoption)? = nil,
            applyTrust: (@Sendable (String) async -> PeerTrustResult)? = nil,
            changes: ConnectIdentityEpoch = ConnectIdentityEpoch()
        ) {
            self.load = load
            self.now = now
            self.refresh = refresh
            self.adoptRing = adoptRing
            self.applyTrust = applyTrust
            self.changes = changes
        }

        /// The source over a `ConnectClient`. `applyTrust` is the host's trust custodian.
        public static func client(
            _ c: ConnectClient, now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
            applyTrust: (@Sendable (String) async -> PeerTrustResult)? = nil
        ) -> ConnectLanSource {
            ConnectLanSource(
                load: { try await c.peerSource() }, now: now,
                refresh: {
                    guard case .ready = await c.identity(refresh: true) else {
                        throw ConnectLanError(.noIdentity, "The identity could not be refreshed.")
                    }
                },
                adoptRing: { await c.adoptRing($0) }, applyTrust: applyTrust, changes: c.identityChanges)
        }
    }

    /// Where the LAN service gets its network: a TCP listener, the advert, browse and dial. The system one
    /// is `SystemConnectLanNetwork`; a test supplies loopback TCP with a fake directory.
    public protocol ConnectLanNetwork: Sendable {
        /// Listen on a random port; each ready inbound connection goes to `onPipe`.
        func listen(
            onPipe: @escaping @Sendable (NWPipe) -> Void, onEvent: @escaping @Sendable (BonjourListenerEvent) -> Void
        ) async throws -> UInt16
        /// Register (or replace, or with nil withdraw) the `_pkeypeer._tcp` service for the listener.
        func advertise(_ advert: BonjourAdvert?) async
        /// Browse; returns the stop. Throws `BonjourBrowseError` when browsing cannot begin.
        func browse(
            onUp: @escaping @Sendable (BonjourFound) -> Void, onDown: @escaping @Sendable (String) -> Void,
            onError: @escaping @Sendable (BonjourBrowseError) -> Void
        ) throws -> @Sendable () -> Void
        /// Connect; the pipe is handed back only after the address passed the dial policy.
        func dial(_ endpoint: BonjourEndpoint) async throws -> NWPipe
        func stop() async
        /// The roster or keys changed: offer the browser's current results to the name filter again.
        func rescan()
    }

    extension ConnectLanNetwork {
        public func rescan() {}
    }

    /// The OS network: `NWListener`, `NWBrowser` and `NWConnection` through `PolarisKeyPlatform`.
    public final class SystemConnectLanNetwork: ConnectLanNetwork, @unchecked Sendable {
        private let listener: BonjourListener
        private let browseOptions: BonjourBrowseOptions
        private let dialOptions: BonjourDialOptions
        private let browseAccept: (@Sendable (String) -> Bool)?
        private let browsing = LockedValue<BonjourBrowse?>(nil)

        /// `peerToPeer` is AWDL (D-5), off by default. `allowLoopback` is for tests and same-host use.
        public convenience init(peerToPeer: Bool = false, allowLoopback: Bool = false) {
            self.init(peerToPeer: peerToPeer, allowLoopback: allowLoopback, accept: nil)
        }

        /// `accept` keeps a browse name out of the table unless it matches a roster device.
        init(peerToPeer: Bool, allowLoopback: Bool, accept: (@Sendable (String) -> Bool)?) {
            listener = BonjourListener(peerToPeer: peerToPeer, policy: BonjourDialPolicy(allowLoopback: allowLoopback))
            browseAccept = accept
            browseOptions = BonjourBrowseOptions(peerToPeer: peerToPeer)
            dialOptions = BonjourDialOptions(
                policy: BonjourDialPolicy(allowLoopback: allowLoopback), peerToPeer: peerToPeer)
        }

        public func listen(
            onPipe: @escaping @Sendable (NWPipe) -> Void, onEvent: @escaping @Sendable (BonjourListenerEvent) -> Void
        ) async throws -> UInt16 {
            try await listener.start(advert: nil, onPipe: onPipe, onEvent: onEvent)
        }

        public func advertise(_ advert: BonjourAdvert?) async { listener.update(advert: advert) }

        public func browse(
            onUp: @escaping @Sendable (BonjourFound) -> Void, onDown: @escaping @Sendable (String) -> Void,
            onError: @escaping @Sendable (BonjourBrowseError) -> Void
        ) throws -> @Sendable () -> Void {
            let b = BonjourBrowse(options: browseOptions, accept: browseAccept)
            try b.start(onUp: onUp, onDown: onDown, onError: onError)
            browsing.set(b)
            return { [browsing] in
                browsing.set(nil)
                b.stop()
            }
        }

        public func dial(_ endpoint: BonjourEndpoint) async throws -> NWPipe {
            try await BonjourPipes.dial(endpoint, options: dialOptions)
        }

        public func stop() async { listener.stop() }

        public func rescan() { browsing.current?.rescan() }
    }

    /// `NWPipe` as the engine's byte pipe.
    struct LanPipe: PeerBytePipe {
        let pipe: NWPipe
        var remoteAddress: String { pipe.remoteAddress }
        func read() async throws -> Data? { try await pipe.read() }
        func write(_ bytes: Data) async throws { try await pipe.write(bytes) }
        func close() async { await pipe.close() }
    }

    public struct ConnectLanOptions: Sendable {
        public var caps: [String]
        public var label: String?
        public var advertise: Bool
        public var browse: Bool
        /// Accept and dial 127.0.0.0/8 and ::1: tests and same-host use only. Ignored when `network` is given.
        public var allowLoopback: Bool
        /// Browse and advertise over AWDL too (D-5). Off by default. Ignored when `network` is given.
        public var peerToPeer: Bool
        public var network: (any ConnectLanNetwork)?
        public var maxSessions: Int
        public var rekeyMessages: Int?
        public var rekeySeconds: TimeInterval?
        public var handshakeSeconds: TimeInterval
        /// Schedule `fn` after `seconds`; returns the cancel. Default: a `Task` sleep.
        public var timer: ConnectPeerDocs.Timer?

        public init(
            caps: [String] = ["app/1"], label: String? = nil, advertise: Bool = true, browse: Bool = true,
            allowLoopback: Bool = false, peerToPeer: Bool = false, network: (any ConnectLanNetwork)? = nil,
            maxSessions: Int = connectLanMaxSessions, rekeyMessages: Int? = nil, rekeySeconds: TimeInterval? = nil,
            handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds, timer: ConnectPeerDocs.Timer? = nil
        ) {
            self.caps = caps
            self.label = label
            self.advertise = advertise
            self.browse = browse
            self.allowLoopback = allowLoopback
            self.peerToPeer = peerToPeer
            self.network = network
            self.maxSessions = maxSessions
            self.rekeyMessages = rekeyMessages
            self.rekeySeconds = rekeySeconds
            self.handshakeSeconds = handshakeSeconds
            self.timer = timer
        }
    }

    /// A roster device seen on the network.
    public struct ConnectLanPeer: Sendable, Equatable {
        public let deviceId: String
        public let endpoint: BonjourEndpoint
    }

    private final class Subscribers<T>: Sendable where T: Sendable {
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
        func fire(_ v: T) {
            let fns = state.with { $0.fns.map(\.1) }
            for f in fns { f(v) }
        }
    }

    private final class Hook: Sendable {
        private let fn = LockedValue<(@Sendable () -> Void)?>(nil)
        func set(_ f: @escaping @Sendable () -> Void) { fn.set(f) }
        func fire() { fn.current?() }
    }

    public actor ConnectLanService: CustomStringConvertible, CustomReflectable {
        private let src: ConnectLanSource
        private let o: ConnectLanOptions
        private let network: any ConnectLanNetwork
        private let docs: ConnectPeerDocs
        private let timer: ConnectPeerDocs.Timer
        private let peerSubs = Subscribers<ConnectLanPeer>()
        private let sessionSubs = Subscribers<ConnectSession>()
        private let errorSubs = Subscribers<ConnectLanError>()

        private var stopped = false
        private var listening = false
        private var port: UInt16 = 0
        private var held: (at: Int, gen: Int, src: PeerSource)?
        private var advName = ""
        private var stopBrowse: (@Sendable () -> Void)?
        /// The browser's stop, readable without the actor, for `abort()`.
        private let browseStop = LockedValue<(@Sendable () -> Void)?>(nil)
        private var cancelEpoch: (@Sendable () -> Void)?
        private var peers: [String: (peer: ConnectLanPeer, instance: String)] = [:]
        nonisolated let index: ConnectBrowseIndex
        private var pending: [ObjectIdentifier: NWPipe] = [:]
        private var sessions: [ObjectIdentifier: ConnectSession] = [:]

        private init(_ src: ConnectLanSource, _ o: ConnectLanOptions) {
            self.src = src
            self.o = o
            let index = ConnectBrowseIndex()
            self.index = index
            let now = src.now
            network =
                o.network
                ?? SystemConnectLanNetwork(
                    peerToPeer: o.peerToPeer, allowLoopback: o.allowLoopback,
                    accept: { index.lookup($0, now: now()) != nil })
            timer =
                o.timer ?? { s, fn in
                    let t = Task {
                        try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
                        if !Task.isCancelled { fn() }
                    }
                    return { t.cancel() }
                }
            let hook = Hook()
            docs = ConnectPeerDocs(
                source: ConnectPeerDocsSource(
                    now: src.now, refresh: src.refresh, adoptRing: src.adoptRing, applyTrust: src.applyTrust),
                onStored: { hook.fire() })
            hook.set { [weak self] in
                guard let self else { return }
                Task { await self.stored() }
            }
        }

        public nonisolated var description: String { "ConnectLanService()" }
        public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

        // MARK: Lifecycle

        /// Listen, then advertise and browse. Throws `ConnectLanError`: `noIdentity`, `noKeys`, `permissionDenied`,
        /// `notConfigured`, `notListening`.
        public static func start(_ src: ConnectLanSource, options: ConnectLanOptions = ConnectLanOptions()) async throws
            -> ConnectLanService
        {
            let s = ConnectLanService(src, options)
            do {
                try await s.begin()
            } catch {
                await s.stop()
                throw error
            }
            return s
        }

        private func begin() async throws {
            _ = try await identity(force: true)
            do {
                port = try await network.listen(
                    onPipe: { [weak self] pipe in
                        guard let self else { return }
                        Task { await self.accepted(pipe) }
                    },
                    onEvent: { [weak self, errorSubs] e in
                        switch e {
                        case .failed(let b): errorSubs.fire(Self.lanError(b))
                        case .withdrawn:
                            // Withdrawn, never kept under another name: say so, and advertise afresh next rotation.
                            errorSubs.fire(
                                ConnectLanError(
                                    .registrationRenamed, "The OS registered the advert under another name."))
                            if let self { Task { await self.advertWithdrawn() } }
                        case .registered: break
                        }
                    })
            } catch let e as BonjourPipeError {
                throw Self.lanError(e)
            }
            listening = true
            if o.advertise { try await rotate() }
            if o.browse && !o.advertise { armEpoch(src.now()) }
            if o.browse {
                do {
                    stopBrowse = try network.browse(
                        onUp: { [weak self] f in
                            guard let self else { return }
                            Task { await self.found(f) }
                        },
                        onDown: { [weak self] n in
                            guard let self else { return }
                            Task { await self.gone(n) }
                        },
                        onError: { [errorSubs] e in errorSubs.fire(Self.lanError(e)) })
                    browseStop.set(stopBrowse)
                } catch let e as BonjourBrowseError {
                    throw Self.lanError(e)
                }
            }
        }

        public func listenPort() -> UInt16 { port }

        /// Roster devices seen on the network right now.
        public func currentPeers() -> [ConnectLanPeer] { peers.values.map(\.peer) }

        /// Called for each pushed `RING` or `TRUST` once it is stored, applied or refused.
        @discardableResult
        public nonisolated func onNotice(_ fn: @escaping @Sendable (ConnectNotice) -> Void) -> @Sendable () -> Void {
            docs.onNotice(fn)
        }

        @discardableResult
        public nonisolated func onPeer(_ fn: @escaping @Sendable (ConnectLanPeer) -> Void) -> @Sendable () -> Void {
            peerSubs.add(fn)
        }

        /// Called for each inbound session once it is open and admitted.
        @discardableResult
        public nonisolated func onSession(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
            sessionSubs.add(fn)
        }

        /// Called when the OS reports a problem after start (Local Network refused, a failed listener).
        @discardableResult
        public nonisolated func onError(_ fn: @escaping @Sendable (ConnectLanError) -> Void) -> @Sendable () -> Void {
            errorSubs.add(fn)
        }

        public func stop() async {
            if stopped { return }
            stopped = true
            docs.close()
            cancelEpoch?()
            cancelEpoch = nil
            stopBrowse?()
            stopBrowse = nil
            for p in pending.values { await p.close() }
            pending = [:]
            for s in sessions.values { await s.close() }
            sessions = [:]
            held = nil
            index.clear()
            await network.stop()
        }

        /// Force-stop for a sign-out that cannot wait (D-12): cancel the listener and the browser now, with no
        /// graceful close and no await on the actor, then drop the sessions and the held identity.
        public nonisolated func abort() {
            browseStop.with { v in
                v?()
                v = nil
            }
            docs.close()
            index.clear()
            let net = network
            Task { await net.stop() }
            Task { await self.abortInActor() }
        }

        private func abortInActor() {
            stopped = true
            listening = false
            held = nil
            cancelEpoch?()
            cancelEpoch = nil
            stopBrowse = nil
            peers = [:]
            let (p, s) = (Array(pending.values), Array(sessions.values))
            pending = [:]
            sessions = [:]
            for x in p { Task { await x.close() } }
            for x in s { Task { await x.close() } }
        }

        // MARK: Errors

        static func lanError(_ e: BonjourBrowseError) -> ConnectLanError {
            switch e {
            case .permissionDenied: return ConnectLanError(.permissionDenied, "Local Network access was refused.")
            case .notConfigured:
                return ConnectLanError(.notConfigured, "The app's Info.plist lacks the Local Network entries.")
            case .unavailable: return ConnectLanError(.notListening, "The LAN is not available.")
            }
        }

        static func lanError(_ e: BonjourPipeError) -> ConnectLanError {
            if case .browse(let b) = e { return lanError(b) }
            return ConnectLanError(.notListening, "The LAN service could not listen.")
        }

        // MARK: Identity

        private func identity(force: Bool) async throws -> PeerSource {
            let now = src.now()
            if !force, let h = held, h.gen == src.changes.value, now - h.at < identityTtlSeconds,
                h.src.certExpiresAt - now > certMarginSeconds
            {
                return h.src
            }
            let gen = src.changes.value
            let v: PeerSource
            do { v = try await src.load() } catch let e as ConnectLanError { throw e } catch {
                throw ConnectLanError(.noIdentity, "No Cloud Connect identity is held.")
            }
            if stopped { return v }
            if index.update(v) { network.rescan() }
            held = (now, gen, v)
            return v
        }

        /// A roster or identity was stored: the next read reloads, and the advert follows a new K_disc
        /// inside the epoch.
        func advertWithdrawn() { advName = "" }

        func stored() {
            src.changes.bump()
            held = nil
            // Reload now so the browse index follows a new roster or key.
            if !stopped { Task { _ = try? await self.identity(force: false) } }
            if !stopped && listening && o.advertise { Task { try? await self.rotate() } }
        }

        // MARK: Links

        private func makeLink(
            pipe: NWPipe, ident: PeerSource, role: PeerChannel.Role, handlers: ConnectSessionHandlers
        ) async throws -> PeerLink {
            let docs = docs
            let epoch = ident.ringEpoch
            // A roster a session handed up counts only while it is newer than the identity loaded.
            let ring: @Sendable () -> (jws: String, epoch: Int)? = {
                if let p = docs.pushed, p.epoch > epoch { return p }
                return nil
            }
            let opts = PeerChannelOptions.connectBase(
                ident, role: role, caps: o.caps, label: o.label, ring: ring, now: src.now,
                rekeyMessages: o.rekeyMessages,
                rekeySeconds: o.rekeySeconds)
            let link = try await PeerLink.make(
                pipe: LanPipe(pipe: pipe), options: opts, handlers: handlers.handlers,
                handshakeSeconds: o.handshakeSeconds)
            handlers.attach(link)
            Task { await link.run() }
            return link
        }

        private func handlers(role: String) -> ConnectSessionHandlers {
            let docs = docs
            return ConnectSessionHandlers(
                role: role, onRing: { docs.onRing($0, $1) }, onTrust: { docs.onTrust($0) },
                onRingWanted: { docs.onRingWanted() })
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

        // MARK: Inbound

        private func accepted(_ pipe: NWPipe) async {
            if stopped || sessions.count >= o.maxSessions { return await pipe.close() }
            let key = ObjectIdentifier(pipe)
            pending[key] = pipe
            do {
                // The identity is read before the first byte is handled; the socket buffers meanwhile.
                let ident = try await identity(force: false)
                if stopped { throw ConnectLanError(.notListening, "stopped") }
                let h = handlers(role: "responder")
                let link = try await makeLink(pipe: pipe, ident: ident, role: .responder, handlers: h)
                let session = try await h.opened(link)
                pending[key] = nil
                pipe.markAuthenticated()
                if stopped { return await session.close() }
                track(session)
                sessionSubs.fire(session)
            } catch {
                pending[key] = nil
                await pipe.close()
            }
        }

        // MARK: Dial

        /// Dial a discovered device and run the handshake. Throws `ConnectLanError`: `unknownPeer`, `connectFailed`,
        /// `permissionDenied`, `handshakeFailed`, `wrongPeer`.
        public func connect(_ deviceId: String) async throws -> ConnectSession {
            guard let peer = peers[deviceId]?.peer else {
                throw ConnectLanError(.unknownPeer, "That device was not found on this network.")
            }
            return try await connect(peer)
        }

        public func connect(_ peer: ConnectLanPeer) async throws -> ConnectSession {
            if stopped { throw ConnectLanError(.notListening, "The LAN service is stopped.") }
            let ident = try await identity(force: false)
            let pipe: NWPipe
            do { pipe = try await network.dial(peer.endpoint) } catch let e as BonjourPipeError {
                if case .browse(.permissionDenied) = e { throw Self.lanError(e) }
                throw ConnectLanError(.connectFailed, "The device did not answer.")
            }
            let key = ObjectIdentifier(pipe)
            pending[key] = pipe
            defer { pending[key] = nil }
            let session: ConnectSession
            do {
                let h = handlers(role: "initiator")
                let link = try await makeLink(pipe: pipe, ident: ident, role: .initiator, handlers: h)
                await link.start()
                session = try await h.opened(link)
            } catch let e as ConnectLanError {
                await pipe.close()
                throw e
            } catch {
                await pipe.close()
                throw ConnectLanError(.handshakeFailed, "The handshake failed.")
            }
            if session.peerDeviceId != peer.deviceId {
                await session.close()
                throw ConnectLanError(.wrongPeer, "The device that answered is not the one that advertised.")
            }
            track(session)
            return session
        }

        // MARK: Discovery

        private func rotate() async throws {
            if stopped { return }
            let ident = try await identity(force: true)
            let now = src.now()
            // The epoch turned over: a peer that learned it first already advertises under the new name.
            if index.refresh(now: now) { network.rescan() }
            let epoch = peerAdvertEpoch(now)
            guard
                let name = try? PeerAdvert.accountInstance(
                    discoveryKey: ident.keys.current.bytes, epoch: epoch, deviceId: ident.deviceId)
            else { throw ConnectLanError(.noKeys, "The device keys or K_disc are not held.") }
            if name != advName {
                advName = name
                await network.advertise(BonjourAdvert(instance: name, txt: ["v=1", "m=a"]))
            }
            armEpoch(src.now())
        }

        /// Wake at the next epoch boundary. With adverts on that is a rotation; browse-only has no advert to
        /// rotate, but a peer already under the next epoch is found by rebuilding the index and rescanning.
        private func armEpoch(_ now: Int) {
            if stopped { return }
            let next = (peerAdvertEpoch(now) + 1) * peerAdvertEpochSeconds - now
            cancelEpoch?()
            cancelEpoch = timer(TimeInterval(max(1, next))) { [weak self] in
                guard let self else { return }
                Task { await self.epochTick() }
            }
        }

        private func epochTick() async {
            if stopped { return }
            if o.advertise {
                try? await rotate()
                return
            }
            if index.refresh(now: src.now()) { network.rescan() }
            armEpoch(src.now())
        }

        private func gone(_ instance: String) {
            for k in peers.keys where peers[k]?.instance == instance { peers[k] = nil }
        }

        private func found(_ f: BonjourFound) async {
            if stopped { return }
            guard case .ok(let mode, _) = PeerAdvert.parseTxt(f.txt), mode == .a else { return }
            guard (try? await identity(force: false)) != nil, let hit = index.lookup(f.instance, now: src.now()) else {
                return
            }
            let peer = ConnectLanPeer(deviceId: hit.deviceId, endpoint: f.endpoint)
            peers[hit.deviceId] = (peer, f.instance)
            peerSubs.fire(peer)
        }
    }
#endif
