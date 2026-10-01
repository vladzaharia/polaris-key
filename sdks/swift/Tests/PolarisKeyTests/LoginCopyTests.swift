// @pkey-feature ui.kit
// Copy-mapping tests for the drop-in login/gate UI. SwiftUI view rendering can't be unit-tested
// headlessly, so the gate-state → copy mapping is factored into the pure
// `PolarisCopy.message(for:allowedRange:)` (see PolarisTheme.swift). These tests pin that
// mapping: every terminal status resolves to the branded title/subtitle/symbol, the "usable"
// states render no message card, and the version-block allowed-range suffix formats the way
// VoiceOver will read it.

#if canImport(SwiftUI)
import PolarisKeyCore
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

    func testDefaultThemeUsesBrandIndigoAccent() {
        // The default theme adopts the Polaris Key brand indigo rather than the system accent.
        XCTAssertEqual(PolarisTheme().accent, PolarisTheme.brandAccent)
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
