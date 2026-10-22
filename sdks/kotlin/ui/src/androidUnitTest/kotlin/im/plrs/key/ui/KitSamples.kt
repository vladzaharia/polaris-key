// The sample states every screen is rendered in, shared by the snapshot and accessibility suites,
// and the two themes a reviewer compares: a host with a stock Material 3 theme (neutral) and the
// same host with the one PolarisBranding switch flipped.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
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
import kotlinx.serialization.json.JsonPrimitive

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
    verificationUri = "https://polaris.locker/device",
    verificationUriComplete = "https://polaris.locker/device?user_code=WDJB-MJHT",
    expiresIn = 600,
    interval = 5,
    expiresAt = NOW + 461,
    deviceName = "Living room TV",
)

internal val sampleDevices = listOf(
    DeviceInfo(id = "dev_1", current = true, status = LicenseStatus.ok, lastVerifiedAt = NOW * 1000 - 120_000, label = "Pixel 9 Pro", platform = "android", lastSeenAt = NOW * 1000 - 120_000),
    DeviceInfo(id = "dev_2", current = false, status = LicenseStatus.ok, label = "Ada's tablet", platform = "android", lastSeenAt = NOW * 1000 - 3 * 86_400_000L),
    DeviceInfo(id = "dev_3", current = false, status = LicenseStatus.ok, lastVerifiedAt = null, label = null, platform = "macos", lastSeenAt = NOW * 1000 - 9 * 86_400_000L),
)

internal val sampleSettings = PolarisSettingsUi(
    loading = false,
    license = PolarisLicenseSummary(LicenseStatus.ok, holder = "Ada Lovelace", entitlements = listOf("dlc.frost", "multiplayer", "soundtrack")),
    entries = listOf(
        PolarisSettingEntry("audio.volume", "Music volume", "80", ConfigSource.remoteDefault, editor = PolarisSettingEditor.Number("80", integer = true, min = 0.0, max = 100.0)),
        PolarisSettingEntry(
            "graphics.quality", "Graphics quality", "high", ConfigSource.local,
            editor = PolarisSettingEditor.Choice(listOf("Low" to JsonPrimitive("low"), "Medium" to JsonPrimitive("medium"), "High" to JsonPrimitive("high")), selected = 2),
        ),
        PolarisSettingEntry("hints.enabled", "Show hints", "true", ConfigSource.remoteDefault, editor = PolarisSettingEditor.Toggle(true)),
        PolarisSettingEntry("player.name", "Display name", "Ada", ConfigSource.fallback, editor = PolarisSettingEditor.Text("Ada", maxLength = 24), description = "Shown on the leaderboard."),
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

internal const val SAMPLE_MANAGE_URL = "https://polaris.locker/activate?product=djdl&next=free-device&for=Android%20arm64"

/** PX-W8 on Android TV: a device-limit refusal whose portal link shows as a QR code (TV only). */
internal val deviceLimitTv: @Composable () -> Unit = {
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
}

/** The update prompt in its dialog, as an app shows it over its own screen. */
internal val updateDialog: @Composable () -> Unit = {
    SampleProduct()
    PolarisUpdatePromptDialog(PolarisUpdateUi("2.5.0"), onUpdate = {}, onLater = {})
}

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
    "sign-in-starting" to { PolarisSignInScreen(PolarisSignInUi.Starting) },
    "sign-in-expired" to { PolarisSignInScreen(PolarisSignInUi.Expired) },
    "sign-in-failed" to { PolarisSignInScreen(PolarisSignInUi.Failed) },
    "sign-in-denied" to { PolarisSignInScreen(PolarisSignInUi.Denied) },
    "settings" to { PolarisSettingsScreen(sampleSettings, onSet = { _, _ -> }, onReset = {}) },
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
    // The styled parts (UI-KITS.md 4.1), from the matrix's own rows.
    "license-choice" to { MatrixCases.case("licenseChoice-many").let { PolarisLicenseChoice(it.screen, it.rows.choices!!) } },
    "license-choice-full" to { MatrixCases.case("licenseChoice-all-full").let { PolarisLicenseChoice(it.screen, it.rows.choices!!) } },
    "paywall" to { samplePaywall().let { (screen, rows) -> PolarisPaywall(screen, rows.features) } },
    "release-notes" to { MatrixCases.case("releaseNotes-list").let { PolarisReleaseNotes(it.screen, it.rows.releaseNotes) } },
    "entitlement-locked" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Export")
            Spacer(Modifier.height(16.dp))
            PolarisEntitlementLocked("Pro", onUnlock = {})
        }
    },
    "cloud-sync" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Cloud Sync")
            Spacer(Modifier.height(16.dp))
            PolarisCloudSyncStatus(PolarisCloudSync.Synced, syncedAtMillis = NOW * 1000 - 300_000, nowMillis = NOW * 1000, onOpen = {})
            Spacer(Modifier.height(12.dp))
            PolarisCloudSyncStatus(PolarisCloudSync.Conflict, onOpen = {})
            Spacer(Modifier.height(12.dp))
            PolarisCloudSyncStatus(PolarisCloudSync.Error, onRetry = {})
        }
    },
    "about" to {
        PolarisAbout(
            PolarisAboutInfo(version = "2.4.1", build = "build 241", diagnostics = "Diceroll 2.4.1 (241)\nAndroid 15"),
            onPrivacy = {}, onSupport = {}, onLicenses = {},
        )
    },
)

internal val sampleFeatures = listOf("Export to PDF and PNG", "Unlimited projects", "Priority support")

/**
 * The Paywall's offers state with the tier and what it adds: the matrix pins the lines and not the
 * product's features, so the sample brings them (`offers.tier`, `offers.features`). [pending] is the
 * matrix's `pending` member ("purchase", "restore").
 */
internal fun samplePaywall(pending: String? = null, purchased: Boolean = false): Pair<KitScreen, KitRowData> {
    val base = MatrixCases.case("paywall-offers").inputs!!
    var inputs = base.with(
        "offers",
        kotlinx.serialization.json.buildJsonObject {
            put("available", JsonPrimitive(true))
            put("tier", JsonPrimitive("Pro"))
            if (purchased) put("purchased", JsonPrimitive(true))
            put("features", kotlinx.serialization.json.JsonArray(sampleFeatures.map(::JsonPrimitive)))
        },
    )
    if (pending != null) inputs = inputs.with("pending", JsonPrimitive(pending))
    return KitStates.resolve(KitComponent.paywall, inputs) to KitRowData.from(inputs)
}
