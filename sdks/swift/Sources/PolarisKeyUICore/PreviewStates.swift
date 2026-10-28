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
    /// Drift Kart by Lanternworks, with its own accent (a light one: the label flips to ink). It
    /// ships no icon art of its own, so the preview draws its monogram, never Tidewater's icon.
    public static let driftKart = KitPresentation(
        name: "Drift Kart", developerName: "Lanternworks", accent: "#ff6a3d", icon: false)
    public static let iPhone = KitPlatform(os: .ios, formFactor: .iphone)
    public static let iPad = KitPlatform(os: .ios, formFactor: .ipad)
    public static let mac = KitPlatform(os: .macos, formFactor: .mac)
    /// A synthetic key with a 22-character secret.
    public static let key = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpQQ"
    public static let manageURL =
        "https://polaris.locker/#/p/tidewater/devices"

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
            freeDeviceUrl: "https://polaris.locker/#/p/tidewater/free-device?license=lic_pro"),
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
        gate + welcome + signIn + nearby + activate + offlineActivation + deviceLimit + statusAndGrace + update + settings
        + devicesAndPaywall + cloudSync

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

    private static let offlineOn = KitCapabilities(offlineActivation: true)

    static let offlineActivation: [PolarisKeyPreviewState] = [
        .init(
            .offlineActivation, "default",
            base {
                $0.capabilities = offlineOn
                $0.offline = KitOffline()
            }),
        .init(
            .offlineActivation, "loaded",
            base {
                $0.capabilities = offlineOn
                $0.offline = KitOffline(file: true)
            }),
        .init(
            .offlineActivation, "rejected-signature",
            base {
                $0.capabilities = offlineOn
                $0.offline = KitOffline(file: true, submitted: true, verified: false)
            }),
        .init(
            .offlineActivation, "done",
            base {
                $0.capabilities = offlineOn
                $0.offline = KitOffline(file: true, submitted: true, verified: true)
            }),
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
            .signIn, "done", variant: "issued-tier",
            base {
                $0.signIn = sign(.signedIn) { $0.issuedNow = true }
                $0.account = KitAccount(signedIn: true, holder: "account", tier: "Pro")
            }),
        .init(
            .signIn, "done", variant: "tier",
            base {
                $0.signIn = sign(.signedIn) {
                    $0.issuedNow = false
                    $0.name = "Mara Lindqvist"
                    $0.tier = "Pro"
                }
            }),
        .init(
            .signIn, "error",
            base {
                $0.signIn = sign()
                $0.signIn?.method = "Passkey"
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
            .signInHandoff, "failed",
            base {
                $0.signIn = sign(channel: .deviceCode)
                $0.deviceCode = KitDeviceCode(phase: .failed)
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
            .licenseChoice, "loading",
            base {
                $0.signIn = sign(.choose)
                $0.loading = true
            }),
        .init(
            .licenseChoice, "raced",
            base {
                $0.signIn = sign(.choose) { $0.raced = true }
                $0.choices = KitLicenseChoices(choices: choices, preselected: "lic_pro")
            }),
        .init(
            .licenseChoice, "grant-expired",
            base {
                $0.signIn = sign(.choose) { $0.grantExpired = true }
            }),
        .init(
            .licenseChoice, "none-keys",
            base {
                $0.signIn = sign(.choose)
                $0.choices = KitLicenseChoices(
                    state: "none", getLicense: KitGetLicense(keyEntry: true))
            }),
    ]

    private static func auto(
        _ step: KitAutoSignInStep, provider: String = "Google", email: String? = nil,
        reach: KitLinkReach? = nil, license: String? = nil, also: Bool? = nil, code: String? = nil,
        manageUrl: String? = nil, seat: (name: String, position: Int, limit: Int)? = nil
    ) -> KitInputs {
        base {
            $0.signIn = sign()
            $0.provider = provider
            $0.autoSignIn = KitAutoSignIn(
                step: step, email: email, reach: reach, license: license, alsoGets: also, code: code,
                licenseName: seat?.name, position: seat?.position, limit: seat?.limit,
                manageUrl: manageUrl)
        }
    }

    static let nearby: [PolarisKeyPreviewState] = [
        .init(
            .signIn, "confirm", auto(.confirm, email: "maya@example.com", license: "new", also: true)),
        .init(
            .signIn, "confirm", variant: "apple",
            auto(
                .confirm, provider: "Apple", license: "existing", also: true,
                seat: (name: "Pro", position: 2, limit: 3))),
        .init(.signIn, "link-offer", variant: "global", auto(.linkOffer, reach: .global)),
        .init(.signIn, "link-offer", auto(.linkOffer, reach: .developer)),
        .init(.signIn, "link-done", auto(.linkDone)),
        .init(.signIn, "link-conflict", auto(.linkConflict)),
        .init(.signIn, "nearby-prompt", auto(.nearbyPrompt)),
        .init(.signIn, "nearby-wait", auto(.nearbyWait, code: "482 913")),
        .init(.signIn, "nearby-done", auto(.nearbyDone, email: "maya@example.com")),
        .init(
            .signIn, "device-limit",
            auto(.deviceLimit, manageUrl: "https://polaris.locker/#/p/tidewater/free-device")),
        // No link to replace a device: the lede names the fix in words (deviceLimit.noManage).
        .init(.signIn, "device-limit", variant: "no-link", auto(.deviceLimit)),
        // Every license full, one of them allowing a replace: the rows under the refusal's title.
        .init(
            .signIn, "choose", variant: "device-limit",
            base {
                $0.signIn = sign(.choose)
                $0.provider = "Apple"
                $0.choices = KitLicenseChoices(choices: fullChoices)
            }),
        .init(
            .signIn, "key-refused",
            base {
                $0.signIn = sign(.choose, event: .haveKey)
                $0.choices = KitLicenseChoices(choices: choices, preselected: "lic_pro")
                $0.activation = KitActivation(result: "key-entry-limit", manageUrl: manageURL)
            }),
        .init(
            .signIn, "key-refused", variant: "license-owned",
            base {
                $0.signIn = sign(.choose, event: .haveKey)
                $0.choices = KitLicenseChoices(choices: choices, preselected: "lic_pro")
                $0.activation = KitActivation(result: "refused", code: "license_owned")
            }),
        .init(.nearbyApproval, "entry", base { _ in }),
        .init(
            .nearbyApproval, "ask",
            base { $0.nearbyApproval = KitNearbyApproval(step: .ask, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "approved",
            base { $0.nearbyApproval = KitNearbyApproval(step: .approved, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "mismatch",
            base { $0.nearbyApproval = KitNearbyApproval(step: .mismatch, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "denied",
            base { $0.nearbyApproval = KitNearbyApproval(step: .denied, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "expired",
            base { $0.nearbyApproval = KitNearbyApproval(step: .expired) }),
        .init(
            .nearbyApproval, "device-limit",
            base { $0.nearbyApproval = KitNearbyApproval(step: .deviceLimit, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "choose",
            base { $0.nearbyApproval = KitNearbyApproval(step: .choose, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "account-required",
            base {
                $0.nearbyApproval = KitNearbyApproval(step: .accountRequired, device: "Kitchen iPad")
            }),
        .init(
            .nearbyApproval, "rate-limited",
            base { $0.nearbyApproval = KitNearbyApproval(step: .rateLimited, device: "Kitchen iPad") }),
        .init(
            .nearbyApproval, "not-nearby",
            base {
                $0.nearbyApproval = KitNearbyApproval(step: .notNearby, device: "Kitchen iPad")
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
            .activate, "key-entry-limit",
            base {
                $0.keyField = KitKeyField(text: key, submitted: true)
                $0.activation = KitActivation(result: "key-entry-limit", manageUrl: manageURL)
            }),
        .init(
            .activate, "license-owned",
            base {
                $0.keyField = KitKeyField(text: key, submitted: true)
                $0.activation = KitActivation(
                    result: "refused", code: "license_owned",
                    signInUrl: "https://polaris.locker/#/p/tidewater/sign-in")
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
            base {
                $0.update = KitUpdate(
                    action: "binary", version: "2.5.0", currentVersion: "2.4.1",
                    sizeBytes: 61_000_000,
                    notes: ["Faster sync across devices.", "Fixes a crash on launch."],
                    notesUrl: "https://harboraudio.example/tidewater/2.5.0")
            }),
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
            .toast, "info",
            base {
                $0.toast = KitToast(kind: "update")
                $0.update = KitUpdate(action: "binary", version: "2.5.0")
            }),
        .init(.toast, "success", base { $0.toast = KitToast(kind: "copied") }),
        .init(
            .updateProgress, "downloading",
            base {
                $0.update = KitUpdate(
                    action: "binary", version: "2.5.0",
                    progress: KitUpdateProgress(
                        phase: "download", fraction: 0.4, bytes: 24_400_000,
                        totalBytes: 61_000_000, secondsLeft: 252))
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
        // The settings drop-in (`PolarisKeySettings`): the whole pane, with the ChannelPicker as a
        // choice, locked by the store, and locked by the license.
        .init(
            .accountAndLicense, "signed-in", variant: "pane",
            base {
                $0.account = KitAccount(signedIn: true, holder: "account")
                $0.devices = devices
                $0.config = config
            }),
        .init(
            .accountAndLicense, "signed-in", variant: "channel-locked",
            base { $0.account = KitAccount(signedIn: true, holder: "account") }),
        .init(
            .accountAndLicense, "signed-in", variant: "channel-license",
            base { $0.account = KitAccount(signedIn: true, holder: "account") }),
        .init(
            .settings, "list", variant: "controls",
            base {
                $0.config =
                    config + [
                        KitConfigRow(
                            key: "player.name", type: "string", source: "local",
                            value: .string("Mara"), label: "Display name")
                    ]
            }),
        .init(.settings, "error", base { $0.error = KitError(code: "config_load_failed") }),
    ]

    static let devicesAndPaywall: [PolarisKeyPreviewState] = [
        .init(
            .devices, "list",
            base {
                var list = devices
                list[2].current = true
                $0.devices = list
            }),
        .init(
            .devices, "renaming",
            base {
                var list = devices
                list[2].current = true
                $0.devices = list
                $0.edit = KitEdit(kind: "rename", device: "Mara's iPad")
            }),
        .init(.devices, "empty", base { $0.devices = [] }),
        .init(.devices, "error", base { $0.error = KitError(code: "device_list_failed") }),
        .init(.devices, "browser-mode", base { $0.browserMode = true }),
        .init(
            .paywall, "offers",
            base {
                $0.entitlement = KitEntitlement(name: "pro.export", entitled: false, tier: "Pro")
                $0.offers = KitOffers(
                    available: true, tier: "Pro",
                    features: ["Stem export", "Unlimited projects", "Priority support"])
            }),
        .init(
            .paywall, "not-available",
            base {
                $0.entitlement = KitEntitlement(name: "pro.export", entitled: false)
                $0.offers = KitOffers(available: false)
            }),
        .init(
            .entitlementGate, "not-entitled",
            base {
                $0.entitlement = KitEntitlement(name: "pro.export", entitled: false, tier: "Pro")
            }),
        .init(
            .entitlementGate, "entitled",
            base { $0.entitlement = KitEntitlement(name: "pro.export", entitled: true) }),
    ]

    /// A made-up recovery code for previews and renders. It opens nothing.
    public static let sampleRecoveryCode = "K7QF-2M9D-XR4T-8WHB-3JNC-6PEV-4HDA-9XKS"

    static let cloudSync: [PolarisKeyPreviewState] = [
        .init(.cloudSyncStatus, "locked", base { $0.cloudSync = KitCloudSync(state: .locked) }),
        .init(
            .cloudSyncStatus, "ring-changed",
            base { $0.cloudSync = KitCloudSync(state: .ringChanged) }),
        .init(.unlockSync, "code", base { $0.unlockSync = KitUnlockSync(step: .code) }),
        .init(.unlockSync, "invalid", base { $0.unlockSync = KitUnlockSync(step: .invalid) }),
        .init(.unlockSync, "working", base { $0.unlockSync = KitUnlockSync(step: .working) }),
        .init(.unlockSync, "failed", base { $0.unlockSync = KitUnlockSync(step: .failed) }),
        .init(
            .unlockSync, "start-over-failed",
            base { $0.unlockSync = KitUnlockSync(step: .startOverFailed) }),
        .init(.unlockSync, "no-code", base { $0.unlockSync = KitUnlockSync(step: .noCode) }),
        .init(
            .unlockSync, "start-over", base { $0.unlockSync = KitUnlockSync(step: .startOver) }),
        .init(.recoveryCode, "show", base { $0.recoveryCode = KitRecoveryCode() }),
        .init(
            .recoveryCode, "saved", base { $0.recoveryCode = KitRecoveryCode(saved: true) }),
        .init(
            .ringChange, "confirm",
            base {
                $0.ringChange = KitRingChange(
                    by: "Maya's MacBook",
                    served: .init(ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c"))
            }),
        .init(
            .ringChange, "confirm", variant: "nothing-served",
            base { $0.ringChange = KitRingChange(by: "Maya's MacBook") }),
        .init(
            .ringChange, "failed",
            base {
                $0.ringChange = KitRingChange(
                    by: "Maya's MacBook",
                    served: .init(ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c"), failed: true)
            }),
    ]
}
