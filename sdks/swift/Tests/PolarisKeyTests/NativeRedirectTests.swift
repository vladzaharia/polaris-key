// @pkey-feature identity.redirect.native
//
// The native redirect sign-in (I-15b.4, WIRE-CONTRACT-V5 §12.12): client-core's `redirect.ts`
// helpers ported (their vectors are the redirect-native-* recordings), then the session over a
// stub transport, then the loopback listener's rules one by one over a real socket (macOS). The
// wire conversations themselves are the transcripts' (`TranscriptTests`).
//
// Listener rules (plans/I-15.md section 2), each a test below:
//   bind first          testTheSessionBindsBeforeItPushesAndPushesTheBoundPort,
//                       testTheBoundSocketIsHeldAgainstAnotherBind
//   127.0.0.1, port     testTheListenerIsReachableOnLoopbackOnAnExplicitPort
//   exact path          testOnlyTheExactPathIsServed
//   one request         testTheFirstGoodCallbackGetsTheSingle303ThenTheSocketCloses
//   reject the rest     testOnlyTheExactPathIsServed, testAForeignHostHeaderIsRefused,
//                       testADeliveryThatIsNotThisSignInsDoesNotEndIt
//   timeout             testTheListenerClosesAtItsLifetime
//   never log the code  testNothingPrintsTheCode

import Foundation
import PolarisKey
import PolarisKeyCore
import XCTest

@testable import PolarisKeyIdentity

#if canImport(Network)
    import Darwin
#endif

private let api = "https://key.example/djdl"
private let state = "tidewater-state-0123456789"
private let verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
private let issuer = "https://key.example/djdl/identity"
private let handle = "rq_fxXQ7DEgqPUfZlsJYdm76w"
private let requestUri = "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
private let scheme = "com.tidewater.studio:/pkey/callback"
private let loopback = "http://127.0.0.1:49152/pkey/callback"

final class NativeRedirectHelperTests: XCTestCase {
    func testTheClassOfARedirectUri() {
        let table: [(String?, NativeRedirectClass?)] = [
            ("http://127.0.0.1:49152/pkey/callback", .loopback),
            ("http://[::1]:49152/pkey/callback", .loopback),
            (scheme, .scheme),
            ("https://app.example/open/pkey", .claimed),
            ("http://localhost:49152/pkey/callback", nil),
            ("http://127.0.0.1/pkey/callback", nil),
            ("http://127.0.0.1:80/pkey/callback", nil),
            ("http://127.0.0.1:049152/pkey/callback", nil),
            ("http://127.0.0.1:70000/pkey/callback", nil),
            ("http://127.0.0.1:49152/other", nil),
            ("http://127.0.0.1:49152/pkey/callback?x=1", nil),
            ("http://127.0.0.1:49152/pkey/callback#f", nil),
            ("http://user@127.0.0.1:49152/pkey/callback", nil),
            ("com.x:/other", nil), ("com.x:/pkey/callback?q=1", nil),
            ("javascript:/pkey/callback", nil), ("https://app.example/", nil),
            ("https://u@app.example/open", nil),
            ("http://127.0.0.1:49152/pkey/callback ", nil), ("", nil), (nil, nil),
        ]
        for (uri, want) in table {
            XCTAssertEqual(NativeRedirect.classify(uri), want, uri ?? "nil")
        }
    }

    func testRedirectUrisAreBuiltFromAPortOrAScheme() throws {
        XCTAssertEqual(try NativeRedirect.loopbackUri(port: 49152), loopback)
        XCTAssertEqual(try NativeRedirect.schemeUri("com.tidewater.studio"), scheme)
        for port in [0, 80, 65536] { XCTAssertThrowsError(try NativeRedirect.loopbackUri(port: port)) }
        for name in ["https", "", "Com.X", "1x"] { XCTAssertThrowsError(try NativeRedirect.schemeUri(name)) }
    }

    func testTheClassOrderIsLoopbackThenSchemeThenClaimedThenTheFallback() {
        let claimed = "https://app.example/open/pkey"
        let discovery = NativeRedirectDiscovery(loopback: true, schemes: [scheme], claimedHttps: [claimed])
        func pick(listen: Bool, schemes: [String] = [scheme], claims: [String] = [claimed])
            -> NativeRedirectChoice
        {
            NativeRedirect.chooseClass(
                requestEndpoint: "\(api)/identity/request", discovery: discovery, canListen: listen,
                registeredSchemes: schemes, registeredClaimed: claims)
        }
        XCTAssertEqual(pick(listen: true), .loopback)
        XCTAssertEqual(pick(listen: false), .scheme(scheme))
        XCTAssertEqual(pick(listen: false, schemes: []), .claimed(claimed))
        // A class the host has but discovery does not list is not used.
        let bare = NativeRedirectDiscovery(loopback: false)
        XCTAssertEqual(
            NativeRedirect.chooseClass(
                requestEndpoint: "\(api)/identity/request", discovery: bare, canListen: true,
                registeredSchemes: [scheme], registeredClaimed: [claimed]),
            .unavailable(.noClass))
        XCTAssertEqual(
            NativeRedirect.chooseClass(requestEndpoint: nil, discovery: discovery, canListen: true),
            .unavailable(.requestNotServed))
    }

