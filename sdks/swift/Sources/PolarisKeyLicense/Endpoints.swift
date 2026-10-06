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

/// The outcome of an activation-like call (`/license/{activate,enroll,token}`), sorted by the
/// body's error CODE, never by status alone (notes/SDK-PARITY-PASS.md §3.1). Every kind carries a
/// `code`; a refusal this build has no kind for is `.refused` with the server's own code, so a
/// code the Worker adds later (I-09's `license_owned`, `key_entry_limit`) is never mislabelled as
/// a device limit.
public enum ActivationResult: Sendable, Equatable {
    case ok(token: String, schemaVersion: Int)
    /// 403 `device_limit`: every seat is taken. `manageURL` (PX-W8, WIRE-CONTRACT-V4 §5.3) is
    /// the customer-portal link that frees one, present while the product's portal is on and
    /// already validated by `ManageLink.read`. Add the app's return with `ManageLink.withReturn`
    /// and, on an `/activate` link, the key with `ManageLink.withKey`. It is never an auth
    /// failure: open it only behind a user action.
    case deviceLimit(limit: Int?, deviceCount: Int?, manageURL: String? = nil)
    /// 401: the key is unknown, revoked or no longer usable.
    case unauthorized
    /// 403 `fingerprint_required`: the tier requires a hardware fingerprint this host could not
    /// produce.
    case fingerprintRequired
    /// Hardware drifted past the tier's tolerance; the binding was retired. Retrying activation
    /// re-binds the new hardware and consumes a seat. (The Worker answers 409, not 403,
    /// precisely because it is retryable.)
    case hardwareMismatch(drift: Int?, changed: [String]?)
    /// The product does not offer keyless enrollment — surfaced from a 404, which the Worker
    /// uses deliberately to hide the route rather than admit it exists and is closed.
    case enrollDisabled
    /// 403 `enroll_claimed`: this machine's free licence belongs to an identity now; sign in.
    case enrollClaimed
    /// 403 `license_disabled`: an operator disabled the licence.
    case licenseDisabled
    /// 403 `license_expired`.
    case licenseExpired
    /// 403 `attestation_required`: the product's device-trust policy wants an attested device.
    case attestationRequired
    /// 429 `rate_limited`; `retryAfterSeconds` from a `Retry-After` header when one was sent.
    case rateLimited(retryAfterSeconds: Int?)
    /// Any other 4xx: the server's code (or `forbidden` / `not_found` / `bad_request` when the
    /// body carried none), the status and the server's message.
    case refused(code: String, status: Int, message: String?)
    /// No usable answer: `network` (no answer), `server-error` (5xx), `bad_response` (a 200
    /// without a token), `local-only`, or `store-failed` (the token could not be persisted).
    case error(code: String, message: String, status: Int? = nil)

    /// The kind's code: the wire code for a refusal, a client code for `.error`, `""` for `.ok`.
    public var code: String {
        switch self {
        case .ok: return ""
        case .deviceLimit: return ErrorCode.deviceLimit
        case .unauthorized: return ErrorCode.unauthorized
        case .fingerprintRequired: return ErrorCode.fingerprintRequired
        case .hardwareMismatch: return ErrorCode.hardwareMismatch
        case .enrollDisabled: return ErrorCode.enrollDisabled
        case .enrollClaimed: return ErrorCode.enrollClaimed
        case .licenseDisabled: return ErrorCode.licenseDisabled
        case .licenseExpired: return ErrorCode.licenseExpired
        case .attestationRequired: return ErrorCode.attestationRequired
        case .rateLimited: return ErrorCode.rateLimited
        case .refused(let code, _, _): return code
        case .error(let code, _, _): return code
        }
    }

    public var isOK: Bool {
        if case .ok = self { return true }
        return false
    }

    /// The kind's name in the transcripts' vocabulary (`ok`, `device-limit`, `refused`, …).
    public var kind: String {
        switch self {
        case .ok: return "ok"
        case .deviceLimit: return "device-limit"
        case .unauthorized: return "unauthorized"
        case .fingerprintRequired: return "fingerprint-required"
        case .hardwareMismatch: return "hardware-mismatch"
        case .enrollDisabled: return "enroll-disabled"
        case .enrollClaimed: return "enroll-claimed"
        case .licenseDisabled: return "license-disabled"
        case .licenseExpired: return "license-expired"
        case .attestationRequired: return "attestation-required"
        case .rateLimited: return "rate-limited"
        case .refused: return "refused"
        case .error: return "error"
        }
    }

