// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

#if canImport(SwiftUI)
    import SwiftUI
#endif

/// An sRGB brand colour. `hex` is the 0xRRGGBB value the design system specifies.
public struct BrandColor: Sendable, Equatable, Hashable {
    public let hex: UInt32

    public init(hex: UInt32) {
        self.hex = hex
    }

    public var red: Double { Double((hex >> 16) & 0xFF) / 255.0 }
    public var green: Double { Double((hex >> 8) & 0xFF) / 255.0 }
    public var blue: Double { Double(hex & 0xFF) / 255.0 }

    #if canImport(SwiftUI)
        public var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: 1) }
    #endif
}

/// One section's accent in one theme: `solid` for indicators and fills, `fg` for text, `on` for
/// text on a solid fill, `subtle` for a tinted surface, `bit` for the K's terminal bit (nil on
/// core: the platform draws no bit).
public struct BrandAccent: Sendable, Equatable {
    public let solid: BrandColor
    public let fg: BrandColor
    public let on: BrandColor
    public let subtle: BrandColor
    public let bit: BrandColor?
}

/// Polaris Key brand tokens (@polaris-key/brand). Dark is the default theme.
public enum PolarisBrand {
    /// Kit primitives, verbatim (kit/08-developer/tokens.json).
    public enum Kit {
        public static let violetDark = BrandColor(hex: 0x9a5cff)
        public static let violetLight = BrandColor(hex: 0x7a2fff)
        public static let goldDark = BrandColor(hex: 0xffc24d)
        public static let goldLight = BrandColor(hex: 0xd07a00)
        public static let pageDark = BrandColor(hex: 0x060912)
        public static let pageLight = BrandColor(hex: 0xf6f8ff)
        public static let starDark = BrandColor(hex: 0xffffff)
        public static let starLight = BrandColor(hex: 0x7a2fff)
        public static let mutedDark = BrandColor(hex: 0xdbe4ff)
        public static let mutedLight = BrandColor(hex: 0x48536b)
    }

    /// Optical cuts by displayed (point) size, never pixel density.
    public static let faviconBelow: Double = 24
    public static let serviceMax: Double = 32
    public static let goldMinimumGlyph: Double = 48
    public static let clearSpaceRatio: Double = 0.25
    public static let poweredByPhrase = "Powered by Polaris Key"

    /// "Powered by" badge minimum sizes in points (CSS-pixel equivalents): never render smaller.
    public static let badgeMinHorizontal: (width: Double, height: Double) = (376, 144)
    public static let badgeMinCompact: (width: Double, height: Double) = (232, 88)
    public static let badgeMinStacked: (width: Double, height: Double) = (288, 336)

    /// Section ids: core plus every service slug.
    public static let serviceIds: [String] = ["core", "license", "config", "release", "distribution", "update", "identity", "sync"]

