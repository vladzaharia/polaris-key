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
public typealias LicenseAcquiredListener = @Sendable (ActivationSource) async -> Void

public actor LicenseClient {
    private let core: CoreContext
    private let fingerprintEnabled: Bool
    private let onAcquired: LicenseAcquiredListener?

    public init(
        core: CoreContext,
        options: LicenseClientOptions = LicenseClientOptions(),
        onAcquired: LicenseAcquiredListener? = nil
    ) {
        self.core = core
        self.fingerprintEnabled = options.fingerprint
        self.onAcquired = onAcquired
    }

    // ── Gate ─────────────────────────────────────────────────────────────────────────────
    /// How this install became activated, or nil. §7: a token supersedes a bundle.
    public func activation() async -> ActivationSource? {
        if await core.token != nil { return .token }
        let cache = await core.cache()
        // A bundle activates ONLY if its licence document actually verified — a config-only
        // bundle imports settings and grants nothing.
        if cache.importedBundle != nil, cache.license != nil { return .bundle }
        return nil
    }

    public func status(now: Int? = nil) async -> LicenseState {
        let cache = await core.cache()
        return licenseState(
            GateInput(
                licenseServiceEnabled: await core.enabled(.license),
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

    /// True iff the named entitlement is present and `value == true`.
    public func isEntitled(_ name: String) async -> Bool {
        await doc()?.entitlements[name]?.value.boolValue == true
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

    /// The channels this licence grants, from the `channels` entitlement. The source of truth
    /// `PolarisKeyUpdate` derives `allowedChannels` from.
    public func entitledChannels() async -> [String] {
        guard let value = await doc()?.entitlements["channels"]?.value,
            let array = value.arrayValue
        else { return [] }
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
        await acquire(LicenseEndpoints.enroll(core, fingerprint: fingerprint()))
    }

    /// Exchange a licence key for a per-device token.
    @discardableResult
    public func activate(key: String) async -> ActivationResult {
        await acquire(LicenseEndpoints.activate(core, key: key, fingerprint: fingerprint()))
    }

    /// Persist a freshly issued token, then raise the acquisition event.
    ///
    /// A failed token write is reported, not swallowed: it used to return `.ok` having stored
    /// nothing, so the app looked activated until the next launch (R4-12).
    private func acquire(_ result: ActivationResult) async -> ActivationResult {
        guard case .ok(let token, _) = result else { return result }
        do {
            try await core.setToken(token)
        } catch {
            return .error(message: "could not persist the device token: \(error)")
        }
        await onAcquired?(.token)
        return result
    }

    /// Deauthorize this device and wipe every local credential and artifact.
    ///
    /// The network call is best-effort and the local wipe is not: a device deactivating on a
    /// plane must not be left holding a token because the control plane was unreachable.
    public func deactivate() async throws {
        if let token = await core.token {
            await LicenseEndpoints.deauthorize(core, token: token)
        }
        try await core.clearAll()
    }
}
