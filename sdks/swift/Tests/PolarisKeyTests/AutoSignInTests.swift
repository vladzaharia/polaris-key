// @pkey-feature identity.autosignin
//
// I-44.2: the automatic sign-in ladder. A fake provider stands in for the platform, so each rung,
// the sign-out flag, the revoked launch (scenario 11) and every result kind run without an Apple
// Account. The wire conversations are the exchange transcripts' (I-44.3).

import Foundation
import PolarisKey
@testable import PolarisKeyCore
@testable import PolarisKeyIdentity
import XCTest

private final class FakeProvider: PlatformIdentityProvider, @unchecked Sendable {
    let kind: ExchangeKind = .apple
    let silentWorks: Bool
    let sheetWorks: Bool
    let revoked: Bool
    let calls = LockedValue<[String]>([])

    init(silent: Bool = true, sheet: Bool = true, revoked: Bool = false) {
        silentWorks = silent
        sheetWorks = sheet
        self.revoked = revoked
    }

    struct Nothing: Error {}

    func silent(nonce: String) async throws -> PlatformSubjectToken {
        calls.with { $0.append("silent") }
        guard silentWorks else { throw Nothing() }
        return PlatformSubjectToken(token: "apple.id.token", nonce: nonce)
    }
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
        token: String? = nil, licensed: Bool = false, provider: FakeProvider? = nil
    ) async throws -> (PolarisKeyClient, InMemoryStore) {
        let store = InMemoryStore(deviceId: "DEVICE00000000000000000000000001")
        if let token { await store.setToken(token) }
        var trust: TrustSet = [:]
        if licensed {
            let signer = TestSigner(kid: "auto-key")
            trust = signer.trust
            let t = Int(Date().timeIntervalSince1970)
            await store.writeCache(
                CacheRecord(docs: [.license: signer.sign(Fixtures.license(deviceId: "DEVICE00000000000000000000000001", licenseId: "lic_auto", issuedAt: t))]))
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
        let result = await c.identity.autoSignIn()
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
        let result = await c.identity.autoSignIn()
        guard case .signedIn = result else { return XCTFail("\(result)") }
        XCTAssertEqual(provider.calls.current, ["silent"])
    }

    // ── Rungs 3 and 4 ───────────────────────────────────────────────────────────────────

    func testRung3SignsInSilentlyAndNeverShowsTheSheet() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let provider = FakeProvider()
        let (c, _) = try await client(provider: provider)
        let result = await c.identity.autoSignIn()
        guard case .signedIn(let ready) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(ready.subject, "ps_abc")
        XCTAssertEqual(provider.calls.current, ["silent"])
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_exchanged")
    }

    func testRung4RunsWhenRung3FindsNothingAndTheCallerAllowsIt() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let provider = FakeProvider(silent: false)
        let (c, _) = try await client(provider: provider)
        let result = await c.identity.autoSignIn(AutoSignInOptions(prompt: .optional))
        guard case .signedIn = result else { return XCTFail("\(result)") }
        XCTAssertEqual(provider.calls.current, ["silent", "sheet"])
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 2, "each attempt takes a fresh nonce")
    }

    func testTheDefaultIsSilentOnlySoTheSheetNeverRunsUnlessAskedFor() async throws {
        await discovery()
        let provider = FakeProvider(silent: false)
        let (c, _) = try await client(provider: provider)
        let result = await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        XCTAssertEqual(provider.calls.current, ["silent"])
    }

    func testADismissedSheetIsNeedsSignIn() async throws {
        await discovery()
        let provider = FakeProvider(silent: false, sheet: false)
        let (c, _) = try await client(provider: provider)
        let result = await c.identity.autoSignIn(AutoSignInOptions(prompt: .optional))
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        XCTAssertEqual(provider.calls.current, ["silent", "sheet"])
    }

    func testTheOptionsProviderWinsOverTheInstalledOne() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let installed = FakeProvider()
        let given = FakeProvider()
        let (c, _) = try await client(provider: installed)
        _ = await c.identity.autoSignIn(AutoSignInOptions(provider: given))
        XCTAssertEqual(installed.calls.current, [])
        XCTAssertEqual(given.calls.current, ["silent"])
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
        let result = await c.identity.autoSignIn()
        guard case .confirm(let pending) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(pending.grant, grant)
        XCTAssertFalse("\(result)".contains(grant))
    }

    func testChoose() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token",
            body:
                #"{"status":"choose","grant":"\#(grant)","expiresIn":300,"choices":{"state":"choose","choices":[{"id":"lic_a","tierName":"djdl","name":null,"origin":"key","access":"seats","seats":{"used":0,"limit":3},"current":false,"expiresAt":null,"state":"free","replace":null,"freeDeviceUrl":null}],"keep":false,"preselected":null,"create":null,"getLicense":null}}"#
        )
        let (c, _) = try await client(provider: FakeProvider())
        let result = await c.identity.autoSignIn()
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
        let result = await c.identity.autoSignIn()
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
        let result = await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .terms))
    }

    func testDeviceLimit() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", status: 403, body: #"{"error":"device_limit"}"#)
        let (c, _) = try await client(provider: FakeProvider())
        let result = await c.identity.autoSignIn()
        XCTAssertEqual(result, .deviceLimit(view: nil))
    }

    func testARefusalIsUnavailableWithTheCode() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", status: 400, body: #"{"error":"invalid_grant"}"#)
        let (c, _) = try await client(provider: FakeProvider())
        let result = await c.identity.autoSignIn()
        XCTAssertEqual(result, .unavailable(code: "invalid_grant"))
    }

    func testNoExchangeMemberIsUnavailableWithNoProviderCall() async throws {
        await discovery(exchange: false)
        let provider = FakeProvider()
        let (c, _) = try await client(provider: provider)
        let result = await c.identity.autoSignIn()
        XCTAssertEqual(result, .unavailable(code: ErrorCode.platformIdentityUnavailable))
        XCTAssertEqual(provider.calls.current, [])
    }

    func testNoProviderIsUnavailable() async throws {
        await discovery()
        let (c, _) = try await client()
        c.identity.installPlatformIdentity(nil)
        let result = await c.identity.autoSignIn()
        XCTAssertEqual(result, .unavailable(code: ErrorCode.platformIdentityUnavailable))
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

        let result = await c.identity.autoSignIn()
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
        let result = await c.identity.autoSignIn()
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
        let result = await c.identity.autoSignIn()
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
        _ = await c.identity.autoSignIn(AutoSignInOptions(prompt: .never))
        let flag = await c.core.explicitSignOut()
        XCTAssertFalse(flag, "nothing is marked until the Worker accepted the sign-out")
        XCTAssertFalse(provider.calls.current.contains("cleanup"))
    }
}
