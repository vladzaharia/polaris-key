// The presentation core's inputs (UI-KITS §5.2; plans/UK-02b.md §4.2): what a kit screen is drawn
// from, member for member the `vocabulary.inputs` of conformance/corpus/v2/ui-matrix.json. Every
// member is an existing SDK result, an approved view (plans/I-04.md §G) or a kit-side value, so a
// host that draws its own UI fills the same struct and gets the same states, copy keys and actions
// as the drop-in.
//
// The types are Codable with the matrix's spellings, so the conformance runner decodes a row's
// `input` straight into `KitInputs`.

import Foundation

// MARK: - Platform

/// The operating system the kit runs on (`enums.json` `platform`).
public enum KitOS: String, Sendable, Codable, CaseIterable {
    case macos, ios, android, windows, linux, web, tvos, visionos, watchos
}

/// The device's form factor, as copy names it ("this iPhone", "this computer").
public enum KitFormFactor: String, Sendable, Codable, CaseIterable {
    case iphone, ipad, mac, phone, tablet, computer, tv, other
}

/// The device the kit runs on.
public struct KitPlatform: Sendable, Codable, Equatable, Hashable {
    public var os: KitOS
    public var formFactor: KitFormFactor

    public init(os: KitOS, formFactor: KitFormFactor) {
        self.os = os
        self.formFactor = formFactor
    }

    /// A desktop OS window (macOS, Windows, Linux), not a TV.
    public var isDesktop: Bool {
        formFactor != .tv && (os == .macos || os == .windows || os == .linux)
    }

    /// A TV or other screen that cannot browse: the only place a sign-in QR appears (DL14).
    public var isTV: Bool { formFactor == .tv || os == .tvos }

    /// A phone or tablet (Apple or Android).
    public var isHandheld: Bool {
        !isTV && (os == .ios || os == .android || os == .visionos)
    }

    /// The device this process runs on.
    public static var current: KitPlatform {
        #if os(macOS)
            return KitPlatform(os: .macos, formFactor: .mac)
        #elseif os(tvOS)
            return KitPlatform(os: .tvos, formFactor: .tv)
        #elseif os(visionOS)
            return KitPlatform(os: .visionos, formFactor: .other)
        #elseif os(watchOS)
            return KitPlatform(os: .watchos, formFactor: .other)
        #elseif os(iOS)
            return KitPlatform(os: .ios, formFactor: currentIOSFormFactor())
        #else
            return KitPlatform(os: .linux, formFactor: .computer)
        #endif
    }
}

#if os(iOS)
    /// iPhone or iPad from the hardware model ("iPad16,3"), which any thread may read, unlike
    /// `UIDevice`, which is main-actor isolated. The simulator names the model it simulates.
    private func currentIOSFormFactor() -> KitFormFactor {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated.hasPrefix("iPad") ? .ipad : .iphone
        }
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        guard size > 0 else { return .iphone }
        var bytes = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.machine", &bytes, &size, nil, 0)
        let model = String(
            decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return model.hasPrefix("iPad") ? .ipad : .iphone
    }
#endif

// MARK: - Identity

/// The integrator's theme identity (UI-KITS §1.2, §3.1 `product`): it wins field by field.
public struct KitIntegrator: Sendable, Codable, Equatable, Hashable {
    public var name: String?
    public var shortName: String?
    public var developer: String?
    /// A `#rrggbb` colour, or `core` for Polaris violet.
    public var accent: String?
    public var accentDark: String?
    /// Whether the integrator supplies an icon (a view or an image).
    public var icon: Bool?
    public var deviceCodeUrl: String?
    /// `line` or `badge` (UI-KITS §4.5); absent is off.
    public var poweredBy: String?

    public init(
        name: String? = nil, shortName: String? = nil, developer: String? = nil,
        accent: String? = nil, accentDark: String? = nil, icon: Bool? = nil,
        deviceCodeUrl: String? = nil, poweredBy: String? = nil
    ) {
        self.name = name
        self.shortName = shortName
        self.developer = developer
        self.accent = accent
        self.accentDark = accentDark
        self.icon = icon
        self.deviceCodeUrl = deviceCodeUrl
        self.poweredBy = poweredBy
    }
}

