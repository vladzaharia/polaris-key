package im.plrs.key.platform.direct

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import im.plrs.key.platform.Digests
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest

/** Options for [ApkInstaller.install]. */
public data class InstallOptions(
    /** Ask for no prompt (`USER_ACTION_NOT_REQUIRED`, API 31+). */
    val silent: Boolean = true,
    /** Commit once the game is in the background (`GENTLE_UPDATE` constraints, API 34+; ignored below). */
    val whenBackgrounded: Boolean = false,
    /** How long a [whenBackgrounded] commit waits for its constraints before installing anyway. */
    val constraintsTimeoutMs: Long = 10 * 60 * 1000L,
    /** Launch the system confirmation when the install needs the user (only while the game runs). */
    val prompt: Boolean = true,
)

/** The result of [ApkInstaller.install]: the [verdict], and whether a session was committed. */
public data class InstallOutcome(
    val verdict: Verdict,
    val committed: Boolean,
    val sessionId: Int?,
    val applied: JSONObject,
    val error: String? = null,
) {
    public fun toJson(): JSONObject = JSONObject()
        .put("committed", committed)
        .put("session", sessionId ?: JSONObject.NULL)
        .put("applied", applied)
        .put("error", error ?: JSONObject.NULL)
        .put("verify", verdict.toJson())
}

/**
 * Verified self-update through a PackageInstaller session (direct builds only; Play forbids it).
 * The recipe measured in notes/S-10 §3:
 *
 *  - Refuse before any session on hash, path, package, signer set or versionCode ([ApkVerifier]);
 *    the bytes are hashed again while they stream into the session, and a change aborts it.
 *  - `MODE_FULL_INSTALL`, the own package name, `INSTALL_REASON_USER`, the size, and
 *    `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` on API 31+: silent when the user allowed
 *    installs from the game ([canInstall]), the manifest has `UPDATE_PACKAGES_WITHOUT_USER_ACTION`
 *    and no other installer owns the app's updates; otherwise the commit asks the user.
 *  - No `setRequestUpdateOwnership`: a self-updater never makes the first install, and on an update
 *    the flag is ignored. No `setPackageSource`.
 *  - Optional gentle constraints on API 34+ (install once the game is in the background).
 *  - The status arrives at [InstallStatusReceiver], usually in a NEW process of the new version:
 *    the update kills the game and nothing relaunches it, so the outcome is journaled
 *    ([InstallJournal]) and reported on the next launch.
 */
public class ApkInstaller(
    private val context: Context,
    private val facts: PackageFacts = AndroidPackageFacts(context),
) {
    private val installer: PackageInstaller get() = context.packageManager.packageInstaller

    /** Whether the user allowed installs from this app (`canRequestPackageInstalls`, API 26+). */
    public fun canInstall(): Boolean =
        if (Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true

    /** The settings screen where the user allows installs from this app. */
    public fun settingsIntent(): Intent =
        if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName))
        } else {
            Intent(Settings.ACTION_SECURITY_SETTINGS)
        }

    /** Abandons this app's sessions except [keep] (call at start-up: stale sessions count against the app). */
    public fun abandonStaleSessions(keep: Set<Int> = emptySet()): Int {
        var n = 0
        for (s in installer.mySessions) {
            if (s.sessionId in keep) continue
            try {
                installer.abandonSession(s.sessionId)
                n++
            } catch (_: SecurityException) {
            }
        }
        return n
    }

    public fun verify(file: File, sha256: String?, versionCode: Long?): Verdict = ApkVerifier.verify(file, sha256, versionCode, facts)

    public fun install(file: File, sha256: String?, versionCode: Long?, options: InstallOptions = InstallOptions()): InstallOutcome {
        val verdict = verify(file, sha256, versionCode)
        val applied = JSONObject()
        if (!verdict.ok) return InstallOutcome(verdict, false, null, applied)
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= 26) params.setInstallReason(PackageManager.INSTALL_REASON_USER)
        params.setSize(file.length())
        if (options.silent && Build.VERSION.SDK_INT >= 31) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            applied.put("userActionNotRequired", true)
        }
        val id = try {
            installer.createSession(params)
        } catch (e: IOException) {
            return InstallOutcome(verdict, false, null, applied, "create_failed: ${e.message}")
        } catch (e: SecurityException) {
            return InstallOutcome(verdict, false, null, applied, "create_failed: ${e.message}")
        }
        try {
            installer.openSession(id).use { session ->
                val streamed = write(session, file)
                if (!streamed.equals(verdict.sha256, ignoreCase = true)) {
                    session.abandon()
                    val changed = verdict.copy(refused = listOf("hash_changed"))
                    return InstallOutcome(changed, false, id, applied)
                }
                val sender = pendingIntent(id, options.prompt).intentSender
                if (options.whenBackgrounded && Build.VERSION.SDK_INT >= 34) {
                    installer.commitSessionAfterInstallConstraintsAreMet(
                        id, sender, PackageInstaller.InstallConstraints.GENTLE_UPDATE, options.constraintsTimeoutMs,
                    )
                    applied.put("gentle", true)
                } else {
                    session.commit(sender)
                }
            }
        } catch (e: Exception) {
            try {
                installer.abandonSession(id)
            } catch (_: Exception) {
            }
            return InstallOutcome(verdict, false, id, applied, "commit_failed: ${e.javaClass.simpleName}: ${e.message}")
        }
        val outcome = InstallOutcome(verdict, true, id, applied)
        InstallJournal(context).record(JSONObject().put("event", "commit").put("session", id).put("versionCode", verdict.archive?.versionCode ?: JSONObject.NULL))
        return outcome
    }

    /**
     * Whether GENTLE_UPDATE constraints hold now (API 34+), through [callback]: true/false, or null
     * below API 34 or when Android refuses the question (it throws SecurityException until the
     * game is its own installer of record).
     */
    public fun gentleConstraintsSatisfied(callback: (Boolean?) -> Unit) {
        if (Build.VERSION.SDK_INT < 34) return callback(null)
        try {
            installer.checkInstallConstraints(
                listOf(context.packageName), PackageInstaller.InstallConstraints.GENTLE_UPDATE, context.mainExecutor,
            ) { r -> callback(r.areAllConstraintsSatisfied()) }
        } catch (_: SecurityException) {
            callback(null)
        } catch (_: IllegalArgumentException) {
            callback(null)
        }
    }

    private fun write(session: PackageInstaller.Session, file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        session.openWrite("base.apk", 0, file.length()).use { out ->
            FileInputStream(file).use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                    out.write(buf, 0, n)
                }
            }
            session.fsync(out)
        }
        return Digests.hex(md.digest())
    }

    private fun pendingIntent(sessionId: Int, prompt: Boolean): PendingIntent {
        val intent = Intent(context, InstallStatusReceiver::class.java)
            .setAction(InstallStatusReceiver.ACTION)
            .setPackage(context.packageName)
            .putExtra(InstallStatusReceiver.EXTRA_PROMPT, prompt)
        // The installer fills the status extras in, so the PendingIntent must be mutable on 31+.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, sessionId, intent, flags)
    }
}
