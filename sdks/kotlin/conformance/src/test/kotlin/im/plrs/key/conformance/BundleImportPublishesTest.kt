// @pkey-feature core.bundle core.sync
//
// SP-51: importing an offline bundle through the client publishes the new licence state, like every
// other transition. The bundle is the corpus's valid full case.
package im.plrs.key.conformance

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.NoNetworkTransport
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.longValue
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class BundleImportPublishesTest {
    @Test
    fun importBundlePublishesTheLicenceState() = runBlocking {
        val c = (Corpus.v2("cases.json")["bundleCases"] as kotlinx.serialization.json.JsonArray).map { it.obj }.first { it["id"].stringValue == "bundle-valid-full" }
        val now = c["now"].longValue!!
        val client = PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = c["expectedAud"].stringValue!!, version = "1.0.0",
                    pinnedKeys = c["pinned"].objectValue!!.mapValues { it.value.stringValue!! },
                    store = InMemoryStore(c["expectedAud"].stringValue!!, c["deviceId"].stringValue!!),
                    transport = NoNetworkTransport, trustRefresh = false, clock = { now },
                ),
            ),
        )
        assertNull(client.licenseState.value)
        client.importBundle(c["bundleJws"].stringValue!!)
        assertNotNull(client.licenseState.value)
        assertEquals(client.status().status, client.licenseState.value!!.status)
    }
}
