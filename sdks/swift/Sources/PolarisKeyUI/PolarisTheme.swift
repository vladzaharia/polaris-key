// Theming for the drop-in login/gate. A product passes its logo, accent colour, palette, type and
// copy; everything else (layout, status routing) is provided by `PolarisLoginView`. The defaults
// are native and neutral; the Polaris Key brand (docs/design/BRAND.md, read from the generated
// `PolarisBrand` tokens) is an opt-in. The headless API stays on `LicenseClient` — this is purely
// presentation.

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
    /// The gate titles and subtitles above default to the generated gate table (core.copy,
    /// `ErrorCopy.title/message(status)`); a product's value wins.
    /// Activation outcomes (§3.1), defaulting to the shared `ErrorCopy` base. A product overrides
    /// one by code: `copy.activationMessages[ErrorCode.deviceLimit] = "…"`.
    public var activationMessages: [String: String]
    /// Shown when a sign-out could not clear the stored licence.
    public var signOutFailedMessage: String
    /// Copy for every other kit component (sign-in, settings, devices, …).
    public var kit = PolarisKitCopy()
    /// PX-W8: the action that opens the refusal's `manageUrl` (SIGN-IN.md D-49).
    public var freeDeviceButton: String
    /// Shown under the QR code on a TV, where the link is scanned on a phone.
    public var freeDeviceScanCaption: String

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
        graceTitle: String = ErrorCopy.title(LicenseStatus.grace.rawValue),
        graceSubtitle: String = ErrorCopy.message(LicenseStatus.grace.rawValue),
        expiredTitle: String = ErrorCopy.title(LicenseStatus.expired.rawValue),
        expiredSubtitle: String = ErrorCopy.message(LicenseStatus.expired.rawValue),
        revokedTitle: String = ErrorCopy.title(LicenseStatus.revoked.rawValue),
        revokedSubtitle: String = ErrorCopy.message(LicenseStatus.revoked.rawValue),
        versionTooOldTitle: String = ErrorCopy.title(LicenseStatus.versionTooOld.rawValue),
        versionTooNewTitle: String = ErrorCopy.title(LicenseStatus.versionTooNew.rawValue),
        channelNotEntitledTitle: String = ErrorCopy.title(
            LicenseStatus.channelNotEntitled.rawValue),
        versionBlockSubtitle: String = "Your current version isn't permitted to run.",
        activationMessages: [String: String] = [:],
        signOutFailedMessage: String = "Sign-out couldn't clear the stored license.",
        freeDeviceButton: String = "Replace a device",
        freeDeviceScanCaption: String =
            "Scan with your phone to free a device, then try again."
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
        self.freeDeviceButton = freeDeviceButton
        self.freeDeviceScanCaption = freeDeviceScanCaption
        self.activationMessages = activationMessages
        self.signOutFailedMessage = signOutFailedMessage
    }

    /// The Welcome's title for the product the kit resolved: the integrator's title when they set
    /// one, else "Welcome to <name>" with the name from the presentation or the bundle when the
    /// copy still holds the generic "this app".
    func welcomeTitle(naming name: String) -> String {
        let generic = "Welcome to \(PolarisCopy().productName)"
        return welcomeTitle == generic && productName == PolarisCopy().productName
            ? "Welcome to \(name)" : welcomeTitle
    }

    /// The sentence for an activation outcome: the product's override for its code, else the
    /// shared copy (`ActivationResult.message`); nil for `.ok`. Never the raw server body.
    public func activationMessage(_ result: ActivationResult) -> String? {
        if result.isOK { return nil }
        if let custom = activationMessages[result.code] { return custom }
        return result.message
    }
}

/// The theme: branding, colours, type, logo, copy and the optional "Powered by" badge.
///
/// The defaults are native and neutral: system fonts, the host app's tint and system colours, the
/// product's icon (`PolarisProductIdentity`), no Polaris Key branding and no badge. Opting in to
/// the Polaris Key brand is one modifier, `.polarisKeyBranding(.polarisKey)`, or
/// `branding: .polarisKey` here: the generated brand palette (dark or light from the `colorScheme`
/// environment) in the product presentation's accent when it has one, and Rubik. Any field set
/// here wins over what the branding or the presentation would pick:
///
/// - `accent` (and `accentOn` for the text on it) re-points the primary button and the accent
///   text in both colour schemes, leaving the rest of the palette alone;
/// - `palette` replaces every colour, per colour scheme;
/// - `typography` picks the system font, Rubik or the product's own faces;
/// - `logo` replaces the product icon the kit would show;
/// - `poweredBy` opts in to the kit's "Powered by Polaris Key" badge under the activation card.
public struct PolarisTheme: Sendable {
    /// The branding for this gate; nil (the default) follows the `polarisKeyBranding`
    /// environment, which is `.native` unless the host opts in.
    public var branding: PolarisBranding?
    /// An accent override for both colour schemes; nil keeps the branding's accent (the app's
    /// tint natively; under `.polarisKey` the presentation's accent, else the core violet).
    public var accentOverride: Color?
    /// The text colour on an overridden accent; nil keeps the palette's `onAccent`.
    public var accentOn: Color?
    /// A palette per colour scheme; nil uses `PolarisPalette.standard(_:for:)` for the branding.
    public var palette: (@Sendable (ColorScheme) -> PolarisPalette)?
    /// The type family; nil uses the system font natively and Rubik under `.polarisKey`.
    public var typography: PolarisTypography?
    public var copy: PolarisCopy
    /// A product-supplied logo view builder (image, SF Symbol, anything), offered a square at each
    /// size the kit draws the product icon; nil shows the presentation's icon, else the app's
    /// icon, else a monogram tile, in both brandings (never a Polaris Key mark).
    public var logoOverride: (@Sendable () -> AnyView)?
    /// The badge shown under the activation card, or nil (the default) for none.
    public var poweredBy: PolarisPoweredBy?

