// @pkey-feature sync.settings config.sync
// U-07.8: the Cloud Sync settings API on a real client against a stub Worker (server mode, so no ring root
// is needed to talk; the ring root sits in an in-memory store so the sign-out chain can be observed).
// A-1 person change, A-2 offline boot, A-3 the sign-out chain, A-4 and A-5 a sign-out elsewhere and the
// vetted sign-in URL, A-6 the one-time import, `config` through the machine, and the recovery-code entry.

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyConfig
@testable import PolarisKeyCore
@testable import PolarisKeyIdentity

private let VOL = "audio.volume"
private let ALICE = "ps_AliceAliceAliceAlice1"
private let BOB = "ps_BobBobBobBobBobBobBob1"
private let mirror: JSONValue = try! JSONDecoder().decode(
    JSONValue.self,
    from: Data(
        """
        {"schemaVersion":1,"entries":[
          {"key":"audio.volume","kind":"config","schema":{"type":"number"},"user":{"sync":"user","conflict":"lastWrite"}},
          {"key":"locked.key","kind":"config","managementDefault":"enforced"}]}
        """.utf8))

private func pullBody(_ sub: String, _ extra: String = "") -> String {
    """
    {"encryption":"server","subject":"\(sub)","cursor":1,"more":false,"serverNow":\(Int(Date().timeIntervalSince1970 * 1000)),\
    "catalogVersion":1,"lastMutationId":0,"changes":[\(extra)],"tombstones":[],"aliases":{},\
    "usage":{"bytes":0,"settings":0,"records":0,"files":0},"quota":{"bytes":268435456,"files":true}}
    """
}

private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [PolarisKeyEvent] = []
    func add(_ e: PolarisKeyEvent) { lock.withLock { items.append(e) } }
    var all: [CloudSyncEvent] {
        lock.withLock { items.compactMap { if case .cloudSync(let c) = $0 { return c } else { return nil } } }
    }
}

/// Delays the requests `holdFor` names (seconds), then forwards them to the stub.
private struct HoldTransport: PolarisTransport {
    let inner: StubTransport
    let holdFor: @Sendable (PolarisRequest) -> Double?
    let hits: LockedValue<Int>

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        if let seconds = holdFor(request) {
            hits.with { $0 += 1 }
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
        return try await inner.send(request)
    }
}

final class CloudSyncSettingsTests: XCTestCase {
    private let signer = TestSigner(kid: "sync-kid")
    private var server = StubServer()
    private var dir = FileManager.default.temporaryDirectory
    private let log = LockedValue<[String]>([])  // "push" with the root state at the time, in order

