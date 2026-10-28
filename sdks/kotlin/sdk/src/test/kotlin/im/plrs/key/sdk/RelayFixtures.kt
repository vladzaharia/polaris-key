// A faithful in-process relay room for the Cloud Connect tests (CC-12.13). It re-implements the CC-07
// engine's observable framing (WIRE-CONTRACT-V5 section 15.7) over the SDK's own envelope codec: a ticket
// is single use and names the device; `from` is stamped from the admission, never read from the client;
// SEND reaches the sockets of `to`; LIST answers MEMBERS; PING answers PONG; an envelope that fails its
// layout closes 1008. Mirrors sdk-node's `relayFixtures.ts` and the Python `connect_relay_fake.py`. Not a
// test class.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.RelayDirection
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.decodeRelay
import im.plrs.key.core.peer.encodeRelay
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList

internal const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

internal class FakeSocket(val room: FakeRoom, val url: String, val protocols: List<String>) : RelaySocket {
    @Volatile var device: String? = null

    @Volatile var closed = false

    @Volatile var closeCode: Int? = null
    private val q = Channel<Any>(Channel.UNLIMITED)

    override suspend fun send(data: ByteArray) {
        if (closed) throw SocketClosed(closeCode)
        room.fromClient(this, data.copyOf())
    }

    override suspend fun receive(): RelayFrame {
        val item = q.receiveCatching().getOrNull() ?: throw SocketClosed(closeCode)
        return if (item is ByteArray) RelayFrame.Binary(item) else RelayFrame.Text
    }

    override suspend fun close(code: Int) = shut(code)

    /** Either side closes: the client's next `receive` raises with [code]. */
    fun shut(code: Int?) {
        synchronized(room) {
            if (closed) return
            closed = true
            closeCode = code
            room.sockets.remove(this)
        }
        q.close()
    }

    fun deliver(m: Any) {
        if (closed) return
        q.trySend(
            when (m) {
                is RelayMessage -> encodeRelay(m)
                is ByteArray -> m
                else -> "text"
            },
        )
    }
}

internal class FakeRoom(members: Set<String>) {
    val memberSet: MutableSet<String> = members.toMutableSet()
    val tickets = HashMap<String, String>()
    val sockets = CopyOnWriteArrayList<FakeSocket>()
    val ever = CopyOnWriteArrayList<FakeSocket>()

    /** Every message a client sent, decoded, with the device that sent it. */
    val received = CopyOnWriteArrayList<Pair<String, RelayMessage>>()

    /** The subprotocol lists clients offered, in order. */
    val offered = CopyOnWriteArrayList<List<String>>()

    /** Close the next admission with this code. */
    @Volatile var rejectWith: Int? = null

    @Volatile var issued = 0
    private val rng = SecureRandom()

    fun issue(device: String, url: String = "wss://k.test/djdl/connect/relay"): RelayGrant {
        issued++
        val t = "pkeyrt_" + String(CharArray(32) { B64[rng.nextInt(B64.length)] })
        synchronized(this) { tickets[t] = device }
        return RelayGrant(t, url, "pkey-relay.1", 2_000_000_000)
    }

    suspend fun opener(url: String, protocols: List<String>): RelaySocket {
        val s = FakeSocket(this, url, protocols.toList())
        ever += s
        offered += protocols.toList()
        val proto = protocols.getOrNull(0)
        val ticket = protocols.getOrNull(1)
        rejectWith?.let {
            rejectWith = null
            throw SocketClosed(it)
        }
        val device = synchronized(this) { ticket?.let { tickets[it] } }
        if (proto != "pkey-relay.1" || device == null) throw SocketClosed(4001)
        synchronized(this) { tickets.remove(ticket) } // single use
        if (device !in memberSet) throw SocketClosed(4003)
        s.device = device
        val mine = sockets.filter { it.device == device }
        if (mine.size >= 2) mine[0].shut(4009) // a third socket of a device replaces the oldest
        sockets += s
        return s
    }

