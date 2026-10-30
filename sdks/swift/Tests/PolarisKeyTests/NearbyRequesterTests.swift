// @pkey-feature identity.nearby
// CC-15.S3: the requester (D) of nearby approval (WIRE-CONTRACT-V5 §15.4.1, §15.6.1), against real approvers
// (the S2 engine) over in-memory pipes and a fake LAN. Mirrors sdk-node's `nearbyRequester.test.ts`, with the
// fixes of its fix round: N1 (one answer per request), N8 (an idle unchosen session is replaced), N10 (the
// request is checked when it starts), and the 250 ms dial race of §15.4.1.

import Foundation
import XCTest

@testable import PolarisKeyCore

private func target(_ n: Int) -> NearbyTarget { NearbyTarget(address: "10.0.0.\(n)", endpoint: n) }

private final class RRig: @unchecked Sendable {
    let timers = ManualTimers()
    let rnet = FakeRequesterNet()
    var nets: [FakeApproverNet] = []
    var approvers: [NearbyApprover] = []
    let approvals = NBox<[(index: Int, approval: NearbyApproval)]>([])
    let keys: any DeviceKeyPort
    var requester: NearbyRequester!

    init() { keys = try! DeviceKeyStore.inMemory() }

    @discardableResult
    func addApprover(label: String? = nil) async throws -> Int {
        let i = nets.count
        let net = FakeApproverNet()
        let approvals = approvals
        let a = try await NearbyApprover.start(
            source: NearbyApproverSource(
                slug: nearbySlug, now: { 1_800_000_000 }, signedIn: { true }, nearbyServed: { true }),
            handler: { a in approvals.mutate { $0.append((i, a)) } },
            options: NearbyApproverOptions(prompt: true, label: label ?? "Approver \(i)", platform: "macos"),
            network: net)
        nets.append(net)
        approvers.append(a)
        return i
    }

    func startRequester(
        label: String? = "Ben's Switch", request: String = nearbyRequestHandle, expiresIn: TimeInterval = 300
    ) async throws {
        let keys = keys
        requester = try await NearbyRequester.start(
            source: NearbyRequesterSource(
                slug: nearbySlug, now: { 1_800_000_000 }, signer: { (keys, nearbyDeviceId) }),
            options: NearbyRequestOptions(
                request: request, label: label, platform: "macos", expiresIn: expiresIn, timer: timers.timer,
                redialSeconds: 0.3),
            network: rnet)
    }

    func upAll() { for n in nets { rnet.up(n) } }

    func listed(_ n: Int) async {
        await nearbyUntil("\(n) listed") { await self.count() == n }
    }

    private func count() async -> Int { await requester.approvers().count }

    func stopAll() async {
        await requester?.close()
        for a in approvers { await a.stop() }
    }
}

final class NearbyRequesterTests: XCTestCase {
    // MARK: Browsing and the list

    func testListsApproversByTheirHelloAndPromptsNoneOfThem() async throws {
        let r = RRig()
        try await r.addApprover(label: "Ana's Mac")
        try await r.addApprover(label: "Ana's iPad")
        try await r.startRequester()
        r.upAll()
        await r.listed(2)
        let list = await r.requester.approvers()
        XCTAssertEqual(Set(list.map { $0.label ?? "" }), ["Ana's Mac", "Ana's iPad"])
        XCTAssertTrue(list.allSatisfy { $0.platform == "macos" && $0.id.hasPrefix("ap_") })
        await nearbySettle()
        XCTAssertTrue(r.approvals.value.isEmpty, "a session held at HELLO prompts nobody")
        await r.stopAll()
    }

    func testDialsAtMostFourApproversAtOnce() async throws {
        let r = RRig()
        for _ in 0..<6 { try await r.addApprover() }
        try await r.startRequester()
        r.upAll()
        await r.listed(4)
        await nearbySettle()
        XCTAssertEqual(r.rnet.dials.value, 4)
        let n = await r.requester.approvers().count
        XCTAssertEqual(n, 4)
        await r.stopAll()
    }

