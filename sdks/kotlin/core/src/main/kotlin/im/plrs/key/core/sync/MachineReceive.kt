// The transport's answer to the request in flight (Python `receive`): what each status does to the
// machine, the E2E pin on a 200, and a clientId the server bound to another device.

package im.plrs.key.core.sync

import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** What the transport answered: a status and body, or a request-level failure (nothing was processed). */
public class SyncResponse(public val status: Int, public val body: JsonElement?, public val transportError: Boolean = false) {
    public companion object {
        /** The transport failed before any answer. */
        public val TRANSPORT: SyncResponse = SyncResponse(0, null, true)
    }
}

/** The answer side of the machine. */
public interface SyncExchange {
    /** The transport's answer to the request in flight; [opened] is the host codec's typed open result (E2E). */
    public fun receive(res: SyncResponse, opened: OpenedBody? = null)
}

private const val STATUS_OK = 200
private const val STATUS_BAD_REQUEST = 400
private const val STATUS_UNAUTHORIZED = 401
private const val STATUS_FORBIDDEN = 403
private const val STATUS_CONFLICT = 409
private const val STATUS_GONE = 410
private const val STATUS_TOO_LARGE = 413
private const val STATUS_RATE_LIMITED = 429
private const val STATUS_SERVER_ERROR = 500
private const val STATUS_UNAVAILABLE = 503

internal class MachineReceive(private val p: MachineParts) : SyncExchange {
    private val core get() = p.core

    override fun receive(res: SyncResponse, opened: OpenedBody?) {
        val req = checkNotNull(core.inFlight) { "respond: no request is in flight" }
        core.inFlight = null
        val proceed = if (res.transportError) false else status(req, res, opened ?: OpenedBody())
        val so = core.signingOut
        if (proceed == null) return
        if (so != null && core.s.subject != null && flushDone(proceed)) {
            p.session.leave("signOut", so.discard)
        } else if (proceed) {
            p.pump.kick()
        }
    }

    private fun flushDone(proceed: Boolean): Boolean = !proceed || p.reads.sendable(core.active()) == 0

    private fun errorCode(body: JsonElement?): String? = body.objectValue?.get("error").objectValue?.get("code").stringValue

    /** Whether the answer lets the pump go on (null: the machine already left and is done). */
    private fun status(req: InFlight, res: SyncResponse, opened: OpenedBody): Boolean? {
        val code = res.status
        return when {
            requestFailed(req, res) -> false
            code == STATUS_UNAUTHORIZED -> false.also { core.s.blocked = "unauthorized" }
            code == STATUS_FORBIDDEN -> forbidden(res.body)
            code == STATUS_CONFLICT -> true.also { clientMismatch(req) }
            code == STATUS_GONE -> true.also { snapshotReset(req) }
            code == STATUS_OK && res.body is JsonObject -> ok(req, res.body, opened)
            else -> false
        }
    }

    /** A request-level failure: nothing was processed and the journal is unchanged (rule 1); a paused write is R4. */
    private fun requestFailed(req: InFlight, res: SyncResponse): Boolean {
        val paused = res.status == STATUS_UNAVAILABLE && req.kind == "push" && errorCode(res.body) == "writes_paused"
        if (paused) core.paused = true
        return paused || res.status >= STATUS_SERVER_ERROR || res.status in listOf(STATUS_BAD_REQUEST, STATUS_TOO_LARGE, STATUS_RATE_LIMITED)
    }

    private fun forbidden(body: JsonElement?): Boolean? {
        val err = body.objectValue?.get("error").objectValue
        if (err?.get("code").stringValue != "account_required") {
            // The journal is kept; a document refresh lifts either block.
            core.s.blocked = if (err?.get("code").stringValue == "attestation_required") "attestation" else "forbidden"
            return false
        }
        p.session.leave("accountRequired", false)
        core.s.blocked = "account_required"
        core.events.add(SyncEvent.SignInOffered(err?.get("signInUrl").stringValue))
        return null
    }

    private fun snapshotReset(req: InFlight) {
        core.s.partitions[req.partition]?.cursor = 0
        core.needSnapshot = true
    }

    /** The pin on a 200 body, then the exchange. A refused body is dropped unread. */
    private fun ok(req: InFlight, body: JsonObject, opened: OpenedBody): Boolean {
        if (!acceptMode(body)) return false
        if (req.kind == "push") core.paused = false
        p.exchange.ok(req, body, opened)
        return true
    }

    /**
     * In E2E mode the body must say `encryption: "e2e"`; an app in server mode refuses an `e2e` body too,
     * since it cannot open it.
     */
    private fun acceptMode(body: JsonObject): Boolean {
        val enc = body["encryption"].stringValue
        val said = if (enc == "e2e" || enc == "server") enc else "omitted"
        val serverMode = !core.requiresE2e() && said != "e2e"
        if (!serverMode) core.advertised = said
        val ok = !core.pinnedOut()
        if (!serverMode && ok && said == "e2e") core.s.e2eSeen = true
        return ok
    }

    /** The server bound this clientId to another device: regenerate and renumber (none was processed under the new id). */
    private fun clientMismatch(req: InFlight) {
        val part = core.s.partitions[req.partition] ?: return
        part.clientId = core.freshClientId()
        part.nextMutationId = 1
        val ops = part.pending
        part.pending = mutableListOf()
        ops.forEach { p.journal.enqueue(part, it.resend(keepParked = true)) }
    }
}
