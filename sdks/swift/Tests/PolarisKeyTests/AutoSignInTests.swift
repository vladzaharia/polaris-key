// @pkey-feature identity.autosignin identity.restore
//
// I-44.2: the automatic sign-in ladder. A fake provider stands in for the platform, so each rung,
// the sign-out flag, the revoked launch (scenario 11) and every result kind run without an Apple
// Account. The wire conversations are the exchange transcripts' (I-44.3). Rung 2 and the restore
// item's life (I-49.9) run over a fake `RestoreItemStore`; TranscriptTests replays the restore transcripts.

import Foundation
import PolarisKey
import PolarisKeyPlatform
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyIdentity
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

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

/// The platform backup, in memory. `failing` reads as an unavailable store (no entitlement).
private final class FakeRestoreStore: RestoreItemStore, @unchecked Sendable {
    let item = LockedValue<RestoreItem?>(nil)
    let failing = LockedValue<Bool>(false)
    let calls = LockedValue<[String]>([])
    /// While true, `read()` waits: the detached daily check is parked at the start of its work.
    let hold = LockedValue<Bool>(false)

    func read() async throws -> RestoreItem? {
        calls.with { $0.append("read") }
        while hold.current { try? await Task.sleep(nanoseconds: 5_000_000) }
        if failing.current { throw RestoreStoreError.unavailable }
        return item.current
    }
    func write(_ value: RestoreItem) async throws {
        calls.with { $0.append("write") }
        if failing.current { throw RestoreStoreError.unavailable }
        item.set(value)
    }
    func delete() async throws {
        calls.with { $0.append("delete") }
        if failing.current { throw RestoreStoreError.unavailable }
        item.set(nil)
    }
}

final class AutoSignInTests: XCTestCase {
    private var server = StubServer()
    private var backup = FakeRestoreStore()
    private let api = "https://key.example/djdl"
    private let nonce = "sQXGUn9Dig9pVY62opwL2ZY-2R6qs3Rmyj7WRgxJxG4"
    private let grant = "sg_" + String(repeating: "b", count: 43)
    private let handle = "lh_" + String(repeating: "c", count: 43)
    private let tokenOk =
        #"{"access_token":"pkeyt_exchanged","token_type":"Bearer","scope":"profile","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc","issued_token_type":"urn:polaris-key:token-type:device"}"#

    override func setUp() {
        super.setUp()
        server = StubServer()
        backup = FakeRestoreStore()
    }

