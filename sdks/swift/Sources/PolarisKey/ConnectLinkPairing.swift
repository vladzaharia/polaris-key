// Pairing two devices of two accounts (CC-19.7; WIRE-CONTRACT-V5 §15.10): `cloudConnect.links.pair`. Both people
// open pairing; each device advertises a pair instance (`m=p`) and browses for the other's, the two run mode `p`
// to the code (commit-reveal), each person confirms it, and the session's contact exchange stores a link on both
// devices. Mirrors sdk-node's `connect/pairing.ts`.
//
// Rules this file keeps:
//  - the advert is `p1-` + 16 random base32 characters with `v=1`, `m=p` and the product tag, on a listener of its
//    own, for at most 300 s and only while the screen is open (`stop()`);
//  - who dials: both sides advertise and browse, so the one whose instance name sorts lower dials and the other
//    answers. Both apply the same rule, so a pair of devices opens one session;
//  - the code is the person's check. A `LinkOffer` is shown only once the session reached the code; its `label`
//    and `platform` are display data from a device on the LAN that nothing has authenticated, to be shown as
//    "reported by the device", never as proof of who it is;
//  - nothing is stored before both people confirm and both `CONTACT`s are read in order; a session that ends first
//    stores nothing on either side;
//  - the one-time static key lives in the channel for the handshake only; the contact secret is handed to the
//    store; no key, secret, nonce or handshake hash is in any message, description or error. `Data` cannot be
//    zeroed in place and CryptoKit copies its inputs, so these copies are released, not overwritten;
//  - the sessions at once are bounded (4) and the responder side is admitted by the approver limiter of §15.6
//    (5 handshakes a minute, 4 waiting a code).

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

