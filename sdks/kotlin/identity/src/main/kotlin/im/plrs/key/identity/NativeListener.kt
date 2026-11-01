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

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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

/** The listener over a `ServerSocket` bound to `127.0.0.1` (exclusive: no other socket shares the port while this one holds it). */
public class LoopbackListener @JvmOverloads public constructor(
    private val lifetimeMillis: Long = NativeRedirect.PUSHED_REQUEST_TTL_SECONDS * 1000,
) : NativeLoopbackListener {
    private val server = ServerSocket().also {
        it.reuseAddress = false
        it.bind(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), 0), BACKLOG)
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
        synchronized(lock) {
            if (shut.get() || started) return
            started = true
            this.accept = accept
        }
        val deadline = System.nanoTime() + lifetimeMillis * 1_000_000
        Thread({ serve(deadline) }, "pkey-native-redirect").also { it.isDaemon = true }.start()
    }

    private fun serve(deadline: Long) {
        try {
            while (!shut.get() && System.nanoTime() < deadline) {
                val socket = try {
                    server.accept()
                } catch (e: SocketTimeoutException) {
                    continue
                }
                // At most MAX_CONNECTIONS at once; the extras are closed unanswered.
                if (!slots.tryAcquire()) {
                    try {
                        socket.close()
                    } catch (e: java.io.IOException) {
                        // Already gone.
                    }
                    continue
                }
                try {
                    Thread({ handle(socket) }, "pkey-native-redirect-conn").also { it.isDaemon = true }.start()
                } catch (e: Throwable) {
                    slots.release()
                    socket.close()
                }
            }
        } catch (e: Throwable) {
            // The socket was closed under accept(), or anything else: nothing is printed.
        } finally {
            close()
        }
    }

    private fun handle(socket: Socket) {
        try {
            socket.use {
                it.soTimeout = CONNECTION_MILLIS
                val request = readHead(it) ?: return@use answer(it, 404, null)
                val lines = request.split("\r\n")
                val parts = lines[0].split(' ')
                val target = if (parts.size == 3 && parts[0] == "GET" && parts[2].startsWith("HTTP/1.")) parts[1] else null
                val hosts = lines.drop(1).filter { l -> l.startsWith("Host:", ignoreCase = true) }.map { l -> l.substring(5).trim() }
                if (target == null || !target.startsWith("/") || target.substringBefore('?') != NativeRedirect.PATH ||
                    hosts.size != 1 || hosts[0].lowercase() != host
                ) {
                    return@use answer(it, 404, null)
                }
                val reply = take(target)
                answer(it, if (reply.location != null) 303 else 404, reply.location)
                if (reply.final) close()
            }
        } catch (e: Throwable) {
            // A client that went away, or anything else; nothing request-derived is reported or printed.
        } finally {
            slots.release()
        }
    }

    /** One request at the callback path. The first accepted one wins; every later one is a 404. */
    private fun take(target: String): NativeListenerReply {
        val callback = synchronized(lock) {
            if (done || shut.get()) return NativeListenerReply(null, false)
            accept
        } ?: return NativeListenerReply(null, false)
        val reply = callback("http://$host$target")
        if (reply.final) {
            synchronized(lock) {
                if (done) return NativeListenerReply(null, false)
                done = true
            }
        }
        return reply
    }

    private fun readHead(socket: Socket): String? {
        val out = ByteArrayOutputStream()
        val input = socket.getInputStream()
        var tail = 0
        val deadline = System.nanoTime() + CONNECTION_MILLIS * 1_000_000L
        while (out.size() < MAX_HEAD) {
            // One wall-clock budget for the whole head, not per read.
            val left = (deadline - System.nanoTime()) / 1_000_000L
            if (left <= 0) return null
            socket.soTimeout = left.toInt()
            val b = input.read()
            if (b < 0) return null
            out.write(b)
            tail = if ((tail % 2 == 0 && b == '\r'.code) || (tail % 2 == 1 && b == '\n'.code)) tail + 1 else if (b == '\r'.code) 1 else 0
            if (tail == 4) return out.toString(Charsets.ISO_8859_1.name())
        }
        return null
    }

    private fun answer(socket: Socket, status: Int, location: String?) {
        val head = StringBuilder("HTTP/1.1 $status ${if (status == 303) "See Other" else "Not Found"}\r\n")
        if (location != null) head.append("Location: ").append(location).append("\r\n")
        head.append("Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        socket.getOutputStream().apply {
            write(head.toString().toByteArray(Charsets.ISO_8859_1))
            flush()
        }
    }

    override fun close() {
        if (!shut.compareAndSet(false, true)) return
        try {
            server.close()
        } catch (e: java.io.IOException) {
            // Already gone.
        }
    }

    private companion object {
        const val BACKLOG = 8
        const val POLL_MILLIS = 250
        const val CONNECTION_MILLIS = 5000
        const val MAX_HEAD = 16 * 1024
        const val MAX_CONNECTIONS = 8
    }
}

/** SIGN-IN D-68: whether this host can open a browser for a loopback listener. */
internal object NativeHost {
    /** `SSH_CONNECTION` or `SSH_TTY`, `CI`, or on Linux no `DISPLAY` and no `WAYLAND_DISPLAY`. */
    fun isHeadless(env: Map<String, String> = System.getenv(), os: String = System.getProperty("os.name").orEmpty()): Boolean =
        !env["SSH_CONNECTION"].isNullOrEmpty() || !env["SSH_TTY"].isNullOrEmpty() || !env["CI"].isNullOrEmpty() ||
            (os.lowercase().contains("linux") && env["DISPLAY"].isNullOrEmpty() && env["WAYLAND_DISPLAY"].isNullOrEmpty())
}

/** The desktop's default browser through `java.awt.Desktop`; `false` where there is none (a headless JVM, Android). */
internal object DesktopBrowser : AccountOpener {
    fun available(): Boolean = try {
        !java.awt.GraphicsEnvironment.isHeadless() && java.awt.Desktop.isDesktopSupported() &&
            java.awt.Desktop.getDesktop().isSupported(java.awt.Desktop.Action.BROWSE)
    } catch (e: Throwable) {
        false
    }

    override suspend fun open(url: String): Boolean = withContext(Dispatchers.IO) {
        try {
            if (!available()) {
                false
            } else {
                java.awt.Desktop.getDesktop().browse(java.net.URI(url))
                true
            }
        } catch (e: Throwable) {
            false
        }
    }
}
