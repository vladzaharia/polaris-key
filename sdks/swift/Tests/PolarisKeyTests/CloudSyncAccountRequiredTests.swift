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
        await h.saveBlocked(subject: hALICE)
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
            if fired.with({ let was = $0; $0 = true; return was }) { return }
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
