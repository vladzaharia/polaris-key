// Product presentation (WIRE-CONTRACT-V4 §5.5, plans/HA-11.md §2.1, plans/HA-13.md): the Kotlin port
// of client-core's `presentation.ts`, pinned by `conformance/corpus/v2/presentation-matrix.json`.
//
// Discovery's `core.presentation` is UNSIGNED display data: the product's name, its developer, an
// accent for light and dark grounds, and an icon given as content-addressed image-host URLs with the
// original's hash and each WebP width's hash. No gate, entitlement or trust decision reads it.
//
//   PresentationRules.parsePresentation   the member, field by field; a malformed field is dropped
//                                         and the member never refuses discovery (`parseCases`)
//   PresentationRules.pickIconSize        which bytes to fetch for a hero drawn at `px` points on a
//                                         `scale` screen, given the decodable types (`pickCases`)
//   PresentationRules.iconMatches         bytes are shown and cached only when their SHA-256 is the
//                                         pick's hash (`verifyCases`)
//   PresentationRules.usableUrlOrigin     §5.5 rule 5, and `safeFetchUrl`, the fetcher's safe link
//   PresentationSource                    the seam the UI kits read (plans/HA-11.md Q7)
//
// The rules are client-core's, line for line (see that file's comment for the five parse rules);
// every limit is a generated `PRESENTATION_*` constant. `DiscoveryPresentationSource`
// (PresentationSource.kt) implements the seam over discovery and the icon cache.

package im.plrs.key.core

import java.security.MessageDigest
import java.util.Locale
import kotlin.math.ceil
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One WebP width of the icon and the hash its bytes must have. */
public data class PresentationIconSize(val w: Int, val sha256: String) {
    public fun toJson(): JsonObject = JsonObject(mapOf("w" to jsonInt(w.toLong()), "sha256" to JsonPrimitive(sha256)))
}

/** The icon: the original's hash, type and URL, and the WebP ladder (`url` with `{w}`, `sizes`). */
public data class PresentationIcon(
    val sha256: String,
    val contentType: String,
    val width: Int? = null,
    val height: Int? = null,
    val original: String,
    /** The ladder's template, holding exactly one `{w}`; null with no sizes. */
    val url: String? = null,
    val sizes: List<PresentationIconSize> = emptyList(),
) {
    /** The member as the contract shows it (and as `presentation.json` stores it). */
    public fun toJson(): JsonObject {
        val out = LinkedHashMap<String, JsonElement>()
        out["sha256"] = JsonPrimitive(sha256)
        out["contentType"] = JsonPrimitive(contentType)
        width?.let { out["width"] = jsonInt(it.toLong()) }
        height?.let { out["height"] = jsonInt(it.toLong()) }
        out["original"] = JsonPrimitive(original)
        url?.let { out["url"] = JsonPrimitive(it) }
        out["sizes"] = JsonArray(sizes.map { it.toJson() })
        return JsonObject(out)
    }
}

/**
 * Discovery's `core.presentation`, normalised: the product's display name, its developer, its
 * accents (lower-case `#rrggbb`) and its icon. The kits render [name] and [developerName] in a
 * bidi-isolated run (FSI…PDI): the text keeps its bidi controls (plans/HA-12.md Q5).
 */
public data class Presentation(
    val name: String,
    val developerName: String? = null,
    /** The accent for a light ground, `#rrggbb` lower-case. */
    val accent: String? = null,
    /** The accent for a dark ground; the dark scheme uses it when set. */
    val accentDark: String? = null,
    val icon: PresentationIcon? = null,
) {
    /** The member as the contract shows it (and as `presentation.json` stores it). */
    public fun toJson(): JsonObject {
        val out = LinkedHashMap<String, JsonElement>()
        out["name"] = JsonPrimitive(name)
        developerName?.let { out["developerName"] = JsonPrimitive(it) }
        accent?.let { out["accent"] = JsonPrimitive(it) }
        accentDark?.let { out["accentDark"] = JsonPrimitive(it) }
        icon?.let { out["icon"] = it.toJson() }
        return JsonObject(out)
    }

    /** The accent for [dark] grounds: `accentDark` in the dark scheme when set, else `accent`. */
    public fun accentFor(dark: Boolean): String? = if (dark) accentDark ?: accent else accent ?: accentDark
}

