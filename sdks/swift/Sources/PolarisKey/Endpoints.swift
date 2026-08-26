// Activation + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report),
// on URLSession. Mirrors sdk-node's endpoints.ts.

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The outcome of an activation-like call (`/activate`, `/token`).
public enum ActivationResult: Sendable, Equatable {
    case ok(token: String, schemaVersion: Int)
    case deviceLimit(limit: Int?, deviceCount: Int?)
    case unauthorized
    /// The tier requires a hardware fingerprint this host could not produce.
    case fingerprintRequired
    /// Hardware drifted past the tier's tolerance; the binding was retired. Retrying
    /// activation re-binds the new hardware and consumes a seat.
    case hardwareMismatch(drift: Int?, changed: [String]?)
    /// The product does not offer keyless enrollment.
    case enrollDisabled
    case error(message: String)
}

/// Default deadline for every SDK request. `URLSession` has no useful default here, so a
/// stalled control plane would hang activation forever (audit finding R4-08).
public let DEFAULT_REQUEST_TIMEOUT: Double = 15

public enum Endpoints {
    private static func metadataHeaders() -> [String: String] {
        [
            HEADER_PLATFORM: PlatformFamily.current,
            HEADER_ARCH: swiftArch(),
            HEADER_SDK_NAME: POLARIS_KEY_SDK_NAME,
            HEADER_SDK_VERSION: POLARIS_KEY_SDK_VERSION,
        ]
    }

    private static func swiftArch() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    /// Exchange a license key for a per-device token (`POST /<product>/activate`).
    public static func activateWithKey(
        baseUrl: String, product: String, key: String, deviceId: String,
        fingerprint: HardwareFingerprint? = nil,
        session: URLSession = .shared,
        timeout: Double = DEFAULT_REQUEST_TIMEOUT
    ) async -> ActivationResult {
        await activationLike(
            urlString: "\(baseUrl)/\(product)/activate",
            headers: ["Authorization": "Bearer \(key)", HEADER_DEVICE: deviceId]
                .merging(metadataHeaders()) { current, _ in current },
            session: session,
            timeout: timeout,
            fingerprint: fingerprint)
    }

    /// Obtain a license with no key and no sign-in (`POST /<product>/enroll`).
    ///
    /// Returns the same `ActivationResult` `activateWithKey` does, so callers need no new
    /// branching. A product that hasn't opted in answers 404 → `.enrollDisabled`.
    public static func enroll(
        baseUrl: String, product: String, deviceId: String,
        fingerprint: HardwareFingerprint? = nil,
        session: URLSession = .shared,
        timeout: Double = DEFAULT_REQUEST_TIMEOUT
    ) async -> ActivationResult {
        await activationLike(
            urlString: "\(baseUrl)/\(product)/enroll",
            headers: [HEADER_DEVICE: deviceId]
                .merging(metadataHeaders()) { current, _ in current },
            session: session,
            timeout: timeout,
            fingerprint: fingerprint)
    }

    /// Re-acquire a token for an already-activated device (`POST /<product>/token`).
    public static func reacquireToken(
        baseUrl: String, product: String, token: String, deviceId: String,
        session: URLSession = .shared,
        timeout: Double = DEFAULT_REQUEST_TIMEOUT
    ) async -> ActivationResult {
        await activationLike(
            urlString: "\(baseUrl)/\(product)/token",
            headers: ["Authorization": "Bearer \(token)", HEADER_DEVICE: deviceId]
                .merging(metadataHeaders()) { current, _ in current },
            session: session,
            timeout: timeout)
    }

    /// Best-effort server-side deauthorize (`POST /<product>/deauthorize`). The local wipe
    /// is what actually matters, so failures are swallowed.
    public static func deauthorize(
        baseUrl: String, product: String, token: String,
        session: URLSession = .shared,
        timeout: Double = DEFAULT_REQUEST_TIMEOUT
    ) async {
        guard let url = URL(string: "\(baseUrl)/\(product)/deauthorize") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// Post a non-secret config/entitlement snapshot for the admin panel
    /// (`POST /<product>/config/report`). Returns whether the server accepted it.
    @discardableResult
    public static func reportSnapshot(
        baseUrl: String, product: String, token: String, snapshot: Data,
        session: URLSession = .shared,
        timeout: Double = DEFAULT_REQUEST_TIMEOUT
    ) async -> Bool {
        guard let url = URL(string: "\(baseUrl)/\(product)/config/report") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in metadataHeaders() {
            req.setValue(value, forHTTPHeaderField: key)
        }
        req.httpBody = snapshot
        guard let (_, response) = try? await session.data(for: req),
              let http = response as? HTTPURLResponse
        else { return false }
        return (200..<300).contains(http.statusCode)
    }

    private static func activationLike(
        urlString: String, headers: [String: String], session: URLSession,
        timeout: Double = DEFAULT_REQUEST_TIMEOUT,
        fingerprint: HardwareFingerprint? = nil
    ) async -> ActivationResult {
        guard let url = URL(string: urlString) else {
            return .error(message: "invalid url")
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.httpMethod = "POST"
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        // No body at all when there is no fingerprint, so the call stays byte-identical to
        // the pre-fingerprint contract against an older Worker.
        if let fingerprint,
           let body = try? JSONEncoder().encode(FingerprintBody(fingerprint: fingerprint)) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            return .error(message: error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            return .error(message: "non-http response")
        }
        switch http.statusCode {
        case 200:
            guard let body = try? JSONDecoder().decode(ActivationOkBody.self, from: data) else {
                return .error(message: "malformed activate response")
            }
            return .ok(token: body.token, schemaVersion: body.schemaVersion)
        case 409:
            let body = try? JSONDecoder().decode(HardwareMismatchBody.self, from: data)
            return .hardwareMismatch(drift: body?.drift, changed: body?.changed)
        case 403:
            let body = try? JSONDecoder().decode(DeviceLimitBody.self, from: data)
            if body?.error == "fingerprint_required" { return .fingerprintRequired }
            return .deviceLimit(limit: body?.limit, deviceCount: body?.deviceCount)
        case 401:
            return .unauthorized
        case 404:
            return .enrollDisabled
        default:
            return .error(message: String(decoding: data, as: UTF8.self))
        }
    }
}

private struct ActivationOkBody: Decodable {
    let token: String
    let schemaVersion: Int
}

private struct DeviceLimitBody: Decodable {
    let error: String?
    let limit: Int?
    let deviceCount: Int?
}

private struct HardwareMismatchBody: Decodable {
    let drift: Int?
    let changed: [String]?
}

/// `{ "fingerprint": { "components": {...}, "hwid": "..." } }`
private struct FingerprintBody: Encodable {
    struct Payload: Encodable {
        let components: [String: String]
        let hwid: String
    }
    let fingerprint: Payload

    init(fingerprint: HardwareFingerprint) {
        self.fingerprint = Payload(
            components: fingerprint.components, hwid: fingerprint.hwid)
    }
}
