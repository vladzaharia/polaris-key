// @pkey-feature connect.protocol
//
// `CoreContext.acceptPeer` (CC-12.5; WIRE-CONTRACT-V5 §15.8): a trust manifest a peer pushed is
// verified against the usable pins and tombstones only, must be newer than the held one, raises the
// clock floor, and answers the refusal reason. Mirrors Node's `acceptPeer` in `core/trust.ts`.

package im.plrs.key.core

import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class TrustAcceptPeerTest {
    private val now = 1_700_000_000L
    private val main = TestSigner("main-2026")
    private val alt = TestSigner("alt-2026")
    private val pins: TrustSet = main.trust + alt.trust

    private fun core() = CoreContext(
        CoreOptions(
            productSlug = "djdl",
            version = "1.0.0",
            pinnedKeys = pins,
            store = InMemoryStore("djdl", "dev1"),
            transport = NoNetworkTransport,
            clock = { now },
        ),
    )

    private fun entry(signer: TestSigner, status: String = "active"): JsonObject = buildJsonObject {
        put("kid", signer.kid)
        put("alg", "EdDSA")
        put("kty", "OKP")
        put("crv", "Ed25519")
        put("publicKey", signer.publicKey)
        put("status", status)
    }

    private fun manifest(issuedAt: Long, by: TestSigner = main, aud: String = "djdl", keys: List<JsonObject> = listOf(entry(main))): String = by.sign(
        "pkey-trust+jws",
        buildJsonObject {
            put("schemaVersion", 1)
            put("aud", aud)
            put("iss", "key.plrs.im")
            put("issuedAt", issuedAt)
            put("expiresAt", issuedAt + 600)
            put("jwksUrl", "https://key.plrs.im/djdl/.well-known/jwks.json")
            put("cacheSeconds", 300)
            putJsonArray("keys") { keys.forEach { add(it) } }
        },
    )

    @Test
    fun aNewerManifestSignedByAUsablePinIsAppliedAndRaisesTheFloor() = runBlocking {
        val c = core()
        c.start()
        assertEquals(PeerTrustResult(true), c.acceptPeer(manifest(now)))
        assertEquals(now, c.trustManifest()!!.issuedAt)
        assertEquals(now, c.highWaterMark())
    }

    @Test
    fun itMustBeNewerThanTheHeldOne() = runBlocking {
        val c = core()
        c.start()
        assertTrue(c.acceptPeer(manifest(now + 10)).applied)
        for (issued in listOf(now + 10, now + 5)) {
            assertEquals(PeerTrustResult(false, "not_newer"), c.acceptPeer(manifest(issued)))
        }
        assertEquals(now + 10, c.trustManifest()!!.issuedAt)
        assertTrue(c.acceptPeer(manifest(now + 11)).applied)
    }

    @Test
    fun aManifestThatDoesNotVerifyIsInvalidAndChangesNothing() = runBlocking {
        val c = core()
        c.start()
        assertTrue(c.acceptPeer(manifest(now)).applied)
        val before = c.trust()
        val bad = listOf(
            "not.a.jws",
            "",
            manifest(now + 50, by = TestSigner("stranger")),
            manifest(now + 50, aud = "other-product"),
            manifest(now + 5000),
        )
        for (jws in bad) assertEquals(PeerTrustResult(false, "invalid"), c.acceptPeer(jws))
        assertEquals(now, c.trustManifest()!!.issuedAt)
        assertEquals(before, c.trust())
    }

    @Test
    fun aRevokedPinNoLongerSignsAPushedManifest() = runBlocking {
        val c = core()
        c.start()
        val revoke = manifest(now, by = alt, keys = listOf(entry(main, "revoked"), entry(alt)))
        assertTrue(c.acceptPeer(revoke).applied)
        assertEquals(listOf("main-2026"), c.revokedPins())
        assertFalse(c.trust().containsKey("main-2026"))
        assertEquals(mapOf("main-2026" to revoke), c.pinRevocations())
        assertEquals(PeerTrustResult(false, "invalid"), c.acceptPeer(manifest(now + 100)))
    }

    @Test
    fun theDiscoveredTierIsReplacedNotMerged() = runBlocking {
        val c = core()
        c.start()
        val extra = TestSigner("extra-2026")
        assertTrue(c.acceptPeer(manifest(now, keys = listOf(entry(main), entry(extra)))).applied)
        assertTrue(c.trust().containsKey("extra-2026"))
        assertTrue(c.acceptPeer(manifest(now + 1)).applied)
        assertFalse(c.trust().containsKey("extra-2026"))
    }

    @Test
    fun concurrentEqualPushesApplyExactlyOnce() = runBlocking {
        val c = core()
        c.start()
        val jws = manifest(now + 1)
        val barrier = CyclicBarrier(8)
        // One thread per caller: the barrier blocks, and Dispatchers.Default has only as many threads
        // as the host has cores (two on a hosted runner), so 8 waiters on it never all arrive.
        val pool = Executors.newFixedThreadPool(8)
        val results = try {
            (1..8).map {
                async(pool.asCoroutineDispatcher()) {
                    barrier.await(30, TimeUnit.SECONDS)
                    c.acceptPeer(jws)
                }
            }.awaitAll()
        } finally {
            pool.shutdown()
        }
        assertEquals(1, results.count { it.applied })
        assertTrue(results.filter { !it.applied }.all { it.reason == "not_newer" })
    }

    @Test
    fun theResultNamesNoKeyMaterial() = runBlocking {
        val c = core()
        c.start()
        val r = c.acceptPeer(manifest(now))
        assertNull(r.reason)
        assertFalse(r.toString().contains(main.publicKey))
    }
}
