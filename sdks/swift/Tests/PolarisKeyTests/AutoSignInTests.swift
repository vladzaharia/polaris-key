// @pkey-feature identity.autosignin
//
// I-44.2: the automatic sign-in ladder. A fake provider stands in for the platform, so each rung,
// the sign-out flag, the revoked launch (scenario 11) and every result kind run without an Apple
// Account. The wire conversations are the exchange transcripts' (I-44.3).

import Foundation
import PolarisKey
import PolarisKeyPlatform
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyIdentity

private final class FakeProvider: PlatformIdentityProvider, @unchecked Sendable {
    let kind: ExchangeKind = .apple
    let silentWorks: Bool
    let sheetWorks: Bool
    let revoked: Bool
    let calls = LockedValue<[String]>([])
    var hasSilentRung: Bool { true }
    /// Runs inside the provider call, after it is logged: where a test signs out or cancels.
    var during: (@Sendable () async throws -> Void)?

    init(silent: Bool = true, sheet: Bool = true, revoked: Bool = false) {
        silentWorks = silent
        sheetWorks = sheet
        self.revoked = revoked
    }

    struct Nothing: Error {}

    func silent(nonce: String) async throws -> PlatformSubjectToken {
        calls.with { $0.append("silent") }
        try await during?()
        guard silentWorks else { throw Nothing() }
        return PlatformSubjectToken(token: "apple.id.token", nonce: nonce)
    }
    func sessionStarted(_ token: PlatformSubjectToken) async { calls.with { $0.append("started") } }
    func sheet(nonce: String) async throws -> PlatformSubjectToken {
        calls.with { $0.append("sheet") }
        guard sheetWorks else { throw Nothing() }
        return PlatformSubjectToken(token: "apple.id.token", nonce: nonce)
    }
    func signOutCleanup() async { calls.with { $0.append("cleanup") } }
    func credentialRevoked() async -> Bool { revoked }
}

final class AutoSignInTests: XCTestCase {
    private var server = StubServer()
    private let api = "https://key.example/djdl"
    private let nonce = "sQXGUn9Dig9pVY62opwL2ZY-2R6qs3Rmyj7WRgxJxG4"
    private let grant = "sg_" + String(repeating: "b", count: 43)
    private let handle = "lh_" + String(repeating: "c", count: 43)
    private let tokenOk =
        #"{"access_token":"pkeyt_exchanged","token_type":"Bearer","scope":"profile","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc","issued_token_type":"urn:polaris-key:token-type:device"}"#

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(exchange: Bool = true) async {
        let member = exchange ? #""exchange":{"kinds":["apple"]},"nonce":"\#(api)/identity/nonce","# : ""
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,\#(member)"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","signout":"\#(api)/identity/signout","choiceLicenses":"\#(api)/identity/choice/licenses","choiceDevices":"\#(api)/identity/choice/devices","choiceComplete":"\#(api)/identity/choice/complete","choiceCancel":"\#(api)/identity/choice/cancel"\#(exchange ? #","nonce":"\#(api)/identity/nonce""# : "")}}}}"#
        )
        await server.reply("/djdl/identity/nonce", body: #"{"nonce":"\#(nonce)","expiresIn":300}"#)
    }

    private func client(
        token: String? = nil, licensed: Bool = false, provenance: TokenProvenance? = .signin,
        provider: FakeProvider? = nil
    ) async throws -> (PolarisKeyClient, InMemoryStore) {
        let store = InMemoryStore(deviceId: "DEVICE00000000000000000000000001")
        if let token { await store.setToken(token) }
        var trust: TrustSet = [:]
        if licensed {
            if let provenance { await store.writeRecord("token-origin", Data(provenance.rawValue.utf8)) }
            let signer = TestSigner(kid: "auto-key")
            trust = signer.trust
            let t = Int(Date().timeIntervalSince1970)
            await store.writeCache(
                CacheRecord(docs: [
                    .license: signer.sign(
                        Fixtures.license(
                            deviceId: "DEVICE00000000000000000000000001", licenseId: "lic_auto", issuedAt: t))
                ]))
        }
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: trust, trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        c.identity.redirectAcquisitionSync.set(false)
        if let provider { c.identity.installPlatformIdentity(provider) }
        return (c, store)
    }

