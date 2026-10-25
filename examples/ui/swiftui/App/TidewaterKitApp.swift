// Tidewater Studio, the SwiftUI kit's sample (UI-KITS §6.1).
//
//   no arguments          the gallery of every preview state, on the fixture product (no Worker)
//   -pkeyState <id>       one state full-screen (the render tests use it), e.g. Welcome.default
//   -pkeyScheme dark|light, -pkeyPreset native, -pkeyAccent #rrggbb, -pkeyAmbient off,
//   -pkeyFreezeTime (countdowns stop, for baselines), -pkeyLocale de, -pkeyMaterial (the iOS 18
//   material fallback on 26)
//   macOS only: -pkeyActivate (take the activation when launched from a script),
//   -pkeyWindow WxH (the content size in points, e.g. 900x640) and -pkeyInactive
//   (hands the activation to Finder once the window is up, so the window is on screen but not
//   active: the inactive look, UK-08.1 S2)
//   macOS only: -pkeySheet (the state as a sheet over Welcome: one fitted 440 pt panel, UK-08.3)
//   macOS only: ⌘, opens Settings on Account (UK-08.4), over a still fixture model (Pro license,
//   2 of 3 devices, a locked managed row), and the app menu has Check for Updates…, Manage
//   License… and Sign Out… (PolarisKeyCommands).
//   macOS only: -pkeyUpdate <state> the update window in one state (UK-08.6): permission, checking,
//   found, downloading, downloading-unknown, extracting, ready, installing, up-to-date, error
//   -pkeyContrast increased, -pkeyReduceTransparency (draw as if the system setting were on: a
//   process cannot set them itself), -pkeyTypeSize ax3 (Dynamic Type forced to accessibility3 -
//   the 200 % stand-in, M6), -pkeyPresentation (the product's accent #ff6a3d and icon arrive as a
//   presentation document would deliver them: no integrator theme, UK-08.7)
//   macOS only: -pkeySettings the Settings pane (Account) as the window's content, at its own size
//   -pkeyOneGate          the one-line drop-in: `.polarisKey(client)` over an offline client (no
//                         Worker), so the gate shows the kit's Welcome (SP-52b.2)
//   --live                the real gate: `.polarisKeyGate(client)` against PKEY_BASE_URL
//                         (default key.plrs.im) for PKEY_PRODUCT with the pins in PKEY_PINS
//
// The live path is the whole integration: one modifier on the root view.

import PolarisKey
import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI

#if os(macOS)
    import PolarisKeyUpdate
    import PolarisKeyUpdateUI
#endif

#if os(macOS)
    import AppKit

    /// `-pkeyWindow WxH`: the window's content size in points.
    enum MacWindow {
        static let size: CGSize? = {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-pkeyWindow"), i + 1 < args.count else { return nil }
            let parts = args[i + 1].lowercased().split(separator: "x").compactMap { Double($0) }
            return parts.count == 2 ? CGSize(width: parts[0], height: parts[1]) : nil
        }()

        /// `-pkeyInactive`: once the window is up, make Finder the active app. The window stays
        /// on screen, drawn as an inactive window.
        /// `-pkeyActivate`: take the activation, so a window launched from a script draws as the
        /// active window (the hand-run review renders; the XCUITest runner activates the app itself).
        @MainActor static func activateIfAsked() {
            guard ProcessInfo.processInfo.arguments.contains("-pkeyActivate") else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                NSApp.activate()
                NSApp.windows.first?.makeKeyAndOrderFront(nil)
            }
        }

        @MainActor static func deactivateIfAsked() {
            guard ProcessInfo.processInfo.arguments.contains("-pkeyInactive") else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                NSWorkspace.shared.runningApplications
                    .first { $0.bundleIdentifier == "com.apple.finder" }?
                    .activate(options: [])
            }
        }
    }
#endif

