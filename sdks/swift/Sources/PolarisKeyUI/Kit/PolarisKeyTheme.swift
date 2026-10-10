// @pkey-feature ui.theme
// The one theme API (UI-KITS §3.1, §3.2 SwiftUI row): `.polarisKeyTheme(PolarisKeyTheme(…))`.
// Every field is optional; an empty theme is the Polaris Key look in the product's accent.
//
//   preset       polaris-key (default) · native: system fonts, the app's tint, system grounds
//   colorScheme  system (default) · dark · light
//   accent       product (default) · core (Polaris violet, only when asked) · a colour
//   radius, typography, density, motion, ambient, product, copy, poweredBy
//
// The kit resolves the theme once per render into a `PolarisKeyStyle.Resolved` (colours through
// the contrast resolver, Rubik scaled with Dynamic Type, the platform measures), which every
// part reads from the environment.

import PolarisKeyUICore
import SwiftUI

public struct PolarisKeyTheme: Sendable, Equatable {
    /// UI-KITS §3.1 `accent`.
    public enum Accent: Sendable, Equatable {
        /// The product's: presentation, then derived from its icon, then ink.
        case product
        /// Polaris violet.
        case core
        /// A `#rrggbb` colour for both schemes, or a pair.
        case color(String, dark: String? = nil)
    }

    /// UI-KITS §3.1 `radius`: the control radius; surfaces scale from it. iOS controls are
    /// capsules at every radius except `points`.
    public enum Radius: Sendable, Equatable {
        case sm, md, lg
        case points(Double)
    }

    /// UI-KITS §3.1 `typography`.
    public struct Typography: Sendable, Equatable {
        /// `rubik` (the kit's), `system` (SF), or a font the host registered, by family name.
        public enum Family: Sendable, Equatable {
            case rubik
            case system
            case custom(String)
        }

        public var family: Family?
        /// A heading face (games); nil keeps the family.
        public var display: String?
        /// A multiplier on top of Dynamic Type.
        public var scale: Double

        public init(family: Family? = nil, display: String? = nil, scale: Double = 1) {
            self.family = family
            self.display = display
            self.scale = scale
        }
    }

    /// UI-KITS §3.1 `density`: control height and spacing, never the component.
    public enum Density: String, Sendable, Equatable {
        case compact, comfortable, spacious
    }

    /// UI-KITS §3.1 `motion`: `system` follows Reduce Motion.
    public enum Motion: String, Sendable, Equatable {
        case system, reduced, none
    }

    /// UI-KITS §4.5 `poweredBy`.
    public enum PoweredBy: String, Sendable, Equatable {
        case line, badge
    }

    /// The semantic roles `colors` may override (UI-KITS §3.1), per scheme.
    public enum ColorRole: String, Sendable, Hashable, CaseIterable {
        case surfacePage, surfaceRaised, surfaceSunken, textStrong, textDefault, textMuted
        case textSubtle, borderSubtle, danger, warning, success
    }

    /// Per-role overrides, per scheme (`#rrggbb`). A status colour keeps its meaning: it is never
    /// replaced by the accent.
    public struct Colors: Sendable, Equatable {
        public var dark: [ColorRole: String]
        public var light: [ColorRole: String]

        public init(dark: [ColorRole: String] = [:], light: [ColorRole: String] = [:]) {
            self.dark = dark
            self.light = light
        }
    }

    /// The integrator's identity (UI-KITS §1.2): it wins field by field over the presentation
    /// and the bundle.
    public struct Product: Sendable, Equatable {
        public var name: String?
        public var shortName: String?
        public var developer: String?
        /// The product's icon (PNG or JPEG bytes).
        public var iconData: Data?
        /// The device-code page (`driftkart.gg/tv`); https only, else ignored.
        public var deviceCodeUrl: String?

        public init(
            name: String? = nil, shortName: String? = nil, developer: String? = nil,
            iconData: Data? = nil, deviceCodeUrl: String? = nil
        ) {
            self.name = name
            self.shortName = shortName
            self.developer = developer
            self.iconData = iconData
            self.deviceCodeUrl = deviceCodeUrl
        }
    }

    public var preset: KitPreset
    public var colorScheme: KitColorScheme
    public var accent: Accent
    /// Service glyph tiles on settings group headers (UI-KITS §1.2); off on product screens.
    public var serviceCues: Bool
    public var colors: Colors
    /// Fields and groups take it; iOS controls stay capsules (§7.3: never a rounded-rectangle
    /// override on 26).
    public var radius: Radius
    public var typography: Typography
    public var density: Density
    public var motion: Motion
    /// The product ambient behind the gate (UI-KITS §1.2); nil is on, except under `native`.
    public var ambient: Bool?
    public var product: Product?
    /// Copy overrides per locale (`["en": ["welcome.lede": "…"]]`), key by key.
    public var copy: [String: [String: String]]
    /// The locale the kit's copy reads; nil follows the app's.
    public var locale: String?
    public var poweredBy: PoweredBy?

    public init(
        preset: KitPreset = .polarisKey, colorScheme: KitColorScheme = .system,
        accent: Accent = .product, serviceCues: Bool = false, colors: Colors = Colors(),
        radius: Radius = .md, typography: Typography = Typography(),
        density: Density = .comfortable, motion: Motion = .system, ambient: Bool? = nil,
        product: Product? = nil, copy: [String: [String: String]] = [:], locale: String? = nil,
        poweredBy: PoweredBy? = nil
    ) {
        self.preset = preset
        self.colorScheme = colorScheme
        self.accent = accent
        self.serviceCues = serviceCues
        self.colors = colors
        self.radius = radius
        self.typography = typography
        self.density = density
        self.motion = motion
        self.ambient = ambient
        self.product = product
        self.copy = copy
        self.locale = locale
        self.poweredBy = poweredBy
    }

    /// The `native` preset (UI-KITS §3.4): system fonts, the app's tint, system grounds.
    public static let native = PolarisKeyTheme(preset: .native)

    /// The integrator half of the core's inputs.
    var integrator: KitIntegrator? {
        var i = KitIntegrator()
        var any = false
        if let product {
            i.name = product.name
            i.shortName = product.shortName
            i.developer = product.developer
            i.icon = product.iconData != nil ? true : nil
            i.deviceCodeUrl = product.deviceCodeUrl
            any = true
        }
        switch accent {
        case .product: break
        case .core:
            i.accent = "core"
            any = true
        case .color(let light, let dark):
            i.accent = light
            i.accentDark = dark
            any = true
        }
        if let poweredBy {
            i.poweredBy = poweredBy.rawValue
            any = true
        }
        return any ? i : nil
    }
}

private struct PolarisKeyThemeKey: EnvironmentKey {
    static let defaultValue = PolarisKeyTheme()
}

extension EnvironmentValues {
    /// The theme `.polarisKeyTheme(_:)` set for this subtree.
    public var polarisKeyTheme: PolarisKeyTheme {
        get { self[PolarisKeyThemeKey.self] }
        set { self[PolarisKeyThemeKey.self] = newValue }
    }
}

extension View {
    /// Theme every Polaris Key view in this subtree (UI-KITS §3.2).
    public func polarisKeyTheme(_ theme: PolarisKeyTheme) -> some View {
        environment(\.polarisKeyTheme, theme)
    }
}
