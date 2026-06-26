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
    case error(message: String)
}

public enum Endpoints {
    private static func metadataHeaders() -> [String: String] {
        [
            HEADER_PLATFORM: ProcessInfo.processInfo.operatingSystemVersionString,
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
        session: URLSession = .shared
    ) async -> ActivationResult {
        await activationLike(
            urlString: "\(baseUrl)/\(product)/activate",
            headers: ["Authorization": "Bearer \(key)", HEADER_DEVICE: deviceId]
                .merging(metadataHeaders()) { current, _ in current },
            session: session)
    }

    /// Re-acquire a token for an already-activated device (`POST /<product>/token`).
    public static func reacquireToken(
        baseUrl: String, product: String, token: String, deviceId: String,
        session: URLSession = .shared
    ) async -> ActivationResult {
        await activationLike(
            urlString: "\(baseUrl)/\(product)/token",
            headers: ["Authorization": "Bearer \(token)", HEADER_DEVICE: deviceId]
                .merging(metadataHeaders()) { current, _ in current },
            session: session)
    }

    /// Best-effort server-side deauthorize (`POST /<product>/deauthorize`). The local wipe
    /// is what actually matters, so failures are swallowed.
    public static func deauthorize(
        baseUrl: String, product: String, token: String,
        session: URLSession = .shared
    ) async {
        guard let url = URL(string: "\(baseUrl)/\(product)/deauthorize") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// Post a non-secret config/entitlement snapshot for the admin panel
    /// (`POST /<product>/config/report`). Returns whether the server accepted it.
    @discardableResult
    public static func reportSnapshot(
        baseUrl: String, product: String, token: String, snapshot: Data,
        session: URLSession = .shared
    ) async -> Bool {
        guard let url = URL(string: "\(baseUrl)/\(product)/config/report") else { return false }
        var req = URLRequest(url: url)
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
        urlString: String, headers: [String: String], session: URLSession
    ) async -> ActivationResult {
        guard let url = URL(string: urlString) else {
            return .error(message: "invalid url")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

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
        case 403:
            let body = try? JSONDecoder().decode(DeviceLimitBody.self, from: data)
            return .deviceLimit(limit: body?.limit, deviceCount: body?.deviceCount)
        case 401:
            return .unauthorized
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
    let limit: Int?
    let deviceCount: Int?
}
