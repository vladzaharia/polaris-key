// @pkey-feature sync.keyring
//
// `client.keyring` (U-39.8): create, unlock through this device's own wrap, a restart that gets the
// root back offline, the pin (a served ring that differs is never opened), recovery, and forget. A
// scripted Worker keeps the ring the client posts and serves it back, so every wrap, blob and root
// here is the client's own. The corpus rows run in :conformance (SyncVectorsTest, TranscriptTest).

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SyncKeyringTest {
    @get:Rule val tmp = TemporaryFolder()

    private val signer = TestSigner()

    /** A Worker that holds one ring: what is posted is what is served. */
    private class Worker {
        var ring: JsonObject? = null
        var wrap: JsonObject? = null
        var recoveryCt: String? = null
        var by: String = ""

        fun handle(r: PolarisRequest): PolarisResponse {
            val body = r.body?.let { JsonText.parseOrNull(it.toString(Charsets.UTF_8)).objectValue }
            return when {
                r.path.endsWith("/devices/keyring") && r.method == "GET" -> respond(200, state())

                r.path.endsWith("/devices/keyring") && r.method == "POST" -> {
                    if (ring != null) return respond(409, """{"error":{"code":"keyring_conflict","message":"x"}}""")
                    hold(body!!)
                    respond(201, """{"ringId":"${body["ringId"].stringValue}","epoch":1}""")
                }

                r.path.endsWith("/devices/keyring/recovery") && r.method == "GET" ->
                    respond(200, """{"ct":"$recoveryCt","epoch":1,"kid":"${ring!!["rootKid"].stringValue}"}""")

                r.path.contains("/devices/keyring/wraps/") -> {
                    wrap = body
                    respond(204)
                }

                else -> respond(404, """{"error":"not_found"}""")
            }
        }

        private fun hold(body: JsonObject) {
            ring = body
            wrap = body["wrap"].objectValue
            recoveryCt = body["recovery"].objectValue?.get("ct").stringValue
            by = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        }

        fun state(): String {
            val r = ring ?: return """{"ring":null,"wrap":null}"""
            val kid = r["rootKid"].stringValue
            val w = wrap
            val wrapJson = if (w == null) {
                "null"
            } else {
                """{"epoch":1,"kid":"$kid","kem":32,"enc":"${w["enc"].stringValue}","ct":"${w["ct"].stringValue}","by":"$by"}"""
            }
            val recovery = if (recoveryCt != null) """{"set":true,"createdAt":1700000000}""" else """{"set":false}"""
            return """{"ring":{"ringId":"${r["ringId"].stringValue}","epoch":1,"rootKid":"$kid","state":"active","createdAt":1700000000,""" +
                """"recovery":$recovery,"adopted":[],"previous":null},"wrap":$wrapJson}"""
        }
    }

    private class Rig(val client: PolarisKeyClient, val keyring: SyncKeyring)

    private fun rig(worker: Worker, keys: DeviceKeyPort, rootStorage: InMemoryDeviceKeyStorage, dir: java.io.File): Rig = runBlocking {
        val store = FileStore("djdl", dir)
        store.setToken("pkeyt_L7Z_jTR0YsyzhMxHLBdEwKZ4yW2Uu4m6CANM1oHQiUA")
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = store,
                    transport = ScriptedTransport(worker::handle),
                    clock = { 1_700_000_000L },
                ),
                license = LicenseClientOptions(fingerprint = false),
                connect = ConnectOptions(deviceKeys = keys, state = InMemoryDeviceKeyStorage()),
                keyring = KeyringOptions(keys = keys, rootStorage = rootStorage),
            ),
        )
        Rig(client, client.keyring)
    }

    private fun newKeys(): DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage())

    private fun refusal(code: String, block: () -> Unit) {
        try {
            block()
        } catch (e: PolarisException) {
            assertEquals(code, e.code)
            return
        }
        fail("expected $code")
    }

    @Test
    fun createHoldsTheRootAndTheCodecSealsAndOpens() = runBlocking {
        val r = rig(Worker(), newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder())
        assertTrue(r.keyring.codec.locked)
        refusal(ErrorCode.syncLocked) { r.keyring.codec.seal("\$settings", "theme", JsonPrimitive("dark")) }
        val made = r.keyring.create()
        assertTrue(r.keyring.unlocked)
        assertNotNull(made.recoveryCode)
        assertFalse(made.toString().contains(made.recoveryCode!!))
        val env = r.keyring.codec.seal("saves", "slot", JsonPrimitive("secret-value"))
        val opened = r.keyring.codec.open("saves", "slot", env) as SyncEnvelope.Opened.Ok
        assertEquals("slot", opened.name)
        assertFalse(opened.toString().contains("secret-value"))
        assertFalse(r.keyring.codec.toString().contains(r.keyring.codec.kid!!))
        assertFalse(r.keyring.toString().contains(made.ringId))
        assertEquals(made.ringId, r.keyring.pin()!!.ringId)
    }

    @Test
    fun aRestartGetsTheRootBackOfflineAndAFreshStorageUnlocksThroughTheWrap() = runBlocking {
        val worker = Worker()
        val keys = newKeys()
        val dir = tmp.newFolder()
        val roots = InMemoryDeviceKeyStorage()
        val first = rig(worker, keys, roots, dir)
        val made = first.keyring.create()
        val kid = first.keyring.codec.kid
        // A new process: same files, same stored root; status unlocks with no request.
        val second = rig(worker, keys, roots, dir)
        val status = second.keyring.status()
        assertTrue(status.unlocked)
        assertTrue(status.rootStored)
        assertEquals(kid, second.keyring.codec.kid)
        // The stored root is gone (a lost keystore alias): the device's own wrap opens it through dh.
        val third = rig(worker, keys, InMemoryDeviceKeyStorage(), dir)
        assertFalse(third.keyring.unlocked)
        assertEquals(SyncSecond(made.ringId), third.keyring.unlock().let { SyncSecond((it as SyncUnlockResult.Unlocked).ringId) })
        assertEquals(kid, third.keyring.codec.kid)
    }

    private data class SyncSecond(val ringId: String)

    @Test
    fun aServedRingThatIsNotThePinnedOneIsNeverOpened() = runBlocking {
        val worker = Worker()
        val keys = newKeys()
        val dir = tmp.newFolder()
        val a = rig(worker, keys, InMemoryDeviceKeyStorage(), dir)
        a.keyring.create()
        val pinned = a.keyring.pin()!!
        // Another ring appears (a different root, wrapped to the same device).
        val other = Worker()
        val b = rig(other, keys, InMemoryDeviceKeyStorage(), tmp.newFolder())
        b.keyring.create()
        worker.ring = other.ring
        worker.wrap = other.wrap
        val c = rig(worker, keys, InMemoryDeviceKeyStorage(), dir)
        val res = c.keyring.unlock()
        assertTrue(res is SyncUnlockResult.RingChanged)
        assertEquals(pinned, (res as SyncUnlockResult.RingChanged).pinned)
        assertTrue(c.keyring.codec.locked)
        // Confirmed by the person: the new ring is opened and pinned.
        val accepted = c.keyring.acceptRingChange(res.served)
        assertTrue(accepted is SyncUnlockResult.Unlocked)
        assertEquals(res.served, c.keyring.pin())
    }

    @Test
    fun recoverOpensTheRootFromTheCodeAndABadCodeIsRefusedBeforeAnyRequest() = runBlocking {
        val worker = Worker()
        val a = rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder())
        val made = a.keyring.create()
        val kid = a.keyring.codec.kid
        // Another device: its own keys, nothing stored, no wrap.
        worker.wrap = null
        val b = rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder())
        val before = (b.client.keyring.status()).unlocked
        assertFalse(before)
        refusal(ErrorCode.recoveryCodeInvalid) { runBlocking { b.keyring.recover("0000-0000-0000-0000-0000-0000-0000-0000") } }
        val got = b.keyring.recover(made.recoveryCode!!)
        assertEquals(made.ringId, got.ringId)
        assertTrue(got.wrapDeposited)
        assertEquals(kid, b.keyring.codec.kid)
        assertNotNull(worker.wrap)
    }

    @Test
    fun forgetDropsTheRootTheStoredCopyAndThePin() = runBlocking {
        val roots = InMemoryDeviceKeyStorage()
        val dir = tmp.newFolder()
        val r = rig(Worker(), newKeys(), roots, dir)
        r.keyring.create()
        assertNotNull(roots.get())
        assertNotNull(r.keyring.pin())
        r.keyring.forget()
        assertTrue(r.keyring.codec.locked)
        assertNull(roots.get())
        assertNull(r.keyring.pin())
        assertFalse(r.keyring.status().rootStored)
    }

    @Test
    fun theRootIsNeverInAnythingTheStateDirectoryHoldsInTheClear() = runBlocking {
        val dir = tmp.newFolder()
        val r = rig(Worker(), newKeys(), InMemoryDeviceKeyStorage(), dir)
        r.keyring.create()
        // The pin file holds no secret; the root is not in it.
        val pin = java.io.File(dir, SYNC_PIN_FILE).readText()
        assertTrue(pin.contains("ringId"))
        assertFalse(pin.contains("\"root\""))
    }
}
