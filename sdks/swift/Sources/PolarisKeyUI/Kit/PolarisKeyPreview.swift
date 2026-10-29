// Previews and the state gallery (UI-KITS §6.1, §6.2): any public `PolarisKeyPreviewState` drawn
// by the kit's own views over a still model, with no client and no network.
//
//   #Preview { PolarisKeyPreview(.named(.welcome, "default")!) }
//   PolarisKeyGallery()   // every state, grouped by component

import PolarisKeyCore
import PolarisKeyUICore
import SwiftUI

/// One preview state, drawn as the drop-in would draw it.
public struct PolarisKeyPreview: View {
    let state: PolarisKeyPreviewState
    let frozen: Date?
    let asSheet: Bool
    @State private var model: PolarisKeyGateModel

    /// `frozenTime` stops the countdowns at the moment the preview was made, for renders that
    /// must match a baseline.
    ///
    /// `asSheet` draws the state as the content of a sheet (the form alone, fitted to 440 pt on a
    /// Mac) for a host that presents it with `.sheet`.
    public init(
        _ state: PolarisKeyPreviewState, iconData: Data? = nil, frozenTime: Bool = false,
        asSheet: Bool = false
    ) {
        self.state = state
        self.asSheet = asSheet
        let now = Date()
        self.frozen = frozenTime ? now : nil
        let route: KitGateRoute
        switch state.component {
        case .signIn, .signInHandoff, .licenseChoice: route = .signIn
        case .activate: route = .activate
        case .offlineActivation: route = .offline
        default: route = .welcome
        }
        let request = KitSignInRequest(
            userCode: "WDJB-MJHT", verificationUri: DEVICE_CODE_PAGE,
            verificationUriComplete: DEVICE_CODE_PAGE + "?user_code=WDJB-MJHT",
            expiresAt: Int(now.timeIntervalSince1970) + 252)
        _model = State(
            initialValue: PolarisKeyGateModel(
                preview: state.inputs, route: route, request: request,
                // The icon only where the inputs say verified bytes arrived; else the monogram.
                presentationIcon: state.inputs.presentation?.icon == true ? iconData : nil))
    }

    public var body: some View {
        PolarisKeyScope(model: model) {
            screen
        }
        .environment(\.kitInSheet, asSheet)
        .environment(\.polarisKeyNow, frozen)
    }

