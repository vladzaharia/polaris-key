// Pairing with a code, with no account (CC-29.11; WIRE-CONTRACT-V5 §15.12): two devices of one app on one LAN pair by
// an 8-digit code or a QR. One device shows (`pair`, the responder: `LocalShower`), the other types or scans (`join`,
// the initiator: `LocalJoiner`). CPace turns the code into a key, mode `q` runs Noise over it, both people confirm, and
// each side stores a link in the local-link record. Mirrors sdk-node's `connect/localShower.ts`, `localJoiner.ts` and
// `localCommon.ts`.
//
// Rules this file keeps:
//  - the window's accounting is `LocalPairingWindow`'s. The session is given `window.beginGuess` as its required
//    permit, so a guess is counted before its tag is tried; the session's `guess` event is the verdict
//    (`guessOpened` / `guessFailed`); `rotated` is told only after the new password, the new QR secret and both
//    generators exist;
//  - the password, the QR secret, the generators, the scalars and the ISK are released when the attempt or the window
//    ends (`Data` is released, not overwritten; a password is a short string and is dropped);
//  - nothing here needs a signed-in device: no identity, no K_disc, no certificate;
//  - a link, an attempt and a window are keyed by values nothing here logs: no password, QR secret, key or secret is
//    in a description, an error or a print;
//  - a session's events are handled in order, one at a time, by one task per attempt.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

