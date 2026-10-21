// @pkey-feature core.presentation
//
// The presentation baseline (HA-13 review finding 2): the public KitSignIn under a product's
// presentation, drawn with the product's icon, name and accent in both schemes. Baselines:
// src/test/snapshots/presentation/phone-branded-{dark,light}.png.

package im.plrs.key.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import androidx.compose.runtime.Composable
import im.plrs.key.core.Presentation
import im.plrs.key.core.PresentationIcon
import im.plrs.key.core.PresentationSource
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Drift Kart's presentation, with its own icon: an orange tile with a white chevron. */
private class DriftKartSource : PresentationSource {
    private val member = Presentation(
        name = "Drift Kart",
        developerName = "Night Owl Games",
        accent = "#ec592a",
        accentDark = "#ff8a5c",
        icon = PresentationIcon(sha256 = "d".repeat(64), contentType = "image/png", original = "https://img.plrs.im/driftkart/a/icon"),
    )

    override fun current(): Presentation? = member

    override suspend fun icon(px: Double, scale: Double): ByteArray? {
        val bmp = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawRoundRect(RectF(0f, 0f, 128f, 128f), 28f, 28f, Paint().apply { color = 0xFFEC592A.toInt(); isAntiAlias = true })
        val chevron = Paint().apply { color = 0xFFFFFFFF.toInt(); isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 14f; strokeCap = Paint.Cap.ROUND }
        canvas.drawLine(40f, 36f, 80f, 64f, chevron)
        canvas.drawLine(80f, 64f, 40f, 92f, chevron)
        canvas.drawLine(62f, 36f, 102f, 64f, chevron)
        canvas.drawLine(102f, 64f, 62f, 92f, chevron)
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    override fun subscribe(listener: (Presentation?) -> Unit): () -> Unit = {}
}

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class PresentationSnapshotTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun theSignInUnderAPresentation() {
        val source = DriftKartSource()
        val inputs = KitInputs.of(
            mapOf(
                "signIn" to buildJsonObject {
                    put("presentation", JsonPrimitive("inline"))
                    put("replace", JsonPrimitive("inline"))
                    put("channel", JsonPrimitive("browser"))
                },
            ),
        )
        for (name in listOf("phone-branded-dark", "phone-branded-light")) {
            val variant = snapshotVariants.first { it.name == name }
            val content: @Composable () -> Unit = {
                PolarisTheme(
                    branding = variant.branding,
                    darkTheme = variant.dark,
                    copy = PolarisCopy(productName = "Drift Kart"),
                    presentation = source,
                ) { KitSignIn(inputs, source) }
            }
            rule.capture("presentation/$name", variant, settle = true, waitMs = 1_500, content = content)
        }
    }
}
