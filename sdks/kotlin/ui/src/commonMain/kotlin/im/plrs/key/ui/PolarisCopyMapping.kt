// The state-to-copy mapping: pure functions from SDK state to the strings a screen shows, so the
// mapping is unit-tested without rendering (PolarisCopyMappingTest) and every screen and test
// share one source of truth. Mirrors Swift's `PolarisCopy.message(for:allowedRange:)`.

package im.plrs.key.ui

import im.plrs.key.core.AllowedRange
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootStage
import im.plrs.key.core.Copy
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/** The glyph a message card shows; the screen picks the icon, the mapping picks the meaning. */
public enum class PolarisMessageKind {
    Info,
    Warning,
    Danger,

    /** A refusal the person can resolve (revoked, expired, version or channel): neutral, never danger (DL6). */
    Blocked,
    Offline,

    /** The kind revoked licences used before DL6 made every resolvable refusal neutral; drawn as [Blocked]. */
    Locked,
}

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
        // core.copy's gate entries: "Signed out", "License expired" (UI-KITS.md: gate copy is core copy).
        LicenseStatus.revoked -> coreMessage("revoked", PolarisMessageKind.Blocked)
        LicenseStatus.expired -> coreMessage("expired", PolarisMessageKind.Blocked)
        LicenseStatus.versionTooOld ->
            PolarisMessageCopy(versionTooOldTitle, withAllowedRange(format(versionTooOldBody, productName), allowedRange), PolarisMessageKind.Blocked)
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

/**
 * The grace banner's headline (UI-KITS.md 4.1 GraceBanner): the count of days left ("Offline · 3
 * days left", grace.daysLeft), or on the last day "Offline · last day to use Diceroll" (grace.lastDay).
 * Without a deadline it is the kit's own [graceTitle]. The wording is the catalog's, in [locale].
 */
public fun PolarisCopy.graceHeadline(graceUntilSeconds: Long?, nowSeconds: Long, locale: String = coreLocale()): String {
    if (graceUntilSeconds == null || graceUntilSeconds <= nowSeconds) return graceTitle
    val days = (graceUntilSeconds - nowSeconds + 86_399) / 86_400
    return if (days <= 1) {
        KitCopy.bundled.format("grace.lastDay", locale, mapOf("product" to CopyArgument.Text(productName)))
    } else {
        KitCopy.bundled.format("grace.daysLeft", locale, mapOf("days" to CopyArgument.Number(days.toInt())))
    }
}

/**
 * The grace banner's body: when offline use ends ("Works offline until Nov 4, 2026", grace.deadline),
 * in [locale] and the device's time zone, or the no-deadline sentence when the licence names none.
 */
public fun PolarisCopy.graceBody(graceUntilSeconds: Long?, nowSeconds: Long, locale: String = coreLocale()): String {
    if (graceUntilSeconds == null || graceUntilSeconds <= nowSeconds) return graceBodyNoDeadline
    // java.text, not java.time: the latter needs API 26 and the kit supports 24 without desugaring.
    val date = java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM, Locale.forLanguageTag(locale))
        .format(java.util.Date(graceUntilSeconds * 1000L))
    return KitCopy.bundled.format("grace.deadline", locale, mapOf("date" to CopyArgument.Text(date)))
}

/**
 * The error an activation result shows, or null for success: one message per §3.1 kind
 * (notes/SDK-PARITY-PASS.md), by code. A refusal reads [errorCodeMessage] (the kit's field, else the
 * core catalog); a code neither knows shows a generic message naming it, never the raw body.
 */
public fun PolarisCopy.activationMessage(result: ActivationResult): String? = when (result) {
    is ActivationResult.Ok -> null
    // core.copy's activation entry; the screen adds the seat caption (seatCaption) under it.
    is ActivationResult.DeviceLimit -> Copy.activationMessage(im.plrs.key.core.ErrorCode.deviceLimit, locale = coreLocale())
    is ActivationResult.KeyEntryLimit -> errorCodeMessage(result.code) ?: Copy.message(result.code, locale = coreLocale())
    is ActivationResult.LicenseOwned -> errorCodeMessage(result.code) ?: Copy.message(result.code, locale = coreLocale())
    ActivationResult.Unauthorized -> activationUnauthorized
    ActivationResult.FingerprintRequired -> activationFingerprintRequired
    is ActivationResult.HardwareMismatch -> activationHardwareMismatch
    ActivationResult.EnrollDisabled -> activationEnrollDisabled
    ActivationResult.EnrollClaimed -> activationEnrollClaimed
    ActivationResult.LicenseDisabled -> activationLicenseDisabled
    ActivationResult.LicenseExpired -> activationLicenseExpired
    ActivationResult.AttestationRequired -> activationAttestationRequired
    is ActivationResult.RateLimited ->
        result.retryAfterSeconds?.takeIf { it > 0 }?.let { format(activationRateLimitedFor, duration(it)) } ?: activationRateLimited
    // A refusal reads its core.copy message; a code the catalog does not know reads core.copy's
    // fallback, which names the code (never the server's body).
    is ActivationResult.Refused -> errorCodeMessage(result.code) ?: Copy.message(result.code, locale = coreLocale())
    // The SDK's message is for logs; the player sees the kit's copy.
    is ActivationResult.Error -> if (result.code == im.plrs.key.core.ErrorCode.network) activationNetwork else activationError
}

