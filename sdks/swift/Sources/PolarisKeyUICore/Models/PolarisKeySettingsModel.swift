// @pkey-feature ui.settings ui.devices
// The live headless model behind `PolarisKeySettings(client)` (UI-KITS §4.1 AccountAndLicense,
// Devices, Settings, ChannelPicker): an @Observable view of a PolarisKeyClient as the inputs the
// pane's screens are drawn from, with the actions each row needs (check now, remove and rename a
// device, change a catalog value, sign out). A host with its own UI binds to the same properties.
//
// Host-dependent actions follow the gate's pattern (decision 7, `KitGateHandlers`): Manage, the
// automatic-update switch and the channel choice draw only when the host passes a handler for them.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense

/// What the host can act on in the settings pane; a row for a nil handler is not drawn.
public struct KitSettingsHandlers {
    /// Manage ↗: open the portal (the host knows its URL and how to open it).
    public var manage: (@MainActor () -> Void)?
    /// The automatic-update switch changed (the host's updater owns the setting).
    public var autoUpdate: (@MainActor (Bool) -> Void)?
    /// The person chose another release channel (the host rebuilds its client with it).
    public var selectChannel: (@MainActor (String) -> Void)?
    /// Sign out finished (the gate shows Welcome by itself; this is for a host with more to do).
    public var signedOut: (@MainActor () -> Void)?

    public init(
        manage: (@MainActor () -> Void)? = nil, autoUpdate: (@MainActor (Bool) -> Void)? = nil,
        selectChannel: (@MainActor (String) -> Void)? = nil,
        signedOut: (@MainActor () -> Void)? = nil
    ) {
        self.manage = manage
        self.autoUpdate = autoUpdate
        self.selectChannel = selectChannel
        self.signedOut = signedOut
    }

    /// Whether the host passed any handler.
    public var isEmpty: Bool {
        manage == nil && autoUpdate == nil && selectChannel == nil && signedOut == nil
    }
}

/// What the build knows that the client does not.
public struct KitSettingsOptions: Sendable, Equatable {
    /// The store that fixes the release channel ("App Store"), or nil when the install does not.
    public var store: String?
    /// The automatic-update switch's starting position.
    public var autoUpdate: Bool
    /// The running version; nil reads the app bundle's.
    public var version: String?

    public init(store: String? = nil, autoUpdate: Bool = true, version: String? = nil) {
        self.store = store
        self.autoUpdate = autoUpdate
        self.version = version
    }
}

/// The ChannelPicker row (UI-KITS §4.1): a choice, or the current channel locked with its reason.
public enum KitChannelState: Sendable, Equatable {
    /// No channel to show (the license is unknown).
    case hidden
    /// The channel as a value; the host cannot act on a switch.
    case value(String)
    case choose(current: String, options: [String])
    /// The channel cannot change, and why (the store, or the license).
    case locked(current: String, reason: CopyLine)

    /// The row for a channel: the outlet fixes it, else the license decides what can be chosen.
    public static func resolve(
        current: String, entitled: [String]?, store: String?, canSelect: Bool
    ) -> KitChannelState {
        if let store, !store.isEmpty {
            return .locked(current: current, reason: CopyLine("channel.locked", ["store": .text(store)]))
        }
        guard let entitled else { return .hidden }
        var options = entitled
        if !options.contains(current) { options.insert(current, at: 0) }
        if options.count < 2 {
            return .locked(current: current, reason: CopyLine("channel.lockedLicense"))
        }
        return canSelect ? .choose(current: current, options: options) : .value(current)
    }
}

@MainActor
@Observable
public final class PolarisKeySettingsModel {
    /// The client, or nil for a preview model.
    public let client: PolarisKeyClient?
    public var handlers: KitSettingsHandlers
    public var options: KitSettingsOptions

