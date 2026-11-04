// @pkey-feature ui.kit.holders
//
// The holdersFlow family of ui-matrix.json (UK-43.4): the AddToAccount model over a scripted driver,
// the same 20 scenarios every native port replays. A driver call past its script answers ok (preview,
// attach) or cancelled (waits).

import Foundation
import PolarisKeyUICore
import XCTest

private struct Network: Error {}

/// A driver that answers from a scenario's script and records what it was asked.
private final class Scripted: AddToAccountDriver, @unchecked Sendable {
    private let lock = NSLock()
    private var waits: [AddToAccountWait]
    private var preview: [Any]
    private var attachScript: [Any]
    private let completes: Bool
    private let signInFails: Bool
    private(set) var calls: [String] = []
    private(set) var hints: [AddToAccountHints] = []
    /// Called once, inside the first wait (the cancel that lands while the sign-in is open).
    var duringFirstWait: (@Sendable () async -> Void)?
    private var waited = false

    init(_ script: [String: Any]) {
        let given = script["waits"] as? [[String: Any]]
        waits = (given ?? [["outcome": "signedIn"]]).map(Scripted.wait)
        preview = script["preview"] as? [Any] ?? []
        attachScript = script["attach"] as? [Any] ?? []
        completes = (script["complete"] as? [String: Any]).map { $0["outcome"] as? String == "signedIn" } ?? true
        signInFails = script["signInError"] != nil
    }

    private static func wait(_ raw: [String: Any]) -> AddToAccountWait {
        switch raw["outcome"] as? String {
        case "pending": return .pending
        case "signedIn": return .signedIn(email: raw["email"] as? String)
        case "choose": return .choose(grant: raw["grant"] as? String ?? "")
        case "cancelled": return .cancelled
        default: return .expired
        }
    }

    private func record(_ call: String) { lock.withLock { calls.append(call) } }

    func signIn(_ hints: AddToAccountHints) async throws -> any AddToAccountHandle {
        lock.withLock {
            calls.append("signIn")
            self.hints.append(hints)
        }
        if signInFails { throw Network() }
        return Handle(self)
    }

    func complete(grant: String) async throws -> Bool {
        record("complete:\(grant):keep")
        return completes
    }

    func attach(confirm: Bool) async throws -> AddToAccountAttach {
        record(confirm ? "attach" : "preview")
        let next: Any? = lock.withLock {
            if confirm { return attachScript.isEmpty ? nil : attachScript.removeFirst() }
            return preview.isEmpty ? nil : preview.removeFirst()
        }
        guard let next else { return .ok }
        guard let object = next as? [String: Any] else { throw Network() }
        if object["kind"] as? String == "refused" {
            return .refused(code: object["code"] as? String ?? "")
        }
        return .ok
    }

    private final class Handle: AddToAccountHandle, @unchecked Sendable {
        let owner: Scripted
        init(_ owner: Scripted) { self.owner = owner }
        var userCode: String? { nil }

        func wait() async throws -> AddToAccountWait {
            let hook: (@Sendable () async -> Void)? = owner.lock.withLock {
                guard !owner.waited, let hook = owner.duringFirstWait else { return nil }
                owner.waited = true
                return hook
            }
            if let hook { await hook() }
            return owner.lock.withLock { owner.waits.isEmpty ? .cancelled : owner.waits.removeFirst() }
        }

        func reopen() async -> Bool { true }
        func cancel() { owner.record("cancel") }
    }
}

@MainActor
final class AddToAccountFlowTests: XCTestCase {
    private func flow() throws -> [String: Any] {
        try XCTUnwrap(UIMatrix.load().raw["holdersFlow"] as? [String: Any])
    }

    private func base(_ flow: [String: Any]) throws -> (KitInputs, String?) {
        let given = try XCTUnwrap(flow["base"] as? [String: Any])
        var members: [String: Any] = [
            "platform": ["os": "macos", "formFactor": "mac"],
            "presentation": ["name": "Tidewater Studio", "icon": true],
            "services": ["license", "identity"],
        ]
        members["licenseHolder"] = given["licenseHolder"]
        return (try UIMatrix.load().inputs(members), given["deviceKind"] as? String)
    }

    func testTheRunnerCoversEveryScenario() throws {
        XCTAssertEqual((try flow()["scenarios"] as? [Any])?.count, 20)
    }

    func testEveryScenario() async throws {
        let flow = try flow()
        let (inputs, deviceKind) = try base(flow)
        for scenario in try XCTUnwrap(flow["scenarios"] as? [[String: Any]]) {
            let name = scenario["name"] as? String ?? "?"
            let driver = Scripted(scenario["driver"] as? [String: Any] ?? [:])
            let model = AddToAccountModel(driver: driver, base: inputs, deviceKind: deviceKind)
            let fields = scenario["fields"] as? [String: Any]
            model.setField(.name, fields?["name"] as? String ?? "Ada Lovelace")
            model.setField(.email, fields?["email"] as? String ?? "ada@example.com")
            var steps: [String] = []
            for action in scenario["actions"] as? [String] ?? [] {
                switch action {
                case "submit-then-cancel":
                    driver.duringFirstWait = { await model.cancel() }
                    await model.submit()
                case "submit": await model.submit()
                case "tryAgain": await model.tryAgain()
                default: XCTFail("\(name): unknown action \(action)")
                }
                steps.append(model.step.rawValue)
            }
            let want = try XCTUnwrap(scenario["expect"] as? [String: Any], name)
            XCTAssertEqual(steps, want["steps"] as? [String], "\(name): steps")
            XCTAssertEqual(driver.calls, want["calls"] as? [String], "\(name): calls")
            let hints = (want["hints"] as? [[String: String]] ?? []).map {
                AddToAccountHints(
                    loginHint: $0["loginHint"] ?? "", nameHint: $0["nameHint"] ?? "",
                    purpose: $0["purpose"] ?? "")
            }
            XCTAssertEqual(driver.hints, hints, "\(name): hints")
            XCTAssertEqual(model.screen.stateName, want["viewState"] as? String, "\(name): view state")
            if let field = want["field"] as? String { XCTAssertEqual(model.field?.rawValue, field, name) }
            if let typed = want["typedEmail"] as? String { XCTAssertEqual(model.typedEmail, typed, name) }
            if let signed = want["signedEmail"] as? String { XCTAssertEqual(model.signedEmail, signed, name) }
        }
    }

    func testTheTypedValuesStayOutOfTheViewsInput() throws {
        // A base without the holder's own email, which a screen shows masked.
        let inputs = try UIMatrix.load().inputs(["services": ["license", "identity"]])
        let model = AddToAccountModel(driver: Scripted([:]), base: inputs, deviceKind: "Mac")
        model.setField(.name, "Ada Lovelace")
        model.setField(.email, "ada@example.com")
        let encoded = String(decoding: try JSONEncoder().encode(model.inputs), as: UTF8.self)
        XCTAssertFalse(encoded.contains("Ada Lovelace"))
        XCTAssertFalse(encoded.contains("\"ada@example.com\""))
    }
}