    func testIgnoresAnAdvertOfAnotherProductAndOfModeA() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        let h = r.nets[0].live[0]
        let other = try PeerAdvert.productTag(slug: "someone-else", epoch: peerAdvertEpoch(1_800_000_000))
        r.rnet.up(h, txt: ["v=1", "m=v", "h=\(other)"])
        r.rnet.up(h, txt: ["v=1", "m=a"])
        r.rnet.up(h, txt: ["v=1", "m=v"])
        await nearbySettle()
        XCTAssertEqual(r.rnet.dials.value, 0)
        // The previous epoch's tag is still ours.
        let prev = try PeerAdvert.productTag(slug: nearbySlug, epoch: peerAdvertEpoch(1_800_000_000) - 1)
        r.rnet.up(h, txt: ["v=1", "m=v", "h=\(prev)"])
        await r.listed(1)
        await r.stopAll()
    }

    func testDropsAnApproverWhoseSessionEndsFromTheList() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(2)
        await r.approvers[0].stop()
        await nearbyUntil("one left") { await r.requester.approvers().count == 1 }
        await r.stopAll()
    }

    func testAnUnknownIdIsRefused() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        do {
            _ = try await r.requester.choose("ap_nope")
            XCTFail("chose")
        } catch { XCTAssertEqual(error as? NearbyError, .unknownApprover) }
        await r.stopAll()
    }

    // MARK: The choice

    func testStartsTheCodeOnTheChosenApproverOnlyAndTheOthersClosePeerBye() async throws {
        let r = RRig()
        try await r.addApprover(label: "A")
        try await r.addApprover(label: "B")
        try await r.startRequester()
        r.upAll()
        await r.listed(2)
        let list = await r.requester.approvers()
        let pick = try XCTUnwrap(list.first { $0.label == "B" })
        let code = try await r.requester.choose(pick.id)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        XCTAssertEqual(r.approvals.value[0].index, 1)
        XCTAssertTrue(r.approvals.value[0].approval.codes.contains(code))
        await nearbySettle()
        XCTAssertEqual(r.approvals.value.count, 1, "the other approver never prompts")
        let now = await r.requester.approvers()
        XCTAssertTrue(now.isEmpty, "once the person chose, the list is over")
        await r.stopAll()
    }

    func testRunsTheWholeVouchTheCodeMatchesVouchReqVerifiesAndApprovedReachesD() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        let results = NBox<[VouchStatus]>([])
        r.requester.onResult { s in results.mutate { $0.append(s) } }
        let id = try await r.requester.approvers()[0].id
        let code = try await r.requester.choose(id)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        let a = r.approvals.value[0].approval
        XCTAssertTrue(a.codes.contains(code))
        let keys = try await r.keys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        guard case .request(let req) = try await a.pick(code) else { return XCTFail("no request") }
        XCTAssertEqual(req.signKey, keys.signKey)
        XCTAssertEqual(req.label, "Ben's Switch")
        let out = try await a.finish(worker.answer(req))
        XCTAssertEqual(out, .sent(.approved))
        await nearbyUntil("result") { results.value == [.approved] }
        let shown = await r.requester.result()
        XCTAssertEqual(shown, .approved)
        await r.stopAll()
    }

    func testAWrongPickEndsTheChosenSessionAndThePersonMayChooseAgainFromAFreshList() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        let closes = NBox<[String]>([])
        r.requester.onClose { c in closes.mutate { $0.append(c) } }
        let code = try await r.requester.choose(try await r.requester.approvers()[0].id)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        let a = r.approvals.value[0].approval
        let decoy = a.codes.first { $0 != code }!
        let got = try await a.pick(decoy)
        XCTAssertEqual(got, .mismatch)
        await nearbyUntil("closed") { closes.value == ["peer_bye"] }
        let res = await r.requester.result()
        XCTAssertNil(res)
        // The request goes on: the redial timer brings the approver back, and the person may choose again.
        await nearbyUntil("redial armed") { r.timers.armed(0.3) >= 1 }
        r.timers.fire(0.3)
        await r.listed(1)
        let again = try await r.requester.choose(try await r.requester.approvers()[0].id)
        await nearbyUntil("second prompt") { r.approvals.value.count == 2 }
        XCTAssertTrue(r.approvals.value[1].approval.codes.contains(again))
        await r.stopAll()
    }

    // MARK: The account gate

    private func approvedWithWrap(_ r: RRig) async throws {
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        let code = try await r.requester.choose(try await r.requester.approvers()[0].id)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        let a = r.approvals.value[0].approval
        let keys = try await r.keys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        guard case .request(let req) = try await a.pick(code) else { return XCTFail("no request") }
        _ = try await a.finish(worker.answer(req))
        try await a.sendRecord(type: PeerRecordType.keyringWrap, body: Data("wrap".utf8))
    }

    func testHoldsAWrapUntilThePersonConfirmedTheAccountThenHandsItOver() async throws {
        let r = RRig()
        try await r.addApprover()
        let got = NBox<[NearbyRecord]>([])
        try await r.startRequester()
        r.requester.onRecord { rec in got.mutate { $0.append(rec) } }
        r.upAll()
        await r.listed(1)
        let code = try await r.requester.choose(try await r.requester.approvers()[0].id)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        let a = r.approvals.value[0].approval
        let keys = try await r.keys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        guard case .request(let req) = try await a.pick(code) else { return XCTFail("no request") }
        _ = try await a.finish(worker.answer(req))
        try await a.sendRecord(type: PeerRecordType.keyringWrap, body: Data("wrap".utf8))
        await nearbySettle()
        XCTAssertTrue(got.value.isEmpty, "D takes no record before its person confirmed the account")
        try await r.requester.confirmAccount()
        await nearbyUntil("wrap") { got.value.count == 1 }
        XCTAssertEqual(got.value[0], NearbyRecord(type: PeerRecordType.keyringWrap, body: Data("wrap".utf8)))
        await r.stopAll()
    }

    func testADeclineDropsTheHeldRecordsAndClosesTheSession() async throws {
        let r = RRig()
        try await r.addApprover()
        let got = NBox<[NearbyRecord]>([])
        let closes = NBox<[String]>([])
        try await approvedWithWrapOn(r, got: got, closes: closes)
        await r.requester.declineAccount()
        await nearbyUntil("closed") { !closes.value.isEmpty }
        XCTAssertTrue(got.value.isEmpty)
        await r.stopAll()
    }

    private func approvedWithWrapOn(_ r: RRig, got: NBox<[NearbyRecord]>, closes: NBox<[String]>) async throws {
        try await r.startRequester()
        r.requester.onRecord { rec in got.mutate { $0.append(rec) } }
        r.requester.onClose { c in closes.mutate { $0.append(c) } }
        r.upAll()
        await r.listed(1)
        let code = try await r.requester.choose(try await r.requester.approvers()[0].id)
        await nearbyUntil("prompt") { r.approvals.value.count == 1 }
        let a = r.approvals.value[0].approval
        let keys = try await r.keys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        guard case .request(let req) = try await a.pick(code) else { return XCTFail("no request") }
        _ = try await a.finish(worker.answer(req))
        try await a.sendRecord(type: PeerRecordType.keyringWrap, body: Data("wrap".utf8))
        await nearbySettle()
    }

    // MARK: The end

    func testExpiresAtExpiresInTheSessionsClosePeerByeAndOnCloseSaysExpired() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        let closes = NBox<[String]>([])
        r.requester.onClose { c in closes.mutate { $0.append(c) } }
        r.upAll()
        await r.listed(1)
        XCTAssertEqual(r.timers.armed(300), 1)
        r.timers.fire(300)
        await nearbyUntil("expired") { closes.value == ["expired"] }
        let closed = await r.requester.isClosed()
        XCTAssertTrue(closed)
        await nearbyUntil("browse stopped") { r.rnet.browseStops.value == 1 }
        await r.stopAll()
    }

    func testCloseEndsTheBrowseAndEverySession() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        await r.requester.close()
        XCTAssertEqual(r.rnet.browseStops.value, 1)
        let n = await r.requester.approvers().count
        XCTAssertEqual(n, 0)
        r.rnet.up(r.nets[0])
        await nearbySettle()
        XCTAssertEqual(r.rnet.dials.value, 1, "nothing is dialled after the end")
        await r.stopAll()
    }

    func testDestroyDropsEverySocketAtOnce() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        r.requester.destroy()
        await nearbyUntil("closed") { await r.requester.isClosed() }
        await r.approvers[0].stop()
    }

    // MARK: N1: one answer per request

    func testAfterApprovedALaterApproverIsNotDialledListedOrChoosable() async throws {
        let r = RRig()
        try await r.addApprover()
        try await approvedWithWrap(r)
        await nearbyUntil("answered") { await r.requester.result() == .approved }
        // A second approver appears after the answer.
        try await r.addApprover()
        let dials = r.rnet.dials.value
        r.rnet.up(r.nets[1])
        await nearbySettle()
        XCTAssertEqual(r.rnet.dials.value, dials)
        do {
            _ = try await r.requester.choose("ap_x")
            XCTFail("chose")
        } catch { XCTAssertEqual(error as? NearbyError, .closed) }
        await r.stopAll()
    }

    func testAfterConfirmAccountALaterApproverIsNotDialledOrChoosableEither() async throws {
        let r = RRig()
        try await r.addApprover()
        try await approvedWithWrap(r)
        try await r.requester.confirmAccount()
        try await r.addApprover()
        let dials = r.rnet.dials.value
        r.rnet.up(r.nets[1])
        await nearbySettle()
        XCTAssertEqual(r.rnet.dials.value, dials)
        await r.stopAll()
    }

    // MARK: N8: an idle unchosen session is replaced after 20 s

    func testAnIdleSessionIsClosedPeerByeAndTheApproverDialledAgain() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        let first = try await r.requester.approvers()[0].id
        XCTAssertEqual(r.timers.armed(20), 1)
        r.timers.fire(20)
        await nearbyUntil("replaced out") { await r.requester.approvers().isEmpty }
        await nearbyUntil("redial armed") { r.timers.armed(0.3) >= 1 }
        r.timers.fire(0.3)
        await r.listed(1)
        let second = try await r.requester.approvers()[0].id
        XCTAssertNotEqual(first, second)
        await r.stopAll()
    }

    func testStartsNoIdleClockOnTheSessionThePersonChose() async throws {
        let r = RRig()
        try await r.addApprover()
        try await r.startRequester()
        r.upAll()
        await r.listed(1)
        _ = try await r.requester.choose(try await r.requester.approvers()[0].id)
        XCTAssertEqual(r.timers.armed(20), 0)
        r.timers.fire(20)
        await nearbySettle()
        let closed = await r.requester.isClosed()
        XCTAssertFalse(closed)
        XCTAssertTrue(r.approvals.value.count <= 1)
        await r.stopAll()
    }

    // MARK: N10: the request is checked when it starts

    func testABadRequestHandleLabelOrLifetimeIsRefusedAtStart() async throws {
        for (req, label, exp) in [
            ("nr_short", nil, 300), (nearbyRequestHandle, String(repeating: "a", count: 257), 300),
            (nearbyRequestHandle, nil, 0), (nearbyRequestHandle, nil, -5),
        ] as [(String, String?, Int)] {
            let r = RRig()
            do {
                try await r.startRequester(label: label, request: req, expiresIn: TimeInterval(exp))
                XCTFail("started: \(req.count) \(label?.count ?? 0) \(exp)")
            } catch { XCTAssertEqual(error as? NearbyError, .badInput) }
            XCTAssertFalse(r.rnet.browsing)
        }
        let r = RRig()
        do {
            try await r.startRequester(expiresIn: .nan)
            XCTFail("started")
        } catch { XCTAssertEqual(error as? NearbyError, .badInput) }
    }

    func testClampsExpiresInTo300Seconds() async throws {
        let r = RRig()
        try await r.startRequester(expiresIn: 1000)
        XCTAssertEqual(r.timers.armed(300), 1)
        XCTAssertEqual(r.timers.armed(1000), 0)
        await r.requester.close()
    }

    func testABrowseThatCannotBeginIsTheTypedError() async throws {
        let r = RRig()
        r.rnet.failBrowse.value = .permissionDenied
        do {
            try await r.startRequester()
            XCTFail("started")
        } catch { XCTAssertEqual(error as? NearbyError, .permissionDenied) }
    }

    func testAThrowingResolveCostsATryNotTheRequest() async throws {
        let r = RRig()
        try await r.addApprover()
        r.rnet.failResolve.value = true
        try await r.startRequester()
        r.upAll()
        await nearbyUntil("tried") { r.rnet.resolves.value >= 1 }
        let closed = await r.requester.isClosed()
        XCTAssertFalse(closed)
        // Three tries per advert, spaced by the redial timer.
        for _ in 0..<3 {
            await nearbyUntil("redial") { r.timers.armed(0.3) >= 1 }
            r.timers.fire(0.3)
            await nearbySettle(20)
        }
        XCTAssertEqual(r.rnet.resolves.value, 3)
        await r.stopAll()
    }

    // MARK: The dial race (§15.4.1)

    /// A pipe whose end is a flag.
    private final class Flagged: PeerBytePipe, @unchecked Sendable {
        let closed = NBox(false)
        let remoteAddress = "x"
        func read() async throws -> Data? { nil }
        func write(_ bytes: Data) async throws {}
        func close() async { closed.value = true }
    }

    func testTheRaceStartsOneAttemptNowAndAnotherEvery250msWithTwoInFlight() async throws {
        let timers = ManualTimers()
        let started = NBox<[Int]>([])
        let gates = NBox<[Int: CheckedContinuation<Void, Never>]>([:])
        let result = NBox<Result<Int, Error>?>(nil)
        Task {
            do {
                _ = try await nearbyDialRace([target(1), target(2), target(3)], timer: timers.timer) { t in
                    let n = t.endpoint as! Int
                    started.mutate { $0.append(n) }
                    if n != 3 { await withCheckedContinuation { c in gates.mutate { $0[n] = c } } }
                    return Flagged()
                }
                result.value = .success(0)
            } catch { result.value = .failure(error) }
        }
        await nearbyUntil("first") { started.value == [1] }
        XCTAssertEqual(timers.armed(0.25), 1)
        timers.fire(0.25)
        await nearbyUntil("second") { started.value == [1, 2] }
        // Two in flight: the next stagger tick starts nothing, but arms again.
        timers.fire(0.25)
        await nearbySettle(40)
        XCTAssertEqual(started.value, [1, 2])
        XCTAssertEqual(timers.armed(0.25), 1)
        gates.value[1]?.resume()
        await nearbyUntil("winner") { result.value != nil }
        gates.value[2]?.resume()
    }

    func testAFailureStartsTheNextAttemptAtOnceAndTheLastErrorEndsTheRace() async throws {
        let timers = ManualTimers()
        let started = NBox<[Int]>([])
        do {
            _ = try await nearbyDialRace([target(1), target(2)], timer: timers.timer) { t in
                started.mutate { $0.append(t.endpoint as! Int) }
                throw (t.endpoint as! Int) == 1 ? NearbyError.unavailable : NearbyError.permissionDenied
            }
            XCTFail("dialled")
        } catch { XCTAssertEqual(error as? NearbyError, .permissionDenied) }
        XCTAssertEqual(started.value, [1, 2])
    }

    func testALoserThatConnectsLaterIsClosedBeforeAByteIsSentOnIt() async throws {
        let timers = ManualTimers()
        let slow = Flagged()
        let fast = Flagged()
        let release = NBox<CheckedContinuation<Void, Never>?>(nil)
        let winner = NBox<(any PeerBytePipe)?>(nil)
        Task {
            winner.value = try? await nearbyDialRace([target(1), target(2)], timer: timers.timer) { t in
                if (t.endpoint as! Int) == 1 {
                    await withCheckedContinuation { c in release.value = c }
                    return slow
                }
                return fast
            }
        }
        // Attempt 1 hangs; the 250 ms tick starts attempt 2, which wins.
        await nearbyUntil("attempt 1 started") { release.value != nil && timers.armed(0.25) == 1 }
        timers.fire(0.25)
        await nearbyUntil("won") { winner.value != nil }
        XCTAssertTrue((winner.value as AnyObject?) === fast)
        release.value?.resume()
        await nearbyUntil("loser closed") { slow.closed.value }
        XCTAssertFalse(fast.closed.value)
    }
}
