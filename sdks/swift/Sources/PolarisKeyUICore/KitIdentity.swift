// @pkey-feature ui.theme
// The product is the hero (UI-KITS §1.2) and the theme's resolution (§3.1, §3.4), as values.
//
// Identity resolves field by field: the integrator's theme, then the product's registered
// presentation (discovery `core.presentation` through the SDK's presentation source, HA-13), then
// the app bundle; with no icon anywhere the kit draws a monogram, never a Polaris Key mark. The
// accent resolves: the integrator's colour (or `core`, the only way to get Polaris violet), then
// the host's tint under the `native` preset, then the presentation's accent, then a colour derived
// from the icon, then ink. The core says where each answer came from; the SwiftUI layer turns the
// source into colours through the contrast resolver.

import Foundation

/// Where the accent came from (`vocabulary.accentSources`).
public enum AccentSource: String, Sendable, Codable, CaseIterable {
    case integrator, product, icon, core, ink, host
}

/// What stands for the product's icon (`vocabulary.icons`).
public enum IconKind: String, Sendable, Codable, CaseIterable {
    case image, monogram, none
}

/// The kit's base look (UI-KITS §3.4).
public enum KitPreset: String, Sendable, Codable, CaseIterable {
    case polarisKey = "polaris-key"
    case native
}

/// `system` follows the OS (UI-KITS §3.1).
public enum KitColorScheme: String, Sendable, Codable, CaseIterable {
    case system, dark, light
}

/// The kit a theme row targets (`vocabulary.kits`).
public enum KitKind: String, Sendable, Codable, CaseIterable {
    case elements, react, swiftui, compose, godot, qt, terminal
}

/// The product as a screen shows it.
public struct ResolvedIdentity: Sendable, Equatable, Hashable {
    /// The full name, for titles.
    public let name: String
    /// The integrator's short name, for inline sentences; nil when unset (never derived).
    public let shortName: String?
    /// "by <Developer>" and "From <Developer>"; nil when no source names one.
    public let developer: String?
    /// The icon kind this kit draws.
    public let icon: IconKind
    public let accentSource: AccentSource
    /// The accent's input colour (`#rrggbb`) for the light and dark schemes, when the source is a
    /// colour (integrator or product); nil otherwise.
    public let accentLight: String?
    public let accentDark: String?
    /// The device-code page the integrator set (`product.deviceCodeUrl`), or nil for the default.
    public let deviceCodeUrl: String?

    /// The name inline sentences use: `shortName` only when the integrator set it.
    public var inlineName: String { shortName ?? name }

    /// The product's initial for the monogram tile.
    public var monogram: String {
        guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return "?"
        }
        return String(first).localizedUppercase
    }
}

/// The theme's answer for one kit (the `theme` family's expectation).
public struct ResolvedTheme: Sendable, Equatable, Hashable {
    public let identity: ResolvedIdentity
    public let colorScheme: KitColorScheme
    public let preset: KitPreset

    public var name: String { identity.name }
    public var accentSource: AccentSource { identity.accentSource }
    public var icon: IconKind { identity.icon }
}

public enum KitIdentity {
    /// The polaris violet the `core` accent names (BRAND §5; `PolarisBrand.violet500`).
    public static let coreAccentLight = "#7a2fff"
    public static let coreAccentDark = "#9a5cff"

    /// Resolve the product identity for `inputs` under `preset` in `kit`.
    public static func resolve(
        _ inputs: KitInputs, preset: KitPreset = .polarisKey, kit: KitKind = .swiftui
    ) -> ResolvedIdentity {
        let integrator = inputs.integrator
        let presentation = inputs.presentation
        let name =
            nonEmpty(integrator?.name) ?? nonEmpty(presentation?.name)
            ?? nonEmpty(inputs.bundle.name) ?? inputs.bundle.slug
        let developer = nonEmpty(integrator?.developer) ?? nonEmpty(presentation?.developerName)
        let hasIcon =
            (integrator?.icon ?? false) || (presentation?.icon ?? false)
            || (inputs.bundle.icon ?? false)
        let icon: IconKind = kit == .terminal ? .none : (hasIcon ? .image : .monogram)

        let source: AccentSource
        var light: String?
        var dark: String?
        if let accent = nonEmpty(integrator?.accent) {
            if accent == "core" {
                source = .core
                light = coreAccentLight
                dark = coreAccentDark
            } else {
                source = .integrator
                light = accent
                dark = nonEmpty(integrator?.accentDark) ?? accent
            }
        } else if preset == .native {
            source = .host
        } else if let accent = nonEmpty(presentation?.accent) {
            source = .product
            light = accent
            dark = nonEmpty(presentation?.accentDark) ?? accent
        } else if hasIcon {
            source = .icon
        } else {
            source = .ink
        }
        return ResolvedIdentity(
            name: name, shortName: nonEmpty(integrator?.shortName), developer: developer,
            icon: icon, accentSource: source, accentLight: light, accentDark: dark,
            deviceCodeUrl: nonEmpty(integrator?.deviceCodeUrl))
    }

    /// The theme for `kit`: identity, scheme and preset. Games and TVs default to dark (UI-KITS
    /// owner decisions, Q9); every other kit follows the system.
    public static func theme(
        _ inputs: KitInputs, kit: KitKind, preset: KitPreset? = nil,
        colorScheme: KitColorScheme? = nil
    ) -> ResolvedTheme {
        let preset = preset ?? .polarisKey
        let scheme =
            colorScheme
            ?? ((kit == .godot || inputs.platform.isTV) ? .dark : .system)
        return ResolvedTheme(
            identity: resolve(inputs, preset: preset, kit: kit), colorScheme: scheme,
            preset: preset)
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return s
    }
}
