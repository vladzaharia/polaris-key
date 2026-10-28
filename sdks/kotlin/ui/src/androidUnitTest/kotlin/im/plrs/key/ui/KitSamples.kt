// The sample states every screen is rendered in, shared by the snapshot and accessibility suites,
// and the two themes a reviewer compares: a host with a stock Material 3 theme (neutral) and the
// same host with the one PolarisBranding switch flipped.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
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

internal val samplePrompt = PolarisSignInCode(
    userCode = "WDJB-MJHT",
    verificationUri = "https://polaris.locker/device",
    verificationUriComplete = "https://polaris.locker/device?user_code=WDJB-MJHT",
    expiresIn = 600,
    expiresAt = NOW + 461,
    deviceName = "Living room TV",
)

internal val sampleDevices = listOf(
    DeviceInfo(
        id = "dev_1",
        current = true,
        status = LicenseStatus.ok,
        lastVerifiedAt = NOW * 1000 - 120_000,
        label = "Pixel 9 Pro",
        platform = "android",
        lastSeenAt =
        NOW * 1000 - 120_000,
    ),
    DeviceInfo(
        id = "dev_2",
        current = false,
        status = LicenseStatus.ok,
        label = "Ada's tablet",
        platform = "android",
        lastSeenAt =
        NOW * 1000 - 3 * 86_400_000L,
    ),
    DeviceInfo(
        id = "dev_3",
        current = false,
        status = LicenseStatus.ok,
        lastVerifiedAt = null,
        label = null,
        platform = "macos",
        lastSeenAt =
        NOW * 1000 - 9 * 86_400_000L,
    ),
)

internal val sampleSettings = PolarisSettingsUi(
    loading = false,
    license = PolarisLicenseSummary(LicenseStatus.ok, holder = "Ada Lovelace", entitlements = listOf("dlc.frost", "multiplayer", "soundtrack")),
    entries = listOf(
        PolarisSettingEntry(
            "audio.volume",
            "Music volume",
            "80",
            ConfigSource.remoteDefault,
            editor = PolarisSettingEditor.Number("80", integer = true, min = 0.0, max = 100.0),
        ),
        PolarisSettingEntry(
            "graphics.quality",
            "Graphics quality",
            "high",
            ConfigSource.local,
            editor = PolarisSettingEditor.Choice(
                listOf(
                    "Low" to JsonPrimitive("low"),
                    "Medium" to JsonPrimitive("medium"),
                    "High" to JsonPrimitive("high"),
                ),
                selected = 2,
            ),
        ),
        PolarisSettingEntry("hints.enabled", "Show hints", "true", ConfigSource.remoteDefault, editor = PolarisSettingEditor.Toggle(true)),
        PolarisSettingEntry(
            "player.name",
            "Display name",
            "Ada",
            ConfigSource.fallback,
            editor = PolarisSettingEditor.Text("Ada", maxLength = 24),
            description = "Shown on the leaderboard.",
        ),
        PolarisSettingEntry("telemetry.enabled", "Share diagnostics", "false", ConfigSource.enforced),
        PolarisSettingEntry("server.region", "Server region", "eu-west", ConfigSource.fallback),
    ),
)

