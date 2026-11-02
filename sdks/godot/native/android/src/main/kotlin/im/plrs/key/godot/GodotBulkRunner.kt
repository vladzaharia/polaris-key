package im.plrs.key.godot

import im.plrs.key.platform.transfer.SyncTransferOutcome
import im.plrs.key.platform.transfer.SyncTransferRunner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/** One queued request. [headers] holds the bearer while the request waits; it is emptied when the request ends. */
internal class BulkRequest(
    val req: Int,
    val method: String,
    val url: String,
    headers: Map<String, String>,
    val body: File?,
    val maxBody: Long,
) {
    @Volatile var headers: Map<String, String> = headers

    @Volatile var cancelled: Boolean = false

    @Volatile var connection: HttpURLConnection? = null

    /** Drop everything credential-bearing and the staged body. */
    fun release() {
        headers = emptyMap()
        body?.delete()
    }
}

/** The requests of one transfer, in order, and the state of the run that serves them. */
internal class BulkTransfer(val id: String, val dir: File) {
    private val queue = LinkedBlockingDeque<BulkRequest>()
    private val inflight = HashSet<BulkRequest>()

    @Volatile var cancelled: Boolean = false
        private set

    @Volatile var ended: Boolean = false
        private set

    private var scheduled = false

    private val wake = Any()

    /** Queue [r] unless there are [max] waiting. */
    fun add(r: BulkRequest, max: Int): Boolean {
        val added = synchronized(this) {
            (queue.size + inflight.size < max).also { if (it) queue.addLast(r) }
        }
        if (added) signal()
        return added
    }

    /** True when the caller must schedule a run (none is queued or running). */
    @Synchronized
    fun markScheduled(): Boolean = (!scheduled).also { scheduled = true }

    fun end() {
        synchronized(this) { ended = true }
        signal()
    }

    @Synchronized
    fun referencedFiles(): List<File> = (queue + inflight).mapNotNull { it.body }

    fun cancelRequest(req: Int) {
        val hit = synchronized(this) {
            (queue + inflight).firstOrNull { it.req == req }?.also {
                it.cancelled = true
                queue.remove(it)
            }
        }
        hit?.connection?.disconnect()
        hit?.release()
    }

    fun cancelAll() {
        val all = synchronized(this) {
            cancelled = true
            (queue + inflight).toList().also { queue.clear() }
        }
        signal()
        for (r in all) {
            r.cancelled = true
            r.connection?.disconnect()
            r.release()
        }
    }

    /** The next request, or null when the transfer has ended and drained, was cancelled, or sat idle for [idle] ms. */
    suspend fun next(idle: Long): BulkRequest? {
        while (true) {
            val r = synchronized(this) {
                if (cancelled) return null
                queue.pollFirst()?.also { inflight += it }
            }
            if (r != null) return r
            // Re-check under the lock: a request that arrives as the run gives up must schedule a new run.
            synchronized(this) {
                if (ended && queue.isEmpty()) return null
            }
            val waited = runInterruptible(Dispatchers.IO) { pollWait(idle) }
            if (!waited) {
                synchronized(this) {
                    if (queue.isEmpty()) {
                        scheduled = false
                        return null
                    }
                }
            }
        }
    }

    // Blocks until a request is queued, the transfer ends or is cancelled, or [idle] ms pass. True if woken.
    private fun pollWait(idle: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(idle)
        synchronized(wake) {
            while (true) {
                if (synchronized(this) { queue.isNotEmpty() || ended || cancelled }) return true
                val left = deadline - System.nanoTime()
                if (left <= 0) return false
                TimeUnit.NANOSECONDS.timedWait(wake, left)
            }
        }
    }

    /** Wake a waiting run (a request was added, or the transfer ended or was cancelled). */
    fun signal() {
        synchronized(wake) { (wake as java.lang.Object).notifyAll() }
    }

    @Synchronized
    fun finished(r: BulkRequest) {
        inflight -= r
    }

    /** The system stopped the run mid-request: the request goes back to the head of the queue. */
    @Synchronized
    fun requeue(r: BulkRequest) {
        inflight -= r
        if (!cancelled && !r.cancelled) queue.addFirst(r)
    }

}

