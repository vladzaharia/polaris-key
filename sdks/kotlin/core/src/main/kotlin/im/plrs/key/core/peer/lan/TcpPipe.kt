// A `java.net.Socket` as a [PeerPipe] (CC-12.11, CC-IPV6.5b). An address is always a literal, judged by
// [lanVerdict] before it is dialled and again on the connected socket. Blocking reads and writes run on `Dispatchers.IO`;
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

    /** The peer's address as canonical text (a link-local IPv6 address keeps its zone). */
    override val remoteAddress: String get() = literalOfInetAddress(socket.inetAddress)

    /** The address of the connected peer as the kernel reports it (the path check of G6). */
    public val connectedAddress: String get() = remoteAddress

    /** This end's own address as canonical text: the on-link test of a global or ULA IPv6 peer needs it. */
    public val localAddress: String get() = literalOfInetAddress(socket.localAddress)

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
        /**
         * Connect to the literal address [host] (dotted IPv4, or IPv6 with an optional zone) and [port], or throw
         * [IOException] after [timeoutMillis]. A name is not an address: nothing is resolved.
         */
        public suspend fun connect(host: String, port: Int, timeoutMillis: Int): TcpPipe = withContext(Dispatchers.IO) {
            val address = inetAddressOfLiteral(host) ?: throw IOException("not an address")
            val s = Socket()
            try {
                s.connect(InetSocketAddress(address, port), timeoutMillis)
            } catch (e: IOException) {
                s.close()
                throw e
            }
            TcpPipe(s)
        }
    }
}