    private func discovery(exchange: Bool = true, restore: Bool = false) async {
        var member = exchange ? #""exchange":{"kinds":["apple"]},"nonce":"\#(api)/identity/nonce","# : ""
        if restore { member += #""restore":true,"# }
        let restoreEndpoint = restore ? #","restore":"\#(api)/identity/restore""# : ""
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,\#(member)"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","signout":"\#(api)/identity/signout","choiceLicenses":"\#(api)/identity/choice/licenses","choiceDevices":"\#(api)/identity/choice/devices","choiceComplete":"\#(api)/identity/choice/complete","choiceCancel":"\#(api)/identity/choice/cancel"\#(restoreEndpoint)\#(exchange ? #","nonce":"\#(api)/identity/nonce""# : "")}}}}"#
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
        c.identity.installRestoreStore(backup)
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

    func testDeactivateSetsTheFlagAndALaunchDoesNotSignInSilently() async throws {
        await discovery()
        let provider = FakeProvider()
        let (c, store) = try await client(token: "pkeyt_a", licensed: true, provider: provider)
        try await c.deactivate()
        let flag = await c.core.explicitSignOut()
        XCTAssertTrue(flag)
        let persisted = await store.readRecord("explicit-sign-out")
        XCTAssertNotNil(persisted)

        // A relaunch: a new client over the same store, with a platform identity ready to sign in.
        let relaunchProvider = FakeProvider()
        let again = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        again.identity.redirectAcquisitionSync.set(false)
        again.identity.installPlatformIdentity(relaunchProvider)
        again.identity.installRestoreStore(backup)
        let held = await again.core.explicitSignOut()
        XCTAssertTrue(held)

        let result = try await again.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        XCTAssertEqual(relaunchProvider.calls.current, [], "no rung ran")
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 0)
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

    // ── Silent restore: rung 2 (I-49.9) ─────────────────────────────────────────────────

    private let itemA = RestoreItem(
        restoreId: "rk_" + String(repeating: "a", count: 22), secret: "rs_" + String(repeating: "s", count: 43))
    private let itemB = RestoreItem(
        restoreId: "rk_" + String(repeating: "b", count: 22), secret: "rs_" + String(repeating: "t", count: 43))
    private var enrolBody: String {
        #"{"restoreId":"\#(itemB.restoreId)","secret":"\#(itemB.secret)"}"#
    }

    private func bodyText(_ request: PolarisRequest) -> String {
        String(decoding: request.body ?? Data(), as: UTF8.self)
    }

    private func isRestoreGrant(_ request: PolarisRequest) -> Bool {
        bodyText(request).contains("grant_type=urn%3Apolaris-key%3Agrant-type%3Arestore")
    }

    private func restoreRequests(_ method: String? = nil) async -> [PolarisRequest] {
        await server.requests(forPath: "/djdl/identity/restore").filter { method == nil || $0.method == method }
    }

    func testRung2SignsInFromTheRestoreItemWithNoProviderAndEnrolsAgain() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/token", body: tokenOk)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        backup.item.set(itemA)
        let (c, _) = try await client()
        c.identity.installPlatformIdentity(nil)
        let result = try await c.identity.autoSignIn()
        guard case .signedIn(let ready) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(ready.subject, "ps_abc")
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_exchanged")
        let provenance = await c.core.tokenProvenance()
        XCTAssertEqual(provenance, .signin)

        let grants = await server.requests(forPath: "/djdl/identity/token")
        XCTAssertEqual(grants.count, 1)
        let form = bodyText(grants[0])
        XCTAssertTrue(isRestoreGrant(grants[0]))
        XCTAssertTrue(form.contains("restore_id=\(itemA.restoreId)"))
        for field in ["restore_secret=", "device_key=", "agree_key=", "proof=", "client_id=djdl"] {
            XCTAssertTrue(form.contains(field), field)
        }
        XCTAssertFalse(form.contains("subject_token"))
        let nonces = await count("/djdl/identity/nonce")
        XCTAssertEqual(nonces, 0, "the platform provider was never asked")

        // Enrolment follows the sign-in: the id of the item travels, the new key replaces it.
        let enrols = await restoreRequests("POST")
        XCTAssertEqual(enrols.count, 1)
        XCTAssertEqual(bodyText(enrols[0]), #"{"restoreId":"\#(itemA.restoreId)"}"#)
        let auth = enrols[0].headers.first { $0.key.lowercased() == "authorization" }?.value
        XCTAssertEqual(auth, "Bearer pkeyt_exchanged")
        XCTAssertEqual(backup.item.current, itemB)
    }

    func testTheRestoreProofIsOverTheIdAndTheDeviceKeyAndHashesTheSecret() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/token", body: tokenOk)
        backup.item.set(itemA)
        let (c, _) = try await client()
        _ = try await c.identity.autoSignIn()
        let grants = await server.requests(forPath: "/djdl/identity/token")
        let fields = Dictionary(
            uniqueKeysWithValues: bodyText(grants[0]).split(separator: "&").map { pair -> (String, String) in
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                return (kv[0], kv.count > 1 ? kv[1] : "")
            })
        let proof = DeviceProof(
            fields: DeviceProofFields(
                purpose: "restore", product: "djdl", deviceId: "DEVICE00000000000000000000000001",
                value: "\(itemA.restoreId).\(fields["device_key"] ?? "")",
                tokenHash: Base64URL.encode(Data(SHA256.hash(data: Data(itemA.secret.utf8))))),
            signKey: fields["device_key"] ?? "", sig: fields["proof"] ?? "")
        XCTAssertTrue(DeviceProofs.verify(proof))
    }

    func testRung2IsSkippedAfterAnExplicitSignOut() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/token", body: tokenOk)
        backup.item.set(itemA)
        let (c, _) = try await client()
        await c.core.setExplicitSignOut(true)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        let grants = await count("/djdl/identity/token")
        XCTAssertEqual(grants, 0)
        XCTAssertEqual(backup.item.current, itemA, "the item is not touched")
    }

