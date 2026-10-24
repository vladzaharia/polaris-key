// @pkey-feature ui.kit
// UK-09b.3 (D-3): the deep-link parser is an allow-list. Accepted: the declared return URI plus one known
// route. Refused: everything else, foreign hosts and schemes first. No link the kit builds carries a token.

package im.plrs.key.ui

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PolarisKeyLinksTest {
    private var syncs = 0
    private val links = PolarisKeyLinks("tidewater://polaris") { syncs++ }
    private val prefixed = PolarisKeyLinks("tidewater://polaris/app") {}

    @Test
    fun acceptedLinksOpenTheirRoute() {
        val table = mapOf(
            "tidewater://polaris/account" to PolarisKeyRoute.Account,
            "tidewater://polaris/devices" to PolarisKeyRoute.Devices,
            "tidewater://polaris/settings" to PolarisKeyRoute.Settings,
            "tidewater://polaris/update" to PolarisKeyRoute.Update,
            "tidewater://polaris/sign-in" to PolarisKeyRoute.SignIn,
            "tidewater://polaris/account/" to PolarisKeyRoute.Account,
            "tidewater://polaris?route=devices" to PolarisKeyRoute.Devices,
            "tidewater://polaris/?route=settings" to PolarisKeyRoute.Settings,
            // Other query values and the fragment are ignored, never read.
            "tidewater://polaris/account?utm=x&token=abc" to PolarisKeyRoute.Account,
            "tidewater://polaris/account#frag" to PolarisKeyRoute.Account,
            "tidewater://polaris?next=http://evil.example&route=update" to PolarisKeyRoute.Update,
        )
        for ((uri, route) in table) assertEquals(uri, route, links.route(uri))
        assertEquals(PolarisKeyRoute.Account, prefixed.route("tidewater://polaris/app/account"))
        assertEquals(PolarisKeyRoute.Update, prefixed.route("tidewater://polaris/app?route=update"))
    }

    @Test
    fun everythingElseIsRefused() {
        val refused = listOf(
            // foreign scheme, host, port, user info
            "https://polaris/account", "http://polaris/account", "tidewater2://polaris/account", "TIDEWATER://polaris/account",
            "tidewater://evil/account", "tidewater://polaris.evil/account", "tidewater://polaris:8080/account",
            "tidewater://user@polaris/account", "tidewater://polaris@evil/account", "tidewater://Polaris/account",
            "javascript:alert(1)", "content://polaris/account", "file:///account", "tidewater:/polaris/account", "tidewater:polaris/account",
            // unknown, empty or mis-cased routes
            "tidewater://polaris", "tidewater://polaris/", "tidewater://polaris/unknown", "tidewater://polaris/Account",
            "tidewater://polaris/account/devices", "tidewater://polaris//account", "tidewater://polaris/account//",
            "tidewater://polaris/accounts", "tidewater://polaris/?route=", "tidewater://polaris?route=nope",
            // ambiguous or doubled
            "tidewater://polaris/account?route=devices", "tidewater://polaris?route=account&route=devices",
            // escapes, dot segments, whitespace, controls, backslash
            "tidewater://polaris/%61ccount", "tidewater://polaris?route=%61ccount", "tidewater://polaris/../account",
            "tidewater://polaris/./account", "tidewater://polaris/account ", " tidewater://polaris/account",
            "tidewater://polaris/ac\ncount", "tidewater://polaris\\account", "tidewater://polaris/account\u0000",
            // other shapes
            "", "account", "/account", "://polaris/account", "tidewater://", "tidewater:///account",
            "tidewater://polaris/account?" + "a".repeat(3000),
        )
        for (uri in refused) assertNull(uri, links.route(uri))
        assertNull(links.route(null))
        // A prefix is a segment boundary and must be there.
        for (uri in listOf(
            "tidewater://polaris/account",
            "tidewater://polaris/application/account",
            "tidewater://polaris/ap/account",
            "tidewater://polaris/app/x/account",
        )) {
            assertNull(uri, prefixed.route(uri))
        }
    }

    @Test
    fun theDeclaredReturnUriMustBeAPlainOne() {
        for (bad in listOf(
            "",
            "polaris",
            "https://polaris:8080",
            "tidewater://u@polaris",
            "tidewater://polaris?route=account",
            "tidewater://polaris#x",
            "tidewater://",
        )) {
            assertThrows(bad, IllegalArgumentException::class.java) { PolarisKeyLinks(bad) {} }
        }
    }

    @Test
    fun handleSyncsOnlyForAnAcceptedLink() = runBlocking {
        assertNull(links.handle("https://evil.example/account"))
        assertNull(links.handle("tidewater://polaris/unknown"))
        assertEquals(0, syncs)
        assertEquals(PolarisKeyRoute.Account, links.handle("tidewater://polaris/account?token=abc"))
        assertEquals(1, syncs)
    }

    @Test
    fun aFailedSyncStillOpensTheRoute() = runBlocking {
        val offline = PolarisKeyLinks("tidewater://polaris") { error("offline") }
        assertEquals(PolarisKeyRoute.Devices, offline.handle("tidewater://polaris/devices"))
    }

    @Test
    fun linksTheKitBuildsCarryNoQueryNoFragmentAndNoSecret() {
        for (route in PolarisKeyRoute.entries) {
            val uri = links.uriFor(route)
            assertEquals("tidewater://polaris/${route.wire}", uri)
            assertFalse(uri, '?' in uri || '#' in uri || '=' in uri)
            assertEquals(route, links.route(uri))
        }
        assertEquals("tidewater://polaris/app/account", prefixed.uriFor(PolarisKeyRoute.Account))
        assertEquals(PolarisKeyRoute.Account, prefixed.route(prefixed.uriFor(PolarisKeyRoute.Account)))
    }

    @Test
    fun routesAreNamedByTheirWire() {
        assertEquals(listOf("account", "devices", "settings", "update", "sign-in"), PolarisKeyRoute.entries.map { it.wire })
        assertNull(PolarisKeyRoute.of("Account"))
    }
}
