// GET /<product>/config with the documented status taxonomy, on URLSession. Verification +
// anti-replay happen in the client (verifyDoc); this is purely the HTTP layer. Mirrors
// sdk-node's fetch.ts.

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private func sdkMetadataHeaders() -> [String: String] {
    [
        HEADER_PLATFORM: PlatformFamily.current,
        HEADER_ARCH: swiftArch(),
        HEADER_SDK_NAME: POLARIS_KEY_SDK_NAME,
        HEADER_SDK_VERSION: POLARIS_KEY_SDK_VERSION,
    ]
}

private func swiftArch() -> String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
}

/// The outcome of a `GET /<product>/config` call.
public enum FetchResult: Sendable {
    case ok(jws: String, etag: String?)
    case notModified
    case unauthorized
    case deviceCap(limit: Int?, deviceCount: Int?)
    case blocked(reason: BlockReason, allowedRange: AllowedRange?)
    case error(status: Int, message: String)
}

public struct FetchOptions: Sendable {
    public let baseUrl: String
    public let product: String
    public let token: String
    public let deviceId: String
    public let version: String
    public let channel: String
    public let etag: String?
    /// Request deadline in seconds. `URLSession`'s own default is far too generous for a
    /// licence check, so a hung control plane would stall the caller indefinitely (R4-08).
    public let timeoutSeconds: Double

    public init(
        baseUrl: String,
        product: String,
        token: String,
        deviceId: String,
        version: String,
        channel: String,
        etag: String? = nil,
        timeoutSeconds: Double = 15
    ) {
        self.baseUrl = baseUrl
        self.product = product
        self.token = token
        self.deviceId = deviceId
        self.version = version
        self.channel = channel
        self.etag = etag
        self.timeoutSeconds = timeoutSeconds
    }
}

/// Fetch the managed-config JWS, classifying the response by the documented status codes:
/// 200(jws+etag) / 304 / 401 / 403{reason,allowedRange} / 429{limit,deviceCount}.
public func fetchManagedConfig(
    _ opts: FetchOptions, session: URLSession = .shared
) async -> FetchResult {
    guard let url = URL(string: "\(opts.baseUrl)/\(opts.product)/config") else {
        return .error(status: 0, message: "invalid url")
    }
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = opts.timeoutSeconds
    req.setValue("Bearer \(opts.token)", forHTTPHeaderField: "Authorization")
    req.setValue(opts.deviceId, forHTTPHeaderField: HEADER_DEVICE)
    req.setValue(opts.version, forHTTPHeaderField: HEADER_VERSION)
    req.setValue(opts.channel, forHTTPHeaderField: HEADER_CHANNEL)
    for (key, value) in sdkMetadataHeaders() {
        req.setValue(value, forHTTPHeaderField: key)
    }
    if let etag = opts.etag {
        req.setValue(etag, forHTTPHeaderField: "If-None-Match")
    }

    let data: Data
    let response: URLResponse
    do {
        (data, response) = try await session.data(for: req)
    } catch {
        return .error(status: 0, message: error.localizedDescription)
    }
    guard let http = response as? HTTPURLResponse else {
        return .error(status: 0, message: "non-http response")
    }

    switch http.statusCode {
    case 304:
        return .notModified
    case 401:
        return .unauthorized
    case 429:
        let body = (try? JSONDecoder().decode(DeviceCapBody.self, from: data))
        return .deviceCap(limit: body?.limit, deviceCount: body?.deviceCount)
    case 403:
        let body = (try? JSONDecoder().decode(BlockBody.self, from: data))
        return .blocked(
            reason: body?.reason ?? .versionTooOld, allowedRange: body?.allowedRange)
    case 200:
        let jws = String(decoding: data, as: UTF8.self)
        let etag = http.value(forHTTPHeaderField: "ETag")
        return .ok(jws: jws, etag: etag)
    default:
        return .error(status: http.statusCode, message: String(decoding: data, as: UTF8.self))
    }
}

private struct DeviceCapBody: Decodable {
    let limit: Int?
    let deviceCount: Int?
}

private struct BlockBody: Decodable {
    let reason: BlockReason?
    let allowedRange: AllowedRange?
}