    private func push(
        redirect: String = loopback, deviceName: String? = "Ada's Mac", returnUri: String? = nil
    ) throws -> PushedRequest {
        try NativeRedirect.pushRequest(
            requestEndpoint: "\(api)/identity/request", authorizeEndpoint: "\(api)/identity/authorize",
            tokenEndpoint: "\(api)/identity/token", issuer: issuer, clientId: "djdl", redirectUri: redirect,
            deviceName: deviceName, returnUri: returnUri, state: state, codeVerifier: verifier)
    }

    func testThePushIsTheRecordedForm() throws {
        let transcript = try XCTUnwrap(
            TranscriptFiles.load().first { $0.id == "redirect-native-loopback" })
        guard case .object(let want)? = transcript.steps[0].exchanges.items[0].request.body?.json else {
            return XCTFail("the recording holds no push")
        }
        let pushed = try push()
        let pairs = pushed.body.split(separator: "&").map { part -> (String, String) in
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            return (
                kv[0].replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "",
                (kv.count > 1 ? kv[1] : "").replacingOccurrences(of: "+", with: " ").removingPercentEncoding
                    ?? ""
            )
        }
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: pairs), want.compactMapValues(\.stringValue))
        XCTAssertEqual(
            pairs.map(\.0),
            [
                "response_type", "client_id", "redirect_uri", "state", "code_challenge",
                "code_challenge_method", "device_name",
            ])
        XCTAssertFalse(pushed.body.contains(verifier))
        XCTAssertFalse("\(pushed.pending)".contains(verifier))
        XCTAssertEqual(pushed.pending.redirectClass, .loopback)
    }

    func testThePushRefusesBeforeBuildingAnything() {
        XCTAssertThrowsError(try push(redirect: "https://app.example/"))
        XCTAssertThrowsError(try push(redirect: "http://localhost:49152/pkey/callback"))
        XCTAssertThrowsError(try push(redirect: scheme, returnUri: loopback))
        XCTAssertThrowsError(
            try NativeRedirect.pushRequest(
                requestEndpoint: "not a url", authorizeEndpoint: "\(api)/a", tokenEndpoint: "\(api)/t",
                issuer: issuer, clientId: "djdl", redirectUri: loopback))
        XCTAssertThrowsError(
            try NativeRedirect.pushRequest(
                requestEndpoint: "\(api)/r", authorizeEndpoint: "\(api)/a", tokenEndpoint: "\(api)/t",
                issuer: issuer, clientId: "djdl", redirectUri: loopback, state: "short"))
        XCTAssertNoThrow(try push(redirect: scheme, returnUri: scheme))
    }

    func testThePushedAnswer() {
        let ok = JSONValue.object(["request_uri": .string(requestUri), "expires_in": .int(600)])
        XCTAssertEqual(
            NativeRedirect.parsePushedAnswer(status: 201, body: ok), .pushed(requestUri: requestUri, expiresIn: 600))
        for expires in [0, 601] {
            XCTAssertEqual(
                NativeRedirect.parsePushedAnswer(
                    status: 201, body: .object(["request_uri": .string(requestUri), "expires_in": .int(expires)])),
                .malformed)
        }
        XCTAssertEqual(
            NativeRedirect.parsePushedAnswer(
                status: 201, body: .object(["request_uri": .string("urn:x"), "expires_in": .int(5)])),
            .malformed)
        XCTAssertEqual(
            NativeRedirect.parsePushedAnswer(
                status: 400, body: .object(["error": .string("redirect_uri_mismatch")])),
            .refused(error: "redirect_uri_mismatch", status: 400, retryAfterSeconds: nil))
        XCTAssertEqual(
            NativeRedirect.parsePushedAnswer(
                status: 429, body: .object(["error": .string("rate_limited"), "retryAfter": .double(1.2)])),
            .refused(error: "rate_limited", status: 429, retryAfterSeconds: 2))
        XCTAssertEqual(
            NativeRedirect.parsePushedAnswer(status: 503, body: nil),
            .refused(error: "server_error", status: 503, retryAfterSeconds: nil))
    }

    func testTheAuthorizeUrlCarriesTheClientAndTheRequestUriOnly() throws {
        XCTAssertEqual(
            try NativeRedirect.authorizeUrl(
                endpoint: "\(api)/identity/authorize", clientId: "djdl", requestUri: requestUri),
            "\(api)/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw"
        )
        XCTAssertThrowsError(
            try NativeRedirect.authorizeUrl(endpoint: "\(api)/a", clientId: "djdl", requestUri: "urn:x"))
    }

    private func check(_ url: String, redirect: String = loopback) -> NativeCallbackResult {
        NativeRedirect.parseCallback(
            state: state, issuer: issuer, redirectUri: redirect, callbackUrl: url)
    }

    func testTheCallbackIsCheckedInTheFixedOrder() {
        let iss = "iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"
        let base = loopback
        XCTAssertEqual(check("\(base)?code=C&state=\(state)&\(iss)&request=\(handle)"), .code("C", request: handle))
        XCTAssertEqual(check("\(scheme)?code=C&state=\(state)&\(iss)", redirect: scheme), .code("C", request: nil))
        XCTAssertEqual(
            check("\(base)?error=access_denied&state=\(state)&\(iss)&request=\(handle)"),
            .cancelled(request: handle))
        XCTAssertEqual(
            check("\(base)?error=server_error&state=\(state)&\(iss)&request=\(handle)"),
            .failed(.authorizationError, error: "server_error"))
        let failures: [(String, NativeCallbackFailure)] = [
            ("\(base)?code=C&state=\(state)&\(iss)&request=\(handle)#frag", .malformed),
            ("http://127.0.0.1:49153/pkey/callback?code=C&state=\(state)&\(iss)&request=\(handle)", .redirectMismatch),
            ("http://127.0.0.1:49152/other?code=C&state=\(state)&\(iss)", .redirectMismatch),
            ("\(base)?code=C&code=D&state=\(state)&\(iss)&request=\(handle)", .malformed),
            ("\(base)?code=C&state=other-state-0123456789&\(iss)&request=\(handle)", .stateMismatch),
            ("\(base)?code=C&\(iss)&request=\(handle)", .stateMismatch),
            ("\(base)?code=C&state=\(state)&request=\(handle)", .issuerMismatch),
            ("\(base)?code=C&state=\(state)&iss=https%3A%2F%2Fevil.example&request=\(handle)", .issuerMismatch),
            ("\(base)?state=\(state)&\(iss)&request=\(handle)", .missingCode),
            ("\(base)?code=C&state=\(state)&\(iss)&request=\(handle)&extra=1", .unexpectedParameter),
            ("\(base)?code=C&state=\(state)&\(iss)", .requestInvalid),
            ("\(base)?code=C&state=\(state)&\(iss)&request=rq_short", .requestInvalid),
        ]
        for (url, reason) in failures {
            XCTAssertEqual(check(url), .failed(reason, error: nil), url)
        }
        // A scheme delivery that carries a handle must still hold a valid one.
        XCTAssertEqual(
            check("\(scheme)?code=C&state=\(state)&\(iss)&request=bad", redirect: scheme),
            .failed(.requestInvalid, error: nil))
        // The scheme and host compare case-insensitively; the path does not.
        XCTAssertEqual(
            check("HTTP://127.0.0.1:49152/pkey/callback?code=C&state=\(state)&\(iss)&request=\(handle)"),
            .code("C", request: handle))
        XCTAssertEqual(
            check("\(base.replacingOccurrences(of: "callback", with: "CALLBACK"))?code=C&state=\(state)&\(iss)&request=\(handle)"),
            .failed(.redirectMismatch, error: nil))
    }

    func testOnlyAForeignDeliveryLeavesTheSignInWaiting() {
        let waiting: Set<NativeCallbackFailure> = [.malformed, .redirectMismatch, .stateMismatch]
        for reason in [
            NativeCallbackFailure.malformed, .redirectMismatch, .stateMismatch, .issuerMismatch,
            .authorizationError, .missingCode, .unexpectedParameter, .requestInvalid,
        ] {
            XCTAssertEqual(reason.leavesSessionWaiting, waiting.contains(reason), reason.rawValue)
        }
    }

    func testNothingPrintsTheCode() {
        let result = NativeCallbackResult.code("SECRET-CODE-123", request: handle)
        for text in ["\(result)", String(reflecting: result), "\(try! push().pending)"] {
            XCTAssertFalse(text.contains("SECRET-CODE-123"), text)
            XCTAssertFalse(text.contains(verifier), text)
            XCTAssertFalse(text.contains(state), text)
        }
    }

    func testConstantTimeEquality() {
        XCTAssertTrue(NativeRedirect.constantTimeEqual("abc", "abc"))
        XCTAssertFalse(NativeRedirect.constantTimeEqual("abc", "abd"))
        XCTAssertFalse(NativeRedirect.constantTimeEqual("abc", "abcd"))
        XCTAssertFalse(NativeRedirect.constantTimeEqual("", "a"))
    }

    func testAHeadlessHostHasNoBrowserForALoopbackListener() {
        XCTAssertTrue(isHeadlessSession(environment: ["SSH_CONNECTION": "1 2 3 4"], linux: false))
        XCTAssertTrue(isHeadlessSession(environment: ["SSH_TTY": "/dev/pts/0"], linux: false))
        XCTAssertTrue(isHeadlessSession(environment: ["CI": "true"], linux: false))
        XCTAssertTrue(isHeadlessSession(environment: [:], linux: true))
        XCTAssertFalse(isHeadlessSession(environment: ["DISPLAY": ":0"], linux: true))
        XCTAssertFalse(isHeadlessSession(environment: ["WAYLAND_DISPLAY": "wayland-0"], linux: true))
        XCTAssertFalse(isHeadlessSession(environment: [:], linux: false))
    }
}

