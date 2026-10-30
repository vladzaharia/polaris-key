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
            // SWUI-A11Y-2: the system's secondary label, except where AppKit's falls under the 4.5:1
            // floor (BRAND.md §9 rule 1), where it is 68 % of the primary label.
            XCTAssertEqual(native.textMuted, .nativeMutedText)
            XCTAssertTrue(native.prefersMaterials)
            XCTAssertFalse(PolarisPalette.brandDark.prefersMaterials)
            XCTAssertEqual(PolarisPalette.standard(.native, for: .light), native)
            XCTAssertEqual(PolarisPalette.standard(.polarisKey, for: .light), .brandLight)
        }

        func testAccentOverrideAppliesInBothSchemesAndLeavesTheRest() throws {
            let theme = PolarisTheme(accent: .teal, accentOn: .black)
            XCTAssertTrue(theme.setsTint(), "an explicit accent is applied even natively")
            for branding in PolarisBranding.allCases {
                for scheme in [ColorScheme.dark, .light] {
                    let resolved = theme.resolvedPalette(for: scheme, branding: branding)
                    let base = PolarisPalette.standard(branding, for: scheme)
                    // The colour goes through the resolver for this scheme.
                    let input = try XCTUnwrap(Color.teal.polarisHex(for: scheme))
                    let want = try XCTUnwrap(PolarisAccent.resolve(input, dark: scheme != .light))
                    XCTAssertEqual(resolved.accent, BrandColor(hexString: want.solid)?.color)
                    XCTAssertEqual(resolved.accentText, BrandColor(hexString: want.fg)?.color)
                    XCTAssertEqual(resolved.focus, BrandColor(hexString: want.focus)?.color)
                    // `accentOn` is the integrator's, as given.
                    XCTAssertEqual(resolved.onAccent, .black)
                    XCTAssertEqual(resolved.page, base.page)
                }
            }
        }

        /// White on `#FF6A3D` is 2.85:1. Through the resolver the fill and its label, and the
        /// accent text on the page, clear 4.5:1 in both schemes and both presets.
        func testAnOrangeAccentClearsContrastInBothSchemes() throws {
            let orange = Color(red: 1, green: 106.0 / 255, blue: 61.0 / 255)
            XCTAssertEqual(orange.polarisHex(for: .light), "#ff6a3d")
            let theme = PolarisTheme(accent: orange)
            for branding in PolarisBranding.allCases {
                for scheme in [ColorScheme.dark, .light] {
                    let p = theme.resolvedPalette(for: scheme, branding: branding)
                    let fill = try XCTUnwrap(p.accent.polarisHex(for: scheme))
                    let label = try XCTUnwrap(p.onAccent.polarisHex(for: scheme))
                    let text = try XCTUnwrap(p.accentText.polarisHex(for: scheme))
                    XCTAssertGreaterThanOrEqual(
                        PolarisAccent.contrast(label, fill), 4.5, "label on fill \(branding) \(scheme)")
                    for ground in PolarisAccent.surfaces(dark: scheme == .dark) {
                        XCTAssertGreaterThanOrEqual(
                            PolarisAccent.contrast(text, ground), 4.5,
                            "text on \(ground) \(branding) \(scheme)")
                    }
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
            let minimum = CGSize(width: 320, height: 104)
            XCTAssertEqual(PolarisPoweredByBadge.size(width: nil), minimum)
            XCTAssertEqual(PolarisPoweredByBadge.size(width: 10), minimum)
            XCTAssertEqual(PolarisPoweredByBadge.size(width: 319), minimum)
            // Larger keeps the artwork's aspect ratio.
            XCTAssertEqual(PolarisPoweredByBadge.size(width: 640), CGSize(width: 640, height: 208))
            XCTAssertEqual(PolarisBrand.poweredByMarkSize, 16)
        }

        /// Every shipped drawing parses completely: each path is non-empty and the micro mark and
        /// the badge land inside their viewBox.
        func testTheLockerVectorsParse() {
            let vectors: [(BrandVector, Double)] = [
                (PolarisBrandMarkData.lockerMicroDark, 128), (PolarisBrandMarkData.lockerMicroLight, 128),
                (PolarisBrandMarkData.lockerPoweredByDark, 320), (PolarisBrandMarkData.lockerPoweredByLight, 320),
            ]
            for (vector, width) in vectors {
                XCTAssertEqual(vector.width, width)
                let paths = vector.paths()
                XCTAssertGreaterThanOrEqual(paths.count, 2)
                let bounds = paths.reduce(CGRect.null) { $0.union($1.path.boundingBoxOfPath) }
                XCTAssertFalse(bounds.isNull)
                XCTAssertGreaterThanOrEqual(bounds.minX, -0.5)
                XCTAssertGreaterThanOrEqual(bounds.minY, -0.5)
                XCTAssertLessThanOrEqual(bounds.maxX, vector.width + 0.5)
                XCTAssertLessThanOrEqual(bounds.maxY, vector.height + 0.5)
            }
            // The micro mark: the locker body and the star, in the kit's coral on dark.
            let micro = PolarisBrandMarkData.lockerMicroDark.paths()
            XCTAssertEqual(micro.map { $0.fill.hex }, [0xff7869, 0xffffff])
            XCTAssertEqual(micro[0].path.boundingBoxOfPath.minX, 8, accuracy: 0.01)
            XCTAssertEqual(micro[0].path.boundingBoxOfPath.maxX, 120, accuracy: 0.01)
            // The badge's type is outlined: many glyph paths, all inside the 320 × 104 canvas.
            XCTAssertGreaterThan(PolarisBrandMarkData.lockerPoweredByDark.paths().count, 10)
        }

        func testMarkStaysInTheDisplayCut() {
            XCTAssertEqual(PolarisMark.displaySize(48), 48)
            XCTAssertEqual(PolarisMark.displaySize(16), 33)
            XCTAssertEqual(PolarisBrand.opticalCut(for: Double(PolarisMark.displaySize(16))), "display")
        }

        func testPoweredByIsOptInAndUsesTheExactPhrase() {
            XCTAssertEqual(PolarisBrand.poweredByPhrase, "Powered by Polaris Locker")
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

        /// The Rubik subset (packages/brand/scripts/subset-fonts.sh) keeps a glyph for every character of
        /// the five Latin locale packs. CJK is not covered on purpose: `KitFonts` hands it to the system
        /// font (`usesCJK`). The mono subset must cover Basic Latin, the code face's whole use.
        func testFontSubsetsCoverTheLatinLocalePacks() throws {
            let corpus = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Sources/PolarisKeyUICore/Resources/kit-copy.json")
            let root = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: corpus)) as? [String: Any])
            let tables = try XCTUnwrap(root["tables"] as? [String: Any])
            var chars = Set<Unicode.Scalar>()
            func walk(_ value: Any) {
                if let text = value as? String {
                    chars.formUnion(text.unicodeScalars)
                } else if let dict = value as? [String: Any] {
                    dict.values.forEach(walk)
                } else if let list = value as? [Any] {
                    list.forEach(walk)
                }
            }
            for locale in ["en", "de", "fr", "es", "pt-BR"] {
                walk(try XCTUnwrap(tables[locale], "no \(locale) table"))
            }
            if let variants = root["variants"] { walk(variants) }
            chars = chars.filter { $0.value >= 0x20 && $0.value != 0x7F }
            XCTAssertGreaterThan(chars.count, 60, "the packs read as nearly empty")

            // A character the full Rubik lacks too (an arrow, say) falls back to the system font
            // before and after the subset, so only a glyph the subset dropped is a failure.
            let full = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("packages/brand/fonts/ttf/Rubik-Variable.ttf")
            func missing(_ url: URL, _ wanted: Set<Unicode.Scalar>) throws -> [String] {
                let descriptor = try XCTUnwrap(
                    (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])?.first)
                let font = CTFontCreateWithFontDescriptor(descriptor, 12, nil)
                return wanted.sorted { $0.value < $1.value }.filter { scalar in
                    var units = Array(String(scalar).utf16)
                    var glyphs = [CGGlyph](repeating: 0, count: units.count)
                    return !CTFontGetGlyphsForCharacters(font, &units, &glyphs, units.count)
                }.map { String(format: "U+%04X", $0.value) }
            }
            func missing(_ file: String, _ wanted: Set<Unicode.Scalar>, against reference: URL? = nil)
                throws -> [String]
            {
                var wanted = wanted
                if let reference {
                    let lacking = try missing(reference, wanted)
                    wanted = wanted.filter { !lacking.contains(String(format: "U+%04X", $0.value)) }
                }
                return try missing(try XCTUnwrap(BrandFonts.url(file), "missing font \(file)"), wanted)
            }
            let hasFull = FileManager.default.fileExists(atPath: full.path)
            XCTAssertEqual(
                try missing("Rubik-Variable", chars, against: hasFull ? full : nil), [],
                "Rubik subset lacks these locale-pack characters")
            let ascii = Set((0x20...0x7E).compactMap(Unicode.Scalar.init))
            XCTAssertEqual(try missing("JetBrainsMono-Variable", ascii), [])
        }

        /// One variable Rubik and JetBrains Mono (UI-KITS.md §2.1), from packages/brand/fonts.
        static let fontCopies: [(String, String)] = [
            ("fonts/Rubik-Variable.ttf", "ttf/Rubik-Variable-kit.ttf"),
            ("fonts/JetBrainsMono-Variable.ttf", "ttf/JetBrainsMono-Variable-kit.ttf"),
            ("fonts/OFL-JetBrainsMono.txt", "OFL-JetBrainsMono.txt"),
            ("fonts/FONT-NOTICE-VARIABLE.txt", "FONT-NOTICE.txt"),
        ]

        static let kitCopies: [(String, String)] = {
            var copies: [(String, String)] = [
                ("fonts/OFL.txt", "source/fonts/OFL.txt"),
            ]
            for theme in ["dark", "light"] {
                copies.append(("marks/key-\(theme)-192.png", "01-marks/key/png/\(theme)/key-192.png"))
            }
            return copies
        }()
    }
#endif
