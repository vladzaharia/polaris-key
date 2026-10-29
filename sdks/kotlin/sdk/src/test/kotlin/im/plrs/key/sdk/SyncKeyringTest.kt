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
import im.plrs.key.core.InMemoryPlatformBackupStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.UnavailablePlatformBackupStore
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

                r.path.endsWith("/devices/keyring/reset") && r.method == "POST" -> {
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

    /** The platform backup a rig's keyring gets, and the person signed in on it. */
    private class Backup(val store: PlatformBackupStore?, val subject: String, val enabled: Boolean = true)

    private class Rig(val client: PolarisKeyClient, val keyring: SyncKeyring)

    private fun rig(worker: Worker, keys: DeviceKeyPort, rootStorage: InMemoryDeviceKeyStorage, dir: java.io.File, backup: Backup? = null): Rig =
        runBlocking {
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
                    keyring = KeyringOptions(keys = keys, rootStorage = rootStorage, backup = backup?.store, keyBackup = backup?.enabled ?: true),
                ),
            )
            if (backup != null) client.core.setSubject(backup.subject)
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

    // -- The platform backup of the root (U-39.10) ----------------------------------------------

    private val alice = "ps_" + "a".repeat(32)
    private val bob = "ps_" + "b".repeat(32)
    private val syncKey = PlatformBackupStore.syncKey("djdl")

    private fun entry(store: PlatformBackupStore): JsonObject? = runBlocking {
        (store.get(syncKey) as? PlatformBackupRead.Found)?.let { JsonText.parseOrNull(it.bytes.toString(Charsets.UTF_8)).objectValue }
    }

    /** A second device of the same person: its own keys, no stored root, and no wrap on the Worker. */
    private fun newDevice(worker: Worker, backup: PlatformBackupStore?, subject: String = alice): Rig {
        worker.wrap = null
        return rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, subject))
    }

    @Test
    fun createSavesOneEntryPerProductWithTheSubjectAndTheRingId() = runBlocking {
        val backup = InMemoryPlatformBackupStore(cloud = true)
        val r = rig(Worker(), newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice))
        val made = r.keyring.create()
        val e = entry(backup)!!
        assertEquals(alice, e["subject"].stringValue)
        assertEquals(made.ringId, e["ringId"].stringValue)
        assertEquals(made.rootKid, e["kid"].stringValue)
        assertNotNull(e["root"].stringValue)
        // Unlocking again overwrites the same key: still one entry per product.
        r.keyring.lock()
        r.keyring.unlock()
        assertEquals(made.ringId, entry(backup)!!["ringId"].stringValue)
        assertTrue(backup.get(PlatformBackupStore.restoreKey("djdl")) is PlatformBackupRead.Missing)
    }

    @Test
    fun aNewDeviceOpensTheRingFromTheBackupBeforeTheRecoveryCodeIsAsked() = runBlocking {
        val worker = Worker()
        val backup = InMemoryPlatformBackupStore(cloud = true)
        val a = rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice))
        val made = a.keyring.create()
        val b = newDevice(worker, backup)
        assertEquals(SyncUnlockResult.Unlocked(made.ringId, 1), b.keyring.unlock())
        assertEquals(a.keyring.codec.kid, b.keyring.codec.kid)
        assertNotNull("the device deposits its own wrap, so the next start needs no backup", worker.wrap)
        assertTrue(b.keyring.status().rootStored)
        assertEquals(made.ringId, b.keyring.pin()!!.ringId)
    }

    @Test
    fun aDeviceWithNoBackupOrAnUnavailableOneStaysLockedAndFallsThroughToTheCode() = runBlocking {
        val worker = Worker()
        val backup = InMemoryPlatformBackupStore()
        rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice)).keyring.create()
        val none = newDevice(worker, null)
        assertEquals(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap), none.keyring.unlock())
        val gone = newDevice(worker, UnavailablePlatformBackupStore("outlet"))
        assertEquals(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap), gone.keyring.unlock())
        val off = newDevice(worker, backup, alice)
        assertTrue(off.keyring.unlock() is SyncUnlockResult.Unlocked)
        worker.wrap = null
        val off2 = Backup(backup, alice, enabled = false)
        val optedOut = rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), off2)
        assertEquals(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap), optedOut.keyring.unlock())
    }

    @Test
    fun anEntryOfAnotherPersonOrAnotherRingIsIgnoredAndLeftWhereItIs() = runBlocking {
        val worker = Worker()
        val backup = InMemoryPlatformBackupStore()
        rig(worker, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice)).keyring.create()
        val before = entry(backup).toString()
        val other = newDevice(worker, backup, bob)
        assertEquals(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap), other.keyring.unlock())
        // The Worker now serves another ring: the old entry opens nothing.
        val second = Worker()
        rig(second, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(null, alice)).keyring.create()
        val moved = newDevice(second, backup)
        assertEquals(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap), moved.keyring.unlock())
        assertEquals(before, entry(backup).toString())
    }

    @Test
    fun signOutKeepsTheEntryAndOnlyRemoveBackupAndResetChangeIt() = runBlocking {
        val backup = InMemoryPlatformBackupStore(cloud = true)
        val r = rig(Worker(), newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice))
        val made = r.keyring.create()
        r.keyring.forget()
        assertEquals(made.ringId, entry(backup)!!["ringId"].stringValue)
        // Reset replaces it with the new ring (same key); the old root is gone from the backup.
        val fresh = rig(Worker().also { it.ring = null }, newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice))
        val reset = fresh.keyring.reset()
        assertEquals(reset.ringId, entry(backup)!!["ringId"].stringValue)
        assertTrue(fresh.keyring.removeBackup())
        assertNull(entry(backup))
        assertTrue(fresh.keyring.unlocked)
    }

    @Test
    fun aRootHeldBeforeTheBackupExistedIsSavedAtTheNextUnlock() = runBlocking {
        val worker = Worker()
        val keys = newKeys()
        val dir = tmp.newFolder()
        val roots = InMemoryDeviceKeyStorage()
        rig(worker, keys, roots, dir, Backup(null, alice)).keyring.create()
        val backup = InMemoryPlatformBackupStore()
        val again = rig(worker, keys, roots, dir, Backup(backup, alice))
        assertTrue(again.keyring.unlock() is SyncUnlockResult.Unlocked)
        assertNotNull(entry(backup))
    }

    @Test
    fun aWriteTheOsRefusesLeavesNoOlderEntryAndTheRingStillWorks() = runBlocking {
        val gone = UnavailablePlatformBackupStore("no-play-services")
        val r = rig(Worker(), newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(gone, alice))
        r.keyring.create()
        assertTrue(r.keyring.unlocked)
        assertTrue(!r.keyring.removeBackup())
        assertTrue(gone.set(syncKey, ByteArray(1)) is PlatformBackupWrite.Unavailable)
    }

    @Test
    fun theBackupEntryAndItsRecordNeverPrintTheRoot() = runBlocking {
        val backup = InMemoryPlatformBackupStore()
        val r = rig(Worker(), newKeys(), InMemoryDeviceKeyStorage(), tmp.newFolder(), Backup(backup, alice))
        r.keyring.create()
        val read = backup.get(syncKey)
        assertFalse(read.toString().contains(entry(backup)!!["root"].stringValue!!))
        assertEquals("SyncBackupRecord(redacted)", SyncBackupRecord.parse((read as PlatformBackupRead.Found).bytes).toString())
    }
}
