package im.plrs.key.godot

import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import im.plrs.key.platform.transfer.SyncTransferOutcome
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BulkCommandsTest {
    private val host = TestHost()
    private val commands = Commands(host)
    private val ctx = host.appContext
    private val bulk = BulkCommands(commands, loopbackHttp = true, idleMillis = 150)
    private val runner = GodotBulkRunner { bulk }
    private lateinit var server: ServerSocket
    private val seen = CopyOnWriteArrayList<Triple<String, String, Map<String, String>>>()
    private val handlers = HashMap<String, (Ex) -> Unit>()
    private val bearer = "Bearer pkeyt_NOT-A-REAL-TOKEN-for-tests"
    private val subject = "person-1"
    private val owner = sha(subject)
    private val tid = "ab".repeat(32)

    private fun sha(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    private fun origin() = "http://127.0.0.1:${server.localPort}"

    @Before
    fun setUp() {
        val config = Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build()
        WorkManagerTestInitHelper.initializeTestWorkManager(ctx, config)
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val sock = try {
                    server.accept()
                } catch (e: java.io.IOException) {
                    break
                }
                Thread { serve(sock) }.start()
            }
        }.start()
    }

    private fun serve(sock: java.net.Socket) = sock.use {
        val input = java.io.BufferedInputStream(sock.getInputStream())
        fun line(): String {
            val sb = StringBuilder()
            while (true) {
                val b = input.read()
                if (b < 0 || b == '\n'.code) break
                if (b != '\r'.code) sb.append(b.toChar())
            }
            return sb.toString()
        }
        val first = line().split(" ")
        val headers = HashMap<String, String>()
        while (true) {
            val l = line()
            if (l.isEmpty()) break
            headers[l.substringBefore(":").lowercase()] = l.substringAfter(":").trim()
        }
        val body = input.readNBytes(headers["content-length"]?.toInt() ?: 0)
        val ex = Ex(first[0], first[1], headers, body)
        seen += Triple(ex.requestMethod, ex.requestURI, headers)
        val h = handlers.entries.filter { ex.requestURI.substringBefore("?").contains(it.key) }.maxByOrNull { it.key.length }?.value
        if (h != null) h(ex) else reply(ex, 200, "ok".toByteArray())
        val out = sock.getOutputStream()
        out.write(("HTTP/1.1 ${ex.code} X\r\nContent-Length: ${ex.out.size}\r\nConnection: close\r\n" + ex.outHeaders.joinToString("") { "${it.first}: ${it.second}\r\n" } + "\r\n").toByteArray())
        out.write(ex.out)
        out.flush()
    }

    private class Ex(val requestMethod: String, val requestURI: String, val headers: Map<String, String>, val requestBody: ByteArray) {
        var code = 200
        var out = ByteArray(0)
        val outHeaders = mutableListOf<Pair<String, String>>()
    }

    @After
    fun tearDown() {
        server.close()
        bulk.shutdown()
    }

    private fun reply(ex: Ex, code: Int, body: ByteArray, vararg headers: Pair<String, String>) {
        ex.code = code
        ex.out = body
        ex.outHeaders += headers
    }

    private fun j(vararg p: Pair<String, Any?>): ByteArray = JSONObject(p.toMap()).toString().toByteArray()

    private fun open(o: String = origin(), keep: List<String> = emptyList()) =
        bulk.open(j("product" to "demo", "origin" to o, "subject" to subject, "keep" to JSONArray(keep)))

    private fun stage(body: ByteArray, tr: String = tid): String {
        val r = bulk.stage(j("transfer" to tr), body)
        assertEquals(BulkCommands.OK, r[0])
        return JSONObject(String(r, 1, r.size - 1)).getString("file")
    }

    private val authHeaders get() = JSONObject(mapOf("authorization" to bearer, "content-type" to "application/octet-stream"))

    private fun put(req: Int, file: String, path: String = "/demo/sync/files/saves/slot/upload/u1/parts/1", tr: String = tid, maxBody: Long = 1024) =
        bulk.put(j("transfer" to tr, "req" to req, "path" to path, "file" to file, "max_body" to maxBody, "headers" to authHeaders))

    private fun get(req: Int, path: String = "/demo/sync/files/saves/slot", tr: String = tid, maxBody: Long = 1024) =
        bulk.get(j("transfer" to tr, "req" to req, "path" to path, "max_body" to maxBody, "headers" to JSONObject(mapOf("authorization" to bearer))))

    private fun events(): List<JSONObject> {
        val a = commands.json(JSONObject().put("op", "poll")).getJSONArray("events")
        return (0 until a.length()).map { a.getJSONObject(it) }.filter { it.optString("ev").startsWith("sb_") }
    }

    private fun run(id: String = tid, o: String = owner) = runBlocking { runner.run(id, o) }

    private fun allFiles(): List<File> = ctx.noBackupFilesDir.walkTopDown().filter { it.isFile }.toList()

    private fun workState(id: String = tid) =
        WorkManager.getInstance(ctx).getWorkInfosForUniqueWork("pkey.sync.transfer." + sha(id)).get().single().state

    // ── the round trip, and where the bearer is not ──────────────────────────────────────────

    @Test
    fun aPutAndAGetRunToTheirEndAndTheBearerStaysInTheRequest() {
        assertEquals(BulkCommands.OK, open()[0])
        handlers["/slot/upload"] = { ex -> reply(ex, 200, """{"ok":true}""".toByteArray(), "ETag" to "\"e1\"", "Set-Cookie" to "x=1", "X-Internal" to "no") }
        handlers["/saves/slot"] = { ex -> reply(ex, 200, "sealed-bytes".toByteArray(), "content-type" to "application/octet-stream") }
        val file = stage(ByteArray(300) { it.toByte() })
        assertEquals(BulkCommands.OK, put(1, file)[0])
        assertEquals(BulkCommands.OK, get(2)[0])
        assertEquals(BulkCommands.OK, bulk.end(j("transfer" to tid))[0])
        assertEquals(SyncTransferOutcome.DONE, run())
        val ev = events()
        assertEquals(listOf("sb_done", "sb_done"), ev.map { it.getString("ev") })
        assertEquals(listOf(1, 2), ev.map { it.getInt("req") })
        assertEquals(200, ev[0].getInt("status"))
        // Only allow-listed answer headers leave native code, and a body never rides an event.
        assertEquals(setOf("etag"), ev[0].getJSONObject("headers").keys().asSequence().toSet())
        assertFalse(ev.any { it.has("body") })
        assertEquals(12, ev[1].getInt("body_len"))
        val took = bulk.take(j("req" to 2))
        assertEquals(BulkCommands.OK, took[0])
        assertEquals("sealed-bytes", String(took, 1, took.size - 1))
        assertEquals(BulkCommands.REFUSED, bulk.take(j("req" to 2))[0])
        // The server saw the bearer, once per request, and it is in no event, no file and no scheduler record.
        assertEquals(listOf(bearer, bearer), seen.map { it.third["authorization"] })
        assertEquals("identity", seen[0].third["accept-encoding"])
        assertFalse(ev.toString().contains("pkeyt_"))
        assertTrue(allFiles().none { String(it.readBytes(), Charsets.ISO_8859_1).contains("pkeyt_") })
        val works = WorkManager.getInstance(ctx).getWorkInfosByTag("pkey.sync.owner." + sha(owner)).get()
        assertEquals(1, works.size)
        assertFalse(works[0].tags.any { it.contains("pkeyt_") })
    }

    @Test
    fun theUploadedBodyIsExactlyTheStagedPieces() {
        open()
        var got = ByteArray(0)
        handlers["/upload/"] = { ex ->
            got = ex.requestBody
            reply(ex, 204, ByteArray(0))
        }
        val a = ByteArray(100) { 1 }
        val b = ByteArray(50) { 2 }
        val name = stage(a)
        assertEquals(BulkCommands.OK, bulk.stage(j("transfer" to tid, "file" to name), b)[0])
        put(1, name)
        bulk.end(j("transfer" to tid))
        run()
        assertArrayEquals(a + b, got)
        assertEquals(204, events().single().getInt("status"))
        // The staged copy is gone once the request ended.
        assertTrue(allFiles().none { it.name == "$name.bin" })
    }

    @Test
    fun aSecondRequestOfATransferAddsNoSecondRun() {
        open()
        put(1, stage(ByteArray(4)))
        put(2, stage(ByteArray(4)))
        val works = WorkManager.getInstance(ctx).getWorkInfosForUniqueWork("pkey.sync.transfer." + sha(tid)).get()
        assertEquals(1, works.size)
    }

    // ── bounds and refusals ──────────────────────────────────────────────────────────────────

    @Test
    fun opsBeforeAnOpenAreRefused() {
        assertEquals(BulkCommands.REFUSED, bulk.stage(j("transfer" to tid), ByteArray(1))[0])
        assertEquals(BulkCommands.REFUSED, get(1)[0])
        assertEquals(BulkCommands.REFUSED, bulk.end(j("transfer" to tid))[0])
    }

    @Test
    fun theOriginIsPinnedAndHttpsOnly() {
        for (bad in listOf("https://user@example.com", "https://example.com/path", "https://example.com?x=1", "ftp://example.com", "http://example.com", "example.com", "https://")) {
            assertEquals(bad, BulkCommands.REFUSED, open(bad)[0])
        }
        assertEquals(BulkCommands.OK, open("https://key.example.com")[0])
        // A different origin on the open session is refused, not swapped in.
        assertEquals(BulkCommands.REFUSED, open("https://other.example.com")[0])
        // Loopback http is for tests and debuggable apps only.
        val strict = BulkCommands(commands, loopbackHttp = false)
        assertEquals(BulkCommands.REFUSED, strict.open(j("product" to "demo", "origin" to "http://127.0.0.1:8080", "subject" to subject))[0])
    }

    @Test
    fun aPathOutsideTheFileRoutesNeverGoesOut() {
        open()
        val f = stage(ByteArray(4))
        val bad = listOf(
            "/demo/sync/files/saves/slot/upload/u1/parts/1?x=1",
            "/demo/sync/files/saves%2Fx/slot",
            "/demo/sync/files/saves/../slot",
            "/demo/sync/files/saves/./slot/upload/u1/parts/1",
            "/other/sync/files/saves/slot/upload/u1/parts/1",
            "/demo/sync/files/saves/slot/begin",
            "https://evil.example.com/demo/sync/files/saves/slot/upload/u1/parts/1",
            "//evil.example.com/demo/sync/files/saves/slot/upload/u1/parts/1",
            "/demo/sync/files/saves/slot/upload/u1/parts/12345",
            "",
        )
        for (p in bad) assertEquals(p, BulkCommands.REFUSED, put(1, f, p)[0])
        assertEquals(BulkCommands.REFUSED, get(2, "/demo/sync/files/saves/slot?version=abc")[0])
        assertEquals(BulkCommands.OK, get(3, "/demo/sync/files/saves/slot?version=12")[0])
        assertEquals(BulkCommands.REFUSED, get(4, "/demo/sync/files/saves/slot/upload/u1/parts/1")[0])
        assertTrue(seen.isEmpty())
    }

    @Test
    fun headersBoundsAndShapesAreChecked() {
        open()
        val f = stage(ByteArray(4))
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage(j("transfer" to tid), ByteArray(BulkCommands.PIECE_MAX + 1))[0])
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage(ByteArray(BulkCommands.HEADER_MAX + 1) { ' '.code.toByte() }, ByteArray(1))[0])
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage(j("transfer" to "../x"), ByteArray(1))[0])
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage(j("transfer" to tid, "file" to "../../etc/passwd"), ByteArray(1))[0])
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage("not json".toByteArray(), ByteArray(1))[0])
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage(j("transfer" to tid, "extra" to 1), ByteArray(1))[0])
        assertEquals(BulkCommands.BAD_INPUT, put(1, f, maxBody = BulkCommands.BODY_MAX + 1)[0])
        assertEquals(BulkCommands.BAD_INPUT, put(0, f)[0])
        assertEquals(BulkCommands.BAD_INPUT, put(1, f, tr = "short")[0])
        assertEquals(BulkCommands.BAD_INPUT, put(1, "../" + f)[0])
        // A header the engine never sends, and one with a line break in it.
        val cookie = bulk.get(j("transfer" to tid, "req" to 1, "path" to "/demo/sync/files/saves/slot", "max_body" to 10, "headers" to JSONObject(mapOf("cookie" to "x"))))
        assertEquals(BulkCommands.REFUSED, cookie[0])
        val split = bulk.get(j("transfer" to tid, "req" to 1, "path" to "/demo/sync/files/saves/slot", "max_body" to 10, "headers" to JSONObject(mapOf("accept" to "a\r\nX: y"))))
        assertEquals(BulkCommands.REFUSED, split[0])
        // A body over the cap never stages.
        val name = stage(ByteArray(BulkCommands.PIECE_MAX))
        assertEquals(BulkCommands.OK, bulk.stage(j("transfer" to tid, "file" to name), ByteArray(BulkCommands.PIECE_MAX))[0])
        assertEquals(BulkCommands.BAD_INPUT, bulk.stage(j("transfer" to tid, "file" to name), ByteArray(1))[0])
    }

    @Test
    fun theRouteTableIsTheSharedOne() {
        val fx = JSONObject(File("../../tests/fixtures/bulk_routes.json").readText())
        val product = fx.getString("product")
        fun rows(key: String) = fx.getJSONArray(key).let { a -> (0 until a.length()).map { a.getJSONArray(it).let { r -> r.getString(0) to r.getString(1) } } }
        assertTrue(rows("allow").isNotEmpty() && rows("refuse").isNotEmpty())
        for ((m, p) in rows("allow")) assertTrue("allow $m $p", BulkCommands.pathAllowed(product, m, p))
        for ((m, p) in rows("refuse")) assertFalse("refuse $m $p", BulkCommands.pathAllowed(product, m, p))
    }

    @Test
    fun aSingleUploadPutGoesOutWithItsStagedBody() {
        open()
        val body = ByteArray(40) { it.toByte() }
        put(1, stage(body), path = "/demo/sync/files/saves/slot/upload/u1")
        bulk.end(j("transfer" to tid))
        run()
        val e = events().single()
        assertEquals("sb_done", e.getString("ev"))
        val one = seen.single()
        assertEquals("PUT", one.first)
        assertEquals("/demo/sync/files/saves/slot/upload/u1", one.second)
        assertEquals("40", one.third["content-length"])
    }

    @Test
    fun anAnswerHeaderOutsideTheListNeverLeavesNativeCode() {
        open()
        handlers["/saves/slot"] = { ex -> reply(ex, 200, "ok".toByteArray(), "X-PKey-Foo" to "1", "ETag" to "e1") }
        get(1)
        bulk.end(j("transfer" to tid))
        run()
        val h = events().single().getJSONObject("headers")
        assertEquals("e1", h.getString("etag"))
        assertFalse(h.has("x-pkey-foo"))
    }

    @Test
    fun aRequestCancelledWhileRunningRaisesNoEventAndKeepsNoAnswer() {
        open()
        val started = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        handlers["/saves/slot"] = { ex ->
            started.countDown()
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            reply(ex, 200, "late".toByteArray())
        }
        get(1)
        bulk.end(j("transfer" to tid))
        val runner = Thread { run() }
        runner.start()
        assertTrue(started.await(10, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(BulkCommands.OK, bulk.cancel(j("transfer" to tid, "req" to 1))[0])
        release.countDown()
        runner.join(15_000)
        assertTrue(events().isEmpty())
        assertTrue(allFiles().none { it.name.startsWith("r-") })
    }

    // ── what the server can do to us ─────────────────────────────────────────────────────────

    @Test
    fun aRedirectIsRefusedAndNeverFollowed() {
        open()
        handlers["/saves/slot"] = { ex -> reply(ex, 302, ByteArray(0), "Location" to "${origin()}/elsewhere") }
        get(1)
        bulk.end(j("transfer" to tid))
        run()
        val e = events().single()
        assertEquals("sb_fail", e.getString("ev"))
        assertEquals("redirect", e.getString("reason"))
        assertEquals(1, seen.size)
        assertFalse(e.toString().contains("elsewhere"))
    }

    @Test
    fun anAnswerOverTheBoundIsRefusedWithoutBeingKept() {
        open()
        handlers["/saves/slot"] = { ex -> reply(ex, 200, ByteArray(100)) }
        get(1, maxBody = 10)
        bulk.end(j("transfer" to tid))
        run()
        assertEquals("oversize", events().single().getString("reason"))
        assertEquals(BulkCommands.REFUSED, bulk.take(j("req" to 1))[0])
        assertTrue(allFiles().none { it.name.startsWith("r-") })
    }

    @Test
    fun anErrorAnswerIsADoneWithItsStatus() {
        open()
        handlers["/saves/slot"] = { ex -> reply(ex, 401, """{"error":"auth"}""".toByteArray(), "Retry-After" to "5") }
        get(1)
        bulk.end(j("transfer" to tid))
        run()
        val e = events().single()
        assertEquals("sb_done", e.getString("ev"))
        assertEquals(401, e.getInt("status"))
        assertEquals("5", e.getJSONObject("headers").getString("retry-after"))
    }

    // ── cancel, close, ownership ─────────────────────────────────────────────────────────────

    @Test
    fun aCancelledRequestIsFinalAndRaisesNoEvent() {
        open()
        get(1)
        get(2)
        assertEquals(BulkCommands.OK, bulk.cancel(j("transfer" to tid, "req" to 1))[0])
        bulk.end(j("transfer" to tid))
        run()
        assertEquals(listOf(2), events().map { it.getInt("req") })
        assertEquals(1, seen.size)
    }

    @Test
    fun aCancelledTransferStopsAndLeavesNothing() {
        open()
        put(1, stage(ByteArray(8)))
        assertEquals(BulkCommands.OK, bulk.cancel(j("transfer" to tid))[0])
        assertEquals(SyncTransferOutcome.STOP, run())
        assertTrue(events().isEmpty())
        assertTrue(seen.isEmpty())
        assertEquals(WorkInfo.State.CANCELLED, workState())
        assertTrue(allFiles().isEmpty())
    }

    @Test
    fun closeStopsTheOwnersWorkAndSpoolAndAfterItNothingArrives() {
        open()
        put(1, stage(ByteArray(8)))
        assertEquals(BulkCommands.OK, bulk.close()[0])
        assertEquals(WorkInfo.State.CANCELLED, workState())
        assertTrue(allFiles().isEmpty())
        // A late run finds no transfer; a late op finds no session.
        assertEquals(SyncTransferOutcome.STOP, run())
        assertEquals(BulkCommands.REFUSED, get(2)[0])
        assertTrue(events().isEmpty())
        assertTrue(seen.isEmpty())
    }

    @Test
    fun anotherPersonsRunIsStopped() {
        open()
        get(1)
        assertEquals(SyncTransferOutcome.STOP, run(o = sha("someone-else")))
        assertEquals(SyncTransferOutcome.STOP, run(id = "cd".repeat(32)))
        assertTrue(seen.isEmpty())
    }

    @Test
    fun anotherSubjectOpenClosesThePreviousSession() {
        open()
        put(1, stage(ByteArray(8)))
        val r = bulk.open(j("product" to "demo", "origin" to origin(), "subject" to "person-2"))
        assertEquals(BulkCommands.OK, r[0])
        assertEquals(SyncTransferOutcome.STOP, run())
        assertEquals(WorkInfo.State.CANCELLED, workState())
    }

    @Test
    fun anIdleTransferEndsAndRunsAgainOnTheNextRequest() {
        open()
        get(1)
        assertEquals(SyncTransferOutcome.DONE, run())
        assertEquals(1, events().size)
        assertEquals(BulkCommands.OK, get(2)[0])
        assertEquals(SyncTransferOutcome.DONE, run())
        assertEquals(listOf(2), events().map { it.getInt("req") })
    }

    @Test
    fun theOpenReconcileKeepsOnlyWhatIsReferenced() {
        open()
        val orphan = stage(ByteArray(8), tr = "cd".repeat(32))
        val kept = stage(ByteArray(8))
        put(1, kept)
        open(keep = listOf(tid))
        val names = allFiles().map { it.name }
        assertTrue("$kept.bin" in names)
        assertFalse("$orphan.bin" in names)
    }

    @Test
    fun noBulkChannelMeansStop() {
        val none = GodotBulkRunner { null }
        assertEquals(SyncTransferOutcome.STOP, runBlocking { none.run(tid, owner) })
        assertNull(bulk.session())
    }
}
