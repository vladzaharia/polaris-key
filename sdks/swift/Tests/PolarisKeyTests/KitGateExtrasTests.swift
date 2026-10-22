// @pkey-feature ui.gate ui.update
//
// What the SwiftUI gate draws beyond the screens (KX-SW-GATE):
//
//   * Trial, Restore and Continue free draw only when the host passes a handler (decision 7);
//   * a toast is one at a time, and an older toast's timer never clears a newer one;
//   * the offered update's notes are at most three plain lines and its changelog entry is found by
//     version, with or without a leading "v" (decision 1).

#if canImport(SwiftUI)
    import Foundation
    import PolarisKey
    import PolarisKeyRelease
    @testable import PolarisKeyUI
    import PolarisKeyUICore
    import XCTest

    @MainActor
    final class KitGateExtrasTests: XCTestCase {
        private func client() async throws -> PolarisKeyClient {
            try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                    transport: StubServer().transport, expectedServices: [.license, .identity],
                    fingerprint: false))
        }

        func testHostActionsDrawOnlyWithAHandler() async throws {
            let model = PolarisKeyGateModel(
                client: try await client(),
                options: KitGateOptions(trial: true, restore: true, enroll: true))
            await model.reload()
            for key in ["welcome.trial", "welcome.restore", "welcome.continueFree"] {
                XCTAssertFalse(model.welcome.shows(key), "\(key) without a handler")
            }
            model.handlers = KitGateHandlers(trial: {}, continueFree: {})
            XCTAssertTrue(model.welcome.shows("welcome.trial"))
            XCTAssertTrue(model.welcome.shows("welcome.continueFree"))
            XCTAssertFalse(model.welcome.shows("welcome.restore"))
            model.handlers = KitGateHandlers(restore: {})
            XCTAssertTrue(model.welcome.shows("welcome.restore"))
            XCTAssertFalse(model.welcome.shows("welcome.trial"))
        }

        func testAHandlerAloneDoesNotTurnTheOptionOn() async throws {
            let model = PolarisKeyGateModel(
                client: try await client(), handlers: KitGateHandlers(trial: {}))
            await model.reload()
            XCTAssertFalse(model.welcome.shows("welcome.trial"), "the build must also offer it")
        }

        func testACopiedToastIsReplacedAndOnlyItsOwnTimerClearsIt() {
            let model = PolarisKeyGateModel(preview: KitInputs())
            XCTAssertNil(model.toast)
            model.offlineCodeCopied()
            let first = model.toast
            XCTAssertEqual(first?.kind, .copied)
            XCTAssertEqual(first?.line.key, "common.copied")
            model.linkCopied()
            let second = model.toast
            XCTAssertNotEqual(first?.id, second?.id)
            model.dismissToast(first!.id)
            XCTAssertNotNil(model.toast, "the first toast's timer must not clear the second")
            model.dismissToast(second!.id)
            XCTAssertNil(model.toast)
        }

        func testLaterRemembersTheDismissal() {
            let model = PolarisKeyGateModel(preview: KitInputs())
            XCTAssertFalse(model.updateDismissed)
            model.deferUpdate()
            XCTAssertTrue(model.updateDismissed)
        }

        func testNotesAreAtMostThreePlainLines() {
            XCTAssertEqual(
                KitUpdateFacts.notes(summary: "- Faster sync\n\n* Fewer prompts\n• Fixes\n# Extra"),
                ["Faster sync", "Fewer prompts", "Fixes"])
            XCTAssertEqual(KitUpdateFacts.notes(summary: nil), [])
            XCTAssertEqual(KitUpdateFacts.notes(summary: "  \n "), [])
        }

        func testTheChangelogEntryIsFoundByVersion() {
            let entries = [
                ChangelogEntry(
                    version: "2.5.0", tag: "v2.5.0", date: nil, summary: "New", url: "https://x/2.5.0"),
                ChangelogEntry(
                    version: "2.4.1", tag: "v2.4.1", date: nil, summary: nil, url: "https://x/2.4.1"),
            ]
            XCTAssertEqual(KitUpdateFacts.entry(for: "v2.4.1", in: entries)?.url, "https://x/2.4.1")
            XCTAssertEqual(KitUpdateFacts.entry(for: "2.5.0", in: entries)?.summary, "New")
            XCTAssertNil(KitUpdateFacts.entry(for: "3.0.0", in: entries))
        }
    }
#endif
