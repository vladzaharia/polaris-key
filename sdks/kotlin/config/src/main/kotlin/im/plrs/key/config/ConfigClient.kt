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

package im.plrs.key.config

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ConfigDoc
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReacquireFn
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement

/** The env prefix. The interim `PLRS_CONFIG_` spelling withdrawn by Amendment A1 is not read. */
public const val DEFAULT_CONFIG_ENV_PREFIX: String = "PKEY_CONFIG_"

public data class ConfigClientOptions(
    /** User/local overrides: beat a remote `default`, never an `enforced`/`hidden` entry. */
    val localOverrides: Map<String, JsonElement> = emptyMap(),
    /** A key's variable is `${envPrefix}${key with "." → "__"}`: `run.concurrency` → `PKEY_CONFIG_run__concurrency`. */
    val envPrefix: String = DEFAULT_CONFIG_ENV_PREFIX,
    /** The environment table; defaults to `System.getenv()`. Injected so precedence is testable. */
    val environment: Map<String, String>? = null,
)

/**
 * @param reacquire the §5 single re-acquire an edge-mint 401 gets: the facade's one closure, the
 *   same a document 401 uses, so the route is chosen the same way. Without it a 401 simply fails.
 */
public class ConfigClient(
    private val core: CoreContext,
    options: ConfigClientOptions = ConfigClientOptions(),
    private val reacquire: ReacquireFn? = null,
) {
    private val localOverrides = options.localOverrides
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
            val (deviceToken, fresh) = MintEndpoint.mint(core, recipeId, reacquire)
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
    public suspend fun fetchSchema(): ByteArray? = ConfigEndpoints.fetchSchema(core)

    /** The product's active catalog version, as the last verified document stated it. */
    public suspend fun schemaVersion(): Long? = doc()?.schemaVersion

    private suspend fun context(): ResolveContext = ResolveContext(doc()?.config, localOverrides, environment, envPrefix)

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