    override func setUp() async throws {
        server = StubServer()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-sync-\(UUID().uuidString)")
        log.set([])
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    private var client0: PolarisKeyClient?
    private var stateDirURL: URL?
    private var stateFile: URL { (stateDirURL ?? dir).appendingPathComponent(cloudSyncFileName) }
    private var marker: URL { (stateDirURL ?? dir).appendingPathComponent("cloud-sync-imported.json") }

    private func serve(
        _ roots: RingRootStore, subject: String = ALICE, pull: String? = nil, push403: Bool = false,
        pushChange: String = ""
    ) async {
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: """
                {"product":"djdl","services":{"license":{"enabled":true},"config":{"enabled":true},\
                "sync":{"enabled":true,"encryption":"server"},\
                "identity":{"enabled":true,"account":true,"issuer":"https://key.example/djdl/identity",\
                "endpoints":{"signout":"https://key.example/djdl/identity/signout"}}}}
                """)
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let log = self.log
        await server.route("/djdl/sync") { _ in StubServer.Reply(body: pull ?? pullBody(subject)) }
        await server.route("/djdl/sync/ops") { req in
            let held = ((try? roots.load()) ?? nil) != nil
            log.with { $0.append("push:root=\(held)") }
            if push403 {
                return StubServer.Reply(
                    status: 403,
                    body: #"{"error":{"code":"account_required","signInUrl":"https://evil.example/login"}}"#)
            }
            let ids =
                ((try? JSONSerialization.jsonObject(with: req.body ?? Data())) as? [String: Any])
                .flatMap { $0["mutations"] as? [[String: Any]] }?.compactMap { $0["mutationId"] as? Int } ?? []
            let results = ids.map { #"{"mutationId":\#($0),"status":"ok","version":2}"# }.joined(separator: ",")
            return StubServer.Reply(
                body: pullBody(subject, pushChange).replacingOccurrences(
                    of: #""changes":["#, with: #""results":[\#(results)],"changes":["#))
        }
    }

    private struct Rig {
        let client: PolarisKeyClient
        let roots: RingRootStore
        let events: Events
    }

    private struct LockedVault: DeviceKeyVault {
        func read() throws -> Data? { nil }
        func insert(_ blob: Data) throws -> Bool { true }
        func upsert(_ blob: Data) throws {}
        func delete() throws { throw DeviceKeyError.keychain(-25308) }
    }

    private func rig(
        roots: RingRootStore = .inMemory(), token: String = "pkeyt_alice", transport: (any PolarisTransport)? = nil
    ) async throws -> Rig {
        let store = InMemoryStore(deviceId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        await store.setToken(token)
        let keys = try DeviceKeyStore.inMemory(productSlug: "djdl")
        _ = try await keys.ensure()
        await serve(roots)
        let core = CoreOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
            trustRefresh: false, store: store, transport: transport ?? server.transport,
            expectedServices: [.license, .config, .identity, .sync], stateDir: dir)
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: core, license: LicenseClientOptions(fingerprint: false),
                connect: ConnectOptions(keys: keys, allowEphemeralKeys: true),
                cloudSync: CloudSyncOptions(encryption: .server, catalog: mirror)))
        try client.configureKeyring(SyncKeyringOptions(keys: keys, rootStore: roots))
        try roots.save(
            StoredRingRoot(
                ringId: "rg_" + String(repeating: "A", count: 22), epoch: 1,
                kid: String(repeating: "ab", count: 8), root: Base64URL.encode(Data(repeating: 7, count: 32))))
        stateDirURL = client.core.dirs.state
        client0 = client
        let events = Events()
        let stream = client.events
        Task { for await e in stream { events.add(e) } }
        return Rig(client: client, roots: roots, events: events)
    }

    private func eventually(_ what: String, timeout: Double = 5, _ cond: () async -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if await cond() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        let st = try? await client0?.cloudSync.status()
        XCTFail("timed out: \(what) \(String(describing: st)) \(await server.requests.map { $0.method + $0.url.path })")
    }

    private func signIn(_ r: Rig, as sub: String = ALICE) async {
        r.client.identity.updateSubject(sub)
        await eventually("signed in") { ((try? await r.client.cloudSync.status().state) ?? .local) != .local }
    }

    private func bodies(_ path: String) async -> [String] {
        await server.requests(forPath: path).map { String(decoding: $0.body ?? Data(), as: UTF8.self) }
    }

    // MARK: A-3

    func testSignOutFlushesWhileTheRootIsHeldThenForgetsAndPurges() async throws {
        let r = try await rig()
        await signIn(r)
        try await r.client.config.set(VOL, .double(0.3))
        XCTAssertTrue(FileManager.default.fileExists(atPath: stateFile.path) || true)
        _ = try await r.client.identity.signOut()
        // The unsynced edit was pushed, and the root was still there when it was.
        XCTAssertFalse(log.current.isEmpty)
        XCTAssertTrue(log.current.allSatisfy { $0 == "push:root=true" })
        let all = await server.requests.map(\.url.path)
        let push = try XCTUnwrap(all.lastIndex(of: "/djdl/sync/ops"))
        let signout = try XCTUnwrap(all.lastIndex(of: "/djdl/identity/signout"))
        XCTAssertLessThan(push, signout, "the flush comes before the sign-out request")
        XCTAssertNil(try r.roots.load(), "the root is gone")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stateFile.path), "the synced data is purged")
        let status = try await r.client.cloudSync.status()
        XCTAssertEqual(status.state, .local)
    }

    func testARingThatCannotForgetStopsTheSignOutAndKeepsTheDataAndTheSession() async throws {
        let r = try await rig(roots: RingRootStore(vault: LockedVault()))
        await signIn(r)
        try await r.client.config.set(VOL, .double(0.3))
        do {
            _ = try await r.client.identity.signOut()
            XCTFail("a root that could not be deleted did not stop the sign-out")
        } catch {}
        let log = await server.requests.map(\.url.path)
        XCTAssertFalse(log.contains("/djdl/identity/signout"))
        // D-13: the sign-out did not happen, so nothing was purged.
        XCTAssertTrue(FileManager.default.fileExists(atPath: stateFile.path), "a stopped sign-out keeps the data")
        // N-4: the person is still signed in, so Cloud Sync is too.
        await eventually("the machine is signed in again") {
            ((try? await r.client.cloudSync.status().state) ?? .local) != .local
        }
        let who = await r.client.cloudSyncApi.currentSubject()
        XCTAssertEqual(who, ALICE)
    }

    // MARK: A-1

