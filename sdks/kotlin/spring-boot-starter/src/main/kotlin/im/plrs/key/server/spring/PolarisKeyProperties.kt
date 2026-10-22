// The `polaris-key.*` properties of the Spring Boot starter (SP-61). One product is three properties; several
// products are `polaris-key.products[n].*`. Both may be set; the single form is listed first.
//
//     polaris-key.product=acme
//     polaris-key.pinned-keys.pkey-2026=<43 base64url characters>
//     polaris-key.base-url=https://key.plrs.im                       # the default
//
// `pkey sdk --lang kotlin --write` writes the slug, the pins and the base URL.

package im.plrs.key.server.spring

import im.plrs.key.server.PolarisProduct
import im.plrs.key.server.PolarisServerOptions
import org.springframework.boot.context.properties.ConfigurationProperties

/** What a refusal does: answer the problem (the default), or raise `PolarisKeyError` into Spring's exception resolvers. */
public enum class ErrorMode { Respond, Throw }

/** What a CORS preflight does at a gate: [Pass] (the default) lets it through, [Gate] refuses it like any other request. */
public enum class PreflightMode { Pass, Gate }

@ConfigurationProperties("polaris-key")
public class PolarisKeyProperties {
    /** False: the starter backs off entirely (no server bean). */
    public var enabled: Boolean = true

    /** The product slug, for the single-product form. */
    public var product: String? = null

    /** The pinned trust set of [product]: kid to raw Ed25519 public key, base64url. */
    public var pinnedKeys: MutableMap<String, String> = linkedMapOf()

    /** The Polaris Key origin of [product]. */
    public var baseUrl: String = "https://key.plrs.im"

    /** More products, when the server serves several; a document's `aud` picks its trust set. */
    public var products: MutableList<Product> = mutableListOf()

    /** Tighten the freshness window to this many seconds after `issuedAt` (plus the 300 s skew). */
    public var maxAgeSeconds: Long? = null

    /** False: verify against the pins alone, for an air-gapped server. */
    public var trustRefresh: Boolean = true

    public var cacheSize: Int = 1000

    /** [ErrorMode.Throw] hands a refusal to `@ExceptionHandler` / `@ControllerAdvice` as `PolarisKeyError`. */
    public var errors: ErrorMode = ErrorMode.Respond

    /** A CORS preflight passes every gate by default: it carries no licence. */
    public var preflight: PreflightMode = PreflightMode.Pass

    public class Product {
        public var slug: String = ""
        public var pinnedKeys: MutableMap<String, String> = linkedMapOf()
        public var baseUrl: String = "https://key.plrs.im"
    }

    /** The products these properties name; each is validated at construction, with the fix in the message. */
    public fun toProducts(): List<PolarisProduct> {
        val list = ArrayList<PolarisProduct>()
        if (product != null || pinnedKeys.isNotEmpty()) list += PolarisProduct(product.orEmpty(), pinnedKeys.toMap(), baseUrl)
        for (p in products) list += PolarisProduct(p.slug, p.pinnedKeys.toMap(), p.baseUrl)
        return list
    }

    /** The server options these properties name. [debug] receives the verdict lines. */
    public fun toOptions(debug: ((String) -> Unit)? = null): PolarisServerOptions = PolarisServerOptions(
        products = toProducts(),
        maxAgeSeconds = maxAgeSeconds,
        trustRefresh = trustRefresh,
        cacheSize = cacheSize,
        debug = debug,
    )
}