/**
 * The copy for a registry error code, or null when there is none. The codes the kit has a field for
 * (the activation refusals and the shared ones) read that field, so a host override or a string
 * resource still wins; every other code the core catalog knows reads `Copy.message` (core.copy:
 * the generated tables plus the host's `Copy.registerLocale` layer, in the default locale). Used for
 * refusals that arrive as a bare code (`ActivationResult.Refused`, a typed N/A).
 */
public fun PolarisCopy.errorCodeMessage(code: String): String? = when (code) {
    im.plrs.key.core.ErrorCode.deviceLimit -> Copy.activationMessage(code, locale = coreLocale())
    im.plrs.key.core.ErrorCode.unauthorized -> activationUnauthorized
    im.plrs.key.core.ErrorCode.fingerprintRequired -> activationFingerprintRequired
    im.plrs.key.core.ErrorCode.hardwareMismatch -> activationHardwareMismatch
    im.plrs.key.core.ErrorCode.enrollDisabled, im.plrs.key.core.ErrorCode.registrationClosed -> activationEnrollDisabled
    im.plrs.key.core.ErrorCode.enrollClaimed -> activationEnrollClaimed
    im.plrs.key.core.ErrorCode.licenseDisabled -> activationLicenseDisabled
    im.plrs.key.core.ErrorCode.licenseExpired -> activationLicenseExpired
    im.plrs.key.core.ErrorCode.attestationRequired -> activationAttestationRequired
    im.plrs.key.core.ErrorCode.rateLimited -> activationRateLimited
    im.plrs.key.core.ErrorCode.network, im.plrs.key.core.ErrorCode.networkError -> activationNetwork
    else -> Locale.getDefault().toLanguageTag().let { locale ->
        // `{product}` names the app when the host named it; otherwise the placeholder drops.
        val params = if (productName != DEFAULT_PRODUCT_NAME) mapOf("product" to productName) else emptyMap()
        if (Copy.hasCopy(code, locale)) Copy.message(code, locale = locale, params = params) else null
    }
}

internal val DEFAULT_PRODUCT_NAME: String = PolarisCopy().productName

/**
 * The product's name where a sentence starts with it (`{product} needs ...`): the host's name as it
 * is, or the "this app" default with a capital, so a nameless kit never starts a sentence in lower case.
 */
internal fun PolarisCopy.productLead(): String =
    if (productName == DEFAULT_PRODUCT_NAME) productName.replaceFirstChar { it.uppercaseChar() } else productName

/** The locale core.copy reads (the default locale; a host registers translations with Copy.registerLocale). */
internal fun coreLocale(): String = Locale.getDefault().toLanguageTag()

/**
 * A core.copy entry (an error code, a gate status or an activation result) as a full-screen
 * message: its title and its message, `{product}` filled when the host named the product.
 */
public fun PolarisCopy.coreMessage(code: String, kind: PolarisMessageKind): PolarisMessageCopy {
    val params = if (productName != DEFAULT_PRODUCT_NAME) mapOf("product" to productName) else emptyMap()
    return PolarisMessageCopy(Copy.title(code, coreLocale()), Copy.message(code, locale = coreLocale(), params = params), kind)
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
        PolarisMessageCopy(bootDeclinedTitle, format(bootDeclinedBody, productLead()), PolarisMessageKind.Info)
}

/** The message an offline stop shows; [canPlayOffline] is the playable stop of stage-matrix v3. */
public fun PolarisCopy.offlineMessage(canPlayOffline: Boolean): PolarisMessageCopy =
    PolarisMessageCopy(bootOfflineTitle, if (canPlayOffline) bootOfflinePlayableBody else bootOfflineBody, PolarisMessageKind.Offline)

/**
 * The message an error stop shows. A code the core catalog has copy for (`sync-failed`) reads that
 * copy; only an unknown code falls back to the generic message naming it.
 */
public fun PolarisCopy.errorMessage(code: String): PolarisMessageCopy =
    if (Copy.hasCopy(code, coreLocale())) coreMessage(code, PolarisMessageKind.Danger)
    else PolarisMessageCopy(bootErrorTitle, format(bootErrorBody, productName), PolarisMessageKind.Danger)

/** The consent card's body for a fetch of [bytes]. */
public fun PolarisCopy.consentMessage(bytes: Long, metered: Boolean): String =
    format(if (metered) consentBodyMetered else consentBody, productLead(), bytes(bytes))

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

/** "20 seconds" under a minute, else [duration]: the figure in "About 20 seconds left". */
public fun PolarisCopy.timeLeft(seconds: Long): String {
    val s = seconds.coerceAtLeast(1)
    return when {
        s >= 60 -> duration(s)
        s == 1L -> durationSecond
        else -> format(durationSeconds, s)
    }
}

/** "About 4 min", rounded up to whole minutes, or "Less than a minute": the download's time left. */
public fun PolarisCopy.timeLeftLine(seconds: Long): String =
    if (seconds < 60) updateTimeLessThanMinute else format(updateTimeMinutes, (seconds + 59) / 60)

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
