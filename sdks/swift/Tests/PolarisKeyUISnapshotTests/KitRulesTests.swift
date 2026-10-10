// @pkey-feature ui.theme ui.gate
// The SwiftUI kit's rules that need no simulator: the theme's resolution (UI-KITS §1.2, §3.3,
// §3.4), the DL1 arrangement and the DL3 hero give-way, the variable fonts' named instances, and
// that every preview state the kit draws has a committed simulator baseline in both schemes
// (recorded by examples/ui/swiftui/run.sh; ui-qa and the docs read the same files).

import Foundation
@testable import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI
import XCTest

final class KitRulesTests: XCTestCase {
    // MARK: Theme

    func testTheProductAccentNeverFallsBackToViolet() {
        let none = KitIdentity.resolve(PolarisKeyPreviewState.base { $0.presentation = nil })
        let palette = KitPaletteResolver.palette(
            identity: none, preset: .polarisKey, dark: true, derivedAccent: nil,
            increaseContrast: false)
        // Ink: the strong text colour as the fill, the page as its label.
        XCTAssertEqual(palette.accentSolid, PolarisBrand.Dark.textStrong.color)
        XCTAssertFalse(palette.accentIsHostTint)
    }

    func testTheNativePresetTakesTheHostsTint() {
        let id = KitIdentity.resolve(PolarisKeyPreviewState.base(), preset: .native)
        XCTAssertEqual(id.accentSource, .host)
        let palette = KitPaletteResolver.palette(
            identity: id, preset: .native, dark: false, derivedAccent: nil,
            increaseContrast: false)
        XCTAssertTrue(palette.accentIsHostTint)
        XCTAssertEqual(palette.accentSolid, Color.accentColor)
    }

    func testALightProductAccentTakesAnInkLabelInBothSchemes() {
        let id = KitIdentity.resolve(
            PolarisKeyPreviewState.base { $0.presentation = PolarisKeyPreviewState.driftKart })
        for dark in [true, false] {
            let resolved = PolarisAccent.resolve(id.accentLight!, dark: dark)
            XCTAssertEqual(resolved?.on, PolarisAccent.ink, "dark: \(dark)")
            let palette = KitPaletteResolver.palette(
                identity: id, preset: .polarisKey, dark: dark, derivedAccent: nil,
                increaseContrast: false)
            XCTAssertEqual(palette.accentOn, BrandColor(hexString: PolarisAccent.ink)!.color)
        }
    }

    func testTheIntegratorsThemeWinsOverThePresentation() {
        var theme = PolarisKeyTheme(accent: .color("#2f6fde"))
        theme.product = PolarisKeyTheme.Product(name: "Tidewater", developer: "Harbor")
        var inputs = PolarisKeyPreviewState.base { $0.presentation = PolarisKeyPreviewState.driftKart }
        inputs.integrator = theme.integrator
        let id = KitIdentity.resolve(inputs)
        XCTAssertEqual(id.name, "Tidewater")
        XCTAssertEqual(id.developer, "Harbor")
        XCTAssertEqual(id.accentSource, .integrator)
        XCTAssertEqual(id.accentLight, "#2f6fde")
        XCTAssertEqual(PolarisKeyTheme(accent: .core).integrator?.accent, "core")
        XCTAssertNil(PolarisKeyTheme().integrator)
    }

    func testColorsOverrideOneRoleAtATime() {
        let id = KitIdentity.resolve(PolarisKeyPreviewState.base())
        var palette = KitPaletteResolver.palette(
            identity: id, preset: .polarisKey, dark: true, derivedAccent: nil,
            increaseContrast: false)
        let before = palette
        KitPaletteResolver.apply([.surfacePage: "#101820", .danger: "not a colour"], to: &palette)
        XCTAssertEqual(palette.page, BrandColor(hexString: "#101820")!.color)
        XCTAssertEqual(palette.danger, before.danger, "an invalid colour leaves the role alone")
        XCTAssertEqual(palette.textStrong, before.textStrong)
    }

    func testTheRadiusScalesFieldsAndGroups() {
        var style = KitResolvedStyle.fallback
        style.radius = .sm
        XCTAssertLessThan(style.fieldRadius, KitResolvedStyle.fallback.fieldRadius)
        style.radius = .points(20)
        XCTAssertEqual(style.fieldRadius, 20)
        XCTAssertEqual(style.groupRadius, 24)
    }

    // MARK: Layout

    func testTheArrangementComesFromTheShape() {
        // DL1 for the SwiftUI kit: the split only at w >= 1.15h and at least 760 x 520.
        XCTAssertEqual(KitArrangement.of(CGSize(width: 440, height: 956)), .tall)
        XCTAssertEqual(KitArrangement.of(CGSize(width: 956, height: 440)), .tall)
        XCTAssertEqual(KitArrangement.of(CGSize(width: 667, height: 375)), .tall)
        XCTAssertEqual(KitArrangement.of(CGSize(width: 820, height: 1180)), .tall)
        XCTAssertEqual(KitArrangement.of(CGSize(width: 1180, height: 820)), .split)
        XCTAssertEqual(KitArrangement.of(CGSize(width: 1366, height: 1024)), .split)
        XCTAssertEqual(KitArrangement.of(CGSize(width: 900, height: 800)), .tall)
    }

    func testTheHeroGivesWayFirst() {
        XCTAssertEqual(KitArrangement.heroSize(height: 956), 120)
        XCTAssertEqual(KitArrangement.heroSize(height: 600), 72)
        XCTAssertNil(KitArrangement.heroSize(height: 440))
    }

    // MARK: Type

    func testTheVariableFontsGiveTheThreeWeights() {
        for weight in [KitWeight.regular, .medium, .semibold] {
            XCTAssertNotNil(KitFonts.rubikName(weight), "Rubik \(weight)")
        }
        XCTAssertNotNil(KitFonts.monoName(.regular))
        XCTAssertNotNil(KitFonts.monoName(.medium))
    }

    // MARK: Baselines

    static var snapshots: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("__Snapshots__")
    }

    /// `SignInHandoff` → `sign-in-handoff`, as ui-qa and the docs name a component.
    static func kebab(_ s: String) -> String {
        s.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1-$2", options: .regularExpression)
            .lowercased()
    }

    func testEveryPreviewStateHasABaselineInBothSchemes() throws {
        let files = Set(
            (try? FileManager.default.contentsOfDirectory(atPath: Self.snapshots.path)) ?? [])
        try XCTSkipIf(files.isEmpty, "no baselines recorded yet (examples/ui/swiftui/run.sh)")
        var missing: [String] = []
        for preview in PolarisKeyPreviewState.all {
            // Previews the drop-in does not draw on iOS yet have no baseline.
            guard ![KitComponent.boot, .offlineActivation, .toast].contains(preview.component)
            else { continue }
            let base = ([Self.kebab(preview.component.rawValue), preview.state] + [preview.variant].compactMap { $0 })
                .joined(separator: "-")
            for scheme in ["dark", "light"] where !files.contains("\(base)-\(scheme).png") {
                missing.append("\(base)-\(scheme).png")
            }
        }
        XCTAssertEqual(missing, [])
    }
}