#if canImport(Network)

    /// The pairing window: it closes by itself after this many seconds (§15.4).
    public let linkPairWindowSeconds: TimeInterval = 300
    private let pairMaxSessions = 4
    private let pairTriesPerAdvert = 2

    /// A nearby device at the code stage.
    public final class LinkOffer: Sendable, CustomStringConvertible, CustomReflectable {
        /// What the other device sent as its label. Unauthenticated display data: any device on the network can
        /// send any label. Show it as "reported by the device" beside the code.
        public let label: String?
        public let platform: String
        /// The code both screens show, like `123 456`. The people compare it before anyone confirms.
        public let code: String
        /// The categories this app asked for: list them before the person confirms.
        public let categories: [String]
        private let onConfirm: @Sendable () async -> Void
        private let onDecline: @Sendable () async -> Void
        private let closeSubs: PairCloseSubs

        init(
            label: String?, platform: String, code: String, categories: [String],
            confirm: @escaping @Sendable () async -> Void, decline: @escaping @Sendable () async -> Void,
            closes: PairCloseSubs
        ) {
            self.label = label
            self.platform = platform
            self.code = code
            self.categories = categories
            onConfirm = confirm
            onDecline = decline
            closeSubs = closes
        }

        /// The person confirmed the code on this device. The link is made when the other person does too.
        public func confirm() async { await onConfirm() }
        /// The person declined: the session closes and nothing is stored.
        public func decline() async { await onDecline() }
        /// Called once when the session ends (at once if it already has). Returns the unsubscribe.
        @discardableResult
        public func onClose(_ fn: @escaping @Sendable (ConnectSessionClosed) -> Void) -> @Sendable () -> Void {
            closeSubs.add(fn)
        }

        public var description: String { "LinkOffer()" }
        public var customMirror: Mirror { Mirror(self, children: [:]) }
    }

    final class PairCloseSubs: Sendable {
        private struct S {
            var next = 0
            var fns: [(Int, @Sendable (ConnectSessionClosed) -> Void)] = []
            var done: ConnectSessionClosed?
        }
        private let state = LockedValue(S())
        func add(_ fn: @escaping @Sendable (ConnectSessionClosed) -> Void) -> @Sendable () -> Void {
            let (id, done) = state.with { s -> (Int, ConnectSessionClosed?) in
                s.next += 1
                if s.done == nil { s.fns.append((s.next, fn)) }
                return (s.next, s.done)
            }
            if let done { fn(done) }
            return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
        }
        func fire(_ c: ConnectSessionClosed) {
            let fns = state.with { s -> [@Sendable (ConnectSessionClosed) -> Void] in
                if s.done != nil { return [] }
                s.done = c
                return s.fns.map(\.1)
            }
            for f in fns { f(c) }
        }
    }

    /// A link just made.
    public struct PairedLink: Sendable, Equatable {
        /// The link's id on this device (`links.list()` has the rest).
        public let id: String
        public let label: String?
        /// The categories both people approved.
        public let categories: [String]
        /// The peer was already linked: the new pairing waits for its first handshake.
        public let rePair: Bool
    }

    public struct PairFailure: Sendable, Equatable {
        public enum Reason: String, Sendable { case declined, timeout, full, closed }
        public let reason: Reason
        public let close: ConnectSessionClosed?
    }

    public struct LinkPairOptions: Sendable {
        /// The data categories this app asks both people to approve (at most 8, each `^[a-z0-9-]{1,32}$`, no
        /// repeat). Show them next to the code. A link keeps the ones both sides listed (D-7).
        public var categories: [String]
        /// This device's label, sent in `HELLO` and stored on the other device as the name of the link. Name the
        /// device or the person ("Ana's laptop"); never an account identifier.
        public var label: String?
        /// Called with each nearby device that reached the code. Show it, and call `confirm()` or `decline()`.
        public var onCode: @Sendable (LinkOffer) -> Void
        /// Called once with the link made (both people confirmed and both devices stored it).
        public var onLinked: (@Sendable (PairedLink) -> Void)?
        /// Called when a session that reached the code ends without a link.
        public var onFailed: (@Sendable (PairFailure) -> Void)?
        /// Seconds the window stays open (default and most 300).
        public var seconds: TimeInterval
        /// Where to listen, advertise, browse and dial. Default: the system one.
        public var network: (any ConnectLanNetwork)?
        /// Accept and dial loopback peers. For tests and same-host use only. Ignored when `network` is given.
        public var allowLoopback: Bool
        public var handshakeSeconds: TimeInterval
        /// Random bytes (tests pin them).
        public var random: (@Sendable (Int) -> Data)?

        public init(
            categories: [String], label: String? = nil, onCode: @escaping @Sendable (LinkOffer) -> Void,
            onLinked: (@Sendable (PairedLink) -> Void)? = nil, onFailed: (@Sendable (PairFailure) -> Void)? = nil,
            seconds: TimeInterval = linkPairWindowSeconds, network: (any ConnectLanNetwork)? = nil,
            allowLoopback: Bool = false, handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds,
            random: (@Sendable (Int) -> Data)? = nil
        ) {
            self.categories = categories
            self.label = label
            self.onCode = onCode
            self.onLinked = onLinked
            self.onFailed = onFailed
            self.seconds = seconds
            self.network = network
            self.allowLoopback = allowLoopback
            self.handshakeSeconds = handshakeSeconds
            self.random = random
        }
    }

    /// The open pairing window.
    public final class LinkPairHandle: Sendable {
        private let w: LinkPairing
        init(_ w: LinkPairing) { self.w = w }
        /// Close the window: the advert, the listener and every session.
        public func stop() async { await w.stop() }
        /// Still advertising.
        public var isOpen: Bool { w.isOpenFlag.current }
    }

    /// What pairing reads of the client.
    struct PairSource: Sendable {
        var slug: String
        var now: @Sendable () -> Int
        var agreeKey: @Sendable () async throws -> String
        var held: @Sendable () async -> [String]
        /// Store the contact the exchange produced; nil at the cap.
        var store:
            @Sendable (_ agreeKey: String, _ secret: Data, _ label: String?, _ cats: [String]) async
                -> (id: String, pending: Bool)?
        /// The cached discovery answer is still true: links stay on (§15.10 "Gates").
        var allowed: @Sendable () async -> Bool
    }

    private final class Live: @unchecked Sendable {
        var link: PeerLink?
        var hello: PeerHello?
        var confirmed = false
        var linked = false
        var dead = false
        var shown = false
        var failure: PairFailure.Reason?
        var closed: ConnectSessionClosed?
        var pipe: NWPipe?
        let closers = PairCloseSubs()
    }

    actor LinkPairing {
        nonisolated let isOpenFlag = LockedValue(true)
        private let src: PairSource
        private let o: LinkPairOptions
        private let network: any ConnectLanNetwork
        private let random: @Sendable (Int) -> Data
        private let limiter = HandshakeLimiter()
        private var live: [ObjectIdentifier: Live] = [:]
        private var candidates: [String: (instance: String, endpoint: BonjourEndpoint, tries: Int)] = [:]
        private var dialing: Set<String> = []
        private var instance = ""
        private var agreeKey = ""
        private var held: [String] = []
        private var stopped = false
        private var stopBrowse: (@Sendable () -> Void)?
        private var window: Task<Void, Never>?

        private init(_ src: PairSource, _ o: LinkPairOptions) {
            self.src = src
            self.o = o
            network = o.network ?? SystemConnectLanNetwork(peerToPeer: false, allowLoopback: o.allowLoopback)
            random = o.random ?? { n in Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
        }

        /// Validate, listen, advertise and browse. Throws `ConnectLanError` `badType`... see `check`.
        static func start(_ src: PairSource, _ o: LinkPairOptions) async throws -> LinkPairHandle {
            try check(o)
            let p = LinkPairing(src, o)
            do { try await p.begin() } catch {
                await p.stop()
                throw error
            }
            return LinkPairHandle(p)
        }

        private static func check(_ o: LinkPairOptions) throws {
            func isCat(_ s: String) -> Bool {
                let u = Array(s.unicodeScalars)
                return (1...32).contains(u.count)
                    && u.allSatisfy {
                        ($0.value >= 0x61 && $0.value <= 0x7a) || ($0.value >= 0x30 && $0.value <= 0x39) || $0 == "-"
                    }
            }
            guard o.categories.count <= maxContactCats, o.categories.allSatisfy(isCat),
                Set(o.categories).count == o.categories.count
            else {
                throw ConnectLanError(
                    .badType, "categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
            }
            if let l = o.label, l.unicodeScalars.count > 64 {
                throw ConnectLanError(.badType, "The label is not valid.")
            }
            guard o.seconds > 0 else { throw ConnectLanError(.badType, "seconds must be above 0.") }
        }

        private func begin() async throws {
            agreeKey = try await src.agreeKey()
            held = await src.held()
            let port: UInt16
            do {
                port = try await network.listen(
                    onPipe: { [weak self] pipe in
                        guard let self else { return }
                        Task { await self.accepted(pipe) }
                    }, onEvent: { _ in })
            } catch let e as BonjourPipeError {
                throw ConnectLanSupport.lanError(e)
            }
            _ = port
            instance = "p1-" + String(PeerAdvert.base32Lower(random(10)).prefix(16))
            let tag = try PeerAdvert.productTag(slug: src.slug, epoch: peerAdvertEpoch(src.now()))
            await network.advertise(BonjourAdvert(instance: instance, txt: ["v=1", "m=p", "h=\(tag)"]))
            do {
                stopBrowse = try network.browse(
                    onUp: { [weak self] f in
                        guard let self else { return }
                        Task { await self.found(f) }
                    },
                    onDown: { [weak self] n in
                        guard let self else { return }
                        Task { await self.gone(n) }
                    }, onError: { _ in })
            } catch let e as BonjourBrowseError {
                throw ConnectLanSupport.lanError(e)
            }
            let seconds = min(o.seconds, linkPairWindowSeconds)
            window = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if !Task.isCancelled { await self?.stop() }
            }
        }

        func stop() async {
            if stopped { return }
            stopped = true
            isOpenFlag.set(false)
            window?.cancel()
            window = nil
            stopBrowse?()
            stopBrowse = nil
            await network.advertise(nil)
            let all = Array(live.values)
            for l in all { await end(l, .peerBye) }
            candidates = [:]
            await network.stop()
        }

        // MARK: Advert and browse

        private func gone(_ name: String) { candidates[name] = nil }

        private func found(_ f: BonjourFound) async {
            if stopped || f.instance == instance { return }
            guard case .ok(let mode, let h) = PeerAdvert.parseTxt(f.txt), mode == .p else { return }
            // The product tag of this epoch or the last: a pair advert of another product is not ours.
            let epoch = peerAdvertEpoch(src.now())
            let tags = [epoch, epoch - 1].compactMap { try? PeerAdvert.productTag(slug: src.slug, epoch: $0) }
            guard let h, tags.contains(h) else { return }
            candidates[f.instance] = (f.instance, f.endpoint, candidates[f.instance]?.tries ?? 0)
            await pump()
        }

        /// Dial the adverts that sort above this device's own (the other side dials the rest).
        private func pump() async {
            // The cached discovery answer can move under an open window (§15.10 "Gates").
            if stopped { return }
            if !(await src.allowed()) { return }
            for (name, c) in candidates {
                if live.count + dialing.count >= pairMaxSessions { return }
                if instance >= c.instance || dialing.contains(name) || c.tries >= pairTriesPerAdvert { continue }
                candidates[name]?.tries += 1
                dialing.insert(name)
                Task {
                    await self.dial(name, c.endpoint)
                    await self.doneDialing(name)
                }
            }
        }

        private func doneDialing(_ name: String) { dialing.remove(name) }

        private func dial(_ name: String, _ endpoint: BonjourEndpoint) async {
            guard let targets = try? await network.resolve(endpoint) else { return }
            for t in targets {
                guard !stopped, let pipe = try? await network.dial(t) else { continue }
                if stopped {
                    await pipe.close()
                    return
                }
                let l = await makeLive(pipe, .initiator)
                await l.link?.start()
                return
            }
        }

        // MARK: Sessions

        private func accepted(_ pipe: NWPipe) async {
            if stopped || live.count >= pairMaxSessions { return await pipe.close() }
            if !(await src.allowed()) { return await pipe.close() }
            _ = await makeLive(pipe, .responder)
        }

        private func makeLive(_ pipe: NWPipe, _ role: PeerChannel.Role) async -> Live {
            let l = Live()
            l.pipe = pipe
            let id = ObjectIdentifier(l)
            live[id] = l
            let key =
                (try? PeerNoiseRawStaticKey(privateKey: random(32)))
                ?? (try! PeerNoiseRawStaticKey(privateKey: Data(count: 32)))
            let opts = PeerChannelOptions(
                role: role, slug: src.slug, staticKey: key, admission: role == .responder ? limiter : nil, caps: [],
                hello: (o.label, connectPlatformName, src.slug, nil), mode: .p,
                exchange: PeerContactOffer(agreeKey: agreeKey, held: held, label: o.label, cats: o.categories),
                now: src.now)
            let handlers = PeerLinkHandlers(
                onEstablished: { [weak self] est, _ in
                    guard let self else { return }
                    pipe.markAuthenticated()
                    Task { await self.established(l, est) }
                },
                onClosed: { [weak self] c in
                    guard let self else { return }
                    Task { await self.closed(l, ConnectSessionClosed(code: c.code, byPeer: c.byPeer)) }
                },
                onContact: { [weak self] secret, body, pending in
                    guard let self else { return }
                    Task { await self.store(l, secret, body, pending) }
                },
                onSas: { [weak self] _, display in
                    guard let self else { return }
                    Task { await self.show(l, display) }
                })
            do {
                let link = try await PeerLink.make(
                    pipe: LanPipe(pipe: pipe), options: opts, handlers: handlers, handshakeSeconds: o.handshakeSeconds)
                l.link = link
                Task { await link.run() }
            } catch {
                live[id] = nil
                await pipe.close()
            }
            return l
        }

        private func established(_ l: Live, _ e: PeerEstablished) { l.hello = e.hello }

        private func show(_ l: Live, _ display: String) {
            if l.shown || stopped { return }
            l.shown = true
            let hello = l.hello
            let cats = o.categories
            let offer = LinkOffer(
                label: hello?.label, platform: hello?.platform ?? "", code: display, categories: cats,
                confirm: { [weak self] in await self?.confirm(l) },
                decline: { [weak self] in await self?.decline(l) }, closes: l.closers)
            o.onCode(offer)
        }

        private func confirm(_ l: Live) async {
            if l.dead || l.confirmed { return }
            l.confirmed = true
            // One link per window: the other devices that reached the code are closed.
            for other in live.values where other !== l && !other.confirmed { await end(other, .peerBye) }
            await l.link?.channel.confirmSas()
        }

        private func decline(_ l: Live) async {
            l.failure = .declined
            await end(l, .peerBye)
        }

        private func store(_ l: Live, _ secret: Data, _ body: ContactBody, _ pending: Bool) async {
            let cats = PeerContacts.categories(o.categories, body.cats)
            guard let r = await src.store(body.agreeKey, secret, body.label, cats) else {
                l.failure = .full
                await end(l, .peerNotAllowed)
                return
            }
            l.linked = true
            o.onLinked?(PairedLink(id: r.id, label: body.label, categories: cats, rePair: r.pending))
            // Both CONTACTs are in: the exchange is over (§15.10).
            await end(l, .peerBye)
        }

        private func closed(_ l: Live, _ c: ConnectSessionClosed) async {
            if l.dead { return }
            l.dead = true
            l.closed = c
            live[ObjectIdentifier(l)] = nil
            l.closers.fire(c)
            if l.shown && !l.linked && !stopped {
                let reason = l.failure ?? (c.code == "peer_timeout" ? .timeout : .closed)
                o.onFailed?(PairFailure(reason: reason, close: c))
            }
            if l.linked && !stopped { await stop() } else { await pump() }
        }

        private func end(_ l: Live, _ code: PeerCloseCode) async { await l.link?.close(code) }
    }

    enum ConnectLanSupport {
        static func lanError(_ e: BonjourPipeError) -> ConnectLanError {
            ConnectLanService.lanError(e)
        }
        static func lanError(_ e: BonjourBrowseError) -> ConnectLanError {
            ConnectLanService.lanError(e)
        }
    }
#endif
