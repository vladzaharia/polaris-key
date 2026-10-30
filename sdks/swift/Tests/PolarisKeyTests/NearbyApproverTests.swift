// @pkey-feature identity.nearby
// CC-15.S2: the approver (M) of nearby approval (WIRE-CONTRACT-V5 §15.4, §15.6.1), driven by the real engine
// of a bare device D over in-memory pipes and a fake advert network. Mirrors sdk-node's
// `nearbyApprover.test.ts`, with the fixed semantics of its fix round: B1 (final stops), B2b (a synchronous
// stop), B3 (a failed renewal halts), N2 (the label compared as cleaned), N4 to N6, N10.

import Foundation
import PolarisKeyPlatform
import XCTest

@testable import PolarisKeyCore

private let now0 = 1_800_000_000

private final class Rig: @unchecked Sendable {
    let net = FakeApproverNet()
    let timers = ManualTimers()
    let signedIn = NBox(true)
    let served = NBox(true)
    /// Set to make a host read never return.
    let hangSignedIn = NBox(false)
    let approvals = NBox<[NearbyApproval]>([])
    let notices = NBox<[ApprovalNotice]>([])
    let stopped = NBox<[NearbyStopReason]>([])
    let mono = NBox<TimeInterval>(0)
    var approver: NearbyApprover!

    func start(
        prompt: Bool = true, background: Bool = false, label: String? = "Ana's Mac", maxSessions: Int = 8
    ) async throws {
        let signed = signedIn
        let hang = hangSignedIn
        let served = served
        let src = NearbyApproverSource(
            slug: nearbySlug, now: { now0 },
            signedIn: {
                while hang.value { try? await Task.sleep(nanoseconds: 20_000_000) }
                return signed.value
            }, nearbyServed: { served.value })
        let approvals = approvals
        let notices = notices
        let stopped = stopped
        let o = NearbyApproverOptions(
            prompt: prompt, background: background, label: label, platform: "macos",
            onNotice: { n in notices.mutate { $0.append(n) } }, onStopped: { r in stopped.mutate { $0.append(r) } },
            renewSeconds: 100, keepOpenSeconds: 300, requestWaitSeconds: 30, maxSessions: maxSessions,
            timer: timers.timer, mono: { [mono] in mono.value })
        approver = try await NearbyApprover.start(
            source: src, handler: { a in approvals.mutate { $0.append(a) } }, options: o, network: net)
    }

    var status: NearbyApproverStatus { approver.status() }

    /// A D with its HELLO exchanged (code held, or started and shown).
    func dial(label: String? = "Ben's Switch", hold: Bool = true, startSas: Bool = false) async throws -> RawD {
        let (c, _) = net.connect()
        let d = try await RawD.over(c, label: label, hold: hold)
        await nearbyUntil("hello") { d.hello != nil }
        if startSas {
            await d.startSas()
            await nearbyUntil("code") { d.code != nil }
        }
        return d
    }

    /// A D that has its code and an approval prompt waiting.
    func prompted(label: String? = "Ben's Switch") async throws -> (RawD, NearbyApproval) {
        let before = approvals.value.count
        let d = try await dial(label: label, startSas: true)
        await nearbyUntil("prompt") { self.approvals.value.count > before }
        return (d, approvals.value[before])
    }

    func shown(_ d: RawD) -> String { PeerSAS.display(d.code!) }
}

final class NearbyApproverTests: XCTestCase {
    // MARK: The advert

    func testAdvertisesARandomInstanceWithTheProductTag() async throws {
        let r = Rig()
        try await r.start()
        let h = try XCTUnwrap(r.net.live.first)
        XCTAssertTrue(PeerAdvert.isInstanceName(h.instance))
        let tag = try PeerAdvert.productTag(slug: nearbySlug, epoch: peerAdvertEpoch(now0))
        XCTAssertEqual(h.txt, ["v=1", "m=v", "h=\(tag)"])
        XCTAssertEqual(r.status, NearbyApproverStatus(state: .advertising, reason: nil, prompt: true))
        XCTAssertEqual(r.timers.armed(100), 1)
        await r.approver.stop()
    }