/**
 * Runs a transfer's queued requests over `HttpURLConnection` under the job the platform scheduled (U-41.6a). The
 * runner looks the transfer up in [BulkCommands]; none, another person's, or a cancelled one is
 * [SyncTransferOutcome.STOP]. It ends [SyncTransferOutcome.DONE] after `sbEnd` and a drained queue, or after the idle
 * time with nothing queued. A system stop requeues the request in flight and rethrows, so the platform decides
 * whether the work runs again.
 */
class GodotBulkRunner(private val bulk: () -> BulkCommands?) : SyncTransferRunner {
    override suspend fun run(transferId: String, owner: String): SyncTransferOutcome {
        val cmds = bulk() ?: return SyncTransferOutcome.STOP
        val t = cmds.transfer(owner, transferId) ?: return SyncTransferOutcome.STOP
        while (true) {
            val r = t.next(cmds.idleMillis) ?: return finish(cmds, owner, t)
            try {
                exchange(cmds, t, r)
            } catch (e: CancellationException) {
                r.connection?.disconnect()
                t.requeue(r)
                throw e
            }
            t.finished(r)
            r.release()
        }
    }

    private fun finish(cmds: BulkCommands, owner: String, t: BulkTransfer): SyncTransferOutcome {
        if (t.cancelled) return SyncTransferOutcome.STOP
        if (t.ended) cmds.retire(owner, t)
        return SyncTransferOutcome.DONE
    }

    private suspend fun exchange(cmds: BulkCommands, t: BulkTransfer, r: BulkRequest) {
        val job = coroutineContext[Job]
        val handle = job?.invokeOnCompletion { if (it != null) r.connection?.disconnect() }
        try {
            withContext(Dispatchers.IO) { runExchange(cmds, t, r) { job?.isActive == false } }
        } finally {
            handle?.dispose()
        }
    }

    private fun runExchange(cmds: BulkCommands, t: BulkTransfer, r: BulkRequest, stopped: () -> Boolean) {
        if (r.cancelled || t.cancelled) return
        val conn = try {
            URL(r.url).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            cmds.emitFail(t, r, "network")
            return
        }
        r.connection = conn
        var out: File? = null
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = CONNECT_MS
            conn.readTimeout = READ_MS
            conn.requestMethod = r.method
            conn.useCaches = false
            // The server's bytes as they are: no transparent gzip, which also breaks Range.
            conn.setRequestProperty("Accept-Encoding", "identity")
            for ((k, v) in r.headers) conn.setRequestProperty(k, v)
            if (r.method == "PUT") {
                val body = r.body ?: return cmds.emitFail(t, r, "network")
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.length())
                body.inputStream().use { input -> conn.outputStream.use { input.copyTo(it, COPY_BUFFER) } }
            }
            val status = conn.responseCode
            if (status in REDIRECT_MIN..REDIRECT_MAX) return cmds.emitFail(t, r, "redirect")
            val stream = (if (status >= HTTP_ERROR) conn.errorStream else conn.inputStream)
            out = cmds.responseFile(t)
            val size = if (stream == null) 0L else bounded(stream, out, r.maxBody)
            if (size < 0) {
                out.delete()
                return cmds.emitFail(t, r, "oversize")
            }
            val headers = JSONObject()
            for ((name, values) in conn.headerFields) {
                val key = name?.lowercase() ?: continue
                if (key in BulkCommands.RESPONSE_HEADERS && values.isNotEmpty()) headers.put(key, values.last().take(HEADER_OUT_MAX))
            }
            cmds.emitDone(t, r, status, headers, out)
            out = null
        } catch (e: IOException) {
            if (!r.cancelled && !t.cancelled && !stopped()) cmds.emitFail(t, r, if (e is java.net.SocketTimeoutException) "timeout" else "network")
        } finally {
            out?.delete()
            conn.disconnect()
            r.connection = null
        }
    }

    /** Copies at most [max] bytes into [to]; returns the count, or -1 when the stream holds more. */
    private fun bounded(from: java.io.InputStream, to: File, max: Long): Long {
        var total = 0L
        val buf = ByteArray(COPY_BUFFER)
        from.use { input ->
            to.outputStream().use { out ->
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > max) return -1
                    out.write(buf, 0, n)
                }
            }
        }
        return total
    }

    private companion object {
        const val CONNECT_MS = 15_000
        const val READ_MS = 60_000
        const val COPY_BUFFER = 64 * 1024
        const val REDIRECT_MIN = 300
        const val REDIRECT_MAX = 399
        const val HTTP_ERROR = 400
        const val HEADER_OUT_MAX = 1024
    }
}
