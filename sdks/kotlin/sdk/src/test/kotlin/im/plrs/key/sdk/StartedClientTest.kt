// @pkey-feature core.store core.headers license.activate
//
// SP-50: a client is usable without `start()`. The documented Android path never called it, so the
// first activation went out with an empty X-PKey-Device and a stored licence read as "needs
// activation". Now every call loads the device id, token and cache first; `start()` is optional and
// runs once; and a client that has nowhere to keep its token fails clearly instead of writing under
// `/`.

package im.plrs.key.sdk

import im.plrs.key.core.CacheRecord
import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.HeaderName
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Store
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StartedClientTest {
    private val signer = TestSigner()
    private val now = 1_700_000_000L

    private fun options(store: Store, transport: ScriptedTransport) = PolarisKeyClientOptions(
        core = CoreOptions(
            productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
            store = store, transport = transport, clock = { now }, expectedServices = listOf(ServiceSlug.license),
        ),
        license = LicenseClientOptions(fingerprint = false),
    )

    /** A store that counts its loads, to show `start()` runs once. */
    private class CountingStore(private val inner: InMemoryStore) : Store by inner {
        val deviceReads = AtomicInteger()
        override suspend fun getDeviceId(): String = inner.getDeviceId().also { deviceReads.incrementAndGet() }
    }

    @Test
    fun aClientNeverStartedSendsItsDeviceIdAndIsLicensed() = runBlocking {
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/license/activate" -> respond(200, """{"token":"pkeyt_started","schemaVersion":4}""")
                "/djdl/license/document" -> respond(200, signer.licenseDoc("djdl", "dev-started", now), mapOf("etag" to "\"a\""))
                else -> respond(200, """{"ok":true}""")
            }
        }
        val client = PolarisKeyClient(options(InMemoryStore("djdl", "dev-started"), transport))
        // No start(): the activation itself loads the device id first.
        val result = client.activate("pkey_djdl_key")
        assertTrue("$result", result is ActivationResult.Ok)
        val activate = transport.requests().first { it.path == "/djdl/license/activate" }
        assertEquals("dev-started", activate.headers[HeaderName.device])
        assertEquals(LicenseStatus.ok, client.status().status)
    }

    @Test
    fun aStoredLicenceIsReadWithoutStart() = runBlocking {
        val store = InMemoryStore("djdl", "dev-stored")
        store.setToken("pkeyt_stored")
        store.writeCache(CacheRecord(docs = mapOf(DocumentSlice.license to signer.licenseDoc("djdl", "dev-stored", now))))
        val client = PolarisKeyClient(options(store, ScriptedTransport { respond(599) }))
        assertEquals(LicenseStatus.ok, client.status().status)
        assertTrue(client.isLicensed())
    }

    @Test
    fun startRunsOnceAndIsOptional() = runBlocking {
        val store = CountingStore(InMemoryStore("djdl", "dev-once"))
        val client = PolarisKeyClient(options(store, ScriptedTransport { respond(599) }))
        client.start()
        client.start()
        client.status()
        assertEquals(1, store.deviceReads.get())
        // A reload is still there for a host that wants one.
        client.core.start()
        assertEquals(2, store.deviceReads.get())
    }

    @Test
    fun noStoreOnAndroidFailsClearly() {
        try {
            CoreContext.defaultStore("djdl", android = true)
            fail("Android has no default store")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidOptions, e.code)
            assertTrue(e.message!!, e.message!!.contains("PolarisKeyAndroid.client"))
        }
    }

    @Test
    fun noHomeDirectoryFailsClearlyInsteadOfWritingUnderTheRoot() {
        for (home in listOf("", "?")) {
            try {
                FileStore.defaultDirectory("djdl", home = home, os = "Linux", env = { null })
                fail("an empty user.home has no default directory")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.invalidOptions, e.code)
            }
        }
        // XDG_STATE_HOME still answers without a home directory.
        assertEquals(
            java.io.File("/state/polaris-key/djdl"),
            FileStore.defaultDirectory("djdl", home = "", os = "Linux", env = { if (it == "XDG_STATE_HOME") "/state" else null }),
        )
    }
}