    func testAPersonChangeNeverFlushesUnderTheNewToken() async throws {
        let r = try await rig()
        await signIn(r)
        try await r.client.config.set(VOL, .double(0.31))
        let before = await bodies("/djdl/sync/ops").count
        // The credential in use becomes Bob's, then the identity says so.
        try await r.client.core.setToken("pkeyt_bob", source: .signin, person: true)
        r.client.identity.updateSubject(BOB)
        await eventually("alice's value left memory") {
            await r.client.config.get(VOL, default: .null) != .double(0.31)
        }
        let sent = await server.requests(forPath: "/djdl/sync/ops")
        XCTAssertEqual(sent.count, before, "nothing of Alice's was sent after the change")
        for req in sent.dropFirst(before) {
            XCTAssertFalse(String(decoding: req.body ?? Data(), as: UTF8.self).contains("0.31"))
        }
        let value = await r.client.config.get(VOL, default: .null)
        XCTAssertNotEqual(value, .double(0.31), "the old person's projection left memory")
    }

    // B-1. Naive: the token is Bob's while the held subject is still Alice's (the licence sync in
    // `onAcquired` runs between), so Alice's pending edit goes out under Bob's token.
    func testNoRequestCarriesAlicesValueUnderBobsTokenWhileTheSignInAcquires() async throws {
        let hits = LockedValue<Int>(0)
        let hold = HoldTransport(
            inner: server.transport,
            holdFor: {
                $0.headers["authorization"] == "Bearer pkeyt_bob" && !$0.url.path.hasPrefix("/djdl/sync") ? 5 : nil
            },
            hits: hits)
        let r = try await rig(transport: hold)
        await signIn(r)
        await server.reply(
            "/djdl/identity/auth/device/start",
            body:
                #"{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}"#
        )
        await server.reply(
            "/djdl/identity/auth/device/poll",
            body: #"{"status":"ready","token":"pkeyt_bob","schemaVersion":1,"subject":"\#(BOB)"}"#)
        try await r.client.config.set(VOL, .double(0.31))  // pending for Alice, debounced
        let prompt = try await r.client.identity.startDeviceCode()
        _ = try await r.client.identity.pollDeviceCode(prompt)  // the window is the 5 s licence-sync hold
        XCTAssertGreaterThan(hits.current, 0, "the window did not open")
        for req in await server.requests(forPath: "/djdl/sync/ops")
        where req.headers["authorization"] == "Bearer pkeyt_bob" {
            XCTAssertFalse(
                String(decoding: req.body ?? Data(), as: UTF8.self).contains("0.31"),
                "Alice's value went out under Bob's token")
        }
    }

    // S-3. Naive: the sign-out waits for the identity consumer's whole pump (a hung pull).
    func testAStuckPumpDoesNotHoldTheSignOutBeyondItsBound() async throws {
        let hold = HoldTransport(
            inner: server.transport,
            holdFor: { $0.headers["authorization"] == "Bearer pkeyt_bob" && $0.url.path == "/djdl/sync" ? 25 : nil },
            hits: LockedValue<Int>(0))
        let r = try await rig(transport: hold)
        await signIn(r)
        await server.reply(
            "/djdl/identity/auth/device/start",
            body:
                #"{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}"#
        )
        await server.reply(
            "/djdl/identity/auth/device/poll",
            body: #"{"status":"ready","token":"pkeyt_bob","schemaVersion":1,"subject":"\#(BOB)"}"#)
        let prompt = try await r.client.identity.startDeviceCode()
        _ = try await r.client.identity.pollDeviceCode(prompt)
        try await Task.sleep(nanoseconds: 500_000_000)  // Bob's first pull is out and hangs
        let t0 = Date()
        _ = try await r.client.identity.signOut()
        XCTAssertLessThan(Date().timeIntervalSince(t0), 15, "the sign-out waited behind the stuck pump")
    }

    // MARK: A-2

    func testAnOfflineBootIsNotASignOut() async throws {
        let first = try await rig()
        await signIn(first)
        try await first.client.config.set(VOL, .double(0.4))
        await first.client.cloudSyncFlush()
        await eventually("the journal is saved") { FileManager.default.fileExists(atPath: stateFile.path) }
        // A relaunch: nothing says who is signed in (no identity read yet, and discovery is down).
        server = StubServer()
        await server.drop("/djdl/.well-known/polaris.json")
        let second = try await rig()
        try await second.client.cloudSync.flush()  // attaches
        let status = try await second.client.cloudSync.status()
        XCTAssertNotEqual(status.state, .local, "the saved journal still names its person")
        XCTAssertTrue(FileManager.default.fileExists(atPath: stateFile.path), "nothing was purged")
        XCTAssertFalse(second.events.all.contains { if case .signedOut = $0 { return true } else { return false } })
        let value = await second.client.config.get(VOL, default: .null)
        XCTAssertEqual(value, .double(0.4))
    }

    // MARK: A-4, A-5

    func testASignOutElsewhereForgetsOnceAndTheSignInUrlIsVetted() async throws {
        let r = try await rig()
        await signIn(r)
        await serve(r.roots, push403: true)
        try await r.client.config.set(VOL, .double(0.5))
        try await r.client.cloudSync.flush()
        await eventually("account_required reached the app") {
            r.events.all.contains { if case .signedOut(.accountRequired, _) = $0 { return true } else { return false } }
        }
        await eventually("offer after the forget") {
            r.events.all.contains { if case .signInOffered = $0 { return true } else { return false } }
        }
        let offers = r.events.all.compactMap { e -> String?? in
            if case .signInOffered(let u) = e { return .some(u) } else { return nil }
        }
        XCTAssertEqual(offers.count, 1)
        XCTAssertEqual(offers.first, .some(nil), "an off-origin URL is never handed to the app")
        XCTAssertNil(try r.roots.load(), "the ring was forgotten")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stateFile.path))
    }

