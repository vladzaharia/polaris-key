// @pkey-feature sync.settings
// The Cloud Sync host after its security review: S-1 an accepted edit survives a rebuild, S-2 purge takes the
// machine away at once and blocks touch and rebuild until it ends, N-1 a served catalog is never persisted.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

private func docOf(_ v: Double) -> SyncMachineDocument {
    SyncMachineDocument(values: ["unrelated.key": .double(v)])
}

@Suite struct CloudSyncHostFixesTests {
    // S-1. Naive: the snapshot is taken before the awaits, so an edit accepted while they run is lost.
    @Test func s1AnEditAcceptedDuringARebuildSurvivesIt() async throws {
        let rig = HostRig()
        var deps = rig.deps()
        let calls = LockedValue<Int>(0)
        let value = LockedValue<Double>(0)
        deps.document = {
            let n = calls.with {
                $0 += 1
                return $0
            }
            // Calls: 1 the first build, then the change check, then the rebuild's: that one is slow.
            if n >= 3 { try? await Task.sleep(nanoseconds: 500_000_000) }
            return docOf(value.current)
        }
        let h = CloudSyncHost(deps: deps, options: CloudSyncOptions(catalog: hMirror))
        try await h.start()
        _ = try await h.signIn(hALICE)
        value.set(1)  // the document changes: the next refresh asks for a rebuild
        let rebuilding = Task { await h.noteDocumentRefreshed() }
        try await Task.sleep(nanoseconds: 150_000_000)
        let r = await h.set(hVOL, .double(0.7))  // accepted while the rebuild's awaits run
        #expect(r == .ok)
        await rebuilding.value
        try await Task.sleep(nanoseconds: 700_000_000)
        #expect(await h.get(hVOL)?.value == .double(0.7))
        #expect((await h.status()?.pending ?? 0) > 0 || rig.sent.contains { $0.method == .post })
    }

    // S-2. Naive: the old machine stays live across purge's awaits, so a touch pumps it.
    @Test func s2PurgeRemovesTheMachineAtOnceAndBlocksTouch() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        _ = await h.set(hVOL, .double(0.5))
        rig.now += 5_000
        await h.setPumpWait(5_000)
        rig.sendDelayMs = 700  // a push is out while the purge starts
        let gen = await h.generationCount()
        let pumping = Task { await h.touch() }
        try await Task.sleep(nanoseconds: 150_000_000)
        let purging = Task { try await h.purge() }
        while await h.generationCount() == gen { try await Task.sleep(nanoseconds: 5_000_000) }
        // Gone before the purge awaited anything. A slow runner can see the purge already finished
        // (the new local machine); never the old signed-in one.
        let mid = await h.status()
        #expect(mid == nil || mid?.state == .local)
        let sentBefore = rig.sent.count
        await h.touch()  // blocked: no pump on any machine while the purge runs
        #expect(rig.sent.count == sentBefore)
        try await purging.value
        await pumping.value
        #expect(await h.status()?.state == .local)
        // A person signing in right after is not lost to the purge.
        _ = try await h.signIn(hALICE)
        #expect(await h.machineSubject() == hALICE)
    }

    // N-1. Naive: the served catalog is written to cloud-sync.json and read back at the next start.
    @Test func n1AServedCatalogIsNeverPersisted() async throws {
        let rig = HostRig()
        rig.setSchema(
            hJ(
                """
                {"schemaVersion":2,"entries":[{"key":"extra.key","kind":"config","user":{"sync":"user","conflict":"lastWrite"}}]}
                """))
        let h = try await rig.host(CloudSyncOptions())  // no mirror: the catalog is fetched at start
        _ = try await h.signIn(hALICE)
        #expect(await h.routeKeys().contains("extra.key"))
        _ = await h.set("extra.key", .int(1))
        rig.now += 5_000
        await h.touch()
        await h.flush(maxMs: 500)
        #expect(CloudSyncStateFile(stateDir: rig.dir, product: "demo").load().catalog == nil)
        let raw = try String(contentsOf: rig.dir.appendingPathComponent(cloudSyncFileName), encoding: .utf8)
        #expect(!raw.contains("extra.key\",\"kind\""))
    }
}
