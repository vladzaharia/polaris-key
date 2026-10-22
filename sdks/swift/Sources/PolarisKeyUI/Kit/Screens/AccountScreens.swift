// @pkey-feature ui.settings ui.devices ui.paywall
// The panes that join the host (DL2): AccountAndLicense, Devices and Settings as SwiftUI `Section`
// sets the host drops into its own `Form` or `List` (they inherit the host's look), plus Paywall's
// browser hand-off and EntitlementGate. UI-KITS §4.3: inset grouped rows, the product row first,
// Manage with the external-link glyph, Sign out in its own group in danger text, provenance as
// text, locked rows as a value with a lock and "Set by <org>", never a dimmed switch.

import PolarisKeyUICore
import SwiftUI

/// A pane's text: the host's font (panes join the host, UI-KITS §2.1 `typography.family: "inherit"`),
/// in the kit's roles only for the colour.
struct PaneText: View {
    let line: CopyLine
    let role: KitTextRole
    let color: KitTextColor
    @Environment(\.polarisKeyStrings) private var strings

    init(_ line: CopyLine, _ role: KitTextRole = .body, color: KitTextColor = .default) {
        self.line = line
        self.role = role
        self.color = color
    }

    init(
        _ key: String, _ args: [String: CopyArgument] = [:], _ role: KitTextRole = .body,
        color: KitTextColor = .default
    ) {
        self.init(CopyLine(key, args), role, color: color)
    }

    var body: some View {
        kitStyle { style in
            Text(strings.string(line))
                .font(role == .footnote || role == .meta ? .footnote : .body)
                .foregroundStyle(
                    color == .default
                        ? AnyShapeStyle(.primary) : AnyShapeStyle(color.resolve(style.palette)))
        }
    }
}

/// A service glyph tile for a settings group header (UI-KITS §1.2 `serviceCues`): off by
/// default, never a fill, a status or a large surface; the service's own accent at 20 pt.
struct ServiceCue: View {
    let service: KitService
    /// The tile and its glyph grow with Dynamic Type, so a group header never holds a fixed-size
    /// glyph beside text that scales.
    @ScaledMetric(relativeTo: .footnote) private var tile: CGFloat = 20
    @ScaledMetric(relativeTo: .footnote) private var glyphSize: CGFloat = 11

    var body: some View {
        kitStyle { style in
            if style.serviceCues {
                let (glyph, ring, fill) = Self.look(service, dark: style.dark)
                Image(systemName: glyph)
                    .font(.system(size: glyphSize, weight: .semibold))
                    .foregroundStyle(ring.color)
                    .frame(width: tile, height: tile)
                    .background(
                        RoundedRectangle(cornerRadius: 5, style: .continuous).fill(fill.color)
                    )
                    .accessibilityHidden(true)
            }
        }
    }

    static func look(_ service: KitService, dark: Bool) -> (String, BrandColor, BrandColor) {
        switch service {
        case .update, .distribution, .release:
            return dark
                ? (
                    "arrow.down.circle", PolarisBrand.Dark.stateUpdateRing,
                    PolarisBrand.Dark.stateUpdateSelectedFill
                )
                : (
                    "arrow.down.circle", PolarisBrand.Light.stateUpdateRing,
                    PolarisBrand.Light.stateUpdateSelectedFill
                )
        case .sync:
            return dark
                ? (
                    "icloud", PolarisBrand.Dark.stateSyncRing,
                    PolarisBrand.Dark.stateSyncSelectedFill
                )
                : (
                    "icloud", PolarisBrand.Light.stateSyncRing,
                    PolarisBrand.Light.stateSyncSelectedFill
                )
        case .commerce:
            return dark
                ? (
                    "bag", PolarisBrand.Dark.stateDistributionRing,
                    PolarisBrand.Dark.stateDistributionSelectedFill
                )
                : (
                    "bag", PolarisBrand.Light.stateDistributionRing,
                    PolarisBrand.Light.stateDistributionSelectedFill
                )
        case .config:
            return dark
                ? (
                    "slider.horizontal.3", PolarisBrand.Dark.stateConfigRing,
                    PolarisBrand.Dark.stateConfigSelectedFill
                )
                : (
                    "slider.horizontal.3", PolarisBrand.Light.stateConfigRing,
                    PolarisBrand.Light.stateConfigSelectedFill
                )
        case .identity:
            return dark
                ? (
                    "person.crop.circle", PolarisBrand.Dark.stateIdentityRing,
                    PolarisBrand.Dark.stateIdentitySelectedFill
                )
                : (
                    "person.crop.circle", PolarisBrand.Light.stateIdentityRing,
                    PolarisBrand.Light.stateIdentitySelectedFill
                )
        case .license:
            return dark
                ? (
                    "key", PolarisBrand.Dark.stateLicenseRing,
                    PolarisBrand.Dark.stateLicenseSelectedFill
                )
                : (
                    "key", PolarisBrand.Light.stateLicenseRing,
                    PolarisBrand.Light.stateLicenseSelectedFill
                )
        }
    }
}

