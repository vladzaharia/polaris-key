// Every string the kit renders, chrome included. Two ways to change it:
//
// - per app, in code: `PolarisTheme(copy = PolarisCopy(productName = "Diceroll", signIn = "Log in"))`;
// - per locale, in resources: every field has a string resource named `pkey_ui_<snake_case>` with
//   the English default (res/values/strings.xml). An app that ships `values-fr/strings.xml` with
//   the same names translates the kit, and `PolarisCopy.localized()` (the default PolarisTheme
//   uses) reads them.
//
// The English defaults here and in strings.xml are the same text; PolarisCopyTest fails when they
// drift. Templates use positional `%1$s` placeholders so a translation can reorder them.
//
// The state-to-copy mapping (which title a revoked licence shows, how an activation error reads)
// is in PolarisCopyMapping.kt as pure functions, unit-tested without rendering, as in Swift.

package im.plrs.key.ui

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext

/** User-facing copy for every screen of the kit. */
@Immutable
public data class PolarisCopy(
    /** The product's name, used in the activation welcome. */
    val productName: String = "this app",

    // ── PolarisBoot ──────────────────────────────────────────────────────────────────────────
    val bootStarting: String = "Starting…",
    val bootSyncing: String = "Checking for updates…",
    val bootGate: String = "Checking your license…",
    val bootDeciding: String = "Looking for a newer version…",
    val bootFetching: String = "Downloading content…",
    val bootMounting: String = "Loading…",
    val bootReady: String = "Ready",
    val bootOfflineTitle: String = "You're offline",
    val bootOfflineBody: String = "Connect to the internet and try again.",
    val bootOfflinePlayableBody: String = "Some content couldn't be downloaded. You can play with what's installed, or connect and try again.",
    val bootErrorTitle: String = "Something went wrong",
    val bootErrorBody: String = "The app couldn't finish starting (%1\$s).",
    val bootBlockedUpdateTitle: String = "Update required",
    val bootBlockedUpdateBody: String = "This version can no longer be used. Update to continue.",
    val bootBlockedUnavailableTitle: String = "Not available on your license",
    val bootBlockedUnavailableBody: String = "This build isn't available on your license.",
    val bootDeclinedTitle: String = "Content not downloaded",
    val bootDeclinedBody: String = "The app needs this content to start. Try again when you're ready.",
    val bootRolledBack: String = "The last update didn't start, so the previous version was restored.",
    val consentTitle: String = "Download content?",
    val consentBody: String = "%1\$s of new content is needed.",
    val consentBodyMetered: String = "%1\$s of new content is needed, and you're on a metered connection.",
    val consentDownload: String = "Download",
    val consentLater: String = "Not now",
    val retry: String = "Try again",
    val playOffline: String = "Play offline",
    val cancel: String = "Cancel",
    val close: String = "Close",
    val loading: String = "Loading",

    // ── Gate ─────────────────────────────────────────────────────────────────────────────────
    val gateLoading: String = "Checking your license…",
    val graceTitle: String = "Offline grace period",
    val graceBody: String = "We couldn't reach the license server. You can keep working for %1\$s.",
    val graceBodyNoDeadline: String = "We couldn't reach the license server. You can keep working for now.",
    val expiredTitle: String = "License expired",
    val expiredBody: String = "Connect to the internet to renew your license.",
    val revokedTitle: String = "License revoked",
    val revokedBody: String = "This license is no longer valid on this device. Sign in or activate again to continue.",
    val versionTooOldTitle: String = "Update required",
    val versionTooOldBody: String = "This version is no longer supported. Update to continue.",
    val versionTooNewTitle: String = "Version not yet allowed",
    val versionTooNewBody: String = "This build is newer than your license allows.",
    val channelNotEntitledTitle: String = "Channel not included",
    val channelNotEntitledBody: String = "Your license doesn't include this release channel.",
    val versionAllowed: String = "Allowed versions: %1\$s",
    val versionMin: String = "%1\$s or later",
    val versionMax: String = "up to %1\$s",
    val versionRange: String = "%1\$s to %2\$s",
    val reconnect: String = "Reconnect",

    // ── Activation ───────────────────────────────────────────────────────────────────────────
    val activationTitle: String = "Welcome to %1\$s",
    val activationSubtitle: String = "Sign in or enter a license key to continue.",
    val activationSubtitleKeyOnly: String = "Enter a license key to continue.",
    val signIn: String = "Sign in",
    val orDivider: String = "or",
    val keyLabel: String = "License key",
    val keyPlaceholder: String = "pkey_…",
    val activate: String = "Activate",
    val activating: String = "Activating…",
    val activationKeyEmpty: String = "Enter a license key first.",
    val activationDeviceLimit: String = "This license has reached its device limit.",
    val activationDeviceLimitCount: String = "This license has reached its device limit (%1\$s of %2\$s devices).",
    val activationUnauthorized: String = "That license key wasn't accepted.",
    val activationFingerprintRequired: String = "This license needs a hardware fingerprint, which couldn't be read on this device.",
    val activationHardwareMismatch: String = "This device's hardware changed. The previous authorization was released; activate again to re-bind.",
    val activationEnrollDisabled: String = "This app doesn't offer a free tier.",
    val activationError: String = "Activation failed. Check your connection and try again.",

    // ── Sign-in with QR (RFC 8628) ───────────────────────────────────────────────────────────
    val signInTitle: String = "Sign in",
    val signInStarting: String = "Getting a sign-in code…",
    val signInInstructions: String = "Scan the code with your phone, or go to %1\$s and enter this code:",
    val signInQrDescription: String = "QR code that opens the sign-in page",
    val signInCodeDescription: String = "Sign-in code %1\$s",
    val signInOpenBrowser: String = "Open sign-in page",
    val signInExpiresIn: String = "Code expires in %1\$s",
    val signInWaiting: String = "Waiting for you to finish signing in…",
    val signInDone: String = "Signed in.",
    val signInExpired: String = "The code expired before sign-in finished.",
    val signInError: String = "Sign-in failed. Check your connection and try again.",
    val signInNewCode: String = "Get a new code",

    // ── Settings ─────────────────────────────────────────────────────────────────────────────
    val settingsTitle: String = "Settings",
    val settingsEmpty: String = "There are no settings to show.",
    val settingsLicense: String = "License",
    val settingsValues: String = "Configuration",
    val settingsLocked: String = "Set by your organization",
    val settingsSourceLocal: String = "Changed on this device",
    val settingsSourceEnv: String = "Set by the environment",
    val settingsSourceDefault: String = "Default",
    val settingsSourceFallback: String = "Built-in default",
    val entitlementLicensed: String = "Licensed",
    val entitlementGrace: String = "Offline grace",
    val entitlementExpired: String = "Expired",
    val entitlementRevoked: String = "Revoked",
    val entitlementInactive: String = "Not activated",
    val entitlementBlocked: String = "Blocked",
    val entitlementNotApplicable: String = "No license needed",
    val licensedTo: String = "Licensed to %1\$s",

    // ── Devices ──────────────────────────────────────────────────────────────────────────────
    val devicesTitle: String = "Devices",
    val devicesSubtitle: String = "Devices signed in with this license.",
    val devicesEmpty: String = "No devices yet.",
    val devicesError: String = "Couldn't load your devices.",
    val deviceThis: String = "This device",
    val deviceUnnamed: String = "Unnamed device",
    val deviceLastVerified: String = "Last checked %1\$s",
    val deviceRename: String = "Rename",
    val deviceRenameTitle: String = "Rename device",
    val deviceRenameLabel: String = "Device name",
    val deviceSave: String = "Save",
    val deviceDeauthorize: String = "Sign out",
    val deviceDeauthorizeTitle: String = "Sign out this device?",
    val deviceDeauthorizeBody: String = "%1\$s will need to sign in or activate again.",
    val deviceRenameDescription: String = "Rename %1\$s",
    val deviceDeauthorizeDescription: String = "Sign out %1\$s",

    // ── Update ───────────────────────────────────────────────────────────────────────────────
    val updateAvailable: String = "Version %1\$s is available",
    val updateAvailableGeneric: String = "An update is available",
    val updateCritical: String = "This update includes an important security fix.",
    val updateAction: String = "Update",
    val updateDismiss: String = "Dismiss",
    val updatePromptTitle: String = "Update available",
    val updatePromptBody: String = "Version %1\$s is ready to install.",
    val updateRequiredTitle: String = "Update required",
    val updateRequiredBody: String = "Version %1\$s is required to keep using this app.",
    val updateNow: String = "Update now",
    val updateLater: String = "Later",
    val updateRestart: String = "Restart to update",
    val updateRestartBody: String = "Version %1\$s is ready. Restart to finish updating.",

    // ── Pack progress ────────────────────────────────────────────────────────────────────────
    val packsTitle: String = "Downloading content",
    val packsDownloading: String = "Downloading",
    val packsInstalling: String = "Installing",
    val packsDone: String = "Done",
    val packsIssue: String = "Needs repair",
    val packsBytes: String = "%1\$s of %2\$s",
    val packsPercent: String = "%1\$s%%",
    val packsComplete: String = "All content is up to date.",

    // ── Units ────────────────────────────────────────────────────────────────────────────────
    val durationDays: String = "%1\$s days",
    val durationDay: String = "1 day",
    val durationHours: String = "%1\$s hours",
    val durationHour: String = "1 hour",
    val durationMinutes: String = "%1\$s minutes",
    val durationMinute: String = "1 minute",
    val durationLessThanMinute: String = "less than a minute",
    val timeAgo: String = "%1\$s ago",
    val timeJustNow: String = "just now",
    val bytesB: String = "%1\$s B",
    val bytesKb: String = "%1\$s KB",
    val bytesMb: String = "%1\$s MB",
    val bytesGb: String = "%1\$s GB",

    // ── Chrome ───────────────────────────────────────────────────────────────────────────────
    /** The accessible name of the "Powered by Polaris Key" badge (the brand phrase). */
    val poweredBy: String = "Powered by Polaris Key",
    /** The accessible name of the Pinned K when branding is on. */
    val polarisKeyMark: String = "Polaris Key",
) {
    public companion object {
        /** The resource name for a field: `pkey_ui_` + its name in snake case. */
        public fun resourceName(field: String): String =
            "pkey_ui_" + field.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").lowercase()

        /**
         * The copy from string resources: the kit's English defaults, or the app's translation of
         * them for the current locale. Fields with no resource keep the English default.
         */
        public fun fromResources(resources: Resources, packageName: String): PolarisCopy {
            val defaults = PolarisCopy()
            val values = HashMap<String, String>()
            for (field in FIELDS) {
                @Suppress("DiscouragedApi") // the names are data (FIELDS), so ids cannot be static
                val id = resources.getIdentifier(resourceName(field), "string", packageName)
                if (id != 0) values[field] = resources.getString(id)
            }
            return defaults.with(values)
        }

        /** The copy for the current configuration (locale), read from string resources. */
        @Composable
        public fun localized(): PolarisCopy {
            val context = LocalContext.current
            val configuration = LocalConfiguration.current
            return remember(context, configuration) {
                fromResources(context.resources, context.packageName)
            }
        }

        /** Every field name, in declaration order. */
        public val FIELDS: List<String> by lazy {
            PolarisCopy::class.java.declaredFields
                .filter { it.type == String::class.java && !java.lang.reflect.Modifier.isStatic(it.modifiers) }
                .map { it.name }
        }
    }

    /** This copy with the named fields replaced (unknown names are ignored). */
    public fun with(values: Map<String, String>): PolarisCopy {
        if (values.isEmpty()) return this
        val copy = this.copy()
        for (field in PolarisCopy::class.java.declaredFields) {
            val value = values[field.name] ?: continue
            if (field.type != String::class.java) continue
            field.isAccessible = true
            field.set(copy, value)
        }
        return copy
    }

    /** All fields by name. */
    public fun asMap(): Map<String, String> = FIELDS.associateWith { name ->
        val field = PolarisCopy::class.java.getDeclaredField(name)
        field.isAccessible = true
        field.get(this) as String
    }
}
