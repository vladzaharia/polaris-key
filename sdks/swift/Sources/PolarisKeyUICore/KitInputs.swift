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
    case license, config, release, distribution, update, identity, sync, commerce, connect

    /// The services each one requires (closed under `requires`).
    public var requires: [KitService] {
        switch self {
        case .distribution: return [.release]
        case .update: return [.distribution]
        case .sync: return [.config, .identity]
        case .commerce: return [.license]
        case .connect: return [.identity]
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
    /// The product's sign-in page a `license_owned` refusal points at (kit-side: the matrix never
    /// sets it). The kit shows only a link that passes `KitLinks.valid`.
    public var signInUrl: String?

    public init(
        result: String, code: String? = nil, limit: Int? = nil, deviceCount: Int? = nil,
        manageUrl: String? = nil, signInUrl: String? = nil
    ) {
        self.result = result
        self.code = code
        self.limit = limit
        self.deviceCount = deviceCount
        self.manageUrl = manageUrl
        self.signInUrl = signInUrl
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

/// The sign-in form's steps that belong to activation without an account.
public enum KitHolderFormStep: String, Sendable, Codable, CaseIterable {
    case keyDone = "key-done"
    case attach
    case added
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
    /// Who signed in and on which tier, by display name, for the signed-in line (kit-side: the
    /// matrix never sets them). Without both the line is "You're signed in".
    public var name: String?
    public var tier: String?
    /// The form's step after a key with no account (UK-42): the holders' screens in its body.
    public var step: KitHolderFormStep?

    public init(
        presentation: KitSignInPresentation = .inline, replace: KitReplaceMode = .inline,
        channel: KitSignInChannel = .browser, outcome: KitSignInOutcome? = nil,
        browserOpened: Bool? = nil, redeeming: Bool? = nil, event: KitSignInEvent? = nil,
        issuedNow: Bool? = nil, raced: Bool? = nil, grantExpired: Bool? = nil,
        method: String? = nil, name: String? = nil, tier: String? = nil,
        step: KitHolderFormStep? = nil
    ) {
        self.step = step
        self.method = method
        self.name = name
        self.tier = tier
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
    case ok, denied, failed, expired, cancelled
}

/// The device-code poll.
public struct KitDeviceCode: Sendable, Codable, Equatable, Hashable {
    public var phase: KitDeviceCodePhase
    public var secondsLeft: Int?
    /// The RFC 8628 user code, shown and copied exactly as served.
    public var userCode: String?
    /// The server's verification address.
    public var verificationUri: String?

    public init(
        phase: KitDeviceCodePhase, secondsLeft: Int? = nil, userCode: String? = nil,
        verificationUri: String? = nil
    ) {
        self.phase = phase
        self.secondsLeft = secondsLeft
        self.userCode = userCode
        self.verificationUri = verificationUri
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
        licenseId: String, seats: KitSeats, devices: [KitReplaceDevice],
        replace: KitReplaceAllowance
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
    /// The counted bytes, when the download knows them (beyond the matrix vocabulary: the copy
    /// says "38 MB of 61 MB", never a percentage dressed as a size).
    public var bytes: Int?
    public var totalBytes: Int?
    /// The time left, when the download estimates it.
    public var secondsLeft: Double?

    public init(
        phase: String, fraction: Double? = nil, bytes: Int? = nil, totalBytes: Int? = nil,
        secondsLeft: Double? = nil
    ) {
        self.phase = phase
        self.fraction = fraction
        self.bytes = bytes
        self.totalBytes = totalBytes
        self.secondsLeft = secondsLeft
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
    /// The running version and the download's size: "You have 2.4.1 · 61 MB download".
    public var currentVersion: String?
    public var sizeBytes: Int?
    /// The release's notes, plain lines (the prompt draws at most three), and its changes page.
    public var notes: [String]?
    public var notesUrl: String?
    /// The store listing a `store` offer names: where "Update" goes when the host has no update
    /// handler. Never the release notes page.
    public var listingUrl: String?

    public init(
        action: String, outlet: String? = nil, reason: String? = nil, version: String? = nil,
        mandatory: Bool? = nil, critical: Bool? = nil, progress: KitUpdateProgress? = nil,
        currentVersion: String? = nil, sizeBytes: Int? = nil, notes: [String]? = nil,
        notesUrl: String? = nil, listingUrl: String? = nil
    ) {
        self.listingUrl = listingUrl
        self.currentVersion = currentVersion
        self.sizeBytes = sizeBytes
        self.notes = notes
        self.notesUrl = notesUrl
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
    /// The tier of the license this account holds here, by display name; names it in the
    /// signed-in line (`signin.return.signedInTier`).
    public var tier: String?

    public init(signedIn: Bool, holder: String? = nil, tier: String? = nil) {
        self.signedIn = signedIn
        self.holder = holder
        self.tier = tier
    }
}

/// An entitlement and whether it holds.
public struct KitEntitlement: Sendable, Codable, Equatable, Hashable {
    public var name: String
    public var entitled: Bool
    /// The tier that grants it, by its display name (beyond the matrix vocabulary).
    public var tier: String?

    public init(name: String, entitled: Bool, tier: String? = nil) {
        self.name = name
        self.entitled = entitled
        self.tier = tier
    }
}

/// The store's offers.
public struct KitOffers: Sendable, Codable, Equatable, Hashable {
    public var available: Bool
    public var purchased: Bool?
    /// The tier on offer, by its display name, and what it adds (beyond the matrix vocabulary:
    /// without them the kit draws no "{tier} includes" line).
    public var tier: String?
    public var features: [String]?
    /// The https page that sells the offer outside the app; the not-available hand-off shows
    /// only when the opener accepts it (DL14).
    public var url: String?

    public init(
        available: Bool, purchased: Bool? = nil, tier: String? = nil, features: [String]? = nil,
        url: String? = nil
    ) {
        self.available = available
        self.purchased = purchased
        self.tier = tier
        self.features = features
        self.url = url
    }
}

/// The toast being shown: `update`, `copied`, `warning`, `error`, `progress` or `key-entries`.
public struct KitToast: Sendable, Codable, Equatable, Hashable {
    public var kind: String
    /// `key-entries`: the key entries the license has left.
    public var left: Int?

    public init(kind: String, left: Int? = nil) {
        self.kind = kind
        self.left = left
    }
}

/// A `core.codes` code a step failed with.
public struct KitError: Sendable, Codable, Equatable, Hashable {
    public var code: String

    public init(code: String) { self.code = code }
}

/// Automatic sign-in's step in the sign-in form (needs `signIn`).
public enum KitAutoSignInStep: String, Sendable, Codable, CaseIterable {
    case confirm
    case linkOffer = "link-offer"
    case linkDone = "link-done"
    case linkConflict = "link-conflict"
    case nearbyPrompt = "nearby-prompt"
    case nearbyWait = "nearby-wait"
    case nearbyDone = "nearby-done"
    /// A device limit with no license rows (KFA-0): its own step, never the key screen.
    case deviceLimit = "device-limit"
}

/// Whose identity a provider link covers: `global` is shared across apps, `developer` is this
/// developer's apps only; absent is treated as per developer.
public enum KitLinkReach: String, Sendable, Codable, CaseIterable {
    case global, developer, unknown
}

/// Automatic sign-in's state: the step, the account's email (absent: the provider shared none)
/// and how far a provider link reaches.
public struct KitAutoSignIn: Sendable, Codable, Equatable, Hashable {
    public var step: KitAutoSignInStep
    public var email: String?
    /// The exchange that produced the grant (`apple`, `google`, `gamecenter`, `pgs`). With no
    /// email the confirm line names the provider by it; absent: no account line.
    public var kind: String?
    public var reach: KitLinkReach?
    /// The license line of the confirm step: `new` or `existing`.
    public var license: String?
    /// Whether the confirm step lists what the account also gets.
    public var alsoGets: Bool?
    /// The code the nearby wait shows, to match on the other device.
    public var code: String?
    /// The existing license the confirm step names, with its term (epoch seconds; nil is
    /// lifetime) and the seat this device takes. Kit-side: the matrix never sets them. The
    /// license line draws only when the seat is known.
    public var licenseName: String?
    public var term: Int?
    public var device: String?
    public var position: Int?
    public var limit: Int?
    /// The device-limit step: the refusal's `manageUrl`, where a device is replaced.
    public var manageUrl: String?
    /// The link offer after a failed Link (kit-side: the matrix never sets it): `stale` (sign in
    /// again), `failed` (this device was refused; No thanks is the way on) or `network` (Link stays).
    public var linkError: String?

    public init(
        step: KitAutoSignInStep, email: String? = nil, reach: KitLinkReach? = nil,
        license: String? = nil, alsoGets: Bool? = nil, code: String? = nil,
        licenseName: String? = nil, term: Int? = nil, device: String? = nil,
        position: Int? = nil, limit: Int? = nil, manageUrl: String? = nil, kind: String? = nil,
        linkError: String? = nil
    ) {
        self.linkError = linkError
        self.kind = kind
        self.manageUrl = manageUrl
        self.licenseName = licenseName
        self.term = term
        self.device = device
        self.position = position
        self.limit = limit
        self.step = step
        self.email = email
        self.reach = reach
        self.license = license
        self.alsoGets = alsoGets
        self.code = code
    }
}

/// The approving device's side of nearby sign-in: where it is, and the device asking.
public struct KitNearbyApproval: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case entry, ask, approved, mismatch, denied, expired, choose
        case rateLimited = "rate-limited"
        case notNearby = "not-nearby"
        case deviceLimit = "device-limit"
        case accountRequired = "account-required"
    }

    public var step: Step
    public var device: String?

    public init(step: Step, device: String? = nil) {
        self.step = step
        self.device = device
    }
}

// MARK: - Cloud Sync

/// CloudSyncStatus's state (ui-matrix `cloudSync`).
public struct KitCloudSync: Sendable, Codable, Equatable, Hashable {
    public enum State: String, Sendable, Codable, CaseIterable {
        case synced, syncing, offline, conflict, error, locked
        case ringChanged = "ring-changed"
        /// A save transfer is running. Never reads as synced.
        case transferring
        /// A transfer is paused for `reason`.
        case waiting
        case transferFailed = "transfer-failed"
    }

    /// Why a transfer waits (default: the network).
    public enum Reason: String, Sendable, Codable, CaseIterable {
        case network, battery, background
    }

    /// A running transfer: display-ready sizes, and a fraction (counted bytes, 0 to 1) only when
    /// the bar may be determinate.
    public struct Transfer: Sendable, Codable, Equatable, Hashable {
        public var size: String?
        public var total: String?
        public var fraction: Double?

        public init(size: String? = nil, total: String? = nil, fraction: Double? = nil) {
            self.size = size
            self.total = total
            self.fraction = fraction
        }
    }

    public var state: State
    public var signedIn: Bool?
    /// The host handles Review for a conflict.
    public var canReview: Bool?
    /// When it last synced, relative ("2 min ago").
    public var lastSynced: String?
    public var transfer: Transfer?
    public var reason: Reason?

    public init(
        state: State, signedIn: Bool? = nil, canReview: Bool? = nil, lastSynced: String? = nil,
        transfer: Transfer? = nil, reason: Reason? = nil
    ) {
        self.state = state
        self.signedIn = signedIn
        self.canReview = canReview
        self.lastSynced = lastSynced
        self.transfer = transfer
        self.reason = reason
    }
}

// MARK: - Connect (LinkPairing, TransferOffer)

/// LinkPairing (ui-matrix `connect`): two people pair their devices once, nearby. `device` is the
/// label the other device reported (unauthenticated display text); `categories` are the ids the app
/// asks both people to approve.
public struct KitLinkPairing: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case open, code, confirm, linked, failed, unavailable
    }

    public enum Reason: String, Sendable, Codable, CaseIterable {
        case declined, timeout, full, closed
    }

    public var step: Step
    public var device: String?
    public var code: String?
    public var categories: [String]
    public var reason: Reason?

    public init(
        step: Step, device: String? = nil, code: String? = nil, categories: [String] = [],
        reason: Reason? = nil
    ) {
        self.step = step
        self.device = device
        self.code = code
        self.categories = categories
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case step, device, code, categories, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        step = try c.decode(Step.self, forKey: .step)
        device = try c.decodeIfPresent(String.self, forKey: .device)
        code = try c.decodeIfPresent(String.self, forKey: .code)
        categories = try c.decodeIfPresent([String].self, forKey: .categories) ?? []
        reason = try c.decodeIfPresent(Reason.self, forKey: .reason)
    }
}

/// TransferOffer (ui-matrix `connect`): a contact offers something (D-8, consent per transfer).
/// `device` and `name` are text the contact chose; `size` is in bytes.
public struct KitTransferOffer: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case ask, receiving, done, failed
    }

    public var step: Step
    public var name: String
    public var device: String?
    public var size: Int?
    public var type: String?

    public init(
        step: Step, name: String, device: String? = nil, size: Int? = nil, type: String? = nil
    ) {
        self.step = step
        self.name = name
        self.device = device
        self.size = size
        self.type = type
    }
}

// MARK: - Pair with a Code (LocalPairing, PairedDevices)

/// One paired device of Pair with a Code (`LocalLinkInfo` of `cloudConnect.localLinks.list`).
public struct KitPairedDevice: Sendable, Codable, Equatable, Hashable {
    public var id: String
    /// The name this device holds for it (the label it sent, or the person's rename).
    public var label: String?
    /// Unix seconds, or nil when it has never been seen.
    public var lastSeen: Int?
    /// True when the other device may find and connect to this one.
    public var reachable: Bool
    /// The other device's platform as it reported it. Display only.
    public var platform: String?

    public init(
        id: String, label: String? = nil, lastSeen: Int? = nil, reachable: Bool = true,
        platform: String? = nil
    ) {
        self.id = id
        self.label = label
        self.lastSeen = lastSeen
        self.reachable = reachable
        self.platform = platform
    }
}

/// LocalPairing (ui-matrix `local`): two devices of one app on one network pair by an 8-digit code
/// or a QR, with no account. Every member is data a model computed.
public struct KitLocalPairing: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case choose
        case opening
        case show
        case closed
        case enter
        case joining
        case confirm
        case waiting
        case paired
        case failed
        case networkBlocked = "network-blocked"
        case off
        case scanPrompt = "scan-prompt"
        case scan
        case cameraOff = "camera-off"
    }
    public enum Notice: String, Sendable, Codable { case rotated, declined, blocked, guessing }
    public enum ScanNotice: String, Sendable, Codable {
        case otherApp = "other-app"
        case notFound = "not-found"
        case stale
        case notReady = "not-ready"
        case preparing
    }
    public enum Busy: String, Sendable, Codable {
        case pair
        case newCode = "new-code"
        case notNow = "not-now"
    }
    public enum ClosedBy: String, Sendable, Codable {
        case tooManyTries = "too-many-tries"
        case expired
    }
    public enum EntryError: String, Sendable, Codable {
        case wrong, spent
        case tooMany = "too-many"
        case notFound = "not-found"
        case notACode = "not-a-code"
    }
    public enum Reason: String, Sendable, Codable { case declined, timeout, full, closed }

    public var step: Step
    public var prePrompt: Bool?
    public var full: Bool?
    /// This device can scan a code: Scan a code leads on choose and replaces the typing and showing links.
    public var canScan: Bool?
    /// choose: the scanner is the host's own sheet, so typing is a link on choose.
    public var sheetScan: Bool?
    /// choose, with `sheetScan`: what each shares comes before the sheet opens.
    public var scanShares: Bool?
    /// scan (and choose with `sheetScan`): why the last scan did not pair; scanning goes on.
    public var scanNotice: ScanNotice?
    /// scan: the camera is in use elsewhere or interrupted.
    public var cameraBusy: Bool?
    public var code: String?
    public var qr: String?
    public var secondsLeft: Int?
    public var notice: Notice?
    public var busy: Busy?
    public var closedBy: ClosedBy?
    public var cooldownLeft: Int?
    public var warn: Bool?
    public var entry: String?
    public var error: EntryError?
    public var triesLeft: Int?
    public var pairDisabled: Bool?
    public var categories: [String]?
    public var device: String?
    public var reason: Reason?
    public var canOpenSettings: Bool?
    public var cantConnect: Bool?
    public var nameError: String?
    public var max: Int?

    public init(step: Step, canOpenSettings: Bool? = nil) {
        self.step = step
        self.canOpenSettings = canOpenSettings == true ? true : nil
    }
}

