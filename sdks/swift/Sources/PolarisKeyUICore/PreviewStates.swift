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

    public init(
        _ component: KitComponent, _ state: String, variant: String? = nil, _ inputs: KitInputs
    ) {
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
    public static let tidewater = KitPresentation(
        name: "Tidewater Studio", developerName: "Harbor Audio", icon: true)
    /// Drift Kart by Lanternworks, with its own accent (a light one: the label flips to ink).
    public static let driftKart = KitPresentation(
        name: "Drift Kart", developerName: "Lanternworks", accent: "#ff6a3d", icon: true)
    public static let iPhone = KitPlatform(os: .ios, formFactor: .iphone)
    public static let iPad = KitPlatform(os: .ios, formFactor: .ipad)
    public static let mac = KitPlatform(os: .macos, formFactor: .mac)
    /// A synthetic key with a 22-character secret.
    public static let key = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpQQ"
    public static let manageURL =
        "https://key.plrs.im/#/p/tidewater/free-device?license=lic_pro&for=iPhone"

    public static let devices: [KitDevice] = [
        KitDevice(
            name: "Work laptop", platform: "windows", formFactor: .computer, lastSeenDays: 12),
        KitDevice(name: "Mara's iPad", platform: "ios", formFactor: .ipad, lastSeenDays: 3),
        KitDevice(name: "MacBook Pro", platform: "macos", formFactor: .mac, lastSeenDays: 0),
    ]

    public static let choices: [KitLicenseChoice] = [
        KitLicenseChoice(
            id: "lic_pro", tierName: "Pro", origin: "purchase", seats: KitSeats(used: 1, limit: 3)),
        KitLicenseChoice(
            id: "lic_store", tierName: "Pro", origin: "store", seats: KitSeats(used: 1, limit: 3),
            expiresAt: 1_798_761_600),
        KitLicenseChoice(
            id: "lic_edu", tierName: "Edu", name: "Fennick Studio Edu", origin: "developer",
            seats: KitSeats(used: 3, limit: 3), expiresAt: 1_798_761_600, state: "full",
            replace: KitReplaceAllowance(allowed: true)),
    ]

    public static let fullChoices: [KitLicenseChoice] = [
        KitLicenseChoice(
            id: "lic_pro", tierName: "Pro", origin: "purchase", seats: KitSeats(used: 3, limit: 3),
            state: "full", replace: KitReplaceAllowance(allowed: true),
            freeDeviceUrl: "https://key.plrs.im/#/p/tidewater/free-device?license=lic_pro"),
        KitLicenseChoice(
            id: "lic_edu", tierName: "Edu", name: "Fennick Studio Edu", origin: "developer",
            seats: KitSeats(used: 3, limit: 3), expiresAt: 1_798_761_600, state: "full",
            replace: KitReplaceAllowance(allowed: true)),
    ]

    public static let replaceView = KitReplaceView(
        licenseId: "lic_pro", seats: KitSeats(used: 3, limit: 3),
        devices: [
            KitReplaceDevice(
                id: "dev_work", label: "Work laptop", platform: "windows", deviceType: "computer",
                lastSeen: 1_758_240_000, leastRecent: true),
            KitReplaceDevice(
                id: "dev_ipad", label: "Mara's iPad", platform: "ios", deviceType: "tablet",
                lastSeen: 1_759_190_400),
            KitReplaceDevice(
                id: "dev_mac", label: "MacBook Pro", platform: "macos", deviceType: "computer",
                lastSeen: 1_759_449_000, activeNow: true),
        ],
        replace: KitReplaceAllowance(allowed: true))

    public static let config: [KitConfigRow] = [
        KitConfigRow(
            key: "render.quality", type: "select", source: "default", value: .string("High"),
            label: "Render quality"),
        KitConfigRow(
            key: "audio.volume", type: "number", source: "local", value: .number(80), min: 0,
            max: 100, label: "Volume"),
        KitConfigRow(
            key: "ui.compact", type: "boolean", source: "default", value: .bool(true),
            label: "Compact layout"),
        KitConfigRow(
            key: "ui.sounds", type: "boolean", source: "default", value: .bool(false),
            label: "Interface sounds"),
    ]

    /// The default inputs: Tidewater on an iPhone, every service on.
    public static func base(_ edit: (inout KitInputs) -> Void = { _ in }) -> KitInputs {
        var i = KitInputs(
            presentation: tidewater, bundle: KitBundle(slug: "tidewater", name: "Tidewater Studio"),
            platform: iPhone)
        edit(&i)
        return i
    }

    private static func sign(
        _ outcome: KitSignInOutcome? = nil, event: KitSignInEvent? = nil,
        channel: KitSignInChannel = .browser,
        _ edit: (inout KitSignIn) -> Void = { _ in }
    ) -> KitSignIn {
        var s = KitSignIn(channel: channel, outcome: outcome, event: event)
        edit(&s)
        return s
    }

    // MARK: The catalogue

    /// Every preview, component by component.
    public static let all: [PolarisKeyPreviewState] =
        gate + welcome + signIn + activate + deviceLimit + statusAndGrace + update + settings
        + devicesAndPaywall

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
        .init(.gate, "booting", base { $0.gate = KitGate(checking: true) }),
        .init(.gate, "needs-activation", base { $0.gate = KitGate(status: .needsActivation) }),
        .init(.gate, "licensed", base { $0.gate = KitGate(status: .ok) }),
        .init(.gate, "grace", base { $0.gate = KitGate(status: .grace, graceDaysLeft: 5) }),
        .init(.gate, "blocked", base { $0.gate = KitGate(status: .revoked) }),
        .init(
            .gate, "error",
            base {
                $0.stage = KitStage(
                    stage: "error", outcome: "error",
                    emit: KitStageEmit(type: "error", code: "sync-failed"))
            }),
        .init(.boot, "progress", base { $0.stage = KitStage(stage: "sync", outcome: "running") }),
        .init(
            .boot, "consent",
            base {
                $0.stage = KitStage(
                    stage: "fetch", outcome: "waiting",
                    emit: KitStageEmit(type: "consent_needed", bytes: 52_428_800, metered: true))
            }),
        .init(
            .boot, "fetching",
            base {
                $0.stage = KitStage(
                    stage: "fetch", outcome: "running",
                    emit: KitStageEmit(type: "fetch_progress", done: 20_971_520, total: 52_428_800))
            }),
        .init(
            .boot, "offline",
            base {
                $0.stage = KitStage(
                    stage: "offline", outcome: "offline",
                    emit: KitStageEmit(type: "offline", canPlayOffline: true))
            }),
        .init(
            .boot, "blocked",
            base {
                $0.stage = KitStage(
                    stage: "blocked", outcome: "blocked",
                    emit: KitStageEmit(type: "blocked", reason: "update-required"))
            }),
        .init(
            .boot, "declined",
            base {
                $0.stage = KitStage(
                    stage: "blocked", outcome: "blocked",
                    emit: KitStageEmit(type: "blocked", reason: "content-declined"))
            }),
        .init(
            .boot, "rolled-back",
            base {
                $0.stage = KitStage(
                    stage: "sync", outcome: "running", emit: KitStageEmit(type: "boot_rolled_back"))
            }),
        .init(
            .boot, "error",
            base {
                $0.stage = KitStage(
                    stage: "error", outcome: "error",
                    emit: KitStageEmit(type: "error", code: "sync-failed"))
            }),
    ]

    static let welcome: [PolarisKeyPreviewState] = [
        .init(.welcome, "default", base()),
        .init(
            .welcome, "default", variant: "extras",
            base {
                $0.capabilities = KitCapabilities(
                    offlineActivation: true, trial: true, restore: true)
            }),
        .init(.welcome, "default", variant: "drift-kart", base { $0.presentation = driftKart }),
        .init(.welcome, "default", variant: "no-presentation", base { $0.presentation = nil }),
        .init(.welcome, "busy", base { $0.pending = .signIn }),
        .init(
            .welcome, "capability-limited",
            base { $0.capabilities = KitCapabilities(signIn: false) }),
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
                $0.choices = KitLicenseChoices(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .signIn, "replace",
            base {
                $0.signIn = sign(.choose, event: .openReplace)
                $0.choices = KitLicenseChoices(choices: fullChoices)
                $0.replaceView = replaceView
            }),
        .init(
            .signIn, "key",
            base {
                $0.signIn = sign(.choose, event: .haveKey)
                $0.choices = KitLicenseChoices(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .signIn, "done", base { $0.signIn = sign(.signedIn) { $0.issuedNow = true } }),
        .init(
            .signIn, "error",
            base {
                $0.signIn = sign()
                $0.error = KitError(code: "sign-in-failed")
            }),
        .init(.signIn, "expired", base { $0.signIn = sign(.expired) }),
        .init(.signInHandoff, "waiting", base { $0.signIn = sign(.pending) }),
        .init(
            .signInHandoff, "no-browser",
            base { $0.signIn = sign(.pending) { $0.browserOpened = false } }),
        .init(
            .signInHandoff, "starting",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = KitDeviceCode(phase: .starting)
            }),
        .init(
            .signInHandoff, "code",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = KitDeviceCode(phase: .waiting, secondsLeft: 252)
            }),
        .init(
            .signInHandoff, "denied",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = KitDeviceCode(phase: .denied)
            }),
        .init(
            .signInHandoff, "expired",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = KitDeviceCode(phase: .expired)
            }),
        .init(
            .licenseChoice, "many",
            base {
                $0.signIn = sign(.choose)
                $0.choices = KitLicenseChoices(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .licenseChoice, "one",
            base {
                $0.signIn = sign(.choose)
                $0.choices = KitLicenseChoices(choices: [choices[0]], preselected: "lic_pro")
            }),
        .init(
            .licenseChoice, "all-full",
            base {
                $0.signIn = sign(.choose)
                $0.choices = KitLicenseChoices(choices: fullChoices)
            }),
        .init(
            .licenseChoice, "replace-open",
            base {
                $0.signIn = sign(.choose, event: .openReplace)
                $0.choices = KitLicenseChoices(choices: fullChoices)
                $0.replaceView = replaceView
            }),
        .init(
            .licenseChoice, "none-keys",
            base {
                $0.signIn = sign(.choose)
                $0.choices = KitLicenseChoices(
                    state: "none", getLicense: KitGetLicense(keyEntry: true))
            }),
    ]

    static let activate: [PolarisKeyPreviewState] = [
        .init(.activate, "empty", base { $0.keyField = KitKeyField(text: "") }),
        .init(.activate, "typing", base { $0.keyField = KitKeyField(text: "pkey_tidewater_Q2xv") }),
        .init(.activate, "parsed", base { $0.keyField = KitKeyField(text: key) }),
        .init(
            .activate, "cut-short",
            base {
                $0.keyField = KitKeyField(text: "pkey_tidewater_Q2xvdWRzT3Zlcl", submitted: true)
            }),
        .init(
            .activate, "busy",
            base {
                $0.keyField = KitKeyField(text: key, submitted: true)
                $0.pending = .activate
            }),
        .init(
            .activate, "rejected",
            base {
                $0.keyField = KitKeyField(text: key, submitted: true)
                $0.activation = KitActivation(result: "license-disabled")
            }),
        .init(
            .activate, "device-limit",
            base {
                $0.keyField = KitKeyField(text: key, submitted: true)
                $0.activation = KitActivation(
                    result: "device-limit", limit: 3, deviceCount: 3, manageUrl: manageURL)
            }),
        .init(
            .activate, "done",
            base {
                $0.keyField = KitKeyField(text: key, submitted: true)
                $0.activation = KitActivation(result: "ok")
            }),
    ]

    static let deviceLimit: [PolarisKeyPreviewState] = [
        .init(
            .deviceLimit, "browser-mode",
            base {
                $0.activation = KitActivation(
                    result: "device-limit", limit: 3, deviceCount: 3, manageUrl: manageURL)
            }),
        .init(
            .deviceLimit, "default",
            base {
                $0.activation = KitActivation(result: "device-limit", limit: 3, deviceCount: 3)
                $0.devices = devices
            }),
    ]

    static let statusAndGrace: [PolarisKeyPreviewState] = [
        .init(.statusScreen, "revoked", base { $0.gate = KitGate(status: .revoked) }),
        .init(.statusScreen, "expired", base { $0.gate = KitGate(status: .expired) }),
        .init(
            .statusScreen, "version-too-old",
            base {
                $0.gate = KitGate(status: .versionTooOld, allowed: KitAllowedVersions(min: "2.0.0"))
            }),
        .init(
            .statusScreen, "version-too-new",
            base {
                $0.gate = KitGate(status: .versionTooNew, allowed: KitAllowedVersions(max: "2.9.9"))
            }),
        .init(
            .statusScreen, "channel-not-entitled",
            base { $0.gate = KitGate(status: .channelNotEntitled) }),
        .init(
            .graceBanner, "days-left", base { $0.gate = KitGate(status: .grace, graceDaysLeft: 5) }),
        .init(
            .graceBanner, "last-day", base { $0.gate = KitGate(status: .grace, graceDaysLeft: 1) }),
    ]

    static let update: [PolarisKeyPreviewState] = [
        .init(
            .updatePrompt, "available",
            base { $0.update = KitUpdate(action: "binary", version: "2.5.0") }),
        .init(
            .updatePrompt, "mandatory",
            base { $0.update = KitUpdate(action: "binary", version: "2.5.0", mandatory: true) }),
        .init(
            .updatePrompt, "store",
            base { $0.update = KitUpdate(action: "store", outlet: "app-store", version: "2.5.0") }),
        .init(
            .updatePrompt, "up-to-date",
            base { $0.update = KitUpdate(action: "none", reason: "up-to-date") }),
        .init(
            .updatePrompt, "ready",
            base { $0.update = KitUpdate(action: "code-ready", version: "2.5.0") }),
        .init(
            .updateProgress, "downloading",
            base {
                $0.update = KitUpdate(
                    action: "binary", version: "2.5.0",
                    progress: KitUpdateProgress(phase: "download", fraction: 0.4))
            }),
        .init(
            .releaseNotes, "list",
            base {
                $0.releaseNotes = [
                    KitReleaseNote(
                        version: "2.5.0", date: "2026-09-30",
                        notes: "Faster sync. Fixes a crash on launch."),
                    KitReleaseNote(
                        version: "2.4.1", date: "2026-08-12", notes: "Fixes the mixer on Windows."),
                ]
            }),
    ]

    static let settings: [PolarisKeyPreviewState] = [
        .init(
            .accountAndLicense, "signed-in",
            base { $0.account = KitAccount(signedIn: true, holder: "account") }),
        .init(
            .accountAndLicense, "key-only", base { $0.account = KitAccount(signedIn: false) }),
        .init(.settings, "list", base { $0.config = config }),
        .init(
            .settings, "locked",
            base {
                $0.config =
                    config + [
                        KitConfigRow(
                            key: "net.lockdown", type: "boolean", source: "enforced", locked: true,
                            org: "Fennick Studio", value: .bool(true), label: "Share crash reports")
                    ]
            }),
        .init(
            .accountAndLicense, "offline",
            base {
                $0.account = KitAccount(signedIn: true, holder: "account")
                $0.gate = KitGate(status: .grace, graceDaysLeft: 5)
            }),
    ]

    static let devicesAndPaywall: [PolarisKeyPreviewState] = [
        .init(
            .devices, "list",
            base {
                var list = devices
                list[2].current = true
                $0.devices = list
            }),
        .init(.devices, "empty", base { $0.devices = [] }),
        .init(.devices, "error", base { $0.error = KitError(code: "device_list_failed") }),
        .init(.devices, "browser-mode", base { $0.browserMode = true }),
        .init(
            .paywall, "offers",
            base {
                $0.entitlement = KitEntitlement(name: "pro.export", entitled: false)
                $0.offers = KitOffers(available: true)
            }),
        .init(
            .paywall, "not-available",
            base {
                $0.entitlement = KitEntitlement(name: "pro.export", entitled: false)
                $0.offers = KitOffers(available: false)
            }),
        .init(
            .entitlementGate, "not-entitled",
            base { $0.entitlement = KitEntitlement(name: "pro.export", entitled: false) }),
        .init(
            .entitlementGate, "entitled",
            base { $0.entitlement = KitEntitlement(name: "pro.export", entitled: true) }),
    ]
}
