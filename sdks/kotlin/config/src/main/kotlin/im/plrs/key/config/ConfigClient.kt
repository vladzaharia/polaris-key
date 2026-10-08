// The Config sub-client — layered settings resolution over the signed config document, secrets,
// the catalog fetch and edge-mint. A port of Swift's `ConfigClient`.
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// An `enforced`/`hidden` key is LOCKED: a local override or an environment variable has no effect
// on it. The override layers are config-side options, not Core ones: they are inputs to THIS
// resolution and nothing else, so a product without Config never has to think about them.
//
// Edge-minted tokens are cached IN MEMORY ONLY, per recipe, each bound to the device token it was
// minted with: they are live credentials for someone else's API, so they never reach the cache
// file or a keystore, and a deactivation, a revoked token or a different identity invalidates them.
//
// SP-50: main-safe. The persisted overrides are read on first use and written on `Dispatchers.IO`,
// never in the constructor, so building a client on the main thread touches no file.

package im.plrs.key.config

import im.plrs.key.core.FileStateSlot
import im.plrs.key.core.JsonText
import im.plrs.key.core.ManagementState
import im.plrs.key.core.MemoryStateSlot
import im.plrs.key.core.StateSlot
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import im.plrs.key.core.CoreContext
import im.plrs.key.core.ConfigDoc
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReacquireFn
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement

/** The env prefix. The interim `PLRS_CONFIG_` spelling withdrawn by Amendment A1 is not read. */
public const val DEFAULT_CONFIG_ENV_PREFIX: String = "PKEY_CONFIG_"

public data class ConfigClientOptions @JvmOverloads constructor(
    /** User/local overrides: beat a remote `default`, never an `enforced`/`hidden` entry. */
    val localOverrides: Map<String, JsonElement> = emptyMap(),
    /** A key's variable is `${envPrefix}${key with "." → "__"}`: `run.concurrency` → `PKEY_CONFIG_run__concurrency`. */
    val envPrefix: String = DEFAULT_CONFIG_ENV_PREFIX,
    /** The environment table; defaults to `System.getenv()`. Injected so precedence is testable. */
    val environment: Map<String, String>? = null,
    /**
     * Where `set()`/`clear()` persist local overrides (notes/SDK-PARITY-PASS.md §3.11, `config.local`):
     * null is `local-config.json` in the store's state directory (on Android the Keystore store's
     * no-backup directory), or memory for a store without one. Pass any [StateSlot] to keep them
     * elsewhere.
     */
    val localStore: StateSlot? = null,
)

/** One change to a key's effective value (`ConfigClient.changes`). */
public data class ConfigChange(val key: String, val value: JsonElement?, val source: ConfigSource)

/**
 * @param reacquire the §5 single re-acquire an edge-mint 401 gets: the facade's one closure, the
 *   same a document 401 uses, so the route is chosen the same way. Without it a 401 simply fails.
 */
