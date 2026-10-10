// Public preview states (UI-KITS §6.2; the SDK usability review §10.1): named inputs that put a
// component in one of its states, with the fixture products of plans/UK-02b.md D10 (Tidewater
// Studio by Harbor Audio, teal from its icon; Drift Kart by Lanternworks, #ff6a3d). A `#Preview`, a
// state gallery, a snapshot test or a host's own UI tests use them; nothing here touches a network.

import Foundation

/// One named state of one component.
public struct PolarisKeyPreviewState: Sendable, Identifiable, Hashable {
    public let component: KitComponent
    /// The `components.json` state these inputs reach.
    public let state: String
    /// What distinguishes this preview from the component's other previews of the same state.
    public let variant: String?
    public let inputs: KitInputs

    public var id: String {
        [component.rawValue, state, variant].compactMap { $0 }.joined(separator: ".")
    }

    public init(_ component: KitComponent, _ state: String, variant: String? = nil, _ inputs: KitInputs) {
        self.component = component
        self.state = state
        self.variant = variant
        self.inputs = inputs
    }

    /// This preview on another platform (a phone, a tablet, a Mac).
    public func on(_ platform: KitPlatform) -> PolarisKeyPreviewState {
        var copy = inputs
        copy.platform = platform
        return PolarisKeyPreviewState(component, state, variant: variant, copy)
    }

    /// The answer the core gives for these inputs.
    public var screen: AnyKitScreen { KitStates.resolve(component, inputs) }
}

extension PolarisKeyPreviewState {
    // MARK: Fixtures

    /// Tidewater Studio by Harbor Audio: no accent of its own, so the kit derives teal from its icon.
    public static let tidewater = PresentationInput(
        name: "Tidewater Studio", developerName: "Harbor Audio", icon: true)
    /// Drift Kart by Lanternworks, with its own accent (a light one: the label flips to ink).
    public static let driftKart = PresentationInput(
        name: "Drift Kart", developerName: "Lanternworks", accent: "#ff6a3d", icon: true)
    public static let iPhone = KitPlatform(os: .ios, formFactor: .iphone)
    public static let iPad = KitPlatform(os: .ios, formFactor: .ipad)
    public static let mac = KitPlatform(os: .macos, formFactor: .mac)
    /// A synthetic key with a 22-character secret.
    public static let key = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpQQ"
    public static let manageURL =
        "https://key.plrs.im/#/p/tidewater/free-device?license=lic_pro&for=iPhone"

    public static let devices: [DeviceInput] = [
        DeviceInput(
            name: "Work laptop", platform: "windows", formFactor: .computer, lastSeenDays: 12),
        DeviceInput(name: "Mara's iPad", platform: "ios", formFactor: .ipad, lastSeenDays: 3),
        DeviceInput(name: "MacBook Pro", platform: "macos", formFactor: .mac, lastSeenDays: 0),
    ]

    public static let choices: [LicenseChoice] = [
        LicenseChoice(
            id: "lic_pro", tierName: "Pro", origin: "purchase", seats: Seats(used: 1, limit: 3)),
        LicenseChoice(
            id: "lic_store", tierName: "Pro", origin: "store", seats: Seats(used: 1, limit: 3),
            expiresAt: 1_798_761_600),
        LicenseChoice(
            id: "lic_edu", tierName: "Edu", name: "Fennick Studio Edu", origin: "developer",
            seats: Seats(used: 3, limit: 3), expiresAt: 1_798_761_600, state: "full",
            replace: ReplaceAllowance(allowed: true)),
    ]

    public static let fullChoices: [LicenseChoice] = [
        LicenseChoice(
            id: "lic_pro", tierName: "Pro", origin: "purchase", seats: Seats(used: 3, limit: 3),
            state: "full", replace: ReplaceAllowance(allowed: true)),
        LicenseChoice(
            id: "lic_edu", tierName: "Edu", name: "Fennick Studio Edu", origin: "developer",
            seats: Seats(used: 3, limit: 3), expiresAt: 1_798_761_600, state: "full",
            replace: ReplaceAllowance(allowed: true)),
    ]

