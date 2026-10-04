// App Attest (P6-02): DCAppAttestService's generateKey, attestKey and generateAssertion, so a store
// build can prove to the Worker that it is a genuine install of this App ID on a real device
// (notes/E1 §F5).
//
//   app_attest_supported               sync   {supported}, or unsupported `runtime` off iOS
//   app_attest_attest {requestHash,     async  {keyId, attestation (standard base64), generated, ms}
//                      keyId?}
//   app_attest_assert {keyId,           async  {keyId, assertion (standard base64), ms}
//                      clientData}
//
// The client-data hash is SHA-256 over the UTF-8 bytes of the string the caller passes: the
// Worker's `requestHash` for an attestation (POST /<product>/devices/attest/challenge), the
// server-defined client data for an assertion. Without a `keyId` the attest op generates a key
// first (`generated: true`) and answers its id, which the caller stores.
//
// Keys die on reinstall, device migration and restore from a backup (Apple: "the keys ... don't
// survive"). A stored key the system no longer knows answers `{ok:false, error:"invalid_key",
// keyId}`: the caller drops it and attests again without a `keyId`. That is expected, not fraud.
// `server_unavailable` means Apple's attestation service did not answer: retry later with the SAME
// key (Apple's guidance), so the caller keeps it.
//
// Only iOS runs it: DCAppAttestService also exists on macOS 11+, but App Attest is an iOS and
// iPadOS service for this SDK (a Mac build stays basic, conformance/parity/features.json
// `devices.attest`). On iOS `isSupported` is false on the simulator and in most app extensions,
// which answers unsupported `runtime` too.

import Foundation

#if canImport(CryptoKit)
import CryptoKit
#endif

#if os(iOS) && canImport(DeviceCheck)
import DeviceCheck
#endif

/// One App Attest failure, typed. `code` is one of the `AppAttestFailure.*` constants.
public struct AppAttestFailure: Error, Sendable, Equatable {
    /// The key is unknown to the system (reinstall, migration, restore) or already unusable:
    /// drop it and attest again with a fresh key.
    public static let invalidKey = "invalid_key"
    /// The input was refused (an empty or malformed key id or hash).
    public static let invalidInput = "invalid_input"
    /// Apple's attestation service is unreachable: retry later with the same key.
    public static let serverUnavailable = "server_unavailable"
    /// App Attest is not supported here (DCError.featureUnsupported).
    public static let featureUnsupported = "feature_unsupported"
    /// Anything else DeviceCheck reported.
    public static let systemFailure = "system_failure"

    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// DCAppAttestService behind a seam (a fake in tests: `swift test` runs on macOS, where this SDK
/// never attests, and the simulator does not support App Attest).
public protocol AppAttestClient: Sendable {
    /// nil when App Attest can run here, else why not (reason `runtime`).
    func unavailable() -> PlatformUnavailable?
    func generateKey() async throws -> String
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data
}

/// No App Attest in this process (macOS, Linux, an iOS build without DeviceCheck).
public struct UnavailableAppAttestClient: AppAttestClient {
    public init() {}

    public func unavailable() -> PlatformUnavailable? {
        PlatformUnavailable(reason: "runtime", detail: "App Attest runs on iOS and iPadOS only.")
    }

    public func generateKey() async throws -> String { throw unavailable()! }
    public func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { throw unavailable()! }
    public func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data { throw unavailable()! }
}

#if os(iOS) && canImport(DeviceCheck)
/// DCAppAttestService.shared (iOS 14+; the package floor is iOS 17).
public struct SystemAppAttestClient: AppAttestClient {
    public init() {}

    public func unavailable() -> PlatformUnavailable? {
        DCAppAttestService.shared.isSupported
            ? nil
            : PlatformUnavailable(
                reason: "runtime", detail: "App Attest is not supported here (the simulator, or an app extension).")
    }

    public func generateKey() async throws -> String {
        do { return try await DCAppAttestService.shared.generateKey() } catch { throw Self.typed(error) }
    }

