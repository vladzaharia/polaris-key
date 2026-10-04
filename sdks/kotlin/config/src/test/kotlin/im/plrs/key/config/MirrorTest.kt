// @pkey-feature config.mirror
//
// The Kotlin catalog mirror: `mirror/ConfigSchema.generated.kt` is what `tools/gen-mirrors.ts
// --lang kotlin` writes for `src/test/resources/catalog.json` (tools/gen-mirrors.test.ts holds
// the two byte-for-byte), and it COMPILES here, in a module with no help from the SDK. This test
// reads it back against the fixture: the escapes (quotes, backslashes, `$`, control characters,
// non-ASCII and astral text) survive, and a secret's default is never compiled in.

package im.plrs.key.config

import im.plrs.key.config.mirror.ConfigKind
import im.plrs.key.config.mirror.ManagementState
import im.plrs.key.config.mirror.ProductCatalog
import im.plrs.key.core.JsonText
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MirrorTest {
    private val fixture = JsonText.parse(javaClass.getResource("/catalog.json")!!.readText()).objectValue!!
    private val entries = fixture["entries"].arrayValue!!.map { it.objectValue!! }

    @Test
    fun theMirrorIsTheFixtureCatalog() {
        assertEquals(fixture["schemaVersion"].longValue!!.toInt(), ProductCatalog.VERSION)
        assertEquals(entries.map { it["key"].stringValue }, ProductCatalog.keys)
        for (e in entries) {
            val m = ProductCatalog.entry(e["key"].stringValue!!)!!
            assertEquals(e["kind"].stringValue, m.kind.wire)
            assertEquals(e["label"].stringValue, m.label)
            assertEquals(e["description"].stringValue, m.description)
            assertEquals(e["accessor"].stringValue, m.accessor)
            assertEquals(e["managementDefault"].stringValue, m.managementDefault?.wire)
            assertTrue(jsonEquals(e["schema"], JsonText.parse(m.schemaJson)))
            if (m.kind == ConfigKind.secret || e["default"] == null) {
                assertNull(m.defaultJson)
            } else {
                assertTrue(e["key"].stringValue, jsonEquals(e["default"], JsonText.parse(m.defaultJson!!)))
            }
        }
    }

    @Test
    fun escapesSurviveCompilation() {
        assertEquals("How fast the dice roll: costs \$5, never \${interpolated}.", ProductCatalog.entry("dice.animSpeed")!!.description)
        assertEquals("Música \"principal\"", ProductCatalog.entry("audio.musicVolume")!!.label)
        assertEquals("Line one.\nLine two, with a back\\slash and a tab\there.", ProductCatalog.entry("audio.musicVolume")!!.description)
        assertEquals("Theme 🎲", ProductCatalog.entry("ui.theme")!!.label)
        assertEquals("Dunkel ☾", ProductCatalog.entry("ui.theme")!!.optionLabels["dark"])
        assertEquals("×", ProductCatalog.entry("dice.animSpeed")!!.unit)
    }

    @Test
    fun aSecretsDefaultIsNeverCompiledIn() {
        val secret = ProductCatalog.entry("leaderboard.apiKey")!!
        assertTrue(secret.isSecret)
        assertNull(secret.defaultJson)
        assertFalse(ProductCatalog.entries.any { it.defaultJson?.contains("never-a-default") == true })
    }

    @Test
    fun kindsStatesAndDependencies() {
        assertEquals(listOf("extras.diceSkins"), ProductCatalog.entriesByKind(ConfigKind.flag).map { it.key })
        assertEquals(ManagementState.enforced, ProductCatalog.entry("game.killSwitch")!!.managementDefault)
        assertEquals("ui.theme", ProductCatalog.entry("game.killSwitch")!!.dependsOnKey)
        assertEquals("dark", ProductCatalog.entry("game.killSwitch")!!.dependsOnEquals)
        assertTrue(ProductCatalog.entry("extras.diceSkins")!!.userGrant)
        assertNull(ProductCatalog.entry("absent"))
    }
}
