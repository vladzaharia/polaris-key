import Foundation
import XCTest

@testable import PolarisKeyPlatform

final class AssetPackTests: XCTestCase {
    private func service(
        _ client: FakeAssetPackClient, availability: PlatformAvailability = .iOS26_4
    ) -> (AssetPackService, EventLog) {
        let sink = PlatformEventSink()
        return (AssetPackService(client: client, availability: availability, sink: sink), EventLog(sink))
    }

    func testUnavailableBelow26_4EvenWhenConfigured() async {
        // A 26.0–26.3 device has the class but not the 26.4 methods: unavailable (version).
        let client = FakeAssetPackClient(configured: true)
        let (s, _) = service(client, availability: .iOS26_3)
        let u = s.unsupported()
        XCTAssertEqual(u?["unsupported"], true)
        XCTAssertEqual(u?["reason"], "version")
        let ensured = await s.ensure([AssetPackRequest(id: "foes-c3", path: "foes/content.pck")], requireLatest: false)
        XCTAssertEqual(ensured["reason"], "version")
        XCTAssertTrue(client.ensureCalls.isEmpty, "the manager is never called below 26.4")
        let st = await s.status(id: "foes-c3")
        XCTAssertEqual(st["reason"], "version")
    }

    func testASideloadBuildIsUnsupportedForTheOutlet() async {
        let client = FakeAssetPackClient(configured: false)
        let (s, _) = service(client)
        XCTAssertEqual(s.unsupported()?["reason"], "outlet")
        let r = await s.checkForUpdates()
        XCTAssertEqual(r["reason"], "outlet")
    }

    func testEnsureForwardsProgressAndReportsReady() async {
        let client = FakeAssetPackClient()
        client.afterEnsure["foes-c3"] = AssetPackStatus(["upToDate", "downloaded"])
        client.files = ["/staging/foes/content.pck"]
        client.progress["foes-c3"] = [.began, .downloading(bytes: 512, total: 1024), .downloading(bytes: 1024, total: 1024), .finished]
        let (s, log) = service(client)
        let r = await s.ensure([AssetPackRequest(id: "foes-c3", path: "foes/content.pck")], requireLatest: true)
        XCTAssertEqual(r["packs"], .array([.object(["id": "foes-c3", "ready": true, "path": "/staging/foes/content.pck"])]))
        XCTAssertEqual(log.named("pack_ready"), [["ev": "pack_ready", "id": "foes-c3", "path": "/staging/foes/content.pck"]])
        let progress = log.named("pack_progress")
        XCTAssertEqual(progress.last, ["ev": "pack_progress", "id": "foes-c3", "bytes": 1024, "total": 1024])
        XCTAssertEqual(client.ensureCalls.first?.1, true)
    }

    func testAFailedEnsureWhoseStatusIsDownloadedIsReady() async {
        // S-01: "Couldn't communicate with a helper application" after a complete download.
        let client = FakeAssetPackClient()
        client.ensureErrors["foes-c3"] = "Couldn't communicate with a helper application."
        client.afterEnsure["foes-c3"] = AssetPackStatus(["downloaded"])
        client.files = ["/staging/foes/content.pck"]
        let (s, log) = service(client)
        let r = await s.ensure([AssetPackRequest(id: "foes-c3", path: "foes/content.pck")], requireLatest: false)
        guard case .array(let packs)? = r["packs"], case .object(let one)? = packs.first else { return XCTFail() }
        XCTAssertEqual(one["ready"], true)
        XCTAssertTrue(log.named("pack_failed").isEmpty)
    }

