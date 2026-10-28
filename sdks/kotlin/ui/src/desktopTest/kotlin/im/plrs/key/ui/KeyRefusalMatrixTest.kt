// @pkey-feature ui.kit.keyentry ui.kit.account
//
// I-10b.20: the two key refusals (key-entry-limit, license-owned), the entries-left toast and the
// signed-in tier toast across the three desktop chromes at the §7.1 sizes, font scale 2 and touch. Every frame
// passes the matrix's checks (no control clipped, no cut text, no sideways scroll, the primary action in the first
// viewport, 24 dp targets under a mouse and 44 dp under touch). With PKEY_KIT_SHOTS set each frame is written to
// <dir>/matrix/<chrome>/<screen>/<w>x<h>[-fs2|-touch].png.

@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.identity.ReplaceView
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.KeyEntries
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private const val KEY = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV"
private const val ADD = "${BoardFixtures.LOCKER}/activate?product=tidewater"
private const val SIGN_IN_PAGE = "${BoardFixtures.LOCKER}/signin?product=tidewater"

private fun needs() = LicenseState(LicenseStatus.needsActivation)

private fun limitUi(manage: String? = ADD) = PolarisActivationUi(
    key = KEY,
    error = PolarisActivationError.Refused(ActivationResult.KeyEntryLimit(manage, KeyEntries(3, 3))),
    manageUrl = manage,
    manageQrUrl = manage,
)

private val ownedUi = PolarisActivationUi(
    key = KEY,
    error = PolarisActivationError.Refused(ActivationResult.LicenseOwned(SIGN_IN_PAGE)),
    signInUrl = SIGN_IN_PAGE,
)

