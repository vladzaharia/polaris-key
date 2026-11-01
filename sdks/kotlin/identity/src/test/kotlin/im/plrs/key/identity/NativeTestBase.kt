// Shared constants and socket helpers of the native redirect tests (I-15b.5).

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.objectValue
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import java.io.File
import java.net.InetAddress
import java.net.Socket

abstract class NativeTestBase {
    protected val api = "https://key.example/djdl"
    protected val iss = "$api/identity"
    protected val state = "tidewater-state-0123456789"
    protected val verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    protected val handle = "rq_fxXQ7DEgqPUfZlsJYdm76w"
    protected val requestUri = "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
    protected val scheme = "com.tidewater.studio:/pkey/callback"
    protected val code = "nzMud_COpAeAOKaIdixAP_dJqIpwVVSjV3GCoBfT-eE"
    protected val returnPage = "https://key.example/signin/return"
    protected val tokenOk = """{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email",""" +
        """"schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc"}"""

    protected fun recorded(name: String) = JsonText.parse(
        File(System.getProperty("pkey.repoRoot"), "conformance/transcripts/redirect-native-$name.json").readText(),
    ).objectValue!!

    protected val issEnc = "https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"

    protected class Reply(val status: Int, val headers: Map<String, String>, val raw: String)

    protected fun get(port: Int, target: String, host: String? = "127.0.0.1:$port", method: String = "GET"): Reply {
        Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port).use { s ->
            s.soTimeout = 5000
            val req = "$method $target HTTP/1.1\r\n" + (if (host != null) "Host: $host\r\n" else "") + "Connection: close\r\n\r\n"
            s.getOutputStream().write(req.toByteArray())
            val text = s.getInputStream().readBytes().toString(Charsets.ISO_8859_1)
            val lines = text.split("\r\n")
            val headers = lines.drop(1).takeWhile {
                it.isNotEmpty()
            }.associate { it.substringBefore(':').lowercase() to it.substringAfter(':').trim() }
            return Reply(lines[0].split(' ')[1].toInt(), headers, text)
        }
    }

    protected fun refused(port: Int): Boolean = runCatching { Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port).close() }.isFailure

    /** Whether a second, non-sharing socket could bind [port] on loopback right now. */
    protected fun canBind(port: Int): Boolean = runCatching {
        java.net.ServerSocket().use {
            it.reuseAddress = false
            it.bind(java.net.InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port))
        }
    }.isSuccess

    protected fun waitUntil(what: () -> Boolean) {
        val end = System.nanoTime() + 5_000_000_000L
        while (!what()) {
            if (System.nanoTime() > end) fail("timed out")
            Thread.sleep(20)
        }
    }

    protected fun assertInvalid(block: () -> Unit) {
        try {
            block()
            fail("accepted")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidArgument, e.code)
        }
    }
}
