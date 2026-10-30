// @pkey-feature identity.devicelabel
//
// The Kotlin runner for conformance/corpus/v2/device-label.json (WIRE-CONTRACT-V5 §12.7.1 and §15.6,
// plans/PX-W13.md §4): every row through normalizeDeviceLabel, every helloCases row through
// cleanDisplayLabel, the two range tables against the corpus, and the label's precedence (a
// per-call name, CoreOptions.deviceName, the platform default).

package im.plrs.key.conformance

import im.plrs.key.core.DEVICE_LABEL_MAX_CODEPOINTS
import im.plrs.key.core.DEVICE_LABEL_SPACE_RANGES
import im.plrs.key.core.DEVICE_LABEL_STRIP_RANGES
import im.plrs.key.core.DEVICE_LABEL_VERSION
import im.plrs.key.core.arrayValue
import im.plrs.key.core.cleanDisplayLabel
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
        assertEquals(2, DEVICE_LABEL_VERSION)
        assertEquals(64, DEVICE_LABEL_MAX_CODEPOINTS)
        val rows = corpus["cases"]!!.arrayValue!!.map { it.obj }
        assertTrue("device-label.json holds at least 20 rows", rows.size >= 20)
        val f = Failures("device-label")
        for (row in rows) {
            val id = row["id"].stringValue!!
            f.equal(row["expect"].stringValue, normalizeDeviceLabel(row["raw"].stringValue!!)) { id }
            val expect = row["expect"].stringValue
            if (expect != null) f.equal(expect, normalizeDeviceLabel(expect)) { "$id: fixed point" }
        }
        f.done(20)
    }

    @Test
    fun everyHelloRow() {
        val rows = corpus["helloCases"]!!.arrayValue!!.map { it.obj }
        assertTrue("device-label.json holds at least 10 helloCases", rows.size >= 10)
        val f = Failures("device-label hello")
        for (row in rows) {
            val id = row["id"].stringValue!!
            f.equal(row["expect"].stringValue, cleanDisplayLabel(row["raw"].stringValue!!)) { id }
            val expect = row["expect"].stringValue
            if (expect != null) f.equal(expect, cleanDisplayLabel(expect)) { "$id: fixed point" }
        }
        f.done(10)
    }

    @Test
    fun tablesEqualTheCorpusRanges() {
        fun pairs(name: String) = corpus["ranges"]!!.obj[name]!!.arrayValue!!.map { p ->
            val pair = p.arrayValue!!
            pair[0].longValue!!.toInt()..pair[1].longValue!!.toInt()
        }
        assertEquals(pairs("space"), DEVICE_LABEL_SPACE_RANGES)
        assertEquals(pairs("strip"), DEVICE_LABEL_STRIP_RANGES)
    }

    @Test
    fun loneSurrogatesAreDeleted() {
        assertEquals("ABC", normalizeDeviceLabel("A\uD800B\uDFFFC"))
        assertEquals("\u00e9", cleanDisplayLabel("e\uDC00\u0301"))
        assertNull(normalizeDeviceLabel("\uD83D"))
        // A well-formed pair is one code point, not two surrogates.
        assertEquals("\uD83C\uDFF4", normalizeDeviceLabel("\uD83C\uDFF4"))
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
