// @pkey-feature update.feeds
//
// The app-updater feed URLs (plans/SP-00.md D5): every row of conformance/corpus/v2/
// feed-url-matrix.json through `client.update.feedUrl()`, against a discovery document carrying the
// row's endpoint set (an empty set is a product with Update off), with the Node runner's row names.
// `{url}` rows must expand to exactly that URL; `{unsupported: "product"}` rows must throw the typed
// UnsupportedException with reason `product`.

package im.plrs.key.conformance

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import java.net.URI
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedUrlMatrixTest : ConformanceSuite() {
    private val matrix = Corpus.v2("feed-url-matrix.json")
    private val trust = Transcript.load().first().trust

    private fun client(endpoints: JsonObject): PolarisKeyClient = runBlocking {
        val update = if (endpoints.isEmpty()) JsonObject(mapOf("enabled" to JsonPrimitive(false)))
        else JsonObject(mapOf("enabled" to JsonPrimitive(true), "endpoints" to endpoints))
        val discovery = JsonObject(mapOf("product" to JsonPrimitive("full"), "services" to JsonObject(mapOf("update" to update)))).toString()
        val transport = object : PolarisTransport {
            override suspend fun send(request: PolarisRequest): PolarisResponse =
                if (URI(request.url).path.endsWith("/polaris.json")) PolarisResponse(200, discovery.toByteArray(), mapOf("content-type" to "application/json"))
                else PolarisResponse(404, ByteArray(0))
        }
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "full", baseUrl = "https://key.plrs.im", version = "1.0.0", pinnedKeys = trust,
                    store = InMemoryStore("full", "dev_feed_matrix"), transport = transport, trustRefresh = false,
                ),
            ),
        )
    }

    @Test
    fun everyRowExpandsAsTheCorpusSays() = runBlocking {
        val sets = matrix["endpointSets"].objectValue!!
        val rows = matrix["rows"].arrayValue!!
        assertTrue("the matrix has rows", rows.isNotEmpty())
        val failures = ArrayList<String>()
        for (r in rows) {
            val row = r.objectValue!!
            val name = row["name"].stringValue!!
            val input = row["input"].objectValue!!
            val expect = row["expect"].objectValue!!
            val c = client(sets[row["endpoints"].stringValue!!].objectValue!!)
            val got: String = try {
                c.update.feedUrl(
                    input["kind"].stringValue!!,
                    channel = input["channel"].stringValue,
                    velopackChannel = input["velopackChannel"].stringValue,
                    buildId = input["buildId"].stringValue,
                )
            } catch (e: UnsupportedException) {
                "unsupported:${e.unsupported.reason}"
            } finally {
                c.close()
            }
            val want = expect["url"].stringValue ?: "unsupported:${expect["unsupported"].stringValue}"
            if (got != want) failures += "$name: expected $want, got $got"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }
}
