// @pkey-feature sync.settings
// U-52.4: what the host does with an `account_required` the machine did not see on `/sync` (a key-ring or
// file route), and with the one it abandons a request for. The api-level persistence and key-ring paths are
// in CloudSyncSettingsTests.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

@Suite struct CloudSyncAccountRequiredTests {
    private func edited(_ rig: HostRig) async throws -> CloudSyncHost {
        let h = try await hSignedIn(rig)
        _ = await h.set(hVOL, .double(0.6))
        return h
    }

    @Test func aRouteAnswerBlocksTheMachineAndSavesItAsItStands() async throws {
        let rig = HostRig()
        rig.responder = { _, _ in .transport }  // the edit stays unsent
        let h = try await edited(rig)
        await h.accountRequired(signInUrl: "/djdl/signin")
        #expect(await h.machineSubject() == nil)
        #expect(await h.status()?.state == .blocked)
        #expect(await h.status()?.reason == .accountRequired)
        try await h.saveBlocked(subject: hALICE)
        #expect(await h.refused == hALICE)
        await h.close()
        // A relaunch over the same directory keeps it blocked, with the partition gone.
        let again = try await rig.host()
        #expect(await again.status()?.state == .blocked)
        #expect(await again.status()?.reason == .accountRequired)
        #expect(await again.machineSubject() == nil)
        #expect(await again.refused == hALICE)
        let saved = CloudSyncStateFile(stateDir: rig.dir, product: "demo").load()
        #expect(saved.persisted?.partitions[hALICE] == nil)
        #expect(saved.persisted?.blocked == .accountRequired)
        // Only a sign-in lifts it, and another subject lifts the refusal too.
        _ = try await again.signIn(hBOB)
        #expect(await again.refused == nil)
        #expect(await again.status()?.state != .blocked)
        await again.close()
    }

    @Test func aPinThatStaysIsSavedWithTheBlockedStateAndSettledOnceItGoes() async throws {
        let rig = HostRig()
        rig.responder = { _, _ in .transport }
        let h = try await edited(rig)
        await h.accountRequired(signInUrl: nil)
        try await h.saveBlocked(subject: hALICE, forgetPending: true)
        #expect(await h.forgetPending)
        let file = CloudSyncStateFile(stateDir: rig.dir, product: "demo")
        #expect(file.load().forgetPending)
        await h.close()
        // A relaunch still knows the pin is pending; settling clears it on disk.
        let again = try await rig.host()
        #expect(await again.forgetPending)
        await again.settleForget()
        #expect(await again.forgetPending == false)
        #expect(file.load().forgetPending == false)
        #expect(file.load().refused == hALICE)
        await again.close()
    }

    @Test func aBlockedStateThatCannotBeWrittenRemovesTheFileAndHoldsTheRefusalInMemory() async throws {
        let rig = HostRig()
        rig.responder = { _, _ in .transport }
        let h = try await edited(rig)
        await h.accountRequired(signInUrl: nil)
        let file = CloudSyncStateFile(stateDir: rig.dir, product: "demo")
        try file.save(CloudSyncFile(openKeys: ["x"], refused: nil))
        // The state path is a non-empty directory now: the rename over it fails, the removal does not.
        try FileManager.default.removeItem(at: file.url)
        try FileManager.default.createDirectory(
            at: file.url.appendingPathComponent("held"), withIntermediateDirectories: true)
        try await h.saveBlocked(subject: hALICE)
        #expect(!FileManager.default.fileExists(atPath: file.url.path))
        #expect(await h.refused == hALICE)
        // Nothing is saved again until a sign-in.
        await h.flush(maxMs: 100)
        #expect(!FileManager.default.fileExists(atPath: file.url.path))
        await h.close()
    }

    @Test func noPersonSignedInIsANoOp() async throws {
        let rig = HostRig()
        let h = try await rig.host()
        await h.accountRequired(signInUrl: nil)
        #expect(await h.status()?.state != .blocked)
    }

    @Test func anAnswerToARequestTheMachineAbandonedIsDroppedWhole() async throws {
        let rig = HostRig()
        let box = LockedValue<CloudSyncHost?>(nil)
        rig.sendDelayMs = 150
        // The first request in flight: the route hears account_required while it waits.
        let fired = LockedValue<Bool>(false)
        rig.onSend = { _ in
            let was = fired.with { flag -> Bool in
                let before = flag
                flag = true
                return before
            }
            if was { return }
            Task { await box.current?.accountRequired(signInUrl: nil) }
        }
        // The answer names a newer catalog: a host that read it would fetch the schema.
        rig.responder = { _, _ in .answer(status: 200, body: hReply(["catalogVersion": .int(2)])) }
        let h = try await rig.host()
        box.set(h)
        _ = try await h.signIn(hALICE)
        await h.touch()
        #expect(await h.status()?.state == .blocked)
        #expect(rig.fetchCount == 0)
        #expect(await h.machineSubject() == nil)
    }
}
