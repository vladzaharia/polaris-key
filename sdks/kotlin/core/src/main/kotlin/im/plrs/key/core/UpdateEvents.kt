// The update-health journal (notes/SDK-PARITY-PASS.md §3.13; P6-03): the persisted queue of update
// outcome events a device reports in the `updates` key of `POST /<p>/devices/report`, so staged-
// rollout auto-halt sees this fleet. The shape is the Worker's allowlist (`W/core/updateHealth.ts`):
//
//     {eventId, event, deliverable, release, fromRelease?, outlet, channel, packSetId?, at, code?}
//
// `event` is one of the seven `updateEvent` values (`conformance/parity/enums.json`, generated into
// `UpdateEvent`). At most MAX_UPDATE_EVENTS (16) go per report; the rest wait for the next one. A
// report that the Worker accepted marks the events it carried as sent (they leave the queue); one
// that failed keeps them, and the Worker counts a resent `eventId` once. The queue keeps the newest
// MAX_JOURNAL events, dropping the oldest past that (as Godot's `PKeySlots.MAX_EVENTS`).
//
// Unsigned, SDK-owned state: it lives in its own file beside the token store (`Store.stateDirectory`),
// never in the verified cache, which holds signed JWSs only (§4.1). Privacy (docs/PRIVACY.md): release
// identifiers, an outlet, a channel, a time and a short error code — no hardware value.

package im.plrs.key.core

import java.io.File
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The id an update-health event names a release by: the release record's `tag` when it names one,
 * else its version. The Worker counts an event only when `release` is a releaseId its Release catalog
 * declares (`W/core/updateHealth.ts`), and a tagged release's releaseId is its tag (Godot's
 * `PKeyUpdater.release_id`).
 */
public fun releaseId(version: String, tag: String?): String = tag?.takeIf { it.isNotEmpty() } ?: version

/** This record's update-health release id ([releaseId]). */
public val ReleaseRecordDoc.releaseId: String get() = releaseId(version, tag)

/** One small piece of SDK-owned state, read whole and replaced atomically. */
public interface StateSlot {
    public fun read(): String?
    public fun write(text: String)
}

/** A [StateSlot] in memory (tests, a store with no state directory). */
public class MemoryStateSlot(initial: String? = null) : StateSlot {
    @Volatile private var text: String? = initial
    override fun read(): String? = text
    override fun write(text: String) {
        this.text = text
    }
}

/**
 * A [StateSlot] in one file: temp + rename, so a crash leaves the old text or the new, never half.
 * Blocking: call it off the main thread (the SDK's own callers do, SP-50).
 */
public class FileStateSlot(public val file: File) : StateSlot {
    override fun read(): String? = try {
        if (file.isFile) file.readText(Charsets.UTF_8) else null
    } catch (e: IOException) {
        null
    }

    override fun write(text: String) {
        val dir = file.absoluteFile.parentFile
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw StoreException("could not create $dir")
        val tmp = File(dir, ".${file.name}.${UUID.randomUUID()}.tmp")
        if (RuntimeFamily.isAndroid) {
            // java.nio.file arrives on API 26 (the SDK's minSdk is 24); a POSIX rename replaces the
            // target atomically, which is all ATOMIC_MOVE adds here.
            try {
                tmp.writeText(text, Charsets.UTF_8)
            } catch (e: IOException) {
                tmp.delete()
                throw StoreException("could not write $file", e)
            }
            if (!tmp.renameTo(file)) {
                tmp.delete()
                throw StoreException("could not replace $file")
            }
            return
        }
        try {
            Files.write(tmp.toPath(), text.toByteArray(Charsets.UTF_8))
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: IOException) {
            tmp.delete()
            throw StoreException("could not write $file", e)
        }
    }
}

