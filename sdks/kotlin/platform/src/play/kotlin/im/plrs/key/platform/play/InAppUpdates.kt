package im.plrs.key.platform.play

import android.app.Activity
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallException
import com.google.android.play.core.install.InstallState
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.ActivityResult
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import org.json.JSONArray
import org.json.JSONObject
import android.content.Context

/**
 * What Play says about an update for this install (`AppUpdateInfo`). Play is authoritative on its
 * outlet: availability is per device and staged-rollout aware, so the server's "latest" is advisory
 * (notes/E2 §A2). [stalenessDays] is null until Play has offered the update for a day.
 */
public data class UpdateStatus(
    /** `UpdateAvailability`: 0 unknown, 1 not available, 2 available, 3 developer-triggered in progress. */
    val availability: Int,
    val availableVersionCode: Int,
    /** `InstallStatus`: 0 unknown, 1 pending, 2 downloading, 3 installing, 4 installed, 5 failed, 6 canceled, 10 requires UI intent, 11 downloaded. */
    val installStatus: Int,
    val priority: Int,
    val stalenessDays: Int?,
    val flexibleAllowed: Boolean,
    val immediateAllowed: Boolean,
    val bytesDownloaded: Long,
    val totalBytes: Long,
) {
    /** A flexible update finished downloading: call [InAppUpdates.complete] (it restarts the app). */
    val readyToComplete: Boolean get() = installStatus == InstallStatus.DOWNLOADED

    /** An update is downloading or installing (re-start an immediate flow on resume). */
    val inProgress: Boolean
        get() = availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS &&
            installStatus in InstallStatus.PENDING..InstallStatus.INSTALLING

    public fun toJson(): JSONObject = JSONObject()
        .put("availability", availability)
        .put("availableVersionCode", availableVersionCode)
        .put("installStatus", installStatus)
        .put("priority", priority)
        .put("stalenessDays", stalenessDays ?: JSONObject.NULL)
        .put("flexibleAllowed", flexibleAllowed)
        .put("immediateAllowed", immediateAllowed)
        .put("bytesDownloaded", bytesDownloaded)
        .put("totalBytes", totalBytes)
        .put("readyToComplete", readyToComplete)
        .put("inProgress", inProgress)

    public companion object {
        public fun of(i: AppUpdateInfo): UpdateStatus = UpdateStatus(
            availability = i.updateAvailability(),
            availableVersionCode = i.availableVersionCode(),
            installStatus = i.installStatus(),
            priority = i.updatePriority(),
            stalenessDays = i.clientVersionStalenessDays(),
            flexibleAllowed = i.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
            immediateAllowed = i.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE),
            bytesDownloaded = i.bytesDownloaded(),
            totalBytes = i.totalBytesToDownload(),
        )
    }
}

/** One `InstallStateUpdatedListener` event (flexible flows only; an immediate flow reports none). */
public data class InstallProgress(val installStatus: Int, val errorCode: Int, val bytesDownloaded: Long, val totalBytes: Long) {
    public fun toJson(): JSONObject = JSONObject()
        .put("installStatus", installStatus)
        .put("errorCode", errorCode)
        .put("bytesDownloaded", bytesDownloaded)
        .put("totalBytes", totalBytes)

    public companion object {
        public fun of(s: InstallState): InstallProgress =
            InstallProgress(s.installStatus(), s.installErrorCode(), s.bytesDownloaded(), s.totalBytesToDownload())
    }
}

/**
 * In-App Updates unavailable. ANY `getAppUpdateInfo` failure means this, not only an
 * [InstallException]: without the Play Store the failure is an obfuscated internal "Failed to bind
 * to the service." (notes/S-10 §1). [installErrorCode] is the `InstallErrorCode` when Play gave one.
 */
public class UpdatesUnavailable(public val exception: String, message: String?, public val installErrorCode: Int?) :
    Exception(message) {
    public fun toJson(): JSONObject = JSONObject()
        .put("error", "unavailable")
        .put("exception", exception)
        .put("message", message ?: JSONObject.NULL)
        .put("installErrorCode", installErrorCode ?: JSONObject.NULL)

    public companion object {
        public fun of(e: Exception?): UpdatesUnavailable = UpdatesUnavailable(
            e?.javaClass?.name ?: "null",
            e?.message,
            (e as? InstallException)?.errorCode,
        )
    }
}

