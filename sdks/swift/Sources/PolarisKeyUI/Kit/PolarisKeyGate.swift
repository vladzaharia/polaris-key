// @pkey-feature ui.gate
// The drop-in (UI-KITS §1.3 layer a, §4.2): `.polarisKeyGate(client)` or
// `PolarisKeyGate(client) { App() }`. It starts itself, never flashes activation before the first
// reload, re-renders on the client's events, and runs every screen the license needs with no
// integrator layout code (DL18). Blocking states own the window on the product's ground (DL2);
// grace and the toast sit over the running app.

import PolarisKey
import PolarisKeyCore
import PolarisKeyUICore
import SwiftUI

public struct PolarisKeyGate<Content: View>: View {
    @State private var model: PolarisKeyGateModel
    private let providers: [KitProvider]
    private let content: () -> Content
    private let handlers: KitGateHandlers

    @Environment(\.polarisKeyTheme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.locale) private var locale

    @State private var graceDismissed = false
    @State private var manageOpened = false
    @State private var cameBack = false

    /// Gate `content` on `client`'s license.
    public init(
        _ client: PolarisKeyClient, options: KitGateOptions = KitGateOptions(),
        providers: [KitProvider] = [.apple], handlers: KitGateHandlers = KitGateHandlers(),
        @ViewBuilder content: @escaping () -> Content
    ) {
        _model = State(
            initialValue: PolarisKeyGateModel(client: client, options: options, handlers: handlers))
        self.handlers = handlers
        self.providers = providers
        self.content = content
    }

    /// Gate `content` with a model the host holds (previews, its own composition).
    public init(
        model: PolarisKeyGateModel, providers: [KitProvider] = [.apple],
        handlers: KitGateHandlers = KitGateHandlers(),
        @ViewBuilder content: @escaping () -> Content
    ) {
        _model = State(initialValue: model)
        self.handlers = handlers
        self.providers = providers
        self.content = content
    }

    public var body: some View {
        PolarisKeyScope(model: model) {
            ZStack(alignment: .bottom) {
                surface
                overlays
            }
        }
        .onChange(of: model.route) { old, new in cameBack = new == .welcome && old != .welcome }
        .sheet(isPresented: mandatoryUpdate) {
            // No dismiss (§4.3): no drag, no Escape, no close button; only the verb.
            PolarisKeyScope(model: model) {
                UpdatePromptView(
                    screen: model.updatePrompt, details: model.inputs.update,
                    onUpdate: updateAction, onLater: {})
            }
            .interactiveDismissDisabled()
        }
        .task { model.start() }
        .onChange(of: theme) { _, theme in model.options.integrator = theme.integrator }
        .onAppear {
            model.options.integrator = theme.integrator
            if !handlers.isEmpty { model.handlers = handlers }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            if manageOpened, model.activate.state == .deviceLimit {
                // Back from Replace a device in the browser: retry the key once (DL6).
                manageOpened = false
                Task { await model.submitKey() }
            } else {
                Task { await model.refresh() }
            }
        }
    }

    @ViewBuilder private var surface: some View {
        let gate = model.gate
        switch gate.state {
        case .licensed, .grace:
            content()
        case .booting, .none:
            BootView(screen: gate)
        case .error:
            StatusScreenView(
                errorLines: gate.copy, onTryAgain: { Task { await model.refresh() } })
        case .needsActivation:
            activation
        case .blocked:
            if model.route == .welcome {
                StatusScreenView(
                    screen: model.statusScreen,
                    available: [
                        "welcome.signIn", "signin.key.differentKey", "status.useAnotherLicense",
                    ],
                    onFix: fix, onTryAgain: { Task { await model.refresh() } })
            } else {
                activation
            }
        }
    }

    /// `presentation: "sheet"` (D-79): the form in one sheet over Welcome; every step morphs inside
    /// it and a second sheet never opens.
    private var signInSheet: Binding<Bool> {
        Binding(
            get: { model.options.signInPresentation == .sheet && model.route == .signIn },
            set: { shown in if !shown { model.backToWelcome() } })
    }

