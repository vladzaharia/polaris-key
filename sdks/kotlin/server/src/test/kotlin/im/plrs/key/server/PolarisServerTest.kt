// @pkey-feature server.license
//
// The server core's I/O half (WIRE-CONTRACT-V4 §14.4), which the corpus does not pin: the trust
// manifest fetch at start and on an unknown kid (at most once a minute), `X-PKey-SDK: kotlin-server`,
// a failed fetch keeping the last verified set, pinned keys never refused during an outage, and the
// freshness options.

package im.plrs.key.server

import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolarisServerTest {
    private val clockNow = AtomicLong(1_700_000_000L)
    private val pinned = TestSigner("pinned")
    private val rotated = TestSigner("rotated")

    private fun manifest(signer: TestSigner, vararg keys: TestSigner, aud: String = "acme", at: Long = clockNow.get()): String = signer.sign(
        "pkey-trust+jws",
        JsonObject(
            mapOf(
                "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive(aud), "schemaVersion" to JsonPrimitive(1),
                "issuedAt" to JsonPrimitive(at), "expiresAt" to JsonPrimitive(at + 86_400), "jwksUrl" to JsonPrimitive("https://key.plrs.im/acme/.well-known/jwks.json"),
                "cacheSeconds" to JsonPrimitive(900),
                "keys" to JsonArray(
                    keys.map {
                        JsonObject(
                            mapOf(
                                "kid" to JsonPrimitive(it.kid), "alg" to JsonPrimitive("EdDSA"), "kty" to JsonPrimitive("OKP"), "crv" to JsonPrimitive("Ed25519"),
                                "publicKey" to JsonPrimitive(it.publicKey), "status" to JsonPrimitive("active"),
                            ),
                        )
                    },
                ),
            ),
        ),
    )

    private fun server(transport: ScriptedTransport, max: Long? = null, refresh: Boolean = true) = PolarisServer(
        PolarisServerOptions(listOf(PolarisProduct("acme", pinned.trust)), maxAgeSeconds = max, trustRefresh = refresh, transport = transport, clock = { clockNow.get() }),
    )

    private fun header(doc: String) = listOf("X-PKey-License" to doc)

    @Test
    fun anUnknownKidFetchesTheManifestOnceAMinuteAndSendsTheServerSdkId() = runBlocking {
        val body = manifest(pinned, pinned, rotated)
        val transport = ScriptedTransport { ScriptedTransport.respond(200, body) }
        val s = server(transport)
        val doc = rotated.licenseDoc("acme", "dev_1", clockNow.get())
        assertEquals(200, s.verdict(header(doc)).status)
        val sent = transport.requests()
        assertEquals(1, sent.size)
        assertEquals("/acme/.well-known/polaris-trust.jws", sent[0].path)
        assertEquals("kotlin-server", sent[0].headers["X-PKey-SDK"])
        // A key the manifest does not publish: refused, and the next junk header inside a minute fetches nothing.
        val junk = TestSigner("unknown").licenseDoc("acme", "dev_1", clockNow.get())
        assertEquals("license_invalid", s.verdict(header(junk)).code)
        assertEquals("license_invalid", s.verdict(header(junk)).code)
        assertEquals(1, transport.requests().size)
        clockNow.addAndGet(61)
        assertEquals("license_invalid", s.verdict(header(junk)).code)
        assertEquals(2, transport.requests().size)
        s.close()
    }

    @Test
    fun concurrentUnknownKidsMakeOneFetchPerMinute() = runBlocking {
        val body = manifest(pinned, pinned)
        val transport = ScriptedTransport { ScriptedTransport.respond(200, body) }
        val s = server(transport)
        val junk = TestSigner("unknown").licenseDoc("acme", "dev_1", clockNow.get())
        val results = (1..40).map { this.async(kotlinx.coroutines.Dispatchers.Default) { s.verdict(header(junk)).code } }.map { it.await() }
        assertTrue(results.all { it == "license_invalid" })
        assertEquals(1, transport.requests().size)
        s.close()
    }

    @Test
    fun aTrustChangeBetweenSnapshotAndInsertLeavesNothingCached() = runBlocking {
        val body = manifest(pinned, pinned, rotated)
        val transport = ScriptedTransport { ScriptedTransport.respond(200, body) }
        val s = server(transport, refresh = false)
        s.beforeCacheInsert = {
            s.beforeCacheInsert = null
            // A trust change (a revocation or rotation) lands after the snapshot was taken.
            runBlocking { s.refreshAll() }
        }
        val doc = pinned.licenseDoc("acme", "dev_1", clockNow.get())
        assertEquals(200, s.verdict(header(doc)).status)
        assertEquals(0, s.cacheSize())
        assertEquals(200, s.verdict(header(doc)).status)
        assertEquals(1, s.cacheSize())
        s.close()
    }

    @Test
    fun anOversizeHeaderFieldIsInvalidWithoutSplitting() {
        val v = backendVerdict(listOf("X-PKey-License" to "a,".repeat(100_000)), clockNow.get(), BackendOptions(listOf("acme")), mapOf("acme" to pinned.trust))
        assertEquals("license_invalid", v.code)
    }

    @Test
    fun aFailedFetchKeepsTheLastVerifiedSetAndPinsStillVerify() = runBlocking {
        var up = true
        val body = manifest(pinned, pinned, rotated)
        val transport = ScriptedTransport { if (up) ScriptedTransport.respond(200, body) else ScriptedTransport.respond(503, "down") }
        val s = server(transport)
        val rotatedDoc = rotated.licenseDoc("acme", "dev_1", clockNow.get())
        assertEquals(200, s.verdict(header(rotatedDoc)).status)
        up = false
        clockNow.addAndGet(120)
        assertEquals(200, s.verdict(header(pinned.licenseDoc("acme", "dev_1", clockNow.get()))).status)
        // The last verified set is kept through the outage.
        assertEquals(200, s.verdict(header(rotated.licenseDoc("acme", "dev_1", clockNow.get()))).status)
        s.close()
    }

    @Test
    fun aManifestNotSignedByAPinIsRefused() = runBlocking {
        val forged = manifest(rotated, rotated)
        val transport = ScriptedTransport { ScriptedTransport.respond(200, forged) }
        val s = server(transport)
        assertEquals("license_invalid", s.verdict(header(rotated.licenseDoc("acme", "dev_1", clockNow.get()))).code)
        assertNull(s.trustFor("acme")["rotated"])
        s.close()
    }

    @Test
    fun trustRefreshFalseRunsOnThePinsAloneWithoutANetworkCall() = runBlocking {
        val transport = ScriptedTransport { ScriptedTransport.respond(200, "x") }
        val s = server(transport, refresh = false)
        s.start()
        assertEquals("license_invalid", s.verdict(header(rotated.licenseDoc("acme", "dev_1", clockNow.get()))).code)
        assertEquals(200, s.verdict(header(pinned.licenseDoc("acme", "dev_1", clockNow.get()))).status)
        assertTrue(transport.requests().isEmpty())
        s.close()
    }

    @Test
    fun maxAgeTightensTheWindowAndTheDefaultIsTheDocumentsOwn() = runBlocking {
        val s = server(ScriptedTransport { ScriptedTransport.respond(404) }, max = 600, refresh = false)
        val doc = pinned.licenseDoc("acme", "dev_1", clockNow.get())
        assertEquals(200, s.verdict(header(doc)).status)
        clockNow.addAndGet(901)
        assertEquals("license_stale", s.verdict(header(doc)).code)
        val wide = server(ScriptedTransport { ScriptedTransport.respond(404) }, refresh = false)
        assertEquals(200, wide.verdict(header(doc)).status)
        clockNow.addAndGet(3600)
        assertEquals("license_stale", wide.verdict(header(doc)).code)
        s.close()
        wide.close()
    }

    @Test
    fun theCacheNeverSkipsFreshness() = runBlocking {
        val s = server(ScriptedTransport { ScriptedTransport.respond(404) }, refresh = false)
        val doc = pinned.licenseDoc("acme", "dev_1", clockNow.get())
        assertEquals(200, s.verdict(header(doc)).status)
        assertEquals(200, s.verdict(header(doc)).status) // from the cache
        clockNow.addAndGet(3600 + 301)
        assertEquals("license_stale", s.verdict(header(doc)).code)
        s.close()
    }

    @Test
    fun onVerdictReportsTheCodeAndStepOnly() = runBlocking {
        val seen = ArrayList<Pair<String?, Int>>()
        val s = PolarisServer(
            PolarisServerOptions(listOf(PolarisProduct("acme", pinned.trust)), trustRefresh = false, clock = { clockNow.get() }, onVerdict = { c, st -> seen += c to st }),
        )
        s.verdict(emptyList())
        s.verdict(header(pinned.licenseDoc("acme", "dev_1", clockNow.get())))
        assertEquals(listOf<Pair<String?, Int>>("license_required" to 1, null to 0), seen)
        s.close()
    }
}

/** Nothing in the server modules logs: a token or a holder cannot reach a log from here. */
class NoLoggingTest {
    @Test
    fun theServerModulesNeverLog() {
        val root = java.io.File(System.getProperty("pkey.repoRoot"), "sdks/kotlin")
        val logging = Regex("""\b(println|print|Logger|LoggerFactory|log\.\w+|logger\.\w+|printStackTrace|System\.(out|err))\b""")
        var files = 0
        for (module in listOf("server", "server-ktor")) {
            java.io.File(root, "$module/src/main").walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { f ->
                files++
                f.readLines().forEachIndexed { i, line ->
                    val code = line.substringBefore("//")
                    assertTrue("${f.name}:${i + 1} logs: $line", !logging.containsMatchIn(code))
                }
            }
        }
        assertTrue(files >= 4)
    }
}
