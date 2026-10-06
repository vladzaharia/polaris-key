// @pkey-feature ui.kit
// Copy-mapping tests for the drop-in login/gate UI. SwiftUI view rendering can't be unit-tested
// headlessly, so the gate-state → copy mapping is factored into the pure
// `PolarisCopy.message(for:allowedRange:)` (see PolarisTheme.swift). These tests pin that
// mapping: every terminal status resolves to the branded title/subtitle/symbol, the "usable"
// states render no message card, and the version-block allowed-range suffix formats the way
// VoiceOver will read it.

#if canImport(SwiftUI)
import PolarisKeyCore
import PolarisKeyLicense
import PolarisKeyUI
import XCTest

final class LoginCopyTests: XCTestCase {
    func testUsableAndActivateStatesHaveNoMessageCard() {
        let copy = PolarisCopy()
        XCTAssertNil(copy.message(for: .ok))
        XCTAssertNil(copy.message(for: .grace))
        XCTAssertNil(copy.message(for: .needsActivation))
    }

    /// D-08 — a product with the license service disabled has nothing to say about a licence, so
    /// the gate renders the product's own UI rather than any card at all.
    func testNotApplicableRendersNoMessageCard() {
        XCTAssertNil(PolarisCopy().message(for: .notApplicable))
    }

    func testRevokedMapping() {
        let copy = PolarisCopy()
        let m = copy.message(for: .revoked)
        XCTAssertEqual(m?.title, copy.revokedTitle)
        XCTAssertEqual(m?.subtitle, copy.revokedSubtitle)
        XCTAssertEqual(m?.symbol, "xmark.seal.fill")
    }

    func testExpiredMapping() {
        let copy = PolarisCopy()
        let m = copy.message(for: .expired)
        XCTAssertEqual(m?.title, copy.expiredTitle)
        XCTAssertEqual(m?.subtitle, copy.expiredSubtitle)
        XCTAssertEqual(m?.symbol, "clock.badge.exclamationmark")
    }

    func testVersionBlockTitlesMapPerStatus() {
        let copy = PolarisCopy()
        XCTAssertEqual(copy.message(for: .versionTooOld)?.title, copy.versionTooOldTitle)
        XCTAssertEqual(copy.message(for: .versionTooNew)?.title, copy.versionTooNewTitle)
        XCTAssertEqual(
            copy.message(for: .channelNotEntitled)?.title, copy.channelNotEntitledTitle)
        // All version blocks share one warning glyph.
        XCTAssertEqual(
            copy.message(for: .versionTooOld)?.symbol, "exclamationmark.triangle.fill")
    }

    func testVersionBlockSubtitleAppendsAllowedRange() {
        let copy = PolarisCopy()
        let m = copy.message(
            for: .versionTooOld, allowedRange: AllowedRange(min: "1.2.0", max: "3.0.0"))
        XCTAssertEqual(
            m?.subtitle, copy.versionBlockSubtitle + " (allowed: min 1.2.0, max 3.0.0)")
    }

    func testVersionBlockSubtitleWithOnlyMin() {
        let copy = PolarisCopy()
        let m = copy.message(for: .versionTooNew, allowedRange: AllowedRange(min: "2.0.0"))
        XCTAssertEqual(m?.subtitle, copy.versionBlockSubtitle + " (allowed: min 2.0.0)")
    }

    func testVersionBlockSubtitleUnchangedWhenRangeEmpty() {
        let copy = PolarisCopy()
        // Nil range, and a present-but-empty range, both leave the base copy untouched.
        XCTAssertEqual(copy.message(for: .versionTooOld)?.subtitle, copy.versionBlockSubtitle)
        let empty = copy.message(for: .versionTooOld, allowedRange: AllowedRange())
        XCTAssertEqual(empty?.subtitle, copy.versionBlockSubtitle)
    }

    /// §3.1/§3.2: the gate renders an activation outcome from the shared copy by code, a product
    /// override wins, and an unknown refusal never reads as a device limit or as the raw body.
    func testActivationMessagesComeFromTheSharedCopy() {
        let copy = PolarisCopy()
        XCTAssertNil(copy.activationMessage(.ok(token: "t", schemaVersion: 1)))
        XCTAssertEqual(
            copy.activationMessage(.deviceLimit(limit: 3, deviceCount: 3)),
            ErrorCopy.message(ErrorCode.deviceLimit))
        XCTAssertEqual(
            copy.activationMessage(.enrollClaimed), ErrorCopy.message(ErrorCode.enrollClaimed))
        let owned = copy.activationMessage(
            .refused(code: "license_owned", status: 403, message: "{\"error\":\"license_owned\"}"))
        XCTAssertEqual(owned, ErrorCopy.message(ErrorCode.licenseOwned))
        XCTAssertNotEqual(owned, ErrorCopy.message(ErrorCode.deviceLimit))
        var custom = PolarisCopy()
        custom.activationMessages[ErrorCode.deviceLimit] = "All seats are taken."
        XCTAssertEqual(
            custom.activationMessage(.deviceLimit(limit: nil, deviceCount: nil)),
            "All seats are taken.")
    }

    func testProductNameThreadsIntoWelcomeTitle() {
        let copy = PolarisCopy(productName: "DJDL")
        XCTAssertEqual(copy.welcomeTitle, "Welcome to DJDL")
        // An explicit override wins over the product-name default.
        let custom = PolarisCopy(productName: "DJDL", welcomeTitle: "Hello there")
        XCTAssertEqual(custom.welcomeTitle, "Hello there")
    }

    func testChromeCopyHasSensibleDefaults() {
        // The previously-hardcoded divider/retry/reconnect strings are branded copy.
        let copy = PolarisCopy()
        XCTAssertEqual(copy.orDividerLabel, "or")
        XCTAssertEqual(copy.retryButton, "Retry")
        XCTAssertEqual(copy.reconnectButton, "Reconnect")
        XCTAssertFalse(copy.graceSubtitle.isEmpty)
    }

    func testDefaultThemeIsNativeAndNeutral() {
        // Owner direction (2026-10-04): no Polaris Key branding unless the integrator opts in.
        let theme = PolarisTheme()
        XCTAssertNil(theme.accentOverride)
        XCTAssertNil(theme.branding)
        XCTAssertEqual(theme.resolvedBranding(), .native)
        XCTAssertEqual(theme.resolvedPalette(for: .dark), PolarisPalette.native)
        XCTAssertEqual(theme.resolvedPalette(for: .light), PolarisPalette.native)
        XCTAssertEqual(theme.resolvedTypography(), .system)
    }

    /// Every status that can reach the view is classified: usable states render `content()`, the
    /// rest resolve to a card. A new status added without a decision here shows up as a nil card
    /// on a screen that renders nothing at all.
    func testEveryStatusIsEitherUsableOrCarriesACard() {
        let copy = PolarisCopy()
        let cardless: Set<LicenseStatus> = [.ok, .grace, .needsActivation, .notApplicable]
        for status in [
            LicenseStatus.ok, .grace, .expired, .revoked, .needsActivation, .versionTooOld,
            .versionTooNew, .channelNotEntitled, .notApplicable,
        ] {
            if cardless.contains(status) {
                XCTAssertNil(copy.message(for: status), "\(status) renders no card")
            } else {
                XCTAssertNotNil(copy.message(for: status), "\(status) must resolve to a card")
            }
        }
    }
}
#endif
