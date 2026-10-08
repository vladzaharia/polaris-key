// @pkey-feature core.sync
//
// SP-51: boot's sync stage backs off after a failed attempt (1 s doubling to a 30 s cap), so a boot
// that keeps failing never becomes a request storm.
package im.plrs.key.sdk

import org.junit.Assert.assertEquals
import org.junit.Test

class BootBackoffTest {
    @Test
    fun backoffDoublesToAThirtySecondCap() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), (1..7).map { bootBackoffMillis(it) })
    }
}