    func testRenewsWithANewInstanceAndPortAndTheOldListenerStops() async throws {
        let r = Rig()
        try await r.start()
        let first = r.net.handles.value[0]
        r.timers.fire(100)
        await nearbyUntil("second advert") { r.net.handles.value.count == 2 }
        let second = r.net.handles.value[1]
        XCTAssertNotEqual(first.instance, second.instance)
        XCTAssertNotEqual(first.port, second.port)
        await nearbyUntil("old stopped") { first.stopped }
        XCTAssertFalse(second.stopped)
        await nearbyUntil("re-armed") { r.timers.armed(100) == 1 }
        await r.approver.stop()
    }

    func testASessionPastTheTransportSurvivesARenewal() async throws {
        let r = Rig()
        try await r.start()
        let d = try await r.dial()
        r.timers.fire(100)
        await nearbyUntil("renewed") { r.net.handles.value.count == 2 }
        await nearbySettle()
        XCTAssertNil(d.closed)
        await d.startSas()
        await nearbyUntil("code") { d.code != nil }
        await r.approver.stop()
    }

    func testStopsAtARenewalWhenSignedOutOrDiscoveryLostNearby() async throws {
        let r = Rig()
        try await r.start()
        r.signedIn.value = false
        r.timers.fire(100)
        await nearbyUntil("signed out") { r.status.state == .stopped }
        XCTAssertEqual(r.status.reason, .signedOut)
        XCTAssertEqual(r.stopped.value, [.signedOut])
        XCTAssertTrue(r.net.live.isEmpty)

        let q = Rig()
        try await q.start()
        q.served.value = false
        q.timers.fire(100)
        await nearbyUntil("discovery") { q.status.state == .stopped }
        XCTAssertEqual(q.status.reason, .discovery)
        XCTAssertEqual(q.stopped.value, [.discovery])
    }

    func testPauseTakesTheAdvertDownAndClosesSessionsAndResumeStartsANewOne() async throws {
        let r = Rig()
        try await r.start()
        let d = try await r.dial()
        await r.approver.pause()
        XCTAssertEqual(r.status.state, .paused)
        XCTAssertTrue(r.net.live.isEmpty)
        await nearbyUntil("D closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_bye")
        XCTAssertEqual(r.stopped.value, [], "the host's own pause needs no word back")
        try await r.approver.resume()
        XCTAssertEqual(r.status.state, .advertising)
        XCTAssertEqual(r.net.live.count, 1)
        XCTAssertNotEqual(r.net.handles.value[0].instance, r.net.handles.value[1].instance)
        await r.approver.stop()
    }

    // MARK: Holding and the prompt

    func testShowsNothingUntilDsPersonChoseAndThenThreeDistinctCodes() async throws {
        let r = Rig()
        try await r.start()
        let d = try await r.dial(label: "Ben's Switch")
        await nearbySettle()
        XCTAssertTrue(r.approvals.value.isEmpty, "a session held at HELLO raises no prompt")
        await d.startSas()
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        let a = r.approvals.value[0]
        XCTAssertEqual(a.codes.count, 3)
        XCTAssertEqual(Set(a.codes).count, 3)
        XCTAssertTrue(a.codes.contains(r.shown(d)))
        XCTAssertEqual(a.label, "Ben's Switch")
        XCTAssertEqual(a.platform, "macos")
        await r.approver.stop()
    }

    func testWithThePromptClosedASessionRaisesANoticeAndTakesNoPick() async throws {
        let r = Rig()
        try await r.start(prompt: false, background: true)
        _ = try await r.dial(startSas: true)
        await nearbyUntil("notice") { r.notices.value.count == 1 }
        XCTAssertEqual(r.notices.value[0], ApprovalNotice(label: "Ben's Switch", platform: "macos"))
        XCTAssertTrue(r.approvals.value.isEmpty)
        try await r.approver.setPrompt(true)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        await r.approver.stop()
    }