/// Discovery's `core.presentation` through the SDK's presentation source (HA-12): `icon` is true
/// when verified icon bytes arrived.
public struct KitPresentation: Sendable, Codable, Equatable, Hashable {
    public var name: String
    public var developerName: String?
    public var accent: String?
    public var accentDark: String?
    public var icon: Bool

    public init(
        name: String, developerName: String? = nil, accent: String? = nil,
        accentDark: String? = nil, icon: Bool = false
    ) {
        self.name = name
        self.developerName = developerName
        self.accent = accent
        self.accentDark = accentDark
        self.icon = icon
    }
}

/// The app bundle's identity, the kit's last identity source.
public struct KitBundle: Sendable, Codable, Equatable, Hashable {
    public var slug: String
    public var name: String?
    /// Whether the bundle has an app icon (not a matrix member: the runner never sets it).
    public var icon: Bool?

    public init(slug: String, name: String? = nil, icon: Bool? = nil) {
        self.slug = slug
        self.name = name
        self.icon = icon
    }
}

// MARK: - Product and gate

/// Discovery's `core.registration`.
public enum KitRegistration: String, Sendable, Codable, CaseIterable {
    case open
    case requiresIdentity = "requires-identity"
    case requiresLicense = "requires-license"
}

/// What the build offers. A member left out takes the default.
public struct KitCapabilities: Sendable, Codable, Equatable, Hashable {
    public var signIn: Bool
    public var keyEntry: Bool
    public var deviceCode: Bool
    public var offlineActivation: Bool
    public var trial: Bool
    public var restore: Bool
    public var purchase: Bool
    public var enroll: Bool

    public init(
        signIn: Bool = true, keyEntry: Bool = true, deviceCode: Bool = true,
        offlineActivation: Bool = false, trial: Bool = false, restore: Bool = false,
        purchase: Bool = false, enroll: Bool = false
    ) {
        self.signIn = signIn
        self.keyEntry = keyEntry
        self.deviceCode = deviceCode
        self.offlineActivation = offlineActivation
        self.trial = trial
        self.restore = restore
        self.purchase = purchase
        self.enroll = enroll
    }

    private enum CodingKeys: String, CodingKey {
        case signIn, keyEntry, deviceCode, offlineActivation, trial, restore, purchase, enroll
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = KitCapabilities()
        signIn = try c.decodeIfPresent(Bool.self, forKey: .signIn) ?? d.signIn
        keyEntry = try c.decodeIfPresent(Bool.self, forKey: .keyEntry) ?? d.keyEntry
        deviceCode = try c.decodeIfPresent(Bool.self, forKey: .deviceCode) ?? d.deviceCode
        offlineActivation =
            try c.decodeIfPresent(Bool.self, forKey: .offlineActivation) ?? d.offlineActivation
        trial = try c.decodeIfPresent(Bool.self, forKey: .trial) ?? d.trial
        restore = try c.decodeIfPresent(Bool.self, forKey: .restore) ?? d.restore
        purchase = try c.decodeIfPresent(Bool.self, forKey: .purchase) ?? d.purchase
        enroll = try c.decodeIfPresent(Bool.self, forKey: .enroll) ?? d.enroll
    }
}

/// The opt-in services (tools/services.json slugs).
public enum KitService: String, Sendable, Codable, CaseIterable {
    case license, config, release, distribution, update, identity, sync

    /// The services each one requires (closed under `requires`).
    public var requires: [KitService] {
        switch self {
        case .distribution: return [.release]
        case .update: return [.distribution]
        case .sync: return [.config, .identity]
        default: return []
        }
    }
}

/// The boot stage machine's view (stage-matrix.json): the stage, its outcome and the emit.
public struct KitStage: Sendable, Codable, Equatable, Hashable {
    public var stage: String
    public var outcome: String
    public var emit: KitStageEmit?

    public init(stage: String, outcome: String, emit: KitStageEmit? = nil) {
        self.stage = stage
        self.outcome = outcome
        self.emit = emit
    }
}

/// One emit object of the stage machine.
public struct KitStageEmit: Sendable, Codable, Equatable, Hashable {
    public var type: String
    public var code: String?
    public var bytes: Int?
    public var metered: Bool?
    public var done: Int?
    public var total: Int?
    public var canPlayOffline: Bool?
    public var reason: String?