/// PairedDevices (ui-matrix `local`): the list of what the person paired, and the row being edited.
public struct KitPairedDevices: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case loading
        case list
        case renaming
        case forgetting
        case loadFailed = "load-failed"
        case off
    }
    public enum RenameError: String, Sendable, Codable { case long, empty, failed }
    public struct Notice: Sendable, Codable, Equatable, Hashable {
        public enum Kind: String, Sendable, Codable {
            case notFound = "not-found"
            case busy, unknown
        }
        public var device: String
        public var kind: Kind
        public var id: String?
        public init(device: String, kind: Kind, id: String? = nil) {
            self.device = device
            self.kind = kind
            self.id = id
        }
    }

    public var step: Step
    public var devices: [KitPairedDevice]?
    public var target: String?
    public var renameError: RenameError?
    public var forgetError: Bool?
    public var notice: Notice?

    public init(step: Step, devices: [KitPairedDevice]? = nil) {
        self.step = step
        self.devices = devices
    }
}

// MARK: - Save conflict

/// SaveConflict (ui-matrix `saveConflict`): the same save changed on two devices. `remote` is nil
/// with `remoteDeleted` true when the other copy was deleted (the matrix's `remote: null`); an
/// absent `remote` is an other copy the host knows nothing about.
public struct KitSaveConflict: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case choose, keeping, kept, failed
    }

    /// The copy kept (or being kept): this device's, the other, or both.
    public enum Keep: String, Sendable, Codable, CaseIterable {
        case local, remote, both
    }

    /// One copy: display-ready.
    public struct Copy: Sendable, Codable, Equatable, Hashable {
        public var when: String?
        public var device: String?

        public init(when: String? = nil, device: String? = nil) {
            self.when = when
            self.device = device
        }
    }

    public var step: Step
    public var local: Copy?
    public var remote: Copy?
    /// The other copy was deleted (`remote: null`): nothing to keep or copy.
    public var remoteDeleted: Bool
    /// A free slot of the 16 exists. Absent or false draws Keep both disabled, with its reason.
    public var bothAvailable: Bool?
    public var keep: Keep?
    /// The version the app knows was saved later (its own metadata, never the display strings).
    /// It tags that card and chooses nothing; ignored when the other copy was deleted.
    public var newer: Keep?
    /// On `choose`: a choice was being applied and the other copy changed again, so nothing was applied and
    /// the copies shown are the new ones. Adds one line saying so.
    public var reopened: Bool?

    public init(
        step: Step, local: Copy? = nil, remote: Copy? = nil, remoteDeleted: Bool = false,
        bothAvailable: Bool? = nil, keep: Keep? = nil, newer: Keep? = nil, reopened: Bool? = nil
    ) {
        self.step = step
        self.local = local
        self.remote = remote
        self.remoteDeleted = remoteDeleted
        self.bothAvailable = bothAvailable
        self.keep = keep
        self.newer = newer
        self.reopened = reopened
    }

    private enum CodingKeys: String, CodingKey {
        case step, local, remote, bothAvailable, keep, newer, reopened
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        step = try c.decode(Step.self, forKey: .step)
        local = try c.decodeIfPresent(Copy.self, forKey: .local)
        // `remote: null` is a deletion; an absent `remote` is not.
        var deleted = false
        if c.contains(.remote) { deleted = try c.decodeNil(forKey: .remote) }
        remoteDeleted = deleted
        remote = remoteDeleted ? nil : try c.decodeIfPresent(Copy.self, forKey: .remote)
        bothAvailable = try c.decodeIfPresent(Bool.self, forKey: .bothAvailable)
        keep = try c.decodeIfPresent(Keep.self, forKey: .keep)
        newer = try c.decodeIfPresent(Keep.self, forKey: .newer)
        reopened = try c.decodeIfPresent(Bool.self, forKey: .reopened)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(step, forKey: .step)
        try c.encodeIfPresent(local, forKey: .local)
        if remoteDeleted {
            try c.encodeNil(forKey: .remote)
        } else {
            try c.encodeIfPresent(remote, forKey: .remote)
        }
        try c.encodeIfPresent(bothAvailable, forKey: .bothAvailable)
        try c.encodeIfPresent(keep, forKey: .keep)
        try c.encodeIfPresent(newer, forKey: .newer)
        try c.encodeIfPresent(reopened, forKey: .reopened)
    }
}

