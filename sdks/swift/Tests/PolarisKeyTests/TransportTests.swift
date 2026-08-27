// The transport seam: the HTTPS base-URL guard, the §7.3 local-only profile, the device
// principal's own surfaces, and the activation ladder.
//
// These are the parity fixes the Swift SDK gained in the re-shape. The base-URL guard in
// particular is not a nicety: the device bearer token rides on every document fetch, and a
// plaintext control plane turns trust-set injection (R4-02) from a local attack into a
// coffee-shop one.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class TransportTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    // ── The base-URL guard ───────────────────────────────────────────────────────────
    /// Throws at CONSTRUCTION, before anything else happens — no directory created, no keychain
    /// touched — so a client that failed the guard has taken no other action.
    func testPlaintextBaseUrlIsRefused() {
        for bad in [
            "http://key.plrs.im", "http://192.168.1.10:8787", "http://evil.example",
            "ftp://key.plrs.im", "not a url", "",
        ] {
            XCTAssertThrowsError(try Endpoints(baseUrl: bad, product: "djdl"), bad) { error in
                XCTAssertEqual(
                    (error as? PolarisError)?.code, PolarisError.insecureBaseUrl, bad)
            }
        }
    }

    /// Loopback keeps `http:` usable for `wrangler dev` and integration tests; nothing else may
    /// carry the bearer token unencrypted.
    func testHttpsAndLoopbackAreAccepted() throws {
        for good in [
            "https://key.plrs.im", "https://key.example:8443", "http://localhost:8787",
            "http://127.0.0.1:8787", "http://[::1]:8787", "HTTPS://KEY.EXAMPLE",
        ] {
            XCTAssertNoThrow(try Endpoints(baseUrl: good, product: "djdl"), good)
        }
        XCTAssertEqual(
            try Endpoints(baseUrl: "https://key.example///", product: "djdl").baseUrl,
            "https://key.example")
    }

    /// The guard is on the CLIENT, not just the URL builder — the whole point is that a
    /// misconfigured host cannot get as far as holding a client.
    func testClientConstructionAppliesTheGuard() {
        XCTAssertThrowsError(
            try PolarisKeyClient(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "http://key.plrs.im", version: "1.0.0",
                    pinnedKeys: [:], store: InMemoryStore()))
        ) { error in
            XCTAssertEqual((error as? PolarisError)?.code, PolarisError.insecureBaseUrl)
        }
    }

    // ── §7.3 local-only ──────────────────────────────────────────────────────────────
    /// Everything offline still works; anything that would dial rejects with `local-only`. The
    /// refusal is at the DIAL — before a URL is built or a header is assembled — so a local-only
    /// build cannot make a request even by accident.
    func testLocalOnlyClientRefusesEveryNetworkCall() async throws {
        let signer = TestSigner(kid: "local-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        await store.writeCache(
            CacheRecord(
                docs: [
                    .config: signer.sign(
                        Fixtures.config(
                            issuedAt: t, config: ["ui.theme": Fixtures.entry(.string("local"))]))
                ]))

        let c = try await PolarisKeyClient.createLocal(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, store: store, expectedServices: [.config],
                fingerprint: false))
        XCTAssertTrue(c.core.localOnly)

        // Reads over the cached document still work.
        let theme = await c.config.config("ui.theme", default: .string("d"))
        XCTAssertEqual(theme, .string("local"))
        let localStatus = await c.status().status
        XCTAssertEqual(localStatus, .notApplicable)

        // Activation surfaces the refusal as a code the host can render, rather than as an
        // indistinguishable transport failure.
        guard case .error(let message) = await c.activate(key: "PKEY-XXXX") else {
            return XCTFail("activation must refuse")
        }
        XCTAssertTrue(message.contains("local-only"))

        // Registration and discovery likewise.
        guard case .error = await c.register() else {
            return XCTFail("registration must refuse")
        }
        guard case .error = await c.discover() else { return XCTFail("discovery must refuse") }
    }

    /// `sync()` on a local-only client with no credential is a no-op, not a throw: an
    /// unactivated client that polls must generate no traffic at all.
    func testLocalOnlySyncWithoutACredentialIsSilent() async throws {
        let c = try await PolarisKeyClient.createLocal(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev")))
        let result = await c.sync()
        XCTAssertFalse(result.applied)
        XCTAssertTrue(result.documents.isEmpty)
    }

    /// Deactivation still works offline: it treats the refusal exactly as it treats being
    /// unreachable, because the local wipe was always the part that mattered.
    func testLocalOnlyDeactivateStillWipesLocalState() async throws {
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        let c = try await PolarisKeyClient.createLocal(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: store))
        try await c.deactivate()
        let token = await store.getToken()
        XCTAssertNil(token)
    }

    /// §5 — nothing to authenticate with means nothing to fetch. This is what makes "offline
    /// start performs zero network calls" a structural property rather than a habit.
    func testSyncWithoutATokenPerformsZeroRequests() async throws {
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport))
        _ = await c.sync()
        let requests = await server.requests
        XCTAssertTrue(requests.isEmpty, "an unactivated client must not dial, not even for trust")
    }

    // ── §6 the device principal ──────────────────────────────────────────────────────
    /// `POST /devices/register` is a CORE surface: a config-only product's installs need an
    /// identity to fetch a document AS and a credential to fetch it WITH, and no licence key.
    func testRegisterMintsACredentialWithNoLicenceKey() async throws {
        await server.reply(
            "/djdl/devices/register",
            body: #"{"token":"pkeyt_registered","deviceId":"dev"}"#)
        let store = InMemoryStore(deviceId: "dev")
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: store, transport: server.transport,
                expectedServices: [.config], fingerprint: false))

        guard case .ok(let token, let deviceId) = await c.register() else {
            return XCTFail("registration should succeed")
        }
        XCTAssertEqual(token, "pkeyt_registered")
        XCTAssertEqual(deviceId, "dev")
        let stored = await store.getToken()
        XCTAssertEqual(stored, "pkeyt_registered")

        // No `Authorization` even if a stale token were held: a client re-registering is asking
        // for a FRESH credential, not authenticating with the old one.
        let request = await server.requests(forPath: "/djdl/devices/register").last
        XCTAssertEqual(request?.method, "POST")
        XCTAssertNil(request?.headers["authorization"])
    }

    /// The two closed policies answer with the SAME 403 — deliberately indistinguishable, so a
    /// client cannot probe which one a product runs.
    func testRegistrationPolicyRefusals() async throws {
        for (status, expected) in [
            (403, RegisterResult.registrationClosed),
            (429, .rateLimited),
            (404, .notConfigured),
        ] {
            server = StubServer()
            await server.reply("/djdl/devices/register", status: status, body: "{}")
            let c = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                    transport: server.transport, fingerprint: false))
            let outcome = await c.register()
            XCTAssertEqual(outcome, expected, "status \(status)")
        }
    }

    // ── §6 device management ─────────────────────────────────────────────────────────
    /// `GET/PATCH/DELETE /<p>/devices[/:id]` are CORE surfaces, available under every
    /// registration policy — a device roster is a property of the product's fleet, not of any
    /// one grant. Only THIS device's status is derived from a signature we checked; another
    /// device's is the server's opinion, and inventing a gate state for it would be reporting a
    /// decision we did not make.
    func testDeviceRosterBlendsServerRowsWithLocalState() async throws {
        let signer = TestSigner(kid: "roster-key")
        let t = Int(Date().timeIntervalSince1970)
        await server.reply(
            "/djdl/devices",
            body: #"""
                {"currentDeviceId":"dev","devices":[
                  {"id":"dev","current":true,"status":"authorized","label":"Ada's Mac"},
                  {"id":"other","current":false,"status":"authorized","label":"Studio"}]}
                """#)
        await server.reply("/djdl/devices/other", body: #"{"ok":true}"#)
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(
            CacheRecord(docs: [.license: signer.sign(Fixtures.license(issuedAt: t))]))
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: server.transport, expectedServices: [.license]))

        let devices = await c.listDevices()
        XCTAssertEqual(devices.count, 2)
        XCTAssertEqual(devices.first { $0.current }?.id, "dev")
        XCTAssertEqual(devices.first { $0.current }?.label, "Ada's Mac")
        XCTAssertEqual(devices.first { $0.current }?.licenseId, "lic")
        XCTAssertNil(devices.first { !$0.current }?.profile)

        try await c.renameDevice("other", label: "Studio B")
        let patch = await server.requests(forPath: "/djdl/devices/other").first
        XCTAssertEqual(patch?.method, "PATCH")
        XCTAssertEqual(patch?.headers["authorization"], "Bearer pkeyt_test")

        try await c.deauthorizeDevice("other")
        let deletes = await server.requests(forPath: "/djdl/devices/other")
            .filter { $0.method == "DELETE" }
        XCTAssertEqual(deletes.count, 1)
    }

    /// Without a credential there is no roster to fetch, so the answer is THIS DEVICE ALONE —
    /// the honest offline answer, not an error.
    func testDeviceRosterOfflineIsThisDeviceAlone() async throws {
        let c = try await PolarisKeyClient.createLocal(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev")))
        let devices = await c.listDevices()
        XCTAssertEqual(devices.map(\.id), ["dev"])
        XCTAssertTrue(devices[0].current)
    }

    /// Deauthorizing THIS device is a full local deactivation, never a roster call.
    func testDeauthorizingSelfIsALocalDeactivation() async throws {
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: store, transport: server.transport))
        try await c.deauthorizeDevice("dev")
        let token = await store.getToken()
        XCTAssertNil(token)
        let rosterCalls = await server.requests(forPath: "/djdl/devices/dev")
        XCTAssertTrue(rosterCalls.isEmpty, "self-deauthorize must not hit the roster route")
    }

    // ── The activation ladder ────────────────────────────────────────────────────────
    /// The Worker emits two error envelopes: routes that MOVED keep the flat v2 shape, and v3
    /// surfaces use the nested one. A 403 meaning "device limit" and a 403 meaning "fingerprint
    /// required" are different outcomes, so both spellings are read.
    func testActivationLadderReadsBothErrorEnvelopes() async throws {
        let cases: [(Int, String, ActivationResult)] = [
            (200, #"{"token":"pkeyt_x","schemaVersion":4}"#, .ok(token: "pkeyt_x", schemaVersion: 4)),
            (401, "{}", .unauthorized),
            (404, "{}", .enrollDisabled),
            (
                403, #"{"error":"device_limit","limit":3,"deviceCount":5}"#,
                .deviceLimit(limit: 3, deviceCount: 5)
            ),
            (
                403, #"{"error":{"code":"device_limit","limit":2,"deviceCount":9}}"#,
                .deviceLimit(limit: 2, deviceCount: 9)
            ),
            (403, #"{"error":"fingerprint_required"}"#, .fingerprintRequired),
            (403, #"{"error":{"code":"fingerprint_required"}}"#, .fingerprintRequired),
            (
                409, #"{"error":"hardware_mismatch","drift":3,"changed":["cpuModel"]}"#,
                .hardwareMismatch(drift: 3, changed: ["cpuModel"])
            ),
        ]
        for (status, body, expected) in cases {
            server = StubServer()
            await server.reply("/djdl/license/activate", status: status, body: body)
            let core = try CoreContext(
                options: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                    transport: server.transport))
            try await core.start()
            let result = await LicenseEndpoints.activate(core, key: "PKEY-KEY")
            XCTAssertEqual(result, expected, "\(status) \(body)")
        }
    }

    /// A host that opted out of fingerprinting sends a byte-identical request to one that has
    /// nothing to report: the body is omitted entirely rather than sent as `{}`.
    func testActivationWithoutAFingerprintSendsNoBody() async throws {
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_x","schemaVersion":1}"#)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport))
        try await core.start()
        _ = await LicenseEndpoints.activate(core, key: "PKEY-KEY", fingerprint: nil)
        let request = await server.requests(forPath: "/djdl/license/activate").last
        XCTAssertNil(request?.body)
        XCTAssertNil(request?.headers["content-type"])
        XCTAssertEqual(request?.headers["authorization"], "Bearer PKEY-KEY")
    }

    /// Activation raises an EVENT rather than syncing inline, and the facade turns that into a
    /// FORCED sync — so a stale ETag cannot 304 away the very first document.
    func testActivationTriggersAForcedSync() async throws {
        let signer = TestSigner(kid: "activation-key")
        let t = Int(Date().timeIntervalSince1970)
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_new","schemaVersion":1}"#)
        let fresh = signer.sign(Fixtures.license(issuedAt: t))
        await server.route("/djdl/license/document") { _ in
            StubServer.Reply(status: 200, body: fresh, headers: ["ETag": "v1"])
        }
        let store = InMemoryStore(deviceId: "dev")
        // A stale ETag from a previous life, which a conditional request would 304 against.
        await store.writeCache(CacheRecord(etags: [.license: "stale"]))

        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: server.transport, expectedServices: [.license], fingerprint: false))
        guard case .ok = await c.activate(key: "PKEY-KEY") else {
            return XCTFail("activation should succeed")
        }
        let activated = await c.status().status
        XCTAssertEqual(activated, .ok, "the first document must have landed")
        let request = await server.requests(forPath: "/djdl/license/document").last
        XCTAssertNil(request?.headers["if-none-match"], "the post-activation sync is forced")
    }

    /// The bridge contract: one snapshot of everything a UI layer renders from.
    func testSyncStateSnapshot() async throws {
        let signer = TestSigner(kid: "bridge-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(
            CacheRecord(docs: [.license: signer.sign(Fixtures.license(issuedAt: t))]))
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: ExplodingTransport(), expectedServices: [.license]))
        let state = await c.syncState()
        XCTAssertEqual(state.activation, .token)
        XCTAssertEqual(state.doc?.issuedAt, t)
        XCTAssertFalse(state.lastSyncUnauthorized)
        XCTAssertNil(state.blocked)
        XCTAssertEqual(state.highWaterMark, t)
        XCTAssertEqual(state.lastVerifiedAt, t * 1000)
    }
}