internal val sampleChannel = PolarisChannelUi(current = "stable", options = listOf("stable", "beta"))

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
    PolarisUpdatePromptDialog(
        PolarisUpdateUi(
            "2.5.0",
            currentVersion = "2.4.1",
            size = 61_000_000L,
            notes = listOf("Faster sync on slow networks", "Fixes a crash when resuming"),
            notesUrl = "https://example.com/releases/2.5.0",
            outlet = "play",
        ),
        onUpdate = {},
        onLater = {},
        onSkip = {},
    )
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
    "polarisKeyGate-needs-activation" to { PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), onSignIn = {}) },
    "activate-device-limit" to {
        PolarisGateScreen(
            gateUi(LicenseStatus.needsActivation),
            PolarisActivationUi(key = "pkey_9f2c-77ab", error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(3, 3))),
        )
    },
    // PX-W8: a device-limit refusal with the portal link — a button, and a QR code on a TV.
    "deviceLimit-browser-mode" to {
        PolarisGateScreen(
            gateUi(LicenseStatus.needsActivation),
            PolarisActivationUi(
                key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
                error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(1, 1, SAMPLE_MANAGE_URL)),
                manageUrl = SAMPLE_MANAGE_URL,
            ),
        )
    },
    "statusScreen-revoked" to { PolarisGateScreen(gateUi(LicenseStatus.revoked), PolarisActivationUi(), onSignIn = {}) },
    "statusScreen-expired" to { PolarisGateScreen(gateUi(LicenseStatus.expired), PolarisActivationUi()) },
    "statusScreen-version-too-old" to {
        PolarisGateScreen(gateUi(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0")), PolarisActivationUi())
    },
    "statusScreen-version-too-new" to {
        PolarisGateScreen(gateUi(LicenseStatus.versionTooNew, AllowedRange(min = "2.0.0", max = "2.9.9")), PolarisActivationUi())
    },
    "statusScreen-channel-not-entitled" to { PolarisGateScreen(gateUi(LicenseStatus.channelNotEntitled), PolarisActivationUi()) },
    "polarisKeyGate-grace" to {
        PolarisGateScreen(gateUi(LicenseStatus.grace, graceUntil = NOW + 3 * 86_400 + 600), PolarisActivationUi()) { SampleProduct() }
    },
    "signInHandoff-code" to { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW)) },
    "signInHandoff-starting" to { PolarisSignInScreen(PolarisSignInUi.Starting) },
    "sign-in-expired" to { PolarisSignInScreen(PolarisSignInUi.Expired) },
    "signInHandoff-failed" to { PolarisSignInScreen(PolarisSignInUi.Failed) },
    "signInHandoff-denied" to { PolarisSignInScreen(PolarisSignInUi.Denied) },
    "settings-list" to { PolarisSettingsScreen(sampleSettings, onSet = { _, _ -> }, onReset = {}) },
    "devices-list" to { PolarisDevicesScreen(PolarisDevicesUi(loading = false, devices = sampleDevices, nowMillis = NOW * 1000)) },
    "account-list-detail" to {
        PolarisAccountScreen(sampleSettings, PolarisDevicesUi(loading = false, devices = sampleDevices, nowMillis = NOW * 1000), onSet = { _, _ ->
        }, onReset = {})
    },
    "updatePrompt-ready" to {
        Column(Modifier.fillMaxSize()) {
            PolarisUpdateBanner(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart), onDismiss = {})
            Box(Modifier.weight(1f)) { SampleProduct() }
        }
    },
    // The sheet or card as the dialog draws it (a phone gets the bottom sheet, a wide or short window the card).
    "updatePrompt-available" to {
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            PolarisUpdatePromptHosted(
                PolarisUpdateUi(
                    "2.5.0",
                    currentVersion = "2.4.1",
                    size = 61_000_000L,
                    notes = listOf("Faster sync on slow networks", "Fixes a crash when resuming"),
                    notesUrl = "https://example.com/releases/2.5.0",
                    outlet = "play",
                ),
                onUpdate = {},
                onLater = {},
                onSkip = {},
            )
        }
    },
    "pack-progress" to { PolarisPackProgressScreen(samplePacks) },
    // The styled parts (UI-KITS.md 4.1), from the matrix's own rows.
    "licenseChoice-many" to { MatrixCases.case("licenseChoice-many").let { PolarisLicenseChoice(it.screen, it.rows.choices!!) } },
    "licenseChoice-all-full" to { MatrixCases.case("licenseChoice-all-full").let { PolarisLicenseChoice(it.screen, it.rows.choices!!) } },
    "paywall-offers" to { samplePaywall().let { (screen, rows) -> PolarisPaywall(screen, rows.features) } },
    "releaseNotes-list" to { MatrixCases.case("releaseNotes-list").let { PolarisReleaseNotes(it.screen, it.rows.releaseNotes) } },
    "entitlementGate-not-entitled" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Export")
            Spacer(Modifier.height(16.dp))
            PolarisEntitlementLocked("Pro", onUnlock = {})
        }
    },
    "cloudSyncStatus-synced" to {
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
    // The Cloud Sync screens (U-42), resolved by KitStates from the cloudSync family's inputs.
    "cloudSyncStatus-locked" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Cloud Sync")
            Spacer(Modifier.height(16.dp))
            PolarisCloudSyncStatus(PolarisCloudSync.Locked, onUnlock = {})
            Spacer(Modifier.height(12.dp))
            PolarisCloudSyncStatus(PolarisCloudSync.RingChanged, onReview = {})
        }
    },
    "unlockSync-code" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "code")) },
    "unlockSync-invalid" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "invalid")) },
    "unlockSync-start-over-failed" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "start-over-failed")) },
    "unlockSync-no-code" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "no-code")) },
    "unlockSync-working" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "working")) },
    "unlockSync-failed" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "failed")) },
    "unlockSync-start-over" to { PolarisUnlockSync(syncScreen(KitComponent.unlockSync, "unlockSync", "step" to "start-over")) },
    "recoveryCode-show" to { PolarisRecoveryCodeScreen(syncScreen(KitComponent.recoveryCode, "recoveryCode"), sampleRecoveryCode) },
    "recoveryCode-saved" to {
        PolarisRecoveryCodeScreen(syncScreen(KitComponent.recoveryCode, "recoveryCode", "saved" to true), sampleRecoveryCode)
    },
    "ringChange-failed" to {
        PolarisRingChange(syncScreen(KitComponent.ringChange, "ringChange", "by" to "Maya's MacBook", "served" to true, "failed" to true))
    },
    "ringChange-confirm" to {
        PolarisRingChange(syncScreen(KitComponent.ringChange, "ringChange", "by" to "Maya's MacBook", "served" to true))
    },
    // The release channel choice (UI-KITS.md §4.1 ChannelPicker): the switchable list, and the lock with its reason.
    "channelPicker-default" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Settings")
            Spacer(Modifier.height(16.dp))
            PolarisChannelPicker(sampleChannel, onSelect = {})
        }
    },
    "channelPicker-locked" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Settings")
            Spacer(Modifier.height(16.dp))
            PolarisChannelPicker(sampleChannel.copy(lockedBy = "play"))
        }
    },
    // Locked by the license (no store fixes the channel), and a pick the host refused.
    "channelPicker-license-locked" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Settings")
            Spacer(Modifier.height(16.dp))
            PolarisChannelPicker(sampleChannel.copy(lockedByLicense = true))
        }
    },
    "channelPicker-error" to {
        PolarisScreen(showLogo = false) {
            PolarisTitle("Settings")
            Spacer(Modifier.height(16.dp))
            PolarisChannelPicker(
                PolarisChannelUi("stable", listOf("stable", "early-access")),
                onSelect = {},
                error = "Your license doesn't include this channel.",
            )
        }
    },
    "about-default" to {
        PolarisAbout(
            PolarisAboutInfo(version = "2.4.1", build = "build 241", diagnostics = "Diceroll 2.4.1 (241)\nAndroid 15"),
            onPrivacy = {},
            onSupport = {},
            onLicenses = {},
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

/** A recovery code as the keyring makes one: groups of letters and digits. */
internal val sampleRecoveryCode = PolarisRecoveryCode("K7QM-2XRD-9TBA-WF4N-HC6P-VJ3E-M4TS-8YGK")

/** The [component] state [member] says, resolved by KitStates (a `served: true` stands for a ring to confirm). */
internal fun syncScreen(component: KitComponent, member: String, vararg fields: Pair<String, Any>): KitScreen {
    val body = kotlinx.serialization.json.buildJsonObject {
        for ((key, value) in fields) {
            when {
                key == "served" -> put(
                    key,
                    kotlinx.serialization.json.buildJsonObject {
                        put("ringId", JsonPrimitive("ring_9f3a"))
                        put("epoch", JsonPrimitive(2))
                        put("rootKid", JsonPrimitive("kid_b21c"))
                    },
                )

                value is Boolean -> put(key, JsonPrimitive(value))

                else -> put(key, JsonPrimitive(value.toString()))
            }
        }
    }
    return KitStates.resolve(component, KitInputs.of(mapOf(member to body)))
}
