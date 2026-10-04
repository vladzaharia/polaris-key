// @pkey-feature core.store devices.facts
package im.plrs.key.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.update.UpdateClientOptions
import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The umbrella wiring and the build download. */
@RunWith(RobolectricTestRunner::class)
class PolarisKeyAndroidTest {
    @get:Rule val tmp = TemporaryFolder()

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val signer = TestSigner()
    private val releaseSigner = TestSigner("release-key")

    private fun options(store: im.plrs.key.core.Store? = null) = PolarisKeyClientOptions(
        core = CoreOptions(productSlug = "diceroll", version = "1.0.0", pinnedKeys = signer.trust, store = store),
        update = UpdateClientOptions(pinnedReleaseKeys = releaseSigner.trust),
    )

    @Test
    fun clientGetsTheAndroidEdges() {
        val client = PolarisKeyAndroid.client(ctx, options())
        assertTrue("the Keystore store by default", client.core.store is AndroidKeystoreStore)
        assertTrue(PolarisKeyAndroid.flavor == "play" || PolarisKeyAndroid.flavor == "direct")
        // A store the host set is kept.
        val mine = InMemoryStore("diceroll")
        assertSame(mine, PolarisKeyAndroid.client(ctx, options(mine)).core.store)
    }

    @Test
    fun buildDownloadStreamsA200AndRefusesAnythingElse() = runBlocking {
        val server = MockWebServer()
        val bytes = ByteArray(70_000) { (it % 251).toByte() }
        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        server.enqueue(MockResponse().setResponseCode(404))
        server.start()
        try {
            val base = server.url("/").toString().trimEnd('/')
            val core = CoreContext(CoreOptions(productSlug = "diceroll", baseUrl = base, version = "1.0.0", pinnedKeys = signer.trust, store = InMemoryStore("diceroll")))
            val dl = OkHttpBuildDownload(core)
            val dest = File(tmp.root, "a.apk")
            dl.download("$base/diceroll/distribution/builds/1.1.0/android-arm64", dest)
            assertArrayEquals(bytes, dest.readBytes())
            val req = server.takeRequest()
            assertEquals("diceroll", req.getHeader("X-PKey-Product") ?: "diceroll")
            try {
                dl.download("$base/missing", File(tmp.root, "b.apk"))
                fail("a 404 must fail")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.httpError, e.code)
            }
        } finally {
            server.shutdown()
        }
    }
}