    /// What the screens are drawn from.
    public private(set) var inputs: KitInputs
    /// The tier's display name and the holder's name, when known.
    public private(set) var tier: String?
    public private(set) var holder: String?
    public private(set) var channel: KitChannelState = .hidden
    /// The seat count against the limit, "2 of 3", only when the roster says so.
    public private(set) var seats: String?
    /// The roster ids, aligned with the device rows.
    public private(set) var deviceIds: [String] = []
    /// A failed rename or remove, shown under the list (the list stays).
    public private(set) var deviceFailure: CopyLine?
    /// The select options of a catalog row, by key.
    public private(set) var selectOptions: [String: [String]] = [:]
    /// The automatic-update switch (the host's updater owns it; see `handlers.autoUpdate`).
    public var autoUpdate: Bool
    /// Check now in flight, and its answer: "You're up to date", or nothing when an offer arrived.
    public private(set) var checking = false
    public private(set) var checkResult: CopyLine?
    public private(set) var hasLoaded = false

    private var servicesOn: Set<KitService>?
    private var licensed: LicenseState?
    private var devices: [KitDevice] = []
    private var rows: [KitConfigRow] = []
    private var devicesLoaded = false
    private var devicesFailed = false
    private var configLoaded = false
    private var configFailed = false
    private var saving = false
    private var saved = false
    private var saveFailed = false
    private var accountSignedIn = false
    private var developer: String?
    private var offered = false
    private var observation: Task<Void, Never>?

    /// A live model over `client`.
    public init(
        client: PolarisKeyClient, handlers: KitSettingsHandlers = KitSettingsHandlers(),
        options: KitSettingsOptions = KitSettingsOptions(), platform: KitPlatform = .current
    ) {
        self.client = client
        self.handlers = handlers
        self.options = options
        self.autoUpdate = options.autoUpdate
        self.inputs = KitInputs(
            bundle: KitBundle(slug: client.product), platform: platform)
    }

    /// A still model for previews and snapshot tests: it shows what it is given and reaches no network.
    public init(
        preview inputs: KitInputs, tier: String? = nil, holder: String? = nil,
        channel: KitChannelState = .hidden, seats: String? = nil,
        handlers: KitSettingsHandlers = KitSettingsHandlers(),
        options: KitSettingsOptions = KitSettingsOptions(),
        deviceFailure: CopyLine? = nil, selectOptions: [String: [String]] = [:]
    ) {
        self.client = nil
        self.handlers = handlers
        self.options = options
        self.autoUpdate = options.autoUpdate
        self.inputs = inputs
        self.tier = tier
        self.holder = holder
        self.channel = channel
        self.seats = seats
        self.deviceFailure = deviceFailure
        self.selectOptions = selectOptions
        self.devices = inputs.devices ?? []
        self.deviceIds = (inputs.devices ?? []).indices.map { "preview-\($0)" }
        self.hasLoaded = true
    }

    // MARK: Screens

    public var account: KitScreen<AccountState> { KitStates.accountAndLicense(accountInputs) }
    public var devicesScreen: KitScreen<DevicesState> { KitStates.devices(devicesInputs) }
    public var settingsScreen: KitScreen<SettingsState> { KitStates.settings(settingsInputs) }
    /// The devices the roster holds, for the list (rows align with the ids).
    public var deviceRows: [KitDevice] { client == nil ? (inputs.devices ?? []) : devices }
    /// The catalog rows.
    public var configRows: [KitConfigRow] { client == nil ? (inputs.config ?? []) : rows }
    public var version: String? { options.version ?? KitUpdateFacts.bundleVersion() }
    public var canManage: Bool { handlers.manage != nil }
    public var canSetAutoUpdate: Bool { handlers.autoUpdate != nil }
    /// The developer a locked catalog row names as its source.
    public var developerName: String? { developer }

    // MARK: Lifecycle

    /// Read the client once and follow its events. Idempotent.
    public func start() {
        guard let client, observation == nil else { return }
        let stream = client.events
        observation = Task { [weak self] in
            await self?.load()
            for await event in stream {
                guard let self else { return }
                if case .updateAvailable = event { self.offered = true }
                await self.reloadAccount()
            }
        }
    }

    public func stop() {
        observation?.cancel()
        observation = nil
    }

    /// Everything the pane shows: account, devices and the catalog.
    public func load() async {
        await reloadAccount()
        async let roster: Void = loadDevices()
        async let catalog: Void = loadConfig()
        _ = await (roster, catalog)
        hasLoaded = true
    }

