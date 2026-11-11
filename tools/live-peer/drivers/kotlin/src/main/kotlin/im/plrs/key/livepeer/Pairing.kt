// The pairing commands: show, join, list, forget.

package im.plrs.key.livepeer

import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.sdk.CloudLocalLinks
import im.plrs.key.sdk.LocalCode
import im.plrs.key.sdk.LocalJoinOptions
import im.plrs.key.sdk.LocalLinkInfo
import im.plrs.key.sdk.LocalOffer
import im.plrs.key.sdk.LocalPairHandle
import im.plrs.key.sdk.LocalPairOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val BROWSE_SECONDS = 4.0
internal const val POLL_MILLIS = 50L
internal const val WAIT_MILLIS = 20_000L

internal class Pairing(
    private val links: CloudLocalLinks,
    private val net: MdnsAdapter,
    private val scope: CoroutineScope,
) {
    @Volatile private var handle: LocalPairHandle? = null

    @Volatile private var codeNow: LocalCode? = null

    private fun confirmTo(offer: LocalOffer) {
        scope.launch { offer.confirm() }
    }

    suspend fun show(a: JsonObject): JsonObject {
        // After a pairing the window closes on its own; a fresh one waits for that.
        if (a.str("fresh") == "true") {
            val until = System.currentTimeMillis() + WAIT_MILLIS
            while (handle?.open == true && System.currentTimeMillis() < until) delay(POLL_MILLIS)
        }
        var h = handle
        if (h == null || !h.open) {
            codeNow = null
            h =
                links.pair(
                    LocalPairOptions(
                        categories = CATEGORIES,
                        onCode = { codeNow = it },
                        onConfirm = ::confirmTo,
                        label = "kotlin",
                        mdns = net,
                        host = LOOP,
                        allowLoopback = true,
                    ),
                )
            handle = h
        }
        val c = checkNotNull(h.code() ?: codeNow) { "the window shows no code" }
        return buildJsonObject {
            put("code", c.code)
            put("qr", c.qr)
        }
    }

    suspend fun join(a: JsonObject): JsonObject {
        val code = a.str("code")
        val dialsLeft = { code?.let { links.dialsLeft(it) } }
        try {
            val p =
                links.join(
                    LocalJoinOptions(
                        categories = CATEGORIES,
                        onConfirm = ::confirmTo,
                        code = code,
                        qr = a.str("qr"),
                        label = "kotlin",
                        // The joiner waits out its browse after a failed dial in case a second device answers.
                        browseSeconds = BROWSE_SECONDS,
                        mdns = net,
                        allowLoopback = true,
                    ),
                )
            return buildJsonObject {
                put("link", p.id)
                put("dialsLeft", dialsLeft())
            }
        } catch (e: PolarisException) {
            throw Refusal(errorOf(e), mapOf("dialsLeft" to JsonPrimitive(dialsLeft())))
        }
    }

    private fun infoOf(l: LocalLinkInfo): JsonObject =
        buildJsonObject {
            put("id", l.id)
            put("label", l.label)
            put("platform", l.platform)
            put("categories", strings(l.categories))
            put("reachable", l.reachable)
        }

    suspend fun list(): JsonObject = buildJsonObject { put("links", JsonArray(links.list().map(::infoOf))) }

    suspend fun forget(a: JsonObject): JsonObject {
        val id = requireNotNull(a.str("id")) { "forget needs an id" }
        return buildJsonObject { put("removed", links.remove(id)) }
    }

    suspend fun stop() {
        handle?.stop()
    }
}
