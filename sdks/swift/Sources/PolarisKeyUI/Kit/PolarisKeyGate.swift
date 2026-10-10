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

    @Environment(\.polarisKeyTheme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.locale) private var locale

    @State private var graceDismissed = false
    @State private var manageOpened = false
    @State private var toastShown = false

    /// Gate `content` on `client`'s license.
    public init(
        _ client: PolarisKeyClient, options: KitGateOptions = KitGateOptions(),
        providers: [KitProvider] = [.apple], @ViewBuilder content: @escaping () -> Content
    ) {
        _model = State(initialValue: PolarisKeyGateModel(client: client, options: options))
        self.providers = providers
        self.content = content
    }

    /// Gate `content` with a model the host holds (previews, its own composition).
    public init(
        model: PolarisKeyGateModel, providers: [KitProvider] = [.apple],
        @ViewBuilder content: @escaping () -> Content
    ) {
        _model = State(initialValue: model)
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
        .task { model.start() }
        .onChange(of: theme) { _, theme in model.options.integrator = theme.integrator }
        .onAppear { model.options.integrator = theme.integrator }
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
                screen: KitScreen(nil, []), available: [], onFix: { _ in },
                onTryAgain: { Task { await model.refresh() } })
        case .needsActivation:
            activation
        case .blocked:
            if model.route == .welcome {
                StatusScreenView(
                    screen: model.statusScreen,
                    available: [
                        "signin.key.differentKey", "status.useAnotherLicense", "common.signOut",
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
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                }
        case .welcome, .offline:
            welcome
        case .activate:
            ActivateView(
                screen: model.activate, text: $model.keyText,
                onSubmit: { Task { await model.submitKey() } }, onReplaceDevice: replaceDevice,
                onCancel: { model.backToWelcome() })
        case .signIn:
            SignInView(model: model, providers: providers)
        }
    }

    private var welcome: some View {
        WelcomeView(
            screen: model.welcome, onSignIn: { model.beginSignIn() },
            onUseKey: { model.useLicenseKey() },
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
                    onReplaceDevice: replaceDevice, onCancel: nil)
            })
    }

    @ViewBuilder private var overlays: some View {
        let grace = model.graceBanner
        if grace.state == .daysLeft || grace.state == .lastDay, !graceDismissed {
            GraceBannerView(
                screen: grace, onReconnect: { Task { await model.refresh() } },
                onDismiss: { graceDismissed = true })
        }
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
        case "common.signOut":
            Task { await model.signOut() }
        default:
            Task { await model.refresh() }
        }
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
        providers: [KitProvider] = [.apple]
    ) -> some View {
        PolarisKeyGate(client, options: options, providers: providers) { self }
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
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .onAppear { model.route = .signIn }
            .onDisappear { model.cancelSignIn() }
        }
    }
}