    public init(
        type: String, code: String? = nil, bytes: Int? = nil, metered: Bool? = nil,
        done: Int? = nil, total: Int? = nil, canPlayOffline: Bool? = nil, reason: String? = nil
    ) {
        self.type = type
        self.code = code
        self.bytes = bytes
        self.metered = metered
        self.done = done
        self.total = total
        self.canPlayOffline = canPlayOffline
        self.reason = reason
    }
}

/// A gate status (`enums.json` `licenseStatus`).
public enum KitLicenseStatus: String, Sendable, Codable, CaseIterable {
    case ok, grace, expired, revoked
    case needsActivation = "needs-activation"
    case versionTooOld = "version-too-old"
    case versionTooNew = "version-too-new"
    case channelNotEntitled = "channel-not-entitled"
    case notApplicable = "not-applicable"

    /// A refusal the person resolves on a StatusScreen (DL6).
    public var isBlocking: Bool {
        switch self {
        case .revoked, .expired, .versionTooOld, .versionTooNew, .channelNotEntitled: return true
        default: return false
        }
    }
}

/// The license's allowed versions, when the server said.
public struct KitAllowedVersions: Sendable, Codable, Equatable, Hashable {
    public var min: String?
    public var max: String?

    public init(min: String? = nil, max: String? = nil) {
        self.min = min
        self.max = max
    }
}

/// The gate's view.
public struct KitGate: Sendable, Codable, Equatable, Hashable {
    public var status: KitLicenseStatus?
    /// No status yet: the first check runs.
    public var checking: Bool?
    /// A cached license is being re-checked.
    public var cached: Bool?
    public var graceDaysLeft: Int?
    public var allowed: KitAllowedVersions?

    public init(
        status: KitLicenseStatus? = nil, checking: Bool? = nil, cached: Bool? = nil,
        graceDaysLeft: Int? = nil, allowed: KitAllowedVersions? = nil
    ) {
        self.status = status
        self.checking = checking
        self.cached = cached
        self.graceDaysLeft = graceDaysLeft
        self.allowed = allowed
    }
}

/// The action in flight, which drives the busy states.
public enum KitPending: String, Sendable, Codable, CaseIterable {
    case signIn = "sign-in"
    case activate, replace, save, purchase, restore
}

// MARK: - Activation

/// The license key field.
public struct KitKeyField: Sendable, Codable, Equatable, Hashable {
    public var text: String
    public var submitted: Bool?

    public init(text: String, submitted: Bool? = nil) {
        self.text = text
        self.submitted = submitted
    }
}

/// An activation result (`enums.json` `activationResult`) with what the refusal carried.
public struct KitActivation: Sendable, Codable, Equatable, Hashable {
    public var result: String
    public var code: String?
    public var limit: Int?
    public var deviceCount: Int?
    public var manageUrl: String?

    public init(
        result: String, code: String? = nil, limit: Int? = nil, deviceCount: Int? = nil,
        manageUrl: String? = nil
    ) {
        self.result = result
        self.code = code
        self.limit = limit
        self.deviceCount = deviceCount
        self.manageUrl = manageUrl
    }
}

/// Offline activation's progress.
public struct KitOffline: Sendable, Codable, Equatable, Hashable {
    public var copied: Bool?
    public var file: Bool?
    public var submitted: Bool?
    public var verified: Bool?

    public init(
        copied: Bool? = nil, file: Bool? = nil, submitted: Bool? = nil, verified: Bool? = nil
    ) {
        self.copied = copied
        self.file = file
        self.submitted = submitted
        self.verified = verified
    }
}

// MARK: - Sign-in

/// The one sign-in form's presentation (UI-KITS owner decisions; SIGN-IN.md D-79).
public enum KitSignInPresentation: String, Sendable, Codable, CaseIterable {
    case inline, sheet, browser
}

/// Where Replace a device runs during sign-in.
public enum KitReplaceMode: String, Sendable, Codable, CaseIterable {
    case inline, browser
}

