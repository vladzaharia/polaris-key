// @pkey-feature server.license server.signin
//
// The server core's developer-facing behaviour: bad configuration fails at startup with the fix, a
// failed trust fetch says why, tier and valued requirements, the debug line, and the test kit.

package im.plrs.key.server

import im.plrs.key.server.testing.PolarisTestKit
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PolarisServerDxTest {
    private val pin = "A".repeat(43)

    private fun message(block: () -> Unit): String = assertThrows(IllegalArgumentException::class.java) { block() }.message!!

    @Test
    fun badConfigurationFailsAtStartupWithTheFix() {
        assertTrue(message { PolarisServerOptions(emptyList()) }.contains("pkey sdk --lang kotlin --write"))
        assertTrue(message { PolarisProduct("", mapOf("k" to pin)) }.contains("slug is empty"))
        assertTrue(message { PolarisProduct("acme", emptyMap()) }.contains("pinned keys for \"acme\" are empty"))
        assertTrue(message { PolarisProduct("acme", emptyMap()) }.contains("pkey sdk --lang kotlin --write"))
        val badPin = message { PolarisProduct("acme", mapOf("pkey-2026" to "not-a-key")) }
        assertTrue(badPin, badPin.contains("\"pkey-2026\"") && badPin.contains("43 base64url"))
        assertTrue(message { PolarisProduct("acme", mapOf("k" to pin), "key.plrs.im") }.contains("baseUrl \"key.plrs.im\""))
        assertTrue(message { PolarisProduct("acme", mapOf("k" to pin), "http://example.com") }.contains("https origin"))
        assertTrue(message { PolarisServerOptions(listOf(PolarisProduct("a", mapOf("k" to pin))), maxAgeSeconds = -1) }.contains("maxAgeSeconds is negative"))
        val twice = PolarisProduct("a", mapOf("k" to pin))
        assertTrue(message { PolarisServerOptions(listOf(twice, twice)) }.contains("repeats the slug \"a\""))
        // A local dev origin is fine.
        PolarisProduct("acme", mapOf("k" to pin), "http://localhost:8787/")
    }

    @Test
    fun anUnreachableTrustFetchSaysWhyAndKeepsThePins() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val lines = CopyOnWriteArrayList<String>()
        val server = PolarisServer(kit.options(trustRefresh = true).copy(debug = { lines += it }))
        kit.trust.offline = true
        server.refreshAll()
        val line = lines.single()
        assertTrue(line, line.startsWith("trust: fetch failed for acme (") && line.endsWith("keeping the last verified keys and the pins"))
        // The pins still verify.
        assertEquals(200, server.verdict(kit.signedHeaders { entitle("x") }.toList()).status)
        server.close()
    }

    @Test
    fun aNon2xxTrustFetchNamesBaseUrlAndSlug() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val lines = CopyOnWriteArrayList<String>()
        // The kit's trust service answers 404 for any other product's path.
        val other = PolarisTestKit(product = "other")
        val server = PolarisServer(kit.options(trustRefresh = true).copy(transport = other.trust, debug = { lines += it }))
        server.refreshAll()
        assertEquals("trust: https://key.plrs.im answered 404 for acme; check baseUrl and the product slug", lines.single())
        server.close()
    }

    @Test
    fun theDebugLineCarriesTheStepAndNeverTheHeader() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val lines = CopyOnWriteArrayList<String>()
        val server = PolarisServer(kit.options().copy(debug = { lines += it }))
        val headers = kit.signedHeaders { signedIn() }
        server.verdict(headers.toList(), listOf(Require.tier("pro")))
        server.verdict(emptyList())
        assertEquals(2, lines.size)
        assertTrue(lines[0], Regex("^polaris-key: require not_entitled kid=pkey-test-2026 aud=acme device=[0-9a-f]{8}$").matches(lines[0]))
        assertEquals("polaris-key: credential license_required kid=- aud=- device=-", lines[1])
        for (line in lines) assertFalse(line.contains(headers.getValue("X-PKey-License")) || line.contains("holder@example.com") || line.contains("dev_test"))
        server.close()
    }

    @Test
    fun tierAndValuedRequirementsRefuseInOrder() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val server = PolarisServer(kit.options())
        suspend fun code(require: List<BackendRequirement>, configure: im.plrs.key.server.testing.TestLicense.() -> Unit) =
            server.verdict(kit.signedHeaders(configure).toList(), require).code
        assertNull(code(listOf(Require.tier("pro", "team"))) { tier = "team" })
        assertEquals("not_entitled", code(listOf(Require.tier("pro", "team"))) { tier = "free" })
        assertEquals("not_entitled", code(listOf(Require.tier("pro"))) {})
        val seats = Require.entitlement("seats") { it is JsonPrimitive && (it.intOrNull ?: 0) >= 5 }
        assertNull(code(listOf(seats)) { entitlements["seats"] = 5 })
        assertEquals("not_entitled", code(listOf(seats)) { entitlements["seats"] = 4 })
        assertEquals("not_entitled", code(listOf(seats)) {})
        // A predicate that throws refuses.
        assertEquals("not_entitled", code(listOf(Require.entitlement("seats") { error("boom") })) { entitlements["seats"] = 5 })
        // The first unmet requirement decides.
        val all = listOf(Require.signIn(), Require.tier("pro"))
        assertEquals("sign_in_required", code(all) { tier = "pro" })
        assertEquals("not_entitled", code(all) { signedIn() })
        assertNull(code(all) { signedIn(); tier = "pro" })
        assertThrows(IllegalArgumentException::class.java) { Require.tier() }
        server.close()
    }

    @Test
    fun refusalForEvaluatesStepSixOnAKnownLicenseAndReportsIt() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val seen = CopyOnWriteArrayList<Pair<String?, Int>>()
        val server = PolarisServer(kit.options().copy(onVerdict = { c, s -> seen += c to s }))
        val auth = server.authenticate(kit.signedHeaders { tier = "free" }.toList())
        val license = auth.license!!
        assertNull(server.refusalFor(license, listOf(Require.tier("free"))))
        val problem = server.refusalFor(license, listOf(Require.tier("pro")), "de")!!
        assertEquals("not_entitled", problem.code)
        assertEquals(BackendRefusal.NotEntitled, problem.refusal)
        assertEquals(listOf<Pair<String?, Int>>(null to 0, "not_entitled" to 6), seen)
        server.close()
    }

    @Test
    fun theKitMakesEachVerdict() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val server = PolarisServer(kit.options())
        val route = listOf(Require.entitlement("export.pdf"))
        suspend fun code(refusal: BackendRefusal?, configure: im.plrs.key.server.testing.TestLicense.() -> Unit = {}) =
            server.verdict(kit.headersFor(refusal, configure).toList(), route).code
        assertEquals("license_required", code(BackendRefusal.LicenseRequired))
        assertEquals("license_invalid", code(BackendRefusal.LicenseInvalid))
        assertEquals("license_stale", code(BackendRefusal.LicenseStale))
        assertEquals("not_entitled", code(BackendRefusal.NotEntitled))
        assertNull(code(null) { entitle("export.pdf") })
        assertEquals("sign_in_required", server.verdict(kit.headersFor(BackendRefusal.SignInRequired).toList(), listOf(Require.signIn())).code)
        // The clock moves: a document is stale once it ages past its window.
        val fresh = kit.signedHeaders { entitle("export.pdf") }.toList()
        assertNull(server.verdict(fresh, route).code)
        kit.clock.advance(2 * 3600)
        assertEquals("license_stale", server.verdict(fresh, route).code)
        server.close()
    }

    @Test
    fun theKitsFakeTrustPublishesKeysAndGoesOffline() = runBlocking {
        val kit = PolarisTestKit(product = "acme")
        val rotated = kit.trust.addKey("rotated-2027")
        val server = PolarisServer(kit.options(trustRefresh = true))
        val doc = rotated.sign { entitle("x") }
        val headers = kit.headers(doc).toList()
        assertEquals(200, server.verdict(headers).status)
        assertTrue(kit.trust.calls.single().endsWith("/acme/.well-known/polaris-trust.jws"))
        // Without the refresh the same key is unknown.
        val pinsOnly = PolarisServer(kit.options())
        assertEquals("license_invalid", pinsOnly.verdict(headers).code)
        // Offline: the pins keep verifying.
        kit.trust.offline = true
        server.refreshAll()
        assertEquals(200, server.verdict(kit.signedHeaders {}.toList()).status)
        assertNotNull(server)
        server.close()
        pinsOnly.close()
    }
}
