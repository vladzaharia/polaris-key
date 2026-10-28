// @pkey-feature connect.lan

package im.plrs.key.core.peer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class BrowseIndexTest {
    private val ids = (0 until 4).map { i -> "AAAABBBBCCCCDDDDEEEEFFFFGGGGHH" + "H" + i }
    private val keys = listOf(ByteArray(32) { 1 }, ByteArray(32) { 2 })
    private val now = 1_700_000_000L

    @Test
    fun aForgedNameCostsOneLookupAndNoHmac() {
        var macs = 0
        val index = BrowseIndex(keys, advertEpoch(now), ids) { k, e, d ->
            macs++
            accountInstance(k, e, d)
        }
        val built = macs
        assertEquals(2 * 2 * ids.size, built) // two epochs, two keys, every device, once
        val alphabet = "abcdefghijklmnopqrstuvwxyz234567"
        repeat(1000) { n ->
            val forged = "p1-" + (0 until 16).joinToString("") { alphabet[(n * 7 + it * 3) % 32].toString() }
            assertNull(index.lookup(forged))
        }
        assertNull(index.lookup("not-a-name"))
        assertEquals(built, macs) // not one more HMAC for a thousand forged names
    }

    @Test
    fun itAnswersLikeBrowseAccountInstance() {
        val epoch = advertEpoch(now)
        val index = BrowseIndex(keys, epoch, ids)
        for ((back, key) in listOf(0 to 0, 1 to 1)) {
            val name = accountInstance(keys[key], epoch - back, ids[2])
            val hit = index.lookup(name)
            assertNotNull(hit)
            assertEquals(hit, browseAccountInstance(name, keys, now, ids))
        }
        assertNull(index.lookup(accountInstance(keys[0], epoch - 2, ids[1]))) // too old
        assertNull(index.lookup(accountInstance(ByteArray(32) { 3 }, epoch, ids[1]))) // not a delivered key
    }
}