    public static let replaceView = ReplaceView(
        licenseId: "lic_pro", seats: Seats(used: 3, limit: 3),
        devices: [
            ReplaceDevice(
                id: "dev_work", label: "Work laptop", platform: "windows", deviceType: "computer",
                lastSeen: 1_758_240_000, leastRecent: true),
            ReplaceDevice(
                id: "dev_ipad", label: "Mara's iPad", platform: "ios", deviceType: "tablet",
                lastSeen: 1_759_190_400),
            ReplaceDevice(
                id: "dev_mac", label: "MacBook Pro", platform: "macos", deviceType: "computer",
                lastSeen: 1_759_449_000, activeNow: true),
        ],
        replace: ReplaceAllowance(allowed: true))

    public static let config: [ConfigRowInput] = [
        ConfigRowInput(key: "render.quality", type: "select", source: "default"),
        ConfigRowInput(
            key: "audio.volume", type: "number", source: "local", value: .number(80), min: 0,
            max: 100),
        ConfigRowInput(key: "ui.compact", type: "boolean", source: "default", value: .bool(true)),
        ConfigRowInput(key: "ui.sounds", type: "boolean", source: "default", value: .bool(false)),
    ]

    /// The default inputs: Tidewater on an iPhone, every service on.
    public static func base(_ edit: (inout KitInputs) -> Void = { _ in }) -> KitInputs {
        var i = KitInputs(
            presentation: tidewater, bundle: BundleIdentity(slug: "tidewater", name: "Tidewater Studio"),
            platform: iPhone)
        edit(&i)
        return i
    }

    private static func sign(
        _ outcome: SignInOutcome? = nil, event: SignInEvent? = nil, channel: SignInChannel = .browser,
        _ edit: (inout SignInInput) -> Void = { _ in }
    ) -> SignInInput {
        var s = SignInInput(channel: channel, outcome: outcome, event: event)
        edit(&s)
        return s
    }

    // MARK: The catalogue

    /// Every preview, component by component.
    public static let all: [PolarisKeyPreviewState] =
        gate + welcome + signIn + activate + deviceLimit + statusAndGrace + update + settings

    /// The previews of one component.
    public static func of(_ component: KitComponent) -> [PolarisKeyPreviewState] {
        all.filter { $0.component == component }
    }

    /// The first preview of `component` in `state`.
    public static func named(_ component: KitComponent, _ state: String, variant: String? = nil)
        -> PolarisKeyPreviewState?
    {
        all.first { $0.component == component && $0.state == state && $0.variant == variant }
    }

    static let gate: [PolarisKeyPreviewState] = [
        .init(.gate, "booting", base { $0.gate = GateInput(checking: true) }),
        .init(.gate, "needs-activation", base { $0.gate = GateInput(status: .needsActivation) }),
        .init(.gate, "licensed", base { $0.gate = GateInput(status: .ok) }),
        .init(.gate, "grace", base { $0.gate = GateInput(status: .grace, graceDaysLeft: 5) }),
        .init(.gate, "blocked", base { $0.gate = GateInput(status: .revoked) }),
        .init(
            .gate, "error",
            base {
                $0.stage = StageInput(
                    stage: "error", outcome: "error", emit: StageEmit(type: "error", code: "sync-failed"))
            }),
        .init(.boot, "progress", base { $0.stage = StageInput(stage: "sync", outcome: "running") }),
        .init(
            .boot, "consent",
            base {
                $0.stage = StageInput(
                    stage: "fetch", outcome: "waiting",
                    emit: StageEmit(type: "consent_needed", bytes: 52_428_800, metered: true))
            }),
        .init(
            .boot, "fetching",
            base {
                $0.stage = StageInput(
                    stage: "fetch", outcome: "running",
                    emit: StageEmit(type: "fetch_progress", done: 20_971_520, total: 52_428_800))
            }),
        .init(
            .boot, "offline",
            base {
                $0.stage = StageInput(
                    stage: "offline", outcome: "offline",
                    emit: StageEmit(type: "offline", canPlayOffline: true))
            }),
        .init(
            .boot, "blocked",
            base {
                $0.stage = StageInput(
                    stage: "blocked", outcome: "blocked",
                    emit: StageEmit(type: "blocked", reason: "update-required"))
            }),
        .init(
            .boot, "declined",
            base {
                $0.stage = StageInput(
                    stage: "blocked", outcome: "blocked",
                    emit: StageEmit(type: "blocked", reason: "content-declined"))
            }),
        .init(
            .boot, "rolled-back",
            base {
                $0.stage = StageInput(
                    stage: "sync", outcome: "running", emit: StageEmit(type: "boot_rolled_back"))
            }),
        .init(
            .boot, "error",
            base {
                $0.stage = StageInput(
                    stage: "error", outcome: "error", emit: StageEmit(type: "error", code: "sync-failed"))
            }),
    ]

