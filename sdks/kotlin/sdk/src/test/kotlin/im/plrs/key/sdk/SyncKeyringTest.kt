// @pkey-feature sync.keyring
//
// `client.keyring` (U-39.8): create, unlock through this device's own wrap, a restart that gets the
// root back offline, the pin (a served ring that differs is never opened), recovery, and forget. A
// scripted Worker keeps the ring the client posts and serves it back, so every wrap, blob and root
// here is the client's own. The corpus rows run in :conformance (SyncVectorsTest, TranscriptTest).

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.DeviceKeysUnreadableException
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.Store
import im.plrs.key.core.StoreException
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
import org.junit.Assert.assertArrayEquals
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
        val seen = mutableListOf<String>()

        fun handle(r: PolarisRequest): PolarisResponse {
            seen += "${r.method} ${r.path}"
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

    private fun rig(
        worker: Worker,
        keys: DeviceKeyPort,
        rootStorage: DeviceKeyStorage?,
        dir: java.io.File,
        store: Store = FileStore("djdl", dir),
    ): Rig = runBlocking {
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

    // -- K1-D1: with no pin, a stored root is the pin ---------------------------------------------

    /** A root storage whose reads or removals fail on demand; everything else is the wrapped storage. */
    private class FaultyRoots(val inner: InMemoryDeviceKeyStorage) : DeviceKeyStorage by inner {
        var getFault: Exception? = null
        var clearFault: Exception? = null

        override suspend fun get(): ByteArray? = getFault?.let { throw it } ?: inner.get()

        override suspend fun clear() {
            clearFault?.let { throw it }
            inner.clear()
        }
    }

    private class Held(val worker: Worker, val keys: DeviceKeyPort, val dir: java.io.File, val roots: InMemoryDeviceKeyStorage, val first: Rig) {
        val pinFile get() = java.io.File(dir, SYNC_PIN_FILE)
    }

    /** A client that made its ring, then a Worker that serves another ring wrapped to the same device. */
    private fun heldThenReplaced(): Pair<Held, SyncCreatedRing> = runBlocking {
        val worker = Worker()
        val keys = newKeys()
        val dir = tmp.newFolder()
        val roots = InMemoryDeviceKeyStorage()
        val first = rig(worker, keys, roots, dir)
        first.keyring.create()
        val other = Worker()
        val o = rig(other, keys, InMemoryDeviceKeyStorage(), tmp.newFolder())
        val made = o.keyring.create()
        worker.ring = other.ring
        worker.wrap = other.wrap
        worker.recoveryCt = other.recoveryCt
        Held(worker, keys, dir, roots, first) to made
    }

    private fun setPinFile(h: Held, text: String) {
        h.pinFile.writeText(text)
        java.nio.file.Files.setPosixFilePermissions(h.pinFile.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"))
    }

    private suspend fun assertRefusedAgainstTheStoredRoot(h: Held, c: Rig, stored: SyncRingPin, rootBefore: ByteArray) {
        val res = c.keyring.unlock()
        assertTrue(res.toString(), res is SyncUnlockResult.RingChanged)
        assertEquals(stored, (res as SyncUnlockResult.RingChanged).pinned)
        assertTrue(c.keyring.codec.locked)
        assertArrayEquals(rootBefore, h.roots.get())
    }

    @Test
    fun aStoredRootIsThePinWhenThePinFileIsLost() = runBlocking {
        // 1. The pin file is deleted.
        val (a, _) = heldThenReplaced()
        val stored = a.first.keyring.pin()!!
        val rootBefore = a.roots.get()!!
        assertTrue(a.pinFile.delete())
        assertRefusedAgainstTheStoredRoot(a, rig(a.worker, a.keys, a.roots, a.dir), stored, rootBefore)
        assertFalse(a.pinFile.exists())
        // 2. The pin file does not parse.
        val (b, _) = heldThenReplaced()
        val rootB = b.roots.get()!!
        setPinFile(b, "{")
        assertRefusedAgainstTheStoredRoot(b, rig(b.worker, b.keys, b.roots, b.dir), b.first.keyring.pin()!!, rootB)
        assertEquals("{", b.pinFile.readText())
        // 3. The pin file names another product.
        val (c, _) = heldThenReplaced()
        val rootC = c.roots.get()!!
        setPinFile(c, c.pinFile.readText().replace("djdl", "other"))
        val pinC = c.first.keyring.pin()!!
        assertRefusedAgainstTheStoredRoot(c, rig(c.worker, c.keys, c.roots, c.dir), pinC, rootC)
        assertTrue(c.pinFile.readText().contains("other"))
        // 4. No state directory (a memory pin) beside a durable root storage, across a restart.
        val worker = Worker()
        val keys = newKeys()
        val roots = InMemoryDeviceKeyStorage()
        val d1 = rig(worker, keys, roots, tmp.newFolder(), InMemoryStore("djdl"))
        d1.keyring.create()
        val pinD = d1.keyring.pin()!!
        val other = Worker()
        val o = rig(other, keys, InMemoryDeviceKeyStorage(), tmp.newFolder())
        o.keyring.create()
        worker.ring = other.ring
        worker.wrap = other.wrap
        val rootD = roots.get()!!
        val d2 = rig(worker, keys, roots, tmp.newFolder(), InMemoryStore("djdl"))
        val res = d2.keyring.unlock()
        assertEquals(pinD, (res as SyncUnlockResult.RingChanged).pinned)
        assertTrue(d2.keyring.codec.locked)
        assertNull(d2.keyring.pin())
        assertArrayEquals(rootD, roots.get())
    }

    @Test
    fun aMatchingStoredRootIsHeldAndRepinned() = runBlocking {
        val worker = Worker()
        val keys = newKeys()
        val dir = tmp.newFolder()
        val roots = InMemoryDeviceKeyStorage()
        val first = rig(worker, keys, roots, dir)
        first.keyring.create()
        val pin = first.keyring.pin()!!
        assertTrue(java.io.File(dir, SYNC_PIN_FILE).delete())
        val second = rig(worker, keys, roots, dir)
        assertTrue(second.keyring.unlock() is SyncUnlockResult.Unlocked)
        assertTrue(second.keyring.unlocked)
        assertEquals(pin, second.keyring.pin())
        assertTrue(java.io.File(dir, SYNC_PIN_FILE).exists())
    }

    @Test
    fun aStoredRootIsReplacedOnlyByAConfirmedAcceptOrTheRecoveryCode() = runBlocking {
        val (a, made) = heldThenReplaced()
        val before = a.roots.get()!!
        assertTrue(a.pinFile.delete())
        val c = rig(a.worker, a.keys, a.roots, a.dir)
        val res = c.keyring.unlock() as SyncUnlockResult.RingChanged
        assertArrayEquals(before, a.roots.get())
        // A confirmed accept names the ring that was shown.
        val accepted = c.keyring.acceptRingChange(res.served)
        assertTrue(accepted is SyncUnlockResult.Unlocked)
        assertEquals(res.served, c.keyring.pin())
        assertFalse(before.contentEquals(a.roots.get()))
        // The recovery code replaces it too.
        val (b, madeB) = heldThenReplaced()
        val beforeB = b.roots.get()!!
        assertTrue(b.pinFile.delete())
        val d = rig(b.worker, b.keys, b.roots, b.dir)
        assertTrue(d.keyring.unlock() is SyncUnlockResult.RingChanged)
        assertArrayEquals(beforeB, b.roots.get())
        assertEquals(madeB.ringId, d.keyring.recover(madeB.recoveryCode!!).ringId)
        assertFalse(beforeB.contentEquals(b.roots.get()))
        assertEquals(made.ringId, a.worker.ring!!["ringId"].stringValue)
    }

    @Test
    fun aStoredRootThatCannotBeReadIsNotAbsent() = runBlocking {
        val (h, made) = heldThenReplaced()
        val faulty = FaultyRoots(h.roots)
        assertTrue(h.pinFile.delete())
        val c = rig(h.worker, h.keys, faulty, h.dir)
        val before = h.roots.get()!!
        // A storage fault.
        faulty.getFault = StoreException("disk")
        refusal(ErrorCode.storeFailed) { runBlocking { c.keyring.unlock() } }
        // A record that cannot be opened, and one that does not decode.
        faulty.getFault = DeviceKeysUnreadableException("sealed")
        refusal(ErrorCode.deviceKeysUnreadable) { runBlocking { c.keyring.unlock() } }
        faulty.getFault = null
        h.roots.put("not a record".toByteArray())
        refusal(ErrorCode.deviceKeysUnreadable) { runBlocking { c.keyring.unlock() } }
        assertFalse(h.pinFile.exists())
        assertTrue(c.keyring.codec.locked)
        h.roots.put(before)
        // The person's confirmation and the recovery code still work while the read faults.
        faulty.getFault = StoreException("disk")
        val res = rig(h.worker, h.keys, h.roots, h.dir).keyring.unlock() as SyncUnlockResult.RingChanged
        assertTrue(c.keyring.acceptRingChange(res.served) is SyncUnlockResult.Unlocked)
        assertTrue(h.pinFile.exists())
        c.keyring.forget()
        faulty.getFault = StoreException("disk")
        assertEquals(made.ringId, c.keyring.recover(made.recoveryCode!!).ringId)
    }

    @Test
    fun anUnreadablePinIsNotAbsent() = runBlocking {
        val (h, _) = heldThenReplaced()
        val rootBefore = h.roots.get()!!
        // No wrap is served, so only a pin read that fails can end the unlock before it reads as locked.
        h.worker.wrap = null
        // A pin file that others can read is refused, not read as absent.
        java.nio.file.Files.setPosixFilePermissions(h.pinFile.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"))
        refusal(ErrorCode.storeFailed) { runBlocking { rig(h.worker, h.keys, h.roots, h.dir).keyring.unlock() } }
        // A pin file that is a symbolic link is refused too.
        val real = java.io.File(h.dir, "elsewhere")
        h.pinFile.copyTo(real)
        assertTrue(h.pinFile.delete())
        java.nio.file.Files.createSymbolicLink(h.pinFile.toPath(), real.toPath())
        refusal(ErrorCode.storeFailed) { runBlocking { rig(h.worker, h.keys, h.roots, h.dir).keyring.unlock() } }
        assertArrayEquals(rootBefore, h.roots.get())
    }

    @Test
    fun forgetKeepsThePinWhenTheRootCannotBeRemoved() = runBlocking {
        val roots = FaultyRoots(InMemoryDeviceKeyStorage())
        val dir = tmp.newFolder()
        val r = rig(Worker(), newKeys(), roots, dir)
        r.keyring.create()
        val pin = r.keyring.pin()!!
        roots.clearFault = StoreException("busy")
        refusal(ErrorCode.storeFailed) { runBlocking { r.keyring.forget() } }
        assertEquals(pin, r.keyring.pin())
        assertTrue(java.io.File(dir, SYNC_PIN_FILE).exists())
        assertNotNull(roots.inner.get())
        roots.clearFault = null
        r.keyring.forget()
        assertNull(r.keyring.pin())
        assertNull(roots.inner.get())
    }

    // -- Deactivation releases the key ring --------------------------------------------------------

    @Test
    fun deactivationForgetsTheKeyRing() = runBlocking {
        for (viaRoster in listOf(false, true)) {
            val worker = Worker()
            val keys = newKeys()
            val dir = tmp.newFolder()
            val roots = InMemoryDeviceKeyStorage()
            val r = rig(worker, keys, roots, dir)
            r.keyring.create()
            assertTrue(r.keyring.unlocked)
            assertNotNull(roots.get())
            assertTrue(java.io.File(dir, SYNC_PIN_FILE).exists())
            if (viaRoster) r.client.deauthorizeDevice(r.client.core.deviceId()) else r.client.license.deactivate()
            assertFalse(r.keyring.unlocked)
            assertNull(roots.get())
            assertFalse(java.io.File(dir, SYNC_PIN_FILE).exists())
            val again = rig(worker, keys, roots, dir).keyring.status()
            assertFalse(again.unlocked)
            assertFalse(again.rootStored)
            assertNull(again.pinned)
        }
    }

    @Test
    fun deactivationStopsWhenTheRootCannotBeRemoved() = runBlocking {
        val worker = Worker()
        val roots = FaultyRoots(InMemoryDeviceKeyStorage())
        val dir = tmp.newFolder()
        val r = rig(worker, newKeys(), roots, dir)
        r.keyring.create()
        worker.seen.clear()
        roots.clearFault = StoreException("busy")
        refusal(ErrorCode.storeFailed) { runBlocking { r.client.license.deactivate() } }
        assertNotNull(r.client.core.token())
        assertTrue("no request was sent: ${worker.seen}", worker.seen.isEmpty())
        assertNotNull(r.keyring.pin())
        // Once the root can be removed, a retry completes.
        roots.clearFault = null
        r.client.license.deactivate()
        assertNull(r.client.core.token())
        assertNull(roots.inner.get())
    }

    @Test
    fun probingForAHeldRootCreatesNoFileOrLock() = runBlocking {
        val base = tmp.newFolder()
        val rootDir = java.io.File(base, "absent/pkey/djdl")
        val storage = FileDeviceKeyStorage(java.io.File(rootDir, "sync-root.bin"))
        val r = rig(Worker(), newKeys(), storage, tmp.newFolder())
        assertFalse(r.keyring.holdsState())
        assertFalse("no directory is created", rootDir.exists())
        assertFalse("no directory is created", java.io.File(base, "absent").exists())
        // A directory with no root file: still nothing created.
        rootDir.mkdirs()
        assertFalse(r.keyring.holdsState())
        assertEquals(emptyList<String>(), rootDir.list()!!.toList())
        // A directory that cannot be listed might hold one: the caller forgets rather than skips.
        val locked = rootDir.setExecutable(false) && rootDir.setReadable(false)
        try {
            if (locked && rootDir.list() == null) assertTrue(r.keyring.holdsState())
        } finally {
            rootDir.setReadable(true)
            rootDir.setExecutable(true)
        }
    }

    /** A root storage that counts writes and removals. */
    private class WatchedRoots(val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        var writes = 0

        override suspend fun put(bytes: ByteArray) {
            writes++
            inner.put(bytes)
        }

        override suspend fun putIfAbsent(bytes: ByteArray): Boolean {
            writes++
            return inner.putIfAbsent(bytes)
        }

        override suspend fun clear() {
            writes++
            inner.clear()
        }

        override suspend fun deleteRecord() {
            writes++
            inner.deleteRecord()
        }
    }

    @Test
    fun deactivationWithNoKeyRingStateLeavesItsStorageUntouched() = runBlocking {
        val dir = tmp.newFolder()
        val r = rig(Worker(), newKeys(), null, dir)
        r.client.license.deactivate()
        assertNull(r.client.core.token())
        assertEquals(emptyList<String>(), dir.list()!!.filter { it.contains("sync") })
        // A host root storage that holds nothing is not written or cleared either.
        val watched = WatchedRoots()
        val other = tmp.newFolder()
        val w = rig(Worker(), newKeys(), watched, other)
        w.client.license.deactivate()
        assertEquals(0, watched.writes)
        assertEquals(emptyList<String>(), other.list()!!.filter { it.contains("sync") })
    }
}