public class ConfigClient(
    private val core: CoreContext,
    options: ConfigClientOptions = ConfigClientOptions(),
    private val reacquire: ReacquireFn? = null,
    /**
     * §3.10's attest-and-retry: called once when an edge-mint answers 403 `attestation_required`;
     * true when the device attested (the mint is then retried once). Null: the refusal stands.
     */
    private val attest: (suspend () -> Boolean)? = null,
) {
    /** The host's static overrides; persisted user overrides layer over them. */
    private val hostOverrides = options.localOverrides
    private val localStoreOption = options.localStore
    private val localSlot: StateSlot by lazy {
        localStoreOption
            ?: core.store.stateDirectory?.let { FileStateSlot(java.io.File(it, "local-config.json")) }
            ?: MemoryStateSlot()
    }
    private val localLock = Mutex()
    @Volatile private var persistedValue: Map<String, JsonElement>? = null

    /** The persisted overrides, read from [localSlot] on first use (off the caller's dispatcher). */
    private suspend fun persisted(): Map<String, JsonElement> =
        persistedValue ?: localLock.withLock { loadedLocked() }

    /** Caller holds [localLock]. */
    private suspend fun loadedLocked(): Map<String, JsonElement> =
        persistedValue ?: withContext(Dispatchers.IO) { readPersisted() }.also { persistedValue = it }

    private suspend fun localOverrides(): Map<String, JsonElement> = hostOverrides + persisted()
    @Volatile private var catalogCache: Catalog? = null
    private val settings = java.util.concurrent.ConcurrentHashMap<String, MutableStateFlow<JsonElement?>>()
    private val changeFlow = MutableSharedFlow<ConfigChange>(extraBufferCapacity = 64)

    /** Every change to a key's effective value: a local `set()`/`clear()`, or a new document. */
    public val changes: SharedFlow<ConfigChange> = changeFlow.asSharedFlow()
    private val envPrefix = options.envPrefix
    private val environment: Map<String, String> = options.environment ?: try {
        System.getenv()
    } catch (e: SecurityException) {
        emptyMap()
    }

    private class Held(val deviceToken: String, val token: MintedToken)
    private class Pending(val deviceToken: String, val result: CompletableDeferred<MintedToken>)

    private val mintLock = Mutex()
    private val minted = HashMap<String, Held>()
    private val minting = HashMap<String, Pending>()

    /**
     * Mint a third-party token through the product's edge-mint recipe [recipeId]. Reused until
     * [MINT_REUSE_MARGIN_SECONDS] before `expiresAt` while the same device token is held; concurrent
     * callers share one request. A 401 gets the one re-acquire (§5), then one retry.
     *
     * Throws [PolarisException]: `service-unavailable` (no Config, before any request),
     * `bad_request` (a recipe id the router could never match, before any request), `unauthorized`
     * (no token, or still 401 after the re-acquire), or the Worker's code (`not_found`,
     * `rate_limited`, `misconfigured`).
     */
    public suspend fun mintToken(recipeId: String): MintedToken {
        core.requireService(ServiceSlug.config, Feature.configMint)
        if (!MintEndpoint.isRecipeId(recipeId)) {
            throw PolarisException(
                ErrorCode.badRequest, "\"$recipeId\" is not an edge-mint recipe id (lowercase letters, digits and \"-\").",
            )
        }
        val current = core.token()
        val now = core.now()
        val (mine, shared) = mintLock.withLock<Pair<Pending?, CompletableDeferred<MintedToken>?>> {
            minted[recipeId]?.let { held ->
                if (current != null && held.deviceToken == current && now < held.token.expiresAt - MINT_REUSE_MARGIN_SECONDS) {
                    return held.token
                }
                minted.remove(recipeId)
            }
            minting[recipeId]?.let { pending ->
                if (current != null && pending.deviceToken == current) return@withLock Pair(null, pending.result)
            }
            val p = Pending(current ?: "", CompletableDeferred())
            minting[recipeId] = p
            Pair(p, null)
        }
        if (shared != null) return shared.await()
        mine!!
        try {
            val (deviceToken, fresh) = im.plrs.key.core.attestAndRetry(attest) { MintEndpoint.mint(core, recipeId, reacquire) }
            mintLock.withLock {
                minted[recipeId] = Held(deviceToken, fresh)
                if (minting[recipeId] === mine) minting.remove(recipeId)
            }
            mine.result.complete(fresh)
            return fresh
        } catch (e: Throwable) {
            mintLock.withLock {
                minted.remove(recipeId)
                if (minting[recipeId] === mine) minting.remove(recipeId)
            }
            mine.result.completeExceptionally(e)
            throw e
        }
    }

    private suspend fun doc(): ConfigDoc? = core.cache().config?.doc

    /** Whether the product runs Config at all: the config-side twin of the gate's `not-applicable`. */
    public suspend fun isEnabled(): Boolean = core.enabled(ServiceSlug.config)

    /** `GET /<p>/config/schema`: the active catalog as served; null on any failure, never a throw. */
    public suspend fun fetchSchema(): ByteArray? = ConfigEndpoints.fetchSchema(core)?.also { b -> Catalog.parse(b)?.let { catalogCache = it } }

    /** The active catalog as types (fetched, then kept for validation); null on any failure. */
    public suspend fun fetchCatalog(): Catalog? = fetchSchema()?.let { Catalog.parse(it) } ?: catalogCache

    /** The catalog the last successful fetch returned, or null. Offline. */
    public val catalog: Catalog? get() = catalogCache

    // ── config.local (§3.11) ─────────────────────────────────────────────────────────────────

    /**
     * Persist a local override for [key]. It beats a remote `default` and never an `enforced` or
     * `hidden` entry (refused `managed_by_admin`). [value] is checked against the catalog entry's
     * schema when the catalog is known, else against the JSON type of the document's value
     * (`invalid-options` when it does not fit). Emits on [changes] and the key's [setting].
     */
    public suspend fun set(key: String, value: JsonElement) {
        val entry = doc()?.config?.get(key)
        if (entry != null && (entry.state == ManagementState.enforced || entry.state == ManagementState.hidden)) {
            throw PolarisException(ErrorCode.managedByAdmin, "$key is managed by the product's administrator and cannot be changed here.")
        }
        val problem = catalogCache?.entry(key)?.problem(value)
            ?: entry?.takeIf { !sameJsonType(it.value, value) }?.let { "$key takes the same type as its current value" }
        if (problem != null) throw PolarisException(ErrorCode.invalidOptions, problem)
        localLock.withLock { save(loadedLocked() + (key to value)) }
        publish()
    }

    /** Remove the local override for [key] (the remote default, environment or fallback answer again). */
    public suspend fun clear(key: String) {
        localLock.withLock {
            val current = loadedLocked()
            if (!current.containsKey(key)) return
            save(current - key)
        }
        publish()
    }

    /** Remove every persisted local override. */
    public suspend fun clearAll() {
        localLock.withLock {
            if (loadedLocked().isEmpty()) return
            save(emptyMap())
        }
        publish()
    }

    /** The persisted local overrides (not the host's static ones). */
    public suspend fun localValues(): Map<String, JsonElement> = persisted()

    /** Caller holds [localLock]: write [values], then hold them. */
    private suspend fun save(values: Map<String, JsonElement>) {
        withContext(Dispatchers.IO) { writePersisted(values) }
        persistedValue = values
    }

    /**
     * A live handle on [key]'s effective value: the current value now, then every change (a local
     * override, a new verified document). Null while no layer answers.
     */
    public suspend fun setting(key: String): StateFlow<JsonElement?> {
        val flow = settings.getOrPut(key) { MutableStateFlow(null) }
        flow.value = ConfigResolution.resolveValue(context(), key)
        return flow.asStateFlow()
    }

    /**
     * Re-resolve every key a [setting] watches and emit [changes] for those whose value moved. The
     * umbrella client calls it after a sync applied a new document; `set()`/`clear()` call it too.
     */
    public suspend fun publish(emit: Boolean = true) {
        val ctx = context()
        val keys = LinkedHashSet<String>(settings.keys)
        doc()?.config?.keys?.let { keys += it }
        keys += localOverrides().keys
        keys += lastSeen.keys
        for (key in keys) {
            val now = ConfigResolution.resolveValue(ctx, key)
            if (emit && now != lastSeen[key]) changeFlow.tryEmit(ConfigChange(key, now, ConfigResolution.resolveSource(ctx, key)))
            if (now == null) lastSeen.remove(key) else lastSeen[key] = now
            settings[key]?.value = now
        }
    }

    private val lastSeen = java.util.concurrent.ConcurrentHashMap<String, JsonElement>()

    private fun readPersisted(): Map<String, JsonElement> {
        val o = localSlot.read()?.let { JsonText.parseOrNull(it) }.objectValue ?: return emptyMap()
        if (o["v"].longValue != 1L) return emptyMap()
        return o["values"].objectValue?.toMap() ?: emptyMap()
    }

    private fun writePersisted(values: Map<String, JsonElement>) {
        try {
            localSlot.write(JsonObject(mapOf("v" to im.plrs.key.core.jsonInt(1), "values" to JsonObject(values))).toString())
        } catch (e: Exception) {
            throw PolarisException(ErrorCode.storeFailed, "the local override could not be saved: ${e.message}", cause = e)
        }
    }

    /** The product's active catalog version, as the last verified document stated it. */
    public suspend fun schemaVersion(): Long? = doc()?.schemaVersion

    private suspend fun context(): ResolveContext = ResolveContext(doc()?.config, localOverrides(), environment, envPrefix)

    /** The effective value for [key], honouring management state and the override layers. */
    public suspend fun config(key: String, default: JsonElement): JsonElement =
        ConfigResolution.resolveValue(context(), key) ?: default

    /** Where `config(key)` would source its value from (provenance, for settings UIs). */
    public suspend fun configSource(key: String): ConfigSource = ConfigResolution.resolveSource(context(), key)

    /** The user-visible catalog (§2.2.1 rule 4): every document entry minus the `hidden` ones. */
    public suspend fun listUserConfig(): List<UserConfigEntry> = ConfigResolution.listUserEntries(context())

    /** A managed secret's value (string only), or null. Secrets are never enumerated. */
    public suspend fun secret(key: String): String? = doc()?.secrets?.get(key)?.value.stringValue
}
