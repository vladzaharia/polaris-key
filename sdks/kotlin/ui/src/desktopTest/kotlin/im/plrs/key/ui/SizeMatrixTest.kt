// @pkey-feature ui.kit
//
// UK-10.11: the desktop kit at the sizes people run it. The UI-KITS.md §7.1 rows as window sizes x the
// three chromes (forced through `pkey.kit.platform`), font scale 2 at three of them, and touch input at
// the phone row. On every frame: no control clipped by its pane or the window, no sideways scroll, no
// text cut, the primary action inside the first viewport, and every target at least U6's size (24 dp
// under a mouse, 44 dp under touch). With PKEY_KIT_SHOTS set, each frame is also written to
// <dir>/matrix/<chrome>/<screen>/<w>x<h>[-fs2].png (compare stays off until UK-10.12).

@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import im.plrs.key.core.AllowedRange
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertTrue

internal val matrixChromes = listOf("Windows", "Gnome", "MacOS")

/** The §7.1 rows as window sizes, in dp (the frames run at density 1). */
internal val matrixSizes = listOf(
    390 to 844,
    844 to 390,
    640 to 360,
    820 to 1180,
    1180 to 820,
    1440 to 900,
    1920 to 1080,
)

/** Font scale 2 at the phone, the phone in landscape and the laptop. */
internal val matrixLargeFontSizes = listOf(390 to 844, 844 to 390, 1440 to 900)

private const val NOW = 1_790_000_000L

private val matrixPrompt = PolarisSignInCode(
    userCode = "WDJB-MJHT",
    verificationUri = "${BoardFixtures.LOCKER}/device",
    verificationUriComplete = "${BoardFixtures.LOCKER}/device?user_code=WDJB-MJHT",
    expiresIn = 600,
    expiresAt = NOW + 461,
    deviceName = "Desk PC",
)
private const val MANAGE = "${BoardFixtures.LOCKER}/activate?product=tidewater&next=free-device&for=Desk%20PC"

private fun gateUi(status: LicenseStatus, range: AllowedRange? = null) =
    PolarisGateUi(license = LicenseState(status, allowedRange = range), nowSeconds = NOW)

/** One screen of the matrix and the label (case-blind, as the Mac title-cases) of its primary action. */
internal class MatrixScreen(val name: String, val primary: Regex, val content: @Composable () -> Unit)

