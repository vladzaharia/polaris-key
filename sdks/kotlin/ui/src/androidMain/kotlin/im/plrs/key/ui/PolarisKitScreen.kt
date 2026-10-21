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

import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.ui.text.style.TextAlign
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

/**
 * The catalog lines that are buttons whatever their name ends in: the welcome's entry points, the
 * status screens' recoveries and the sign-in's choices.
 */
private val controlKeys = setOf(
    "welcome.signIn", "welcome.useKey", "welcome.trial", "welcome.continueFree", "welcome.restore", "welcome.offline",
    "status.renew", "status.useAnotherLicense", "status.update", "status.switchChannel", "status.contact",
    "signin.menu.signIn", "signin.passkey", "signin.none.get", "signin.none.otherAccount",
    "signin.choice.keyInstead", "signin.key.differentKey", "signin.code.resend", "signin.handoff.useCode",
    "signin.replace.back", "signin.replace.openSystem", "signin.replace.open",
)

internal fun kitLineRole(key: String): KitLineRole = when {
    key.startsWith("a11y.") -> KitLineRole.Announcement
    key in controlKeys || KitAction.forCopyKey(key) != null || controlSuffix.containsMatchIn(key) -> KitLineRole.Control
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
    // The sign-in form is a focused step: the product header above a start-aligned title.
    KitScreenBody(screen, modifier, catalog, locale, onAction, focused = screen.component == KitComponent.signIn, productName = null)
}

@Composable
private fun KitScreenBody(
    screen: KitScreen,
    modifier: Modifier,
    catalog: KitCopy,
    locale: String,
    onAction: (KitAction?) -> Unit,
    focused: Boolean,
    productName: String?,
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
    val semanticsModifier = modifier.semantics {
        if (announcement.isNotEmpty()) {
            contentDescription = announcement
            liveRegion = LiveRegionMode.Polite
        }
    }
    val actions: (@Composable ColumnScope.() -> Unit)? = if (controls.isEmpty()) null else {
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
    }
    val body: @Composable ColumnScope.() -> Unit = {
        if (focused) PolarisProductHeader(productName)
        text.forEachIndexed { index, line ->
            if (index == 0) PolarisTitle(line.text) else PolarisBody(line.text)
            Spacer(Modifier.height(8.dp))
        }
        // With no controls, the line closes the content.
        if (attribution && controls.isEmpty()) PolarisPoweredByLine()
    }
    if (focused) {
        PolarisScaffold(
            modifier = semanticsModifier,
            anchor = PolarisAnchor.Top,
            contentAlign = TextAlign.Start,
            actions = actions,
            content = body,
        )
    } else {
        PolarisScreen(modifier = semanticsModifier, actions = actions, content = body)
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
 * under the product's identity from [presentation]: the product header (icon and name) above the
 * title, then the controls in the kit's buttons. Wrap it in [PolarisTheme] with the same source to
 * draw the product's accent and icon.
 */
@Composable
public fun KitSignIn(
    inputs: KitInputs,
    presentation: PresentationSource? = null,
    modifier: Modifier = Modifier,
    onAction: (KitAction?) -> Unit = {},
) {
    val member = rememberPresentation(presentation)
    KitScreenBody(
        screen = remember(inputs, member) { KitStates.resolve(KitComponent.signIn, inputs.withPresentation(member)) },
        modifier = modifier,
        catalog = KitCopy.bundled,
        locale = kitLocale(),
        onAction = onAction,
        focused = true,
        productName = member?.name,
    )
}
