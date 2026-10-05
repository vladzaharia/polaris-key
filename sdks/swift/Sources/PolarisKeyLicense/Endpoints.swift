// The License service's HTTP surface — `POST /<p>/license/{activate,enroll,token,deauthorize}`
// (§R1, wire contract v3 §5).
//
// Pure transport: it builds the request, maps the status ladder, and hands back a result.
// Verification, caching and the gate live elsewhere on purpose — an HTTP layer that verified
// would be an HTTP layer that could be talked into not verifying. `GET /license/document` is
// NOT here: it is one of the two documents Core's `sync()` drives through identical machinery,
// so its route lives in `Endpoints` and its status ladder in `CoreContext.getDocument`.
//
// Every call goes through `CoreContext.request`, so the seven `X-PKey-*` headers and the
// deadline arrive automatically and a new endpoint cannot ship without them (R4-08).
//
// ── WHY THE ERROR READER LOOKS AT TWO SHAPES ────────────────────────────────────────────────
//
// The Worker emits two envelopes. Routes that MOVED but did not change keep the flat v2 shape
// (`{"error":"device_limit","limit":3}`); genuinely new v3 surfaces use the nested one
// (`{"error":{"code":…}}`). A 403 that means "device limit" and a 403 that means "fingerprint
// required" are different outcomes for the caller, and guessing between them would be worse
// than reading both spellings.

import Foundation
import PolarisKeyCore

/// The outcome of an activation-like call (`/license/{activate,enroll,token}`).
public enum ActivationResult: Sendable, Equatable {
    case ok(token: String, schemaVersion: Int)
    case deviceLimit(limit: Int?, deviceCount: Int?)
    case unauthorized
    /// The tier requires a hardware fingerprint this host could not produce.
    case fingerprintRequired
    /// Hardware drifted past the tier's tolerance; the binding was retired. Retrying activation
    /// re-binds the new hardware and consumes a seat. (The Worker answers 409, not 403,
    /// precisely because it is retryable.)
    case hardwareMismatch(drift: Int?, changed: [String]?)
    /// The product does not offer keyless enrollment — surfaced from a 404, which the Worker
    /// uses deliberately to hide the route rather than admit it exists and is closed.
    case enrollDisabled
    case error(message: String)
}

public enum LicenseEndpoints {
    /// `POST /<p>/license/activate` — exchange a licence key for a per-device `pkeyt_` token.
    public static func activate(
        _ core: CoreContext, key: String, fingerprint: HardwareFingerprint? = nil
    ) async -> ActivationResult {
        // PX-W13 §8 Q2: the label seeds the device's name in the customer's and console's lists.
        await activationLike(
            core, url: core.endpoints.licenseActivate,
            extra: ["authorization": "Bearer \(key)"], fingerprint: fingerprint,
            deviceName: await core.deviceLabel())
    }

    /// `POST /<p>/license/enroll` — obtain a licence with no key and no sign-in. Returns the
    /// same shape `activate` does, so callers need no new branching.
    public static func enroll(
        _ core: CoreContext, fingerprint: HardwareFingerprint? = nil
    ) async -> ActivationResult {
        await activationLike(
            core, url: core.endpoints.licenseEnroll, extra: [:], fingerprint: fingerprint)
    }

    /// `POST /<p>/license/token` — rotate the current device token. The §5 single re-acquire.
    public static func reacquireToken(
        _ core: CoreContext, token: String
    ) async -> ActivationResult {
        await activationLike(
            core, url: core.endpoints.licenseToken,
            extra: ["authorization": "Bearer \(token)"], fingerprint: nil)
    }

    /// `POST /<p>/license/deauthorize` — release this device's seat.
    ///
    /// Best-effort: the LOCAL wipe is what the caller actually depends on, and a device that
    /// deactivates on a plane must not be left holding credentials because the server was
    /// unreachable. That includes the local-only refusal (§7.3), which is swallowed here for
    /// the same reason being offline is.
    public static func deauthorize(_ core: CoreContext, token: String) async {
        _ = try? await core.request(
            core.endpoints.licenseDeauthorize, method: "POST",
            headers: ["authorization": "Bearer \(token)"])
    }

