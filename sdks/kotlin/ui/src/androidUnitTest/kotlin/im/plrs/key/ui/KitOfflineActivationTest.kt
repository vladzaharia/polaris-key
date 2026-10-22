// @pkey-feature ui.kit
// OfflineActivation in the generic renderer: Copy code is a real button that copies the request
// code, beside step 1; the request QR is drawn only when the host gives the code.

package im.plrs.key.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class KitOfflineActivationTest {
    @get:Rule
    val rule = createComposeRule()

    private val inputs = KitInputs.of(
        mapOf(
            "capabilities" to buildJsonObject { put("offlineActivation", JsonPrimitive(true)) },
            "offline" to JsonObject(emptyMap()),
        ),
    )

    @Test
    fun copyCodeIsAButtonThatCopiesTheRequestCode() {
        val screen = KitStates.resolve(KitComponent.offlineActivation, inputs)
        var action: KitAction? = null
        rule.setContent {
            StockHost(false) {
                PolarisTheme(darkTheme = false) {
                    PolarisKitScreen(screen, requestCode = "dev_7Q2Mx9cLr4TbV0aZ3WPLDA8kN5eY", onAction = { action = it })
                }
            }
        }
        rule.onNodeWithText("Copy code").performClick()
        rule.waitForIdle()
        val clipboard = ApplicationProvider.getApplicationContext<Context>().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals("dev_7Q2Mx9cLr4TbV0aZ3WPLDA8kN5eY", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(KitAction.forCopyKey("offlineActivation.copyCode"), action)
    }
}
