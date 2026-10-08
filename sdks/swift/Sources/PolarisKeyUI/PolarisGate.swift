// `PolarisGate` — the drop-in gate over a `PolarisKeyModel` (notes/SDK-PARITY-PASS.md §3.18).
//
// Every `gate-matrix` status routes to its surface (the same surfaces as `PolarisLoginView`).
// What the model adds:
//
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
    private let showsKeyEntry: Bool
    private let offersOfflineActivation: Bool
    private let content: () -> Content

    @State private var licenseKey = ""
    @State private var sheet: GateSheet?

    enum GateSheet: String, Identifiable {
        case signIn, offline
        var id: String { rawValue }
    }

    public init(
        model: PolarisKeyModel, theme: PolarisTheme = PolarisTheme(), showsKeyEntry: Bool = true,
        offersOfflineActivation: Bool = true, @ViewBuilder content: @escaping () -> Content
    ) {
        self.model = model
        self.theme = theme
        self.showsKeyEntry = showsKeyEntry
        self.offersOfflineActivation = offersOfflineActivation
        self.content = content
    }

    public var body: some View {
        PolarisGateSurface(
            status: model.licenseEnabled ? model.state.status : .notApplicable,
            allowedRange: model.state.allowedRange,
            isWorking: model.isWorking,
            lastError: model.lastError,
            licenseKey: $licenseKey,
            theme: theme,
            onSignIn: model.identityEnabled ? { sheet = .signIn } : nil,
            onActivate: { key in Task { await model.activate(key: key) } },
            onRefresh: { Task { await model.refresh() } },
            onContinueFree: model.offersFreeTier ? { Task { await model.enroll() } } : nil,
            onActivateOffline: offersOfflineActivation ? { sheet = .offline } : nil,
            showsKeyEntry: showsKeyEntry,
            content: content
        )
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
