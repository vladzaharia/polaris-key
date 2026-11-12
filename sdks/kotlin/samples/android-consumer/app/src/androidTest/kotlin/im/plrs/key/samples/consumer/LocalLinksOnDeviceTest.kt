// @pkey-feature connect.local
//
// CC-29b.A on a real Android runtime (API 34 and up, where NsdManager has the calls the adapter needs): two clients of one
// app on one emulator pair with a code (mode q), each stores the link in the Keystore-sealed local store, the record reads
// back through a third client with the peer's platform, and one device then opens the link (mode l) and the other receives
// the session. Real NSD, real loopback-free TCP on the emulator's network; no account anywhere.

package im.plrs.key.samples.consumer

import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.android.androidLocalStorage
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.platform.AndroidKeyStoreProvider
import im.plrs.key.platform.KeystoreSealer
import im.plrs.key.sdk.ConnectOptions
import im.plrs.key.sdk.ConnectSession
import im.plrs.key.sdk.LanErrorReason
import im.plrs.key.sdk.LanException
import im.plrs.key.sdk.LocalCode
import im.plrs.key.sdk.LocalJoinOptions
import im.plrs.key.sdk.LocalPairOptions
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class LocalLinksOnDeviceTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dir = File(context.cacheDir, "local-links-test-${System.nanoTime()}")
    private val servers = ArrayList<SplitServer>()
    private val clients = ArrayList<PolarisKeyClient>()

    /** Allows local pairing (`services.connect.localPairing`) and nothing else. */
    private fun discovery(): SplitServer = SplitServer(splitMillis = 0) { r ->
        if (r.path.endsWith("/.well-known/polaris.json")) {
            Reply(
                200,
                """{"product":"${ConsumerApp.PRODUCT}","services":{"connect":{"enabled":true,"localPairing":true,"relay":false,""" +
                    """"endpoints":{"identity":"x","devices":"y"}}}}""",
            )
        } else {
            Reply(404, """{"error":{"code":"not_found"}}""")
        }
    }.also { servers += it }

    /** One device: its own server (so its own store namespace) and its own sealed local-link file. */
    private fun device(name: String, withStore: Boolean = true): PolarisKeyClient {
        val base = ConsumerApp.options(discovery().baseUrl)
        val options = if (withStore) {
            base.copy(connect = ConnectOptions(localState = androidLocalStorage(context, ConsumerApp.PRODUCT, file = File(dir, "$name.bin"))))
        } else {
            base
        }
        return PolarisKeyAndroid.client(context, options).also { clients += it }
    }

    @After
    fun tearDown() {
        runBlocking {
            for (c in clients) runCatching { c.cloudConnect.stop() }
            // The sealed record and its wrapping key go with the test.
            runCatching { androidLocalStorage(context, ConsumerApp.PRODUCT, file = File(dir, "a.bin")).deleteRecord() }
            runCatching { androidLocalStorage(context, ConsumerApp.PRODUCT, file = File(dir, "b.bin")).deleteRecord() }
        }
        scope.cancel()
        for (s in servers) s.close()
        dir.deleteRecursively()
    }

    private suspend fun until(what: String, seconds: Long = 30, condition: () -> Boolean) {
        try {
            withTimeout(seconds * 1000) {
                while (!condition()) delay(100)
            }
        } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $what", timeout)
        }
    }

    @Test
    fun aClientWithNoSealedStoreRefusesAndPolarisKeyAndroidSuppliesOne() = runBlocking {
        val bare = PolarisKeyAndroid.client(context, ConsumerApp.options(discovery().baseUrl)).also { clients += it }
        // PolarisKeyAndroid fills the sealed store in: a read works, and a device with no record holds no link.
        assertTrue(bare.cloudConnect.localLinks.list().isEmpty())
        // The plain core client has no sealed store on Android and refuses, rather than write link secrets in a plain file.
        val base = ConsumerApp.options(discovery().baseUrl)
        val plain = PolarisKeyClient(base.copy(core = base.core.copy(store = im.plrs.key.core.InMemoryStore(ConsumerApp.PRODUCT)))).also {
            clients +=
                it
        }
        try {
            plain.cloudConnect.localLinks.list()
            fail("a plain file store must not hold link secrets on Android")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidOptions, e.code)
        }
    }

    @Test
    fun twoDevicesPairWithACodeThenOpenTheLinkAndTheRecordSurvivesAReload() = runBlocking {
        assumeTrue("NsdManager needs API 34", Build.VERSION.SDK_INT >= 34)
        // One app holds one store, so one wrapping key; the two devices of this test share the alias, and the key is made once.
        KeystoreSealer(AndroidKeyStoreProvider(context), KeystoreSealer.localAliasFor(ConsumerApp.PRODUCT)).seal(ByteArray(1), ByteArray(1))
        val a = device("a")
        val b = device("b")
        for (c in listOf(a, b)) {
            c.discover()
            assertTrue(c.cloudConnect.localLinks.localPairing())
            // No account: the LAN service serves local links alone and binds nothing while no link is held.
            c.cloudConnect.start()
        }

        val codes = CopyOnWriteArrayList<LocalCode>()
        val inbound = CopyOnWriteArrayList<ConnectSession>()
        a.cloudConnect.localLinks.onLink { inbound += it }
        b.cloudConnect.localLinks.onLink { inbound += it }
        fun confirm(offer: im.plrs.key.sdk.LocalOffer) {
            scope.launch { offer.confirm() }
        }

        // Mode q: A shows a code, B types it; both people confirm.
        val window = a.cloudConnect.localLinks.pair(
            LocalPairOptions(categories = listOf("docs"), onCode = { codes += it }, onConfirm = ::confirm, label = "A", seconds = 120.0),
        )
        until("the code") { codes.isNotEmpty() }
        val paired = b.cloudConnect.localLinks.join(
            LocalJoinOptions(categories = listOf("docs"), onConfirm = ::confirm, code = codes.last().code, label = "B", browseSeconds = 30.0),
        )
        until("the link on A") { runBlocking { a.cloudConnect.localLinks.list().size } == 1 }
        window.stop()

        val onA = a.cloudConnect.localLinks.list().single()
        val onB = b.cloudConnect.localLinks.list().single()
        assertEquals(paired.id, onB.id)
        assertEquals(listOf("docs"), onA.categories)
        // The HELLO of an Android pairing says android, and the record keeps it.
        assertEquals("android", onA.platform)
        assertEquals("android", onB.platform)

        // The record reads back through a new client over the same sealed file, with the platform.
        val reloaded = device("a")
        val again = reloaded.cloudConnect.localLinks.list().single()
        assertEquals(onA.id, again.id)
        assertEquals("android", again.platform)
        assertEquals(onA.label, again.label)
        assertFalse(File(dir, "a.bin").readBytes().toString(Charsets.ISO_8859_1).contains("pkey.connect.local.v1"))

        // Mode l: the link is advertised (m=l) by both devices; A opens it and B receives the session.
        until("the listeners") { a.cloudConnect.status().lan == "on" && b.cloudConnect.status().lan == "on" }
        // A finds B's m=l advert when NSD reports it: open answers unknown_peer (or busy, after a miss) until then.
        var found: ConnectSession? = null
        until("B's advert", seconds = 60) {
            found = try {
                runBlocking { a.cloudConnect.localLinks.open(onA.id) }
            } catch (e: LanException) {
                if (e.reason != LanErrorReason.unknown_peer && e.reason != LanErrorReason.busy) throw e
                null
            }
            found != null
        }
        val session = found!!
        assertEquals(onA.id, session.local?.id)
        until("the session on B") { inbound.any { it.local?.id == onB.id } }
        assertNotNull(inbound.first { it.local?.id == onB.id })
        session.close()
    }
}