@main
struct TidewaterKitApp: App {
    var body: some Scene {
        WindowGroup {
            Root()
        }
        #if os(macOS)
            .windowResizability(MacWindow.size == nil ? .automatic : .contentSize)
            .commands {
                PolarisKeyCommands(model: SampleSettings.commandsModel, theme: SampleArgs.theme)
            }
        #endif
        #if os(macOS)
            // The two lines a host writes: this scene, and `.commands` above.
            Settings {
                PolarisKeySettingsPane(model: SampleSettings.paneModel, cloudSync: "Synced 2 min ago")
                    .polarisKeyTheme(SampleArgs.theme(iconData: TidewaterIcon.png))
                    .environment(\.polarisKeyMaterialFallback, SampleArgs.has("-pkeyMaterial"))
                    .environment(\.polarisKeyForcedAccessibility, SampleArgs.forcedAccessibility)
            }
        #endif
    }
}

enum SampleArgs {
    static let args = ProcessInfo.processInfo.arguments

    static func has(_ flag: String) -> Bool { args.contains(flag) }

    static func value(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var forcedAccessibility: PolarisKeyForcedAccessibility {
        PolarisKeyForcedAccessibility(
            increaseContrast: value("-pkeyContrast") == "increased",
            reduceTransparency: has("-pkeyReduceTransparency"))
    }

    /// `-pkeyTypeSize ax3`: the forced size; nil leaves the system's.
    static var typeSize: DynamicTypeSize? {
        switch value("-pkeyTypeSize") {
        case "ax3": return .accessibility3
        case "ax5": return .accessibility5
        default: return nil
        }
    }

    static var theme: PolarisKeyTheme { theme(iconData: nil) }

    static func theme(iconData: Data?) -> PolarisKeyTheme {
        var theme = PolarisKeyTheme()
        if let iconData { theme.product = PolarisKeyTheme.Product(iconData: iconData) }
        if value("-pkeyPreset") == "native" { theme.preset = .native }
        switch value("-pkeyScheme") {
        case "dark": theme.colorScheme = .dark
        case "light": theme.colorScheme = .light
        default: break
        }
        if let accent = value("-pkeyAccent") { theme.accent = .color(accent) }
        if value("-pkeyAmbient") == "off" { theme.ambient = false }
        if let locale = value("-pkeyLocale") { theme.locale = locale }
        return theme
    }
}

#if os(macOS)
    /// The still model behind the sample's Settings pane and menu: the fixture product, signed in.
    enum SampleSettings {
        @MainActor static func make() -> PolarisKeySettingsModel {
            func inputs(_ id: String) -> KitInputs {
                PolarisKeyPreviewState.all.first { $0.id == id }!.inputs
            }
            var pane = inputs("AccountAndLicense.signed-in.pane")
            pane.platform = PolarisKeyPreviewState.mac
            // Only the managed row: the mockup's pane has no other catalog settings.
            pane.config = inputs("Settings.locked").config?.filter { $0.locked }
            // Two devices, this Mac one of them: the list agrees with "2 of 3 in use".
            pane.devices = [
                KitDevice(
                    name: "Work laptop", platform: "windows", formFactor: .computer, lastSeenDays: 12),
                KitDevice(
                    name: "MacBook Pro", platform: "macos", formFactor: .mac, lastSeenDays: 0,
                    current: true),
            ]
            return PolarisKeySettingsModel(
                preview: pane, tier: "Pro", holder: "Mara Lindqvist",
                channel: .choose(current: "stable", options: ["stable", "beta"]), seats: "2 of 3",
                seatCounts: (2, 3),
                handlers: KitSettingsHandlers(
                    manage: {}, autoUpdate: { _ in }, selectChannel: { _ in }),
                options: KitSettingsOptions(version: "2.4.1"))
        }

        @MainActor static let paneModel = make()
        @MainActor static let commandsModel = make()
    }
#endif

struct ForcedTypeSize: ViewModifier {
    let size: DynamicTypeSize?

    @ViewBuilder func body(content: Content) -> some View {
        if let size { content.dynamicTypeSize(size) } else { content }
    }
}

struct Root: View {
    private let args = SampleArgs.args

    private func value(_ flag: String) -> String? { SampleArgs.value(flag) }

