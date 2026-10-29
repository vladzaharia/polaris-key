// Bonjour byte pipes for Cloud Connect's LAN service (CC-11.11; WIRE-CONTRACT-V5 §15.4, G6, G7, D-10).
// Standalone, like the rest of this target: it moves bytes and knows nothing of the protocol. The
// `PeerBytePipe` it implements is `PolarisKeyCore`'s port; this target does not import Core, so the
// umbrella (or a thin conformance in the host) adapts `NWPipe`, which has the same four members.
//
//   - Listener: an `NWListener` for TCP on a random port. With an advert it registers
//     `service` (instance + TXT). If the OS registers the service under any other name the
//     registration is withdrawn (`service = nil`), never kept under that name.
//   - Dial: an `NWConnection` to a browse endpoint (or a host and port). The address rule is
//     `lanVerdict` (§15.4.1): RFC 1918 IPv4, fe80::/10, fc00::/7 and an on-link global IPv6 address
//     (G6, D-10), plus loopback only when the caller opts in. A host and port is judged as text
//     before a socket exists (a name is refused), and the connected path's remote and local
//     endpoints are judged again before the first byte; a refusal cancels the connection unused. A
//     name, a public address, 169.254/16 and 100.64/10 are refused.
//   - The pipe: reads are pull-based (one `receive` per `read()`), so a reader that stops reading
//     stops the TCP window; writes complete when the OS has taken the bytes.
//   - G7: the listener admits at most 32 unauthenticated sockets in all, 16 per /64 and 4 per
//     address (a link-local key carries its zone). A slot is held from accept until
//     `markAuthenticated()` or the socket's end. A source that fails the address rule is closed with
//     no read and no slot, at accept and again on the connected path. Time (30 s) and frame size
//     (16 KiB) before admission are `PeerLink`'s.
//   - Peer-to-peer (AWDL) is off unless the host asks (D-5).

import Foundation

#if canImport(Network)
    import Network
#endif

// MARK: - Dial policy (G6, D-10)

/// Which addresses the device will connect to and accept: `lanVerdict` (`LanAddress.swift`) with
/// the loopback opt-in.
public struct BonjourDialPolicy: Sendable, Equatable {
    /// Loopback (127/8 and ::1) is dialled only when a test opts in.
    public var allowLoopback: Bool

    public init(allowLoopback: Bool = false) { self.allowLoopback = allowLoopback }

    /// The verdict on `remote` (text) given the socket's own address when known.
    public func verdict(remote: String, local: String? = nil) -> LanVerdict {
        lanVerdict(remote, local: local, allowLoopback: allowLoopback)
    }

    /// `bytes` is 4 bytes (IPv4) or 16 (IPv6), network order. The local address is unknown, so a
    /// global IPv6 address is refused.
    public func allows(addressBytes b: [UInt8]) -> Bool {
        guard let text = lanAddressText(bytes: b) else { return false }
        return verdict(remote: text).dial
    }

    #if canImport(Network)
        /// The verdict on a connected path's endpoints (hosts and ports only). A remote that is not an
        /// address is refused; an unknown local endpoint is `nil`.
        public func pathVerdict(remote: NWEndpoint?, local: NWEndpoint?) -> LanVerdict {
            guard let r = BonjourPipes.addressText(remote) else { return .refused }
            return verdict(remote: r, local: BonjourPipes.addressText(local))
        }
    #endif
}

// MARK: - G7 limiter

/// At most `total` unauthenticated sockets, `perGroup` from one /64 and `perAddress` from one address.
/// Keys are `lanVerdict`'s: a link-local address counts with its zone.
public final class UnauthenticatedLimiter: @unchecked Sendable {
    public static let defaultTotal = 32
    public static let defaultPerAddress = 4
    public static let defaultPerGroup = 16

    public struct Slot: Sendable, Hashable {
        fileprivate let id: Int
        fileprivate let address: String
        fileprivate let group: String?
    }

