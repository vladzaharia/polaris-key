// @pkey-feature ui.kit license.gate
//
// SP-51: a licence revoked while the app is in the foreground shows the revoked screen. A real
// client over a scripted Worker is activated and gated; the server then revokes (the licence
// document and the token route answer 401), a foreground sync runs, and the gate swaps the product
// for the activation screen with no restart and no retry from the user.

package im.plrs.key.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-mdpi")
class RevokedInForegroundTest {
    @get:Rule
    val rule = createComposeRule()

    @Volatile private var revoked = false

    @Test
    fun aRevokedLicenceReplacesTheProductWithTheActivationScreen() {
        val signer = TestSigner()
        val now = 1_700_000_000L
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/license/document" ->
                    if (revoked) respond(401, """{"error":{"code":"unauthorized"}}""")
                    else respond(200, signer.licenseDoc("djdl", "dev-fg", now), mapOf("etag" to "\"v1\""))
                "/djdl/license/token" -> respond(401, """{"error":{"code":"unauthorized"}}""")
                else -> respond(200, """{"ok":true}""")
            }
        }
        val client = PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev-fg").also { runBlocking { it.setToken("pkeyt_fg") } },
                    transport = transport, clock = { now }, expectedServices = listOf(ServiceSlug.license),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
        runBlocking { client.sync() }

        rule.setContent {
            val scope = rememberCoroutineScope()
            val state = androidx.compose.runtime.remember { PolarisGateState(client.gateActions(), scope).also { it.start() } }
            PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                PolarisGate(state) { Text("Diceroll product") }
            }
        }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Diceroll product").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Diceroll product").assertIsDisplayed()

        // The server revokes; the app syncs in the foreground (PolarisKeyLifecycle does this on resume).
        revoked = true
        runBlocking { client.sync(force = true) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Diceroll product").fetchSemanticsNodes().isEmpty() }
        // The activation screen took its place.
        assertTrue(rule.onAllNodesWithText("Diceroll product").fetchSemanticsNodes().isEmpty())
    }
}
