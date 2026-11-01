// The native redirect sign-in (WIRE-CONTRACT-V5 §12.12; I-15b.4): the app pushes its authorization
// request, opens the system browser at `authorize` with the `request_uri` it got back, and receives
// the code on a redirect it owns:
//
//   - loopback (macOS default): a listener on 127.0.0.1 with an OS-assigned port, bound BEFORE the
//     request is pushed and held until the first good callback, the lifetime or `cancel()`;
//   - a registered scheme or a claimed HTTPS link (iOS and visionOS default): an
//     `ASWebAuthenticationSession` hands the callback URL back; a delivery from elsewhere (the
//     host's `onOpenURL`, a universal link) comes in through `signIn.handleRedirect(_:)`.
//
// `signIn.start(SignInOptions(channel: .redirect))` with no `redirectUri` begins one and returns
// the session; `session.wait()` settles it. Rules of the listener (§12.12, SR-I15):
//
//   - bind first: the port is ours before the Worker learns it;
//   - 127.0.0.1 only, an explicit port other than 80, the exact path `/pkey/callback`;
//   - one callback: the first good one gets the single `303`, then the socket closes; every other
//     request is a `404` with no body, and a delivery that is not this sign-in's does not end it;
//   - the code is never logged and never leaves the callback URL, which is not stored.

@preconcurrency import Dispatch
import Foundation
import PolarisKeyCore

#if canImport(Network)
    import Network
#endif

// ── The listener seam ────────────────────────────────────────────────────────────────────────

/// Where the listener sends the browser after a callback: `location` is the `303` target (nil
/// answers `404`), and `final` closes the listener once this answer is sent.
struct NativeListenerReply: Sendable, Equatable {
    var location: String?
    var final: Bool
}

/// A bound loopback socket. A test supplies one without a socket (`IdentityClient.nativeListenerFactory`).
protocol NativeLoopbackListener: Sendable {
    /// The bound port.
    var port: Int { get }
    /// Begin serving: `accept` gets the absolute callback URL of every request at the callback path.
    func start(_ accept: @escaping @Sendable (String) -> NativeListenerReply)
    /// Stop listening and release the port. Safe to call more than once.
    func close()
}

/// The listener could not be bound (for example a sandbox without the network server entitlement).
struct NativeListenerUnavailable: Error {}

