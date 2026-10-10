// Product discovery: `GET /<product>/.well-known/polaris.json` — wire contract v3.
//
// ── WHAT CHANGED FROM v2 ────────────────────────────────────────────────────────────────────
//
// The v2 document had a `modules` object each surface re-derived its own way, so it could claim
// a capability was on while its routes 404ed. v3 replaces it with a top-level `services` map
// keyed by the service slugs, every entry a projection of ONE authority (the product's
// `services_json`), and a disabled service is `{"enabled": false}` and NOTHING ELSE — there is
// no endpoint list to read a disabled service's shape out of.
//
// The document is allowed to GROW: this parser validates the fields the SDK consumes and
// preserves the rest verbatim, so a product publishing richer onboarding metadata is not
// rejected by an SDK that predates it.
//
// ── FAIL-CLOSED (D-21) ──────────────────────────────────────────────────────────────────────
//
// A slug the document omits reads as DISABLED, not "unknown, assume on" — that is the point of
// parsing it at all, since the SDK gates sub-client availability on this. A MALFORMED `services`
// value is a REJECTED document rather than "assume defaults": silently substituting the
// permissive default is exactly how a fail-closed gate becomes a fail-open one.
//
// The offline fallback — what a client believes before it has ever seen a document — is the
// host's `expectedServices`, resolved in `CoreContext.services()`. Discovery, once loaded,
// always wins over it. It has to be a fallback rather than a fetch, because discovery is a
// NETWORK read and an offline-first client must not be told it has no license service simply
// because the control plane is unreachable.

import Foundation

// `ServiceSlug` — the opt-in services, in canonical order, with `isDefaultEnabled` — is GENERATED
// from the service table (tools/services.json) into `ServiceSlug.generated.swift` by
// `pnpm gen services`. Core is not a service — it is always on.

/// Per-service state as the SDK consumes it.
public typealias ServicesMap = [ServiceSlug: Bool]

/// What a client believes with neither a discovery document nor a stated expectation:
/// licensing + settings delivery, which is what every product ran before the suite existed.
/// Release, distribution, update and identity are OFF, so their sub-clients refuse until something says
/// otherwise — the fail-closed half of D-21 applied to the genuinely new surfaces.
/// The service table's `defaultEnabled` rows.
public let DEFAULT_SERVICES: ServicesMap = Dictionary(
    uniqueKeysWithValues: ServiceSlug.allCases.map { ($0, $0.isDefaultEnabled) })

/// Everything off. The starting point for both `servicesFromList` and the discovery parser.
public let NO_SERVICES: ServicesMap = Dictionary(
    uniqueKeysWithValues: ServiceSlug.allCases.map { ($0, false) })

/// Turn a host's `expectedServices` list into a full map — everything unlisted is off.
public func servicesFromList(_ slugs: [ServiceSlug]) -> ServicesMap {
    var out = NO_SERVICES
    for slug in slugs { out[slug] = true }
    return out
}

/// One service's published fragment. `enabled` is the only field Core reads; the rest is the
/// service's own business and is preserved for the sub-client that wants it.
public struct ServiceFragment: Sendable, Equatable {
    public let enabled: Bool
    /// Named endpoints, e.g. update's `appcast` / `version` / `channelAppcast`.
    public let endpoints: [String: String]
    /// Everything else the fragment carried, kept as parsed JSON so an SDK that predates a
    /// field is not the reason a product cannot publish it.
    public let extras: [String: JSONValue]

    public init(
        enabled: Bool, endpoints: [String: String] = [:], extras: [String: JSONValue] = [:]
    ) {
        self.enabled = enabled
        self.endpoints = endpoints
        self.extras = extras
    }

    /// A disabled service publishes exactly this and nothing else.
    public static let disabled = ServiceFragment(enabled: false)
}

/// Core's always-on block (design spec §2.1).
public struct DiscoveryCore: Sendable, Equatable {
    public let registration: RegistrationPolicy?
    public let compatMin: String?
    public let compatMax: String?
    public let endpoints: [String: String]

    public init(
        registration: RegistrationPolicy? = nil, compatMin: String? = nil,
        compatMax: String? = nil, endpoints: [String: String] = [:]
    ) {
        self.registration = registration
        self.compatMin = compatMin
        self.compatMax = compatMax
        self.endpoints = endpoints
    }
}