/// The settings pane's account and license, as sections.
public struct AccountAndLicenseSection: View {
    let screen: KitScreen<AccountState>
    var tier: String?
    var holder: String?
    var version: String?
    var devices: String?
    var onManage: () -> Void
    var onSignOut: () -> Void
    @Binding var autoUpdate: Bool
    var onCheckNow: () -> Void
    /// Manage ↗ and the automatic-update switch draw only when the host can act on them
    /// (UI-KITS decision 7). True keeps the pane's earlier behaviour for a host that passes both.
    var canManage = true
    var canAutoUpdate = true
    /// The ChannelPicker row, and the host's way to switch (nil: the row is a value or locked).
    var channel: KitChannelState = .hidden
    var onChannel: ((String) -> Void)?
    /// Check now in flight, and its one-line answer.
    var checking = false
    var checkNote: CopyLine?
    /// The check failed: its note is the failure line, with Try again under it.
    var checkFailed = false
    /// Which groups to draw: the whole pane, or the part above or below the Devices and Settings
    /// sections `PolarisKeySettings` puts between them.
    var part: Part = .all

    public enum Part: Sendable { case all, top, bottom }

    @State private var confirmingSignOut = false
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<AccountState>, tier: String? = nil, holder: String? = nil,
        version: String? = nil, devices: String? = nil, autoUpdate: Binding<Bool> = .constant(true),
        onManage: @escaping () -> Void, onSignOut: @escaping () -> Void,
        onCheckNow: @escaping () -> Void = {}, canManage: Bool = true, canAutoUpdate: Bool = true,
        channel: KitChannelState = .hidden, onChannel: ((String) -> Void)? = nil,
        checking: Bool = false, checkNote: CopyLine? = nil, checkFailed: Bool = false,
        part: Part = .all
    ) {
        self.checkFailed = checkFailed
        self.canManage = canManage
        self.canAutoUpdate = canAutoUpdate
        self.channel = channel
        self.onChannel = onChannel
        self.checking = checking
        self.checkNote = checkNote
        self.part = part
        self.screen = screen
        self.tier = tier
        self.holder = holder
        self.version = version
        self.devices = devices
        self._autoUpdate = autoUpdate
        self.onManage = onManage
        self.onSignOut = onSignOut
        self.onCheckNow = onCheckNow
    }

    public var body: some View {
        kitStyle { style in
            if part != .bottom { top(style) }
            if part != .top { bottom(style) }
        }
    }

    @ViewBuilder private func top(_ style: KitResolvedStyle) -> some View {
        Group {
            Section {
                HStack(spacing: style.space(.sm)) {
                    ProductIcon(size: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(style.identity.name)
                            .fontWeight(.medium)
                            .foregroundStyle(.primary)
                        if screen.shows("account.tier") {
                            PaneText(
                                CopyLine("account.tier", ["tier": .text(tier ?? "")]), .meta,
                                color: .muted)
                        }
                        if screen.shows("account.holder"), let holder {
                            PaneText(
                                CopyLine("account.holder", ["name": .text(holder)]), .meta,
                                color: .muted)
                        } else if screen.shows("account.keyOnly") {
                            PaneText(CopyLine("account.keyOnly"), .meta, color: .muted)
                        } else if screen.shows("account.offline") {
                            StatusPill(CopyLine("part.status.grace"), tone: .warning)
                            PaneText(CopyLine("account.offline"), .meta, color: .muted)
                        }
                    }
                }
                .padding(.vertical, 4)
                .frame(minHeight: 64)
                .accessibilityElement(children: .combine)
                if screen.shows("common.manage"), canManage {
                    Button(action: onManage) {
                        HStack {
                            PaneText(CopyLine("common.manage"), .body, color: .default)
                            Spacer()
                            Image(systemName: PolarisKitGlyph.newWindow)
                                .foregroundStyle(style.palette.textMuted)
                                .accessibilityLabel(strings.string("a11y.externalLink"))
                        }
                        .frame(minHeight: 52)
                    }
                    .tint(style.palette.accentFg)
                }
                if screen.shows("account.devices"), devices != nil {
                    LabeledContent {
                        Text(devices ?? "")
                    } label: {
                        PaneText(CopyLine("account.devices"), .body, color: .default)
                    }
                    .frame(minHeight: 52)
                }
                // Cloud Sync has no value and no destination here yet (CloudSyncStatus is the
                // second wave): no row, rather than a label that does nothing.
                if screen.state == .offline {
                    // Everything that needs no network stays; Try again is the way out.
                    if let version {
                        PaneText(
                            CopyLine("account.version", ["version": .text(version)]), .body,
                            color: .default
                        )
                        .frame(minHeight: 52, alignment: .leading)
                    }
                    Button(action: onCheckNow) {
                        HStack {
                            PaneText(CopyLine("common.tryAgain"), .body, color: .accent)
                            Spacer()
                            if checking {
                                ProgressView().accessibilityLabel(strings.string("a11y.busy"))
                            }
                        }
                        .frame(minHeight: 52, alignment: .leading)
                    }
                    .tint(style.palette.accentFg)
                    .disabled(checking)
                }
            }
            // A group header only over rows that render (never an empty "Updates").
            if screen.shows("account.updates"),
                (screen.shows("account.autoUpdate") && canAutoUpdate) || screen.shows("update.checkNow")
                    || channel != .hidden
                    || (version != nil && screen.shows("account.version"))
            {
                Section {
                    if screen.shows("account.autoUpdate"), canAutoUpdate {
                        Toggle(isOn: $autoUpdate) {
                            PaneText(CopyLine("account.autoUpdate"), .body, color: .default)
                        }
                        .tint(style.palette.accentSolid)
                        .frame(minHeight: 52)
                    }
                    if let version, screen.shows("account.version") {
                        PaneText(
                            CopyLine("account.version", ["version": .text(version)]), .body,
                            color: .default
                        )
                        .frame(minHeight: 52, alignment: .leading)
                    }
                    if screen.shows("account.channel") { channelRow(style) }
                    if screen.shows("update.checkNow") {
                        Button(action: onCheckNow) {
                            HStack {
                                PaneText(CopyLine("update.checkNow"), .body, color: .accent)
                                Spacer()
                                if checking {
                                    ProgressView()
                                        .accessibilityLabel(strings.string("a11y.busy"))
                                }
                            }
                            .frame(minHeight: 52, alignment: .leading)
                        }
                        .tint(style.palette.accentFg)
                        .disabled(checking)
                    }
                    if let checkNote {
                        PaneText(checkNote, .footnote, color: checkFailed ? .danger : .muted)
                            .frame(minHeight: 44, alignment: .leading)
                        if checkFailed {
                            Button(action: onCheckNow) {
                                PaneText(CopyLine("common.tryAgain"), .body, color: .accent)
                                    .frame(minHeight: 52, alignment: .leading)
                            }
                            .tint(style.palette.accentFg)
                            .disabled(checking)
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        ServiceCue(service: .update)
                        PaneText(CopyLine("account.updates"), .footnote, color: .muted)
                    }
                }
            }
        }
    }

    @ViewBuilder private func bottom(_ style: KitResolvedStyle) -> some View {
        Group {
            if screen.shows("common.signOut") {
                Section {
                    Button(role: .destructive) {
                        confirmingSignOut = true
                    } label: {
                        PaneText(CopyLine("common.signOut"), .body, color: .danger)
                            .frame(minHeight: 52, alignment: .leading)
                    }
                    .confirmationDialog(
                        strings.string("common.signOut"), isPresented: $confirmingSignOut,
                        titleVisibility: .hidden
                    ) {
                        Button(
                            strings.string("common.signOut"), role: .destructive, action: onSignOut)
                    }
                } footer: {
                    // The attribution is the pane's last item, a section footer (UI-KITS §1.6).
                    if screen.shows("part.poweredBy") { PoweredBy() }
                }
            } else if screen.shows("part.poweredBy") {
                Section {
                } footer: {
                    PoweredBy()
                }
            }
        }
    }

    /// The ChannelPicker (UI-KITS §4.1): a menu where the host can switch, else the channel as a
    /// value, with the lock and its reason when the store or the license fixes it.
    @ViewBuilder private func channelRow(_ style: KitResolvedStyle) -> some View {
        switch channel {
        case .hidden:
            EmptyView()
        case .value(let current):
            LabeledContent {
                Text(Self.channelName(current)).foregroundStyle(style.palette.textMuted)
            } label: {
                PaneText(CopyLine("account.channel"), .body, color: .default)
            }
            .frame(minHeight: 52)
        case .choose(let current, let options):
            Picker(
                selection: Binding(get: { current }, set: { onChannel?($0) })
            ) {
                ForEach(options, id: \.self) { Text(Self.channelName($0)).tag($0) }
            } label: {
                PaneText(CopyLine("account.channel"), .body, color: .default)
            }
            .pickerStyle(.menu)
            .tint(style.palette.accentSolid)
            .frame(minHeight: 52)
        case .locked(let current, let reason):
            LabeledContent {
                HStack(spacing: style.space(.xxs)) {
                    Image(systemName: "lock.fill").imageScale(.small)
                        .accessibilityLabel(strings.string("a11y.locked"))
                    Text(Self.channelName(current))
                }
                .foregroundStyle(style.palette.textMuted)
            } label: {
                VStack(alignment: .leading, spacing: style.space(.xxs)) {
                    PaneText(CopyLine("account.channel"), .body, color: .default)
                    PaneText(reason, .footnote, color: .muted)
                }
            }
            .frame(minHeight: 64)
        }
    }

    static func channelName(_ id: String) -> String {
        id.prefix(1).uppercased() + id.dropFirst()
    }
}

