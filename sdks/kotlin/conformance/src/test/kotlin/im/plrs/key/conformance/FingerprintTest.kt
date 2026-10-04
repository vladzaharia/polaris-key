// @pkey-feature devices.fingerprint
//
// The Kotlin runner for conformance/corpus/v2/fingerprint.json: the component and hwid digests,
// the device-id formula, and the three source rules (WIRE-CONTRACT-V3 §6.1) — `windowsCim`
// (with the pinned `windowsCimCommand`), `linuxAnchor` and `ramBuckets` — since a JVM desktop app
// can run on Windows and Linux. `devices.fingerprint` stays planned in sdks/kotlin/parity.json
// until P6-12 adds Android's inputs; this suite already pins the derivation.

package im.plrs.key.conformance

import im.plrs.key.core.DeviceId
import im.plrs.key.core.Fingerprint
import im.plrs.key.core.FingerprintComponent
import im.plrs.key.core.arrayValue
import im.plrs.key.core.decimalValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.math.RoundingMode
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Test

class FingerprintTest {
    private val corpus = Corpus.v2("fingerprint.json")

    private fun rows(name: String) = corpus[name]!!.arrayValue!!.map { it.obj }

    private fun strings(e: kotlinx.serialization.json.JsonElement?) =
        e.objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()

    @Test
    fun componentOrderAndLengths() {
        assertEquals(1L, corpus["fingerprintVersion"].longValue)
        assertEquals(corpus["componentOrder"]!!.arrayValue!!.map { it.stringValue }, FingerprintComponent.entries.map { it.wire })
        assertEquals(22L, corpus["componentHashLength"].longValue)
        assertEquals(32L, corpus["hwidLength"].longValue)
    }

    @Test
    fun vectors() {
        val f = Failures("vectors")
        for (v in rows("vectors")) {
            val got = Fingerprint.hashComponents(v["product"].stringValue!!, strings(v["raw"]))
            f.equal(strings(v["components"]), got.components) { "${v["id"].stringValue} components" }
            f.equal(v["hwid"].stringValue, got.hwid) { "${v["id"].stringValue} hwid" }
        }
        f.done(6)
    }

    @Test
    fun deviceIds() {
        val f = Failures("deviceIds")
        for (v in rows("deviceIds")) {
            f.equal(v["expected"].stringValue, DeviceId.fromRaw(v["product"].stringValue!!, v["raw"].stringValue!!)) { "device-id ${v["id"].stringValue}" }
        }
        f.done(4)
    }

    @Test
    fun windowsCimCommand() {
        val want = corpus["windowsCimCommand"]!!.obj
        val got = Fingerprint.WINDOWS_CIM_COMMAND
        assertEquals(want["program"].stringValue, got.program)
        assertEquals(want["args"]!!.arrayValue!!.map { it.stringValue }, got.args)
        assertEquals(want["stdin"].stringValue, got.stdin)
        assertEquals(want["timeoutMs"].longValue, got.timeoutMs)
    }

    @Test
    fun windowsCim() {
        val f = Failures("windowsCim")
        for (c in rows("windowsCim")) {
            f.equal(strings(c["expected"]), Fingerprint.parseWindowsCim(c["stdout"].stringValue)) { "windowsCim ${c["id"].stringValue}" }
        }
        f.done(17)
    }

    @Test
    fun linuxAnchor() {
        val f = Failures("linuxAnchor")
        for (c in rows("linuxAnchor")) {
            val files = c["files"].objectValue!!.mapValues { it.value.stringValue }
            val got = Fingerprint.linuxAnchorSource(files)
            val expected = c["expected"]
            val want = if (expected == null || expected is JsonNull) null else strings(expected)
            f.equal(want, got?.let { mapOf("source" to it.source, "value" to it.value) }) { "linuxAnchor ${c["id"].stringValue}" }
        }
        f.done(10)
    }

    @Test
    fun ramBuckets() {
        val f = Failures("ramBuckets")
        for (c in rows("ramBuckets")) {
            val bytes = c["bytes"].decimalValue!!.setScale(0, RoundingMode.FLOOR).toBigInteger()
            f.equal(c["bucket"].stringValue, Fingerprint.ramBucket(bytes)) { "ramBuckets ${c["id"].stringValue}" }
        }
        f.done(13)
    }
}