/// How the sign-in reaches the card.
public enum KitSignInChannel: String, Sendable, Codable, CaseIterable {
    case browser
    case deviceCode = "device-code"
}

/// `session.wait()`'s outcomes (plans/I-04.md §G.9).
public enum KitSignInOutcome: String, Sendable, Codable, CaseIterable {
    case pending, choose, signedIn, cancelled, expired
}

/// The kit events of the sign-in form.
public enum KitSignInEvent: String, Sendable, Codable, CaseIterable {
    case useCode = "use-code"
    case copyLink = "copy-link"
    case haveKey = "have-key"
    case openReplace = "open-replace"
    case confirmReplace = "confirm-replace"
    case reopen
}

/// The sign-in session.
public struct KitSignIn: Sendable, Codable, Equatable, Hashable {
    public var presentation: KitSignInPresentation
    public var replace: KitReplaceMode
    public var channel: KitSignInChannel
    public var outcome: KitSignInOutcome?
    public var browserOpened: Bool?
    public var redeeming: Bool?
    public var event: KitSignInEvent?
    /// True when this sign-in added or issued the license.
    public var issuedNow: Bool?
    public var raced: Bool?
    public var grantExpired: Bool?
    /// The method the person picked ("Apple", "Email", "Passkey"), named in a failure's sentence.
    /// A kit-side value; the matrix never sets it.
    public var method: String?

    public init(
        presentation: KitSignInPresentation = .inline, replace: KitReplaceMode = .inline,
        channel: KitSignInChannel = .browser, outcome: KitSignInOutcome? = nil,
        browserOpened: Bool? = nil, redeeming: Bool? = nil, event: KitSignInEvent? = nil,
        issuedNow: Bool? = nil, raced: Bool? = nil, grantExpired: Bool? = nil,
        method: String? = nil
    ) {
        self.method = method
        self.presentation = presentation
        self.replace = replace
        self.channel = channel
        self.outcome = outcome
        self.browserOpened = browserOpened
        self.redeeming = redeeming
        self.event = event
        self.issuedNow = issuedNow
        self.raced = raced
        self.grantExpired = grantExpired
    }
}

/// The device-code poll's phase.
public enum KitDeviceCodePhase: String, Sendable, Codable, CaseIterable {
    case starting, waiting
    case slowDown = "slow-down"
    case ok, denied, expired, cancelled
}

/// The device-code poll.
public struct KitDeviceCode: Sendable, Codable, Equatable, Hashable {
    public var phase: KitDeviceCodePhase
    public var secondsLeft: Int?

    public init(phase: KitDeviceCodePhase, secondsLeft: Int? = nil) {
        self.phase = phase
        self.secondsLeft = secondsLeft
    }
}

/// A device count against a limit.
public struct KitSeats: Sendable, Codable, Equatable, Hashable {
    public var used: Int
    public var limit: Int

    public init(used: Int, limit: Int) {
        self.used = used
        self.limit = limit
    }
}

/// Whether a full license can replace a device now.
public struct KitReplaceAllowance: Sendable, Codable, Equatable, Hashable {
    public var allowed: Bool
    public var retryAfter: Int?

    public init(allowed: Bool, retryAfter: Int? = nil) {
        self.allowed = allowed
        self.retryAfter = retryAfter
    }
}

/// One license of plans/I-04.md's `LicenseChoiceView`, field for field.
public struct KitLicenseChoice: Sendable, Codable, Equatable, Hashable, Identifiable {
    public var id: String
    public var tierName: String
    public var name: String?
    /// `purchase`, `store`, `key`, `free`, `developer` or `signin`.
    public var origin: String
    /// `seats` or `account`.
    public var access: String
    public var seats: KitSeats?
    public var current: Bool
    public var expiresAt: Int?
    /// `free` or `full`.
    public var state: String
    public var replace: KitReplaceAllowance?
    public var freeDeviceUrl: String?

    public init(
        id: String, tierName: String, name: String? = nil, origin: String,
        access: String = "seats", seats: KitSeats? = nil, current: Bool = false,
        expiresAt: Int? = nil, state: String = "free", replace: KitReplaceAllowance? = nil,
        freeDeviceUrl: String? = nil
    ) {
        self.id = id
        self.tierName = tierName
        self.name = name
        self.origin = origin
        self.access = access
        self.seats = seats
        self.current = current
        self.expiresAt = expiresAt
        self.state = state
        self.replace = replace
        self.freeDeviceUrl = freeDeviceUrl
    }

