// @pkey-feature ui.i18n
// The generated catalog tables (commonMain/composeResources, written by `pnpm gen brand`) are
// Compose Multiplatform resources of this KMP module: every name in the English table has a
// generated accessor, so `stringResource(Res.allStringResources.getValue(name))` reads any catalog
// line, and every launch locale carries the English names.
package im.plrs.key.ui

import im.plrs.key.ui.res.Res
import im.plrs.key.ui.res.allStringResources
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposeResourcesTest {
    private val root = File(System.getProperty("pkey.repoRoot") ?: "../../..").resolve("sdks/kotlin/ui/src/commonMain/composeResources")
    private val name = Regex("""<string name="([^"]+)"""")

    private fun names(dir: String): Set<String> =
        name.findAll(root.resolve(dir).resolve("strings.xml").readText()).map { it.groupValues[1] }.toSet()

    @Test
    fun everyEnglishNameHasAGeneratedAccessor() {
        val english = names("values")
        assertTrue("the English table is the catalog", english.size > 1_000)
        assertEquals(english, Res.allStringResources.keys)
    }

    @Test
    fun everyLaunchLocaleKeepsTheEnglishNames() {
        val english = names("values")
        val locales = root.listFiles { f -> f.isDirectory && f.name.startsWith("values-") }!!.map { it.name }
        assertEquals(8, locales.size)
        for (locale in locales) assertEquals(locale, english, names(locale))
    }
}
