// @pkey-feature sync.settings
// The Cloud Sync host's bounds (U-07.7): H-7 purge, H-8 re-entrancy, H-9 a bounded flush, `close()` and
// the lifecycle flush (Q-5). One test per rule; each names below how the naive version fails.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

private let ALICE = hALICE
private let VOL = hVOL
private let mirror = hMirror

private func stateFileExists(_ rig: HostRig) -> Bool {
    FileManager.default.fileExists(atPath: rig.dir.appendingPathComponent(cloudSyncFileName).path)
}

/// Runs `body` on the host once the machine holds a pending edit that a push is about to carry.
private func withPendingEdit(_ rig: HostRig, _ h: CloudSyncHost) async {
    _ = await h.set(VOL, .double(0.5))
    rig.now += 5_000
}

@Suite struct CloudSyncHostBoundsTests {
    // H-7. Naive: no generation check, so the in-flight push's answer is `receive`d into the rebuilt
    // machine (a precondition failure, or the old snapshot saved again) and the file comes back.
    @Test func h7PurgeInterleavedWithAnInFlightExchangeNeverReceivesOrResavesTheOldSnapshot() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        await withPendingEdit(rig, h)
        await h.setPumpWait(50)  // the purge stops waiting before the slow answer lands
        let gen = await h.generationCount()
        let go = LockedValue<Bool>(false)
        rig.onSend = { r in
            guard r.sent.last?.method == .post, !go.current else { return }
            go.set(true)
            // The purge starts while this push is out; the push waits until the purge has moved on.
            Task { try? await h.purge() }
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline {
                if Task.isCancelled { break }
                Thread.sleep(forTimeInterval: 0.01)
                if r.purgeStarted.current { break }
            }
        }
        rig.sendDelayMs = 0
        // The purge bumps the generation immediately: let the answer arrive after that.
        rig.responder = { req, r in
            if req.method == .get { return .answer(status: 200, body: hReply()) }
            if req.method == .post {
                let end = Date().addingTimeInterval(2)
                while Date() < end, !r.purgeStarted.current { Thread.sleep(forTimeInterval: 0.01) }
                Thread.sleep(forTimeInterval: 0.4)  // lands after the purge has finished
            }
            // The answer carries a sealed open-key row of the person being purged.
            let leak: JSONValue = .object([
                "setting": .string(SyncBlind.blind(root: hRoot, kind: .setting, ctx: hC, n: "leak.key")),
                "scope": .string("user"), "version": .int(9),
                "ct": .string(
                    Base64URL.encode(
                        try! SyncEnvelope.seal(root: hRoot, collection: hC, name: "leak.key", value: .int(1)))),
            ])
            return .answer(
                status: 200,
                body: hReply([
                    "encryptionSince": .int(0), "changes": .array([leak]),
                    "results": .array([.object(["mutationId": .int(1), "status": .string("ok"), "version": .int(9)])]),
                ]))
        }
        Task {
            // Watch for the generation to move, then release the send.
            for _ in 0..<300 {
                if await h.generationCount() != gen {
                    rig.purgeStarted.set(true)
                    return
                }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        await h.touch()
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(rig.sent.contains { $0.method == .post })  // the push was really in flight
        #expect(rig.purgeStarted.current)
        #expect(!stateFileExists(rig))  // not re-saved by the stale pump
        #expect(await h.openKeyNames().isEmpty)  // the purged person's name did not come back
        #expect(await h.status()?.state == .local)  // a fresh, signed-out machine
        _ = try await h.signIn(ALICE)
        await h.flush(maxMs: 500)
        #expect(CloudSyncStateFile(stateDir: rig.dir, product: "demo").load().openKeys.isEmpty)
        #expect(await h.get(VOL)?.from != .cloud)
    }

    // H-7. Naive: the file is removed after the wait, so a slow pump leaves the snapshot on disk, or
    // purge fails to throw when the file stays.
    @Test func h7PurgeDeletesTheFileFirstSweepsTemporariesAndSavesNothingUntilSignIn() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        await withPendingEdit(rig, h)
        await h.touch()
        #expect(stateFileExists(rig))
        try Data().write(to: rig.dir.appendingPathComponent("\(cloudSyncFileName).dead.tmp"))
        try await h.purge()
        #expect(try FileManager.default.contentsOfDirectory(atPath: rig.dir.path).isEmpty)
        await h.touch()
        await h.flush(maxMs: 500)
        #expect(!stateFileExists(rig))  // purged: nothing is saved until a principal signs in
        _ = try await h.signIn(ALICE)
        await withPendingEdit(rig, h)
        await h.touch()
        #expect(stateFileExists(rig))
        #expect(await h.openKeyNames().isEmpty)
    }

