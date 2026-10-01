// URL construction — the §R1 canonical route table, in one place.
//
// v2 built every URL by string concatenation at the call site (`"\(baseUrl)/\(product)/config"`),
// which meant each one carried its own copy of the path, its own `URL(string:)` optionality, and
// its own opportunity to forget that a product slug needs escaping. §R1 then MOVED every route
// under a service prefix, and a string-concatenating client is exactly the client that discovers
// such a move one endpoint at a time.
//
// `Endpoints` is a builder over a validated base URL. The paths below are the canonical v3 ones;
// the four permanent aliases (`/<p>/appcast.xml`, `/<p>/<channel>/appcast.xml`,
// `/<p>/install.sh`, `/<p>/version`) exist server-side for hosts that hard-coded them, and this
// SDK deliberately does not use them.

import Foundation

/// The two signed documents Core knows how to fetch, cache and floor. A `String` raw value
/// because it is also the on-disk cache slice key (§4.1).
public enum DocumentSlice: String, Sendable, Codable, Equatable, CaseIterable {
    case license
    case config
}

/// A validated base URL plus a product slug: everything needed to name any Polaris Key route.
public struct Endpoints: Sendable, Equatable {
    /// Normalized, scheme-checked, trailing slashes stripped.
    public let baseUrl: String
    public let product: String

    /// Loopback hosts keep `http:` usable for `wrangler dev` and integration tests; nothing else
    /// may carry the bearer token unencrypted.
    private static let loopbackHosts: Set<String> = [
        "localhost", "127.0.0.1", "::1", "[::1]",
    ]

    /// Build the endpoint set, rejecting a base URL that would carry the device bearer token in
    /// the clear.
    ///
    /// A plaintext control plane turns trust-set injection (R4-02) from a local attack into a
    /// coffee-shop one, and the token is on every document fetch. Node raises
    /// `InsecureBaseUrlError` at construction for exactly this; Swift throws here so a client
    /// that failed the check has done nothing else first — no directory created, no keychain
    /// touched.
    public init(baseUrl: String, product: String) throws {
        let trimmed = baseUrl.replacingOccurrences(
            of: #"/+$"#, with: "", options: .regularExpression)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
            let host = url.host?.lowercased()
        else {
            throw PolarisError(
                code: PolarisError.insecureBaseUrl,
                message: "baseUrl is not a valid URL: \(baseUrl)")
        }
        let loopback = scheme == "http" && Endpoints.loopbackHosts.contains(host)
        guard scheme == "https" || loopback else {
            throw PolarisError(
                code: PolarisError.insecureBaseUrl,
                message:
                    "baseUrl must be https: (got \(scheme)://\(host)); plaintext http:// is only "
                    + "accepted for localhost/127.0.0.1.")
        }
        self.baseUrl = trimmed
        self.product = product
    }

    /// Percent-escaping for ONE path segment. `.urlPathAllowed` deliberately permits `/`, which
    /// is the wrong answer for a value that must not be able to introduce a segment: a device id
    /// containing a slash would otherwise address a different route entirely.
    private static let segmentAllowed = CharacterSet.urlPathAllowed
        .subtracting(CharacterSet(charactersIn: "/"))

    static func segment(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: segmentAllowed) ?? raw
    }

    /// `<baseUrl>/<product>/<path>`. The product slug is escaped as a single segment; the path is
    /// not, so callers pass literals from the table below rather than user input.
    public func url(_ path: String) -> URL {
        let slug = Endpoints.segment(product)
        // Every component is either a validated base URL or a compile-time literal, so this
        // cannot fail; the fallback keeps the API non-optional for call sites.
        return URL(string: "\(baseUrl)/\(slug)/\(path)")
            ?? URL(string: "\(baseUrl)/\(slug)")!
    }

    // ── Core (§6) ────────────────────────────────────────────────────────────────────────
    public var discovery: URL { url(".well-known/polaris.json") }
    public var trustManifest: URL { url(".well-known/polaris-trust.jws") }
    public var jwks: URL { url(".well-known/jwks.json") }
    public var devicesRegister: URL { url("devices/register") }
    public var devicesReport: URL { url("devices/report") }
    public var devices: URL { url("devices") }
    public func device(_ id: String) -> URL {
        url("devices/\(Endpoints.segment(id))")
    }

    // ── License (§5) ─────────────────────────────────────────────────────────────────────
    public var licenseActivate: URL { url("license/activate") }
    public var licenseEnroll: URL { url("license/enroll") }
    public var licenseToken: URL { url("license/token") }
    public var licenseDeauthorize: URL { url("license/deauthorize") }
    public var licenseDocument: URL { url("license/document") }

    // ── Config (§2.2) ────────────────────────────────────────────────────────────────────
    public var configDocument: URL { url("config/document") }
    public var configSchema: URL { url("config/schema") }

    // ── Update ───────────────────────────────────────────────────────────────────────────
    public var updateVersion: URL { url("update/version") }
    public var updateAppcast: URL { url("update/appcast.xml") }
    public func updateAppcast(channel: String) -> URL {
        url("update/\(Endpoints.segment(channel))/appcast.xml")
    }

    // ── Release ──────────────────────────────────────────────────────────────────────────
    public var releaseChangelog: URL { url("release/changelog") }
    public var releaseInstall: URL { url("release/install.sh") }
    /// `/release/dl/:version/:file` — `file` is `<binary>-<arch>[.dmg]`. Each is ONE segment.
    public func releaseDownload(version: String, file: String) -> URL {
        url("release/dl/\(Endpoints.segment(version))/\(Endpoints.segment(file))")
    }

    /// The signed-document route for one cache slice — the pairing `sync()` drives both
    /// documents through, so neither can acquire a path the other lacks.
    public func document(_ slice: DocumentSlice) -> URL {
        switch slice {
        case .license: return licenseDocument
        case .config: return configDocument
        }
    }
}