    func testFailuresCarryTheErrorString() async {
        let client = FakeAssetPackClient()
        client.ensureErrors["foes-c3"] = "No asset pack with the ID foes-c3 was found"
        client.afterEnsure["foes-c3"] = AssetPackStatus(["downloadAvailable"])
        // A downloaded but out-of-date pack is not ready either.
        client.afterEnsure["bosses-c3"] = AssetPackStatus(["outOfDate", "downloaded"])
        let (s, log) = service(client)
        _ = await s.ensure(
            [AssetPackRequest(id: "foes-c3", path: "foes/content.pck"), AssetPackRequest(id: "bosses-c3", path: "b/content.pck")],
            requireLatest: false)
        let failed = log.named("pack_failed")
        XCTAssertEqual(failed.count, 2)
        let foes = failed.first { $0["id"] == "foes-c3" }
        XCTAssertEqual(
            foes?["err"], "ManagedBackgroundAssetsXPC.XPCInvocationError 1: No asset pack with the ID foes-c3 was found")
        XCTAssertTrue(log.named("pack_ready").isEmpty)
    }

    func testUrlForAMissingFileIsNotReady() async {
        // url(for:) returns a path for files that do not exist (S-01): checked on disk.
        let client = FakeAssetPackClient()
        client.afterEnsure["foes-c3"] = AssetPackStatus(["upToDate", "downloaded"])
        let (s, log) = service(client)
        let r = await s.ensure([AssetPackRequest(id: "foes-c3", path: "foes/missing.pck")], requireLatest: false)
        guard case .array(let packs)? = r["packs"], case .object(let one)? = packs.first else { return XCTFail() }
        XCTAssertEqual(one["ready"], false)
        XCTAssertEqual(log.named("pack_failed").count, 1)
        let url = await s.url(for: "foes/missing.pck")
        XCTAssertEqual(url, ["ok": true, "path": "/staging/foes/missing.pck", "exists": false])
    }

    func testStatusLocalVersionUpdatesAndRemove() async {
        let client = FakeAssetPackClient()
        client.statuses["foes-c3"] = AssetPackStatus(["upToDate", "downloaded"])
        client.statuses["bosses-c3"] = AssetPackStatus(["outOfDate", "downloaded"])
        client.versions = ["foes-c3": 3, "bosses-c3": 5]
        client.updating = ["bosses-c3"]
        let (s, _) = service(client)
        let foes = await s.status(id: "foes-c3")
        XCTAssertEqual(foes["localVersion"], 3)
        XCTAssertEqual(foes["status"], .array(["upToDate", "downloaded"]))
        let bosses = await s.status(id: "bosses-c3")
        XCTAssertEqual(bosses["localVersion"], .null, "an out-of-date copy's version is not the manifest's")
        let unknown = await s.status(id: "nope")
        XCTAssertEqual(unknown["version"], .null)
        XCTAssertNotNil(unknown["infoError"])
        let updates = await s.checkForUpdates()
        XCTAssertEqual(updates, ["ok": true, "updating": .array(["bosses-c3"]), "removed": .array([])])
        let removed = await s.remove(id: "foes-c3")
        XCTAssertEqual(removed["ok"], true)
        XCTAssertEqual(client.removeCalls, ["foes-c3"])
    }

    func testWatchForwardsStatusUpdates() async {
        let client = FakeAssetPackClient()
        client.progress["foes-c3"] = [.began, .downloading(bytes: 1, total: 2), .failed("boom")]
        let (s, log) = service(client)
        let r = await s.watch(id: "foes-c3")
        XCTAssertEqual(r["ok"], true)
        let events = await log.wait { $0.contains { $0["state"] == "failed" } }
        XCTAssertTrue(events.contains { $0["ev"] == "pack_progress" && $0["bytes"] == 1 })
        _ = await s.unwatch(id: "foes-c3")
    }

    func testInfoPlistGate() {
        XCTAssertFalse(backgroundAssetsConfigured(nil))
        XCTAssertFalse(backgroundAssetsConfigured(["BAAppGroupID": "group.x"]))
        XCTAssertFalse(backgroundAssetsConfigured(["BAHasManagedAssetPacks": true]))
        XCTAssertTrue(backgroundAssetsConfigured(["BAAppGroupID": "group.x", "BAHasManagedAssetPacks": true]))
        // The test bundle carries no keys, so the real client is never constructed configured.
        XCTAssertFalse(backgroundAssetsConfigured())
    }
}
