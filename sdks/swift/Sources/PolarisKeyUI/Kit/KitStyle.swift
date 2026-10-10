// The resolved look every Polaris Key part draws with (UI-KITS §1.1, §1.4 iOS row, §2.1, §3.3):
// colours from the generated brand tokens on the iOS system grouped grounds, the product accent
// through the contrast resolver (`PolarisAccent`), Rubik scaled with Dynamic Type, the iOS
// measures (52 pt capsule controls, 20 pt card padding, the 4 pt spacing grid) and the person's
// settings (Reduce Motion, Reduce Transparency, Increase Contrast). Under `native` the system's own
// colours, fonts and the app's tint take over (§3.4).

import CoreGraphics
import CoreText
import Foundation
import PolarisKeyUICore
import SwiftUI

/// The colours of one scheme.
public struct KitPalette: Sendable, Equatable {
    public var page: Color
    public var raised: Color
    public var sunken: Color
    public var textStrong: Color
    public var textDefault: Color
    public var textMuted: Color
    public var textSubtle: Color
    public var border: Color
    /// The accent's fill (the primary), ≥ 3:1 on every surface.
    public var accentSolid: Color
    /// The label on the fill, ≥ 4.5:1 on it.
    public var accentOn: Color
    /// Accent text and glyphs, ≥ 4.5:1 on every surface.
    public var accentFg: Color
    /// The tinted fill for a selected row.
    public var accentSubtle: Color
    public var focus: Color
    public var success: Color
    public var warning: Color
    public var danger: Color
    /// Whether the accent is the host's tint (`native`, or `host` source).
    public var accentIsHostTint: Bool
}

/// The resolved style.
public struct KitResolvedStyle: Sendable, Equatable {
    public var palette: KitPalette
    public var preset: KitPreset
    public var dark: Bool
    public var identity: ResolvedIdentity
    /// The locale the copy reads.
    public var locale: String
    public var typography: PolarisKeyTheme.Typography
    public var density: PolarisKeyTheme.Density
    public var reduceMotion: Bool
    public var reduceTransparency: Bool
    public var increaseContrast: Bool
    public var ambient: Bool
    public var poweredBy: PolarisKeyTheme.PoweredBy?
    public var platform: KitPlatform
    /// Draw the iOS 18 material fallback even where Liquid Glass exists (review and baselines).
    public var forcesMaterial = false

    /// Liquid Glass is available (iOS 26) and transparency is not reduced.
    public var usesGlass: Bool {
        guard !reduceTransparency, !forcesMaterial else { return false }
        if #available(iOS 26.0, macOS 26.0, *) { return true }
        return false
    }

    public var isNative: Bool { preset == .native }

    // MARK: Measures (UI-KITS §2.1 iOS column; DL3 density steps)

    /// A control's height: 52 pt, a step down in compact, up in spacious.
    public var controlHeight: CGFloat {
        switch density {
        case .compact: return 44
        case .comfortable: return CGFloat(PolarisKit.IOS.controlHeight)
        case .spacious: return 60
        }
    }

    public var cardPad: CGFloat { CGFloat(PolarisKit.IOS.cardPad) }
    /// The inset grouped list's radius.
    public var groupRadius: CGFloat { 16 }
    /// A field's radius (filled, no border).
    public var fieldRadius: CGFloat { 14 }
    /// The sheet's radius (concentric with the device's corners).
    public var sheetRadius: CGFloat { CGFloat(PolarisKit.IOS.radiusSheet) }

    /// The 4 pt spacing scale (BRAND §4.6; DL3).
    public func space(_ step: KitSpace) -> CGFloat {
        let base: CGFloat
        switch step {
        case .xxs: base = 4
        case .xs: base = 8
        case .sm: base = 12
        case .md: base = 16
        case .lg: base = 24
        case .xl: base = 32
        case .xxl: base = 48
        }
        switch density {
        case .compact: return max(4, base - (base >= 16 ? 4 : 0))
        case .comfortable: return base
        case .spacious: return base + (base >= 16 ? 8 : 4)
        }
    }