    func testTheOptionOffSkipsRung2RevokesTheKeyAndDeletesTheItem() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        backup.item.set(itemA)
        let provider = FakeProvider(silent: false)
        let (c, _) = try await client(token: "pkeyt_a", provider: provider)
        let result = try await c.identity.autoSignIn(AutoSignInOptions(restore: false))
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .noCredential))
        let grants = await count("/djdl/identity/token")
        XCTAssertEqual(grants, 0, "no restore grant")
        let deletes = await restoreRequests("DELETE")
        XCTAssertEqual(deletes.count, 1)
        let posts = await restoreRequests("POST")
        XCTAssertTrue(posts.isEmpty, "never enrols")
        XCTAssertNil(backup.item.current)
    }

    func testARefusedRestoreLeavesTheItemAndFallsToRung3() async throws {
        let refusals: [(Int, String)] = [
            (400, #"{"error":"invalid_grant"}"#), (429, #"{"error":"rate_limited","retryAfter":86400}"#),
            (503, #"{"error":"unavailable"}"#),
            // The key was consumed and the sign-in refused after it: rung 3 is next.
            (403, #"{"error":"device_limit"}"#), (403, #"{"error":"not_entitled"}"#),
            (403, #"{"error":"interstitial_required","reason":"terms","url":"\#(api)/identity/authorize"}"#),
        ]
        for (status, body) in refusals {
            server = StubServer()
            backup = FakeRestoreStore()
            await discovery(restore: true)
            let ok = tokenOk
            await server.route("/djdl/identity/token") { request in
                let restoreGrant = String(decoding: request.body ?? Data(), as: UTF8.self)
                    .contains("grant-type%3Arestore")
                return restoreGrant ? StubServer.Reply(status: status, body: body) : StubServer.Reply(body: ok)
            }
            backup.item.set(itemA)
            let provider = FakeProvider()
            let (c, _) = try await client(provider: provider)
            let result = try await c.identity.autoSignIn()
            guard case .signedIn = result else { return XCTFail("\(status) \(body): \(result)") }
            XCTAssertEqual(provider.calls.current, ["silent", "started"], "\(status) \(body)")
            XCTAssertEqual(backup.item.current, itemA, "\(status) \(body): the item stays")
            XCTAssertFalse(backup.calls.current.contains("delete"), "\(status) \(body)")
            let grants = await server.requests(forPath: "/djdl/identity/token")
            XCTAssertEqual(grants.count, 2, "the restore grant, then the exchange")
        }
    }

    func testAnUnavailableStoreAndAMissingMemberGoStraightToRung3() async throws {
        // No restore member in discovery: no restore request at all.
        await discovery(restore: false)
        await server.reply("/djdl/identity/token", body: tokenOk)
        backup.item.set(itemA)
        let first = FakeProvider()
        let (c, _) = try await client(provider: first)
        _ = try await c.identity.autoSignIn()
        XCTAssertEqual(first.calls.current, ["silent", "started"])
        let firstGrants = await server.requests(forPath: "/djdl/identity/token")
        XCTAssertFalse(isRestoreGrant(firstGrants[0]))
        let none = await restoreRequests()
        XCTAssertTrue(none.isEmpty)

        // An unavailable store (no entitlement): the same, with the member present.
        server = StubServer()
        backup = FakeRestoreStore()
        backup.failing.set(true)
        await discovery(restore: true)
        await server.reply("/djdl/identity/token", body: tokenOk)
        let second = FakeProvider()
        let (d, _) = try await client(provider: second)
        let result = try await d.identity.autoSignIn()
        guard case .signedIn = result else { return XCTFail("\(result)") }
        XCTAssertEqual(second.calls.current, ["silent", "started"])
        let grants = await server.requests(forPath: "/djdl/identity/token")
        XCTAssertEqual(grants.count, 1)
        XCTAssertFalse(isRestoreGrant(grants[0]))
        let enrols = await restoreRequests("POST")
        XCTAssertTrue(enrols.isEmpty, "nothing is enrolled with no place to keep the key")
    }

    func testAConfirmIsTheExchangesAndEnrolmentFollowsComplete() async throws {
        await discovery(restore: true)
        let grant = self.grant
        await server.route("/djdl/identity/token") { _ in
            StubServer.Reply(
                body:
                    #"{"status":"confirm","grant":"\#(grant)","expiresIn":300,"consent":{"client":{"appName":"djdl","developerName":null,"iconUrl":null,"nameVerified":true},"as":{"provider":null,"email":null},"items":[],"scopeHash":"327f","firstTime":true,"changed":false}}"#
            )
        }
        await server.reply("/djdl/identity/choice/complete", body: tokenOk)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        backup.item.set(itemA)
        let (c, _) = try await client()
        let result = try await c.identity.autoSignIn()
        guard case .confirm(let pending) = result else { return XCTFail("\(result)") }
        XCTAssertNil(pending.consent.as.provider, "a restore names no provider")
        XCTAssertNil(pending.consent.as.email)
        let before = await restoreRequests()
        XCTAssertTrue(before.isEmpty, "no session yet: nothing is enrolled")
        _ = try await c.identity.choice.complete(
            grant: pending.grant, choice: nil, consent: ChoiceConsent(claims: []))
        let enrols = await restoreRequests("POST")
        XCTAssertEqual(enrols.count, 1)
        XCTAssertEqual(backup.item.current, itemB)
    }

    func testARestoreResultAndItemNeverPrintTheSecret() async throws {
        XCTAssertFalse("\(itemA)".contains(itemA.secret))
        XCTAssertFalse(String(reflecting: itemA).contains(itemA.secret))
        var dumped = ""
        dump(itemA, to: &dumped)
        XCTAssertFalse(dumped.contains(itemA.secret))
        XCTAssertTrue(dumped.contains("[redacted]"))
        let enrolled = RestoreEnrolResult.enrolled(restoreId: itemB.restoreId, secret: itemB.secret)
        XCTAssertFalse("\(enrolled)".contains(itemB.secret))
        XCTAssertFalse(String(reflecting: enrolled).contains(itemB.secret))
        var dumpedResult = ""
        dump(enrolled, to: &dumpedResult)
        XCTAssertFalse(dumpedResult.contains(itemB.secret))
        XCTAssertTrue(dumpedResult.contains("[redacted]"))
    }

    // ── Enrolment (I-49.9) ──────────────────────────────────────────────────────────────

    func testRung1ChecksTheKeyOnceADayAndEnrolsWhenThereIsNone() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        let (c, store) = try await client(token: "pkeyt_a", licensed: true)
        let first = try await c.identity.autoSignIn()
        guard case .signedIn = first else { return XCTFail("\(first)") }
        await c.identity.restoreAwaitDailyCheck()
        var posts = await restoreRequests("POST")
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(bodyText(posts[0]), "{}", "no item yet")
        XCTAssertEqual(backup.item.current, itemB)
        let stamp = await store.readRecord("restore-checked")
        XCTAssertNotNil(stamp, "the check clock is a local record")

        // Within the day: no request.
        _ = try await c.identity.autoSignIn()
        await c.identity.restoreAwaitDailyCheck()
        posts = await restoreRequests("POST")
        XCTAssertEqual(posts.count, 1)

        // A day later: the item's id is checked, and `current` writes nothing.
        let old = Int(Date().timeIntervalSince1970) - Restore.checkSeconds - 5
        await store.writeRecord("restore-checked", Data(String(old).utf8))
        await server.reply("/djdl/identity/restore", status: 200, body: #"{"status":"current"}"#)
        let writesBefore = backup.calls.current.filter { $0 == "write" }.count
        _ = try await c.identity.autoSignIn()
        await c.identity.restoreAwaitDailyCheck()
        posts = await restoreRequests("POST")
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(bodyText(posts[1]), #"{"restoreId":"\#(itemB.restoreId)"}"#)
        XCTAssertEqual(backup.calls.current.filter { $0 == "write" }.count, writesBefore)
    }

    func testAnInteractiveSignInClearsTheFlagAndEnrols() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/token", body: tokenOk)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        let (c, _) = try await client()
        await c.core.setExplicitSignOut(true)
        let outcome = try await c.identity.exchange(kind: .apple, subjectToken: "apple.id.token", nonce: nonce)
        guard case .signedIn = outcome else { return XCTFail("\(outcome)") }
        let flag = await c.core.explicitSignOut()
        XCTAssertFalse(flag)
        XCTAssertEqual(backup.item.current, itemB)
    }

    func testNothingIsEnrolledWhileTheSignedOutFlagIsSetOrTheMemberIsMissing() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true)
        await c.core.setExplicitSignOut(true)
        await c.identity.restoreDailyCheck()
        await c.identity.restoreSignInCompleted()
        let posts = await restoreRequests()
        XCTAssertTrue(posts.isEmpty)
        XCTAssertNil(backup.item.current)

        server = StubServer()
        await discovery(restore: false)
        let (d, _) = try await client(token: "pkeyt_a", licensed: true)
        _ = try await d.identity.autoSignIn()
        await d.identity.restoreAwaitDailyCheck()
        let none = await restoreRequests()
        XCTAssertTrue(none.isEmpty, "an old Worker: no member, no enrolment")
    }

    // ── Sign-out (I-49.9) ───────────────────────────────────────────────────────────────

    func testSignOutRevokesTheKeyBeforeTheWorkersSignOutDeletesTheItemAndKeepsTheFlag() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        await server.reply("/djdl/identity/token", body: tokenOk)
        backup.item.set(itemA)
        let (c, _) = try await client(token: "pkeyt_a")
        _ = try await c.identity.signOut()
        let order = await server.requests.filter {
            $0.url.path == "/djdl/identity/restore" || $0.url.path == "/djdl/identity/signout"
        }.map { "\($0.method) \($0.url.path)" }
        XCTAssertEqual(order, ["DELETE /djdl/identity/restore", "POST /djdl/identity/signout"])
        XCTAssertNil(backup.item.current, "the synchronizable item is deleted")
        let flag = await c.core.explicitSignOut()
        XCTAssertTrue(flag)

        // The item comes back (another device re-enrolled): this device's flag still stops rung 2.
        backup.item.set(itemB)
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        let grants = await count("/djdl/identity/token")
        XCTAssertEqual(grants, 0)
    }

    func testADeleteTheWorkerCouldNotTakeIsQueuedAndGoesFirstAtTheNextLaunch() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 503, body: "{}") }
        await server.reply("/djdl/identity/signout", status: 500, body: "{}")
        backup.item.set(itemA)
        let (c, store) = try await client(token: "pkeyt_a", licensed: true)
        do { _ = try await c.identity.signOut() } catch {}
        let queued = await store.readRecord("restore-delete-pending")
        XCTAssertNotNil(queued, "queued in a local record that no backup carries")
        XCTAssertNil(backup.item.current, "the item goes whatever the Worker answered")

        // The next launch: the Worker answers; the queued DELETE is the first call to the restore route.
        await server.route("/djdl/identity/restore") { request in
            request.method == "DELETE"
                ? StubServer.Reply(status: 204, body: "")
                : StubServer.Reply(status: 200, body: #"{"status":"current"}"#)
        }
        let again = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        again.identity.installRestoreStore(backup)
        _ = try await again.identity.autoSignIn()
        let restoreCalls = await restoreRequests().map(\.method)
        XCTAssertEqual(
            restoreCalls.dropFirst().first, "DELETE", "the retry is the next restore call after the failed one")
        let cleared = await store.readRecord("restore-delete-pending")
        XCTAssertNil(cleared)
    }

    func testARevokedCredentialWithNoSessionQueuesTheDeleteForTheNextSignIn() async throws {
        await discovery(restore: true)
        backup.item.set(itemA)
        let (c, store) = try await client(provider: FakeProvider(revoked: true))
        let result = try await c.identity.autoSignIn()
        XCTAssertEqual(result, .needsSignIn(linkHandle: nil, reason: .signedOut))
        XCTAssertNil(backup.item.current)
        let queued = await store.readRecord("restore-delete-pending")
        XCTAssertNotNil(queued, "no bearer to send it with: it waits for the next sign-in")
    }

    // ── The I-49 fix round ──────────────────────────────────────────────────────────────

    func testAnOfflineLaunchKeepsTheQueuedDeleteAndTheNextOnlineLaunchSendsIt() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        let (seed, store) = try await client(token: "pkeyt_a")
        _ = seed
        await store.writeRecord("restore-delete-pending", Data("1".utf8))
        // A new process: no discovery in memory, and the Worker is unreachable.
        server = StubServer()
        await server.drop("/djdl/.well-known/polaris.json")
        let offline = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        offline.identity.installRestoreStore(backup)
        _ = try await offline.identity.autoSignIn()
        let kept = await store.readRecord("restore-delete-pending")
        XCTAssertNotNil(kept)

        server = StubServer()
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        let online = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        online.identity.installRestoreStore(backup)
        _ = try await online.identity.autoSignIn()
        let sent = await restoreRequests("DELETE")
        XCTAssertEqual(sent.count, 1)
        let cleared = await store.readRecord("restore-delete-pending")
        XCTAssertNil(cleared)
    }

    private func expectSignOutToFail(_ c: PolarisKeyClient) async {
        do { _ = try await c.identity.signOut() } catch { return }
        XCTFail("the sign-out should have failed")
    }

    func testSignOutDeletesTheItemAndSendsDeleteWhenTheWorkerRefusesTheSignOut() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        await server.reply("/djdl/identity/signout", status: 500, body: "{}")
        backup.item.set(itemA)
        let (c, store) = try await client(token: "pkeyt_a", licensed: true)
        await store.writeRecord("restore-checked", Data("1".utf8))
        await expectSignOutToFail(c)
        let deletes = await restoreRequests("DELETE")
        XCTAssertEqual(deletes.count, 1)
        XCTAssertNil(backup.item.current)
        let checked = await store.readRecord("restore-checked")
        XCTAssertNil(checked)
        let pending = await store.readRecord("restore-delete-pending")
        XCTAssertNil(pending, "the DELETE was delivered")
    }

    func testSignOutDeletesTheItemAndQueuesTheDeleteWhenNothingCanBeReached() async throws {
        await discovery(restore: true)
        await server.drop("/djdl/identity/restore")
        await server.drop("/djdl/identity/signout")
        backup.item.set(itemA)
        let (c, store) = try await client(token: "pkeyt_a", licensed: true)
        await expectSignOutToFail(c)
        XCTAssertNil(backup.item.current)
        let pending = await store.readRecord("restore-delete-pending")
        XCTAssertNotNil(pending)
    }

    func testSignOutWithNoItemStillRevokesTheDeviceKey() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true)
        _ = try await c.identity.signOut()
        let deletes = await restoreRequests("DELETE")
        XCTAssertEqual(deletes.count, 1, "the item may have been deleted by a sibling; the key is still revoked")
    }

    func testAnOfflineSignOutDeletesTheItemAndQueuesTheDelete() async throws {
        let store = InMemoryStore(deviceId: "DEVICE00000000000000000000000001")
        await store.setToken("pkeyt_a")
        await server.drop("/djdl/.well-known/polaris.json")
        let offline = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        backup.item.set(itemA)
        offline.identity.installRestoreStore(backup)
        do {
            _ = try await offline.identity.signOut()
            XCTFail("the sign-out should have failed")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, ErrorCode.networkError)
        }
        XCTAssertNil(backup.item.current)
        let pending = await store.readRecord("restore-delete-pending")
        XCTAssertNotNil(pending)

        // The next launch, with discovery up, sends the DELETE first.
        server = StubServer()
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        let online = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        online.identity.installRestoreStore(backup)
        _ = try await online.identity.autoSignIn()
        let sent = await restoreRequests("DELETE")
        XCTAssertEqual(sent.count, 1)
        let cleared = await store.readRecord("restore-delete-pending")
        XCTAssertNil(cleared)
    }

    func testAnEnrolmentDuringSignOutLeavesNoItemAfterIt() async throws {
        await discovery(restore: true)
        let created = enrolBody
        let holder = LockedValue<PolarisKeyClient?>(nil)
        let generation = LockedValue<Int>(0)
        let gate = backup
        await server.route("/djdl/identity/restore") { request in
            request.method == "DELETE"
                ? StubServer.Reply(status: 204, body: "")
                : StubServer.Reply(status: 201, body: created)
        }
        // A daily check begins while the Worker handles the sign-out, after the client's own revocation.
        await server.route("/djdl/identity/signout") { _ in
            if let c = holder.current {
                c.identity.restoreLaunchDailyCheck(generation: generation.current)
                // Wait until the check is inside its first read, so it has passed the generation test.
                for _ in 0..<400 where !gate.calls.current.contains("read") { usleep(5_000) }
                Task {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    gate.hold.set(false)
                }
            }
            return StubServer.Reply(status: 200, body: #"{"released":false}"#)
        }
        let (c, _) = try await client(token: "pkeyt_a", licensed: true)
        holder.set(c)
        generation.set(await c.core.signOutGeneration + 1)
        backup.hold.set(true)
        _ = try await c.identity.signOut()
        backup.hold.set(false)
        await c.identity.restoreAwaitDailyCheck()
        XCTAssertNil(backup.item.current, "the item a check wrote during the sign-out is gone with the rest")
    }

    func testTheDailyCheckIsDetachedAndNeverDelaysTheSignInResult() async throws {
        await discovery(restore: true)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true)
        backup.hold.set(true)
        let done = LockedValue(false)
        let ladder = Task {
            let result = try await c.identity.autoSignIn()
            done.set(true)
            return result
        }
        for _ in 0..<400 where !done.current { try await Task.sleep(nanoseconds: 10_000_000) }
        let returned = done.current
        backup.hold.set(false)
        let result = try await ladder.value
        XCTAssertTrue(returned, "the sign-in returned while the check was still running")
        guard case .signedIn = result else { return XCTFail("\(result)") }
        await c.identity.restoreAwaitDailyCheck()
        XCTAssertEqual(backup.item.current, itemB)
    }

    func testADetachedCheckThatFailsIsSwallowedAndTriedAgainAtTheNextLaunch() async throws {
        await discovery(restore: true)
        await server.drop("/djdl/identity/restore")
        let (c, store) = try await client(token: "pkeyt_a", licensed: true)
        let first = try await c.identity.autoSignIn()
        guard case .signedIn = first else { return XCTFail("\(first)") }
        await c.identity.restoreAwaitDailyCheck()
        let stamp = await store.readRecord("restore-checked")
        XCTAssertNil(stamp, "a failed check stamps nothing")
        server = StubServer()
        await discovery(restore: true)
        await server.reply("/djdl/identity/restore", status: 201, body: enrolBody)
        let (d, _) = try await client(token: "pkeyt_a", licensed: true)
        _ = try await d.identity.autoSignIn()
        await d.identity.restoreAwaitDailyCheck()
        XCTAssertEqual(backup.item.current, itemB)
    }

    func testASignOutDuringTheDetachedCheckWaitsForItThenRevokesWhatItEnrolled() async throws {
        await discovery(restore: true)
        let created = enrolBody
        await server.route("/djdl/identity/restore") { request in
            request.method == "DELETE"
                ? StubServer.Reply(status: 204, body: "")
                : StubServer.Reply(status: 201, body: created)
        }
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let (c, _) = try await client(token: "pkeyt_a", licensed: true)
        backup.hold.set(true)
        _ = try await c.identity.autoSignIn()
        // The check is parked inside its first read of the backup: only now does the sign-out begin.
        for _ in 0..<400 where !backup.calls.current.contains("read") { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(backup.calls.current.contains("read"))
        let out = Task { try await c.identity.signOut() }
        try await Task.sleep(nanoseconds: 200_000_000)
        backup.hold.set(false)
        _ = try await out.value
        await c.identity.restoreAwaitDailyCheck()
        let order = await server.requests.filter {
            $0.url.path == "/djdl/identity/restore" || $0.url.path == "/djdl/identity/signout"
        }.map { "\($0.method) \($0.url.path)" }
        XCTAssertEqual(
            order,
            ["POST /djdl/identity/restore", "DELETE /djdl/identity/restore", "POST /djdl/identity/signout"])
        XCTAssertNil(backup.item.current)
    }

    func testTheOptionOffRevokesWhenOnlyTheCheckRecordRemains() async throws {
        await discovery(restore: true)
        await server.route("/djdl/identity/restore") { _ in StubServer.Reply(status: 204, body: "") }
        let (c, store) = try await client(token: "pkeyt_a", licensed: true)
        await store.writeRecord("restore-checked", Data("1".utf8))
        _ = try await c.identity.autoSignIn(AutoSignInOptions(restore: false))
        let deletes = await restoreRequests("DELETE")
        XCTAssertEqual(deletes.count, 1, "a sibling deleted the item; this device's key is still revoked")
        let checked = await store.readRecord("restore-checked")
        XCTAssertNil(checked)
        // Nothing left to remove: the next launch sends nothing more.
        _ = try await c.identity.autoSignIn(AutoSignInOptions(restore: false))
        let again = await restoreRequests("DELETE")
        XCTAssertEqual(again.count, 1)
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