/** One `updates` entry, as the Worker's allowlist reads it. */
public data class UpdateEventEntry(
    val eventId: String,
    /** An [UpdateEvent] value. */
    val event: String,
    /** `app` for the application build, the pack id for a pack. */
    val deliverable: String,
    /** The release the event is about (its version or tag). */
    val release: String,
    val fromRelease: String? = null,
    /** The outlet id or kind, `unknown` when none is known. */
    val outlet: String,
    val channel: String,
    val packSetId: String? = null,
    /** Epoch seconds. */
    val at: Long,
    /** A short registry code for a failure. */
    val code: String? = null,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("eventId", JsonPrimitive(eventId))
            put("event", JsonPrimitive(event))
            put("deliverable", JsonPrimitive(deliverable))
            put("release", JsonPrimitive(release))
            fromRelease?.let { put("fromRelease", JsonPrimitive(it)) }
            put("outlet", JsonPrimitive(outlet))
            put("channel", JsonPrimitive(channel))
            packSetId?.let { put("packSetId", JsonPrimitive(it)) }
            put("at", jsonInt(at))
            code?.let { put("code", JsonPrimitive(it)) }
        }

    public companion object {
        private val EVENT_ID = Regex("^[A-Za-z0-9._:-]{1,64}$")
        private val DELIVERABLE = Regex("^(?=.{1,64}$)[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$")
        private val RELEASE = Regex("^[A-Za-z0-9._+@:/-]{1,128}$")
        private val OUTLET = Regex("^[a-z][a-z0-9-]{0,63}$")
        private val CHANNEL = Regex("^[a-z0-9][a-z0-9-]{0,63}$")
        private val PACK_SET = Regex("^[A-Za-z0-9._:-]{1,128}$")
        private val CODE = Regex("^[A-Za-z0-9._:-]{1,64}$")

        /** An entry the Worker would keep, or null (the Worker's `boundedEntry`, so nothing is sent to be dropped). */
        public fun from(e: JsonElement?): UpdateEventEntry? {
            val o = e.objectValue ?: return null
            fun s(k: String, re: Regex): String? = o[k].stringValue?.takeIf { re.matches(it) }
            fun opt(k: String, re: Regex): Pair<Boolean, String?> {
                if (!o.containsKey(k)) return true to null
                val v = s(k, re) ?: return false to null
                return true to v
            }
            val event = o["event"].stringValue?.takeIf { it in UPDATE_EVENT_VALUES } ?: return null
            val at = o["at"].longValue?.takeIf { it > 0 } ?: return null
            val from = opt("fromRelease", RELEASE).takeIf { it.first } ?: return null
            val packSet = opt("packSetId", PACK_SET).takeIf { it.first } ?: return null
            val code = opt("code", CODE).takeIf { it.first } ?: return null
            return UpdateEventEntry(
                eventId = s("eventId", EVENT_ID) ?: return null,
                event = event,
                deliverable = s("deliverable", DELIVERABLE) ?: return null,
                release = s("release", RELEASE) ?: return null,
                fromRelease = from.second,
                outlet = s("outlet", OUTLET) ?: return null,
                channel = s("channel", CHANNEL) ?: return null,
                packSetId = packSet.second,
                at = at,
                code = code.second,
            )
        }

        /** [raw] trimmed to the release alphabet (a version always fits; anything else is cut). */
        internal fun releaseOf(raw: String): String? = raw.filter { it.isLetterOrDigit() && it.code < 0x80 || it in "._+@:/-" }.take(128).ifEmpty { null }

        /** [raw] as an outlet value, or `unknown`. */
        internal fun outletOf(raw: String?): String = raw?.takeIf { OUTLET.matches(it) } ?: OUTLET_UNKNOWN

        internal fun channelOf(raw: String): String = raw.takeIf { CHANNEL.matches(it) } ?: CHANNEL_STABLE

        internal fun deliverableOf(raw: String): String? = raw.takeIf { DELIVERABLE.matches(it) }

        internal fun codeOf(raw: String?): String? = raw?.filter { it.isLetterOrDigit() && it.code < 0x80 || it in "._:-" }?.take(64)?.ifEmpty { null }
    }
}

/** At most this many events ride one report (the Worker's `MAX_UPDATE_EVENTS`). */
public const val MAX_UPDATE_EVENTS: Int = 16

