// The Release sub-client — the software TRUTH store's public face (D-05, §R1).
//
// Release owns what the software is and where it comes from: the changelog, the install script,
// the artifacts. Update owns the FEED over it (appcast, version check). They are two services
// precisely because a product can want a changelog without wanting Sparkle — which is also why
// this module is NOT macOS-only and does not link Sparkle: an iOS app can show its release notes.
//
// Deliberately thin, and the same surface as `@polaris-key/node`'s and `polaris_key`'s release
// clients (pinned by the release-changelog transcripts): public GETs returning JSON, no signed
// document and therefore no verification — a release note is not a grant. When Release's access
// mode is `entitled` (D-13) the server refuses without a usable licence; this client forwards the
// bearer when one is held and reports the refusal by the refusal body's own code rather than
// inventing a retry.
//
// Every verb refuses with `service-unavailable` when the product does not run Release: a client
// that has not been told the service exists must not probe for it (D-21).

import Foundation
import PolarisKeyCore

/// One published release, as `GET /<p>/release/changelog` reports it.
public struct ChangelogEntry: Sendable, Equatable, Codable {
    public let version: String
    public let tag: String
    /// ISO-8601 publication time, or nil for an undated release.
    public let date: String?
    /// The curated summary, or nil when the release body yielded none.
    public let summary: String?
    public let url: String

    public init(version: String, tag: String, date: String?, summary: String?, url: String) {
        self.version = version
        self.tag = tag
        self.date = date
        self.summary = summary
        self.url = url
    }
}

public struct ReleaseClient: Sendable {
    private let core: CoreContext

    public init(core: CoreContext) {
        self.core = core
    }

    /// `GET /<p>/release/changelog` — the published release list, newest first.
    ///
    /// Throws `PolarisError` `service-unavailable` when the product does not run Release; the
    /// refusal body's code (`unauthorized`, `channel_not_allowed`, `download_auth_required`, …)
    /// for a 401 or 403; `not_found` for any other failure status.
    public func changelog() async throws -> [ChangelogEntry] {
        try await core.requireService(.release)
        var headers = ["accept": "application/json"]
        // Forwarded when held so an `entitled` feed can authenticate; a public feed ignores it.
        if let token = await core.token { headers["authorization"] = "Bearer \(token)" }
        let response = try await core.request(core.endpoints.releaseChangelog, headers: headers)
        let path = "release/changelog"
        if response.status == 401 || response.status == 403 {
            let code = Self.refusalCode(response.body)
            throw PolarisError(
                code: code ?? (response.status == 401 ? ErrorCode.unauthorized : ErrorCode.forbidden),
                message: response.status == 401
                    ? "\(path) refused: this feed needs a usable licence."
                    : "\(path) refused: this build is not entitled to that feed.")
        }
        guard response.isOK else {
            throw PolarisError(
                code: ErrorCode.notFound, message: "\(path) failed with status \(response.status).")
        }
        guard
            case .object(let root)? = try? JSONDecoder().decode(JSONValue.self, from: response.body),
            case .array(let entries)? = root["entries"]
        else { return [] }
        return entries.compactMap(Self.entry)
    }

    /// The canonical install-script URL, for a host that wants to print it rather than run it.
    public func installURL() async throws -> URL {
        try await core.requireService(.release)
        return core.endpoints.releaseInstall
    }

    /// `GET /<p>/release/dl/:version/:binary-:arch[.dmg]` — the artifact URL, with
    /// `?checksum=sha256` when `checksum` is set (the server then serves the artifact's sha256
    /// digest). Built, not fetched: the caller streams it themselves.
    public func downloadURL(
        version: String, binary: String, arch: String, checksum: Bool = false, dmg: Bool = false
    ) async throws -> URL {
        try await core.requireService(.release)
        let url = core.endpoints.releaseDownload(
            version: version, file: "\(binary)-\(arch)\(dmg ? ".dmg" : "")")
        guard checksum, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return url }
        parts.queryItems = [URLQueryItem(name: "checksum", value: "sha256")]
        return parts.url ?? url
    }

    /// The refusal's own code: the nested v3 shape (`{"error":{"code":…}}`, the `entitled`
    /// mode) or the flat one (`{"error":"download_auth_required"}`, `authenticated`/`licensed`).
    static func refusalCode(_ body: Data) -> String? {
        guard case .object(let root)? = try? JSONDecoder().decode(JSONValue.self, from: body)
        else { return nil }
        switch root["error"] {
        case .string(let code)? where !code.isEmpty: return code
        case .object(let error)?:
            if case .string(let code)? = error["code"], !code.isEmpty { return code }
            return nil
        default: return nil
        }
    }

    /// One entry, tolerant of a missing field the way the other SDKs are: strings default to
    /// empty, `date` and `summary` stay nil unless they are strings.
    static func entry(_ value: JSONValue) -> ChangelogEntry? {
        guard case .object(let o) = value else { return nil }
        return ChangelogEntry(
            version: o["version"]?.stringValue ?? "",
            tag: o["tag"]?.stringValue ?? "",
            date: o["date"]?.stringValue,
            summary: o["summary"]?.stringValue,
            url: o["url"]?.stringValue ?? "")
    }
}
