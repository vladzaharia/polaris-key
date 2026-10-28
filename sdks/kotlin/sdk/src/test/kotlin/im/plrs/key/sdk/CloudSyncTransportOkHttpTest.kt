// @pkey-feature sync.settings
//
// H-3 against the real OkHttpTransport: a redirect is an answer and is not followed, a body past the cap is no answer,
// and a gzip body is capped on its decoded size. Plus the java.io path of a state file on an Android below API 26.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.FileStore
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.GZIPOutputStream

class CloudSyncTransportOkHttpTest {
    @get:Rule val tmp = TemporaryFolder()

    private val pull = Json.parseToJsonElement("""{"method":"GET","path":"/djdl/sync?cursor=0"}""") as JsonObject

    private fun core(server: MockWebServer): CoreContext {
        val store = FileStore("djdl", tmp.newFolder())
        runBlocking { store.setToken("pkeyt_L7Z_jTR0YsyzhMxHLBdEwKZ4yW2Uu4m6CANM1oHQiUA") }
        return CoreContext(
            CoreOptions(
                productSlug = "djdl",
                baseUrl = server.url("/").toString().trimEnd('/'),
                version = "1.0.0",
                pinnedKeys = TestSigner().trust,
                trustRefresh = false,
                store = store,
            ),
        )
    }

    @Test
    fun aRedirectIsAnAnswerAndIsNotFollowed() = runBlocking {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/elsewhere").toString()).setBody(""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"cursor":1}"""))
        try {
            val res = CloudSyncTransport.send(core(server), pull)
            assertEquals(302, res.status)
            assertEquals("the second request never happened", 1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun aBodyPastTheCapIsNoAnswerAndAGzipBodyIsCappedOnItsDecodedSize() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(ByteArray(SYNC_MAX_RESPONSE_BYTES + 10) { 'a'.code.toByte() })))
        val bomb = java.io.ByteArrayOutputStream().also { out ->
            GZIPOutputStream(out).use { z -> repeat(SYNC_MAX_RESPONSE_BYTES / 1024 + 20) { z.write(ByteArray(1024) { 'a'.code.toByte() }) } }
        }.toByteArray()
        assertTrue("the compressed body is small", bomb.size < SYNC_MAX_RESPONSE_BYTES / 100)
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Encoding", "gzip").setBody(Buffer().write(bomb)))
        server.start()
        try {
            val c = core(server)
            assertTrue("over the cap", CloudSyncTransport.send(c, pull).transportError)
            assertTrue("a gzip bomb", CloudSyncTransport.send(c, pull).transportError)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun theStateFileLoadsAndRemovesThroughJavaIoWhereNioIsMissing() {
        forceLegacyIo = true
        try {
            val dir = tmp.newFolder()
            val f = CloudSyncStateFile(dir, "demo")
            val persisted = Json.parseToJsonElement("""{"partitions":{},"hlc":[0,0],"contacted":true}""") as JsonObject
            f.save(persisted, null, listOf("a"))
            assertNotNull("the journal survives a restart", f.load().persisted)
            assertEquals(listOf("a"), f.load().openKeys)
            // A link at the name reads as empty.
            val real = File(dir, "real.json").also { f.file.copyTo(it) }
            f.remove()
            assertFalse(f.file.exists())
            java.nio.file.Files.createSymbolicLink(f.file.toPath(), real.toPath())
            assertNull(f.load().persisted)
            f.remove()
            assertFalse(java.nio.file.Files.exists(f.file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        } finally {
            forceLegacyIo = false
        }
    }
}
