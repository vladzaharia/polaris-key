// The state-to-copy mapping: pure functions from SDK state to the strings a screen shows, so the
// mapping is unit-tested without rendering (PolarisCopyMappingTest) and every screen and test
// share one source of truth. Mirrors Swift's `PolarisCopy.message(for:allowedRange:)`.

package im.plrs.key.ui

import im.plrs.key.core.AllowedRange
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootStage
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/** The glyph a message card shows; the screen picks the icon, the mapping picks the meaning. */
public enum class PolarisMessageKind { Info, Warning, Danger, Blocked, Offline, Locked }

/** The resolved copy of one full-screen message (a terminal gate state, a boot stop). */
public data class PolarisMessageCopy(
    val title: String,
    val body: String,
    val kind: PolarisMessageKind,
)

/** Format a positional template (`%1$s`, `%2$s`, `%%`) with string arguments. */
public fun PolarisCopy.format(template: String, vararg args: Any): String =
    String.format(Locale.ROOT, template, *args.map { it.toString() }.toTypedArray())

/**
 * The message a terminal gate status renders, or null when it renders none: `ok` and
 * `not-applicable` show the product, `grace` shows a banner over it, and `needs-activation` shows
 * the activation screen.
 */
public fun PolarisCopy.gateMessage(status: LicenseStatus, allowedRange: AllowedRange? = null): PolarisMessageCopy? =
    when (status) {
        LicenseStatus.ok, LicenseStatus.grace, LicenseStatus.needsActivation, LicenseStatus.notApplicable -> null
        LicenseStatus.revoked -> PolarisMessageCopy(revokedTitle, revokedBody, PolarisMessageKind.Locked)
        LicenseStatus.expired -> PolarisMessageCopy(expiredTitle, expiredBody, PolarisMessageKind.Warning)
        LicenseStatus.versionTooOld ->
            PolarisMessageCopy(versionTooOldTitle, withAllowedRange(versionTooOldBody, allowedRange), PolarisMessageKind.Blocked)
        LicenseStatus.versionTooNew ->
            PolarisMessageCopy(versionTooNewTitle, withAllowedRange(versionTooNewBody, allowedRange), PolarisMessageKind.Blocked)
        LicenseStatus.channelNotEntitled ->
            PolarisMessageCopy(channelNotEntitledTitle, channelNotEntitledBody, PolarisMessageKind.Blocked)
    }

/** The body of a version block with the server's allowed window appended, when it gave one. */
public fun PolarisCopy.withAllowedRange(body: String, range: AllowedRange?): String {
    val min = range?.min?.takeIf { it.isNotBlank() }
    val max = range?.max?.takeIf { it.isNotBlank() }
    val window = when {
        min != null && max != null -> format(versionRange, min, max)
        min != null -> format(versionMin, min)
        max != null -> format(versionMax, max)
        else -> return body
    }
    return body + "\n" + format(versionAllowed, window)
}

/** The grace banner's body: how long is left, when the licence says. */
public fun PolarisCopy.graceBody(graceUntilSeconds: Long?, nowSeconds: Long): String =
    if (graceUntilSeconds == null || graceUntilSeconds <= nowSeconds) graceBodyNoDeadline
    else format(graceBody, duration(graceUntilSeconds - nowSeconds))

/** The error an activation result shows, or null for success. */
public fun PolarisCopy.activationMessage(result: ActivationResult): String? = when (result) {
    is ActivationResult.Ok -> null
    is ActivationResult.DeviceLimit ->
        if (result.limit != null && result.deviceCount != null) format(activationDeviceLimitCount, result.deviceCount!!, result.limit!!)
        else activationDeviceLimit
    ActivationResult.Unauthorized -> activationUnauthorized
    ActivationResult.FingerprintRequired -> activationFingerprintRequired
    is ActivationResult.HardwareMismatch -> activationHardwareMismatch
    ActivationResult.EnrollDisabled -> activationEnrollDisabled
    // The SDK's message is for logs; the player sees the kit's copy.
    is ActivationResult.Error -> activationError
}

