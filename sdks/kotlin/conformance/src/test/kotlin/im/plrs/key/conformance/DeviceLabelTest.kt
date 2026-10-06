// @pkey-feature identity.devicelabel
//
// The Kotlin runner for conformance/corpus/v2/device-label.json (WIRE-CONTRACT-V4 §12.7.1,
// plans/PX-W13.md §4): every row through normalizeDeviceLabel, and the label's precedence (a
// per-call name, CoreOptions.deviceName, the platform default).

package im.plrs.key.conformance

import im.plrs.key.core.DEVICE_LABEL_MAX_CODEPOINTS
import im.plrs.key.core.DEVICE_LABEL_VERSION
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.normalizeDeviceLabel
import im.plrs.key.core.resolveDeviceLabel
import im.plrs.key.core.stringValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceLabelTest : ConformanceSuite() {
    private val corpus = Corpus.v2("device-label.json")

    @Test
    fun everyRow() {
        assertEquals(DEVICE_LABEL_VERSION.toLong(), corpus["deviceLabelVersion"].longValue)
        assertEquals(64, DEVICE_LABEL_MAX_CODEPOINTS)
        val rows = corpus["cases"]!!.arrayValue!!.map { it.obj }
        assertTrue("device-label.json holds at least 20 rows", rows.size >= 20)
        val f = Failures("device-label")
        for (row in rows) {
            f.equal(row["expect"].stringValue, normalizeDeviceLabel(row["raw"].stringValue!!)) { row["id"].stringValue!! }
        }
        f.done(20)
    }

    @Test
    fun precedence() {
        val host = { " host\t" }
        assertEquals("Den PC", resolveDeviceLabel("Den PC", "TV", host))
        assertEquals("TV", resolveDeviceLabel(null, "TV", host))
        assertEquals("host", resolveDeviceLabel(null, null, host))
        assertNull(resolveDeviceLabel("", "TV", host))
        assertNull(resolveDeviceLabel(null, "", host))
    }
}