internal val matrixScreens: List<MatrixScreen> = listOf(
    MatrixScreen("gate", Regex("sign in", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), onSignIn = {})
    },
    MatrixScreen("activate", Regex("activate", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV"))
    },
    MatrixScreen("sign-in", Regex("open browser|copy link", RegexOption.IGNORE_CASE)) {
        PolarisSignInScreen(PolarisSignInUi.Showing(matrixPrompt, NOW))
    },
    // The v7 sign-in steps and the approving device's prompt, resolved from the matrix's own inputs.
    MatrixScreen("sign-in-confirm", Regex("continue", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(autoStep("confirm", email = "maya@example.com", license = "existing", alsoGets = true))
    },
    MatrixScreen("sign-in-confirm-new", Regex("continue", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(autoStep("confirm", email = "maya@example.com", license = "new"))
    },
    MatrixScreen("link-offer", Regex("link google", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(autoStep("link-offer"))
    },
    MatrixScreen("link-done", Regex("done", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(autoStep("link-done"))
    },
    MatrixScreen("link-conflict", Regex("join accounts", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(autoStep("link-conflict"))
    },
    MatrixScreen("nearby-wait", Regex("use a code instead", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(autoStep("nearby-wait", code = "482913"))
    },
    MatrixScreen("nearby-approval", Regex("deny", RegexOption.IGNORE_CASE)) {
        PolarisKitScreen(
            KitStates.resolve(
                KitComponent.nearbyApproval,
                KitInputs.of(
                    fixture(
                        "nearbyApproval" to buildJsonObject {
                            put("step", "ask")
                            put("device", "Kitchen iPad")
                        },
                    ),
                ),
            ),
        )
    },
    MatrixScreen("device-limit", Regex("browser|manage|replace", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(
            gateUi(LicenseStatus.needsActivation),
            PolarisActivationUi(
                key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV",
                error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(1, 1, MANAGE)),
                manageUrl = MANAGE,
            ),
        )
    },
    MatrixScreen("message", Regex("update|install", RegexOption.IGNORE_CASE)) {
        PolarisGateScreen(gateUi(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0")), PolarisActivationUi(), onUpdate = {})
    },
    MatrixScreen("update-sheet", Regex("update now|install", RegexOption.IGNORE_CASE)) {
        BoardFixtures.Product()
        PolarisUpdatePromptDialog(
            PolarisUpdateUi(
                "2.5.0",
                currentVersion = "2.4.1",
                size = 61_000_000L,
                notes = listOf("Faster sync on slow networks", "Fixes a crash when resuming"),
                notesUrl = "https://example.com/releases/2.5.0",
                outlet = "direct",
            ),
            onUpdate = {},
            onLater = {},
            onSkip = {},
        )
    },
)

/**
 * The inputs every v7 kit fixture shares: a named product and developer, a Pro tier (the license line)
 * and Google as the provider (React, SwiftUI and Godot render the same).
 */
private fun fixture(vararg more: Pair<String, kotlinx.serialization.json.JsonElement>): Map<String, kotlinx.serialization.json.JsonElement> = mapOf(
    "integrator" to buildJsonObject {
        put("name", BoardFixtures.PRODUCT)
        put("developer", BoardFixtures.DEVELOPER)
    },
    "account" to buildJsonObject { put("tier", "Pro") },
    "provider" to JsonPrimitive("Google"),
) + more

private fun autoStep(step: String, email: String? = null, license: String? = null, alsoGets: Boolean = false, code: String? = null): KitScreen =
    KitStates.resolve(
        KitComponent.signIn,
        KitInputs.of(
            fixture(
                "autoSignIn" to buildJsonObject {
                    put("step", step)
                    email?.let { put("email", it) }
                    license?.let { put("license", it) }
                    if (alsoGets) put("alsoGets", true)
                    code?.let { put("code", it) }
                },
            ),
        ),
    )

/** What the matrix measures on one frame; every entry is a violation. */
internal class FrameCheck(val failures: MutableList<String> = mutableListOf(), var primaryFound: Boolean = false)

internal fun SemanticsNode.matrixLabel(): String {
    val text = config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
    val description = config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()
    val editable = config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
    return "$text $description $editable".trim()
}

private fun textLayout(node: SemanticsNode): TextLayoutResult? {
    val action = node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action ?: return null
    val results = mutableListOf<TextLayoutResult>()
    action(results)
    return results.firstOrNull()
}

/** [node] is whole (its clipped bounds are its full size) and inside its root, or says what is cut. */
private fun wholeAndInside(label: String, node: SemanticsNode, out: MutableList<String>) {
    val root = generateSequence(node) { it.parent }.last().size
    val shown = node.boundsInRoot
    val whole = shown.width >= node.size.width - 1f && shown.height >= node.size.height - 1f
    val inside = shown.left >= -1f && shown.top >= -1f && shown.right <= root.width + 1f && shown.bottom <= root.height + 1f
    if (!whole || !inside || shown.isEmpty) out += "'$label' shows $shown of ${node.size} in ${root.width}x${root.height}"
}

/** The frame's assertions: controls whole, targets, text uncut, no sideways scroll, the primary in view. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.checkFrame(screen: MatrixScreen, minTargetDp: Float): FrameCheck {
    val check = FrameCheck()
    val controls = onAllNodes(hasClickAction() or hasSetTextAction()).fetchSemanticsNodes()
    for (node in controls) {
        val label = node.matrixLabel()
        wholeAndInside(label, node, check.failures)
        val height = maxOf(node.size.height.toFloat(), node.touchBoundsInRoot.height)
        val width = maxOf(node.size.width.toFloat(), node.touchBoundsInRoot.width)
        // U6: a target is 24 dp (mouse) or 44 dp (touch) on its short side; a text link may be a line tall but is padded to it.
        if (minOf(height, width) < minTargetDp - 0.5f) check.failures += "'$label' is ${width}x$height dp, under $minTargetDp"
        if (screen.primary.containsMatchIn(label)) {
            val shown = node.boundsInRoot
            val root = generateSequence(node) { it.parent }.last().size
            if (!shown.isEmpty && shown.bottom <= root.height + 1f && shown.top >= -1f) check.primaryFound = true
        }
    }
    if (!check.primaryFound) {
        check.failures +=
            "the primary action ${screen.primary} is not in the first viewport (${controls.map { it.matrixLabel() }})"
    }
    for (node in onAllNodes(androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(SemanticsActions.GetTextLayoutResult)).fetchSemanticsNodes()) {
        val layout = textLayout(node) ?: continue
        val lastEllipsized = layout.lineCount > 0 && layout.isLineEllipsized(layout.lineCount - 1)
        if (layout.didOverflowHeight || lastEllipsized) check.failures += "text '${node.matrixLabel().take(40)}' is cut"
    }
    for (node in onAllNodes(
        androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange),
    ).fetchSemanticsNodes()) {
        val range = node.config[SemanticsProperties.HorizontalScrollAxisRange]
        if (range.maxValue() > 0f) check.failures += "a sideways scroll of ${range.maxValue()}"
    }
    return check
}

/** The host facts the matrix renders under (never the real desktop's). */
internal fun matrixFacts(dark: Boolean, highContrast: Boolean = false, reducedTransparency: Boolean = false) =
    PolarisHostFacts(dark = dark, highContrast = highContrast, reducedTransparency = reducedTransparency)

/** Composes [content] in the Tidewater theme at [w] x [h] and runs [after] on the settled frame. */
@OptIn(ExperimentalTestApi::class)
internal fun matrixFrame(
    w: Int,
    h: Int,
    dark: Boolean,
    fontScale: Float = 1f,
    touch: Boolean = false,
    facts: PolarisHostFacts = matrixFacts(dark),
    branding: PolarisBranding = PolarisBranding.PolarisKey,
    theme: @Composable (@Composable () -> Unit) -> Unit = { inner ->
        PolarisTheme(
            branding = branding,
            darkTheme = dark,
            copy = PolarisCopy(productName = BoardFixtures.PRODUCT),
            accent = BoardFixtures.tidewaterAccent,
            logo = { BoardFixtures.TidewaterIcon() },
            developer = BoardFixtures.DEVELOPER,
            content = inner,
        )
    },
    content: @Composable () -> Unit,
    after: ComposeUiTest.() -> Unit,
) = runDesktopComposeUiTest(width = w, height = h) {
    setContent {
        val density = LocalDensity.current
        CompositionLocalProvider(
            LocalDensity provides Density(density.density, fontScale),
            LocalPolarisHostFacts provides facts,
            LocalPolarisTouchInput provides touch,
            LocalPolarisInitialFocus provides false,
        ) {
            theme { Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() } }
        }
    }
    waitForIdle()
    mainClock.advanceTimeBy(800)
    waitForIdle()
    after()
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.writeShot(out: File?, chrome: String, screen: String, w: Int, h: Int, suffix: String) {
    if (out == null) return
    val roots = onAllNodes(isRoot())
    val image = roots[roots.fetchSemanticsNodes().size - 1].captureToImage()
    val file = File(out, "matrix/${chrome.lowercase()}/$screen/${w}x$h$suffix.png")
    file.parentFile.mkdirs()
    ImageIO.write(image.toAwtImage(), "png", file)
}

/**
 * Findings the matrix surfaces that are not fixed here (UK-10.15 owns them). Each entry must still occur: a fix removes its
 * line, and a line that no longer matches fails the test, so the list only shrinks (the lint-debt rule).
 */
internal val knownMatrixGaps: List<Regex> = listOf(
    // Content taller than a short window scrolls inside its pane at font scale 2: the controls below the fold are not in view.
    Regex("""Gnome message 844x390-fs2: .* (shows|is not in the first viewport) .*"""),
    Regex("""Windows update-sheet 844x390-fs2: 'All changes in 2\.5\.0' shows .*"""),
    // The Mac sheet's three-button row is wider than the sheet at font scale 2 (it clips; it neither wraps nor stacks).
    Regex("""MacOS update-sheet \d+x\d+-fs2: '(Remind Me Later|All Changes in 2\.5\.0)' shows .*"""),
    // The Mac sign-in and device-limit action rows sit below the fold of the 520 dp floor at font scale 2.
    Regex("""MacOS (sign-in|device-limit) \d+x\d+-fs2: '.*' shows .*"""),
    // The confirm step with the license and "also gets" lines (KF-compose fixture): its actions scroll below the fold at font scale 2
    // on the Mac's 520 dp floor (two panes). The phone-width window docks its actions now (KFA-compose).
    Regex("""MacOS sign-in-confirm 844x520-fs2: (.* shows .*|the primary action .* is not in the first viewport .*)"""),
)

/** [failures] minus the known gaps; a known gap that matched nothing is reported too. */
internal fun unexpected(failures: List<String>): List<String> = failures.filterNot { f -> knownMatrixGaps.any { it.matches(f) } } +
    knownMatrixGaps.filter { gap -> failures.none { gap.matches(it) } }.map { "a known gap no longer occurs: ${it.pattern}" }

class SizeMatrixTest {
    private val out = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)

    private fun run(chrome: String, sizes: List<Pair<Int, Int>>, fontScale: Float, touch: Boolean, suffix: String): List<String> {
        val failures = mutableListOf<String>()
        withPlatform(chrome) {
            for ((rowW, rowH) in sizes) {
                for (screen in matrixScreens) {
                    // The Mac window never lays out under its 480 x 520 floor (a smaller host scrolls the floor-sized content, S7): the Mac is measured at the floor.
                    val mac = chrome == "MacOS"
                    val w = if (mac) maxOf(rowW, 480) else rowW
                    val h = if (mac) maxOf(rowH, 520) else rowH
                    matrixFrame(w, h, dark = true, fontScale = fontScale, touch = touch, content = screen.content, after = {
                        val check = checkFrame(screen, if (touch) 44f else 24f)
                        for (f in check.failures) failures += "$chrome ${screen.name} ${w}x$h$suffix: $f"
                        writeShot(out, chrome, screen.name, w, h, suffix)
                    })
                }
            }
        }
        return failures
    }

    /** Under the floor the Mac scrolls the floor-sized content (S7) rather than clipping it. */
    @Test
    fun theMacScrollsBelowItsFloor() = withPlatform("MacOS") {
        for ((w, h) in matrixSizes.filter { it.first < 480 || it.second < 520 }) {
            matrixFrame(w, h, dark = false, content = matrixScreens[0].content, after = {
                val scrolls = onAllNodes(
                    androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange) or
                        androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange),
                ).fetchSemanticsNodes()
                assertTrue(
                    scrolls.any { n ->
                        (n.config.getOrNull(SemanticsProperties.HorizontalScrollAxisRange)?.maxValue?.invoke() ?: 0f) > 0f ||
                            (n.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)?.maxValue?.invoke() ?: 0f) > 0f
                    },
                    "${w}x$h: the Mac scrolls below its floor",
                )
            })
        }
    }

    @Test
    fun everyRowFitsInEveryChrome() {
        val failures = matrixChromes.flatMap { run(it, matrixSizes, 1f, touch = false, suffix = "") }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @Test
    fun fontScale2NeverClips() {
        val failures = unexpected(matrixChromes.flatMap { run(it, matrixLargeFontSizes, 2f, touch = false, suffix = "-fs2") })
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @Test
    fun touchTargetsAre44() {
        val failures = matrixChromes.flatMap { run(it, listOf(390 to 844), 1f, touch = true, suffix = "-touch") }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }
}