/// The license's devices as a section: rename inline, remove with a confirm (never a dead end).
public struct DevicesSection: View {
    let screen: KitScreen<DevicesState>
    let devices: [KitDevice]
    var onRemove: (KitDevice) -> Void
    var onRetry: () -> Void
    var onManage: () -> Void
    /// Rename in place; nil: the host cannot save a name, so no Rename is drawn.
    var onRename: ((KitDevice, String) -> Void)?
    /// A failed rename or remove, under the list (the list stays).
    var failure: CopyLine?
    /// Draws the browser-mode "Manage devices" link only when the host can open it.
    var canManage = true
    /// The device a Remove waits on, confirmed first (it signs that device out).
    @State private var removing: KitDevice?
    /// The device being renamed, and the name typed so far.
    @State private var renaming: KitDevice?
    @State private var draft = ""
    @FocusState private var focused: Bool
    /// The last rename sent, to reopen on a failure.
    @State private var lastRename: (KitDevice, String)?
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<DevicesState>, devices: [KitDevice],
        onRemove: @escaping (KitDevice) -> Void,
        onRetry: @escaping () -> Void, onManage: @escaping () -> Void = {},
        onRename: ((KitDevice, String) -> Void)? = nil, failure: CopyLine? = nil,
        canManage: Bool = true, renaming: KitDevice? = nil
    ) {
        self._renaming = State(initialValue: renaming)
        self._draft = State(initialValue: renaming?.name ?? "")
        self.onRename = onRename
        self.failure = failure
        self.canManage = canManage
        self.screen = screen
        self.devices = devices
        self.onRemove = onRemove
        self.onRetry = onRetry
        self.onManage = onManage
    }

    public var body: some View {
        kitStyle { style in
            Section {
                switch screen.state {
                case .loading:
                    LoadingIndicator(CopyLine("common.loading"))
                case .error:
                    if let line = screen.copy.first(where: { $0.key != "common.tryAgain" }) {
                        PaneText(line, .body, color: .default)
                    }
                    Button(strings.string("common.tryAgain"), action: onRetry)
                        .tint(style.palette.accentFg)
                        .frame(minHeight: 52, alignment: .leading)
                case .empty:
                    PaneText(CopyLine("devices.empty"), .body, color: .default)
                        .frame(minHeight: 52, alignment: .leading)
                case .browserMode:
                    // The sentence and the way there: never a dead end.
                    PaneText(CopyLine("devices.browser"), .body, color: .muted)
                    if screen.shows("devices.manage"), canManage {
                        Button(action: onManage) {
                            HStack {
                                PaneText(CopyLine("devices.manage"), .body, color: .accent)
                                Spacer()
                                Image(systemName: PolarisKitGlyph.newWindow)
                                    .foregroundStyle(style.palette.textMuted)
                                    .accessibilityLabel(strings.string("a11y.externalLink"))
                            }
                        }
                    }
                default:
                    ForEach(Array(devices.enumerated()), id: \.offset) { _, device in
                        if renaming == device {
                            renameRow(device, style)
                        } else {
                            row(device, style)
                        }
                    }
                }
                if let failure {
                    PaneText(failure, .footnote, color: .danger)
                }
            } header: {
                PaneText(CopyLine("devices.title"), .footnote, color: .muted)
            }
            .onChange(of: failure) { _, line in
                guard line?.key == "devices.renameFailed", let (device, typed) = lastRename else {
                    return
                }
                draft = typed
                renaming = device
                focused = true
            }
            .confirmationDialog(
                removing.map {
                    strings.string(
                        "devices.removeConfirm",
                        [
                            "device": .text($0.name ?? strings.string("devices.unnamed")),
                            "product": .text(style.identity.name),
                        ])
                } ?? "",
                isPresented: Binding(
                    get: { removing != nil }, set: { if !$0 { removing = nil } }),
                titleVisibility: .visible
            ) {
                Button(strings.string("devices.remove"), role: .destructive) {
                    if let device = removing { onRemove(device) }
                    removing = nil
                }
                Button(strings.string("common.cancel"), role: .cancel) { removing = nil }
            }
        }
    }

    private func name(_ device: KitDevice) -> String {
        device.name ?? strings.string("devices.unnamed")
    }

    @ViewBuilder private func row(_ device: KitDevice, _ style: KitResolvedStyle) -> some View {
        HStack(spacing: 0) {
            // The current device says so where "last used" would go, under its name.
            DeviceRow(
                name: device.name, formFactor: device.formFactor.rawValue,
                meta: device.current
                    ? strings.string(
                        "part.thisDeviceTitle", ["formFactor": .text(device.formFactor.rawValue)])
                    : strings.string(
                        "devices.meta",
                        [
                            "platform": .text(KitFormat.platformName(device.platform)),
                            "when": .text(KitFormat.daysAgo(device.lastSeenDays)),
                        ])
            )
            if onRename != nil || !device.current {
                // Rename and Remove are visible, not only a swipe or a long press away.
                Menu {
                    if onRename != nil {
                        Button(strings.string("devices.rename")) { beginRename(device) }
                    }
                    if !device.current {
                        Button(strings.string("devices.remove"), role: .destructive) {
                            removing = device
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 20))
                        .foregroundStyle(style.palette.textMuted)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(name(device))
            }
        }
        .frame(minHeight: 64)
        .swipeActions {
            if !device.current {
                Button(strings.string("devices.remove"), role: .destructive) { removing = device }
                    .tint(style.palette.danger)
                    .accessibilityLabel(
                        strings.string("a11y.removeDevice", ["device": .text(name(device))]))
            }
            if onRename != nil {
                Button(strings.string("devices.rename")) { beginRename(device) }
                    .tint(style.palette.accentSolid)
                    .accessibilityLabel(
                        strings.string("a11y.renameDevice", ["device": .text(name(device))]))
            }
        }
    }

    private func beginRename(_ device: KitDevice) {
        draft = device.name ?? ""
        renaming = device
        focused = true
    }

    /// The row as a field: Return or Save keeps the name, Cancel puts the old one back. The field
    /// is focused on begin, and a failed save brings it back with what was typed.
    @ViewBuilder private func renameRow(_ device: KitDevice, _ style: KitResolvedStyle)
        -> some View
    {
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            TextField(strings.string("devices.renameLabel"), text: $draft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused)
                .onSubmit { commitRename(device) }
                .frame(minHeight: 44)
            HStack {
                // The frame and the hit shape live inside the label: outside a borderless
                // button they pad the layout, not the tappable area.
                Button {
                    renaming = nil
                } label: {
                    Text(strings.string("common.cancel"))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                Spacer()
                Button {
                    commitRename(device)
                } label: {
                    Text(strings.string("common.save"))
                        .fontWeight(.semibold)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
            }
            .buttonStyle(.borderless)
            .tint(style.palette.accentFg)
        }
        .padding(.vertical, style.space(.xs))
        .frame(minHeight: 64)
        .onAppear { focused = true }
    }

    private func commitRename(_ device: KitDevice) {
        // Closed at once; a failed save reopens it with this name (EXPERIENCE §7.3: input
        // survives a failed save).
        lastRename = (device, draft)
        onRename?(device, draft)
        renaming = nil
    }
}

/// A text setting: its title is the visible label (the row reads "Display name  Mara"), the
/// field is at least 44 pt, and the value is kept when focus leaves it, not only on Return.
struct SettingsFieldRow: View {
    let title: String
    @Binding var text: String
    var commit: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        LabeledContent(title) {
            TextField("", text: $text)
                .multilineTextAlignment(.trailing)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(commit)
                .frame(minHeight: 44)
                .accessibilityLabel(title)
        }
        .frame(minHeight: 52)
        .onChange(of: focused) { _, now in if !now { commit() } }
    }
}

