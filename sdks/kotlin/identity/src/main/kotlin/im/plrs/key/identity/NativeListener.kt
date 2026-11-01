// The loopback listener of a native redirect sign-in (WIRE-CONTRACT-V5 §12.12 item 6; I-15b.5) and the
// system browser of a JVM desktop. A raw `ServerSocket`, so the same JAR loads on Android (where the
// loopback class is simply never chosen).
//
// Rules: bind 127.0.0.1 only, on an OS-assigned port, BEFORE the request is pushed, and keep the socket
// until the callback; accept `GET /pkey/callback` whose `Host` is `127.0.0.1:<port>` and whose `state`
// matches; answer anything else `404` and keep listening; answer `303` to the customer host's return page
// with `Referrer-Policy: no-referrer` and `no-store`; close on the first match or after 600 s; serve no
// HTML and send no CORS headers. The request line carries the code, so nothing request-derived is logged
// or put in an error message.

package im.plrs.key.identity

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/** What a listener answers one accepted callback with: [location] to `303` to (null answers `404`), and whether [final] (close after this answer). */
public class NativeListenerReply(public val location: String?, public val final: Boolean)

/** A bound loopback listener. The socket exists from construction, so [port] is known before the request is pushed. */
public interface NativeLoopbackListener {
    public val port: Int

    /** Serve until the first accepted callback, the lifetime or [close]. [accept] gets the full callback URL. */
    public fun start(accept: (String) -> NativeListenerReply)

    /** Stop listening and release the port. Safe to call more than once, from any thread. */
    public fun close()

    public val closed: Boolean
}

/**
 * Run [block]; any [Throwable] it throws answers [fallback]. The listener and the browser opener handle requests and
 * URLs that carry a code, so nothing they hit may escape, print a stack trace or be logged.
 */
@Suppress("TooGenericExceptionCaught", "SwallowedException") // Catching Throwable is the security requirement here.
internal inline fun <T> hushed(fallback: T, block: () -> T): T = try {
    block()
} catch (e: Throwable) {
    fallback
}

private const val NANOS_PER_MILLI = 1_000_000L
private const val MILLIS_PER_SECOND = 1000L
private const val STATUS_SEE_OTHER = 303
private const val STATUS_NOT_FOUND = 404
private const val REQUEST_LINE_PARTS = 3
private const val CR = '\r'.code
private const val LF = '\n'.code
private const val HEAD_END_LENGTH = 4
private const val HOST_HEADER = "Host:"
private const val BACKLOG = 8
private const val POLL_MILLIS = 250
private const val CONNECTION_MILLIS = 5000
private const val MAX_HEAD = 16 * 1024
private const val MAX_CONNECTIONS = 8

/** The wire half of the listener: the one request line and `Host` header it accepts, the bounded head read, and the answers. */
internal object LoopbackHttp {
    /** The request target of `GET /pkey/callback...` for exactly this [host], else null. */
    fun target(head: String, host: String): String? {
        val lines = head.split("\r\n")
        return requestTarget(lines.first())?.takeIf { it.substringBefore('?') == NativeRedirect.PATH && hostHeader(lines) == host }
    }

    private fun requestTarget(line: String): String? {
        val parts = line.split(' ')
        return parts.takeIf { it.size == REQUEST_LINE_PARTS && it[0] == "GET" && it[2].startsWith("HTTP/1.") }
            ?.get(1)?.takeIf { it.startsWith("/") }
    }

    /** The one `Host` header, lower-cased; null when there are none or several. */
    private fun hostHeader(lines: List<String>): String? = lines.drop(1).filter { it.startsWith(HOST_HEADER, ignoreCase = true) }
        .map { it.substring(HOST_HEADER.length).trim().lowercase() }.singleOrNull()

    /** Read a request head (to its blank line) within one wall-clock budget; null when it is too long, slow or cut short. */
    fun readHead(socket: Socket): String? {
        val out = ByteArrayOutputStream()
        val input = socket.getInputStream()
        // One wall-clock budget for the whole head, not per read.
        val deadline = System.nanoTime() + CONNECTION_MILLIS * NANOS_PER_MILLI
        var tail = 0
        while (out.size() < MAX_HEAD && tail < HEAD_END_LENGTH) {
            val b = readByte(socket, input, deadline)
            if (b < 0) return null
            out.write(b)
            tail = advance(tail, b)
        }
        return if (tail == HEAD_END_LENGTH) out.toString(Charsets.ISO_8859_1.name()) else null
    }

    private fun readByte(socket: Socket, input: java.io.InputStream, deadline: Long): Int {
        val left = (deadline - System.nanoTime()) / NANOS_PER_MILLI
        if (left <= 0) return -1
        socket.soTimeout = left.toInt()
        return input.read()
    }

    /** How much of the `CR LF CR LF` that ends a head has been seen. */
    private fun advance(tail: Int, b: Int): Int {
        val expected = if (tail % 2 == 0) CR else LF
        return when {
            b == expected -> tail + 1
            b == CR -> 1
            else -> 0
        }
    }

