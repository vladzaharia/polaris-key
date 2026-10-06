// A drop-in SwiftUI gate that renders by license status. It observes a `LicenseClient` (the
// headless API stays there) and shows the right surface for each state: an OIDC sign-in button +
// license-key entry card when activation is needed, an offline-grace banner, a version-block
// screen, or — when usable — the product's own UI via a slot closure.
//
// ── WHY IT WRAPS `LicenseClient` AND NOT `PolarisKeyClient` ────────────────────────────────────
//
// PolarisKeyUI depends on Core + License + Config, not on the umbrella. A gate renders LICENSE
// state, so the license sub-client is the honest dependency, and taking it directly keeps the UI
// usable by a product that composed its own client rather than the facade. The one thing the
// view needs that the license service does not own is a SYNC — a Core pass across every enabled
// document — so that arrives as a closure the host wires to `client.sync()`. A config-only
// product passes no gate at all; its status is `notApplicable` and `content()` renders straight
// through.
//
// Brandable through `PolarisTheme`; extensible through the `content` slot.

import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import SwiftUI

/// An observable wrapper that bridges the `LicenseClient` actor into SwiftUI. It snapshots the
/// gate state on the main actor so views update; call `refresh()`/`activate(key:)` to drive the
/// client and re-snapshot.
@MainActor
public final class PolarisGateModel: ObservableObject {
    @Published public private(set) var state: LicenseState
    @Published public private(set) var profile: DocProfile?
    @Published public private(set) var isWorking = false
    @Published public var lastError: String?
    /// The last activation's typed outcome, so a host (or the kit) can branch on its kind — show
    /// "Manage devices" on `.deviceLimit`, "Sign in" on `.enrollClaimed` — rather than on copy.
    @Published public private(set) var lastResult: ActivationResult?
    /// The copy activation outcomes are rendered with (`PolarisCopy.activationMessage`).
    public var copy: PolarisCopy = PolarisCopy()

    private let client: LicenseClient
    private let syncAction: @Sendable () async -> Void
    /// The facade, when built with `init(client:)`: the gate then offers the built-in device-code
    /// sign-in, and the model follows `client.events`.
    public private(set) var facade: PolarisKeyClient?
    /// Whether the product runs Identity (known only with `init(client:)`).
    @Published public private(set) var identityEnabled = false
    private var observation: Task<Void, Never>?

    /// - Parameter sync: a Core sync pass. Defaults to a no-op, which is correct for a
    ///   local-only build (§7.3) where "retry" cannot mean a network call.
    public init(
        license: LicenseClient,
        initialState: LicenseState = LicenseState(status: .needsActivation),
        sync: @escaping @Sendable () async -> Void = {}
    ) {
        self.client = license
        self.syncAction = sync
        self.state = initialState
    }

    /// The convenience init: the gate over `client`, syncing through `client.sync()` and
    /// re-snapshotting whenever `client.events` reports a change.
    public convenience init(client: PolarisKeyClient) {
        self.init(license: client.license, sync: { _ = await client.sync() })
        self.facade = client
        let stream = client.events
        observation = Task { [weak self] in
            await self?.reload()
            for await _ in stream { await self?.reload() }
        }
    }

    deinit { observation?.cancel() }

    /// Pull the latest gate state from the client (no network).
    public func reload() async {
        state = await client.status()
        profile = await client.profile()
        if let facade { identityEnabled = await facade.core.enabled(.identity) }
    }

    /// Run a Core sync, then re-snapshot the gate.
    public func refresh() async {
        isWorking = true
        defer { isWorking = false }
        await syncAction()
        await reload()
    }

    /// Activate with a license key, surfacing a human error on failure, then re-snapshot.
    public func activate(key: String) async {
        isWorking = true
        defer { isWorking = false }
        let result = await client.activate(key: key)
        lastResult = result
        lastError = copy.activationMessage(result)
        await reload()
    }

    public func deactivate() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await client.deactivate()
            lastError = nil
        } catch {
            // The local wipe failing means the credential is STILL on this machine — the user
            // has to know, rather than seeing a sign-out that silently did nothing.
            lastError = "\(copy.signOutFailedMessage) \(error.localizedDescription)"
        }
        await reload()
    }
}

/// The drop-in gate. `content` is rendered when the gate is usable (ok / grace / not-applicable);
/// `onSignIn` starts the product's OIDC flow (the SDK is transport-agnostic about the browser
/// dance).
public struct PolarisLoginView<Content: View>: View {
    @ObservedObject private var model: PolarisGateModel
    private let theme: PolarisTheme
    private let onSignIn: (() -> Void)?
    private let content: () -> Content