/** What [PresentationRules.pickIconSize] chose: the URL to fetch and the hash its bytes must have. */
public sealed interface IconPick {
    /** A WebP width of the ladder. */
    public data class Size(val w: Int, val sha256: String, val url: String) : IconPick

    /** The original. */
    public data class Original(val sha256: String, val url: String) : IconPick

    /** Nothing this platform can decode. */
    public data object None : IconPick
}

/**
 * The seam every UI kit reads (plans/HA-11.md Q7): the SDK implements it over discovery and its icon
 * cache ([DiscoveryPresentationSource], `PolarisKeyClient.presentationSource`); a kit never fetches
 * discovery or the icon itself.
 */
public interface PresentationSource {
    /** The last parsed member, or null (none served, or none known yet). */
    public fun current(): Presentation?

    /** Verified icon bytes for a hero drawn at [px] points on a [scale] screen, or null. Never throws. */
    public suspend fun icon(px: Double, scale: Double = 1.0): ByteArray?

    /** Called with the new member whenever it changes (null when it went away); returns the unsubscribe. */
    public fun subscribe(listener: (Presentation?) -> Unit): () -> Unit
}

public object PresentationRules {
    /** The content types the JVM decodes with `javax.imageio` (no WebP or AVIF reader built in). */
    public val JVM_DECODABLE: Set<String> = setOf("image/png", "image/jpeg", "image/gif")

    /** Android's `BitmapFactory` set: WebP always, AVIF from API 31 (Android 12). */
    public fun androidDecodable(sdkInt: Int): Set<String> =
        setOf("image/png", "image/jpeg", "image/gif", "image/webp") + (if (sdkInt >= 31) setOf("image/avif") else emptySet())

    /** What this runtime decodes: [androidDecodable] on Android, else [JVM_DECODABLE]. */
    public val platformDecodable: Set<String> by lazy {
        if (!RuntimeFamily.isAndroid) {
            JVM_DECODABLE
        } else {
            val sdk = try {
                Class.forName("android.os.Build\$VERSION").getField("SDK_INT").getInt(null)
            } catch (e: Exception) {
                0
            }
            androidDecodable(sdk)
        }
    }