#if canImport(Network)
    /// The loopback listener over `NWListener`.
    final class NWLoopbackListener: NativeLoopbackListener, @unchecked Sendable {
        private let listener: NWListener
        private let queue = DispatchQueue(label: "polaris-key.native-redirect.listener")
        private let lock = NSLock()
        private var boundPort = 0
        private var accept: (@Sendable (String) -> NativeListenerReply)?
        private var done = false
        private var closed = false
        private var timer: DispatchSourceTimer?
        private let lifetime: TimeInterval
        private var liveConnections = 0
        /// Concurrent connections served; the rest are closed at once.
        static let connectionCap = 16

        var port: Int { lock.withLock { boundPort } }

        private init(lifetime: TimeInterval) throws {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = false
            // 127.0.0.1 and nothing else, whatever the machine's other addresses are.
            parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
            self.listener = try NWListener(using: parameters)
            self.lifetime = lifetime
            listener.newConnectionHandler = { [weak self] connection in self?.handle(connection) }
        }

        /// Bind to 127.0.0.1 on an OS-assigned port and return once it is listening. Nothing is
        /// answered with a redirect until `start(_:)`.
        static func bind(lifetime: TimeInterval = TimeInterval(NativeRedirect.pushedRequestTtlSeconds))
            async throws -> NWLoopbackListener
        {
            let bound: NWLoopbackListener
            do { bound = try NWLoopbackListener(lifetime: lifetime) } catch { throw NativeListenerUnavailable() }
            let once = LockedValue(false)
            let port: Int = try await withCheckedThrowingContinuation { continuation in
                bound.listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        guard let raw = bound.listener.port?.rawValue,
                            once.with({ taken -> Bool in
                                defer { taken = true }
                                return !taken
                            })
                        else { return }
                        continuation.resume(returning: Int(raw))
                    case .failed, .cancelled:
                        guard
                            once.with({ taken -> Bool in
                                defer { taken = true }
                                return !taken
                            })
                        else {
                            bound.close()
                            return
                        }
                        continuation.resume(throwing: NativeListenerUnavailable())
                    default: break
                    }
                }
                bound.listener.start(queue: bound.queue)
            }
            bound.lock.withLock { bound.boundPort = port }
            bound.listener.stateUpdateHandler = { [weak bound] state in
                if case .failed = state { bound?.close() }
            }
            return bound
        }

        func start(_ accept: @escaping @Sendable (String) -> NativeListenerReply) {
            let arm = lock.withLock { () -> Bool in
                guard !closed, self.accept == nil else { return false }
                self.accept = accept
                return true
            }
            guard arm else { return }
            let source = DispatchSource.makeTimerSource(queue: queue)
            source.schedule(deadline: .now() + lifetime)
            source.setEventHandler { [weak self] in self?.close() }
            let stillOpen = lock.withLock { () -> Bool in
                if closed { return false }
                timer = source
                return true
            }
            if stillOpen { source.resume() } else { source.cancel() }
        }

        func close() {
            let (source, already) = lock.withLock { () -> (DispatchSourceTimer?, Bool) in
                let was = closed
                closed = true
                let t = timer
                timer = nil
                accept = nil
                return (t, was)
            }
            source?.cancel()
            if !already { listener.cancel() }
        }

        // One request per connection: read the head, answer, close.

        private func handle(_ connection: NWConnection) {
            let admitted = lock.withLock { () -> Bool in
                guard liveConnections < Self.connectionCap else { return false }
                liveConnections += 1
                return true
            }
            guard admitted else {
                connection.cancel()
                return
            }
            let released = LockedValue(false)
            connection.stateUpdateHandler = { [weak self] state in
                switch state {
                case .cancelled, .failed:
                    let first = released.with { done -> Bool in
                        defer { done = true }
                        return !done
                    }
                    if first { self?.lock.withLock { self?.liveConnections -= 1 } }
                default: break
                }
            }
            connection.start(queue: queue)
            let deadline = DispatchWorkItem { connection.cancel() }
            queue.asyncAfter(deadline: .now() + 5, execute: deadline)
            receive(connection, buffer: Data(), deadline: deadline)
        }

        private func receive(_ connection: NWConnection, buffer: Data, deadline: DispatchWorkItem) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
                [weak self] data, _, isComplete, error in
                guard let self else {
                    connection.cancel()
                    return
                }
                var received = buffer
                if let data { received.append(data) }
                if let end = received.range(of: Data("\r\n\r\n".utf8)) {
                    deadline.cancel()
                    self.answer(connection, head: received[..<end.lowerBound])
                } else if received.count >= 8192 || isComplete || error != nil {
                    deadline.cancel()
                    self.send(connection, status: 404, location: nil, closeListener: false)
                } else {
                    self.receive(connection, buffer: received, deadline: deadline)
                }
            }
        }

        private func answer(_ connection: NWConnection, head: Data) {
            guard let text = String(data: head, encoding: .utf8) else {
                send(connection, status: 404, location: nil, closeListener: false)
                return
            }
            let lines = text.components(separatedBy: "\r\n")
            let request = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: true)
            let host = lines.dropFirst().compactMap { line -> String? in
                guard let colon = line.firstIndex(of: ":"),
                    line[..<colon].lowercased() == "host"
                else { return nil }
                return line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces).lowercased()
            }.first
            let target = request.count == 3 ? String(request[1]) : ""
            let route = target.prefix(while: { $0 != "?" })
            guard request.count == 3, request[0] == "GET", request[2].hasPrefix("HTTP/1."),
                target.hasPrefix("/"), route == NativeRedirect.path[...], host == "127.0.0.1:\(port)"
            else {
                send(connection, status: 404, location: nil, closeListener: false)
                return
            }
            let reply = deliver("http://127.0.0.1:\(port)\(target)")
            send(
                connection, status: reply.location != nil ? 303 : 404, location: reply.location,
                closeListener: reply.final)
        }

        /// One request at the callback path. The first accepted one wins; every later one is a 404.
        private func deliver(_ url: String) -> NativeListenerReply {
            let handler = lock.withLock { () -> (@Sendable (String) -> NativeListenerReply)? in
                done || closed ? nil : accept
            }
            guard let handler else { return NativeListenerReply(location: nil, final: false) }
            let reply = handler(url)
            guard reply.final else { return reply }
            let won = lock.withLock { () -> Bool in
                if done { return false }
                done = true
                return true
            }
            return won ? reply : NativeListenerReply(location: nil, final: false)
        }

        private func send(_ connection: NWConnection, status: Int, location: String?, closeListener: Bool) {
            var head = status == 303 ? "HTTP/1.1 303 See Other\r\n" : "HTTP/1.1 404 Not Found\r\n"
            if status == 303, let location,
                !location.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
            {
                head += "Location: \(location)\r\n"
            }
            head +=
                "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            connection.send(
                content: Data(head.utf8),
                completion: .contentProcessed { [weak self] _ in
                    connection.cancel()
                    if closeListener { self?.close() }
                })
        }
    }