/// Catalog-driven settings as sections: typed controls (a switch for a boolean, a slider for a
/// bounded number, a stepper for an open one, text otherwise), provenance as group headers
/// ("From <Developer>", "Managed settings"), locked rows as a value with a lock and "Set by
/// <org>", never a dimmed switch (UI-KITS §4.3). Rows are at least 52 pt, 64 with a second line.
public struct SettingsSection: View {
    let screen: KitScreen<SettingsState>
    let rows: [KitConfigRow]
    var onChange: (String, KitConfigValue) -> Void
    /// A select row's choices, by key (the catalog's `enum`); a row without choices is read-only.
    var options: [String: [String]] = [:]
    var onRetry: (() -> Void)?
    /// Reset a changed row to its default; nil: no Reset is drawn.
    var onReset: ((String) -> Void)?
    @State private var edits: [String: KitConfigValue] = [:]
    /// What was reported per row, so a commit never repeats.
    @State private var log = KitCommitLog()
    @State private var query = ""
    @Environment(\.polarisKeyStrings) private var strings

    /// `onChange` reports an edit by the row's key; the host saves it (the kit never writes).
    public init(
        screen: KitScreen<SettingsState>, rows: [KitConfigRow],
        onChange: @escaping (String, KitConfigValue) -> Void = { _, _ in },
        options: [String: [String]] = [:], onRetry: (() -> Void)? = nil,
        onReset: ((String) -> Void)? = nil
    ) {
        self.options = options
        self.onRetry = onRetry
        self.onReset = onReset
        self.screen = screen
        self.rows = rows
        self.onChange = onChange
    }

