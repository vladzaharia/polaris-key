// @pkey-feature ui.kit
// The SwiftUI kit's branding (docs/design/BRAND.md, owner decisions 2026-10-04): native and
// neutral by default, the Polaris Key brand behind one opt-in (`.polarisKeyBranding(.polarisKey)`
// or `PolarisTheme(branding:)`), whose palette is the generated `PolarisBrand` values in each colour
// scheme; an integrator's overrides land where they should; the bundled Rubik registers; the badge
// is off by default and never renders below its kit minimum; and every bundled kit file is
// byte-identical to packages/brand/kit.

#if canImport(SwiftUI)
    import Foundation
    @testable import PolarisKeyUI
    import SwiftUI
    import XCTest

    final class BrandThemeTests: XCTestCase {
        /// The pre-2026-10-04 non-optional `accent` and `logo` still compile (deprecated) and map
        /// onto the optional overrides.
        @available(*, deprecated)
        func testDeprecatedAccentAndLogoMapOntoTheOverrides() {
            var theme = PolarisTheme()
            XCTAssertEqual(theme.accent, .accentColor)
            _ = theme.logo()
            theme.accent = .teal
            XCTAssertEqual(theme.accentOverride, .teal)
            XCTAssertEqual(PolarisTheme(accent: .orange).accent, .orange)
            theme.logo = { AnyView(Text("L")) }
            XCTAssertNotNil(theme.logoOverride)
        }

        func testBrandPaletteIsTheGeneratedTokens() {
            let dark = PolarisPalette.brand(for: .dark)
            XCTAssertEqual(dark.page, PolarisBrand.Dark.surfacePage.color)
            XCTAssertEqual(dark.raised, PolarisBrand.Dark.surfaceRaised.color)
            XCTAssertEqual(dark.textStrong, PolarisBrand.Dark.textStrong.color)
            XCTAssertEqual(dark.textMuted, PolarisBrand.Dark.textMuted.color)
            XCTAssertEqual(dark.focus, PolarisBrand.Dark.focus.color)
            XCTAssertEqual(dark.warningSubtle, PolarisBrand.Dark.warningSubtle.color)
            XCTAssertEqual(dark.danger, PolarisBrand.Dark.danger.color)

            let light = PolarisPalette.brand(for: .light)
            XCTAssertEqual(light.page, PolarisBrand.Light.surfacePage.color)
            XCTAssertEqual(light.raised, PolarisBrand.Light.surfaceRaised.color)
            XCTAssertEqual(light.textStrong, PolarisBrand.Light.textStrong.color)
            XCTAssertEqual(light.focus, PolarisBrand.Light.focus.color)
            XCTAssertNotEqual(dark, light)
        }

        /// SDK UI is a core surface (BRAND.md §7.1): the core violet, which is the kit violet.
        func testAccentIsTheCoreViolet() {
            let dark = PolarisBrand.accent(for: "core", dark: true)
            let light = PolarisBrand.accent(for: "core", dark: false)
            XCTAssertEqual(PolarisPalette.brandDark.accent, dark.solid.color)
            XCTAssertEqual(PolarisPalette.brandDark.accentText, dark.fg.color)
            XCTAssertEqual(PolarisPalette.brandDark.onAccent, dark.on.color)
            XCTAssertEqual(PolarisPalette.brandLight.accent, light.solid.color)
            XCTAssertEqual(dark.solid, PolarisBrand.Kit.violetDark)
            XCTAssertEqual(light.solid, PolarisBrand.Kit.violetLight)
            XCTAssertNil(dark.bit, "the core mark draws no bit")
        }

        func testBrandingDefaultsToNativeEverywhere() {
            XCTAssertEqual(EnvironmentValues().polarisKeyBranding, .native)
            let theme = PolarisTheme()
            XCTAssertEqual(theme.resolvedPalette(for: .dark), .native)
            XCTAssertEqual(theme.resolvedTypography(), .system)
            XCTAssertFalse(theme.setsTint(), "a native gate inherits the host app's tint")
            XCTAssertNil(theme.poweredBy)
        }

        func testTheEnvironmentOptInSwitchesToTheBrand() {
            var environment = EnvironmentValues()
            environment.polarisKeyBranding = .polarisKey
            let theme = PolarisTheme()
            let branding = environment.polarisKeyBranding
            XCTAssertEqual(theme.resolvedBranding(branding), .polarisKey)
            XCTAssertEqual(
                theme.resolvedPalette(for: .dark, branding: branding), PolarisPalette.brandDark)
            XCTAssertEqual(
                theme.resolvedPalette(for: .light, branding: branding), PolarisPalette.brandLight)
            XCTAssertEqual(theme.resolvedTypography(branding: branding), .brand)
            XCTAssertTrue(theme.setsTint(branding: branding))
            XCTAssertNil(theme.poweredBy, "the badge stays a separate opt-in")
        }

        /// The theme's own `branding` wins over the environment, in both directions.
        func testThemeBrandingOverridesTheEnvironment() {
            let branded = PolarisTheme(branding: .polarisKey)
            XCTAssertEqual(branded.resolvedBranding(.native), .polarisKey)
            XCTAssertEqual(branded.resolvedPalette(for: .light), .brandLight)
            let native = PolarisTheme(branding: .native)
            XCTAssertEqual(native.resolvedBranding(.polarisKey), .native)
            XCTAssertEqual(native.resolvedPalette(for: .dark, branding: .polarisKey), .native)
        }

        func testNativePaletteUsesTheSystemAndTheAppAccent() {
            let native = PolarisPalette.native
            XCTAssertEqual(native.accent, .accentColor)
            XCTAssertEqual(native.textStrong, .primary)
            XCTAssertEqual(native.textMuted, .secondary)
            XCTAssertTrue(native.prefersMaterials)
            XCTAssertFalse(PolarisPalette.brandDark.prefersMaterials)
            XCTAssertEqual(PolarisPalette.standard(.native, for: .light), native)
            XCTAssertEqual(PolarisPalette.standard(.polarisKey, for: .light), .brandLight)
        }

        func testAccentOverrideAppliesInBothSchemesAndLeavesTheRest() {
            let theme = PolarisTheme(accent: .teal, accentOn: .black)
            XCTAssertTrue(theme.setsTint(), "an explicit accent is applied even natively")
            for branding in PolarisBranding.allCases {
                for scheme in [ColorScheme.dark, .light] {
                    let resolved = theme.resolvedPalette(for: scheme, branding: branding)
                    let base = PolarisPalette.standard(branding, for: scheme)
                    XCTAssertEqual(resolved.accent, .teal)
                    XCTAssertEqual(resolved.accentText, .teal)
                    XCTAssertEqual(resolved.onAccent, .black)
                    XCTAssertEqual(resolved.page, base.page)
                    XCTAssertEqual(resolved.focus, base.focus)
                }
            }
        }

        func testTypographyOverrideWinsOverBranding() {
            let theme = PolarisTheme(typography: .custom(regular: "A", bold: "B"))
            XCTAssertEqual(theme.resolvedTypography(), .custom(regular: "A", bold: "B"))
            XCTAssertEqual(
                theme.resolvedTypography(branding: .polarisKey), .custom(regular: "A", bold: "B"))
            XCTAssertEqual(
                PolarisTheme(typography: .system).resolvedTypography(branding: .polarisKey),
                .system)
        }

        func testGateLayoutIsCentredAtAComfortableWidth() {
            // A readable card on iPad and macOS rather than edge to edge; one radius per kind.
            XCTAssertLessThanOrEqual(PolarisGateLayout.cardMaxWidth, 480)
            XCTAssertGreaterThanOrEqual(PolarisGateLayout.cardMaxWidth, 360)
            XCTAssertGreaterThan(PolarisGateLayout.cardRadius, PolarisGateLayout.controlRadius)
            XCTAssertGreaterThanOrEqual(PolarisGateLayout.pagePadding, 16)
        }

        func testPaletteOverrideReplacesEveryColour() {
            var custom = PolarisPalette.brandLight
            custom.page = .white
            custom.raised = .gray
            let fixed = custom
            let theme = PolarisTheme(palette: { _ in fixed })
            XCTAssertEqual(theme.resolvedPalette(for: .dark), custom)
            XCTAssertEqual(theme.resolvedPalette(for: .light, branding: .polarisKey), custom)
            XCTAssertTrue(theme.setsTint())
        }

        func testBundledRubikRegisters() {
            XCTAssertTrue(BrandFonts.isAvailable, "the bundled Rubik faces must register")
            XCTAssertEqual(PolarisTypography.brand.resolvedFamily, .brand)
            XCTAssertEqual(PolarisTypography.system.resolvedFamily, .system)
            XCTAssertEqual(
                PolarisTypography.custom(regular: "A", bold: "B").resolvedFamily,
                .custom(regular: "A", bold: "B"))
        }

        /// Rubik ships two weights, so headings take the Bold face and nothing asks for a
        /// synthesised medium or semibold (BRAND.md §1.6).
        func testHeadingsUseTheBoldFace() {
            XCTAssertTrue(PolarisTypography.spec(.title).1)
            XCTAssertTrue(PolarisTypography.spec(.bannerTitle).1)
            XCTAssertFalse(PolarisTypography.spec(.body).1)
            XCTAssertFalse(PolarisTypography.spec(.subtitle).1)
            XCTAssertFalse(PolarisTypography.spec(.caption).1)
        }

        func testBadgeNeverRendersBelowTheKitMinimum() {
            XCTAssertEqual(
                PolarisPoweredByBadge.Layout.compact.minimumSize, CGSize(width: 232, height: 88))
            XCTAssertEqual(
                PolarisPoweredByBadge.Layout.horizontal.minimumSize,
                CGSize(width: 376, height: 144))
            XCTAssertEqual(
                PolarisPoweredByBadge.Layout.stacked.minimumSize, CGSize(width: 288, height: 336))
            for layout in PolarisPoweredByBadge.Layout.allCases {
                XCTAssertEqual(
                    PolarisPoweredByBadge.size(layout: layout, width: nil), layout.minimumSize)
                XCTAssertEqual(
                    PolarisPoweredByBadge.size(layout: layout, width: 10), layout.minimumSize)
            }
            // Larger keeps the artwork's aspect ratio.
            XCTAssertEqual(
                PolarisPoweredByBadge.size(layout: .compact, width: 464),
                CGSize(width: 464, height: 176))
        }

        func testMarkStaysInTheDisplayCut() {
            XCTAssertEqual(PolarisMark.displaySize(48), 48)
            XCTAssertEqual(PolarisMark.displaySize(16), 33)
            XCTAssertEqual(PolarisBrand.opticalCut(for: Double(PolarisMark.displaySize(16))), "display")
        }

        func testPoweredByIsOptInAndUsesTheExactPhrase() {
            XCTAssertNil(PolarisTheme().poweredBy)
            XCTAssertEqual(PolarisBrand.poweredByPhrase, "Powered by Polaris Key")
        }

        /// Every bundled kit file, against its source in packages/brand/kit. A difference means the
        /// kit moved: run tools/sync-brand-assets.sh (whose list this mirrors) and commit.
        func testBundledKitFilesMatchTheKit() throws {
            let kit = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("packages/brand/kit")
            guard FileManager.default.fileExists(atPath: kit.path) else {
                throw XCTSkip("packages/brand/kit is not beside this package (a standalone copy)")
            }
            for (bundled, source) in Self.kitCopies {
                let url = try XCTUnwrap(brandResourceURL(bundled), "missing resource \(bundled)")
                XCTAssertEqual(
                    try Data(contentsOf: url), try Data(contentsOf: kit.appendingPathComponent(source)),
                    "\(bundled) differs from kit/\(source): run tools/sync-brand-assets.sh")
            }
            let fonts = kit.deletingLastPathComponent().appendingPathComponent("fonts")
            for (bundled, source) in Self.fontCopies {
                let url = try XCTUnwrap(brandResourceURL(bundled), "missing resource \(bundled)")
                XCTAssertEqual(
                    try Data(contentsOf: url), try Data(contentsOf: fonts.appendingPathComponent(source)),
                    "\(bundled) differs from packages/brand/fonts/\(source): run tools/sync-brand-assets.sh")
            }
        }

        /// The variable Rubik and JetBrains Mono (UI-KITS.md §2.1), from packages/brand/fonts. The
        /// static Rubik above stays until the kit's typography moves to the variable face (UK-07).
        static let fontCopies: [(String, String)] = [
            ("fonts/Rubik-Variable.ttf", "ttf/Rubik-Variable.ttf"),
            ("fonts/JetBrainsMono-Variable.ttf", "ttf/JetBrainsMono-Variable.ttf"),
            ("fonts/OFL-JetBrainsMono.txt", "OFL-JetBrainsMono.txt"),
            ("fonts/FONT-NOTICE-VARIABLE.txt", "FONT-NOTICE.txt"),
        ]

        static let kitCopies: [(String, String)] = {
            var copies: [(String, String)] = [
                ("fonts/Rubik-Regular.ttf", "source/fonts/Rubik-Regular.ttf"),
                ("fonts/Rubik-Bold.ttf", "source/fonts/Rubik-Bold.ttf"),
                ("fonts/OFL.txt", "source/fonts/OFL.txt"),
                ("fonts/FONT-NOTICE.txt", "source/fonts/FONT-NOTICE.txt"),
            ]
            for theme in ["dark", "light"] {
                copies.append(("marks/key-\(theme)-192.png", "01-marks/key/png/\(theme)/key-192.png"))
                for treatment in ["transparent", "outline", "sticker"] {
                    for (layout, px) in [("compact", 696), ("horizontal", 1128), ("stacked", 864)] {
                        copies.append(
                            (
                                "powered-by/\(treatment)/\(layout)-\(theme).png",
                                "03-powered-by/\(treatment)/powered-by-\(layout)-\(theme)-\(px).png"
                            ))
                    }
                }
            }
            return copies
        }()
    }
#endif
