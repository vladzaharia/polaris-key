// `client.devices` — the device roster (§6) and App Attest (P6-02, notes/SDK-PARITY-PASS.md
// §3.10).
//
//   list() / current()        the roster, blended with this device's locally derived state
//   rename(_:label:)          PATCH /<p>/devices/:id (self only, enforced server-side)
//   deauthorize(_:)           DELETE /<p>/devices/:id; THIS device is a full local deactivation
//   attest()                  POST devices/attest/challenge → DCAppAttestService.attestKey with
//                             clientDataHash = SHA-256(UTF-8(requestHash)) → POST devices/attest;
//                             the key id is kept in the Keychain and a key the system no longer
//                             knows (reinstall, migration, restore) is dropped and a fresh one
//                             attested in the same call.
//
// `attest()` answers a typed N/A wherever it cannot run (PARITY §2.2): `runtime` on macOS and
// where App Attest does not run (the simulator, most extensions), `outlet` on an iOS build that is
// not an App Store or TestFlight install (it carries an embedded provisioning profile). The
// device then simply stays at the `basic` trust level, which is expected, not suspicious.
//
// When attestation can run here the facade registers `attest()` as Core's attestor, so a call
// refused with 403 `attestation_required` (edge-mint, a commerce claim) attests once and retries
// once (§3.10).

import Foundation
import PolarisKeyCore
import PolarisKeyLicense
import PolarisKeyPlatform

/// Where `attest()` keeps the App Attest key id. The default is the Keychain
/// (`SecureStore`, service `pkey:<product>`, account `app_attest_key` — the account Godot's
/// `PKeyApple` uses); tests inject a memory store.
public protocol AttestKeyStore: Sendable {
    func get() -> String?
    func set(_ keyId: String)
    func delete()
}

/// The Keychain-backed key store.
public struct KeychainAttestKeyStore: AttestKeyStore {
    public static let account = "app_attest_key"
    private let store: SecureStore

    public init(product: String, backend: any KeychainBackend = SystemKeychainBackend()) {
        self.store = SecureStore(product: product, backend: backend)
    }

    public func get() -> String? { store.get(account: Self.account)["value"]?.stringValue }
    public func set(_ keyId: String) { _ = store.set(account: Self.account, value: keyId) }
    public func delete() { _ = store.delete(account: Self.account) }
}

/// `attest()`'s success: the trust level the Worker recorded.
public struct AttestOutcome: Sendable, Equatable {
    public let trustLevel: String
    public let kind: String
    /// Epoch seconds, or 0 when the answer omitted it.
    public let attestedAt: Int

    public init(trustLevel: String, kind: String, attestedAt: Int) {
        self.trustLevel = trustLevel
        self.kind = kind
        self.attestedAt = attestedAt
    }
}

/// How `attest()` ended.
public enum AttestResult: Sendable, Equatable {
    case attested(AttestOutcome)
    /// The typed N/A: `runtime` or `outlet` (PARITY §2.2).
    case unsupported(Unsupported)
    /// The Worker refused: `unauthorized`, `rate_limited`, `attestation_unavailable`,
    /// `attestation_rejected`, …, verbatim.
    case refused(code: String, status: Int, message: String?)
    /// No usable answer, or App Attest itself failed: `network`, `invalid-response`,
    /// `platform-error`, `timeout`, `no-token`, `local-only`.
    case error(code: String, message: String)

    public var isAttested: Bool {
        if case .attested = self { return true }
        return false
    }

    /// The code: `""` when attested, the reason's feature-scoped `unsupported` otherwise.
    public var code: String {
        switch self {
        case .attested: return ""
        case .unsupported: return ErrorCode.unsupported
        case .refused(let code, _, _), .error(let code, _): return code
        }
    }
}

/// The App Attest options a host can override (tests, or a build that knows better).
public struct AttestOptions: Sendable {
    /// DCAppAttestService behind its seam. nil: the system client on iOS, none elsewhere.
    public var client: (any AppAttestClient)?
    /// The key id store. nil: the Keychain.
    public var keyStore: (any AttestKeyStore)?
    /// Why this install may not attest (`outlet`), or nil when it may. nil: an iOS build that
    /// carries an embedded provisioning profile is not an App Store or TestFlight install.
    public var outletCheck: (@Sendable () -> String?)?

    public init(
        client: (any AppAttestClient)? = nil, keyStore: (any AttestKeyStore)? = nil,
        outletCheck: (@Sendable () -> String?)? = nil
    ) {
        self.client = client
        self.keyStore = keyStore
        self.outletCheck = outletCheck
    }
}

public final class DevicesClient: Sendable {
    private let core: CoreContext
    private let license: LicenseClient
    private let attestClient: any AppAttestClient
    private let keyStore: any AttestKeyStore
    private let outletCheck: @Sendable () -> String?
    private let events: PolarisEventHub?

