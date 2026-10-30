// Fixtures for the nearby (mode v) tests (CC-15.K2, K3): a fake LAN, a bare device D that speaks mode v
// with the engine over a real loopback socket to an approver's advert, timers a test fires by hand, and a fake
// of the Worker's `nearby/approve` that holds the key-binding rule of WIRE-CONTRACT-V5 section 12.11.5 rule 3.
// Mirrors packages/sdk-node/test/connect/nearbyFixtures.ts.

package im.plrs.key.core.peer.nearby

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerHello
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.RecordType
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.VouchHello
import im.plrs.key.core.peer.VouchMessage
import im.plrs.key.core.peer.VouchRequest
import im.plrs.key.core.peer.VouchVerdict
import im.plrs.key.core.peer.buildVouchRequest
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.peerHostPlatform
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList

const val SLUG = "djdl"
const val D_ID = "NEARBYDEVICEZZZZZZZZZZZZZZZZZZZD"
const val REQUEST = "nr_0IvbE7YHMGPBP0VAfZDQhg"
const val T0 = 1_700_000_000L

private val rng = SecureRandom()

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

fun memoryKeys(): DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage())

/** Poll [cond] until it holds; fail after [timeoutMillis]. */
fun until(timeoutMillis: Long = 8000, what: String = "condition", cond: () -> Boolean) {
    val end = System.nanoTime() + timeoutMillis * 1_000_000
    while (!cond()) {
        if (System.nanoTime() > end) throw AssertionError("timed out waiting for $what")
        Thread.sleep(10)
    }
}

/** Let events that should NOT happen have a moment to. */
fun settle(millis: Long = 80) = Thread.sleep(millis)

/** A fake LAN: every advert and browser on one network, all at 127.0.0.1. */
class MemNetwork(private val at: String = "127.0.0.1") : MdnsAdapter {
    val adverts = LinkedHashMap<String, MdnsAdvert>()
    val browsers = CopyOnWriteArrayList<Pair<(MdnsFound) -> Unit, (String) -> Unit>>()
    val log = CopyOnWriteArrayList<String>()

    private fun found(a: MdnsAdvert) = MdnsFound(a.instance, at, a.port, a.txt)

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

    /** The adverts of mode v, instance, port and TXT. */
    fun approverAdverts(): List<MdnsAdvert> = synchronized(adverts) { adverts.values.filter { "m=v" in it.txt } }

    /** A found record a test injects (a forged advert). */
    fun inject(f: MdnsFound) {
        for ((up, _) in browsers) up(f)
    }

    /** Take an advert away without its owner's say (the network lost it). */
    fun drop(instance: String) {
        synchronized(adverts) { adverts.remove(instance) }
        for ((_, down) in browsers) down(instance)
    }
}

/** Timers a test fires by hand. */
class FakeTimers {
    class T(val seconds: Double, val fn: () -> Unit) {
        @Volatile var live = true
    }

    val all = CopyOnWriteArrayList<T>()

    val timer: (Double, () -> Unit) -> (() -> Unit) = { seconds, fn ->
        val t = T(seconds, fn)
        all += t
        val cancel: () -> Unit = { t.live = false }
        cancel
    }

    fun live(seconds: Double): List<T> = all.filter { it.live && it.seconds == seconds }

    /** Fire every live timer of [seconds] once. */
    fun fire(seconds: Double) {
        for (t in live(seconds)) {
            t.live = false
            t.fn()
        }
    }
}

/** A monotonic clock a test moves. */
class FakeClock(@Volatile var now: Double = 100.0) {
    val mono: () -> Double = { now }
}

class RawDOptions(
    val keys: DeviceKeyPort? = null,
    val deviceId: String = D_ID,
    val request: String = REQUEST,
    val label: String? = null,
    /** Hold the SAS (default true, as the requester does); false commits at HELLO. */
    val hold: Boolean = true,
    /** Which advert to dial (default: the only one). */
    val port: Int? = null,
    /** Show the code and send `VOUCH_REQ` as soon as the code is known. */
    val auto: Boolean = false,
)