    static let welcome: [PolarisKeyPreviewState] = [
        .init(.welcome, "default", base()),
        .init(
            .welcome, "default", variant: "extras",
            base { $0.capabilities = Capabilities(offlineActivation: true, trial: true, restore: true) }),
        .init(.welcome, "default", variant: "drift-kart", base { $0.presentation = driftKart }),
        .init(.welcome, "default", variant: "no-presentation", base { $0.presentation = nil }),
        .init(.welcome, "busy", base { $0.pending = .signIn }),
        .init(
            .welcome, "capability-limited", base { $0.capabilities = Capabilities(signIn: false) }),
    ]

    static let signIn: [PolarisKeyPreviewState] = [
        .init(.signIn, "methods", base { $0.signIn = sign() }),
        .init(.signIn, "handoff", base { $0.signIn = sign(.pending) }),
        .init(
            .signIn, "finishing", base { $0.signIn = sign(.pending) { $0.redeeming = true } }),
        .init(
            .signIn, "choose",
            base {
                $0.signIn = sign(.choose)
                $0.choices = LicenseChoiceView(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .signIn, "replace",
            base {
                $0.signIn = sign(.choose, event: .openReplace)
                $0.choices = LicenseChoiceView(choices: fullChoices)
                $0.replaceView = replaceView
            }),
        .init(
            .signIn, "key",
            base {
                $0.signIn = sign(.choose, event: .haveKey)
                $0.choices = LicenseChoiceView(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .signIn, "done", base { $0.signIn = sign(.signedIn) { $0.issuedNow = true } }),
        .init(.signIn, "error", base { $0.signIn = sign(); $0.error = ErrorInput(code: "sign-in-failed") }),
        .init(.signIn, "expired", base { $0.signIn = sign(.expired) }),
        .init(.signInHandoff, "waiting", base { $0.signIn = sign(.pending) }),
        .init(
            .signInHandoff, "no-browser",
            base { $0.signIn = sign(.pending) { $0.browserOpened = false } }),
        .init(
            .signInHandoff, "starting",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = DeviceCodeInput(phase: .starting)
            }),
        .init(
            .signInHandoff, "code",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = DeviceCodeInput(phase: .waiting, secondsLeft: 252)
            }),
        .init(
            .signInHandoff, "denied",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = DeviceCodeInput(phase: .denied)
            }),
        .init(
            .signInHandoff, "expired",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = DeviceCodeInput(phase: .expired)
            }),
        .init(
            .licenseChoice, "many",
            base {
                $0.signIn = sign(.choose)
                $0.choices = LicenseChoiceView(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .licenseChoice, "one",
            base {
                $0.signIn = sign(.choose)
                $0.choices = LicenseChoiceView(choices: [choices[0]], preselected: "lic_pro")
            }),
        .init(
            .licenseChoice, "all-full",
            base {
                $0.signIn = sign(.choose)
                $0.choices = LicenseChoiceView(choices: fullChoices)
            }),
        .init(
            .licenseChoice, "replace-open",
            base {
                $0.signIn = sign(.choose, event: .openReplace)
                $0.choices = LicenseChoiceView(choices: fullChoices)
                $0.replaceView = replaceView
            }),
        .init(
            .licenseChoice, "none-keys",
            base {
                $0.signIn = sign(.choose)
                $0.choices = LicenseChoiceView(state: "none", getLicense: GetLicense(keyEntry: true))
            }),
    ]

    static let activate: [PolarisKeyPreviewState] = [
        .init(.activate, "empty", base { $0.keyField = KeyFieldInput(text: "") }),
        .init(.activate, "typing", base { $0.keyField = KeyFieldInput(text: "pkey_tidewater_Q2xv") }),
        .init(.activate, "parsed", base { $0.keyField = KeyFieldInput(text: key) }),
        .init(
            .activate, "cut-short",
            base { $0.keyField = KeyFieldInput(text: "pkey_tidewater_Q2xvdWRzT3Zlcl", submitted: true) }),
        .init(
            .activate, "busy",
            base {
                $0.keyField = KeyFieldInput(text: key, submitted: true)
                $0.pending = .activate
            }),
        .init(
            .activate, "rejected",
            base {
                $0.keyField = KeyFieldInput(text: key, submitted: true)
                $0.activation = ActivationInput(result: "license-disabled")
            }),
        .init(
            .activate, "device-limit",
            base {
                $0.keyField = KeyFieldInput(text: key, submitted: true)
                $0.activation = ActivationInput(
                    result: "device-limit", limit: 3, deviceCount: 3, manageUrl: manageURL)
            }),
        .init(
            .activate, "done",
            base {
                $0.keyField = KeyFieldInput(text: key, submitted: true)
                $0.activation = ActivationInput(result: "ok")
            }),
    ]

    static let deviceLimit: [PolarisKeyPreviewState] = [
        .init(
            .deviceLimit, "browser-mode",
            base {
                $0.activation = ActivationInput(
                    result: "device-limit", limit: 3, deviceCount: 3, manageUrl: manageURL)
            }),
        .init(
            .deviceLimit, "default",
            base {
                $0.activation = ActivationInput(result: "device-limit", limit: 3, deviceCount: 3)
                $0.devices = devices
            }),
    ]

    static let statusAndGrace: [PolarisKeyPreviewState] = [
        .init(.statusScreen, "revoked", base { $0.gate = GateInput(status: .revoked) }),
        .init(.statusScreen, "expired", base { $0.gate = GateInput(status: .expired) }),
        .init(
            .statusScreen, "version-too-old",
            base { $0.gate = GateInput(status: .versionTooOld, allowed: AllowedVersions(min: "2.0.0")) }),
        .init(
            .statusScreen, "version-too-new",
            base { $0.gate = GateInput(status: .versionTooNew, allowed: AllowedVersions(max: "2.9.9")) }),
        .init(
            .statusScreen, "channel-not-entitled",
            base { $0.gate = GateInput(status: .channelNotEntitled) }),
        .init(
            .graceBanner, "days-left", base { $0.gate = GateInput(status: .grace, graceDaysLeft: 5) }),
        .init(
            .graceBanner, "last-day", base { $0.gate = GateInput(status: .grace, graceDaysLeft: 1) }),
    ]

    static let update: [PolarisKeyPreviewState] = [
        .init(
            .updatePrompt, "available",
            base { $0.update = UpdateInput(action: "binary", version: "2.5.0") }),
        .init(
            .updatePrompt, "mandatory",
            base { $0.update = UpdateInput(action: "binary", version: "2.5.0", mandatory: true) }),
        .init(
            .updatePrompt, "store",
            base { $0.update = UpdateInput(action: "store", outlet: "app-store", version: "2.5.0") }),
        .init(
            .updatePrompt, "up-to-date",
            base { $0.update = UpdateInput(action: "none", reason: "up-to-date") }),
    ]

    static let settings: [PolarisKeyPreviewState] = [
        .init(
            .accountAndLicense, "signed-in",
            base { $0.account = AccountInput(signedIn: true, holder: "account") }),
        .init(
            .accountAndLicense, "key-only", base { $0.account = AccountInput(signedIn: false) }),
        .init(.settings, "list", base { $0.config = config }),
    ]
}
