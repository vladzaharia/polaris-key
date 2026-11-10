// The one check a Cloud Sync sign-in URL passes before it reaches app code. The rule is the same in every
// SDK and pinned by the corpus's `signInUrlCases` (`tools/sync-scenarios.ts`): it uses no URL library, so
// no parser's quirks can differ between languages.

package im.plrs.key.core.sync

public object SignInUrl {
    private const val HTTPS = "https://"
    private const val DEFAULT_PORT = 443
    private const val MAX_PORT_DIGITS = 5
    private const val FIRST_PRINTABLE = 0x21
    private const val LAST_PRINTABLE = 0x7E
    private val originPattern = Regex("https://([a-z0-9.-]+)(?::([0-9]{1,$MAX_PORT_DIGITS}))?")
    private val schemePattern = Regex("[A-Za-z][A-Za-z0-9+.-]*:.*", RegexOption.DOT_MATCHES_ALL)

    /**
     * A sign-in URL fit to hand to the app: https on the Worker's [origin] (`https://host[:port]`),
     * normalised, else null. `https://` or `//` start an authority that must be exactly the Worker's host
     * (and port; 443 is the default); any other `scheme:`, userinfo, a trailing dot, a lookalike host, a
     * backslash, whitespace or a control or non-ASCII character answers null. Anything else is a path on
     * the origin. There is no path restriction.
     */
    public fun safe(url: String?, origin: String): String? {
        val base = originPattern.matchEntire(origin.lowercase())
        val tail = if (url.isNullOrEmpty() || base == null || !printable(url)) null else tailOf(url, base)
        if (tail == null || base == null) return null
        val port = port(base)
        val suffix = if (port == DEFAULT_PORT) "" else ":$port"
        return "$HTTPS${base.groupValues[1]}$suffix${if (tail.startsWith("/")) tail else "/$tail"}"
    }

    private fun port(origin: MatchResult): Int = origin.groupValues[2].ifEmpty { "$DEFAULT_PORT" }.toInt()

    private fun printable(url: String): Boolean = url.none { it.code < FIRST_PRINTABLE || it.code > LAST_PRINTABLE || it == '\\' }

    /** What follows the authority (or the whole path-only URL); null when the authority is not the Worker's, or another scheme starts it. */
    private fun tailOf(url: String, origin: MatchResult): String? {
        val rest = when {
            url.startsWith(HTTPS, ignoreCase = true) -> url.substring(HTTPS.length)
            url.startsWith("//") -> url.substring(2)
            else -> null
        }
        return when {
            rest != null -> authorityTail(rest, origin)
            schemePattern.matches(url) -> null
            else -> url
        }
    }

    private fun authorityTail(rest: String, origin: MatchResult): String? {
        val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
        val host = origin.groupValues[1]
        val port = port(origin)
        val allowed = if (port == DEFAULT_PORT) listOf(host, "$host:$DEFAULT_PORT") else listOf("$host:$port")
        return if (rest.substring(0, end).lowercase() in allowed) rest.substring(end) else null
    }
}
