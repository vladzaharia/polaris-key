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
                .font(role == .footnote || role == .meta ? .footnote : nil)
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
                    }
                }
                if screen.shows("account.devices") {
                    LabeledContent {
                        Text(devices ?? "")
                    } label: {
                        PaneText(CopyLine("account.devices"), .body, color: .default)
                    }
                }
                if screen.shows("account.cloudSync") {
                    PaneText(CopyLine("account.cloudSync"), .body, color: .default)
                }
            }
            if screen.shows("account.updates") {
                Section {
                    if screen.shows("account.autoUpdate") {
                        Toggle(isOn: $autoUpdate) {
                            PaneText(CopyLine("account.autoUpdate"), .body, color: .default)
                        }
                        .tint(style.palette.accentSolid)
                    }
                    if let version, screen.shows("account.version") {
                        PaneText(
                            CopyLine("account.version", ["version": .text(version)]), .body,
                            color: .default)
                    }
                    if screen.shows("update.checkNow") {
                        Button(action: onCheckNow) {
                            PaneText(CopyLine("update.checkNow"), .body, color: .accent)
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
                    }
                    .confirmationDialog(
                        strings.string("common.signOut"), isPresented: $confirmingSignOut,
                        titleVisibility: .hidden
                    ) {
                        Button(
                            strings.string("common.signOut"), role: .destructive, action: onSignOut)
                    }
                }
            }
            if screen.shows("part.poweredBy") {
                Section { PoweredBy() }
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
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<DevicesState>, devices: [KitDevice],
        onRemove: @escaping (KitDevice) -> Void,
        onRetry: @escaping () -> Void
    ) {
        self.screen = screen
        self.devices = devices
        self.onRemove = onRemove
        self.onRetry = onRetry
    }

    public var body: some View {
        Section {
            switch screen.state {
            case .loading:
                LoadingIndicator(CopyLine("common.loading"))
            case .error:
                if let line = screen.copy.first(where: { $0.key != "common.tryAgain" }) {
                    PaneText(line, .body, color: .default)
                }
                Button(strings.string("common.tryAgain"), action: onRetry)
            case .empty:
                PaneText(CopyLine("devices.empty"), .body, color: .default)
            case .browserMode:
                PaneText(CopyLine("devices.browser"), .body, color: .default)
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
                            onRemove(device)
                        }
                    }
                }
            }
        } header: {
            PaneText(CopyLine("devices.title"), .footnote, color: .muted)
        }
    }
}

/// Catalog-driven settings as a section: typed controls, provenance as text, locked rows as text.
public struct SettingsSection: View {
    let screen: KitScreen<SettingsState>
    let rows: [KitConfigRow]
    @Environment(\.polarisKeyStrings) private var strings

    public init(screen: KitScreen<SettingsState>, rows: [KitConfigRow]) {
        self.screen = screen
        self.rows = rows
    }

    public var body: some View {
        kitStyle { style in
            Section {
                ForEach(rows, id: \.key) { row in
                    LabeledContent {
                        if row.locked {
                            HStack(spacing: 4) {
                                Image(systemName: "lock.fill").font(.system(size: 14))
                                    .accessibilityLabel(strings.string("a11y.locked"))
                                Text(value(row))
                            }
                            .foregroundStyle(style.palette.textMuted)
                        } else {
                            Text(value(row)).foregroundStyle(style.palette.textMuted)
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label ?? Self.humanize(row.key))
                            if row.locked {
                                PaneText(
                                    row.org.map { CopyLine("settings.setBy", ["org": .text($0)]) }
                                        ?? CopyLine("settings.setByGuardian"), .footnote,
                                    color: .muted)
                            }
                        }
                    }
                }
            } header: {
                HStack(spacing: 6) {
                    ServiceCue(service: .config)
                    PaneText(CopyLine("settings.title"), .footnote, color: .muted)
                }
            }
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
        switch row.value {
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
    var onPortal: () -> Void
    var onRedeem: () -> Void

    public init(
        screen: KitScreen<PaywallState>, onPortal: @escaping () -> Void,
        onRedeem: @escaping () -> Void
    ) {
        self.screen = screen
        self.onPortal = onPortal
        self.onRedeem = onRedeem
    }

    public var body: some View {
        KitScreenScaffold(hero: true, header: false) {
            if let title = screen.line("paywall.title") ?? screen.line("paywall.notAvailable") {
                KitText(title, .title, color: .strong, alignment: .center)
                    .accessibilityAddTraits(.isHeader)
            }
        } content: {
            if let includes = screen.line("paywall.includes") {
                KitText(includes, .body, color: .default, alignment: .center)
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