    /// A duration from the motion tokens, 0 under Reduce Motion (DL16).
    public func duration(_ seconds: Double) -> Double { reduceMotion ? 0 : seconds }

    /// A morph between steps (SIGN-IN.md §3.18): `.smooth(duration: 0.26)`, none when reduced.
    public var morph: Animation? {
        reduceMotion ? nil : .smooth(duration: PolarisKit.Motion.moderate)
    }

    // MARK: Type

    /// The font for `role`, scaled with Dynamic Type (UI-KITS §2.1 iOS type scale; DL11, DL12).
    public func font(_ role: KitTextRole) -> Font {
        let spec = role.spec
        let scale = typography.scale
        let size = CGFloat(spec.size * scale)
        if isNative || typography.family == .system {
            if role == .code || role == .key {
                return Font.system(spec.textStyle, design: .monospaced).weight(spec.weight.swiftUI)
            }
            return Font.system(spec.textStyle).weight(spec.weight.swiftUI)
        }
        if role == .code || role == .key {
            guard let name = KitFonts.monoName(spec.weight) else {
                return Font.system(spec.textStyle, design: .monospaced).weight(spec.weight.swiftUI)
            }
            return Font.custom(name, size: size, relativeTo: spec.textStyle)
        }
        if case .custom(let family) = typography.family {
            let face = (role == .display || role == .title) ? (typography.display ?? family) : family
            return Font.custom(face, size: size, relativeTo: spec.textStyle).weight(spec.weight.swiftUI)
        }
        guard let name = KitFonts.rubikName(spec.weight) else {
            return Font.system(spec.textStyle).weight(spec.weight.swiftUI)
        }
        return Font.custom(name, size: size, relativeTo: spec.textStyle)
    }
}

/// The spacing steps.
public enum KitSpace: Sendable {
    case xxs, xs, sm, md, lg, xl, xxl
}

/// The kit's text roles (UI-KITS §2.1 type scale, iOS points).
public enum KitTextRole: Sendable, CaseIterable {
    case display, title, headline, body, label, button, meta, footnote, code, key

    struct Spec {
        let size: Double
        let weight: KitWeight
        let textStyle: Font.TextStyle
    }

    var spec: Spec {
        let t = PolarisKit.IOS.Typography.self
        switch self {
        case .display: return Spec(size: t.display.size, weight: .semibold, textStyle: .largeTitle)
        case .title: return Spec(size: t.title.size, weight: .semibold, textStyle: .title)
        case .headline: return Spec(size: 20, weight: .semibold, textStyle: .title3)
        case .body: return Spec(size: t.body.size, weight: .regular, textStyle: .body)
        case .label: return Spec(size: t.label.size, weight: .medium, textStyle: .body)
        case .button: return Spec(size: t.button.size, weight: .medium, textStyle: .body)
        case .meta: return Spec(size: t.meta.size, weight: .regular, textStyle: .subheadline)
        case .footnote: return Spec(size: t.footnote.size, weight: .regular, textStyle: .footnote)
        case .code: return Spec(size: t.code.size, weight: .medium, textStyle: .title)
        case .key: return Spec(size: t.body.size, weight: .regular, textStyle: .body)
        }
    }
}

/// The three weights (DL12).
enum KitWeight {
    case regular, medium, semibold

    var swiftUI: Font.Weight {
        switch self {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        }
    }
}

/// The variable Rubik and JetBrains Mono the kit bundles (Resources/Brand/fonts), registered once
/// per process. Each named instance of a variable font has its own PostScript name
/// (`Rubik-Light_SemiBold`), which `Font.custom` needs exactly, so the names are read from the
/// files' descriptors rather than assumed.
enum KitFonts {
    static func register() { _ = faces }

