// @pkey-feature ui.kit license.gate
//
// UK-10.3: the whole kit compiles for the desktop, and PolarisGate boots there. A real client over
// a scripted Worker is activated; the gate (headless Compose desktop test, no image baseline) lets
// the product through. The same shape as the Android RevokedInForegroundTest, without the revoke.

package im.plrs.key.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
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
import kotlin.test.Test

class PolarisGateBootSmokeTest {
    @OptIn(ExperimentalTestApi::class)
    @Test
    fun polarisGateBootsAndLetsAnActivatedProductThrough() = runDesktopComposeUiTest(width = 480, height = 640) {
        val signer = TestSigner()
        val now = 1_700_000_000L
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/license/document" -> respond(200, signer.licenseDoc("djdl", "dev-desk", now), mapOf("etag" to "\"v1\""))
                else -> respond(200, """{"ok":true}""")
            }
        }
        val client = PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev-desk").also { runBlocking { it.setToken("pkeyt_desk") } },
                    transport = transport, clock = { now }, expectedServices = listOf(ServiceSlug.license),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
        runBlocking { client.sync() }

        setContent {
            val scope = rememberCoroutineScope()
            val state = remember { PolarisGateState(client.gateActions(), scope).also { it.start() } }
            PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                PolarisGate(state) { Text("Diceroll product") }
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Diceroll product").fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Diceroll product").assertExists()
    }
}
