// @pkey-feature packs.state
//
// B-150: a registry that refuses a record fetch keeps its class. 401 is `unauthorized`, 403
// `forbidden`, 5xx `server-error`; a dropped connection (no response) and any other status, 404
// included, stay `network-error`. One mapping in every packs client.

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

class PacksRecordRefusalTest {
    private val discovery = """{"product":"djdl","services":{"license":{"enabled":false},"config":{"enabled":false},""" +
        """"release":{"enabled":true,"endpoints":{"record":"https://key.example/djdl/release/records/{sha256}"}},""" +
        """"distribution":{"enabled":true,"endpoints":{"blobs":"https://key.example/djdl/distribution/blobs/sha256/{sha256}"}},""" +
        """"update":{"enabled":true,"endpoints":{}}}}"""

    /** Discovery answers; the record path answers [status], or throws when [status] is 0. */
    private class Registry(private val discovery: String, private val status: Int) : PolarisTransport {
        override suspend fun send(request: PolarisRequest): PolarisResponse {
            if (request.url.contains("/release/records/")) {
                if (status == 0) throw IOException("connection dropped")
                return PolarisResponse(status, "{}".toByteArray())
            }
            return PolarisResponse(200, discovery.toByteArray(), mapOf("content-type" to "application/json"))
        }
    }

    private fun codeFor(status: Int): String? = runBlocking {
        val v1 = treePack("djdl.l10n", "1.0.0", 1, mapOf("a.json" to "{}".toByteArray()))
        val stamp = JsonObject(stampOf(v1).json.toMap() + ("format" to JsonPrimitive("pkey-content/1")))
        val dir = Files.createTempDirectory("pkey-packs-refusal")
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = "https://key.example", version = "1.0.0",
                pinnedKeys = PackFixtures.productTrust, store = InMemoryStore("djdl"),
                transport = Registry(discovery, status),
                expectedServices = listOf(ServiceSlug.release, ServiceSlug.distribution, ServiceSlug.update),
            ),
        )
        val client = PacksClient(
            core, PackFixtures.releaseKeys,
            PacksOptions(contentStamp = PackStampSource.FromBytes(stamp.toString().toByteArray()), dir = dir),
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
    fun aRefusedRecordFetchKeepsItsClass() {
        assertEquals(ErrorCode.unauthorized, codeFor(401))
        assertEquals(ErrorCode.forbidden, codeFor(403))
        assertEquals(ErrorCode.serverError, codeFor(500))
        assertEquals(ErrorCode.serverError, codeFor(503))
        assertEquals(ErrorCode.networkError, codeFor(404))
        assertEquals(ErrorCode.networkError, codeFor(0))
    }
}
