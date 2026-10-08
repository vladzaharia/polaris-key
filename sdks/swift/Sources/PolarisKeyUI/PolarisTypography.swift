// The gate's type. Natively the gate uses the system font with SwiftUI's own weights; under
// `.polarisKeyBranding(.polarisKey)` it uses the brand face, Rubik (BRAND.md §1.6): Rubik Bold for headings, Rubik Regular
// for body copy. The kit ships only those two weights, so the brand family never asks SwiftUI for a
// synthesised medium or semibold: a heading picks the Bold face by name instead of `.bold()`.
//
// ── WHY BUNDLING RUBIK IS CLEAN ─────────────────────────────────────────────────────────────────
//
// Rubik is under the SIL Open Font License 1.1 with no Reserved Font Name. The OFL lets the fonts be
// bundled with any software, whatever its own licence, provided they are not sold by themselves and
// the copyright notice and licence travel with them. PolarisKeyUI ships the kit's TTFs unchanged
// (`Resources/Brand/fonts/`, checked byte for byte against packages/brand/kit by BrandThemeTests),
// next to `OFL.txt` and the kit's `FONT-NOTICE.txt`. The fonts are registered for this process only
// (`CTFontManagerScope.process`), and only the first time a branded gate asks for them, so a
// native gate never touches CoreText registration and nothing is installed on the user's system.
//
// When registration fails (a host that strips resources, a sandbox that refuses CoreText), the brand
// family falls back to the system font rather than to a missing face. A product that wants its own
// type passes `PolarisTypography.system` or `.custom(regular:bold:)`.

import CoreText
import Foundation
import SwiftUI

/// The font family the gate renders its copy in.
public struct PolarisTypography: Sendable, Equatable {
    public enum Family: Sendable, Equatable {
        /// Rubik, bundled with PolarisKeyUI. Falls back to the system font if it cannot register.
        case brand
        /// The platform's system font (San Francisco), with SwiftUI's own weights.
        case system
        /// A product's own faces, by PostScript name. The product registers them (Info.plist
        /// `UIAppFonts` / `ATSApplicationFontsPath`, or CoreText).
        case custom(regular: String, bold: String)
    }

    /// The text roles the gate uses, each scaling with Dynamic Type from its SwiftUI text style.
    public enum Role: Sendable, CaseIterable {
        /// Card headings (`.title2`, bold face).
        case title
        /// Secondary copy under a heading (`.subheadline`).
        case subtitle
        /// The grace banner's heading (`.subheadline`, bold face).
        case bannerTitle
        /// Button labels and the licence-key field (`.body`).
        case body
        /// Small print: the "or" divider, errors, the banner body (`.caption`).
        case caption
    }

    public var family: Family

    public init(family: Family) {
        self.family = family
    }

    /// Rubik, the Polaris Key brand face (the default under `.polarisKeyBranding(.polarisKey)`).
    public static let brand = PolarisTypography(family: .brand)
    /// The system font (the default natively).
    public static let system = PolarisTypography(family: .system)
    /// A product's own faces, by PostScript name.
    public static func custom(regular: String, bold: String) -> PolarisTypography {
        PolarisTypography(family: .custom(regular: regular, bold: bold))
    }

    /// The family actually rendered: `.brand` resolves to `.system` when Rubik is unavailable.
    public var resolvedFamily: Family {
        if case .brand = family, !BrandFonts.isAvailable { return .system }
        return family
    }

    /// The font for `role`.
    public func font(_ role: Role) -> Font {
        let (style, bold) = Self.spec(role)
        switch resolvedFamily {
        case .system:
            let font = Font.system(style)
            return bold ? font.bold() : font
        case .brand:
            return Font.custom(
                bold ? BrandFonts.boldName : BrandFonts.regularName,
                size: Self.pointSize(style), relativeTo: style)
        case .custom(let regular, let boldName):
            return Font.custom(
                bold ? boldName : regular, size: Self.pointSize(style), relativeTo: style)
        }
    }

    /// How heavy a kit-internal text role is. The brand family ships Regular and Bold only, so
    /// `.medium` renders Regular there and never asks for a synthesised weight.
    enum Emphasis {
        case regular
        case medium
        case bold
    }

    /// The family at any text style, scaling with Dynamic Type from it.
    func font(style: Font.TextStyle, emphasis: Emphasis) -> Font {
        switch resolvedFamily {
        case .system:
            switch emphasis {
            case .regular: return .system(style)
            case .medium: return .system(style).weight(.medium)
            case .bold: return .system(style).bold()
            }
        case .brand:
            return .custom(
                emphasis == .bold ? BrandFonts.boldName : BrandFonts.regularName,
                size: Self.pointSize(style), relativeTo: style)
        case .custom(let regular, let bold):
            return .custom(
                emphasis == .bold ? bold : regular, size: Self.pointSize(style), relativeTo: style)
        }
    }

    /// The family at a fixed size (a glyph drawn inside a fixed tile, such as the monogram).
    func fixedFont(size: CGFloat, bold: Bool) -> Font {
        switch resolvedFamily {
        case .system: return .system(size: size, weight: bold ? .semibold : .regular)
        case .brand:
            return .custom(bold ? BrandFonts.boldName : BrandFonts.regularName, fixedSize: size)
        case .custom(let regular, let boldName):
            return .custom(bold ? boldName : regular, fixedSize: size)
        }
    }

    static func spec(_ role: Role) -> (Font.TextStyle, Bool) {
        switch role {
        case .title: return (.title2, true)
        case .subtitle: return (.subheadline, false)
        case .bannerTitle: return (.subheadline, true)
        case .body: return (.body, false)
        case .caption: return (.caption, false)
        }
    }

    /// The platform's default point size for the text styles the gate uses, so a custom face lands
    /// at the size the system font would have had before Dynamic Type scales it.
    static func pointSize(_ style: Font.TextStyle) -> CGFloat {
        #if os(macOS)
            switch style {
            case .largeTitle: return 26
            case .title: return 22
            case .title2: return 17
            case .title3: return 15
            case .callout: return 12
            case .subheadline: return 11
            case .footnote, .caption, .caption2: return 10
            default: return 13
            }
        #else
            switch style {
            case .largeTitle: return 34
            case .title: return 28
            case .title2: return 22
            case .title3: return 20
            case .callout: return 16
            case .subheadline: return 15
            case .footnote: return 13
            case .caption: return 12
            case .caption2: return 11
            default: return 17
            }
        #endif
    }
}

/// Process-scoped registration of the bundled Rubik faces.
enum BrandFonts {
    static let regularName = "Rubik-Regular"
    static let boldName = "Rubik-Bold"

    /// The bundled font files, in `Resources/Brand/fonts/`.
    static func url(_ name: String) -> URL? {
        brandResourceURL("fonts/\(name).ttf")
    }

    /// Registers both faces once per process; true when both can be instantiated by name.
    static let isAvailable: Bool = {
        for name in [regularName, boldName] {
            if let url = url(name) {
                // An "already registered" error (the host bundles Rubik too) is fine: the face is
                // reachable by name either way, which the check below confirms.
                _ = CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
        return [regularName, boldName].allSatisfy(isInstalled)
    }()

    static func isInstalled(_ postScriptName: String) -> Bool {
        let font = CTFontCreateWithName(postScriptName as CFString, 12, nil)
        return CTFontCopyPostScriptName(font) as String == postScriptName
    }
}
