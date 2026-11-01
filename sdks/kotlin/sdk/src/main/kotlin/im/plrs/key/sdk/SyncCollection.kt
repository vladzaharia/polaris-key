// The records handle of a Cloud Sync collection (plans/C-26 D-2, U-46): `client.cloudSync.collection(name)` over the
// machine, with the catalog checks made before anything is journalled. A refused call changes nothing and sends
// nothing. The refusals are the registered wire codes (errors.json): `collection_unknown` for a name the catalog does not
// declare, `op_invalid_for_policy` for a verb the collection's policy does not allow, `value_invalid` for a value or name
// over a cap. A refusal is returned, never thrown.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.SYNC_MAX_UNION_ELEMENT_BYTES
import im.plrs.key.core.sync.CallResult
import im.plrs.key.core.sync.CanonicalJson
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.PutAtResult
import im.plrs.key.core.sync.ReadResult
import im.plrs.key.core.sync.RecordOutcome
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCryptoException
import im.plrs.key.core.sync.SyncEvent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** Why a call was refused; [code] is the registered wire code (`signed_out` is local only). */
public enum class CollectionError(public val code: String) {
    CollectionUnknown(ErrorCode.collectionUnknown),
    OpInvalidForPolicy(ErrorCode.opInvalidForPolicy),
    ValueInvalid(ErrorCode.valueInvalid),
    SignedOut("signed_out"),
}

/** What a collection call answers: [Ok] (with the ticket of a compare-and-set, which reports an outcome), or [Refused]. */
public sealed interface CollectionResult {
    public data class Ok(val mutationId: Long? = null) : CollectionResult

    public data class Refused(val error: CollectionError) : CollectionResult
}

/** The base of a `revision` compare-and-set: an exact version, or [Absent] (`"*"`): create only. */
public sealed interface IfVersion {
    public data class At(val version: Long) : IfVersion

    public data object Absent : IfVersion
}

private fun IfVersion.toJson(): JsonElement = when (this) {
    is IfVersion.At -> JsonPrimitive(version)
    IfVersion.Absent -> JsonPrimitive("*")
}

/** What a collection listener is told. */
public sealed interface CollectionEvent {
    /** These records changed (ids in byte order); [origin] is `local` or `remote`. */
    public data class Change(val ids: List<String>, val origin: String) : CollectionEvent

    /** The result of a compare-and-set `put` or `delete`, under the ticket it returned. */
    public data class Outcome(val outcome: RecordOutcome) : CollectionEvent
}

/** A registered listener; [cancel] stops it. */
public class CollectionSubscription internal constructor(private val stop: suspend () -> Unit) {
    public suspend fun cancel() {
        stop()
    }
}

/** The handle `client.cloudSync.collection(name)` returns. */
@Suppress("TooManyFunctions")
public class SyncCollection internal constructor(public val name: String, private val host: CloudSyncHost) {
    private val listeners = CopyOnWriteArrayList<(CollectionEvent) -> Unit>()
    private val tickets: MutableSet<Long> = ConcurrentHashMap.newKeySet()
    private var unsubscribe: (() -> Unit)? = null
    private var untap: (() -> Unit)? = null

    /** The collection's policy (`lastWrite`, `max`, `min`, `revision`, `merge` or `union`), or null when the catalog does not declare it. */
    public suspend fun policy(): String? = host.withMachine { it.collectionDecl(name)?.policy }

    /**
     * The effective value (pending edits over the cloud copy) and where it came from, or null. An undeclared name is null;
     * stored JSON comes back untouched, so a field this version does not know survives.
     */
    public suspend fun get(id: String): ReadResult? = host.withMachine { m -> if (m.collectionDecl(name) == null) null else m.record(name, id) }

    /** The ids of the records a person holds, in byte order, pending creates included. */
    public suspend fun ids(): List<String> = host.withMachine { m ->
        if (m.collectionDecl(name) == null) {
            emptyList()
        } else {
            // E2E: a record that holds a file and no value is listed under its wire id; it has no name.
            val e2e = m.encryptionMode() == "e2e"
            m.recordIds(name).filter { !(e2e && SyncBlind.isBlindedName(it)) }
        }
    }

    /**
     * `lastWrite`, `max`, `min`: a stamped write. `revision`: a write based on the version held, or on [ifVersion] as an
     * exact compare-and-set, whose outcome goes to the listener as [CollectionEvent.Outcome].
     */
    public suspend fun put(id: String, value: JsonElement, ifVersion: IfVersion? = null): CollectionResult {
        val r = apply(id, { it in PUT_POLICIES }) { m, policy ->
            when {
                ifVersion != null && policy != "revision" -> refused(CollectionError.OpInvalidForPolicy)
                ifVersion != null -> exact(m.putAt(name, id, value, ifVersion.toJson()))
                else -> done(m.put(name, id, value))
            }
        }
        return touched(r)
    }

