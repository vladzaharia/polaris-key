package im.plrs.key.godot

import android.content.Intent
import com.google.android.play.core.appupdate.AppUpdateManager
import im.plrs.key.platform.play.AssetPacks
import im.plrs.key.platform.play.InAppUpdates
import im.plrs.key.platform.play.InstallProgress
import im.plrs.key.platform.play.IntegrityBackend
import im.plrs.key.platform.play.IntegrityError
import im.plrs.key.platform.play.PackError
import im.plrs.key.platform.play.PackManager
import im.plrs.key.platform.play.PackState
import im.plrs.key.platform.play.PlayIntegrity
import im.plrs.key.platform.play.PlayPackManager
import im.plrs.key.platform.play.UpdatesUnavailable
import org.json.JSONObject

internal fun createFlavorCommands(c: Commands): FlavorCommands = PlayCommands(c)

/**
 * The play flavour: Play In-App Updates, Play Asset Delivery and the standard Play Integrity API
 * (P6-02). Every Play Core call runs on the UI thread; listener events become `update_state` and
 * `pack_state`, the In-App Updates activity result `update_result`.
 *
 * `integrity_prepare {cloudProjectNumber}` warms the token provider up (seconds);
 * `integrity_token {cloudProjectNumber, requestHash}` answers `{token, prepared, reprepared}` for the
 * Worker's `POST /<product>/devices/attest` (`kind: "play-integrity"`), the request hash passed
 * verbatim. The cloud project number is a string of digits or a JSON number. A failure is
 * `{ok: false, error: "integrity", errorCode (StandardIntegrityErrorCode or null), exception, message}`.
 */
class PlayCommands(
    c: Commands,
    private val updateManager: (() -> AppUpdateManager)? = null,
    private val packManager: (() -> PackManager)? = null,
    private val integrityBackend: (() -> IntegrityBackend)? = null,
) : FlavorCommands(c) {
    override val ops: Set<String> = Commands.PLAY_OPS

    private var updates: InAppUpdates? = null
    private var packs: AssetPacks? = null
    private var integrity: PlayIntegrity? = null
    private val updateListener: (InstallProgress) -> Unit = { p -> c.event("update_state", p.toJson()) }
    private val packListener: (PackState) -> Unit = { s -> c.event("pack_state", s.toJson()) }

    override fun capabilities(out: JSONObject) {
        out.put("inAppUpdates", true).put("assetPacks", true).put("playIntegrity", true)
    }

    /** Created on first use (UI or render thread), with the listener registered once. */
    @Synchronized
    private fun updates(): InAppUpdates = updates ?: (updateManager?.let { InAppUpdates(it()) } ?: InAppUpdates(c.host.appContext)).also {
        it.addListener(updateListener)
        updates = it
    }

    @Synchronized
    private fun packs(): AssetPacks = packs ?: AssetPacks(packManager?.invoke() ?: PlayPackManager(c.host.appContext)).also {
        it.listen(packListener)
        packs = it
    }

    @Synchronized
    private fun integrity(): PlayIntegrity = integrity ?: (integrityBackend?.let { PlayIntegrity(it()) } ?: PlayIntegrity(c.host.appContext)).also {
        integrity = it
    }

    override fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "integrity_prepare", "integrity_token" -> {
            val project = cloudProjectNumber(q)
            val hash = q.optString("requestHash")
            when {
                project == null -> Commands.fail("bad_request", "cloudProjectNumber must be a positive integer")
                op == "integrity_token" && hash.isEmpty() -> Commands.fail("bad_request", "requestHash is required")
                op == "integrity_prepare" -> c.onUiAsync { done ->
                    integrity().prepare(project) { r -> done(r.fold({ JSONObject().put("ok", true).put("prepared", it) }, { integrityFail(it) })) }
                }
                else -> c.onUiAsync { done ->
                    integrity().request(project, hash) { r -> done(r.fold({ it.toJson().put("ok", true) }, { integrityFail(it) })) }
                }
            }
        }
        "iau_check" -> c.onUiAsync { done ->
            updates().check { r ->
                done(r.fold({ it.toJson().put("ok", true) }, { unavailable(it) }))
            }
        }
        "iau_start" -> {
            val type = InAppUpdates.typeOf(q.optString("type"))
            if (type == null) {
                Commands.fail("bad_request", "type must be flexible or immediate")
            } else {
                c.onUiAsync { done ->
                    val act = c.host.foregroundActivity
                    if (act == null) done(Commands.fail("no_activity", "no foreground activity")) else done(updates().start(type, act).toJson().put("ok", true))
                }
            }
        }
        "iau_complete" -> c.onUiAsync { done ->
            updates().complete { r -> done(r.fold({ JSONObject().put("ok", true) }, { unavailable(it) })) }
        }
        "pad_state" -> c.onUiAsync { done -> packs().state(q.getString("name")) { r -> done(packResult(r)) } }
        "pad_fetch" -> c.onUiAsync { done -> packs().fetch(q.getString("name")) { r -> done(packResult(r)) } }
        "pad_remove" -> c.onUiAsync { done ->
            packs().remove(q.getString("name")) { r -> done(r.fold({ JSONObject().put("ok", true) }, { packFail(it) })) }
        }
        "pad_confirm" -> c.onUiAsync { done ->
            val act = c.host.foregroundActivity
            if (act == null) {
                done(Commands.fail("no_activity", "no foreground activity"))
            } else {
                packs().confirm(act) { r -> done(r.fold({ JSONObject().put("ok", true).put("result", it) }, { packFail(it) })) }
            }
        }
        // Synchronous: Play Core answers these from local state on any thread (notes/S-10 §2).
        "pad_location" -> try {
            val loc = packs().location(q.getString("name"))
            JSONObject().put("ok", true).put("location", loc?.toJson() ?: JSONObject.NULL)
        } catch (e: Exception) {
            packFail(e)
        }
        "pad_cancel" -> try {
            JSONObject().put("ok", true).put("state", packs().cancel(q.getString("name"))?.toJson() ?: JSONObject.NULL)
        } catch (e: Exception) {
            packFail(e)
        }
        else -> Commands.fail("unknown_op", op)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != InAppUpdates.REQUEST_CODE) return
        c.event(
            "update_result",
            JSONObject().put("resultCode", resultCode).put("result", InAppUpdates.activityResult(resultCode)),
        )
    }

    override fun close() {
        updates?.removeListener(updateListener)
        packs?.unlisten(packListener)
    }

    private fun integrityFail(e: Throwable): JSONObject = IntegrityError.of(e).toJson().put("ok", false)

    /** A positive cloud project number from a digit string or a JSON number, else null. */
    private fun cloudProjectNumber(q: JSONObject): Long? {
        val raw = q.opt("cloudProjectNumber") ?: return null
        val n = when (raw) {
            is String -> if (raw.isNotEmpty() && raw.all { it in '0'..'9' }) raw.toLongOrNull() else null
            is Number -> raw.toDouble().let { d -> if (d == Math.floor(d) && d < 9.007199254740992E15) d.toLong() else null }
            else -> null
        }
        return n?.takeIf { it > 0 }
    }

    private fun unavailable(e: Throwable): JSONObject =
        (e as? UpdatesUnavailable ?: UpdatesUnavailable(e.javaClass.name, e.message, null)).toJson().put("ok", false)

    private fun packResult(r: Result<PackState>): JSONObject = r.fold({ JSONObject().put("ok", true).put("state", it.toJson()) }, { packFail(it) })

    private fun packFail(e: Throwable): JSONObject =
        (e as? PackError ?: PackError(e.javaClass.name, e.message, null)).toJson().put("ok", false)
}
