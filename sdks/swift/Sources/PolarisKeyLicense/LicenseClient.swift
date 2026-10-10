// The License sub-client — activation, entitlements, and the gate (wire contract v3 §5).
//
// ── WHAT THE GATE READS, AND WHERE EACH INPUT COMES FROM ────────────────────────────────────
//
// `status()` is a pure call into `licenseState`; everything interesting is in assembling its
// inputs, and each one comes from exactly one owner:
//
//   licenseServiceEnabled  Core's resolved capabilities (discovery → expectedServices →
//                          default). FALSE short-circuits the machine to `notApplicable` with
//                          `isUsable: true`, which is how a config-only product boots usable
//                          instead of sitting on `needs-activation` forever (D-08).
//   activation             `.token` if a `pkeyt_` credential is held, else `.bundle` if a
//                          verified offline import left a license document, else nil. A token
//                          SUPERSEDES a bundle (§7): once the device is online-activated the
//                          bundle is history.
//   doc / highWaterMark    the re-verified cache and the monotonic floor, both Core's.
//   blocked / lastSync…    unsigned hints that can only ever make the gate STRICTER (§4.1).
//
// ── ACTIVATION RAISES AN EVENT, IT DOES NOT SYNC ────────────────────────────────────────────
//
// v2 called `refresh()` inline from every mint path, which meant each one had to remember to,
// and a config-only product had no way to say "there is no licence here, sync anyway". Here the
// credential is stored and an event is raised; the facade decides what a fresh credential means.

import Foundation
import PolarisKeyCore

public struct LicenseClientOptions: Sendable {
    /// Collect a hardware fingerprint at activation. Defaults to true; set false to opt out
    /// entirely (the server then records this device as `unverified` rather than refusing it).
    public let fingerprint: Bool

    public init(fingerprint: Bool = true) {
        self.fingerprint = fingerprint
    }
}

/// Raised after a credential is minted, so the facade can sync without every activation path
/// having to remember to.
/// `licenseInfo()`: the verified licence, summarised (notes/SDK-PARITY-PASS.md §3.3).
public struct LicenseInfo: Sendable, Equatable {
    static let tierKey = "license.tier"
    static let tierLabelKey = "license.tierLabel"
    static let deviceLimitKey = "deviceLimit"

    public let licenseId: String
    /// The tier id (`license.tier`), when the licence document carries one.
    public let tier: String?
    /// The tier's display name (`license.tierLabel`).
    public let tierLabel: String?
    /// The seat limit (`deviceLimit`).
    public let deviceLimit: Int?
    /// The document's own expiry and grace end, epoch seconds. (A licence-level expiry arrives
    /// with licence document v2, LX-17.)
    public let expiresAt: Int
    public let graceUntil: Int
    public let profile: DocProfile?
    public let entitledChannels: [String]

    public init(
        licenseId: String, tier: String?, tierLabel: String?, deviceLimit: Int?, expiresAt: Int,
        graceUntil: Int, profile: DocProfile?, entitledChannels: [String]
    ) {
        self.licenseId = licenseId
        self.tier = tier
        self.tierLabel = tierLabel
        self.deviceLimit = deviceLimit
        self.expiresAt = expiresAt
        self.graceUntil = graceUntil
        self.profile = profile
        self.entitledChannels = entitledChannels
    }
}

public typealias LicenseAcquiredListener = @Sendable (ActivationSource) async -> Void
/// Raised after `deactivate()` ran (whether or not the local wipe succeeded: either way the
/// licence state may have changed), so a facade can emit its `license` event.
public typealias LicenseReleasedListener = @Sendable () async -> Void

