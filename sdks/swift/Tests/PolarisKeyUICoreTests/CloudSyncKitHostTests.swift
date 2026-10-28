// @pkey-feature ui.settings
// The Cloud Sync kit host's binding (U-42.3T): status and events drive the row, its buttons open
// the screens, and the screens' outcomes switch back. A fake source stands in for the client.

import PolarisKey
import PolarisKeyCore
import PolarisKeyUICore
import XCTest

private final class Fake: @unchecked Sendable {
    let lock = NSLock()
    var status = SyncStatus(state: .locked, pending: 0, reason: .keyring)
    var probe: SyncUnlockResult = .locked(reason: .noWrap)
    var statusError: Error?
    var flushes = 0
    var recovered: [String] = []
    var accepted: [SyncRingPin] = []
    var newCodes = 0
    var cont: AsyncStream<CloudSyncEvent>.Continuation?

    func set(_ body: () -> Void) {
        lock.lock()
        body()
        lock.unlock()
    }
    func get<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func source() -> CloudSyncSource {
        CloudSyncSource(
            status: { [self] in
                try get {
                    if let e = statusError { throw e }
                    return status
                }
            },
            flush: { [self] in
                get {
                    flushes += 1
                    return status
                }
            },
            probe: { [self] in get { probe } },
            events: { [self] in
                let (stream, c) = AsyncStream<CloudSyncEvent>.makeStream()
                set { cont = c }
                return stream
            },
            screens: CloudSyncScreenHost(
                recover: { [self] code in
                    set {
                        recovered.append(code)
                        status = SyncStatus(state: .idle, pending: 0)
                    }
                },
                reset: { "RESET-CODE" },
                acceptRingChange: { [self] pin in
                    set {
                        accepted.append(pin)
                        status = SyncStatus(state: .idle, pending: 0)
                    }
                    return .unlocked(ringId: pin.ringId, epoch: pin.epoch)
                },
                newRecoveryCode: { [self] in
                    set { newCodes += 1 }
                    return "NEW-CODE"
                }))
    }
}

@MainActor
final class CloudSyncKitHostTests: XCTestCase {
    private let ring = SyncRingPin(ringId: "ring_b", epoch: 2, rootKid: "aa")