/** A device D at the record level: the engine, a socket and what came back. */
class RawD private constructor(private val o: RawDOptions, val keys: DeviceKeyPort, private val scope: CoroutineScope) {
    val events = CopyOnWriteArrayList<SessionEvent>()
    val records = CopyOnWriteArrayList<Pair<Int, ByteArray>>()

    @Volatile var closed: SessionEvent.Closed? = null

    @Volatile var code: Int? = null

    @Volatile var hello: PeerHello? = null
    lateinit var link: PeerLink<Unit>
    val channel: PeerChannel get() = link.channel
    val helloOut = VouchHello(o.label, peerHostPlatform())

    /** The person chose this approver. */
    suspend fun startSas() = channel.startSas()

    /** D shows the code (its confirmation) and sends `VOUCH_REQ`; [over] may change the body first. */
    suspend fun showAndRequest(over: ((ByteArray) -> ByteArray)? = null) {
        val flow = checkNotNull(channel.vouch)
        flow.codeShown()
        channel.confirmSas()
        var body = buildVouchRequest(keys, SLUG, channel.handshakeHash(), o.request, o.deviceId, helloOut)
        if (over != null) body = over(body)
        if (flow.send(VouchMessage(RecordType.VOUCH_REQ, body)) is VouchVerdict.Ok) channel.sendRecord(RecordType.VOUCH_REQ, body)
    }

    fun result(): String? = records.firstOrNull { it.first == RecordType.VOUCH_RESULT }?.let {
        Regex("\"status\":\"([a-z_]+)\"").find(String(it.second))?.groupValues?.get(1)
    }

    fun waitFor(what: String = "D", f: () -> Boolean) = until(5000, what, f)

    suspend fun close() {
        try {
            channel.close(im.plrs.key.core.peer.PeerCloseCode.peer_bye)
        } catch (e: Exception) {
            // already gone
        }
    }

    companion object {
        suspend fun dial(net: MemNetwork, scope: CoroutineScope, o: RawDOptions = RawDOptions()): RawD {
            val port = o.port ?: net.approverAdverts().first().port
            val keys = o.keys ?: memoryKeys()
            keys.ensure()
            val pipe = TcpPipe.connect("127.0.0.1", port, 3000)
            val d = RawD(o, keys, scope)
            val handlers = LinkHandlers<Unit>(
                onEstablished = { _, e -> d.hello = e.hello },
                onRecord = { _, type, body -> d.records += type to body },
                onClosed = { c -> d.closed = c },
                onSas = { _, e ->
                    d.code = e.code
                    if (o.auto) scope.launch { d.showAndRequest() }
                },
            )
            d.link = PeerLink(pipe, scope, handlers, 30.0, anonymous = true) { send, onEvent ->
                PeerChannel(
                    NoiseRole.initiator, SLUG, RawNoiseStatic(randomBytes(32)), null,
                    HelloInfo(peerHostPlatform(), SLUG, o.label), send, onEvent,
                    mode = PeerMode.v, holdSas = o.hold,
                )
            }
            scope.launch { d.link.run() }
            d.link.start()
            return d
        }
    }
}

/** What `nearby/start` registered for D, and the approve rules the Worker applies. */
class FakeNearbyWorker {
    class Start(val deviceId: String, val signKey: String, val agreeKey: String)

    val start = HashMap<String, Start>()
    val calls = ArrayList<Pair<String, String>>()

    /** Does M have keys registered? A first approve without them answers `device_keys_required`. */
    var mHasKeys = false
    val decided = HashSet<String>()
    val approved = ArrayList<String>()

    suspend fun register(request: String, keys: DeviceKeyPort, deviceId: String) {
        val k = keys.ensure()
        start[request] = Start(deviceId, k.signKey, k.agreeKey)
    }

    /** `POST nearby/approve` as M sends it: exactly what `pick()` returned. Returns the status and body. */
    fun approve(r: VouchRequest): Pair<Int, String?> {
        calls += r.request to r.deviceId
        if (!mHasKeys) return 409 to "{\"code\":\"device_keys_required\"}"
        val s = start[r.request]
        if (s == null || r.request in decided || s.deviceId != r.deviceId || s.signKey != r.signKey || s.agreeKey != r.agreeKey) return 404 to null
        decided += r.request
        approved += r.deviceId
        return 200 to "{\"status\":\"approved\"}"
    }
}
