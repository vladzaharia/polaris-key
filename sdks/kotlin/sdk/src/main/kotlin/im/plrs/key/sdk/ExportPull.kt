// What the Worker holds, as the export reads it (WIRE-CONTRACT-V5 section 13.12, "What is read"): a pull from cursor 0 and every
// page that follows (`more`), a later row replacing an earlier one and a tombstone removing it. At most `SYNC_EXPORT_MAX_PULLS`
// pulls; a `429`'s `Retry-After` and a retry's backoff are waits of the export's budget; one request is tried at most eight times.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.SYNC_EXPORT_MAX_PULLS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncExportException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MAX_ATTEMPTS = 8
private const val BACKOFF_BASE = 0.5
private const val BACKOFF_CAP = 30.0
private const val STATUS_OK = 200
private const val STATUS_FORBIDDEN = 403
private const val STATUS_TIMEOUT = 408
private const val STATUS_TOO_MANY = 429
private const val STATUS_SERVER_ERROR = 500

internal class ExportPull(private val core: CoreContext, private val bound: String, private val budget: ExportBudget) {
    private fun network() = SyncExportException(SyncExportException.NETWORK)

    private fun accountRequired() = PolarisException(ErrorCode.accountRequired, "Cloud Sync needs a signed-in account")

    /** The raw answer to one `GET` of a sync route; nothing sent (no token, or another person's) is `account_required`. */
    private suspend fun send(path: String): PolarisResponse {
        val req = buildJsonObject {
            put("method", "GET")
            put("path", path)
        }
        return CloudSyncTransport.exchange(core, req, bound) ?: throw accountRequired()
    }

    /** Throws for an answer no retry can fix; returns for one worth another try. */
    private fun refuseUnlessRetryable(res: PolarisResponse) {
        if (res.status == STATUS_FORBIDDEN && res.text.contains(ErrorCode.accountRequired)) throw accountRequired()
        val retryable = res.status == STATUS_TIMEOUT || res.status == STATUS_TOO_MANY || res.status >= STATUS_SERVER_ERROR
        if (!retryable) throw network()
    }

    /** One `GET` of a sync route with the bounded retries: the answer's JSON object. */
    private suspend fun get(path: String): JsonObject {
        var attempt = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            val res = send(path)
            val body = if (res.status == STATUS_OK) CloudSyncTransport.answer(res.status, res.body).body.objectValue ?: throw network() else null
            if (body != null) return body
            refuseUnlessRetryable(res)
            attempt++
            if (attempt >= MAX_ATTEMPTS) throw network()
            val told = parseRetryAfter(res.header("retry-after"))
            budget.sleep(told ?: minOf(BACKOFF_CAP, BACKOFF_BASE * Math.pow(2.0, (attempt - 1).toDouble())))
        }
    }

    /** The rows the Worker holds, as served: settings first, then records. */
    suspend fun all(clientId: String): List<JsonElement> {
        val settings = LinkedHashMap<String, JsonObject>()
        val records = LinkedHashMap<Pair<String, String>, JsonObject>()
        var cursor = 0L
        repeat(SYNC_EXPORT_MAX_PULLS) {
            val body = get("/${core.product}/sync?cursor=$cursor&clientId=$clientId")
            body["changes"].arrayValue?.mapNotNull { it.objectValue }?.forEach { take(it, settings, records) }
            body["tombstones"].arrayValue?.mapNotNull { it.objectValue }?.forEach { drop(it, settings, records) }
            if (body["more"].boolValue != true) return settings.values + records.values
            val next = (body["cursor"] as? JsonPrimitive)?.takeIf { !it.isString }?.longValue
            if (next == null || next <= cursor) throw network()
            cursor = next
        }
        // More pages than the bound allows: the export does not wait for ever on a Worker that never ends.
        throw network()
    }

    private fun refOf(c: JsonObject): Pair<String, String>? {
        val r = c["record"].arrayValue ?: return null
        val a = r.getOrNull(0).stringValue
        val b = r.getOrNull(1).stringValue
        return if (r.size >= 2 && a != null && b != null) a to b else null
    }

    private fun take(c: JsonObject, settings: MutableMap<String, JsonObject>, records: MutableMap<Pair<String, String>, JsonObject>) {
        val name = c["setting"].stringValue
        if (name != null) settings[name] = c else refOf(c)?.let { records[it] = c }
    }

    private fun drop(t: JsonObject, settings: MutableMap<String, JsonObject>, records: MutableMap<Pair<String, String>, JsonObject>) {
        t["setting"].stringValue?.let { settings.remove(it) }
        refOf(t)?.let { records.remove(it) }
    }
}
