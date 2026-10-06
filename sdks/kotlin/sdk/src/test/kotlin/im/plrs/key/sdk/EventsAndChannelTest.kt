// @pkey-feature core.sync license.channels
//
// The umbrella client's event stream and runtime channel switching (notes/SDK-PARITY-PASS.md §3.11,
// §3.18 `ChannelPicker`): one multi-subscriber `events` Flow carries licence and config changes, a
// local override reaches it, and setChannel() honours the licence's channels, persists beside the
// store and names the new channel on the next request.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class EventsAndChannelTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private fun client(dir: File, seen: MutableList<PolarisRequest>): PolarisKeyClient = runBlocking {
        val store = FileStore("djdl", dir).also { it.setToken("pkeyt_held") }
        val device = store.getDeviceId()
        val license = signer.licenseDoc("djdl", device, now, entitlements = mapOf("channels" to JsonArray(listOf(JsonPrimitive("stable"), JsonPrimitive("beta")))))
        val config = signer.configDoc("djdl", device, now, config = mapOf("ui.theme" to JsonPrimitive("dark")))
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.3.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = store, clock = { now },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.config),
                    transport = ScriptedTransport { r ->
                        seen += r
                        when (r.path) {
                            "/djdl/license/document" -> respond(200, license)
                            "/djdl/config/document" -> respond(200, config)
                            else -> respond(404)
                        }
                    },
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
    }

    @Test
    fun aLocalOverrideReachesTheEventStream() = runBlocking {
        val dir = Files.createTempDirectory("pkey-events").toFile()
        try {
            val c = client(dir, mutableListOf())
            c.start()
            c.sync()
            val next = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) { c.events.filterIsInstance<PolarisEvent.Config>().first() }
            }
            c.config.set("ui.theme", JsonPrimitive("light"))
            val event = next.await()
            assertEquals("ui.theme", event.change.key)
            assertEquals(JsonPrimitive("light"), event.change.value)
            c.close()
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun theChannelSwitchesWithinTheLicenceAndPersists() = runBlocking {
        val dir = Files.createTempDirectory("pkey-channel").toFile()
        try {
            val seen = mutableListOf<PolarisRequest>()
            val c = client(dir, seen)
            c.start()
            c.sync()
            val choices = c.channelChoices()
            assertEquals("stable", choices.current)
            assertNull(choices.lockedBy)
            assertTrue("beta" in choices.options)
            try {
                c.setChannel("nightly")
                fail("a channel the licence does not grant is refused")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.channelNotAllowed, e.code)
            }
            seen.clear()
            c.setChannel("beta")
            assertEquals("beta", c.core.channel)
            // The forced sync names the new channel.
            assertEquals("beta", seen.first().headers.entries.first { it.key.equals("x-pkey-channel", true) }.value)
            c.close()
            // A new process reads the persisted preference; null returns to the build's channel.
            val again = client(dir, mutableListOf())
            assertEquals("beta", again.core.channel)
            again.setChannel(null)
            assertEquals("stable", again.core.channel)
            again.close()
        } finally {
            dir.deleteRecursively()
        }
    }
}
