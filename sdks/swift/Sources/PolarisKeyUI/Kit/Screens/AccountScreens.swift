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

    var body: some View {
        kitStyle { style in
            if style.serviceCues {
                let (glyph, ring, fill) = Self.look(service, dark: style.dark)
                Image(systemName: glyph)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ring.color)
                    .frame(width: 20, height: 20)
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

    @State private var confirmingSignOut = false
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<AccountState>, tier: String? = nil, holder: String? = nil,
        version: String? = nil, devices: String? = nil, autoUpdate: Binding<Bool> = .constant(true),
        onManage: @escaping () -> Void, onSignOut: @escaping () -> Void,
        onCheckNow: @escaping () -> Void = {}
    ) {
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
                        }
                    }
                }
                .padding(.vertical, 4)
                .frame(minHeight: 64)
                .accessibilityElement(children: .combine)
                if screen.shows("common.manage") {
                    Button(action: onManage) {
                        HStack {
                            PaneText(CopyLine("common.manage"), .body, color: .default)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundStyle(style.palette.textMuted)
                                .accessibilityLabel(strings.string("a11y.externalLink"))
                        }
                        .frame(minHeight: 52)
                    }
                }
                if screen.shows("account.devices") {
                    LabeledContent {
                        Text(devices ?? "")
                    } label: {
                        PaneText(CopyLine("account.devices"), .body, color: .default)
                    }
                    .frame(minHeight: 52)
                }
                if screen.shows("account.cloudSync") {
                    PaneText(CopyLine("account.cloudSync"), .body, color: .default)
                        .frame(minHeight: 52, alignment: .leading)
                }
            }
            // A group header only over rows that render (never an empty "Updates").
            if screen.shows("account.updates"),
                screen.shows("account.autoUpdate") || screen.shows("update.checkNow")
                    || (version != nil && screen.shows("account.version"))
            {
                Section {
                    if screen.shows("account.autoUpdate") {
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
                    if screen.shows("update.checkNow") {
                        Button(action: onCheckNow) {
                            PaneText(CopyLine("update.checkNow"), .body, color: .accent)
                                .frame(minHeight: 52, alignment: .leading)
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        ServiceCue(service: .update)
                        PaneText(CopyLine("account.updates"), .footnote, color: .muted)
                    }
                }
            }
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
}

/// The license's devices as a section: rename inline, remove with a confirm (never a dead end).
public struct DevicesSection: View {
    let screen: KitScreen<DevicesState>
    let devices: [KitDevice]
    var onRemove: (KitDevice) -> Void
    var onRetry: () -> Void
    var onManage: () -> Void
    /// The device a Remove waits on, confirmed first (it signs that device out).
    @State private var removing: KitDevice?
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<DevicesState>, devices: [KitDevice],
        onRemove: @escaping (KitDevice) -> Void,
        onRetry: @escaping () -> Void, onManage: @escaping () -> Void = {}
    ) {
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
                        .frame(minHeight: 52, alignment: .leading)
                case .empty:
                    PaneText(CopyLine("devices.empty"), .body, color: .default)
                        .frame(minHeight: 52, alignment: .leading)
                case .browserMode:
                    // The sentence and the way there: never a dead end.
                    PaneText(CopyLine("devices.browser"), .body, color: .muted)
                    if screen.shows("devices.manage") {
                        Button(action: onManage) {
                            HStack {
                                PaneText(CopyLine("devices.manage"), .body, color: .accent)
                                Spacer()
                                Image(systemName: "arrow.up.right")
                                    .foregroundStyle(style.palette.textMuted)
                                    .accessibilityLabel(strings.string("a11y.externalLink"))
                            }
                        }
                    }
                default:
                    ForEach(Array(devices.enumerated()), id: \.offset) { _, device in
                        DeviceRow(
                            name: device.name, formFactor: device.formFactor.rawValue,
                            meta: strings.string(
                                "devices.meta",
                                [
                                    "platform": .text(KitFormat.platformName(device.platform)),
                                    "when": .text(KitFormat.daysAgo(device.lastSeenDays)),
                                ])
                        )
                        .swipeActions {
                            Button(strings.string("devices.remove"), role: .destructive) {
                                removing = device
                            }
                        }
                    }
                }
            } header: {
                PaneText(CopyLine("devices.title"), .footnote, color: .muted)
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
}

/// Catalog-driven settings as sections: typed controls (a switch for a boolean, a slider for a
/// bounded number, a stepper for an open one, text otherwise), provenance as group headers
/// ("From <Developer>", "Managed settings"), locked rows as a value with a lock and "Set by
/// <org>", never a dimmed switch (UI-KITS §4.3). Rows are at least 52 pt, 64 with a second line.
public struct SettingsSection: View {
    let screen: KitScreen<SettingsState>
    let rows: [KitConfigRow]
    var onChange: (String, KitConfigValue) -> Void
    @State private var edits: [String: KitConfigValue] = [:]
    @Environment(\.polarisKeyStrings) private var strings

    /// `onChange` reports an edit by the row's key; the host saves it (the kit never writes).
    public init(
        screen: KitScreen<SettingsState>, rows: [KitConfigRow],
        onChange: @escaping (String, KitConfigValue) -> Void = { _, _ in }
    ) {
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
    enum Control: Equatable { case locked, toggle, slider, stepper, text }

    static func control(_ row: KitConfigRow) -> Control {
        if row.locked { return .locked }
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
            ForEach([Group.yours, .developer, .managed], id: \.self) { group in
                let members = rows.filter { Self.group($0) == group }
                if !members.isEmpty {
                    Section {
                        ForEach(members, id: \.key) { row in
                            settingRow(row, style)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            if group == .yours { ServiceCue(service: .config) }
                            PaneText(header(group, style), .footnote, color: .muted)
                        }
                    }
                }
            }
        }
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
        if Self.control(row) == .locked {
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
        } else if Self.control(row) == .toggle, case .bool(let on)? = current(row) {
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
                    Slider(
                        value: Binding(get: { n }, set: { set(row, .number($0.rounded())) }),
                        in: lo...hi
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
                        line: CopyLine("paywall.portal"), kind: .primary, glyph: "arrow.up.right",
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
