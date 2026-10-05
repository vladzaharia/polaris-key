// The sample states every screen is rendered in, shared by the snapshot and accessibility suites,
// and the two themes a reviewer compares: a host with a stock Material 3 theme (neutral) and the
// same host with the one PolarisBranding switch flipped.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import im.plrs.key.config.ConfigSource
import im.plrs.key.core.AllowedRange
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.initialBootState
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.license.ActivationResult
import im.plrs.key.sdk.DeviceInfo

internal const val NOW: Long = 1_790_000_000

/** A host app with a stock Material 3 theme, light or dark. */
@Composable
internal fun StockHost(dark: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme(), content = content)
}

/** The product the gate lets through, as a host would render it. */
@Composable
internal fun SampleProduct() {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(contentAlignment = Alignment.Center) {
            Text("Diceroll", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
        }
    }
}

internal val sampleCopy = PolarisCopy(productName = "Diceroll")

internal fun gateUi(status: LicenseStatus, range: AllowedRange? = null, graceUntil: Long? = null) =
    PolarisGateUi(license = LicenseState(status, graceUntil = graceUntil, allowedRange = range), nowSeconds = NOW)

internal val samplePrompt = SignInPrompt(
    deviceCode = "dc_sample",
    userCode = "WDJB-MJHT",
    verificationUri = "https://key.plrs.im/activate",
    verificationUriComplete = "https://key.plrs.im/activate?user_code=WDJB-MJHT",
    expiresIn = 600,
    interval = 5,
    expiresAt = NOW + 461,
)

internal val sampleDevices = listOf(
    DeviceInfo(id = "dev_1", current = true, status = LicenseStatus.ok, lastVerifiedAt = NOW * 1000 - 120_000, label = "Pixel 9 Pro"),
    DeviceInfo(id = "dev_2", current = false, status = LicenseStatus.ok, lastVerifiedAt = NOW * 1000 - 3 * 86_400_000L, label = "Ada's tablet"),
    DeviceInfo(id = "dev_3", current = false, status = LicenseStatus.ok, lastVerifiedAt = null, label = null),
)

internal val sampleSettings = PolarisSettingsUi(
    loading = false,
    license = PolarisLicenseSummary(LicenseStatus.ok, holder = "Ada Lovelace", entitlements = listOf("dlc.frost", "multiplayer", "soundtrack")),
    entries = listOf(
        PolarisSettingEntry("audio.volume", "Music volume", "80", ConfigSource.remoteDefault),
        PolarisSettingEntry("graphics.quality", "Graphics quality", "high", ConfigSource.local),
        PolarisSettingEntry("telemetry.enabled", "Share diagnostics", "false", ConfigSource.enforced),
        PolarisSettingEntry("server.region", "Server region", "eu-west", ConfigSource.fallback),
    ),
)

internal val samplePacks = PolarisPackProgressUi(
    listOf(
        PolarisPackRow("base", PolarisPackRow.Phase.Done, 48_000_000, 48_000_000),
        PolarisPackRow("dlc.frost", PolarisPackRow.Phase.Downloading, 31_500_000, 120_000_000),
        PolarisPackRow("voices.fr", PolarisPackRow.Phase.Installing, 7_800_000, 9_200_000),
    ),
)

internal fun bootUi(stage: BootStage, outcome: BootOutcome = BootOutcome.running, canPlayOffline: Boolean = false) =
    PolarisBootUi(state = initialBootState().copy(stage = stage, outcome = outcome, canPlayOffline = canPlayOffline))

internal const val SAMPLE_MANAGE_URL = "https://key.plrs.im/activate?product=djdl&next=free-device&for=Android%20arm64"

/** Every screen the kit ships, by snapshot name. */
internal val kitScreens: List<Pair<String, @Composable () -> Unit>> = listOf(
    "boot-progress" to { PolarisBootScreen(bootUi(BootStage.sync)) },
    "boot-consent" to {
        PolarisBootScreen(bootUi(BootStage.fetch, BootOutcome.waiting).copy(consent = PolarisBootUi.Consent(268_400_000, metered = true)))
    },
    "boot-offline" to { PolarisBootScreen(bootUi(BootStage.offline, BootOutcome.offline, canPlayOffline = true)) },
    "boot-blocked" to {
        PolarisBootScreen(bootUi(BootStage.blocked, BootOutcome.blocked).copy(blocked = BootEmit.BlockedReason.updateRequired), onUpdate = {})
    },
    "boot-error" to { PolarisBootScreen(bootUi(BootStage.error, BootOutcome.error).copy(errorCode = "sync-failed")) },
    "gate-activation" to { PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), onSignIn = {}) },
    "gate-activation-error" to {
        PolarisGateScreen(
            gateUi(LicenseStatus.needsActivation),
            PolarisActivationUi(key = "pkey_9f2c-77ab", error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(3, 3))),
        )
    },
    // PX-W8: a device-limit refusal with the portal link — a button, and a QR code on a TV.
    "gate-device-limit-manage" to {
        PolarisGateScreen(
            gateUi(LicenseStatus.needsActivation),
            PolarisActivationUi(
                key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
                error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(1, 1, SAMPLE_MANAGE_URL)),
                manageUrl = SAMPLE_MANAGE_URL,
            ),
        )
    },
    "gate-device-limit-manage-tv" to {
        PolarisGateScreen(
            gateUi(LicenseStatus.needsActivation),
            PolarisActivationUi(
                key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
                error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(1, 1, SAMPLE_MANAGE_URL)),
                manageUrl = "$SAMPLE_MANAGE_URL#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
                manageQrUrl = SAMPLE_MANAGE_URL,
            ),
            manageAsQr = true,
        )
    },
    "gate-revoked" to { PolarisGateScreen(gateUi(LicenseStatus.revoked), PolarisActivationUi(), onSignIn = {}) },
    "gate-expired" to { PolarisGateScreen(gateUi(LicenseStatus.expired), PolarisActivationUi()) },
    "gate-version-too-old" to {
        PolarisGateScreen(gateUi(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0")), PolarisActivationUi())
    },
    "gate-version-too-new" to {
        PolarisGateScreen(gateUi(LicenseStatus.versionTooNew, AllowedRange(min = "2.0.0", max = "2.9.9")), PolarisActivationUi())
    },
    "gate-channel-not-entitled" to { PolarisGateScreen(gateUi(LicenseStatus.channelNotEntitled), PolarisActivationUi()) },
    "gate-grace" to {
        PolarisGateScreen(gateUi(LicenseStatus.grace, graceUntil = NOW + 3 * 86_400 + 600), PolarisActivationUi()) { SampleProduct() }
    },
    "sign-in" to { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW)) },
    "settings" to { PolarisSettingsScreen(sampleSettings) },
    "devices" to { PolarisDevicesScreen(PolarisDevicesUi(loading = false, devices = sampleDevices, nowMillis = NOW * 1000)) },
    "update-banner" to {
        Column(Modifier.fillMaxSize()) {
            PolarisUpdateBanner(PolarisUpdateUi("2.5.0", critical = true), onDismiss = {})
            Box(Modifier.weight(1f)) { SampleProduct() }
        }
    },
    "update-prompt" to {
        PolarisScreen(showLogo = false) {
            PolarisUpdatePrompt(PolarisUpdateUi("2.5.0"), Modifier.padding(0.dp), onLater = {})
        }
    },
    "pack-progress" to { PolarisPackProgressScreen(samplePacks) },
)