    /** `merge`: write the fields in [set] and drop the ones in [remove]. Others stay as stored. */
    public suspend fun update(id: String, set: Map<String, JsonElement> = emptyMap(), remove: List<String> = emptyList()): CollectionResult {
        val names = set.keys.toList() + remove
        val r = apply(id, { it == "merge" }) { m, _ ->
            val bad = names.isEmpty() || names.toSet().size != names.size ||
                names.any { it.isEmpty() || it.toByteArray(Charsets.UTF_8).size > MAX_FIELD_BYTES }
            if (bad) refused(CollectionError.ValueInvalid) else done(m.update(name, id, set, remove))
        }
        return touched(r)
    }

    /** `union`: add an element (at most 1 KiB of canonical JSON). */
    public suspend fun add(id: String, element: JsonElement): CollectionResult = elementOp(id, element, add = true)

    /** `union`: remove an element, observed at the current cursor. */
    public suspend fun remove(id: String, element: JsonElement): CollectionResult = elementOp(id, element, add = false)

    /**
     * Delete the record. For `revision`, [ifVersion] is the compare-and-set base (default: the version held, else
     * [IfVersion.Absent]); it is refused for any other policy.
     */
    public suspend fun delete(id: String, ifVersion: IfVersion? = null): CollectionResult {
        val r = apply(id, { true }) { m, policy ->
            when {
                policy == "revision" -> {
                    val base = ifVersion ?: m.records(name).firstOrNull { it.id == id }?.let { IfVersion.At(it.version) } ?: IfVersion.Absent
                    exact(m.removeAt(name, id, base.toJson()))
                }

                ifVersion != null -> refused(CollectionError.OpInvalidForPolicy)

                else -> done(m.delete(name, id))
            }
        }
        return touched(r)
    }

    /**
     * Changes to this collection, including the ones this device makes. The listener runs on a worker context for a
     * change, and inside the host for an outcome, so it must not call the machine.
     */
    public suspend fun on(listener: (CollectionEvent) -> Unit): CollectionSubscription {
        listeners.add(listener)
        watch()
        return CollectionSubscription {
            listeners.remove(listener)
            if (listeners.isEmpty()) unwatch()
        }
    }

    // ── internals ────────────────────────────────────────────────────────────────────────────

    private suspend fun apply(id: String, allowed: (String) -> Boolean, block: (CloudSyncMachine, String) -> CollectionResult): CollectionResult =
        host.withMachine { m ->
            val policy = m.collectionDecl(name)?.policy
            when {
                policy == null -> refused(CollectionError.CollectionUnknown)
                !allowed(policy) -> refused(CollectionError.OpInvalidForPolicy)
                id.isEmpty() -> refused(CollectionError.ValueInvalid)
                else -> block(m, policy)
            }
        }

    private suspend fun elementOp(id: String, element: JsonElement, add: Boolean): CollectionResult {
        val r = apply(id, { it == "union" }) { m, _ ->
            val size = try {
                CanonicalJson.encodeBytes(element).size
            } catch (_: SyncCryptoException) {
                Int.MAX_VALUE
            }
            when {
                size > SYNC_MAX_UNION_ELEMENT_BYTES -> refused(CollectionError.ValueInvalid)
                add -> done(m.add(name, id, element))
                else -> done(m.remove(name, id, element))
            }
        }
        return touched(r)
    }

    private fun refused(e: CollectionError): CollectionResult = CollectionResult.Refused(e)

    private fun done(r: CallResult): CollectionResult = when (r) {
        CallResult.Ok -> CollectionResult.Ok()
        is CallResult.Failed -> fail(r.error)
    }

    private fun exact(r: PutAtResult): CollectionResult = when (r) {
        is PutAtResult.Ok -> {
            // Outcomes are reported to a listener, so a ticket is kept only while one is registered.
            if (listeners.isNotEmpty()) tickets.add(r.mutationId)
            CollectionResult.Ok(r.mutationId)
        }

        is PutAtResult.Failed -> fail(r.error)
    }

    private fun fail(error: String): CollectionResult =
        refused(if (error == "signed-out") CollectionError.SignedOut else CollectionError.CollectionUnknown)

    /** After a verb that took effect the host reports the events and wakes its pump; a refusal does neither. */
    private fun touched(r: CollectionResult): CollectionResult {
        if (r is CollectionResult.Ok) host.kick()
        return r
    }

    private suspend fun watch() {
        host.withMachine { m ->
            if (unsubscribe != null) return@withMachine
            m.watchRecords(name, true)
            unsubscribe = host.onEvents { events ->
                for (e in events) if (e is SyncEvent.Records && e.collection == name) emit(CollectionEvent.Change(e.ids, e.origin))
            }
            untap = m.tapOutcomes { o -> if (tickets.remove(o.mutationId)) emit(CollectionEvent.Outcome(o)) }
        }
    }

    private suspend fun unwatch() {
        host.withMachine { m ->
            unsubscribe?.invoke()
            untap?.invoke()
            unsubscribe = null
            untap = null
            m.watchRecords(name, false)
        }
    }

    private fun emit(e: CollectionEvent) {
        for (fn in listeners) runCatching { fn(e) }
    }

    private companion object {
        /** A merge field name: non-empty, at most 1 KiB (section 13.3). */
        const val MAX_FIELD_BYTES = 1024
        val PUT_POLICIES = setOf("lastWrite", "max", "min", "revision")
    }
}