public actor LicenseClient {
    private let core: CoreContext
    private let fingerprintEnabled: Bool
    private let onAcquired: LicenseAcquiredListener?
    private let onReleased: LicenseReleasedListener?

    public init(
        core: CoreContext,
        options: LicenseClientOptions = LicenseClientOptions(),
        onAcquired: LicenseAcquiredListener? = nil,
        onReleased: LicenseReleasedListener? = nil
    ) {
        self.core = core
        self.fingerprintEnabled = options.fingerprint
        self.onAcquired = onAcquired
        self.onReleased = onReleased
    }

    // ── Gate ─────────────────────────────────────────────────────────────────────────────
    /// How this install became activated, or nil. §7: a token supersedes a bundle.
    public func activation() async -> ActivationSource? {
        if await core.token != nil { return .token }
        let cache = await core.cache()
        // A bundle activates ONLY if its licence document actually verified — a config-only
        // bundle imports settings and grants nothing.
        if cache.bundle?.activates == true, cache.license != nil { return .bundle }
        return nil
    }

    public func status(now: Int? = nil) async -> LicenseState {
        let cache = await core.cache()
        return licenseState(
            GateInput(
                licenseServiceEnabled: await core.licenseGateEnabled(),
                activation: await activation(),
                doc: cache.license?.doc,
                now: await core.now(now),
                highWaterMark: await core.highWaterMark,
                lastSyncUnauthorized: cache.lastSyncUnauthorized,
                blocked: cache.blocked.map(BlockInfo.init),
                lastVerifiedAt: cache.lastVerifiedAt))
    }

    public func isLicensed(now: Int? = nil) async -> Bool {
        isUsable(await status(now: now))
    }

    // ── Reads off the license document ───────────────────────────────────────────────────
    private func doc() async -> LicenseDoc? {
        await core.cache().license?.doc
    }

    /// True iff the gate is usable AND the named entitlement is present with `value == true`.
    ///
    /// S-19 G11: a revoked, expired, blocked or never-activated install answers false even while a
    /// cached document still lists the flag. (Before this it read the cached document alone, so a
    /// revoked licence kept unlocking its features until the cache was cleared.)
    public func isEntitled(_ name: String, now: Int? = nil) async -> Bool {
        guard isUsable(await status(now: now)) else { return false }
        return await doc()?.entitlements[name]?.value.boolValue == true
    }

    /// The raw value of an entitlement (a tier string, a seat count, a channel list), or nil
    /// when absent. Gated like `isEntitled`: nil while the gate is not usable.
    public func entitlementValue(_ name: String, now: Int? = nil) async -> JSONValue? {
        guard isUsable(await status(now: now)) else { return nil }
        return await doc()?.entitlements[name]?.value
    }

    /// A summary of the verified licence for an account or settings screen, or nil when no
    /// licence document is held. Read from the enforced entitlements the Worker signs
    /// (`license.tier`, `license.tierLabel`, `deviceLimit`, `channels`).
    public func licenseInfo() async -> LicenseInfo? {
        guard let doc = await doc() else { return nil }
        let e = doc.entitlements
        return LicenseInfo(
            licenseId: doc.licenseId,
            tier: e[LicenseInfo.tierKey]?.value.stringValue,
            tierLabel: e[LicenseInfo.tierLabelKey]?.value.stringValue,
            deviceLimit: e[LicenseInfo.deviceLimitKey]?.value.intValue,
            expiresAt: doc.expiresAt, graceUntil: doc.graceUntil, profile: doc.profile,
            entitledChannels: await entitledChannels())
    }

    public func entitlements() async -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (key, entry) in await doc()?.entitlements ?? [:] { out[key] = entry.value }
        return out
    }

    /// The signed greeting block, or nil. Signed so it cannot be spoofed locally.
    public func profile() async -> DocProfile? {
        await doc()?.profile
    }

    public func licenseId() async -> String? {
        await doc()?.licenseId
    }

    /// The channels this licence grants: the `channels` entitlement's string values, in order,
    /// as granted — or `["stable"]` when the entitlement is absent or not an array. This is the
    /// Worker's own answer (`entitledChannels` in core/entitlements.ts) and the same list every
    /// SDK returns for the same document; before P1b-07 this SDK answered `[]` for an absent
    /// entitlement, which disagreed with the Worker it gates against.
    ///
    /// The grants are RAW: `staging` is not rewritten to `beta` here. Whether a grant covers a
    /// channel is the entitlement rule's question (WIRE-CONTRACT-V3 §5.1 rule 4), not this
    /// list's. `PolarisKeyUpdate`'s `allowedChannels(from:)` derives Sparkle's channel set from
    /// the same entitlement and already treats an absent one as stable only.
    public func entitledChannels() async -> [String] {
        guard let value = await doc()?.entitlements["channels"]?.value,
            let array = value.arrayValue
        else { return [CHANNEL_STABLE] }
        return array.compactMap(\.stringValue)
    }

    // ── Activation ───────────────────────────────────────────────────────────────────────
    private func fingerprint() -> HardwareFingerprint? {
        guard fingerprintEnabled else { return nil }
        return Fingerprint.collect(productSlug: core.product)
    }

    /// Obtain a licence with no key and no sign-in, when the product offers a free tier.
    @discardableResult
    public func enroll() async -> ActivationResult {
        await acquire(LicenseEndpoints.enroll(core, fingerprint: fingerprint()), source: .enroll)
    }

    /// Exchange a licence key for a per-device token.
    @discardableResult
    public func activate(key: String) async -> ActivationResult {
        await acquire(
            LicenseEndpoints.activate(core, key: key, fingerprint: fingerprint()), source: .activate)
    }

    /// Persist a freshly issued token, then raise the acquisition event.
    ///
    /// A failed token write is reported, not swallowed: it used to return `.ok` having stored
    /// nothing, so the app looked activated until the next launch (R4-12).
    private func acquire(_ result: ActivationResult, source: TokenSource) async -> ActivationResult {
        guard case .ok(let token, _) = result else { return result }
        do {
            try await core.setToken(token, source: source)
        } catch {
            return .error(code: ErrorCode.storeFailed, message: "could not persist the device token: \(error)")
        }
        await onAcquired?(.token)
        return result
    }

    /// Deauthorize this device and wipe every local credential and artifact.
    ///
    /// The network call is best-effort and the local wipe is not: a device deactivating on a
    /// plane must not be left holding a token because the control plane was unreachable.
    ///
    /// Raises the licence change (`onReleased`) when it returns or throws, so `client.events`
    /// carries the `license` event whichever entry point released the seat.
    public func deactivate() async throws {
        do {
            if let token = await core.token {
                await LicenseEndpoints.deauthorize(core, token: token)
            }
            try await core.clearAll()
        } catch {
            await onReleased?()
            throw error
        }
        await onReleased?()
    }
}
