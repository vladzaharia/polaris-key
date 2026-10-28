// A `java.net.Socket` as a [PeerPipe] (CC-12.11). Blocking reads and writes run on `Dispatchers.IO`;
// closing the socket ends a blocked read with an `IOException`, which [im.plrs.key.core.peer.PeerLink]
// treats as the end of the stream. Only the standard library, so it runs on Android API 24.

package im.plrs.key.core.peer.lan

import im.plrs.key.core.peer.PeerPipe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

private const val READ_CHUNK = 65_536

/** One TCP connection. */
public class TcpPipe(private val socket: Socket) : PeerPipe {
    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()
    private val buf = ByteArray(READ_CHUNK)

    init {
        socket.tcpNoDelay = true
    }

    override val remoteAddress: String get() = socket.inetAddress?.hostAddress.orEmpty()

    /** The address of the connected peer as the kernel reports it (the path check of G6). */
    public val connectedAddress: String get() = remoteAddress

    override suspend fun read(): ByteArray? = withContext(Dispatchers.IO) {
        val n = input.read(buf)
        if (n < 0) null else buf.copyOf(n)
    }

    override suspend fun write(bytes: ByteArray) {
        withContext(Dispatchers.IO) {
            output.write(bytes)
            output.flush()
        }
    }

    override fun close() {
        try {
            socket.close()
        } catch (e: IOException) {
            // already closed
        }
    }

    override fun toString(): String = "TcpPipe"

    public companion object {
        /** Connect to [host]:[port], or throw [IOException] after [timeoutMillis]. */
        public suspend fun connect(host: String, port: Int, timeoutMillis: Int): TcpPipe = withContext(Dispatchers.IO) {
            val s = Socket()
            try {
                s.connect(InetSocketAddress(host, port), timeoutMillis)
            } catch (e: IOException) {
                s.close()
                throw e
            }
            TcpPipe(s)
        }
    }
}