    /// The person-facing sentence for this outcome (`ErrorCopy`), or nil for `.ok`. A hardware
    /// mismatch names the components that changed.
    public var message: String? {
        switch self {
        case .ok: return nil
        case .hardwareMismatch(_, let changed):
            guard let changed, !changed.isEmpty else { return ErrorCopy.message(code) }
            return ErrorCopy.message(code)
                .replacingOccurrences(
                    of: "hardware changed.",
                    with: "hardware changed (\(changed.joined(separator: ", "))).")
        default: return ErrorCopy.message(code)
        }
    }
}

public enum LicenseEndpoints {
    /// `POST /<p>/license/activate` — exchange a licence key for a per-device `pkeyt_` token.
    public static func activate(
        _ core: CoreContext, key: String, fingerprint: HardwareFingerprint? = nil
    ) async -> ActivationResult {
        await activationLike(
            core, url: core.endpoints.licenseActivate,
            extra: ["authorization": "Bearer \(key)"], fingerprint: fingerprint)
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
        fingerprint: HardwareFingerprint?
    ) async -> ActivationResult {
        var headers = extra
        var body: Data?
        // The body is omitted entirely when there is no fingerprint, so a host that opted out
        // sends a byte-identical request to one that has nothing to report.
        if let fingerprint,
            let encoded = try? JSONEncoder().encode(ActivationFingerprintBody(fingerprint))
        {
            headers["content-type"] = "application/json"
            body = encoded
        }

        let response: PolarisResponse
        do {
            response = try await core.request(url, method: "POST", headers: headers, body: body)
        } catch let error as PolarisError {
            return .error(
                code: error.code == PolarisError.localOnly ? error.code : ErrorCode.network,
                message: error.message)
        } catch {
            return .error(code: ErrorCode.network, message: error.localizedDescription)
        }
        return mapActivationResponse(response, enroll: url == core.endpoints.licenseEnroll)
    }

    /// The shared status ladder over one answer (§3.1). Internal so the unit table can drive it
    /// without a transport.
    static func mapActivationResponse(_ response: PolarisResponse, enroll: Bool)
        -> ActivationResult
    {
        if response.status == 200 {
            guard let ok = try? JSONDecoder().decode(ActivationOkBody.self, from: response.body)
            else {
                return .error(
                    code: ErrorCode.badResponse, message: "malformed activation response",
                    status: 200)
            }
            return .ok(token: ok.token, schemaVersion: ok.schemaVersion)
        }
        let body = try? JSONDecoder().decode(ErrorBody.self, from: response.body)
        let code = body?.code
        let message = body?.message
        switch response.status {
        case 401:
            return .unauthorized
        case 409 where code == nil || code == ErrorCode.hardwareMismatch:
            return .hardwareMismatch(drift: body?.drift, changed: body?.changed)
        case 429:
            return .rateLimited(retryAfterSeconds: retryAfter(response.header("retry-after")))
        case 404 where code == ErrorCode.enrollDisabled || (enroll && code == nil):
            return .enrollDisabled
        case 400..<500:
            switch code {
            case ErrorCode.deviceLimit?:
                return .deviceLimit(
                    limit: body?.limit, deviceCount: body?.deviceCount, manageURL: body?.manageURL)
            case ErrorCode.fingerprintRequired?: return .fingerprintRequired
            case ErrorCode.enrollClaimed?: return .enrollClaimed
            case ErrorCode.licenseDisabled?: return .licenseDisabled
            case ErrorCode.licenseExpired?: return .licenseExpired
            case ErrorCode.attestationRequired?: return .attestationRequired
            case ErrorCode.hardwareMismatch?:
                return .hardwareMismatch(drift: body?.drift, changed: body?.changed)
            case ErrorCode.enrollDisabled?: return .enrollDisabled
            case ErrorCode.rateLimited?:
                return .rateLimited(retryAfterSeconds: retryAfter(response.header("retry-after")))
            case let code?:
                return .refused(code: code, status: response.status, message: message)
            case nil:
                // An unknown refusal is never a device limit: it keeps a generic code for its
                // status, so the host still branches on something stable.
                let generic: String
                switch response.status {
                case 403: generic = ErrorCode.forbidden
                case 404: generic = ErrorCode.notFound
                default: generic = ErrorCode.badRequest
                }
                return .refused(code: generic, status: response.status, message: message)
            }
        default:
            return .error(
                code: ErrorCode.serverError,
                message: message ?? "activation failed with status \(response.status).",
                status: response.status)
        }
    }

