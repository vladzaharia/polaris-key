// Brandable theming for the drop-in login/gate. A product passes its logo, accent color,
// and copy; everything else (layout, status routing) is provided by `PolarisKeyLoginView`.
// Headless API stays on `PolarisKeyClient` — this is purely presentation.

import SwiftUI

/// User-facing copy for the gate. Defaults read for the generic "this app" case; a product
/// overrides `productName` (and any string it wants to brand) at construction.
public struct PolarisKeyCopy: Sendable {
    public var productName: String
    public var welcomeTitle: String
    public var welcomeSubtitle: String
    public var signInButton: String
    public var licenseKeyPlaceholder: String
    public var activateButton: String
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
        licenseKeyPlaceholder: String = "License key",
        activateButton: String = "Activate",
        graceTitle: String = "Offline grace period",
        graceSubtitle: String = "We couldn't reach the license server. You can keep working for now.",
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
        self.licenseKeyPlaceholder = licenseKeyPlaceholder
        self.activateButton = activateButton
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
public struct PolarisKeyTheme: Sendable {
    public var accent: Color
    public var copy: PolarisKeyCopy
    /// A product-supplied logo view builder (image, SF Symbol, anything). Defaults to a
    /// neutral key glyph so the component renders standalone.
    public var logo: @Sendable () -> AnyView

    public init(
        accent: Color = .accentColor,
        copy: PolarisKeyCopy = PolarisKeyCopy(),
        logo: (@Sendable () -> AnyView)? = nil
    ) {
        self.accent = accent
        self.copy = copy
        self.logo =
            logo
            ?? {
                AnyView(
                    Image(systemName: "key.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary))
            }
    }
}
