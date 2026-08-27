// Brandable theming for the drop-in login/gate. A product passes its logo, accent color, and
// copy; everything else (layout, status routing) is provided by `PolarisLoginView`. The headless
// API stays on `LicenseClient` — this is purely presentation.

import PolarisKeyCore
import PolarisKeyLicense
import SwiftUI

/// User-facing copy for the gate. Defaults read for the generic "this app" case; a product
/// overrides `productName` (and any string it wants to brand) at construction.
///
/// Every string the gate renders lives here (including the divider/retry/reconnect chrome), so a
/// product can fully localize/brand the surface and so VoiceOver reads product copy.
public struct PolarisCopy: Sendable {
    public var productName: String
    public var welcomeTitle: String
    public var welcomeSubtitle: String
    public var signInButton: String
    public var orDividerLabel: String
    public var licenseKeyPlaceholder: String
    public var activateButton: String
    public var retryButton: String
    public var reconnectButton: String
    public var graceTitle: String
    public var graceSubtitle: String
    public var expiredTitle: String
    public var expiredSubtitle: String
    public var revokedTitle: String
    public var revokedSubtitle: String
    public var versionTooOldTitle: String
    public var versionTooNewTitle: String
    public var channelNotEntitledTitle: String
    public var versionBlockSubtitle: String

    public init(
        productName: String = "this app",
        welcomeTitle: String? = nil,
        welcomeSubtitle: String = "Sign in or enter a license key to continue.",
        signInButton: String = "Sign in",
        orDividerLabel: String = "or",
        licenseKeyPlaceholder: String = "License key",
        activateButton: String = "Activate",
        retryButton: String = "Retry",
        reconnectButton: String = "Reconnect",
        graceTitle: String = "Offline grace period",
        graceSubtitle: String =
            "We couldn't reach the license server. You can keep working for now.",
        expiredTitle: String = "License expired",
        expiredSubtitle: String = "Reconnect to renew your license.",
        revokedTitle: String = "License revoked",
        revokedSubtitle: String = "This license is no longer valid on this device.",
        versionTooOldTitle: String = "Update required",
        versionTooNewTitle: String = "Version not yet allowed",
        channelNotEntitledTitle: String = "Channel not entitled",
        versionBlockSubtitle: String = "Your current version isn't permitted to run."
    ) {
        self.productName = productName
        self.welcomeTitle = welcomeTitle ?? "Welcome to \(productName)"
        self.welcomeSubtitle = welcomeSubtitle
        self.signInButton = signInButton
        self.orDividerLabel = orDividerLabel
        self.licenseKeyPlaceholder = licenseKeyPlaceholder
        self.activateButton = activateButton
        self.retryButton = retryButton
        self.reconnectButton = reconnectButton
        self.graceTitle = graceTitle
        self.graceSubtitle = graceSubtitle
        self.expiredTitle = expiredTitle
        self.expiredSubtitle = expiredSubtitle
        self.revokedTitle = revokedTitle
        self.revokedSubtitle = revokedSubtitle
        self.versionTooOldTitle = versionTooOldTitle
        self.versionTooNewTitle = versionTooNewTitle
        self.channelNotEntitledTitle = channelNotEntitledTitle
        self.versionBlockSubtitle = versionBlockSubtitle
    }
}

/// The brandable theme: an accent color, an optional logo view, and the copy block.
public struct PolarisTheme: Sendable {
    public var accent: Color
    public var copy: PolarisCopy
    /// A product-supplied logo view builder (image, SF Symbol, anything). Defaults to the Polaris Key
    /// north-star glyph in the brand accent so the component renders standalone and on-brand.
    public var logo: @Sendable () -> AnyView

    public init(
        accent: Color = PolarisTheme.brandAccent,
        copy: PolarisCopy = PolarisCopy(),
        logo: (@Sendable () -> AnyView)? = nil
    ) {
        self.accent = accent
        self.copy = copy
        self.logo =
            logo
            ?? {
                AnyView(
                    Image(systemName: "sparkles")
                        .font(.system(size: 44))
                        .foregroundStyle(accent)
                        .accessibilityHidden(true))
            }
    }

    /// The Polaris Key brand indigo (`#5B7CFA`, HSL 232°/92%/68%) — the same accent the admin/React
    /// surface uses. Tuned to read on a deep-slate dark background while clearing WCAG AA for
    /// large text / UI chrome. Exposed so consumers can reference the canonical hue without
    /// re-deriving it.
    public static let brandAccent = Color(
        red: 0x5B / 255.0, green: 0x7C / 255.0, blue: 0xFA / 255.0)
}

/// The resolved copy for a single terminal gate "message" surface (revoked / expired /
/// version-block). Title + subtitle are what VoiceOver reads as the combined status card;
/// `symbol` is the (a11y-hidden) SF Symbol glyph.
///
/// Pulled out as a pure value so the gate-state → copy mapping is unit-testable without
/// rendering SwiftUI, and so the view and tests share one source of truth.
public struct PolarisMessageCopy: Sendable, Equatable {
    public let title: String
    public let subtitle: String
    public let symbol: String

    public init(title: String, subtitle: String, symbol: String) {
        self.title = title
        self.subtitle = subtitle
        self.symbol = symbol
    }
}

extension PolarisCopy {
    /// Map a terminal gate status (plus any server-supplied allowed range, for version blocks) to
    /// its rendered title/subtitle/symbol.
    ///
    /// Returns `nil` for statuses that render no message card: `.ok` and `.notApplicable` route
    /// straight to the product's own UI, `.grace` gets a banner over it, and `.needsActivation`
    /// gets the activation form. `.notApplicable` is the v3 addition (D-08) — a product with the
    /// license service disabled has nothing to say about a licence, and saying nothing is the
    /// correct rendering.
    public func message(for status: LicenseStatus, allowedRange: AllowedRange? = nil)
        -> PolarisMessageCopy?
    {
        switch status {
        case .ok, .grace, .needsActivation, .notApplicable:
            return nil
        case .revoked:
            return PolarisMessageCopy(
                title: revokedTitle, subtitle: revokedSubtitle, symbol: "xmark.seal.fill")
        case .expired:
            return PolarisMessageCopy(
                title: expiredTitle, subtitle: expiredSubtitle,
                symbol: "clock.badge.exclamationmark")
        case .versionTooOld, .versionTooNew, .channelNotEntitled:
            let title: String
            switch status {
            case .versionTooNew: title = versionTooNewTitle
            case .channelNotEntitled: title = channelNotEntitledTitle
            default: title = versionTooOldTitle
            }
            return PolarisMessageCopy(
                title: title,
                subtitle: PolarisCopy.versionBlockSubtitle(
                    base: versionBlockSubtitle, allowedRange: allowedRange),
                symbol: "exclamationmark.triangle.fill")
        }
    }

    /// Append a human "(allowed: min …, max …)" suffix to the version-block body when the server
    /// told us the permitted window. Shared by the view and tests.
    public static func versionBlockSubtitle(base: String, allowedRange: AllowedRange?) -> String {
        guard let range = allowedRange else { return base }
        let parts = [range.min.map { "min \($0)" }, range.max.map { "max \($0)" }]
            .compactMap { $0 }
        guard !parts.isEmpty else { return base }
        return base + " (allowed: \(parts.joined(separator: ", ")))"
    }
}