/// UnlockSync's step. `nearby` says the host could unlock from a nearby device: v0.10.0 never
/// offers it, because NearbyApproval does not ship.
public struct KitUnlockSync: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case code, invalid, working, failed
        case startOverFailed = "start-over-failed"
        case noCode = "no-code"
        case startOver = "start-over"
    }

    public var step: Step
    public var nearby: Bool?

    public init(step: Step, nearby: Bool? = nil) {
        self.step = step
        self.nearby = nearby
    }
}

/// RecoveryCode. The code is never an input: the kit draws it from the host, once.
public struct KitRecoveryCode: Sendable, Codable, Equatable, Hashable {
    public var saved: Bool?

    public init(saved: Bool? = nil) { self.saved = saved }
}

/// RingChange: `by` is the device that wrapped (`changed.by`), `served` the ring the person was
/// shown (`changed.served`), the one value `acceptRingChange` takes.
public struct KitRingChange: Sendable, Codable, Equatable, Hashable {
    public struct Ring: Sendable, Codable, Equatable, Hashable {
        public var ringId: String
        public var epoch: Int
        public var rootKid: String

        public init(ringId: String, epoch: Int, rootKid: String) {
            self.ringId = ringId
            self.epoch = epoch
            self.rootKid = rootKid
        }
    }