    @State private var licenseKey: String = ""

    /// - Parameter onSignIn: starts the product's own sign-in; nil hides the button. For the
    ///   built-in device-code sign-in, use `PolarisGate` (or `.polarisKey(client)`) instead.
    public init(
        model: PolarisGateModel,
        theme: PolarisTheme = PolarisTheme(),
        onSignIn: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.model = model
        self.theme = theme
        self.onSignIn = onSignIn
        self.content = content
    }

    @State private var signingIn = false

    /// The host's sign-in, else the built-in device code when the model has a client and the
    /// product runs Identity, else none (the button is hidden rather than a no-op).
    private var signIn: (() -> Void)? {
        if let onSignIn { return onSignIn }
        guard model.facade != nil, model.identityEnabled else { return nil }
        return { signingIn = true }
    }

    public var body: some View {
        PolarisGateSurface(
            status: model.state.status,
            allowedRange: model.state.allowedRange,
            isWorking: model.isWorking,
            lastError: model.lastError,
            licenseKey: $licenseKey,
            theme: theme,
            onSignIn: signIn,
            onActivate: { key in Task { await model.activate(key: key) } },
            onRefresh: { Task { await model.refresh() } },
            content: content
        )
        .task { await model.reload() }
        .sheet(isPresented: $signingIn) {
            if let client = model.facade {
                PolarisSignIn(client: client, theme: theme) { _ in
                    signingIn = false
                    Task { await model.reload() }
                }
                .frame(minWidth: 360, minHeight: 520)
            }
        }
    }
}

/// The gate's presentation for one snapshot of the model: which surface shows for a status, and how
/// it is drawn. Split from `PolarisLoginView` so previews can render every state without a live
/// `LicenseClient`; the routing is exactly the view's.
///
/// Layout: every full-screen state centres its card horizontally and vertically, at a comfortable
/// maximum width (`PolarisGateLayout.cardMaxWidth`) rather than edge to edge on iPad and macOS, and
/// scrolls instead of clipping when Dynamic Type makes it taller than the screen.
struct PolarisGateSurface<Content: View>: View {
    let status: LicenseStatus
    let allowedRange: AllowedRange?
    let isWorking: Bool
    let lastError: String?
    @Binding var licenseKey: String
    let theme: PolarisTheme
    /// nil hides "Sign in" (the product runs no Identity).
    let onSignIn: (() -> Void)?
    let onActivate: (String) -> Void
    let onRefresh: () -> Void
    /// "Continue free" (keyless enrolment), shown only when given.
    var onContinueFree: (() -> Void)? = nil
    /// "Activate offline", shown only when given.
    var onActivateOffline: (() -> Void)? = nil
    /// False hides key entry (a store outlet whose rules forbid it, App Store 3.1.1).
    var showsKeyEntry: Bool = true
    let content: () -> Content

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var environmentBranding
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var scaledCardPadding: CGFloat = 28

    private var branding: PolarisBranding { theme.resolvedBranding(environmentBranding) }
    private var palette: PolarisPalette {
        theme.resolvedPalette(for: colorScheme, branding: environmentBranding)
    }
    /// The tint the gate imposes, or nil to inherit the host app's.
    private var tint: Color? {
        theme.setsTint(branding: environmentBranding) ? palette.accent : nil
    }
    private var accentTextTint: Color? { tint == nil ? nil : palette.accentText }
    private var cardPadding: CGFloat { min(scaledCardPadding, PolarisGateLayout.cardPaddingMax) }
    private func font(_ role: PolarisTypography.Role) -> Font {
        theme.resolvedTypography(branding: environmentBranding).font(role)
    }

    var body: some View {
        Group {
            switch status {
            case .ok, .notApplicable:
                // §5 / D-08 — a product that does not run the license service has no gate to
                // show. Rendering the activation form there would demand a licence that does not
                // exist.
                content()
            case .grace:
                graceScreen
            case .needsActivation:
                activationScreen
            case .revoked, .expired, .versionTooOld, .versionTooNew, .channelNotEntitled:
                // One shared mapping for every terminal "message" surface — see
                // `PolarisCopy.message(for:allowedRange:)`.
                if let copy = theme.copy.message(for: status, allowedRange: allowedRange) {
                    messageScreen(
                        title: copy.title, subtitle: copy.subtitle, symbol: copy.symbol,
                        tone: status == .revoked ? palette.danger : palette.warning)
                }
            }
        }
    }

