// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

import Foundation

/// A corner radius: fixed points, or a capsule (half the control's height).
public enum KitRadius: Sendable, Equatable {
    case points(Double)
    case capsule
}

/// One role of a platform type scale, in points.
public struct KitTypeRole: Sendable, Equatable {
    public let size: Double
    public let lineHeight: Double
    public let weight: Int
    /// Letter spacing in em.
    public let tracking: Double
    /// Set in the kit mono (JetBrains Mono) rather than Rubik.
    public let mono: Bool
}

/// The UI-kit tokens (docs/design/UI-KITS.md §2.1) for the Apple kits: SwiftUI, UIKit and AppKit.
/// Read them as `PolarisKit.IOS.controlHeight`, `PolarisKit.MacOS.Typography.title`,
/// `PolarisKit.Dark.dangerSolid`. Colours are in PolarisBrand (BrandTokens.generated.swift).
public enum PolarisKit {
    /// The concentric rule: an inner radius is the outer radius less the inset, never below this.
    public static let concentricMin: Double = 8

    /// The inner radius of a surface of radius `outer` inset by `inset`.
    public static func concentricRadius(outer: Double, inset: Double) -> Double {
        max(concentricMin, outer - inset)
    }

    /// Font families the kit bundles (Resources/Brand/fonts).
    public static let fontFamily = "Rubik"
    public static let monoFamily = "JetBrains Mono"

    /// Motion durations in seconds and distances in points (the kit's own animations; system
    /// sheets keep their springs). notes/S-23 §5; zero the durations under Reduce Motion.
    public enum Motion {
        public static let micro: Double = 0.08
        public static let fast: Double = 0.12
        public static let base: Double = 0.2
        public static let moderate: Double = 0.26
        public static let slow: Double = 0.32
        public static let deliberate: Double = 0.48
        public static let shimmer: Double = 1.6
        public static let distanceXs: Double = 2
        public static let distanceSm: Double = 4
        public static let distanceMd: Double = 8
        public static let distanceLg: Double = 12
        public static let distanceXl: Double = 24
        public static let pressScale: Double = 0.98
        public static let sheetScale: Double = 0.98
    }

    public enum Dark {
        /// The 1 pt inner top edge on raised surfaces and primaries: white at this opacity.
        public static let highlight = BrandColor(hex: 0xffffff)
        public static let highlightOpacity: Double = 0.05
        /// The danger fill behind white labels (the accent resolver's white-first rule).
        public static let dangerSolid = BrandColor(hex: 0xdb3a2b)
        public static let dangerOn = BrandColor(hex: 0xffffff)
        /// The colour a scrim dims with; each platform sets its opacity.
        public static let scrimColor = BrandColor(hex: 0x020408)
        /// The four surfaces the accent resolver checks contrast on: page, raised, overlay, sunken.
        public static let accentSurfaces: [BrandColor] = [BrandColor(hex: 0x060912), BrandColor(hex: 0x0d111b), BrandColor(hex: 0x121722), BrandColor(hex: 0x020408)]
    }

    public enum Light {
        /// The 1 pt inner top edge on raised surfaces and primaries: white at this opacity.
        public static let highlight = BrandColor(hex: 0xffffff)
        public static let highlightOpacity: Double = 0.9
        /// The danger fill behind white labels (the accent resolver's white-first rule).
        public static let dangerSolid = BrandColor(hex: 0xbe2323)
        public static let dangerOn = BrandColor(hex: 0xffffff)
        /// The colour a scrim dims with; each platform sets its opacity.
        public static let scrimColor = BrandColor(hex: 0x060912)
        /// The four surfaces the accent resolver checks contrast on: page, raised, overlay, sunken.
        public static let accentSurfaces: [BrandColor] = [BrandColor(hex: 0xf6f8ff), BrandColor(hex: 0xffffff), BrandColor(hex: 0xffffff), BrandColor(hex: 0xebeef8)]
    }

    /// iOS, iPadOS, visionOS and tvOS (points).
    public enum IOS {
        public static let controlHeight: Double = 52
        public static let radiusControl: KitRadius = .capsule
        public static let radiusSheet: Double = 40
        public static let radiusFloating: Double = 40
        public static let radiusFloatingLarge: Double = 48
        public static let cardPad: Double = 20
        public static let focusSystem: Bool = true
        public static let focusWidth: Double = 0
        public static let focusOffset: Double = 0
        public static let focusInner: Double = 0
        public static let focusGlow: Double = 0
        public static let hasScrim: Bool = true
        public static let scrimDarkOpacity: Double = 0.32
        public static let scrimDarkBlur: Double = 0
        public static let scrimLightOpacity: Double = 0.18
        public static let scrimLightBlur: Double = 0

        /// The type scale (points). Weights are 400, 500 and 600 only.
        public enum Typography {
            public static let display = KitTypeRole(size: 34, lineHeight: 40, weight: 600, tracking: 0, mono: false)
            public static let title = KitTypeRole(size: 28, lineHeight: 34, weight: 600, tracking: 0, mono: false)
            public static let body = KitTypeRole(size: 17, lineHeight: 22, weight: 400, tracking: 0, mono: false)
            public static let label = KitTypeRole(size: 17, lineHeight: 22, weight: 500, tracking: 0, mono: false)
            public static let button = KitTypeRole(size: 17, lineHeight: 22, weight: 500, tracking: 0, mono: false)
            public static let meta = KitTypeRole(size: 15, lineHeight: 20, weight: 400, tracking: 0, mono: false)
            public static let footnote = KitTypeRole(size: 13, lineHeight: 18, weight: 400, tracking: 0, mono: false)
            public static let code = KitTypeRole(size: 28, lineHeight: 34, weight: 500, tracking: 0, mono: true)
        }
    }

    /// macOS (points).
    public enum MacOS {
        public static let controlHeight: Double = 28
        public static let controlHeightHero: Double = 36
        public static let radiusControl: KitRadius = .capsule
        public static let radiusForm: Double = 10
        public static let radiusSheet: Double = 18
        public static let cardPad: Double = 24
        public static let cardPadCompact: Double = 22
        public static let focusSystem: Bool = true
        public static let focusWidth: Double = 0
        public static let focusOffset: Double = 0
        public static let focusInner: Double = 0
        public static let focusGlow: Double = 0
        public static let hasScrim: Bool = false
        public static let scrimDarkOpacity: Double = 0
        public static let scrimDarkBlur: Double = 0
        public static let scrimLightOpacity: Double = 0
        public static let scrimLightBlur: Double = 0

        /// The type scale (points). Weights are 400, 500 and 600 only.
        public enum Typography {
            public static let display = KitTypeRole(size: 26, lineHeight: 32, weight: 600, tracking: 0, mono: false)
            public static let title = KitTypeRole(size: 22, lineHeight: 28, weight: 600, tracking: 0, mono: false)
            public static let body = KitTypeRole(size: 13, lineHeight: 16, weight: 400, tracking: 0, mono: false)
            public static let label = KitTypeRole(size: 13, lineHeight: 16, weight: 500, tracking: 0, mono: false)
            public static let button = KitTypeRole(size: 13, lineHeight: 16, weight: 500, tracking: 0, mono: false)
            public static let meta = KitTypeRole(size: 12, lineHeight: 15, weight: 400, tracking: 0, mono: false)
            public static let footnote = KitTypeRole(size: 12, lineHeight: 15, weight: 400, tracking: 0, mono: false)
            public static let code = KitTypeRole(size: 28, lineHeight: 34, weight: 600, tracking: 0.06, mono: true)
        }
    }
}
