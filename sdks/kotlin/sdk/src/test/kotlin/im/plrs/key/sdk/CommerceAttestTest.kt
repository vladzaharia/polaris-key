// @pkey-feature devices.attest commerce.receipt config.mint
//
// Attestation and commerce through the umbrella client (notes/SDK-PARITY-PASS.md §3.9, §3.10): the
// three attestation steps with the platform evidence, the typed N/As (a JVM desktop is `runtime`), the
// Worker's refusal codes kept; attest-and-retry on a commerce claim and on an edge-mint (one attest,
// one retry, never a loop); the claim's typed results; and App Store 3.1.3(b)'s hiding rule.

package im.plrs.key.sdk

import im.plrs.key.core.AttestChallenge
import im.plrs.key.core.AttestEvidence
import im.plrs.key.core.AttestationProvider
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CommerceAttestTest {
    private val signer = TestSigner()

    private class FakeIntegrity(var unavailable: Unsupported? = null) : AttestationProvider {
        val seen = mutableListOf<AttestChallenge>()
        override fun unavailable(): Unsupported? = unavailable
        override suspend fun evidence(challenge: AttestChallenge): AttestEvidence {
            seen += challenge
            return AttestEvidence.PlayIntegrity("integrity-token-for-${challenge.requestHash}")
        }
    }

    private fun client(provider: AttestationProvider?, handler: (PolarisRequest) -> PolarisResponse): Pair<PolarisKeyClient, ScriptedTransport> = runBlocking {
        val transport = ScriptedTransport(handler)
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }, transport = transport, clock = { 1_700_000_000L },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.distribution),
                ),
                license = LicenseClientOptions(fingerprint = false),
                attestation = provider,
            ),
        )
        client to transport
    }

    private fun attestRoutes(r: PolarisRequest): PolarisResponse? = when (r.path) {
        "/djdl/devices/attest/challenge" -> respond(200, """{"challenge":"ch_1","requestHash":"rh_1","play":{"cloudProjectNumber":"1234"}}""")
        "/djdl/devices/attest" -> respond(200, """{"trustLevel":"attested","kind":"play-integrity","attestedAt":1700000000}""")
        else -> null
    }

    @Test
    fun attestRunsTheThreeSteps() = runBlocking {
        val integrity = FakeIntegrity()
        val (client, transport) = client(integrity) { attestRoutes(it) ?: respond(404) }
        val r = client.devices.attest()
        assertEquals("attested", r.trustLevel)
        assertEquals(1_700_000_000L, r.attestedAt)
        assertEquals(AttestChallenge("ch_1", "rh_1", "1234"), integrity.seen.single())
        val post = transport.requests().single { it.path == "/djdl/devices/attest" }
        assertEquals("Bearer pkeyt_held", post.headers["authorization"])
        val body = JsonText.parse(post.body!!.toString(Charsets.UTF_8)).objectValue!!
        assertEquals("play-integrity", body["kind"].stringValue)
        assertEquals("integrity-token-for-rh_1", body["token"].stringValue)
        assertEquals("ch_1", body["challenge"].stringValue)
    }

    @Test
    fun aRefusalKeepsTheWorkersCode() = runBlocking {
        val (client, _) = client(FakeIntegrity()) { r ->
            if (r.path == "/djdl/devices/attest") respond(422, """{"error":{"code":"attestation_rejected"}}""") else attestRoutes(r) ?: respond(404)
        }
        try {
            client.devices.attest()
            fail("expected a refusal")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.attestationRejected, e.code)
        }
    }

    @Test
    fun withoutAProviderTheJvmIsTheRuntimeNa() = runBlocking {
        val (client, transport) = client(null) { respond(500) }
        try {
            client.devices.attest()
            fail("expected the typed N/A")
        } catch (e: UnsupportedException) {
            assertEquals(UnsupportedReason.runtime, e.unsupported.reason)
        }
        assertTrue(transport.requests().isEmpty())
        // A build that cannot attest (a direct flavour) is `outlet`, also before any request.
        val (direct, t2) = client(FakeIntegrity(Unsupported("devices.attest", UnsupportedReason.outlet, "direct build"))) { respond(500) }
        try {
            direct.devices.attest()
            fail("expected the typed N/A")
        } catch (e: UnsupportedException) {
            assertEquals(UnsupportedReason.outlet, e.unsupported.reason)
        }
        assertTrue(t2.requests().isEmpty())
    }

    @Test
    fun aClaimThatNeedsAttestationAttestsOnceAndRetriesOnce() = runBlocking {
        var claims = 0
        val (client, transport) = client(FakeIntegrity()) { r ->
            attestRoutes(r) ?: when (r.path) {
                "/djdl/distribution/commerce/claim" -> {
                    claims++
                    if (claims == 1) respond(403, """{"error":{"code":"attestation_required"}}""")
                    else respond(200, """{"ok":true,"store":"play","productId":"skins","flag":"extras.skins","state":"active","granted":true,"changed":true}""")
                }
                else -> respond(404)
            }
        }
        val r = client.commerce.claimPlay("skins", "tok")
        assertEquals(ClaimResult.Ok("play", "skins", "extras.skins", null, "active", true, true), r)
        assertEquals(2, claims)
        assertEquals(1, transport.requests().count { it.path == "/djdl/devices/attest" })
        val body = JsonText.parse(transport.requests().last { it.path.endsWith("/claim") }.body!!.toString(Charsets.UTF_8)).objectValue!!
        assertEquals(setOf("store", "productId", "purchaseToken"), body.keys)
    }

    @Test
    fun aSecondAttestationRefusalStands() = runBlocking {
        val (client, transport) = client(FakeIntegrity()) { r ->
            attestRoutes(r) ?: if (r.path.endsWith("/claim")) respond(403, """{"error":{"code":"attestation_required"}}""") else respond(404)
        }
        assertEquals(ClaimResult.AttestationRequired, client.commerce.claimSteam("ab12", "1234560"))
        assertEquals(2, transport.requests().count { it.path.endsWith("/claim") })
        // Where the runtime cannot attest, no attestation is tried at all.
        val (jvm, t2) = client(null) { r -> if (r.path.endsWith("/claim")) respond(403, """{"error":{"code":"attestation_required"}}""") else respond(404) }
        assertEquals(ClaimResult.AttestationRequired, jvm.commerce.claimSteam("ab12", "1234560"))
        assertEquals(1, t2.requests().count { it.path.endsWith("/claim") })
        assertFalse(t2.requests().any { it.path.contains("attest") })
    }

    @Test
    fun anEdgeMintThatNeedsAttestationAttestsAndRetries() = runBlocking {
        var mints = 0
        val (client, transport) = client(FakeIntegrity()) { r ->
            attestRoutes(r) ?: when (r.path) {
                "/djdl/config/mint/maps/token" -> {
                    mints++
                    if (mints == 1) respond(403, """{"error":{"code":"attestation_required"}}""") else respond(200, """{"token":"edge","expiresAt":1700003600}""")
                }
                else -> respond(404)
            }
        }
        assertEquals("edge", client.config.mintToken("maps").token)
        assertEquals(1, transport.requests().count { it.path == "/djdl/devices/attest" })
    }

    @Test
    fun claimRefusalsAreTyped() = runBlocking {
        val (client, _) = client(null) { r ->
            when (r.path) {
                "/djdl/distribution/commerce/binding" -> respond(200, """{"bindingId":"F8606AE6-C6AF-419A-A7CA-125107444036","products":[{"store":"steam","productId":"1","flag":"extras.dice"},{"store":"app-store","productId":"2","flag":"extras.music"}]}""")
                else -> respond(403, """{"error":"not_entitled","reason":"no_license"}""")
            }
        }
        val b = client.commerce.binding()
        assertEquals("f8606ae6-c6af-419a-a7ca-125107444036", b.bindingId)
        assertEquals(CommerceProduct("steam", "1", "extras.dice", "app"), b.products[0])
        assertEquals(ClaimResult.Refused("not_entitled", "no_license", 403, null), client.commerce.claimSteam("ab", "1"))
        try {
            client.commerce.claim("itch", emptyMap())
            fail("expected invalid-options")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidOptions, e.code)
        }
        // App Store 3.1.3(b): sold on Steam only → hidden on an Apple outlet; sold on the App Store too → shown.
        assertTrue(CommerceClient.hiddenOn("extras.dice", b.products))
        assertFalse(CommerceClient.hiddenOn("extras.music", b.products))
        assertFalse(CommerceClient.hiddenOn("operator.grant", b.products))
        // Android never hides.
        assertFalse(client.commerce.hiddenHere("extras.dice"))
    }
}
