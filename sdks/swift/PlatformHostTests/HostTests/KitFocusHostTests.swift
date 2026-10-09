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
        // The refused-key test takes 137 s on a loaded CI simulator, past run.sh's 120 s default
        // allowance (xcodebuild then kills the runner and exits 65 though every test passed).
        // XCTest rounds this up to whole minutes.
        nonisolated override var executionTimeAllowance: TimeInterval { 300 }

        struct Harness: View {
            @State var key: String
            var error: String?
            var manage: String?
            var preset: PolarisBranding
            var dts: DynamicTypeSize = .large
            var body: some View {
                PolarisGateSurface(
                    status: .needsActivation, allowedRange: nil, isWorking: false,
                    lastError: error, manageURL: manage, licenseKey: $key,
                    theme: PolarisTheme(copy: PolarisCopy(productName: "Tidewater Studio")),
                    onSignIn: {}, onActivate: { _ in }, onRefresh: {}, onActivateOffline: {},
                    content: { Text("App") }
                )
                .polarisKeyBranding(preset)
                .environment(\.dynamicTypeSize, dts)
            }
        }

        /// A real full-screen window on the simulator's own scene (so the software keyboard
        /// overlaps it as it does in an app); optionally rotated to landscape first.
        private func fullScreenCheck(
            _ name: String, preset: PolarisBranding, landscape: Bool, dts: DynamicTypeSize
        ) {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene }).first
            else { return XCTFail("\(name): the hosted app has no scene") }
            if landscape {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { _ in }
                wait(1.5)
            }
            defer {
                if landscape {
                    scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in }
                    wait(1.5)
                }
            }
            final class Box: @unchecked Sendable { var frame = CGRect.zero }
            let box = Box()
            let obs = NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main
            ) { n in
                box.frame =
                    (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
                    ?? .zero
            }
            defer { NotificationCenter.default.removeObserver(obs) }
            let window = UIWindow(windowScene: scene)
            window.frame = scene.coordinateSpace.bounds
            let limit = ErrorCopy.message(ErrorCode.deviceLimit)
            window.rootViewController = UIHostingController(
                rootView: Harness(
                    key: Self.key, error: limit,
                    manage: "https://key.plrs.im/portal/tidewater/devices", preset: preset,
                    dts: dts))
            window.makeKeyAndVisible()
            wait(1.2)
            guard let field = live(window) else {
                window.isHidden = true
                return XCTFail("\(name): no live key field")
            }
            XCTAssertTrue(field.becomeFirstResponder(), "\(name): the field takes focus")
            wait(1.5)
            XCTAssertNotEqual(box.frame, .zero, "\(name): the keyboard showed")
            func above(_ when: String) {
                let rect = field.convert(field.bounds, to: window)
                XCTAssertLessThanOrEqual(
                    rect.maxY, box.frame.minY + 0.5,
                    "\(name): the field \(rect.integral) is under the keyboard \(box.frame.integral) \(when)")
                XCTAssertGreaterThanOrEqual(rect.minY, -0.5, "\(name): the field is above the screen \(when)")
            }
            above("after focus")
            // The first keystroke clears the refusal callout and used to flip the page's fit,
            // sliding the field behind the keyboard.
            field.insertText("X")
            wait(1.2)
            XCTAssertTrue(live(window) === field && field.isFirstResponder, "\(name): same field")
            above("after the first keystroke")
            field.insertText("Y")
            wait(0.6)
            above("after the second keystroke")
            field.resignFirstResponder()
            wait(0.5)
            window.isHidden = true
            window.rootViewController = nil
        }

        /// The field stays above the keyboard after the first keystroke, portrait and landscape,
        /// at the default and the smallest Dynamic Type, native and Polaris.
        func testTheFieldStaysAboveTheKeyboardAfterTheFirstKeystroke() {
            for landscape in [false, true] {
                for dts in [DynamicTypeSize.large, .xSmall] {
                    for preset in [PolarisBranding.native, .polarisKey] {
                        fullScreenCheck(
                            "\(landscape ? "land" : "port")-\(dts)-\(preset)", preset: preset,
                            landscape: landscape, dts: dts)
                    }
                }
            }
        }

        static let key = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA"

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