    public var by: String?
    public var served: Ring?
    /// Accepting did not open a root: the screen says so; Accept stays available.
    public var failed: Bool?

    public init(by: String? = nil, served: Ring? = nil, failed: Bool? = nil) {
        self.by = by
        self.served = served
        self.failed = failed
    }
}

// MARK: - The inputs

/// Where Add your name and email goes (UK-43): `portal` for a kit with no in-app channel.
public enum KitAddIn: String, Sendable, Codable, CaseIterable {
    case portal, app
}

/// Who holds the license that just activated. Empty email: floating, held by the key alone; set:
/// waiting for that email to sign in (screens show it masked, `KitFormat.maskEmail`).
public struct KitLicenseHolder: Sendable, Codable, Equatable, Hashable {
    public var email: String?
    public var addIn: KitAddIn?

    public init(email: String? = nil, addIn: KitAddIn? = nil) {
        self.email = email
        self.addIn = addIn
    }
}

/// ActivateDone's display facts (strings its supplier formatted).
public struct KitActivateDone: Sendable, Codable, Equatable, Hashable {
    public var tier: String?
    public var term: String?
    public var deviceKind: String?
    public var position: Int?
    public var limit: Int?
    /// The person came back from AddToAccount (Cancel): focus returns to the control that opened it.
    public var returned: Bool?
    /// Wins over `licenseHolder.addIn` here.
    public var addIn: KitAddIn?
    /// The channel is still being read: the action shows busy until it is known.
    public var addBusy: Bool?

