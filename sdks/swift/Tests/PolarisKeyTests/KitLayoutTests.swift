// @pkey-feature ui.kit
//
// The SwiftUI kit's responsive layouts: device-code sign-in, the gate's Welcome and offline
// activation, hosted in a real NSHostingView (macOS) or UIHostingController (iOS simulator) at
// phone, tablet and Mac sizes, at Dynamic Type L and AX3, in the native and the Polaris Key
// presets. Each render asserts that the user code and the primary action (and the gate's Activate)
// sit inside the visible, safe area at scroll offset zero: on screen without scrolling.
//
// `swift test` runs it on macOS. The iPhone and iPad sizes are meant for the iOS simulator, where
// Dynamic Type scales the type:
//
//   xcodebuild test -scheme PolarisKey-Package -destination 'platform=iOS Simulator,name=…' \
//     -only-testing:PolarisKeyTests/KitLayoutTests
//
// With PKEY_KIT_SNAPSHOTS=<dir> (TEST_RUNNER_PKEY_KIT_SNAPSHOTS under xcodebuild) each render at
// the platform's own sizes (Mac windows on macOS, phones and tablets on iOS) is also written to
// <dir>/swiftui.<screen>/<size>[-ax3]-<preset>-<scheme>.png, dark and light.

#if canImport(SwiftUI)
    import Foundation
    import ImageIO
    import PolarisKey
    import PolarisKeyCore
    import PolarisKeyIdentity
    @testable import PolarisKeyUI
    import SwiftUI
    import UniformTypeIdentifiers
    import XCTest

    #if canImport(UIKit)
        import UIKit
    #elseif canImport(AppKit)
        import AppKit
    #endif

    /// One screen size, with the safe-area insets the device puts around it.
    struct KitSize: Sendable {
        let name: String
        let size: CGSize
        var insets = EdgeInsets()
    }

    enum KitSizes {
        static let iPhoneSE = KitSize(
            name: "iphone-se-375x667", size: CGSize(width: 375, height: 667),
            insets: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0))
        static let iPhoneSELandscape = KitSize(
            name: "iphone-se-667x375", size: CGSize(width: 667, height: 375))
        static let iPhoneMax = KitSize(
            name: "iphone-440x956", size: CGSize(width: 440, height: 956),
            insets: EdgeInsets(top: 62, leading: 0, bottom: 34, trailing: 0))
        static let iPhoneMaxLandscape = KitSize(
            name: "iphone-956x440", size: CGSize(width: 956, height: 440),
            insets: EdgeInsets(top: 0, leading: 62, bottom: 21, trailing: 62))
        static let iPad = KitSize(
            name: "ipad-1024x1366", size: CGSize(width: 1024, height: 1366),
            insets: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0))
        static let iPadLandscape = KitSize(
            name: "ipad-1366x1024", size: CGSize(width: 1366, height: 1024),
            insets: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0))
        static let macSmall = KitSize(name: "mac-480x520", size: CGSize(width: 480, height: 520))
        static let mac = KitSize(name: "mac-900x640", size: CGSize(width: 900, height: 640))
        static let macLarge = KitSize(name: "mac-1440x900", size: CGSize(width: 1440, height: 900))

        static let phonesAndTablets = [
            iPhoneSE, iPhoneSELandscape, iPhoneMax, iPhoneMaxLandscape, iPad, iPadLandscape,
        ]
        static let macs = [macSmall, mac, macLarge]
        static let all = phonesAndTablets + macs
        /// The sizes this platform writes snapshots for: Mac windows on macOS, phones and tablets
        /// on the iOS simulator (each platform's own controls and type).
        #if os(macOS)
            static let snapshotted = macs
        #else
            static let snapshotted = phonesAndTablets
        #endif
    }

    /// The two presets the kit ships: native (the default) and the Polaris Key look.
    enum KitPreset: String, CaseIterable, Sendable {
        case native
        case polaris
    }

    @MainActor
    final class KitFrameBox {
        var frames: [PolarisLayoutRole: CGRect] = [:]
        func store(_ frames: [PolarisLayoutRole: CGRect]) -> Bool {
            self.frames = frames
            return true
        }
    }

    /// Hosts a view in a real window at one size and reports where the probed elements landed.
    @MainActor
    enum KitHost {
        struct Result {
            var frames: [PolarisLayoutRole: CGRect]
            /// The area content may use: the window less the device's safe-area insets.
            var safe: CGRect
            var image: CGImage?
        }

        static func render<V: View>(
            _ view: V, at kitSize: KitSize, scheme: ColorScheme, type: DynamicTypeSize,
            snapshot: Bool
        ) -> Result {
            let box = KitFrameBox()
            let size = kitSize.size
            let insets = kitSize.insets
            let root = view
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, type)
                .safeAreaPadding(insets)
                .overlayPreferenceValue(PolarisLayoutProbeKey.self) { anchors in
                    GeometryReader { proxy in
                        let _ = box.store(anchors.mapValues { proxy[$0] })
                        Color.clear
                    }
                    .ignoresSafeArea()
                }
                .frame(width: size.width, height: size.height)
            let safe = CGRect(
                x: insets.leading, y: insets.top,
                width: size.width - insets.leading - insets.trailing,
                height: size.height - insets.top - insets.bottom)
            #if canImport(UIKit)
                let controller = UIHostingController(rootView: root)
                controller.safeAreaRegions = []
                controller.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
                controller.traitOverrides.preferredContentSizeCategory =
                    type == .accessibility3 ? .accessibilityExtraLarge : .large
                let scene = UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }.first
                let window =
                    scene.map { UIWindow(windowScene: $0) }
                    ?? UIWindow(frame: CGRect(origin: .zero, size: size))
                window.frame = CGRect(origin: .zero, size: size)
                window.overrideUserInterfaceStyle = controller.overrideUserInterfaceStyle
                window.rootViewController = controller
                window.isHidden = false
                controller.view.frame = window.bounds
                controller.view.setNeedsLayout()
                controller.view.layoutIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.12))
                controller.view.layoutIfNeeded()
                var image: CGImage?
                if snapshot {
                    let format = UIGraphicsImageRendererFormat()
                    format.scale = 2
                    image = UIGraphicsImageRenderer(bounds: controller.view.bounds, format: format)
                        .image { context in
                            controller.view.layer.render(in: context.cgContext)
                        }.cgImage
                }
                window.isHidden = true
                window.rootViewController = nil
                return Result(frames: box.frames, safe: safe, image: image)
            #else
                let host = NSHostingView(rootView: root.environment(\.controlActiveState, .key))
                host.frame = CGRect(origin: .zero, size: size)
                let window = KitKeyWindow(
                    contentRect: host.frame, styleMask: [.borderless], backing: .buffered,
                    defer: false)
                window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
                window.contentView = host
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.12))
                host.layoutSubtreeIfNeeded()
                var image: CGImage?
                if snapshot, let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                    host.cacheDisplay(in: host.bounds, to: rep)
                    image = rep.cgImage
                }
                window.contentView = nil
                return Result(frames: box.frames, safe: safe, image: image)
            #endif
        }

        static func writePNG(_ image: CGImage, to url: URL) {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard
                let destination = CGImageDestinationCreateWithURL(
                    url as CFURL, UTType.png.identifier as CFString, 1, nil)
            else { return }
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
        }
    }

    #if os(macOS)
        /// A window that draws as the key window, so a snapshot shows the active look (an
        /// inactive window greys the prominent button).
        final class KitKeyWindow: NSWindow {
            override var isKeyWindow: Bool { true }
            override var isMainWindow: Bool { true }
            override var canBecomeKey: Bool { true }
        }
    #endif

    /// The Tidewater Studio fixture (UI-KITS §1.2): a teal icon with a sun over two waves, its
    /// accent and developer, served as a presentation would be.
    @MainActor
    enum Tidewater {
        static let name = "Tidewater Studio"

        private static var renderedIcon: Data?

        /// The icon as PNG bytes, as a presentation carries it.
        static var iconPNG: Data {
            if let renderedIcon { return renderedIcon }
            let data = renderIcon()
            renderedIcon = data
            return data
        }

        private static func renderIcon() -> Data {
            let icon = ZStack {
                LinearGradient(
                    colors: [BrandColor(hex: 0x0E3A44).color, BrandColor(hex: 0x0A2A33).color],
                    startPoint: .top, endPoint: .bottom)
                Circle().fill(BrandColor(hex: 0xF4D28A).color)
                    .frame(width: 44, height: 44).offset(x: 34, y: -36)
                Wave().stroke(BrandColor(hex: 0x5FE0CB).color, lineWidth: 14).offset(y: 18)
                Wave().stroke(BrandColor(hex: 0x8FC9C0).color, lineWidth: 14).offset(y: 46)
            }
            .frame(width: 180, height: 180)
            let renderer = ImageRenderer(content: icon)
            renderer.scale = 1
            let data = NSMutableData()
            guard let image = renderer.cgImage,
                let destination = CGImageDestinationCreateWithData(
                    data as CFMutableData, UTType.png.identifier as CFString, 1, nil)
            else { return Data() }
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
            return data as Data
        }

        static var presentation: PolarisProductPresentation {
            PolarisProductPresentation(
                name: name, developerName: "Harbor Audio", accent: "#369186", iconData: iconPNG)
        }

        static let theme = PolarisTheme(copy: PolarisCopy(productName: name))

        struct Wave: Shape {
            func path(in rect: CGRect) -> Path {
                var path = Path()
                let mid = rect.midY
                path.move(to: CGPoint(x: rect.minX - 10, y: mid))
                var x = rect.minX - 10
                while x < rect.maxX + 10 {
                    path.addQuadCurve(
                        to: CGPoint(x: x + 30, y: mid), control: CGPoint(x: x + 15, y: mid - 14))
                    path.addQuadCurve(
                        to: CGPoint(x: x + 60, y: mid), control: CGPoint(x: x + 45, y: mid + 14))
                    x += 60
                }
                return path
            }
        }
    }

    @MainActor
    final class KitLayoutTests: XCTestCase {
        let snapshots = ProcessInfo.processInfo.environment["PKEY_KIT_SNAPSHOTS"]

        static let prompt = SignInPrompt(
            deviceCode: "dc", userCode: "WDJB-MJHT", verificationUri: "https://key.plrs.im/device",
            verificationUriComplete: "https://key.plrs.im/device?user_code=WDJB-MJHT",
            expiresIn: 600, interval: 5, expiresAt: Int(Date().timeIntervalSince1970) + 252)

        /// The sizes this platform runs: everything (the Mac sizes are windows on macOS, and a
        /// phone-sized window is still a window), with the iPhone and iPad sizes meaningful for
        /// Dynamic Type on the iOS simulator.
        var sizes: [KitSize] { KitSizes.all }

        private func styled<V: View>(_ view: V, _ preset: KitPreset) -> some View {
            view
                .polarisKeyPresentation(Tidewater.presentation)
                .polarisKeyBranding(preset == .polaris ? .polarisKey : .native)
        }

        /// Render `make()` at every size, type size and preset, asserting `roles` are on screen.
        private func check<V: View>(
            screen: String, roles: [PolarisLayoutRole], sizes: [KitSize],
            types: [DynamicTypeSize] = [.large, .accessibility3],
            _ make: () -> V
        ) {
            for size in sizes {
                for type in types {
                    for preset in KitPreset.allCases {
                        for scheme in snapshots == nil ? [ColorScheme.dark] : [.dark, .light] {
                            let result = KitHost.render(
                                styled(make(), preset), at: size, scheme: scheme, type: type,
                                snapshot: snapshots != nil)
                            let label =
                                "\(screen) \(size.name) \(type == .large ? "L" : "AX3") \(preset)"
                            for role in roles {
                                guard let frame = result.frames[role] else {
                                    XCTFail("\(label): \(role) was not laid out")
                                    continue
                                }
                                XCTAssertFalse(frame.isEmpty, "\(label): \(role) is empty")
                                XCTAssertTrue(
                                    result.safe.insetBy(dx: -0.5, dy: -0.5).contains(frame),
                                    "\(label): \(role) at \(frame) is outside \(result.safe)")
                            }
                            if let dir = snapshots, let image = result.image,
                                KitSizes.snapshotted.contains(where: { $0.name == size.name })
                            {
                                let typeSuffix = type == .large ? "" : "-ax3"
                                let schemeName = scheme == .dark ? "dark" : "light"
                                let file =
                                    "\(size.name)\(typeSuffix)-\(preset.rawValue)-\(schemeName).png"
                                KitHost.writePNG(
                                    image,
                                    to: URL(fileURLWithPath: dir)
                                        .appendingPathComponent("swiftui.\(screen)")
                                        .appendingPathComponent(file))
                            }
                        }
                    }
                }
            }
        }

        func testDeviceCodeSignInKeepsTheCodeAndOpenBrowserOnScreen() {
            check(screen: "signin", roles: [.code, .primaryAction], sizes: sizes) {
                PolarisSignInSurface(
                    phase: .waiting(Self.prompt), theme: Tidewater.theme, attach: .constant(true),
                    onOpen: { _ in }, onAccept: {}, onRetry: {}, onCancel: {})
            }
        }

        func testTheGateKeepsSignInAndActivateOnScreen() {
            check(screen: "gate", roles: [.primaryAction, .activate], sizes: sizes) {
                PolarisGateSurface(
                    status: .needsActivation, allowedRange: nil, isWorking: false,
                    lastError: nil, licenseKey: .constant(""), theme: Tidewater.theme,
                    onSignIn: {}, onActivate: { _ in }, onRefresh: {}, onActivateOffline: {},
                    content: { Text("App") })
            }
        }

        /// A refused key: the key stays on one line (middle-truncated) and Activate stays on
        /// screen above the refusal and Replace a device.
        func testTheDeviceLimitKeepsActivateOnScreen() {
            check(
                screen: "gate-limit", roles: [.primaryAction, .activate],
                sizes: [KitSizes.iPhoneSE, KitSizes.iPhoneMaxLandscape, KitSizes.macSmall],
                types: [.large]
            ) {
                PolarisGateSurface(
                    status: .needsActivation, allowedRange: nil, isWorking: false,
                    lastError: ErrorCopy.message(ErrorCode.deviceLimit),
                    manageURL: "https://key.plrs.im/portal/tidewater/devices",
                    licenseKey: .constant("pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA"),
                    theme: Tidewater.theme, onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                    content: { Text("App") })
            }
        }

        func testOfflineActivationKeepsImportOnScreen() {
            check(
                screen: "offline", roles: [.primaryAction],
                sizes: [
                    KitSizes.iPhoneSE, KitSizes.iPhoneSELandscape, KitSizes.macSmall, KitSizes.mac,
                ],
                types: [.large]
            ) {
                PolarisOfflineSurface(
                    product: "tidewater", deviceId: "dev_7Q2Mx9cLr4TbV0aZ", message: nil,
                    imported: false, copied: false, theme: Tidewater.theme, onCopy: {},
                    onImportFile: {}, onPaste: {}, onDone: {})
            }
        }

        // ── The rules behind the layouts ──

        func testTheLayoutFollowsTheSpaceNotTheDevice() {
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 375, height: 667)), [.column])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 667, height: 375)),
                [.column, .sideBySide])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 480, height: 520)), [.column])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 900, height: 640)), [.split])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 1024, height: 1366)), [.split])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 956, height: 440)),
                [.column, .sideBySide])
        }

        /// SIGN-IN.md D-67: no QR on a phone, tablet or Mac; it is for TV screens only.
        func testTheCodeViewShowsNoQRCodeOffTV() {
            XCTAssertFalse(PolarisSignInSurface.showsQRCode)
        }

        func testTheCodeViewShowsThePageAsPeopleTypeIt() {
            XCTAssertEqual(
                PolarisSignInSurface.displayURL("https://key.plrs.im/device"), "key.plrs.im/device")
            XCTAssertEqual(
                PolarisSignInSurface.displayURL("HTTP://example.com/tv/"), "example.com/tv")
        }

        /// UI-KITS §1.2: the integrator's theme, then the presentation, then the bundle; with no
        /// icon anywhere, a monogram, never a Polaris Key mark.
        func testIdentityResolvesInTheSpecOrder() {
            let bundle = PolarisProductIdentity.Bundled(
                name: "Bundle Name", icon: nil, iconIsMasked: false)
            let bare = PolarisProductIdentity.resolve(
                theme: PolarisTheme(), presentation: nil, bundle: bundle)
            XCTAssertEqual(bare.name, "Bundle Name")
            XCTAssertEqual(PolarisCopy().welcomeTitle(naming: bare.name), "Welcome to Bundle Name")
            XCTAssertEqual(
                PolarisCopy(productName: "Mine").welcomeTitle(naming: "Other"), "Welcome to Mine")
            XCTAssertEqual(
                PolarisCopy(welcomeTitle: "Hello").welcomeTitle(naming: "Other"), "Hello")
            guard case .monogram("B") = bare.icon else {
                return XCTFail("no icon anywhere draws the monogram, got \(bare.icon)")
            }

            let presented = PolarisProductIdentity.resolve(
                theme: PolarisTheme(), presentation: Tidewater.presentation, bundle: bundle)
            XCTAssertEqual(presented.name, "Tidewater Studio")
            XCTAssertEqual(presented.developer, "Harbor Audio")
            guard case .image = presented.icon else {
                return XCTFail("the presentation's icon leads, got \(presented.icon)")
            }

            let integrator = PolarisProductIdentity.resolve(
                theme: PolarisTheme(
                    copy: PolarisCopy(productName: "Mine"),
                    logo: { AnyView(Image(systemName: "leaf.fill")) }),
                presentation: Tidewater.presentation, bundle: bundle)
            XCTAssertEqual(integrator.name, "Mine")
            guard case .custom = integrator.icon else {
                return XCTFail("the integrator's logo wins, got \(integrator.icon)")
            }

            // Branded, with nothing to show, it is still the product's monogram.
            let branded = PolarisProductIdentity.resolve(
                theme: PolarisTheme(branding: .polarisKey), presentation: nil,
                bundle: PolarisProductIdentity.Bundled(
                    name: "aurora", icon: nil, iconIsMasked: false))
            guard case .monogram("A") = branded.icon else {
                return XCTFail("no Pinned K on the gate (UI-KITS §1.6), got \(branded.icon)")
            }
        }

        /// The presentation accent colours the Polaris Key preset, through the contrast resolver;
        /// natively the host's tint leads, and the integrator's accent always wins.
        func testThePresentationAccentAppliesUnderThePolarisKeyPreset() throws {
            let teal = Tidewater.presentation
            let resolved = try XCTUnwrap(PolarisAccent.resolve("#369186", dark: true))
            let branded = PolarisTheme().resolvedPalette(
                for: .dark, branding: .polarisKey, presentation: teal)
            XCTAssertEqual(branded.accent, BrandColor(hexString: resolved.solid)?.color)
            XCTAssertEqual(branded.accentText, BrandColor(hexString: resolved.fg)?.color)
            XCTAssertEqual(branded.onAccent, BrandColor(hexString: resolved.on)?.color)

            let native = PolarisTheme().resolvedPalette(
                for: .dark, branding: .native, presentation: teal)
            XCTAssertEqual(native.accent, .accentColor)
            XCTAssertFalse(PolarisTheme().setsTint(branding: .native))

            let integrator = PolarisTheme(accent: .orange).resolvedPalette(
                for: .dark, branding: .polarisKey, presentation: teal)
            XCTAssertEqual(integrator.accent, .orange)

            var dark = teal
            dark.accentDark = "#9a5cff"
            XCTAssertEqual(dark.accent(for: .dark), "#9a5cff")
            XCTAssertEqual(dark.accent(for: .light), "#369186")
        }

        /// The spacing scale is 4-pt steps.
        func testSpacingIsOnTheFourPointScale() {
            for step in [
                PolarisSpace.xxs, PolarisSpace.xs, PolarisSpace.s, PolarisSpace.m, PolarisSpace.l,
                PolarisSpace.xl, PolarisSpace.xxl,
            ] {
                XCTAssertEqual(step.truncatingRemainder(dividingBy: 4), 0, "\(step)")
            }
        }
    }
#endif