    // ── needs-activation: OIDC button + license-key card ──
    private var activationScreen: some View {
        centredCard(badge: theme.poweredBy) {
            VStack(spacing: 10) {
                logo
                    .padding(.bottom, 6)
                Text(theme.copy.welcomeTitle)
                    .font(font(.title)).foregroundStyle(palette.textStrong)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(theme.copy.welcomeSubtitle)
                    .font(font(.subtitle)).foregroundStyle(palette.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 14) {
                if let onSignIn {
                    Button(action: onSignIn) {
                        Text(theme.copy.signInButton)
                            .font(font(.body))
                            .foregroundStyle(palette.onAccent)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .buttonBorderShape(.roundedRectangle(radius: PolarisGateLayout.controlRadius))
                    .modifier(OptionalTint(color: tint))
                    .disabled(isWorking)
                    .accessibilityLabel(theme.copy.signInButton)
                    .accessibilityHint("Signs in to license \(theme.copy.productName).")
                }

                if showsKeyEntry {
                    if onSignIn != nil {
                        HStack(spacing: 12) {
                            divider
                            Text(theme.copy.orDividerLabel)
                                .font(font(.caption)).foregroundStyle(palette.textMuted)
                                .layoutPriority(1)
                            divider
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(theme.copy.orDividerLabel)
                    }

                    licenseKeyField

                    Button {
                        onActivate(licenseKey)
                    } label: {
                        Text(theme.copy.activateButton)
                            .font(font(.body))
                            .frame(maxWidth: .infinity)
                    }
                    .modifier(ProminentWhen(prominent: onSignIn == nil))
                    .controlSize(.large)
                    .buttonBorderShape(.roundedRectangle(radius: PolarisGateLayout.controlRadius))
                    .modifier(OptionalTint(color: onSignIn == nil ? tint : accentTextTint))
                    .disabled(isWorking || licenseKey.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel(theme.copy.activateButton)
                    .accessibilityHint("Activates the license key you entered above.")
                }

                if let onContinueFree {
                    Button(action: onContinueFree) {
                        Text(theme.copy.kit.continueFreeButton)
                            .font(font(.body))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.large)
                    .modifier(OptionalTint(color: accentTextTint))
                    .disabled(isWorking)
                    .accessibilityHint("Starts the free tier without a license key.")
                }

                if let onActivateOffline, showsKeyEntry {
                    Button(theme.copy.kit.activateOfflineLink, action: onActivateOffline)
                        .buttonStyle(.borderless)
                        .font(font(.caption))
                        .modifier(OptionalTint(color: accentTextTint))
                }
            }

            if let err = lastError {
                Label {
                    Text(err)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill")
                        .accessibilityHidden(true)
                }
                .font(font(.caption)).foregroundStyle(palette.danger)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isStaticText)
            }
            if isWorking {
                ProgressView()
                    .accessibilityLabel("Working")
            }
        }
    }

    private var licenseKeyField: some View {
        let shape = RoundedRectangle(
            cornerRadius: PolarisGateLayout.controlRadius, style: .continuous)
        return TextField(theme.copy.licenseKeyPlaceholder, text: $licenseKey)
            .textFieldStyle(.plain)
            .font(font(.body))
            .foregroundStyle(palette.textDefault)
            .multilineTextAlignment(.center)
            .autocorrectionDisabled()
            #if os(iOS)
                .textInputAutocapitalization(.never)
            #endif
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(shape.fill(palette.page))
            .overlay(shape.strokeBorder(palette.borderStrong, lineWidth: 1))
            .modifier(OptionalTint(color: tint == nil ? nil : palette.focus))
            .accessibilityLabel(theme.copy.licenseKeyPlaceholder)
            .accessibilityHint("Enter a license key to activate without signing in.")
    }

    /// The product's logo, else the branding's default: a neutral key glyph in the tint natively,
    /// the bit-less Pinned K under `.polarisKey`.
    @ViewBuilder private var logo: some View {
        if let custom = theme.logoOverride {
            custom()
                .accessibilityHidden(true)
        } else if branding == .polarisKey {
            PolarisMark(accessibilityLabel: nil)
        } else {
            Image(systemName: "key.fill")
                .font(.largeTitle).imageScale(.large)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
        }
    }

    // ── grace: keep working, with a reconnect affordance ──
    private var graceScreen: some View {
        VStack(spacing: 0) {
            banner(
                title: theme.copy.graceTitle, subtitle: theme.copy.graceSubtitle,
                symbol: "wifi.exclamationmark")
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // ── shared building blocks ──
    private func messageScreen(title: String, subtitle: String, symbol: String, tone: Color)
        -> some View
    {
        centredCard(badge: nil) {
            // Group the glyph + title + body so VoiceOver reads them as one status card
            // ("<title>. <subtitle>.") instead of three disjoint swipes; the glyph carries no
            // independent meaning, so it folds into the combined label.
            VStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.largeTitle).imageScale(.large)
                    .foregroundStyle(tone)
                    .padding(.bottom, 6)
                    .accessibilityHidden(true)
                Text(title)
                    .font(font(.title)).foregroundStyle(palette.textStrong)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle)
                    .font(font(.subtitle)).foregroundStyle(palette.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)

            Button {
                onRefresh()
            } label: {
                Text(theme.copy.retryButton)
                    .font(font(.body))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .buttonBorderShape(.roundedRectangle(radius: PolarisGateLayout.controlRadius))
            .modifier(OptionalTint(color: accentTextTint))
            .disabled(isWorking)
            .accessibilityLabel(theme.copy.retryButton)
            .accessibilityHint("Re-checks your license with the server.")
        }
    }

    /// A card centred on the page, horizontally and vertically, at the comfortable maximum width;
    /// it scrolls (still centred when it fits) once Dynamic Type makes it taller than the screen.
    private func centredCard<C: View>(
        badge: PolarisPoweredBy?, @ViewBuilder _ inner: () -> C
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: PolarisGateLayout.cardRadius, style: .continuous)
        let stack = VStack(spacing: 24) {
            VStack(spacing: 24) { inner() }
                .padding(cardPadding)
                .frame(maxWidth: PolarisGateLayout.cardMaxWidth)
                .background(shape.fill(palette.raised))
                .overlay(shape.strokeBorder(palette.borderSubtle, lineWidth: 1))
            if let badge {
                PolarisPoweredByBadge(layout: badge.layout, treatment: badge.treatment)
            }
        }
        .padding(.horizontal, PolarisGateLayout.pagePadding)
        .padding(.vertical, 32)
        return GeometryReader { proxy in
            ScrollView(.vertical) {
                stack
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(palette.page.ignoresSafeArea())
    }

    private func banner(title: String, subtitle: String, symbol: String) -> some View {
        let glyph = Image(systemName: symbol)
            .font(font(.body))
            .foregroundStyle(palette.warning)
            .accessibilityHidden(true)
        let text = VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(font(.bannerTitle)).foregroundStyle(palette.textStrong)
                .fixedSize(horizontal: false, vertical: true)
            Text(subtitle)
                .font(font(.caption)).foregroundStyle(palette.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        // Combine the title + body into a single announced label; flag it as static text so
        // VoiceOver reads the grace state when the banner appears.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        let button = Button(theme.copy.reconnectButton) { onRefresh() }
            .font(font(.body))
            .buttonStyle(.bordered)
            .buttonBorderShape(.roundedRectangle(radius: PolarisGateLayout.controlRadius))
            .modifier(OptionalTint(color: accentTextTint))
            .controlSize(.small)
            .disabled(isWorking)
            .accessibilityLabel(theme.copy.reconnectButton)
            .accessibilityHint("Re-checks your license to leave the offline grace period.")

        return Group {
            if dynamicTypeSize.isAccessibilitySize {
                // At accessibility sizes a single row squeezes the copy into a sliver: stack it.
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) { glyph; text }
                    button
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 12) {
                    glyph
                    text
                    Spacer(minLength: 12)
                    button
                }
            }
        }
        .frame(maxWidth: PolarisGateLayout.bannerMaxWidth)
        .padding(.horizontal, PolarisGateLayout.pagePadding)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(bannerGround.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { divider }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var bannerGround: some View {
        if palette.prefersMaterials {
            Rectangle().fill(.bar)
        } else {
            Rectangle().fill(palette.warningSubtle)
        }
    }

    private var divider: some View { Rectangle().fill(palette.borderSubtle).frame(height: 1) }
}

/// The gate's layout constants: one corner radius per element kind and the comfortable widths.
enum PolarisGateLayout {
    /// The card's maximum width: comfortable on iPad and macOS, full width (minus the page
    /// padding) on iPhone.
    static let cardMaxWidth: CGFloat = 420
    /// The grace banner's content width: centred, never edge to edge on a wide window.
    static let bannerMaxWidth: CGFloat = 680
    static let cardRadius: CGFloat = 20
    static let controlRadius: CGFloat = 10
    static let pagePadding: CGFloat = 20
    /// The card padding scales with Dynamic Type up to this, so large text keeps its width.
    static let cardPaddingMax: CGFloat = 36
}

/// `.borderedProminent` when the button is the card's primary action, `.bordered` otherwise.
private struct ProminentWhen: ViewModifier {
    let prominent: Bool

    func body(content: Content) -> some View {
        if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

/// `.tint(color)` when a colour is given; otherwise the view inherits the environment's tint, so
/// a native gate takes the host app's accent.
private struct OptionalTint: ViewModifier {
    let color: Color?

    func body(content: Content) -> some View {
        if let color {
            content.tint(color)
        } else {
            content
        }
    }
}

#if DEBUG
    /// Every gate surface, native (the default) and with the Polaris Key branding, in dark and
    /// light, at iPhone, iPad and Mac sizes and at a large accessibility Dynamic Type size. Xcode
    /// renders these from the package; they need no `LicenseClient`.
    struct PolarisGateSurface_Previews: PreviewProvider {
        static func surface(
            _ status: LicenseStatus, theme: PolarisTheme = PolarisTheme(),
            lastError: String? = nil, allowedRange: AllowedRange? = nil
        ) -> some View {
            PolarisGateSurface(
                status: status, allowedRange: allowedRange, isWorking: false,
                lastError: lastError, licenseKey: .constant(""), theme: theme,
                onSignIn: {}, onActivate: { _ in }, onRefresh: {},
                content: {
                    Text("Product UI").font(.title).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                })
        }

        static let aurora = PolarisTheme(copy: PolarisCopy(productName: "Aurora"))
        static let sizes: [(String, CGSize)] = [
            ("iPhone", CGSize(width: 393, height: 852)),
            ("iPad", CGSize(width: 820, height: 1180)),
            ("Mac", CGSize(width: 900, height: 640)),
        ]

        static var previews: some View {
            ForEach(PolarisBranding.allCases, id: \.self) { branding in
                ForEach([ColorScheme.dark, .light], id: \.self) { scheme in
                    let suffix = "\(branding.rawValue), \(scheme == .dark ? "dark" : "light")"
                    surface(.needsActivation, theme: aurora)
                        .polarisKeyBranding(branding)
                        .environment(\.colorScheme, scheme)
                        .previewLayout(.fixed(width: 393, height: 852))
                        .previewDisplayName("Activation (\(suffix))")
                    surface(.grace)
                        .polarisKeyBranding(branding)
                        .environment(\.colorScheme, scheme)
                        .previewLayout(.fixed(width: 393, height: 852))
                        .previewDisplayName("Grace (\(suffix))")
                    surface(.revoked)
                        .polarisKeyBranding(branding)
                        .environment(\.colorScheme, scheme)
                        .previewLayout(.fixed(width: 393, height: 852))
                        .previewDisplayName("Revoked (\(suffix))")
                    surface(.versionTooOld, allowedRange: AllowedRange(min: "2.0.0"))
                        .polarisKeyBranding(branding)
                        .environment(\.colorScheme, scheme)
                        .previewLayout(.fixed(width: 393, height: 852))
                        .previewDisplayName("Version block (\(suffix))")
                }
            }

            ForEach(sizes, id: \.0) { name, size in
                surface(.needsActivation, theme: aurora)
                    .previewLayout(.fixed(width: size.width, height: size.height))
                    .previewDisplayName("Activation on \(name)")
            }

            surface(.needsActivation, theme: aurora, lastError: "That license key wasn't accepted.")
                .environment(\.dynamicTypeSize, .accessibility3)
                .previewLayout(.fixed(width: 393, height: 852))
                .previewDisplayName("Activation, accessibility type")
            surface(.grace)
                .environment(\.dynamicTypeSize, .accessibility3)
                .previewLayout(.fixed(width: 393, height: 852))
                .previewDisplayName("Grace, accessibility type")

            surface(
                .needsActivation,
                theme: PolarisTheme(
                    branding: .polarisKey,
                    copy: PolarisCopy(productName: "Aurora"), poweredBy: PolarisPoweredBy())
            )
            .previewLayout(.fixed(width: 393, height: 852))
            .previewDisplayName("Branded with Powered-by badge")

            surface(
                .needsActivation,
                theme: PolarisTheme(
                    accent: .teal, copy: PolarisCopy(productName: "Aurora"),
                    logo: { AnyView(Image(systemName: "leaf.fill").font(.system(size: 44))) }),
                lastError: "That license key wasn't accepted."
            )
            .previewLayout(.fixed(width: 393, height: 852))
            .previewDisplayName("Integrator accent and logo")
        }
    }
#endif
