// The sessions the driver holds, the events it reports, and the open, send and recv commands over them.

package im.plrs.key.livepeer

import im.plrs.key.core.PolarisException
import im.plrs.key.sdk.CloudLocalLinks
import im.plrs.key.sdk.CloudTransfer
import im.plrs.key.sdk.ConnectSession
import im.plrs.key.sdk.LanErrorReason
import im.plrs.key.sdk.LanException
import im.plrs.key.sdk.OfferDecision
import im.plrs.key.sdk.TransferOutcome
import im.plrs.key.sdk.TransferSendOptions
import im.plrs.key.sdk.TransferSource
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

internal class Sessions(
    private val links: CloudLocalLinks,
    private val transfer: CloudTransfer,
    private val recvDir: File,
) {
    private val events = ConcurrentLinkedQueue<JsonObject>()
    private val held = ConcurrentHashMap<String, ConnectSession>()
    private val received = Channel<JsonObject>(Channel.UNLIMITED)
    private val offers = AtomicInteger()

    fun start() {
        links.onChange { events += buildJsonObject { put("kind", "change") } }
        links.onLink { s ->
            track(s, "in")
            events +=
                buildJsonObject {
                    put("kind", "link")
                    put("id", s.local?.id)
                }
        }
        transfer.onOffer { o -> OfferDecision.Accept(File(recvDir, "${offers.getAndIncrement()}-${o.id}.bin")) }
        transfer.onResult { r ->
            val dest = r.destination
            if (r.incoming && r.outcome == TransferOutcome.delivered && dest != null) {
                val data = dest.readBytes()
                received.trySend(
                    buildJsonObject {
                        put("sha256", sha256(data))
                        put("bytes", data.size)
                    },
                )
            }
        }
    }

    private fun track(
        s: ConnectSession,
        dir: String,
    ) {
        val id = s.local?.id
        if (id != null) held[id] = s
        s.onClose { c ->
            events +=
                buildJsonObject {
                    put("kind", "session-end")
                    put("dir", dir)
                    put("id", id)
                    put("code", c.code)
                    put("byPeer", c.byPeer)
                }
        }
    }

    /** A link not seen on the network yet is not an attempt: keep looking until the hang guard. */
    private suspend fun openLink(
        id: String,
        wait: Boolean,
    ): ConnectSession {
        val until = System.currentTimeMillis() + if (wait) WAIT_MILLIS else 0L
        while (true) {
            try {
                return links.open(id).also { track(it, "out") }
            } catch (e: LanException) {
                if (e.reason != LanErrorReason.unknown_peer || System.currentTimeMillis() >= until) throw Refusal(errorOf(e))
                delay(POLL_MILLIS)
            }
        }
    }

    suspend fun open(a: JsonObject): JsonObject {
        val id = requireNotNull(a.str("id")) { "open needs an id" }
        val wait = a["wait"]?.jsonPrimitive?.boolean ?: true
        try {
            openLink(id, wait)
        } catch (e: PolarisException) {
            throw Refusal(errorOf(e))
        }
        return buildJsonObject { put("link", id) }
    }

    suspend fun send(a: JsonObject): JsonObject {
        val id = requireNotNull(a.str("id")) { "send needs an id" }
        val data = pattern(requireNotNull(a["bytes"]?.jsonPrimitive?.int) { "send needs bytes" })
        check(sha256(data) == a.str("sha256")) { "the sender's pattern hashes differently" }
        val session = held[id]?.takeIf { it.closed == null } ?: openLink(id, true)
        TransferSource.ofBytes(data, name = "live.bin").use { source ->
            transfer.send(session, source, TransferSendOptions(category = CATEGORIES.first())).await()
            return buildJsonObject {
                put("sha256", source.sha256)
                put("bytes", source.size)
            }
        }
    }

    suspend fun recv(): JsonObject = received.receive()

    fun drain(): JsonObject {
        val out = ArrayList<JsonElement>()
        while (true) out += events.poll() ?: break
        return buildJsonObject { put("events", JsonArray(out)) }
    }
}
