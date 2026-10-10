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
        static let iPhone390 = KitSize(
            name: "iphone-390x844", size: CGSize(width: 390, height: 844),
            insets: EdgeInsets(top: 47, leading: 0, bottom: 34, trailing: 0))
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

    enum KitTypeName {
        static func short(_ t: DynamicTypeSize) -> String {
            switch t {
            case .large: return "L"
            case .accessibility1: return "AX1"
            case .accessibility3: return "AX3"
            case .accessibility5: return "AX5"
            default: return "\(t)"
            }
        }
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

        struct Inspection {
            var fieldFound = false
            var fieldAlpha: CGFloat = 0
            var hitIsField = false
        }

        /// Host `view` and report on its text field: whether it exists, its opacity, and whether a
        /// hit-test at its centre lands in it.
        static func inspect<V: View>(_ view: V, at kitSize: KitSize) -> Inspection {
            let size = kitSize.size
            var out = Inspection()
            #if canImport(UIKit)
                let controller = UIHostingController(rootView: view.frame(width: size.width, height: size.height))
                let window = UIWindow(frame: CGRect(origin: .zero, size: size))
                window.rootViewController = controller
                window.isHidden = false
                controller.view.frame = window.bounds
                controller.view.layoutIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                controller.view.layoutIfNeeded()
                if let field = firstSubview(of: UITextField.self, in: controller.view) {
                    out.fieldFound = true
                    out.fieldAlpha = field.alpha
                    let centre = field.convert(CGPoint(x: field.bounds.midX, y: field.bounds.midY), to: controller.view)
                    let hit = controller.view.hitTest(centre, with: nil)
                    out.hitIsField = hit === field || (hit?.isDescendant(of: field) ?? false)
                }
                window.isHidden = true
            #else
                let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
                host.frame = CGRect(origin: .zero, size: size)
                let window = KitKeyWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = host
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                host.layoutSubtreeIfNeeded()
                if let field = firstSubview(of: NSTextField.self, in: host, where: { $0.isEditable }) {
                    out.fieldFound = true
                    out.fieldAlpha = field.alphaValue
                    let centre = field.convert(NSPoint(x: field.bounds.midX, y: field.bounds.midY), to: host)
                    let hit = host.hitTest(host.convert(centre, to: host.superview))
                    out.hitIsField = hit === field || (hit?.isDescendant(of: field) ?? false)
                }
                window.contentView = nil
            #endif
            return out
        }

        #if canImport(UIKit)
            static func firstSubview<T: UIView>(of type: T.Type, in root: UIView) -> T? {
                if let hit = root as? T { return hit }
                for sub in root.subviews { if let hit = firstSubview(of: type, in: sub) { return hit } }
                return nil
            }

            /// Focus the key field, wait, and report whether the SAME field is still first
            /// responder (focusing, and the keyboard that follows, must never rebuild it).
            static func focusStaysOnSameField<V: View>(_ view: V, at kitSize: KitSize) -> Bool {
                let size = kitSize.size
                let controller = UIHostingController(rootView: view.frame(width: size.width, height: size.height))
                let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
                let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
                window.frame = CGRect(origin: .zero, size: size)
                window.rootViewController = controller
                window.makeKeyAndVisible()
                controller.view.frame = window.bounds
                controller.view.layoutIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                guard let field = firstSubview(of: UITextField.self, in: controller.view) else { return false }
                _ = field.becomeFirstResponder()
                RunLoop.main.run(until: Date().addingTimeInterval(0.6))
                let still = firstSubview(of: UITextField.self, in: controller.view)
                let result = still === field && field.isFirstResponder
                window.isHidden = true
                return result
            }
        #else
            static func firstSubview<T: NSView>(of type: T.Type, in root: NSView, where match: (T) -> Bool = { _ in true }) -> T? {
                if let hit = root as? T, match(hit) { return hit }
                for sub in root.subviews { if let hit = firstSubview(of: type, in: sub, where: match) { return hit } }
                return nil
            }
        #endif

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
            types: [DynamicTypeSize]? = nil,
            _ make: () -> V
        ) {
            // macOS ignores dynamicTypeSize for these fonts, so its AX rows would only duplicate L.
            #if os(macOS)
                let types = [DynamicTypeSize.large]
            #else
                let types = types ?? [.large, .accessibility3]
            #endif
            for size in sizes {
                for type in types {
                    for preset in KitPreset.allCases {
                        for scheme in snapshots == nil ? [ColorScheme.dark] : [.dark, .light] {
                            let result = KitHost.render(
                                styled(make(), preset), at: size, scheme: scheme, type: type,
                                snapshot: snapshots != nil)
                            let label =
                                "\(screen) \(size.name) \(KitTypeName.short(type)) \(preset)"
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
                                let typeSuffix = type == .large ? "" : "-\(KitTypeName.short(type).lowercased())"
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
                sizes: [
                    KitSizes.iPhoneSE, KitSizes.iPhoneSELandscape, KitSizes.iPhoneMaxLandscape,
                    KitSizes.macSmall,
                ],
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

        /// A realistic 32-character device id (DeviceID.derive length), at L and AX3.
        static let realDeviceId = "dev_7Q2Mx9cLr4TbV0aZ3WPLDA8kN5eY"

        func testOfflineActivationKeepsImportOnScreen() {
            check(
                screen: "offline", roles: [.primaryAction],
                // Mac windows at Dynamic Type AX3 are not a real combination (macOS ignores it),
                // so the Mac sizes run only on macOS and the phone and tablet sizes elsewhere.
                sizes: KitSizes.snapshotted
            ) {
                PolarisOfflineSurface(
                    productName: "Tidewater Studio", deviceId: Self.realDeviceId, message: nil,
                    imported: false, theme: Tidewater.theme, onImportFile: {}, onPaste: {},
                    onDone: {})
            }
        }

        func testSignInKeepsTheCodeOnScreenAtAX5() {
            #if !os(macOS)
                check(
                    screen: "signin", roles: [.code, .primaryAction],
                    sizes: [KitSizes.iPhoneSE, KitSizes.iPhoneMax], types: [.accessibility5]
                ) {
                    PolarisSignInSurface(
                        phase: .waiting(Self.prompt), theme: Tidewater.theme,
                        attach: .constant(true), onOpen: { _ in }, onAccept: {}, onRetry: {},
                        onCancel: {})
                }
            #endif
        }

        /// A long device-code domain at L and AX1 still lays out with the code and Open browser
        /// on screen (the page token never breaks; it moves to its own line).
        func testALongDeviceCodeDomainKeepsTheActionOnScreen() {
            let long = SignInPrompt(
                deviceCode: "dc", userCode: "WDJB-MJHT",
                verificationUri: "https://licensing.tidewater-studio-games.example.com/device",
                verificationUriComplete:
                    "https://licensing.tidewater-studio-games.example.com/device?user_code=WDJB-MJHT",
                expiresIn: 600, interval: 5, expiresAt: Int(Date().timeIntervalSince1970) + 252)
            check(
                screen: "signin-long", roles: [.code, .primaryAction],
                // Mac windows at AX1 are not a real combination (macOS ignores Dynamic Type).
                sizes: KitSizes.snapshotted + [KitSizes.iPhoneSELandscape],
                types: [.large, .accessibility1]
            ) {
                PolarisSignInSurface(
                    phase: .waiting(long), theme: Tidewater.theme, attach: .constant(true),
                    onOpen: { _ in }, onAccept: {}, onRetry: {}, onCancel: {})
            }
        }

        /// Tall phones and iPad portrait: the act is pinned within 24 pt of the bottom safe area.
        func testTheTallColumnPinsTheActToTheBottom() {
            #if !os(macOS)
                for size in [KitSizes.iPhoneMax, KitSizes.iPhone390, KitSizes.iPad] {
                    let result = KitHost.render(
                        styled(
                            PolarisGateSurface(
                                status: .needsActivation, allowedRange: nil, isWorking: false,
                                lastError: nil, licenseKey: .constant(""), theme: Tidewater.theme,
                                onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                                onActivateOffline: {}, content: { Text("App") }), .native),
                        at: size, scheme: .dark, type: .large, snapshot: false)
                    let act = result.frames[.primaryAction]
                    XCTAssertNotNil(act, size.name)
                    // Sign in is the first control; the act's last control is the extras row,
                    // which sits within the safe area. The act as a whole sits low: Sign in is in
                    // the lower half.
                    if let act {
                        XCTAssertGreaterThan(
                            act.minY, result.safe.midY - 1, "\(size.name): the act sits low")
                    }
                }
            #endif
        }

        /// Large, AX3 and AX5: the rows a changed screen is held to (macOS runs L only).
        static let allTypes: [DynamicTypeSize] = [.large, .accessibility3, .accessibility5]

        /// A blocking state (expired, revoked, a version block) keeps its filled action on screen
        /// at every size, type size and preset, with the renewal page and the host's own action
        /// both given (the longest list of controls the page has).
        func testABlockingStateKeepsItsPrimaryActionOnScreen() {
            let allowed = AllowedRange(min: "2.0.0")
            for status in [LicenseStatus.expired, .revoked, .versionTooOld] {
                check(
                    screen: "gate-\(status.rawValue)", roles: [.primaryAction], sizes: sizes,
                    types: Self.allTypes
                ) {
                    PolarisGateSurface(
                        status: status, allowedRange: allowed, isWorking: false, lastError: nil,
                        renewURL: URL(string: "https://example.com/renew"),
                        blockedAction: { _ in AnyView(Text("Contact support")) },
                        licenseKey: .constant(""), theme: Tidewater.theme,
                        onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                        content: { Text("App") })
                }
            }
        }

        /// "Use a different key": the form and its Activate are on screen, with Cancel.
        func testTheDifferentKeyFormKeepsActivateOnScreen() {
            check(
                screen: "gate-different-key", roles: [.primaryAction, .keyField],
                sizes: [
                    KitSizes.iPhoneSE, KitSizes.iPhoneSELandscape, KitSizes.iPhoneMax,
                    KitSizes.iPad, KitSizes.macSmall, KitSizes.mac,
                ],
                types: Self.allTypes
            ) {
                PolarisGateSurface(
                    status: .expired, allowedRange: nil, isWorking: false, lastError: nil,
                    licenseKey: .constant(""), theme: Tidewater.theme, onSignIn: {},
                    onActivate: { _ in }, onRefresh: {}, showsKeyFormInitially: true,
                    content: { Text("App") })
            }
        }

        /// The signed-in screen: who signed in, Continue and Not you?.
        func testTheSignedInScreenKeepsContinueOnScreen() {
            check(
                screen: "signin-ready", roles: [.primaryAction], sizes: sizes, types: Self.allTypes
            ) {
                PolarisSignInSurface(
                    phase: .ready(
                        SignInReady(identity: SignInIdentity(name: "Ada Lovelace", email: "ada@example.com"))),
                    theme: Tidewater.theme, attach: .constant(true), onOpen: { _ in },
                    onAccept: {}, onRetry: {}, onCancel: {})
            }
        }

        /// Until the first read of the client, the gate draws no controls at all.
        func testTheGateDrawsNoCardBeforeTheFirstRead() {
            let result = KitHost.render(
                styled(
                    PolarisGateSurface(
                        status: .needsActivation, allowedRange: nil, isWorking: false,
                        lastError: nil, isLoading: true, licenseKey: .constant(""),
                        theme: Tidewater.theme, onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                        content: { Text("App") }), .polaris),
                at: KitSizes.iPhoneMax, scheme: .dark, type: .large, snapshot: false)
            XCTAssertTrue(result.frames.isEmpty, "controls laid out: \(result.frames.keys)")
        }

        func testButtonLabelsAreTitleCaseOnMacAndSentenceCaseOnIOS() {
            let minor: Set<String> = KitButtonCase.minorWords
            let labels = PolarisKitCopy().buttonLabels + PolarisCopy().buttonLabels
            for label in labels {
                let words = label.split(separator: " ").map(String.init)
                for (i, word) in words.enumerated() {
                    guard let first = word.first(where: { $0.isLetter }) else { continue }
                    let edge = i == 0 || i == words.count - 1
                    #if os(macOS)
                        let bare = word.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
                        if edge || !minor.contains(bare.lowercased()) {
                            XCTAssertTrue(first.isUppercase, "\(label): '\(word)' is not title case")
                        } else {
                            XCTAssertTrue(first.isLowercase, "\(label): '\(word)' should be lower")
                        }
                    #else
                        if i > 0 {
                            XCTAssertTrue(first.isLowercase, "\(label): '\(word)' is not sentence case")
                        }
                    #endif
                }
            }
            #if os(macOS)
                XCTAssertEqual(PolarisCopy().signInButton, "Sign In")
                XCTAssertEqual(PolarisCopy().freeDeviceButton, "Replace a Device")
                XCTAssertEqual(PolarisKitCopy().importFileButton, "Load File…")
                XCTAssertEqual(PolarisCopy().retryButton, "Try Again")
            #else
                XCTAssertEqual(PolarisCopy().signInButton, "Sign in")
                XCTAssertEqual(PolarisKitCopy().importFileButton, "Load file…")
            #endif
        }

        /// The resting key field is fully opaque and hit-testable, so a tap focuses it.
        func testTheRestingKeyFieldIsHitTestable() {
            let size = KitSizes.iPhoneMaxLandscape
            let result = KitHost.inspect(
                styled(
                    PolarisGateSurface(
                        status: .needsActivation, allowedRange: nil, isWorking: false,
                        lastError: ErrorCopy.message(ErrorCode.deviceLimit),
                        manageURL: "https://key.plrs.im/portal/tidewater/devices",
                        licenseKey: .constant("pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA"),
                        theme: Tidewater.theme, onSignIn: {}, onActivate: { _ in },
                        onRefresh: {}, content: { Text("App") }), .polaris),
                at: size)
            XCTAssertTrue(result.fieldFound, "the key field is in the view tree")
            XCTAssertEqual(result.fieldAlpha, 1, accuracy: 0.001, "the field is fully opaque")
            XCTAssertTrue(result.hitIsField, "a hit at the field's centre lands in the field")
        }

        #if canImport(UIKit)
            /// Focusing the key field must not rebuild it: the same UITextField stays first
            /// responder.
            func testFocusingTheKeyFieldDoesNotRebuildIt() {
                for size in [KitSizes.iPhoneSE, KitSizes.iPhoneMax, KitSizes.iPhoneSELandscape] {
                    let ok = KitHost.focusStaysOnSameField(
                        styled(
                            PolarisGateSurface(
                                status: .needsActivation, allowedRange: nil, isWorking: false,
                                lastError: nil, licenseKey: .constant(""), theme: Tidewater.theme,
                                onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                                content: { Text("App") }), .native),
                        at: size)
                    XCTAssertTrue(ok, "\(size.name): the key field kept first responder")
                }
            }
        #endif

        func testOfflineCopyAndQRCarryTheShownCode() {
            XCTAssertEqual(
                String(format: PolarisKitCopy().offlineProductLabel, "Tidewater Studio"),
                "Product: Tidewater Studio")
            // The card shows the id, Copy copies it and the QR encodes it: one value.
            XCTAssertEqual(
                PolarisOfflineSurface.requestCode(deviceId: Self.realDeviceId), Self.realDeviceId)
            XCTAssertNotNil(PolarisQRCode.cgImage(for: Self.realDeviceId))
        }

        func testTheLedeBreaksOnlyAfterSlashAndDot() {
            let page = "licensing.tidewater-studio-games.example.com/device"
            let out = PolarisPageLede.breakable(page)
            XCTAssertEqual(out.replacingOccurrences(of: "\u{200B}", with: "")
                .replacingOccurrences(of: "\u{2060}", with: ""), page)
            XCTAssertTrue(out.contains(".\u{200B}") && out.contains("/\u{200B}"))
            XCTAssertTrue(out.contains("\u{2060}-\u{2060}"), "hyphens never break")
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
            // iPad portrait is tall-shaped: the column, not two empty strips.
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 1024, height: 1366)), [.column])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 834, height: 1194)), [.column])
            XCTAssertEqual(
                PolarisKitLayout.candidates(for: CGSize(width: 1366, height: 1024)), [.split])
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
            // The integrator's colour leads, and goes through the resolver like any other accent.
            let orange = try XCTUnwrap(Color.orange.polarisHex(for: .dark))
            let orangeResolved = try XCTUnwrap(PolarisAccent.resolve(orange, dark: true))
            XCTAssertEqual(integrator.accent, BrandColor(hexString: orangeResolved.solid)?.color)
            XCTAssertNotEqual(integrator.accent, branded.accent)

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
