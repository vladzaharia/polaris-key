// @pkey-feature connect.lan
//
// The fixtures of the LAN service tests (CC-12.12; WIRE-CONTRACT-V5 sections 15.4 to 15.6): a fake mDNS
// network, devices with signed rings and certificates, and a raw socket for the listener's bounds.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.ADVERT_EPOCH_SECONDS
import im.plrs.key.core.peer.accountInstance
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING_PER_ADDRESS
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

abstract class ConnectLanBase {
    internal val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    internal val now0 = 1_700_000_000L
    internal val signer = TestSigner()
    internal val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    internal val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
    internal val idC = "CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB"
    internal val rng = SecureRandom()
    internal val scope = CoroutineScope(Dispatchers.Default + Job())
    internal val services = ArrayList<LanService>()

    @After
    fun tearDown() {
        for (s in services) runBlocking { s.stop() }
        scope.cancel()
    }

    internal fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    internal fun until(timeoutMillis: Long = 8000, cond: () -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond()) {
            if (System.nanoTime() > end) throw AssertionError("timed out")
            Thread.sleep(10)
        }
    }

    // -- a fake LAN: every advert and browser on one network, all at 127.0.0.1 ----------------------

    internal class Network(val at: String = "127.0.0.1") : MdnsAdapter {
        val adverts = LinkedHashMap<String, MdnsAdvert>()
        val browsers = CopyOnWriteArrayList<Pair<(MdnsFound) -> Unit, (String) -> Unit>>()
        val log = CopyOnWriteArrayList<String>()

        /** Opens the sockets every dial to a found advert uses (null: the default route). */
        @Volatile
        var factory: javax.net.SocketFactory? = null

        private fun found(a: MdnsAdvert) = MdnsFound(a.instance, at, a.port, a.txt, socketFactory = factory)

        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
            synchronized(adverts) { adverts[advert.instance] = advert }
            log += "up " + advert.instance
            for ((up, _) in browsers) up(found(advert))
            return MdnsHandle {
                synchronized(adverts) { adverts.remove(advert.instance) }
                log += "down " + advert.instance
                for ((_, down) in browsers) down(advert.instance)
            }
        }

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle {
            val b = onUp to onDown
            browsers += b
            for (a in synchronized(adverts) { adverts.values.toList() }) onUp(found(a))
            return MdnsHandle { browsers -= b }
        }

        fun inject(f: MdnsFound) {
            for ((up, _) in browsers) up(f)
        }

        fun names(): List<String> = synchronized(adverts) { adverts.keys.toList() }
    }

    // -- devices and sources --------------------------------------------------------------------

    internal class Device(val id: String, val port: DeviceKeyPort, val signKey: String, val agreeKey: String)

    internal fun device(id: String): Device = runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val k = port.ensure()
        Device(id, port, k.signKey, k.agreeKey)
    }

    internal fun ring(devs: List<Device>, epoch: Long, subject: String = sub): String = signer.sign(
        "pkey-ring+jws",
        JsonObject(
            mapOf(
                "iss" to JsonPrimitive("key.plrs.im"),
                "aud" to JsonPrimitive("djdl"),
                "sub" to JsonPrimitive(subject),
                "epoch" to jsonInt(epoch),
                "issuedAt" to jsonInt(now0 - 10),
                "expiresAt" to jsonInt(now0 + 600_000),
                "devices" to JsonArray(
                    devs.sortedBy { it.id }.map {
                        JsonObject(
                            mapOf(
                                "deviceId" to JsonPrimitive(it.id),
                                "signKey" to JsonPrimitive(it.signKey),
                                "agreeKey" to JsonPrimitive(it.agreeKey),
                            ),
                        )
                    },
                ),
            ),
        ),
    )

    internal inner class World(val net: Network = Network()) {
        val a = device(idA)
        val b = device(idB)
        val k = rnd()
        val ring = ring(listOf(a, b), 1)

        @Volatile
        var now = now0

        fun peerSource(
            d: Device,
            keys: ByteArray = k,
            certExp: Long = now0 + 1000,
            ringJws: String = ring,
            subject: String = sub,
            roster: List<String> = listOf(idA, idB),
        ): PeerSource {
            val cert = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(subject),
                        "deviceId" to JsonPrimitive(d.id), "signKey" to JsonPrimitive(d.signKey), "agreeKey" to JsonPrimitive(d.agreeKey),
                        "ringEpoch" to jsonInt(1), "issuedAt" to jsonInt(now0 - 10), "expiresAt" to jsonInt(certExp),
                    ),
                ),
            )
            return PeerSource(
                slug = "djdl", trust = signer.trust, sub = subject, deviceId = d.id, certificate = cert, certificateExpiresAt = certExp,
                ring = ringJws, ringEpoch = 1, roster = roster, discovery = DiscoveryKeys(keys, null),
                agreePublic = Base64Url.decodeStrict(d.agreeKey)!!, keys = d.port,
            )
        }

        fun source(d: Device, ps: PeerSource = peerSource(d), onLoad: () -> PeerSource = { ps }) = LanSource(load = { onLoad() }, now = { now })

        fun start(
            d: Device,
            src: LanSource = source(d),
            mdns: MdnsAdapter = net,
            allowLoopback: Boolean = true,
            advertise: Boolean = true,
            browse: Boolean = true,
            maxPending: Int = 32,
            maxPendingPerAddress: Int = 4,
            maxPendingPerGroup: Int = 16,
            handshakeSeconds: Double = 30.0,
            dialSeconds: Double = 5.0,
            rekeyMessages: Int? = null,
            timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
            lanPermission: suspend () -> Boolean = { true },
            host: String? = "127.0.0.1",
        ): LanService = runBlocking {
            val o = LanOptions(
                mdns = mdns, host = host, allowLoopback = allowLoopback, advertise = advertise, browse = browse,
                maxPending = maxPending, maxPendingPerAddress = maxPendingPerAddress, maxPendingPerGroup = maxPendingPerGroup,
                handshakeSeconds = handshakeSeconds, dialSeconds = dialSeconds,
                rekeyMessages = rekeyMessages, timer = timer, lanPermission = lanPermission,
            )
            LanService.start(src, o).also { services += it }
        }
    }

    internal fun pair(la: LanService, lb: LanService): Pair<ConnectSession, ConnectSession> {
        val inbound = CopyOnWriteArrayList<ConnectSession>()
        la.onSession { inbound += it }
        until { lb.peers().any { it.deviceId == idA } }
        val out = runBlocking { lb.connect(idA) }
        until { inbound.isNotEmpty() }
        return out to inbound[0]
    }

    internal class Raw(port: Int, host: String = "127.0.0.1") {
        val sock = Socket(host, port)

        @Volatile var received = 0
        val closed = CountDownLatch(1)

        init {
            Thread {
                try {
                    val b = ByteArray(4096)
                    while (true) {
                        val n = sock.getInputStream().read(b)
                        if (n < 0) break
                        received += n
                    }
                } catch (e: java.io.IOException) {
                    // reset: the listener dropped us
                }
                closed.countDown()
            }.also { it.isDaemon = true }.start()
        }

        val isClosed: Boolean get() = closed.count == 0L

        fun write(b: ByteArray) {
            sock.getOutputStream().write(b)
            sock.getOutputStream().flush()
        }

        fun drop() = sock.close()
    }
}
