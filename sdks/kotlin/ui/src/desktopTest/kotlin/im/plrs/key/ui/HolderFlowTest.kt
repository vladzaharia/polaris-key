// @pkey-feature ui.kit.holders
//
// UK-43.10: the holders' screens wired to a live client on the desktop kit. After a key activates the gate
// draws the Done step before the product and forgets the key at Start using; the recommendation leads to the
// account form, Cancel on an idle form goes back to Done; Settings on a floating license offers Add and calls
// the exit Remove license; the portal link carries `#key=` on a phone or a desktop and never on a TV; the key
// never prints.

@file:Suppress("MagicNumber", "TooManyFunctions")

package im.plrs.key.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class HolderFlowTest {
    private var old: String? = null

    @BeforeTest
    fun forceWindows() {
        // The host may be a Mac, whose labels are title case: these tests are not about one OS.
        old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
    }

    @AfterTest
    fun restore() {
        old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    }

    private fun client(vararg services: ServiceSlug): PolarisKeyClient {
        val signer = TestSigner()
        val now = 1_700_000_000L
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/license/document" -> respond(200, signer.licenseDoc("djdl", "dev-desk", now), mapOf("etag" to "\"v1\""))
                else -> respond(200, """{"ok":true}""")
            }
        }
        return PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = InMemoryStore("djdl", "dev-desk").also { runBlocking { it.setToken("pkeyt_desk") } },
                    transport = transport,
                    clock = { now },
                    expectedServices = services.toList(),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        ).also { runBlocking { it.sync() } }
    }

    private class Activating(var status: LicenseStatus = LicenseStatus.needsActivation) : PolarisGateActions {
        override suspend fun status(): LicenseState = LicenseState(status)
        override suspend fun activate(key: String): ActivationResult {
            status = LicenseStatus.ok
            return ActivationResult.Ok("pkeyt_x", 1)
        }
    }

    @Test
    fun theGateShowsDoneBeforeTheProductAndStartUsingForgetsTheKey() = runDesktopComposeUiTest(900, 700) {
        val client = client(ServiceSlug.license, ServiceSlug.identity)
        lateinit var gate: PolarisGateState
        setContent {
            val scope = rememberCoroutineScope()
            gate = remember { PolarisGateState(Activating(), scope).also { it.start() } }
            PolarisTheme(branding = PolarisBranding.PolarisKey, copy = PolarisCopy(productName = "Tidewater Studio"), darkTheme = false) {
                PolarisKeyProvider(client) { PolarisGate(gate) { Text("The product") } }
            }
        }
        waitForIdle()
        gate.onKeyChange("pkey_secret")
        gate.activate()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Start using Tidewater Studio").fetchSemanticsNodes().isNotEmpty() }
        onAllNodesWithText("The product").assertCountEquals(0)
        onNodeWithText("Tidewater Studio is ready").assertExists()
        assertNotNull(gate.keyDone.value)
        assertFalse(gate.keyDone.value.toString().contains("pkey_secret"), "the key never prints")
        onNodeWithText("Start using Tidewater Studio").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("The product").fetchSemanticsNodes().isNotEmpty() }
        assertNull(gate.keyDone.value, "Start using forgets the key")
    }

    @Test
    fun theRecommendationOpensTheFormAndCancelOnAnIdleFormGoesBackToDone() = runDesktopComposeUiTest(900, 700) {
        val client = client(ServiceSlug.license, ServiceSlug.identity)
        lateinit var gate: PolarisGateState
        setContent {
            val scope = rememberCoroutineScope()
            gate = remember { PolarisGateState(Activating(), scope).also { it.start() } }
            PolarisTheme(branding = PolarisBranding.PolarisKey, copy = PolarisCopy(productName = "Tidewater Studio"), darkTheme = false) {
                PolarisKeyProvider(client) { PolarisGate(gate) { Text("The product") } }
            }
        }
        waitForIdle()
        gate.onKeyChange("pkey_secret")
        gate.activate()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Start using Tidewater Studio").fetchSemanticsNodes().isNotEmpty() }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Add your name and email").fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Add your name and email").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Continue").fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Cancel").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Tidewater Studio is ready").fetchSemanticsNodes().isNotEmpty() }
        assertNotNull(gate.keyDone.value, "leaving the form is not Start using")
    }

    @Test
    fun withTheStepOffTheGateGoesStraightToTheProduct() = runDesktopComposeUiTest(900, 700) {
        val client = client(ServiceSlug.license, ServiceSlug.identity)
        lateinit var gate: PolarisGateState
        setContent {
            val scope = rememberCoroutineScope()
            gate = remember { PolarisGateState(Activating(), scope).also { it.start() } }
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisKeyProvider(client) { PolarisGate(gate, keyDone = false) { Text("The product") } }
            }
        }
        waitForIdle()
        gate.onKeyChange("pkey_secret")
        gate.activate()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("The product").fetchSemanticsNodes().isNotEmpty() }
        waitUntil(timeoutMillis = 5_000) { gate.keyDone.value == null }
    }

    @Test
    fun aFloatingLicenseOffersAddAndCallsTheExitRemoveLicense() = runDesktopComposeUiTest(900, 700) {
        var added = 0
        var out = 0
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisAccountScreen(
                    settingsUi = PolarisSettingsUi(loading = false, license = PolarisLicenseSummary(LicenseStatus.ok, floating = true)),
                    devicesUi = PolarisDevicesUi(loading = false),
                    onSignOut = { out++ },
                    onAddToAccount = { added++ },
                    floating = true,
                )
            }
        }
        waitForIdle()
        onNodeWithText("Not in an account").assertExists()
        onNodeWithText("Add your name and email").performClick()
        assertEquals(1, added)
        onAllNodesWithText("Sign out").assertCountEquals(0)
        onNodeWithText("Remove license from this device").performClick()
        assertEquals(1, out)
    }

    @Test
    fun anAccountOutOfTheFloatingStateKeepsSignOut() = runDesktopComposeUiTest(900, 700) {
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisAccountScreen(
                    settingsUi = PolarisSettingsUi(loading = false, license = PolarisLicenseSummary(LicenseStatus.ok)),
                    devicesUi = PolarisDevicesUi(loading = false),
                    onSignOut = {},
                )
            }
        }
        waitForIdle()
        onNodeWithText("Sign out").assertExists()
        onAllNodesWithText("Not in an account").assertCountEquals(0)
    }

    @Test
    fun thePortalLinkCarriesTheKeyOnAPhoneOrDesktopAndNeverOnATv() {
        val opened = mutableListOf<String>()
        val opener = PolarisOpener {
            opened += it
            true
        }
        val link = "https://polaris.locker/activate?product=djdl"
        assertTrue(opener.openPortal(link, "pkey_k", tv = false))
        assertTrue(opener.openPortal(link, "pkey_k", tv = true))
        assertTrue(opener.openPortal(link, null, tv = false))
        assertEquals("$link#key=pkey_k", opened[0])
        assertEquals(link, opened[1])
        assertEquals(link, opened[2])
        assertFalse(opener.openPortal(null, "pkey_k", tv = false), "no link is a refusal, not a silent open")
        assertFalse(opener.openPortal("http://polaris.locker/activate", "pkey_k", tv = false), "the opener refuses a link that is not https")
    }

    @Test
    fun anAccountSignInThatCannotStartIsFalseNotSilent() {
        // Identity is off: the sign-in refuses, and the screen gets false to say so (never a dropped session).
        assertFalse(runBlocking { client(ServiceSlug.license).signInToAccount("ada@example.com") })
    }

    @Test
    fun theHolderFactsCarryTheHolderEmailAndNoPositionOffline() {
        val facts =
            runBlocking { client(ServiceSlug.license, ServiceSlug.identity).holderFacts(HOLDER_ADD_IN_APP, "computer", PolarisKeyDone("pkey_k")) }
        assertFalse(facts.portalOnly)
        assertNull(facts.holderEmail)
        assertTrue(facts.portal?.startsWith("https://") == true)
    }
}
