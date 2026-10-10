// Product discovery: `GET /<product>/.well-known/polaris.json` — wire contract v3.
//
// The document's `services` map is the authority for which opt-in services the product runs. It
// FAILS CLOSED (D-21): a slug the document omits reads as disabled, a malformed `services` value
// refuses the whole document, and `enabled` must be a real boolean. The document may grow: fields
// the SDK does not read are kept. Discovery is explicit (a network read); before it has answered,
// capabilities come from the host's `expectedServices`, else the suite default. `core.presentation`
// is parsed here too (Presentation.kt): the product's display data, unsigned and never a gate input.

package im.plrs.key.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Per-service state as the SDK consumes it. */
public typealias ServicesMap = Map<ServiceSlug, Boolean>

/** The service table's `defaultEnabled` rows: licensing and settings delivery. */
public val DEFAULT_SERVICES: ServicesMap = ServiceSlug.entries.associateWith { it.isDefaultEnabled }

/** Everything off. */
public val NO_SERVICES: ServicesMap = ServiceSlug.entries.associateWith { false }

/** A host's `expectedServices` as a full map; everything unlisted is off. */
public fun servicesFromList(slugs: Collection<ServiceSlug>): ServicesMap = ServiceSlug.entries.associateWith { it in slugs }

/** One service's published fragment; `enabled` is the only field Core reads. */
public data class ServiceFragment(
    val enabled: Boolean,
    val endpoints: Map<String, String> = emptyMap(),
    val extras: Map<String, JsonElement> = emptyMap(),
) {
    public companion object {
        public val disabled: ServiceFragment = ServiceFragment(false)
    }
}

/** Core's always-on block. */
public data class DiscoveryCore(
    val registration: RegistrationPolicy? = null,
    val compatMin: String? = null,
    val compatMax: String? = null,
    val endpoints: Map<String, String> = emptyMap(),
)

/** The published trust pointers. `pinnedKeys` is informational ONLY: never a key source (§1). */
public data class DiscoveryTrust(
    val jwksUrl: String? = null,
    val trustManifestUrl: String? = null,
    val pinnedKeys: TrustSet = emptyMap(),
)

public data class ProductDiscoveryDocument(
    val product: String,
    val name: String? = null,
    val baseUrl: String? = null,
    val protocolVersion: Long? = null,
    val core: DiscoveryCore? = null,
    val trust: DiscoveryTrust? = null,
    /** Every slug has an entry; absent slugs read as disabled. */
    val services: Map<ServiceSlug, ServiceFragment>,
    /**
     * `core.presentation` (WIRE-CONTRACT-V4 §5.5), normalised by [PresentationRules.parsePresentation]:
     * unsigned display data, never a gate input. Null when the document carries none (or an
     * invalid one); a malformed field is dropped and never refuses the document.
     */
    val presentation: Presentation? = null,
) {
    /** The capability map Core gates sub-clients on. */
    val servicesMap: ServicesMap get() = ServiceSlug.entries.associateWith { services[it]?.enabled == true }
}

public sealed interface DiscoveryResult {
    public data class Ok(val document: ProductDiscoveryDocument) : DiscoveryResult

    public data object NotFound : DiscoveryResult

    public data class Invalid(val message: String) : DiscoveryResult

    public data class Error(val status: Int, val message: String) : DiscoveryResult
}

public object Discovery {
    private fun strings(o: JsonObject?): Map<String, String> =
        o?.entries?.mapNotNull { (k, v) -> v.stringValue?.let { k to it } }?.toMap() ?: emptyMap()

    /** Parse a discovery document; the fail-closed rules as pure data. */
    public fun parse(text: String, expectedProduct: String): DiscoveryResult {
        val obj = JsonText.parseOrNull(text).objectValue
            ?: return DiscoveryResult.Invalid("Discovery document must be a JSON object.")
        val product = obj["product"].stringValue
            ?: obj["product"].objectValue?.get("slug").stringValue
            ?: obj["slug"].stringValue
        if (product.isNullOrEmpty()) return DiscoveryResult.Invalid("Discovery document is missing product.")
        if (product != expectedProduct) {
            return DiscoveryResult.Invalid("Discovery document product $product does not match $expectedProduct.")
        }
        val servicesObj = obj["services"].objectValue
            ?: return DiscoveryResult.Invalid("Discovery services must be a map of service fragments.")
        val services = LinkedHashMap<ServiceSlug, ServiceFragment>()
        for (slug in ServiceSlug.entries) {
            val raw = servicesObj[slug.slug]
            if (raw == null) {
                services[slug] = ServiceFragment.disabled
                continue
            }
            val fragment = raw.objectValue
                ?: return DiscoveryResult.Invalid("Discovery service ${slug.slug} must be an object.")
            services[slug] = ServiceFragment(
                enabled = fragment["enabled"].boolValue == true,
                endpoints = strings(fragment["endpoints"].objectValue),
                extras = fragment.filterKeys { it != "enabled" && it != "endpoints" },
            )
        }
        val core = obj["core"].objectValue?.let { c ->
            val compat = c["compat"].objectValue
            DiscoveryCore(
                registration = RegistrationPolicy.of(c["registration"].stringValue),
                compatMin = compat?.get("min").stringValue,
                compatMax = compat?.get("max").stringValue,
                endpoints = strings(c["endpoints"].objectValue),
            )
        }
        val trust = obj["trust"].objectValue?.let { t ->
            DiscoveryTrust(
                jwksUrl = t["jwksUrl"].stringValue,
                trustManifestUrl = t["trustManifestUrl"].stringValue,
                pinnedKeys = strings(t["pinnedKeys"].objectValue),
            )
        }
        return DiscoveryResult.Ok(
            ProductDiscoveryDocument(
                product = product,
                name = obj["name"].stringValue,
                baseUrl = obj["baseUrl"].stringValue,
                protocolVersion = obj["protocolVersion"].longValue,
                core = core,
                trust = trust,
                services = services,
                presentation = PresentationRules.parsePresentation(obj["core"], obj["name"], product),
            ),
        )
    }

    /** Fetch and parse. A local-only client's refusal is an `Error`, never "no services". */
    public suspend fun fetch(
        endpoints: Endpoints,
        transport: PolarisTransport,
        headers: Map<String, String> = emptyMap(),
        timeoutSeconds: Double = 15.0,
    ): DiscoveryResult {
        val response = try {
            transport.send(
                PolarisRequest(
                    url = endpoints.discovery,
                    headers = headers + ("accept" to "application/json"),
                    timeoutSeconds = timeoutSeconds,
                ),
            )
        } catch (e: PolarisException) {
            return DiscoveryResult.Error(0, e.message ?: e.code)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            return DiscoveryResult.Error(0, e.message ?: "transport error")
        }
        if (response.status == 404) return DiscoveryResult.NotFound
        if (!response.isOk) return DiscoveryResult.Error(response.status, response.text)
        return parse(response.text, endpoints.product)
    }
}
