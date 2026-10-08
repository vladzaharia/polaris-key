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
    /// PX-W8: the portal link that frees a seat, after the last activation was refused with
    /// `device_limit`; nil otherwise. It already carries the app's return URL and, on an
    /// `/activate` link, the key as a fragment. Never an auth failure: the gate only offers it.
    @Published public private(set) var manageURL: String?
    /// The last activation's typed outcome, so a host (or the kit) can branch on its kind — show
    /// "Manage devices" on `.deviceLimit`, "Sign in" on `.enrollClaimed` — rather than on copy.
    @Published public private(set) var lastResult: ActivationResult?
    /// The copy activation outcomes are rendered with (`PolarisCopy.activationMessage`).
    public var copy: PolarisCopy = PolarisCopy()

    private let client: LicenseClient
    private let syncAction: @Sendable () async -> Void
    private let returnURL: String?
    /// The facade, when built with `init(client:)`: the gate then offers the built-in device-code
    /// sign-in, and the model follows `client.events`.
    public private(set) var facade: PolarisKeyClient?
    /// Whether the product runs Identity (known only with `init(client:)`).
    @Published public private(set) var identityEnabled = false
    private var observation: Task<Void, Never>?

    /// - Parameters:
    ///   - sync: a Core sync pass. Defaults to a no-op, which is correct for a local-only build
    ///     (§7.3) where "retry" cannot mean a network call.
    ///   - returnURL: where the portal sends the person back once a seat is free (a declared
    ///     return target of the product, PX-10); nil adds none.
    public init(
        license: LicenseClient,
        initialState: LicenseState = LicenseState(status: .needsActivation),
        sync: @escaping @Sendable () async -> Void = {},
        returnURL: String? = nil,
        copy: PolarisCopy = PolarisCopy()
    ) {
        self.client = license
        self.syncAction = sync
        self.state = initialState
        self.returnURL = returnURL
        self.copy = copy
    }

    /// The link the gate offers for a refused activation: the served `manageUrl` with the key
    /// fragment (only on an `/activate` link) and the app's return added. Pure, for tests.
    /// A `.qr` presentation never carries the key: a code on a shared TV screen can be scanned by
    /// anyone in the room, so the phone's `/activate` page asks for the key instead
    /// (docs/security/THREAT-MODEL.md).
    nonisolated public static func offeredManageURL(
        _ served: String?, key: String, returnURL: String?,
        presentation: PolarisManagePresentation = .button
    ) -> String? {
        guard let served, ManageLink.isValid(served) else { return nil }
        var url = presentation == .qr ? served : ManageLink.withKey(served, key)
        if let returnURL, !returnURL.isEmpty { url = ManageLink.withReturn(url, returnURL) }
        return url
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
        manageURL = nil
        if case .deviceLimit(_, _, let served) = result {
            manageURL = Self.offeredManageURL(
                served, key: key, returnURL: returnURL,
                presentation: PolarisManagePresentation.current)
        }
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
            manageURL: model.manageURL,
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
                .polarisSheetFrame()
            }
        }
    }
}

/// The gate's presentation for one snapshot of the model: which surface shows for a status, and how
/// it is drawn. Split from `PolarisLoginView` so previews can render every state without a live
/// `LicenseClient`; the routing is exactly the view's.
///
/// Layout: every full-screen state is a `PolarisAdaptivePage`: one column on a phone in portrait,
/// the form beside the welcome in landscape and short windows (so Activate is never below the
/// fold), and the split Welcome on iPad and roomy Mac windows; a page taller than the screen puts
/// its actions first and scrolls the rest.
struct PolarisGateSurface<Content: View>: View {
    let status: LicenseStatus
    let allowedRange: AllowedRange?
    let isWorking: Bool
    let lastError: String?
    var manageURL: String? = nil
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
    @Environment(\.polarisKeyPresentation) private var presentation
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @FocusState private var keyFieldFocused: Bool
    #if os(macOS)
        @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 64
    #else
        @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 88
    #endif

