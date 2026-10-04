// @pkey-feature core.headers
//
// The Kotlin runner for conformance/corpus/v2/headers.json (WIRE-CONTRACT-V3 §5.2), with the Node
// runner's assertions: every row through canonicalPlatform / canonicalArch, the generated tables
// equal to the map the non-null rows describe, and every table value a generated enum value. The
// header this process sends is a canonical value too.

package im.plrs.key.conformance

import im.plrs.key.core.ARCH_SPELLINGS
import im.plrs.key.core.ARCH_VALUES
import im.plrs.key.core.PLATFORM_SPELLINGS
import im.plrs.key.core.PLATFORM_VALUES
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.arrayValue
import im.plrs.key.core.canonicalArch
import im.plrs.key.core.canonicalPlatform
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HeadersTest {
    private val corpus = Corpus.v2("headers.json")

    private fun fold(s: String) = buildString { for (c in s) append(if (c in 'A'..'Z') c + 32 else c) }

    private fun section(name: String, map: (String) -> String?, table: Map<String, String>, values: List<String>) {
        val rows = corpus[name]!!.arrayValue!!.map { it.obj }
        assertTrue("$name holds at least 31 rows", rows.size >= 31)
        val f = Failures(name)
        val derived = LinkedHashMap<String, String>()
        for (row in rows) {
            val raw = row["raw"].stringValue!!
            val expect = row["expect"].stringValue
            f.equal(expect, map(raw)) { "${row["id"].stringValue} ($raw)" }
            if (expect != null) derived[fold(raw)] = expect
        }
        f.done(31)
        assertEquals("$name: the generated table equals the rows", derived, table)
        for (v in table.values) assertTrue("$name: $v is a generated value", v in values)
        // A doctored row fails the same comparison.
        val row = rows.first { it["expect"].stringValue != null }
        assertNotEquals(row["expect"].stringValue + "-doctored", map(row["raw"].stringValue!!))
    }

    @Test
    fun headersVersion() = assertEquals(1L, corpus["headersVersion"].longValue)

    @Test
    fun platformCases() = section("platformCases", ::canonicalPlatform, PLATFORM_SPELLINGS, PLATFORM_VALUES)

    @Test
    fun archCases() = section("archCases", ::canonicalArch, ARCH_SPELLINGS, ARCH_VALUES)

    @Test
    fun thisProcessSendsCanonicalValues() {
        RuntimeFamily.platformHeader?.let { assertTrue(it, it in PLATFORM_VALUES) }
        RuntimeFamily.archHeader?.let { assertTrue(it, it in ARCH_VALUES) }
        assertEquals("jvm", RuntimeFamily.capabilityRuntime)
    }
}
