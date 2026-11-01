package im.plrs.key.godot

import android.content.Context
import android.content.pm.ApplicationInfo
import im.plrs.key.platform.transfer.SyncSpool
import im.plrs.key.platform.transfer.SyncTransfers
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The bulk-body channel of the Godot plugin (U-41.6a, D-5): sealed PUT bodies and GET answers move natively, under a
 * system-scheduled job, while GDScript keeps the engine, the journal and every JSON call. `byte[]` in, `byte[]` out,
 * as [CryptoCommands]: a reply is a status byte, then the result. Each op's header is UTF-8 JSON of at most
 * [HEADER_MAX] bytes; a body travels as bytes next to it, never inside it.
 *
 * Bearer (D-9). A request's `Authorization` value arrives inside that request's header and lives in memory in the
 * queued [BulkRequest] until the request ends. It is never put in an event, a file, a log, WorkManager data or job
 * extras; the scheduler stores the transfer id and the owner tag only.
 *
 * Every bound is checked here, at the plugin boundary, whatever GDScript already checked: https and the origin pinned
 * at [open] (loopback http only for a debuggable app or a test), the anchored `/<product>/sync/files/...` shapes with
 * `version=<digits>` the only query, the method, the header allow-list, a body of at most [BODY_MAX], no redirect.
 * Nothing is logged and no reply carries a header value.
 */