    /// The dark theme (default).
    public enum Dark {
        public static let surfacePage = BrandColor(hex: 0x060912)
        public static let surfaceRaised = BrandColor(hex: 0x0d111b)
        public static let surfaceOverlay = BrandColor(hex: 0x121722)
        public static let surfaceSunken = BrandColor(hex: 0x020408)
        public static let textStrong = BrandColor(hex: 0xffffff)
        public static let textDefault = BrandColor(hex: 0xdbe4ff)
        public static let textMuted = BrandColor(hex: 0xb5bed3)
        public static let textSubtle = BrandColor(hex: 0x969eb2)
        public static let textOnAccent = BrandColor(hex: 0x060912)
        public static let borderSubtle = BrandColor(hex: 0x212633)
        public static let borderStrong = BrandColor(hex: 0x61697b)
        public static let focus = BrandColor(hex: 0x9a5cff)
        public static let success = BrandColor(hex: 0x56d57b)
        public static let successOn = BrandColor(hex: 0x060912)
        public static let successBorder = BrandColor(hex: 0x3b9555)
        public static let successSubtle = BrandColor(hex: 0x10211f)
        public static let warning = BrandColor(hex: 0xc38d18)
        public static let warningOn = BrandColor(hex: 0x060912)
        public static let warningBorder = BrandColor(hex: 0x896100)
        public static let warningSubtle = BrandColor(hex: 0x1d1913)
        public static let danger = BrandColor(hex: 0xf2513f)
        public static let dangerOn = BrandColor(hex: 0x060912)
        public static let dangerBorder = BrandColor(hex: 0xc83b2c)
        public static let dangerSubtle = BrandColor(hex: 0x221217)
        public static let info = BrandColor(hex: 0xb688fe)
        public static let infoOn = BrandColor(hex: 0x060912)
        public static let infoBorder = BrandColor(hex: 0x8f54dc)
        public static let infoSubtle = BrandColor(hex: 0x1b182e)
        public static let signed = BrandColor(hex: 0xffc24d)
        public static let signedOn = BrandColor(hex: 0x060912)
        public static let signedBorder = BrandColor(hex: 0xba882e)
        public static let signedSubtle = BrandColor(hex: 0x241f19)
        public static let signedMark = BrandColor(hex: 0xffc24d)
        public static let brandViolet = BrandColor(hex: 0x9a5cff)
        public static let brandStar = BrandColor(hex: 0xffffff)
        public static let brandGold = BrandColor(hex: 0xffc24d)
    }

    /// The light theme.
    public enum Light {
        public static let surfacePage = BrandColor(hex: 0xf6f8ff)
        public static let surfaceRaised = BrandColor(hex: 0xffffff)
        public static let surfaceOverlay = BrandColor(hex: 0xffffff)
        public static let surfaceSunken = BrandColor(hex: 0xebeef8)
        public static let textStrong = BrandColor(hex: 0x060912)
        public static let textDefault = BrandColor(hex: 0x262d40)
        public static let textMuted = BrandColor(hex: 0x48536b)
        public static let textSubtle = BrandColor(hex: 0x5d667b)
        public static let textOnAccent = BrandColor(hex: 0xffffff)
        public static let borderSubtle = BrandColor(hex: 0xdadee9)
        public static let borderStrong = BrandColor(hex: 0x7e8699)
        public static let focus = BrandColor(hex: 0x7a2fff)
        public static let success = BrandColor(hex: 0x167337)
        public static let successOn = BrandColor(hex: 0xffffff)
        public static let successBorder = BrandColor(hex: 0x348f4f)
        public static let successSubtle = BrandColor(hex: 0xe0ebeb)
        public static let warning = BrandColor(hex: 0x814d00)
        public static let warningOn = BrandColor(hex: 0xffffff)
        public static let warningBorder = BrandColor(hex: 0x9d6726)
        public static let warningSubtle = BrandColor(hex: 0xeae7e6)
        public static let danger = BrandColor(hex: 0xbe2323)
        public static let dangerOn = BrandColor(hex: 0xffffff)
        public static let dangerBorder = BrandColor(hex: 0xdb423c)
        public static let dangerSubtle = BrandColor(hex: 0xf0e3e9)
        public static let info = BrandColor(hex: 0x7a2fff)
        public static let infoOn = BrandColor(hex: 0xffffff)
        public static let infoBorder = BrandColor(hex: 0x8e66f1)
        public static let infoSubtle = BrandColor(hex: 0xeae4ff)
        public static let signed = BrandColor(hex: 0xc47300)
        public static let signedOn = BrandColor(hex: 0x060912)
        public static let signedBorder = BrandColor(hex: 0xbf7101)
        public static let signedSubtle = BrandColor(hex: 0xf1ebe6)
        public static let signedMark = BrandColor(hex: 0xd07a00)
        public static let brandViolet = BrandColor(hex: 0x7a2fff)
        public static let brandStar = BrandColor(hex: 0x7a2fff)
        public static let brandGold = BrandColor(hex: 0xd07a00)
    }

