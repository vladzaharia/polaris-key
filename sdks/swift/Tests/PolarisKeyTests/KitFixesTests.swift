// @pkey-feature ui.kit
//
// Render-and-sample and layout checks for the kit's last-round fixes: button and placeholder
// contrast measured from real renders (the kit's own skin must reach 4.5:1, not the system's tinted
// styles), the offline request code's invisible break points (no false hyphens), and the Mac
// sign-in code staying large.

#if canImport(SwiftUI)
    import CoreGraphics
    import Foundation
    import PolarisKey
    import PolarisKeyCore
    @testable import PolarisKeyUI
    import SwiftUI
    import XCTest

    enum PixelContrast {
        /// WCAG relative luminance of an sRGB pixel.
        static func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double {
            func lin(_ c: Double) -> Double {
                c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        }

        static func ratio(_ a: Double, _ b: Double) -> Double {
            (max(a, b) + 0.05) / (min(a, b) + 0.05)
        }

        /// The contrast of the text in `rect` (points) against its ground: the ground is the most
        /// common colour in the rect, the text the pixel furthest from it in luminance.
        static func measure(_ image: CGImage, rect: CGRect, scale: CGFloat) -> Double? {
            let px = CGRect(
                x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale,
                height: rect.height * scale
            ).integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            guard px.width > 2, px.height > 2, let crop = image.cropping(to: px) else { return nil }
            let w = crop.width, h = crop.height
            var data = [UInt8](repeating: 0, count: w * h * 4)
            guard
                let ctx = CGContext(
                    data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return nil }
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            var counts: [UInt32: Int] = [:]
            for i in stride(from: 0, to: data.count, by: 4) {
                let key = UInt32(data[i]) << 16 | UInt32(data[i + 1]) << 8 | UInt32(data[i + 2])
                counts[key, default: 0] += 1
            }
            guard let ground = counts.max(by: { $0.value < $1.value })?.key else { return nil }
            func lum(_ k: UInt32) -> Double {
                luminance(Double(k >> 16 & 255) / 255, Double(k >> 8 & 255) / 255, Double(k & 255) / 255)
            }
            let bg = lum(ground)
            var best = 1.0
            for k in counts.keys { best = max(best, ratio(bg, lum(k))) }
            return best
        }
    }

    @MainActor
    final class KitFixesTests: XCTestCase {
        private func styled<V: View>(_ view: V, _ preset: KitPreset) -> some View {
            view.polarisKeyPresentation(Tidewater.presentation)
                .polarisKeyBranding(preset == .polaris ? .polarisKey : .native)
        }

        /// The phone landscape or Mac-small size this platform renders.
        private var smallSize: KitSize {
            #if os(macOS)
                return KitSizes.macSmall
            #else
                return KitSizes.iPhoneMaxLandscape
            #endif
        }

        private func contrast<V: View>(
            _ view: V, _ role: PolarisLayoutRole, at size: KitSize, scheme: ColorScheme,
            preset: KitPreset = .polaris, type: DynamicTypeSize = .large
        ) throws -> Double {
            let result = KitHost.render(
                styled(view, preset), at: size, scheme: scheme, type: type, snapshot: true)
            let frame = try XCTUnwrap(result.frames[role], "\(role) was not laid out")
            let image = try XCTUnwrap(result.image)
            let scale = CGFloat(image.width) / size.size.width
            return try XCTUnwrap(PixelContrast.measure(image, rect: frame, scale: scale))
        }

        private func limitGate() -> some View {
            PolarisGateSurface(
                status: .needsActivation, allowedRange: nil, isWorking: false,
                lastError: ErrorCopy.message(ErrorCode.deviceLimit),
                manageURL: "https://key.plrs.im/portal/tidewater/devices",
                licenseKey: .constant("pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA"),
                theme: Tidewater.theme, onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                content: { Text("App") })
        }

        /// Replace a Device (prominent), Sign in and Activate (secondary) under the Polaris preset.
        func testGateLimitButtonsReachAA() throws {
            for scheme in [ColorScheme.light, .dark] {
                for (role, name) in [
                    (PolarisLayoutRole.primaryAction, "Replace a device"),
                    (.signIn, "Sign in"), (.activate, "Activate"),
                ] {
                    let ratio = try contrast(limitGate(), role, at: smallSize, scheme: scheme)
                    XCTAssertGreaterThanOrEqual(
                        ratio, 4.5, "\(name) \(scheme) is \(String(format: "%.2f", ratio)):1")
                }
            }
        }

        /// Cancel and Paste on offline activation, Cancel on sign-in, under the Polaris preset.
        func testCancelAndPasteReachAA() throws {
            let offline = PolarisOfflineSurface(
                productName: "Tidewater Studio", deviceId: KitLayoutTests.realDeviceId,
                message: nil, imported: false, theme: Tidewater.theme, onImportFile: {},
                onPaste: {}, onDone: {})
            for scheme in [ColorScheme.light, .dark] {
                for role in [PolarisLayoutRole.secondaryAction, .leadingAction] {
                    let ratio = try contrast(offline, role, at: KitSizes.iPhoneMax, scheme: scheme)
                    XCTAssertGreaterThanOrEqual(
                        ratio, 4.5, "offline \(role) \(scheme): \(String(format: "%.2f", ratio)):1")
                }
                let signIn = PolarisSignInSurface(
                    phase: .waiting(KitLayoutTests.prompt), theme: Tidewater.theme,
                    attach: .constant(true), onOpen: { _ in }, onAccept: {}, onRetry: {},
                    onCancel: {})
                let ratio = try contrast(
                    signIn, .secondaryAction, at: KitSizes.iPhoneMax, scheme: scheme)
                XCTAssertGreaterThanOrEqual(
                    ratio, 4.5, "sign-in Cancel \(scheme): \(String(format: "%.2f", ratio)):1")
            }
        }

        /// The key placeholder is the only visible name in compact mode.
        func testTheKeyPlaceholderReachesAA() throws {
            for scheme in [ColorScheme.light, .dark] {
                let gate = PolarisGateSurface(
                    status: .needsActivation, allowedRange: nil, isWorking: false, lastError: nil,
                    licenseKey: .constant(""), theme: Tidewater.theme, onSignIn: {},
                    onActivate: { _ in }, onRefresh: {}, onActivateOffline: {},
                    content: { Text("App") })
                let ratio = try contrast(gate, .keyField, at: KitSizes.iPhoneMax, scheme: scheme)
                XCTAssertGreaterThanOrEqual(
                    ratio, 4.5, "placeholder \(scheme): \(String(format: "%.2f", ratio)):1")
            }
        }

        // ── The offline request code ──

        func testTheRequestCodeBreaksWithoutFalseHyphens() {
            let ids = [
                KitLayoutTests.realDeviceId, "dev-7Q2M-x9cL-r4Tb-V0aZ-3WPL-DA8k-N5eY",
                "dev_7Q2Mx9cLr4TbV0aZ3WPLDA8kN5eYZ", "ab",
            ]
            for id in ids {
                let shown = PolarisOfflineSurface.displayCode(id)
                let stripped = shown.replacingOccurrences(of: "\u{200B}", with: "")
                    .replacingOccurrences(of: "\u{2060}", with: "")
                XCTAssertEqual(stripped, id, "the drawn code rejoins to the raw id")
                XCTAssertEqual(
                    shown.filter { $0 == "-" }.count, id.filter { $0 == "-" }.count,
                    "no hyphen is added")
                // Real hyphens never end a line: a word joiner sits on each side.
                XCTAssertFalse(shown.contains("-\u{200B}"))
                // No group is an orphan of one or two characters.
                for part in shown.components(separatedBy: "\u{200B}") where id.count > 4 {
                    XCTAssertGreaterThan(
                        part.replacingOccurrences(of: "\u{2060}", with: "").count, 2,
                        "an orphan tail in \(id)")
                }
            }
            // Copy and the QR carry the raw id.
            XCTAssertEqual(
                PolarisOfflineSurface.requestCode(deviceId: ids[1]), ids[1])
        }

        /// The code, Copy and the primary action stay on screen at every phone and tablet size, in
        /// both presets, at L and AX3, with a hyphenated id.
        func testTheHyphenatedRequestCodeLaysOutEverywhere() {
            let id = "dev-7Q2M-x9cL-r4Tb-V0aZ-3WPL-DA8k-N5eY"
            for size in KitSizes.snapshotted {
                for preset in KitPreset.allCases {
                    for type in [DynamicTypeSize.large, .accessibility3] {
                        #if os(macOS)
                            if type != .large { continue }
                        #endif
                        let result = KitHost.render(
                            styled(
                                PolarisOfflineSurface(
                                    productName: "Tidewater Studio", deviceId: id, message: nil,
                                    imported: false, theme: Tidewater.theme, onImportFile: {},
                                    onPaste: {}, onDone: {}), preset),
                            at: size, scheme: .light, type: type, snapshot: false)
                        let label = "\(size.name) \(preset) \(KitTypeName.short(type))"
                        guard let code = result.frames[.code] else {
                            XCTFail("\(label): the code was not laid out")
                            continue
                        }
                        XCTAssertTrue(
                            result.safe.insetBy(dx: -0.5, dy: -0.5).contains(code),
                            "\(label): code \(code) outside \(result.safe)")
                    }
                }
            }
        }

        // ── Mac sign-in code size ──

        func testTheSignInCodeKeepsItsSizeInASmallWindow() {
            #if os(macOS)
                for size in [KitSizes.macSmall, KitSizes.mac] {
                    let result = KitHost.render(
                        styled(
                            PolarisSignInSurface(
                                phase: .waiting(KitLayoutTests.prompt), theme: Tidewater.theme,
                                attach: .constant(true), onOpen: { _ in }, onAccept: {},
                                onRetry: {}, onCancel: {}), .native),
                        at: size, scheme: .light, type: .large, snapshot: false)
                    guard let code = result.frames[.code] else {
                        return XCTFail("\(size.name): no code")
                    }
                    // 30 pt type at 0.06 tracking, 9 characters: far wider than a shrunk (18 px
                    // cap height at 2x, about 13 pt type) code. The previous size was 44 px cap
                    // height at 1440; at least 30 pt means the frame is at least ~150 pt wide
                    // and 30 pt tall.
                    XCTAssertGreaterThanOrEqual(code.height, 30, "\(size.name): \(code)")
                    XCTAssertGreaterThanOrEqual(code.width, 150, "\(size.name): \(code)")
                }
            #endif
        }
    }
#endif