    public init(
        tier: String? = nil, term: String? = nil, deviceKind: String? = nil, position: Int? = nil,
        limit: Int? = nil, returned: Bool? = nil, addIn: KitAddIn? = nil, addBusy: Bool? = nil
    ) {
        self.tier = tier
        self.term = term
        self.deviceKind = deviceKind
        self.position = position
        self.limit = limit
        self.returned = returned
        self.addIn = addIn
        self.addBusy = addBusy
    }
}

/// AddToAccount's input: its step and the facts its lines name.
public struct KitAddToAccount: Sendable, Codable, Equatable, Hashable {
    public enum Step: String, Sendable, Codable, CaseIterable {
        case form, invalid, busy, added, owned
        case emailBound = "email-bound"
        case otherAccount = "other-account"
        case failed
    }

    public enum Field: String, Sendable, Codable, CaseIterable {
        case name, email, both
    }

    public var step: Step
    /// `invalid`: which field the person must fix.
    public var field: Field?
    public var deviceKind: String?
    /// `other-account`: the email typed and the one of the account that signed in, already masked.
    public var typedEmail: String?
    public var signedEmail: String?
    /// Opened from the app's Settings: `added` closes with Done.
    public var fromSettings: Bool?

    public init(
        step: Step, field: Field? = nil, deviceKind: String? = nil, typedEmail: String? = nil,
        signedEmail: String? = nil, fromSettings: Bool? = nil
    ) {
        self.step = step
        self.field = field
        self.deviceKind = deviceKind
        self.typedEmail = typedEmail
        self.signedEmail = signedEmail
        self.fromSettings = fromSettings
    }
}

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
    /// Milliseconds since the request a loading state waits on started (DL7). nil: the delay has
    /// passed. See `KitLoadingDelay`.
    public var elapsedMs: Double?
    public var keyField: KitKeyField?
    public var activation: KitActivation?
    public var offline: KitOffline?
    public var signIn: KitSignIn?
    /// The provider the person signed in with ("Apple", "Google"), named in the auto steps.
    public var provider: String?
    public var autoSignIn: KitAutoSignIn?
    /// nil: the account menu's entry.
    public var nearbyApproval: KitNearbyApproval?
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
    public var cloudSync: KitCloudSync?
    public var unlockSync: KitUnlockSync?
    public var recoveryCode: KitRecoveryCode?
    public var ringChange: KitRingChange?
    public var saveConflict: KitSaveConflict?
    public var licenseHolder: KitLicenseHolder?
    public var activateDone: KitActivateDone?
    public var addToAccount: KitAddToAccount?
    public var linkPairing: KitLinkPairing?
    public var transferOffer: KitTransferOffer?
    public var localPairing: KitLocalPairing?
    public var pairedDevices: KitPairedDevices?

    public init(
        integrator: KitIntegrator? = nil, presentation: KitPresentation? = nil,
        bundle: KitBundle = KitBundle(slug: ""), platform: KitPlatform = .current,
        services: Set<KitService>? = nil, registration: KitRegistration = .requiresLicense,
        capabilities: KitCapabilities = KitCapabilities(), stage: KitStage? = nil,
        gate: KitGate? = nil, pending: KitPending? = nil, loading: Bool? = nil,
        elapsedMs: Double? = nil, keyField: KitKeyField? = nil, activation: KitActivation? = nil,
        offline: KitOffline? = nil, signIn: KitSignIn? = nil, provider: String? = nil,
        autoSignIn: KitAutoSignIn? = nil, nearbyApproval: KitNearbyApproval? = nil,
        deviceCode: KitDeviceCode? = nil, choices: KitLicenseChoices? = nil,
        replaceView: KitReplaceView? = nil, selected: String? = nil, devices: [KitDevice]? = nil,
        browserMode: Bool? = nil, edit: KitEdit? = nil, saved: Bool? = nil,
        replacement: KitReplacement? = nil, update: KitUpdate? = nil,
        releaseNotes: [KitReleaseNote]? = nil, config: [KitConfigRow]? = nil,
        account: KitAccount? = nil, entitlement: KitEntitlement? = nil,
        offers: KitOffers? = nil, toast: KitToast? = nil, error: KitError? = nil,
        cloudSync: KitCloudSync? = nil, unlockSync: KitUnlockSync? = nil,
        recoveryCode: KitRecoveryCode? = nil, ringChange: KitRingChange? = nil,
        saveConflict: KitSaveConflict? = nil, licenseHolder: KitLicenseHolder? = nil,
        activateDone: KitActivateDone? = nil, addToAccount: KitAddToAccount? = nil,
        linkPairing: KitLinkPairing? = nil, transferOffer: KitTransferOffer? = nil,
        localPairing: KitLocalPairing? = nil, pairedDevices: KitPairedDevices? = nil
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
        self.elapsedMs = elapsedMs
        self.keyField = keyField
        self.activation = activation
        self.offline = offline
        self.signIn = signIn
        self.provider = provider
        self.autoSignIn = autoSignIn
        self.nearbyApproval = nearbyApproval
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
        self.cloudSync = cloudSync
        self.unlockSync = unlockSync
        self.recoveryCode = recoveryCode
        self.ringChange = ringChange
        self.saveConflict = saveConflict
        self.licenseHolder = licenseHolder
        self.activateDone = activateDone
        self.addToAccount = addToAccount
        self.linkPairing = linkPairing
        self.transferOffer = transferOffer
        self.localPairing = localPairing
        self.pairedDevices = pairedDevices
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