public struct DiscoveryTrust: Sendable, Equatable {
    public let jwksUrl: String?
    public let trustManifestUrl: String?
    /// The product's published pins. Informational ONLY — a client's root of trust is the set
    /// compiled into the host application (§1); adopting these would make discovery a key
    /// source, which is precisely what §1 forbids.
    public let pinnedKeys: TrustSet

    public init(
        jwksUrl: String? = nil, trustManifestUrl: String? = nil, pinnedKeys: TrustSet = [:]
    ) {
        self.jwksUrl = jwksUrl
        self.trustManifestUrl = trustManifestUrl
        self.pinnedKeys = pinnedKeys
    }
}

public struct ProductDiscoveryDocument: Sendable, Equatable {
    public let product: String
    public let name: String?
    public let baseUrl: String?
    public let protocolVersion: Int?
    public let core: DiscoveryCore?
    public let trust: DiscoveryTrust?
    /// The v3 authority. Every slug has an entry; absent slugs read as disabled.
    public let services: [ServiceSlug: ServiceFragment]

    public init(
        product: String, name: String? = nil, baseUrl: String? = nil,
        protocolVersion: Int? = nil, core: DiscoveryCore? = nil, trust: DiscoveryTrust? = nil,
        services: [ServiceSlug: ServiceFragment]
    ) {
        self.product = product
        self.name = name
        self.baseUrl = baseUrl
        self.protocolVersion = protocolVersion
        self.core = core
        self.trust = trust
        self.services = services
    }

    /// The capability map Core gates sub-clients on.
    public var servicesMap: ServicesMap {
        var out = NO_SERVICES
        for (slug, fragment) in services { out[slug] = fragment.enabled }
        return out
    }
}

public enum DiscoveryResult: Sendable {
    case ok(ProductDiscoveryDocument)
    case notFound
    case invalid(String)
    case error(status: Int, message: String)
}

public enum Discovery {
    /// Parse a discovery document. Separated from the fetch so the fail-closed rules are
    /// testable as pure data — every interesting case here is a malformed document, and none of
    /// them need a socket.
    public static func parse(_ data: Data, expectedProduct: String) -> DiscoveryResult {
        guard let root = try? JSONDecoder().decode(JSONValue.self, from: data),
            let obj = root.objectValue
        else { return .invalid("Discovery document must be a JSON object.") }

        // The Worker publishes `product` as a slug string and duplicates it as `slug`; older
        // shapes nested it. Accept all three spellings, then require an exact match — a
        // document for another product is not a document this client may act on.
        let product =
            obj["product"]?.stringValue
            ?? obj["product"]?.objectValue?["slug"]?.stringValue
            ?? obj["slug"]?.stringValue
        guard let product, !product.isEmpty else {
            return .invalid("Discovery document is missing product.")
        }
        guard product == expectedProduct else {
            return .invalid(
                "Discovery document product \(product) does not match \(expectedProduct).")
        }

        guard let servicesValue = obj["services"], let servicesObj = servicesValue.objectValue
        else { return .invalid("Discovery services must be a map of service fragments.") }

        var services: [ServiceSlug: ServiceFragment] = [:]
        for slug in ServiceSlug.allCases {
            guard let raw = servicesObj[slug.rawValue] else {
                // Absent ⇒ disabled. Fail closed (D-21).
                services[slug] = .disabled
                continue
            }
            guard let fragment = raw.objectValue else {
                return .invalid("Discovery service \(slug.rawValue) must be an object.")
            }
            // `enabled` must be a real BOOLEAN. A truthy string ("false"!) reading as on is the
            // classic version of this bug.
            let enabled = fragment["enabled"]?.boolValue == true
            var endpoints: [String: String] = [:]
            for (key, value) in fragment["endpoints"]?.objectValue ?? [:] {
                if let s = value.stringValue { endpoints[key] = s }
            }
            var extras = fragment
            extras.removeValue(forKey: "enabled")
            extras.removeValue(forKey: "endpoints")
            services[slug] = ServiceFragment(
                enabled: enabled, endpoints: endpoints, extras: extras)
        }

        return .ok(
            ProductDiscoveryDocument(
                product: product,
                name: obj["name"]?.stringValue,
                baseUrl: obj["baseUrl"]?.stringValue,
                protocolVersion: obj["protocolVersion"]?.intValue,
                core: parseCore(obj["core"]?.objectValue),
                trust: parseTrust(obj["trust"]?.objectValue),
                services: services))
    }