    private func count(_ path: String) async -> Int { await server.requests(forPath: path).count }

    // ── Rung 1 ──────────────────────────────────────────────────────────────────────────

    func testRung1AStoredCredentialAndLicenceIsSignedInWithNoRequest() async throws {
        await discovery()
        let provider = FakeProvider()
        let (c, _) = try await client(token: "pkeyt_a", licensed: true, provider: provider)
        let result = try await c.identity.autoSignIn()
        guard case .signedIn(let ready) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(ready.licenseId, "lic_auto")
        XCTAssertEqual(provider.calls.current, [])
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 0)
    }

    func testACredentialWithoutALicenceDoesNotStopTheLadder() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let provider = FakeProvider()
        let (c, _) = try await client(token: "pkeyt_a", provider: provider)
        let result = try await c.identity.autoSignIn()
        guard case .signedIn = result else { return XCTFail("\(result)") }
        XCTAssertEqual(provider.calls.current, ["silent", "started"])
    }

    // ── Rungs 3 and 4 ───────────────────────────────────────────────────────────────────

    func testRung3SignsInSilentlyAndNeverShowsTheSheet() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let provider = FakeProvider()
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn()
        guard case .signedIn(let ready) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(ready.subject, "ps_abc")
        XCTAssertEqual(provider.calls.current, ["silent", "started"])
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_exchanged")
    }

    func testRung4RunsWhenRung3FindsNothingAndTheCallerAllowsIt() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let provider = FakeProvider(silent: false)
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn(AutoSignInOptions(prompt: .optional))
        guard case .signedIn = result else { return XCTFail("\(result)") }
        XCTAssertEqual(provider.calls.current, ["silent", "sheet", "started"])
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 2, "each attempt takes a fresh nonce")
    }

    func testTheDefaultIsSilentOnlySoTheSheetNeverRunsUnlessAskedFor() async throws {
        await discovery()
        let provider = FakeProvider(silent: false)
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        XCTAssertEqual(provider.calls.current, ["silent"])
    }

    func testADismissedSheetIsNeedsSignIn() async throws {
        await discovery()
        let provider = FakeProvider(silent: false, sheet: false)
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn(AutoSignInOptions(prompt: .optional))
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        XCTAssertEqual(provider.calls.current, ["silent", "sheet"])
    }

    func testTheOptionsProviderWinsOverTheInstalledOne() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let installed = FakeProvider()
        let given = FakeProvider()
        let (c, _) = try await client(provider: installed)
        _ = try await c.identity.autoSignIn(AutoSignInOptions(provider: given))
        XCTAssertEqual(installed.calls.current, [])
        XCTAssertEqual(given.calls.current, ["silent", "started"])
    }

    // ── Result kinds ────────────────────────────────────────────────────────────────────

    func testConfirm() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token",
            body:
                #"{"status":"confirm","grant":"\#(grant)","expiresIn":300,"consent":{"client":{"appName":"djdl","developerName":null,"iconUrl":null,"nameVerified":true},"as":{"provider":"apple","email":"a@example.com"},"items":[],"scopeHash":"327f","firstTime":true,"changed":false}}"#
        )
        let (c, _) = try await client(provider: FakeProvider())
        let result = try await c.identity.autoSignIn()
        guard case .confirm(let pending) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(pending.grant, grant)
        XCTAssertFalse("\(result)".contains(grant))
    }

    private var confirmBody: String {
        #"{"status":"confirm","grant":"\#(grant)","expiresIn":300,"consent":{"client":{"appName":"djdl","developerName":null,"iconUrl":null,"nameVerified":true},"as":{"provider":"apple","email":"a@example.com"},"items":[],"scopeHash":"327f","firstTime":true,"changed":false}}"#
    }

    func testTheAppleSessionStartsOnlyWhenChoiceCompleteMakesOne() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: confirmBody)
        await server.reply("/djdl/identity/choice/complete", body: tokenOk)
        let provider = FakeProvider()
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn()
        guard case .confirm(let pending) = result else { return XCTFail("\(result)") }
        XCTAssertFalse(provider.calls.current.contains("started"), "no session yet: nothing is saved")
        _ = try await c.identity.choice.complete(
            grant: pending.grant, choice: nil, consent: ChoiceConsent(claims: []))
        XCTAssertEqual(provider.calls.current.filter { $0 == "started" }.count, 1)
    }

    func testAnotherWayOfSigningInNeverSavesTheAppleSession() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: confirmBody)
        await server.reply("/djdl/identity/choice/cancel", body: "")
        let provider = FakeProvider()
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn()
        guard case .confirm(let pending) = result else { return XCTFail("\(result)") }
        // "Use another account": the grant is dropped, then the person signs in some other way.
        try? await c.identity.choice.cancel(grant: pending.grant)
        try await c.core.setToken("pkeyt_other", source: .signin, person: true)
        XCTAssertFalse(provider.calls.current.contains("started"))
        XCTAssertTrue(c.identity.pendingPlatformSessions.current.isEmpty)
    }

    func testASignOutBetweenTheCheckAndTheStoreUndoesTheStore() async throws {
        await discovery()
        let (c, _) = try await client(provider: FakeProvider())
        let generation = await c.core.signOutGeneration
        await c.core.setBeforeLadderStore { [core = c.core] in
            // signOut() ran here: it bumped the generation and saw no token.
            await core.bumpSignOutGeneration()
        }
        let stored = try await c.core.setTokenUnlessSignedOut("pkeyt_late", generation: generation)
        XCTAssertFalse(stored)
        let token = await c.core.token
        XCTAssertNil(token)
        let provenance = await c.core.tokenProvenance()
        XCTAssertNil(provenance, "rung 1 must not count the late token")
    }

    func testAMirrorNeverShowsTheIdentityToken() {
        let grant = AppleSignInGrant(
            userID: "u1", identityToken: "secret.id.token", authorizationCode: "secretcode", email: nil)
        let subject = PlatformSubjectToken(token: "secret.id.token", nonce: "n", userID: "u1")
        var out = ""
        dump(grant, to: &out)
        dump(subject, to: &out)
        XCTAssertFalse(out.contains("secret"))
        XCTAssertTrue(out.contains("[redacted]"))
    }

    func testChoose() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token",
            body:
                #"{"status":"choose","grant":"\#(grant)","expiresIn":300,"choices":{"state":"choose","choices":[{"id":"lic_a","tierName":"djdl","name":null,"origin":"key","access":"seats","seats":{"used":0,"limit":3},"current":false,"expiresAt":null,"state":"free","replace":null,"freeDeviceUrl":null}],"keep":false,"preselected":null,"create":null,"getLicense":null}}"#
        )
        let (c, _) = try await client(provider: FakeProvider())
        let result = try await c.identity.autoSignIn()
        guard case .choose(let pending) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(pending.grant, grant)
    }

    func testNeedsSignInKeepsTheHandleButNeverPrintsIt() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token", status: 403,
            body:
                #"{"error":"interstitial_required","reason":"no_link","url":"\#(api)/identity/authorize","linkHandle":"\#(handle)","expiresIn":600}"#
        )
        let (c, _) = try await client(provider: FakeProvider())
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: handle, reason: .noLink))
        XCTAssertFalse("\(result)".contains(handle))
        XCTAssertFalse("\(String(reflecting: result))".contains(handle))
    }

    func testTermsHasNoHandle() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token", status: 403,
            body: #"{"error":"interstitial_required","reason":"terms","url":"\#(api)/identity/authorize"}"#)
        let (c, _) = try await client(provider: FakeProvider())
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .terms))
    }

    func testDeviceLimit() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", status: 403, body: #"{"error":"device_limit"}"#)
        let (c, _) = try await client(provider: FakeProvider())
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .deviceLimit(manageUrl: nil, view: nil))
    }

    func testARefusalIsUnavailableWithTheCode() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", status: 400, body: #"{"error":"invalid_grant"}"#)
        let (c, _) = try await client(provider: FakeProvider())
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .unavailable(code: "invalid_grant"))
    }

    func testNoExchangeMemberIsUnavailableWithNoProviderCall() async throws {
        await discovery(exchange: false)
        let provider = FakeProvider()
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .unavailable(code: ErrorCode.platformIdentityUnavailable))
        XCTAssertEqual(provider.calls.current, [])
    }

    func testNoProviderNeedsSignIn() async throws {
        await discovery()
        let (c, _) = try await client()
        c.identity.installPlatformIdentity(nil)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
    }

    // ── Sign-out ────────────────────────────────────────────────────────────────────────

    func testSignOutSetsTheFlagCleansUpAndSilencesRungs3And4() async throws {
        await discovery()
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let provider = FakeProvider()
        let (c, store) = try await client(token: "pkeyt_a", provider: provider)
        _ = try await c.identity.signOut()
        XCTAssertEqual(provider.calls.current, ["cleanup"])
        let flag = await c.core.explicitSignOut()
        XCTAssertTrue(flag)
        let persisted = await store.readRecord("explicit-sign-out")
        XCTAssertNotNil(persisted)

        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        XCTAssertEqual(provider.calls.current, ["cleanup"], "neither rung ran")
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 0)
    }

    func testTheFlagSurvivesARestartAndAnExplicitSignInClearsIt() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let provider = FakeProvider()
        let (c, store) = try await client(provider: provider)
        await c.core.setExplicitSignOut(true)
        // A new process over the same store still reads it.
        let again = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        let held = await again.core.explicitSignOut()
        XCTAssertTrue(held)

        // The person signs in themselves: the exchange stores a sign-in token.
        let outcome = try await again.identity.exchange(
            kind: .apple, subjectToken: "apple.id.token", nonce: nonce)
        guard case .signedIn = outcome else { return XCTFail("\(outcome)") }
        let cleared = await again.core.explicitSignOut()
        XCTAssertFalse(cleared)
        let persisted = await store.readRecord("explicit-sign-out")
        XCTAssertNil(persisted)
    }

    func testAFailedSignOutLeavesTheFlagUnset() async throws {
        await discovery()
        await server.reply("/djdl/identity/signout", status: 500, body: "{}")
        let provider = FakeProvider()
        let (c, _) = try await client(token: "pkeyt_a", provider: provider)
        do { _ = try await c.identity.signOut() } catch {}
        let flag = await c.core.explicitSignOut()
        XCTAssertFalse(flag)
        XCTAssertEqual(provider.calls.current, [])
    }

    // ── Scenario 11 ─────────────────────────────────────────────────────────────────────

    func testARevokedCredentialAtLaunchSignsTheDeviceOut() async throws {
        await discovery()
        await server.reply("/djdl/identity/signout", body: #"{"released":true}"#)
        let provider = FakeProvider(revoked: true)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true, provider: provider)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        let signouts = await count("/djdl/identity/signout")
        XCTAssertEqual(signouts, 1)
        let token = await c.core.token
        XCTAssertNil(token)
        let flag = await c.core.explicitSignOut()
        XCTAssertTrue(flag)
        XCTAssertEqual(provider.calls.current, ["cleanup"])
    }

    func testARevokedCredentialWithNoSessionStillCleansUpLocally() async throws {
        await discovery()
        let provider = FakeProvider(revoked: true)
        let (c, _) = try await client(provider: provider)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        let signouts = await count("/djdl/identity/signout")
        XCTAssertEqual(signouts, 0)
        XCTAssertEqual(provider.calls.current, ["cleanup"])
    }

    func testARevokedCredentialWhoseSignOutFailsRetriesAtTheNextLaunch() async throws {
        await discovery()
        await server.reply("/djdl/identity/signout", status: 500, body: "{}")
        let provider = FakeProvider(revoked: true)
        let (c, _) = try await client(token: "pkeyt_a", provider: provider)
        _ = try await c.identity.autoSignIn(AutoSignInOptions(prompt: .never))
        let flag = await c.core.explicitSignOut()
        XCTAssertFalse(flag, "nothing is marked until the Worker accepted the sign-out")
        XCTAssertFalse(provider.calls.current.contains("cleanup"))
    }

    // ── SEC-LADDER ──────────────────────────────────────────────────────────────────────

    func testAKeyActivatedDeviceIsNotASession() async throws {
        await discovery()
        let provider = FakeProvider(silent: false)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true, provenance: .key, provider: provider)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        XCTAssertEqual(provider.calls.current, ["silent"])
    }

    func testAnAccountSignOutThatKeepsTheTokenIsNotASessionEither() async throws {
        await discovery()
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let provider = FakeProvider(silent: false)
        let (c, store) = try await client(token: "pkeyt_a", licensed: true, provider: provider)
        let before = try await c.identity.autoSignIn()
        guard case .signedIn = before else { return XCTFail("\(before)") }
        _ = try await c.identity.signOut()
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_a")
        let origin = await store.readRecord("token-origin")
        XCTAssertEqual(origin.map { String(decoding: $0, as: UTF8.self) }, "key")
        let after = try await c.identity.autoSignIn()
        XCTAssertEqual(after, .needsSignIn(linkHandle: nil, reason: .signedOut))
    }

    func testASignOutWhileTheProviderIsPendingStoresNothingAndKeepsTheFlag() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let provider = FakeProvider()
        let (c, _) = try await client(token: nil, provider: provider)
        // Sign out needs a bearer to be accepted: give the device a token before, via the stub.
        try await c.core.setToken("pkeyt_other", source: .activate)
        provider.during = { [identity = c.identity] in _ = try await identity.signOut() }
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_other", "the ladder stored no token")
        let flag = await c.core.explicitSignOut()
        XCTAssertTrue(flag)
        let tokenCalls = await count("/djdl/identity/token")
        XCTAssertEqual(tokenCalls, 0, "the exchange was not even sent")
        XCTAssertFalse(provider.calls.current.contains("started"))
    }

    func testTheLadderNeverEndsTheSignedOutState() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let (c, _) = try await client(provider: FakeProvider())
        // The flag appears after the ladder started (a sign-out on another path): the store aborts.
        let generation = await c.core.signOutGeneration
        await c.core.setExplicitSignOut(true)
        let stored = try await c.core.setTokenUnlessSignedOut("pkeyt_x", generation: generation)
        XCTAssertFalse(stored)
        let flag = await c.core.explicitSignOut()
        XCTAssertTrue(flag)
    }

    func testAppleHasNoSilentRungSoTheDefaultNeverReachesTheAuthorizer() async throws {
        await discovery()
        let spy = SpyAuthorizer()
        let (c, _) = try await client()
        c.identity.installPlatformIdentity(
            AppleSignInProvider(apple: AppleSignIn(authorizer: spy, userIDs: MemoryIDs())))
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        XCTAssertEqual(spy.count, 0)
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 0, "no request for a rung that cannot run")
    }

    func testTheRevokedBranchCleansUpTheOptionsProvider() async throws {
        await discovery()
        await server.reply("/djdl/identity/signout", body: #"{"released":true}"#)
        let installed = FakeProvider()
        let given = FakeProvider(revoked: true)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true, provider: installed)
        _ = try await c.identity.autoSignIn(AutoSignInOptions(provider: given))
        XCTAssertEqual(given.calls.current, ["cleanup"])
        XCTAssertEqual(installed.calls.current, [])
    }

    func testCancellationIsRethrown() async throws {
        await discovery()
        let provider = FakeProvider()
        provider.during = { try await Task.sleep(nanoseconds: 5_000_000_000) }
        let (c, _) = try await client(provider: provider)
        let identity = c.identity
        let task = Task { try await identity.autoSignIn() }
        while !provider.calls.current.contains("silent") { await Task.yield() }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled ladder returned")
        } catch is CancellationError {}
    }
}

private final class SpyAuthorizer: AppleIDAuthorizing, @unchecked Sendable {
    private let n = LockedValue<Int>(0)
    var count: Int { n.current }
    func authorize(nonce: String, immediate: Bool) async throws -> AppleSignInGrant {
        n.with { $0 += 1 }
        throw AppleSignInFailure.cancelled
    }
    func credentialState(forUserID userID: String) async -> AppleCredentialState { .authorized }
}

private final class MemoryIDs: AppleUserIDStoring, @unchecked Sendable {
    private let v = LockedValue<String?>(nil)
    func load() -> String? { v.current }
    func save(_ userID: String) { v.set(userID) }
    func clear() { v.set(nil) }
}