#if canImport(Network)

    /// The code a shower shows now. It changes after every failed guess.
    public struct LocalCode: Sendable, Equatable, CustomStringConvertible {
        /// The 8 digits as two groups of four, like `4812 3456`.
        public let code: String
        /// The text of the QR, `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case.
        public let qr: String
        /// The public two digits of the code, the advert's `n`.
        public let nameplate: String
        public var description: String { "LocalCode(redacted)" }
    }

    /// What `pair` and `join` report once a link is stored.
    public struct LocalPaired: Sendable, Equatable {
        /// Names the link on this device; `list()` has the rest.
        public let id: String
        public let label: String?
        /// The categories both people approved.
        public let categories: [String]
    }

    public struct LocalPairFailure: Sendable, Equatable {
        public enum Reason: String, Sendable {
            case declined, timeout, full
            case tooManyTries = "too-many-tries"
            case closed
        }
        public let reason: Reason
        public let close: ConnectSessionClosed?
    }

    /// The other device, at the consent step.
    public final class LocalOffer: Sendable, CustomStringConvertible, CustomReflectable {
        /// The label the other device sent. It proved the code, but nothing else about it is authenticated: show it as
        /// "reported by the device".
        public let label: String?
        public let platform: String
        /// The categories this app asked for: list them before the person agrees.
        public let categories: [String]
        private let onConfirm: @Sendable () async -> Void
        private let onDecline: @Sendable () async -> Void
        private let closeSubs: PairCloseSubs

        init(
            label: String?, platform: String, categories: [String], confirm: @escaping @Sendable () async -> Void,
            decline: @escaping @Sendable () async -> Void, closes: PairCloseSubs
        ) {
            self.label = label
            self.platform = platform
            self.categories = categories
            onConfirm = confirm
            onDecline = decline
            closeSubs = closes
        }

        /// Agree to the pairing. The link exists once the other person agrees too.
        public func confirm() async { await onConfirm() }
        /// Say no: the session closes and this side stores nothing.
        public func decline() async { await onDecline() }
        /// Called once when the session ends (at once if it already has). Returns the unsubscribe.
        @discardableResult
        public func onClose(_ fn: @escaping @Sendable (ConnectSessionClosed) -> Void) -> @Sendable () -> Void {
            closeSubs.add(fn)
        }

        public var description: String { "LocalOffer()" }
        public var customMirror: Mirror { Mirror(self, children: [:]) }
    }

    /// The common options of `pair` and `join`.
    public struct LocalPairingBase: Sendable {
        /// The data categories this app asks both people to approve (at most 8, each `^[a-z0-9-]{1,32}$`, no repeat).
        /// Show them next to the consent. A link keeps the ones both sides listed.
        public var categories: [String]
        /// This device's label, sent in `HELLO` and in `LOCAL_LINK` and stored on the other device.
        public var label: String?
        /// Called when a device reaches the consent: show it, then call `confirm()` or `decline()`.
        public var onConfirm: @Sendable (LocalOffer) -> Void
        /// Where to listen, advertise, browse and dial. Default: the system one.
        public var network: (any ConnectLanNetwork)?
        /// Accept and dial loopback peers. For tests and same-host use only. Ignored when `network` is given.
        public var allowLoopback: Bool
        public var handshakeSeconds: TimeInterval
        /// Random bytes (tests pin them).
        public var random: (@Sendable (Int) -> Data)?
        /// A monotonic clock in seconds (tests drive it).
        public var mono: (@Sendable () -> TimeInterval)?
    }

    public struct LocalPairOptions: Sendable {
        public var base: LocalPairingBase
        /// Called with the code when the window opens, and with the new one after every failed guess.
        public var onCode: @Sendable (LocalCode) -> Void
        /// Called once with the link made.
        public var onLinked: (@Sendable (LocalPaired) -> Void)?
        /// Called when a session that reached consent ends without a link, and at the fifth failed guess.
        public var onFailed: (@Sendable (LocalPairFailure) -> Void)?
        /// Seconds the window stays open (default and most 300).
        public var seconds: TimeInterval

        public init(
            categories: [String], label: String? = nil, onCode: @escaping @Sendable (LocalCode) -> Void,
            onConfirm: @escaping @Sendable (LocalOffer) -> Void, onLinked: (@Sendable (LocalPaired) -> Void)? = nil,
            onFailed: (@Sendable (LocalPairFailure) -> Void)? = nil,
            seconds: TimeInterval = TimeInterval(localPairSeconds),
            network: (any ConnectLanNetwork)? = nil, allowLoopback: Bool = false,
            handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds, random: (@Sendable (Int) -> Data)? = nil,
            mono: (@Sendable () -> TimeInterval)? = nil
        ) {
            base = LocalPairingBase(
                categories: categories, label: label, onConfirm: onConfirm, network: network,
                allowLoopback: allowLoopback, handshakeSeconds: handshakeSeconds, random: random, mono: mono)
            self.onCode = onCode
            self.onLinked = onLinked
            self.onFailed = onFailed
            self.seconds = seconds
        }
    }

    public struct LocalJoinOptions: Sendable {
        public var base: LocalPairingBase
        /// The code the other device shows, typed (spaces and hyphens are ignored).
        public var code: String?
        /// The text of the QR the other device shows. Give exactly one of `code` and `qr`.
        public var qr: String?
        /// Seconds to browse for the other device (default and most 15).
        public var browseSeconds: TimeInterval

        public init(
            categories: [String], label: String? = nil, code: String? = nil, qr: String? = nil,
            onConfirm: @escaping @Sendable (LocalOffer) -> Void,
            browseSeconds: TimeInterval = TimeInterval(localJoinBrowseSeconds),
            network: (any ConnectLanNetwork)? = nil, allowLoopback: Bool = false,
            handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds, random: (@Sendable (Int) -> Data)? = nil,
            mono: (@Sendable () -> TimeInterval)? = nil
        ) {
            base = LocalPairingBase(
                categories: categories, label: label, onConfirm: onConfirm, network: network,
                allowLoopback: allowLoopback, handshakeSeconds: handshakeSeconds, random: random, mono: mono)
            self.code = code
            self.qr = qr
            self.browseSeconds = browseSeconds
        }
    }

    /// The open pairing window.
    public final class LocalPairHandle: Sendable {
        private let w: LocalShower
        init(_ w: LocalShower) { self.w = w }
        /// Close the window: the advert, the listener and every session.
        public func stop() async { await w.stop() }
        /// The window is still open.
        public var isOpen: Bool { w.isOpenFlag.current }
        /// The code on show now; nil once the window has closed.
        public func code() -> LocalCode? { w.shownCode.current }
    }

    /// What pairing reads of the client.
    struct LocalSource: Sendable {
        var slug: String
        var now: @Sendable () -> Int
        /// The cached discovery answer `localPairing` is true (§15.12 "Gates").
        var allowed: @Sendable () -> Bool
        var store: LocalLinkStore
        /// The links changed: the listener and the adverts follow.
        var notify: @Sendable () -> Void
    }

    private func systemRandom(_ n: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    /// Throws `ConnectLanError` `badType` for options of `pair` or `join` that break a rule.
    func checkLocalOptions(_ o: LocalPairingBase) throws {
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
        if let l = o.label, l.unicodeScalars.count > 64 { throw ConnectLanError(.badType, "The label is not valid.") }
    }

    /// The first frame of `pipe` within `seconds`: C1 or C2. Nil for anything else: a zero-length frame, a second
    /// frame, bytes past the first, a close or the deadline.
    func readSingleFrame(_ pipe: any PeerBytePipe, within seconds: TimeInterval) async -> Data? {
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            if !Task.isCancelled { await pipe.close() }
        }
        defer { timer.cancel() }
        var reader = PeerFrameReader()
        var got = 0
        while true {
            guard let chunk = try? await pipe.read(), !chunk.isEmpty else { return nil }
            got += chunk.count
            guard let frames = try? reader.push(chunk) else { return nil }
            if frames.count > 1 { return nil }
            if let f = frames.first { return got == 2 + f.count ? f : nil }
        }
    }

    final class LocalAttempt: @unchecked Sendable {
        var id: Int?
        var pipe: NWPipe?
        var link: PeerLink?
        var hello: PeerHello?
        var phase = Phase.c1
        enum Phase { case c1, session, done }
        var shown = false
        var linked = false
        var declined = false
        var ended = false
        var failure: LocalPairFailure.Reason?
        var closed: ConnectSessionClosed?
        var storing: Task<Void, Never>?
        /// This attempt's link private key: kept only while the attempt runs.
        var linkKey = Data()
        let closers = PairCloseSubs()
        let events: AsyncStream<LocalAttemptEvent>.Continuation
        let stream: AsyncStream<LocalAttemptEvent>
        init() {
            let (s, c) = AsyncStream<LocalAttemptEvent>.makeStream()
            stream = s
            events = c
        }
    }

    enum LocalAttemptEvent: Sendable {
        case session(PeerSessionEvent)
        case closed(ConnectSessionClosed)
    }

    /// The consent handle the host gets for an attempt that proved the code.
    private func makeOffer(
        _ a: LocalAttempt, categories: [String], hello: PeerHello,
        confirm: @escaping @Sendable (LocalAttempt) async -> Void,
        decline: @escaping @Sendable (LocalAttempt) async -> Void
    ) -> LocalOffer {
        LocalOffer(
            label: hello.label, platform: hello.platform, categories: categories,
            confirm: { await confirm(a) }, decline: { await decline(a) }, closes: a.closers)
    }

    // ── The shower ───────────────────────────────────────────────────────────────────────────────

    actor LocalShower {
        nonisolated let isOpenFlag = LockedValue(true)
        nonisolated let shownCode = LockedValue<LocalCode?>(nil)
        private let src: LocalSource
        private let o: LocalPairOptions
        private let network: any ConnectLanNetwork
        private let random: @Sendable (Int) -> Data
        private let mono: @Sendable () -> TimeInterval
        /// Read by the session's permit, which is synchronous: one lock, one writer at a time.
        private let window = LockedValue(LocalPairingWindow())
        private var attempts: [ObjectIdentifier: LocalAttempt] = [:]
        private var inUse: [String: String] = [:]
        private let sid: Data
        private let instance: String
        private let ci: Data
        private var nameplate = ""
        private var password: String?
        private var qrSecret: Data?
        private var gens: (code: Data, qr: Data)?
        private var stopped = false
        private var stopBrowse: (@Sendable () -> Void)?
        private var expiry: Task<Void, Never>?
        private var onEnd: (@Sendable () -> Void)?
        private var rotating: Task<Void, Never>?

        private init(_ src: LocalSource, _ o: LocalPairOptions, onEnd: @escaping @Sendable () -> Void) {
            self.src = src
            self.o = o
            self.onEnd = onEnd
            network = o.base.network ?? SystemConnectLanNetwork(peerToPeer: false, allowLoopback: o.base.allowLoopback)
            random = o.base.random ?? systemRandom
            mono = o.base.mono ?? { ProcessInfo.processInfo.systemUptime }
            sid = (o.base.random ?? systemRandom)(10)
            instance = PeerLocal.pairingInstance(sid: sid) ?? ""
            ci = peerPrologue(slug: src.slug, mode: .q)
        }

        static func start(_ src: LocalSource, _ o: LocalPairOptions, onEnd: @escaping @Sendable () -> Void) async throws
            -> LocalShower
        {
            let s = LocalShower(src, o, onEnd: onEnd)
            do { try await s.open() } catch {
                await s.stop()
                throw error
            }
            return s
        }

        private func tags() -> [String] {
            let epoch = peerAdvertEpoch(src.now())
            return [epoch, epoch - 1].compactMap { try? PeerAdvert.productTag(slug: src.slug, epoch: $0) }
        }

        private func open() async throws {
            _ = window.with { $0.open(mono()) }
            // The nameplates other windows of this product are using on the link: best effort, from what the browse has
            // seen so far.
            let wanted = tags()
            do {
                stopBrowse = try network.browse(
                    onUp: { [weak self] f in
                        guard let self else { return }
                        Task { await self.seen(f, wanted) }
                    },
                    onDown: { [weak self] n in
                        guard let self else { return }
                        Task { await self.gone(n) }
                    }, onError: { _ in })
            } catch let e as BonjourBrowseError {
                throw ConnectLanSupport.lanError(e)
            }
            guard let np = PeerLocal.drawNameplate({ [random] in random($0) }, inUse: Array(inUse.values)) else {
                throw ConnectLanError(.badType, "No random source.")
            }
            nameplate = np
            try await renew()
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
            guard let h = tags().first else { throw ConnectLanError(.badType, "No product tag.") }
            await network.advertise(BonjourAdvert(instance: instance, txt: ["v=1", "m=q", "h=\(h)", "n=\(nameplate)"]))
            let seconds = min(o.seconds, TimeInterval(localPairSeconds))
            expiry = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if !Task.isCancelled { await self?.shutdown(keepSessions: true) }
            }
            show()
        }

        private func seen(_ f: BonjourFound, _ wanted: [String]) {
            if stopped || f.instance == instance { return }
            guard case .ok(let h, let n) = PeerLocal.parsePairingTxt(f.txt), wanted.contains(h) else { return }
            if inUse.count < 64 { inUse[f.instance] = n }
        }

        private func gone(_ name: String) { inUse[name] = nil }

        /// A new password and QR secret, and both generators made from them. Nothing is kept when the window
        /// stopped while they were made.
        private func renew() async throws {
            guard let pw = PeerLocal.drawPassword({ [random] in random($0) }) else {
                throw ConnectLanError(.badType, "No random source.")
            }
            let secret = random(localQrSecretBytes)
            let sid = sid
            let ci = ci
            let made = try await Task.detached(priority: .userInitiated) {
                (
                    code: PeerCPace.generator(prs: try PeerCPace.prsCode(pw), ci: ci, sid: sid),
                    qr: PeerCPace.generator(prs: try PeerCPace.prsQr(secret), ci: ci, sid: sid)
                )
            }.value
            if stopped { return }
            password = pw
            qrSecret = secret
            gens = made
        }

        private func show() {
            guard !stopped, let pw = password, let secret = qrSecret,
                let display = PeerLocal.displayCode(nameplate: nameplate, password: pw),
                let qr = PeerLocal.makeQr(slug: src.slug, instance: instance, secret: secret)
            else { return }
            let c = LocalCode(code: display, qr: qr, nameplate: nameplate)
            shownCode.set(c)
            o.onCode(c)
        }

        /// Make the next code, then tell the window. `rotated` comes only after the new password, the new QR secret
        /// and both generators exist; until then a C1 meets a busy window.
        private func rotate() async {
            do { try await renew() } catch {
                await stop()
                return
            }
            if stopped { return }
            show()
            window.with { $0.rotated(mono()) }
        }

        private func apply(_ out: LocalWindowOutcome) {
            if out.rotate, rotating == nil {
                rotating = Task { [weak self] in
                    await self?.rotate()
                    await self?.rotationDone()
                }
            }
            if out.result == .tooManyTries {
                o.onFailed?(LocalPairFailure(reason: .tooManyTries, close: nil))
                Task { await self.shutdown(keepSessions: false) }
            }
        }

        private func rotationDone() { rotating = nil }

        func stop() async { await shutdown(keepSessions: false) }

        /// Close the window: the advert, the listener and the connections (`keepSessions` spares those past the
        /// transport).
        private func shutdown(keepSessions: Bool) async {
            if stopped { return }
            stopped = true
            isOpenFlag.set(false)
            expiry?.cancel()
            expiry = nil
            _ = window.with { $0.close(mono()) }
            stopBrowse?()
            stopBrowse = nil
            await network.advertise(nil)
            await network.stop()
            for a in Array(attempts.values) where !keepSessions || a.phase != .session {
                await end(a)
            }
            // The code, the QR secret and the generators are of no use to anyone now.
            qrSecret = nil
            gens = nil
            password = nil
            shownCode.set(nil)
            inUse = [:]
            let done = onEnd
            onEnd = nil
            done?()
        }

        // MARK: Connections

        private func accepted(_ pipe: NWPipe) async {
            if stopped || !src.allowed() { return await pipe.close() }
            let at = mono()
            let a = LocalAttempt()
            a.pipe = pipe
            let key = ObjectIdentifier(a)
            attempts[key] = a
            guard let frame = await readSingleFrame(LanPipe(pipe: pipe), within: TimeInterval(localAttemptSeconds))
            else {
                over(a, pre: true)
                return await pipe.close()
            }
            await c1(a, pipe, frame, at: at)
        }

        private func c1(_ a: LocalAttempt, _ pipe: NWPipe, _ frame: Data, at: TimeInterval) async {
            let verdict = PeerCPace.parseC1(frame)
            var valid = false
            if case .ok = verdict { valid = true }
            let out = window.with { $0.c1(mono(), valid: valid) }
            // Closed, busy, limited and refused: closed silently; none of them counts a failure.
            guard out.result == .attempt, case .ok(let kind?, let share) = verdict, let id = out.id, let g = gens else {
                over(a, pre: false)
                return await pipe.close()
            }
            a.id = id
            let generator = kind == .code ? g.code : g.qr
            let y = random(32)
            guard let yb = PeerCPace.share(scalar: y, generator: generator), !stopped else {
                over(a, pre: true)
                return await pipe.close()
            }
            guard (try? await pipe.write(PeerFrame.encode(PeerCPace.encodeC2(yb: yb)))) != nil,
                let isk = PeerCPace.isk(sid: sid, scalar: y, ya: share, yb: yb, role: .responder)
            else {
                over(a, pre: true)
                return await pipe.close()
            }
            let psk = PeerCPace.psk(isk: isk, slug: src.slug)
            let held = (try? await src.store.count()) ?? maxLocalLinks
            if stopped {
                over(a, pre: false)
                return await pipe.close()
            }
            let key = random(32)
            a.linkKey = key
            let elapsed = mono() - at
            guard let staticKey = try? PeerNoiseRawStaticKey(privateKey: key) else {
                over(a, pre: true)
                return await pipe.close()
            }
            let w = window
            let m = mono
            let opts = PeerChannelOptions(
                role: .responder, slug: src.slug, staticKey: staticKey, caps: [],
                hello: (o.base.label, connectPlatformName, src.slug, nil), mode: .q,
                pair: PeerPairingOptions(
                    psk: psk, isk: isk, held: held, cats: o.base.categories, label: o.base.label, elapsed: elapsed,
                    // The required permit: it counts the guess before the tag is tried.
                    permit: { w.with { $0.beginGuess(id, m()) } }))
            let events = a.events
            let handlers = PeerLinkHandlers(
                onClosed: { c in events.yield(.closed(ConnectSessionClosed(code: c.code, byPeer: c.byPeer))) },
                onSession: { e in events.yield(.session(e)) })
            do {
                let link = try await PeerLink.make(
                    pipe: LanPipe(pipe: pipe), options: opts, handlers: handlers,
                    handshakeSeconds: max(1, TimeInterval(localAttemptSeconds) - elapsed))
                a.link = link
                Task { await self.consume(a) }
                Task { await link.run() }
            } catch {
                over(a, pre: true)
                await pipe.close()
            }
        }

        /// One task per attempt: its events are handled in the order they came.
        private func consume(_ a: LocalAttempt) async {
            for await e in a.stream {
                switch e {
                case .session(let s): await event(a, s)
                case .closed(let c):
                    await closed(a, c)
                    return
                }
            }
        }

        private func event(_ a: LocalAttempt, _ e: PeerSessionEvent) async {
            switch e {
            case .guess(let opens):
                let t = mono()
                // The verdict of the permitted guess: opened (the count is refunded and the attempt is the session) or
                // failed (the code rotates).
                let out: LocalWindowOutcome? = a.id.map { id in
                    window.with { opens ? $0.guessOpened(id, t) : $0.guessFailed(id, t) }
                }
                a.phase = opens ? .session : .done
                if let out { apply(out) }
            case .established(let est):
                a.pipe?.markAuthenticated()
                a.hello = est.hello
                present(a)
            case .localLink(let secret, let ownKey, let peerKey, let label, let cats):
                a.storing = Task { [self] in
                    await store(a, secret: secret, ownKey: ownKey, peerKey: peerKey, label: label, cats: cats)
                }
            default: break
            }
        }

        private func present(_ a: LocalAttempt) {
            guard !a.shown, !stopped, let hello = a.hello else { return }
            a.shown = true
            let handle = makeOffer(
                a, categories: o.base.categories, hello: hello,
                confirm: { a in
                    if a.ended { return }
                    await a.link?.channel.confirmPairing()
                },
                decline: { a in
                    a.declined = true
                    a.failure = .declined
                    await a.link?.channel.declinePairing()
                })
            o.base.onConfirm(handle)
        }

        private func store(
            _ a: LocalAttempt, secret: Data, ownKey: Data, peerKey: Data, label: String?, cats: [String]
        ) async {
            let added = try? await src.store.add(
                ownKey: a.linkKey, ownPublic: ownKey, peerKey: peerKey, secret: secret, label: label, cats: cats,
                now: src.now())
            switch added {
            case .stored(let id)?:
                a.linked = true
                // The listener starts (a device that held no link) and the new link is advertised.
                src.notify()
                o.onLinked?(LocalPaired(id: id, label: label, categories: cats))
            case .full?: a.failure = .full
            case nil: a.failure = .closed
            }
        }

        private func closed(_ a: LocalAttempt, _ c: ConnectSessionClosed) async {
            if a.closed != nil { return }
            a.closed = c
            // The store runs beside the close: judge the window on its result.
            await a.storing?.value
            let t = mono()
            var out = LocalWindowOutcome.none
            if a.phase == .session {
                out = window.with { $0.sessionEnd(t, stored: a.linked) }
            } else if let id = a.id, a.phase != .done {
                // A permitted guess that has no verdict is a failed guess; one that never reached its guess counts nothing.
                out = window.with { $0.abandon(id, t) }
            }
            over(a, pre: false)
            a.closers.fire(c)
            if a.shown && !a.linked && !stopped {
                let reason = a.failure ?? (c.code == "peer_timeout" ? .timeout : .closed)
                o.onFailed?(LocalPairFailure(reason: reason, close: c))
            }
            if a.linked { await shutdown(keepSessions: false) } else { apply(out) }
        }

        /// The attempt is over: its key and its place go; `pre` is a socket that closed before its session began.
        private func over(_ a: LocalAttempt, pre: Bool) {
            if a.ended { return }
            a.ended = true
            attempts[ObjectIdentifier(a)] = nil
            a.linkKey = Data()
            a.events.finish()
            if pre, let id = a.id, a.phase == .c1 { apply(window.with { $0.abandon(id, mono()) }) }
        }

        private func end(_ a: LocalAttempt) async {
            if let link = a.link { await link.close(.peerBye) } else { await a.pipe?.close() }
        }
    }

    // ── The joiner ───────────────────────────────────────────────────────────────────────────────

    actor LocalJoiner {
        private let src: LocalSource
        private let o: LocalJoinOptions
        private let budget: LocalDialBudgets
        private let network: any ConnectLanNetwork
        private let random: @Sendable (Int) -> Data
        private let mono: @Sendable () -> TimeInterval
        private var plan: LocalJoinPlan
        private var cands: [String: BonjourEndpoint] = [:]
        private let ci: Data
        private let password: String?
        private let nameplate: String?
        private var qr: (instance: String, secret: Data)?
        private var qrGen: Data?
        private var qrInvalidDetail: String?
        private var budgetSpent = false
        private var browseOver = false
        private var done = false
        private var current: LocalAttempt?
        private var stopBrowse: (@Sendable () -> Void)?
        private let wake: AsyncStream<Void>
        private let wakeUp: AsyncStream<Void>.Continuation

        init(_ src: LocalSource, _ budget: LocalDialBudgets, _ o: LocalJoinOptions) {
            self.src = src
            self.o = o
            self.budget = budget
            network = o.base.network ?? SystemConnectLanNetwork(peerToPeer: false, allowLoopback: o.base.allowLoopback)
            random = o.base.random ?? systemRandom
            mono = o.base.mono ?? { ProcessInfo.processInfo.systemUptime }
            ci = peerPrologue(slug: src.slug, mode: .q)
            var input = LocalJoinInput.invalid
            var pw: String?
            var np: String?
            var qrIn: (instance: String, secret: Data)?
            var detail: String?
            if let code = o.code {
                if let c = PeerLocal.parseCode(code) {
                    input = .code(nameplate: c.nameplate)
                    pw = c.password
                    np = c.nameplate
                }
            } else if let text = o.qr {
                switch PeerLocal.parseQr(text, own: src.slug) {
                case .ok(_, let instance, let secret):
                    input = .qr(instance: instance)
                    qrIn = (instance, secret)
                case .otherApp: detail = "This code is for another app."
                case .invalid: break
                }
            }
            password = pw
            nameplate = np
            qr = qrIn
            qrInvalidDetail = detail
            plan = LocalJoinPlan(input)
            let (s, c) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            wake = s
            wakeUp = c
        }

        private func failed(_ code: LocalJoinResult) -> LocalPairingError {
            switch code {
            case .pairingNotFound:
                return LocalPairingError(ErrorCode.pairingNotFound, "The other device was not found on this network.")
            default:
                return LocalPairingError(
                    ErrorCode.pairingCodeFailed,
                    qrInvalidDetail
                        ?? (budgetSpent
                            ? "That code did not work. Wait a few minutes, or ask the other device for a new code."
                            : "That code did not work."))
            }
        }

        /// Cancel the join: the dial in flight closes and `run` throws `peer-closed`.
        func cancel() {
            if done { return }
            done = true
            wakeUp.yield()
            if let a = current, let link = a.link, !a.linked { Task { await link.close(.peerBye) } }
            Task { await current?.pipe?.close() }
        }

        func run() async throws -> LocalPaired {
            if !plan.browses { throw failed(.pairingCodeFailed) }
            // A code whose dials are spent answers at once and browses nothing; a QR is never limited.
            if let np = nameplate, !budget.check(np, mono()).allowed {
                budgetSpent = true
                throw failed(.pairingCodeFailed)
            }
            defer { cleanup() }
            // A QR's generator is made before anything is dialled.
            if let qr, let sid = PeerLocal.sid(ofInstance: qr.instance) {
                let ci = ci
                let secret = qr.secret
                qrGen = try await Task.detached(priority: .userInitiated) {
                    PeerCPace.generator(prs: try PeerCPace.prsQr(secret), ci: ci, sid: sid)
                }.value
            }
            let wanted = [peerAdvertEpoch(src.now()), peerAdvertEpoch(src.now()) - 1].compactMap {
                try? PeerAdvert.productTag(slug: src.slug, epoch: $0)
            }
            do {
                stopBrowse = try network.browse(
                    onUp: { [weak self] f in
                        guard let self else { return }
                        Task { await self.found(f, wanted) }
                    },
                    onDown: { [weak self] n in
                        guard let self else { return }
                        Task { await self.gone(n) }
                    }, onError: { _ in })
            } catch let e as BonjourBrowseError {
                throw ConnectLanSupport.lanError(e)
            }
            let seconds = min(o.browseSeconds, TimeInterval(localJoinBrowseSeconds))
            let timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if !Task.isCancelled { await self?.browseEnded() }
            }
            defer { timer.cancel() }
            for await _ in wake {
                if done { throw LocalPairingError(ErrorCode.peerClosed, "The pairing was closed.") }
                while let name = plan.next(), let endpoint = cands[name] {
                    if !src.allowed() {
                        cancel()
                        throw LocalPairingError(ErrorCode.peerClosed, "The pairing was closed.")
                    }
                    let end = await dial(name, endpoint)
                    if done { throw LocalPairingError(ErrorCode.peerClosed, "The pairing was closed.") }
                    // A QR names one instance, so one dial is all there can be.
                    if plan.next() == nil || qr != nil { browseOver = true }
                    switch end {
                    case .paired(let p): return p
                    case .failed(let e): throw e
                    case .noTransport: continue
                    }
                }
                // Browse over and nothing is dialling: the answer is the plan's.
                if browseOver {
                    let r = plan.result()
                    throw failed(r == .pairingNotFound ? r : .pairingCodeFailed)
                }
            }
            throw LocalPairingError(ErrorCode.peerClosed, "The pairing was closed.")
        }

        private func cleanup() {
            done = true
            stopBrowse?()
            stopBrowse = nil
            qr = nil
            qrGen = nil
            wakeUp.finish()
        }

        private func browseEnded() {
            browseOver = true
            stopBrowse?()
            stopBrowse = nil
            wakeUp.yield()
        }

        private func found(_ f: BonjourFound, _ wanted: [String]) {
            if done || browseOver { return }
            guard case .ok(let h, let n) = PeerLocal.parsePairingTxt(f.txt) else { return }
            if plan.see(instance: f.instance, tagMatches: wanted.contains(h), n: n) { cands[f.instance] = f.endpoint }
            wakeUp.yield()
        }

        private func gone(_ name: String) { cands[name] = nil }

        private enum DialEnd {
            case paired(LocalPaired)
            case failed(Error)
            case noTransport
        }

        /// One dial. It ends the plan's turn as `before-c2`, `after-c2` or `transport`.
        private func dial(_ instance: String, _ endpoint: BonjourEndpoint) async -> DialEnd {
            let t = mono()
            if let np = nameplate {
                // Spent when the dial is made, so joins that overlap cannot multiply the dials.
                if !budget.check(np, t).allowed {
                    budgetSpent = true
                    plan.ended(.beforeC2)
                    browseOver = true
                    return .noTransport
                }
                budget.spend(np, t, dials: 1)
            }
            guard let sid = PeerLocal.sid(ofInstance: instance) else {
                plan.ended(.beforeC2)
                return .noTransport
            }
            // A typed code's map runs now, once per dial and at most twice per code in 300 s.
            let gen: Data
            if let g = qrGen {
                gen = g
            } else if let pw = password {
                let ci = ci
                gen = await Task.detached(priority: .userInitiated) {
                    PeerCPace.generator(prs: (try? PeerCPace.prsCode(pw)) ?? Data(), ci: ci, sid: sid)
                }.value
            } else {
                plan.ended(.beforeC2)
                return .noTransport
            }
            let y = random(32)
            guard let ya = PeerCPace.share(scalar: y, generator: gen) else {
                plan.ended(.beforeC2)
                return .noTransport
            }
            guard let targets = try? await network.resolve(endpoint) else {
                plan.ended(.beforeC2)
                return .noTransport
            }
            var pipe: NWPipe?
            for target in targets {
                if done { return .noTransport }
                if let p = try? await network.dial(target) {
                    pipe = p
                    break
                }
            }
            guard let pipe else {
                plan.ended(.beforeC2)
                return .noTransport
            }
            if done {
                await pipe.close()
                return .noTransport
            }
            let a = LocalAttempt()
            a.pipe = pipe
            current = a
            let at = mono()
            guard (try? await pipe.write(PeerFrame.encode(PeerCPace.encodeC1(qr != nil ? .qr : .code, ya: ya)))) != nil,
                let reply = await readSingleFrame(LanPipe(pipe: pipe), within: TimeInterval(localAttemptSeconds)),
                case .ok(_, let yb) = PeerCPace.parseC2(reply),
                let isk = PeerCPace.isk(sid: sid, scalar: y, ya: ya, yb: yb, role: .initiator), !done
            else {
                await pipe.close()
                plan.ended(.beforeC2)
                return .noTransport
            }
            let psk = PeerCPace.psk(isk: isk, slug: src.slug)
            let held = (try? await src.store.count()) ?? maxLocalLinks
            return await session(a, pipe, psk: psk, isk: isk, held: held, elapsed: mono() - at)
        }

        private func session(
            _ a: LocalAttempt, _ pipe: NWPipe, psk: Data, isk: Data, held: Int, elapsed: TimeInterval
        ) async -> DialEnd {
            let key = random(32)
            a.linkKey = key
            guard let staticKey = try? PeerNoiseRawStaticKey(privateKey: key) else {
                await pipe.close()
                plan.ended(.beforeC2)
                return .noTransport
            }
            let opts = PeerChannelOptions(
                role: .initiator, slug: src.slug, staticKey: staticKey, caps: [],
                hello: (o.base.label, connectPlatformName, src.slug, nil), mode: .q,
                pair: PeerPairingOptions(
                    psk: psk, isk: isk, held: held, cats: o.base.categories, label: o.base.label, elapsed: elapsed))
            let events = a.events
            let handlers = PeerLinkHandlers(
                onClosed: { c in events.yield(.closed(ConnectSessionClosed(code: c.code, byPeer: c.byPeer))) },
                onSession: { e in events.yield(.session(e)) })
            let link: PeerLink
            do {
                link = try await PeerLink.make(
                    pipe: LanPipe(pipe: pipe), options: opts, handlers: handlers,
                    handshakeSeconds: max(1, TimeInterval(localAttemptSeconds) - elapsed))
            } catch {
                await pipe.close()
                plan.ended(.beforeC2)
                return .noTransport
            }
            a.link = link
            Task { await link.run() }
            await link.start()
            var up = false
            var paired: LocalPaired?
            var storing: Task<LocalPaired?, Never>?
            var closedWith: ConnectSessionClosed?
            for await e in a.stream {
                switch e {
                case .session(.established(let est)):
                    up = true
                    pipe.markAuthenticated()
                    // The first session that reaches the transport ends the dial.
                    plan.ended(.transport)
                    a.hello = est.hello
                    a.shown = true
                    let handle = makeOffer(
                        a, categories: o.base.categories, hello: est.hello,
                        confirm: { a in
                            if a.ended { return }
                            await a.link?.channel.confirmPairing()
                        },
                        decline: { a in
                            a.declined = true
                            a.failure = .declined
                            await a.link?.channel.declinePairing()
                        })
                    o.base.onConfirm(handle)
                case .session(.localLink(let secret, let ownKey, let peerKey, let label, let cats)):
                    let store = src.store
                    let notify = src.notify
                    let now = src.now()
                    let key = a.linkKey
                    storing = Task {
                        let added = try? await store.add(
                            ownKey: key, ownPublic: ownKey, peerKey: peerKey, secret: secret, label: label, cats: cats,
                            now: now)
                        switch added {
                        case .stored(let id)?:
                            a.linked = true
                            notify()
                            return LocalPaired(id: id, label: label, categories: cats)
                        case .full?:
                            a.failure = .full
                            return nil
                        case nil:
                            a.failure = .closed
                            return nil
                        }
                    }
                case .session: break
                case .closed(let c):
                    closedWith = c
                }
                if closedWith != nil { break }
            }
            if let storing { paired = await storing.value }
            a.linkKey = Data()
            if let c = closedWith { a.closers.fire(c) }
            a.ended = true
            if !up { plan.ended(.afterC2) }
            if let p = paired { return .paired(p) }
            if up {
                return .failed(
                    a.failure == .full
                        ? LocalPairingError(ErrorCode.localLinksFull, "This device holds the most local links it can.")
                        : LocalPairingError(
                            ErrorCode.peerClosed,
                            a.declined ? "The pairing was declined." : "The pairing ended before it finished."))
            }
            return .noTransport
        }
    }

    /// The joiner's dial budgets, one per product for the whole process: an app that makes a new client per screen or
    /// per retry meets the same budget, so retries cannot multiply a fake advert's guesses. In memory only (a restart
    /// resets it, as §15.12 allows).
    final class LocalDialBudgets: Sendable {
        private let budget = LockedValue(LocalDialBudget())
        func check(_ nameplate: String, _ t: Double) -> (allowed: Bool, used: Int) {
            budget.with { $0.check(nameplate, t) }
        }
        func spend(_ nameplate: String, _ t: Double, dials: Int) {
            budget.with { $0.spend(nameplate, t, dials: dials) }
        }

        private static let all = LockedValue<[String: LocalDialBudgets]>([:])
        static func of(_ slug: String) -> LocalDialBudgets {
            all.with { m in
                if let b = m[slug] { return b }
                let b = LocalDialBudgets()
                m[slug] = b
                return b
            }
        }
        /// Forget every dial budget. For tests.
        static func reset() { all.with { $0 = [:] } }
    }
#endif