    fun answer(socket: Socket, status: Int, location: String?) {
        val head = StringBuilder("HTTP/1.1 $status ${if (status == STATUS_SEE_OTHER) "See Other" else "Not Found"}\r\n")
        if (location != null) head.append("Location: ").append(location).append("\r\n")
        head.append("Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        socket.getOutputStream().apply {
            write(head.toString().toByteArray(Charsets.ISO_8859_1))
            flush()
        }
    }
}

/** The listener over a `ServerSocket` bound to `127.0.0.1` (exclusive: no other socket shares the port while this one holds it). */
public class LoopbackListener @JvmOverloads public constructor(
    private val lifetimeMillis: Long = NativeRedirect.PUSHED_REQUEST_TTL_SECONDS * MILLIS_PER_SECOND,
) : NativeLoopbackListener {
    private val server = ServerSocket().also {
        it.reuseAddress = false
        it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), BACKLOG)
        it.soTimeout = POLL_MILLIS
    }
    override val port: Int = server.localPort
    private val lock = Any()
    private var accept: ((String) -> NativeListenerReply)? = null
    private var started = false
    private var done = false
    private val shut = AtomicBoolean(false)
    private val slots = java.util.concurrent.Semaphore(MAX_CONNECTIONS)
    private val host = "127.0.0.1:$port"

    override val closed: Boolean get() = shut.get()

    override fun start(accept: (String) -> NativeListenerReply) {
        val first = synchronized(lock) {
            (!shut.get() && !started).also {
                started = true
                if (it) this.accept = accept
            }
        }
        if (first) {
            val deadline = System.nanoTime() + lifetimeMillis * NANOS_PER_MILLI
            daemon("pkey-native-redirect") { serve(deadline) }
        }
    }

    private fun daemon(name: String, body: () -> Unit) = Thread(body, name).also { it.isDaemon = true }.start()

    private fun serve(deadline: Long) {
        hushed(Unit) {
            while (!shut.get() && System.nanoTime() < deadline) {
                hushed<Socket?>(null) { server.accept() }?.let(::admit)
            }
        }
        close()
    }

    /** At most [MAX_CONNECTIONS] at once; the extras are closed unanswered. */
    private fun admit(socket: Socket) {
        val acquired = slots.tryAcquire()
        val serving = acquired && hushed(false) {
            daemon("pkey-native-redirect-conn") { handle(socket) }
            true
        }
        if (!serving) {
            if (acquired) slots.release()
            hushed(Unit) { socket.close() }
        }
    }

    private fun handle(socket: Socket) {
        hushed(Unit) { socket.use { respond(it) } }
        slots.release()
    }

    private fun respond(socket: Socket) {
        val target = LoopbackHttp.readHead(socket)?.let { LoopbackHttp.target(it, host) }
        if (target == null) {
            LoopbackHttp.answer(socket, STATUS_NOT_FOUND, null)
        } else {
            val reply = take(target)
            LoopbackHttp.answer(socket, if (reply.location != null) STATUS_SEE_OTHER else STATUS_NOT_FOUND, reply.location)
            if (reply.final) close()
        }
    }

    /** One request at the callback path. The first accepted one wins; every later one is a 404. */
    private fun take(target: String): NativeListenerReply {
        val callback = synchronized(lock) { accept.takeUnless { done || shut.get() } } ?: return REFUSED
        val reply = callback("http://$host$target")
        return if (reply.final && !claim()) REFUSED else reply
    }

    private fun claim(): Boolean = synchronized(lock) { (!done).also { done = true } }

    override fun close() {
        if (shut.compareAndSet(false, true)) hushed(Unit) { server.close() }
    }

    private companion object {
        val REFUSED = NativeListenerReply(null, false)
    }
}

/** SIGN-IN D-68: whether this host can open a browser for a loopback listener. */
internal object NativeHost {
    private val MARKERS = listOf("SSH_CONNECTION", "SSH_TTY", "CI")

    /** `SSH_CONNECTION` or `SSH_TTY`, `CI`, or on Linux no `DISPLAY` and no `WAYLAND_DISPLAY`. */
    fun isHeadless(env: Map<String, String> = System.getenv(), os: String = System.getProperty("os.name").orEmpty()): Boolean =
        MARKERS.any { !env[it].isNullOrEmpty() } || (os.contains("linux", ignoreCase = true) && !hasDisplay(env))

    private fun hasDisplay(env: Map<String, String>) = !env["DISPLAY"].isNullOrEmpty() || !env["WAYLAND_DISPLAY"].isNullOrEmpty()
}

/** The desktop's default browser through `java.awt.Desktop`; `false` where there is none (a headless JVM, Android). */
internal object DesktopBrowser : AccountOpener {
    fun available(): Boolean = hushed(false) {
        !java.awt.GraphicsEnvironment.isHeadless() && java.awt.Desktop.isDesktopSupported() &&
            java.awt.Desktop.getDesktop().isSupported(java.awt.Desktop.Action.BROWSE)
    }

    override suspend fun open(url: String): Boolean = withContext(Dispatchers.IO) {
        hushed(false) {
            val can = available()
            if (can) java.awt.Desktop.getDesktop().browse(java.net.URI(url))
            can
        }
    }
}
