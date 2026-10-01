// The Config sub-client — layered settings resolution over the signed config document.
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// An `enforced`/`hidden` key is LOCKED: overriding it via `localOverrides` or an env var has no
// effect and the remote value still wins. That is the whole point of the management state —
// see packages/docs/src/content/docs/start/concepts.md.
//
// The OVERRIDE LAYERS are config-side options rather than Core ones for a reason: `envPrefix`,
// the environment table and `localOverrides` are inputs to THIS resolution and to nothing else,
// so a product that has disabled Config never has to think about them. The pre-suite client
// fused all of them into one twenty-field bag, which is how `trust` ended up looking like a
// licensing concern.

import Foundation
import PolarisKeyCore

/// Where a resolved config value came from, for diagnostics and settings UIs.
public enum ConfigSource: String, Sendable, Equatable {
    /// Remote `enforced` entry — server value wins, no override possible.
    case enforced
    /// Remote `hidden` entry — server value wins and the key is withheld from enumeration.
    case hidden
    /// A caller-supplied `localOverrides` value.
    case local
    /// An environment-variable override.
    case env
    /// A remote `default`-state value (no local/env override present).
    case remoteDefault = "remote-default"
    /// No remote entry and no override — the caller's `default:` fallback.
    case fallback
}

/// One user-facing catalog entry, for building settings UIs. `hidden` keys are excluded (they
/// are still APPLIED by `config(_:default:)`); `enforced` keys are shown read-only.
public struct UserConfigEntry: Sendable, Equatable {
    public let key: String
    public let value: JSONValue
    /// True iff the entry is `enforced` (the user cannot override it).
    public let enforced: Bool

    public init(key: String, value: JSONValue, enforced: Bool) {
        self.key = key
        self.value = value
        self.enforced = enforced
    }
}

public struct ConfigClientOptions: Sendable {
    /// User/local config overrides — beat a remote `default` value, but NOT an `enforced`/
    /// `hidden` one (the server stays authoritative for those).
    public let localOverrides: [String: JSONValue]
    /// Env-var prefix for config overrides. A key's env var is
    /// `${envPrefix}${key with "." → "__"}` — `run.concurrency` → `PKEY_CONFIG_run__concurrency`.
    public let envPrefix: String
    /// Environment table to read overrides from. Injected rather than read from
    /// `ProcessInfo` here so the precedence rules are testable without mutating the process.
    public let environment: [String: String]?

    public init(
        localOverrides: [String: JSONValue] = [:],
        envPrefix: String = DEFAULT_CONFIG_ENV_PREFIX,
        environment: [String: String]? = nil
    ) {
        self.localOverrides = localOverrides
        self.envPrefix = envPrefix
        self.environment = environment
    }
}

/// The env prefix. The interim `PLRS_CONFIG_` spelling withdrawn by Amendment A1 is not read (§8).
public let DEFAULT_CONFIG_ENV_PREFIX = "PKEY_CONFIG_"

public actor ConfigClient {
    private let core: CoreContext
    private let localOverrides: [String: JSONValue]
    private let envPrefix: String
    private let environment: [String: String]

    public init(core: CoreContext, options: ConfigClientOptions = ConfigClientOptions()) {
        self.core = core
        self.localOverrides = options.localOverrides
        self.envPrefix = options.envPrefix
        self.environment = options.environment ?? ProcessInfo.processInfo.environment
    }

    private func doc() async -> ConfigDoc? {
        await core.cache().config?.doc
    }

    /// Whether the product runs Config at all — the config-side twin of the gate's
    /// `not-applicable`.
    public func isEnabled() async -> Bool {
        await core.enabled(.config)
    }

    /// `GET /<p>/config/schema` — the product's active catalog, as served. `nil` on any failure,
    /// never a throw; see `ConfigEndpoints.fetchSchema`.
    public func fetchSchema() async -> Data? {
        await ConfigEndpoints.fetchSchema(core)
    }

    /// The product's active catalog version, as the last verified document stated it.
    public func schemaVersion() async -> Int? {
        await doc()?.schemaVersion
    }

    /// Resolve the effective value for `key`, honouring management state + the override layers.
    public func config(_ key: String, default fallback: JSONValue) async -> JSONValue {
        let entry = await doc()?.config[key]
        // enforced | hidden → the remote value is locked; local/env are ignored.
        if let entry, entry.state == .enforced || entry.state == .hidden { return entry.value }
        if let local = localOverrides[key] { return local }
        if let env = envValue(for: key) { return env }
        if let entry { return entry.value }
        return fallback
    }

    /// Where `config(key)` would source its value from (provenance, for settings UIs).
    public func configSource(_ key: String) async -> ConfigSource {
        let entry = await doc()?.config[key]
        if entry?.state == .enforced { return .enforced }
        if entry?.state == .hidden { return .hidden }
        if localOverrides[key] != nil { return .local }
        if envValue(for: key) != nil { return .env }
        if entry != nil { return .remoteDefault }
        return .fallback
    }

    /// The user-visible catalog: every remote entry MINUS the `hidden` ones, each carrying its
    /// effective value and whether it is `enforced`.
    public func listUserConfig() async -> [UserConfigEntry] {
        guard let config = await doc()?.config else { return [] }
        var out: [UserConfigEntry] = []
        for (key, entry) in config where entry.state != .hidden {
            out.append(
                UserConfigEntry(
                    key: key,
                    value: await self.config(key, default: entry.value),
                    enforced: entry.state == .enforced))
        }
        return out
    }

    /// A managed secret's value (string only), or nil. Secrets are never enumerated.
    public func secret(_ key: String) async -> String? {
        await doc()?.secrets[key]?.value.stringValue
    }

    /// Read + decode the env override for `key`, or nil if unset.
    ///
    /// The raw string is parsed as JSON when it LOOKS like JSON (so `"4"`→int, `true`→bool,
    /// `[1,2]`→array) and kept as a plain string otherwise. The look-first test matters: a bare
    /// `dark` is a perfectly good string value, and treating a parse failure as the signal would
    /// make the behaviour depend on how permissive this platform's JSON parser happens to be.
    private func envValue(for key: String) -> JSONValue? {
        let name = envPrefix + key.replacingOccurrences(of: ".", with: "__")
        guard let raw = environment[name] else { return nil }
        guard looksLikeJson(raw), let data = raw.data(using: .utf8),
            let parsed = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return .string(raw) }
        return parsed
    }

    private func looksLikeJson(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = t.first else { return false }
        if t == "true" || t == "false" || t == "null" { return true }
        if first == "{" || first == "[" || first == "\"" { return true }
        if first == "-" || first.isNumber {
            return t.range(
                of: #"^-?\d+(\.\d+)?([eE][+-]?\d+)?$"#, options: .regularExpression) != nil
        }
        return false
    }
}