// ── The session ──────────────────────────────────────────────────────────────────────────────

final class NativeRedirectSessionTests: XCTestCase {
    private var server = StubServer()
    private let requestPath = "/djdl/identity/request"
    private let tokenPath = "/djdl/identity/token"
    private let tokenOk =
        #"{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":{"id":"lic_1"},"subject":"ps_abc"}"#

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(
        request: Bool = true, native: String? = nil, returnPage: String = "https://key.example/signin/return"
    ) async {
        let nativeMember =
            native
            ?? #""nativeRedirect":{"loopback":true,"schemes":["\#(scheme)"],"claimedHttps":[]},"#
        let endpoints =
            #""authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token""#
            + (request ? #","request":"\#(api)/identity/request","signinReturn":"\#(returnPage)""# : "")
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"\#(issuer)",\#(request ? nativeMember : "")"endpoints":{\#(endpoints)}}}}"#
        )
        await server.reply(requestPath, status: 201, body: #"{"request_uri":"\#(requestUri)","expires_in":600}"#)
        await server.reply(tokenPath, body: tokenOk)
    }

    private func client(deviceId: String = "dev") async throws -> PolarisKeyClient {
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: deviceId),
                transport: server.transport, expectedServices: [.identity], fingerprint: false))
        c.identity.redirectAcquisitionSync.set(false)
        c.identity.redirectEntropy.set((state: state, codeVerifier: verifier))
        return c
    }

    private func options(
        _ native: NativeRedirectOptions = NativeRedirectOptions(loopback: true, registeredSchemes: [], openBrowser: false),
        browser: (any SignInBrowser)? = nil
    ) -> SignInOptions {
        SignInOptions(channel: .redirect, browser: browser, native: native)
    }

    private final class Listeners: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var made: [ReplayListener] = []
        let onMake: (@Sendable () -> Void)?
        init(onMake: (@Sendable () -> Void)? = nil) { self.onMake = onMake }
        func make() -> ReplayListener {
            onMake?()
            let l = ReplayListener(port: 49152 + lock.withLock { made.count })
            lock.withLock { made.append(l) }
            return l
        }
    }

    private func install(_ c: PolarisKeyClient, _ listeners: Listeners) {
        c.identity.nativeListenerFactory.set { listeners.make() }
    }

    private func header(_ request: PolarisRequest, _ name: String) -> String? {
        request.headers.first { $0.key.lowercased() == name }?.value
    }

    private func pushedBody() async throws -> String {
        let pushes = await server.requests(forPath: requestPath)
        return String(decoding: try XCTUnwrap(pushes.first?.body), as: UTF8.self)
    }

    private func callback(_ port: Int = 49152, _ q: String? = nil) -> String {
        "http://127.0.0.1:\(port)/pkey/callback?"
            + (q ?? "code=C0DE&state=\(state)&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity&request=\(handle)")
    }

    func testTheSessionBindsBeforeItPushesAndPushesTheBoundPort() async throws {
        let order = LockedValue<[String]>([])
        await discovery()
        let c = try await client()
        let listeners = Listeners { order.with { $0.append("bind") } }
        install(c, listeners)
        await server.route(requestPath) { _ in
            order.with { $0.append("push") }
            return StubServer.Reply(status: 201, body: #"{"request_uri":"\#(requestUri)","expires_in":600}"#)
        }
        let s = try await c.identity.signIn.start(options())
        XCTAssertEqual(order.current, ["bind", "push"])
        let pushes = await server.requests(forPath: requestPath)
        XCTAssertEqual(pushes.count, 1)
        let body = String(decoding: try XCTUnwrap(pushes[0].body), as: UTF8.self)
        XCTAssertTrue(body.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fpkey%2Fcallback"), body)
        XCTAssertEqual(header(pushes[0], "x-pkey-device"), "dev")
        XCTAssertEqual(pushes[0].headers["content-type"], "application/x-www-form-urlencoded")
        XCTAssertNil(pushes[0].headers["authorization"])
        XCTAssertEqual(
            s.authorizeUrl,
            "\(api)/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw"
        )
        XCTAssertEqual(s.outcome, .pending)
        s.cancel()
    }

    func testTheCodeIsRedeemedFromThePushingDeviceWithoutRepeatingTheLabel() async throws {
        await discovery()
        let c = try await client(deviceId: "pusher-device")
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        let reply = try XCTUnwrap(listeners.made[0].deliver(callback()))
        XCTAssertEqual(reply, NativeListenerReply(location: "https://key.example/signin/return?request=\(handle)", final: true))
        let outcome = try await s.wait()
        guard case .signedIn(let ready) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(ready.subject, "ps_abc")
        XCTAssertTrue(listeners.made[0].closed)
        let tokens = await server.requests(forPath: tokenPath)
        XCTAssertEqual(tokens.count, 1)
        XCTAssertEqual(header(tokens[0], "x-pkey-device"), "pusher-device")
        XCTAssertNil(tokens[0].headers["authorization"])
        let form = String(decoding: try XCTUnwrap(tokens[0].body), as: UTF8.self)
        XCTAssertFalse(form.contains("device_name"), form)
        XCTAssertTrue(form.contains("code_verifier=\(verifier)"))
        // Settled: the same outcome again, and nothing more is sent.
        let again = try await s.wait()
        XCTAssertEqual(again, outcome)
        let after = await server.requests(forPath: tokenPath)
        XCTAssertEqual(after.count, 1)
    }

    func testNoRequestEndpointIsRedirectUnavailableAndNothingIsSent() async throws {
        await discovery(request: false)
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        do {
            _ = try await c.identity.signIn.start(options())
            XCTFail("started")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.redirectUnavailable)
        }
        XCTAssertTrue(listeners.made.isEmpty, "no socket for a product that serves no request endpoint")
        let pushes = await server.requests(forPath: requestPath)
        XCTAssertTrue(pushes.isEmpty)
    }

    func testAClassTheProductDoesNotListIsNotUsed() async throws {
        await discovery(native: #""nativeRedirect":{"loopback":false,"schemes":[],"claimedHttps":[]},"#)
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        for native in [
            NativeRedirectOptions(loopback: true, registeredSchemes: [], openBrowser: false),
            NativeRedirectOptions(loopback: false, registeredSchemes: [scheme], openBrowser: false),
        ] {
            do {
                _ = try await c.identity.signIn.start(options(native))
                XCTFail("started")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, ErrorCode.redirectUnavailable)
            }
        }
        let pushes = await server.requests(forPath: requestPath)
        XCTAssertTrue(pushes.isEmpty)
    }

    func testAListenerThatCannotBindFallsBackToTheRegisteredScheme() async throws {
        await discovery()
        let c = try await client()
        c.identity.nativeListenerFactory.set { throw NativeListenerUnavailable() }
        let s = try await c.identity.signIn.start(
            options(NativeRedirectOptions(loopback: true, registeredSchemes: [scheme], openBrowser: false)))
        XCTAssertEqual(s.native?.redirectClass, .scheme)
        let body = try await pushedBody()
        XCTAssertTrue(body.contains("redirect_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback"), body)
        s.cancel()
        // With no scheme to fall back to there is nothing to start.
        do {
            _ = try await c.identity.signIn.start(options())
            XCTFail("started")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.redirectUnavailable)
        }
    }

    func testAReturnPageOutsideTheProductIsRefusedBeforeAnythingIsBound() async throws {
        await discovery(returnPage: "https://evil.example/signin/return")
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        do {
            _ = try await c.identity.signIn.start(options())
            XCTFail("started")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.invalidOptions)
        }
        XCTAssertTrue(listeners.made.isEmpty)
    }

    func testAPushTheWorkerRefusesIsTypedAndReleasesTheSocket() async throws {
        await discovery()
        await server.reply(requestPath, status: 400, body: #"{"error":"redirect_uri_mismatch"}"#)
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        do {
            _ = try await c.identity.signIn.start(options())
            XCTFail("started")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, "redirect_uri_mismatch")
        }
        XCTAssertTrue(listeners.made[0].closed)
        XCTAssertNil(c.identity.nativeActive.current)
    }

    func testAMalformedPushedAnswerIsABadResponse() async throws {
        await discovery()
        await server.reply(requestPath, status: 201, body: #"{"request_uri":"nope","expires_in":600}"#)
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        do {
            _ = try await c.identity.signIn.start(options())
            XCTFail("started")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.badResponse)
        }
        XCTAssertTrue(listeners.made[0].closed)
    }

    func testADeliveryThatIsNotThisSignInsDoesNotEndIt() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        let listener = listeners.made[0]
        // Another sign-in's state, another URL: a 404 that keeps listening.
        for url in [
            callback(49152, "code=C&state=other-state-0123456789&iss=\(issuer)&request=\(handle)"),
            "http://127.0.0.1:49152/other?code=C",
        ] {
            XCTAssertEqual(listener.deliver(url), NativeListenerReply(location: nil, final: false), url)
        }
        XCTAssertFalse(listener.closed)
        XCTAssertEqual(s.outcome, .pending)
        // A failure that IS this sign-in's ends it, with a 404 and no redemption.
        let bad = listener.deliver(callback(49152, "code=C&state=\(state)&iss=https%3A%2F%2Fevil.example&request=\(handle)"))
        XCTAssertEqual(bad, NativeListenerReply(location: nil, final: true))
        do {
            _ = try await s.wait()
            XCTFail("settled")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let tokens = await server.requests(forPath: tokenPath)
        XCTAssertTrue(tokens.isEmpty)
    }

    func testOnlyTheFirstCallbackIsAccepted() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        let first = listeners.made[0].deliver(callback())
        XCTAssertEqual(first?.final, true)
        XCTAssertNotNil(first?.location)
        let second = listeners.made[0].deliver(callback())
        XCTAssertEqual(second, NativeListenerReply(location: nil, final: true))
        _ = try await s.wait()
        let tokens = await server.requests(forPath: tokenPath)
        XCTAssertEqual(tokens.count, 1)
    }

    func testAccessDeniedOnTheReturnPageCarriesNoCodeAndCancels() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        let reply = listeners.made[0].deliver(
            callback(49152, "error=access_denied&state=\(state)&iss=\(issuer)&request=\(handle)"))
        XCTAssertEqual(
            reply?.location, "https://key.example/signin/return?request=\(handle)&cancelled=1")
        let outcome = try await s.wait()
        XCTAssertEqual(outcome, .cancelled)
        let tokens = await server.requests(forPath: tokenPath)
        XCTAssertTrue(tokens.isEmpty)
    }

    func testHandleRedirectTakesASchemeDeliveryAndRefusesAForeignOne() async throws {
        await discovery()
        let c = try await client()
        do {
            _ = try await c.identity.signIn.handleRedirect("\(scheme)?code=C")
            XCTFail("no sign-in was waiting")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let s = try await c.identity.signIn.start(
            options(NativeRedirectOptions(loopback: false, registeredSchemes: [scheme], openBrowser: false)))
        XCTAssertEqual(s.native?.redirectClass, .scheme)
        let iss = "iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"
        for foreign in [
            "\(scheme)?code=C&state=other-state-0123456789&\(iss)",
            "com.other.app:/pkey/callback?code=C&state=\(state)&\(iss)",
        ] {
            do {
                _ = try await c.identity.signIn.handleRedirect(foreign)
                XCTFail("accepted \(foreign)")
            } catch let e as SignInError {
                XCTAssertEqual(e.code, ErrorCode.signInFailed)
            }
        }
        let none = await server.requests(forPath: tokenPath)
        XCTAssertTrue(none.isEmpty, "a foreign delivery never reaches the token endpoint")
        XCTAssertEqual(s.outcome, .pending)
        let outcome = try await c.identity.signIn.handleRedirect("\(scheme)?code=C&state=\(state)&\(iss)")
        guard case .signedIn = outcome else { return XCTFail("\(outcome)") }
        // Single use: the same delivery again is refused without a request.
        do {
            _ = try await c.identity.signIn.handleRedirect("\(scheme)?code=C&state=\(state)&\(iss)")
            XCTFail("a replayed delivery was accepted")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let tokens = await server.requests(forPath: tokenPath)
        XCTAssertEqual(tokens.count, 1)
        // The scheme class sends no handle and no listener: the push had a return page only on loopback.
        let body = try await pushedBody()
        XCTAssertFalse(body.contains("return_uri"))
    }

    func testReopenGivesTheSameUrlUntilTheSignInEnds() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let browser = await MainActor.run { FakeBrowser() }
        let s = try await c.identity.signIn.start(
            options(NativeRedirectOptions(loopback: true, registeredSchemes: [], openBrowser: true), browser: browser))
        let reopened = await s.reopen()
        XCTAssertTrue(reopened)
        let opened = await MainActor.run { browser.opened }
        XCTAssertEqual(opened.count, 2)
        XCTAssertEqual(Set(opened.map(\.absoluteString)), [try XCTUnwrap(s.authorizeUrl)])
        let pushes = await server.requests(forPath: requestPath)
        XCTAssertEqual(pushes.count, 1, "reopening is not a new push")
        s.cancel()
        let afterCancel = await s.reopen()
        XCTAssertFalse(afterCancel)
    }

    func testCancelClosesTheListenerDropsTheRequestAndRefusesALaterDelivery() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        s.cancel()
        XCTAssertTrue(listeners.made[0].closed)
        let outcome = try await s.wait()
        XCTAssertEqual(outcome, .cancelled)
        XCTAssertNil(s.native?.pendingView)
        do {
            _ = try await c.identity.signIn.handleRedirect(callback())
            XCTFail("a cancelled sign-in took a delivery")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let tokens = await server.requests(forPath: tokenPath)
        XCTAssertTrue(tokens.isEmpty)
    }

    func testTheRequestLapsingSettlesExpiredAndClosesTheListener() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        XCTAssertTrue(try XCTUnwrap(s.native).arrivals.arrive(.expired))
        let outcome = try await s.wait()
        XCTAssertEqual(outcome, .expired)
        XCTAssertTrue(listeners.made[0].closed)
    }

    func testACancelledWaitingTaskThrowsAndTheSignInKeepsGoing() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        let waiter = Task { try await s.wait() }
        try await Task.sleep(nanoseconds: 50_000_000)
        waiter.cancel()
        do {
            _ = try await waiter.value
            XCTFail("the cancelled wait returned")
        } catch is CancellationError {}
        XCTAssertEqual(s.outcome, .pending)
        XCTAssertFalse(listeners.made[0].closed)
        _ = listeners.made[0].deliver(callback())
        let outcome = try await s.wait()
        guard case .signedIn = outcome else { return XCTFail("\(outcome)") }
    }

    func testANewSignInReplacesTheOneStillWaiting() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let first = try await c.identity.signIn.start(options())
        let second = try await c.identity.signIn.start(options())
        XCTAssertTrue(listeners.made[0].closed)
        XCTAssertFalse(listeners.made[1].closed)
        let replaced = try await first.wait()
        XCTAssertEqual(replaced, .cancelled)
        XCTAssertEqual(second.outcome, .pending)
        second.cancel()
    }

    func testTheWorkersRefusalOfTheCodeIsTypedAndNeverWipesTheToken() async throws {
        await discovery()
        await server.reply(tokenPath, status: 400, body: #"{"error":"invalid_grant"}"#)
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        _ = listeners.made[0].deliver(callback())
        do {
            _ = try await s.wait()
            XCTFail("redeemed")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, "invalid_grant")
        }
        let held = await c.core.token
        XCTAssertNil(held)
    }

    func testTheCodeFromAPushedRequestCanBeCompletedThroughCompleteToo() async throws {
        await discovery()
        let c = try await client()
        let listeners = Listeners()
        install(c, listeners)
        let s = try await c.identity.signIn.start(options())
        let outcome = try await s.complete(callbackUrl: callback())
        guard case .signedIn = outcome else { return XCTFail("\(outcome)") }
    }
}