    /// The groups, in order: what the person set, the developer's defaults, then the locked rows.
    enum Group: Equatable {
        case yours, developer, managed
    }

    static func group(_ row: KitConfigRow) -> Group {
        if row.locked { return .managed }
        return row.source == "default" ? .developer : .yours
    }

    /// The control a row gets (§4.3): a switch for a boolean, a slider for a bounded number, a
    /// stepper for an open one, text otherwise; a locked row is always text.
    enum Control: Equatable { case locked, toggle, slider, stepper, text, select, field }

    static func control(_ row: KitConfigRow, options: [String: [String]] = [:]) -> Control {
        if row.locked { return .locked }
        if row.type == "select", !(options[row.key] ?? []).isEmpty { return .select }
        if row.type == "string" { return .field }
        switch (row.type, row.value) {
        case ("boolean", .bool?): return .toggle
        case ("number", .number?):
            if let lo = row.min, let hi = row.max, hi > lo { return .slider }
            return .stepper
        default: return .text
        }
    }

    public var body: some View {
        kitStyle { style in
            if screen.state == .loading {
                Section { LoadingIndicator(CopyLine("common.loading")) } header: { head(.yours, style) }
            }
            if screen.state == .error {
                Section {
                    if let line = screen.copy.first { PaneText(line, .body, color: .danger) }
                    if let onRetry {
                        Button(strings.string("common.tryAgain"), action: onRetry)
                            .frame(minHeight: 52, alignment: .leading)
                    }
                } header: {
                    head(.yours, style)
                }
            }
            if screen.shows("settings.search"), !rows.isEmpty {
                Section {
                    TextField(strings.string("settings.search"), text: $query)
                        .frame(minHeight: 52)
                }
            }
            ForEach([Group.yours, .developer, .managed], id: \.self) { group in
                let members = rows.filter { Self.group($0) == group && matches($0) }
                if !members.isEmpty {
                    Section {
                        ForEach(members, id: \.key) { row in
                            // Reset to default is an action on the row (swipe, long press, and
                            // VoiceOver's actions), not a second row of loose accent text.
                            let canReset = row.source == "local" && !row.locked && onReset != nil
                            settingRow(row, style)
                                .swipeActions {
                                    if canReset {
                                        Button(strings.string("settings.reset")) { reset(row) }
                                            .tint(style.palette.accentSolid)
                                    }
                                }
                                .contextMenu {
                                    if canReset {
                                        Button(strings.string("settings.reset")) { reset(row) }
                                    }
                                }
                        }
                    } header: {
                        head(group, style)
                    } footer: {
                        // Saving, then Saved, once (the host saves; the kit only says so).
                        if group == .yours, screen.state == .saving, let line = screen.copy.first {
                            PaneText(line, .footnote, color: .muted)
                        }
                    }
                }
            }
        }
    }

