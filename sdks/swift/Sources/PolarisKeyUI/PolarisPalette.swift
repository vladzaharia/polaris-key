// The gate's colours for one colour scheme. Two built-in palettes:
//
// - `native` (the default): system semantic colours and the app's accent, so the gate looks like
//   the host app and carries no Polaris Key branding;
// - `brand(for:)`: the generated brand tokens (`PolarisBrand`, written by `pnpm gen:brand` into
//   BrandTokens.generated.swift). SDK UI is a core surface (BRAND.md §7.1): the core violet accent.
//
// Both follow the SwiftUI `colorScheme` environment (system colours are dynamic; the brand palette
// is picked per scheme), so the gate tracks the system appearance and any
// `.preferredColorScheme(_:)` the host sets. A product re-points the accent through
// `PolarisTheme(accent:)` or replaces the whole palette through `PolarisTheme(palette:)`.

import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// Every colour the gate paints, for one colour scheme.
///
/// In the brand palette, text tokens sit on surface tokens so the brand's contrast guarantees
/// (BRAND.md §9) carry over; an override that changes a surface owns the contrast of the text
/// drawn on it.
public struct PolarisPalette: Sendable, Equatable {
    /// The ground behind the full-screen gate states.
    public var page: Color
    /// The card the activation form and status messages sit on.
    public var raised: Color
    /// Headings.
    public var textStrong: Color
    /// Body copy.
    public var textDefault: Color
    /// Secondary copy (subtitles).
    public var textMuted: Color
    /// The card edge and the divider rules.
    public var borderSubtle: Color
    /// Control boundaries (the licence-key field).
    public var borderStrong: Color
    /// The primary button's fill.
    public var accent: Color
    /// Accent-coloured text and bordered controls on the card.
    public var accentText: Color
    /// Text on the primary button's fill.
    public var onAccent: Color
    /// The focus ring and keyboard focus tint. Violet in every brand theme (BRAND.md §5.4).
    public var focus: Color
    /// The offline-grace banner's glyph and the expired / version-block glyphs.
    public var warning: Color
    /// The offline-grace banner's tinted ground (when `prefersMaterials` is false).
    public var warningSubtle: Color
    /// The revoked glyph and activation errors.
    public var danger: Color
    /// Draw the grace banner on a native bar material instead of `warningSubtle`.
    public var prefersMaterials: Bool

    public init(
        page: Color, raised: Color, textStrong: Color, textDefault: Color, textMuted: Color,
        borderSubtle: Color, borderStrong: Color, accent: Color, accentText: Color,
        onAccent: Color, focus: Color, warning: Color, warningSubtle: Color, danger: Color,
        prefersMaterials: Bool = false
    ) {
        self.page = page
        self.raised = raised
        self.textStrong = textStrong
        self.textDefault = textDefault
        self.textMuted = textMuted
        self.borderSubtle = borderSubtle
        self.borderStrong = borderStrong
        self.accent = accent
        self.accentText = accentText
        self.onAccent = onAccent
        self.focus = focus
        self.warning = warning
        self.warningSubtle = warningSubtle
        self.danger = danger
        self.prefersMaterials = prefersMaterials
    }

    /// The built-in palette for `branding` in `scheme`.
    public static func standard(_ branding: PolarisBranding, for scheme: ColorScheme)
        -> PolarisPalette
    {
        branding == .polarisKey ? brand(for: scheme) : native
    }

    /// System semantic colours and the app's accent colour (the default). The colours are
    /// dynamic, so one value serves both schemes.
    public static let native: PolarisPalette = {
        #if canImport(UIKit)
            let page = Color(uiColor: .systemGroupedBackground)
            let raised = Color(uiColor: .secondarySystemGroupedBackground)
            let border = Color(uiColor: .separator)
            let strong = Color(uiColor: .tertiaryLabel)
        #else
            let page = Color(nsColor: .windowBackgroundColor)
            let raised = Color(nsColor: .controlBackgroundColor)
            let border = Color(nsColor: .separatorColor)
            let strong = Color(nsColor: .tertiaryLabelColor)
        #endif
        return PolarisPalette(
            page: page, raised: raised, textStrong: .primary, textDefault: .primary,
            textMuted: .secondary, borderSubtle: border, borderStrong: strong,
            accent: .accentColor, accentText: .accentColor, onAccent: .white,
            focus: .accentColor, warning: .orange, warningSubtle: Color.orange.opacity(0.12),
            danger: .red, prefersMaterials: true)
    }()

    /// The Polaris Key palette for `scheme`, straight from the generated tokens: the dark theme
    /// for `.dark` (and any future scheme), the light theme for `.light`.
    public static func brand(for scheme: ColorScheme) -> PolarisPalette {
        scheme == .light ? brandLight : brandDark
    }

    /// The brand's dark theme (the brand default).
    public static let brandDark: PolarisPalette = {
        typealias T = PolarisBrand.Dark
        let core = PolarisBrand.accent(for: "core", dark: true)
        return PolarisPalette(
            page: T.surfacePage.color, raised: T.surfaceRaised.color,
            textStrong: T.textStrong.color, textDefault: T.textDefault.color,
            textMuted: T.textMuted.color, borderSubtle: T.borderSubtle.color,
            borderStrong: T.borderStrong.color, accent: core.solid.color,
            accentText: core.fg.color, onAccent: core.on.color, focus: T.focus.color,
            warning: T.warning.color, warningSubtle: T.warningSubtle.color,
            danger: T.danger.color)
    }()

    /// The brand's light theme.
    public static let brandLight: PolarisPalette = {
        typealias T = PolarisBrand.Light
        let core = PolarisBrand.accent(for: "core", dark: false)
        return PolarisPalette(
            page: T.surfacePage.color, raised: T.surfaceRaised.color,
            textStrong: T.textStrong.color, textDefault: T.textDefault.color,
            textMuted: T.textMuted.color, borderSubtle: T.borderSubtle.color,
            borderStrong: T.borderStrong.color, accent: core.solid.color,
            accentText: core.fg.color, onAccent: core.on.color, focus: T.focus.color,
            warning: T.warning.color, warningSubtle: T.warningSubtle.color,
            danger: T.danger.color)
    }()
}