    private let total: Int
    private let perAddress: Int
    private let perGroup: Int
    private let lock = NSLock()
    private var next = 0
    private var held: [Int: Slot] = [:]
    private var perAddr: [String: Int] = [:]
    private var perNet: [String: Int] = [:]

    public init(
        total: Int = defaultTotal, perAddress: Int = defaultPerAddress, perGroup: Int = defaultPerGroup
    ) {
        self.total = total
        self.perAddress = perAddress
        self.perGroup = perGroup
    }

    public var count: Int { lock.withLock { held.count } }

    /// A slot, or nil when the socket must be refused. `address` is a `lanVerdict` key.
    public func admit(address: String) -> Slot? {
        let group = lanGroupKey(address)
        return lock.withLock {
            guard held.count < total, (perAddr[address] ?? 0) < perAddress else { return nil }
            if let group, (perNet[group] ?? 0) >= perGroup { return nil }
            next += 1
            let slot = Slot(id: next, address: address, group: group)
            held[next] = slot
            perAddr[address, default: 0] += 1
            if let group { perNet[group, default: 0] += 1 }
            return slot
        }
    }

    /// Idempotent.
    public func release(_ slot: Slot) {
        lock.withLock {
            guard held.removeValue(forKey: slot.id) != nil else { return }
            let n = (perAddr[slot.address] ?? 1) - 1
            perAddr[slot.address] = n > 0 ? n : nil
            if let group = slot.group {
                let m = (perNet[group] ?? 1) - 1
                perNet[group] = m > 0 ? m : nil
            }
        }
    }
}

// MARK: - Errors, events, options

public enum BonjourPipeError: Error, Sendable, Equatable {
    /// The connected path's address failed the dial policy; nothing was sent.
    case addressRefused
    case timedOut
    case closed
    /// The endpoint had no network endpoint (a test row) or was not an address.
    case unresolvable
    case browse(BonjourBrowseError)
    /// The OS's text, never a peer's.
    case failed(String)
}

public struct BonjourDialOptions: Sendable, Equatable {
    public var policy: BonjourDialPolicy
    public var peerToPeer: Bool
    public var timeout: TimeInterval

    public init(policy: BonjourDialPolicy = BonjourDialPolicy(), peerToPeer: Bool = false, timeout: TimeInterval = 10) {
        self.policy = policy
        self.peerToPeer = peerToPeer
        self.timeout = timeout
    }
}

/// What a listener reports besides pipes.
public enum BonjourListenerEvent: Sendable, Equatable {
    /// The service is registered under exactly the requested name.
    case registered(String)
    /// The registration was withdrawn because the OS named it differently (`got`), or it was removed.
    case withdrawn(requested: String, got: String?)
    case failed(BonjourBrowseError)
}

public struct BonjourAdvert: Sendable, Equatable {
    public var instance: String
    /// `key=value` entries.
    public var txt: [String]

    public init(instance: String, txt: [String]) {
        self.instance = instance
        self.txt = txt
    }
}

/// What to do with a registration update the OS reported.
public enum BonjourRegistrationAction: Sendable, Equatable {
    case keep
    case withdraw(got: String)
}

public enum BonjourRegistration {
    /// A service registered under another name than requested is withdrawn, never kept.
    public static func action(requested: String, registeredAs name: String) -> BonjourRegistrationAction {
        name == requested ? .keep : .withdraw(got: name)
    }
}

