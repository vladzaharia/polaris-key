// Enrollment + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report),
// on URLSession. Mirrors sdk-node's endpoints.ts.

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The outcome of an enroll-like call (`/enroll`, `/token`).
public enum EnrollResult: Sendable, Equatable {
    case ok(token: String, schemaVersion: Int)
    case machineLimit(limit: Int?, machineCount: Int?)
    case unauthorized
    case error(message: String)
}

public enum Endpoints {
    /// Exchange a license key for a per-machine token (`POST /<product>/enroll`).
    public static func enrollWithKey(
        baseUrl: String, product: String, key: String, deviceId: String,
        session: URLSession = .shared
    ) async -> EnrollResult {
        await enrollLike(
            urlString: "\(baseUrl)/\(product)/enroll",
            headers: ["Authorization": "Bearer \(key)", HEADER_DEVICE: deviceId],
            session: session)
    }

    /// Re-acquire a token for an already-enrolled device (`POST /<product>/token`).
    public static func reacquireToken(
        baseUrl: String, product: String, token: String, deviceId: String,
        session: URLSession = .shared
    ) async -> EnrollResult {
        await enrollLike(
            urlString: "\(baseUrl)/\(product)/token",
            headers: ["Authorization": "Bearer \(token)", HEADER_DEVICE: deviceId],
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
        req.httpBody = snapshot
        guard let (_, response) = try? await session.data(for: req),
              let http = response as? HTTPURLResponse
        else { return false }
        return (200..<300).contains(http.statusCode)
    }

    private static func enrollLike(
        urlString: String, headers: [String: String], session: URLSession
    ) async -> EnrollResult {
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
            guard let body = try? JSONDecoder().decode(EnrollOkBody.self, from: data) else {
                return .error(message: "malformed enroll response")
            }
            return .ok(token: body.token, schemaVersion: body.schemaVersion)
        case 403:
            let body = try? JSONDecoder().decode(MachineLimitBody.self, from: data)
            return .machineLimit(limit: body?.limit, machineCount: body?.machineCount)
        case 401:
            return .unauthorized
        default:
            return .error(message: String(decoding: data, as: UTF8.self))
        }
    }
}

private struct EnrollOkBody: Decodable {
    let token: String
    let schemaVersion: Int
}

private struct MachineLimitBody: Decodable {
    let limit: Int?
    let machineCount: Int?
}