    @ViewBuilder private var activation: some View {
        switch model.route {
        case .signIn where model.options.signInPresentation == .sheet:
            welcome
                .sheet(isPresented: signInSheet) {
                    PolarisKeyScope(model: model) {
                        SignInView(model: model, providers: providers) { model.backToWelcome() }
                    }
                    .kitSignInSheetShape()
                }
        case .welcome:
            welcome
        case .offline:
            OfflineActivationView(
                screen: model.offlineActivation, requestCode: model.offlineRequestCode,
                text: $model.offlineText, onCopied: { model.offlineCodeCopied() },
                onSubmit: { Task { await model.submitOffline() } },
                onCancel: { model.backToWelcome() })
        case .activate:
            ActivateView(
                screen: model.activate, text: $model.keyText,
                onSubmit: { Task { await model.submitKey() } }, onReplaceDevice: replaceDevice,
                onCancel: { model.backToWelcome() })
        case .signIn:
            SignInView(model: model, providers: providers)
        }
    }

    /// Back or Escape from a step: Welcome puts focus on "Use a License Key" again.
    private var returnedToWelcome: Bool { cameBack }

    private var welcome: some View {
        WelcomeView(
            screen: model.welcome, onSignIn: { model.beginSignIn() },
            onUseKey: { model.useLicenseKey() },
            onExtra: { key in
                switch key {
                case "welcome.offline": model.useOffline()
                case "welcome.trial": model.handlers.trial?()
                case "welcome.restore": model.handlers.restore?()
                case "welcome.continueFree": model.handlers.continueFree?()
                default: break
                }
            },
            inline: {
                if model.welcome.shows("welcome.ledeKeyOnly") {
                    ActivateBody(
                        screen: model.activate, text: $model.keyText,
                        onSubmit: { Task { await model.submitKey() } },
                        onReplaceDevice: replaceDevice)
                }
            },
            inlineActions: {
                ActivateActions(
                    screen: model.activate, onSubmit: { Task { await model.submitKey() } },
                    onReplaceDevice: replaceDevice, onCancel: nil,
                    onDifferentKey: { model.keyText = "" })
            },
            refocusUseKey: returnedToWelcome)
    }

    /// The licensed app is showing: the only time the banner and the update sheet draw.
    private var appShowing: Bool {
        model.gate.state == .licensed || model.gate.state == .grace
    }

    /// A mandatory update owns the screen as a sheet with no dismiss (§4.3).
    private var mandatoryUpdate: Binding<Bool> {
        Binding(
            get: {
                guard appShowing else { return false }
                let state = model.updatePrompt.state
                return state == .mandatory || state == .revokedRequiredContent
            },
            set: { _ in })
    }

    /// What "Update now" does: the host's handler, else the store listing the decision named.
    /// Never the release notes page; with neither there is no verb (decision 7).
    private var updateAction: (() -> Void)? {
        switch KitUpdateRoute.resolve(
            hasHandler: model.handlers.update != nil, update: model.inputs.update)
        {
        case .handler: return { model.handlers.update?() }
        case .open(let link): return { openURL(link) }
        case .none: return nil
        }
    }

    @ViewBuilder private var overlays: some View {
        let grace = model.graceBanner
        VStack(spacing: 8) {
            if grace.state == .daysLeft || grace.state == .lastDay, !graceDismissed {
                GraceBannerView(
                    screen: grace, onReconnect: { Task { await model.refresh() } },
                    onDismiss: { graceDismissed = true })
            }
            updateOverlay
            if let toast = model.toast {
                GateToastView(
                    toast: toast, onDismiss: { model.dismissToast(toast.id) },
                    onUpdate: { model.reofferUpdate() }
                )
                .id(toast.id)
            }
        }
    }

    /// The optional offer: the glass banner (with its download inline), or the compact
    /// UpdateProgress row once the download pauses, fails, installs or finishes.
    @ViewBuilder private var updateOverlay: some View {
        let prompt = model.updatePrompt
        let phase = model.inputs.update?.progress?.phase
        if appShowing, !model.updateDismissed || phase != nil {
            switch prompt.state {
            case .mandatory, .revokedRequiredContent, .none, .upToDate, .blocked:
                EmptyView()
            default:
                if let phase, ["paused", "failed", "install", "done"].contains(phase) {
                    UpdateProgressView(
                        screen: KitStates.updateProgress(model.inputs),
                        fraction: model.inputs.update?.progress?.fraction,
                        title: progressTitle, onRetry: { updateAction?() }
                    )
                    .padding()
                    .modifier(KitFloatingProgressSurface())
                } else {
                    UpdatePromptView(
                        screen: prompt, fraction: model.inputs.update?.progress?.fraction,
                        details: model.inputs.update, onUpdate: updateAction,
                        onLater: { model.deferUpdate() })
                }
            }
        }
    }