    private var theme: PolarisKeyTheme { SampleArgs.theme }

    var body: some View {
        Group {
            #if os(macOS)
                if let id = value("-pkeyUpdate"), let fixture = UpdateFixture(rawValue: id) {
                    UpdateWindowHost(fixture: fixture, theme: theme)
                } else {
                    content
                }
            #else
                content
            #endif
        }
        .polarisKeyTheme(theme)
        .environment(\.polarisKeyMaterialFallback, args.contains("-pkeyMaterial"))
        .environment(\.polarisKeyForcedAccessibility, SampleArgs.forcedAccessibility)
        .modifier(ForcedTypeSize(size: SampleArgs.typeSize))
        #if os(macOS)
            .frame(
                width: MacWindow.size?.width, height: MacWindow.size?.height
            )
            .onAppear {
                MacWindow.activateIfAsked()
                MacWindow.deactivateIfAsked()
            }
        #endif
    }

    /// The state as a presentation document would deliver the product: its accent and its icon
    /// (the verified bytes are the sample's icon), with no theme from the integrator.
    private static func presented(_ state: PolarisKeyPreviewState) -> PolarisKeyPreviewState {
        var inputs = state.inputs
        inputs.presentation = KitPresentation(
            name: "Tidewater Studio", developerName: "Harbor Audio", accent: "#ff6a3d", icon: true)
        return PolarisKeyPreviewState(state.component, state.state, variant: state.variant, inputs)
    }

    /// `-pkeySettings`: the Settings pane as the window's content (macOS).
    @ViewBuilder private var settingsPane: some View {
        #if os(macOS)
            PolarisKeySettingsPane(model: SampleSettings.paneModel, cloudSync: "Synced 2 min ago")
        #else
            EmptyView()
        #endif
    }

    @ViewBuilder private var content: some View {
        Group {
            if args.contains("-pkeySettings") {
                settingsPane
            } else if args.contains("-pkeyOneGate"), let client = LiveClient.offline() {
                SessionsView().polarisKey(client)
            } else if args.contains("--live"), let client = LiveClient.make() {
                SessionsView().polarisKeyGate(client)
                    #if os(macOS)
                        // `--live` also runs Sparkle on the kit's own update window.
                        .task { await LiveUpdates.start(client, theme: theme) }
                    #endif
            } else if let id = value("-pkeyState"),
                let listed = PolarisKeyPreviewState.all.first(where: { $0.id == id })
            {
                let found = args.contains("-pkeyPresentation") ? Self.presented(listed) : listed
                // A Mac says "this Mac", never "this iPhone".
                #if os(macOS)
                    let state = found.on(PolarisKeyPreviewState.mac)
                #else
                    let state = found
                #endif
                #if os(macOS)
                    if args.contains("-pkeySheet"),
                    let welcome = PolarisKeyPreviewState.named(.welcome, "default")?.on(PolarisKeyPreviewState.mac)
                {
                        PolarisKeyPreview(
                            welcome, iconData: TidewaterIcon.png,
                            frozenTime: args.contains("-pkeyFreezeTime")
                        )
                        .sheet(isPresented: .constant(true)) {
                            PolarisKeyPreview(
                                state, iconData: TidewaterIcon.png,
                                frozenTime: args.contains("-pkeyFreezeTime"), asSheet: true
                            )
                            .presentationSizing(.fitted)
                        }
                    } else {
                        PolarisKeyPreview(
                            state, iconData: TidewaterIcon.png,
                            frozenTime: args.contains("-pkeyFreezeTime"))
                    }
                #else
                    PolarisKeyPreview(
                        state, iconData: TidewaterIcon.png,
                        frozenTime: args.contains("-pkeyFreezeTime"))
                #endif
            } else {
                PolarisKeyGallery()
            }
        }
    }
}

/// The app behind the gate.
struct SessionsView: View {
    var body: some View {
        NavigationStack {
            List(["Harbor demo", "Night swim", "Field notes", "Lighthouse"], id: \.self) {
                Text($0)
            }
            .navigationTitle("Sessions")
        }
    }
}

enum LiveClient {
    /// A client that never reaches a Worker: no pins, no trust refresh, no network (`-pkeyOneGate`).
    @MainActor static func offline() -> PolarisKeyClient? {
        let options = PolarisKeyClientOptions(
            productSlug: "tidewater", baseUrl: "https://key.invalid", version: "2.4.1",
            pinnedKeys: [:], trustRefresh: false)
        return try? PolarisKeyClient(options: options)
    }

