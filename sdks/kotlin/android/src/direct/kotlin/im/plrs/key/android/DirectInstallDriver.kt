// update.driver on a direct build (P6-12): the verified self-update, Godot's PKeyApkUpdate (P5-06)
// on :update's InstallDriver port. `binary {method: native}`:
//
//   1. the VERIFIED signed release record the decision pins (UpdateClient.releaseRecord), and its
//      build `decision.build` with exactly one `payload` artifact (else `record-mismatch`);
//   2. the bytes from discovery's builds route (UpdateClient.buildUrl), downloaded into the app's
//      private storage (`filesDir/pkey/<product>/updates/apk/`), checked against the artifact's size
//      and SHA-256 (else `payload-mismatch`, nothing installed);
//   3. :platform's ApkInstaller, which checks again before any session (hash, private path, package,
//      signing-certificate set, a higher versionCode) and re-hashes while streaming into the session
//      (`hash_changed`); any refusal is `swap-refused` with every reason in the detail.
//
// Nothing comes from an unsigned field: the URL is only where the bytes are fetched from. The record
// carries no Android versionCode (`buildNumber` is a free string), so no expected versionCode is
// passed; the installer still refuses one that is not above the installed one. A committed session
// usually kills the app (the new version starts with no game running), so the outcome is journaled
// by :platform's InstallStatusReceiver and read at the next launch ([launchOutcome]); [cleanup]
// removes a verified copy a killed process left behind.

package im.plrs.key.android

import android.content.Context
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.platform.Digests
import im.plrs.key.platform.direct.ApkInstaller
import im.plrs.key.platform.direct.InstallJournal
import im.plrs.key.platform.direct.InstallOptions
import im.plrs.key.platform.direct.InstallOutcome
import im.plrs.key.update.InstallDriver
import im.plrs.key.update.InstallResult
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** The PackageInstaller side of [DirectInstallDriver]; [ApkInstallerSessions] on a device, a fake in tests. */
public fun interface ApkSessions {
    public fun install(file: File, sha256: String, options: InstallOptions): InstallOutcome
}

/** [ApkSessions] over :platform's verified [ApkInstaller]. */
public class ApkInstallerSessions(private val installer: ApkInstaller) : ApkSessions {
    public constructor(context: Context) : this(ApkInstaller(context))

    override fun install(file: File, sha256: String, options: InstallOptions): InstallOutcome = installer.install(file, sha256, null, options)
}

/** The verified PackageInstaller self-update as :update's install driver. */
public class DirectInstallDriver(
    private val sessions: ApkSessions,
    /** The verified release record by its SHA-256 (UpdateClient.releaseRecord). */
    private val records: suspend (String) -> ReleaseRecordDoc,
    /** A build's download URL (UpdateClient.buildUrl). */
    private val buildUrl: suspend (version: String, buildId: String) -> String?,
    private val download: BuildDownload,
    /** The app-private directory the APK is downloaded into. */
    private val dir: File,
    private val options: InstallOptions = InstallOptions(),
) : InstallDriver {
    /** The last installer outcome (every refusal reason, the session), or null. */
    @Volatile public var lastOutcome: InstallOutcome? = null
        private set

    override suspend fun install(check: UpdateCheck): InstallResult {
        val d = check.decision
        return when {
            d is UpdateDecision.Binary && d.method == NATIVE -> installApk(d)
            d is UpdateDecision.Binary -> InstallResult.Declined("binary ${d.method}: offer UpdateClient.buildUrl as a download link")
            d is UpdateDecision.Store -> InstallResult.Declined("a store updates this install${d.listingUrl?.let { ": $it" } ?: ""}")
            else -> InstallResult.NothingToInstall
        }
    }

    private suspend fun installApk(d: UpdateDecision.Binary): InstallResult {
        val sha = d.release.sha256 ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the decision pins no release record")
        val record = try {
            records(sha)
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            return InstallResult.Failed(e.code, e.message)
        } catch (e: Exception) {
            return InstallResult.Failed(ErrorCode.recordRejected, e.message)
        }
        val payloads = record.builds?.firstOrNull { it.id == d.build }?.artifacts?.filter { it.role == PAYLOAD }.orEmpty()
        val artifact = payloads.singleOrNull()
            ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the verified record has no build '${d.build}' with one payload")
        val url = try {
            buildUrl(d.release.version, d.build)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return InstallResult.Failed(ErrorCode.serviceUnavailable, "discovery names no builds route")
        val expected = artifact.sha256.lowercase()
        val part = File(dir, "$FILE.part")
        val apk = File(dir, FILE)
        try {
            if (!dir.isDirectory && !dir.mkdirs()) return InstallResult.Failed(ErrorCode.storeFailed, "cannot create $dir")
            part.delete()
            download.download(url, part)
        } catch (e: CancellationException) {
            part.delete()
            throw e
        } catch (e: PolarisException) {
            part.delete()
            return InstallResult.Failed(e.code, e.message)
        } catch (e: Exception) {
            part.delete()
            return InstallResult.Failed(ErrorCode.networkError, e.message)
        }
        val ok = withContext(Dispatchers.IO) { part.length() == artifact.size && Digests.sha256(part).equals(expected, ignoreCase = true) }
        if (!ok) {
            part.delete()
            return InstallResult.Failed(ErrorCode.payloadMismatch, "the downloaded APK does not match the record's size and SHA-256; nothing was installed")
        }
        apk.delete()
        if (!part.renameTo(apk)) {
            part.delete()
            return InstallResult.Failed(ErrorCode.storeFailed, "the verified APK could not be moved into place")
        }
        val outcome = try {
            withContext(Dispatchers.IO) { sessions.install(apk, expected, options) }
        } catch (e: IOException) {
            apk.delete()
            return InstallResult.Failed(ErrorCode.platformError, e.message)
        }
        lastOutcome = outcome
        // The session holds its own copy of the bytes (or there is none).
        apk.delete()
        if (!outcome.committed) {
            val why = outcome.verdict.refused.ifEmpty { listOfNotNull(outcome.error ?: "refused") }
            return InstallResult.Failed(ErrorCode.swapRefused, "apk-refused: ${why.joinToString(", ")}")
        }
        return InstallResult.Started
    }

    /** Remove a verified APK a previous launch left behind (true when one was removed). Call at launch. */
    public fun cleanup(): Boolean {
        val f = File(dir, FILE)
        return f.isFile && f.delete()
    }

    public companion object {
        /** The binary method this driver installs (`BinaryMethod.native`). */
        public const val NATIVE: String = im.plrs.key.core.BinaryMethod.native
        public const val PAYLOAD: String = "payload"
        public const val FILE: String = "update.apk"

        /** The last journaled PackageInstaller outcome (often written by the new version's process), or null. */
        public fun launchOutcome(context: Context, clear: Boolean = true): JSONObject? {
            val journal = InstallJournal(context)
            val last = journal.last()
            if (clear) journal.clear()
            return last
        }
    }
}
