// @pkey-feature ui.kit
//
// The SwiftUI kit's license-key field in a REAL scene with the real software keyboard (the hosted
// app gives a UIWindowScene; `swift test` has none). It types into a key that was just refused
// with `device_limit` (the first keystroke clears the error callout, which changes the page's
// height), at the phone sizes whose height crosses the tall/compressed threshold, and asserts the
// SAME UITextField stays first responder: focusing or typing must never rebuild the field.
#if canImport(UIKit)
    import SwiftUI
    import UIKit
    import XCTest

    import PolarisKey
    import PolarisKeyCore
    @testable import PolarisKeyUI

    @MainActor
    final class KitFocusHostTests: XCTestCase {
        struct Harness: View {
            @State var key: String
            var error: String?
            var manage: String?
            var preset: PolarisBranding
            var body: some View {
                PolarisGateSurface(
                    status: .needsActivation, allowedRange: nil, isWorking: false,
                    lastError: error, manageURL: manage, licenseKey: $key,
                    theme: PolarisTheme(copy: PolarisCopy(productName: "Tidewater Studio")),
                    onSignIn: {}, onActivate: { _ in }, onRefresh: {}, onActivateOffline: {},
                    content: { Text("App") }
                )
                .polarisKeyBranding(preset)
            }
        }

        private func wait(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }

        private func fields(in v: UIView) -> [UITextField] {
            var out: [UITextField] = []
            if let f = v as? UITextField { out.append(f) }
            for s in v.subviews { out += fields(in: s) }
            return out
        }

        private func live(_ v: UIView) -> UITextField? {
            fields(in: v).first { f in
                var cur: UIView? = f
                while let c = cur {
                    if c.isHidden || c.alpha < 0.01 { return false }
                    cur = c.superview
                }
                return f.window != nil && f.isEnabled
            }
        }

        private func run(
            _ name: String, size: CGSize, key: String, refused: Bool, preset: PolarisBranding,
            typing: String
        ) {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene }).first
            else { return XCTFail("\(name): the hosted app has no scene") }
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(origin: .zero, size: size)
            let limit = ErrorCopy.message(ErrorCode.deviceLimit)
            window.rootViewController = UIHostingController(
                rootView: Harness(
                    key: key, error: refused ? limit : nil,
                    manage: refused ? "https://key.plrs.im/portal/tidewater/devices" : nil,
                    preset: preset))
            window.makeKeyAndVisible()
            wait(1.0)
            guard let field = live(window) else {
                window.isHidden = true
                return XCTFail("\(name): no live key field")
            }
            XCTAssertTrue(field.becomeFirstResponder(), "\(name): the field takes focus")
            wait(1.2)
            XCTAssertTrue(
                field.isFirstResponder && live(window) === field,
                "\(name): focus kept on the same field after the keyboard appeared")
            for ch in typing {
                field.insertText(String(ch))
                wait(0.25)
            }
            wait(1.0)
            XCTAssertTrue(live(window) === field, "\(name): typing did not rebuild the field")
            XCTAssertTrue(field.isFirstResponder, "\(name): typing kept first responder")
            XCTAssertTrue((field.text ?? "").hasSuffix(typing), "\(name): the keystrokes landed")
            field.resignFirstResponder()
            wait(0.5)
            window.isHidden = true
            window.rootViewController = nil
        }

        private static let key = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA"

        /// 390 x 844 (iPhone 16e / 17e) and 402 x 874 (17 Pro): the sizes where the refused page
        /// sits near the tall/compressed threshold; plus the small and large extremes.
        func testTypingIntoARefusedKeyKeepsTheSameField() {
            let sizes: [(String, CGSize)] = [
                ("390x844", CGSize(width: 390, height: 844)),
                ("402x874", CGSize(width: 402, height: 874)),
                ("375x667", CGSize(width: 375, height: 667)),
                ("440x956", CGSize(width: 440, height: 956)),
            ]
            // The refused page's fit crosses the tall/compressed threshold (typing clears the
            // error callout, ~120 pt of height) at some container height; sweep heights at the
            // common phone width so the crossing is certain to be exercised, whatever the
            // device's safe areas and Dynamic Type make of it.
            for height in stride(from: 640, through: 960, by: 16) {
                run(
                    "390x\(height)-sweep", size: CGSize(width: 390, height: CGFloat(height)),
                    key: Self.key, refused: true, preset: .native, typing: "X")
            }
            for (label, size) in sizes {
                for preset in [PolarisBranding.native, .polarisKey] {
                    run("\(label)-refused-\(preset)", size: size, key: Self.key, refused: true,
                        preset: preset, typing: "X")
                }
                run("\(label)-empty", size: size, key: "", refused: false, preset: .native,
                    typing: "pkey_")
            }
        }
    }
#endif
