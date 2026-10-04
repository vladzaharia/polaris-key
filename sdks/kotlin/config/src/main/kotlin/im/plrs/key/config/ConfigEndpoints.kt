// The Config service's HTTP surface — `GET /<p>/config/document`, `GET /<p>/config/schema` and the
// edge-mint route (wire contract v3 §2.2, §5; P0-12). A port of Swift's `Fetch.swift` and
// `Mint.swift`.
//
// What is NOT here matters as much: there is no build gate (version and channel are licence grants,
// D-20, so this fetch is never `blocked`), no `/config/report` (telemetry moved to Core's
// `POST /<p>/devices/report`), and no status ladder (both signed documents go through Core's
// `getDocument`, so they can never drift on what a 403, a 429 or a dropped connection means).

package im.plrs.key.config

import im.plrs.key.core.CoreContext
import im.plrs.key.core.DocumentResult
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ReacquireFn
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.arrayValue
import im.plrs.key.core.decimalValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException

public object ConfigEndpoints {
    /** `GET /<p>/config/document`: the signed config + secrets document, with its OWN ETag (§5). */
    public suspend fun fetchDocument(core: CoreContext, token: String, etag: String? = null): DocumentResult =
        core.getDocument(DocumentSlice.config, token, etag)

    /**
     * `GET /<p>/config/schema`: the product's active catalog, unsigned and unauthenticated.
     * Diagnostic only (nothing security-relevant is read from it), so every failure (a refusal, a
     * transport error, a body that is not a catalog, local-only mode, a product that does not run
     * Config, which is not even probed, D-21) is null, never a throw. The bytes are returned as
     * served.
     */
    public suspend fun fetchSchema(core: CoreContext): ByteArray? {
        if (!core.enabled(ServiceSlug.config)) return null
        val response = try {
            core.request(core.endpoints.configSchema, headers = mapOf("accept" to "application/json"))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        if (!response.isOk || !isCatalog(response.body)) return null
        return response.body
    }

    /** The catalog's outer shape: an integral `schemaVersion` and an `entries` array. */
    public fun isCatalog(body: ByteArray): Boolean {
        val root = JsonText.parseOrNull(body.toString(Charsets.UTF_8)).objectValue ?: return false
        val version = root["schemaVersion"].decimalValue ?: return false
        if (version.stripTrailingZeros().scale() > 0) return false
        return root["entries"].arrayValue != null
    }
}

/** What a mint returns. Its `toString` shows [token] as `[redacted]`. */
public data class MintedToken(val token: String, /** Epoch seconds. */ val expiresAt: Long) {
    override fun toString(): String = "MintedToken(token=[redacted], expiresAt=$expiresAt)"
}

/** A cached minted token is reused until this many seconds before its `expiresAt`. */
public const val MINT_REUSE_MARGIN_SECONDS: Long = 30

/** Edge-mint: `GET /<p>/config/mint/<recipeId>/token`, authenticated with the device token. */
public object MintEndpoint {
    /**
     * The router's recipe-id alphabet (`MINT_ID` in the Worker's `services/config/routes.ts`): a
     * traversal or an encoded separator can never reach the recipe lookup.
     */
    public fun isRecipeId(id: String): Boolean = id.isNotEmpty() && id.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }

    /** One mint (with the single re-acquire), and the device token presented for it. */
    public suspend fun mint(core: CoreContext, recipeId: String, reacquire: ReacquireFn?): Pair<String, MintedToken> {
        val token = core.token() ?: throw PolarisException(
            ErrorCode.unauthorized, "edge-mint needs a device token: activate, enrol, sign in or register first.",
        )
        var presented = token
        var response = get(core, presented, recipeId)
        if (response.status == 401 && reacquire != null) {
            val next = core.reacquireOutsideSync(reacquire)
            if (next != null) {
                presented = next
                response = get(core, presented, recipeId)
            }
        }
        val o = JsonText.parseOrNull(response.text).objectValue
        if (response.status == 200) {
            val minted = o?.get("token").stringValue
            val expiresAt = o?.get("expiresAt").longValue
            if (minted == null || expiresAt == null) {
                throw PolarisException(ErrorCode.badResponse, "edge-mint answered without a token and its expiry.")
            }
            return presented to MintedToken(minted, expiresAt)
        }
        // The Worker's flat (`{"error":"x"}`) or nested (`{"error":{"code":"x"}}`) body.
        val code = o?.get("error").stringValue ?: o?.get("error").objectValue?.get("code").stringValue
        throw PolarisException(
            code ?: "http_${response.status}",
            o?.get("message").stringValue ?: "edge-mint of \"$recipeId\" failed with status ${response.status}.",
        )
    }

    private suspend fun get(core: CoreContext, token: String, recipeId: String): PolarisResponse = try {
        core.request(core.endpoints.configMint(recipeId), headers = mapOf("authorization" to "Bearer $token"))
    } catch (e: CancellationException) {
        throw e
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.localOnly) throw e
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    }
}
