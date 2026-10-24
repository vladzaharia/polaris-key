// The state holders of the desktop windows (UK-10.8, K3): plain classes, so a test drives them without
// opening a window. PolarisWindows.desktop.kt draws them in real OS windows.
//
//   - Which surface an update takes: an optional one is its own window, a mandatory one a dialog inside the
//     gate window with no close, "Restart to finish" the banner (updateRoute).
//   - The Settings window: closed, or open on one pane (Account or Devices); the pane names the title.
//   - The gate window: the Settings window, the manual "Check for updates" and the sign-out question.
//   - The menu's labels, from the catalog: "Check for updates" and "Manage license", and on macOS the
//     title-case `macos` variants with their ellipsis ("Check for Updates…").

package im.plrs.key.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import im.plrs.key.core.UpdateCheck
import kotlinx.coroutines.CancellationException

/** Where an update on offer is shown. */
public enum class PolarisUpdateRoute {
    /** Nothing is on offer. */
    None,

    /** An optional update: its own window (one column, not resizable, sized to its content). */
    Window,

    /** A mandatory update: a dialog inside the gate window, with no close. */
    Dialog,

    /** "Restart to finish": the banner over the app. */
    Banner,
}

/** The surface [ui] takes on the desktop. */
public fun updateRoute(ui: PolarisUpdateUi?): PolarisUpdateRoute = when {
    ui == null -> PolarisUpdateRoute.None
    ui.kind == PolarisUpdateUi.Kind.Restart -> PolarisUpdateRoute.Banner
    ui.mandatory -> PolarisUpdateRoute.Dialog
    else -> PolarisUpdateRoute.Window
}

/** The panes of the Settings window. */
public enum class PolarisSettingsPane { Account, Devices }

/** Whether the Settings window is open and on which pane. */
public class PolarisSettingsWindowState(initial: PolarisSettingsPane? = null) {
    /** The open pane, or null while the window is closed. */
    public var pane: PolarisSettingsPane? by mutableStateOf(initial)
        private set

    public val isOpen: Boolean get() = pane != null

    /** Opens the window on [pane] (or switches an open one to it). */
    public fun open(pane: PolarisSettingsPane = PolarisSettingsPane.Account) {
        this.pane = pane
    }

    /** Closes the window; Escape and the OS close button do this. */
    public fun close() {
        pane = null
    }
}

/** How the last manual "Check for updates" went. */
public enum class PolarisCheckStatus { Idle, Checking, UpToDate, Offered, Failed }

/** The gate window's own state: its Settings window, the manual update check and the sign-out question. */
public class PolarisKeyWindowState {
    public val settings: PolarisSettingsWindowState = PolarisSettingsWindowState()

    public var check: PolarisCheckStatus by mutableStateOf(PolarisCheckStatus.Idle)
        private set

    /** True while "Sign out" waits for the person's answer. */
    public var askingSignOut: Boolean by mutableStateOf(false)
        private set

    internal var checkAction: () -> Unit = {}

    /** The menu's "Check for updates", once a window has wired it. */
    public fun requestCheck(): Unit = checkAction()

    /** The menu's "Manage license": the Settings window on the Account pane. */
    public fun manageLicense(): Unit = settings.open(PolarisSettingsPane.Account)

    /** Sign out asks first (SIGN-IN.md D-71); [confirmSignOut] or [cancelSignOut] answers. */
    public fun requestSignOut() {
        askingSignOut = true
    }

    public fun cancelSignOut() {
        askingSignOut = false
    }

    /** Answers yes: runs [signOut] and closes the question. */
    public fun confirmSignOut(signOut: () -> Unit) {
        askingSignOut = false
        signOut()
    }

    public fun dismissCheck() {
        if (check != PolarisCheckStatus.Checking) check = PolarisCheckStatus.Idle
    }

    /**
     * The menu's "Check for updates": [decide] reads the decision, [update] offers it again even when the
     * person dismissed or skipped that version. One check runs at a time.
     */
    public suspend fun checkForUpdates(update: PolarisUpdateState, decide: suspend () -> UpdateCheck) {
        if (check == PolarisCheckStatus.Checking) return
        check = PolarisCheckStatus.Checking
        check = try {
            if (update.showRequested(decide())) PolarisCheckStatus.Offered else PolarisCheckStatus.UpToDate
        } catch (e: CancellationException) {
            check = PolarisCheckStatus.Idle
            throw e
        } catch (e: Exception) {
            PolarisCheckStatus.Failed
        }
    }
}

/** The menu's labels, found by catalog key (`update.checkNow`, `menu.manageLicense`, `menu.signOut`). */
public class PolarisMenuLabels internal constructor(
    public val checkForUpdates: String,
    public val manageLicense: String,
    public val signOut: String,
) {
    public companion object {
        /** The labels for [variant] in [locale]: macOS reads the `macos` variants (title case, an ellipsis). */
        public fun of(variant: PolarisPlatformVariant, locale: String): PolarisMenuLabels {
            val catalog = KitCopy.bundled
            val copyVariant = if (variant == PolarisPlatformVariant.MacOS) CopyVariant.macos else null
            return PolarisMenuLabels(
                checkForUpdates = catalog.format("update.checkNow", locale, variant = copyVariant),
                manageLicense = catalog.format("menu.manageLicense", locale, variant = copyVariant),
                signOut = catalog.format("menu.signOut", locale, variant = copyVariant),
            )
        }
    }
}
