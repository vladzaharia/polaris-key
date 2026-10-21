// @pkey-feature packs.state
//
// B-150 follow-through: a content route that refuses an object or range fetch keeps its class.
// 401 and 403 are `pack-not-entitled` (content URLs are entitlement-gated), 5xx `server-error`; a
// dropped connection (no response) and any other status, 404 included, stay `network-error`. One
// mapping in every packs client.

package im.plrs.key.packs

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.ServiceSlug
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class PacksObjectRefusalTest {
    private val discovery = """{"product":"djdl","services":{"license":{"enabled":false},"config":{"enabled":false},""" +
        """"release":{"enabled":true,"endpoints":{"record":"https://key.example/djdl/release/records/{sha256}"}},""" +
        """"distribution":{"enabled":true,"endpoints":{"blobs":"https://key.example/djdl/distribution/blobs/sha256/{sha256}"}},""" +
        """"update":{"enabled":true,"endpoints":{}}}}"""

    /** Discovery and the record answer; the record is the pack's own signed record. */
    private class Registry(private val discovery: String, private val pack: BuiltPack) : PolarisTransport {
        override suspend fun send(request: PolarisRequest): PolarisResponse {
            if (request.url.contains("/release/records/")) {
                return PolarisResponse(200, pack.jws.toByteArray(), mapOf("content-type" to "application/jose"))
            }
            return PolarisResponse(200, discovery.toByteArray(), mapOf("content-type" to "application/json"))
        }
    }

    /** The blob route: answers [status], or throws when [status] is 0 (no response at all). */
    private class Blobs(private val status: Int) : PackObjectTransport {
        override suspend fun get(url: String, headers: Map<String, String>, timeoutSeconds: Double): ObjectResponse {
            if (status == 0) throw IOException("connection dropped")
            return ObjectResponse(status, null, null, ByteStream.empty)
        }
    }

    private fun codeFor(status: Int): String? = runBlocking {
        val v1 = treePack("djdl.l10n", "1.0.0", 1, mapOf("a.json" to "{}".toByteArray()))
        val stamp = JsonObject(stampOf(v1).json.toMap() + ("format" to JsonPrimitive("pkey-content/1")))
        val dir = Files.createTempDirectory("pkey-packs-object-refusal")
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = "https://key.example", version = "1.0.0",
                pinnedKeys = PackFixtures.productTrust, store = InMemoryStore("djdl"),
                transport = Registry(discovery, v1),
                expectedServices = listOf(ServiceSlug.release, ServiceSlug.distribution, ServiceSlug.update),
            ),
        )
        val client = PacksClient(
            core, PackFixtures.releaseKeys,
            PacksOptions(
                contentStamp = PackStampSource.FromBytes(stamp.toString().toByteArray()), dir = dir,
                objectTransport = Blobs(status),
            ),
        )
        try {
            client.ensure(listOf("djdl.l10n"))
            fail("status $status installed a pack")
            null
        } catch (e: PackException) {
            e.code
        } catch (e: im.plrs.key.core.PolarisException) {
            e.code
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun aRefusedObjectFetchKeepsItsClass() {
        assertEquals(ErrorCode.packNotEntitled, codeFor(401))
        assertEquals(ErrorCode.packNotEntitled, codeFor(403))
        assertEquals(ErrorCode.serverError, codeFor(500))
        assertEquals(ErrorCode.serverError, codeFor(503))
        assertEquals(ErrorCode.networkError, codeFor(404))
        assertEquals(ErrorCode.networkError, codeFor(0))
    }

    @Test
    fun objectRefusalIsTheOneMapping() {
        assertEquals(ErrorCode.packNotEntitled, objectRefusal(401))
        assertEquals(ErrorCode.packNotEntitled, objectRefusal(403))
        assertEquals(ErrorCode.serverError, objectRefusal(599))
        assertEquals(ErrorCode.networkError, objectRefusal(404))
        assertEquals(ErrorCode.networkError, objectRefusal(200))
        assertEquals(ErrorCode.networkError, objectRefusal(0))
    }
}