/** The persisted update-event queue (§3.13). Thread-safe; every failure to persist is swallowed. */
public class UpdateEventJournal(
    private val slot: StateSlot,
    /** Epoch seconds. */
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    /** What every event names when the emitter does not: the outlet and channel (the facade wires them). */
    @Volatile public var context: () -> Pair<String?, String> = { null to CHANNEL_STABLE }

    private val lock = Any()
    private val random = SecureRandom()

    /** The queued events, oldest first. */
    public fun events(): List<UpdateEventEntry> = synchronized(lock) { load() }

    /**
     * Queue one event. [deliverable] is `app` or a pack id; [release] the release the event is about:
     * its [releaseId] (the record's tag when it names one, else the version). Values outside the Worker's alphabets are normalised or the event is dropped (never
     * sent to be refused). Returns the entry, or null when it was dropped.
     */
    public fun record(
        event: String,
        release: String,
        deliverable: String = "app",
        fromRelease: String? = null,
        code: String? = null,
        packSetId: String? = null,
    ): UpdateEventEntry? {
        if (event !in UPDATE_EVENT_VALUES) return null
        val (outlet, channel) = try {
            context()
        } catch (e: Exception) {
            null to CHANNEL_STABLE
        }
        val rel = UpdateEventEntry.releaseOf(release) ?: return null
        val entry = UpdateEventEntry(
            eventId = newId(event),
            event = event,
            deliverable = UpdateEventEntry.deliverableOf(deliverable) ?: return null,
            release = rel,
            fromRelease = fromRelease?.let { UpdateEventEntry.releaseOf(it) }?.takeIf { it != rel },
            outlet = UpdateEventEntry.outletOf(outlet),
            channel = UpdateEventEntry.channelOf(channel),
            packSetId = packSetId?.takeIf { Regex("^[A-Za-z0-9._:-]{1,128}$").matches(it) },
            at = clock().coerceAtLeast(1),
            code = UpdateEventEntry.codeOf(code),
        )
        synchronized(lock) {
            val events = load().toMutableList()
            events += entry
            while (events.size > MAX_JOURNAL) events.removeAt(0)
            save(events)
        }
        return entry
    }

    /**
     * Queue [event] unless the newest queued or sent event of the same kind for the same deliverable
     * already names [release] (an offer seen on every launch is one offer).
     */
    public fun recordOnce(event: String, release: String, deliverable: String = "app", fromRelease: String? = null): UpdateEventEntry? {
        val key = "$event|$deliverable|$release"
        synchronized(lock) {
            if (lastOnce() == key) return null
        }
        val e = record(event, release, deliverable, fromRelease) ?: return null
        synchronized(lock) { slotOnce(key) }
        return e
    }

    /** The events the next report carries: the oldest [MAX_UPDATE_EVENTS]. */
    public fun pending(): List<UpdateEventEntry> = events().take(MAX_UPDATE_EVENTS)

    /** Drop the events a report delivered. */
    public fun markSent(eventIds: Collection<String>) {
        if (eventIds.isEmpty()) return
        synchronized(lock) {
            val events = load()
            val keep = events.filter { it.eventId !in eventIds }
            if (keep.size != events.size) save(keep)
        }
    }

    private fun newId(event: String): String {
        val b = ByteArray(8).also { random.nextBytes(it) }
        return b.joinToString("") { "%02x".format(it) } + "-" + event
    }

    @Volatile private var once: String? = null

    private fun lastOnce(): String? = once ?: readState()["once"].stringValue.also { once = it }

    private fun slotOnce(key: String) {
        once = key
        save(load(), key)
    }

    private fun readState(): JsonObject = slot.read()?.let { JsonText.parseOrNull(it) }.objectValue ?: JsonObject(emptyMap())

    private fun load(): List<UpdateEventEntry> {
        val st = readState()
        if (st["v"].longValue != 1L) return emptyList()
        return st["events"].arrayValue?.mapNotNull { UpdateEventEntry.from(it) } ?: emptyList()
    }

    private fun save(events: List<UpdateEventEntry>, onceKey: String? = once) {
        val body = buildJsonObject {
            put("v", jsonInt(1))
            put("events", JsonArray(events.map { it.json }))
            onceKey?.let { put("once", JsonPrimitive(it)) }
        }
        try {
            slot.write(body.toString())
        } catch (e: Exception) {
            // Telemetry never costs the host anything; the events live in memory until the next write.
        }
    }

    public companion object {
        /** The queue keeps the newest this many events. */
        public const val MAX_JOURNAL: Int = 64
    }
}
