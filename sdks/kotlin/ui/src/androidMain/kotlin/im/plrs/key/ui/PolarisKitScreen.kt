// The screens drawn from the presentation core (UI-KITS.md §4.1; plans/UK-02b.md §5).
//
// `KitStates.resolve(component, inputs)` answers, from wire-free inputs, which state a component is
// in, which catalog lines it shows and which actions it offers. PolarisKitScreen draws that answer
// in the kit's look and hands each action back to the host; it holds no state of its own, so the
// same inputs always draw the same screen (the ui-matrix snapshots run exactly that).
//
// KitSignIn is the SignIn(state, presentation) component: the sign-in form's state from the inputs,
// the product's identity from the SDK's presentation source (the kit fetches nothing itself).

package im.plrs.key.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import im.plrs.key.core.Presentation
import im.plrs.key.core.PresentationSource
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The locale tag the catalog formats in: the device's first locale. */
@Composable
internal fun kitLocale(): String {
    val configuration = LocalConfiguration.current
    return remember(configuration) {
        val locales = configuration.locales
        if (locales.isEmpty) "en" else locales[0].toLanguageTag()
    }
}

/** What a line is on screen: a control, an announcement for assistive tech only, or text. */
internal enum class KitLineRole { Control, Announcement, Text }

private val controlSuffix = Regex(
    "(continue|keyInstead|openBrowser|openSystem|manage|download|install|retry|tryAgain|again|activate|later|notNow|" +
        "restart|signOut|remove|rename|save|done|close|back|cancel|reconnect|newCode|copyLink|open|choose)$",
)

internal fun kitLineRole(key: String): KitLineRole = when {
    key.startsWith("a11y.") -> KitLineRole.Announcement
    KitAction.forCopyKey(key) != null || controlSuffix.containsMatchIn(key) -> KitLineRole.Control
    else -> KitLineRole.Text
}

private data class KitLine(val key: String, val role: KitLineRole, val text: String)

/**
 * Draws [screen] (a `KitStates.resolve` answer) in the kit's look. The first text line is the title,
 * the rest are body copy; control lines are buttons, the first one primary. [onAction] receives the
 * vocabulary action a control stands for, or null for a control the vocabulary has no action for.
 * A hidden screen draws nothing.
 */
@Composable
public fun PolarisKitScreen(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
    onAction: (KitAction?) -> Unit = {},
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) {
        screen.copy.map { line -> KitLine(line.key, kitLineRole(line.key), catalog.format(line, locale)) }
    }
    val controls = lines.filter { it.role == KitLineRole.Control }
    val announcement = lines.filter { it.role == KitLineRole.Announcement }.joinToString(". ") { it.text }
    val text = lines.filter { it.role == KitLineRole.Text && it.key != "part.poweredBy" }
    // The optional attribution (UI-KITS.md section 1.6): the line, the pane's last item, after the
    // controls. On when the inputs carry it or the theme's `showPoweredBy` is on, and only on the
    // account pane (the kit has no About); never on a gate.
    val attribution = lines.any { it.key == "part.poweredBy" } ||
        (PolarisTheme.current.showPoweredBy && screen.component == KitComponent.accountAndLicense)
    PolarisScreen(
        modifier = modifier.semantics {
            if (announcement.isNotEmpty()) {
                contentDescription = announcement
                liveRegion = LiveRegionMode.Polite
            }
        },
        actions = if (controls.isEmpty()) null else {
            {
                controls.forEachIndexed { index, line ->
                    val action = KitAction.forCopyKey(line.key)
                    if (index == 0) {
                        PolarisPrimaryButton(line.text, onClick = { onAction(action) })
                    } else {
                        PolarisTextButton(line.text, onClick = { onAction(action) })
                    }
                }
                if (attribution) {
                    Spacer(Modifier.height(16.dp))
                    PolarisPoweredByLine()
                }
            }
        },
    ) {
        text.forEachIndexed { index, line ->
            if (index == 0) PolarisTitle(line.text) else PolarisBody(line.text)
            Spacer(Modifier.height(8.dp))
        }
        // With no controls, the line closes the content.
        if (attribution && controls.isEmpty()) PolarisPoweredByLine()
    }
}

/** The presentation member as the matrix's wire-free input. */
internal fun Presentation.toInput(): JsonObject {
    val out = linkedMapOf<String, JsonElement>("name" to JsonPrimitive(name), "icon" to JsonPrimitive(icon != null))
    developerName?.let { out["developerName"] = JsonPrimitive(it) }
    accent?.let { out["accent"] = JsonPrimitive(it) }
    accentDark?.let { out["accentDark"] = JsonPrimitive(it) }
    return JsonObject(out)
}

/** [this] with `presentation` set from [member] unless the inputs carry their own. */
public fun KitInputs.withPresentation(member: Presentation?): KitInputs =
    if (member == null || has("presentation")) this else with("presentation", member.toInput())

/**
 * The sign-in form for [inputs] (the matrix's `signIn`, `capabilities`, `services` ... members),
 * under the product's identity from [presentation]. Wrap it in [PolarisTheme] with the same source
 * to draw the product's accent and icon.
 */
@Composable
public fun KitSignIn(
    inputs: KitInputs,
    presentation: PresentationSource? = null,
    modifier: Modifier = Modifier,
    onAction: (KitAction?) -> Unit = {},
) {
    val member = rememberPresentation(presentation)
    PolarisKitScreen(
        screen = remember(inputs, member) { KitStates.resolve(KitComponent.signIn, inputs.withPresentation(member)) },
        modifier = modifier,
        onAction = onAction,
    )
}