    /// Style name ("Regular", "Medium", "SemiBold") → PostScript name, per family.
    private static let faces: (rubik: [String: String], mono: [String: String]) = {
        func load(_ file: String) -> [String: String] {
            guard let url = BrandFonts.url(file) else { return [:] }
            _ = CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            let descriptors =
                CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] ?? []
            var map: [String: String] = [:]
            for d in descriptors {
                guard let name = CTFontDescriptorCopyAttribute(d, kCTFontNameAttribute) as? String
                else { continue }
                let style =
                    (CTFontDescriptorCopyAttribute(d, kCTFontStyleNameAttribute) as? String)
                    ?? name.components(separatedBy: CharacterSet(charactersIn: "-_")).last ?? ""
                map[style.replacingOccurrences(of: " ", with: "").lowercased()] = name
            }
            return map
        }
        return (load("Rubik-Variable"), load(BrandFonts.monoFile))
    }()

    static var rubikAvailable: Bool { rubikName(.semibold) != nil }
    static var monoAvailable: Bool { monoName(.regular) != nil }

    private static func pick(_ map: [String: String], _ weight: KitWeight) -> String? {
        let order: [String]
        switch weight {
        case .regular: order = ["regular"]
        case .medium: order = ["medium", "regular"]
        case .semibold: order = ["semibold", "medium", "bold"]
        }
        for style in order {
            if let name = map[style], BrandFonts.isInstalled(name) { return name }
        }
        return nil
    }

    static func rubikName(_ weight: KitWeight) -> String? {
        register()
        return pick(faces.rubik, weight)
    }

    static func monoName(_ weight: KitWeight) -> String? {
        register()
        return pick(faces.mono, weight)
    }
}

// MARK: - Resolution

enum KitPaletteResolver {
    /// iOS grounds (UI-KITS §1.4): system grouped black / #f2f2f7 with cells #16181d / white.
    static func palette(
        identity: ResolvedIdentity, preset: KitPreset, dark: Bool, derivedAccent: String?,
        increaseContrast: Bool
    ) -> KitPalette {
        let tokens: (BrandColor, BrandColor, BrandColor, BrandColor, BrandColor, BrandColor) =
            dark
            ? (
                PolarisBrand.Dark.textStrong, PolarisBrand.Dark.textDefault,
                PolarisBrand.Dark.textMuted, PolarisBrand.Dark.textSubtle,
                PolarisBrand.Dark.borderSubtle, PolarisBrand.Dark.borderStrong
            )
            : (
                PolarisBrand.Light.textStrong, PolarisBrand.Light.textDefault,
                PolarisBrand.Light.textMuted, PolarisBrand.Light.textSubtle,
                PolarisBrand.Light.borderSubtle, PolarisBrand.Light.borderStrong
            )
        let status =
            dark
            ? (PolarisBrand.Dark.success, PolarisBrand.Dark.warning, PolarisBrand.Dark.danger)
            : (PolarisBrand.Light.success, PolarisBrand.Light.warning, PolarisBrand.Light.danger)
        let page = dark ? BrandColor(hex: 0x000000) : BrandColor(hex: 0xf2f2f7)
        let raised = dark ? BrandColor(hex: 0x16181d) : BrandColor(hex: 0xffffff)
        let sunken = dark ? BrandColor(hex: 0x1f2128) : BrandColor(hex: 0xffffff)

        var p = KitPalette(
            page: page.color, raised: raised.color, sunken: sunken.color,
            textStrong: tokens.0.color, textDefault: tokens.1.color, textMuted: tokens.2.color,
            textSubtle: tokens.3.color,
            border: (increaseContrast ? tokens.5 : tokens.4).color,
            accentSolid: tokens.0.color, accentOn: page.color, accentFg: tokens.0.color,
            accentSubtle: (dark ? BrandColor(hex: 0x23262e) : BrandColor(hex: 0xe6e8ef)).color,
            focus: tokens.0.color, success: status.0.color, warning: status.1.color,
            danger: status.2.color, accentIsHostTint: false)

        if preset == .native {
            p.page = Color.systemGroupedGround
            p.raised = Color.secondarySystemGroupedGround
            p.sunken = Color.tertiarySystemGroupedGround
            p.textStrong = .primary
            p.textDefault = .primary
            p.textMuted = .secondary
            p.textSubtle = .secondary
        }

        let input: String?
        switch identity.accentSource {
        case .integrator, .product, .core:
            input = dark ? (identity.accentDark ?? identity.accentLight) : identity.accentLight
        case .icon:
            input = derivedAccent
        case .host:
            p.accentSolid = .accentColor
            p.accentFg = .accentColor
            p.accentOn = .white
            p.accentSubtle = Color.accentColor.opacity(0.14)
            p.focus = .accentColor
            p.accentIsHostTint = true
            return p
        case .ink:
            input = nil
        }
        if let input, let r = PolarisAccent.resolve(input, dark: dark),
            let solid = BrandColor(hexString: r.solid), let on = BrandColor(hexString: r.on),
            let fg = BrandColor(hexString: r.fg), let subtle = BrandColor(hexString: r.subtle),
            let focus = BrandColor(hexString: r.focus)
        {
            p.accentSolid = solid.color
            p.accentOn = on.color
            p.accentFg = fg.color
            p.accentSubtle = subtle.color
            p.focus = focus.color
        }
        return p
    }
}

