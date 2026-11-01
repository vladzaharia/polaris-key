package im.plrs.key.godot

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import im.plrs.key.platform.NsdAdvertResult
import im.plrs.key.platform.NsdResolved
import im.plrs.key.platform.PeerNsd
import im.plrs.key.platform.PeerNsdListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The LAN discovery ops of the Godot plugin (CC-14b.9, D-15), over `:platform`'s [PeerNsd]. Discovery
 * only: the pipes are GDScript sockets, and the advert names the port of the GDScript listener. No
 * bytes of a session cross the plugin.
 *
 * - `nsd_status`: `{supported, permission}` where permission is `not_required`, `granted` or `denied`.
 * - `nsd_advertise {instance, port, txt}`: publish (or move the running advert to a new name). The
 *   outcome arrives as the event `nsd_advert {ok, reason?}`. A second call replaces the first.
 * - `nsd_advertise_stop`, `nsd_browse_start`, `nsd_browse_stop`, `nsd_stop_all`.
 * - `nsd_accept {names}`: the instance names this device would accept. Until the first call nothing is
 *   accepted. A name outside the set is dropped before it takes a table slot, a watch or an event, so a
 *   forged name costs nothing. A bad list clears the set (nothing accepted) and answers `bad_input`.
 *
 * Events ride `poll`, as `nsd_found {instance, hosts, port, txt}` (every address the OS resolved, the
 * dialable kinds first), `nsd_lost {instance}`, `nsd_advert` and `nsd_error {reason}`. They are
 * coalesced per instance (the newest state of a name wins), so the buffer holds at most the watched names
 * plus two status slots, and an event is never lost to a busy network: it is replaced by a newer one.
 *
 * Android 17 (API 37) guards local-network access behind `ACCESS_LOCAL_NETWORK` for apps that target it.
 * When that applies and the permission is not granted, advertise and browse answer `permission_denied`
 * and start nothing; the GDScript side asks the user (L-11) and retries.
 */
/** Ends an advert, a browse or a watch. */
typealias Stopper = () -> Unit

class NsdCommands(private val c: Commands, private val backend: Backend) {
    /** What the ops act through: [PeerNsd] and the permission state in the app, a fake in tests. */
    interface Backend {
        fun supported(): Boolean

        fun permission(): Permission

        fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): Stopper

        fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): Stopper

        fun watch(instance: String, listener: PeerNsdListener): Stopper

        fun close() {}
    }

    enum class Permission(val word: String) {
        NOT_REQUIRED("not_required"),
        GRANTED("granted"),
        DENIED("denied"),
    }

    private val lock = Any()
    private var accepted: Set<String> = emptySet()
    private var advert: Stopper? = null
    private var advertGen = 0
    private var browse: Stopper? = null
    private val watches = HashMap<String, Stopper>()
    private val events = Coalesced()

    fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "nsd_status" -> JSONObject().put("ok", true).put("supported", backend.supported()).put("permission", backend.permission().word)
        "nsd_advertise" -> guarded { advertise(q) }
        "nsd_advertise_stop" -> {
            synchronized(lock) { stopAdvert() }
            JSONObject().put("ok", true)
        }
        "nsd_browse_start" -> guarded { startBrowse() }
        "nsd_browse_stop" -> {
            synchronized(lock) { stopBrowse() }
            JSONObject().put("ok", true)
        }
        "nsd_accept" -> accept(q)
        "nsd_stop_all" -> {
            stopAll()
            JSONObject().put("ok", true)
        }
        else -> Commands.fail("unknown_op", op)
    }

    fun supported(): Boolean = backend.supported()

    /** Appends the pending discovery events to a `poll` reply. */
    fun drainInto(events: JSONArray) {
        val out = synchronized(lock) { this.events.drain() }
        for (e in out) events.put(e)
    }

    fun close() {
        stopAll()
        backend.close()
    }

    // ── ops ──────────────────────────────────────────────────────────────────────────────────

    private fun gate(): JSONObject? = when {
        !backend.supported() -> Commands.fail("unsupported", "sdk")
        backend.permission() == Permission.DENIED -> Commands.fail("permission_denied", null)
        else -> null
    }

    private fun guarded(block: () -> JSONObject): JSONObject {
        gate()?.let { return it }
        return try {
            block()
        } catch (e: IllegalArgumentException) {
            Commands.fail("bad_input", null)
        } catch (e: Exception) {
            Commands.fail("nsd", Commands.EXCEPTION_REASON)
        }
    }

    private fun advertise(q: JSONObject): JSONObject {
        val instance = q.optString("instance")
        val port = q.optInt("port", 0)
        if (!isInstanceName(instance) || port !in 1..65535) return Commands.fail("bad_input", null)
        val txt = parseTxt(q.optJSONArray("txt")) ?: return Commands.fail("bad_input", null)
        synchronized(lock) {
            stopAdvert()
            val gen = ++advertGen
            advert = backend.advertise(instance, port, txt) { result ->
                synchronized(lock) {
                    // An answer for an advert that was since replaced or stopped says nothing about the current one.
                    if (gen == advertGen) {
                        events.single("advert", advertEvent(result))
                        if (result is NsdAdvertResult.Refused) stopAdvert()
                    }
                }
            }
        }
        return JSONObject().put("ok", true)
    }

    private fun startBrowse(): JSONObject {
        synchronized(lock) {
            if (browse != null) return Commands.fail("busy", null)
            browse = openBrowse()
        }
        return JSONObject().put("ok", true)
    }

    private fun accept(q: JSONObject): JSONObject {
        val list = q.optJSONArray("names")
        val names = HashSet<String>()
        var good = list != null && list.length() <= MAX_ACCEPTED
        if (good) {
            for (i in 0 until list!!.length()) {
                val n = list.optString(i)
                if (!isInstanceName(n)) {
                    good = false
                    break
                }
                names += n
            }
        }
        synchronized(lock) {
            val next: Set<String> = if (good) names else emptySet()
            if (next != accepted) {
                accepted = next
                if (browse != null) {
                    // Names that left the set go now; names that joined need the OS to report them again, which
                    // a fresh discovery does for every service already on the network.
                    for (n in watches.keys.toList()) if (n !in next) dropWatch(n)
                    runCatching { browse?.invoke() }
                    browse = null
                    // The permission may have been withdrawn since the browse started: judge it again.
                    if (gate() == null) browse = runCatching { openBrowse() }.getOrNull()
                    if (browse == null) for (n in watches.keys.toList()) dropWatch(n)
                }
            }
        }
        return if (good) JSONObject().put("ok", true) else Commands.fail("bad_input", null)
    }

    // ── state (under the lock) ───────────────────────────────────────────────────────────────

    private fun openBrowse(): Stopper = backend.browse(
        object : PeerNsdListener {
            override fun onFound(instance: String) = synchronized(lock) { watch(instance) }

            override fun onLost(instance: String) = synchronized(lock) { dropWatch(instance) }

            override fun onFailed(reason: String) = synchronized(lock) { events.single("error", JSONObject().put("ev", "nsd_error").put("reason", reasonWord(reason))) }
        },
    ) { name -> synchronized(lock) { name in accepted } }

    private fun watch(instance: String) {
        // The name filter ran before this, but the set may have changed since: judge again.
        if (instance !in accepted || watches.containsKey(instance)) return
        watches[instance] = backend.watch(
            instance,
            object : PeerNsdListener {
                override fun onResolved(resolved: NsdResolved) = synchronized(lock) {
                    if (instance in watches) found(instance, resolved)
                }

                override fun onLost(instance: String) = synchronized(lock) { events.lost(instance) }

                override fun onFailed(reason: String) = synchronized(lock) {
                    // A watch the platform would not take (its own bound) or ended: the name is not reported.
                    if (watches.remove(instance) != null) events.lost(instance)
                    events.single("error", JSONObject().put("ev", "nsd_error").put("reason", reasonWord(reason)))
                }
            },
        )
    }

    private fun found(instance: String, r: NsdResolved) {
        if (r.port !in 1..65535 || r.addresses.isEmpty()) {
            // Nothing dialable is left (the last address expired): the name is lost, not kept at its old address.
            events.lost(instance)
            return
        }
        val row = JSONObject()
            .put("ev", "nsd_found")
            .put("instance", instance)
            .put("hosts", JSONArray(r.addresses))
            .put("port", r.port)
            .put("txt", JSONArray(txtOf(r.attributes)))
        events.found(instance, row)
    }

    private fun dropWatch(instance: String) {
        watches.remove(instance)?.let { runCatching { it() } }
        events.lost(instance)
    }

    private fun stopAdvert() {
        advertGen++
        advert?.let { runCatching { it() } }
        advert = null
    }

    private fun stopBrowse() {
        browse?.let { runCatching { it() } }
        browse = null
        for (n in watches.keys.toList()) dropWatch(n)
    }

    private fun stopAll() {
        synchronized(lock) {
            stopAdvert()
            stopBrowse()
            accepted = emptySet()
            events.clear()
        }
    }

    private fun advertEvent(r: NsdAdvertResult): JSONObject = when (r) {
        is NsdAdvertResult.Registered -> JSONObject().put("ev", "nsd_advert").put("ok", true)
        is NsdAdvertResult.Refused -> JSONObject().put("ev", "nsd_advert").put("ok", false).put("reason", reasonWord(r.reason))
    }

    /** One fixed word per failure (never platform text): `renamed`, `failed`, `limit`, or `failed` for the rest. */
    private fun reasonWord(reason: String): String = when (reason) {
        "renamed", "limit" -> reason
        else -> "failed"
    }

    /**
     * The newest state per instance plus single status slots. Bounded by the watch limit and two slots, so
     * nothing a peer does grows it.
     */
    private class Coalesced {
        private val pending = LinkedHashMap<String, JSONObject?>()
        private val emitted = HashMap<String, String>()
        private val singles = LinkedHashMap<String, JSONObject>()

        fun found(instance: String, row: JSONObject) {
            pending[instance] = row
        }

        fun lost(instance: String) {
            // A name nobody was told about needs no loss event.
            if (instance in emitted || pending[instance] != null) pending[instance] = null
        }

        fun single(key: String, event: JSONObject) {
            singles[key] = event
        }

        fun clear() {
            pending.clear()
            emitted.clear()
            singles.clear()
        }

        fun drain(): List<JSONObject> {
            val out = ArrayList<JSONObject>()
            for ((instance, row) in pending) {
                if (row == null) {
                    if (emitted.remove(instance) != null) out += JSONObject().put("ev", "nsd_lost").put("instance", instance)
                } else {
                    val sig = row.toString()
                    if (emitted[instance] != sig) {
                        emitted[instance] = sig
                        out += row
                    }
                }
            }
            pending.clear()
            out += singles.values
            singles.clear()
            return out
        }
    }

    companion object {
        const val MAX_ACCEPTED = 1024
        const val MAX_TXT = 8
        const val MAX_TXT_BYTES = 255

        /** The ACCESS_LOCAL_NETWORK permission and the API that introduced its enforcement. */
        const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
        const val LOCAL_NETWORK_API = 37

        private val INSTANCE = Regex("p1-[a-z2-7]{16}")

        fun isInstanceName(name: String): Boolean = INSTANCE.matches(name)

        /**
         * Whether local-network access needs the runtime permission: only when the device enforces it
         * ([deviceSdk] 37 or later) and the app targets it ([targetSdk] 37 or later).
         */
        fun permissionState(deviceSdk: Int, targetSdk: Int, granted: Boolean): Permission = when {
            deviceSdk < LOCAL_NETWORK_API || targetSdk < LOCAL_NETWORK_API -> Permission.NOT_REQUIRED
            granted -> Permission.GRANTED
            else -> Permission.DENIED
        }

        /** A TXT entry list as the map [PeerNsd] takes, or null when an entry is not plain `key=value` text within the DNS limits. */
        fun parseTxt(list: JSONArray?): Map<String, ByteArray>? {
            if (list == null) return emptyMap()
            if (list.length() > MAX_TXT) return null
            val out = LinkedHashMap<String, ByteArray>()
            for (i in 0 until list.length()) {
                val e = list.opt(i) as? String ?: return null
                if (e.toByteArray(Charsets.UTF_8).size > MAX_TXT_BYTES) return null
                val eq = e.indexOf('=')
                val key = if (eq < 0) e else e.substring(0, eq)
                val value = if (eq < 0) "" else e.substring(eq + 1)
                if (key.isEmpty() || key.any { it.code !in 0x20..0x7e }) return null
                if (out.containsKey(key)) return null
                out[key] = value.toByteArray(Charsets.UTF_8)
            }
            return out
        }

        /** What the OS handed over, as at most [MAX_TXT] `key=value` strings in key order, each within the DNS limit. */
        fun txtOf(attributes: Map<String, ByteArray?>): List<String> {
            val out = ArrayList<String>()
            for (k in attributes.keys.sorted()) {
                if (out.size >= MAX_TXT) break
                val v = attributes[k]
                val text = if (v == null) k else "$k=${String(v, Charsets.UTF_8)}"
                if (text.toByteArray(Charsets.UTF_8).size <= MAX_TXT_BYTES) out += text
            }
            return out
        }
    }

    /** The app's backend: [PeerNsd] on its own thread, the permission read from the context. */
    class Real(private val context: () -> Context) : Backend {
        private val executorLazy = lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "pkey-nsd").apply { isDaemon = true } } }
        private val executor: ExecutorService by executorLazy
        private val nsd: PeerNsd by lazy { PeerNsd(context(), executor) }

        override fun supported(): Boolean = Build.VERSION.SDK_INT >= PeerNsd.MIN_SDK

        override fun permission(): Permission {
            val ctx = context()
            val granted = ctx.checkSelfPermission(LOCAL_NETWORK_PERMISSION) == PackageManager.PERMISSION_GRANTED
            return permissionState(Build.VERSION.SDK_INT, ctx.applicationInfo.targetSdkVersion, granted)
        }

        override fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): Stopper = nsd.advertise(instance, port, txt, onResult).let { h -> { h.stop() } }

        override fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): Stopper = nsd.browse(listener, accept).let { h -> { h.stop() } }

        override fun watch(instance: String, listener: PeerNsdListener): Stopper = nsd.watch(instance, listener).let { h -> { h.stop() } }

        override fun close() {
            if (executorLazy.isInitialized()) executor.shutdown()
        }
    }
}
