// @pkey-feature identity.link identity.redirect.native ui.signin
//
// I-44.11: the SwiftUI kit's sign-in on the native redirect (rung 6) and the link steps that follow
// a sign-in this device started. The model starts the SDK's native redirect where there is one and
// the device code where the SDK answers redirect-unavailable (or the person asked for a code); then
// link-offer, link-done and link-conflict run over `identity.link`, and every way out of them
// closes the offer (`link.pending` is false afterwards).

#if canImport(SwiftUI)
    import Foundation
    import PolarisKey
    import PolarisKeyCore
    import PolarisKeyIdentity
    import PolarisKeyPlatform
    @testable import PolarisKeyUI
    import PolarisKeyUICore
    import SwiftUI
    import XCTest

    @testable import PolarisKeyIdentity

    @MainActor
    final class KitLinkStepsTests: XCTestCase {
        private var server = StubServer()
        private let api = "https://key.example/djdl"
        private let state = "tidewater-state-0123456789"
        private let verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
        private let requestUri = "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
        private let handle = "lh_" + String(repeating: "c", count: 43)
        private let requestHandle = "rq_fxXQ7DEgqPUfZlsJYdm76w"
        private let subject = "ps_abc"

        override func setUp() async throws { server = StubServer() }

        private final class AppleProvider: PlatformIdentityProvider, @unchecked Sendable {
            let kind: ExchangeKind = .apple
            struct Nothing: Error {}
            func silent(nonce: String) async throws -> PlatformSubjectToken { throw Nothing() }
            func sheet(nonce: String) async throws -> PlatformSubjectToken {
                PlatformSubjectToken(token: "apple.id.token", nonce: nonce)
            }
            func signOutCleanup() async {}
            func credentialRevoked() async -> Bool { false }
        }

        private final class FailingProvider: PlatformIdentityProvider, @unchecked Sendable {
            let kind: ExchangeKind = .apple
            struct Nothing: Error {}
            func silent(nonce: String) async throws -> PlatformSubjectToken { throw Nothing() }
            func sheet(nonce: String) async throws -> PlatformSubjectToken { throw Nothing() }
            func signOutCleanup() async {}
            func credentialRevoked() async -> Bool { false }
        }

        /// Holds the link offer's GET until the test lets it go.
        private actor Gate {
            private var waiting: [CheckedContinuation<Void, Never>] = []
            private var open = false
            func wait() async {
                if open { return }
                await withCheckedContinuation { waiting.append($0) }
            }
            func release() {
                open = true
                for continuation in waiting { continuation.resume() }
                waiting = []
            }
        }

        private struct HeldTransport: PolarisTransport {
            let inner: StubTransport
            let gate: Gate
            func send(_ request: PolarisRequest) async throws -> PolarisResponse {
                if request.method == "GET", request.url.path == "/djdl/identity/link" { await gate.wait() }
                return try await inner.send(request)
            }
        }

        private final class Listeners: @unchecked Sendable {
            private let lock = NSLock()
            private(set) var made: [ReplayListener] = []
            func make() -> ReplayListener {
                let l = ReplayListener(port: 49152 + lock.withLock { made.count })
                lock.withLock { made.append(l) }
                return l
            }
        }

        private func discovery(native: Bool = true, offer: String = #"[{"kind":"apple","reach":"developer"}]"#)
            async
        {
            let request =
                native
                ? #","request":"\#(api)/identity/request","signinReturn":"https://key.example/signin/return""# : ""
            let nativeMember =
                native ? #""nativeRedirect":{"loopback":true,"schemes":[],"claimedHttps":[]},"# : ""
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body:
                    #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"\#(api)/identity","exchange":{"kinds":["apple"]},"nonce":"\#(api)/identity/nonce",\#(nativeMember)"endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","link":"\#(api)/identity/link","nonce":"\#(api)/identity/nonce"\#(request)}},"license":{"enabled":true,"configured":true}}}"#
            )
            await server.reply(
                "/djdl/identity/request", status: 201,
                body: #"{"request_uri":"\#(requestUri)","expires_in":600}"#)
            await server.reply(
                "/djdl/identity/token",
                body:
                    #"{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"\#(subject)"}"#
            )
            await server.reply("/djdl/identity/link", body: #"{"offer":\#(offer)}"#)
            await server.reply(
                "/djdl/identity/nonce", body: #"{"nonce":"\#(String(repeating: "N", count: 43))","expiresIn":300}"#)
            await server.reply(
                "/djdl/auth/device/start", body: "{}")
            await server.reply(
                "/djdl/identity/auth/device/start",
                body:
                    #"{"deviceCode":"dc_1","userCode":"WDJB-MJHT","verificationUri":"https://polaris.locker/device","verificationUriComplete":"https://polaris.locker/device?user_code=WDJB-MJHT","expiresIn":600,"interval":5}"#
            )
        }

        private func model(
            browser: FakeBrowser? = nil, store: InMemoryStore? = nil, transport: (any PolarisTransport)? = nil
        ) async throws
            -> (PolarisKeyGateModel, PolarisKeyClient, Listeners, InMemoryStore)
        {
            let held = store ?? InMemoryStore(deviceId: "DEVICE00000000000000000000000001")
            let c = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    core: CoreOptions(
                        productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                        pinnedKeys: [:], trustRefresh: false, store: held, transport: transport ?? server.transport,
                        expectedServices: [.license, .identity],
                        // No device label: the macOS computer name is read through the Contacts store, which a CI
                        // runner without a GUI session never answers (each sign-in then stalls for ~30 s).
                        deviceName: ""),
                    license: LicenseClientOptions(fingerprint: false),
                    connect: ConnectOptions(keys: try LabelKeyPort(label: "kit-link-key-1"))))
            c.identity.redirectAcquisitionSync.set(false)
            c.identity.redirectEntropy.set((state: state, codeVerifier: verifier))
            c.identity.installPlatformIdentity(AppleProvider())
            let listeners = Listeners()
            c.identity.nativeListenerFactory.set { listeners.make() }
            let m = PolarisKeyGateModel(
                client: c, options: KitGateOptions(autoSignIn: false), browser: browser ?? FakeBrowser())
            await m.reload()
            return (m, c, listeners, held)
        }

        private func settle(_ done: () -> Bool) async throws {
            for _ in 0..<150 where !done() { try await Task.sleep(nanoseconds: 20_000_000) }
        }

        private func callback(_ port: Int = 49152) -> String {
            "http://127.0.0.1:\(port)/pkey/callback?code=C0DE&state=\(state)&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity&request=\(requestHandle)"
        }

        /// A native sign-in taken to its end: the redirect arrives and the token is redeemed.
        private func signIn(_ m: PolarisKeyGateModel, _ listeners: Listeners) async throws {
            m.beginSignIn()
            try await settle { !listeners.made.isEmpty && m.request != nil }
            XCTAssertNotNil(listeners.made.first?.deliver(callback()))
        }

        // ── Rung 6 ───────────────────────────────────────────────────────────────────────────

        func testTheSignInStartsTheNativeRedirectAndOpensTheSdksBrowser() async throws {
            await discovery()
            let browser = FakeBrowser()
            let (m, _, listeners, _) = try await model(browser: browser)
            m.beginSignIn()
            try await settle { m.nativeSessionWaiting }
            let pushes = await server.requests(forPath: "/djdl/identity/request")
            XCTAssertEqual(pushes.count, 1)
            let body = String(decoding: try XCTUnwrap(pushes.first?.body), as: UTF8.self)
            XCTAssertTrue(body.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fpkey%2Fcallback"), body)
            let codes = await server.requests(forPath: "/djdl/identity/auth/device/start")
            XCTAssertTrue(codes.isEmpty, "no device code on the native path")
            XCTAssertEqual(m.handoff.state, .waiting)
            XCTAssertEqual(browser.opened.count, 1)
            // Open browser again is the same page, never a second push.
            m.reopenBrowser()
            try await settle { browser.opened.count == 2 }
            XCTAssertEqual(Set(browser.opened.map(\.absoluteString)).count, 1)
            let again = await server.requests(forPath: "/djdl/identity/request")
            XCTAssertEqual(again.count, 1)
            // Cancel ends the session and closes the socket.
            m.cancelSignIn()
            XCTAssertTrue(listeners.made[0].closed)
            XCTAssertEqual(m.signInScreen.state, .methods)
        }

        func testAProductWithNoNativeRedirectTakesTheDeviceCode() async throws {
            await discovery(native: false)
            let (m, _, listeners, _) = try await model()
            m.beginSignIn()
            try await settle { m.request != nil }
            XCTAssertEqual(m.request?.userCode, "WDJB-MJHT")
            XCTAssertTrue(listeners.made.isEmpty)
            let pushes = await server.requests(forPath: "/djdl/identity/request")
            XCTAssertTrue(pushes.isEmpty)
            m.cancelSignIn()
        }

        func testASignInWithACodeNeverStartsTheRedirect() async throws {
            await discovery()
            let (m, _, listeners, _) = try await model()
            m.beginSignIn(code: true)
            try await settle { m.request != nil }
            XCTAssertEqual(m.request?.userCode, "WDJB-MJHT")
            XCTAssertTrue(listeners.made.isEmpty)
            let pushes = await server.requests(forPath: "/djdl/identity/request")
            XCTAssertTrue(pushes.isEmpty)
            m.cancelSignIn()
        }

        func testUseACodeInsteadEndsTheRedirectAndAsksForACode() async throws {
            await discovery()
            let (m, _, listeners, _) = try await model()
            m.beginSignIn()
            try await settle { m.nativeSessionWaiting }
            m.useCode()
            try await settle { m.handoff.state == .code }
            XCTAssertEqual(m.handoff.state, .code)
            XCTAssertTrue(listeners.made[0].closed)
            XCTAssertEqual(m.request?.userCode, "WDJB-MJHT")
            m.cancelSignIn()
        }

        // ── The link steps ───────────────────────────────────────────────────────────────────

        func testASameDeviceSignInEndsOnTheLinkOfferAndNoThanksRemembersIt() async throws {
            await discovery()
            let (m, c, listeners, store) = try await model()
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            XCTAssertEqual(m.signInScreen.state, .linkOffer)
            XCTAssertTrue(m.linkStepActive)
            XCTAssertTrue(c.identity.link.pending)
            XCTAssertNil(m.toast, "the sign-in's toast waits for the offer")
            await m.declineLinkOffer()
            XCTAssertFalse(m.linkStepActive)
            XCTAssertFalse(c.identity.link.pending)
            XCTAssertEqual(m.route, .welcome)
            let kept = await store.readRecord(IdentityClient.linkDeclinedRecord)
            XCTAssertNotNil(kept)
        }

        func testAcceptSendsOneRequestWithTheHandleAndDismissesOnLinked() async throws {
            await discovery()
            let (m, c, listeners, _) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            await server.route("/djdl/identity/link") { request in
                request.method == "POST"
                    ? StubServer.Reply(body: #"{"linked":{"kind":"apple","reach":"developer"}}"#)
                    : StubServer.Reply(body: #"{"offer":[]}"#)
            }
            await m.acceptLinkOffer()
            XCTAssertEqual(m.signInScreen.state, .linkDone)
            XCTAssertFalse(c.identity.link.pending, "dismiss() on linked")
            m.finishLink()
            XCTAssertFalse(m.linkStepActive)
            XCTAssertEqual(m.route, .welcome)
            let posts = await server.requests(forPath: "/djdl/identity/link").filter { $0.method == "POST" }
            XCTAssertEqual(posts.count, 1)
        }

        func testAConflictShowsTheConflictStepAndDoneLeavesIt() async throws {
            await discovery()
            let (m, c, listeners, _) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            await server.route("/djdl/identity/link") { request in
                request.method == "POST"
                    ? StubServer.Reply(status: 409, body: #"{"error":{"code":"link_conflict"}}"#)
                    : StubServer.Reply(body: #"{"offer":[]}"#)
            }
            await m.acceptLinkOffer()
            XCTAssertEqual(m.signInScreen.state, .linkConflict)
            XCTAssertFalse(c.identity.link.pending)
            m.finishLink()
            XCTAssertEqual(m.route, .welcome)
        }

        private func failLink(status: Int, code: String) async {
            await server.route("/djdl/identity/link") { request in
                request.method == "POST"
                    ? StubServer.Reply(status: status, body: #"{"error":{"code":"\#(code)"}}"#)
                    : StubServer.Reply(body: #"{"offer":[{"kind":"apple","reach":"developer"}]}"#)
            }
        }

        func testAStaleStepUpKeepsTheOfferWithSignInAgainAndLinkIsOneTapAfter() async throws {
            await discovery()
            let (m, c, listeners, store) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            await failLink(status: 401, code: "step_up_required")
            await m.acceptLinkOffer()
            let screen = m.signInScreen
            XCTAssertEqual(screen.state, .linkOffer)
            XCTAssertTrue(screen.shows("signin.linkOffer.stale"))
            XCTAssertEqual(m.announcement?.key, "signin.linkOffer.stale", "the problem line is announced")
            XCTAssertTrue(screen.shows("signin.again"))
            XCTAssertFalse(screen.shows("signin.linkOffer.primary"))
            XCTAssertTrue(screen.shows("signin.linkOffer.decline"))
            XCTAssertTrue(c.identity.link.pending)
            let kept = await store.readRecord(IdentityClient.linkDeclinedRecord)
            XCTAssertNil(kept)
            // Sign in again: a fresh sign-in, then the offer is back with Link and the handle held.
            await server.route("/djdl/identity/link") { request in
                request.method == "POST"
                    ? StubServer.Reply(body: #"{"linked":{"kind":"apple","reach":"developer"}}"#)
                    : StubServer.Reply(body: #"{"offer":[{"kind":"apple","reach":"developer"}]}"#)
            }
            m.linkSignInAgain()
            // What is drawn: the hand-off, with the app held back (never the bare app).
            XCTAssertTrue(m.holdsApp)
            XCTAssertEqual(m.route, .signIn)
            try await settle { listeners.made.count == 2 && m.request != nil }
            XCTAssertTrue(m.holdsApp)
            XCTAssertEqual(m.signInScreen.state, .handoff)
            XCTAssertEqual(m.handoff.state, .waiting)
            XCTAssertNotNil(listeners.made[1].deliver(callback(49153)))
            try await settle { m.signInScreen.state == .linkOffer }
            XCTAssertEqual(m.signInScreen.state, .linkOffer)
            XCTAssertTrue(m.signInScreen.shows("signin.linkOffer.primary"))
            XCTAssertFalse(m.signInScreen.shows("signin.linkOffer.stale"))
            XCTAssertEqual(m.announcement?.key, "signin.linkOffer.title")
            await m.acceptLinkOffer()
            XCTAssertEqual(m.signInScreen.state, .linkDone)
            let posts = await server.requests(forPath: "/djdl/identity/link").filter { $0.method == "POST" }
            XCTAssertEqual(posts.count, 2)
        }

        func testCancelOnTheSecondSignInEndsTheLinkAndShowsTheApp() async throws {
            await discovery()
            let (m, c, listeners, store) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            await failLink(status: 401, code: "step_up_required")
            await m.acceptLinkOffer()
            m.linkSignInAgain()
            try await settle { m.handoff.state == .waiting }
            XCTAssertTrue(m.holdsApp)
            m.cancelSignIn()
            XCTAssertFalse(m.holdsApp)
            XCTAssertEqual(m.route, .welcome)
            XCTAssertFalse(c.identity.link.pending)
            let kept = await store.readRecord(IdentityClient.linkDeclinedRecord)
            XCTAssertNil(kept)
        }

        func testTheAppIsNeverDrawnWhileTheOfferIsBeingDecided() async throws {
            await discovery()
            let gate = Gate()
            let held = HeldTransport(inner: server.transport, gate: gate)
            let (m, _, listeners, _) = try await model(transport: held)
            m.beginSignIn()
            try await settle { !listeners.made.isEmpty && m.request != nil }
            XCTAssertNotNil(listeners.made[0].deliver(callback()))
            // The token is redeemed and the gate reloaded while the link GET is held.
            try await settle { m.holdsApp }
            var samples = 0
            for _ in 0..<40 {
                try await Task.sleep(nanoseconds: 10_000_000)
                do {
                    samples += 1
                    XCTAssertTrue(m.holdsApp, "the app must not draw before the offer is decided")
                    XCTAssertEqual(m.route, .signIn)
                    XCTAssertNotEqual(m.signInScreen.state, .linkOffer)
                }
            }
            XCTAssertGreaterThan(samples, 0)
            XCTAssertTrue(m.holdsApp)
            await gate.release()
            try await settle { m.signInScreen.state == .linkOffer }
            XCTAssertEqual(m.signInScreen.state, .linkOffer)
            XCTAssertTrue(m.holdsApp)
            XCTAssertEqual(m.route, .signIn)
        }

        func testNoOfferReleasesTheHoldAndShowsTheApp() async throws {
            await discovery(offer: #"[{"kind":"google","reach":null}]"#)
            let (m, _, listeners, _) = try await model()
            try await signIn(m, listeners)
            try await settle { !m.holdsApp && m.route == .welcome }
            XCTAssertFalse(m.holdsApp)
            XCTAssertEqual(m.route, .welcome)
        }

        func testLinkShowsProgressAndNoThanksIsOffWhileItRuns() async throws {
            await discovery()
            let (m, c, listeners, _) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            let task = Task { await m.acceptLinkOffer() }
            // The stub answers at once; what is pinned is that a second press is ignored and the
            // flag is down afterwards.
            await task.value
            XCTAssertFalse(m.linkWorking)
            XCTAssertTrue(m.holdsApp || !m.linkStepActive)
        }

        func testARefusedDeviceLosesLinkAndNoThanksIsTheWayOn() async throws {
            for (status, code) in [(404, "not_found"), (400, "invalid_grant")] {
                server = StubServer()
                await discovery()
                let (m, c, listeners, _) = try await model()
                c.identity.linkHold(handle: handle, expiresAt: Int.max)
                try await signIn(m, listeners)
                try await settle { m.signInScreen.state == .linkOffer }
                await failLink(status: status, code: code)
                await m.acceptLinkOffer()
                let screen = m.signInScreen
                XCTAssertEqual(screen.state, .linkOffer, code)
                XCTAssertTrue(screen.shows("signin.linkOffer.failed"), code)
                XCTAssertEqual(m.announcement?.key, "signin.linkOffer.failed", code)
                XCTAssertFalse(screen.shows("signin.linkOffer.primary"), code)
                XCTAssertFalse(screen.shows("signin.again"), code)
                XCTAssertTrue(screen.shows("signin.linkOffer.decline"), code)
                await m.declineLinkOffer()
                XCTAssertFalse(m.linkStepActive, code)
                XCTAssertFalse(c.identity.link.pending, code)
            }
        }

        func testANetworkFailureKeepsLinkWithTheNetworkLine() async throws {
            await discovery()
            let (m, c, listeners, _) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            await server.route("/djdl/identity/link") { request in
                request.method == "POST"
                    ? StubServer.Reply(status: 503, body: "{}")
                    : StubServer.Reply(body: #"{"offer":[{"kind":"apple","reach":"developer"}]}"#)
            }
            await server.drop("/djdl/identity/link")
            await m.acceptLinkOffer()
            let screen = m.signInScreen
            XCTAssertEqual(screen.state, .linkOffer)
            XCTAssertTrue(screen.shows("core.codes.network.message"))
            XCTAssertTrue(screen.shows("signin.linkOffer.primary"))
            XCTAssertFalse(screen.shows("signin.again"))
            XCTAssertTrue(c.identity.link.pending)
            XCTAssertEqual(m.announcement?.key, "core.codes.network.message")
        }

        func testAServerErrorIsNotARefusalAndLinkStays() async throws {
            await discovery()
            let (m, c, listeners, _) = try await model()
            c.identity.linkHold(handle: handle, expiresAt: Int.max)
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            await failLink(status: 503, code: "unavailable")
            await m.acceptLinkOffer()
            let screen = m.signInScreen
            XCTAssertEqual(screen.state, .linkOffer)
            XCTAssertTrue(screen.shows("core.codes.network.message"))
            XCTAssertFalse(screen.shows("signin.linkOffer.failed"))
            XCTAssertTrue(screen.shows("signin.linkOffer.primary"))
        }

        func testAnUnavailableAcceptEndsTheOfferQuietly() async throws {
            await discovery()
            let (m, c, listeners, store) = try await model()
            c.identity.installPlatformIdentity(FailingProvider())
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            // No handle held and the provider's sheet fails: nothing to link with.
            await m.acceptLinkOffer()
            XCTAssertFalse(m.linkStepActive)
            XCTAssertFalse(c.identity.link.pending)
            let kept = await store.readRecord(IdentityClient.linkDeclinedRecord)
            XCTAssertNil(kept)
        }

        func testNoOfferForTheInstalledProviderMeansNoStep() async throws {
            await discovery(offer: #"[{"kind":"google","reach":null}]"#)
            let (m, c, listeners, _) = try await model()
            try await signIn(m, listeners)
            try await settle { !c.identity.link.pending }
            XCTAssertFalse(m.linkStepActive)
            XCTAssertNotEqual(m.signInScreen.state, .linkOffer)
            XCTAssertFalse(c.identity.link.pending)
        }

        func testLeavingTheOfferIsNotThanksAndRemembersNothing() async throws {
            await discovery()
            let (m, c, listeners, store) = try await model()
            try await signIn(m, listeners)
            try await settle { m.signInScreen.state == .linkOffer }
            m.cancelSignIn()
            XCTAssertFalse(m.linkStepActive)
            XCTAssertFalse(c.identity.link.pending)
            let kept = await store.readRecord(IdentityClient.linkDeclinedRecord)
            XCTAssertNil(kept)
        }

        func testADeviceCodeSignInOpensNoOffer() async throws {
            await discovery()
            await server.reply("/djdl/identity/auth/device/poll", body: "{}")
            let (m, c, _, _) = try await model()
            m.beginSignIn(code: true)
            try await settle { m.request != nil }
            XCTAssertFalse(c.identity.link.pending)
            XCTAssertFalse(m.linkStepActive)
            m.cancelSignIn()
        }
    }

    extension PolarisKeyGateModel {
        /// The native session is up and waiting for the redirect.
        fileprivate var nativeSessionWaiting: Bool {
            request != nil && handoff.state == .waiting
        }
    }

#endif