extension Color {
    #if canImport(UIKit)
        static let systemGroupedGround = Color(uiColor: .systemGroupedBackground)
        static let secondarySystemGroupedGround = Color(uiColor: .secondarySystemGroupedBackground)
        static let tertiarySystemGroupedGround = Color(uiColor: .tertiarySystemGroupedBackground)
    #else
        static let systemGroupedGround = Color(nsColor: .windowBackgroundColor)
        static let secondarySystemGroupedGround = Color(nsColor: .controlBackgroundColor)
        static let tertiarySystemGroupedGround = Color(nsColor: .textBackgroundColor)
    #endif
}

private struct KitResolvedStyleKey: EnvironmentKey {
    static let defaultValue: KitResolvedStyle? = nil
}

extension EnvironmentValues {
    /// The resolved style, set by `PolarisKeyStyleScope`; nil outside one (parts then resolve
    /// a default from the theme and the scheme).
    public var polarisKeyStyle: KitResolvedStyle? {
        get { self[KitResolvedStyleKey.self] }
        set { self[KitResolvedStyleKey.self] = newValue }
    }
}

/// Resolves the theme for a subtree: the identity from the model's inputs, the scheme, the
/// person's settings, and the accent (derived from the icon when the product names none).
struct PolarisKeyStyleScope: ViewModifier {
    let inputs: KitInputs
    let icon: CGImage?

    @Environment(\.polarisKeyTheme) private var theme
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.locale) private var locale
    @Environment(\.polarisKeyMaterialFallback) private var forcesMaterial

    func body(content: Content) -> some View {
        let style = resolved()
        content
            .environment(\.polarisKeyStyle, style)
            .environment(\.kitIconImage, icon)
            .preferredColorScheme(preferredScheme)
            .tint(style.palette.accentSolid)
    }

    private var preferredScheme: ColorScheme? {
        switch theme.colorScheme {
        case .system: return nil
        case .dark: return .dark
        case .light: return .light
        }
    }

    private func resolved() -> KitResolvedStyle {
        var i = inputs
        if let integrator = theme.integrator {
            i.integrator = integrator
        }
        if icon != nil { i.bundle.icon = true }
        let identity = KitIdentity.resolve(i, preset: theme.preset)
        let dark: Bool
        switch theme.colorScheme {
        case .dark: dark = true
        case .light: dark = false
        case .system: dark = systemScheme == .dark
        }
        let derived = identity.accentSource == .icon ? icon.flatMap(KitIconAccent.derive) : nil
        let palette = KitPaletteResolver.palette(
            identity: identity, preset: theme.preset, dark: dark, derivedAccent: derived,
            increaseContrast: contrast == .increased)
        let motionReduced: Bool
        switch theme.motion {
        case .system: motionReduced = reduceMotion
        case .reduced, .none: motionReduced = true
        }
        return KitResolvedStyle(
            palette: palette, preset: theme.preset, dark: dark, identity: identity,
            locale: theme.locale ?? locale.identifier, typography: theme.typography,
            density: theme.density, reduceMotion: motionReduced,
            reduceTransparency: reduceTransparency, increaseContrast: contrast == .increased,
            ambient: theme.ambient ?? (theme.preset != .native), poweredBy: theme.poweredBy,
            platform: inputs.platform, forcesMaterial: forcesMaterial)
    }
}

private struct PolarisKeyMaterialFallbackKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Draw the designed iOS 18 fallback (system materials, solid capsules) on iOS 26 as well: the
    /// sample's `-pkeyMaterial` uses it to render the fallback where no iOS 18 runtime is installed.
    public var polarisKeyMaterialFallback: Bool {
        get { self[PolarisKeyMaterialFallbackKey.self] }
        set { self[PolarisKeyMaterialFallbackKey.self] = newValue }
    }
}

private struct KitIconImageKey: EnvironmentKey {
    static let defaultValue: CGImage? = nil
}

extension EnvironmentValues {
    /// The product icon the kit draws (the integrator's, the presentation's, the bundle's).
    var kitIconImage: CGImage? {
        get { self[KitIconImageKey.self] }
        set { self[KitIconImageKey.self] = newValue }
    }
}

/// The accent derived from the icon (UI-KITS §3.3 `deriveAccent`), cached per image.
enum KitIconAccent {
    @MainActor private static var cache: [ObjectIdentifier: String?] = [:]

    static func derive(_ image: CGImage) -> String? {
        MainActor.assumeIsolated {
            let key = ObjectIdentifier(image)
            if let hit = cache[key] { return hit }
            let value = PolarisAccent.derive(rgba: rgba(image, side: 48))
            cache[key] = value
            return value
        }
    }

    /// The image's pixels as RGBA bytes at `side` × `side`.
    static func rgba(_ image: CGImage, side: Int) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        bytes.withUnsafeMutableBytes { buffer in
            guard
                let ctx = CGContext(
                    data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8,
                    bytesPerRow: side * 4, space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        return bytes
    }
}

extension View {
    /// The resolved style of this subtree, or a default when no scope set one.
    func kitStyle<V: View>(@ViewBuilder _ body: @escaping (KitResolvedStyle) -> V) -> some View {
        KitStyleReader(content: body)
    }
}

/// Reads the resolved style, resolving a default one outside a scope.
struct KitStyleReader<Content: View>: View {
    let content: (KitResolvedStyle) -> Content
    @Environment(\.polarisKeyStyle) private var style

    init(@ViewBuilder content: @escaping (KitResolvedStyle) -> Content) {
        self.content = content
    }

    var body: some View {
        if let style {
            content(style)
        } else {
            content(KitResolvedStyle.fallback)
        }
    }
}

extension KitResolvedStyle {
    /// The look outside a scope: Tidewater's fixture identity in ink, dark.
    static let fallback: KitResolvedStyle = {
        let identity = KitIdentity.resolve(PolarisKeyPreviewState.base())
        return KitResolvedStyle(
            palette: KitPaletteResolver.palette(
                identity: identity, preset: .polarisKey, dark: true, derivedAccent: nil,
                increaseContrast: false),
            preset: .polarisKey, dark: true, identity: identity, locale: "en",
            typography: PolarisKeyTheme.Typography(), density: .comfortable, reduceMotion: false,
            reduceTransparency: false, increaseContrast: false, ambient: true, poweredBy: nil,
            platform: KitPlatform.current)
    }()
}
