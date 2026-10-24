// Tidewater Studio, the SwiftUI kit's sample (UI-KITS §6.1).
//
//   no arguments          the gallery of every preview state, on the fixture product (no Worker)
//   -pkeyState <id>       one state full-screen (the render tests use it), e.g. Welcome.default
//   -pkeyScheme dark|light, -pkeyPreset native, -pkeyAccent #rrggbb, -pkeyAmbient off,
//   -pkeyFreezeTime (countdowns stop, for baselines), -pkeyLocale de, -pkeyMaterial (the iOS 18
//   material fallback on 26)
//   macOS only: -pkeyWindow WxH (the content size in points, e.g. 900x640) and -pkeyInactive
//   (hands the activation to Finder once the window is up, so the window is on screen but not
//   active: the inactive look, UK-08.1 S2)
//   macOS only: ⌘, opens Settings on Account (UK-08.4), over a still fixture model (Pro license,
//   2 of 3 devices, a locked managed row), and the app menu has Check for Updates…, Manage
//   License… and Sign Out… (PolarisKeyCommands).
//   --live                the real gate: `.polarisKeyGate(client)` against PKEY_BASE_URL
//                         (default key.plrs.im) for PKEY_PRODUCT with the pins in PKEY_PINS
//
// The live path is the whole integration: one modifier on the root view.

import PolarisKey
import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI

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

struct Root: View {
    private let args = SampleArgs.args

    private func value(_ flag: String) -> String? { SampleArgs.value(flag) }

    private var theme: PolarisKeyTheme { SampleArgs.theme }

    var body: some View {
        Group {
            if args.contains("--live"), let client = LiveClient.make() {
                SessionsView().polarisKeyGate(client)
            } else if let id = value("-pkeyState"),
                let state = PolarisKeyPreviewState.all.first(where: { $0.id == id })
            {
                PolarisKeyPreview(
                    state, iconData: TidewaterIcon.png,
                    frozenTime: args.contains("-pkeyFreezeTime"))
            } else {
                PolarisKeyGallery()
            }
        }
        .polarisKeyTheme(theme)
        .environment(\.polarisKeyMaterialFallback, args.contains("-pkeyMaterial"))
        #if os(macOS)
            .frame(
                width: MacWindow.size?.width, height: MacWindow.size?.height
            )
            .onAppear { MacWindow.deactivateIfAsked() }
        #endif
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
