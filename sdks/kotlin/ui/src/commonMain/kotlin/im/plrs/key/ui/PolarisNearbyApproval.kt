// @pkey-feature identity.nearby
// The approving device's screens (I-45.13): "Approve a nearby device" from the account menu, drawn over
// PolarisNearbyApprovalState. The ask shows the three codes, one button each, and Deny; the person taps the code the other
// device shows. There is no Approve button. A licence
// choice is one tap per licence. Every outcome is the UI matrix's `NearbyApproval` step with its title and one way on, and
// leaving the ask or the choice by any route answers Deny.
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "CyclomaticComplexMethod")

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier

/**
 * The approver for [state]: it starts when this enters the composition and stops, answering Deny to what is on screen,
 * when it leaves. [onManage] runs for "Manage devices" (a full licence), [onSignIn] for "Sign in" (the device has no account).
 */
@Composable
public fun PolarisNearbyApproval(
    state: PolarisNearbyApprovalState,
    modifier: Modifier = Modifier,
    onManage: (() -> Unit)? = null,
    onSignIn: (() -> Unit)? = null,
) {
    val ui by state.ui.collectAsState()
    LaunchedEffect(state) { state.open() }
    DisposableEffect(state) { onDispose { state.close() } }
    PolarisNearbyApprovalScreen(ui, state, modifier, onManage, onSignIn)
}

@Composable
internal fun PolarisNearbyApprovalScreen(
    ui: PolarisApprovalUi,
    state: PolarisNearbyApprovalState,
    modifier: Modifier = Modifier,
    onManage: (() -> Unit)? = null,
    onSignIn: (() -> Unit)? = null,
) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val member = rememberPresentation(LocalPolarisKey.current?.presentationSource)
    val themeName = PolarisTheme.copy.productName

    fun resolve(step: String, device: String?): KitScreen {
        val inputs = nearbyApprovalInputs(step, device).withPresentation(member)
        // Without the product's presentation the theme's name stands in for it.
        val named = if (member == null && !inputs.has("presentation")) {
            inputs.with(
                "presentation",
                kotlinx.serialization.json.JsonObject(
                    mapOf(
                        "name" to kotlinx.serialization.json.JsonPrimitive(themeName),
                        "icon" to kotlinx.serialization.json.JsonPrimitive(false),
                    ),
                ),
            )
        } else {
            inputs
        }
        return KitStates.resolve(KitComponent.nearbyApproval, named)
    }

    /** The title and the body of a step's text lines (its controls are drawn by the kit as buttons). */
    fun words(screen: KitScreen): Pair<String, String> {
        val text = screen.copy.filter { kitLineRole(it.key) == KitLineRole.Text }.map { catalog.format(it, locale) }
        return (text.firstOrNull().orEmpty()) to text.drop(1).joinToString("\n\n")
    }
    when (ui) {
        PolarisApprovalUi.Closed -> Unit

        // The entry is only offered where it can run; a screen opened anyway closes itself.
        PolarisApprovalUi.Unavailable -> LaunchedEffect(Unit) { state.done() }

        PolarisApprovalUi.Listening -> {
            val title = catalog.format("signin.nearby.menu", locale)
            PolarisMessageScreen(PolarisMessageCopy(title, "", PolarisMessageKind.Info), modifier) {
                PolarisSecondaryButton(catalog.format("common.cancel", locale), state::close)
            }
        }

        is PolarisApprovalUi.Working -> PolarisProgressScreen(catalog.format("common.working", locale), modifier)

        is PolarisApprovalUi.Ask -> {
            val screen = remember(ui, member) { resolve("ask", ui.device) }
            val (title, body) = words(screen)
            PolarisMessageScreen(PolarisMessageCopy(title, body, PolarisMessageKind.Warning), modifier) {
                // The codes are the only way to approve; each is one tap.
                ui.codes.forEachIndexed { i, code -> PolarisSecondaryButton(code, { state.pick(i) }, initialFocus = i == 0) }
                PolarisSecondaryButton(catalog.format("signin.approve.deny", locale), state::deny)
            }
        }

        is PolarisApprovalUi.Choose -> {
            val screen = remember(ui, member) { resolve("choose", ui.device) }
            val (title, body) = words(screen)
            PolarisMessageScreen(PolarisMessageCopy(title, body, PolarisMessageKind.Info), modifier) {
                ui.rows.forEachIndexed { i, row -> PolarisSecondaryButton(row.name, { state.choose(i) }, initialFocus = i == 0) }
                if (ui.canCreate) PolarisSecondaryButton(catalog.format("signin.choice.create", locale), state::createLicense)
                PolarisSecondaryButton(catalog.format("signin.approve.deny", locale), state::deny)
            }
        }

        is PolarisApprovalUi.Result -> {
            val screen = remember(ui, member) { resolve(ui.step, ui.device) }
            PolarisKitScreen(
                screen,
                modifier,
                onControl = { key ->
                    when (key) {
                        "devices.manage" -> onManage?.invoke()
                        "signin.key.signIn" -> onSignIn?.invoke()
                    }
                    state.done()
                },
            )
        }
    }
}
