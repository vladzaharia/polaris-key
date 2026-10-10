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
    /// False until the first `reload()` has read the client: the gate then draws only its ground,
    /// so a licensed cold launch never flashes the activation card.
    @Published public private(set) var hasLoaded = false
    @Published public var lastError: String?
    /// Raised once per activation result, so a repeated identical refusal is still announced.
    @Published public private(set) var resultSerial = 0
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
        hasLoaded = true
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
        resultSerial += 1
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
            isLoading: !model.hasLoaded,
            resultSerial: model.resultSerial,
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
    /// The first read of the client has not finished: draw the ground and nothing else.
    var isLoading = false
    /// Raised per activation result (see `PolarisKeyModel.resultSerial`).
    var resultSerial = 0
    /// Called when the person taps Replace a device (the gate retries once when they return).
    var onOpenManage: (() -> Void)? = nil
    /// Where an expired licence is renewed or managed (`GateOptions.renewURL`), or nil.
    var renewURL: URL? = nil
    /// Called when the person taps Renew or manage (the gate re-checks when they return).
    var onOpenRenew: (() -> Void)? = nil
    /// The host's own action on a blocking state (`GateOptions.blockedAction`).
    var blockedAction: (@MainActor @Sendable (LicenseStatus) -> AnyView?)? = nil
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
    /// Starts with the form showing (render tests and previews of that step).
    var showsKeyFormInitially = false
    let content: () -> Content

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var environmentBranding
    @Environment(\.polarisKeyPresentation) private var presentation
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @FocusState private var keyFieldFocused: Bool
    @AccessibilityFocusState private var errorFocused: Bool
    /// A focus token raised each time the key field gains focus, so the page scrolls it above the
    /// keyboard without any layout change.
    @State private var focusToken = 0
    /// The error is cleared from view as soon as the key is edited, so a stale refusal does not sit
    /// under a key the person is fixing.
    @State private var errorDismissed = false
    /// "Use a different key" was chosen on a blocking state: the activation form shows in its place.
    @State private var showsKeyForm = false

    private var style: PolarisKitStyle {
        PolarisKitStyle(
            theme: theme, scheme: colorScheme, branding: environmentBranding,
            presentation: presentation)
    }
    private var palette: PolarisPalette { style.palette }
    /// The tint the gate imposes, or nil to inherit the host app's.
    private var tint: Color? { style.tint }
    private var accentTextTint: Color? { style.textTint }
    private func font(_ role: PolarisTypography.Role) -> Font { style.typography.font(role) }

    /// The error shown under the field, or nil once the key is edited.
    private var visibleError: String? { errorDismissed ? nil : lastError }
    /// The manage URL for a device-limit refusal, as a URL.
    private var manageLink: URL? { manageURL.flatMap(URL.init(string:)) }

    /// What the announcer watches: a new result, or a new message.
    private struct ErrorEvent: Equatable {
        var serial: Int
        var message: String?
    }

    var body: some View {
        Group {
            if isLoading {
                loadingGround
            } else {
                switch status {
                case .ok, .notApplicable:
                    // §5 / D-08 — a product that does not run the license service has no gate to
                    // show. Rendering the activation form there would demand a licence that does
                    // not exist.
                    content()
                case .grace:
                    graceScreen
                case .needsActivation:
                    activationScreen()
                case .revoked, .expired:
                    // A blocking state gets the actions that can change it (DL6): a different key,
                    // sign-in, renew or manage, and the host's own. The key form is one tap away
                    // and Cancel returns here.
                    if showsKeyForm && showsKeyEntry {
                        activationScreen(differentKey: true)
                    } else {
                        blockedScreen(status)
                    }
                case .versionTooOld, .versionTooNew, .channelNotEntitled:
                    blockedScreen(status)
                }
            }
        }
        .onChange(of: ErrorEvent(serial: resultSerial, message: lastError)) { _, new in
            errorDismissed = false
            if let message = new.message {
                PolarisAccessibility.announce(message)
                errorFocused = true
            }
        }
        .onChange(of: licenseKey) { _, _ in errorDismissed = true }
        .onChange(of: status) { _, _ in showsKeyForm = false }
        .onAppear { if showsKeyFormInitially { showsKeyForm = true } }
    }

    /// The gate's ground before the first read of the client: no card, no copy (the answer is a
    /// local read), named for VoiceOver.
    private var loadingGround: some View {
        palette.page
            .ignoresSafeArea()
            .accessibilityElement()
            .accessibilityLabel(theme.copy.kit.bootChecking)
    }

    // ── needs-activation: the product, then Sign in and the license key ──
    //
    // The Welcome leads with the product (its icon at hero size, never a Polaris Key mark: UI-KITS
    // §1.2, §1.6) and lays out for the space it gets (`PolarisAdaptivePage`): one column in
    // portrait, the form beside the welcome in landscape and short windows, and the split Welcome on
    // landscape-shaped iPad and Mac windows, where the icon moves to the pane. After "Use a
    // different key" on a blocking state (`differentKey`) the same form leads with that title and
    // ends in Cancel.
    private func activationScreen(differentKey: Bool = false) -> some View {
        let style = self.style
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        return PolarisAdaptivePage(style: style, identity: identity) { layout in
            if differentKey {
                PolarisPageHeading(
                    title: theme.copy.kit.useDifferentKeyTitle, identity: identity, style: style,
                    layout: layout)
            } else {
                VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.s) {
                    if layout != .split {
                        PolarisPageDecoration {
                            PolarisWelcomeHero(identity: identity, style: style)
                        }
                    }
                    Text(theme.copy.welcomeTitle(naming: identity.name))
                        .font(style.font(.welcomeTitle)).foregroundStyle(palette.textStrong)
                        .multilineTextAlignment(layout.textAlignment)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if let developer = identity.developer {
                        Text(developerLine(developer))
                            .font(style.font(.caption)).foregroundStyle(palette.textMuted)
                            .multilineTextAlignment(layout.textAlignment)
                    }
                }
                .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
                .modifier(PolarisCompressedType(compressed: false))
            }
        } detail: { layout in
            // The integrator's own subtitle is product copy: shown when set, omitted when the page
            // is compressed. The default lede is empty (the buttons say it).
            if !differentKey, !theme.copy.welcomeSubtitle.isEmpty {
                PolarisPageDecoration {
                    PolarisPageText(
                        text: Text(theme.copy.welcomeSubtitle), style: style, layout: layout)
                }
            }
        } act: { layout in
            VStack(spacing: PolarisSpace.s) {
                PolarisFitReader { fit in
                    activationForm(layout, compact: fit.compressed, keyOnly: differentKey)
                }
                if differentKey {
                    Button(theme.copy.kit.cancelButton) { showsKeyForm = false }
                        .controlSize(.large)
                        .modifier(KitTint(color: accentTextTint))
                        .modifier(PolarisButtonSkin(style: style, prominent: false))
                        .modifier(PolarisButtonFont(style: style))
                        .keyboardShortcut(.cancelAction)
                        .disabled(isWorking)
                }
            }
        }
        .modifier(OptionalTint(color: tint))
    }

    /// "by <Developer>" (catalog `common.byDeveloper`, `by %@`).
    private func developerLine(_ developer: String) -> String {
        "by \(developer)"
    }

    /// `compact` (a compressed page, such as a phone in landscape) trims decoration so the whole
    /// act, including a device-limit callout's action, stays above the fold: no key
    /// label, regular-size controls and tighter spacing. The structure stays the same either way.
    @ViewBuilder private func activationForm(
        _ layout: PolarisKitLayout, compact: Bool = false, keyOnly: Bool = false
    ) -> some View {
        let keyHasText = !licenseKey.trimmingCharacters(in: .whitespaces).isEmpty
        let deviceLimit = manageLink != nil && visibleError != nil
            && PolarisManagePresentation.current == .button
        // One prominent action at a time: the device-limit callout's Replace when it shows, else
        // Activate once the field has text, else Sign in.
        // After "Use a different key" the person has chosen the key: Activate is the one filled
        // action and Sign in (one step back) is not repeated.
        let signIn = keyOnly ? nil : onSignIn
        let activateProminent = showsKeyEntry && (keyHasText || keyOnly) && !deviceLimit
        let signInProminent = signIn != nil && !activateProminent && !deviceLimit

        VStack(spacing: compact ? PolarisSpace.xs : PolarisSpace.s) {
            if let onSignIn = signIn {
                gateButton(
                    theme.copy.signInButton, prominent: signInProminent, role: .primary,
                    disabled: isWorking, compact: compact, action: onSignIn)
                    .modifier(
                        GateProbe(role: signInProminent ? .primaryAction : nil))
                    // A background, because a probe on the same view as another replaces it.
                    .background(Color.clear.polarisLayoutProbe(.signIn))
            }

            if showsKeyEntry {
                if !compact { keyFieldLabel }
                // A refusal the person can resolve (device limit) is not a wrong key: no red field.
                licenseKeyField(hasError: visibleError != nil && !deviceLimit)
                gateButton(
                    theme.copy.activateButton, prominent: activateProminent, role: .activate,
                    disabled: isWorking || !keyHasText, busy: isWorking, compact: compact,
                    action: { onActivate(licenseKey) })
                    .modifier(
                        GateProbe(role: activateProminent ? .primaryAction : .activate))

                if deviceLimit, let url = manageLink {
                    deviceLimitCallout(url, compact: compact)
                } else if let err = visibleError {
                    errorLine(err, layout: layout)
                }
            } else if let err = visibleError {
                errorLine(err, layout: layout)
            }

            if onContinueFree != nil || (onActivateOffline != nil && showsKeyEntry) {
                extras(layout).padding(.top, PolarisSpace.xs)
            }

            // tvOS: the refusal link is a QR, opened on a phone.
            if let url = manageLink, PolarisManagePresentation.current == .qr {
                freeDeviceQR(url)
            }

            if let badge = theme.poweredBy {
                PolarisPoweredByBadge(layout: badge.layout, treatment: badge.treatment)
                    .padding(.top, PolarisSpace.l)
            }
        }
    }

    /// One gate button, labelled through the shared role; the `.activate` role shows its busy
    /// label while the gate works.
    private enum GateButtonRole { case primary, activate }
    @ViewBuilder private func gateButton(
        _ title: String, prominent: Bool, role: GateButtonRole, disabled: Bool, busy: Bool = false,
        compact: Bool = false, isDefault: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: PolarisSpace.xs) {
                if busy, role == .activate {
                    ProgressView().controlSize(.small)
                }
                Text(busy && role == .activate ? theme.copy.kit.activatingLabel : title)
            }
            .modifier(PolarisButtonFont(style: style))
            .frame(maxWidth: .infinity)
        }
        .controlSize(compact ? .regular : (prominent && role == .primary ? .extraLarge : .large))
        .modifier(KitTint(color: prominent ? tint : accentTextTint))
        .modifier(PolarisButtonSkin(style: style, prominent: prominent))
        .modifier(DefaultActionShortcut(active: (role == .activate && prominent) || isDefault))
        .disabled(disabled)
        .accessibilityLabel(title)
    }

    private var keyFieldLabel: some View {
        Text(theme.copy.kit.keyFieldLabel)
            .font(style.font(.meta)).foregroundStyle(palette.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityHidden(true)
    }

    private func errorLine(_ message: String, layout: PolarisKitLayout) -> some View {
        Label {
            Text(message).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.circle.fill").accessibilityHidden(true)
        }
        .font(font(.caption)).foregroundStyle(palette.danger)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, PolarisSpace.xxs)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityFocused($errorFocused)
    }

    /// A device-limit refusal and Replace a device in one callout under the field: the error, then
    /// the region's only prominent button.
    private func deviceLimitCallout(_ url: URL, compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: PolarisSpace.s) {
            Label {
                Text(lastError ?? "").fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "info.circle").accessibilityHidden(true)
            }
            .font(style.font(.meta)).foregroundStyle(palette.textDefault)
            .accessibilityAddTraits(.isStaticText)
            .accessibilityFocused($errorFocused)

            Button {
                onOpenManage?()
                openURL(url)
            } label: {
                Text(theme.copy.freeDeviceButton)
                    .modifier(PolarisButtonFont(style: style))
                    .frame(maxWidth: .infinity)
            }
            .controlSize(compact ? .regular : .large)
            .modifier(KitTint(color: tint))
            .modifier(PolarisButtonSkin(style: style, prominent: true))
            .accessibilityLabel(theme.copy.freeDeviceButton)
            .polarisLayoutProbe(.primaryAction)
        }
        .padding(PolarisSpace.s)
        .frame(maxWidth: .infinity)
        // A neutral callout (default text on the neutral tile ground, no danger colour): the
        // refusal is resolved by its one prominent action, not an error to fix in the field.
        .background(style.tileFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(palette.borderSubtle, lineWidth: 1))
        .padding(.top, PolarisSpace.xxs)
    }

    /// The quiet extras (Continue free, Activate offline) under the form (UI-KITS §4.3), centred
    /// under the full-width controls and lead-aligned only in the split. On macOS they are links.
    private func extras(_ layout: PolarisKitLayout) -> some View {
        let links = Group {
            if let onContinueFree {
                Button(theme.copy.kit.continueFreeButton, action: onContinueFree)
                    .disabled(isWorking)
            }
            if let onActivateOffline, showsKeyEntry {
                Button(theme.copy.kit.activateOfflineLink, action: onActivateOffline)
                    .disabled(isWorking)
            }
        }
        .modifier(PolarisButtonFont(style: style))
        .modifier(ExtrasButtonStyle(tint: accentTextTint))
        let alignment: Alignment = layout == .split ? .leading : .center
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: PolarisSpace.l) { links }
            VStack(spacing: PolarisSpace.s) { links }
        }
        .frame(maxWidth: .infinity, alignment: alignment)
    }

    /// PX-W8 on tvOS: the refusal link as a QR, opened on a phone.
    private func freeDeviceQR(_ url: URL) -> some View {
        VStack(spacing: PolarisSpace.xs) {
            PolarisQRCode(url.absoluteString, accessibilityLabel: theme.copy.freeDeviceButton)
                .frame(width: 200, height: 200)
            Text(theme.copy.freeDeviceScanCaption)
                .font(font(.caption)).foregroundStyle(palette.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The license-key field. The field stays fully opaque and hit-testable at rest (only its
    /// glyphs are hidden under a middle-truncated overlay), so a tap anywhere focuses it and
    /// VoiceOver reads the key. Under the native preset on macOS it is the system rounded field.
    @ViewBuilder private func licenseKeyField(hasError: Bool) -> some View {
        let resting = !keyFieldFocused && !licenseKey.isEmpty
        let field = TextField(
            theme.copy.kit.keyFieldPlaceholder, text: $licenseKey,
            // The placeholder is the only visible name in compact mode. The system prompt is
            // blended toward the background on some OS releases (3.1:1 light on macOS 15), so it
            // stays empty and `placeholderOverlay` draws the muted text, the same on every OS.
            prompt: Text(""))
            .font(style.monoBody)
            .multilineTextAlignment(.leading)
            .autocorrectionDisabled()
            #if os(iOS)
                .textInputAutocapitalization(.never)
                .submitLabel(.go)
            #endif
            .focused($keyFieldFocused)
            .preference(key: PolarisFieldFocusKey.self, value: keyFieldFocused)
            .polarisLayoutProbe(.keyField)
            .onChange(of: keyFieldFocused) { _, focused in
                if focused { focusToken += 1 }
            }
            // The first keystroke clears the refusal callout and reflows the act: ask the page to
            // bring the act back above the keyboard.
            .onChange(of: errorDismissed) { _, dismissed in
                if dismissed, keyFieldFocused { focusToken += 1 }
            }
            .onSubmit {
                guard !isWorking, !licenseKey.trimmingCharacters(in: .whitespaces).isEmpty else {
                    return
                }
                onActivate(licenseKey)
            }
            .disabled(isWorking)
            .accessibilityLabel(theme.copy.kit.keyFieldLabel)
            .accessibilityValue(licenseKey)

        #if os(macOS)
            if style.branding == .native {
                field
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    // Hide only the field's own glyphs at rest (as the custom field does), so the
                    // key is drawn once, by the middle-truncated overlay inset to the system
                    // field's text inset.
                    .foregroundStyle(resting ? Color.clear : palette.textDefault)
                    .overlay(restingOverlay(resting).padding(.horizontal, 8))
                    .overlay(placeholderOverlay.padding(.horizontal, 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(hasError ? palette.danger : Color.clear, lineWidth: 1))
                    .polarisScrollRequest(focusToken)
            } else {
                customKeyField(field, resting: resting, hasError: hasError)
            }
        #else
            customKeyField(field, resting: resting, hasError: hasError)
        #endif
    }

    @ViewBuilder private func customKeyField<F: View>(
        _ field: F, resting: Bool, hasError: Bool
    ) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: PolarisGateLayout.controlRadius, style: .continuous)
        HStack(spacing: PolarisSpace.xs) {
            field
                .textFieldStyle(.plain)
                // Hide only the glyphs at rest, so the field stays hit-testable and in the
                // accessibility tree; the middle-truncated overlay shows the key.
                .foregroundStyle(resting ? Color.clear : palette.textDefault)
                .overlay(restingOverlay(resting), alignment: .leading)
                .overlay(placeholderOverlay, alignment: .leading)
                .frame(maxWidth: .infinity)
            #if os(iOS)
                PasteButton(payloadType: String.self) { items in
                    if let first = items.first { licenseKey = first }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.capsule)
                .tint(accentTextTint ?? palette.accentText)
            #endif
        }
        .padding(.horizontal, PolarisSpace.m)
        .padding(.vertical, PolarisSpace.s)
        .background(shape.fill(palette.page))
        .overlay(shape.strokeBorder(hasError ? palette.danger : palette.borderStrong, lineWidth: 1))
        .modifier(OptionalTint(color: tint == nil ? nil : palette.focus))
        .polarisScrollRequest(focusToken)
    }

    @ViewBuilder private var placeholderOverlay: some View {
        if licenseKey.isEmpty {
            Text(theme.copy.kit.keyFieldPlaceholder)
                .font(style.monoBody)
                .foregroundStyle(palette.textMuted)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder private func restingOverlay(_ resting: Bool) -> some View {
        if resting {
            Text(licenseKey)
                .font(style.monoBody)
                .foregroundStyle(palette.textDefault)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .allowsHitTesting(false)
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

    /// A blocking state (revoked, expired, a version block): its glyph and title, the explanation
    /// and the actions that can change it (DL6), on the same page as the Welcome. Exactly one is
    /// filled. Expired: Renew or manage when the host gave a page, else Try again; then Use a
    /// different key and Sign in. Revoked: Use a different key (or Sign in without key entry).
    /// Version blocks: Try again. The host's own action closes the list.
    private func blockedScreen(_ status: LicenseStatus) -> some View {
        let style = self.style
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        let message = theme.copy.message(for: status, allowedRange: allowedRange)
        let offers = blockedOffers(status)
        let tone = status == .revoked ? palette.danger : palette.warning
        return PolarisAdaptivePage(style: style, identity: identity) { layout in
            PolarisPageHeading(
                title: message?.title ?? "", identity: identity, style: style, layout: layout,
                symbol: message?.symbol, symbolTint: tone)
        } detail: { layout in
            PolarisPageText(
                text: Text(blockedSubtitle(status, message: message, offers: offers)), style: style,
                layout: layout)
        } act: { layout in
            blockedActions(status, offers: offers)
        }
        .modifier(OptionalTint(color: tint))
    }

    /// The ways out a blocking state has right now.
    private struct BlockedOffers {
        var renew: Bool
        var differentKey: Bool
        var signIn: Bool
    }

    private func blockedOffers(_ status: LicenseStatus) -> BlockedOffers {
        switch status {
        case .expired, .revoked:
            return BlockedOffers(
                renew: status == .expired && renewURL != nil, differentKey: showsKeyEntry,
                signIn: onSignIn != nil)
        default:
            return BlockedOffers(renew: false, differentKey: false, signIn: false)
        }
    }

    /// The explanation, worded for the actions below it. A subtitle the integrator changed is
    /// theirs and is shown as given.
    private func blockedSubtitle(
        _ status: LicenseStatus, message: PolarisMessageCopy?, offers: BlockedOffers
    ) -> String {
        guard let message else { return "" }
        let defaults = PolarisCopy()
        let kit = theme.copy.kit
        switch status {
        case .expired where theme.copy.expiredSubtitle == defaults.expiredSubtitle:
            if offers.renew { return kit.expiredWithRenew }
            return offers.differentKey ? kit.expiredWithKey : kit.expiredCheckOnly
        case .revoked where theme.copy.revokedSubtitle == defaults.revokedSubtitle:
            switch (offers.signIn, offers.differentKey) {
            case (true, true): return message.subtitle
            case (false, true): return kit.revokedKeyOnly
            case (true, false): return kit.revokedSignInOnly
            case (false, false): return kit.revokedContactOnly
            }
        default:
            return message.subtitle
        }
    }

    @ViewBuilder private func blockedActions(_ status: LicenseStatus, offers: BlockedOffers)
        -> some View
    {
        let kit = theme.copy.kit
        // The one filled action.
        let primary: BlockedAction = {
            if offers.renew { return .renew }
            if status == .revoked {
                if offers.differentKey { return .differentKey }
                if offers.signIn { return .signIn }
            }
            return .retry
        }()
        let order: [BlockedAction] = {
            var list: [BlockedAction] = [primary]
            let rest: [BlockedAction] =
                status == .expired
                ? [.retry, .differentKey, .signIn] : [.signIn, .differentKey, .retry]
            for action in rest where action != primary { list.append(action) }
            return list.filter { action in
                switch action {
                case .renew: return offers.renew
                case .differentKey: return offers.differentKey
                case .signIn: return offers.signIn
                case .retry: return true
                }
            }
        }()
        VStack(spacing: PolarisSpace.s) {
            ForEach(Array(order.enumerated()), id: \.element) { index, action in
                let isPrimary = index == 0
                gateButton(
                    title(of: action, kit: kit), prominent: isPrimary, role: .primary,
                    disabled: isWorking && action == .retry, isDefault: isPrimary,
                    action: { perform(action) }
                )
                .modifier(GateProbe(role: isPrimary ? .primaryAction : nil))
            }
            if let extra = blockedAction?(status) { extra }
        }
        .frame(maxWidth: PolarisKitLayout.columnMaxWidth)
        .frame(maxWidth: .infinity)
    }

    private enum BlockedAction: Hashable { case renew, differentKey, signIn, retry }

    private func title(of action: BlockedAction, kit: PolarisKitCopy) -> String {
        switch action {
        case .renew: return kit.renewButton
        case .differentKey: return kit.useDifferentKeyButton
        case .signIn: return theme.copy.signInButton
        case .retry: return theme.copy.retryButton
        }
    }

    private func perform(_ action: BlockedAction) {
        switch action {
        case .renew:
            guard let renewURL else { return }
            onOpenRenew?()
            openURL(renewURL)
        case .differentKey: showsKeyForm = true
        case .signIn: onSignIn?()
        case .retry: onRefresh()
        }
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
/// Publish a gate button's bounds as its layout role (nil publishes nothing).
private struct GateProbe: ViewModifier {
    let role: PolarisLayoutRole?
    func body(content: Content) -> some View {
        if let role {
            content.polarisLayoutProbe(role)
        } else {
            content
        }
    }
}

/// Return as the gate's default action (Return) only when active.
private struct DefaultActionShortcut: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active {
            content.keyboardShortcut(.defaultAction)
        } else {
            content
        }
    }
}

/// Reads the page's fit from the environment the page set, for content built by a closure of an
/// outer view (which would otherwise see only its own environment).
struct PolarisFitReader<Content: View>: View {
    @ViewBuilder let content: (PolarisPageFit) -> Content
    @Environment(\.polarisPageFit) private var fit
    var body: some View { content(fit) }
}

/// The Welcome's hero icon: 120 pt in a tall column, 56 pt beside the form or at accessibility
/// type sizes (where the form needs the room), else the default hero. Drops on a compressed page.
struct PolarisWelcomeHero: View {
    let identity: PolarisProductIdentity
    let style: PolarisKitStyle

    @Environment(\.polarisPageFit) private var fit
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        PolarisProductIcon(identity: identity, size: size, style: style)
            .padding(.bottom, PolarisSpace.xs)
    }

    private var size: CGFloat {
        if dynamicTypeSize.isAccessibilitySize { return 56 }
        if fit.tall { return 120 }
        #if os(macOS)
            return 72
        #else
            return 96
        #endif
    }
}

/// The extras' button style: on macOS a plain text button in the resolved accent text colour when
/// the kit sets one (the system's link style takes the system link blue and ignores the tint),
/// else the link style under the host's tint; borderless elsewhere.
private struct ExtrasButtonStyle: ViewModifier {
    let tint: Color?
    func body(content: Content) -> some View {
        #if os(macOS)
            if let tint {
                content.buttonStyle(.plain).foregroundStyle(tint).underline()
            } else {
                content.buttonStyle(.link)
            }
        #else
            content.buttonStyle(.borderless).modifier(OptionalTint(color: tint))
        #endif
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
