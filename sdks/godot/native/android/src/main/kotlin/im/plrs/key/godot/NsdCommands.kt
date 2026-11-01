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
 * - `nsd_status`: `{supported, permission, slots}` where permission is `not_required`, `granted` or `denied`,
 *   and `slots` is true when the ops below take a slot (an older plugin has no such field).
 * - `nsd_advertise {slot?, instance, port, txt}`: publish (or move the running advert of that slot to a new
 *   name). `slot` is `a` (the default), `v`, `p` or `c0` to `c7`: at most 11 registrations over [PeerNsd],
 *   all on the caller's port. The outcome arrives as the event `nsd_advert {slot, ok, reason?}`. A second
 *   call on a slot replaces that slot's advert only.
 * - `nsd_advertise_stop {slot?}` (no slot: `a`), `nsd_browse_start`, `nsd_browse_stop`, `nsd_stop_all`.
 * - `nsd_accept {names, tags?}`: the instance names this device would accept. Until the first call nothing is
 *   accepted. A name outside the set is dropped before it takes a table slot, a watch or an event, so a
 *   forged name costs nothing. `tags` is `{v: [h, h], p: [h, h]}` (at most 2 per kind, each 16 of `0-9a-f`):
 *   while it is not empty, a well-formed name outside `names` is watched (at most [MAX_CANDIDATES] such
 *   names) and kept only when its TXT has `m=<kind>` and an `h` in `tags[kind]`. A bad list of either
 *   kind clears both sets (nothing accepted) and answers `bad_input`.
 *
 * Events ride `poll`, as `nsd_found {instance, hosts, port, txt}` (every address the OS resolved, the
 * dialable kinds first), `nsd_lost {instance}`, `nsd_advert` and `nsd_error {reason}`. They are
 * coalesced per instance (the newest state of a name wins), so the buffer holds at most the watched names
 * plus the status slots (one per advert slot, and the error), and an event is never lost to a busy network: it is replaced by a newer one.
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
    private var tags: Map<String, Set<String>> = emptyMap()

    /** Names outside the roster that the tag browse let in (watched, or rejected and kept out until lost). */
    private val candidates = HashSet<String>()

    /** The candidates whose TXT did not match: not watched again until they go. */
    private val rejected = LinkedHashSet<String>()
    private val adverts = HashMap<String, Advert>()
    private var advertGen = 0
    private var browse: Stopper? = null
    private val watches = HashMap<String, Stopper>()
    private val events = Coalesced()

    private class Advert(val stop: Stopper, val gen: Int)

    fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "nsd_status" -> JSONObject().put("ok", true).put("supported", backend.supported()).put("permission", backend.permission().word).put("slots", true)
        "nsd_advertise" -> guarded { advertise(q) }
        "nsd_advertise_stop" -> {
            val slot = q.optString("slot", "a")
            if (!isSlot(slot)) {
                Commands.fail("bad_input", null)
            } else {
                synchronized(lock) { stopAdvert(slot) }
                JSONObject().put("ok", true)
            }
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
        val slot = q.optString("slot", "a")
        val instance = q.optString("instance")
        val port = q.optInt("port", 0)
        if (!isSlot(slot) || !isInstanceName(instance) || port !in 1..65535) return Commands.fail("bad_input", null)
        val txt = parseTxt(q.optJSONArray("txt")) ?: return Commands.fail("bad_input", null)
        synchronized(lock) {
            stopAdvert(slot)
            val gen = ++advertGen
            val stop = backend.advertise(instance, port, txt) { result ->
                synchronized(lock) {
                    // An answer for an advert that was since replaced or stopped says nothing about the current one.
                    if (adverts[slot]?.gen == gen) {
                        events.single("advert:$slot", advertEvent(slot, result))
                        if (result is NsdAdvertResult.Refused) stopAdvert(slot)
                    }
                }
            }
            adverts[slot] = Advert(stop, gen)
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
        val parsed = if (good) parseTags(q.opt("tags")) else null
        if (parsed == null) good = false
        synchronized(lock) {
            val next: Set<String> = if (good) names else emptySet()
            val nextTags: Map<String, Set<String>> = if (good) parsed!! else emptyMap()
            if (next != accepted || nextTags != tags) {
                accepted = next
                tags = nextTags
                if (browse != null) {
                    // Names that left the set go now, and so do the watches on candidates (the new browse reports
                    // them again); names that joined need the OS to report them again, which a fresh discovery
                    // does for every service already on the network.
                    for (n in watches.keys.toList()) if (n !in next) dropWatch(n)
                    clearCandidates()
                    runCatching { browse?.invoke() }
                    browse = null
                    // The permission may have been withdrawn since the browse started: judge it again.
                    if (gate() == null) browse = runCatching { openBrowse() }.getOrNull()
                    if (browse == null) for (n in watches.keys.toList()) dropWatch(n)
                } else {
                    clearCandidates()
                }
            }
        }
        return if (good) JSONObject().put("ok", true) else Commands.fail("bad_input", null)
    }

    // ── state (under the lock) ───────────────────────────────────────────────────────────────

    private fun openBrowse(): Stopper = backend.browse(
        object : PeerNsdListener {
            override fun onFound(instance: String) = synchronized(lock) { watch(instance) }

            override fun onLost(instance: String) = synchronized(lock) {
                dropWatch(instance)
                candidates.remove(instance)
                rejected.remove(instance)
                Unit
            }

            override fun onFailed(reason: String) = synchronized(lock) { events.single("error", JSONObject().put("ev", "nsd_error").put("reason", reasonWord(reason))) }
        },
    ) { name -> synchronized(lock) { name in accepted || admitCandidate(name) } }

    private fun clearCandidates() {
        candidates.clear()
        rejected.clear()
    }

    /** Whether a name outside the roster may take a table slot: only while tags are set, and within the bound. */
    private fun admitCandidate(name: String): Boolean {
        if (tags.isEmpty() || !isInstanceName(name)) return false
        if (name in candidates) return true
        if (name in rejected) return false
        if (candidates.size >= MAX_CANDIDATES) return false
        candidates += name
        return true
    }

    private fun watch(instance: String) {
        // The name filter ran before this, but the set may have changed since: judge again.
        val known = instance in accepted || (tags.isNotEmpty() && instance in candidates)
        if (!known || watches.containsKey(instance) || instance in rejected) return
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
        if (instance !in accepted && !tagMatch(r.attributes)) {
            // A candidate whose TXT is not an advert we look for: not reported, not watched, and kept out until it goes.
            // Its slot is freed: only names whose tag matched keep counting toward the candidate bound.
            candidates.remove(instance)
            rejected += instance
            while (rejected.size > MAX_REJECTED) rejected.remove(rejected.first())
            dropWatch(instance)
            return
        }
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

    /** Whether a TXT says `m=<kind>` with an `h` that is one of the tags set for that kind. */
    private fun tagMatch(attributes: Map<String, ByteArray?>): Boolean {
        val kind = attributes["m"]?.let { String(it, Charsets.UTF_8) } ?: return false
        val h = attributes["h"]?.let { String(it, Charsets.UTF_8) } ?: return false
        return tags[kind]?.contains(h) == true
    }

    private fun dropWatch(instance: String) {
        watches.remove(instance)?.let { runCatching { it() } }
        events.lost(instance)
    }

    private fun stopAdvert(slot: String) {
        adverts.remove(slot)?.let { runCatching { it.stop() } }
    }

    private fun stopBrowse() {
        browse?.let { runCatching { it() } }
        browse = null
        for (n in watches.keys.toList()) dropWatch(n)
        clearCandidates()
    }

    private fun stopAll() {
        synchronized(lock) {
            for (slot in adverts.keys.toList()) stopAdvert(slot)
            stopBrowse()
            accepted = emptySet()
            tags = emptyMap()
            clearCandidates()
            events.clear()
        }
    }

    private fun advertEvent(slot: String, r: NsdAdvertResult): JSONObject = when (r) {
        is NsdAdvertResult.Registered -> JSONObject().put("ev", "nsd_advert").put("slot", slot).put("ok", true)
        is NsdAdvertResult.Refused -> JSONObject().put("ev", "nsd_advert").put("slot", slot).put("ok", false).put("reason", reasonWord(r.reason))
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

        /** Names outside the roster that a tag browse may hold at once (half of PeerNsd's 64 watches). */
        const val MAX_CANDIDATES = 32

        /** Names kept out until the OS reports them gone; the oldest are forgotten past this. */
        const val MAX_REJECTED = 256
        const val MAX_TAGS = 2
        const val TAG_LENGTH = 16
        const val MAX_TXT = 8
        const val MAX_TXT_BYTES = 255

        /** The ACCESS_LOCAL_NETWORK permission and the API that introduced its enforcement. */
        const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
        const val LOCAL_NETWORK_API = 37

        private val INSTANCE = Regex("p1-[a-z2-7]{16}")
        private val SLOT = Regex("[avp]|c[0-7]")
        private val TAG = Regex("[0-9a-f]{16}")

        fun isSlot(slot: String): Boolean = SLOT.matches(slot)

        /** `{v: [h…], p: [h…]}` as sets, or null when it is anything else. An absent value is no tags. */
        fun parseTags(value: Any?): Map<String, Set<String>>? {
            if (value == null || value == JSONObject.NULL) return emptyMap()
            val o = value as? JSONObject ?: return null
            val out = HashMap<String, Set<String>>()
            for (k in o.keys()) {
                if (k != "v" && k != "p") return null
                val list = o.optJSONArray(k) ?: return null
                if (list.length() > MAX_TAGS) return null
                val set = HashSet<String>()
                for (i in 0 until list.length()) {
                    val h = list.opt(i) as? String ?: return null
                    if (!TAG.matches(h)) return null
                    set += h
                }
                if (set.isNotEmpty()) out[k] = set
            }
            return out
        }

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
