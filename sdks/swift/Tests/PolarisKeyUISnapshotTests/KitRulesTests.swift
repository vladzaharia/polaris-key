// @pkey-feature ui.theme ui.gate
// The SwiftUI kit's rules that need no simulator: the theme's resolution (UI-KITS §1.2, §3.3,
// §3.4), the DL1 arrangement and the DL3 hero give-way, the variable fonts' named instances, and
// that every preview state the kit draws has a committed simulator baseline in both schemes
// (recorded by examples/ui/swiftui/run.sh; ui-qa and the docs read the same files).

import Foundation
import PolarisKeyUICore
import SwiftUI
import XCTest

@testable import PolarisKeyUI

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
        var inputs = PolarisKeyPreviewState.base {
            $0.presentation = PolarisKeyPreviewState.driftKart
        }
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

    // MARK: Mac measures (UK-08.1)

    func testTheMacMeasuresAreTheMacColumn() {
        #if os(macOS)
            let style = KitResolvedStyle.fallback
            XCTAssertEqual(style.controlHeight, 28)
            XCTAssertEqual(style.heroControlHeight, 36)
            XCTAssertEqual(style.fieldRadius, 10)
            XCTAssertEqual(style.sheetRadius, 18)
            XCTAssertEqual(style.cardPad, 24)
            XCTAssertEqual(KitTextRole.body.spec.size, 13)
            XCTAssertEqual(KitTextRole.title.spec.size, 22)
            XCTAssertEqual(KitTextRole.display.spec.size, 26)
        #else
            XCTAssertEqual(KitResolvedStyle.fallback.controlHeight, 52)
            XCTAssertEqual(KitTextRole.body.spec.size, 17)
        #endif
    }

    func testAnInactiveFilledButtonsLabelKeepsContrastOnTheNeutralFill() {
        // The inactive look is the raised fill under the strong text colour (S2): 4.5:1 or more
        // in both schemes, for any accent (the fill and label do not depend on it).
        for dark in [true, false] {
            let id = KitIdentity.resolve(PolarisKeyPreviewState.base())
            let p = KitPaletteResolver.palette(
                identity: id, preset: .polarisKey, dark: dark, derivedAccent: nil,
                increaseContrast: false)
            let fill = dark ? PolarisBrand.Dark.textStrong : PolarisBrand.Light.textStrong
            let raised = dark ? "#16181d" : "#ffffff"
            let ratio = PolarisAccent.contrast(String(format: "#%06x", fill.hex), raised)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "dark: \(dark)")
            XCTAssertEqual(p.textStrong, fill.color)
        }
    }

    func testTheMacButtonRowPutsCancelDirectlyLeftOfTheDefault() {
        let slots: [KitActionSlot] = [
            KitActionSlot(kind: .primary),
            KitActionSlot(kind: .quiet, leading: true),  // Paste
            KitActionSlot(kind: .quiet),  // key instead
            KitActionSlot(kind: .quiet),  // Cancel
        ]
        XCTAssertEqual(KitActionOrder.order(slots), [1, 2, 3, 0])
        XCTAssertEqual(KitActionOrder.order([KitActionSlot(kind: .quiet), KitActionSlot(kind: .secondary), KitActionSlot(kind: .primary)]), [0, 1, 2])
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

    func testAFocusedStepsHeaderInsetIsOneValuePerWindow() {
        XCTAssertEqual(KitArrangement.topInset(height: 956), 76.48, accuracy: 0.01)
        XCTAssertEqual(KitArrangement.topInset(height: 100), 16)
        XCTAssertEqual(KitArrangement.topInset(height: 2000), 88)
    }

    @MainActor
    func testAKeyAtRestKeepsItsPrefixAndLastSix() {
        XCTAssertEqual(
            KeyField.shortened("pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpQQ"), "pkey_tidewater_…ZUhpQQ")
        XCTAssertEqual(KeyField.shortened("pkey_x_abc"), "pkey_x_abc")
        XCTAssertEqual(KeyField.shortened("no-underscore-here-at-all"), "no-underscore-here-at-all")
    }

    // MARK: Type

    func testTheVariableFontsGiveTheThreeWeights() {
        for weight in [KitWeight.regular, .medium, .semibold] {
            XCTAssertNotNil(KitFonts.rubikName(weight), "Rubik \(weight)")
        }
        XCTAssertNotNil(KitFonts.monoName(.regular))
        XCTAssertNotNil(KitFonts.monoName(.medium))
    }

    // MARK: Boot skeleton (DL7)

    func testBootSkeletonIsStaticUnderReduceMotion() {
        let still = BootSkeletonModel(reduceMotion: true)
        XCTAssertEqual(still.shimmerStart(elapsed: 0), BootSkeletonModel.restingStart)
        XCTAssertEqual(still.shimmerStart(elapsed: 0.9), BootSkeletonModel.restingStart)
    }

    func testBootShimmerSweepsOnceEachPeriodAndLoops() {
        let moving = BootSkeletonModel(reduceMotion: false)
        let p = PolarisKit.Motion.shimmer
        XCTAssertEqual(moving.shimmerStart(elapsed: 0), -BootSkeletonModel.shimmerWidth, accuracy: 1e-9)
        XCTAssertEqual(moving.shimmerStart(elapsed: p), -BootSkeletonModel.shimmerWidth, accuracy: 1e-9)
        XCTAssertGreaterThan(moving.shimmerStart(elapsed: p * 0.99), 0.9)
    }

    func testBootSkeletonIsTwoBars() {
        XCTAssertEqual(BootSkeletonModel.bars, [1, 0.7])
    }

    // MARK: Spec conformance (UI-KITS §4.3, DL4, DL5)

    @MainActor
    func testAStatusScreenNamesTheProductOnceUnderItsIcon() {
        // DL5: "License expired" does not name the product, so the name sits under the icon;
        // "Update to keep using {product}" does, so it does not repeat.
        XCTAssertFalse(StatusScreenView.titleNamesProduct(CopyLine("core.codes.license-expired.title")))
        XCTAssertFalse(StatusScreenView.titleNamesProduct(nil))
        XCTAssertTrue(StatusScreenView.titleNamesProduct(CopyLine("update.mandatoryTitle")))
    }

    @MainActor
    func testTheDeviceCodeIsFortyPointsAtHalfWeightWithWideTracking() {
        XCTAssertEqual(CodeDisplay.size, 40)
        XCTAssertEqual(CodeDisplay.tracking, 0.12)
    }

    func testTheHandoffCodeViewKeepsItsCheckLine() throws {
        // "Check the code there matches this one" is in the catalog and drawn with the code.
        XCTAssertFalse(KitCopy.bundled.argumentNames("signin.handoff.check").contains("x"))
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/PolarisKeyUI/Kit/Screens/SignInScreens.swift"),
            encoding: .utf8)
        XCTAssertTrue(source.contains("CopyLine(\"signin.handoff.check\")"))
    }

    @MainActor
    func testActivateDoneHasItsOnePrimaryWhenTheHostGivesOne() {
        XCTAssertEqual(ActivateActions.doneActionKey(onDone: true), "signin.done.start")
        XCTAssertNil(ActivateActions.doneActionKey(onDone: false))
    }

    @MainActor
    func testALicenseRowDrawsItsSeatMeterMutedWhenFull() {
        let free = KitLicenseChoice(
            id: "a", tierName: "Pro", origin: "key", seats: KitSeats(used: 1, limit: 3))
        let full = KitLicenseChoice(
            id: "b", tierName: "Edu", origin: "developer", seats: KitSeats(used: 3, limit: 3),
            state: "full")
        let hidden = KitLicenseChoice(id: "c", tierName: "Pro", origin: "key")
        XCTAssertEqual(LicenseChoiceView.meter(for: free)?.used, 1)
        XCTAssertEqual(LicenseChoiceView.meter(for: free)?.muted, false)
        XCTAssertEqual(LicenseChoiceView.meter(for: full)?.muted, true)
        XCTAssertNil(LicenseChoiceView.meter(for: hidden))
    }

    @MainActor
    func testSettingsRowsGetTypedControlsAndGroups() {
        let rows = PolarisKeyPreviewState.config
        let byKey = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0) })
        XCTAssertEqual(SettingsSection.control(byKey["ui.compact"]!), .toggle)
        XCTAssertEqual(SettingsSection.control(byKey["audio.volume"]!), .slider)
        XCTAssertEqual(SettingsSection.control(byKey["render.quality"]!), .text)
        let open = KitConfigRow(key: "x.n", type: "number", source: "local", value: .number(3))
        XCTAssertEqual(SettingsSection.control(open), .stepper)
        let locked = KitConfigRow(
            key: "net.lockdown", type: "boolean", source: "enforced", locked: true, org: "Fennick",
            value: .bool(true))
        XCTAssertEqual(SettingsSection.control(locked), .locked)
        XCTAssertEqual(SettingsSection.group(locked), .managed)
        XCTAssertEqual(SettingsSection.group(byKey["ui.compact"]!), .developer)
        XCTAssertEqual(SettingsSection.group(byKey["audio.volume"]!), .yours)
    }

    @MainActor
    func testTheUpdatePromptShowsAtMostThreeNotes() {
        XCTAssertEqual(UpdatePromptView.noteLines(["a", "", "b", "c", "d"]), ["a", "b", "c"])
        XCTAssertEqual(UpdatePromptView.noteLines(nil), [])
    }

    func testTimeLeftIsWordsNotAClock() {
        let twenty = KitFormat.timeLeft(20)
        XCTAssertTrue(twenty.contains("20") && twenty.lowercased().contains("sec"), twenty)
        let four = KitFormat.timeLeft(252)
        XCTAssertTrue(four.contains("4") && !four.contains(":"), four)
    }

    @MainActor
    func testOnlyAnErrorToastStays() {
        XCTAssertTrue(ToastView.persists(.danger))
        for tone in [StatusPill.Tone.neutral, .success, .warning] {
            XCTAssertFalse(ToastView.persists(tone))
        }
        XCTAssertEqual(ToastView.lifetime, 6)
    }

    @MainActor
    func testAFailedStartSaysWhatFailedAndOffersTryAgain() {
        // DL7: the boot error's own title is drawn, with the product named by it (DL5), never an
        // icon and a button alone.
        let lines = [CopyLine("gate.error.title", ["product": "Tidewater Studio"]),
            CopyLine("common.tryAgain")]
        let view = StatusScreenView(errorLines: lines, onTryAgain: {})
        XCTAssertEqual(view.lines.map(\.key), ["gate.error.title", "common.tryAgain"])
        XCTAssertTrue(StatusScreenView.titleNamesProduct(lines.first))
    }

    func testARefusalCalloutTakesAccessibilityFocus() throws {
        // DL7: focus moves to the refusal when it appears. The focus state is SwiftUI-internal, so
        // the rule is pinned at its source.
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/PolarisKeyUI/Kit/Screens/ActivateScreens.swift"),
            encoding: .utf8)
        XCTAssertTrue(source.contains(".accessibilityFocused($focused)"))
        XCTAssertTrue(source.contains(".onAppear { focused = true }"))
    }

    func testADeviceRowsMetaWrapsInsteadOfClipping() throws {
        // DL11: a long dated meta ("Windows · last used Sep 18, 2025") wraps between words; the
        // accessibility audit flagged it as clipped before it could. Pinned at its source.
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/PolarisKeyUI/Kit/KitParts.swift"),
            encoding: .utf8)
        let row = try XCTUnwrap(source.range(of: "Text(meta)"))
        XCTAssertTrue(
            source[row.lowerBound...].prefix(400).contains(
                ".fixedSize(horizontal: false, vertical: true)"))
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
            guard ![KitComponent.boot, .toast].contains(preview.component)
            else { continue }
            // States that draw no kit view of their own: the gate past booting shows another
            // component's screen (Welcome, the status screen) or the app, up to date draws
            // nothing, and an entitled gate draws the host's content.
            if preview.component == .gate && preview.state != "booting" { continue }
            if preview.id.hasSuffix("UpdatePrompt.up-to-date")
                || preview.id.hasSuffix("EntitlementGate.entitled")
            {
                continue
            }
            let base =
                ([Self.kebab(preview.component.rawValue), preview.state]
                + [preview.variant].compactMap { $0 })
                .joined(separator: "-")
            for scheme in ["dark", "light"] where !files.contains("\(base)-\(scheme).png") {
                missing.append("\(base)-\(scheme).png")
            }
        }
        XCTAssertEqual(missing, [])
    }

    // MARK: macOS menu and Settings pane (UK-08.4)

    #if os(macOS)
        func testTheMenuWordsAreTitleCaseWithAnEllipsis() {
            let strings = KitStrings()
            XCTAssertEqual(strings.string("update.checkNow"), "Check for Updates…")
            XCTAssertEqual(strings.string("menu.manageLicense"), "Manage License…")
            XCTAssertEqual(strings.string("menu.signOut"), "Sign Out…")
            XCTAssertEqual(strings.string("menu.account"), "Account")
            // The confirm is the destructive button's word, with no ellipsis: it acts.
            XCTAssertEqual(strings.string("signin.signout.confirm"), "Sign Out")
        }

        func testTheSignOutConfirmationUsesSigninNineCopy() {
            let strings = KitStrings()
            XCTAssertEqual(
                SignOutCopy.title(strings, product: "Tidewater Studio"),
                "Sign out of Tidewater Studio on this device?")
            XCTAssertEqual(
                SignOutCopy.message(strings, product: "Tidewater Studio", tier: "Pro"),
                "Tidewater Studio stops using your Pro license on this device and frees room for another device."
            )
        }

        @MainActor func testAStillModelAnswersCheckNowWithUpToDate() async {
            let model = PolarisKeySettingsModel(preview: PolarisKeyPreviewState.base())
            await model.checkNow()
            XCTAssertEqual(model.checkResult, CopyLine("update.upToDate"))
            XCTAssertFalse(model.checkFailed)
        }

        @MainActor func testTheUpdateHookIsEmptyUntilAnUpdateWindowSetsIt() {
            XCTAssertNil(PolarisKeyUpdateHook.present)
            PolarisKeyUpdateHook.present = {}
            XCTAssertNotNil(PolarisKeyUpdateHook.present)
            PolarisKeyUpdateHook.present = nil
        }
    #endif
}