    /// The three mint/rotate endpoints share a response ladder, so they share a reader.
    private static func activationLike(
        _ core: CoreContext, url: URL, extra: [String: String],
        fingerprint: HardwareFingerprint?, deviceName: String? = nil
    ) async -> ActivationResult {
        var headers = extra
        var body: Data?
        // The body is omitted entirely when there is neither a fingerprint nor a label, so a host
        // that opted out sends a byte-identical request to one that has nothing to report.
        if fingerprint != nil || deviceName != nil,
            let encoded = try? JSONEncoder().encode(
                ActivationFingerprintBody(fingerprint, deviceName: deviceName))
        {
            headers["content-type"] = "application/json"
            body = encoded
        }

        let response: PolarisResponse
        do {
            response = try await core.request(url, method: "POST", headers: headers, body: body)
        } catch let error as PolarisError {
            return .error(message: error.message)
        } catch {
            return .error(message: error.localizedDescription)
        }

        switch response.status {
        case 200:
            guard let ok = try? JSONDecoder().decode(ActivationOkBody.self, from: response.body)
            else { return .error(message: "malformed activation response") }
            return .ok(token: ok.token, schemaVersion: ok.schemaVersion)
        case 409:
            let body = try? JSONDecoder().decode(HardwareMismatchBody.self, from: response.body)
            return .hardwareMismatch(
                drift: body?.drift ?? body?.error?.drift,
                changed: body?.changed ?? body?.error?.changed)
        case 403:
            let body = try? JSONDecoder().decode(ForbiddenBody.self, from: response.body)
            if body?.code == "fingerprint_required" { return .fingerprintRequired }
            return .deviceLimit(
                limit: body?.limit ?? body?.error?.limit,
                deviceCount: body?.deviceCount ?? body?.error?.deviceCount)
        case 401:
            return .unauthorized
        case 404:
            return .enrollDisabled
        default:
            return .error(message: String(decoding: response.body, as: UTF8.self))
        }
    }
}

private struct ActivationOkBody: Decodable {
    let token: String
    let schemaVersion: Int
}

/// The 409 body in BOTH spellings. `error` is a bare CODE STRING in the flat shape the moved
/// routes kept, and an object in the nested v3 one — so it is decoded permissively rather than
/// typed, since a decoder that threw on the string form would lose the `drift`/`changed` detail
/// sitting beside it at the top level.
private struct HardwareMismatchBody: Decodable {
    struct Nested: Decodable {
        let drift: Int?
        let changed: [String]?
    }
    let drift: Int?
    let changed: [String]?
    let error: Nested?

    private enum CodingKeys: String, CodingKey {
        case error, drift, changed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        drift = try c.decodeIfPresent(Int.self, forKey: .drift)
        changed = try c.decodeIfPresent([String].self, forKey: .changed)
        error = try? c.decode(Nested.self, forKey: .error)
    }
}

/// The 403 body in BOTH spellings: `{"error":"device_limit","limit":3}` (flat, from the routes
/// that merely moved) and `{"error":{"code":"…","limit":3}}` (nested, v3). `code` collapses them.
private struct ForbiddenBody: Decodable {
    struct Nested: Decodable {
        let code: String?
        let limit: Int?
        let deviceCount: Int?
    }
    let error: Nested?
    let errorCode: String?
    let limit: Int?
    let deviceCount: Int?

    var code: String? { errorCode ?? error?.code }

    private enum CodingKeys: String, CodingKey {
        case error, limit, deviceCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        limit = try c.decodeIfPresent(Int.self, forKey: .limit)
        deviceCount = try c.decodeIfPresent(Int.self, forKey: .deviceCount)
        // `error` is a string in the flat shape and an object in the nested one.
        errorCode = try? c.decode(String.self, forKey: .error)
        error = errorCode == nil ? try? c.decode(Nested.self, forKey: .error) : nil
    }
}

/// `{ "fingerprint": { "components": {...}, "hwid": "..." }, "deviceName": "..." }`, each member
/// omitted when absent (PX-W13 §8 Q2 adds the label, on activation only).
private struct ActivationFingerprintBody: Encodable {
    struct Payload: Encodable {
        let components: [String: String]
        let hwid: String
    }
    let fingerprint: Payload?
    let deviceName: String?

    init(_ fingerprint: HardwareFingerprint?, deviceName: String? = nil) {
        self.fingerprint = fingerprint.map {
            Payload(components: $0.components, hwid: $0.hwid)
        }
        self.deviceName = deviceName
    }
}