    private val HEX_COLOUR = Regex("^#[0-9A-Fa-f]{6}$")
    private val SHA256 = Regex("^[0-9a-f]{64}$")
    private val ICON_TYPES: Set<String> = PRESENTATION_ICON_TYPES.toSet()
    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "[::1]")
    private val DNS_LABEL = Regex("^[a-z0-9-]{1,63}$")
    private val ALL_DIGITS = Regex("^[0-9]+$")

    /** WHATWG's ends-in-a-number test: a last label that would parse as an IPv4 number. */
    private val HEX_NUMBER = Regex("^0x[0-9a-f]*$")

    /** A lower-cased authority's host when it has a usable host and port, else null. */
    private fun authorityHost(authority: String): String? {
        val host: String
        val port: String?
        if (authority.startsWith("[")) {
            val close = authority.indexOf(']')
            if (close == -1) return null
            host = authority.substring(0, close + 1)
            val after = authority.substring(close + 1)
            if (after.isNotEmpty() && !after.startsWith(":")) return null
            port = if (after.isEmpty()) null else after.substring(1)
        } else {
            val colon = authority.indexOf(':')
            host = if (colon == -1) authority else authority.substring(0, colon)
            port = if (colon == -1) null else authority.substring(colon + 1)
        }
        if (port != null && (port.isEmpty() || port.length > 5 || !ALL_DIGITS.matches(port) || port.toInt() > 65535)) return null
        if (host == "[::1]" || host == "127.0.0.1") return host
        val labels = host.split(".")
        if (!labels.all { DNS_LABEL.matches(it) }) return null
        val last = labels.last()
        if (ALL_DIGITS.matches(last) || HEX_NUMBER.matches(last)) return null
        return host
    }

    /** UTF-8 byte length of [s], or -1 when it holds a lone surrogate (not encodable). */
    private fun utf8Length(s: String): Int {
        var n = 0
        var i = 0
        while (i < s.length) {
            val c = s[i].code
            when {
                c < 0x80 -> n += 1
                c < 0x800 -> n += 2
                c in 0xD800..0xDBFF -> {
                    val d = if (i + 1 < s.length) s[i + 1].code else 0
                    if (d < 0xDC00 || d > 0xDFFF) return -1
                    n += 4
                    i++
                }
                c in 0xDC00..0xDFFF -> return -1
                else -> n += 3
            }
            i++
        }
        return n
    }

    /** Rule 2: a display text, or null. */
    private fun text(v: JsonElement?): String? {
        val s = v.stringValue ?: return null
        val bytes = utf8Length(s)
        if (bytes < 1 || bytes > PRESENTATION_TEXT_MAX_BYTES) return null
        for (ch in s) {
            val c = ch.code
            if (c <= 0x1F || c in 0x7F..0x9F) return null
        }
        return s
    }

    /** Rule 3: a colour, lower-cased, or null. */
    private fun colour(v: JsonElement?): String? = v.stringValue?.takeIf { HEX_COLOUR.matches(it) }?.lowercase(Locale.ROOT)

    /** Rule 5: the URL's origin (scheme and authority, lower-cased) when it is usable, else null. */
    public fun usableUrlOrigin(v: String?): String? {
        if (v == null || v.isEmpty() || v.length > PRESENTATION_URL_MAX_BYTES) return null
        for (ch in v) {
            val c = ch.code
            if (c < 0x21 || c > 0x7E || c == 0x23 || c == 0x5C) return null
        }
        val lower = v.lowercase(Locale.ROOT)
        val scheme = when {
            lower.startsWith("https://") -> "https"
            lower.startsWith("http://") -> "http"
            else -> return null
        }
        val rest = lower.substring(scheme.length + 3)
        val end = rest.indexOfFirst { it == '/' || it == '?' }
        val authority = if (end == -1) rest else rest.substring(0, end)
        val host = authorityHost(authority) ?: return null
        // Only the loopback hosts may be plain http.
        if (scheme == "http" && host !in LOOPBACK_HOSTS) return null
        return "$scheme://$authority"
    }

    /**
     * The fetcher's safe link (UI-KITS DL14): [url] is usable (https, or http on a loopback host) and
     * on [original]'s origin, so a `{w}` expansion can never reach another host.
     */
    public fun safeFetchUrl(url: String, original: String): Boolean {
        val origin = usableUrlOrigin(url) ?: return false
        return origin == usableUrlOrigin(original)
    }

    /** Rule 4's `sizes`: the entries, `[]` when absent, or null when any entry is bad. */
    private fun sizes(v: JsonElement?): List<PresentationIconSize>? {
        if (v == null) return emptyList()
        val arr = v.arrayValue ?: return null
        if (arr.size > PRESENTATION_MAX_ICON_SIZES) return null
        val out = ArrayList<PresentationIconSize>()
        var last = 0L
        for (e in arr) {
            val o = e.objectValue ?: return null
            val w = o["w"].longValue ?: return null
            if (w < 1 || w > PRESENTATION_MAX_ICON_WIDTH || w <= last) return null
            val sha = o["sha256"].stringValue
            if (sha == null || !SHA256.matches(sha)) return null
            out += PresentationIconSize(w.toInt(), sha)
            last = w
        }
        return out
    }

    private fun dimension(v: JsonElement?): Int? = v.longValue?.takeIf { it in 1..PRESENTATION_ICON_MAX_DIMENSION.toLong() }?.toInt()

    /** Rule 4: the icon, or null. */
    private fun icon(v: JsonElement?): PresentationIcon? {
        val o = v.objectValue ?: return null
        val sha = o["sha256"].stringValue
        if (sha == null || !SHA256.matches(sha)) return null
        val contentType = o["contentType"].stringValue
        if (contentType == null || contentType !in ICON_TYPES) return null
        val original = o["original"].stringValue
        val origin = usableUrlOrigin(original) ?: return null
        val ladder = sizes(o["sizes"])
        val url = o["url"].stringValue
        val templated = ladder != null &&
            ladder.isNotEmpty() &&
            url != null &&
            url.length <= PRESENTATION_URL_MAX_BYTES &&
            url.split("{w}").size == 2 &&
            // `{w}` after the authority: the template begins with the original's own origin.
            (url.lowercase(Locale.ROOT).startsWith("$origin/") || url.lowercase(Locale.ROOT).startsWith("$origin?")) &&
            usableUrlOrigin(url.replace("{w}", "1")) == origin
        return PresentationIcon(
            sha256 = sha,
            contentType = contentType,
            width = dimension(o["width"]),
            height = dimension(o["height"]),
            original = original!!,
            url = if (templated) url else null,
            sizes = if (templated) ladder!! else emptyList(),
        )
    }

    /**
     * `core.presentation` from a discovery document's [core] block, normalised, or null when the
     * member is absent or not an object. [docName] is the document's top-level `name` and [product]
     * its slug: the name's fall-backs.
     */
    public fun parsePresentation(core: JsonElement?, docName: JsonElement?, product: String): Presentation? {
        val raw = core.objectValue?.get("presentation").objectValue ?: return null
        return Presentation(
            name = text(raw["name"]) ?: text(docName) ?: product,
            developerName = text(raw["developerName"]),
            accent = colour(raw["accent"]),
            accentDark = colour(raw["accentDark"]),
            icon = icon(raw["icon"]),
        )
    }

    /**
     * Which bytes to fetch for a hero drawn at [px] points on a [scale] screen, given the content
     * types the platform decodes. `need = ceil(px × scale)` (at least 1):
     *
     *   1. With sizes and WebP decodable: the smallest `w ≥ need`, else the largest `w`.
     *   2. The original instead when it is decodable, its `width` is known and exceeds the largest
     *      `w`, and `need` exceeds the largest `w`.
     *   3. With no usable size: the original, when it is decodable.
     *   4. Otherwise none.
     */
    public fun pickIconSize(icon: PresentationIcon, px: Double, scale: Double, decodable: Collection<String>): IconPick {
        val product = ceil(px * scale)
        val need = if (product.isFinite() && product >= 1) product else 1.0
        val originalOk = icon.contentType in decodable
        val original = IconPick.Original(icon.sha256, icon.original)
        val template = icon.url
        if (icon.sizes.isNotEmpty() && template != null && "image/webp" in decodable) {
            val largest = icon.sizes.last()
            val fit = icon.sizes.firstOrNull { it.w >= need } ?: largest
            if (originalOk && need > largest.w && icon.width != null && icon.width > largest.w) return original
            return IconPick.Size(fit.w, fit.sha256, template.replace("{w}", fit.w.toString()))
        }
        return if (originalOk) original else IconPick.None
    }

    /** Lower-case hex SHA-256 of [bytes]. */
    public fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    /**
     * Whether [bytes] hash to [sha256]: their lower-case hex SHA-256 equals it exactly (an upper-case
     * expectation never matches). Bytes that do not match are neither shown nor cached.
     */
    public fun iconMatches(bytes: ByteArray, sha256: String): Boolean = sha256Hex(bytes) == sha256
}
