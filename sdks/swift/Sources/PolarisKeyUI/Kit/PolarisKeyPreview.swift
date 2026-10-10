// Previews and the state gallery (UI-KITS §6.1, §6.2): any public `PolarisKeyPreviewState` drawn
// by the kit's own views over a still model, with no client and no network.
//
//   #Preview { PolarisKeyPreview(.named(.welcome, "default")!) }
//   PolarisKeyGallery()   // every state, grouped by component

import PolarisKeyUICore
import SwiftUI

/// One preview state, drawn as the drop-in would draw it.
public struct PolarisKeyPreview: View {
    let state: PolarisKeyPreviewState
    let frozen: Date?
    @State private var model: PolarisKeyGateModel

    /// `frozenTime` stops the countdowns at the moment the preview was made, for renders that
    /// must match a baseline.
    public init(_ state: PolarisKeyPreviewState, iconData: Data? = nil, frozenTime: Bool = false) {
        self.state = state
        let now = Date()
        self.frozen = frozenTime ? now : nil
        let route: KitGateRoute
        switch state.component {
        case .signIn, .signInHandoff, .licenseChoice: route = .signIn
        case .activate: route = .activate
        default: route = .welcome
        }
        let request = KitSignInRequest(
            userCode: "WDJB-MJHT", verificationUri: "https://key.plrs.im/device",
            verificationUriComplete: "https://key.plrs.im/device?code=WDJB-MJHT",
            expiresAt: Int(now.timeIntervalSince1970) + 252)
        _model = State(
            initialValue: PolarisKeyGateModel(
                preview: state.inputs, route: route, request: request,
                presentationIcon: iconData))
    }

    public var body: some View {
        PolarisKeyScope(model: model) {
            screen
        }
        .environment(\.polarisKeyNow, frozen)
    }

    @ViewBuilder private var screen: some View {
        switch state.component {
        case .gate:
            PolarisKeyGate(model: model) { PreviewHostApp() }
        case .boot:
            BootView(boot: model.boot)
        case .welcome:
            WelcomeView(screen: model.welcome, onSignIn: {}, onUseKey: {})
        case .signIn, .signInHandoff, .licenseChoice:
            SignInView(model: model)
        case .activate:
            ActivateView(
                screen: model.activate, text: $model.keyText, onSubmit: {},
                onReplaceDevice: {}, onCancel: {})
        case .deviceLimit:
            DeviceLimitView(
                screen: model.deviceLimit, devices: model.inputs.devices ?? [],
                onOpenBrowser: {}, onReplace: {}, onBack: {})
        case .statusScreen:
            StatusScreenView(
                screen: model.statusScreen,
                available: ["signin.key.differentKey", "status.useAnotherLicense", "common.signOut"],
                onFix: { _ in }, onTryAgain: {})
        case .graceBanner:
            ZStack(alignment: .bottom) {
                PreviewHostApp()
                GraceBannerView(screen: model.graceBanner, onReconnect: {}, onDismiss: {})
            }
        default:
            PreviewHostApp()
        }
    }
}

/// A stand-in for the host app behind an overlay.
struct PreviewHostApp: View {
    var body: some View {
        kitStyle { style in
            NavigationStack {
                List {
                    ForEach(["Harbor demo", "Night swim", "Field notes", "Lighthouse"], id: \.self) {
                        Text($0)
                    }
                }
                .navigationTitle(style.identity.name)
            }
        }
    }
}

/// Every preview state, grouped by component: the sample's gallery and a review aid.
public struct PolarisKeyGallery: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                ForEach(KitComponent.allCases, id: \.self) { component in
                    let states = PolarisKeyPreviewState.of(component)
                    if !states.isEmpty {
                        Section(component.rawValue) {
                            ForEach(states) { state in
                                NavigationLink(state.variant.map { "\(state.state) · \($0)" } ?? state.state) {
                                    PolarisKeyPreview(state)
                                        .navigationBarBackButtonHiddenIfAvailable()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

extension View {
    @ViewBuilder fileprivate func navigationBarBackButtonHiddenIfAvailable() -> some View {
        #if os(iOS)
            self.toolbarBackground(.hidden, for: .navigationBar)
        #else
            self
        #endif
    }
}

#Preview("Welcome") {
    PolarisKeyPreview(PolarisKeyPreviewState.named(.welcome, "default")!)
}

#Preview("Activate, device limit") {
    PolarisKeyPreview(PolarisKeyPreviewState.named(.activate, "device-limit")!)
}

#Preview("Sign in, code") {
    PolarisKeyPreview(PolarisKeyPreviewState.named(.signInHandoff, "code")!)
}
