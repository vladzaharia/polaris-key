// @pkey-feature ui.settings
// The Cloud Sync models (U-42.3): what the matrix rows cannot say alone. A fake host stands in for
// the keyring; nothing here touches a network or a real root.

import PolarisKey
import PolarisKeyCore
import PolarisKeyUICore
import XCTest

private actor Calls {
    var recovered: [String] = []
    var accepted: [SyncRingPin] = []
    var resets = 0
    func recover(_ code: String) { recovered.append(code) }
    func accept(_ pin: SyncRingPin) { accepted.append(pin) }
    func reset() { resets += 1 }
}

@MainActor
final class CloudSyncModelTests: XCTestCase {
    private func host(
        _ calls: Calls, recover: @escaping @Sendable (String) async throws -> Void = { _ in },
        accept: @escaping @Sendable (SyncRingPin) async throws -> SyncUnlockResult = { _ in
            .unlocked(ringId: "ring_a", epoch: 1)
        }
    ) -> CloudSyncHost {
        CloudSyncHost(
            recover: { try await recover($0); await calls.recover($0) },
            reset: { await calls.reset(); return "NEW-CODE" },
            acceptRingChange: { await calls.accept($0); return try await accept($0) },
            newRecoveryCode: { "FRESH-CODE" })
    }

    func testAWrongCodeIsInvalidAndARightOneUnlocks() async {
        let calls = Calls()
        let bad = PolarisError(code: ErrorCode.recoveryCodeInvalid, message: "no")
        let model = UnlockSyncModel(
            host: host(calls, recover: { if $0 == "BAD" { throw bad } }))
        var unlocked = 0
        model.onUnlocked = { unlocked += 1 }
        model.code = "BAD"
        await model.unlock()
        XCTAssertEqual(model.screen.state, .invalid)
        model.codeEdited()
        XCTAssertEqual(model.screen.state, .code, "the error clears on edit")
        await model.unlock()
        XCTAssertEqual(unlocked, 0)
        model.code = "GOOD"
        await model.unlock()
        XCTAssertEqual(model.screen.state, .working, "stays until the host swaps the screen")
        XCTAssertEqual(unlocked, 1)
        XCTAssertEqual(model.code, "", "the code leaves the model once used")
    }

    func testAnEmptyCodeNeverReachesTheHost() async {
        let calls = Calls()
        let model = UnlockSyncModel(host: host(calls))
        await model.unlock()
        XCTAssertEqual(model.screen.state, .code, "nothing was checked, so no error")
        let recovered = await calls.recovered
        XCTAssertTrue(recovered.isEmpty)
    }

    func testARequestFailureIsFailedNotInvalid() async {
        let calls = Calls()
        let model = UnlockSyncModel(
            host: host(calls, recover: { _ in throw PolarisError(code: "network", message: "x") }))
        model.code = "CODE"
        await model.unlock()
        XCTAssertEqual(model.screen.state, .failed)
        await model.retry()
        XCTAssertEqual(model.screen.state, .code)
    }

    func testStartOverRunsOnlyFromItsWarning() async {
        let calls = Calls()
        let model = UnlockSyncModel(host: host(calls), armDelay: .milliseconds(5))
        await model.confirmStartOver()
        var resets = await calls.resets
        XCTAssertEqual(resets, 0, "no warning shown, nothing replaced")
        model.askStartOver()
        XCTAssertEqual(model.screen.state, .startOver)
        model.cancel()
        XCTAssertEqual(model.screen.state, .code)
        model.askStartOver()
        await model.confirmStartOver()
        resets = await calls.resets
        XCTAssertEqual(resets, 0, "a tap right after the warning appears does not reset")
        try? await Task.sleep(for: .milliseconds(30))
        var shown: String?
        model.onStartedOver = { shown = $0 }
        await model.confirmStartOver()
        resets = await calls.resets
        XCTAssertEqual(resets, 1)
        XCTAssertEqual(shown, "NEW-CODE")
    }

    func testTheRecoveryCodeIsNeverInTheInputsAndDoneWaitsForSaved() {
        let model = RecoveryCodeModel()
        model.show(code: "SECRET-CODE")
        XCTAssertEqual(model.screen.state, .show)
        XCTAssertFalse(model.screen.shows("common.done"))
        let encoded = String(data: try! JSONEncoder().encode(model.inputs), encoding: .utf8)!
        XCTAssertFalse(encoded.contains("SECRET-CODE"))
        XCTAssertFalse("\(model)".contains("SECRET-CODE"))
        var done = 0
        model.onDone = { done += 1 }
        model.done()
        XCTAssertEqual(done, 0)
        model.setSaved(true)
        XCTAssertTrue(model.screen.shows("common.done"))
        model.done()
        XCTAssertEqual(done, 1)
        XCTAssertNil(model.code, "the code leaves memory on Done")
    }