#endif

// ── Arrival ──────────────────────────────────────────────────────────────────────────────────

/// What ended the wait for the redirect.
enum NativeArrival: Sendable, Equatable {
    case callback(NativeCallbackResult)
    case cancelled
    /// The pushed request lapsed.
    case expired
}

/// The first arrival wins; every waiter sees it. A waiter is cancellation-aware.
final class NativeArrivals: Sendable {
    private struct State {
        var arrival: NativeArrival?
        var waiters: [Int: CheckedContinuation<NativeArrival, any Error>] = [:]
        var next = 0
    }
    private let state = LockedValue(State())

    /// False when an arrival was already taken.
    @discardableResult
    func arrive(_ arrival: NativeArrival) -> Bool {
        let waiters = state.with { st -> [CheckedContinuation<NativeArrival, any Error>]? in
            guard st.arrival == nil else { return nil }
            st.arrival = arrival
            let all = Array(st.waiters.values)
            st.waiters = [:]
            return all
        }
        guard let waiters else { return false }
        for waiter in waiters { waiter.resume(returning: arrival) }
        return true
    }

    var current: NativeArrival? { state.current.arrival }

    func next() async throws -> NativeArrival {
        let id = state.with { st -> Int in
            st.next += 1
            return st.next
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NativeArrival, any Error>) in
                enum Step {
                    case resume(NativeArrival)
                    case cancel, wait
                }
                let step = state.with { st -> Step in
                    if let arrival = st.arrival { return .resume(arrival) }
                    if Task.isCancelled { return .cancel }
                    st.waiters[id] = continuation
                    return .wait
                }
                switch step {
                case .resume(let arrival): continuation.resume(returning: arrival)
                case .cancel: continuation.resume(throwing: CancellationError())
                case .wait: break
                }
            }
        } onCancel: {
            let waiter = state.with { $0.waiters.removeValue(forKey: id) }
            waiter?.resume(throwing: CancellationError())
        }
    }
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────

/// One native sign-in between the push and the redirect. A secret holder through `pending`.
final class NativeFlow: Sendable {
    let redirectClass: NativeRedirectClass
    let redirectUri: String
    let authorizeUrl: String
    /// When the pushed request lapses, in the SDK's clock (epoch seconds).
    let expiresAt: Int
    let expiresIn: Int
    let returnPage: String?
    let listener: (any NativeLoopbackListener)?
    let arrivals = NativeArrivals()

    private struct State {
        var pending: NativePending?
        var closed = false
        var expiry: Task<Void, Never>?
        var redeem: Task<Result<SignInOutcome, any Error>, Never>?
    }
    private let state: LockedValue<State>

    init(
        pending: NativePending, authorizeUrl: String, expiresAt: Int, expiresIn: Int,
        listener: (any NativeLoopbackListener)?, returnPage: String?
    ) {
        self.redirectClass = pending.redirectClass
        self.redirectUri = pending.redirectUri
        self.authorizeUrl = authorizeUrl
        self.expiresAt = expiresAt
        self.expiresIn = expiresIn
        self.listener = listener
        self.returnPage = returnPage
        self.state = LockedValue(State(pending: pending))
    }

    var pendingView: NativePending? { state.current.pending }
    var isClosed: Bool { state.current.closed }

    /// Take the pending request: it is used for ONE callback and one token request.
    func takePending() -> NativePending? {
        state.with { st in
            let taken = st.pending
            st.pending = nil
            return taken
        }
    }

    func setExpiry(_ task: Task<Void, Never>) {
        let stale = state.with { st -> Task<Void, Never>? in
            if st.closed { return task }
            let old = st.expiry
            st.expiry = task
            return old
        }
        stale?.cancel()
    }

    /// Stop listening and drop the expiry timer.
    func shut() {
        let (task, listener) = state.with { st -> (Task<Void, Never>?, (any NativeLoopbackListener)?) in
            st.closed = true
            let t = st.expiry
            st.expiry = nil
            return (t, self.listener)
        }
        task?.cancel()
        listener?.close()
    }

