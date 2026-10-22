// @pkey-feature ui.kit ui.signin
// The public KitSignIn's methods step, beyond the picture (UK-59 review 2): the kit names the
// provider the generic row opens (Polaris Locker, or the `provider` input), leaves out the "Or
// continue with" divider and the "Sign in..." menu link, and never draws a line that ends in
// "with" or a "{provider}" the inputs did not fill. The first control is Continue in browser on
// a desktop (DL9), as in the React and Swift kits.

package im.plrs.key.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class KitSignInMethodsTest {
    @get:Rule
    val rule = createComposeRule()

    private fun shown(inputs: KitInputs): List<String> {
        rule.setContent { StockHost(false) { PolarisTheme(copy = PolarisCopy(productName = "Drift Kart"), darkTheme = false) { KitSignIn(inputs) } } }
        rule.waitForIdle()
        return rule.onAllNodes(SemanticsMatcher("has text") { it.config.contains(SemanticsProperties.Text) }, useUnmergedTree = true)
            .fetchSemanticsNodes()
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }
            .map { it.text.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
    }

    private fun inputs(vararg extra: Pair<String, kotlinx.serialization.json.JsonElement>): KitInputs =
        KitInputs.of(
            mapOf(
                "signIn" to buildJsonObject {
                    put("presentation", JsonPrimitive("inline"))
                    put("replace", JsonPrimitive("inline"))
                    put("channel", JsonPrimitive("browser"))
                },
            ) + extra,
        )

    @Test
    fun theGenericRowNamesPolarisLockerAndNothingDangles() {
        val texts = shown(inputs())
        assertTrue("Continue with Polaris Locker is a button: $texts", "Continue with Polaris Locker" in texts)
        assertTrue("Continue in browser is on screen: $texts", "Continue in browser" in texts)
        assertFalse("no divider over a provider list that is not drawn: $texts", texts.any { it.startsWith("Or continue with") })
        assertFalse("no Sign in... link on the sign-in step: $texts", texts.any { it.startsWith("Sign in…") || it == "Sign in..." })
        assertFalse("no line ends in 'with': $texts", texts.any { it.endsWith(" with") })
        assertFalse("no unfilled argument: $texts", texts.any { '{' in it || '}' in it })
        // Continue in browser comes first (the primary), before the provider row.
        assertTrue(texts.indexOf("Continue in browser") < texts.indexOf("Continue with Polaris Locker"))
    }

    @Test
    fun aProductThatShowsItsOwnProviderNamesIt() {
        val texts = shown(inputs("provider" to JsonPrimitive("Steam")))
        assertTrue("Continue with Steam: $texts", "Continue with Steam" in texts)
        assertEquals(false, "Continue with Polaris Locker" in texts)
    }
}