    private func wait(_ host: CloudSyncKitHostModel, _ ok: @MainActor () -> Bool) async {
        for _ in 0..<200 where !ok() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    func testEachSyncStateDrawsItsRow() async {
        let fake = Fake()
        let host = CloudSyncKitHostModel(source: fake.source())
        let cases: [(SyncStatus, CloudSyncStatusState?, String?)] = [
            (SyncStatus(state: .local, pending: 0), nil, nil),
            (SyncStatus(state: .idle, pending: 0), .synced, nil),
            (SyncStatus(state: .syncing, pending: 2), .syncing, nil),
            (SyncStatus(state: .offline, pending: 1), .offline, nil),
            (SyncStatus(state: .locked, pending: 0, reason: .keyring), .locked, "cloudSync.locked"),
            (
                SyncStatus(state: .blocked, pending: 0, reason: .accountRequired), .error,
                "cloudSync.signedOut"
            ),
            (SyncStatus(state: .blocked, pending: 0, reason: .quota), .error, "cloudSync.error"),
        ]
        for (status, state, key) in cases {
            fake.set { fake.status = status }
            await host.refresh()
            XCTAssertEqual(host.status?.screen.state, state, "\(status.state)")
            if let key { XCTAssertEqual(host.status?.screen.copy.first?.key, key) }
        }
    }

    func testLockedWithAChangedRingBecomesRingChangedAndReviewShowsThatRing() async {
        let fake = Fake()
        fake.set { fake.probe = .ringChanged(pinned: ring, served: ring, createdAt: 1, by: "Mac") }
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.refresh()
        XCTAssertEqual(host.status?.screen.state, .ringChanged)
        host.status?.onReview()
        XCTAssertEqual(host.screen, .ringChange)
        XCTAssertEqual(host.ringModel?.inputs.ringChange?.served?.ringId, "ring_b")
        XCTAssertEqual(host.ringModel?.inputs.ringChange?.by, "Mac")
    }

    func testUnlockOpensUnlockSyncAndOnUnlockedSwitchesBack() async {
        let fake = Fake()
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.refresh()
        XCTAssertEqual(host.status?.screen.state, .locked)
        host.status?.onUnlock()
        XCTAssertEqual(host.screen, .unlock)
        host.unlockModel?.code = "CODE"
        await host.unlockModel?.unlock()
        await wait(host) { host.screen == nil && host.status?.screen.state == .synced }
        XCTAssertNil(host.screen)
        XCTAssertNil(host.unlockModel, "the model, and its code, are dropped")
        XCTAssertEqual(host.status?.screen.state, .synced)
        XCTAssertEqual(fake.get { fake.recovered }, ["CODE"])
        XCTAssertGreaterThan(fake.get { fake.flushes }, 0)
    }

    func testAcceptingTheShownRingHandsTheHostThatRingAndSwitchesBack() async {
        let fake = Fake()
        fake.set { fake.probe = .ringChanged(pinned: ring, served: ring, createdAt: 1, by: nil) }
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.refresh()
        host.status?.onReview()
        await host.ringModel?.accept()
        await wait(host) { host.screen == nil && host.status?.screen.state == .synced }
        XCTAssertEqual(fake.get { fake.accepted }, [ring])
        XCTAssertNil(host.screen)
        XCTAssertEqual(host.status?.screen.state, .synced)
    }

    func testRingChangeCanFallBackToTheRecoveryCode() async {
        let fake = Fake()
        fake.set { fake.probe = .ringChanged(pinned: ring, served: ring, createdAt: 1, by: nil) }
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.refresh()
        host.status?.onReview()
        host.ringModel?.useRecoveryCode()
        XCTAssertEqual(host.screen, .unlock)
    }

    func testStartOverShowsTheNewCodeOnceThenDoneLeavesAndClearsIt() async {
        let fake = Fake()
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.refresh()
        host.openUnlock()
        host.unlockModel?.askStartOver()
        for _ in 0..<200 where host.unlockModel?.startOverArmed != true {
            try? await Task.sleep(for: .milliseconds(10))
        }
        await host.unlockModel?.confirmStartOver()
        XCTAssertEqual(host.screen, .recoveryCode)
        XCTAssertEqual(host.recoveryModel?.code, "RESET-CODE")
        host.dismiss()
        XCTAssertEqual(host.screen, .recoveryCode, "an unsaved new code is not dismissed")
        host.recoveryModel?.setSaved(true)
        host.recoveryModel?.done()
        XCTAssertNil(host.screen)
        XCTAssertNil(host.recoveryModel)
    }

    func testNewRecoveryCodeGoesThroughTheClientEntryAndShowsOnce() async {
        let fake = Fake()
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.requestNewRecoveryCode()
        XCTAssertEqual(host.screen, .recoveryCode)
        XCTAssertEqual(host.recoveryModel?.code, "NEW-CODE")
        XCTAssertEqual(fake.get { fake.newCodes }, 1)
        XCTAssertFalse(host.newCodeFailed)
    }

    func testEventsMoveTheRow() async {
        let fake = Fake()
        fake.set { fake.status = SyncStatus(state: .idle, pending: 0) }
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.start()
        XCTAssertEqual(host.status?.screen.state, .synced)
        // A sign-out is not a fault: neutral copy, and Sign in only when the host app supplies it.
        fake.get { fake.cont }?.yield(.signedOut(reason: .accountRequired, unsynced: 0))
        await wait(host) { host.status?.screen.state == .error }
        XCTAssertEqual(host.status?.screen.copy.first?.key, "cloudSync.signedOut")
        XCTAssertNil(host.status?.onSignIn)
        // A change event redraws from the machine.
        fake.set { fake.status = SyncStatus(state: .syncing, pending: 1) }
        fake.get { fake.cont }?.yield(.change(keys: ["a"], origin: .local))
        await wait(host) { host.status?.screen.state == .syncing }
        XCTAssertEqual(host.status?.screen.state, .syncing)
        host.stop()
    }

    func testAnOffServiceShowsNoRow() async {
        let fake = Fake()
        fake.set { fake.statusError = PolarisError(code: "product", message: "n/a") }
        let host = CloudSyncKitHostModel(source: fake.source())
        await host.refresh()
        XCTAssertNil(host.status)
    }
}
