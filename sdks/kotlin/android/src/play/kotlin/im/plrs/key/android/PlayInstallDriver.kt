// update.driver on a play build (P6-12): :update's InstallDriver over :platform's InAppUpdates. The
// play build carries no installer code (no PackageInstaller session, no install permission;
// tools/check_flavours.sh).
//
// Play is authoritative for availability on its outlet: rollouts are staged per device, so the
// server's "latest" is advisory (notes/E2 §A2). A `store` decision asks Play and acts on what Play
// says, as Godot's play adapter does (P5-06, notes/S-10 §Results 1):
//
//   Play says                               not urgent                urgent
//   downloaded (installStatus 11)           complete (restarts)       complete (restarts)
//   in progress (availability 3, 1-3)       Started, nothing to do    resume the immediate flow
//   available (2), the type allowed         flexible flow             immediate if allowed, else flexible
//   not offered yet (1)                     Declined(play-staging)    Failed: offer the listing
//   any failure                             Failed: offer the listing Failed: offer the listing
//
// "Urgent" is the decision's `mandatory` or `critical`, and, when the host sets them, Play's own
// signals: an update priority at or above [PlayUpdatePolicy.immediatePriority], or a staleness of
// at least [PlayUpdatePolicy.immediateAfterDays]. Both are off by default (Godot's behaviour). The
// flow's outcome arrives as the host activity's result for InAppUpdates.REQUEST_CODE
// (InAppUpdates.activityResult maps it); a failed or cancelled flow is offered again at the next
// check. Call from Android's main thread: Play's callbacks arrive there.

package im.plrs.key.android

import android.app.Activity
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.UpdateEvent
import im.plrs.key.core.UpdateEventJournal
import im.plrs.key.platform.play.InAppUpdates
import im.plrs.key.platform.play.UpdateStatus
import im.plrs.key.update.InstallDriver
import im.plrs.key.update.InstallResult
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** Play In-App Updates as :update's install driver. */
public class PlayInstallDriver(
    private val updates: InAppUpdates,
    /** The activity In-App Updates' flows start from (the host's current one). */
    private val activity: () -> Activity?,
    private val policy: PlayUpdatePolicy = PlayUpdatePolicy(),
    /** Where `update_downloaded` and `update_applied` are journaled (notes/SDK-PARITY-PASS.md §3.13); null: nowhere. */
    private val events: () -> UpdateEventJournal? = { null },
    /** The running version, the events' `fromRelease`. */
    private val runningVersion: String? = null,
) : InstallDriver {
    /** The last status Play reported to this driver, or null. */
    @Volatile public var lastStatus: UpdateStatus? = null
        private set

    override suspend fun install(check: UpdateCheck): InstallResult = when (val d = check.decision) {
        is UpdateDecision.Store -> inAppUpdate(d.mandatory || d.critical, d.listingUrl, d.release.version)
        // A `platform` answer: the platform updates this install by itself.
        is UpdateDecision.Platform -> InstallResult.NothingToInstall
        is UpdateDecision.Binary -> InstallResult.Failed(
            ErrorCode.unsupported,
            "a play build carries no installer (binary ${d.method}); offer UpdateClient.buildUrl, or ship the direct flavour",
        )
        else -> InstallResult.NothingToInstall
    }

    private suspend fun inAppUpdate(decisionUrgent: Boolean, listingUrl: String?, release: String): InstallResult {
        val offer = listingUrl?.let { "; offer the listing $it" } ?: ""
        val status = suspendCancellableCoroutine { cont -> updates.check { cont.resume(it) } }.getOrElse {
            return InstallResult.Failed(ErrorCode.platformError, "In-App Updates are unavailable (${it.message})$offer")
        }
        lastStatus = status
        val urgent = decisionUrgent ||
            policy.immediatePriority?.let { status.priority >= it } == true ||
            policy.immediateAfterDays?.let { days -> status.stalenessDays?.let { it >= days } } == true
        if (status.readyToComplete || status.installStatus == InstallStatus.DOWNLOADED) {
            events()?.recordOnce(UpdateEvent.updateDownloaded, release, fromRelease = runningVersion)
            val done = suspendCancellableCoroutine { cont -> updates.complete { cont.resume(it) } }
            if (done.isSuccess) events()?.record(UpdateEvent.updateApplied, release, fromRelease = runningVersion)
            return if (done.isSuccess) InstallResult.Started else InstallResult.Failed(ErrorCode.platformError, "Play could not complete the downloaded update (${done.exceptionOrNull()?.message})$offer")
        }
        if (status.availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS &&
            status.installStatus in InstallStatus.PENDING..InstallStatus.INSTALLING
        ) {
            // Play's resume rule: an interrupted immediate update is started again as is.
            return if (urgent) start(AppUpdateType.IMMEDIATE, offer) else InstallResult.Started
        }
        if (status.availability == UpdateAvailability.UPDATE_AVAILABLE) {
            val type = when {
                urgent && status.immediateAllowed -> AppUpdateType.IMMEDIATE
                status.flexibleAllowed -> AppUpdateType.FLEXIBLE
                status.immediateAllowed -> AppUpdateType.IMMEDIATE
                else -> return InstallResult.Failed(ErrorCode.platformError, "Play allows neither a flexible nor an immediate update now$offer")
            }
            return start(type, offer)
        }
        if (status.availability == UpdateAvailability.UPDATE_NOT_AVAILABLE && !urgent) {
            // Play has not offered this update to this device yet (a staged rollout): nothing to show.
            return InstallResult.Declined(STAGING)
        }
        return InstallResult.Failed(ErrorCode.platformError, "Play does not offer the update to this device (availability ${status.availability})$offer")
    }

    private fun start(type: Int, offer: String): InstallResult {
        val host = activity() ?: return InstallResult.Failed(ErrorCode.platformError, "no activity to start the In-App Update from$offer")
        val r = updates.start(type, host)
        return if (r.started) InstallResult.Started else InstallResult.Failed(ErrorCode.platformError, "Play refused the In-App Update (${r.reason})$offer")
    }

    public companion object {
        /** [InstallResult.Declined]'s detail while Play stages the rollout away from this device. */
        public const val STAGING: String = "play-staging"
    }
}
