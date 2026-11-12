// What the driver's client sees of the network: discovery from a local transport, mDNS through the harness.

package im.plrs.key.livepeer

import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArrayList

internal const val PRODUCT = "djdl"
internal const val LOOP = "127.0.0.1"
private const val HTTP_OK = 200
private const val HTTP_NOT_FOUND = 404

/** The harness is the mDNS broker: our adverts go to it, its other drivers' adverts come back. Found hosts are loopback. */
internal class BrokerNet : MdnsAdapter {
    private val adverts = LinkedHashMap<String, MdnsAdvert>()
    private val browsers = CopyOnWriteArrayList<Pair<(MdnsFound) -> Unit, (String) -> Unit>>()

    private fun found(a: MdnsAdvert) = MdnsFound(a.instance, LOOP, a.port, a.txt)

    override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
        synchronized(adverts) { adverts[advert.instance] = advert }
        send(
            buildJsonObject {
                put("mdns", "advertise")
                put(
                    "advert",
                    buildJsonObject {
                        put("instance", advert.instance)
                        put("port", advert.port)
                        put("txt", strings(advert.txt))
                    },
                )
            },
        )
        for ((up, _) in browsers) up(found(advert))
        return MdnsHandle {
            val had = synchronized(adverts) { adverts.remove(advert.instance) != null }
            if (had) {
                send(
                    buildJsonObject {
                        put("mdns", "withdraw")
                        put("instance", advert.instance)
                    },
                )
                for ((_, down) in browsers) down(advert.instance)
            }
        }
    }

    override suspend fun browse(
        onUp: (MdnsFound) -> Unit,
        onDown: (String) -> Unit,
        accept: (String) -> Boolean,
    ): MdnsHandle {
        val b = onUp to onDown
        browsers += b
        for (a in synchronized(adverts) { adverts.values.toList() }) if (accept(a.instance)) onUp(found(a))
        return MdnsHandle { browsers -= b }
    }

    fun remoteUp(a: MdnsAdvert) {
        synchronized(adverts) { adverts[a.instance] = a }
        for ((up, _) in browsers) up(found(a))
    }

    fun remoteDown(instance: String) {
        val had = synchronized(adverts) { adverts.remove(instance) != null }
        if (had) for ((_, down) in browsers) down(instance)
    }
}

/** Discovery says `localPairing: true`; every other call is a 404. */
internal object LocalDiscovery : PolarisTransport {
    private const val DOC =
        """{"product":"$PRODUCT","protocolVersion":5,""" +
            """"services":{"connect":{"enabled":true,"localPairing":true}}}"""

    override suspend fun send(request: PolarisRequest): PolarisResponse =
        if (request.url.endsWith("/.well-known/polaris.json")) {
            PolarisResponse(HTTP_OK, DOC.toByteArray(), mapOf("content-type" to "application/json"))
        } else {
            PolarisResponse(HTTP_NOT_FOUND, "{}".toByteArray())
        }
}
