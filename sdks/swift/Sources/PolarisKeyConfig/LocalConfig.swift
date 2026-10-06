// Persisted local overrides (notes/SDK-PARITY-PASS.md §3.11, SP-S14) and the decoded catalog.
//
// `config.set(key, value)` writes the user's own value for a `config` key; it sits in the
// resolution's LOCAL layer (above the environment and a remote `default`, below `enforced` and
// `hidden`, which stay authoritative), survives restarts and raises a `config(key:)` change event.
// `clear(key)` removes it. Values persist in UserDefaults (an app group's suite when
// `LocalConfigOptions.suiteName` names one) under one key per product; a host can pass its own
// `LocalConfigStore`, and `MemoryLocalConfigStore` keeps nothing between launches.
//
// Validation is against the product's catalog (`GET /<p>/config/schema`), fetched once per
// process when first needed: an unknown key, a `secret` or `flag`, or a value that does not match
// the entry's schema `type` / `enum` is refused with `invalid-options`. A locked key (`enforced`
// or `hidden` in the signed document) is refused too, because the value could never take effect.
// When the catalog cannot be fetched (offline, no Config service) the value is kept unvalidated
// and resolution still applies it only where the management state allows.

import Foundation
import PolarisKeyCore

/// Where persisted local overrides live.
public protocol LocalConfigStore: Sendable {
    func load() -> [String: JSONValue]
    func save(_ values: [String: JSONValue])
}

/// UserDefaults, one JSON blob per product (`pkey.config.local.<product>`).
public struct UserDefaultsLocalConfigStore: LocalConfigStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    /// `suiteName` names an app-group suite shared with extensions; nil uses `.standard`.
    public init(product: String, suiteName: String? = nil) {
        self.defaults = suiteName.flatMap { UserDefaults(suiteName: $0) } ?? .standard
        self.key = "pkey.config.local." + product
    }

    public func load() -> [String: JSONValue] {
        guard let data = defaults.data(forKey: key),
            case .object(let o)? = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return [:] }
        return o
    }

    public func save(_ values: [String: JSONValue]) {
        if values.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(JSONValue.object(values)) {
            defaults.set(data, forKey: key)
        }
    }
}

/// Kept in memory only (tests, previews, a host that persists elsewhere).
public final class MemoryLocalConfigStore: LocalConfigStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: JSONValue]

    public init(_ values: [String: JSONValue] = [:]) { self.values = values }
    public func load() -> [String: JSONValue] { lock.withLock { values } }
    public func save(_ values: [String: JSONValue]) { lock.withLock { self.values = values } }
}

/// Where `config.set` persists. Default: UserDefaults (`.standard`).
public struct LocalConfigOptions: Sendable {
    /// An app-group UserDefaults suite (shared with extensions); nil for `.standard`.
    public var suiteName: String?
    /// A host store instead of UserDefaults.
    public var store: (any LocalConfigStore)?

    public init(suiteName: String? = nil, store: (any LocalConfigStore)? = nil) {
        self.suiteName = suiteName
        self.store = store
    }
}

// ── The catalog ─────────────────────────────────────────────────────────────────────────────

/// One catalog entry (`@polaris-key/catalog`'s `ConfigEntry`). Unknown members are ignored.
public struct ConfigCatalogEntry: Sendable, Equatable, Decodable {
    /// Rendering hints; they never affect validation.
    public struct UiHints: Sendable, Equatable, Decodable {
        public var widget: String?
        public var help: String?
        public var placeholder: String?
        public var order: Int?
        public var advanced: Bool?
        public var unit: String?
        public var optionLabels: [String: String]?
    }

    public struct DependsOn: Sendable, Equatable, Decodable {
        public var key: String
        public var equals: JSONValue
    }

    public var key: String
    /// `config`, `secret` or `flag`.
    public var kind: String
    public var category: String
    public var label: String
    public var description: String
    /// The Draft-07-subset JSON Schema fragment.
    public var schema: JSONValue
    public var `default`: JSONValue?
    /// `default`, `enforced` or `hidden` (config keys).
    public var managementDefault: String?
    public var userGrant: Bool?
    public var grantLabel: String?
    public var ui: UiHints?
    public var dependsOn: DependsOn?
    public var deprecated: Bool?
    public var since: String?

    /// The schema's `type` (`string`, `integer`, `number`, `boolean`, `object`, `array`), if one.
    public var schemaType: String? { schema.objectValue?["type"]?.stringValue }
    /// The schema's `enum`, if one.
    public var allowedValues: [JSONValue]? { schema.objectValue?["enum"]?.arrayValue }

    /// Whether `value` satisfies the entry's `type` and `enum` (the checks a settings UI needs;
    /// the server validates the full schema when an admin writes a value).
    public func accepts(_ value: JSONValue) -> Bool {
        if let allowed = allowedValues, !allowed.contains(value) { return false }
        switch (schemaType, value) {
        case (nil, _): return true
        case ("string", .string), ("boolean", .bool), ("object", .object), ("array", .array): return true
        case ("integer", .int): return true
        case ("integer", .double(let d)): return d == d.rounded()
        case ("number", .int), ("number", .double): return true
        case ("null", .null): return true
        default: return false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case key, kind, category, label, description, schema, `default`, managementDefault, userGrant,
            grantLabel, ui, dependsOn, deprecated, since
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        kind = try c.decode(String.self, forKey: .kind)
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        schema = try c.decodeIfPresent(JSONValue.self, forKey: .schema) ?? .object([:])
        `default` = try c.decodeIfPresent(JSONValue.self, forKey: .default)
        managementDefault = try c.decodeIfPresent(String.self, forKey: .managementDefault)
        userGrant = try c.decodeIfPresent(Bool.self, forKey: .userGrant)
        grantLabel = try c.decodeIfPresent(String.self, forKey: .grantLabel)
        ui = try? c.decodeIfPresent(UiHints.self, forKey: .ui)
        dependsOn = try? c.decodeIfPresent(DependsOn.self, forKey: .dependsOn)
        deprecated = try c.decodeIfPresent(Bool.self, forKey: .deprecated)
        since = try c.decodeIfPresent(String.self, forKey: .since)
    }
}

/// The product's catalog as served (`ProductCatalog`).
public struct ConfigCatalog: Sendable, Equatable, Decodable {
    public var schemaVersion: Int
    public var entries: [ConfigCatalogEntry]

    public func entry(_ key: String) -> ConfigCatalogEntry? { entries.first { $0.key == key } }

    /// Decode a catalog body; nil when it is not one.
    public static func decode(_ data: Data) -> ConfigCatalog? {
        try? JSONDecoder().decode(ConfigCatalog.self, from: data)
    }
}
