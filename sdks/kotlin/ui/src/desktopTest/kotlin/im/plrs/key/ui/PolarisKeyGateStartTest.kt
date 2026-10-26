// @pkey-feature ui.kit
//
// UK-09b.3: PolarisKeyGate starts the client exactly once, however often its content recomposes, and
// PolarisKeyApp (the deprecated name) is the same gate.

package im.plrs.key.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import im.plrs.key.core.CacheRecord
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Store
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals

/** The store counts how often the client loads its state, which only `start()` does. */
private class CountingStore(private val inner: Store, val loads: AtomicInteger) : Store by inner {
    override suspend fun readCache(): CacheRecord? = inner.readCache().also { loads.incrementAndGet() }
}

private const val WIDTH = 480
private const val HEIGHT = 640
private const val WAIT_MS = 10_000L
private const val NOW = 1_700_000_000L
private const val OK = 200

class PolarisKeyGateStartTest {
    private fun client(loads: AtomicInteger): PolarisKeyClient {
        val signer = TestSigner()
        val now = NOW
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/license/document" -> respond(OK, signer.licenseDoc("djdl", "dev-desk", now), mapOf("etag" to "\"v1\""))
                else -> respond(OK, """{"ok":true}""")
            }
        }
        val store = CountingStore(InMemoryStore("djdl", "dev-desk").also { runBlocking { it.setToken("pkeyt_desk") } }, loads)
        return PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = store,
                    transport = transport,
                    clock = { now },
                    expectedServices = listOf(ServiceSlug.license),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theGateStartsTheClientOnceAcrossRecompositions() = runDesktopComposeUiTest(width = WIDTH, height = HEIGHT) {
        val loads = AtomicInteger()
        val client = client(loads)
        var round by mutableStateOf(0)
        setContent {
            PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                PolarisKeyGate(client) { Text("Product round $round") }
            }
        }
        waitUntil(timeoutMillis = WAIT_MS) { onAllNodesWithText("Product round 0").fetchSemanticsNodes().isNotEmpty() }
        val afterFirst = loads.get()
        round = 1
        round = 2
        waitUntil(timeoutMillis = WAIT_MS) { onAllNodesWithText("Product round 2").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(afterFirst, loads.get(), "a recomposition must not restart the client")
        assertEquals(1, afterFirst, "the client loads its state once")
    }

    @Suppress("DEPRECATION")
    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theDeprecatedNameIsTheSameGate() = runDesktopComposeUiTest(width = WIDTH, height = HEIGHT) {
        val loads = AtomicInteger()
        val client = client(loads)
        setContent {
            PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                PolarisKeyApp(client) { Text("Old name product") }
            }
        }
        waitUntil(timeoutMillis = WAIT_MS) { onAllNodesWithText("Old name product").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1, loads.get())
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theGateHandsTheThemeAboveItTheProductPresentation() = runDesktopComposeUiTest(width = WIDTH, height = HEIGHT) {
        val client = client(AtomicInteger())
        var sink: Any? = null
        setContent {
            PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                PolarisKeyGate(client) {
                    Text("Seen")
                    sink = LocalPolarisPresentationSink.current?.value
                }
            }
        }
        waitUntil(timeoutMillis = WAIT_MS) { onAllNodesWithText("Seen").fetchSemanticsNodes().isNotEmpty() }
        waitForIdle()
        assertEquals(client.presentationSource, sink, "the one-liner needs no presentation argument")
    }
}
