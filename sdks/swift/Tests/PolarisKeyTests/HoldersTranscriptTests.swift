// @pkey-feature ui.kit.holders identity.devicecode.choice identity.attach
//
// The AddToAccount model and its SDK driver over the recorded `holders-add-to-account-preview`
// conversation (UK-43.4), through TranscriptTests' replayer. The recording is one flow the model drives
// end to end: key activation, then the sign-in the driver starts (channel redirect with no redirect URI;
// the recorded product serves no redirect, so the SDK answers redirect-unavailable and the driver asks
// for a device code with the hints), the poll that answers `choose`, `choice.complete` keeping this
// device's license, the attach preview (`confirm: false`) and the confirmed attach. The five recorded
// steps after the activation are replayed as one ordered step, so the replayer asserts every request and
// nothing else is sent: the same licenseId and subject, `attached: "claimed"`.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import PolarisKeyUICore
import XCTest

final class HoldersTranscriptTests: XCTestCase {
    private func recorded() throws -> Transcript {
        try XCTUnwrap(try TranscriptFiles.load().first { $0.id == "holders-add-to-account-preview" })
    }

    /// The transcript with every exchange after the activation moved onto the sign-in step, in order. The
    /// later steps stay (the replayer reads the product's discovery off their actions) but expect no
    /// traffic of their own.
    private func merged(_ t: Transcript) throws -> Transcript {
        var out = t
        let rest = Array(t.steps.dropFirst())
        XCTAssertEqual(
            rest.map(\.action), ["beginSignIn", "pollSignIn", "choiceComplete", "attach", "attach"])
        var args: [String: JSONValue] = [:]
        for step in rest { args.merge(step.args) { _, new in new } }
        out.steps[1].args = args
        out.steps[1].exchanges = Transcript.Exchanges(ordered: true, items: rest.flatMap(\.exchanges.items))
        out.steps[1].expect = [:]
        for i in 2..<out.steps.count {
            out.steps[i].exchanges = Transcript.Exchanges(ordered: true, items: [])
            out.steps[i].expect = [:]
        }
        return out
    }

    /// Type the recorded hints into the model, press Continue, and report where it landed.
    @MainActor
    private static func drive(
        _ client: PolarisKeyClient, _ step: Transcript.Step
    ) async -> (step: String, view: String) {
        var base = KitInputs()
        base.platform = KitPlatform(os: .macos, formFactor: .mac)
        base.presentation = KitPresentation(name: "Tidewater Studio", icon: true)
        base.services = [.license, .identity]
        base.licenseHolder = KitLicenseHolder(email: "ada@example.com")
        let model = AddToAccountModel(
            driver: IdentityAddToAccountDriver(identity: client.identity), base: base, deviceKind: "Mac")
        model.setField(.name, step.args["nameHint"]?.stringValue ?? "")
        model.setField(.email, step.args["loginHint"]?.stringValue ?? "")
        await model.submit()
        return (model.step.rawValue, model.screen.stateName)
    }

    private final class Seen: @unchecked Sendable {
        var landed: (step: String, view: String)?
    }

    func testTheModelReplaysTheRecordedConversation() async throws {
        let applicable = try TranscriptFiles.applies(recorded(), TranscriptFiles.manifestStatuses())
        try XCTSkipUnless(applicable, "sdks/swift/parity.json does not claim the transcript's features")
        let seen = Seen()
        try await SwiftReplay.replay(merged(recorded())) { client, step in
            guard step.action != "activate" else { return nil }
            // The later steps' traffic was replayed inside the sign-in step.
            guard step.action == "beginSignIn" else { return [:] }
            seen.landed = await Self.drive(client, step)
            return [:]
        }
        XCTAssertEqual(seen.landed?.step, "added")
        XCTAssertEqual(seen.landed?.view, "added")
    }
}
