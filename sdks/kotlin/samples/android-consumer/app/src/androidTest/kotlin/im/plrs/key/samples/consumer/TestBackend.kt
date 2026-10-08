package im.plrs.key.samples.consumer

import com.google.crypto.tink.subtle.Ed25519Sign
import im.plrs.key.core.Base64Url
import im.plrs.key.core.TrustSet
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.Collections
import kotlin.concurrent.thread
import org.json.JSONObject

/** One request as the server read it (header names lowercase). */
class SeenRequest(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

/** One response: status, JSON or JWS body, extra headers. */
class Reply(val status: Int, val body: String = "", val headers: Map<String, String> = emptyMap())

/**
 * A plain HTTP/1.1 server on 127.0.0.1 that SPLITS every response: the status line and headers are
 * written and flushed, then the body follows [splitMillis] later, as on any real network. A client
 * that resumes its caller when the headers arrive and reads the body there reads it on that thread:
 * on Android's main thread that is NetworkOnMainThreadException (SP-50). Runs on its own threads.
 */
class SplitServer(private val splitMillis: Long = 250, private val handler: (SeenRequest) -> Reply) : AutoCloseable {
    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val baseUrl: String = "http://127.0.0.1:${socket.localPort}"
    val seen: MutableList<SeenRequest> = Collections.synchronizedList(ArrayList())

    init {
        thread(isDaemon = true, name = "split-server") {
            while (!socket.isClosed) {
                val s = try {
                    socket.accept()
                } catch (e: SocketException) {
                    break
                }
                thread(isDaemon = true, name = "split-server-conn") { serve(s) }
            }
        }
    }

    private fun serve(s: Socket): Unit = s.use {
        val input = BufferedInputStream(s.getInputStream())
        val line = readLine(input) ?: return
        val headers = LinkedHashMap<String, String>()
        while (true) {
            val h = readLine(input) ?: return
            if (h.isEmpty()) break
            val i = h.indexOf(':')
            if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(length)
        var got = 0
        while (got < length) {
            val n = input.read(body, got, length - got)
            if (n < 0) break
            got += n
        }
        val parts = line.split(' ')
        val request = SeenRequest(parts[0], parts.getOrElse(1) { "/" }.substringBefore('?'), headers, body)
        seen += request
        val reply = try {
            handler(request)
        } catch (e: Exception) {
            Reply(500, """{"error":{"code":"internal_error","message":"${e.message}"}}""")
        }
        val bytes = reply.body.toByteArray(Charsets.UTF_8)
        val head = StringBuilder("HTTP/1.1 ${reply.status} ${reason(reply.status)}\r\n")
        val contentType = if (reply.body.startsWith("{") || reply.body.startsWith("[")) "application/json" else "application/jose"
        if (reply.headers.keys.none { it.equals("content-type", true) } && bytes.isNotEmpty()) head.append("Content-Type: $contentType\r\n")
        for ((k, v) in reply.headers) head.append("$k: $v\r\n")
        head.append("Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
        val out = s.getOutputStream()
        out.write(head.toString().toByteArray(Charsets.US_ASCII))
        out.flush()
        if (bytes.isNotEmpty()) {
            Thread.sleep(splitMillis)
            out.write(bytes)
            out.flush()
        }
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val c = input.read()
            if (c < 0) return if (buf.size() == 0) null else buf.toString("US-ASCII")
            if (c == '\n'.code) return buf.toString("US-ASCII").trimEnd('\r')
            buf.write(c)
        }
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        304 -> "Not Modified"
        401 -> "Unauthorized"
        404 -> "Not Found"
        else -> "Status"
    }

    override fun close() = socket.close()
}

/** A throwaway Ed25519 product key (Tink's pure-Java signer) and the documents it signs. */
class DeviceSigner(private val kid: String = "consumer-test") {
    private val pair = Ed25519Sign.KeyPair.newKeyPair()
    private val signer = Ed25519Sign(pair.privateKey)

    /** The trust set that pins this key. */
    val trust: TrustSet = mapOf(kid to Base64Url.encode(pair.publicKey))

    private fun sign(typ: String, payload: JSONObject): String {
        val header = JSONObject().put("alg", "EdDSA").put("typ", typ).put("kid", kid)
        val input = Base64Url.encode(header.toString()) + "." + Base64Url.encode(payload.toString())
        return input + "." + Base64Url.encode(signer.sign(input.toByteArray(Charsets.UTF_8)))
    }

    /** `pkey-license+jws` for [deviceId], issued at [now], with `pro: true` as a default-state entitlement. */
    fun licenseDoc(aud: String, deviceId: String, now: Long, licenseId: String = "lic_consumer"): String {
        val entitlements = JSONObject().put(
            "pro",
            JSONObject().put("state", "default").put("value", true).put("updatedAt", 1),
        )
        val payload = JSONObject()
            .put("iss", "key.plrs.im")
            .put("aud", aud)
            .put("deviceId", deviceId)
            .put("issuedAt", now)
            .put("expiresAt", now + 3600)
            .put("graceUntil", now + 7 * 86_400)
            .put("licenseId", licenseId)
            .put("entitlements", entitlements)
        return sign("pkey-license+jws", payload)
    }
}