class BulkCommands(
    private val c: Commands,
    /** Loopback http for a test; null (the plugin) means only a debuggable app, which is how the emulator proof runs. */
    private val loopbackHttp: Boolean? = null,
    /** How long a transfer's run waits for another request before it ends (the transfer runs again on the next enqueue). */
    internal val idleMillis: Long = IDLE_MILLIS,
) {
    private val allowLoopbackHttp: Boolean by lazy { loopbackHttp ?: isDebuggable(c.host.appContext) }
    private val lock = Any()
    private var session: Session? = null
    private val random = SecureRandom()

    internal class Session(val product: String, val origin: String, val owner: String) {
        val transfers = HashMap<String, BulkTransfer>()
        val responses = HashMap<Int, File>()
    }

    internal fun session(): Session? = synchronized(lock) { session }

    internal fun transfer(owner: String, id: String): BulkTransfer? = synchronized(lock) { session?.takeIf { it.owner == owner }?.transfers?.get(id) }

    /** A transfer that ended and drained leaves the session; its answers stay until taken. */
    internal fun retire(owner: String, t: BulkTransfer) {
        synchronized(lock) { session?.takeIf { it.owner == owner }?.transfers?.remove(t.id, t) }
    }

    internal fun context(): Context = c.host.appContext

    // ── ops ──────────────────────────────────────────────────────────────────────────────────

    /** `{product, origin, subject, keep: [64-hex...]}`: pin the origin, set the owner, reconcile the spool. */
    fun open(header: ByteArray?): ByteArray = guarded {
        val q = parse(header, setOf("product", "origin", "subject", "keep")) ?: return@guarded status(BAD_INPUT)
        val product = q.optString("product")
        val subject = q.optString("subject")
        val origin = pinnedOrigin(q.optString("origin")) ?: return@guarded status(REFUSED)
        if (!PRODUCT.matches(product) || product == "." || product == ".." || subject.isEmpty() || subject.length > SUBJECT_MAX) {
            return@guarded status(BAD_INPUT)
        }
        val keep = q.optJSONArray("keep") ?: JSONArray()
        val keepIds = HashSet<String>()
        for (i in 0 until minOf(keep.length(), KEEP_MAX)) {
            val id = keep.optString(i)
            if (!TRANSFER_ID.matches(id)) return@guarded status(BAD_INPUT)
            keepIds += id
        }
        val owner = sha256Hex(subject)
        // Another person on this device: the previous session closes completely first.
        val previous = synchronized(lock) { if (session?.owner != owner) detachLocked() else null }
        previous?.let { release(it) }
        synchronized(lock) {
            val s = session ?: Session(product, origin, owner).also { session = it }
            if (s.product != product || s.origin != origin) return@guarded status(REFUSED)
            reconcile(s, keepIds)
        }
        status(OK)
    }

    /** `{transfer, file?}` + a piece of at most [PIECE_MAX]: append to the transfer's spool file; the reply names it. */
    fun stage(header: ByteArray?, piece: ByteArray?): ByteArray = guarded {
        val q = parse(header, setOf("transfer", "file")) ?: return@guarded status(BAD_INPUT)
        if (piece == null || piece.size > PIECE_MAX) return@guarded status(BAD_INPUT)
        val s = session() ?: return@guarded status(REFUSED)
        val id = q.optString("transfer")
        if (!TRANSFER_ID.matches(id)) return@guarded status(BAD_INPUT)
        val dir = transferDir(s, id)
        val name = if (q.has("file")) q.optString("file") else freshName()
        if (!SPOOL_NAME.matches(name)) return@guarded status(BAD_INPUT)
        val file = File(dir, "$name.bin")
        if (q.has("file") && !file.isFile) return@guarded status(REFUSED)
        if (file.length() + piece.size > BODY_MAX) return@guarded status(BAD_INPUT)
        try {
            file.appendBytes(piece)
        } catch (e: IOException) {
            return@guarded status(REFUSED)
        }
        ok(JSONObject().put("file", name).put("size", file.length()).toString().toByteArray(Charsets.UTF_8))
    }

    /** `{transfer, req, path, headers, file, max_body, user_initiated?}`: queue a PUT whose body is a staged file. */
    fun put(header: ByteArray?): ByteArray = enqueue(header, "PUT")

    /** `{transfer, req, path, headers, max_body, user_initiated?}`: queue a GET; the answer waits for [take]. */
    fun get(header: ByteArray?): ByteArray = enqueue(header, "GET")

    /** `{req}`: the answer body of a finished request, once. */
    fun take(header: ByteArray?): ByteArray = guarded {
        val q = parse(header, setOf("req")) ?: return@guarded status(BAD_INPUT)
        val req = q.optInt("req", -1)
        val s = session() ?: return@guarded status(REFUSED)
        val file = synchronized(lock) { s.responses.remove(req) } ?: return@guarded status(REFUSED)
        try {
            ok(file.readBytes())
        } catch (e: IOException) {
            status(REFUSED)
        } finally {
            file.delete()
        }
    }

    /** `{transfer}` or `{transfer, req}`: cancel is final; no event follows it. */
    fun cancel(header: ByteArray?): ByteArray = guarded {
        val q = parse(header, setOf("transfer", "req")) ?: return@guarded status(BAD_INPUT)
        val id = q.optString("transfer")
        if (!TRANSFER_ID.matches(id)) return@guarded status(BAD_INPUT)
        val s = session() ?: return@guarded status(REFUSED)
        if (q.has("req")) {
            val t = synchronized(lock) { s.transfers[id] } ?: return@guarded status(REFUSED)
            t.cancelRequest(q.optInt("req", -1))
        } else {
            val t = synchronized(lock) { s.transfers.remove(id) }
            t?.cancelAll()
            SyncTransfers.cancel(c.host.appContext, id)
            transferDir(s, id).deleteRecursively()
        }
        status(OK)
    }

    /** `{transfer}`: no more requests. The run ends when the queue is empty. */
    fun end(header: ByteArray?): ByteArray = guarded {
        val q = parse(header, setOf("transfer")) ?: return@guarded status(BAD_INPUT)
        val id = q.optString("transfer")
        val s = session() ?: return@guarded status(REFUSED)
        val t = synchronized(lock) { s.transfers[id] } ?: return@guarded status(REFUSED)
        t.end()
        status(OK)
    }

    /**
     * Sign-out and close, in the order the SDK needs: every request stops and no event follows, then the owner's
     * scheduled work and jobs go, then the spool. Call off Android's main thread (GDScript's call thread is one).
     */
    fun close(): ByteArray = guarded {
        synchronized(lock) { detachLocked() }?.let { release(it) }
        status(OK)
    }

    /** The plugin is going away: the same as [close], without a reply. */
    fun shutdown() {
        synchronized(lock) { detachLocked() }?.let { release(it) }
    }

    // ── what the run uses ────────────────────────────────────────────────────────────────────

    internal fun emitDone(t: BulkTransfer, r: BulkRequest, status: Int, headers: JSONObject, bodyFile: File?) {
        val s: Session
        synchronized(lock) {
            s = session ?: return
            if (t.cancelled || r.cancelled) {
                bodyFile?.delete()
                return
            }
            if (bodyFile != null) s.responses[r.req] = bodyFile
        }
        c.queue.push(
            JSONObject().put("ev", "sb_done").put("transfer", t.id).put("req", r.req).put("status", status).put("headers", headers)
                .put("body_len", bodyFile?.length() ?: 0L),
        )
    }

    internal fun emitFail(t: BulkTransfer, r: BulkRequest, reason: String) {
        synchronized(lock) { if (t.cancelled || r.cancelled || session == null) return }
        c.queue.push(JSONObject().put("ev", "sb_fail").put("transfer", t.id).put("req", r.req).put("reason", reason))
    }

    internal fun responseFile(t: BulkTransfer): File = File(t.dir, "r-${freshName()}.bin")

    // ── internals ────────────────────────────────────────────────────────────────────────────

    private fun enqueue(header: ByteArray?, method: String): ByteArray = guarded {
        val allowed = setOf("transfer", "req", "path", "headers", "max_body", "user_initiated") + if (method == "PUT") setOf("file") else emptySet()
        val q = parse(header, allowed) ?: return@guarded status(BAD_INPUT)
        val s = session() ?: return@guarded status(REFUSED)
        val id = q.optString("transfer")
        val reqId = q.optInt("req", -1)
        val path = q.optString("path")
        val maxBody = q.optLong("max_body", -1)
        if (!TRANSFER_ID.matches(id) || reqId < 1 || maxBody < 0 || maxBody > BODY_MAX) return@guarded status(BAD_INPUT)
        if (!pathAllowed(s.product, method, path)) return@guarded status(REFUSED)
        val headers = requestHeaders(q.optJSONObject("headers") ?: JSONObject()) ?: return@guarded status(REFUSED)
        val dir = transferDir(s, id)
        var body: File? = null
        if (method == "PUT") {
            val name = q.optString("file")
            if (!SPOOL_NAME.matches(name)) return@guarded status(BAD_INPUT)
            body = File(dir, "$name.bin").takeIf { it.isFile } ?: return@guarded status(REFUSED)
        }
        val owner = s.owner
        var schedule = false
        synchronized(lock) {
            if (session !== s) return@guarded status(REFUSED)
            if (s.transfers.size >= TRANSFERS_MAX && !s.transfers.containsKey(id)) return@guarded status(REFUSED)
            val t = s.transfers.getOrPut(id) { BulkTransfer(id, dir) }
            if (t.ended || t.cancelled) return@guarded status(REFUSED)
            val added = t.add(BulkRequest(reqId, method, s.origin + path, headers, body, maxBody), REQUESTS_MAX)
            if (!added) return@guarded status(REFUSED)
            schedule = t.markScheduled()
        }
        if (schedule) {
            try {
                SyncTransfers.enqueue(c.host.appContext, id, owner, q.optBoolean("user_initiated", false))
            } catch (e: IllegalArgumentException) {
                return@guarded status(BAD_INPUT)
            }
        }
        status(OK)
    }

    /** Stop every request of the session and forget it; no event follows. */
    private fun detachLocked(): Session? {
        val s = session ?: return null
        session = null
        for (t in s.transfers.values) t.cancelAll()
        s.transfers.clear()
        s.responses.clear()
        return s
    }

    /**
     * The scheduler's side of a close, outside the lock: a stopping run may still be on its way out, and
     * `cancelOwner` waits for it. The owner's scheduled work, then the spooled files.
     */
    private fun release(s: Session) {
        SyncTransfers.cancelOwner(c.host.appContext, s.owner)
    }

    private fun reconcile(s: Session, keep: Set<String>) {
        val root = SyncSpool.dir(c.host.appContext, s.owner)
        val live = HashSet<File>()
        for (t in s.transfers.values) live += t.referencedFiles()
        live += s.responses.values
        val keepDirs = keep.map { dirName(it) }.toSet() + s.transfers.keys.map { dirName(it) }
        for (d in root.listFiles().orEmpty()) {
            if (d.name !in keepDirs) {
                d.deleteRecursively()
                continue
            }
            for (f in d.listFiles().orEmpty()) if (f !in live) f.delete()
        }
    }

    private fun transferDir(s: Session, id: String): File = File(SyncSpool.dir(c.host.appContext, s.owner), dirName(id)).also { it.mkdirs() }

    private fun dirName(id: String): String = sha256Hex(id).take(SPOOL_NAME_LEN)

    private fun freshName(): String {
        val b = ByteArray(SPOOL_NAME_LEN / 2)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    private fun pinnedOrigin(origin: String): String? {
        val u = try {
            URI(origin)
        } catch (e: java.net.URISyntaxException) {
            return null
        }
        val host = u.host ?: return null
        val plain = u.path.isNullOrEmpty() && u.rawQuery == null && u.rawFragment == null && u.rawUserInfo == null
        val loopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]"
        val schemeOk = u.scheme == "https" || (u.scheme == "http" && allowLoopbackHttp && loopback)
        return if (plain && schemeOk && origin == "${u.scheme}://${u.rawAuthority}") origin else null
    }

    /** Parse a header: bounded, a JSON object, and only [keys] in it. */
    private fun parse(header: ByteArray?, keys: Set<String>): JSONObject? {
        if (header == null || header.size > HEADER_MAX) return null
        return try {
            val q = JSONObject(String(header, Charsets.UTF_8))
            val it = q.keys()
            while (it.hasNext()) if (it.next() !in keys) return null
            q
        } catch (e: JSONException) {
            null
        }
    }

    private fun requestHeaders(o: JSONObject): Map<String, String>? {
        if (o.length() > HEADERS_MAX) return null
        val out = LinkedHashMap<String, String>()
        val names = o.keys()
        while (names.hasNext()) {
            val raw = names.next()
            val name = raw.lowercase()
            val value = o.opt(raw) as? String ?: return null
            if (!(name in REQUEST_HEADERS || name.startsWith("x-pkey-"))) return null
            if (!HEADER_NAME.matches(name) || value.length > HEADER_VALUE_MAX || value.any { it.code < 0x20 || it.code == 0x7f }) return null
            if (out.put(name, value) != null) return null
        }
        return out
    }

    private inline fun guarded(block: () -> ByteArray): ByteArray = try {
        block()
    } catch (e: SecurityException) {
        status(REFUSED)
    } catch (e: RuntimeException) {
        // Unknown fault: refuse, and say nothing about the inputs.
        status(REFUSED)
    }

    private fun ok(body: ByteArray): ByteArray {
        val out = ByteArray(body.size + 1)
        out[0] = OK
        body.copyInto(out, 1)
        return out
    }

    private fun status(b: Byte): ByteArray = byteArrayOf(b)

    companion object {
        const val OK: Byte = 1
        const val REFUSED: Byte = 0
        const val BAD_INPUT: Byte = 3

        const val HEADER_MAX = 16 * 1024
        const val PIECE_MAX = 8 * 1024 * 1024
        const val BODY_MAX = 16 * 1024 * 1024L
        const val IDLE_MILLIS = 60_000L
        private const val SUBJECT_MAX = 512
        private const val KEEP_MAX = 4096
        private const val TRANSFERS_MAX = 16
        private const val REQUESTS_MAX = 256
        private const val HEADERS_MAX = 32
        private const val HEADER_VALUE_MAX = 4096
        private const val SPOOL_NAME_LEN = 32

        private val PRODUCT = Regex("[A-Za-z0-9._-]{1,128}")
        private val SEG = "[A-Za-z0-9._:-]{1,128}"
        private val TRANSFER_ID = Regex("[0-9a-f]{64}")
        private val SPOOL_NAME = Regex("[0-9a-f]{32}")
        private val HEADER_NAME = Regex("[a-z0-9-]{1,64}")
        private val REQUEST_HEADERS = setOf("authorization", "accept", "content-type", "content-digest", "range", "if-match")
        private val QUERY = Regex("version=[0-9]{1,9}")

        /** The answer headers that leave native code; every other header is dropped. */
        val RESPONSE_HEADERS = setOf("etag", "content-range", "content-type", "content-digest", "retry-after")

        fun isDebuggable(ctx: Context): Boolean = (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

        fun sha256Hex(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

        /** Whether [pathAndQuery] is one of the product's file routes for [method] (the GDScript `is_files_path`, again). */
        fun pathAllowed(product: String, method: String, pathAndQuery: String): Boolean {
            val q = pathAndQuery.indexOf('?')
            val path = if (q < 0) pathAndQuery else pathAndQuery.substring(0, q)
            val query = if (q < 0) "" else pathAndQuery.substring(q + 1)
            if (path.split("/").any { it == "." || it == ".." }) return false
            val p = Regex.escape(product)
            val base = "/$p/sync/files/$SEG"
            val rec = "$base/$SEG"
            val upload = "$rec/upload/$SEG"
            val hex = "[0-9a-f]{64}"
            val putShapes = listOf("$upload/parts/[0-9]{1,4}", "$upload/chunks/$hex", rec, "$base/chunks/$hex")
            val getShapes = listOf(rec, "$base/chunks/$hex")
            val shapes = if (method == "PUT") putShapes else getShapes
            if (shapes.none { Regex(it).matches(path) }) return false
            // The version query belongs to the record GET only.
            return query.isEmpty() || (method == "GET" && Regex(rec).matches(path) && QUERY.matches(query))
        }
    }
}