    public init(
        branding: PolarisBranding? = nil,
        accent: Color? = nil,
        accentOn: Color? = nil,
        palette: (@Sendable (ColorScheme) -> PolarisPalette)? = nil,
        typography: PolarisTypography? = nil,
        copy: PolarisCopy = PolarisCopy(),
        logo: (@Sendable () -> AnyView)? = nil,
        poweredBy: PolarisPoweredBy? = nil
    ) {
        self.branding = branding
        self.accentOverride = accent
        self.accentOn = accentOn
        self.palette = palette
        self.typography = typography
        self.copy = copy
        self.logoOverride = logo
        self.poweredBy = poweredBy
    }

    /// The branding in effect under an environment value of `environment`.
    public func resolvedBranding(_ environment: PolarisBranding = .native) -> PolarisBranding {
        branding ?? environment
    }

    /// The colours the gate paints in `scheme` under `environment` branding: the palette with the
    /// accent overrides applied.
    ///
    /// The accent resolves in the UI-KITS §1.2 order: the integrator's (`accent`, or a whole
    /// `palette`), then, under `.polarisKey` branding, the product presentation's accent
    /// (`accentDark` in the dark scheme) through the contrast resolver (`PolarisAccent`), then the
    /// branding's own. Natively the host app's tint always leads, so a presentation accent does not
    /// apply there.
    public func resolvedPalette(
        for scheme: ColorScheme, branding environment: PolarisBranding = .native,
        presentation: PolarisProductPresentation? = nil
    ) -> PolarisPalette {
        var resolved =
            palette?(scheme)
            ?? PolarisPalette.standard(resolvedBranding(environment), for: scheme)
        if let accent = accentOverride {
            resolved.accent = accent
            resolved.accentText = accent
        } else if palette == nil, resolvedBranding(environment) == .polarisKey,
            let input = presentation?.accent(for: scheme),
            let accent = PolarisAccent.resolve(input, dark: scheme != .light),
            let solid = BrandColor(hexString: accent.solid),
            let fg = BrandColor(hexString: accent.fg),
            let on = BrandColor(hexString: accent.on),
            let focus = BrandColor(hexString: accent.focus)
        {
            resolved.accent = solid.color
            resolved.accentText = fg.color
            resolved.onAccent = on.color
            resolved.focus = focus.color
        }
        if let accentOn { resolved.onAccent = accentOn }
        return resolved
    }

    /// The type family under `environment` branding.
    public func resolvedTypography(branding environment: PolarisBranding = .native)
        -> PolarisTypography
    {
        typography ?? (resolvedBranding(environment) == .polarisKey ? .brand : .system)
    }

    /// Whether the gate sets its own tint. Natively, with no colour override, it does not, so the
    /// host app's `.tint` / accent colour flows through untouched.
    public func setsTint(branding environment: PolarisBranding = .native) -> Bool {
        resolvedBranding(environment) == .polarisKey || accentOverride != nil || palette != nil
    }

    /// The accent as a non-optional colour, kept for source compatibility: the override, or the
    /// app's accent colour.
    @available(*, deprecated, renamed: "accentOverride")
    public var accent: Color {
        get { accentOverride ?? .accentColor }
        set { accentOverride = newValue }
    }

    /// The logo builder as a non-optional closure, kept for source compatibility: the override,
    /// or the neutral key glyph.
    @available(*, deprecated, renamed: "logoOverride")
    public var logo: @Sendable () -> AnyView {
        get { logoOverride ?? { AnyView(Image(systemName: "key.fill").accessibilityHidden(true)) } }
        set { logoOverride = newValue }
    }

    /// The pre-brand-system accent's name, kept for source compatibility. It answers the brand's
    /// core violet for dark grounds; the indigo it used to hold is outside the palette.
    @available(
        *, deprecated,
        message: "Use .polarisKeyBranding(.polarisKey) or PolarisPalette.brand(for:).accent."
    )
    public static var brandAccent: Color { PolarisPalette.brandDark.accent }
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

extension BrandColor {
    /// A `#rrggbb` string as a colour (the accent resolver's output), or nil.
    init?(hexString: String) {
        guard hexString.count == 7, hexString.hasPrefix("#"),
            let value = UInt32(hexString.dropFirst(), radix: 16)
        else { return nil }
        self.init(hex: value)
    }
}