private val refusalScreens: List<MatrixScreen> = listOf(
    MatrixScreen("key-entry-limit", Regex("^sign in$", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(PolarisGateUi(license = needs()), limitUi(), onSignIn = {})
    },
    MatrixScreen("key-entry-limit-tv", Regex("^sign in$", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(PolarisGateUi(license = needs()), limitUi(), onSignIn = {}, manageAsQr = true)
    },
    MatrixScreen("key-entry-limit-no-link", Regex("^sign in$", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(PolarisGateUi(license = needs()), limitUi(manage = null), onSignIn = {})
    },
    MatrixScreen("license-owned", Regex("sign in to that account", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(PolarisGateUi(license = needs()), ownedUi, onSignIn = {})
    },
    MatrixScreen("license-owned-link", Regex("sign in to that account", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(PolarisGateUi(license = needs()), ownedUi)
    },
)

class KeyRefusalMatrixTest {
    private val out = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)

    private fun run(chrome: String, sizes: List<Pair<Int, Int>>, fontScale: Float, touch: Boolean, suffix: String): List<String> {
        val failures = mutableListOf<String>()
        withPlatform(chrome) {
            for ((rowW, rowH) in sizes) for (screen in refusalScreens) {
                val mac = chrome == "MacOS"
                val w = if (mac) maxOf(rowW, 480) else rowW
                val h = if (mac) maxOf(rowH, 520) else rowH
                matrixFrame(w, h, dark = true, fontScale = fontScale, touch = touch, content = screen.content, after = {
                    val check = checkFrame(screen, if (touch) 44f else 24f)
                    for (f in check.failures) failures += "$chrome ${screen.name} ${w}x$h$suffix: $f"
                    writeShot(out, chrome, screen.name, w, h, suffix)
                })
            }
        }
        return failures
    }

    @Test
    fun theRefusalsFitEverySize() {
        val failures = matrixChromes.flatMap { run(it, matrixSizes, 1f, touch = false, suffix = "") }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @Test
    fun theRefusalsSurviveFontScale2() {
        val failures = unexpected(matrixChromes.flatMap { run(it, matrixLargeFontSizes, 2f, touch = false, suffix = "-fs2") })
            .filterNot { it.startsWith("a known gap no longer occurs") }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @Test
    fun theRefusalsHaveTouchTargets() {
        val failures = matrixChromes.flatMap { run(it, listOf(390 to 844), 1f, touch = true, suffix = "-touch") }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @Test
    fun theRefusalsSayTheCatalogsWords() {
        withPlatform("Windows") {
            matrixFrame(390, 844, dark = false, content = refusalScreens[0].content, after = {
                onNodeWithText("This key has no entries left. Add it to your account and sign in instead.").assertExists()
                onNodeWithText("Tidewater Studio").assertExists()
                onNodeWithText("Add Tidewater Studio to your account").assertExists()
                onNodeWithText("Use a different key").assertExists()
            })
            matrixFrame(390, 844, dark = false, content = refusalScreens[3].content, after = {
                onNodeWithText("Sign in to that account").assertExists()
                onNodeWithText("Use a different key").assertExists()
                onNodeWithText("License in another account").assertExists()
            })
            // A desktop host cannot draw the QR: the link is copied instead.
            matrixFrame(844, 600, dark = false, content = refusalScreens[1].content, after = {
                onNodeWithText("Copy link").assertExists()
            })
        }
    }

    @Test
    fun theTvShowsTheLinkAsAQrAndNoKeyIsInIt() {
        assertEquals(ADD, limitUi().manageQrUrl)
        assertTrue(KEY !in limitUi().manageQrUrl!!)
    }

    /** The two toasts: the entries left after a key activation, and the tier after a sign-in. */
    @Test
    fun theToastsNameTheEntriesAndTheTier() {
        assertEquals("2 key entries left", keyEntriesLeftLine(1, 3, "en"))
        assertEquals("1 key entry left", keyEntriesLeftLine(2, 3, "en"))
        assertEquals("0 key entries left", keyEntriesLeftLine(4, 3, "en"))
        assertEquals("Signed in as Ada · Pro license", signedInMessage(SignedInAs("Ada", "Pro"), "en"))
        assertEquals("You're signed in · Pro license", signedInMessage(SignedInAs(null, "Pro"), "en"))
        assertEquals("You're signed in", signedInMessage(SignedInAs("Ada", null), "en"))
        assertEquals("You're signed in", signedInMessage(null, "en"))
        for ((name, text) in listOf("signed-in" to signedInMessage(SignedInAs("Ada", "Pro"), "en"), "entries-left" to keyEntriesLeftLine(1, 3, "en"))) {
            withPlatform("Windows") {
                matrixFrame(844, 500, dark = true, content = {
                    PolarisGateScreen(
                        PolarisGateUi(license = LicenseState(LicenseStatus.ok)),
                        PolarisActivationUi(),
                        toast = PolarisToastSpec(text, if (name == "signed-in") PolarisToastKind.Success else PolarisToastKind.Info),
                    ) { Box(Modifier.fillMaxSize()) { BoardFixtures.Product() } }
                }, after = {
                    onNodeWithText(text).assertExists()
                    writeShot(out, "Windows", name, 844, 500, "")
                })
            }
        }
    }

    /** `rememberLicenseChoiceState` builds the holder from a settled Choose and finishes through the actions. */
    @Test
    fun rememberLicenseChoiceStateWrapsTheJvmHolder() = runDesktopComposeUiTest(width = 400, height = 300) {
        val view = Json.parseToJsonElement("""{"state":"choose","choices":[{"id":"lic_pro","state":"ok"}],"preselected":"lic_pro"}""").jsonObject
        val choose = SignInOutcome.Choose("sg_x", 300.0, view)
        val calls = ArrayList<LicenseChoice>()
        val actions = object : PolarisLicenseChoiceActions {
            override suspend fun licenses(grant: String): ChoiceResult<LicenseChoiceView> = ChoiceResult.Refused("rate_limited", 429)
            override suspend fun devices(grant: String, licenseId: String): ChoiceResult<ReplaceView> = ChoiceResult.Refused("not_found", 404)
            override suspend fun complete(grant: String, choice: LicenseChoice): ChoiceResult<ChoiceCompleted> {
                calls += choice
                return ChoiceResult.Ok(ChoiceCompleted("lic_pro", "ps_x", "profile"))
            }
            override suspend fun cancel(grant: String): ChoiceResult<Unit> = ChoiceResult.Ok(Unit)
        }
        var state: PolarisLicenseChoiceState? = null
        var completed by mutableStateOf<ChoiceCompleted?>(null)
        setContent { state = rememberLicenseChoiceState(choose, actions) { completed = it } }
        waitForIdle()
        val held = assertNotNull(state)
        assertEquals("lic_pro", (held.ui.value as PolarisLicenseChoiceUi.Choosing).preselected)
        held.choose("lic_pro")
        waitUntil(timeoutMillis = 5_000) { completed != null }
        assertEquals(listOf<LicenseChoice>(LicenseChoice.License("lic_pro")), calls)
        assertTrue(held.ui.value is PolarisLicenseChoiceUi.Done)

        // A Worker answer that is not a view leaves the card to choose: no state.
        assertEquals(null, PolarisLicenseChoiceState.firstView(SignInOutcome.Choose("sg_y", 300.0, Json.parseToJsonElement("""{"nope":1}""").jsonObject)))
    }
}
