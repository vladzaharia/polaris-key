// The product page link (WIRE-CONTRACT-V4 section 5.7, plans/DISC-01.md), pinned by
// conformance/corpus/v2/portal-matrix.json. A port of client-core's `portal`.
//
// Discovery's `core.portal` is UNSIGNED display data: whether the product's customer portal is on and, while
// it is, the product page `<customer origin>/activate?product=<slug>`. Pure functions, no I/O:
//
//   parse     the member as a whole: null for unknown, or Portal(enabled, activate)
//   link      the one link a terminal kit draws: the response's own link, then discovery's member, then the
//             legacy guess against a Worker that sent none. Null means no link: the kit draws "Contact {developer}"
//
// A link that fails section 5.3 rule 4 is no link, never repaired and never replaced by a guess once the Worker
// has answered. A client never adds `#key=` to it.
package im.plrs.key.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Discovery's `core.portal`, normalised. [activate] is null while the portal is off or its link failed the rule. */
public data class PortalMember(val enabled: Boolean, val activate: String? = null)

public object PortalLink {
    /**
     * `core.portal` of a discovery document's `core` block, or null when it says nothing usable (an older Worker, or
     * a malformed member): "unknown", which is not "off".
     */
    public fun parse(core: JsonElement?): PortalMember? {
        val portal = (core as? JsonObject)?.get("portal") as? JsonObject
        val enabled = (portal?.get("enabled") as? JsonPrimitive)?.takeIf { !it.isString }?.content
        return when (enabled) {
            "true" -> {
                val activate = (portal["activate"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                PortalMember(true, activate?.takeIf { ManageLink.isValid(it) })
            }

            "false" -> PortalMember(false)

            else -> null
        }
    }

    /**
     * The product page link, or null (no link: the kit draws "Contact {developer}"). First match: a valid [served]
     * link; the discovered [portal] (off, or no usable link, is null, never the guess); the legacy
     * `<origin>/activate?product=<slug>` where the Worker said nothing.
     */
    public fun link(served: String?, portal: PortalMember?, baseUrl: String, product: String): String? = when {
        ManageLink.isValid(served) -> served
        portal != null -> portal.activate.takeIf { portal.enabled }
        product.isEmpty() -> null
        else -> legacy(baseUrl, product)
    }

    private fun legacy(baseUrl: String, product: String): String? {
        val base = baseUrl.trimEnd('/')
        val origin = if (base == "https://$POLARIS_ISSUER") CUSTOMER_ORIGIN_DEFAULT else base
        return "$origin/activate?product=${encodeSlug(product)}".takeIf { ManageLink.isValid(it) }
    }

    private const val UNRESERVED = "-._~"
    private const val HEX = "0123456789ABCDEF"

    /** RFC 3986 unreserved characters stay; every other UTF-8 byte is `%XX`. */
    private fun encodeSlug(value: String): String {
        val out = StringBuilder()
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val c = b.toUByte().toInt()
            val ch = c.toChar()
            if (c < ASCII && (ch.isLetterOrDigit() || ch in UNRESERVED)) {
                out.append(ch)
            } else {
                out.append('%').append(HEX[c shr NIBBLE]).append(HEX[c and NIBBLE_MASK])
            }
        }
        return out.toString()
    }

    private const val ASCII = 0x80
    private const val NIBBLE = 4
    private const val NIBBLE_MASK = 0xF
}
