// @pkey-feature sync.files
//
// The file transport (U-23.K5) against the real OkHttpTransport: a closed list of routes, no redirect followed, a
// Content-Digest on every PUT, an answer read under the cap the call expects, Retry-After as plain digits, and a
// bearer that is another person's (or none) sending nothing.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.FileStore
import im.plrs.key.core.SYNC_CHUNK_MAX_STORED_BYTES
import im.plrs.key.core.objectValue
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

class CloudSyncFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    private val chunk = "ab".repeat(32)
    private val target = FileTarget("saves", "slot1")

    private fun core(server: MockWebServer, token: Boolean = true, subject: String? = null): CoreContext {
        val store = FileStore("djdl", tmp.newFolder())
        runBlocking {
            if (token) store.setToken("pkeyt_L7Z_jTR0YsyzhMxHLBdEwKZ4yW2Uu4m6CANM1oHQiUA")
        }
        val ctx = CoreContext(
            CoreOptions(
                productSlug = "djdl",
                baseUrl = server.url("/").toString().trimEnd('/'),
                version = "1.0.0",
                pinnedKeys = TestSigner().trust,
                trustRefresh = false,
                store = store,
            ),
        )
        if (subject != null) runBlocking { ctx.setSubject(subject) }
        return ctx
    }

    private fun <T> withServer(block: suspend (MockWebServer) -> T): T = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            block(server)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun onlyTheRoutesOfTheFilesSurfaceAreAllowed() {
        val base = "/djdl/sync/files/saves/slot1"
        for (ok in listOf(
            "$base/begin", "$base/finalize", "$base/revisions", base, "$base?version=3", "$base/upload/up_1", "$base/upload/up_1/parts/12",
            "$base/upload/up_1/chunks", "$base/upload/up_1/chunks/$chunk", "/djdl/sync/files/saves/chunks/$chunk",
        )) {
            assertTrue(ok, isFilesPath("djdl", ok))
        }
        for (bad in listOf(
            "/djdl/sync/files/saves/../slot1", "/djdl/sync/files/./slot1/begin", "$base/upload/up_1/parts/x", "$base/upload/up_1/chunks/ABC",
            "$base/other", "$base?version=x", "$base/begin?version=1", "/other/sync/files/saves/slot1", "/djdl/sync/ops", "$base/upload/..",
            "/djdl/sync/files/saves/slot1/upload/up_1/parts/12345", "//evil.example/djdl/sync/files/saves/slot1",
        )) {
            assertFalse(bad, isFilesPath("djdl", bad))
        }
    }

    @Test
    fun retryAfterIsPlainDigitsNineAtMostAndCapped() {
        assertEquals(30.0, parseRetryAfter("30")!!, 0.0)
        assertEquals(3600.0, parseRetryAfter("999999999")!!, 0.0)
        assertNull(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"))
        assertNull(parseRetryAfter("1234567890"))
        assertNull(parseRetryAfter("-5"))
        assertNull(parseRetryAfter(""))
        assertNull(parseRetryAfter(null))
    }

    @Test
    fun aPartIsSentWithItsDigestAndTheBearerToTheUploadRoute() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(204))
        val body = ByteArray(100) { it.toByte() }
        val sha = MessageDigest.getInstance("SHA-256").digest(body)
        val hex = sha.joinToString("") { "%02x".format(it) }
        val reply = HttpFileTransport(core(server)).putPart(target, "up_1", 2, body, hex)
        assertTrue(reply is FileReply.Ok)
        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/djdl/sync/files/saves/slot1/upload/up_1/parts/2", req.path)
        assertEquals("sha-256=:" + java.util.Base64.getEncoder().encodeToString(sha) + ":", req.getHeader("content-digest"))
        assertTrue(req.getHeader("authorization")!!.startsWith("Bearer pkeyt_"))
        assertEquals("application/octet-stream", req.getHeader("content-type"))
        assertEquals(100L, req.bodySize)
    }

    @Test
    fun aRedirectIsARefusalAndIsNotFollowed() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/elsewhere").toString()))
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val reply = HttpFileTransport(core(server)).status(target, "up_1")
        assertEquals("redirect_refused", (reply as FileReply.Refused).refusal.code)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun anErrorKeepsItsCodeRetryAfterAndExtraMembers() = withServer { server ->
        server.enqueue(
            MockResponse().setResponseCode(503).setHeader("Retry-After", "7").setBody("""{"error":{"code":"unavailable","message":"x"}}"""),
        )
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"upload_incomplete","message":"x"},"missing":[1,2]}"""))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"quota_exceeded","message":"x","scope":"user"}}"""))
        val t = HttpFileTransport(core(server))
        val busy = (t.status(target, "up_1") as FileReply.Refused).refusal
        assertEquals(503, busy.status)
        assertEquals("unavailable", busy.code)
        assertEquals(7.0, busy.retryAfterSeconds!!, 0.0)
        val incomplete = (t.finalize(target, buildJsonObject { put("uploadId", "up_1") }) as FileReply.Refused).refusal
        assertEquals("upload_incomplete", incomplete.code)
        assertEquals("[1,2]", incomplete.body.objectValue!!["missing"].toString())
        val quota = (t.finalize(target, buildJsonObject { put("uploadId", "up_1") }) as FileReply.Refused).refusal
        assertEquals("user", (quota.body.objectValue!!["scope"] as JsonPrimitive).content)
    }

    @Test
    fun aBodyPastTheCapIsNoAnswer() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(ByteArray(SYNC_CHUNK_MAX_STORED_BYTES + 1))))
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 0-9/100").setBody(Buffer().write(ByteArray(11))))
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(ByteArray(FILES_JSON_MAX_BYTES + 1) { ' '.code.toByte() })))
        val t = HttpFileTransport(core(server))
        assertEquals("bad_response", (t.getChunk("saves", chunk) as FileReply.Refused).refusal.code)
        assertEquals("bad_response", (t.getFile(target, FileQuery(range = 0 to 10)) as FileReply.Refused).refusal.code)
        assertEquals("bad_response", (t.status(target, "up_1") as FileReply.Refused).refusal.code)
    }

    @Test
    fun aRangedReadAsksForTheRangeAndParsesContentRange() = withServer { server ->
        server.enqueue(
            MockResponse().setResponseCode(
                206,
            ).setHeader("Content-Range", "bytes 10-19/100").setHeader("ETag", "\"abc\"").setBody(Buffer().write(ByteArray(10))),
        )
        val reply = HttpFileTransport(core(server)).getFile(target, FileQuery(version = 3, range = 10 to 20, ifMatch = "\"abc\"")) as FileReply.Ok
        val req = server.takeRequest()
        assertEquals("/djdl/sync/files/saves/slot1?version=3", req.path)
        assertEquals("bytes=10-19", req.getHeader("range"))
        assertEquals("\"abc\"", req.getHeader("if-match"))
        val cr = reply.value.contentRange!!
        assertEquals(listOf(10, 20, 100), listOf(cr.start, cr.end, cr.total))
        assertEquals("\"abc\"", reply.value.etag)
    }

    @Test
    fun aBadNameIsNeverSent() = withServer { server ->
        val t = HttpFileTransport(core(server))
        for (call in listOf<suspend () -> Any?>(
            { t.status(FileTarget("saves", ".."), "up_1") },
            { t.status(FileTarget("saves/x", "slot1"), "up_1") },
            { t.putPart(target, "up_1", 0, ByteArray(1), "0".repeat(64)) },
            { t.getChunk("saves", "NOTHEX") },
            { t.putChunk(target, "up_1", chunk, ByteArray(SYNC_CHUNK_MAX_STORED_BYTES + 1), "0".repeat(64)) },
            { t.putSingle(target, "up_1", ByteArray(1), "short") },
        )) {
            try {
                call()
                org.junit.Assert.fail("sent")
            } catch (e: TransferException) {
                assertEquals(Reason.REJECTED, e.reason)
            }
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun noBearerOrAnotherPersonsBearerSendsNothing() = withServer { server ->
        val none = HttpFileTransport(core(server, token = false)).status(target, "up_1") as FileReply.Refused
        assertEquals(401, none.refusal.status)
        val other = HttpFileTransport(core(server, subject = "ps_other")) { "ps_alice" }.status(target, "up_1") as FileReply.Refused
        assertEquals(401, other.refusal.status)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun beginAndFinalizeAnswersAreChecked() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"uploadId":"..","mode":"single","expiresAt":1}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"uploadId":"up_1","mode":"single","expiresAt":1700086400000}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"version":1,"size":5,"sha256":"x","format":"zip"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"version":1,"size":5,"sha256":"x","format":"whole"}"""))
        val t = HttpFileTransport(core(server))
        val req = JsonObject(emptyMap())
        assertEquals("bad_response", (t.begin(target, req) as FileReply.Refused).refusal.code)
        assertTrue(t.begin(target, req) is FileReply.Ok)
        assertEquals("bad_response", (t.finalize(target, req) as FileReply.Refused).refusal.code)
        assertTrue(t.finalize(target, req) is FileReply.Ok)
    }
}
