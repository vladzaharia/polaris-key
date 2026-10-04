// @pkey-feature devices.register
//
// The JVM desktop's fingerprint reader: whatever this host yields is hashed into the wire form
// (22-character component digests, a 32-character hwid, canonical component names only), never a
// raw value, and the result is stable across two reads.

package im.plrs.key.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FingerprintSourceTest {
    @Test
    fun aDesktopFingerprintIsHashedAndStable() {
        val first = JvmFingerprintSource.collect("djdl") ?: return // a host that yields nothing sends no body
        val canonical = FingerprintComponent.entries.map { it.wire }.toSet()
        assertTrue(first.components.keys.all { it in canonical })
        assertTrue(first.components.values.all { it.length == 22 })
        assertEquals(32, first.hwid.length)
        assertEquals(first, JvmFingerprintSource.collect("djdl"))
        // Per-product hashing: another product sees different digests for the same machine.
        assertTrue(JvmFingerprintSource.collect("other")!!.hwid != first.hwid)
    }

    @Test
    fun theRequestBodyIsTheShapeEveryMintRouteReads() {
        val body = HardwareFingerprint(mapOf("machineUuid" to "abc"), "h").requestBody().toString(Charsets.UTF_8)
        assertEquals("""{"fingerprint":{"components":{"machineUuid":"abc"},"hwid":"h"}}""", body)
    }
}