    func testShowsOnePromptAtATimeAndTheNextShowsWhenTheFirstEnds() async throws {
        let r = Rig()
        try await r.start()
        let (d1, a1) = try await r.prompted()
        let d2 = try await r.dial(startSas: true)
        await nearbySettle()
        XCTAssertEqual(r.approvals.value.count, 1, "the second waits with no code shown")
        await a1.decline()
        await nearbyUntil("D1 closed") { d1.closed != nil }
        await nearbyUntil("second prompt") { r.approvals.value.count == 2 }
        XCTAssertTrue(r.approvals.value[1].codes.contains(r.shown(d2)))
        await r.approver.stop()
    }

    // MARK: The pick

    func testTheRightCodeDeliversAVerifiedRequestWithExactlyDsKeys() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        let keys = try await d.keys.ensure()
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        let got = try await picked
        guard case .request(let req) = got else { return XCTFail("\(got)") }
        XCTAssertEqual(req.request, nearbyRequestHandle)
        XCTAssertEqual(req.deviceId, nearbyDeviceId)
        XCTAssertEqual(req.signKey, keys.signKey)
        XCTAssertEqual(req.agreeKey, keys.agreeKey)
        XCTAssertEqual(req.label, "Ben's Switch")
        XCTAssertEqual(req.platform, "macos")
        await r.approver.stop()
    }

    func testAWrongPickClosesPeerByeDeliversNoRequestAndRefusesFinish() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        try await d.showAndRequest()
        let decoy = a.codes.first { $0 != r.shown(d) }!
        let got = try await a.pick(decoy)
        XCTAssertEqual(got, .mismatch)
        await nearbyUntil("D closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_bye")
        XCTAssertTrue(d.closed?.byPeer ?? false)
        do {
            _ = try await a.finish(
                VouchApproveAnswer(http: 200, body: #"{"status":"approved"}"#, discoveryNearby: true))
            XCTFail("finished")
        } catch { XCTAssertTrue(error is NearbyError) }
        await r.approver.stop()
    }

    func testFinishBeforeAPickIsRefused() async throws {
        let r = Rig()
        try await r.start()
        let (_, a) = try await r.prompted()
        do {
            _ = try await a.finish(
                VouchApproveAnswer(http: 200, body: #"{"status":"approved"}"#, discoveryNearby: true))
            XCTFail("finished")
        } catch { XCTAssertEqual(error as? NearbyError, .notPicked) }
        await r.approver.stop()
    }

    func testARequestThatDoesNotVerifyClosesBadFrameAndAnswersInvalid() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        async let picked = a.pick(r.shown(d))
        // D sends a label that is not the one its HELLO showed.
        try await d.showAndRequest(label: .some("Mallory"))
        let got = try await picked
        XCTAssertEqual(got, .invalid)
        await nearbyUntil("D closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_bad_frame")
        await r.approver.stop()
    }

    func testDeclineClosesPeerByeWithNoRequestDelivered() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        try await d.showAndRequest()
        await a.decline()
        await nearbyUntil("D closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_bye")
        do {
            _ = try await a.pick(r.shown(d))
            XCTFail("picked")
        } catch { XCTAssertTrue(error is NearbyError) }
        await r.approver.stop()
    }

    // MARK: finish

    func testApprovedReachesDAndThenASyncRecordIsCarried() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        let keys = try await d.keys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        guard case .request(let req) = try await picked else { return XCTFail("no request") }
        let out = try await a.finish(worker.answer(req))
        XCTAssertEqual(out, .sent(.approved))
        await nearbyUntil("result") { d.records.count == 1 }
        XCTAssertEqual(d.records[0].type, PeerRecordType.vouchResult)
        XCTAssertEqual(PeerVouch.parseResult(d.records[0].body), .status(.approved))
        try await a.sendRecord(type: PeerRecordType.keyringWrap, body: Data("wrap".utf8))
        await nearbyUntil("wrap") { d.records.count == 2 }
        XCTAssertEqual(d.records[1].type, PeerRecordType.keyringWrap)
        // Only 0x0030 to 0x003F go this way.
        do {
            try await a.sendRecord(type: PeerRecordType.ping, body: Data(count: 8))
            XCTFail("sent")
        } catch { XCTAssertEqual(error as? NearbyError, .badType) }
        await r.approver.stop()
    }

    func testAWorkerThatDoesNotMatchDsKeysAnswers404AndD_Hears_Expired() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        // The Worker saw other keys on `start`.
        let other = try DeviceKeyStore.inMemory()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: try await other.ensure())
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        guard case .request(let req) = try await picked else { return XCTFail("no request") }
        let out = try await a.finish(worker.answer(req))
        XCTAssertEqual(out, .sent(.expired))
        await nearbyUntil("result") { d.records.count == 1 }
        XCTAssertEqual(PeerVouch.parseResult(d.records[0].body), .status(.expired))
        await nearbyUntil("closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_bye")
        await r.approver.stop()
    }

    func testA404AfterDiscoveryLostNearbySendsNothingClosesAndStopsTheAdvert() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        _ = try await picked
        let out = try await a.finish(VouchApproveAnswer(http: 404, body: nil, discoveryNearby: false))
        XCTAssertEqual(out, .closed)
        await nearbyUntil("closed") { d.closed != nil }
        XCTAssertTrue(d.records.isEmpty)
        await nearbyUntil("stopped") { r.status.state == .stopped }
        XCTAssertEqual(r.status.reason, .discovery)
        XCTAssertEqual(r.stopped.value, [.discovery])
    }

    func testKeysRequiredWaitsOnceAndASecondOneCloses() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        _ = try await picked
        let keys = VouchApproveAnswer(http: 409, body: #"{"code":"device_keys_required"}"#, discoveryNearby: true)
        let first = try await a.finish(keys)
        XCTAssertEqual(first, .waitKeys)
        let second = try await a.finish(keys)
        XCTAssertEqual(second, .closed)
        await r.approver.stop()
    }

    func testChooseWaitsForTheLicenceChoiceAsOftenAsItIsAsked() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        _ = try await picked
        for _ in 0..<3 {
            let out = try await a.finish(
                VouchApproveAnswer(http: 200, body: #"{"status":"choose"}"#, discoveryNearby: true))
            XCTAssertEqual(out, .waitChoice)
        }
        await r.approver.stop()
    }

    func testTheSessionClosesThreeHundredSecondsAfterThePick() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        _ = try await picked
        r.timers.fire(300)
        await nearbyUntil("closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_bye")
        await r.approver.stop()
    }

    func testARequestThatNeverComesEndsThePickWithTheThirtySecondWait() async throws {
        let r = Rig()
        try await r.start()
        let (d, a) = try await r.prompted()
        async let picked = a.pick(r.shown(d))
        await nearbyUntil("wait armed") { r.timers.armed(30) == 1 }
        r.timers.fire(30)
        let got = try await picked
        XCTAssertEqual(got, .invalid)
        await nearbyUntil("closed") { d.closed != nil }
        XCTAssertEqual(d.closed?.code, "peer_timeout")
        await r.approver.stop()
    }

    // MARK: The failure budget

    func testStopsTheAdvertAtTheSecondPromptedFailureAndStartsAgainOnReopen() async throws {
        let r = Rig()
        try await r.start()
        for _ in 0..<2 {
            let (d, a) = try await r.prompted()
            try await d.showAndRequest()
            let decoy = a.codes.first { $0 != r.shown(d) }!
            _ = try await a.pick(decoy)
        }
        await nearbyUntil("budget stop") { r.status.state == .stopped }
        XCTAssertEqual(r.status.reason, .budget)
        XCTAssertEqual(r.stopped.value, [.budget])
        XCTAssertTrue(r.net.live.isEmpty)
        try await r.approver.reopen()
        XCTAssertEqual(r.status.state, .advertising)
        XCTAssertEqual(r.net.live.count, 1)
        await r.approver.stop()
    }

    func testAPeerThatClosesAfterThePromptShowedCountsAndBeforeAnyPromptDoesNot() async throws {
        let r = Rig()
        try await r.start()
        // Before any prompt: two held sessions that close are free.
        for _ in 0..<2 {
            let d = try await r.dial()
            await d.link.close(.peerBye)
            await nearbySettle(40)
        }
        XCTAssertEqual(r.status.state, .advertising)
        // After the prompt showed, before the answer: two of them stop the advert.
        for _ in 0..<2 {
            let (d, _) = try await r.prompted()
            await d.link.close(.peerBye)
            await nearbySettle(40)
        }
        await nearbyUntil("budget stop") { r.status.state == .stopped }
        XCTAssertEqual(r.status.reason, .budget)
    }

    func testTheHostsOwnCloseOfAShownPromptCountsForNothing() async throws {
        let r = Rig()
        try await r.start()
        for _ in 0..<2 {
            let (_, a) = try await r.prompted()
            await a.close()
            await nearbySettle(40)
        }
        XCTAssertEqual(r.status.state, .advertising)
        await r.approver.stop()
    }

    // MARK: B1: a stopped advert stays stopped

    func testPauseAndResumeDoNotReviveABudgetStopOrOverwriteItsReason() async throws {
        let r = Rig()
        try await r.start()
        for _ in 0..<2 {
            let (d, a) = try await r.prompted()
            try await d.showAndRequest()
            _ = try await a.pick(a.codes.first { $0 != r.shown(d) }!)
        }
        await nearbyUntil("budget stop") { r.status.state == .stopped }
        await r.approver.pause()
        XCTAssertEqual(r.status, NearbyApproverStatus(state: .stopped, reason: .budget, prompt: true))
        try await r.approver.resume()
        XCTAssertEqual(r.status, NearbyApproverStatus(state: .stopped, reason: .budget, prompt: true))
        XCTAssertTrue(r.net.live.isEmpty)
        // The screen opening again clears it.
        try await r.approver.setPrompt(false)
        try await r.approver.setPrompt(true)
        XCTAssertEqual(r.status.state, .advertising)
        await r.approver.stop()
    }

    func testASignOutStopIsFinalPauseResumeReopenAndSetPromptReviveNothing() async throws {
        let r = Rig()
        try await r.start()
        r.signedIn.value = false
        r.timers.fire(100)
        await nearbyUntil("signed out") { r.status.state == .stopped }
        r.signedIn.value = true
        await r.approver.pause()
        try await r.approver.resume()
        try await r.approver.reopen()
        try await r.approver.setPrompt(false)
        try await r.approver.setPrompt(true)
        XCTAssertEqual(r.status.state, .stopped)
        XCTAssertEqual(r.status.reason, .signedOut)
        XCTAssertTrue(r.net.live.isEmpty)
    }

    func testStopIsFinal() async throws {
        let r = Rig()
        try await r.start()
        await r.approver.stop()
        XCTAssertEqual(r.status.state, .stopped)
        XCTAssertEqual(r.status.reason, .host)
        try await r.approver.resume()
        try await r.approver.reopen()
        try await r.approver.setPrompt(false)
        try await r.approver.setPrompt(true)
        XCTAssertEqual(r.status.state, .stopped)
        XCTAssertTrue(r.net.live.isEmpty)
        XCTAssertEqual(r.net.handles.value.count, 1)
    }

    func testPauseWorksFromAdvertisingOnlyAndResumeOnlyFromTheHostsOwnPause() async throws {
        let r = Rig()
        try await r.start()
        try await r.approver.resume()
        XCTAssertEqual(r.net.handles.value.count, 1, "resume without a pause starts nothing")
        await r.approver.pause()
        await r.approver.pause()
        XCTAssertEqual(r.status.reason, .host)
        try await r.approver.resume()
        XCTAssertEqual(r.net.live.count, 1)
        await r.approver.stop()
    }

    func testResumeReadsSignedInAndDiscoveryAgain() async throws {
        let r = Rig()
        try await r.start()
        await r.approver.pause()
        r.signedIn.value = false
        try await r.approver.resume()
        XCTAssertEqual(r.status.state, .stopped)
        XCTAssertEqual(r.status.reason, .signedOut)
        XCTAssertEqual(r.stopped.value, [.signedOut])

        let q = Rig()
        try await q.start()
        await q.approver.pause()
        q.served.value = false
        try await q.approver.resume()
        XCTAssertEqual(q.status.reason, .discovery)
    }

    // MARK: B2, B3: stopping and renewing

    func testStopDoesNotWaitBehindARenewalWhoseSignInCheckHangs() async throws {
        let r = Rig()
        try await r.start()
        let d = try await r.dial()
        r.hangSignedIn.value = true
        r.timers.fire(100)
        await nearbySettle(60)
        let done = NBox(false)
        Task {
            await r.approver.stop()
            done.value = true
        }
        await nearbyUntil("stop returned", seconds: 3) { done.value }
        XCTAssertEqual(r.status.state, .stopped)
        XCTAssertTrue(r.net.live.isEmpty)
        await nearbyUntil("D closed") { d.closed != nil }
        // The renewal that was hanging brings nothing back.
        r.hangSignedIn.value = false
        await nearbySettle()
        XCTAssertEqual(r.status.state, .stopped)
        XCTAssertTrue(r.net.live.isEmpty)
        XCTAssertEqual(r.net.handles.value.count, 1)
    }

    func testARenewalThatFailsStopsTheAdvertWithOnStoppedAndRearmsNothing() async throws {
        let r = Rig()
        try await r.start()
        r.net.failNext.value = .unavailable
        r.timers.fire(100)
        await nearbyUntil("halted") { r.status.state == .stopped }
        XCTAssertEqual(r.status.reason, .discovery)
        XCTAssertEqual(r.stopped.value, [.discovery])
        XCTAssertEqual(r.timers.armed(100), 0)
        XCTAssertTrue(r.net.live.isEmpty)
    }

    func testARenewalWhoseSignInCheckHangsIsBoundedAndCountsAsSignedOut() async throws {
        let r = Rig()
        try await r.start()
        r.hangSignedIn.value = true
        r.timers.fire(100)
        await nearbyUntil("bound armed") { r.timers.armed(15) == 1 }
        r.timers.fire(15)
        await nearbyUntil("signed out") { r.status.state == .stopped }
        XCTAssertEqual(r.status.reason, .signedOut)
        r.hangSignedIn.value = false
    }

    func testDestroyDropsTheAdvertAndTheSocketsAtOnce() async throws {
        let r = Rig()
        try await r.start()
        let (c, server) = r.net.connect()
        let d = try await RawD.over(c)
        await nearbyUntil("hello") { d.hello != nil }
        r.approver.destroy()
        await nearbyUntil("stopped") { r.status.state == .stopped }
        await nearbyUntil("socket closed") { server.closed }
        XCTAssertTrue(r.net.live.isEmpty)
    }

    // MARK: N5, N10, N2

    func testTheNextPromptWaitsUntilThePickedSessionFinishes() async throws {
        let r = Rig()
        try await r.start()
        let (d1, a1) = try await r.prompted()
        let keys = try await d1.keys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        let d2 = try await r.dial(startSas: true)
        async let picked = a1.pick(r.shown(d1))
        try await d1.showAndRequest()
        guard case .request(let req) = try await picked else { return XCTFail("no request") }
        await nearbySettle()
        XCTAssertEqual(r.approvals.value.count, 1, "held while the picked session is open")
        _ = try await a1.finish(worker.answer(req))
        await nearbyUntil("second prompt") { r.approvals.value.count == 2 }
        XCTAssertTrue(r.approvals.value[1].codes.contains(r.shown(d2)))
        await r.approver.stop()
    }

    func testPromptFalseNeedsAnExplicitBackgroundTrue() async throws {
        let r = Rig()
        do {
            try await r.start(prompt: false, background: false)
            XCTFail("started")
        } catch { XCTAssertEqual(error as? NearbyError, .badInput) }
        XCTAssertTrue(r.net.handles.value.isEmpty)
    }

    func testClosingTheScreenOfAForegroundApproverPausesTheAdvertUntilItOpensAgain() async throws {
        let r = Rig()
        try await r.start()
        try await r.approver.setPrompt(false)
        XCTAssertEqual(r.status.state, .paused)
        XCTAssertTrue(r.net.live.isEmpty)
        try await r.approver.setPrompt(true)
        XCTAssertEqual(r.status.state, .advertising)
        await r.approver.stop()
    }

    func testABackgroundApproverKeepsAdvertisingWhenTheScreenCloses() async throws {
        let r = Rig()
        try await r.start(prompt: true, background: true)
        try await r.approver.setPrompt(false)
        XCTAssertEqual(r.status.state, .advertising)
        XCTAssertEqual(r.net.live.count, 1)
        await r.approver.stop()
    }

    func testAnHonestDWhoseLabelDoesNotCleanTwiceTheSameWayStillVerifies() async throws {
        let r = Rig()
        try await r.start()
        // A zero-width space between a base letter and a combining acute: cleaning twice differs.
        let raw = "e\u{200B}\u{301}x"
        let (d, a) = try await r.prompted(label: raw)
        async let picked = a.pick(r.shown(d))
        try await d.showAndRequest()
        guard case .request(let req) = try await picked else { return XCTFail("no request") }
        XCTAssertEqual(Array(req.label!.unicodeScalars), Array("e\u{301}x".unicodeScalars))
        await r.approver.stop()
    }

    // MARK: Accept limits

    func testTheApproversAcceptPoolAdmitsOneWaitingSessionPerAddressAndTwoPerGroup() {
        let pool = UnauthenticatedLimiter.approver()
        let first = pool.admit(address: "192.168.1.10")
        XCTAssertNotNil(first)
        XCTAssertNil(pool.admit(address: "192.168.1.10"), "one waiting session per source address")
        XCTAssertNotNil(pool.admit(address: "192.168.1.11"))
        XCTAssertNil(pool.admit(address: "192.168.1.12"), "two per /24")
        pool.release(first!)
        XCTAssertNotNil(pool.admit(address: "192.168.1.10"))
    }

    func testTheSessionCapRefusesAConnectionPastIt() async throws {
        let r = Rig()
        try await r.start(maxSessions: 1)
        _ = try await r.dial()
        let (c, server) = r.net.connect()
        await nearbyUntil("refused") { server.closed }
        XCTAssertTrue(c.closed || server.closed)
        await r.approver.stop()
    }

    func testAnApproverSessionTellsTheGateItsTransportIsUpAndReleasesTheSlotOnThePick() async throws {
        let r = Rig()
        try await r.start()
        let (c, server) = r.net.connect()
        let d = try await RawD.over(c)
        await nearbyUntil("hello") { d.hello != nil }
        XCTAssertEqual(server.establishedCalls.value, 1)
        XCTAssertEqual(server.settleCalls.value, 0)
        await d.startSas()
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        async let picked = r.approvals.value[0].pick(PeerSAS.display(d.code!))
        await nearbyUntil("settled") { server.settleCalls.value >= 1 }
        try await d.showAndRequest()
        _ = try await picked
        await r.approver.stop()
    }
}

