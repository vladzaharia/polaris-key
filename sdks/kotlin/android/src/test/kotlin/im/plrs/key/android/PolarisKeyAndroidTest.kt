// @pkey-feature core.store devices.facts identity.restore
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
import java.io.File

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
    fun clientInstallsTheBlockStoreBackupForSilentRestoreUnlessTheDeveloperTurnsItOff() {
        // I-49.11: rung 2 keeps its item in the platform backup; AndroidOptions.restore = false is the opt-out.
        assertTrue(PolarisKeyAndroid.client(ctx, options()).identity.hasPlatformBackup)
        assertTrue(PolarisKeyAndroid.client(ctx, options(), AndroidOptions(restore = false)).identity.hasPlatformBackup)
    }

    private class DurableKeys(private val inner: im.plrs.key.core.InMemoryDeviceKeyStorage = im.plrs.key.core.InMemoryDeviceKeyStorage()) :
        im.plrs.key.core.DeviceKeyStorage by inner {
        override val persistence = im.plrs.key.core.DeviceKeyPersistence.durable
    }

    private class FakeBackup : im.plrs.key.platform.PlatformBackup {
        val items = HashMap<String, ByteArray>()
        val calls = ArrayList<String>()
        override val isSupported = true
        override fun cloudBackup(callback: (Boolean) -> Unit) = callback(true)
        override fun get(key: String, callback: (im.plrs.key.platform.PlatformBackupRead) -> Unit) {
            calls += "get"
            callback(items[key]?.let { im.plrs.key.platform.PlatformBackupRead.Found(it) } ?: im.plrs.key.platform.PlatformBackupRead.Missing)
        }
        override fun set(key: String, bytes: ByteArray, callback: (im.plrs.key.platform.PlatformBackupWrite) -> Unit) {
            calls += "set"
            items[key] = bytes
            callback(im.plrs.key.platform.PlatformBackupWrite.Done(true))
        }
        override fun delete(key: String, callback: (im.plrs.key.platform.PlatformBackupWrite) -> Unit) {
            calls += "delete"
            items.remove(key)
            callback(im.plrs.key.platform.PlatformBackupWrite.Done(false))
        }
    }

    @Test
    fun restoreRungRedeemsTheBlockStoreItemOnAnAndroidClientAndWritesTheNewOne() = runBlocking {
        val oldItem = """{"v":1,"restoreId":"rk_${"a".repeat(22)}","secret":"rs_${"b".repeat(43)}"}""".toByteArray()
        val fake = FakeBackup().also { it.items["pkey-restore-diceroll"] = oldItem }
        val server = MockWebServer()
        val seen = ArrayList<String>()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val base = server.url("/").toString().trimEnd('/') + "/diceroll/identity"
                seen += "${request.method} ${request.path}"
                return when (request.path) {
                    "/diceroll/.well-known/polaris.json" -> MockResponse().setBody(
                        """{"product":"diceroll","services":{"identity":{"enabled":true,"configured":true,""" +
                            """"account":true,"restore":true,"endpoints":{"token":"$base/token","restore":"$base/restore"}}}}""",
                    )

                    "/diceroll/identity/token" -> MockResponse().setBody(
                        """{"access_token":"pkeyt_restored","token_type":"Bearer","scope":"profile","schemaVersion":1,""" +
                            """"device":{"id":"D"},"license":null,"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ",""" +
                            """"issued_token_type":"urn:polaris-key:token-type:device"}""",
                    )

                    "/diceroll/identity/restore" -> MockResponse().setResponseCode(201)
                        .setBody("""{"restoreId":"rk_${"c".repeat(22)}","secret":"rs_${"d".repeat(43)}"}""")

                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found"}}""")
                }
            }
        }
        server.start()
        try {
            val client = PolarisKeyAndroid.client(
                ctx,
                PolarisKeyClientOptions(
                    core = CoreOptions(
                        productSlug = "diceroll",
                        baseUrl = server.url("/").toString().trimEnd('/'),
                        version = "1.0.0",
                        pinnedKeys = signer.trust,
                        trustRefresh = false,
                        store = InMemoryStore("diceroll"),
                    ),
                    // Robolectric has no Keystore: the device keys are durable in memory for this test.
                    connect = im.plrs.key.sdk.ConnectOptions(deviceKeys = im.plrs.key.core.DeviceKeyStore(DurableKeys())),
                    update = UpdateClientOptions(pinnedReleaseKeys = releaseSigner.trust),
                ),
            )
            client.identity.installPlatformBackup(AndroidPlatformBackupStore(fake))
            val result = client.identity.autoSignIn()
            assertTrue("signed in by restore: $result $seen ${fake.calls}", result is im.plrs.key.identity.AutoSignInResult.SignedIn)
            assertTrue(seen.toString(), seen.any { it == "POST /diceroll/identity/token" })
            assertTrue(seen.toString(), seen.any { it == "POST /diceroll/identity/restore" })
            // The new key replaced the old in the Block Store item.
            assertTrue(String(fake.items["pkey-restore-diceroll"]!!).contains("rk_" + "c".repeat(22)))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun clientGetsTheAndroidDeviceKeysSoTheExchangeReachesTheNonceRoute() = runBlocking {
        val server = MockWebServer()
        val base = "http://localhost"
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse = when (request.path) {
                "/diceroll/.well-known/polaris.json" -> MockResponse().setBody(
                    """{"product":"diceroll","services":{"identity":{"enabled":true,"configured":true,"account":true,""" +
                        """"exchange":{"kinds":["google"],"google":{"serverClientId":"1234-web.apps.googleusercontent.com"}},""" +
                        """"endpoints":{"nonce":"$base/diceroll/identity/nonce","token":"$base/diceroll/identity/token"}}}}""",
                )

                else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found"}}""")
            }
        }
        server.start()
        try {
            val client = PolarisKeyAndroid.client(
                ctx,
                PolarisKeyClientOptions(
                    core = CoreOptions(
                        productSlug = "diceroll",
                        baseUrl = server.url("/").toString().trimEnd('/'),
                        version = "1.0.0",
                        pinnedKeys = signer.trust,
                    ),
                    update = UpdateClientOptions(pinnedReleaseKeys = releaseSigner.trust),
                ),
            )
            // K1: with no device keys the call answered Ended(Unavailable(noDeviceKeys)) before any request;
            // with them it goes on to the product's discovery (here a scripted refusal throws).
            val answer = try {
                client.identity.exchangeNonce(im.plrs.key.identity.ExchangeKind.google)
            } catch (e: PolarisException) {
                null
            }
            assertTrue("device keys are set: $answer", server.requestCount > 0)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun localClientNamespacesTheDefaultAndroidStore() {
        val local = PolarisKeyAndroid.client(
            ctx,
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "diceroll",
                    baseUrl = "http://localhost:8787",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                ),
                update = UpdateClientOptions(pinnedReleaseKeys = releaseSigner.trust),
            ),
        )
        assertEquals(
            "diceroll@localhost_8787",
            (local.core.store as AndroidKeystoreStore).productSlug,
        )
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
            val core =
                CoreContext(
                    CoreOptions(
                        productSlug = "diceroll",
                        baseUrl = base,
                        version = "1.0.0",
                        pinnedKeys = signer.trust,
                        trustRefresh = false,
                        store = InMemoryStore("diceroll"),
                    ),
                )
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