    @MainActor static func make() -> PolarisKeyClient? {
        let env = ProcessInfo.processInfo.environment
        guard let pinsJSON = env["PKEY_PINS"], let data = pinsJSON.data(using: .utf8),
            let pins = try? JSONDecoder().decode(TrustSet.self, from: data)
        else { return nil }
        let options = PolarisKeyClientOptions(
            productSlug: env["PKEY_PRODUCT"] ?? "tidewater",
            baseUrl: env["PKEY_BASE_URL"] ?? "https://key.plrs.im", version: "2.4.1",
            pinnedKeys: pins)
        return try? PolarisKeyClient(options: options)
    }
}

/// The fixture product's icon (the same art as the mockups'), drawn once.
enum TidewaterIcon {
    @MainActor static let png: Data? = {
        let renderer = ImageRenderer(content: TidewaterIconArt())
        renderer.scale = 2
        #if canImport(UIKit)
            return renderer.uiImage?.pngData()
        #else
            guard let tiff = renderer.nsImage?.tiffRepresentation else { return nil }
            return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        #endif
    }()

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

struct TidewaterIconArt: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.055, green: 0.227, blue: 0.267),
                    Color(red: 0.039, green: 0.165, blue: 0.2),
                ],
                startPoint: .top, endPoint: .bottom)
            Circle().fill(Color(red: 0.957, green: 0.824, blue: 0.541))
                .frame(width: 44, height: 44).offset(x: 34, y: -36)
            TidewaterIcon.Wave().stroke(Color(red: 0.373, green: 0.878, blue: 0.796), lineWidth: 14)
                .offset(y: 18)
            TidewaterIcon.Wave().stroke(Color(red: 0.561, green: 0.788, blue: 0.753), lineWidth: 14)
                .offset(y: 46)
        }
        .frame(width: 180, height: 180)
    }
}

#if os(macOS)
    /// `-pkeyUpdate <state>`: the update window in one state, drawn by the driver itself. The sample's
    /// own window stays out of the way, so the update window is the only one on screen.
    struct UpdateWindowHost: View {
        let fixture: UpdateFixture
        let theme: PolarisKeyTheme
        @State private var driver: PolarisSparkleUserDriver?

        var body: some View {
            Color.clear.frame(width: 1, height: 1)
                .onAppear {
                    let inputs = KitInputs(
                        bundle: KitBundle(slug: "tidewater", name: "Tidewater Studio", icon: true))
                    let driver = PolarisSparkleUserDriver(
                        preview: inputs, iconData: TidewaterIcon.png,
                        options: .init(theme: theme))
                    self.driver = driver
                    driver.present(fixture: fixture)
                    DispatchQueue.main.async {
                        for window in NSApp.windows where window !== driver.nsWindow {
                            window.orderOut(nil)
                        }
                    }
                }
        }
    }

    /// `--live`: Sparkle on the kit's user driver. The sample's bundle carries no `SUPublicEDKey`
    /// (it is not a shipped app), so `start` refuses and says why: the anchor is not bypassed.
    @MainActor enum LiveUpdates {
        static var sparkle: PolarisSparkle?

        static func start(_ client: PolarisKeyClient, theme: PolarisKeyTheme) async {
            do {
                sparkle = try await PolarisSparkle.start(
                    client: client,
                    userDriver: PolarisSparkleUserDriver(
                        client: client, options: .init(theme: theme)))
            } catch {
                NSLog("Sparkle not started: \(error)")
            }
        }
    }
#endif
