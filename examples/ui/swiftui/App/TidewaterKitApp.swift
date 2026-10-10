// Tidewater Studio, the SwiftUI kit's sample (UI-KITS §6.1).
//
//   no arguments          the gallery of every preview state, on the fixture product (no Worker)
//   -pkeyState <id>       one state full-screen (the render tests use it), e.g. Welcome.default
//   -pkeyScheme dark|light, -pkeyPreset native, -pkeyAccent #rrggbb, -pkeyAmbient off,
//   -pkeyFreezeTime (countdowns stop, for baselines), -pkeyLocale de, -pkeyMaterial (the iOS 18
//   material fallback on 26)
//   --live                the real gate: `.polarisKeyGate(client)` against PKEY_BASE_URL
//                         (default key.plrs.im) for PKEY_PRODUCT with the pins in PKEY_PINS
//
// The live path is the whole integration: one modifier on the root view.

import PolarisKey
import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI

@main
struct TidewaterKitApp: App {
    var body: some Scene {
        WindowGroup {
            Root()
        }
    }
}

struct Root: View {
    private let args = ProcessInfo.processInfo.arguments

    private func value(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    private var theme: PolarisKeyTheme {
        var theme = PolarisKeyTheme()
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
        return renderer.uiImage?.pngData()
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
