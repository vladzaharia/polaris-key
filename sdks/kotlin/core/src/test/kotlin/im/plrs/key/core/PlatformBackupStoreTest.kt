package im.plrs.key.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `PlatformBackupStore` port: its key names, its typed answers and the in-memory double. */
class PlatformBackupStoreTest {
    @Test
    fun keysAreOnePerProductWithOneOfTwoPrefixes() {
        assertEquals("pkey-restore-tidewater", PlatformBackupStore.restoreKey("tidewater"))
        assertEquals("pkey-sync-tidewater", PlatformBackupStore.syncKey("tidewater"))
        assertTrue(PlatformBackupStore.isOurKey(PlatformBackupStore.restoreKey("tidewater")))
        assertTrue(PlatformBackupStore.isOurKey(PlatformBackupStore.syncKey("tidewater")))
        for (bad in listOf(
            "",
            "pkey-restore-",
            "pkey-sync-",
            "other-tidewater",
            "pkey-token-tidewater",
            "com.google.android.gms.auth.blockstore.DEFAULT_BYTES_DATA_KEY",
        )) {
            assertFalse(bad, PlatformBackupStore.isOurKey(bad))
        }
    }

    @Test
    fun unavailableStoreAnswersEveryCallWithItsReason() = runBlocking {
        val store = UnavailablePlatformBackupStore(PlatformBackupStore.REASON_OUTLET)
        val key = PlatformBackupStore.restoreKey("tidewater")
        assertEquals(PlatformBackupRead.Unavailable("outlet"), store.get(key))
        assertEquals(PlatformBackupWrite.Unavailable("outlet"), store.set(key, byteArrayOf(1)))
        assertEquals(PlatformBackupWrite.Unavailable("outlet"), store.delete(key))
        assertFalse(store.cloudBackup())
    }

    @Test
    fun inMemoryStoreRoundTripsAndDeletes() = runBlocking {
        val store = InMemoryPlatformBackupStore(cloud = true)
        val key = PlatformBackupStore.syncKey("tidewater")
        assertEquals(PlatformBackupRead.Missing, store.get(key))
        assertEquals(PlatformBackupWrite.Done(true), store.set(key, byteArrayOf(1, 2, 3)))
        assertArrayEquals(byteArrayOf(1, 2, 3), (store.get(key) as PlatformBackupRead.Found).bytes)
        assertEquals(PlatformBackupWrite.Done(false), store.delete(key))
        assertEquals(PlatformBackupRead.Missing, store.get(key))
        assertTrue(store.cloudBackup())
        assertFalse(InMemoryPlatformBackupStore().cloudBackup())
    }

    @Test
    fun inMemoryStoreAppliesTheSameRulesAsBlockStore() = runBlocking {
        val store = InMemoryPlatformBackupStore()
        assertEquals(PlatformBackupRead.Refused("bad-key"), store.get("tidewater"))
        assertEquals(PlatformBackupWrite.Refused("bad-key"), store.set("tidewater", byteArrayOf(1)))
        assertEquals(PlatformBackupWrite.Refused("bad-key"), store.delete("tidewater"))
        val key = PlatformBackupStore.restoreKey("tidewater")
        assertEquals(PlatformBackupWrite.Done(false), store.set(key, ByteArray(PlatformBackupStore.MAX_VALUE_BYTES)))
        assertEquals(PlatformBackupWrite.Refused("too-large"), store.set(key, ByteArray(PlatformBackupStore.MAX_VALUE_BYTES + 1)))
        // The entry cap: 16 products fill it; a 17th key is refused, an existing one still updates.
        for (i in 1 until PlatformBackupStore.MAX_ENTRIES) store.set(PlatformBackupStore.syncKey("p$i"), byteArrayOf(1))
        assertEquals(PlatformBackupWrite.Unavailable("full"), store.set(PlatformBackupStore.syncKey("one-more"), byteArrayOf(1)))
        assertEquals(PlatformBackupWrite.Done(false), store.set(key, byteArrayOf(9)))
    }

    @Test
    fun foundNeverPrintsItsBytes() {
        assertEquals("Found(3 bytes)", PlatformBackupRead.Found(byteArrayOf(7, 8, 9)).toString())
    }

    private object Silent : PlatformBackupStore {
        override suspend fun get(key: String): PlatformBackupRead = kotlinx.coroutines.awaitCancellation()

        override suspend fun set(key: String, bytes: ByteArray): PlatformBackupWrite = kotlinx.coroutines.awaitCancellation()

        override suspend fun delete(key: String): PlatformBackupWrite = kotlinx.coroutines.awaitCancellation()

        override suspend fun cloudBackup(): Boolean = kotlinx.coroutines.awaitCancellation()
    }

    @Test
    fun aBoundedStoreAnswersUnavailableWhenTheInnerOneNeverAnswers() = runBlocking {
        val bounded = BoundedPlatformBackupStore(Silent, 100)
        val key = PlatformBackupStore.syncKey("tidewater")
        assertEquals(PlatformBackupRead.Unavailable(PlatformBackupStore.REASON_FAILED), bounded.get(key))
        assertEquals(PlatformBackupWrite.Unavailable(PlatformBackupStore.REASON_FAILED), bounded.set(key, ByteArray(1)))
        assertEquals(PlatformBackupWrite.Unavailable(PlatformBackupStore.REASON_FAILED), bounded.delete(key))
        assertFalse(bounded.cloudBackup())
    }

    @Test
    fun aBoundedStorePassesAnsweringCallsThroughAndIsNotWrappedTwice() = runBlocking {
        val inner = InMemoryPlatformBackupStore(cloud = true)
        val bounded = BoundedPlatformBackupStore(inner, 5_000)
        val key = PlatformBackupStore.syncKey("tidewater")
        assertEquals(PlatformBackupWrite.Done(true), bounded.set(key, ByteArray(2)))
        assertEquals(2, (bounded.get(key) as PlatformBackupRead.Found).bytes.size)
        assertTrue(bounded.cloudBackup())
        assertTrue(BoundedPlatformBackupStore.of(bounded) === bounded)
        assertEquals(null, BoundedPlatformBackupStore.of(null))
    }
}
