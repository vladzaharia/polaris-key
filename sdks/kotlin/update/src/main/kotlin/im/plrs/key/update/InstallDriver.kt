// The install driver port (registry `update.driver`; P6-08 defines it, P6-12 implements it on
// Android, UK-40 on a JVM desktop): what hands an update decision to the platform's installer. On
// Android that is Play's In-App Updates for a Play install and PackageInstaller for a direct one
// (:platform's `InAppUpdates`, `ApkInstaller`, wired by :android). On a JVM desktop it is
// [DesktopInstallDriver]: the installer for the OS and arch, downloaded, verified against the
// signed release record and opened. [JvmInstallDriver] is the options' default MARKER:
// `UpdateClient.install` replaces it with the desktop driver on a JVM and :android replaces it with
// the flavour's driver; called directly (an Android build without :android) it is the typed
// `runtime` N/A.

package im.plrs.key.update

import im.plrs.key.core.Feature
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.UpdateCheck
import kotlinx.coroutines.flow.StateFlow

/** What an install driver reports. */
public sealed interface InstallResult {
    /** The platform took the update (an immediate or flexible In-App Update, a committed session). */
    public data object Started : InstallResult

    /** The decision asks for nothing to install (`none`, `blocked`, `packs`, …). */
    public data object NothingToInstall : InstallResult

    /** The user or the platform declined; [detail] says why. */
    public data class Declined(val detail: String) : InstallResult

    /** The platform installer failed; [code] is a registry code. */
    public data class Failed(val code: String, val detail: String? = null) : InstallResult
}

/** Hands an update decision to the platform's installer. */
public fun interface InstallDriver {
    public suspend fun install(check: UpdateCheck): InstallResult
}

/**
 * Where an install the platform downloads in the background stands (a Play flexible update; notes/
 * SDK-PARITY-PASS.md §3.16, §3.18 `UpdatePrompt`): the update prompt shows the progress and then
 * "Restart to finish", which calls [ProgressiveInstallDriver.finish].
 */
public sealed interface InstallStage {
    /** Nothing in flight. */
    public data object Idle : InstallStage

    /** Downloading: [done] of [total] bytes (total 0 while unknown). */
    public data class Downloading(val done: Long, val total: Long) : InstallStage

    /** Downloaded: a restart ([ProgressiveInstallDriver.finish]) installs it. */
    public data object ReadyToRestart : InstallStage

    /** The download or the install failed, or the user cancelled it; [code] is a registry code. */
    public data class Failed(val code: String, val detail: String? = null) : InstallStage
}

/** A driver whose install continues after [install] returns, and finishes with a restart. */
public interface ProgressiveInstallDriver : InstallDriver {
    /** The background install's stage; [InstallStage.Idle] until one starts. */
    public val progress: StateFlow<InstallStage>

    /** Install a downloaded update (the app restarts); `NothingToInstall` when none is downloaded. */
    public suspend fun finish(): InstallResult

    /**
     * Re-read the platform's state when the app returns to the foreground (an update that finished
     * downloading while it was away becomes [InstallStage.ReadyToRestart]).
     */
    public suspend fun resume() {}
}

/** The default marker (see the file comment); installing through it directly is the typed `runtime` N/A. */
public object JvmInstallDriver : InstallDriver {
    override suspend fun install(check: UpdateCheck): InstallResult = throw UnsupportedException(
        Unsupported(Feature.updateDriver, UnsupportedReason.runtime, "no platform install driver is wired here; use UpdateClient.install, or offer UpdateClient.buildUrl as a download link"),
    )
}
