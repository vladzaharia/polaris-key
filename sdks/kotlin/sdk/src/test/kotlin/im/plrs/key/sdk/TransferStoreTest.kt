// @pkey-feature connect.transfer
//
// The partial-file store of Direct Transfer (CC-20.7; WIRE-CONTRACT-V5 section 15.11): space reserved at accept and
// held until the transfer ends, a write past the offered size refused, a partial touched only by its holder and
// its peer, eviction that spares a live transfer, and a purge after which a late effect cannot bring the directory
// back.

package im.plrs.key.sdk

import im.plrs.key.core.peer.XferEffect
import im.plrs.key.core.peer.XferPartial
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

class TransferStoreTest {
    private val dirs = ArrayList<File>()
    private val peer = ByteArray(32) { 1 }
    private val other = ByteArray(32) { 2 }
    private val me = Any()
    private val you = Any()

    @After
    fun cleanUp() = dirs.forEach { it.deleteRecursively() }

    private fun store(quota: Long = 1000, reserve: Long = 0): TransferStore {
        val root = Files.createTempDirectory("pkey-store-test").toFile().also { dirs += it }
        return TransferStore(root, { System.currentTimeMillis() / 1000.0 }, { quota }, reserve)
    }

    private fun ref(n: Int) = "%064x".format(n)

    private fun partial(n: Int, size: Long) = XferPartial(ref(n), "AAAAAAAAAAAAAAAAAAAAAA", "0".repeat(64), size, 100, 0, 0.0)

    private fun refused(f: () -> Unit) {
        try {
            f()
            fail("must be refused")
        } catch (e: IOException) {
            assertTrue(e.message!!.isNotEmpty())
        }
    }

    @Test
    fun spaceIsReservedAtAcceptAndHeldUntilTheTransferEnds() {
        val s = store()
        val e = s.epoch
        assertEquals(1000L, s.free())
        s.apply(XferEffect.Create(ref(1), partial(1, 600)), me, peer, e) { null }
        assertEquals(400L, s.free())
        refused { s.apply(XferEffect.Create(ref(2), partial(2, 600)), you, peer, e) { null } }
        s.apply(XferEffect.Create(ref(2), partial(2, 400)), you, peer, e) { null }
        assertEquals(0L, s.free())
        // Written bytes are on disk, no longer owed: the total does not move.
        s.apply(XferEffect.Write(ref(1), 0, ByteArray(100)), me, peer, e) { null }
        assertEquals(0L, s.free())
        s.apply(XferEffect.Delete(ref(1)), me, peer, e) { null }
        assertEquals(600L, s.free())
        // A session that ends keeps what it wrote and gives back what it had reserved.
        s.apply(XferEffect.Write(ref(2), 0, ByteArray(100)), you, peer, e) { null }
        s.apply(XferEffect.Keep(ref(2)), you, peer, e) { null }
        assertEquals(900L, s.free())
    }

    @Test
    fun aWritePastTheOfferedSizeOrWithNoReservationIsRefused() {
        val s = store()
        val e = s.epoch
        s.apply(XferEffect.Create(ref(1), partial(1, 150)), me, peer, e) { null }
        s.apply(XferEffect.Write(ref(1), 0, ByteArray(100)), me, peer, e) { null }
        refused { s.apply(XferEffect.Write(ref(1), 100, ByteArray(51)), me, peer, e) { null } }
        s.apply(XferEffect.Write(ref(1), 100, ByteArray(50)), me, peer, e) { null }
        s.apply(XferEffect.Keep(ref(1)), me, peer, e) { null }
        refused { s.apply(XferEffect.Write(ref(1), 150, ByteArray(1)), me, peer, e) { null } }
    }

    @Test
    fun aPartialIsTouchedOnlyByItsHolderAndItsPeer() {
        val s = store()
        val e = s.epoch
        s.apply(XferEffect.Create(ref(1), partial(1, 100)), me, peer, e) { null }
        refused { s.apply(XferEffect.Write(ref(1), 0, ByteArray(1)), you, peer, e) { null } }
        refused { s.apply(XferEffect.Delete(ref(1)), you, peer, e) { null } }
        refused { s.apply(XferEffect.Create(ref(1), partial(1, 100)), you, peer, e) { null } }
        s.apply(XferEffect.Keep(ref(1)), me, peer, e) { null }
        refused { s.apply(XferEffect.Delete(ref(1)), you, other, e) { null } }
        assertEquals(1, s.partialsFor(peer).size)
        assertEquals(0, s.partialsFor(other).size)
    }

    @Test
    fun evictionSparesALiveTransferAndAnotherPeersPartial() {
        val s = store()
        val e = s.epoch
        s.apply(XferEffect.Create(ref(1), partial(1, 100)), me, peer, e) { null }
        s.apply(XferEffect.Evict(ref(1)), you, peer, e) { null }
        assertEquals("a live partial stays", 1, s.partialsFor(peer).size)
        s.apply(XferEffect.Keep(ref(1)), me, peer, e) { null }
        s.apply(XferEffect.Evict(ref(1)), you, other, e) { null }
        assertEquals("another peer's partial stays", 1, s.partialsFor(peer).size)
        s.apply(XferEffect.Evict(ref(1)), you, peer, e) { null }
        assertEquals(0, s.partialsFor(peer).size)
    }

    @Test
    fun aLateEffectAfterAPurgeDoesNotBringTheStoreBack() {
        val root = Files.createTempDirectory("pkey-store-test").toFile().also { dirs += it }
        val s = TransferStore(root, { 0.0 }, { 1000 }, 0)
        val e = s.epoch
        s.apply(XferEffect.Create(ref(1), partial(1, 100)), me, peer, e) { null }
        assertTrue(File(root, "xfer").isDirectory)
        s.purgeAll()
        assertFalse(File(root, "xfer").exists())
        refused { s.apply(XferEffect.Write(ref(1), 0, ByteArray(10)), me, peer, e) { null } }
        refused { s.apply(XferEffect.Create(ref(2), partial(2, 10)), me, peer, e) { null } }
        assertFalse("the directory stays gone", File(root, "xfer").exists())
        // A session bound after the purge works again.
        s.apply(XferEffect.Create(ref(3), partial(3, 10)), me, peer, s.epoch) { null }
        assertTrue(File(root, "xfer").isDirectory)
    }

    @Test
    fun theFilesAreNamedByTheDerivedPathAndOwnerOnly() {
        val root = Files.createTempDirectory("pkey-store-test").toFile().also { dirs += it }
        val s = TransferStore(root, { 0.0 }, { 1000 }, 0)
        s.apply(XferEffect.Create(ref(7), partial(7, 10)), me, peer, s.epoch) { null }
        val names = File(root, "xfer").list()!!.sorted()
        assertEquals(listOf(ref(7) + ".json", ref(7) + ".part"), names)
        if (File(root, "xfer").toPath().fileSystem.supportedFileAttributeViews().contains("posix")) {
            fun mode(f: File) = PosixFilePermissions.toString(Files.getPosixFilePermissions(f.toPath()))
            assertEquals("rw-------", mode(File(root, "xfer/" + ref(7) + ".part")))
            assertEquals("rw-------", mode(File(root, "xfer/" + ref(7) + ".json")))
            assertEquals("rwx------", mode(File(root, "xfer")))
        }
    }
}