    private func reloadAccount() async {
        guard let client else { return }
        var on: Set<KitService> = []
        for service in KitService.allCases {
            if let slug = ServiceSlug(rawValue: service.rawValue), await client.core.enabled(slug) {
                on.insert(service)
            }
        }
        if await client.core.licenseGateEnabled() { on.insert(.license) } else { on.remove(.license) }
        servicesOn = on
        licensed = await client.status()
        let current = await client.identity.current()
        accountSignedIn = current != nil
        holder = current?.name ?? current?.email
        let info = await client.licenseInfo()
        tier = info?.tierLabel ?? info?.tier
        developer = client.presentation?.developerName ?? client.presentation?.name
        channel = KitChannelState.resolve(
            current: client.core.channel, entitled: info?.entitledChannels, store: options.store,
            canSelect: handlers.selectChannel != nil)
    }

    // MARK: Devices

    private func loadDevices() async {
        guard let client else { return }
        let roster = await client.listDevices()
        devicesLoaded = true
        devicesFailed = false
        devices = roster.map(Self.kitDevice)
        deviceIds = roster.map(\.id)
        if let limit = await client.licenseInfo()?.deviceLimit, !roster.isEmpty {
            seats = "\(roster.count) of \(limit)"
        }
    }

    static func kitDevice(_ info: DeviceInfo) -> KitDevice {
        let platform = info.platform ?? "other"
        let form: KitFormFactor
        switch platform {
        case "ios": form = .iphone
        case "macos": form = .mac
        case "android": form = .phone
        case "windows", "linux": form = .computer
        default: form = .other
        }
        let seen = info.lastSeen.map { max(0, (Int(Date().timeIntervalSince1970) - $0) / 86_400) }
        return KitDevice(
            name: info.label, platform: platform, formFactor: form,
            lastSeenDays: info.current ? 0 : (seen ?? 0), current: info.current)
    }

    /// Remove a device from the license. The current device is not removable here: Sign out is
    /// its control.
    public func removeDevice(at index: Int) async {
        guard let client, deviceIds.indices.contains(index), !devices[index].current else { return }
        let device = devices[index]
        deviceFailure = nil
        do {
            try await client.deauthorizeDevice(deviceIds[index])
            await loadDevices()
        } catch {
            deviceFailure = CopyLine(
                "devices.removeFailed", ["device": .text(device.name ?? "")])
            }
    }

    /// Rename a device in place; an empty name clears the label.
    public func renameDevice(at index: Int, to name: String) async {
        guard let client, deviceIds.indices.contains(index) else { return }
        let device = devices[index]
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        deviceFailure = nil
        do {
            try await client.renameDevice(deviceIds[index], label: label.isEmpty ? nil : label)
            await loadDevices()
        } catch {
            deviceFailure = CopyLine(
                "devices.renameFailed", ["device": .text(device.name ?? label)])
            }
    }

    public func retryDevices() async {
        deviceFailure = nil
        await loadDevices()
    }

    // MARK: Catalog settings

    private func loadConfig() async {
        guard let client else { return }
        guard await client.config.isEnabled() else {
            rows = []
            configLoaded = true
            return
        }
        guard let catalog = await client.config.fetchCatalog() else {
            configFailed = true
            configLoaded = true
            return
        }
        configFailed = false
        let listed = Set(await client.config.listUserConfig().map(\.key))
        var out: [KitConfigRow] = []
        var picks: [String: [String]] = [:]
        for entry in catalog.entries where entry.kind == "config" && entry.deprecated != true {
            let state = await client.config.settingState(entry.key)
            // A hidden key is locked and not listed: never shown.
            if state.locked, !listed.contains(entry.key) { continue }
            guard
                let row = Self.row(
                    entry, state: state, org: developer ?? client.product)
            else { continue }
            if let options = entry.allowedValues?.compactMap(\.stringValue), !options.isEmpty {
                picks[entry.key] = options
            }
            out.append(row)
        }
        rows = out
        selectOptions = picks
        configLoaded = true
    }

