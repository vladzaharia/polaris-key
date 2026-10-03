package im.plrs.key.platform.direct

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import org.json.JSONObject
import java.io.File

/**
 * The install journal: the last PackageInstaller outcome, in `noBackupFilesDir/pkey/install/last.json`.
 * The receiver writes it (often in a process of the NEW version, with no game running) and the
 * game reads it on its next launch to report the previous attempt.
 */
public class InstallJournal(context: Context) {
    private val file = File(context.noBackupFilesDir, "pkey/install/last.json")

    public fun record(entry: JSONObject) {
        entry.put("at", System.currentTimeMillis())
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "last.json.tmp")
        tmp.writeText(entry.toString())
        if (!tmp.renameTo(file)) {
            file.writeText(entry.toString())
            tmp.delete()
        }
    }

    /** The last entry, or null. */
    public fun last(): JSONObject? = try {
        if (file.isFile) JSONObject(file.readText()) else null
    } catch (_: Exception) {
        null
    }

    public fun clear(): Boolean = !file.exists() || file.delete()
}

/** A PackageInstaller status, as the receiver saw it. */
public data class InstallStatus(
    /** `PackageInstaller.STATUS_*`: -1 pending user action, 0 success, 1–8 failures. */
    val status: Int,
    val message: String?,
    val sessionId: Int,
    /** `EXTRA_OTHER_PACKAGE_NAME`: the conflicting or owning package, when Android names one. */
    val otherPackage: String?,
    val legacyStatus: Int,
    /** The confirmation activity for [status] -1, else null. */
    val confirmIntent: Intent?,
    val prompt: Boolean,
) {
    val name: String get() = statusName(status)

    public fun toJson(): JSONObject = JSONObject()
        .put("event", "status")
        .put("status", status)
        .put("name", name)
        .put("message", message ?: JSONObject.NULL)
        .put("session", sessionId)
        .put("otherPackage", otherPackage ?: JSONObject.NULL)
        .put("legacyStatus", legacyStatus)
        .put("confirmAction", confirmIntent?.action ?: JSONObject.NULL)

    public companion object {
        public fun statusName(status: Int): String = when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> "pending_user_action"
            PackageInstaller.STATUS_SUCCESS -> "success"
            PackageInstaller.STATUS_FAILURE -> "failure"
            PackageInstaller.STATUS_FAILURE_BLOCKED -> "failure_blocked"
            PackageInstaller.STATUS_FAILURE_ABORTED -> "failure_aborted"
            PackageInstaller.STATUS_FAILURE_INVALID -> "failure_invalid"
            PackageInstaller.STATUS_FAILURE_CONFLICT -> "failure_conflict"
            PackageInstaller.STATUS_FAILURE_STORAGE -> "failure_storage"
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "failure_incompatible"
            8 -> "failure_timeout" // STATUS_FAILURE_TIMEOUT, API 34
            else -> "unknown"
        }

        public fun of(intent: Intent): InstallStatus {
            val confirm = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_INTENT)
            }
            return InstallStatus(
                status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE),
                message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1),
                otherPackage = intent.getStringExtra(PackageInstaller.EXTRA_OTHER_PACKAGE_NAME),
                legacyStatus = intent.getIntExtra("android.content.pm.extra.LEGACY_STATUS", 0),
                confirmIntent = confirm,
                prompt = intent.getBooleanExtra(InstallStatusReceiver.EXTRA_PROMPT, false),
            )
        }
    }
}

/**
 * Where a running game hears install statuses. The Godot binding sets [listener] while the game
 * runs; it launches a confirmation ([InstallStatus.confirmIntent]) from its activity when the
 * install asked for prompts. With no listener (the usual case after a successful update: a new
 * process of the new version) only the journal records the status.
 */
public object InstallEvents {
    @Volatile
    public var listener: ((InstallStatus) -> Unit)? = null
}

/** Manifest-declared, not exported: PackageInstaller's status for sessions [ApkInstaller] committed. */
public class InstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val s = InstallStatus.of(intent)
        val entry = s.toJson().put("listener", InstallEvents.listener != null)
        try {
            InstallJournal(context).record(entry)
        } catch (_: Exception) {
            // The journal is best effort; the listener below still hears it.
        }
        InstallEvents.listener?.invoke(s)
    }

    public companion object {
        public const val ACTION: String = "im.plrs.key.platform.INSTALL_STATUS"
        public const val EXTRA_PROMPT: String = "im.plrs.key.platform.PROMPT"
    }
}