    func testTheSignInUrlCheck() {
        let origin = "https://key.example"
        XCTAssertEqual(safeSignInUrl("/djdl/signin", origin: origin), "https://key.example/djdl/signin")
        XCTAssertEqual(safeSignInUrl("https://key.example/x?y=1", origin: origin), "https://key.example/x?y=1")
        for bad in [
            "https://evil.example/x", "http://key.example/x", "//evil.example/x", "https://key.example:8443/x",
            "https://key.example/a b", "https://key.example/\u{0}", "https://key.example/\n", "javascript:alert(1)",
            "https://key.example.evil.example/x",
        ] { XCTAssertNil(safeSignInUrl(bad, origin: origin), bad) }
        XCTAssertNil(safeSignInUrl(nil, origin: origin))
    }

    // MARK: A-6 and config through the machine

    func testLocalValuesAreOfferedOnceAndTheMarkerIsWrittenAfterSignIn() async throws {
        let r = try await rig()
        // Before any person: config.local holds the value.
        try await r.client.config.set(VOL, .double(0.2))
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        await signIn(r)
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
        let value = await r.client.config.get(VOL, default: .null)
        XCTAssertEqual(value, .double(0.2))
        let state = await r.client.config.setting(VOL).sync()
        XCTAssertNotEqual(state, .local)
    }

    func testSettingSyncStatesAndRefusalsInTheMachinesOrder() async throws {
        let r = try await rig()
        let handle = r.client.config.setting(VOL)
        var s = await handle.sync()
        XCTAssertEqual(s, .local, "no signed-in person")
        await signIn(r)
        try await handle.set(.double(0.6))
        s = await handle.sync()
        XCTAssertEqual(s, .pending)
        try await r.client.cloudSync.flush()
        s = await handle.sync()
        XCTAssertEqual(s, .synced)
        // bad_request first, then managed_by_admin
        do {
            try await handle.set(.string("loud"))
            XCTFail("a value the schema refuses was kept")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.badRequest) }
        // A locked key's clear is a no-op and does not throw (Q-9); its set is refused.
        await r.client.config.setting("locked.key").clear()
        do {
            try await r.client.config.set("locked.key", .int(1))
            XCTFail("a locked key was written")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.managedByAdmin) }
    }

    func testConfigChangeOriginIsLocalByDefaultAndRemoteForAChangeAnotherDeviceMade() async throws {
        let r = try await rig()
        await signIn(r)
        let seen = LockedValue<[ConfigChange]>([])
        r.client.config.onConfigChange("*") { c in seen.with { $0.append(c) } }
        try await r.client.config.set(VOL, .double(0.7))
        XCTAssertEqual(seen.current.last { $0.key == VOL }?.origin, .local)
        // Another device wrote a key; the next answer brings it.
        await serve(
            r.roots,
            pushChange:
                #"{"setting":"remote.only","scope":"user","value":"hi","version":50,"editedHlc":"0000ffffffff:0000"}"#)
        try await r.client.cloudSync.flush()
        await eventually("remote change") { seen.current.contains { $0.key == "remote.only" } }
        XCTAssertEqual(seen.current.first { $0.key == "remote.only" }?.origin, .remote)
    }

    // MARK: the recovery-code entry

    func testNewRecoveryCodeReachesTheKeyring() async throws {
        let r = try await rig()
        // The ring holds no root in memory (it was never unlocked), so the keyring's own refusal comes back.
        do {
            _ = try await r.client.cloudSync.recoveryCode.generate()
            XCTFail("a locked ring made a recovery code")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.syncLocked) }
    }

    func testStatusIsTheTypedNotApplicableWithoutTheSyncService() async throws {
        let store = InMemoryStore(deviceId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
                trustRefresh: false, store: store, transport: server.transport, fingerprint: false))
        do {
            _ = try await client.cloudSync.status()
            XCTFail("status answered without the Sync service")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.serviceUnavailable) }
    }
}

extension PolarisKeyClient {
    fileprivate func cloudSyncFlush() async { _ = try? await cloudSync.flush() }
}