    public init(
        core: CoreContext, license: LicenseClient, attest options: AttestOptions = AttestOptions(),
        events: PolarisEventHub? = nil
    ) {
        self.core = core
        self.events = events
        self.license = license
        self.attestClient = options.client ?? DevicesClient.systemAttestClient()
        self.keyStore = options.keyStore ?? KeychainAttestKeyStore(product: core.product)
        self.outletCheck = options.outletCheck ?? DevicesClient.defaultOutletCheck
    }

    static func systemAttestClient() -> any AppAttestClient {
        #if os(iOS) && canImport(DeviceCheck)
            return SystemAppAttestClient()
        #else
            return UnavailableAppAttestClient()
        #endif
    }

    /// An embedded provisioning profile means a development, ad-hoc or enterprise build, which
    /// App Attest's production environment does not vouch for.
    @Sendable static func defaultOutletCheck() -> String? {
        #if os(iOS)
            if BundleEvidence.mainBundle().provisioned {
                return "Only an App Store or TestFlight install can attest (this build carries a provisioning profile); it stays at the basic trust level."
            }
        #endif
        return nil
    }

    // ── Roster ───────────────────────────────────────────────────────────────────────────
    /// This device, from locally verified state.
    public func current() async -> DeviceInfo {
        let cache = await core.cache()
        return DeviceInfo(
            id: await core.deviceId,
            current: true,
            status: await license.status().status,
            licenseId: cache.license?.doc.licenseId,
            profile: cache.license?.doc.profile,
            lastVerifiedAt: cache.lastVerifiedAt)
    }

    /// The device roster, blended with this device's locally derived state. Without a credential
    /// (or offline, or local-only) the answer is THIS DEVICE ALONE, which is the honest answer.
    public func list() async -> [DeviceInfo] {
        let current = await current()
        guard let roster = try? await core.listDevices(), !roster.isEmpty else {
            return [current]
        }
        return roster.map { device in
            let isCurrent = device.current ?? (device.id == current.id)
            return DeviceInfo(
                id: device.id,
                current: isCurrent,
                // Only THIS device's status is derived from a signature we checked.
                status: isCurrent ? current.status : .ok,
                licenseId: device.licenseId ?? (isCurrent ? current.licenseId : nil),
                profile: isCurrent ? current.profile : nil,
                lastVerifiedAt: isCurrent ? current.lastVerifiedAt : nil,
                label: device.label,
                platform: device.platform, appVersion: device.appVersion,
                lastSeen: device.lastSeen)
        }
    }

    /// Rename a device (self only, enforced server-side). Throws `PolarisError`.
    public func rename(_ deviceId: String, label: String?) async throws {
        try await core.renameDevice(deviceId, label: label)
    }

    /// Release a device's seat. THIS device is a full local deactivation.
    public func deauthorize(_ deviceId: String) async throws {
        if deviceId == (await core.deviceId) {
            try await license.deactivate()
            events?.emit(.license(await license.status()))
            return
        }
        try await core.deauthorizeDevice(deviceId)
    }

    // ── App Attest ───────────────────────────────────────────────────────────────────────
    /// Whether `attest()` can run here, as `supports(devices.attest)` would answer it.
    public func attestSupport() -> Support {
        let feature = Feature.devicesAttest
        if let u = attestClient.unavailable() {
            return .unsupported(Unsupported(feature: feature, reason: u.reason, detail: u.detail))
        }
        if let why = outletCheck() {
            return .unsupported(
                Unsupported(feature: feature, reason: UnsupportedReason.outlet, detail: why))
        }
        return .supported(feature: feature)
    }

    /// Raise this device to trust level `attested` (P6-02). See the file header for the flow.
    public func attest() async -> AttestResult {
        if case .unsupported(let u) = attestSupport() { return .unsupported(u) }
        guard let token = await core.token else {
            return .error(code: ErrorCode.noToken, message: "Activate or register before attesting.")
        }
        let auth = ["authorization": "Bearer \(token)"]

        let challengeResponse: PolarisResponse
        do {
            challengeResponse = try await core.request(
                core.endpoints.url("devices/attest/challenge"), method: "POST", headers: auth)
        } catch {
            return Self.transportFailure(error)
        }
        guard challengeResponse.isOK else { return Self.refusal(challengeResponse) }
        guard
            let ch = try? JSONDecoder().decode(ChallengeBody.self, from: challengeResponse.body),
            !ch.challenge.isEmpty, !ch.requestHash.isEmpty
        else {
            return .error(
                code: ErrorCode.invalidResponse,
                message: "The attestation challenge has no challenge or requestHash.")
        }

        let attested: (keyId: String, attestation: Data)
        switch await appAttest(requestHash: ch.requestHash) {
        case .success(let value): attested = value
        case .failure(let failure): return failure.result
        }

        let body = try? JSONEncoder().encode([
            "kind": "app-attest", "keyId": attested.keyId,
            "attestation": attested.attestation.base64EncodedString(), "challenge": ch.challenge,
        ])
        let response: PolarisResponse
        do {
            response = try await core.request(
                core.endpoints.url("devices/attest"), method: "POST",
                headers: auth.merging(["content-type": "application/json"]) { a, _ in a },
                body: body)
        } catch {
            return Self.transportFailure(error)
        }
        guard response.isOK else { return Self.refusal(response) }
        guard let out = try? JSONDecoder().decode(AttestBody.self, from: response.body) else {
            return .error(
                code: ErrorCode.invalidResponse, message: "The attestation answer has no trustLevel.")
        }
        return .attested(
            AttestOutcome(
                trustLevel: out.trustLevel, kind: out.kind ?? "app-attest",
                attestedAt: out.attestedAt ?? 0))
    }