    public var isFull: Bool { state == "full" }
}

/// The offer to create a license during sign-in.
public struct KitLicenseCreateOffer: Sendable, Codable, Equatable, Hashable {
    public var tierName: String
    public var access: String

    public init(tierName: String, access: String) {
        self.tierName = tierName
        self.access = access
    }
}

/// Where to get a license when the account has none.
public struct KitGetLicense: Sendable, Codable, Equatable, Hashable {
    public var activateUrl: String?
    public var purchaseUrl: String?
    public var keyEntry: Bool

    public init(activateUrl: String? = nil, purchaseUrl: String? = nil, keyEntry: Bool) {
        self.activateUrl = activateUrl
        self.purchaseUrl = purchaseUrl
        self.keyEntry = keyEntry
    }
}

/// plans/I-04.md's `LicenseChoiceView`.
public struct KitLicenseChoices: Sendable, Codable, Equatable, Hashable {
    /// `choose`, `none` or `autoIssue`.
    public var state: String
    public var choices: [KitLicenseChoice]
    public var keep: Bool
    /// A license id, `keep`, or nil.
    public var preselected: String?
    public var create: KitLicenseCreateOffer?
    public var getLicense: KitGetLicense?

    public init(
        state: String = "choose", choices: [KitLicenseChoice] = [], keep: Bool = false,
        preselected: String? = nil, create: KitLicenseCreateOffer? = nil,
        getLicense: KitGetLicense? = nil
    ) {
        self.state = state
        self.choices = choices
        self.keep = keep
        self.preselected = preselected
        self.create = create
        self.getLicense = getLicense
    }
}

/// One device of plans/I-04.md's `ReplaceView`.
public struct KitReplaceDevice: Sendable, Codable, Equatable, Hashable, Identifiable {
    public var id: String
    public var label: String?
    public var platform: String
    public var deviceType: String
    public var lastSeen: Int
    public var leastRecent: Bool
    public var activeNow: Bool
    public var thisBrowser: Bool

    public init(
        id: String, label: String?, platform: String, deviceType: String, lastSeen: Int,
        leastRecent: Bool = false, activeNow: Bool = false, thisBrowser: Bool = false
    ) {
        self.id = id
        self.label = label
        self.platform = platform
        self.deviceType = deviceType
        self.lastSeen = lastSeen
        self.leastRecent = leastRecent
        self.activeNow = activeNow
        self.thisBrowser = thisBrowser
    }
}

/// plans/I-04.md's `ReplaceView`.
public struct KitReplaceView: Sendable, Codable, Equatable, Hashable {
    public var licenseId: String
    public var seats: KitSeats
    public var devices: [KitReplaceDevice]
    public var replace: KitReplaceAllowance

    public init(
        licenseId: String, seats: KitSeats, devices: [KitReplaceDevice], replace: KitReplaceAllowance
    ) {
        self.licenseId = licenseId
        self.seats = seats
        self.devices = devices
        self.replace = replace
    }
}

// MARK: - Devices

/// One device of the license (the roster, or the device-limit refusal's list).
public struct KitDevice: Sendable, Codable, Equatable, Hashable {
    public var name: String?
    /// `enums.json` `platform`.
    public var platform: String
    public var formFactor: KitFormFactor
    public var lastSeenDays: Int
    /// True only when the runtime knows this row is the device it runs on.
    public var current: Bool

    public init(
        name: String?, platform: String, formFactor: KitFormFactor, lastSeenDays: Int,
        current: Bool = false
    ) {
        self.name = name
        self.platform = platform
        self.formFactor = formFactor
        self.lastSeenDays = lastSeenDays
        self.current = current
    }
}

/// An inline edit the person opened.
public struct KitEdit: Sendable, Codable, Equatable, Hashable {
    /// `rename`, `remove` or `value`.
    public var kind: String
    public var device: String?

    public init(kind: String, device: String? = nil) {
        self.kind = kind
        self.device = device
    }
}

