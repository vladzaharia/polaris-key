// The public preview states reach the states they name, and the catalog and identity helpers the
// SwiftUI layer leans on behave (UI-KITS §6.2: previews are public, so they must not lie).

import Foundation
import PolarisKeyUICore
import XCTest

final class PreviewStateTests: XCTestCase {
    func testEveryPreviewReachesItsState() {
        XCTAssertFalse(PolarisKeyPreviewState.all.isEmpty)
        for preview in PolarisKeyPreviewState.all {
            XCTAssertEqual(preview.screen.state, preview.state, preview.id)
            XCTAssertEqual(preview.screen.component, preview.component, preview.id)
        }
    }

    func testPreviewIdsAreUnique() {
        let ids = PolarisKeyPreviewState.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    func testThePreviewKeyIsAWholeKey() {
        let verdict = KeyVerdict(PolarisKeyPreviewState.key)
        XCTAssertEqual(verdict.kind, .parsed)
        XCTAssertEqual(verdict.slug, "tidewater")
        XCTAssertEqual(verdict.keyPrefix, "pkey_tidewater_")
    }

    func testKeyVerdicts() {
        XCTAssertEqual(KeyVerdict("").kind, .empty)
        XCTAssertEqual(KeyVerdict("", submitted: true).kind, .submittedEmpty)
        XCTAssertEqual(KeyVerdict("pk").kind, .typing)
        XCTAssertEqual(KeyVerdict("pk", submitted: true).kind, .malformed)
        XCTAssertEqual(KeyVerdict("tidewater-2024-pro").kind, .malformed)
        XCTAssertEqual(KeyVerdict("pkey_Tide").kind, .malformed)
        XCTAssertEqual(KeyVerdict("pkey_tidewater_abc").kind, .typing)
        XCTAssertEqual(KeyVerdict("pkey_tidewater_abc", submitted: true).kind, .cutShort)
        XCTAssertEqual(KeyVerdict("pkey_tidewater_abc", submitted: true).used, 3)
        XCTAssertEqual(
            KeyVerdict("pkey_tidewater_" + String(repeating: "A", count: 23)).kind, .malformed)
        XCTAssertEqual(KeyVerdict("  \(PolarisKeyPreviewState.key)\n").kind, .parsed)
        // The secret's alphabet is base64url: `_` and `-` are secret characters.
        XCTAssertEqual(KeyVerdict("pkey_tidewater_Q2xv_-WRzT3ZlclRoZUhpQ").kind, .parsed)
    }

    func testTheCatalogFormatsNestedLinesInTheSameLocale() {
        let line = CopyLine(
            "deviceLimit.lede", ["formFactor": .text("iphone")])
        XCTAssertEqual(
            KitCopy.bundled.format(line, locale: "en"),
            "To use it on this iPhone, replace one. You can add it back later.")
        let consequence = CopyLine(
            "signin.replace.lede",
            ["thisDevice": .line(CopyLine("part.thisDeviceTitle", ["formFactor": .text("ipad")]))])
        XCTAssertEqual(
            KitCopy.bundled.format(consequence, locale: "de"),
            KitCopy.bundled.format(
                "signin.replace.lede", locale: "de",
                args: [
                    "thisDevice": .text(
                        KitCopy.bundled.format(
                            "part.thisDeviceTitle", locale: "de",
                            args: ["formFactor": .text("ipad")]))
                ]))
    }

    func testAMissingArgumentShowsRatherThanVanishes() {
        XCTAssertEqual(
            KitCopy.bundled.format("welcome.title", locale: "en"), "Welcome to {product}")
        XCTAssertEqual(KitCopy.bundled.format("no.such.key", locale: "en"), "no.such.key")
    }

    func testALineIsCompleteOnlyWithEveryArgumentItsMessageNames() {
        XCTAssertFalse(CopyLine("updateProgress.downloading", ["size": "24 MB"]).isComplete())
        XCTAssertTrue(
            CopyLine(
                "updateProgress.downloading", ["size": "24 MB", "total": "61 MB", "time": "4:12"]
            ).isComplete())
        XCTAssertTrue(CopyLine("common.tryAgain").isComplete())
        XCTAssertEqual(
            KitMessageFormat.argumentNames("{count, plural, one {# of {name}} other {#}} {x}"),
            ["count", "name", "x"])
    }

    func testProgressNeverInventsASize() {
        // Fraction only (the matrix vocabulary): no size, so the line is not drawn.
        let fractionOnly = PolarisKeyPreviewState.base {
            $0.update = KitUpdate(
                action: "binary", version: "2.5.0",
                progress: KitUpdateProgress(phase: "download", fraction: 0.4))
        }
        let line = KitStates.updateProgress(fractionOnly).line("updateProgress.downloading")
        XCTAssertNotNil(line)
        XCTAssertFalse(line!.isComplete())
        // Counted bytes and a time left: "24.4 MB of 61 MB · 4:12 left".
        let counted = PolarisKeyPreviewState.all.first {
            $0.component == .updateProgress && $0.state == "downloading"
        }!
        let full = KitStates.updateProgress(counted.inputs).line("updateProgress.downloading")!
        XCTAssertTrue(full.isComplete())
        XCTAssertEqual(full.args["time"], "4:12")
    }

    func testReleaseDatesAreNeverRawISO() {
        let day = KitFormat.day("2026-09-30")
        XCTAssertNotEqual(day, "2026-09-30")
        XCTAssertTrue(day.contains("2026"))
        XCTAssertEqual(KitFormat.day("soon"), "soon")
    }

    func testTheSignInErrorNeverStartsMidSentence() {
        var inputs = PolarisKeyPreviewState.base { $0.error = KitError(code: "sign-in-failed") }
        XCTAssertFalse(KitStates.signIn(inputs).line("signIn.methodError")!.isComplete())
        inputs.signIn = KitSignIn()
        inputs.signIn?.method = "Apple"
        let line = KitStates.signIn(inputs).line("signIn.methodError")!
        XCTAssertTrue(KitCopy.bundled.format(line, locale: "en").hasPrefix("Apple sign-in"))
    }

    func testLocalesResolveToTheirPack() {
        let copy = KitCopy.bundled
        XCTAssertEqual(copy.packLocale(for: "pt-BR"), "pt-BR")
        XCTAssertEqual(copy.packLocale(for: "pt_PT"), "pt-BR")
        XCTAssertEqual(copy.packLocale(for: "de-AT"), "de")
        XCTAssertEqual(copy.packLocale(for: "zh-Hans-CN"), "zh-Hans")
        XCTAssertEqual(copy.packLocale(for: "sv"), "en")
        XCTAssertEqual(copy.locales.first, "en")
        XCTAssertEqual(copy.locales.count, 9)
    }

    func testMacOSButtonsTakeTheirTitleCaseVariant() {
        let copy = KitCopy.bundled
        let en = copy.format("update.restartWhenReady", locale: "en")
        let mac = copy.format("update.restartWhenReady", locale: "en", variant: .macos)
        XCTAssertEqual(en, "Restart when ready")
        XCTAssertNotEqual(mac, en)
    }

    func testThisDeviceIsNeverHardCoded() {
        // "this Mac" on an iPhone was a SW finding: the platform word comes from the form factor.
        let iphone = PolarisKeyPreviewState.named(.deviceLimit, "default")!.on(
            PolarisKeyPreviewState.iPhone)
        let lede = KitStates.deviceLimit(iphone.inputs).line("deviceLimit.lede")!
        XCTAssertEqual(
            KitCopy.bundled.format(lede, locale: "en"),
            "To use it on this iPhone, replace one. You can add it back later.")
    }

    func testIdentityNeverFallsBackToPolarisViolet() {
        let none = PolarisKeyPreviewState.base { $0.presentation = nil }
        let id = KitIdentity.resolve(none)
        XCTAssertEqual(id.accentSource, .ink)
        XCTAssertEqual(id.icon, .monogram)
        XCTAssertEqual(id.monogram, "T")
        XCTAssertNil(id.accentLight)
        let drift = KitIdentity.resolve(
            PolarisKeyPreviewState.base { $0.presentation = PolarisKeyPreviewState.driftKart })
        XCTAssertEqual(drift.accentSource, .product)
        XCTAssertEqual(drift.accentLight, "#ff6a3d")
        XCTAssertEqual(drift.accentDark, "#ff6a3d")
    }

    func testLinksFailClosed() {
        XCTAssertNotNil(KitLinks.valid("https://key.plrs.im/device"))
        XCTAssertNil(KitLinks.valid("http://key.plrs.im/device"))
        XCTAssertNil(KitLinks.valid("javascript:alert(1)"))
        XCTAssertNil(KitLinks.valid(nil))
        XCTAssertNotNil(KitLinks.valid("http://127.0.0.1:5173/cb"))
        XCTAssertEqual(KitLinks.display("https://key.plrs.im/device/"), "key.plrs.im/device")
        let id = KitIdentity.resolve(
            PolarisKeyPreviewState.base {
                $0.integrator = KitIntegrator(deviceCodeUrl: "https://driftkart.gg/tv")
            })
        XCTAssertEqual(
            KitLinks.deviceCodePage(id, platform: PolarisKeyPreviewState.iPhone),
            "https://driftkart.gg/tv")
        let bad = KitIdentity.resolve(
            PolarisKeyPreviewState.base {
                $0.integrator = KitIntegrator(deviceCodeUrl: "ftp://driftkart.gg/tv")
            })
        XCTAssertEqual(
            KitLinks.deviceCodePage(bad, platform: PolarisKeyPreviewState.iPhone),
            "https://key.plrs.im/device")
    }

    func testPluralRulesMatchCLDROnIntegers() {
        XCTAssertEqual(PluralRules.category(1, locale: "en"), "one")
        XCTAssertEqual(PluralRules.category(0, locale: "en"), "other")
        XCTAssertEqual(PluralRules.category(0, locale: "fr"), "one")
        XCTAssertEqual(PluralRules.category(1_000_000, locale: "fr"), "many")
        XCTAssertEqual(PluralRules.category(0, locale: "pt-BR"), "one")
        XCTAssertEqual(PluralRules.category(2_000_000, locale: "es"), "many")
        XCTAssertEqual(PluralRules.category(1, locale: "ja"), "other")
        XCTAssertEqual(PluralRules.category(1, locale: "zh-Hans"), "other")
    }
}