    /// App Attest with the stored key id, re-attesting with a fresh key when the stored one is
    /// gone. A key that exists afterwards is kept: the attested one, or a generated one whose
    /// attestation Apple's service could not serve yet (retried later with the same key).
    private func appAttest(requestHash: String) async
        -> Result<(keyId: String, attestation: Data), AttestFailure>
    {
        guard let hash = appAttestClientDataHash(requestHash) else {
            return .failure(
                AttestFailure(
                    .unsupported(
                        Unsupported(
                            feature: Feature.devicesAttest, reason: UnsupportedReason.runtime,
                            detail: "SHA-256 (CryptoKit) is not available here."))))
        }
        var stored = keyStore.get()
        for attempt in 0..<2 {
            var keyId = stored
            do {
                if keyId == nil { keyId = try await attestClient.generateKey() }
                let attestation = try await attestClient.attestKey(keyId!, clientDataHash: hash)
                if keyId != stored { keyStore.set(keyId!) }
                return .success((keyId!, attestation))
            } catch let f as AppAttestFailure {
                if f.code == AppAttestFailure.invalidKey && stored != nil && attempt == 0 {
                    // The key died with a reinstall, a device migration or a restore: expected.
                    keyStore.delete()
                    stored = nil
                    continue
                }
                if f.code == AppAttestFailure.serverUnavailable, let keyId, keyId != stored {
                    keyStore.set(keyId)
                }
                if f.code == AppAttestFailure.featureUnsupported {
                    return .failure(
                        AttestFailure(
                            .unsupported(
                                Unsupported(
                                    feature: Feature.devicesAttest,
                                    reason: UnsupportedReason.runtime, detail: f.message))))
                }
                return .failure(
                    AttestFailure(.error(code: ErrorCode.platformError, message: "\(f.code): \(f.message)")))
            } catch let u as PlatformUnavailable {
                return .failure(
                    AttestFailure(
                        .unsupported(
                            Unsupported(
                                feature: Feature.devicesAttest, reason: u.reason, detail: u.detail))))
            } catch {
                return .failure(AttestFailure(.error(code: ErrorCode.platformError, message: "\(error)")))
            }
        }
        return .failure(
            AttestFailure(.error(code: ErrorCode.platformError, message: "App Attest did not produce a key.")))
    }

    private struct AttestFailure: Error {
        let result: AttestResult
        init(_ result: AttestResult) { self.result = result }
    }

    private static func transportFailure(_ error: Error) -> AttestResult {
        if let p = error as? PolarisError, p.code == PolarisError.localOnly {
            return .error(code: p.code, message: p.message)
        }
        return .error(code: ErrorCode.network, message: "\(error)")
    }

    static func refusal(_ response: PolarisResponse) -> AttestResult {
        let body = try? JSONDecoder().decode(ServerErrorBody.self, from: response.body)
        if response.status >= 500 {
            return .error(
                code: ErrorCode.serverError,
                message: body?.message ?? "status \(response.status)")
        }
        return .refused(
            code: body?.code ?? ErrorCode.httpError, status: response.status,
            message: body?.message)
    }
}

private struct ChallengeBody: Decodable {
    let challenge: String
    let requestHash: String
}

private struct AttestBody: Decodable {
    let trustLevel: String
    let kind: String?
    let attestedAt: Int?
}

/// An error body in either spelling (flat `{"error":"code"}` or nested `{"error":{"code":…}}`),
/// plus the `reason` and `message` beside it.
struct ServerErrorBody: Decodable {
    let code: String?
    let reason: String?
    let message: String?

    private enum CodingKeys: String, CodingKey { case error, reason, message }
    private struct Nested: Decodable {
        let code: String?
        let reason: String?
        let message: String?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let flat = try? c.decode(String.self, forKey: .error)
        let nested = flat == nil ? try? c.decode(Nested.self, forKey: .error) : nil
        code = flat ?? nested?.code
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nested?.reason
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? nested?.message
    }
}
