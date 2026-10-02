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
    private let reacquire: ReacquireFn?
    /// Edge-minted tokens, in memory only, each with the device token it was minted with (see
    /// `Mint.swift`).
    private var minted: [String: (deviceToken: String, token: MintedToken)] = [:]
    private var minting: [String: (deviceToken: String, task: Task<MintedToken, Error>)] = [:]

    /// - Parameter reacquire: the §5 single re-acquire an edge-mint 401 gets — the facade's one
    ///   closure, the same a document 401 uses, so the route (`license/token`, or re-registration
    ///   for a licence-less device) is chosen the same way. Injected because the routes belong to
    ///   the license and devices modules; without it a 401 simply fails.
    public init(
        core: CoreContext, options: ConfigClientOptions = ConfigClientOptions(),
        reacquire: ReacquireFn? = nil
    ) {
        self.core = core
        self.localOverrides = options.localOverrides
        self.envPrefix = options.envPrefix
        self.environment = options.environment ?? ProcessInfo.processInfo.environment
        self.reacquire = reacquire
    }

    /// Mint a third-party token through the product's edge-mint recipe `recipeId`
    /// (`GET /<p>/config/mint/<recipeId>/token`, authenticated with the device token).
    ///
    /// Minted tokens are cached IN MEMORY ONLY, per recipe, and reused until 30 seconds before
    /// `expiresAt`: they are short-lived secrets and never reach the cache file or the keychain. A
    /// 401 gets the one re-acquire every authenticated call gets (§5), then one retry.
    ///
    /// Throws `PolarisError`: `service-unavailable` (no Config service, before any request),
    /// `bad_request` (a recipe id the router could never match, before any request),
    /// `unauthorized` (no token, or still 401 after the re-acquire), or the Worker's code —
    /// `not_found` for an unknown or unapproved recipe, `rate_limited`, `misconfigured`.
    public func mintToken(_ recipeId: String) async throws -> MintedToken {
        try await core.requireService(.config, feature: Feature.configMint)
        guard MintEndpoint.isRecipeId(recipeId) else {
            throw PolarisError(
                code: "bad_request",
                message:
                    "\"\(recipeId)\" is not an edge-mint recipe id (lowercase letters, digits and \"-\").")
        }
        let current = await core.token
        if let held = minted[recipeId] {
            if let current, held.deviceToken == current,
                await core.now() < held.token.expiresAt - MINT_REUSE_MARGIN_SECONDS
            {
                return held.token
            }
            minted[recipeId] = nil
        }
        if let pending = minting[recipeId], let current, pending.deviceToken == current {
            return try await pending.task.value
        }
        let core = self.core
        let reacquire = self.reacquire
        let task = Task { () async throws -> MintedToken in
            let (deviceToken, fresh) = try await MintEndpoint.mint(
                core, recipeId: recipeId, reacquire: reacquire)
            self.store(recipeId, deviceToken: deviceToken, token: fresh)
            return fresh
        }
        minting[recipeId] = (current ?? "", task)
        defer {
            if minting[recipeId]?.task == task { minting[recipeId] = nil }
        }
        do {
            return try await task.value
        } catch {
            minted[recipeId] = nil
            throw error
        }
    }

    private func store(_ recipeId: String, deviceToken: String, token: MintedToken) {
        minted[recipeId] = (deviceToken, token)
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

    /// The resolution inputs: the last verified document plus this client's override layers.
    private func context() async -> ResolveContext {
        ResolveContext(
            remote: await doc()?.config, localOverrides: localOverrides, env: environment,
            envPrefix: envPrefix)
    }

    /// Resolve the effective value for `key`, honouring management state + the override layers
    /// (`ConfigResolution`, WIRE-CONTRACT-V3 §2.2.1).
    public func config(_ key: String, default fallback: JSONValue) async -> JSONValue {
        ConfigResolution.resolveValue(await context(), key) ?? fallback
    }

    /// Where `config(key)` would source its value from (provenance, for settings UIs).
    public func configSource(_ key: String) async -> ConfigSource {
        ConfigResolution.resolveSource(await context(), key)
    }

    /// The user-visible catalog (§2.2.1 rule 4): every document entry MINUS the `hidden` ones,
    /// each carrying its effective value and whether it is `enforced`.
    public func listUserConfig() async -> [UserConfigEntry] {
        ConfigResolution.listUserEntries(await context())
    }

    /// A managed secret's value (string only), or nil. Secrets are never enumerated.
    public func secret(_ key: String) async -> String? {
        await doc()?.secrets[key]?.value.stringValue
    }
}