    fun fromClient(s: FakeSocket, data: ByteArray) {
        val m = decodeRelay(RelayDirection.toRoom, data)
        if (m == null) {
            s.shut(1008)
            return
        }
        val dev = s.device!!
        received += dev to m
        when (m) {
            is RelayMessage.Send -> {
                val to = Base64Url.encode(m.to)
                for (t in sockets.filter { it.device == to }) {
                    t.deliver(RelayMessage.Recv(Base64Url.decodeStrict(dev)!!, m.session, m.noise))
                }
            }

            RelayMessage.List -> s.deliver(members())

            is RelayMessage.Ping -> s.deliver(RelayMessage.Pong(m.data))

            else -> Unit
        }
    }

    fun members(): RelayMessage.Members {
        val ids = sockets.mapNotNull { it.device }.toSortedSet()
        return RelayMessage.Members(ids.map { Base64Url.decodeStrict(it)!! })
    }

    fun dropAll(code: Int?) {
        for (s in sockets.toList()) s.shut(code)
    }

    fun pushRing(epoch: Long) {
        for (s in sockets) s.deliver(RelayMessage.Ring(epoch))
    }

    fun push(device: String, m: Any) {
        for (s in sockets.filter { it.device == device }) s.deliver(m)
    }

    fun sends(device: String): List<RelayMessage.Send> = received.filter { it.first == device }.mapNotNull { it.second as? RelayMessage.Send }
}

/** A sleep the test drives: nothing wakes until [fire] picks it. */
internal class ManualSleep : suspend (Double) -> Unit {
    val delays = CopyOnWriteArrayList<Double>()
    val pending = CopyOnWriteArrayList<Pair<Double, CompletableDeferred<Unit>>>()

    override suspend fun invoke(seconds: Double) {
        val f = CompletableDeferred<Unit>()
        delays += seconds
        pending += seconds to f
        try {
            f.await()
        } finally {
            pending.removeAll { it.second === f }
        }
    }

    fun fire(match: (Double) -> Boolean): Boolean {
        for ((s, f) in pending) {
            if (match(s) && !f.isCompleted) {
                f.complete(Unit)
                return true
            }
        }
        return false
    }
}

/** Two devices of one person with real device keys, a signed roster and certificates. */
internal class TestWorld(val signer: TestSigner = TestSigner()) {
    val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    val now0 = 1_700_000_000L
    val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
    private val rng = SecureRandom()
    val k = ByteArray(32).also { rng.nextBytes(it) }

    class Device(val id: String, val port: DeviceKeyPort, val signKey: String, val agreeKey: String)

    private fun device(id: String): Device = kotlinx.coroutines.runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val keys = port.ensure()
        Device(id, port, keys.signKey, keys.agreeKey)
    }

    val a = device(idA)
    val b = device(idB)

    fun ring(devs: List<Device>, epoch: Long, subject: String = sub): String = signer.sign(
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

    val ring = ring(listOf(a, b), 1)

    @Volatile var now = now0

    fun peerSource(d: Device, keys: ByteArray = k, certExp: Long = now0 + 1000, ringJws: String = ring, ringEpoch: Long = 1): PeerSource {
        val cert = signer.sign(
            "pkey-peer+jws",
            JsonObject(
                mapOf(
                    "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(sub),
                    "deviceId" to JsonPrimitive(d.id), "signKey" to JsonPrimitive(d.signKey), "agreeKey" to JsonPrimitive(d.agreeKey),
                    "ringEpoch" to jsonInt(ringEpoch), "issuedAt" to jsonInt(now0 - 10), "expiresAt" to jsonInt(certExp),
                ),
            ),
        )
        return PeerSource(
            slug = "djdl", trust = signer.trust, sub = sub, deviceId = d.id, certificate = cert, certificateExpiresAt = certExp,
            ring = ringJws, ringEpoch = ringEpoch, roster = listOf(idA, idB), discovery = DiscoveryKeys(keys, null),
            agreePublic = Base64Url.decodeStrict(d.agreeKey)!!, keys = d.port,
        )
    }

    fun source(d: Device, refresh: (suspend () -> Unit)? = null, ps: PeerSource = peerSource(d)) =
        LanSource(load = { ps }, now = { now }, refresh = refresh)
}