    private static func parseCore(_ obj: [String: JSONValue]?) -> DiscoveryCore? {
        guard let obj else { return nil }
        var endpoints: [String: String] = [:]
        for (key, value) in obj["endpoints"]?.objectValue ?? [:] {
            if let s = value.stringValue { endpoints[key] = s }
        }
        let compat = obj["compat"]?.objectValue
        return DiscoveryCore(
            registration: obj["registration"]?.stringValue.flatMap(RegistrationPolicy.init),
            compatMin: compat?["min"]?.stringValue,
            compatMax: compat?["max"]?.stringValue,
            endpoints: endpoints)
    }

    private static func parseTrust(_ obj: [String: JSONValue]?) -> DiscoveryTrust? {
        guard let obj else { return nil }
        var pinned: TrustSet = [:]
        for (kid, value) in obj["pinnedKeys"]?.objectValue ?? [:] {
            if let s = value.stringValue { pinned[kid] = s }
        }
        return DiscoveryTrust(
            jwksUrl: obj["jwksUrl"]?.stringValue,
            trustManifestUrl: obj["trustManifestUrl"]?.stringValue,
            pinnedKeys: pinned)
    }

    /// Fetch and parse. The transport is passed in, so a local-only client's refusal propagates
    /// rather than being swallowed into "the product has no services".
    public static func fetch(
        endpoints: Endpoints, transport: any PolarisTransport, headers: [String: String] = [:],
        timeoutSeconds: Double = 15
    ) async -> DiscoveryResult {
        let response: PolarisResponse
        do {
            response = try await transport.send(
                PolarisRequest(
                    url: endpoints.discovery,
                    headers: headers.merging(["accept": "application/json"]) { a, _ in a },
                    timeoutSeconds: timeoutSeconds))
        } catch let error as PolarisError {
            return .error(status: 0, message: error.message)
        } catch {
            return .error(status: 0, message: error.localizedDescription)
        }
        if response.status == 404 { return .notFound }
        guard response.isOK else {
            return .error(
                status: response.status, message: String(decoding: response.body, as: UTF8.self))
        }
        return parse(response.body, expectedProduct: endpoints.product)
    }
}

/// The absolute appcast URL a Sparkle host should feed its updater, taken from Update's
/// PUBLISHED fragment rather than string-built by the caller.
///
/// §R1 moved these paths and left permanent aliases; a host that hard-codes one is a host that
/// breaks the next time they move, whereas the discovery document is the product's own statement
/// of where its feed lives. Returns nil when Update is disabled or publishes no feed — the same
/// fail-closed posture the sub-client gate takes, expressed as a value because asking "where is
/// my feed?" before discovery has run is a sequencing question, not an error.
public func appcastUrl(
    from document: ProductDiscoveryDocument, channel: String? = nil, arch: String? = nil
) -> URL? {
    guard let fragment = document.services[.update], fragment.enabled,
        let base = fragment.endpoints["appcast"], var components = URLComponents(string: base)
    else { return nil }

    if let channel, channel != "stable" {
        // `/update/<channel>/appcast.xml` is a PATH, not a query parameter (§R1) — the published
        // endpoint is the stable feed, and a channel feed is its sibling. The Worker also
        // publishes a `channelAppcast` template carrying a literal `{channel}` token; preferring
        // it keeps the substitution the product's decision rather than ours.
        if let template = fragment.endpoints["channelAppcast"],
            template.contains("{channel}"),
            let templated = URLComponents(
                string: template.replacingOccurrences(
                    of: "{channel}",
                    with: channel.addingPercentEncoding(
                        withAllowedCharacters: .urlPathAllowed) ?? channel))
        {
            components = templated
        } else {
            let safe =
                channel.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? channel
            components.path = components.path.replacingOccurrences(
                of: "/appcast.xml", with: "/\(safe)/appcast.xml")
        }
    }

    if let arch {
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "arch" }
        items.append(URLQueryItem(name: "arch", value: arch))
        components.queryItems = items
    }
    return components.url
}