    /// The person's own group has no header: it sits under the host's own "Settings" title, and
    /// the developer's and the managed groups say whose they are.
    @ViewBuilder private func head(_ group: Group, _ style: KitResolvedStyle) -> some View {
        if group != .yours {
            PaneText(header(group, style), .footnote, color: .muted)
        }
    }

    private func reset(_ row: KitConfigRow) {
        edits[row.key] = nil
        log.forget(row.key)
        onReset?(row.key)
    }

    /// Report an edit once: Return and leaving the field both land here, and the same value is
    /// never sent twice.
    private func commit(_ row: KitConfigRow) {
        guard log.shouldCommit(key: row.key, value: edits[row.key], rowValue: row.value),
            let value = edits[row.key]
        else { return }
        onChange(row.key, value)
    }

    private func matches(_ row: KitConfigRow) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty || title(row).localizedCaseInsensitiveContains(q)
    }

    private func header(_ group: Group, _ style: KitResolvedStyle) -> CopyLine {
        switch group {
        case .yours: return CopyLine("settings.title")
        case .developer:
            return CopyLine(
                "settings.fromDeveloper",
                ["developer": .text(style.identity.developer ?? style.identity.name)])
        case .managed: return CopyLine("account.managedSettings")
        }
    }

    private func current(_ row: KitConfigRow) -> KitConfigValue? { edits[row.key] ?? row.value }

    private func set(_ row: KitConfigRow, _ value: KitConfigValue) {
        edits[row.key] = value
        onChange(row.key, value)
    }

    private func title(_ row: KitConfigRow) -> String { row.label ?? Self.humanize(row.key) }

    @ViewBuilder private func settingRow(_ row: KitConfigRow, _ style: KitResolvedStyle)
        -> some View
    {
        if Self.control(row, options: options) == .locked {
            // A value as text with its lock and its source, never a dimmed control.
            LabeledContent {
                HStack(spacing: 4) {
                    Image(systemName: "lock.fill").font(.system(size: 14))
                        .accessibilityLabel(strings.string("a11y.locked"))
                    Text(value(row))
                }
                .foregroundStyle(style.palette.textMuted)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(row))
                    PaneText(
                        row.org.map { CopyLine("settings.setBy", ["org": .text($0)]) }
                            ?? CopyLine("settings.setByGuardian"), .footnote, color: .muted)
                }
            }
            .frame(minHeight: 64)
        } else if Self.control(row, options: options) == .select, case .string(let chosen)? = current(row),
            let choices = options[row.key]
        {
            Picker(
                selection: Binding(get: { chosen }, set: { set(row, .string($0)) })
            ) {
                ForEach(choices, id: \.self) { Text($0).tag($0) }
            } label: {
                Text(title(row))
            }
            .pickerStyle(.menu)
            .tint(style.palette.accentSolid)
            .frame(minHeight: 52)
        } else if Self.control(row, options: options) == .field {
            SettingsFieldRow(
                title: title(row),
                text: Binding(
                    get: { if case .string(let s)? = current(row) { return s } else { return "" } },
                    set: { edits[row.key] = .string($0) }),
                commit: { commit(row) })
        } else if Self.control(row, options: options) == .toggle, case .bool(let on)? = current(row) {
            Toggle(
                title(row),
                isOn: Binding(get: { on }, set: { set(row, .bool($0)) })
            )
            .tint(style.palette.accentSolid)
            .frame(minHeight: 52)
        } else if Self.control(row) != .text, case .number(let n)? = current(row) {
            if Self.control(row) == .slider, let lo = row.min, let hi = row.max {
                VStack(alignment: .leading, spacing: 2) {
                    LabeledContent(title(row)) {
                        Text(n.formatted()).foregroundStyle(style.palette.textMuted)
                            .monospacedDigit()
                    }
                    // The value shows as it moves; the host hears it once, on release.
                    Slider(
                        value: Binding(get: { n }, set: { edits[row.key] = .number($0.rounded()) }),
                        in: lo...hi,
                        onEditingChanged: { editing in if !editing { commit(row) } }
                    )
                    .tint(style.palette.accentSolid)
                    .accessibilityLabel(title(row))
                    .accessibilityValue(n.formatted())
                }
                .frame(minHeight: 64)
            } else {
                Stepper(
                    value: Binding(get: { n }, set: { set(row, .number($0)) }),
                    step: 1
                ) {
                    LabeledContent(title(row)) {
                        Text(n.formatted()).foregroundStyle(style.palette.textMuted)
                            .monospacedDigit()
                    }
                }
                .frame(minHeight: 52)
            }
        } else {
            LabeledContent(title(row)) {
                Text(value(row)).foregroundStyle(style.palette.textMuted)
            }
            .frame(minHeight: 52)
        }
    }

    /// A catalog row with no label: its last segment in words, never the raw dotted key (§4.3).
    static func humanize(_ key: String) -> String {
        let last = key.split(separator: ".").last.map(String.init) ?? key
        let words = last.replacingOccurrences(
            of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
        ).replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    private func value(_ row: KitConfigRow) -> String {
        switch current(row) {
        case .bool(let b)?: return strings.string(b ? "settings.on" : "settings.off")
        case .number(let n)?: return n.formatted()
        case .string(let s)?: return s
        case nil: return strings.string("settings.source.default")
        }
    }
}