// ── The loopback listener, over a real socket ────────────────────────────────────────────────

#if canImport(Network)
    final class NativeLoopbackListenerTests: XCTestCase {
        /// One raw HTTP exchange on 127.0.0.1:`port`; nil when the connection was refused.
        private func raw(_ port: Int, _ request: String) async -> String? {
            await withCheckedContinuation { continuation in
                DispatchQueue.global().async {
                    let fd = socket(AF_INET, SOCK_STREAM, 0)
                    defer { close(fd) }
                    var address = sockaddr_in()
                    address.sin_family = sa_family_t(AF_INET)
                    address.sin_port = in_port_t(port).bigEndian
                    address.sin_addr.s_addr = inet_addr("127.0.0.1")
                    let rc = withUnsafePointer(to: &address) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                        }
                    }
                    guard rc == 0 else { return continuation.resume(returning: nil) }
                    var timeout = timeval(tv_sec: 3, tv_usec: 0)
                    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                    let bytes = Array(request.utf8)
                    _ = bytes.withUnsafeBufferPointer { send(fd, $0.baseAddress, $0.count, 0) }
                    var out = Data()
                    var buffer = [UInt8](repeating: 0, count: 2048)
                    while true {
                        let n = recv(fd, &buffer, buffer.count, 0)
                        if n <= 0 { break }
                        out.append(contentsOf: buffer[0..<n])
                    }
                    continuation.resume(returning: String(decoding: out, as: UTF8.self))
                }
            }
        }

        private func get(_ port: Int, _ target: String, host: String? = nil, method: String = "GET") async -> String? {
            await raw(
                port, "\(method) \(target) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\nConnection: close\r\n\r\n")
        }

        private func bound(lifetime: TimeInterval = 600) async throws -> (NWLoopbackListener, LockedValue<[String]>) {
            let listener: NWLoopbackListener
            do { listener = try await NWLoopbackListener.bind(lifetime: lifetime) } catch {
                throw XCTSkip("this host cannot bind a loopback socket: \(error)")
            }
            let seen = LockedValue<[String]>([])
            listener.start { url in
                seen.with { $0.append(url) }
                return NativeListenerReply(location: "https://key.example/signin/return?request=rq_x", final: true)
            }
            return (listener, seen)
        }

        func testTheListenerIsReachableOnLoopbackOnAnExplicitPort() async throws {
            let (listener, _) = try await bound()
            defer { listener.close() }
            XCTAssertGreaterThan(listener.port, 1023)
            XCTAssertNotEqual(listener.port, 80)
            let answer = await get(listener.port, "/other")
            XCTAssertNotNil(answer, "127.0.0.1 is served")
            // The socket is on 127.0.0.1 and nothing wider: it is not reachable through the machine's other addresses.
            var wide = sockaddr_in()
            wide.sin_family = sa_family_t(AF_INET)
            wide.sin_port = in_port_t(listener.port).bigEndian
            wide.sin_addr.s_addr = INADDR_ANY
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            defer { close(fd) }
            let rc = withUnsafePointer(to: &wide) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            XCTAssertNotEqual(rc, 0, "another socket cannot take the port on any address while it is held")
        }

        func testTheBoundSocketIsHeldAgainstAnotherBind() async throws {
            let (listener, _) = try await bound()
            defer { listener.close() }
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            defer { close(fd) }
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(listener.port).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            var reuse: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
            let rc = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            XCTAssertNotEqual(rc, 0, "a second bind on the held port was allowed")
        }

        func testOnlyTheExactPathIsServed() async throws {
            let (listener, seen) = try await bound()
            defer { listener.close() }
            for target in [
                "/", "/other", "/pkey/callbackx", "/pkey/callback/", "/PKEY/CALLBACK", "/pkey/callback%2f", "pkey/callback",
                "//pkey/callback", "/pkey/../pkey/callback",
            ] {
                let answer = await get(listener.port, target)
                XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 404") == true, "\(target): \(answer ?? "nil")")
            }
            for method in ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"] {
                let answer = await get(listener.port, "/pkey/callback?code=C", method: method)
                XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 404") == true, "\(method): \(answer ?? "nil")")
            }
            XCTAssertTrue(seen.current.isEmpty, "nothing off the path reached the session")
        }

        func testAForeignHostHeaderIsRefused() async throws {
            let (listener, seen) = try await bound()
            defer { listener.close() }
            for host in ["evil.example", "localhost:\(listener.port)", "127.0.0.1", "127.0.0.1:\(listener.port + 1)"] {
                let answer = await get(listener.port, "/pkey/callback?code=C", host: host)
                XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 404") == true, "\(host): \(answer ?? "nil")")
            }
            XCTAssertTrue(seen.current.isEmpty)
        }

        func testTheFirstGoodCallbackGetsTheSingle303ThenTheSocketCloses() async throws {
            let (listener, seen) = try await bound()
            let first = await get(listener.port, "/pkey/callback?code=C&state=S")
            let answer = try XCTUnwrap(first)
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 303 See Other\r\n"), answer)
            XCTAssertTrue(answer.contains("Location: https://key.example/signin/return?request=rq_x\r\n"), answer)
            XCTAssertTrue(answer.contains("Cache-Control: no-store\r\n"), answer)
            XCTAssertTrue(answer.contains("Referrer-Policy: no-referrer\r\n"), answer)
            XCTAssertTrue(answer.contains("Content-Length: 0\r\n"), answer)
            XCTAssertEqual(seen.current, ["http://127.0.0.1:\(listener.port)/pkey/callback?code=C&state=S"])
            // Closed after the answer: the next connection is refused (or, in the instant before the
            // close lands, a 404 that never reaches the session).
            try await Task.sleep(nanoseconds: 300_000_000)
            let next = await get(listener.port, "/pkey/callback?code=D&state=S")
            XCTAssertNil(next, "the listener is still open after its one callback")
            XCTAssertEqual(seen.current.count, 1)
            listener.close()
        }

        func testAnUnfinishedRequestIsDroppedAndNothingReachesTheSession() async throws {
            let (listener, seen) = try await bound()
            defer { listener.close() }
            let answer = await raw(listener.port, "GET /pkey/callback?code=C HTTP/1.1\r\nHost: 127.0.0.1:\(listener.port)\r\n")
            // No blank line ever arrives: the connection is closed after its deadline with no redirect.
            XCTAssertTrue(answer?.contains("303") != true)
            XCTAssertTrue(seen.current.isEmpty)
        }

        func testTheListenerClosesAtItsLifetime() async throws {
            let (listener, _) = try await bound(lifetime: 0.3)
            let before = await get(listener.port, "/other")
            XCTAssertNotNil(before)
            try await Task.sleep(nanoseconds: 900_000_000)
            let after = await get(listener.port, "/other")
            XCTAssertNil(after, "the listener outlived its lifetime")
        }

        func testCloseReleasesThePortAndIsIdempotent() async throws {
            let (listener, _) = try await bound()
            listener.close()
            listener.close()
            try await Task.sleep(nanoseconds: 200_000_000)
            let after = await get(listener.port, "/other")
            XCTAssertNil(after)
        }

        func testASessionOverARealListenerRedeemsOnceTheBrowserIsRedirected() async throws {
            let server = StubServer()
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body:
                    #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"\#(issuer)","nativeRedirect":{"loopback":true,"schemes":[],"claimedHttps":[]},"endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","request":"\#(api)/identity/request","signinReturn":"https://key.example/signin/return"}}}}"#
            )
            await server.reply(
                "/djdl/identity/request", status: 201, body: #"{"request_uri":"\#(requestUri)","expires_in":600}"#)
            await server.reply(
                "/djdl/identity/token",
                body:
                    #"{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc"}"#
            )
            let c = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                    transport: server.transport, expectedServices: [.identity], fingerprint: false))
            c.identity.redirectAcquisitionSync.set(false)
            let s: SignInSession
            do {
                s = try await c.identity.signIn.start(
                    SignInOptions(
                        channel: .redirect,
                        native: NativeRedirectOptions(loopback: true, registeredSchemes: [], openBrowser: false)))
            } catch let e as PolarisError where e.code == ErrorCode.redirectUnavailable {
                throw XCTSkip("this host cannot bind a loopback socket")
            }
            let flow = try XCTUnwrap(s.native)
            let port = try XCTUnwrap(URLComponents(string: flow.redirectUri)?.port)
            let pushes = await server.requests(forPath: "/djdl/identity/request")
            let pushed = String(decoding: try XCTUnwrap(pushes.first?.body), as: UTF8.self)
            XCTAssertTrue(pushed.contains("127.0.0.1%3A\(port)%2Fpkey%2Fcallback"), pushed)
            let pending = try XCTUnwrap(flow.pendingView)
            let iss = "https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"
            // A request with another person's state is a 404 and the sign-in goes on waiting.
            let stray = await get(port, "/pkey/callback?code=X&state=other-state-0123456789&iss=\(iss)&request=\(handle)")
            XCTAssertTrue(stray?.hasPrefix("HTTP/1.1 404") == true, stray ?? "nil")
            XCTAssertEqual(s.outcome, .pending)
            let good = await get(
                port, "/pkey/callback?code=C0DE&state=\(pending.state)&iss=\(iss)&request=\(handle)")
            let answer = try XCTUnwrap(good)
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 303"), answer)
            XCTAssertTrue(answer.contains("Location: https://key.example/signin/return?request=\(handle)"), answer)
            let outcome = try await s.wait()
            guard case .signedIn = outcome else { return XCTFail("\(outcome)") }
            let held = await c.core.token
            XCTAssertEqual(held, "pkeyt_new")
        }
    }
#endif