    public func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        do {
            return try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash)
        } catch { throw Self.typed(error) }
    }

    public func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        do {
            return try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash)
        } catch { throw Self.typed(error) }
    }

    static func typed(_ error: Error) -> AppAttestFailure {
        guard let dc = error as? DCError else {
            return AppAttestFailure(code: AppAttestFailure.systemFailure, message: "\(error)")
        }
        let code: String
        switch dc.code {
        case .invalidKey: code = AppAttestFailure.invalidKey
        case .invalidInput: code = AppAttestFailure.invalidInput
        case .serverUnavailable: code = AppAttestFailure.serverUnavailable
        case .featureUnsupported: code = AppAttestFailure.featureUnsupported
        default: code = AppAttestFailure.systemFailure
        }
        return AppAttestFailure(code: code, message: dc.localizedDescription)
    }
}
#endif

/// SHA-256 of the UTF-8 bytes of `clientData`, or nil where CryptoKit is absent (Linux; this
/// target is type-checked there, never run).
public func appAttestClientDataHash(_ clientData: String) -> Data? {
    #if canImport(CryptoKit)
    return Data(SHA256.hash(data: Data(clientData.utf8)))
    #else
    return nil
    #endif
}

/// The App Attest ops over one client.
struct AppAttestService: Sendable {
    let client: any AppAttestClient
    /// Apple's attestation service is a network call: bound it.
    var deadline: Double = 30

    func unsupported() -> PlatformObject? {
        guard let u = client.unavailable() else {
            if appAttestClientDataHash("") == nil {
                return PlatformHost.unsupported("runtime", "SHA-256 (CryptoKit) is not available here.")
            }
            return nil
        }
        return PlatformHost.unsupported(u.reason, u.detail)
    }

    func supported() -> PlatformObject {
        if let u = unsupported() { return u }
        return ["ok": true, "supported": true]
    }

    /// Attest `keyId` (generated first when nil) for the Worker's `requestHash`.
    func attest(requestHash: String, keyId: String?) async -> PlatformObject {
        let start = Date()
        guard let hash = appAttestClientDataHash(requestHash) else {
            return PlatformHost.unsupported("runtime", "SHA-256 (CryptoKit) is not available here.")
        }
        var id = keyId
        let generated = keyId == nil
        do {
            let client = self.client
            if id == nil {
                id = try await withPlatformDeadline(deadline) { try await client.generateKey() }
            }
            let key = id!
            let attestation = try await withPlatformDeadline(deadline) {
                try await client.attestKey(key, clientDataHash: hash)
            }
            return [
                "ok": true, "keyId": .string(key), "attestation": .string(attestation.base64EncodedString()),
                "generated": .bool(generated), "ms": .int(elapsedMs(since: start)),
            ]
        } catch {
            return failure(error, keyId: id, generated: generated, start: start)
        }
    }

    /// An assertion by `keyId` over SHA-256(UTF-8(`clientData`)).
    func assert(keyId: String, clientData: String) async -> PlatformObject {
        let start = Date()
        guard let hash = appAttestClientDataHash(clientData) else {
            return PlatformHost.unsupported("runtime", "SHA-256 (CryptoKit) is not available here.")
        }
        do {
            let client = self.client
            let assertion = try await withPlatformDeadline(deadline) {
                try await client.generateAssertion(keyId, clientDataHash: hash)
            }
            return [
                "ok": true, "keyId": .string(keyId), "assertion": .string(assertion.base64EncodedString()),
                "ms": .int(elapsedMs(since: start)),
            ]
        } catch {
            return failure(error, keyId: keyId, generated: false, start: start)
        }
    }

    private func failure(_ error: Error, keyId: String?, generated: Bool, start: Date) -> PlatformObject {
        var out: PlatformObject = ["ok": false, "ms": .int(elapsedMs(since: start)), "generated": .bool(generated)]
        if let keyId { out["keyId"] = .string(keyId) }
        switch error {
        case let f as AppAttestFailure:
            if f.code == AppAttestFailure.featureUnsupported {
                return PlatformHost.unsupported("runtime", f.message)
            }
            out["error"] = .string(f.code)
            out["message"] = .string(f.message)
        case let u as PlatformUnavailable:
            return PlatformHost.unsupported(u.reason, u.detail)
        case is PlatformTimeout:
            out["error"] = "timeout"
        default:
            out["error"] = .string(AppAttestFailure.systemFailure)
            out["message"] = .string("\(error)")
        }
        return out
    }
}
