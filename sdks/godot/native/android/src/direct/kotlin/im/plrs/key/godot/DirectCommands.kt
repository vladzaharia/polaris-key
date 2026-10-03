package im.plrs.key.godot

import im.plrs.key.platform.direct.AndroidPackageFacts
import im.plrs.key.platform.direct.ApkInstaller
import im.plrs.key.platform.direct.InstallEvents
import im.plrs.key.platform.direct.InstallJournal
import im.plrs.key.platform.direct.InstallOptions
import im.plrs.key.platform.direct.InstallStatus
import im.plrs.key.platform.direct.PackageFacts
import org.json.JSONObject
import java.io.File

internal fun createFlavorCommands(c: Commands): FlavorCommands = DirectCommands(c)

/**
 * The direct flavour: verified PackageInstaller self-update. Verification and the session write
 * run on the worker thread. While the game runs, install statuses become `install_status` events,
 * and a status that needs the user launches the system confirmation from the game's activity when
 * the install asked for prompts. After a successful update the game is gone; the next launch reads
 * the outcome with `pi_last`.
 */
class DirectCommands(c: Commands, private val facts: PackageFacts? = null) : FlavorCommands(c) {
    override val ops: Set<String> = Commands.DIRECT_OPS

    private val installer: ApkInstaller by lazy { ApkInstaller(c.host.appContext, facts ?: AndroidPackageFacts(c.host.appContext)) }
    private val listener: (InstallStatus) -> Unit = { s -> onStatus(s) }

    init {
        InstallEvents.listener = listener
    }

    override fun capabilities(out: JSONObject) {
        out.put("packageInstaller", true)
    }

    override fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "pi_can_install" -> JSONObject().put("ok", true).put("canInstall", installer.canInstall())
        "pi_open_settings" -> c.onUiAsync { done ->
            val act = c.host.foregroundActivity
            if (act == null) {
                done(Commands.fail("no_activity", "no foreground activity"))
            } else {
                act.startActivity(installer.settingsIntent())
                done(JSONObject().put("ok", true).put("started", true))
            }
        }
        "pi_verify" -> {
            val (file, sha, vc) = target(q)
            c.onWorkerAsync { JSONObject().put("ok", true).put("verify", installer.verify(file, sha, vc).toJson()) }
        }
        "pi_install" -> {
            val (file, sha, vc) = target(q)
            val options = InstallOptions(
                silent = q.optBoolean("silent", true),
                whenBackgrounded = q.optBoolean("whenBackgrounded", false),
                constraintsTimeoutMs = q.optLong("timeoutMs", InstallOptions().constraintsTimeoutMs),
                prompt = q.optBoolean("prompt", true),
            )
            c.onWorkerAsync { installer.install(file, sha, vc, options).toJson().put("ok", true) }
        }
        "pi_last" -> {
            val journal = InstallJournal(c.host.appContext)
            val last = journal.last()
            if (q.optBoolean("clear", false)) journal.clear()
            JSONObject().put("ok", true).put("last", last ?: JSONObject.NULL)
        }
        "pi_abandon_stale" -> JSONObject().put("ok", true).put("abandoned", installer.abandonStaleSessions())
        "pi_constraints" -> c.async { done ->
            installer.gentleConstraintsSatisfied { r -> done(JSONObject().put("ok", true).put("satisfied", r ?: JSONObject.NULL)) }
        }
        else -> Commands.fail("unknown_op", op)
    }

    private fun target(q: JSONObject): Triple<File, String?, Long?> {
        val vc = if (q.has("versionCode") && !q.isNull("versionCode")) q.getLong("versionCode") else null
        return Triple(File(q.getString("path")), q.optString("sha256").ifEmpty { null }, vc)
    }

    private fun onStatus(s: InstallStatus) {
        val body = s.toJson()
        val act = c.host.foregroundActivity
        if (s.status == android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION && s.prompt && s.confirmIntent != null && act != null) {
            body.put("promptLaunched", true)
            c.host.onUi {
                try {
                    act.startActivity(s.confirmIntent)
                } catch (e: Exception) {
                    c.event("install_status", JSONObject().put("event", "prompt_failed").put("message", "${e.javaClass.simpleName}: ${e.message}"))
                }
            }
        }
        c.event("install_status", body)
    }

    override fun close() {
        if (InstallEvents.listener === listener) InstallEvents.listener = null
    }
}
