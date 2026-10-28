// Mirrors packages/client-core/test/deviceKeys.test.ts for the Kotlin device key store (CC-26.5):
// generation, rotate, wipe, low-order refusal, the file store's permissions, and the proof signer.
package im.plrs.key.core

import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DeviceKeysTest {
    @get:Rule val tmp = TemporaryFolder()

    private val device = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val now = 1_700_000_000L
    private val backends = listOf<DeviceCurves>(JcaDeviceCurves, TinkDeviceCurves)

    private fun mem(c: DeviceCurves) = DeviceKeyStore(InMemoryDeviceKeyStorage(), { c })
    private fun file(c: DeviceCurves, f: File = File(tmp.root, "keys/device-keys.json"), s: DeviceKeySealer? = null) =
        DeviceKeyStore(FileDeviceKeyStorage(f, s), { c })

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            if (e is T) return
            throw e
        }
        fail("expected ${T::class.simpleName}")
    }

    @Test
    fun theBackendsPassTheirKnownAnswers() {
        for (c in backends) assertTrue(c.name, DeviceCurvesSelection.knownAnswer(c))
        assertFalse(DeviceCurvesSelection.knownAnswer(UnavailableDeviceCurves))
        assertEquals("unavailable", DeviceCurvesSelection.select(listOf(UnavailableDeviceCurves)).name)
    }

    @Test
    fun makesOnePairOnFirstNeedAndKeepsIt() = runBlocking {
        for (c in backends) {
            val s = mem(c)
            assertNull(s.publicKeys())
            val (a, b) = listOf(async { s.ensure() }, async { s.ensure() }).awaitAll()
            assertEquals(a, b)
            assertEquals(1, a.generation)
            assertEquals(43, a.signKey.length)
            assertEquals(32, Base64Url.decodeStrict(a.agreeKey)!!.size)
            assertEquals(a, s.ensure())
            assertEquals(a, s.publicKeys())
        }
    }

    @Test
    fun signsWhatTheStrictVerifierAcceptsAndNoMemberReturnsAPrivateHalf() = runBlocking {
        for (c in backends) {
            val s = mem(c)
            val k = s.ensure()
            val msg = "hello".toByteArray()
            val sig = s.sign(msg)
            assertEquals(64, sig.size)
            val pub = Base64Url.decodeStrict(k.signKey)!!
            assertTrue(Ed25519Strict.prechecks(pub, sig))
            assertTrue(JcaEd25519Verifier.verify(pub, msg, sig))
            assertTrue(TinkEd25519Verifier.verify(pub, msg, sig))
            assertFalse(JcaEd25519Verifier.verify(pub, "hellp".toByteArray(), sig))
            val members = DeviceKeyPort::class.java.methods.map { it.name }.toSet()
            assertTrue(members.none { it.contains("private", true) || it.contains("seed", true) })
        }
    }

    @Test
    fun refusesToSignBeforeEnsure() {
        assertThrows<IllegalStateException> { runBlocking { mem(JcaDeviceCurves).sign(ByteArray(1)) } }
    }

    @Test
    fun derivesTheSameSecretAsThePeerAndRefusesLowOrderPeers() = runBlocking {
        for (c in backends) {
            val other = backends.first { it !== c }
            val s = mem(c)
            val k = s.ensure()
            val peerPriv = DeviceCurvesSelection.randomBytes(32)
            val peerPub = other.x25519(peerPriv, X25519Points.BASE)!!
            val mine = s.dh(peerPub)
            assertNotNull(mine)
            // The peer, on the other backend, agrees.
            assertArrayEquals(mine, other.x25519(peerPriv, Base64Url.decodeStrict(k.agreeKey)!!))
            assertNull(s.dh(ByteArray(32)))
            assertNull(s.dh(ByteArray(32).also { it[0] = 1 }))
            // The other low-order encodings, a high-bit spelling of zero, and a wrong length.
            for (hex in listOf(
                "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
                "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
                "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
            )) {
                assertNull(hex, s.dh(ByteArray(32) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }))
            }
            assertNull(s.dh(ByteArray(32).also { it[31] = 0x80.toByte() }))
            assertNull(s.dh(ByteArray(31)))
            assertNull(mem(c).dh(peerPub)) // no keys yet
        }
    }

    @Test
    fun rotatesToANewPairAndWipes() = runBlocking {
        for (c in backends) {
            val s = file(c)
            val a = s.ensure()
            val b = s.rotate()
            assertEquals(2, b.generation)
            assertNotEquals(a.signKey, b.signKey)
            assertNotEquals(a.agreeKey, b.agreeKey)
            assertEquals(b, s.ensure())
            s.wipe()
            assertNull(s.publicKeys())
            val d = s.ensure()
            assertEquals(1, d.generation)
            assertNotEquals(b.signKey, d.signKey)
            s.wipe()
        }
    }

    @Test
    fun rotateBeforeEnsureStartsAtOne() = runBlocking {
        assertEquals(1, mem(JcaDeviceCurves).rotate().generation)
    }

    @Test
    fun anUnreadableRecordIsAnErrorNeverReplacedUntilWipe() = runBlocking {
        val f = File(tmp.root, "bad/device-keys.json")
        val s = file(JcaDeviceCurves, f)
        val a = s.ensure()
        f.writeText("""{"v":1,"generation":1}""")
        val garbage = f.readBytes()
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.publicKeys() } }
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.ensure() } }
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.rotate() } }
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.sign(ByteArray(1)) } }
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.dh(DeviceCurvesSelection.randomBytes(32)) } }
        assertThrows<DeviceKeysUnreadableException> { runBlocking { DeviceProofs.signKeysProof(s, "djdl", device, now) } }
        assertArrayEquals(garbage, f.readBytes()) // survives every call
        s.wipe()
        assertNull(s.publicKeys())
        val b = s.ensure()
        assertEquals(1, b.generation)
        assertNotEquals(a.signKey, b.signKey)
    }

    @Test
    fun aMismatchedRecordIsAnErrorAndSurvives() = runBlocking {
        val storage = InMemoryDeviceKeyStorage()
        val s = DeviceKeyStore(storage)
        val k = s.ensure()
        val other = mem(JcaDeviceCurves).ensure()
        val bad = String(storage.get()!!).replace(k.signKey, other.signKey).toByteArray()
        storage.put(bad)
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.ensure() } }
        assertThrows<DeviceKeysUnreadableException> { runBlocking { s.rotate() } }
        assertArrayEquals(bad, storage.get())
    }

    @Test
    fun aTransientSealerFaultKeepsTheIdentity() = runBlocking {
        val f = File(tmp.root, "flaky/device-keys.json")
        val good = XorSealer()
        val a = file(JcaDeviceCurves, f, good).ensure()
        val before = f.readBytes()
        val flaky = object : DeviceKeySealer by good {
            override fun open(blob: ByteArray, context: ByteArray): ByteArray? = throw StoreException("keystore busy")
        }
        assertThrows<StoreException> { runBlocking { file(JcaDeviceCurves, f, flaky).ensure() } }
        assertThrows<StoreException> { runBlocking { file(JcaDeviceCurves, f, flaky).rotate() } }
        assertArrayEquals(before, f.readBytes())
        assertEquals(a, file(JcaDeviceCurves, f, good).publicKeys())
    }

    @Test
    fun twoStoresOverOneFileAgree() = runBlocking {
        val f = File(tmp.root, "shared/device-keys.json")
        val (a, b) = listOf(async { file(JcaDeviceCurves, f).ensure() }, async { file(TinkDeviceCurves, f).ensure() }).awaitAll()
        assertEquals(a, b)
        assertEquals(a, file(JcaDeviceCurves, f).publicKeys())
    }

    @Test
    fun theFileStoreKeepsKeysAcrossInstancesAndIsOwnerOnly() = runBlocking {
        val f = File(tmp.root, "state/device-keys.json")
        val a = file(JcaDeviceCurves, f).ensure()
        assertEquals(a, file(JcaDeviceCurves, f).publicKeys())
        assertEquals(DeviceKeyPersistence.durable, file(JcaDeviceCurves, f).persistence())
        if ("posix" in java.nio.file.FileSystems.getDefault().supportedFileAttributeViews()) {
            assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(f.toPath())))
            assertEquals("rwx------", PosixFilePermissions.toString(Files.getPosixFilePermissions(f.parentFile.toPath())))
            assertTrue(f.parentFile.listFiles()!!.none { it.name.endsWith(".tmp") })
        }
    }

    @Test
    fun wipeReallyDeletesTheFileAndItsTempFiles() = runBlocking {
        val f = File(tmp.root, "state/device-keys.json")
        val s = file(JcaDeviceCurves, f)
        s.ensure()
        val stray = File(f.parentFile, ".device-keys.json.stray.tmp").also { it.writeText("x") }
        assertTrue(f.exists())
        s.wipe()
        assertFalse(f.exists())
        assertFalse(stray.exists())
        assertNull(s.publicKeys())
        s.wipe() // wiping nothing is fine
    }

    @Test
    fun theFileStoreRefusesASymlink() = runBlocking {
        val target = File(tmp.root, "elsewhere.json").also { it.writeText("{}") }
        val dir = File(tmp.root, "linked").also { it.mkdirs() }
        val f = File(dir, "device-keys.json")
        try {
            Files.createSymbolicLink(f.toPath(), target.toPath())
        } catch (e: Exception) {
            return@runBlocking // no symlinks here
        }
        assertThrows<StoreException> { runBlocking { file(JcaDeviceCurves, f).ensure() } }
        assertEquals("{}", target.readText())
    }

    @Test
    fun aSealedFileHoldsNoPlaintextKeyAndIsBoundToItsContext() = runBlocking {
        val sealer = XorSealer()
        val f = File(tmp.root, "sealed/device-keys.json")
        val s = file(JcaDeviceCurves, f, sealer)
        val k = s.ensure()
        val onDisk = String(f.readBytes(), Charsets.ISO_8859_1)
        assertFalse(onDisk.contains("seed"))
        assertFalse(onDisk.contains(k.signKey))
        assertEquals(k, file(JcaDeviceCurves, f, sealer).publicKeys())
        // A sealer that can no longer open the file (its key was destroyed) is an error, not a reset; wipe clears it.
        sealer.destroy()
        val fresh = XorSealer()
        val again = file(JcaDeviceCurves, f, fresh)
        assertThrows<DeviceKeysUnreadableException> { runBlocking { again.ensure() } }
        again.wipe()
        assertNotEquals(k.signKey, again.ensure().signKey)
        // wipe destroys the wrapping key.
        again.wipe()
        assertTrue(fresh.destroyed)
    }

    /** A toy sealer: it flips every byte, and refuses a blob once destroyed or under another key. */
    private class XorSealer : DeviceKeySealer {
        var destroyed = false
        private val id = java.util.UUID.randomUUID().toString().toByteArray()
        override fun seal(plain: ByteArray, context: ByteArray) = id + plain.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        override fun open(blob: ByteArray, context: ByteArray): ByteArray? {
            if (destroyed || blob.size < id.size || !blob.copyOfRange(0, id.size).contentEquals(id)) return null
            return blob.copyOfRange(id.size, blob.size).map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        }
        override fun destroy() { destroyed = true }
    }

    // ── the proof signer ────────────────────────────────────────────────────────────────────────

    @Test
    fun signsEveryPurposeAndTheVerifierAcceptsItOnBothBackends() = runBlocking {
        for (c in backends) {
            val s = mem(c)
            for (p in DeviceProofPurpose.entries.filter { it != DeviceProofPurpose.keys }) {
                val proof = DeviceProofs.sign(s, p, "djdl", device, "v-${p.wire}", "Zm9v", verifier = Ed25519.verifier)
                assertTrue(DeviceProofs.verify(proof, verifier = JcaEd25519Verifier))
                assertTrue(DeviceProofs.verify(proof, verifier = TinkEd25519Verifier))
                assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(purpose = "keys")), now))
                assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(product = "other"))))
                assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(deviceId = device.replace("A", "B")))))
                assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(tokenHash = "-"))))
            }
        }
    }

    @Test
    fun signsTheExactMessageBytes() = runBlocking {
        val inner = mem(JcaDeviceCurves)
        val seen = mutableListOf<ByteArray>()
        val spy = object : DeviceKeyPort by inner {
            override suspend fun sign(message: ByteArray): ByteArray = inner.sign(message).also { seen.add(message) }
        }
        DeviceProofs.sign(spy, DeviceProofPurpose.link, "djdl", device, "abc")
        assertEquals(1, seen.size)
        assertEquals("pkey-proof/1\nlink\ndjdl\n$device\nabc\n-", String(seen[0], Charsets.US_ASCII))
    }

    @Test
    fun refusesAFieldThatBreaksTheLineFormat() = runBlocking {
        val s = mem(JcaDeviceCurves)
        for (bad in listOf("a\nb", "", "a b", "é")) {
            assertThrows<DeviceProofException> { runBlocking { DeviceProofs.sign(s, DeviceProofPurpose.nonce, "djdl", device, bad) } }
        }
    }

    @Test
    fun signRefusesKeysAndKeysRefusesABadProduct() {
        val s = mem(JcaDeviceCurves)
        assertThrows<DeviceProofException> { runBlocking { DeviceProofs.sign(s, DeviceProofPurpose.keys, "djdl", device, "x") } }
        for (p in listOf("Djdl", "", "a\nb", "-x", "x".repeat(65))) {
            assertThrows<DeviceProofException> { runBlocking { DeviceProofs.signKeysProof(s, p, device, now) } }
        }
    }

    @Test
    fun refusesWhenTheKeysChangeWhileSigning() {
        val inner = mem(JcaDeviceCurves)
        val racy = object : DeviceKeyPort by inner {
            override suspend fun sign(message: ByteArray): ByteArray = inner.sign(message).also { inner.rotate() }
        }
        assertThrows<DeviceProofException> { runBlocking { DeviceProofs.sign(racy, DeviceProofPurpose.nonce, "djdl", device, "x") } }
    }

    @Test
    fun refusesAPortWhoseSignatureDoesNotVerify() {
        val inner = mem(JcaDeviceCurves)
        val liar = object : DeviceKeyPort by inner {
            override suspend fun sign(message: ByteArray): ByteArray = ByteArray(64)
        }
        assertThrows<DeviceProofException> { runBlocking { DeviceProofs.sign(liar, DeviceProofPurpose.nonce, "djdl", device, "x") } }
    }

    @Test
    fun buildsTheKeysProofAndThePutBodyTheWorkerChecks() = runBlocking {
        val s = mem(JcaDeviceCurves)
        val k = s.ensure()
        val (path, body) = DeviceProofs.buildDeviceKeysRequest(s, "djdl", device, now, allowEphemeral = true)
        assertEquals("/djdl/devices/keys", path)
        assertEquals(k.signKey, body.signKey)
        assertEquals(k.agreeKey, body.agreeKey)
        assertEquals(now, body.issuedAt)
        val proof = DeviceProof(
            DeviceProofFields("keys", "djdl", device, DeviceProofs.keysValue(body.signKey, body.agreeKey, body.issuedAt)),
            body.signKey,
            body.sig,
        )
        assertTrue(DeviceProofs.verify(proof, now))
        assertTrue(DeviceProofs.verify(proof, now + 300))
        assertFalse(DeviceProofs.verify(proof, now + 301))
        assertFalse(DeviceProofs.verify(proof, null))
        assertEquals(64, Base64Url.decodeStrict(body.sig)!!.size)
    }

    @Test
    fun keysProofForARotatedPairNamesTheNewKeys() = runBlocking {
        val s = mem(JcaDeviceCurves)
        s.ensure()
        val b = s.rotate()
        val r = DeviceProofs.signKeysProof(s, "djdl", device, now, allowEphemeral = true)
        assertEquals(b, r.keys)
        assertEquals(b.signKey, r.proof.signKey)
    }

    @Test
    fun refusesToRegisterKeysThatLiveInMemoryOnly() = runBlocking {
        val s = mem(JcaDeviceCurves)
        s.ensure()
        assertEquals(DeviceKeyPersistence.memory, s.persistence())
        assertThrows<DeviceKeyUnsupportedException> { runBlocking { DeviceProofs.signKeysProof(s, "djdl", device, now) } }
        assertThrows<DeviceKeyUnsupportedException> { runBlocking { DeviceProofs.buildDeviceKeysRequest(s, "djdl", device, now) } }
        assertNotNull(DeviceProofs.buildDeviceKeysRequest(s, "djdl", device, now, allowEphemeral = true))
        // Other proofs need no registration.
        assertNotNull(DeviceProofs.sign(s, DeviceProofPurpose.nonce, "djdl", device, "x"))
        // The file store is durable and registers.
        assertNotNull(DeviceProofs.buildDeviceKeysRequest(file(JcaDeviceCurves), "djdl", device, now))
    }
}
