// The sample's fixtures (UK-09b.2): the Tidewater Studio product behind a scripted Worker. The client is a real
// PolarisKeyClient (the same one `--live` builds, minus the keyring), so the kit's windows run their real paths:
// activation, the device-limit refusal, the device-code sign-in, the roster and the update install. Nothing here
// opens a socket.
//
//   activate:  any key; one containing FULL is refused with the device limit (3 of 3).
//   sign-in:   the code is WDJB-MJHT; the Worker approves it SIGN_IN_SECONDS after the code is shown.
//   update:    [Tidewater.offer] is 2.5.0 (optional); the installer is a fake that downloads 48 MB in about 9 seconds.

package im.plrs.key.samples.composeandroid

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.Presentation
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.ui.PolarisUpdateActions
import im.plrs.key.ui.PolarisUpdateUi
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import im.plrs.key.update.ProgressiveInstallDriver
import im.plrs.key.update.UpdateClientOptions
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive

internal const val PRODUCT = "tidewater"
internal const val PRODUCT_NAME = "Tidewater Studio"
internal const val DEVICE_ID = "tide-pixel"
internal const val TOKEN = "pkeyt_tidewater"

/** Seconds from the code appearing to the Worker approving it. */
internal const val SIGN_IN_SECONDS = 12L

private const val INSTALLER_BYTES = 48_000_000L
private const val INSTALLER_SECONDS = 9L

/** The fake installer: reports bytes like a real driver does, then answers that it started. */
internal class FixtureInstaller : ProgressiveInstallDriver {
    private val stage = MutableStateFlow<InstallStage>(InstallStage.Idle)
    override val progress: StateFlow<InstallStage> = stage.asStateFlow()

    override suspend fun install(check: UpdateCheck): InstallResult {
        val steps = INSTALLER_SECONDS * 4
        for (i in 1..steps) {
            stage.value = InstallStage.Downloading(INSTALLER_BYTES * i / steps, INSTALLER_BYTES)
            delay(250)
        }
        stage.value = InstallStage.Idle
        return InstallResult.Started
    }

    override suspend fun finish(): InstallResult = InstallResult.NothingToInstall
}

/** The scripted Worker and the client over it. */
internal class Tidewater(private val start: Start) {
    private val product = TestSigner("tidewater-product")
    private val release = TestSigner("tidewater-release")
    private val now: () -> Long = { System.currentTimeMillis() / 1000 }
    private val activated = start !in setOf(Start.Walk, Start.Activate, Start.Limit)
    private val signInStartedAt = AtomicLong(0)

    private val transport = ScriptedTransport { handle(it) }
    val installer = FixtureInstaller()

    val client: PolarisKeyClient = PolarisKeyClient(
        PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = PRODUCT, version = "2.4.0", pinnedKeys = product.trust, trustRefresh = false,
                store = InMemoryStore(PRODUCT, DEVICE_ID).also { store -> if (activated) runBlocking { store.setToken(TOKEN) } },
                transport = transport, clock = now, deviceName = "Pixel Tablet",
                expectedServices = listOf(ServiceSlug.license, ServiceSlug.identity, ServiceSlug.release, ServiceSlug.distribution, ServiceSlug.update),
            ),
            license = LicenseClientOptions(fingerprint = false),
            update = UpdateClientOptions(pinnedReleaseKeys = release.trust, installDriver = installer),
        ),
    ).also { runBlocking { it.core.presentation.accept(Presentation(PRODUCT_NAME, "Harbor Audio", accent = "#26847a", accentDark = "#4fc4b8")) } }

    /** The update on offer, as the kit's update prompt draws it: 2.5.0, optional. */
    fun offer(): PolarisUpdateUi = PolarisUpdateUi(
        version = "2.5.0", currentVersion = "2.4.0", size = INSTALLER_BYTES,
        notes = listOf("Faster project loading", "Fixes a crash when exporting on battery"),
    )

    /** What the update prompt's install runs; the install itself is [installer]. */
    val updateActions: PolarisUpdateActions = object : PolarisUpdateActions {
        override suspend fun install(check: UpdateCheck): InstallResult = installer.install(check)
        override suspend fun finish(): InstallResult = installer.finish()
        override val stages = installer.progress
    }

    /** The check the install is handed: the fixture installer ignores what is in it. */
    fun check(): UpdateCheck = UpdateCheck(
        "stable",
        UpdateDecision.Platform(DecisionRelease("2.5.0", 7), mandatory = false, critical = false, discardStaged = false),
        UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList(),
    )

    private fun handle(r: PolarisRequest): PolarisResponse {
        val bearer = r.headers["authorization"]?.removePrefix("Bearer ")
        return when (r.path) {
            "/$PRODUCT/license/activate" ->
                if (bearer.orEmpty().uppercase().contains("FULL")) {
                    respond(403, """{"error":"device_limit","limit":3,"deviceCount":3,"manageUrl":"https://polaris.locker/portal/tidewater/devices"}""")
                } else {
                    respond(200, """{"token":"$TOKEN","schemaVersion":1}""")
                }
            "/$PRODUCT/license/document" ->
                if (bearer == TOKEN) {
                    respond(
                        200,
                        product.licenseDoc(
                            PRODUCT, DEVICE_ID, now(), licenseId = "lic_tidewater",
                            entitlements = mapOf("license.tier" to JsonPrimitive("studio"), "license.tierLabel" to JsonPrimitive("Studio"), "deviceLimit" to JsonPrimitive(3)),
                        ),
                        mapOf("etag" to "\"v1\""),
                    )
                } else {
                    respond(401, """{"error":"unauthorized"}""")
                }
            "/$PRODUCT/identity/auth/device/start" -> {
                signInStartedAt.set(now())
                respond(
                    200,
                    """{"deviceCode":"dc_tidewater","userCode":"WDJB-MJHT","verificationUri":"https://polaris.locker/device","verificationUriComplete":"https://polaris.locker/device?code=WDJB-MJHT","expiresIn":600,"interval":2,"deviceName":"Pixel Tablet"}""",
                )
            }
            "/$PRODUCT/identity/auth/device/poll" ->
                if (now() - signInStartedAt.get() >= SIGN_IN_SECONDS) {
                    respond(200, """{"status":"ready","token":"$TOKEN"}""")
                } else {
                    respond(200, """{"status":"pending"}""")
                }
            "/$PRODUCT/devices" -> respond(200, roster())
            else ->
                if (r.path.startsWith("/$PRODUCT/devices/")) respond(200, "{}") else respond(404)
        }
    }

    private fun roster(): String {
        val t = now()
        return """{"devices":[
            {"id":"$DEVICE_ID","label":"Pixel Tablet","platform":"android","lastSeen":${t - 30}},
            {"id":"dev-laptop","label":"Mira's Pixel 9","platform":"android","lastSeen":${t - 3 * 3600}},
            {"id":"dev-bench","label":"Bench PC","platform":"windows","lastSeen":${t - 5 * 86_400}}]}"""
    }
}
