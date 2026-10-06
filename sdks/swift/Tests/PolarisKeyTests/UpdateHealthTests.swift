// @pkey-feature devices.report update.driver update.feed
//
// SP-S05 and SP-S10 (notes/SDK-PARITY-PASS.md §3.13, §3.16, §3.7, §3.8): the update-health journal
// (P6-03) persists through the store, rides at most 16 per report with the gate and outlet, and is
// dropped only once a report is accepted; report(extras:) adds allowlisted keys without
// overriding the SDK's; install() opens a store listing and journals the hand-off; feedUrl()
// expands discovery's templates; distribution.downloadModel() decodes the page model.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyUpdate
import XCTest

final class UpdateHealthTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func client(store: InMemoryStore? = nil) async throws -> (PolarisKeyClient, InMemoryStore) {
        let s: InMemoryStore
        if let store { s = store } else {
            s = InMemoryStore(deviceId: "dev")
            await s.setToken("pkeyt_dev")
        }
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: s, transport: server.transport,
                expectedServices: [.license, .update, .release, .distribution],
                fingerprint: false))
        return (c, s)
    }

    private func reportBody() async throws -> [String: JSONValue] {
        let r = await server.requests(forPath: "/djdl/devices/report").last
        return try XCTUnwrap(
            try JSONDecoder().decode(JSONValue.self, from: r?.body ?? Data()).objectValue)
    }

    func testTheJournalPersistsAndIsBoundedPerReport() async throws {
        let store = InMemoryStore(deviceId: "dev")
        let journal = UpdateJournal(store: store)
        for i in 0..<20 {
            await journal.record(
                UpdateEvent.updateConfirmed, release: "1.0.\(i)", fromRelease: "1.0.0",
                channel: "stable", at: 1_700_000_000 + i)
        }
        let again = UpdateJournal(store: store)
        let all = await again.all()
        XCTAssertEqual(all.count, 20, "persisted through the store")
        let pending = await again.pending()
        XCTAssertEqual(pending.count, MAX_REPORT_UPDATE_EVENTS)
        XCTAssertEqual(pending.first?.release, "1.0.0")
        XCTAssertNil(pending.first?.fromRelease, "equal to release is omitted")
        XCTAssertEqual(pending.last?.fromRelease, "1.0.0")
        XCTAssertEqual(pending.first?.outlet, "unknown")
        await again.markReported(pending.map(\.eventId))
        let left = await again.all()
        XCTAssertEqual(left.count, 4)
    }

    func testAReportCarriesUpdatesGateAndOutletAndDropsThemWhenAccepted() async throws {
        let (c, _) = try await client()
        c.core.journal.outlet.set("app-store")
        await c.core.journal.record(
            UpdateEvent.updateApplied, release: "1.1.0", fromRelease: "1.0.0", channel: "stable")
        await server.reply("/djdl/devices/report", status: 500, body: "{}")
        let refused = await c.report()
        XCTAssertFalse(refused)
        let kept = await c.core.journal.all()
        XCTAssertEqual(kept.count, 1, "kept until a report is accepted")

        await server.reply("/djdl/devices/report", body: #"{"ok":true}"#)
        let ok = await c.report(extras: [
            "packInstalls": .array([]), "gate": .string("ignored"), "nope": .bool(true),
        ])
        XCTAssertTrue(ok)
        let body = try await reportBody()
        XCTAssertEqual(body["outlet"], .string("app-store"))
        XCTAssertEqual(body["gate"]?.objectValue?["status"], .string("needs-activation"), "the SDK's gate wins over extras")
        XCTAssertEqual(body["packInstalls"], .array([]))
        XCTAssertNil(body["nope"], "only allowlisted keys")
        let updates = try XCTUnwrap(body["updates"]?.arrayValue)
        XCTAssertEqual(updates.first?.objectValue?["event"], .string("update_applied"))
        XCTAssertEqual(updates.first?.objectValue?["outlet"], .string("app-store"))
        let after = await c.core.journal.all()
        XCTAssertTrue(after.isEmpty)
    }

    func testInstallOpensAStoreListingAndJournalsTheHandOff() async throws {
        let (c, _) = try await client()
        let opened = LockedValue<[URL]>([])
        let check = UpdateCheck(
            channel: "stable",
            decision: .store(
                release: DecisionRelease(version: "2.0.0", seq: 3),
                listingUrl: "https://apps.apple.com/app/id1", mandatory: false, critical: false,
                discardStaged: false),
            feed: .network, record: .none, errors: [])
        let outcome = await c.update.install(check) { url in
            opened.with { $0.append(url) }
            return true
        }
        XCTAssertEqual(outcome, .storeOpened(URL(string: "https://apps.apple.com/app/id1")!))
        XCTAssertEqual(opened.current, [URL(string: "https://apps.apple.com/app/id1")!])
        let events = await c.core.journal.all()
        XCTAssertEqual(events.map(\.event), ["update_applied"])
        XCTAssertEqual(events.first?.release, "2.0.0")

        let none = UpdateCheck(
            channel: "stable", decision: .none(reason: "current", behind: false, discardStaged: false),
            feed: .network, record: .none, errors: [])
        let upToDate = await c.update.install(none) { _ in true }
        XCTAssertEqual(upToDate, .upToDate)
    }

    func testFeedUrlsAndTheDownloadModel() async throws {
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: #"{"product":"djdl","services":{"license":{"enabled":true},"update":{"enabled":true,"endpoints":{"appcast":"https://key.example/djdl/update/appcast.xml","channelAppcast":"https://key.example/djdl/update/{channel}/appcast.xml","velopack":"https://key.example/djdl/update/{channel}/velopack/releases.{velopackChannel}.json"}},"release":{"enabled":true},"distribution":{"enabled":true}}}"#)
        await server.reply(
            "/djdl/distribution/download.json",
            body: #"{"schemaVersion":1,"product":{"slug":"djdl","name":"DJDL"},"channel":"stable","pageUrl":null,"listing":{"name":"DJDL"},"release":{"releaseId":"v2","version":"2.0.0","title":null,"publishedAt":null,"summary":null},"platforms":[{"platform":"macos","label":"macOS","primary":"download:direct:macos","actions":["download:direct:macos"],"builds":[]}],"actions":[{"id":"download:direct:macos","kind":"download","outletId":"direct","platforms":["macos"],"label":"Download","url":"https://dl.example/x.dmg","deepLink":null,"qr":null,"command":null,"fingerprint":null,"version":"2.0.0","build":null}],"keys":[]}"#)
        let (c, _) = try await client()
        _ = await c.discover()
        let appcast = try await c.update.feedUrl(.appcast, channel: "beta")
        XCTAssertEqual(appcast.absoluteString, "https://key.example/djdl/update/beta/appcast.xml")
        let velopack = try await c.update.feedUrl(.velopack, channel: "stable", velopackChannel: "osx")
        XCTAssertEqual(
            velopack.absoluteString,
            "https://key.example/djdl/update/stable/velopack/releases.osx.json")
        do {
            _ = try await c.update.feedUrl(.winsparkle)
            XCTFail("expected unsupported")
        } catch let e as UnsupportedError {
            XCTAssertEqual(e.reason, UnsupportedReason.product)
        }
        let model = try await c.distribution.downloadModel()
        XCTAssertEqual(model.release?.version, "2.0.0")
        XCTAssertEqual(model.primaryAction(for: "macos")?.url, "https://dl.example/x.dmg")
    }
}
