// `PolarisGate` — the drop-in gate over a `PolarisKeyModel` (notes/SDK-PARITY-PASS.md §3.18).
//
// Every `gate-matrix` status routes to its surface (the same surfaces as `PolarisLoginView`).
// What the model adds:
//
//   * a blocking state (expired, revoked) offers the actions that can change it: Renew or manage
//     (when the host gave `GateOptions.renewURL`), Use a different key, Sign in, and the host's
//     own (`GateOptions.blockedAction`);
//   * until the first read of the client has finished the gate draws only its ground, so a
//     licensed cold launch never flashes the activation card;
//   * "Sign in" opens the built-in device-code sign-in (`PolarisSignIn`; a QR code on TV only) when
//     the product runs Identity, and is HIDDEN when it does not — never a button that does nothing;
//   * "Continue free" (keyless enrolment) when the host says the product offers a free tier;
//   * "Activate offline" opens `PolarisOfflineActivation`;
//   * key entry is hidden where the host says the outlet forbids it (`showsKeyEntry: false`);
//   * every activation outcome is rendered from the shared copy by code (§3.1, §3.2).

import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import SwiftUI

public struct PolarisGate<Content: View>: View {
    private let model: PolarisKeyModel
    private let theme: PolarisTheme
    private let options: GateOptions
    private let content: () -> Content

    @State private var licenseKey = ""
    @State private var sheet: GateSheet?
    @State private var manageOpened = false
    @State private var renewOpened = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    enum GateSheet: String, Identifiable {
        case signIn, offline
        var id: String { rawValue }
    }

    public init(
        model: PolarisKeyModel, theme: PolarisTheme = PolarisTheme(), options: GateOptions,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.model = model
        self.theme = theme
        self.options = options
        self.content = content
    }

    /// The same with the two switches this gate had before `GateOptions`. Offline activation is
    /// off on iOS unless asked for (`GateOptions.defaultOffersOfflineActivation`).
    public init(
        model: PolarisKeyModel, theme: PolarisTheme = PolarisTheme(), showsKeyEntry: Bool = true,
        offersOfflineActivation: Bool = GateOptions.defaultOffersOfflineActivation,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            model: model, theme: theme,
            options: GateOptions(
                showsKeyEntry: showsKeyEntry, offersOfflineActivation: offersOfflineActivation),
            content: content)
    }

    private var showsKeyEntry: Bool { options.showsKeyEntry }

    public var body: some View {
        PolarisGateSurface(
            status: model.licenseEnabled ? model.state.status : .notApplicable,
            allowedRange: model.state.allowedRange,
            isWorking: model.isWorking,
            lastError: model.lastError,
            manageURL: model.offeredManageURL,
            isLoading: !model.hasLoaded,
            resultSerial: model.resultSerial,
            onOpenManage: { manageOpened = true },
            renewURL: options.renewURL,
            onOpenRenew: { renewOpened = true },
            blockedAction: options.blockedAction,
            licenseKey: $licenseKey,
            theme: theme,
            onSignIn: model.identityEnabled ? { sheet = .signIn } : nil,
            onActivate: { key in Task { await model.activate(key: key) } },
            onRefresh: { Task { await model.refresh() } },
            onContinueFree: model.offersFreeTier ? { Task { await model.enroll() } } : nil,
            onActivateOffline: options.offersOfflineActivation ? { sheet = .offline } : nil,
            showsKeyEntry: showsKeyEntry,
            content: content
        )
        .modifier(PolarisPresentationDefault(model: model))
        .onChange(of: model.lastActivation) { _, _ in
            // A new result closes the round: a second refusal needs a second Replace tap.
            manageOpened = false
        }
        .onChange(of: scenePhase) { _, phase in
            // Back from the renewal page: check the licence again, once.
            if phase == .active, renewOpened {
                renewOpened = false
                Task { await model.refresh() }
            }
            // Only after the person opened Replace a device (never on a lock/unlock), and only
            // while the field still holds the refused key, retry it once, quietly.
            guard phase == .active, manageOpened, model.offeredManageURL != nil,
                let key = model.lastKey, key == licenseKey.trimmingCharacters(in: .whitespacesAndNewlines)
            else { return }
            manageOpened = false
            Task { await model.activate(key: key, showsWork: false) }
        }
        .sheet(item: $sheet) { which in
            Group {
                switch which {
                case .signIn:
                    PolarisSignIn(client: model.client, theme: theme) { _ in
                        sheet = nil
                        Task { await model.reload() }
                    }
                case .offline:
                    PolarisOfflineActivation(model: model, theme: theme) { sheet = nil }
                }
            }
            .polarisSheetFrame()
        }
    }
}