/// A Replace a device on the key path.
public struct KitReplacement: Sendable, Codable, Equatable, Hashable {
    public var device: String
    /// `done` or `failed`.
    public var outcome: String

    public init(device: String, outcome: String) {
        self.device = device
        self.outcome = outcome
    }
}

// MARK: - Update

/// A download's progress.
public struct KitUpdateProgress: Sendable, Codable, Equatable, Hashable {
    /// `queued`, `download`, `verify`, `paused`, `install`, `failed` or `done`.
    public var phase: String
    public var fraction: Double?

    public init(phase: String, fraction: Double? = nil) {
        self.phase = phase
        self.fraction = fraction
    }
}

/// The update decision and its download.
public struct KitUpdate: Sendable, Codable, Equatable, Hashable {
    /// `enums.json` `updateAction`.
    public var action: String
    /// `enums.json` `outletKind`.
    public var outlet: String?
    public var reason: String?
    public var version: String?
    public var mandatory: Bool?
    public var critical: Bool?
    public var progress: KitUpdateProgress?

    public init(
        action: String, outlet: String? = nil, reason: String? = nil, version: String? = nil,
        mandatory: Bool? = nil, critical: Bool? = nil, progress: KitUpdateProgress? = nil
    ) {
        self.action = action
        self.outlet = outlet
        self.reason = reason
        self.version = version
        self.mandatory = mandatory
        self.critical = critical
        self.progress = progress
    }
}

/// One release's notes. `notes` is plain text: markup in it is shown, never run.
public struct KitReleaseNote: Sendable, Codable, Equatable, Hashable {
    public var version: String
    public var date: String
    public var notes: String

    public init(version: String, date: String, notes: String) {
        self.version = version
        self.date = date
        self.notes = notes
    }
}

// MARK: - Settings, account, paywall

/// One `config.list` row.
public struct KitConfigRow: Sendable, Codable, Equatable, Hashable {
    public var key: String
    /// The catalog's label for the row (kit-side; the matrix never sets it).
    public var label: String?
    /// `boolean`, `number`, `select` or `string`.
    public var type: String
    /// `default`, `local`, `env` or `enforced`.
    public var source: String
    public var locked: Bool
    public var org: String?
    public var value: KitConfigValue?
    public var min: Double?
    public var max: Double?
    public var advanced: Bool?

    public init(
        key: String, type: String, source: String, locked: Bool = false, org: String? = nil,
        value: KitConfigValue? = nil, min: Double? = nil, max: Double? = nil, advanced: Bool? = nil,
        label: String? = nil
    ) {
        self.key = key
        self.label = label
        self.type = type
        self.source = source
        self.locked = locked
        self.org = org
        self.value = value
        self.min = min
        self.max = max
        self.advanced = advanced
    }
}

/// A setting's value.
public enum KitConfigValue: Sendable, Codable, Equatable, Hashable {
    case bool(Bool)
    case number(Double)
    case string(String)

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else {
            self = .string(try c.decode(String.self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        }
    }
}

/// The account signed in on this device.
public struct KitAccount: Sendable, Codable, Equatable, Hashable {
    public var signedIn: Bool
    /// `account` when the holder is the account signed in here (S-19); absent otherwise.
    public var holder: String?

    public init(signedIn: Bool, holder: String? = nil) {
        self.signedIn = signedIn
        self.holder = holder
    }
}

/// An entitlement and whether it holds.
public struct KitEntitlement: Sendable, Codable, Equatable, Hashable {
    public var name: String
    public var entitled: Bool

    public init(name: String, entitled: Bool) {
        self.name = name
        self.entitled = entitled
    }
}

/// The store's offers.
public struct KitOffers: Sendable, Codable, Equatable, Hashable {
    public var available: Bool
    public var purchased: Bool?

    public init(available: Bool, purchased: Bool? = nil) {
        self.available = available
        self.purchased = purchased
    }
}

/// The toast being shown: `update`, `copied`, `warning`, `error` or `progress`.
public struct KitToast: Sendable, Codable, Equatable, Hashable {
    public var kind: String

    public init(kind: String) { self.kind = kind }
}

/// A `core.codes` code a step failed with.
public struct KitError: Sendable, Codable, Equatable, Hashable {
    public var code: String

