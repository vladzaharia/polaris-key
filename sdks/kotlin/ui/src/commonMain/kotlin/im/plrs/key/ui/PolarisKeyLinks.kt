// Routes and deep links (UK-09b.3, UI-KITS.md D-3). The kit does not own navigation: the host keeps its own
// (navigation-compose in the sample) and the kit names the places a link may open and parses the link.
//
//   val links = PolarisKeyLinks("tidewater://polaris", client)
//   links.handle(intent.dataString)      // a PolarisKeyRoute, or null when nothing opens
//
// The parser is an allow-list. A link opens only when it is the host's declared return URI (scheme and host
// exactly, no port, no user info, the declared path prefix) followed by one known route, written as the path
// (`tidewater://polaris/account`) or as the one query value `route` (`tidewater://polaris?route=account`).
// Every other query value, and the fragment, is ignored; it never reaches anything. Everything else is refused
// and opens nothing. The only effects of an accepted link are a client sync and the route it returns. The kit
// never writes a token, a code or a key into a link: [PolarisKeyLinks.uriFor] builds a link from a route alone.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException

/** A place a link may open. [wire] is its name in a link. */
public enum class PolarisKeyRoute(public val wire: String) {
    Account("account"),
    Devices("devices"),
    Settings("settings"),
    Update("update"),
    SignIn("sign-in"),
    ;

    public companion object {
        /** The route named [wire] exactly (lower case), or null. */
        public fun of(wire: String): PolarisKeyRoute? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * The link handler for the host's return URI [returnUri] (scheme, host and an optional path prefix, for example
 * `tidewater://polaris`). [sync] runs once per accepted link; [PolarisKeyLinks] is a pure parser otherwise.
 *
 * @throws IllegalArgumentException when [returnUri] is not an absolute `scheme://host[/prefix]` without port,
 *   user info, query or fragment.
 */
public class PolarisKeyLinks internal constructor(returnUri: String, private val sync: suspend () -> Unit) {
    /** Handle links for [returnUri], syncing [client] when a link opens a route. */
    public constructor(returnUri: String, client: PolarisKeyClient) : this(returnUri, { client.sync() })

    private val declared: Parts = parse(returnUri)
        ?.takeIf { '?' !in returnUri && '#' !in returnUri && it.hostOk }
        ?: throw IllegalArgumentException("a return URI is scheme://host[/prefix] with no port, user info, query or fragment")

    /** The route [uri] opens, or null when it is not the declared return URI plus one known route. Pure. */
    @Suppress("ReturnCount")
    public fun route(uri: String?): PolarisKeyRoute? {
        val link = uri?.takeIf { it.length <= MAX_URI }?.let(::parse) ?: return null
        if (!link.hostOk || link.scheme != declared.scheme || link.host != declared.host) return null
        if (!link.path.startsWith(declared.path)) return null
        // The prefix ends at a segment boundary: "/app" does not admit "/application/account".
        val rest = link.path.removePrefix(declared.path)
        if (rest.isNotEmpty() && !rest.startsWith("/")) return null
        val trimmed = rest.removePrefix("/").removeSuffix("/")
        val segments = if (trimmed.isEmpty()) emptyList() else trimmed.split('/')
        val fromQuery = link.query.filter { it.first == "route" }.map { it.second }
        // One name, from the path or from `route`, never both and never two.
        val name = when {
            segments.size + fromQuery.size != 1 -> return null
            segments.isNotEmpty() -> segments[0]
            else -> fromQuery[0]
        }
        if (name.isEmpty() || '%' in name) return null
        return PolarisKeyRoute.of(name)
    }

    /**
     * Handle [uri]: when it opens a route, sync the client (a failed sync does not stop the link: the screens
     * show their own state) and return the route; otherwise do nothing and return null.
     */
    public suspend fun handle(uri: String?): PolarisKeyRoute? {
        val route = route(uri) ?: return null
        try {
            sync()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline or refused: the route still opens, on what the device already holds.
        }
        return route
    }

    /** The link that opens [route]: the declared return URI and the route's name, nothing else. */
    public fun uriFor(route: PolarisKeyRoute): String = declared.scheme + "://" + declared.host + declared.path.trimEnd('/') + "/" + route.wire

    private class Parts(
        val scheme: String,
        val host: String,
        /** The authority is a bare host: no user info, port or odd characters. */
        val hostOk: Boolean,
        val path: String,
        val query: List<Pair<String, String>>,
    )

    private companion object {
        const val MAX_URI = 2048
        const val DEL = 0x7f
        const val SCHEME_SEPARATOR = "://"

        private val schemeRule = Regex("[a-z][a-z0-9+.-]*")
        private val hostRule = Regex("[a-z0-9]([a-z0-9.-]*[a-z0-9])?")

        /** Splits an absolute hierarchical URI by hand (no java.net.URI in common code), or null when it is not one. */
        @Suppress("ReturnCount")
        fun parse(uri: String): Parts? {
            // Whitespace, control characters and backslashes have no place in a route link.
            if (uri.any { it.code <= ' '.code || it.code == DEL || it == '\\' }) return null
            val beforeFragment = uri.substringBefore('#')
            val scheme = beforeFragment.substringBefore(SCHEME_SEPARATOR, "")
            if (!schemeRule.matches(scheme)) return null
            val afterScheme = beforeFragment.substring(scheme.length + SCHEME_SEPARATOR.length)
            val authority = afterScheme.substringBefore('/').substringBefore('?')
            val tail = afterScheme.substring(authority.length)
            val path = tail.substringBefore('?')
            // Escapes and dot segments could name a different place than the one that was checked.
            if ('%' in path || path.split('/').any { it == "." || it == ".." }) return null
            val queryText = if ('?' in tail) tail.substringAfter('?') else ""
            val query = if (queryText.isEmpty()) emptyList() else queryText.split('&').map { it.substringBefore('=') to it.substringAfter('=', "") }
            val host = authority
            return Parts(scheme, host, hostRule.matches(host), path, query)
        }
    }
}

/** What to tell the person when a link opened nothing (catalog line `common.linkUnavailable`, in the device's language). */
@Composable
public fun polarisLinkUnavailable(): String = KitCopy.bundled.format("common.linkUnavailable", kitLocale())