    /// `Retry-After` in whole seconds (the delta-seconds form; an HTTP date is ignored).
    static func retryAfter(_ value: String?) -> Int? {
        guard let value, let seconds = Int(value.trimmingCharacters(in: .whitespaces)),
            seconds >= 0
        else { return nil }
        return seconds
    }
}

private struct ActivationOkBody: Decodable {
    let token: String
    let schemaVersion: Int
}

/// An error body in BOTH spellings the Worker uses: flat `{"error":"device_limit","limit":3}`
/// (the routes that merely moved) and nested `{"error":{"code":"…","limit":3}}` (v3). The extra
/// fields are read at the top level first and inside `error` second. `error` is decoded
/// permissively, since a decoder that threw on one spelling would lose the detail beside it.
struct ErrorBody: Decodable {
    struct Nested: Decodable {
        let code: String?
        let message: String?
        let limit: Int?
        let deviceCount: Int?
        let drift: Int?
        let changed: [String]?
        /// PX-W8: read leniently, so a malformed link never costs the caller the other fields.
        let manageUrl: String?

        private enum CodingKeys: String, CodingKey {
            case code, message, limit, deviceCount, drift, changed, manageUrl
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            code = try c.decodeIfPresent(String.self, forKey: .code)
            message = try c.decodeIfPresent(String.self, forKey: .message)
            limit = try c.decodeIfPresent(Int.self, forKey: .limit)
            deviceCount = try c.decodeIfPresent(Int.self, forKey: .deviceCount)
            drift = try c.decodeIfPresent(Int.self, forKey: .drift)
            changed = try c.decodeIfPresent([String].self, forKey: .changed)
            manageUrl = try? c.decode(String.self, forKey: .manageUrl)
        }
    }
    let flatCode: String?
    let nested: Nested?
    let topMessage: String?
    let topLimit: Int?
    let topDeviceCount: Int?
    let topDrift: Int?
    let topChanged: [String]?
    let topManageUrl: String?

    var code: String? { flatCode ?? nested?.code }
    var message: String? { topMessage ?? nested?.message }
    var limit: Int? { topLimit ?? nested?.limit }
    var deviceCount: Int? { topDeviceCount ?? nested?.deviceCount }
    var drift: Int? { topDrift ?? nested?.drift }
    var changed: [String]? { topChanged ?? nested?.changed }
    /// The validated refusal link (PX-W8): the top-level member, else the nested one.
    var manageURL: String? { ManageLink.read(topManageUrl, nested?.manageUrl) }

    private enum CodingKeys: String, CodingKey {
        case error, message, limit, deviceCount, drift, changed, manageUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        topManageUrl = try? c.decode(String.self, forKey: .manageUrl)
        topMessage = try? c.decodeIfPresent(String.self, forKey: .message)
        topLimit = try? c.decodeIfPresent(Int.self, forKey: .limit)
        topDeviceCount = try? c.decodeIfPresent(Int.self, forKey: .deviceCount)
        topDrift = try? c.decodeIfPresent(Int.self, forKey: .drift)
        topChanged = try? c.decodeIfPresent([String].self, forKey: .changed)
        let flat = try? c.decode(String.self, forKey: .error)
        flatCode = flat?.isEmpty == true ? nil : flat
        nested = flat == nil ? try? c.decode(Nested.self, forKey: .error) : nil
    }
}

/// `{ "fingerprint": { "components": {...}, "hwid": "..." } }`
private struct ActivationFingerprintBody: Encodable {
    struct Payload: Encodable {
        let components: [String: String]
        let hwid: String
    }
    let fingerprint: Payload

    init(_ fingerprint: HardwareFingerprint) {
        self.fingerprint = Payload(
            components: fingerprint.components, hwid: fingerprint.hwid)
    }
}