final class NearbyOneTimeKeyTests: XCTestCase {
    func testAWipedKeyAnswersNothingAndTheSessionSharesTheStorage() async throws {
        let k = try PeerOneTimeKey()
        let before = try await k.publicKey()
        XCTAssertEqual(before.count, 32)
        XCTAssertFalse(k.isWiped)
        // The channel holds this very object, not a copy: wiping it is wiping the session's storage.
        let sent = NBox<[Data]>([])
        let events = NBox<[PeerSessionEvent]>([])
        let m = try PeerChannel(
            role: .responder, slug: nearbySlug, staticKey: k, admission: HandshakeLimiter(),
            hello: (nil, "t", "a", nil), send: { d in sent.mutate { $0.append(d) } },
            onEvent: { e in events.mutate { $0.append(e) } }, mode: .v)
        let first = NBox<[Data]>([])
        let d = try PeerChannel(
            role: .initiator, slug: nearbySlug, staticKey: PeerOneTimeKey(), hello: (nil, "t", "a", nil),
            send: { x in first.mutate { $0.append(x) } }, onEvent: { _ in }, mode: .v)
        await d.start()
        k.wipe()
        XCTAssertTrue(k.isWiped)
        let dh = try await k.dh(before)
        XCTAssertNil(dh)
        do {
            _ = try await k.publicKey()
            XCTFail("answered")
        } catch { XCTAssertEqual(error as? PeerNoiseError, .badKey) }
        await m.receive(first.value[0])
        let closed = events.value.filter {
            if case .closed(.handshakeFailed, _) = $0 { return true } else { return false }
        }
        XCTAssertEqual(closed.count, 1, "a wiped key cannot take part in a handshake")
        XCTAssertTrue(sent.value.isEmpty, "and nothing is sent")
    }
}
