// @pkey-feature ui.settings ui.devices
// The macOS Settings pane (UI-KITS §4.2 "macOS", UK-08.4): `PolarisKeySettingsPane(client)` is one
// Settings tab, "Account", for a host's `Settings { }` scene. It is a grouped Form that hugs its
// content at about 650 pt and names the pane in the window title:
//
//   * the license header (icon, tier, holder, Manage ↗), Devices ("2 of 3 in use", opening an
//     in-pane list), Cloud Sync when the host passes its status, and the version with
//     Check for Updates…;
//   * the publisher's group (Update automatically, Release channel);
//   * Managed settings and the catalog's other rows (locked rows with their source);
//   * Sign Out…, alone at the bottom, behind a confirmation.
//
//   Settings { PolarisKeySettingsPane(client) }
//   .commands { PolarisKeyCommands(client) }
//
// A host with other tabs puts the pane in its `TabView`; `PolarisKeySettingsPane.tag` is the tab's
// tag, which Manage License… selects through `PolarisKeySettingsRoute`.

#if os(macOS)
    import AppKit
    import Observation
    import PolarisKey
    import PolarisKeyCore
    import PolarisKeyUICore
    import SwiftUI

    /// What the app menu asks of the Settings window. `PolarisKeyCommands`' Manage License… sets
    /// `selection` before it opens Settings; a host with its own `TabView` binds its selection to
    /// it (a host whose Settings holds only the pane needs nothing). Sign Out… and a Check for
    /// Updates… with no update window set `request`; the pane does it in its own window, where
    /// the confirmation and the answer have a place to be (no system alert, SIGN-IN.md D-80).
    @MainActor
    @Observable
    public final class PolarisKeySettingsRoute {
        public static let shared = PolarisKeySettingsRoute()

        public enum Request: Sendable, Equatable {
            /// Ask "Sign out of <product> on this device?" and sign out on a yes.
            case signOut
            /// Check now and say the answer under the version.
            case checkNow
        }

        /// The tag of the tab to show; nil when none was asked for.
        public var selection: String?
        /// A pending action for the Account pane; the pane clears it when it takes it.
        public var request: Request?
        public init() {}
    }

    public struct PolarisKeySettingsPane: View {
        /// The pane's tab tag (`PolarisKeySettingsRoute.selection` takes it).
        public static let tag = "polaris-key.account"

        @State private var model: PolarisKeySettingsModel
        @Environment(PolarisKeyGateModel.self) private var gate: PolarisKeyGateModel?
        @Environment(\.polarisKeyTheme) private var theme
        @Environment(\.locale) private var locale
        @State private var own: PolarisKeyGateModel?
        private let cloudSync: String?
        private let checkForUpdates: (@MainActor () -> Void)?

        /// The pane for `client`. `handlers` names what the host can act on (Manage, the automatic
        /// update switch, the channel choice); `cloudSync` is the Cloud Sync row's status ("Synced
        /// 2 min ago"), drawn only when the host passes it; `checkForUpdates` replaces
        /// `PolarisKeyUpdateHook.present` for this pane.
        public init(
            _ client: PolarisKeyClient, handlers: KitSettingsHandlers = KitSettingsHandlers(),
            options: KitSettingsOptions = KitSettingsOptions(), cloudSync: String? = nil,
            checkForUpdates: (@MainActor () -> Void)? = nil
        ) {
            _model = State(
                initialValue: PolarisKeySettingsModel(
                    client: client, handlers: handlers, options: options))
            self.cloudSync = cloudSync
            self.checkForUpdates = checkForUpdates
        }

        /// The pane over a model the host holds (previews, its own composition).
        public init(
            model: PolarisKeySettingsModel, cloudSync: String? = nil,
            checkForUpdates: (@MainActor () -> Void)? = nil
        ) {
            _model = State(initialValue: model)
            self.cloudSync = cloudSync
            self.checkForUpdates = checkForUpdates
        }

        public var body: some View {
            let strings = KitStrings(
                catalog: KitCopy.bundled.overriding(theme.copy),
                locale: theme.locale ?? locale.identifier)
            Group {
                if let scopeModel = gate ?? own {
                    PolarisKeyScope(model: scopeModel) {
                        AccountPane(model: model, cloudSync: cloudSync, checkForUpdates: checkForUpdates)
                    }
                } else if model.client != nil {
                    Color.clear.frame(width: 650, height: 0)
                        .onAppear {
                            if let client = model.client {
                                let fallback = PolarisKeyGateModel(client: client)
                                fallback.start()
                                own = fallback
                            }
                        }
                } else {
                    // A preview model has no client to scope from: the theme's own look.
                    AccountPane(model: model, cloudSync: cloudSync, checkForUpdates: checkForUpdates)
                        .modifier(PolarisKeyStyleScope(
                            inputs: model.inputs, icon: KitIconSource.image(theme: theme, presentation: nil)))
                        .environment(\.polarisKeyStrings, strings)
                }
            }
            .tabItem {
                Label(strings.string("menu.account"), systemImage: "person.crop.circle")
            }
            .tag(Self.tag)
            .task { model.start() }
        }
    }

    /// A Mac control for a Form: the system's 28 pt `.bordered` button at regular size (capsule and
    /// the accent under the Polaris look, the plain system one under `native`), never the 36 pt
    /// kit capsule.
    private struct PaneButton: View {
        let line: CopyLine
        let style: KitResolvedStyle
        var glyph: String?
        let action: () -> Void
        @Environment(\.polarisKeyStrings) private var strings

        var body: some View {
            Button(action: action) {
                HStack(spacing: style.space(.xxs)) {
                    Text(strings.string(line))
                    if let glyph { Image(systemName: glyph).accessibilityHidden(true) }
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(style.isNative ? .roundedRectangle : .capsule)
            .controlSize(.regular)
            .tint(style.isNative ? nil : style.palette.accentFg)
        }
    }

    /// The pane's two pages: the account, and the in-pane device list behind Devices.
    private enum AccountPage { case account, devices }

    private struct AccountPane: View {
        @Bindable var model: PolarisKeySettingsModel
        let cloudSync: String?
        let checkForUpdates: (@MainActor () -> Void)?
        @State private var page: AccountPage = .account
        @State private var confirmingSignOut = false
        @Environment(\.polarisKeyStrings) private var strings
        private let route = PolarisKeySettingsRoute.shared

        var body: some View {
            kitStyle { style in
                Group {
                    switch page {
                    case .account: account(style)
                    case .devices: devices(style)
                    }
                }
                .formStyle(.grouped)
                // Hug the content: the Settings window takes this height, not a default one.
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 650)
                .navigationTitle(strings.string(page == .account ? "menu.account" : "account.devices"))
                // Escape steps back from the device list, then closes the window like ⌘W.
                .onExitCommand {
                    if page == .devices {
                        page = .account
                    } else {
                        NSApp.keyWindow?.performClose(nil)
                    }
                }
                .task { take(route.request) }
                .onChange(of: route.request) { _, request in take(request) }
                .onChange(of: model.checkResult) { _, line in announce(line) }
                .onChange(of: model.deviceFailure) { _, line in announce(line) }
            }
        }

        /// An action the app menu asked for: it runs here, in the window that is now in front.
        private func take(_ request: PolarisKeySettingsRoute.Request?) {
            guard let request else { return }
            route.request = nil
            page = .account
            switch request {
            case .signOut: confirmingSignOut = true
            case .checkNow: Task { await model.checkNow() }
            }
        }

        private func announce(_ line: CopyLine?) {
            guard let line else { return }
            AccessibilityNotification.Announcement(strings.string(line)).post()
        }

        // MARK: Account page

        @ViewBuilder private func account(_ style: KitResolvedStyle) -> some View {
            Form {
                Section {
                    licenseHeader(style)
                    if let counts = model.seatCounts, model.devicesScreen.state != .browserMode {
                        Button {
                            page = .devices
                        } label: {
                            HStack {
                                PaneText(CopyLine("account.devices"), .body, color: .default)
                                Spacer()
                                Text(
                                    strings.string(
                                        "part.seatMeter.caption",
                                        ["used": .number(counts.used), "limit": .number(counts.limit)])
                                )
                                .foregroundStyle(style.palette.textMuted)
                                Image(systemName: "chevron.right")
                                    .imageScale(.small)
                                    .foregroundStyle(style.palette.textMuted)
                                    .accessibilityHidden(true)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        // Combined, not ignored: ignoring the children drops the button's press, and the
                        // audit then finds a button with no action.
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(
                            strings.string("account.devices") + ", "
                                + strings.string(
                                    "part.seatMeter.caption",
                                    ["used": .number(counts.used), "limit": .number(counts.limit)]))
                    }
                    if let cloudSync {
                        LabeledContent {
                            Text(cloudSync).foregroundStyle(style.palette.textMuted)
                        } label: {
                            PaneText(CopyLine("account.cloudSync"), .body, color: .default)
                        }
                    }
                    versionRow(style)
                }
                publisherGroup(style)
                SettingsSection(
                    screen: model.settingsScreen, rows: model.configRows,
                    onChange: { key, value in Task { await model.setValue(key, value) } },
                    options: model.selectOptions, onRetry: { Task { await model.retryConfig() } },
                    onReset: { key in Task { await model.resetValue(key) } })
                if model.account.shows("common.signOut") {
                    // No box of its own: the bare button, as the mockup has it.
                    Section {
                    } footer: {
                        PaneButton(line: CopyLine("menu.signOut"), style: style) {
                            confirmingSignOut = true
                        }
                    }
                    .confirmationDialog(
                        SignOutCopy.title(strings, product: style.identity.name),
                        isPresented: $confirmingSignOut, titleVisibility: .visible
                    ) {
                        Button(strings.string("signin.signout.confirm"), role: .destructive) {
                            Task { await model.signOut() }
                        }
                        Button(strings.string("common.cancel"), role: .cancel) {}
                    } message: {
                        Text(SignOutCopy.message(strings, product: style.identity.name, tier: model.tier))
                    }
                }
            }
        }

        @ViewBuilder private func licenseHeader(_ style: KitResolvedStyle) -> some View {
            HStack(spacing: style.space(.sm)) {
                ProductIcon(size: 40)
                VStack(alignment: .leading, spacing: style.space(.xxs)) {
                    // The window's own header: the tier, then who, not the product name again.
                    if model.account.shows("account.tier") {
                        PaneText(
                            CopyLine("account.tier", ["tier": .text(model.tier ?? "")]), .body,
                            color: .default)
                        .fontWeight(.medium)
                    }
                    if model.account.shows("account.holder"), let holder = model.holder {
                        PaneText(
                            CopyLine("account.holder", ["name": .text(holder)]), .meta, color: .muted)
                    } else if model.account.shows("account.keyOnly") {
                        PaneText(CopyLine("account.keyOnly"), .meta, color: .muted)
                    } else if model.account.shows("account.offline") {
                        PaneText(CopyLine("account.offline"), .meta, color: .muted)
                    }
                }
                .accessibilityElement(children: .combine)
                Spacer()
                if model.account.shows("common.manage"), model.canManage {
                    PaneButton(
                        line: CopyLine("common.manage"), style: style, glyph: PolarisKitGlyph.newWindow
                    ) { model.handlers.manage?() }
                }
            }
            .padding(.vertical, style.space(.xxs))
        }

        @ViewBuilder private func versionRow(_ style: KitResolvedStyle) -> some View {
            if model.account.shows("update.checkNow") || model.version != nil {
                HStack {
                    VStack(alignment: .leading, spacing: style.space(.xxs)) {
                        if let version = model.version {
                            PaneText(
                                CopyLine("account.version", ["version": .text(version)]), .body,
                                color: .default)
                        }
                        if let note = model.checkResult {
                            PaneText(note, .footnote, color: model.checkFailed ? .danger : .muted)
                        }
                    }
                    Spacer()
                    if model.checking {
                        ProgressView().controlSize(.small)
                            .accessibilityLabel(strings.string("a11y.busy"))
                    }
                    if model.account.shows("update.checkNow") {
                        PaneButton(line: CopyLine("update.checkNow"), style: style) { check() }
                    }
                }
            }
        }

        /// Check for Updates…: the host's handler, else the update window's seam, else Check now
        /// on the client with its one-line answer under the version.
        private func check() {
            if let handler = checkForUpdates ?? PolarisKeyUpdateHook.present {
                handler()
            } else {
                Task { await model.checkNow() }
            }
        }

        /// "From <Developer>": what the publisher lets the person set about updates.
        @ViewBuilder private func publisherGroup(_ style: KitResolvedStyle) -> some View {
            let showsAuto = model.account.shows("account.autoUpdate") && model.canSetAutoUpdate
            let showsChannel = model.account.shows("account.channel") && model.channel != .hidden
            if showsAuto || showsChannel {
                Section {
                    if showsAuto {
                        Toggle(isOn: Binding(get: { model.autoUpdate }, set: { model.setAutoUpdate($0) })) {
                            PaneText(CopyLine("account.autoUpdate"), .body, color: .default)
                        }
                        .tint(style.palette.accentSolid)
                    }
                    if showsChannel { channelRow(style) }
                } header: {
                    if let developer = style.identity.developer ?? model.developerName {
                        PaneText(
                            CopyLine("settings.fromDeveloper", ["developer": .text(developer)]),
                            .footnote, color: .muted)
                    } else {
                        PaneText(CopyLine("account.updates"), .footnote, color: .muted)
                    }
                }
            }
        }

        @ViewBuilder private func channelRow(_ style: KitResolvedStyle) -> some View {
            switch model.channel {
            case .hidden:
                EmptyView()
            case .value(let current):
                LabeledContent {
                    Text(AccountAndLicenseSection.channelName(current))
                        .foregroundStyle(style.palette.textMuted)
                } label: {
                    PaneText(CopyLine("account.channel"), .body, color: .default)
                }
            case .choose(let current, let options):
                // A Button that opens a popover, not a Picker or a Menu: the audit finds no press
                // action on either one's pop-up button, and a Button has one. The accessibility
                // label names the setting and the value announces the current channel.
                LabeledContent {
                    ChannelChooser(
                        current: current, options: options, style: style,
                        label: strings.string("account.channel"),
                        select: { model.selectChannel($0) })
                } label: {
                    PaneText(CopyLine("account.channel"), .body, color: .default)
                }
            case .locked(let current, let reason):
                LabeledContent {
                    HStack(spacing: style.space(.xxs)) {
                        Image(systemName: "lock.fill").imageScale(.small)
                            .accessibilityLabel(strings.string("a11y.locked"))
                        Text(AccountAndLicenseSection.channelName(current))
                    }
                    .foregroundStyle(style.palette.textMuted)
                } label: {
                    VStack(alignment: .leading, spacing: style.space(.xxs)) {
                        PaneText(CopyLine("account.channel"), .body, color: .default)
                        PaneText(reason, .footnote, color: .muted)
                    }
                }
            }
        }

        // MARK: Device list page

        @ViewBuilder private func devices(_ style: KitResolvedStyle) -> some View {
            Form {
                Section {
                    Button {
                        page = .account
                    } label: {
                        Label {
                            Text(strings.string("menu.account"))
                        } icon: {
                            Image(systemName: "chevron.left")
                        }
                    }
                    .buttonStyle(.link)
                    .tint(style.palette.accentFg)
                    .accessibilityLabel(strings.string("common.back"))
                }
                DevicesSection(
                    screen: model.devicesScreen, devices: model.deviceRows,
                    onRemove: { device in
                        if let index = model.deviceRows.firstIndex(of: device) {
                            Task { await model.removeDevice(at: index) }
                        }
                    },
                    onRetry: { Task { await model.retryDevices() } },
                    onManage: { model.handlers.manage?() },
                    onRename: { device, name in
                        if let index = model.deviceRows.firstIndex(of: device) {
                            Task { await model.renameDevice(at: index, to: name) }
                        }
                    },
                    failure: model.deviceFailure, canManage: model.canManage)
            }
        }
    }

    /// The sign-out confirmation's words (SIGN-IN.md §4.9), shared by the pane's dialog and the
    /// app menu's alert. The Swift SDK has no Cloud Sync yet, so the unsynced-changes line and
    /// Wait for Sync wait for it.
    enum SignOutCopy {
        static func title(_ strings: KitStrings, product: String) -> String {
            strings.string("signin.signout.titleMac", ["product": .text(product)])
        }

        static func message(_ strings: KitStrings, product _: String, tier: String?) -> String {
            strings.string("signin.signout.releasedMac", ["tier": .text(tier ?? "")])
        }
    }

    /// The release-channel control of the Settings pane: a pop-up button (press, or Space from the
    /// keyboard) listing the channels; the current one is ticked.
    private struct ChannelChooser: View {
        let current: String
        let options: [String]
        let style: KitResolvedStyle
        let label: String
        let select: (String) -> Void
        @State private var open = false

        var body: some View {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: style.space(.xxs)) {
                    Text(AccountAndLicenseSection.channelName(current))
                    Image(systemName: "chevron.up.chevron.down").imageScale(.small)
                        .accessibilityHidden(true)
                }
                .foregroundStyle(style.palette.textStrong)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(label)
            .accessibilityValue(AccountAndLicenseSection.channelName(current))
            .popover(isPresented: $open, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(options, id: \.self) { option in
                        Button {
                            select(option)
                            open = false
                        } label: {
                            HStack(spacing: style.space(.xs)) {
                                Image(systemName: "checkmark").opacity(option == current ? 1 : 0)
                                    .accessibilityHidden(true)
                                Text(AccountAndLicenseSection.channelName(option))
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, style.space(.xs))
                            .padding(.horizontal, style.space(.sm))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(option == current ? .isSelected : [])
                    }
                }
                .padding(.vertical, style.space(.xxs))
                .frame(minWidth: 160)
            }
        }
    }
#endif
