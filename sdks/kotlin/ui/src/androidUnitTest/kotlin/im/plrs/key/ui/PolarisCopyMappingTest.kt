// The state-to-copy mapping, without rendering: which title and body each licence status and boot
// stop shows, how activation errors and version windows read, and the unit formatting.

package im.plrs.key.ui

import im.plrs.key.core.AllowedRange
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootStage
import im.plrs.key.core.COPY_CODES
import im.plrs.key.core.Copy
import im.plrs.key.core.CopyEntry
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class PolarisCopyMappingTest {
    private val copy = PolarisCopy(productName = "Diceroll")

    @Test
    fun statusesThatRenderNoMessage() {
        for (s in listOf(LicenseStatus.ok, LicenseStatus.grace, LicenseStatus.needsActivation, LicenseStatus.notApplicable)) {
            assertNull(s.wire, copy.gateMessage(s))
        }
    }

    @Test
    fun terminalStatusesMapToTheirCopy() {
        // Revoked and expired are core.copy's gate entries (copy.en.json), verbatim.
        assertEquals(
            PolarisMessageCopy("Signed out", "This device was signed out. Sign in or activate again to continue.", PolarisMessageKind.Locked),
            copy.gateMessage(LicenseStatus.revoked),
        )
        assertEquals(
            PolarisMessageCopy("License expired", "Your license has expired. Connect to the internet or renew it to continue.", PolarisMessageKind.Warning),
            copy.gateMessage(LicenseStatus.expired),
        )
        // Sign-in's stops read core.copy too.
        assertEquals(
            PolarisMessageCopy("Code expired", "The code expired before sign-in finished. Start again.", PolarisMessageKind.Info),
            copy.coreMessage(SIGN_IN_EXPIRED, PolarisMessageKind.Info),
        )
        assertEquals(
            PolarisMessageCopy("Sign-in failed", "Sign-in didn't finish. Try again.", PolarisMessageKind.Danger),
            copy.coreMessage(SIGN_IN_FAILED, PolarisMessageKind.Danger),
        )
        assertEquals(copy.versionTooOldTitle, copy.gateMessage(LicenseStatus.versionTooOld)!!.title)
        assertEquals(copy.versionTooNewTitle, copy.gateMessage(LicenseStatus.versionTooNew)!!.title)
        val channel = copy.gateMessage(LicenseStatus.channelNotEntitled)!!
        assertEquals(copy.channelNotEntitledTitle, channel.title)
        assertEquals(copy.channelNotEntitledBody, channel.body)
        assertEquals(PolarisMessageKind.Blocked, channel.kind)
    }

    @Test
    fun versionBlocksNameTheAllowedWindow() {
        assertEquals(copy.versionTooOldBody, copy.gateMessage(LicenseStatus.versionTooOld, null)!!.body)
        assertEquals(copy.versionTooOldBody, copy.gateMessage(LicenseStatus.versionTooOld, AllowedRange())!!.body)
        assertEquals(
            "${copy.versionTooOldBody}\nAllowed versions: 2.4.0 or later",
            copy.gateMessage(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0"))!!.body,
        )
        assertEquals(
            "${copy.versionTooNewBody}\nAllowed versions: up to 2.9.9",
            copy.gateMessage(LicenseStatus.versionTooNew, AllowedRange(max = "2.9.9"))!!.body,
        )
        assertEquals(
            "${copy.versionTooNewBody}\nAllowed versions: 2.0.0 to 2.9.9",
            copy.gateMessage(LicenseStatus.versionTooNew, AllowedRange(min = "2.0.0", max = "2.9.9"))!!.body,
        )
    }

    @Test
    fun activationResults() {
        assertNull(copy.activationMessage(ActivationResult.Ok("pkeyt_x", 1)))
        // core.copy's device-limit entry; the seat count is the screen's caption, not this line.
        val limit = "This license is already on all its devices. Replace a device to use it here."
        assertEquals(limit, copy.activationMessage(ActivationResult.DeviceLimit(null, null)))
        assertEquals(limit, copy.activationMessage(ActivationResult.DeviceLimit(limit = 3, deviceCount = 3)))
        assertEquals("3 of 3 in use", copy.format(copy.seatCaption, 3, 3))
        assertEquals(copy.activationUnauthorized, copy.activationMessage(ActivationResult.Unauthorized))
        assertEquals(copy.activationFingerprintRequired, copy.activationMessage(ActivationResult.FingerprintRequired))
        assertEquals(copy.activationHardwareMismatch, copy.activationMessage(ActivationResult.HardwareMismatch(2, listOf("disk"))))
        assertEquals(copy.activationEnrollDisabled, copy.activationMessage(ActivationResult.EnrollDisabled))
        // The SDK's error text is for logs, never shown.
        assertEquals(copy.activationError, copy.activationMessage(ActivationResult.Error("HTTP 500 at /license/activate")))
        assertEquals(copy.activationEnrollClaimed, copy.activationMessage(ActivationResult.EnrollClaimed))
        assertEquals(copy.activationLicenseDisabled, copy.activationMessage(ActivationResult.LicenseDisabled))
        assertEquals(copy.activationLicenseExpired, copy.activationMessage(ActivationResult.LicenseExpired))
        assertEquals(copy.activationAttestationRequired, copy.activationMessage(ActivationResult.AttestationRequired))
        assertEquals(copy.activationRateLimited, copy.activationMessage(ActivationResult.RateLimited(null)))
        assertEquals("Too many attempts. Try again in 2 minutes.", copy.activationMessage(ActivationResult.RateLimited(150)))
        assertEquals(copy.activationNetwork, copy.activationMessage(ActivationResult.Error("offline", "network")))
        // A known code arriving as a bare refusal reads as its own copy; an unknown one names the code, never the body.
        assertEquals(copy.activationEnrollDisabled, copy.activationMessage(ActivationResult.Refused("registration_closed", 403, "raw body")))
        assertEquals("Something went wrong (no_such_code). Try again.", copy.activationMessage(ActivationResult.Refused("no_such_code", 403, "raw body")))
    }

    @Test
    fun refusalsTheKitHasNoFieldForReadTheCoreCatalog() {
        // core.copy: a code the catalog knows reads Copy.message, never the raw body.
        assertEquals(
            "This Diceroll license is already in another Polaris Key account. A license never moves by its key.",
            copy.activationMessage(ActivationResult.Refused("license_owned", 403, "raw body")),
        )
        // Without a product name the placeholder drops; the sentence is the catalog's.
        assertEquals(Copy.message("license_owned"), PolarisCopy().errorCodeMessage("license_owned"))
        assertEquals(COPY_CODES.getValue("not_entitled").message, PolarisCopy().errorCodeMessage("not_entitled"))
        assertNull(copy.errorCodeMessage("no_such_code"))
        // The kit's own field still wins for the codes it names, so its overrides keep working.
        val custom = PolarisCopy(activationUnauthorized = "Nope.")
        assertEquals("Nope.", custom.activationMessage(ActivationResult.Refused("unauthorized", 401, "raw body")))
        // The host's Copy override layer reaches the kit.
        try {
            Copy.registerLocale("en", mapOf("license_owned" to CopyEntry("Taken", "Someone else owns this license.")))
            assertEquals("Someone else owns this license.", copy.activationMessage(ActivationResult.Refused("license_owned", 403, "raw body")))
        } finally {
            Copy.resetOverrides()
        }
    }

    @Test
    fun bootStagesAndStops() {
        assertEquals(copy.bootStarting, copy.bootStageLabel(BootStage.shell))
        assertEquals(copy.bootSyncing, copy.bootStageLabel(BootStage.sync))
        assertEquals(copy.bootGate, copy.bootStageLabel(BootStage.gate))
        assertEquals(copy.bootDeciding, copy.bootStageLabel(BootStage.decide))
        assertEquals(copy.bootFetching, copy.bootStageLabel(BootStage.fetch))
        assertEquals(copy.bootMounting, copy.bootStageLabel(BootStage.mount))
        for (stage in BootStage.entries) assertTrue(copy.bootStageLabel(stage).isNotBlank())
        assertEquals(copy.bootBlockedUpdateTitle, copy.blockedMessage(BootEmit.BlockedReason.updateRequired).title)
        assertEquals(copy.bootBlockedUnavailableTitle, copy.blockedMessage(BootEmit.BlockedReason.notAvailable).title)
        assertEquals(copy.bootDeclinedTitle, copy.blockedMessage(BootEmit.BlockedReason.contentDeclined).title)
        assertEquals(copy.bootOfflineBody, copy.offlineMessage(false).body)
        assertEquals(copy.bootOfflinePlayableBody, copy.offlineMessage(true).body)
        assertEquals("The app couldn't finish starting (sync-failed).", copy.errorMessage("sync-failed").body)
    }

    @Test
    fun graceCountdown() {
        assertEquals(copy.graceBodyNoDeadline, copy.graceBody(null, 100))
        assertEquals(copy.graceBodyNoDeadline, copy.graceBody(50, 100))
        assertEquals("We couldn't reach the license server. You can keep working for 3 days.", copy.graceBody(100 + 3 * 86_400 + 5, 100))
    }

    @Test
    fun durations() {
        assertEquals("less than a minute", copy.duration(59))
        assertEquals("1 minute", copy.duration(60))
        assertEquals("2 minutes", copy.duration(150))
        assertEquals("1 hour", copy.duration(3_600))
        assertEquals("5 hours", copy.duration(5 * 3_600 + 59))
        assertEquals("1 day", copy.duration(86_400))
        assertEquals("12 days", copy.duration(12 * 86_400))
        assertEquals("less than a minute", copy.duration(-5))
        assertEquals("just now", copy.ago(30))
        assertEquals("2 minutes ago", copy.ago(120))
    }

    @Test
    fun countdownClock() {
        assertEquals("7:41", countdown(461))
        assertEquals("0:05", countdown(5))
        assertEquals("1:00:00", countdown(3_600))
        assertEquals("0:00", countdown(-1))
    }

    @Test
    fun byteSizes() {
        assertEquals("512 B", copy.bytes(512, Locale.US))
        assertEquals("1.5 KB", copy.bytes(1_500, Locale.US))
        assertEquals("268.4 MB", copy.bytes(268_400_000, Locale.US))
        assertEquals("2 GB", copy.bytes(2_000_000_000, Locale.US))
        assertEquals("1,5 MB", copy.bytes(1_500_000, Locale.GERMANY))
        assertEquals(
            "268.4 MB of new content is needed, and you're on a metered connection.",
            PolarisCopy().let { c -> c.format(c.consentBodyMetered, c.bytes(268_400_000, Locale.US)) },
        )
    }

    @Test
    fun entitlementLabels() {
        assertEquals(copy.entitlementLicensed, copy.entitlementLabel(LicenseStatus.ok))
        assertEquals(copy.entitlementGrace, copy.entitlementLabel(LicenseStatus.grace))
        assertEquals(copy.entitlementBlocked, copy.entitlementLabel(LicenseStatus.channelNotEntitled))
        for (s in LicenseStatus.entries) assertTrue(copy.entitlementLabel(s).isNotBlank())
    }

    @Test
    fun overridesWin() {
        val custom = PolarisCopy(productName = "Diceroll", signIn = "Log in")
        assertEquals("Log in", custom.signIn)
        assertEquals("Welcome to Diceroll", custom.format(custom.activationTitle, custom.productName))
        val replaced = PolarisCopy().with(mapOf("retry" to "Réessayer", "nope" to "ignored"))
        assertEquals("Réessayer", replaced.retry)
        assertEquals(PolarisCopy().cancel, replaced.cancel)
    }

    @Test
    fun resourceNames() {
        assertEquals("pkey_ui_activation_title", PolarisCopy.resourceName("activationTitle"))
        assertEquals("pkey_ui_bytes_kb", PolarisCopy.resourceName("bytesKb"))
        assertEquals("pkey_ui_powered_by", PolarisCopy.resourceName("poweredBy"))
        assertEquals(PolarisCopy.FIELDS.size, PolarisCopy.FIELDS.map { PolarisCopy.resourceName(it) }.toSet().size)
    }
}
