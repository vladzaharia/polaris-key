// The Update sub-client — the FEED over Release's truth store (D-05, §R1).
//
// Two jobs, both thin:
//
//   `check()`   `GET /<p>/update/version` → what the newest build on this channel is, plus
//               whether the running version is behind it. The comparison uses Core's
//               `Semver.compare`, the same one the server's build gate and every other SDK use —
//               a version check that disagreed with the gate would tell a user to update to a
//               build the gate then blocks.
//   `feed()`    the Sparkle appcast URL + `allowedChannels` + auth headers, taken from
//               DISCOVERY rather than string-built here.
//
// No Sparkle import: this file is the network client, and it works on any platform. The
// Sparkle-touching code is in `SparkleUpdater.swift`, behind `#if os(macOS)`.

import Foundation
import PolarisKeyCore

public struct VersionCheck: Sendable, Equatable {
    /// The newest version on the requested channel.
    public let version: String
    public let tag: String
    public let url: String
    /// Whether the host APPLICATION's own version is older than `version`. Computed from
    /// `CoreOptions.version`, not the SDK's: the SDK ships inside the thing being updated.
    public let updateAvailable: Bool
}

public actor UpdateClient {
    private let core: CoreContext

    public init(core: CoreContext) {
        self.core = core
    }

    /// `GET /<p>/update/version` — the newest build, and whether we are behind it.
    ///
    /// Refuses when the product does not run Update (D-21), before a socket is opened: a
    /// disabled service and a missing route answer with the same 404 server-side, so probing
    /// would tell the caller nothing the capability map does not already say.
    public func check(channel: String? = nil) async throws -> VersionCheck {
        try await core.requireService(.update)
        var components = URLComponents(
            url: core.endpoints.updateVersion, resolvingAgainstBaseURL: false)
        if let channel {
            components?.queryItems = [URLQueryItem(name: "channel", value: channel)]
        }
        guard let url = components?.url else {
            throw PolarisError(code: "bad_request", message: "could not build update/version URL")
        }

        var headers: [String: String] = [:]
        // The token is sent when we hold one: `entitled` products need it, and `public` ones
        // ignore it. Sending it unconditionally is what keeps the caller from having to know
        // which access mode the product is on.
        if let token = await core.token { headers["authorization"] = "Bearer \(token)" }

        let response = try await core.request(url, headers: headers)
        if response.status == 403 {
            let body = try? JSONDecoder().decode(WireErrorBody.self, from: response.body)
            throw PolarisError(
                code: body?.error?.code ?? "forbidden",
                message: "This build is not entitled to that update channel.")
        }
        guard response.isOK else {
            throw PolarisError(
                code: "not_found",
                message: "update/version failed with status \(response.status).")
        }
        guard let body = try? JSONDecoder().decode(VersionBody.self, from: response.body) else {
            throw PolarisError(
                code: "bad_request", message: "malformed update/version response")
        }
        return VersionCheck(
            version: body.version, tag: body.tag, url: body.url,
            updateAvailable: Semver.compare(core.version, body.version) < 0)
    }

    /// The Sparkle feed for a channel, derived from the discovery document Core loaded.
    ///
    /// Returns nil when discovery has not run or Update is not enabled — see
    /// `UpdateFeedBuilder.feed` for why that is a value rather than an error.
    public func feed(
        channel: String = "stable",
        arch: UpdateArch? = UpdateArch.current,
        entitlements: [String: JSONValue] = [:]
    ) async -> UpdateFeed? {
        guard let document = await core.discoveryDocument else { return nil }
        return UpdateFeedBuilder.feed(
            from: document, channel: channel, arch: arch, entitlements: entitlements)
    }

    /// The headers Sparkle must send with its own feed requests in `entitled` mode.
    public func feedHeaders(channel: String = "stable") async -> [String: String] {
        UpdateFeedBuilder.feedHeaders(
            token: await core.token, version: core.version, channel: channel,
            deviceId: await core.deviceId)
    }
}

private struct VersionBody: Decodable {
    let version: String
    let tag: String
    let url: String
}

private struct WireErrorBody: Decodable {
    struct Nested: Decodable {
        let code: String?
    }
    let error: Nested?
}
