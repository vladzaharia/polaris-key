// The validating opener (UK-10.2). Every link the kit opens, whatever the platform, goes through
// PolarisOpener.invoke, which opens a link only when isSafeHttpsLink accepts it. The platform's
// launcher behind it never sees anything else.

package im.plrs.key.ui

/** The longest link the kit opens, encodes or copies (a QR code holds more, but nothing legitimate is longer). */
internal const val MAX_LINK_LENGTH: Int = 2048

/**
 * True only for a plain https link: at most [MAX_LINK_LENGTH] printable ASCII characters, no
 * backslash, no userinfo, a non-empty host of letters, digits, dots and hyphens, and an optional
 * numeric port. Everything else (http, file:, javascript:, intent:, custom schemes, `user@host`
 * tricks, bracketed or percent-encoded hosts, whitespace) is refused.
 */
internal fun isSafeHttpsLink(raw: String): Boolean {
    if (raw.length > MAX_LINK_LENGTH) return false
    if (!raw.startsWith("https://", ignoreCase = true)) return false
    if (raw.any { it <= ' ' || it >= '\u007f' || it == '\\' }) return false
    val rest = raw.substring("https://".length)
    val authority = rest.substring(0, rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it })
    if (authority.isEmpty() || '@' in authority) return false
    val colon = authority.indexOf(':')
    val host = if (colon < 0) authority else authority.substring(0, colon)
    if (colon >= 0) {
        val port = authority.substring(colon + 1)
        if (port.isNotEmpty() && (port.length > 5 || !port.all { it in '0'..'9' })) return false
    }
    if (host.isEmpty() || !host.first().isAsciiAlnum() || !host.all { it.isAsciiAlnum() || it == '.' || it == '-' }) return false
    return true
}

private fun Char.isAsciiAlnum(): Boolean = this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'

/** Opens a link the platform's way, but only after the link passes [isSafeHttpsLink]. */
public class PolarisOpener(private val launch: (String) -> Boolean) {
    /** True when [url] is a safe https link and the platform took it; false otherwise (show the copy-link state). */
    public operator fun invoke(url: String): Boolean = isSafeHttpsLink(url) && runCatching { launch(url) }.getOrDefault(false)
}