    /// What is downloading, for the progress row's title.
    private var progressTitle: CopyLine? {
        guard let version = model.inputs.update?.version else { return nil }
        return CopyLine(
            "update.title", ["product": .text(model.identity.name), "version": .text(version)])
    }

    private var replaceDevice: (() -> Void)? {
        guard let link = KitLinks.valid(model.inputs.activation?.manageUrl) else { return nil }
        return {
            manageOpened = true
            openURL(link)
        }
    }

    private func fix(_ key: String) {
        switch key {
        case "signin.key.differentKey", "status.useAnotherLicense":
            model.useDifferentKey()
        case "welcome.signIn":
            model.beginSignIn()
        default:
            Task { await model.refresh() }
        }
    }
}

extension View {
    /// The sign-in sheet's shape. iOS: full height with the drag indicator. macOS: one fitted
    /// sheet, 440 pt wide; macOS 26 draws the inset rounded panel itself and the kit only sizes
    /// it (S3).
    @ViewBuilder fileprivate func kitSignInSheetShape() -> some View {
        #if os(macOS)
            kitMacSheet()
        #else
            presentationDetents([.large]).presentationDragIndicator(.visible)
        #endif
    }
}

/// Puts a gate model's resolved style, copy and icon in the environment of `content`: the
/// one place a subtree turns the theme into colours, fonts and strings.
public struct PolarisKeyScope<Content: View>: View {
    let model: PolarisKeyGateModel
    @ViewBuilder let content: () -> Content

    @Environment(\.polarisKeyTheme) private var theme
    @Environment(\.locale) private var locale

    public init(model: PolarisKeyGateModel, @ViewBuilder content: @escaping () -> Content) {
        self.model = model
        self.content = content
    }

    public var body: some View {
        let icon = KitIconSource.image(theme: theme, presentation: model.presentationIcon)
        let strings = KitStrings(
            catalog: model.copy.overriding(theme.copy), locale: theme.locale ?? locale.identifier)
        content()
            .modifier(PolarisKeyStyleScope(inputs: model.inputs, icon: icon))
            .environment(\.polarisKeyStrings, strings)
            .environment(model)
            // One polite announcement per change (DL7, DL9): a refusal, a step, a result.
            .onChange(of: model.announcement) { _, line in
                guard let line else { return }
                AccessibilityNotification.Announcement(strings.string(line)).post()
            }
    }
}

/// Where the product's icon comes from (UI-KITS §1.2): the integrator's, the presentation's
/// verified bytes, the app bundle's, else nothing (the monogram).
enum KitIconSource {
    @MainActor static func image(theme: PolarisKeyTheme, presentation: Data?) -> CGImage? {
        if let data = theme.product?.iconData,
            let image = PolarisProductIdentity.IconCache.image(for: data)
        {
            return image
        }
        if let presentation, let image = PolarisProductIdentity.IconCache.image(for: presentation) {
            return image
        }
        return PolarisProductIdentity.Bundled.main.icon
    }
}

extension View {
    /// The one-line drop-in (UI-KITS §4.2): gate this view on `client`'s license.
    ///
    /// ```swift
    /// WindowGroup { ContentView().polarisKeyGate(client) }
    /// ```
    public func polarisKeyGate(
        _ client: PolarisKeyClient, options: KitGateOptions = KitGateOptions(),
        providers: [KitProvider] = [.apple], handlers: KitGateHandlers = KitGateHandlers()
    ) -> some View {
        PolarisKeyGate(client, options: options, providers: providers, handlers: handlers) { self }
    }

    /// The one sign-in form as a sheet (`presentation: "sheet"`, D-79): every step morphs inside
    /// it; a second sheet never opens.
    public func polarisKeySignIn(
        isPresented: Binding<Bool>, model: PolarisKeyGateModel, providers: [KitProvider] = [.apple]
    ) -> some View {
        sheet(isPresented: isPresented) {
            PolarisKeyScope(model: model) {
                SignInView(model: model, providers: providers) { isPresented.wrappedValue = false }
            }
            .kitSignInSheetShape()
            .onAppear { model.route = .signIn }
            .onDisappear { model.cancelSignIn() }
        }
    }
}
