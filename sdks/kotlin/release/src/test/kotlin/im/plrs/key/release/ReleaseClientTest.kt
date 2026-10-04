// @pkey-feature release.changelog release.download release.record
//
// The release client beyond the changelog transcripts: refusals report the body's own code in
// either envelope, URLs are built (never fetched) with each value one escaped segment, every verb
// refuses `service-unavailable` without Release, and `verifyRecord` binds a record to the app's
// pinned release keys with the client's own product as the audience.

package im.plrs.key.release

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ReleaseRecordStep
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.VerifyReleaseRecordResult
import im.plrs.key.core.recordHash
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ReleaseClientTest {
    private val productKey = TestSigner("product-key")

    private fun release(
        services: List<ServiceSlug> = listOf(ServiceSlug.release),
        token: String? = null,
        handler: (PolarisRequest) -> PolarisResponse = { respond(404) },
    ): Pair<ReleaseClient, ScriptedTransport> = runBlocking {
        val store = InMemoryStore("djdl", "dev1")
        token?.let { store.setToken(it) }
        val transport = ScriptedTransport(handler)
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = productKey.trust, trustRefresh = false,
                store = store, transport = transport, clock = { 1_700_000_000 }, expectedServices = services,
            ),
        )
        core.start()
        ReleaseClient(core) to transport
    }

    private fun code(block: suspend () -> Unit): String? = runBlocking {
        try {
            block()
            null
        } catch (e: PolarisException) {
            e.code
        }
    }

    @Test
    fun refusalsCarryTheBodysOwnCode() {
        assertEquals("channel_not_allowed", code { release { respond(403, """{"error":{"code":"channel_not_allowed"}}""") }.first.changelog() })
        assertEquals("download_auth_required", code { release { respond(401, """{"error":"download_auth_required"}""") }.first.changelog() })
        assertEquals(ErrorCode.unauthorized, code { release { respond(401, "") }.first.changelog() })
        assertEquals(ErrorCode.forbidden, code { release { respond(403, "{}") }.first.changelog() })
        assertEquals(ErrorCode.notFound, code { release { respond(500) }.first.changelog() })
    }

    @Test
    fun theBearerIsForwardedOnlyWhenHeldAndEntriesAreTolerant() = runBlocking {
        val body = """{"entries":[{"version":"1.0.0","tag":"v1.0.0","date":null,"url":"u"},{"tag":7},"junk"]}"""
        val (anonymous, t1) = release { respond(200, body) }
        val entries = anonymous.changelog()
        assertEquals(listOf(ChangelogEntry("1.0.0", "v1.0.0", null, null, "u"), ChangelogEntry("", "", null, null, "")), entries)
        assertTrue("authorization" !in t1.requests().single().headers)
        val (held, t2) = release(token = "pkeyt_x") { respond(200, """{"entries":[]}""") }
        assertEquals(emptyList<ChangelogEntry>(), held.changelog())
        assertEquals("Bearer pkeyt_x", t2.requests().single().headers["authorization"])
    }

    @Test
    fun urlsAreBuiltWithEscapedSegments() = runBlocking {
        val (r, transport) = release()
        assertEquals("https://key.plrs.im/djdl/release/install.sh", r.installUrl())
        assertEquals("https://key.plrs.im/djdl/release/dl/1.2.0/djdl-arm64.dmg", r.downloadUrl("1.2.0", "djdl", "arm64", dmg = true))
        assertEquals("https://key.plrs.im/djdl/release/dl/1.2.0/djdl-x64?checksum=sha256", r.downloadUrl("1.2.0", "djdl", "x64", checksum = true))
        assertEquals("https://key.plrs.im/djdl/release/dl/..%2F1/a%2Fb-c", r.downloadUrl("../1", "a/b", "c"))
        assertTrue(transport.requests().isEmpty())
    }

    @Test
    fun everyVerbRefusesWithoutRelease() {
        val (r, _) = release(services = listOf(ServiceSlug.license))
        assertEquals(ErrorCode.serviceUnavailable, code { r.changelog() })
        assertEquals(ErrorCode.serviceUnavailable, code { r.installUrl() })
        assertEquals(ErrorCode.serviceUnavailable, code { r.downloadUrl("1", "b", "a") })
    }

    @Test
    fun verifyRecordUsesThePinnedReleaseKeysAndTheProduct() = runBlocking {
        val releaseKey = TestSigner("release-key")
        val payload = JsonObject(
            mapOf(
                "schemaVersion" to JsonPrimitive(1), "aud" to JsonPrimitive("djdl"), "deliverable" to JsonPrimitive("app"),
                "kind" to JsonPrimitive("app"), "version" to JsonPrimitive("1.2.0"), "seq" to JsonPrimitive(12),
                "issuedAt" to JsonPrimitive(1_700_000_000),
                "builds" to JsonArray(
                    listOf(
                        JsonObject(
                            mapOf(
                                "id" to JsonPrimitive("apk"), "platform" to JsonPrimitive("android"), "arch" to JsonPrimitive("any"),
                                "format" to JsonPrimitive("apk"), "artifacts" to JsonArray(emptyList()),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val jws = releaseKey.sign("pkey-release+jws", payload)
        val (r, _) = release()
        val ok = r.verifyRecord(jws, releaseKey.trust, recordHash(jws))
        assertTrue(ok is VerifyReleaseRecordResult.Ok)
        assertEquals("1.2.0", (ok as VerifyReleaseRecordResult.Ok).record.version)
        // Signed by a key the app does not pin: refused at the signature step.
        assertEquals(VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws), r.verifyRecord(jws, productKey.trust.mapKeys { "release-key" }, recordHash(jws)))
        // A release key that is also a product key is never accepted.
        val byProductKey = productKey.sign("pkey-release+jws", payload)
        assertEquals(VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws), r.verifyRecord(byProductKey, productKey.trust, recordHash(byProductKey)))
        // The hash comes first.
        assertEquals(VerifyReleaseRecordResult.Refused(ReleaseRecordStep.hash), r.verifyRecord(jws, releaseKey.trust, "0".repeat(64)))
        try {
            r.verifyRecord("not a jws", releaseKey.trust, recordHash("not a jws")).let {
                assertEquals(VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws), it)
            }
        } catch (e: Exception) {
            fail("verifyRecord threw: $e")
        }
    }
}