    @Test func h7PurgeBeforeStartStillRemovesAFileFromAnEarlierProcess() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        await withPendingEdit(rig, h)
        await h.touch()
        #expect(stateFileExists(rig))
        let fresh = CloudSyncHost(deps: rig.deps(), options: CloudSyncOptions(catalog: mirror))
        try await fresh.purge()
        #expect(!stateFileExists(rig))
    }

    // H-8. Naive: a listener's touch waits for the pump it runs inside (a deadlock), or starts a second
    // pump (two requests in flight).
    @Test func h8AListenerThatSetsAndFlushesDuringEventDeliveryNeitherHangsNorStartsASecondPump() async throws {
        let rig = HostRig()
        let h = try await rig.host()
        rig.sendDelayMs = 10
        let seen = LockedValue<Int>(0)
        await h.onEvents { _ in
            seen.set(seen.current + 1)
            Task {
                _ = await h.set(VOL, .double(Double(seen.current)))
                await h.flush(maxMs: 1_000)
                await h.touch()
            }
        }
        _ = try await h.signIn(ALICE)
        let done = Task { await h.touch() }
        let finished = await withTaskGroup(of: Bool.self) { g in
            g.addTask {
                await done.value
                return true
            }
            g.addTask {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                return false
            }
            let r = await g.next() ?? false
            g.cancelAll()
            return r
        }
        #expect(finished)
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(rig.maxInFlight == 1)
    }

    // H-9. Naive: flush waits on the pump with no deadline, so a Worker that never answers holds a
    // sign-out or an app exit for the transport's whole timeout.
    @Test func h9FlushIsBoundedEvenWithAPumpStuckOnTheNetwork() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        await withPendingEdit(rig, h)
        rig.sendDelayMs = 5_000
        let start = Date()
        await h.flush(maxMs: 300)
        #expect(Date().timeIntervalSince(start) < 2)
        await h.close()
    }

    // H-9. Naive: a touch that lands as the pump ends is dropped, so the trailing edit waits for the
    // next timer tick (or forever when nothing is pending).
    @Test func h9AnEditThatLandsWhileAPumpRunsIsStillSentByTheSameFlush() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        await withPendingEdit(rig, h)
        rig.sendDelayMs = 100
        let pump = Task { await h.touch() }  // a pump is running
        try await Task.sleep(nanoseconds: 30_000_000)
        _ = await h.set("second.key", .int(2))  // an edit lands mid-pump
        rig.now += 5_000
        await h.flush(maxMs: 3_000)
        await pump.value
        let posts = rig.sent.filter { $0.method == .post }
        let wire = posts.map { String(decoding: (try? JSONEncoder().encode($0.body)) ?? Data(), as: UTF8.self) }
            .joined()
        #expect(posts.count >= 2 || wire.contains("ct"))
        #expect(await h.status()?.pending == 0)
    }

    // close(). Naive: the timer or the ring attachment survives, and the journal is not saved.
    @Test func closeStopsTheTimerDetachesTheRingSavesAndIsIdempotent() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        _ = await h.set(VOL, .double(0.4))  // drafted, armed timer
        await h.close()
        #expect(stateFileExists(rig))  // the debounced edit was committed and saved
        let n = rig.sent.count
        rig.setRoot(false)
        rig.setRoot(true)  // a detached ring does not wake a closed host
        await h.touch()
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(rig.sent.count == n)
        #expect(!(await h.isStarted))
        await h.close()
    }

    // Lifecycle. Naive: no hook, so the edit waits in the debounce window when the app is suspended.
    @Test func aBackgroundOrTerminateNotificationFlushesBoundedAndRemovingTheHookStops() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig)
        let center = NotificationCenter()
        let bg = Notification.Name("test.background")
        let term = Notification.Name("test.terminate")
        await h.installLifecycleHooks(center: center, names: [(bg, false), (term, true)])
        _ = await h.set(VOL, .double(0.8))
        center.post(name: bg, object: nil)
        var seen = false
        for _ in 0..<50 where !seen {
            try await Task.sleep(nanoseconds: 50_000_000)
            seen = rig.sent.contains { $0.method == .post }
        }
        #expect(seen)
        // A blocking notification returns only after the flush (posted off the cooperative pool).
        _ = await h.set(VOL, .double(0.9))
        let before = rig.sent.filter { $0.method == .post }.count
        await Task.detached { center.post(name: term, object: nil) }.value
        #expect(rig.sent.filter { $0.method == .post }.count > before)
        await h.close()
        let after = rig.sent.count
        _ = center
        center.post(name: bg, object: nil)
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(rig.sent.count == after)
    }
}