    public static func row(_ entry: ConfigCatalogEntry, state: ConfigSettingState, org: String)
        -> KitConfigRow?
    {
        let type: String
        switch entry.schemaType {
        case "boolean": type = "boolean"
        case "integer", "number": type = "number"
        case "string": type = entry.allowedValues == nil ? "string" : "select"
        default: return nil
        }
        let value: KitConfigValue?
        switch state.value {
        case .bool(let b)?: value = .bool(b)
        case .int(let n)?: value = .number(Double(n))
        case .double(let n)?: value = .number(n)
        case .string(let s)?: value = .string(s)
        default: value = nil
        }
        let source: String
        switch state.source {
        case .enforced, .hidden: source = "enforced"
        case .local: source = "local"
        case .env: source = "env"
        case .remoteDefault, .fallback: source = "default"
        }
        let bounds = entry.schema.objectValue
        return KitConfigRow(
            key: entry.key, type: type, source: source, locked: state.locked,
            org: state.locked ? org : nil, value: value, min: bounds?["minimum"]?.doubleValue,
            max: bounds?["maximum"]?.doubleValue, advanced: entry.ui?.advanced,
            label: entry.label)
    }

    /// The person changed a catalog value; the client keeps it (never an enforced one).
    public func setValue(_ key: String, _ value: KitConfigValue) async {
        guard let client else { return }
        let json: JSONValue
        switch value {
        case .bool(let b): json = .bool(b)
        case .number(let n): json = n.rounded() == n ? .int(Int(n)) : .double(n)
        case .string(let s): json = .string(s)
        }
        saving = true
        saved = false
        saveFailed = false
        do {
            try await client.config.set(key, json)
            await loadConfig()
            saved = true
        } catch {
            saveFailed = true
        }
        saving = false
    }

    /// Back to the default: the person's own value is cleared.
    public func resetValue(_ key: String) async {
        guard let client else { return }
        await client.config.clear(key)
        await loadConfig()
    }

    public func retryConfig() async {
        configLoaded = false
        saveFailed = false
        await loadConfig()
    }

    // MARK: Account

    /// Check now: a fresh sync; an offer reaches the gate's banner, otherwise the row says so.
    public func checkNow() async {
        guard let client, !checking else { return }
        checking = true
        checkResult = nil
        offered = false
        let result = await client.sync(force: true)
        // The offer, if any, arrives on the event stream just after the sync.
        try? await Task.sleep(nanoseconds: 300_000_000)
        checking = false
        if result.unauthorized || result.blocked {
            checkResult = CopyLine("common.tryAgain")
        } else if !offered {
            checkResult = CopyLine("update.upToDate")
        }
    }

    public func setAutoUpdate(_ on: Bool) {
        autoUpdate = on
        handlers.autoUpdate?(on)
    }

    public func selectChannel(_ name: String) {
        handlers.selectChannel?(name)
    }

    /// Sign out: release this device's seat and wipe its credential.
    public func signOut() async {
        guard let client else { return }
        try? await client.deactivate()
        await reloadAccount()
        handlers.signedOut?()
    }

    // MARK: Inputs

    /// The base every pane's inputs share: the product, the platform, the services that are on.
    private var base: KitInputs {
        KitInputs(bundle: inputs.bundle, platform: inputs.platform, services: servicesOn)
    }

    private var accountInputs: KitInputs {
        guard client != nil else { return inputs }
        var i = base
        if !hasLoaded { i.loading = true }
        if let licensed, licensed.status == .grace { i.gate = KitGate(status: .grace) }
        i.account = KitAccount(signedIn: accountSignedIn, holder: accountSignedIn ? "account" : nil)
        return i
    }

    private var devicesInputs: KitInputs {
        guard client != nil else { return inputs }
        var i = base
        i.devices = devicesLoaded ? devices : nil
        if devicesFailed { i.error = KitError(code: "device_list_failed") }
        return i
    }

    private var settingsInputs: KitInputs {
        guard client != nil else { return inputs }
        var i = base
        if configFailed {
            i.error = KitError(code: "config_load_failed")
        } else if configLoaded {
            i.config = rows
            if saving {
                i.pending = .save
            } else if saveFailed {
                i.error = KitError(code: "config_save_failed")
            } else if saved {
                i.saved = true
            }
        } else {
            i.loading = true
        }
        return i
    }
}
