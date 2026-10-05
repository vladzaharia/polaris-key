// @pkey-feature ui.stages update.bootguard
//
// `client.boot()` and the app boot guard (notes/SDK-PARITY-PASS.md §3.4, §3.15) driving the
// stage machine (stage-matrix.json): a usable gate boots to `ready`; no credential under a closed
// registration policy waits at the gate (never an invented prompt); an `open` product registers
// keylessly; the guard counts unconfirmed launches, journals `boot_rolled_back` (`no-previous`)
// once, and `update_confirmed` for the first confirmed launch of a new build; decide and fetch
// hooks feed their stages.

import Foundation
import PolarisKey
import PolarisKeyCore
import XCTest

final class BootTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func client(
        version: String = "1.0.0", store: InMemoryStore = InMemoryStore(deviceId: "dev"),
        services: [ServiceSlug] = [.config], local: Bool = false
    ) async throws -> PolarisKeyClient {
        let options = PolarisKeyClientOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: version,
            pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
            expectedServices: services, fingerprint: false)
        return local
            ? try await PolarisKeyClient.createLocal(options: options)
            : try await PolarisKeyClient.create(options: options)
    }

    func testAProductWithoutLicenseBootsToReady() async throws {
        let c = try await client()
        let stages = LockedValue<[String]>([])
        let run = await c.boot(confirmAfterReady: false) { emit in
            if case .stageChanged(let stage, _) = emit { stages.with { $0.append(stage.rawValue) } }
        }
        XCTAssertEqual(run.outcome, .ready)
        XCTAssertEqual(run.gate, .notApplicable)
        XCTAssertEqual(
            stages.current, ["shell", "guard", "sync", "gate", "decide", "fetch", "mount", "ready"])
        XCTAssertTrue(run.emits.contains(.bootReady))
    }

    func testNoCredentialWaitsAtTheGate() async throws {
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: #"{"product":"djdl","core":{"registration":"requires-license"},"services":{"license":{"enabled":true}}}"#)
        let c = try await client(services: [.license])
        let run = await c.boot(confirmAfterReady: false)
        XCTAssertEqual(run.outcome, .waiting)
        XCTAssertEqual(run.gate, .needsActivation)
        XCTAssertTrue(run.emits.contains(.waiting(status: .needsActivation)))
        let registers = await server.requests(forPath: "/djdl/devices/register")
        XCTAssertTrue(registers.isEmpty, "a closed policy never registers")
    }

    func testAnOpenProductRegistersKeylessly() async throws {
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: #"{"product":"djdl","core":{"registration":"open"},"services":{"license":{"enabled":true}}}"#)
        await server.reply(
            "/djdl/devices/register", body: #"{"token":"pkeyt_reg","deviceId":"dev"}"#)
        let c = try await client(services: [.license])
        _ = await c.ensureActivated()
        let token = await c.core.token
        XCTAssertEqual(token, "pkeyt_reg")
    }

    func testLocalOnlyBootsOfflineIntoReady() async throws {
        let c = try await client(local: true)
        let run = await c.boot(confirmAfterReady: false)
        XCTAssertEqual(run.outcome, .ready, "allowOffline carries a not-applicable gate through")
        let strict = await c.boot(options: BootOptions(allowOffline: false), confirmAfterReady: false)
        XCTAssertEqual(strict.outcome, .offline)
    }

    func testHooksFeedDecideAndFetch() async throws {
        let c = try await client()
        c.setBootHooks(
            BootHooks(
                decide: { .optional },
                fetch: { send in
                    send(.fetchProgress(done: 1, total: 2))
                    return BootFetchAnswer(result: .ok, installed: ["maps"])
                },
                packOptions: { BootPackLists(required: ["maps"], essential: []) }))
        let run = await c.boot(confirmAfterReady: false)
        XCTAssertEqual(run.outcome, .ready)
        XCTAssertTrue(run.emits.contains(.updateAvailable))
        XCTAssertTrue(run.emits.contains(.fetchProgress(done: 1, total: 2)))

        c.setBootHooks(BootHooks(decide: { .required }))
        let blocked = await c.boot(confirmAfterReady: false)
        XCTAssertEqual(blocked.outcome, .blocked)
    }

    func testTheBootGuardCountsAndJournals() async throws {
        let store = InMemoryStore(deviceId: "dev")
        let v1 = try await client(store: store)
        let first = await v1.bootGuard.markBootAttempt()
        XCTAssertEqual(first.failedBoots, 0)
        XCTAssertEqual(first.action, BootGuardAction.none)
        await v1.bootGuard.confirmBoot()

        let v2 = try await client(version: "1.1.0", store: store)
        _ = await v2.bootGuard.markBootAttempt()
        _ = await v2.bootGuard.markBootAttempt()
        let third = await v2.bootGuard.markBootAttempt()
        XCTAssertEqual(third.failedBoots, MAX_FAILED_BOOTS)
        XCTAssertEqual(third.action, .rollBack)
        XCTAssertTrue(third.rollBackUnavailable)
        _ = await v2.bootGuard.markBootAttempt()
        var events = await v2.core.journal.all()
        XCTAssertEqual(events.filter { $0.event == "boot_rolled_back" }.count, 1, "once")
        XCTAssertEqual(events.first?.code, "no-previous")
        XCTAssertEqual(events.first?.fromRelease, "1.0.0")

        await v2.bootGuard.confirmBoot()
        let reset = await v2.bootGuard.failedBoots()
        XCTAssertEqual(reset, 0)
        events = await v2.core.journal.all()
        let confirmed = events.first { $0.event == "update_confirmed" }
        XCTAssertEqual(confirmed?.release, "1.1.0")
        XCTAssertEqual(confirmed?.fromRelease, "1.0.0")
    }
}
