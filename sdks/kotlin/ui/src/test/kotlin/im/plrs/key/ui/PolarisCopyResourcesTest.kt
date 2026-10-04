// Every string is in PolarisCopy AND in the string resources, with the same English text, so the
// resources are a complete translation hook: an app's values-<locale>/strings.xml with the same
// names translates every string the kit renders.

package im.plrs.key.ui

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class PolarisCopyResourcesTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun everyFieldHasAResourceWithTheSameEnglish() {
        val defaults = PolarisCopy().asMap()
        val missing = mutableListOf<String>()
        val differ = mutableListOf<String>()
        for ((field, english) in defaults) {
            @Suppress("DiscouragedApi")
            val id = context.resources.getIdentifier(PolarisCopy.resourceName(field), "string", context.packageName)
            if (id == 0) {
                missing += field
                continue
            }
            val resource = context.resources.getString(id)
            if (resource != english) differ += "$field: \"$english\" vs \"$resource\""
        }
        assertTrue("fields without a pkey_ui_ string resource: $missing", missing.isEmpty())
        assertTrue("PolarisCopy and strings.xml disagree:\n" + differ.joinToString("\n"), differ.isEmpty())
        assertTrue(defaults.size > 100)
    }

    @Test
    fun noResourceWithoutAField() {
        val xml = File(System.getProperty("pkey.repoRoot") ?: "../../..").resolve("sdks/kotlin/ui/src/main/res/values/strings.xml").readText()
        val names = Regex("""<string name="(pkey_ui_[a-z0-9_]+)"""").findAll(xml).map { it.groupValues[1] }.toList()
        val fields = PolarisCopy.FIELDS.map { PolarisCopy.resourceName(it) }.toSet()
        assertEquals(names.size, names.toSet().size)
        assertEquals("strings.xml names without a PolarisCopy field", emptySet<String>(), names.toSet() - fields)
    }

    @Test
    fun fromResourcesIsTheEnglishDefault() {
        assertEquals(PolarisCopy(), PolarisCopy.fromResources(context.resources, context.packageName))
    }

    @Test
    @Config(qualifiers = "fr")
    fun aTranslationOverridesTheEnglish() {
        // The debug source set carries a values-fr/strings.xml for two names, as an app would.
        val copy = PolarisCopy.fromResources(context.resources, context.packageName)
        assertEquals("Réessayer", copy.retry)
        assertEquals("Bienvenue dans %1\$s", copy.activationTitle)
        assertEquals("untranslated names keep the English", PolarisCopy().cancel, copy.cancel)
    }
}
