// Discovery URL templates (WIRE-CONTRACT-V4 §2.2, plans/P3-01.md §2.5 step 1): `{name}` placeholders
// substituted with each value percent-encoded exactly as JavaScript's `encodeURIComponent`, then
// resolved against the control plane (a discovered template is normally absolute already). Shared by
// the update client and the packs facet (P6-08), as Swift's `expandTemplate`.

package im.plrs.key.core

import java.net.URI

private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

/** `encodeURIComponent`: every UTF-8 byte outside the unreserved set as `%XX` (uppercase hex). */
public fun encodeUriComponent(value: String): String {
    val sb = StringBuilder()
    for (b in value.toByteArray(Charsets.UTF_8)) {
        val c = b.toInt() and 0xff
        if (c < 0x80 && UNRESERVED.indexOf(c.toChar()) >= 0) sb.append(c.toChar()) else sb.append('%').append("%02X".format(c))
    }
    return sb.toString()
}

/** [template] with every `{k}` replaced by `encodeUriComponent(v)`, resolved against [baseUrl]; null when unusable. */
public fun expandTemplate(template: String, baseUrl: String, values: Map<String, String>): String? {
    var out = template
    for ((k, v) in values) out = out.replace("{$k}", encodeUriComponent(v))
    return try {
        URI("$baseUrl/").resolve(URI(out)).toString()
    } catch (e: Exception) {
        null
    }
}

/**
 * Whether [url] is on the control plane's own origin (scheme, host, port): the only place a bearer
 * goes, with one exception: a verified build download (`fetchVerified`) also sends it to the bytes host
 * discovery declares, the origin of its `builds` template (`CoreContext.bearerAllowed`).
 */
public fun sameOrigin(url: String, baseUrl: String): Boolean = try {
    val a = URI(url)
    val b = URI(baseUrl)
    fun port(u: URI): Int = if (u.port >= 0) u.port else when (u.scheme?.lowercase()) {
        "https" -> 443
        "http" -> 80
        else -> -1
    }
    a.scheme.equals(b.scheme, ignoreCase = true) && a.host.equals(b.host, ignoreCase = true) && port(a) == port(b)
} catch (e: Exception) {
    false
}

/** The wire code a refusal body names (`{error: {code}}` or `{error: "code"}`), or null. */
public fun wireErrorCode(body: ByteArray): String? {
    val root = JsonText.parseOrNull(body.toString(Charsets.UTF_8)).objectValue ?: return null
    root["error"].stringValue?.takeIf { it.isNotEmpty() }?.let { return it }
    return root["error"].objectValue?.get("code").stringValue?.takeIf { it.isNotEmpty() }
}