    private static let accentsDark: [String: BrandAccent] = [
            "core": BrandAccent(solid: BrandColor(hex: 0x9a5cff), fg: BrandColor(hex: 0x9a5cff), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x18132e), bit: nil),
            "license": BrandAccent(solid: BrandColor(hex: 0xc6e940), fg: BrandColor(hex: 0xc6e940), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x1d2418), bit: BrandColor(hex: 0xc6e940)),
            "config": BrandAccent(solid: BrandColor(hex: 0xfac700), fg: BrandColor(hex: 0xfac700), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x232010), bit: BrandColor(hex: 0xfac700)),
            "release": BrandAccent(solid: BrandColor(hex: 0x00dbfd), fg: BrandColor(hex: 0x00dbfd), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x05222e), bit: BrandColor(hex: 0x00dbfd)),
            "distribution": BrandAccent(solid: BrandColor(hex: 0x39d075), fg: BrandColor(hex: 0x39d075), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x0c211e), bit: BrandColor(hex: 0x39d075)),
            "update": BrandAccent(solid: BrandColor(hex: 0xfe8001), fg: BrandColor(hex: 0xfe8001), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x241710), bit: BrandColor(hex: 0xfe8001)),
            "identity": BrandAccent(solid: BrandColor(hex: 0xd77df2), fg: BrandColor(hex: 0xd77df2), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x1f172d), bit: BrandColor(hex: 0xd77df2)),
            "sync": BrandAccent(solid: BrandColor(hex: 0x14f8e1), fg: BrandColor(hex: 0x14f8e1), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0x08262b), bit: BrandColor(hex: 0x14f8e1)),
    ]

    private static let accentsLight: [String: BrandAccent] = [
            "core": BrandAccent(solid: BrandColor(hex: 0x7a2fff), fg: BrandColor(hex: 0x7a2fff), on: BrandColor(hex: 0xffffff), subtle: BrandColor(hex: 0xeae4ff), bit: nil),
            "license": BrandAccent(solid: BrandColor(hex: 0x708d00), fg: BrandColor(hex: 0x556e00), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0xe9ede6), bit: BrandColor(hex: 0x708d00)),
            "config": BrandAccent(solid: BrandColor(hex: 0x8b6902), fg: BrandColor(hex: 0x866500), on: BrandColor(hex: 0xffffff), subtle: BrandColor(hex: 0xebeae6), bit: BrandColor(hex: 0x8b6902)),
            "release": BrandAccent(solid: BrandColor(hex: 0x0390a6), fg: BrandColor(hex: 0x007487), on: BrandColor(hex: 0x060912), subtle: BrandColor(hex: 0xdeeef6), bit: BrandColor(hex: 0x0390a6)),
            "distribution": BrandAccent(solid: BrandColor(hex: 0x05773b), fg: BrandColor(hex: 0x05773b), on: BrandColor(hex: 0xffffff), subtle: BrandColor(hex: 0xdeebeb), bit: BrandColor(hex: 0x05773b)),
            "update": BrandAccent(solid: BrandColor(hex: 0xb95800), fg: BrandColor(hex: 0xaa5000), on: BrandColor(hex: 0xffffff), subtle: BrandColor(hex: 0xf0e8e6), bit: BrandColor(hex: 0xb95800)),
            "identity": BrandAccent(solid: BrandColor(hex: 0x9e34ae), fg: BrandColor(hex: 0x9e34ae), on: BrandColor(hex: 0xffffff), subtle: BrandColor(hex: 0xede4f7), bit: BrandColor(hex: 0x9e34ae)),
            "sync": BrandAccent(solid: BrandColor(hex: 0x086260), fg: BrandColor(hex: 0x086260), on: BrandColor(hex: 0xffffff), subtle: BrandColor(hex: 0xdee9ef), bit: BrandColor(hex: 0x086260)),
    ]

    /// A section's accent. Unknown ids answer the core (platform) violet.
    public static func accent(for service: String, dark: Bool = true) -> BrandAccent {
        let table = dark ? accentsDark : accentsLight
        return table[service] ?? table["core"]!
    }

    /// Which optical cut a mark displayed at `size` points uses.
    public static func opticalCut(for size: Double) -> String {
        if size < faviconBelow { return "favicon" }
        if size <= serviceMax { return "service" }
        return "display"
    }
}