    public init(code: String) { self.code = code }
}

// MARK: - The inputs

/// Everything a kit screen is drawn from. Every member is optional in the matrix; the defaults
/// here are the runtime's (this device, every service on, the Polaris Key preset).
public struct KitInputs: Sendable, Codable, Equatable, Hashable {
    public var integrator: KitIntegrator?
    /// nil: discovery carries no presentation (or the SDK has no accessor yet).
    public var presentation: KitPresentation?
    public var bundle: KitBundle
    public var platform: KitPlatform
    /// The enabled services; nil means all on.
    public var services: Set<KitService>?
    public var registration: KitRegistration
    public var capabilities: KitCapabilities
    public var stage: KitStage?
    public var gate: KitGate?
    public var pending: KitPending?
    public var loading: Bool?
    public var keyField: KitKeyField?
    public var activation: KitActivation?
    public var offline: KitOffline?
    public var signIn: KitSignIn?
    public var deviceCode: KitDeviceCode?
    public var choices: KitLicenseChoices?
    public var replaceView: KitReplaceView?
    public var selected: String?
    public var devices: [KitDevice]?
    public var browserMode: Bool?
    public var edit: KitEdit?
    public var saved: Bool?
    public var replacement: KitReplacement?
    public var update: KitUpdate?
    public var releaseNotes: [KitReleaseNote]?
    public var config: [KitConfigRow]?
    public var account: KitAccount?
    public var entitlement: KitEntitlement?
    public var offers: KitOffers?
    public var toast: KitToast?
    public var error: KitError?

    public init(
        integrator: KitIntegrator? = nil, presentation: KitPresentation? = nil,
        bundle: KitBundle = KitBundle(slug: ""), platform: KitPlatform = .current,
        services: Set<KitService>? = nil, registration: KitRegistration = .requiresLicense,
        capabilities: KitCapabilities = KitCapabilities(), stage: KitStage? = nil,
        gate: KitGate? = nil, pending: KitPending? = nil, loading: Bool? = nil,
        keyField: KitKeyField? = nil, activation: KitActivation? = nil,
        offline: KitOffline? = nil, signIn: KitSignIn? = nil,
        deviceCode: KitDeviceCode? = nil, choices: KitLicenseChoices? = nil,
        replaceView: KitReplaceView? = nil, selected: String? = nil, devices: [KitDevice]? = nil,
        browserMode: Bool? = nil, edit: KitEdit? = nil, saved: Bool? = nil,
        replacement: KitReplacement? = nil, update: KitUpdate? = nil,
        releaseNotes: [KitReleaseNote]? = nil, config: [KitConfigRow]? = nil,
        account: KitAccount? = nil, entitlement: KitEntitlement? = nil,
        offers: KitOffers? = nil, toast: KitToast? = nil, error: KitError? = nil
    ) {
        self.integrator = integrator
        self.presentation = presentation
        self.bundle = bundle
        self.platform = platform
        self.services = services
        self.registration = registration
        self.capabilities = capabilities
        self.stage = stage
        self.gate = gate
        self.pending = pending
        self.loading = loading
        self.keyField = keyField
        self.activation = activation
        self.offline = offline
        self.signIn = signIn
        self.deviceCode = deviceCode
        self.choices = choices
        self.replaceView = replaceView
        self.selected = selected
        self.devices = devices
        self.browserMode = browserMode
        self.edit = edit
        self.saved = saved
        self.replacement = replacement
        self.update = update
        self.releaseNotes = releaseNotes
        self.config = config
        self.account = account
        self.entitlement = entitlement
        self.offers = offers
        self.toast = toast
        self.error = error
    }

    /// Whether `service` is on (an absent list means all are).
    public func isOn(_ service: KitService) -> Bool { services?.contains(service) ?? true }

    /// `services` closed under `requires`: a service whose requirement is off is off too.
    public var closedServices: Set<KitService> {
        var on = services ?? Set(KitService.allCases)
        var changed = true
        while changed {
            changed = false
            for s in on where !s.requires.allSatisfy(on.contains) {
                on.remove(s)
                changed = true
            }
        }
        return on
    }
}