    /// Cancel: drop the pending request and close the listener; the wait settles `.cancelled`.
    func cancel() {
        _ = takePending()
        arrivals.arrive(.cancelled)
        shut()
    }

    /// The redemption, run once whoever asks first (`wait()` or `handleRedirect`).
    func redeem(
        _ make: @escaping @Sendable () async -> Result<SignInOutcome, any Error>
    ) -> Task<Result<SignInOutcome, any Error>, Never> {
        state.with { st in
            if let running = st.redeem { return running }
            let created = Task { await make() }
            st.redeem = created
            return created
        }
    }

    /// The listener's callback: the `303` target and whether this was the last request.
    func onListenerCallback(_ url: String) -> NativeListenerReply {
        guard let pending = pendingView else { return NativeListenerReply(location: nil, final: true) }
        let result = NativeRedirect.parseCallback(pending, url)
        if case .failed(let reason, _) = result, reason.leavesSessionWaiting {
            return NativeListenerReply(location: nil, final: false)
        }
        guard arrivals.arrive(.callback(result)) else { return NativeListenerReply(location: nil, final: true) }
        if case .failed = result { return NativeListenerReply(location: nil, final: true) }
        if let request = result.request, let page = returnPage {
            var cancelled = false
            if case .cancelled = result { cancelled = true }
            return NativeListenerReply(
                location: Self.returnLocation(page, request: request, cancelled: cancelled), final: true)
        }
        return NativeListenerReply(location: nil, final: true)
    }

    /// The customer host's return page for this request (`/signin/return?request=rq_…`); it never
    /// carries a code.
    static func returnLocation(_ page: String, request: String, cancelled: Bool) -> String {
        "\(page)\(page.contains("?") ? "&" : "?")request=\(ManageLink.formEncode(request))"
            + (cancelled ? "&cancelled=1" : "")
    }
}

// ── Options ──────────────────────────────────────────────────────────────────────────────────

/// What the host tells a native redirect sign-in about the app (`SignInOptions.native`).
public struct NativeRedirectOptions: Sendable {
    /// Use the loopback listener. Nil is automatic: on for a macOS desktop session that is not
    /// headless, off elsewhere; true asks for it on any platform with a network stack.
    public var loopback: Bool?
    /// The full redirect URIs (`<scheme>:/pkey/callback`) this build registered with the OS. Nil
    /// reads the URL schemes in the app's Info.plist (`CFBundleURLTypes`).
    public var registeredSchemes: [String]?
    /// The claimed HTTPS redirect URIs (`https://<host><path>`) this build is associated with.
    /// There is no way to read these at run time: the host names them.
    public var registeredClaimed: [String]
    /// A registered scheme's redirect URI for "Return to <App>". It never carries a code.
    public var returnUri: String?
    /// Open the system browser as the session starts. False leaves it to the host (`reopen()`).
    public var openBrowser: Bool

    public init(
        loopback: Bool? = nil, registeredSchemes: [String]? = nil, registeredClaimed: [String] = [],
        returnUri: String? = nil, openBrowser: Bool = true
    ) {
        self.loopback = loopback
        self.registeredSchemes = registeredSchemes
        self.registeredClaimed = registeredClaimed
        self.returnUri = returnUri
        self.openBrowser = openBrowser
    }
}

/// SIGN-IN D-68: a headless session (SSH, CI, or on Linux no display) cannot open a browser for a
/// loopback listener.
func isHeadlessSession(
    environment: [String: String] = ProcessInfo.processInfo.environment, linux: Bool? = nil
) -> Bool {
    let onLinux: Bool
    #if os(Linux)
        onLinux = linux ?? true
    #else
        onLinux = linux ?? false
    #endif
    func set(_ name: String) -> Bool { !(environment[name] ?? "").isEmpty }
    return set("SSH_CONNECTION") || set("SSH_TTY") || set("CI")
        || (onLinux && !set("DISPLAY") && !set("WAYLAND_DISPLAY"))
}

/// The `<scheme>:/pkey/callback` redirect URIs of the app's Info.plist URL schemes.
func infoPlistRedirectSchemes(_ bundle: Bundle = .main) -> [String] {
    guard let types = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] else {
        return []
    }
    return types.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }
        .compactMap { try? NativeRedirect.schemeUri($0.lowercased()) }
}

// ── Starting one ─────────────────────────────────────────────────────────────────────────────