#if canImport(Network)

    // MARK: - The pipe

    /// One TCP connection as a duplex byte stream. `read()` is pull-based.
    public final class NWPipe: @unchecked Sendable {
        private static let readMax = 65_536

        private let conn: NWConnection
        private let queue: DispatchQueue
        private let lock = NSLock()
        private var isClosed = false
        private var releaseSlot: (() -> Void)?
        private var authenticated = false
        public let remoteAddress: String

        fileprivate init(conn: NWConnection, queue: DispatchQueue, remote: String, release: (() -> Void)?) {
            self.conn = conn
            self.queue = queue
            self.remoteAddress = remote
            self.releaseSlot = release
        }

        /// The next chunk; nil at the end of the stream or after `close()`.
        public func read() async throws -> Data? {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data?, Error>) in
                conn.receive(minimumIncompleteLength: 1, maximumLength: Self.readMax) {
                    [self] data, _, isComplete, error in
                    if let data, !data.isEmpty { return cont.resume(returning: data) }
                    if let error {
                        if lock.withLock({ isClosed }) { return cont.resume(returning: nil) }
                        return cont.resume(throwing: BonjourPipeError.failed("\(error)"))
                    }
                    _ = isComplete
                    cont.resume(returning: nil)
                }
            }
        }

        /// Completes when the OS has taken the bytes.
        public func write(_ bytes: Data) async throws {
            if lock.withLock({ isClosed }) { throw BonjourPipeError.closed }
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                conn.send(
                    content: bytes,
                    completion: .contentProcessed { error in
                        if let error {
                            cont.resume(throwing: BonjourPipeError.failed("\(error)"))
                        } else {
                            cont.resume()
                        }
                    })
            }
        }

        public func close() async { shut() }

        /// The session is admitted: this socket no longer counts against the unauthenticated limits.
        public func markAuthenticated() {
            lock.withLock { authenticated = true }
            freeSlot()
        }

        /// The pre-auth deadline: closes the socket unless the session was admitted. Idempotent.
        fileprivate func closeUnlessAuthenticated() {
            if lock.withLock({ authenticated }) { return }
            shut()
        }

        fileprivate func shut() {
            lock.withLock { isClosed = true }
            conn.cancel()
            freeSlot()
        }

        fileprivate func freeSlot() {
            let r = lock.withLock { () -> (() -> Void)? in
                defer { releaseSlot = nil }
                return releaseSlot
            }
            r?()
        }

        /// Starts `conn` and reports the first ready or failure to `onReady` exactly once. A later end
        /// frees the slot.
        fileprivate static func open(
            _ conn: NWConnection, queue: DispatchQueue, remote: String, release: (() -> Void)?,
            onReady: @escaping @Sendable (NWPipe) -> Void, onFail: @escaping @Sendable (BonjourPipeError) -> Void
        ) -> NWPipe {
            let pipe = NWPipe(conn: conn, queue: queue, remote: remote, release: release)
            let once = Once()
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.claim() { onReady(pipe) }
                case .waiting(let e):
                    if case .dns(let code) = e {
                        let c = BonjourErrors.classify(dnsError: code)
                        if c == .permissionDenied || c == .notConfigured {
                            if once.claim() {
                                pipe.shut()
                                onFail(.browse(c))
                            }
                        }
                    }
                case .failed(let e):
                    pipe.shut()
                    conn.stateUpdateHandler = nil  // breaks the pipe <-> handler cycle
                    if once.claim() { onFail(.failed("\(e)")) }
                case .cancelled:
                    pipe.freeSlot()
                    conn.stateUpdateHandler = nil
                    if once.claim() { onFail(.closed) }
                default:
                    break
                }
            }
            conn.start(queue: queue)
            return pipe
        }

        fileprivate func fail(_ error: BonjourPipeError, to onFail: @Sendable (BonjourPipeError) -> Void) {
            shut()
            onFail(error)
        }
    }

    // MARK: - Dial

    public enum BonjourPipes {
        /// Dial a browse hit.
        public static func dial(_ endpoint: BonjourEndpoint, options: BonjourDialOptions = BonjourDialOptions())
            async throws
            -> NWPipe
        {
            guard let network = endpoint.network else { throw BonjourPipeError.unresolvable }
            return try await dial(network, options: options)
        }

        /// The text of a host and port endpoint's address, or nil for a name, a service and anything
        /// else. A link-local address keeps the zone of its interface.
        static func addressText(_ e: NWEndpoint?) -> String? {
            guard case .hostPort(let host, _)? = e else { return nil }
            switch host {
            case .ipv4(let a): return lanAddressText(bytes: Array(a.rawValue))
            case .ipv6(let a):
                var b = Array(a.rawValue)
                // Some stacks keep the link-local scope in bytes 2 and 3 (KAME); RFC 4291 has them zero.
                if b.count == 16, b[0] == 0xFE, (b[1] & 0xC0) == 0x80 {
                    b[2] = 0
                    b[3] = 0
                }
                return lanAddressText(bytes: b, zone: a.interface?.name)
            case .name: return nil
            @unknown default: return nil
            }
        }

        /// This device's own IPv6 addresses on up interfaces, as text (the zone is not needed).
        static func ownIPv6Addresses() -> [String] {
            var head: UnsafeMutablePointer<ifaddrs>?
            guard getifaddrs(&head) == 0, let first = head else { return [] }
            defer { freeifaddrs(head) }
            var out: [String] = []
            var next: UnsafeMutablePointer<ifaddrs>? = first
            while let cur = next {
                defer { next = cur.pointee.ifa_next }
                guard cur.pointee.ifa_flags & UInt32(IFF_UP) != 0, let sa = cur.pointee.ifa_addr,
                    sa.pointee.sa_family == sa_family_t(AF_INET6)
                else { continue }
                let bytes = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { s in
                    withUnsafeBytes(of: s.pointee.sin6_addr) { Array($0) }
                }
                if let t = lanAddressText(bytes: bytes) { out.append(t) }
            }
            return out
        }

        /// Dial an endpoint. A host and port is judged as text before a socket exists (a name is
        /// refused); the pipe is handed back only after the connected path's remote and local
        /// endpoints passed `lanVerdict`. A refused or failed dial has sent nothing.
        public static func dial(_ endpoint: NWEndpoint, options: BonjourDialOptions = BonjourDialOptions()) async throws
            -> NWPipe
        {
            switch endpoint {
            case .hostPort:
                // The address itself stands in for "some local address in the same /64"; the
                // connected path decides with the real one.
                guard let text = addressText(endpoint), options.policy.verdict(remote: text, local: text).dial else {
                    throw BonjourPipeError.addressRefused
                }
            case .service:
                break  // the OS resolves a browse hit; only the connected path can be judged
            default:
                throw BonjourPipeError.addressRefused
            }
            let params = NWParameters.tcp
            params.includePeerToPeer = options.peerToPeer
            let conn = NWConnection(to: endpoint, using: params)
            let queue = DispatchQueue(label: "im.plrs.key.bonjour-dial")
            return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<NWPipe, Error>) in
                let done = Once()
                let finishFail: @Sendable (BonjourPipeError) -> Void = { e in
                    if done.claim() { cont.resume(throwing: e) }
                }
                _ = NWPipe.open(
                    conn, queue: queue, remote: "", release: nil,
                    onReady: { pipe in
                        let path = conn.currentPath
                        guard
                            options.policy.pathVerdict(remote: path?.remoteEndpoint, local: path?.localEndpoint).dial
                        else {
                            pipe.fail(.addressRefused, to: finishFail)
                            return
                        }
                        if done.claim() { cont.resume(returning: pipe) }
                    },
                    onFail: finishFail)
                queue.asyncAfter(deadline: .now() + options.timeout) {
                    // Only a dial still pending times out; a delivered pipe is the caller's.
                    if done.claim() {
                        conn.cancel()
                        cont.resume(throwing: BonjourPipeError.timedOut)
                    }
                }
            }
        }
    }

    // MARK: - Listener

    /// Listens for peers on a random TCP port and (optionally) advertises `_pkeypeer._tcp`.
    public final class BonjourListener: @unchecked Sendable {
        /// G7: an accepted socket that is not admitted as a session within this many seconds is closed.
        public static let preAuthSeconds: TimeInterval = 30
        /// `start` throws when the listener has not reached `.ready` this long after `.waiting`.
        public static let readySeconds: TimeInterval = 10

        private let peerToPeer: Bool
        private let limiter: UnauthenticatedLimiter
        private let policy: BonjourDialPolicy
        private let preAuth: TimeInterval
        private let readyBound: TimeInterval
        private let lock = NSLock()
        private var listener: NWListener?
        private var advert: BonjourAdvert?
        private var stopped = false
        private let queue = DispatchQueue(label: "im.plrs.key.bonjour-listen")

        /// `peerToPeer` is D-5's opt-in (AWDL), off by default.
        /// `policy` is the accept-side address policy (G6): only LAN sources are served; loopback only on
        /// the test opt-in.
        public init(
            peerToPeer: Bool = false, limiter: UnauthenticatedLimiter = UnauthenticatedLimiter(),
            policy: BonjourDialPolicy = BonjourDialPolicy(),
            preAuthSeconds: TimeInterval = BonjourListener.preAuthSeconds,
            readySeconds: TimeInterval = BonjourListener.readySeconds
        ) {
            self.peerToPeer = peerToPeer
            self.limiter = limiter
            self.policy = policy
            self.preAuth = preAuthSeconds
            self.readyBound = readySeconds
        }

        /// The limiter key of a source the policy allows, else nil: `lanVerdict`'s key (an IPv4-mapped
        /// IPv6 source and its IPv4 form share one; a link-local key keeps its zone). `local` is the
        /// socket's own endpoint when known. At accept it is not, so a global IPv6 source passes only
        /// when it shares a /64 with one of this device's own IPv6 addresses (`own`); the connected
        /// path is judged again, with its real local address, before the host sees the pipe.
        static func allowedSource(
            _ e: NWEndpoint, local: NWEndpoint? = nil, policy: BonjourDialPolicy,
            own: () -> [String] = BonjourPipes.ownIPv6Addresses
        ) -> String? {
            guard let text = BonjourPipes.addressText(e) else { return nil }
            if let l = local.flatMap(BonjourPipes.addressText) {
                let v = policy.verdict(remote: text, local: l)
                return v.dial ? v.key : nil
            }
            let first = policy.verdict(remote: text, local: nil)
            if first.dial { return first.key }
            for l in own() {
                let v = policy.verdict(remote: text, local: l)
                if v.dial { return v.key }
            }
            return nil
        }

        /// Policy first, then a slot: a refused source never takes one.
        static func gate(
            _ e: NWEndpoint, local: NWEndpoint? = nil, policy: BonjourDialPolicy, limiter: UnauthenticatedLimiter
        ) -> (address: String, slot: UnauthenticatedLimiter.Slot)? {
            guard let address = allowedSource(e, local: local, policy: policy),
                let slot = limiter.admit(address: address)
            else {
                return nil
            }
            return (address, slot)
        }

        /// What a listener `.waiting` error means: a refused permission or missing plist fails `start` now;
        /// anything else waits for the ready bound.
        static func waitingFailure(_ e: NWError) -> BonjourBrowseError? {
            guard case .dns(let code) = e else { return nil }
            let c = BonjourErrors.classify(dnsError: code)
            return c == .permissionDenied || c == .notConfigured ? c : nil
        }

        /// Start listening and return the port. With `advert` the service is registered; each accepted,
        /// ready connection goes to `onPipe`, which should call `markAuthenticated()` once the session
        /// is admitted.
        @discardableResult
        public func start(
            advert: BonjourAdvert? = nil, onPipe: @escaping @Sendable (NWPipe) -> Void,
            onEvent: @escaping @Sendable (BonjourListenerEvent) -> Void = { _ in }
        ) async throws -> UInt16 {
            let params = NWParameters.tcp
            params.includePeerToPeer = peerToPeer
            let l: NWListener
            do { l = try NWListener(using: params) } catch { throw BonjourPipeError.failed("\(error)") }
            let ok = lock.withLock { () -> Bool in
                if listener != nil || stopped { return false }
                listener = l
                self.advert = advert
                return true
            }
            guard ok else {
                l.cancel()
                throw BonjourPipeError.closed
            }
            if let advert { l.service = Self.service(advert) }

            l.serviceRegistrationUpdateHandler = { [weak self, weak l] change in
                guard let self, let l else { return }
                guard case .add(let ep) = change, case .service(let name, _, _, _) = ep else { return }
                let requested = lock.withLock { self.advert?.instance }
                guard let requested else { return }
                switch BonjourRegistration.action(requested: requested, registeredAs: name) {
                case .keep: onEvent(.registered(name))
                case .withdraw(let got):
                    l.service = nil
                    lock.withLock { self.advert = nil }
                    onEvent(.withdrawn(requested: requested, got: got))
                }
            }
            let limiter = limiter
            let policy = policy
            let preAuth = preAuth
            l.newConnectionHandler = { [queue] conn in
                guard let (address, slot) = Self.gate(conn.endpoint, policy: policy, limiter: limiter) else {
                    conn.cancel()  // a non-LAN source or a full pool: closed with no read
                    return
                }
                let pipe = NWPipe.open(
                    conn, queue: queue, remote: address, release: { limiter.release(slot) },
                    onReady: { pipe in
                        // The connected path, judged with its own local address before the host sees the
                        // pipe, so before any read: a non-LAN source is closed here and never served.
                        let path = conn.currentPath
                        guard policy.pathVerdict(remote: path?.remoteEndpoint, local: path?.localEndpoint).dial else {
                            pipe.shut()
                            return
                        }
                        onPipe(pipe)
                    }, onFail: { _ in })
                // The 30 s clock starts at accept, not when the host gets round to the handshake (G7).
                queue.asyncAfter(deadline: .now() + preAuth) { pipe.closeUnlessAuthenticated() }
            }
            let readyBound = readyBound
            let queue = queue
            return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
                let once = Once()
                l.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if once.claim() { cont.resume(returning: l.port?.rawValue ?? 0) }
                    case .waiting(let e):
                        // No usable interface or a policy refusal: never leave `start` suspended.
                        if let c = Self.waitingFailure(e) {
                            if once.claim() {
                                l.cancel()
                                cont.resume(throwing: BonjourPipeError.browse(c))
                            }
                        } else {
                            queue.asyncAfter(deadline: .now() + readyBound) {
                                if once.claim() {
                                    l.cancel()
                                    cont.resume(throwing: BonjourPipeError.failed("listener not ready"))
                                }
                            }
                        }
                    case .failed(let e):
                        let c = Self.classify(e)
                        if once.claim() {
                            cont.resume(throwing: BonjourPipeError.browse(c))
                        } else {
                            onEvent(.failed(c))
                        }
                    case .cancelled:
                        if once.claim() { cont.resume(throwing: BonjourPipeError.closed) }
                    default:
                        break
                    }
                }
                l.start(queue: queue)
            }
        }

        /// Replace the advert (the next epoch, or a new K_disc) on the same port. Nil withdraws it.
        public func update(advert: BonjourAdvert?) {
            let l = lock.withLock { () -> NWListener? in
                guard !stopped, listener != nil else { return nil }
                self.advert = advert
                return listener
            }
            l?.service = advert.map(Self.service)
        }

        public func stop() {
            let l = lock.withLock { () -> NWListener? in
                stopped = true
                defer {
                    listener = nil
                    advert = nil
                }
                return listener
            }
            l?.cancel()
        }

        static func txtRecord(_ advert: BonjourAdvert) -> NWTXTRecord {
            var record = NWTXTRecord()
            for entry in advert.txt {
                if let i = entry.firstIndex(of: "=") {
                    record[String(entry[..<i])] = String(entry[entry.index(after: i)...])
                } else {
                    record.setEntry(.none, for: entry)
                }
            }
            return record
        }

        static func service(_ advert: BonjourAdvert) -> NWListener.Service {
            NWListener.Service(
                name: advert.instance, type: bonjourPeerServiceType, domain: nil, txtRecord: txtRecord(advert))
        }

        static func hostString(_ e: NWEndpoint) -> String {
            if case .hostPort(let host, _) = e { return "\(host)" }
            return "\(e)"
        }

        static func classify(_ e: NWError) -> BonjourBrowseError {
            if case .dns(let code) = e { return BonjourErrors.classify(dnsError: code) }
            return .unavailable("\(e)")
        }
    }
#endif