/// The upsell without a store (UI-KITS §4.1 Paywall): what the tier adds, and the browser or a
/// code. StoreKit's own view is the Paywall on Apple when the product sells in-app (UK-25); the kit
/// never invents checkout.
public struct PaywallView: View {
    let screen: KitScreen<PaywallState>
    /// What the tier adds, as the product names it.
    var features: [String]
    var onPortal: () -> Void
    var onRedeem: () -> Void

    public init(
        screen: KitScreen<PaywallState>, features: [String] = [], onPortal: @escaping () -> Void,
        onRedeem: @escaping () -> Void
    ) {
        self.screen = screen
        self.features = features
        self.onPortal = onPortal
        self.onRedeem = onRedeem
    }

    public var body: some View {
        KitScreenScaffold(hero: true, header: false) {
            if let title = screen.line("paywall.title") {
                KitText(title, .title, color: .strong, alignment: .center)
                    .accessibilityAddTraits(.isHeader)
            }
        } content: {
            // Not available is a sentence, not a heading.
            if let sentence = screen.line("paywall.notAvailable") {
                KitText(sentence, .body, color: .default, alignment: .center)
            }
            if let includes = screen.line("paywall.includes"), includes.isComplete(),
                !features.isEmpty
            {
                kitStyle { style in
                    VStack(alignment: .leading, spacing: style.space(.xs)) {
                        KitText(includes, .label, color: .strong)
                        ForEach(features, id: \.self) { feature in
                            // An HStack, not a Label: a Label's title truncates in a narrow
                            // column ("Unlimited proj…" at AX5), this one wraps.
                            HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(style.palette.accentFg)
                                    .accessibilityHidden(true)
                                Text(feature)
                                    .font(style.font(.body))
                                    .foregroundStyle(style.palette.textDefault)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } actions: {
            KitActionStack {
                if screen.shows("paywall.portal") {
                    KitButton(
                        line: CopyLine("paywall.portal"), kind: .primary, glyph: PolarisKitGlyph.newWindow,
                        action: onPortal)
                }
                if screen.shows("paywall.redeem") {
                    KitButton(line: CopyLine("paywall.redeem"), kind: .secondary, action: onRedeem)
                }
            }
        }
    }
}

/// Renders `content` only while the entitlement holds; otherwise `locked`. A theme or style never
/// unlocks it: only the entitlement decides.
public struct EntitlementGate<Content: View, Locked: View>: View {
    let screen: KitScreen<EntitlementGateState>
    @ViewBuilder let content: () -> Content
    @ViewBuilder let locked: () -> Locked

    public init(
        screen: KitScreen<EntitlementGateState>, @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder locked: @escaping () -> Locked
    ) {
        self.screen = screen
        self.content = content
        self.locked = locked
    }

    public var body: some View {
        switch screen.state {
        case .entitled: content()
        case .loading: LoadingIndicator(CopyLine("common.loading"))
        default: locked()
        }
    }
}
