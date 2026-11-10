// @pkey-feature ui.kit
// The Cloud Sync "Sync stopped." row (SwiftUI): it lays out with its Sign in to sync button at
// every text size and in both schemes (the button drops under the words at accessibility sizes),
// and the row's one line keeps its height whether or not the button is there.
#if os(macOS)
    import AppKit
    import PolarisKeyUI
    import PolarisKeyUICore
    import SwiftUI
    import XCTest

    final class CloudSyncStoppedTests: XCTestCase {
        @MainActor private func fitted(
            _ model: CloudSyncStatusModel, size: DynamicTypeSize, scheme: ColorScheme
        ) -> CGSize {
            let host = NSHostingView(
                rootView: List { Section { CloudSyncStatusView(model: model) } }
                    .environment(\.dynamicTypeSize, size)
                    .environment(\.colorScheme, scheme)
                    .frame(width: 420, height: 400))
            host.frame = NSRect(x: 0, y: 0, width: 420, height: 400)
            host.layoutSubtreeIfNeeded()
            return host.fittingSize
        }

        @MainActor private func model(signIn: (@MainActor () -> Void)?) -> CloudSyncStatusModel {
            var inputs = KitInputs()
            inputs.cloudSync = KitCloudSync(state: .error, signedIn: false)
            return CloudSyncStatusModel(
                inputs: inputs, onUnlock: {}, onReview: {}, onSignIn: signIn)
        }

        @MainActor func testSyncStoppedLaysOutWithItsButtonAtEverySize() {
            let stopped = model(signIn: {})
            XCTAssertEqual(stopped.screen.copy.first?.key, "cloudSync.syncStopped")
            XCTAssertEqual(stopped.screen.copy.map(\.key).sorted(), ["cloudSync.signIn", "cloudSync.syncStopped"])
            for size in [DynamicTypeSize.large, .accessibility3, .accessibility5] {
                for scheme in [ColorScheme.dark, .light] {
                    let with = fitted(stopped, size: size, scheme: scheme)
                    XCTAssertGreaterThan(with.height, 0, "\(size) \(scheme)")
                }
            }
        }

        @MainActor func testTheRowKeepsOneLineWithAndWithoutTheButton() {
            let with = fitted(model(signIn: {}), size: .large, scheme: .light)
            let without = fitted(model(signIn: nil), size: .large, scheme: .light)
            // The button sits on the label's line (a 44 pt minimum row either way).
            XCTAssertEqual(with.height, without.height, accuracy: 1)
        }
    }
#endif
