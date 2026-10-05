// `PolarisKeyClient.fromBundle()` — one call from a bundled `PolarisKey.plist` to a started client
// (notes/SDK-PARITY-PASS.md §2.4, §3.19).
//
// The plist is generated, never hand-written: `pkey sdk --lang swift --write` (SP-02) fetches the
// product's discovery document and writes its trust pins, release-key pins and services. Keys
// (camelCase, the same names as the other SDKs' generated config):
//
//   product            String   the product slug (required; `productSlug` is accepted too)
//   baseUrl            String   default https://key.plrs.im
//   pinnedKeys         Dict     kid → base64url Ed25519 public key (required, non-empty)
//   pinnedReleaseKeys  Dict     kid → base64url release-signing key, for `client.update`
//   expectedServices   [String] the services the product runs (discovery still refines them)
//   channel            String   the release channel this build follows
//   refreshIntervalSeconds Number  opt-in polling
//
// The version is the bundle's `CFBundleShortVersionString`, so it is never pasted either.

import Foundation
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense

/// What `fromBundle()` read from `PolarisKey.plist`.
public struct PolarisKeyBundleConfig: Sendable, Equatable {
    public static let resourceName = "PolarisKey"

    public var product: String
    public var baseUrl: String
    public var pinnedKeys: TrustSet
    public var pinnedReleaseKeys: TrustSet
    public var expectedServices: [ServiceSlug]?
    public var channel: String?
    public var refreshIntervalSeconds: Double?

    /// Parse the plist's dictionary. Throws `PolarisError(invalid-options)` naming the bad key.
    public init(plist: [String: Any]) throws {
        func bad(_ key: String, _ why: String) -> PolarisError {
            PolarisError(
                code: ErrorCode.invalidOptions, message: "PolarisKey.plist: \(key) \(why).")
        }
        guard let product = (plist["product"] ?? plist["productSlug"]) as? String,
            !product.isEmpty
        else { throw bad("product", "is missing") }
        self.product = product
        self.baseUrl = (plist["baseUrl"] as? String) ?? "https://key.plrs.im"
        func keys(_ name: String) throws -> TrustSet {
            guard let raw = plist[name] else { return [:] }
            guard let dict = raw as? [String: String] else {
                throw bad(name, "is not a dictionary of strings")
            }
            return dict
        }
        self.pinnedKeys = try keys("pinnedKeys")
        guard !pinnedKeys.isEmpty else { throw bad("pinnedKeys", "is missing or empty") }
        self.pinnedReleaseKeys = try keys("pinnedReleaseKeys")
        if let raw = plist["expectedServices"] {
            guard let list = raw as? [String] else { throw bad("expectedServices", "is not a list") }
            var slugs: [ServiceSlug] = []
            for s in list {
                guard let slug = ServiceSlug(rawValue: s) else {
                    throw bad("expectedServices", "names an unknown service \"\(s)\"")
                }
                slugs.append(slug)
            }
            self.expectedServices = slugs
        } else {
            self.expectedServices = nil
        }
        self.channel = plist["channel"] as? String
        self.refreshIntervalSeconds = (plist["refreshIntervalSeconds"] as? NSNumber)?.doubleValue
    }

    /// Read `PolarisKey.plist` from `bundle`.
    public static func load(from bundle: Foundation.Bundle = .main) throws -> PolarisKeyBundleConfig {
        guard let url = bundle.url(forResource: resourceName, withExtension: "plist") else {
            throw PolarisError(
                code: ErrorCode.notConfigured,
                message:
                    "No PolarisKey.plist in the app bundle. Generate it with `pkey sdk --lang swift --write` and add it to the app target.")
        }
        let data = try Data(contentsOf: url)
        guard
            let dict = try PropertyListSerialization.propertyList(from: data, format: nil)
                as? [String: Any]
        else {
            throw PolarisError(
                code: ErrorCode.invalidOptions, message: "PolarisKey.plist is not a dictionary.")
        }
        return try PolarisKeyBundleConfig(plist: dict)
    }
}

extension PolarisKeyClient {
    /// The bundle's marketing version, or nil.
    public static func bundleVersion(_ bundle: Foundation.Bundle = .main) -> String? {
        bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    /// Options from a parsed `PolarisKey.plist` plus this build's version.
    public static func options(
        from config: PolarisKeyBundleConfig, version: String, store: (any Store)? = nil,
        transport: (any PolarisTransport)? = nil
    ) -> PolarisKeyClientOptions {
        PolarisKeyClientOptions(
            productSlug: config.product, baseUrl: config.baseUrl, version: version,
            channel: config.channel, pinnedKeys: config.pinnedKeys, store: store,
            transport: transport, expectedServices: config.expectedServices,
            refreshIntervalSeconds: config.refreshIntervalSeconds,
            pinnedReleaseKeys: config.pinnedReleaseKeys)
    }

    /// Read `PolarisKey.plist` and the bundle version, build the client and `start()` it (no
    /// network). Throws `PolarisError` `not-configured` (no plist), `invalid-options` (a bad key),
    /// or what `create(options:)` throws.
    public static func fromBundle(
        _ bundle: Foundation.Bundle = .main, version: String? = nil
    ) async throws -> PolarisKeyClient {
        let config = try PolarisKeyBundleConfig.load(from: bundle)
        guard let version = version ?? bundleVersion(bundle) else {
            throw PolarisError(
                code: ErrorCode.invalidOptions,
                message: "The bundle has no CFBundleShortVersionString; pass version:.")
        }
        return try await create(options: options(from: config, version: version))
    }
}
