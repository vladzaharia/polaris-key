// @pkey-feature ui.kit.holders
//
// What the holder screens read from the model and the host (UK-43.5): the code's address, the page
// that opened (or did not), and an account sign-in that finishes or leaves a problem, Cancel live.

import Foundation
import PolarisKeyUICore
import XCTest

private struct Down: Error {}

/// A sign-in that shows a code, then answers from a list.
private final class CodeHandle: AddToAccountHandle, @unchecked Sendable {
    let userCode: String? = "WDJB-MJHT"
    let verificationUri: String? = "https://polaris.locker/device"
    let verificationUriComplete: String? = "https://polaris.locker/device?user_code=WDJB-MJHT"
    private let lock = NSLock()
    private var answers: [AddToAccountWait]
    private let opens: Bool
    private(set) var cancelled = false
    private(set) var reopened = 0

    init(_ answers: [AddToAccountWait], opens: Bool = true) {
        self.answers = answers
        self.opens = opens
    }

    func wait() async throws -> AddToAccountWait {
        lock.withLock { answers.isEmpty ? .cancelled : answers.removeFirst() }
    }

    func reopen() async -> Bool {
        lock.withLock { reopened += 1 }
        return opens
    }

    func cancel() { lock.withLock { cancelled = true } }
}

private struct CodeDriver: AddToAccountDriver {
    let handle: CodeHandle
    var fails = false
    func signIn(_ hints: AddToAccountHints) async throws -> any AddToAccountHandle {
        if fails { throw Down() }
        return handle
    }
    func complete(grant: String) async throws -> Bool { true }
    func attach(confirm: Bool) async throws -> AddToAccountAttach { .ok }
}

@MainActor
final class HolderHostTests: XCTestCase {
    func testAnAccountSignInThatFinishesIsTrueAndLeavesNoProblem() async {
        let handle = CodeHandle([.pending, .signedIn(email: nil)])
        let host = HolderHostState(driver: CodeDriver(handle: handle))
        let ok = await host.signIn(loginHint: "maya@example.com")
        XCTAssertTrue(ok)
        XCTAssertNil(host.problem)
        XCTAssertFalse(host.working)
        // A code sign-in opens its page itself.
        XCTAssertEqual(handle.reopened, 1)
    }

    func testAnAccountSignInThatExpiresLeavesADangerLine() async {
        let host = HolderHostState(driver: CodeDriver(handle: CodeHandle([.expired])))
        let ok = await host.signIn()
        XCTAssertFalse(ok)
        XCTAssertEqual(host.problem, .signInFailed)
        XCTAssertEqual(HolderProblem.signInFailed.key, "signin.approve.failed")
    }

    func testASignInThatCannotStartLeavesADangerLine() async {
        let host = HolderHostState(
            driver: CodeDriver(handle: CodeHandle([]), fails: true))
        let ok = await host.signIn()
        XCTAssertFalse(ok)
        XCTAssertEqual(host.problem, .signInFailed)
        XCTAssertFalse(host.working)
    }

    func testAFailedOpenIsSaidAndTheSignInStillRuns() async {
        let handle = CodeHandle([.signedIn(email: nil)], opens: false)
        let host = HolderHostState(driver: CodeDriver(handle: handle))
        let ok = await host.signIn()
        XCTAssertTrue(ok)
        XCTAssertEqual(host.problem, .openFailed)
        XCTAssertEqual(HolderProblem.openFailed.key, "signin.handoff.noBrowser")
    }

    func testCancelLetsTheSignInGoAndClearsTheWait() async throws {
        let handle = CodeHandle([.pending, .pending, .pending])
        let host = HolderHostState(driver: CodeDriver(handle: handle))
        let task = Task { await host.signIn() }
        // The wait is showing: the code is there, and the sign-in is working.
        for _ in 0..<200 where !host.waiting { await Task.yield() }
        XCTAssertTrue(host.waiting)
        XCTAssertEqual(host.userCode, "WDJB-MJHT")
        XCTAssertEqual(host.address, "https://polaris.locker/device")
        host.cancel()
        XCTAssertTrue(handle.cancelled)
        XCTAssertFalse(host.working)
        XCTAssertNil(host.userCode)
        XCTAssertNil(host.problem)
        let ok = await task.value
        XCTAssertFalse(ok)
    }

    func testTheModelOpensACodeSignInsPageAndKeepsItsAddress() async {
        let handle = CodeHandle([.pending, .pending])
        let model = AddToAccountModel(
            driver: CodeDriver(handle: handle), base: KitInputs(), deviceKind: "Mac")
        model.setField(.name, "Ada")
        model.setField(.email, "ada@example.com")
        let task = Task { await model.submit() }
        for _ in 0..<200 where model.userCode == nil { await Task.yield() }
        for _ in 0..<200 where !model.opened { await Task.yield() }
        XCTAssertEqual(model.userCode, "WDJB-MJHT")
        XCTAssertEqual(model.address, "https://polaris.locker/device")
        XCTAssertEqual(model.link, "https://polaris.locker/device?user_code=WDJB-MJHT")
        XCTAssertTrue(model.opened)
        XCTAssertFalse(model.openFailed)
        XCTAssertEqual(model.inputs.deviceCode?.verificationUri, "https://polaris.locker/device")
        XCTAssertEqual(model.screen.state, .waiting)
        model.cancel()
        _ = await task.value
        XCTAssertEqual(model.step, .form)
        XCTAssertNil(model.address)
    }

    func testAFailedOpenOnTheModelIsSaidUntilTheNextOpenWorks() async {
        let handle = CodeHandle([.pending, .pending], opens: false)
        let model = AddToAccountModel(driver: CodeDriver(handle: handle), base: KitInputs())
        model.setField(.name, "Ada")
        model.setField(.email, "ada@example.com")
        let task = Task { await model.submit() }
        for _ in 0..<200 where !model.openFailed { await Task.yield() }
        XCTAssertTrue(model.openFailed)
        XCTAssertFalse(model.opened)
        model.cancel()
        _ = await task.value
        XCTAssertFalse(model.openFailed)
    }
}