    private var style: PolarisKitStyle {
        PolarisKitStyle(
            theme: theme, scheme: colorScheme, branding: environmentBranding,
            presentation: presentation)
    }
    private var palette: PolarisPalette { style.palette }
    /// The tint the gate imposes, or nil to inherit the host app's.
    private var tint: Color? { style.tint }
    private var accentTextTint: Color? { tint == nil ? nil : palette.accentText }
    private func font(_ role: PolarisTypography.Role) -> Font { style.typography.font(role) }

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

    // ── needs-activation: the product, then Sign in and the license key ──
    //
    // The Welcome leads with the product (its icon at hero size, never a Polaris Key mark: UI-KITS
    // §1.2, §1.6) and lays out for the space it gets (`PolarisAdaptivePage`): one column on a
    // phone in portrait, the form beside the welcome in landscape, and the split Welcome on iPad
    // and roomy Mac windows.
    private var activationScreen: some View {
        let style = self.style
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        return PolarisAdaptivePage(style: style, identity: identity) { layout in
            VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.m) {
                if layout != .split {
                    PolarisPageDecoration {
                        PolarisProductIcon(
                            identity: identity, size: welcomeIconSize(layout), style: style)
                    }
                }
                Text(theme.copy.welcomeTitle(naming: identity.name))
                    .font(font(.title)).foregroundStyle(palette.textStrong)
                    .multilineTextAlignment(layout.textAlignment)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
        } detail: { layout in
            PolarisPageText(text: Text(theme.copy.welcomeSubtitle), style: style, layout: layout)
        } act: { layout in
            activationForm(layout)
        }
        .modifier(OptionalTint(color: tint))
    }

    /// The Welcome's icon: hero size in a column, smaller beside the form and at accessibility
    /// type sizes, where the form needs the room.
    private func welcomeIconSize(_ layout: PolarisKitLayout) -> CGFloat {
        if layout == .sideBySide || dynamicTypeSize.isAccessibilitySize { return 56 }
        return min(heroSize, 120)
    }

