// @pkey-feature ui.settings ui.devices
// The settings drop-in (UI-KITS §4.2, DL2): `PolarisKeySettings(client)` is a `Section` set for a
// host's own `List` or `Form` (iOS) or a `Settings { }` scene (macOS). It wires AccountAndLicense
// (Manage ↗, Check now, automatic updates, the channel, version, Sign out), Devices (load,
// remove, rename in place) and the product's catalog Settings to one client. The panes inherit the
// host's font and look; every host-dependent row draws only when the host passed its handler.
//
//   Form { PolarisKeySettings(client, handlers: KitSettingsHandlers(manage: { open(portal) })) }

import PolarisKey
import PolarisKeyCore
import PolarisKeyUICore
import SwiftUI

public struct PolarisKeySettings: View {
    @State private var model: PolarisKeySettingsModel
    /// The gate's model when the pane sits inside `.polarisKeyGate`; else the pane builds its own.
    @Environment(PolarisKeyGateModel.self) private var gate: PolarisKeyGateModel?
    @State private var own: PolarisKeyGateModel?

    /// The pane for `client`. `handlers` names what the host can act on; `options` what the build
    /// knows (the store that fixes the channel, the running version).
    public init(
        _ client: PolarisKeyClient, handlers: KitSettingsHandlers = KitSettingsHandlers(),
        options: KitSettingsOptions = KitSettingsOptions()
    ) {
        _model = State(
            initialValue: PolarisKeySettingsModel(
                client: client, handlers: handlers, options: options))
        _own = State(initialValue: nil)
    }

    /// The pane over a model the host holds (previews, its own composition).
    public init(model: PolarisKeySettingsModel) {
        _model = State(initialValue: model)
        _own = State(initialValue: nil)
    }

    public var body: some View {
        Group {
            if let scopeModel = gate ?? own {
                PolarisKeyScope(model: scopeModel) { SettingsSections(model: model) }
            } else {
                // Outside the gate there is no theme scope yet: build one from the client.
                Color.clear.frame(height: 0)
                    .onAppear {
                        if let client = model.client {
                            let fallback = PolarisKeyGateModel(client: client)
                            fallback.start()
                            own = fallback
                        }
                    }
            }
        }
        .task { model.start() }
    }
}

/// The pane's sections, in the order of UI-KITS §4.3: the account, the devices, the catalog's
/// settings, then Sign out in its own group.
struct SettingsSections: View {
    @Bindable var model: PolarisKeySettingsModel
    @Environment(\.openURL) private var openURL
    @Environment(\.polarisKeyStrings) private var strings
    /// The gate's model when the pane sits inside `.polarisKeyGate`: the product's identity the Add screens name.
    @Environment(PolarisKeyGateModel.self) private var gate: PolarisKeyGateModel?

    var body: some View {
        panes
            // Add your name and email (or the manage QR on a TV) over the pane, until it is done.
            .sheet(
                isPresented: Binding(
                    get: { model.holders != nil }, set: { _ in })
            ) {
                if let flow = model.holders {
                    // The sheet inherits the pane's look and strings; Cancel and Done are its only ways out.
                    HolderFlowView(flow: flow)
                        #if !os(macOS)
                            .interactiveDismissDisabled()
                        #endif
                }
            }
            // "Approve a nearby device" opens over the pane and closes by any route as a Deny or a Done.
            .sheet(
                isPresented: Binding(
                    get: { model.nearbyApproval?.presented ?? false },
                    set: { shown in
                        if !shown, let approval = model.nearbyApproval { Task { await approval.close() } }
                    })
            ) {
                if let approval = model.nearbyApproval {
                    NearbyApprovalView(model: approval)
                }
            }
            // The pane's results reach VoiceOver as they land (DL7).
            .onChange(of: model.checkResult) { _, line in announce(line) }
            .onChange(of: model.deviceFailure) { _, line in announce(line) }
            .onChange(of: model.signOutError) { _, line in announce(line) }
    }

    private func announce(_ line: CopyLine?) {
        guard let line else { return }
        AccessibilityNotification.Announcement(strings.string(line)).post()
    }

    private func addTapped() {
        let scope = gate?.inputs
        let opener = openURL
        Task { @MainActor in
            let open = holderOpening(opener) { [model] in model.addOpenFailed() }
            await model.beginAdd(scope: scope, open: open)
        }
    }

    @ViewBuilder private var panes: some View {
        AccountAndLicenseSection(
            screen: model.account, tier: model.tier, holder: model.holder, version: model.version,
            devices: model.seats, autoUpdate: Binding(get: { model.autoUpdate }, set: { model.setAutoUpdate($0) }),
            onManage: { model.handlers.manage?() }, onSignOut: { Task { await model.signOut() } },
            onCheckNow: { Task { await model.checkNow() } }, canManage: model.canManage,
            canAutoUpdate: model.canSetAutoUpdate, channel: model.channel,
            onChannel: model.handlers.selectChannel == nil ? nil : { model.selectChannel($0) },
            checking: model.checking, checkNote: model.checkResult, checkFailed: model.checkFailed,
            part: .top,
            onApproveNearby: model.canApproveNearby && model.nearbyApproval != nil
                ? { model.nearbyApproval?.onOpen?() } : nil,
            onAdd: model.canAdd ? { addTapped() } : nil, addExternal: model.addOpensPortal,
            addProblem: model.addProblem)
        DevicesSection(
            screen: model.devicesScreen, devices: model.deviceRows,
            onRetry: { Task { await model.retryDevices() } },
            onManage: { model.handlers.manage?() },
            onRename: { device, name in
                if let index = model.deviceRows.firstIndex(of: device) {
                    Task { await model.renameDevice(at: index, to: name) }
                }
            },
            failure: model.deviceFailure, canManage: model.canManage)
        SettingsSection(
            screen: model.settingsScreen, rows: model.configRows,
            onChange: { key, value in Task { await model.setValue(key, value) } },
            options: model.selectOptions, onRetry: { Task { await model.retryConfig() } },
            onReset: { key in Task { await model.resetValue(key) } })
        AccountAndLicenseSection(
            screen: model.account, onManage: {}, onSignOut: { Task { await model.signOut() } },
            part: .bottom, signOutFailed: model.signOutFailed,
            onSignOutAnyway: { Task { await model.signOutAnyway() } },
            onSignOutRetry: { Task { await model.signOut() } },
            onDismissSignOutFailure: { model.dismissSignOutFailure() },
            signOutError: model.signOutError)
    }
}
