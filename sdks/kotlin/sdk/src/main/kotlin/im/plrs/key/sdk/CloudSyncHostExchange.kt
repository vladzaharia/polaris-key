// One request of the machine through the host: seal it (E2E), send it, open the answer, hand both to
// the machine (H-10, HOST-BIND), and the catalog refetch a pull can trigger (H-2).

package im.plrs.key.sdk

import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.HostCodec
import im.plrs.key.core.sync.SyncResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The most exchanges one pump makes, whatever the machine keeps asking for. */
public const val SYNC_MAX_EXCHANGES: Int = 64

internal class CloudSyncHostExchange(private val st: CloudSyncHostState) {
    private val deps get() = st.deps

    /** Whether the person this request was bound to is known and is not the session's person (A-1). */
    private suspend fun otherPerson(bound: String?): Boolean {
        if (bound == null) return false
        val session = deps.subject()
        return session != null && session != bound
    }

    /** One request: seal it (E2E), send it, open the answer, hand both to the machine. */
    suspend fun exchange(m: CloudSyncMachine, req: JsonObject) {
        val e2e = m.encryptionMode() == "e2e"
        val bound = m.subject
        val generation = st.generation
        // S3: a locked ring sends nothing, a pull included. A request bound to another person is never sent.
        val blocked = (e2e && deps.codec.locked) || otherPerson(bound)
        val mutations = ((req["body"] as? JsonObject)?.get("mutations")).arrayValue
        val wire = if (blocked) null else prepared(req, e2e, mutations)
        if (wire == null) {
            m.receive(SyncResponse.TRANSPORT)
        } else {
            val res = try {
                deps.sendFor?.invoke(wire, bound) ?: deps.send(wire)
            } catch (e: CancellationException) {
                // A flush that timed out cancels the call. The machine must hear that nothing was processed, or its
                // request stays in flight for good and nothing is ever sent again.
                withContext(NonCancellable) { if (st.generation == generation) m.receive(SyncResponse.TRANSPORT) }
                throw e
            }
            when {
                // A purge ran while the request was out: the machine is gone, so the answer is never read (H-7).
                st.generation != generation -> Unit

                otherPerson(bound) -> m.receive(SyncResponse.TRANSPORT)

                else -> {
                    st.failures = if (res.transportError) st.failures + 1 else 0
                    answer(m, res, e2e, mutations ?: emptyList())
                }
            }
        }
    }

    /** The request as it goes on the wire (sealed in E2E mode), or null when nothing may be sent. */
    private fun prepared(req: JsonObject, e2e: Boolean, mutations: List<JsonElement>?): JsonObject? {
        if (req["method"] != JsonPrimitive("POST")) return req
        st.noteOwnMutations(mutations?.let { kotlinx.serialization.json.JsonArray(it) })
        return if (e2e) sealed(req, req["body"]) else req
    }

    /** The sealed request, or null when the ring locked or a mutation cannot be sealed: nothing is sent. */
    private fun sealed(req: JsonObject, body: JsonElement?): JsonObject? =
        runCatching { JsonObject(req + ("body" to HostCodec.sealPush(body ?: JsonObject(emptyMap()), deps.codec, st.routes))) }.getOrNull()

    private suspend fun answer(m: CloudSyncMachine, res: SyncResponse, e2e: Boolean, mutations: List<JsonElement>) {
        val isOk = !res.transportError && res.status == STATUS_OK
        if (e2e && isOk && res.body is JsonObject) {
            answerE2e(m, res.body!!, mutations)
        } else {
            // Server mode, an error answer, or no answer: the machine reads it as it is. A 200 that is not an
            // object in E2E mode is dropped.
            m.receive(if (e2e && isOk) SyncResponse.TRANSPORT else res)
            if (isOk && res.body is JsonObject) maybeRefetch(res.body)
        }
    }

    private suspend fun answerE2e(m: CloudSyncMachine, body: JsonElement, mutations: List<JsonElement>) {
        // Locked since the request left, or a repeated mutationId: the answer is dropped and the cursor stays.
        val pulled = runCatching { HostCodec.openPull(body, deps.codec, mutations, st.opts.aliases, st.openKeys.toList()) }.getOrNull()
        if (pulled == null) {
            m.receive(SyncResponse.TRANSPORT)
        } else {
            st.noteOpenedRows(pulled.body, pulled.opened)
            m.receive(SyncResponse(STATUS_OK, pulled.body), pulled.opened)
            maybeRefetch(pulled.body)
        }
    }

    /** A pull that names another `catalogVersion` than the catalog held: fetch it again, once (H-2). */
    private suspend fun maybeRefetch(body: JsonElement?) {
        val v = ((body as? JsonObject)?.get("catalogVersion")).longValue ?: return
        if (v != st.catalog["schemaVersion"].longValue && v != st.triedVersion) refetch(v)
    }

    /** Rate-limited, and counted in the pump's budget like any other request. */
    suspend fun refetch(version: Long?) {
        val now = deps.clock()
        val last = st.lastFetchAt
        val allowed = st.used < SYNC_MAX_EXCHANGES && (last == null || now - last >= CATALOG_REFETCH_MS)
        if (allowed) {
            st.lastFetchAt = now
            st.triedVersion = version
            st.used += 1
            CloudSyncCatalog.vetted(runCatching { deps.fetchSchema() }.getOrNull())?.let { take(it) }
        }
    }

    private fun take(fetched: JsonObject) {
        if (fetched.toString() == st.served.toString()) return
        val before = CloudSyncCatalog.routesOf(st.catalog)
        st.served = fetched
        // Rebuild only when the routes the machine uses would change.
        val effective = CloudSyncCatalog.effective(st.mirror, st.served, st.openKeys)
        if (CloudSyncCatalog.routesOf(effective) == before) {
            st.catalog = effective
        } else {
            st.rebuildWanted = true
            st.again = true
        }
    }

    private companion object {
        const val STATUS_OK = 200
    }
}