    private func activationForm(_ layout: PolarisKitLayout) -> some View {
        VStack(spacing: PolarisSpace.s) {
            if let onSignIn {
                Button(action: onSignIn) {
                    Text(theme.copy.signInButton)
                        .font(font(.body))
                        .foregroundStyle(palette.onAccent)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .modifier(OptionalTint(color: tint))
                .disabled(isWorking)
                .accessibilityLabel(theme.copy.signInButton)
                .accessibilityHint("Signs in to license \(theme.copy.productName).")
                .polarisLayoutProbe(.primaryAction)
            }

            if showsKeyEntry {
                if onSignIn != nil {
                    HStack(spacing: PolarisSpace.s) {
                        divider
                        Text(theme.copy.orDividerLabel)
                            .font(font(.caption)).foregroundStyle(palette.textMuted)
                            .layoutPriority(1)
                        divider
                    }
                    .padding(.vertical, PolarisSpace.xxs)
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
                .modifier(OptionalTint(color: onSignIn == nil ? tint : accentTextTint))
                .disabled(isWorking || licenseKey.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel(theme.copy.activateButton)
                .accessibilityHint("Activates the license key you entered above.")
                .modifier(ActivateProbe(isPrimary: onSignIn == nil))
            }

            if onContinueFree != nil || (onActivateOffline != nil && showsKeyEntry) {
                extras(layout)
                    .padding(.top, PolarisSpace.xs)
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
                .multilineTextAlignment(layout.textAlignment)
                .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
                .padding(.top, PolarisSpace.xxs)
                .accessibilityAddTraits(.isStaticText)
            }
            if let link = manageURL, let url = URL(string: link) {
                freeDeviceAction(url)
            }
            if isWorking {
                ProgressView()
                    .accessibilityLabel("Working")
            }
            if let badge = theme.poweredBy {
                PolarisPoweredByBadge(layout: badge.layout, treatment: badge.treatment)
                    .padding(.top, PolarisSpace.l)
            }
        }
    }

    /// The quiet extras (Continue free, Activate offline) as one row of links under the form
    /// (UI-KITS §4.3), stacking when the row does not fit.
    private func extras(_ layout: PolarisKitLayout) -> some View {
        let links = Group {
            if let onContinueFree {
                Button(theme.copy.kit.continueFreeButton, action: onContinueFree)
                    .disabled(isWorking)
                    .accessibilityHint("Starts the free tier without a license key.")
            }
            if let onActivateOffline, showsKeyEntry {
                Button(theme.copy.kit.activateOfflineLink, action: onActivateOffline)
            }
        }
        .buttonStyle(.borderless)
        .font(font(.subtitle))
        .modifier(OptionalTint(color: accentTextTint))
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: PolarisSpace.l) { links }
            VStack(spacing: PolarisSpace.s) { links }
        }
        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
    }

    /// PX-W8: "Replace a device" for a `device_limit` refusal. A button that opens the portal on
    /// macOS and iOS; a QR code on tvOS, where the link is opened on a phone. The person then
    /// returns and presses Activate again, so the button above is the "Try again".
    @ViewBuilder private func freeDeviceAction(_ url: URL) -> some View {
        switch PolarisManagePresentation.current {
        case .qr:
            VStack(spacing: PolarisSpace.xs) {
                PolarisQRCode(url.absoluteString, accessibilityLabel: theme.copy.freeDeviceButton)
                    .frame(width: 200, height: 200)
                Text(theme.copy.freeDeviceScanCaption)
                    .font(font(.caption)).foregroundStyle(palette.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .button:
            Button {
                openURL(url)
            } label: {
                Text(theme.copy.freeDeviceButton)
                    .font(font(.body))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .modifier(OptionalTint(color: accentTextTint))
            .accessibilityLabel(theme.copy.freeDeviceButton)
            .accessibilityHint("Opens your account in the browser to free a device.")
        }
    }

    /// The license-key field. A key stays on one line and, when it does not fit, gives way in the
    /// middle ("pkey_tidewater_7Q2M…3WPLDA"), keeping the prefix and the end people compare
    /// against the purchase email (UI-KITS §4.3); while editing, the field scrolls to the caret.
    private var licenseKeyField: some View {
        let shape = RoundedRectangle(
            cornerRadius: PolarisGateLayout.controlRadius, style: .continuous)
        let resting = !keyFieldFocused && !licenseKey.isEmpty
        return TextField(theme.copy.licenseKeyPlaceholder, text: $licenseKey)
            .textFieldStyle(.plain)
            .font(font(.body))
            .monospaced(!licenseKey.isEmpty)
            .foregroundStyle(palette.textDefault)
            .multilineTextAlignment(.center)
            .autocorrectionDisabled()
            #if os(iOS)
                .textInputAutocapitalization(.never)
                .submitLabel(.go)
            #endif
            .focused($keyFieldFocused)
            .onSubmit {
                if !licenseKey.trimmingCharacters(in: .whitespaces).isEmpty {
                    onActivate(licenseKey)
                }
            }
            .opacity(resting ? 0 : 1)
            .overlay {
                if resting {
                    Text(licenseKey)
                        .font(font(.body))
                        .monospaced()
                        .foregroundStyle(palette.textDefault)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, PolarisSpace.m)
            .padding(.vertical, PolarisSpace.s)
            .background(shape.fill(palette.page))
            .overlay(shape.strokeBorder(palette.borderStrong, lineWidth: 1))
            .modifier(OptionalTint(color: tint == nil ? nil : palette.focus))
            .accessibilityLabel(theme.copy.licenseKeyPlaceholder)
            .accessibilityHint("Enter a license key to activate without signing in.")
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

    /// A terminal state (revoked, expired, version block): its glyph and title, the explanation,
    /// and Retry, on the same page as the Welcome.
    private func messageScreen(title: String, subtitle: String, symbol: String, tone: Color)
        -> some View
    {
        let style = self.style
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        return PolarisAdaptivePage(style: style, identity: identity) { layout in
            PolarisPageHeading(
                title: title, identity: identity, style: style, layout: layout, symbol: symbol,
                symbolTint: tone)
        } detail: { layout in
            PolarisPageText(text: Text(subtitle), style: style, layout: layout)
        } act: { _ in
            Button {
                onRefresh()
            } label: {
                Text(theme.copy.retryButton)
                    .font(font(.body))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .modifier(OptionalTint(color: accentTextTint))
            .disabled(isWorking)
            .accessibilityLabel(theme.copy.retryButton)
            .accessibilityHint("Re-checks your license with the server.")
            .polarisLayoutProbe(.primaryAction)
        }
        .modifier(OptionalTint(color: tint))
    }

    private func banner(title: String, subtitle: String, symbol: String) -> some View {
        let glyph = Image(systemName: symbol)
            .font(font(.body))
            .foregroundStyle(palette.warning)
            .accessibilityHidden(true)
        let text = VStack(alignment: .leading, spacing: PolarisSpace.xxs) {
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
            .modifier(OptionalTint(color: accentTextTint))
            .controlSize(.small)
            .disabled(isWorking)
            .accessibilityLabel(theme.copy.reconnectButton)
            .accessibilityHint("Re-checks your license to leave the offline grace period.")

        return Group {
            if dynamicTypeSize.isAccessibilitySize {
                // At accessibility sizes a single row squeezes the copy into a sliver: stack it.
                VStack(alignment: .leading, spacing: PolarisSpace.s) {
                    HStack(alignment: .firstTextBaseline, spacing: PolarisSpace.xs) { glyph; text }
                    button
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: PolarisSpace.s) {
                    glyph
                    text
                    Spacer(minLength: PolarisSpace.s)
                    button
                }
            }
        }
        .frame(maxWidth: PolarisGateLayout.bannerMaxWidth)
        .padding(.horizontal, PolarisGateLayout.pagePadding)
        .padding(.vertical, PolarisSpace.s)
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

/// The gate's layout constants. The page's arrangement and widths are `PolarisKitLayout`'s.
enum PolarisGateLayout {
    /// The form's maximum width: comfortable on iPad and macOS, full width (minus the page inset)
    /// on iPhone.
    static let cardMaxWidth: CGFloat = PolarisKitLayout.columnMaxWidth
    /// The grace banner's content width: centred, never edge to edge on a wide window.
    static let bannerMaxWidth: CGFloat = 680
    /// The license-key field's corner radius.
    static let controlRadius: CGFloat = 12
    /// The grace banner's side inset.
    static let pagePadding: CGFloat = PolarisSpace.l
}

/// How the gate offers a refusal link (PX-W8): a button where a browser is at hand, a QR code on
/// a TV.
public enum PolarisManagePresentation: Sendable, Equatable {
    case button
    case qr

    public static var current: PolarisManagePresentation {
        #if os(tvOS)
            return .qr
        #else
            return .button
        #endif
    }
}

extension View {
    /// A kit sheet's size. macOS sizes a sheet from its content, so it gets a comfortable ideal
    /// size and a minimum small enough for a 480 x 520 window (a 520-pt minimum clipped Cancel
    /// there); iOS gives the sheet the screen and the page lays itself out in it.
    func polarisSheetFrame() -> some View {
        #if os(macOS)
            frame(minWidth: 380, idealWidth: 460, minHeight: 360, idealHeight: 480)
        #else
            self
        #endif
    }
}

/// Activate is the primary action when no Sign in sits above it.
private struct ActivateProbe: ViewModifier {
    let isPrimary: Bool
    func body(content: Content) -> some View {
        if isPrimary {
            content.polarisLayoutProbe(.primaryAction)
        } else {
            content.polarisLayoutProbe(.activate)
        }
    }
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
            PolarisGateSurface(
                status: .needsActivation, allowedRange: nil, isWorking: false,
                lastError: PolarisCopy().activationMessage(.deviceLimit(limit: 1, deviceCount: 1)),
                manageURL: "https://key.plrs.im/activate?product=aurora&next=free-device",
                licenseKey: .constant("pkey_aurora_ABCDEFGHIJKLMNOPQRSTUV"), theme: aurora,
                onSignIn: {}, onActivate: { _ in }, onRefresh: {}, content: { EmptyView() }
            )
            .previewLayout(.fixed(width: 393, height: 852))
            .previewDisplayName("Device limit with Replace a device")
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