/** The label under the progress indicator while the boot runs through [stage]. */
public fun PolarisCopy.bootStageLabel(stage: BootStage): String = when (stage) {
    BootStage.idle, BootStage.shell, BootStage.guard -> bootStarting
    BootStage.sync -> bootSyncing
    BootStage.gate -> bootGate
    BootStage.decide -> bootDeciding
    BootStage.fetch -> bootFetching
    BootStage.mount -> bootMounting
    BootStage.ready, BootStage.background -> bootReady
    BootStage.offline -> bootOfflineTitle
    BootStage.blocked -> bootBlockedUpdateTitle
    BootStage.error -> bootErrorTitle
}

/** The message a blocked boot shows. */
public fun PolarisCopy.blockedMessage(reason: BootEmit.BlockedReason): PolarisMessageCopy = when (reason) {
    BootEmit.BlockedReason.updateRequired ->
        PolarisMessageCopy(bootBlockedUpdateTitle, bootBlockedUpdateBody, PolarisMessageKind.Blocked)
    BootEmit.BlockedReason.notAvailable ->
        PolarisMessageCopy(bootBlockedUnavailableTitle, bootBlockedUnavailableBody, PolarisMessageKind.Blocked)
    BootEmit.BlockedReason.contentDeclined ->
        PolarisMessageCopy(bootDeclinedTitle, bootDeclinedBody, PolarisMessageKind.Info)
}

/** The message an offline stop shows; [canPlayOffline] is the playable stop of stage-matrix v3. */
public fun PolarisCopy.offlineMessage(canPlayOffline: Boolean): PolarisMessageCopy =
    PolarisMessageCopy(bootOfflineTitle, if (canPlayOffline) bootOfflinePlayableBody else bootOfflineBody, PolarisMessageKind.Offline)

/** The message an error stop shows, naming the SDK error code. */
public fun PolarisCopy.errorMessage(code: String): PolarisMessageCopy =
    PolarisMessageCopy(bootErrorTitle, format(bootErrorBody, code), PolarisMessageKind.Danger)

/** The consent card's body for a fetch of [bytes]. */
public fun PolarisCopy.consentMessage(bytes: Long, metered: Boolean): String =
    format(if (metered) consentBodyMetered else consentBody, bytes(bytes))

/** The settings badge for a licence status. */
public fun PolarisCopy.entitlementLabel(status: LicenseStatus): String = when (status) {
    LicenseStatus.ok -> entitlementLicensed
    LicenseStatus.grace -> entitlementGrace
    LicenseStatus.expired -> entitlementExpired
    LicenseStatus.revoked -> entitlementRevoked
    LicenseStatus.needsActivation -> entitlementInactive
    LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled -> entitlementBlocked
    LicenseStatus.notApplicable -> entitlementNotApplicable
}

/** A human duration, rounded down to its largest unit: "3 days", "1 hour", "less than a minute". */
public fun PolarisCopy.duration(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    val days = s / 86_400
    val hours = s / 3_600
    val minutes = s / 60
    return when {
        days >= 2 -> format(durationDays, days)
        days == 1L -> durationDay
        hours >= 2 -> format(durationHours, hours)
        hours == 1L -> durationHour
        minutes >= 2 -> format(durationMinutes, minutes)
        minutes == 1L -> durationMinute
        else -> durationLessThanMinute
    }
}

/** "5 minutes ago", or "just now" under a minute. */
public fun PolarisCopy.ago(seconds: Long): String =
    if (seconds < 60) timeJustNow else format(timeAgo, duration(seconds))

/** A countdown clock: `m:ss`, or `h:mm:ss` from an hour. */
public fun countdown(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    val h = s / 3_600
    val m = (s % 3_600) / 60
    val sec = s % 60
    return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(Locale.ROOT, "%d:%02d", m, sec)
}

/** A byte count in decimal units with at most one decimal: "512 B", "1.5 MB", "2 GB". */
public fun PolarisCopy.bytes(count: Long, locale: Locale = Locale.getDefault()): String {
    val n = count.coerceAtLeast(0)
    val fmt = DecimalFormat("#,##0.#", DecimalFormatSymbols.getInstance(locale))
    return when {
        n < 1_000 -> format(bytesB, n)
        n < 1_000_000 -> format(bytesKb, fmt.format(n / 1_000.0))
        n < 1_000_000_000 -> format(bytesMb, fmt.format(n / 1_000_000.0))
        else -> format(bytesGb, fmt.format(n / 1_000_000_000.0))
    }
}