    @ViewBuilder private var screen: some View {
        switch state.component {
        case .gate:
            PolarisKeyGate(model: model) { PreviewHostApp() }
        case .boot:
            // A still: every action is drawn as the host would wire it.
            BootView(
                boot: model.boot, onDownload: {}, onNotNow: {}, onContinueOffline: {},
                onTryAgain: {}, onUpdate: {})
        case .welcome:
            WelcomeView(
                screen: model.welcome, onSignIn: {}, onUseKey: {},
                inline: {
                    ActivateBody(
                        screen: model.activate, text: $model.keyText, onSubmit: {},
                        onReplaceDevice: nil)
                },
                inlineActions: {
                    ActivateActions(
                        screen: model.activate, onSubmit: {}, onReplaceDevice: nil, onCancel: nil)
                })
        case .signIn, .signInHandoff, .licenseChoice:
            SignInView(model: model)
        case .nearbyApproval:
            NearbyApprovalView(
                model: NearbyApprovalModel(inputs: model.inputs, codes: ["482 913", "716 204", "359 078"]))
        case .activate:
            ActivateView(
                screen: model.activate, text: $model.keyText, onSubmit: {},
                onReplaceDevice: {}, onCancel: {}, onDone: {},
                refusalLink: ActivateRefusal.link(model.activate, model.inputs.activation),
                onRefusalLink: model.inputs.platform.isTV ? nil : {},
                onSignIn: model.inputs.isOn(.identity) && model.inputs.capabilities.signIn
                    ? {} : nil)
        case .offlineActivation:
            OfflineActivationView(
                screen: model.offlineActivation, requestCode: model.offlineRequestCode,
                text: $model.offlineText, onSubmit: {}, onCancel: {}, onDone: {})
        case .deviceLimit:
            DeviceLimitView(
                screen: model.deviceLimit, devices: model.inputs.devices ?? [],
                onOpenBrowser: {}, onReplace: {}, onBack: {})
        case .statusScreen:
            StatusScreenView(
                screen: model.statusScreen,
                available: [
                    "welcome.signIn", "signin.key.differentKey", "status.renew", "status.update",
                    "status.useAnotherLicense",
                ],
                onFix: { _ in }, onTryAgain: {})
        case .graceBanner:
            ZStack(alignment: .bottom) {
                PreviewHostApp()
                GraceBannerView(screen: model.graceBanner, onReconnect: {}, onDismiss: {})
            }
        case .updatePrompt:
            let screen = model.updatePrompt
            if screen.state == .mandatory || screen.state == .revokedRequiredContent {
                UpdatePromptView(screen: screen, onUpdate: {}, onLater: {})
            } else {
                ZStack(alignment: .bottom) {
                    PreviewHostApp()
                    UpdatePromptView(
                        screen: screen, fraction: model.inputs.update?.progress?.fraction,
                        details: model.inputs.update, onUpdate: {}, onLater: {})
                }
            }
        case .toast:
            ZStack(alignment: .bottom) {
                PreviewHostApp()
                PreviewToast(screen: KitStates.toast(model.inputs))
            }
        case .updateProgress:
            PreviewSettingsHost {
                Section {
                    UpdateProgressView(
                        screen: KitStates.updateProgress(model.inputs),
                        fraction: model.inputs.update?.progress?.fraction, onRetry: {})
                }
            }
        case .releaseNotes:
            NavigationStack {
                ReleaseNotesView(
                    screen: KitStates.releaseNotes(model.inputs),
                    notes: model.inputs.releaseNotes ?? [], onRetry: {})
            }
        case .accountAndLicense where state.variant != nil:
            // The drop-in `PolarisKeySettings`, over a still model.
            PreviewSettingsHost { PolarisKeySettings(model: settingsModel) }
        case .accountAndLicense:
            PreviewSettingsHost {
                AccountAndLicenseSection(
                    screen: KitStates.accountAndLicense(model.inputs), tier: "Pro",
                    holder: "Mara Fennick", version: "2.4.1", devices: "2 of 3",
                    onManage: {}, onSignOut: {})
            }
        case .devices:
            PreviewSettingsHost {
                DevicesSection(
                    screen: KitStates.devices(model.inputs), devices: model.inputs.devices ?? [],
                    onRemove: { _ in }, onRetry: {},
                    onRename: model.inputs.edit?.kind == "rename" ? { _, _ in } : nil,
                    renaming: model.inputs.edit?.kind == "rename"
                        ? model.inputs.devices?.first { $0.name == model.inputs.edit?.device } : nil)
            }
        case .settings:
            PreviewSettingsHost {
                SettingsSection(
                    screen: KitStates.settings(model.inputs), rows: model.inputs.config ?? [],
                    options: state.variant == "controls"
                        ? ["render.quality": ["Low", "Medium", "High"]] : [:],
                    onRetry: {}, onReset: state.variant == "controls" ? { _ in } : nil)
            }
        case .unlockSync:
            UnlockSyncView(model: UnlockSyncModel(inputs: model.inputs, armDelay: .zero))
        case .recoveryCode:
            let recovery = RecoveryCodeModel(inputs: model.inputs)
            let _ = recovery.show(code: PolarisKeyPreviewState.sampleRecoveryCode)
            let _ = recovery.setSaved(model.inputs.recoveryCode?.saved == true)
            RecoveryCodeView(model: recovery)
        case .ringChange:
            RingChangeView(model: RingChangeModel(inputs: model.inputs))
        case .cloudSyncStatus:
            // A still: the buttons draw as the settings host (U-07) will wire them.
            PreviewSettingsHost {
                Section {
                    CloudSyncStatusView(
                        screen: KitStates.cloudSyncStatus(model.inputs), onUnlock: {},
                        onReview: {})
                }
            }
        case .paywall:
            PaywallView(
                screen: KitStates.paywall(model.inputs),
                features: model.inputs.offers?.features ?? [], onPortal: {}, onRedeem: {})
        case .entitlementGate:
            EntitlementGate(screen: KitStates.entitlementGate(model.inputs)) {
                PreviewHostApp()
            } locked: {
                let offers = KitOffers(
                    available: true, tier: "Pro",
                    features: ["Stem export", "Unlimited projects", "Priority support"])
                PaywallView(
                    screen: KitStates.paywall(
                        {
                            var i = model.inputs
                            i.offers = offers
                            return i
                        }()), features: offers.features ?? [], onPortal: {}, onRedeem: {})
            }
        }
    }
}

extension PolarisKeyPreview {
    /// The still model of a `PolarisKeySettings` preview: who is signed in, and what the host can do.
    var settingsModel: PolarisKeySettingsModel {
        let channel: KitChannelState
        var handlers = KitSettingsHandlers(manage: {}, autoUpdate: { _ in })
        switch state.variant {
        case "channel-locked":
            channel = .locked(
                current: "stable",
                reason: CopyLine("channel.locked", ["store": .text("App Store")]))
        case "channel-license":
            channel = .locked(current: "stable", reason: CopyLine("channel.lockedLicense"))
        default:
            channel = .choose(current: "stable", options: ["stable", "beta"])
            handlers.selectChannel = { _ in }
        }
        return PolarisKeySettingsModel(
            preview: state.inputs, tier: "Pro", holder: "Mara Fennick", channel: channel,
            seats: "2 of 3", handlers: handlers, options: KitSettingsOptions(version: "2.4.1"),
            selectOptions: ["render.quality": ["Low", "Medium", "High"]])
    }
}

/// A toast over the host, as the gate draws it (no timer in a still).
struct PreviewToast: View {
    let screen: KitScreen<ToastState>
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        if let line = screen.copy.first {
            ToastView(
                text: strings.string(line), tone: screen.state == .success ? .success : .neutral)
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
                // The stand-in host's list is named, as a real host's is.
                .accessibilityLabel(style.identity.name)
            }
        }
    }
}

/// A host's settings screen, for the panes that join it.
struct PreviewSettingsHost<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        NavigationStack {
            Form { content() }
                .navigationTitle("Settings")
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
                                NavigationLink(
                                    state.variant.map { "\(state.state) · \($0)" } ?? state.state
                                ) {
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