extension IdentityClient {
    private static func origin(of url: String) -> String? {
        guard let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased(),
            let host = parts.host?.lowercased()
        else { return nil }
        return "\(scheme)://\(host)\(parts.port.map { ":\($0)" } ?? "")"
    }

    private static func text(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// Begin a native redirect sign-in (§12.12). The class is the first that applies: loopback
    /// (unless the host is headless, D-68, or `loopback: false`), a registered scheme, a claimed
    /// HTTPS link; none is `redirect-unavailable` (nothing was sent: the caller offers a code).
    ///
    /// The order of a loopback start is the listener's bind, the pushed request, then the
    /// browser, so the port is held before the Worker learns it. Every endpoint is used only when
    /// discovery names it, and the ones the device's headers reach must be on this product.
    func startNative(_ options: SignInOptions) async throws -> SignInSession {
        if await core.discoveryDocument == nil { await core.discover() }
        try await core.requireService(.identity, feature: Feature.identityRedirectNative)
        let native = options.native
        let fragment = await core.discoveryDocument?.identity
        let requestEndpoint = Self.text(fragment?.request)
        let authorize = Self.text(fragment?.authorize)
        let token = Self.text(fragment?.token)
        let issuer = Self.text(fragment?.issuer)
        let returnPage = Self.text(fragment?.signinReturn)
        if let returnPage {
            // The 303 target is the product's own customer host: the API origin or the issuer's.
            let allowed = [Self.origin(of: core.endpoints.baseUrl), issuer.flatMap(Self.origin(of:))]
            guard returnPage.hasPrefix("https://"), allowed.contains(Self.origin(of: returnPage)) else {
                throw PolarisError(
                    code: ErrorCode.invalidOptions, message: "the return page is outside this product.")
            }
        }
        if requestEndpoint != nil, authorize == nil || token == nil || issuer == nil {
            throw PolarisError(
                code: ErrorCode.signInUnavailable,
                message: "this product's discovery serves no redirect sign-in.")
        }
        let schemes = native.registeredSchemes ?? infoPlistRedirectSchemes()
        var claimed = native.registeredClaimed
        if !Self.claimedHttpsSupported { claimed = [] }
        let wantsListener = native.loopback ?? (Self.desktopListens && !isHeadlessSession())
        let canListen = wantsListener && returnPage != nil && Self.platformListens

        func choose(_ listen: Bool) -> NativeRedirectChoice {
            NativeRedirect.chooseClass(
                requestEndpoint: requestEndpoint, discovery: fragment?.nativeRedirect, canListen: listen,
                registeredSchemes: schemes, registeredClaimed: claimed)
        }

        // Bind first, push second: the port is ours before the Worker learns it.
        var choice = choose(canListen)
        var listener: (any NativeLoopbackListener)?
        var redirectUri = ""
        if case .loopback = choice {
            do {
                let bound = try await bindListener()
                listener = bound
                redirectUri = try NativeRedirect.loopbackUri(port: bound.port)
            } catch is NativeListenerUnavailable {
                // A sandbox without the network server entitlement: the scheme, if there is one.
                choice = choose(false)
            }
        }
        switch choice {
        case .loopback: break
        case .scheme(let uri), .claimed(let uri): redirectUri = uri
        case .unavailable(let reason):
            throw PolarisError(
                code: ErrorCode.redirectUnavailable,
                message: "no native redirect can start here; sign in with a code instead (\(reason.rawValue)).")
        }
        guard let requestEndpoint, let authorize, let token, let issuer else {
            listener?.close()
            throw PolarisError(
                code: ErrorCode.signInUnavailable,
                message: "this product's discovery serves no redirect sign-in.")
        }
        do {
            let product = core.endpoints.url("").absoluteString
            guard token.hasPrefix(product), requestEndpoint.hasPrefix(product) else {
                throw PolarisError(
                    code: ErrorCode.badResponse, message: "an endpoint points outside this product.")
            }
            let entropy = redirectEntropy.current
            let label = await core.deviceLabel(options.deviceName)
            let pushed = try NativeRedirect.pushRequest(
                requestEndpoint: requestEndpoint, authorizeEndpoint: authorize, tokenEndpoint: token,
                issuer: issuer, clientId: core.product, redirectUri: redirectUri, deviceName: label,
                returnUri: native.returnUri, scope: options.scope, loginHint: options.loginHint,
                nameHint: options.nameHint, purpose: options.purpose?.rawValue,
                licenseChoice: options.licenseChoice?.rawValue,
                choiceAvailable: fragment?.choiceAvailable == true, state: entropy?.state,
                codeVerifier: entropy?.codeVerifier)
            guard let url = URL(string: pushed.url) else {
                throw PolarisError(code: ErrorCode.badResponse, message: "the request endpoint is not a URL.")
            }
            let response: PolarisResponse
            do {
                response = try await core.request(
                    url, method: "POST", headers: ["content-type": pushed.contentType],
                    body: Data(pushed.body.utf8))
            } catch let error as PolarisError where error.code == PolarisError.localOnly {
                throw error
            } catch {
                throw PolarisError(code: IdentityClient.networkError, message: "the sign-in request could not be sent.")
            }
            let body = try? JSONDecoder().decode(JSONValue.self, from: response.body)
            let (requestUri, expiresIn): (String, Int)
            switch NativeRedirect.parsePushedAnswer(status: response.status, body: body) {
            case .refused(let error, let status, let retryAfter):
                var retry = retryAfter
                if retry == nil,
                    let header = response.headers.first(where: { $0.key.lowercased() == "retry-after" })?
                        .value.trimmingCharacters(in: .whitespaces), let seconds = Int(header)
                {
                    retry = min(seconds, 3600)
                }
                throw SignInError(
                    code: status >= 500 ? IdentityClient.serverError : error,
                    message: "the Worker refused the sign-in request (\(error)).",
                    retryAfterSeconds: retry)
            case .malformed:
                throw PolarisError(
                    code: ErrorCode.badResponse,
                    message: "the request endpoint answered without a complete pushed request.")
            case .pushed(let uri, let lifetime): (requestUri, expiresIn) = (uri, lifetime)
            }
            let flow = NativeFlow(
                pending: pushed.pending,
                authorizeUrl: try NativeRedirect.authorizeUrl(
                    endpoint: authorize, clientId: core.product, requestUri: requestUri),
                expiresAt: await core.now() + expiresIn, expiresIn: expiresIn, listener: listener,
                returnPage: returnPage)
            let session = SignInSession(
                client: self, native: flow, deviceName: label, browser: options.browser)
            flow.setExpiry(
                Task { [weak flow] in
                    guard (try? await self.sleepFor(Double(expiresIn))) != nil else { return }
                    flow?.arrivals.arrive(.expired)
                })
            listener?.start { [weak flow] url in
                flow?.onListenerCallback(url) ?? NativeListenerReply(location: nil, final: true)
            }
            // A new sign-in replaces the one still waiting: its listener closes and its request drops.
            let previous = nativeActive.with { active -> SignInSession? in
                let old = active
                active = session
                return old
            }
            previous?.cancel()
            if native.openBrowser { _ = await session.reopen() }
            return session
        } catch {
            listener?.close()
            throw error
        }
    }

    /// Redeem a native sign-in's code from the device that pushed it (a different device is
    /// `invalid_grant`). The label went with the push and is not repeated.
    func redeemNative(_ pending: NativePending, code: String) async throws -> RedirectRedeemed {
        try await redeemRedirect(
            RedirectPending(
                authorizeUrl: "", state: pending.state, codeVerifier: pending.codeVerifier,
                redirectUri: pending.redirectUri, clientId: pending.clientId, issuer: pending.issuer,
                tokenEndpoint: pending.tokenEndpoint, choiceApp: pending.choiceApp),
            code: code, deviceName: nil, repeatLabel: false)
    }

    func bindListener() async throws -> any NativeLoopbackListener {
        if let factory = nativeListenerFactory.current { return try await factory() }
        #if canImport(Network)
            return try await NWLoopbackListener.bind()
        #else
            throw NativeListenerUnavailable()
        #endif
    }

    /// The host can bind a socket here at all.
    private static var platformListens: Bool {
        #if canImport(Network)
            return true
        #else
            return false
        #endif
    }

    /// A desktop session listens by default; a phone or headset does not.
    private static var desktopListens: Bool {
        #if os(macOS) || os(Linux)
            return true
        #else
            return false
        #endif
    }

    /// Claimed HTTPS needs `ASWebAuthenticationSession.Callback.https`, which is 17.4 / 14.4 and later.
    private static var claimedHttpsSupported: Bool {
        #if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
            if #available(iOS 17.4, macOS 14.4, visionOS 1.2, *) { return true }
            return false
        #else
            return false
        #endif
    }
}