    func testAcceptHandsOverTheRingThatWasShown() async {
        let calls = Calls()
        let shown = SyncRingPin(ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c")
        let model = RingChangeModel(by: "Maya's MacBook", served: shown, host: host(calls))
        var accepted = 0
        model.onAccepted = { accepted += 1 }
        await model.accept()
        let pins = await calls.accepted
        XCTAssertEqual(pins, [shown])
        XCTAssertEqual(accepted, 1)
    }

    func testARingThatMovedIsShownAgainNotAdopted() async {
        let calls = Calls()
        let shown = SyncRingPin(ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c")
        let moved = SyncRingPin(ringId: "ring_zzzz", epoch: 3, rootKid: "kid_0000")
        let model = RingChangeModel(
            by: nil, served: shown,
            host: host(
                calls,
                accept: { _ in
                    .ringChanged(pinned: shown, served: moved, createdAt: 0, by: "Other device")
                }))
        var accepted = 0
        model.onAccepted = { accepted += 1 }
        await model.accept()
        XCTAssertEqual(accepted, 0)
        XCTAssertEqual(model.inputs.ringChange?.served?.ringId, "ring_zzzz")
        XCTAssertEqual(model.inputs.ringChange?.by, "Other device")
    }

    func testNothingServedMeansNothingToAccept() async {
        let calls = Calls()
        let model = RingChangeModel(by: "Maya's MacBook", served: nil, host: host(calls))
        XCTAssertFalse(model.screen.shows("ringChange.accept"))
        await model.accept()
        let pins = await calls.accepted
        XCTAssertTrue(pins.isEmpty)
    }

    func testTheStatusNeverOffersUnlockOnARingChange() {
        let model = CloudSyncStatusModel(.ringChanged, onUnlock: {}, onReview: {})
        XCTAssertFalse(model.screen.offers(.unlock))
        model.show(.locked)
        XCTAssertTrue(model.screen.offers(.unlock))
        XCTAssertFalse(model.screen.shows("cloudSync.synced"))
    }

    func testNoRecoveryCodeOffersStartOverAndCancelReturnsThere() async {
        let calls = Calls()
        let model = UnlockSyncModel(
            host: host(calls, recover: { _ in throw PolarisError(code: ErrorCode.notFound, message: "x") }))
        model.code = "CODE"
        await model.unlock()
        XCTAssertEqual(model.screen.state, .noCode)
        XCTAssertTrue(model.screen.offers(.startOver))
        XCTAssertFalse(model.screen.shows("unlockSync.field"))
        model.askStartOver()
        XCTAssertEqual(model.screen.state, .startOver)
        model.cancel()
        XCTAssertEqual(model.screen.state, .noCode)
    }

    func testAFailedAcceptSaysSoAndCanBeRetried() async {
        let calls = Calls()
        let shown = SyncRingPin(ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c")
        let model = RingChangeModel(
            by: nil, served: shown,
            host: host(calls, accept: { _ in throw PolarisError(code: "network", message: "x") }))
        await model.accept()
        XCTAssertEqual(model.screen.state, .failed)
        XCTAssertTrue(model.screen.shows("ringChange.failed"))
        XCTAssertTrue(model.screen.offers(.acceptRingChange))
    }

    func testARecoveryScreenWithNoCodeDrawsNothing() {
        XCTAssertTrue(RecoveryCodeModel().screen.isHidden)
    }

    func testAStartOverInFlightCannotBeCancelledAndKeepsItsCode() async {
        let gate = AsyncStream<Void>.makeStream()
        let slow = CloudSyncHost(
            recover: { _ in }, reset: {
                for await _ in gate.stream { break }
                return "MINTED"
            }, acceptRingChange: { _ in .locked(reason: .noRing) }, newRecoveryCode: { "X" })
        let model = UnlockSyncModel(host: slow, armDelay: .milliseconds(5))
        var shown: String?
        model.onStartedOver = { shown = $0 }
        model.askStartOver()
        try? await Task.sleep(for: .milliseconds(30))
        let running = Task { await model.confirmStartOver() }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(model.minting)
        var cancelled = 0
        model.onCancel = { cancelled += 1 }
        model.cancel()
        running.cancel()
        gate.continuation.yield()
        await running.value
        XCTAssertEqual(cancelled, 0, "Cancel is ignored while the new key is being made")
        XCTAssertEqual(shown, "MINTED", "the new code reaches the screen")
        XCTAssertFalse(model.minting)
    }

    func testAFreshCodeSurvivesClearWhileItIsBeingMade() async {
        let gate = AsyncStream<Void>.makeStream()
        let slow = CloudSyncHost(
            recover: { _ in }, reset: { nil }, acceptRingChange: { _ in .locked(reason: .noRing) },
            newRecoveryCode: {
                for await _ in gate.stream { break }
                return "FRESH"
            })
        let model = RecoveryCodeModel(host: slow)
        let making = Task { try? await model.generate() }
        try? await Task.sleep(for: .milliseconds(30))
        model.clear()
        gate.continuation.yield()
        await making.value
        XCTAssertEqual(model.code, "FRESH")
    }

    func testAFailedStartOverIsNotAnUnlockFailureAndRetriesItself() async {
        let calls = Calls()
        let attempts = Attempts()
        let flaky = CloudSyncHost(
            recover: { _ in }, reset: {
                if await attempts.next() == 1 { throw PolarisError(code: "network", message: "x") }
                return "MINTED"
            }, acceptRingChange: { _ in .locked(reason: .noRing) }, newRecoveryCode: { "X" })
        _ = calls
        let model = UnlockSyncModel(host: flaky, armDelay: .milliseconds(5))
        var shown: String?
        model.onStartedOver = { shown = $0 }
        model.askStartOver()
        try? await Task.sleep(for: .milliseconds(30))
        await model.confirmStartOver()
        XCTAssertEqual(model.screen.state, .startOverFailed)
        await model.retry()
        XCTAssertEqual(shown, "MINTED")
    }
}

private actor Attempts {
    var n = 0
    func next() -> Int { n += 1; return n }
}