/**
 * Play In-App Updates over an [AppUpdateManager] (the real one, or Play Core's
 * `FakeAppUpdateManager` in tests). Call from Android's main thread; callbacks arrive there.
 *
 *  - [check] reads the [UpdateStatus] and keeps the `AppUpdateInfo` [start] needs.
 *  - [start] runs the flexible or immediate flow through `startUpdateFlowForResult`; the outcome
 *    arrives as the host activity's result for [REQUEST_CODE] ([activityResult] maps it).
 *  - Flexible progress arrives through [addListener]; [complete] installs a downloaded update and
 *    restarts the app.
 *  - On every resume, [check] again: [UpdateStatus.readyToComplete] means "call complete",
 *    [UpdateStatus.inProgress] with an immediate update means "start the immediate flow again".
 */
public class InAppUpdates(private val manager: AppUpdateManager) {
    public constructor(context: Context) : this(AppUpdateManagerFactory.create(context))

    private var info: AppUpdateInfo? = null
    private val listeners = mutableMapOf<(InstallProgress) -> Unit, InstallStateUpdatedListener>()

    /** The last [check]'s status, or null before one succeeded. */
    public val last: UpdateStatus? get() = info?.let { UpdateStatus.of(it) }

    public fun check(callback: (Result<UpdateStatus>) -> Unit) {
        val task = try {
            manager.appUpdateInfo
        } catch (e: Exception) {
            callback(Result.failure(UpdatesUnavailable.of(e)))
            return
        }
        task.addOnCompleteListener { t ->
            if (t.isSuccessful && t.result != null) {
                info = t.result
                callback(Result.success(UpdateStatus.of(t.result)))
            } else {
                callback(Result.failure(UpdatesUnavailable.of(t.exception)))
            }
        }
    }

    /**
     * Starts the [type] flow ([AppUpdateType.FLEXIBLE] or [AppUpdateType.IMMEDIATE]) on the last
     * [check]'s info. Returns `started`, or the refusal: `no-check`, `not-available`, `type-not-allowed`.
     */
    public fun start(type: Int, activity: Activity, requestCode: Int = REQUEST_CODE): StartResult {
        val i = info ?: return StartResult(false, "no-check")
        if (i.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE &&
            !(type == AppUpdateType.IMMEDIATE && i.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS)
        ) {
            return StartResult(false, "not-available")
        }
        val options = AppUpdateOptions.defaultOptions(type)
        if (!i.isUpdateTypeAllowed(options)) return StartResult(false, "type-not-allowed", i.getFailedUpdatePreconditions(options).toList())
        val started = manager.startUpdateFlowForResult(i, activity, options, requestCode)
        // An AppUpdateInfo is single-use for a flow: the next start needs a fresh check.
        if (started) info = null
        return StartResult(started, if (started) null else "refused")
    }

    /** The result of [start]: [started], or why not ([reason]; [preconditions] Play reported). */
    public data class StartResult(val started: Boolean, val reason: String?, val preconditions: List<Int> = emptyList()) {
        public fun toJson(): JSONObject = JSONObject()
            .put("started", started)
            .put("reason", reason ?: JSONObject.NULL)
            .put("preconditions", JSONArray(preconditions))
    }

    /** Installs a downloaded flexible update (Play restarts the app). */
    public fun complete(callback: (Result<Unit>) -> Unit) {
        val task = try {
            manager.completeUpdate()
        } catch (e: Exception) {
            callback(Result.failure(UpdatesUnavailable.of(e)))
            return
        }
        task.addOnCompleteListener { t ->
            callback(if (t.isSuccessful) Result.success(Unit) else Result.failure(UpdatesUnavailable.of(t.exception)))
        }
    }

    public fun addListener(listener: (InstallProgress) -> Unit) {
        if (listeners.containsKey(listener)) return
        val l = InstallStateUpdatedListener { s -> listener(InstallProgress.of(s)) }
        listeners[listener] = l
        manager.registerListener(l)
    }

    public fun removeListener(listener: (InstallProgress) -> Unit) {
        listeners.remove(listener)?.let { manager.unregisterListener(it) }
    }

    public companion object {
        /** The request code [start] uses by default ("PK"). */
        public const val REQUEST_CODE: Int = 0x504B

        /** `flexible` or `immediate` to an [AppUpdateType], or null. */
        public fun typeOf(name: String): Int? = when (name) {
            "flexible" -> AppUpdateType.FLEXIBLE
            "immediate" -> AppUpdateType.IMMEDIATE
            else -> null
        }

        /** An activity result for [REQUEST_CODE]: `accepted`, `canceled`, `failed` or `unknown`. */
        public fun activityResult(resultCode: Int): String = when (resultCode) {
            Activity.RESULT_OK -> "accepted"
            Activity.RESULT_CANCELED -> "canceled"
            ActivityResult.RESULT_IN_APP_UPDATE_FAILED -> "failed"
            else -> "unknown"
        }
    }
}
