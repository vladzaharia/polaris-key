// @pkey-feature ui.kit
// The snapshot suite (Roborazzi over Robolectric's native graphics; no emulator). Every screen in
// kitScreens is rendered in every variant: a phone in light and dark, neutral and branded; the
// phone at a 200 % font scale; and a tablet in landscape, neutral and branded. Plus the optional
// "Powered by" badge in both brandings. The reference images are committed under
// src/test/snapshots/ and `./gradlew :ui:verifyRoborazziDebug` fails on a difference;
// `:ui:recordRoborazziDebug` re-records them after an intended change.
//
// Densities are mdpi so the committed images stay small; the layouts are in dp, so the pictures
// are the layouts a reviewer checks, at one pixel per dp.

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ActivityScenario
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

data class SnapshotVariant(
    val name: String,
    val branding: PolarisBranding,
    val dark: Boolean,
    val widthDp: Int = 411,
    val heightDp: Int = 891,
    val fontScale: Float = 1f,
    /** Android TV's UI mode (the television qualifier). */
    val tv: Boolean = false,
) {
    override fun toString(): String = name
}

internal val snapshotVariants = listOf(
    SnapshotVariant("phone-neutral-light", PolarisBranding.None, dark = false),
    SnapshotVariant("phone-neutral-dark", PolarisBranding.None, dark = true),
    SnapshotVariant("phone-branded-dark", PolarisBranding.PolarisKey, dark = true),
    SnapshotVariant("phone-branded-light", PolarisBranding.PolarisKey, dark = false),
    SnapshotVariant("phone-neutral-light-font200", PolarisBranding.None, dark = false, fontScale = 2f),
    SnapshotVariant("tablet-neutral-light", PolarisBranding.None, dark = false, widthDp = 1280, heightDp = 800),
    SnapshotVariant("tablet-branded-dark", PolarisBranding.PolarisKey, dark = true, widthDp = 1280, heightDp = 800),
)

/** The resource qualifiers of [this] variant: size, UI mode, night mode, mdpi. */
internal val SnapshotVariant.qualifiers: String
    get() = "w${widthDp}dp-h${heightDp}dp-${if (tv) "television-" else ""}${if (dark) "night" else "notnight"}-mdpi"

/** Small rendering differences between hosts (font hinting) are not changes. */
@OptIn(ExperimentalRoborazziApi::class)
internal val snapshotOptions by lazy {
    // Lazy: the parameterised runner reads snapshotVariants outside the Robolectric sandbox.
    RoborazziOptions(compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f))
}

/**
 * Render [content] for [variant] in a fresh activity and capture it to src/test/snapshots/[name].png.
 * The qualifiers (size, night mode) and the font scale are set BEFORE the activity starts, so the
 * configuration is the one the screen really sees; the compose clock is paused, so an
 * indeterminate progress indicator (an infinite animation) cannot keep the capture from idling.
 */
/**
 * The input mode a capture runs in: touch (a phone in hand, no focus ring) unless [keyboard], so
 * Robolectric's window (which is not in touch mode) does not draw every screen keyboard-focused.
 */
internal class FixedInputMode(override val inputMode: InputMode) : InputModeManager {
    @OptIn(ExperimentalComposeUiApi::class)
    override fun requestInputMode(inputMode: InputMode): Boolean = false
}

@OptIn(ExperimentalRoborazziApi::class)
internal fun ComposeTestRule.capture(
    name: String,
    variant: SnapshotVariant,
    showPoweredBy: Boolean = false,
    keyboard: Boolean = false,
    accent: Color? = null,
    host: ColorScheme? = null,
    /** Let the screen settle on a running clock after the fades (focus requests land); no infinite animations. */
    settle: Boolean = false,
    content: @Composable () -> Unit,
) {
    RuntimeEnvironment.setQualifiers(variant.qualifiers)
    RuntimeEnvironment.setFontScale(variant.fontScale)
    mainClock.autoAdvance = false
    ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
        scenario.onActivity { activity ->
            activity.setContent {
                // A TV is never in touch mode: the D-pad is a keyboard to Compose.
                val mode = if (keyboard || variant.tv) InputMode.Keyboard else InputMode.Touch
                CompositionLocalProvider(LocalInputModeManager provides FixedInputMode(mode)) {
                    val scheme = host ?: if (variant.dark) darkColorScheme() else lightColorScheme()
                    MaterialTheme(colorScheme = scheme) {
                        PolarisTheme(branding = variant.branding, showPoweredBy = showPoweredBy, copy = sampleCopy, darkTheme = variant.dark, accent = accent) {
                            content()
                        }
                    }
                }
            }
        }
        // Past the cross-fades, so the picture is the settled screen (and an indeterminate
        // indicator at a frame where its arc is long enough to read).
        mainClock.advanceTimeBy(2_600)
        if (settle) {
            mainClock.autoAdvance = true
            waitForIdle()
        }
        onRoot().captureRoboImage(filePath = "src/test/snapshots/$name.png", roborazziOptions = snapshotOptions)
    }
}

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class KitSnapshotTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = snapshotVariants.map { arrayOf<Any>(it) }
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyScreen() {
        for ((screen, content) in kitScreens) rule.capture("$screen/${variant.name}", variant, content = content)
    }
}

/** The optional badge, off by default, in both brandings. */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class PoweredBySnapshotTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun badgeInBothBrandings() {
        val activation = kitScreens.first { it.first == "gate-activation" }.second
        rule.capture("powered-by/phone-neutral-light", snapshotVariants[0], showPoweredBy = true, content = activation)
        rule.capture("powered-by/phone-branded-dark", snapshotVariants[2], showPoweredBy = true, content = activation)
        rule.capture("powered-by/phone-branded-light", snapshotVariants[3], showPoweredBy = true, content = activation)
    }
}
