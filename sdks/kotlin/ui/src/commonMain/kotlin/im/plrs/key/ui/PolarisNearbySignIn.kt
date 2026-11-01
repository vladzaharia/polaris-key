// @pkey-feature identity.nearby
// Nearby sign-in on the new device (I-45.12): the kit's `nearby-prompt`, `nearby-wait` and `nearby-done` steps drawn over
// PolarisNearbySignInState. The pre-prompt (Continue or Not now), the code to tap on the other device ("Use a code
// instead" gives nearby up), the approvers to pick from when several answered, and the account to confirm (Continue, or
// "Not you?" which signs the device out). Over hands the person to the regular sign-in; the screen draws nothing then.
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "CyclomaticComplexMethod")

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier

/** The nearby step for [state]; nothing while [PolarisNearbyUi.Over]. */
@Composable
public fun PolarisNearbySignIn(state: PolarisNearbySignInState, modifier: Modifier = Modifier) {
    val ui by state.ui.collectAsState()
    PolarisNearbySignInScreen(ui, state, modifier)
}

@Composable
internal fun PolarisNearbySignInScreen(ui: PolarisNearbyUi, state: PolarisNearbySignInState, modifier: Modifier = Modifier) {
    val member = rememberPresentation(LocalPolarisKey.current?.presentationSource)
    val themeName = PolarisTheme.copy.productName
    fun resolve(inputs: KitInputs): KitScreen {
        val withMember = inputs.withPresentation(member).let {
            if (member == null &&
                !it.has("presentation")
            ) {
                it.with(
                    "presentation",
                    kotlinx.serialization.json.JsonObject(
                        mapOf(
                            "name" to kotlinx.serialization.json.JsonPrimitive(themeName),
                            "icon" to kotlinx.serialization.json.JsonPrimitive(false),
                        ),
                    ),
                )
            } else {
                it
            }
        }
        return KitStates.resolve(KitComponent.signIn, withMember)
    }
    when (ui) {
        PolarisNearbyUi.Idle, PolarisNearbyUi.Looking, PolarisNearbyUi.Done -> PolarisProgressScreen(PolarisTheme.copy.gateLoading, modifier)

        // The regular sign-in takes over; the host's gate shows it.
        is PolarisNearbyUi.Over -> Unit

        PolarisNearbyUi.Prompt -> {
            val screen = remember(member) { resolve(nearbyPromptInputs()) }
            PolarisKitScreen(
                screen,
                modifier,
                onControl = { key ->
                    when (key) {
                        "common.continue" -> state.continuePrompt()
                        "common.notNow" -> state.notNow()
                    }
                },
            )
        }

        is PolarisNearbyUi.Pick -> {
            // Several answered: the wait's title and body, and one button per approver (the code comes once one is chosen).
            val args = mapOf("app" to CopyArgument.Text(themeName))
            val title = KitCopy.bundled.format("signin.nearby.title", kitLocale(), args)
            val body = KitCopy.bundled.format("signin.nearby.body", kitLocale(), args)
            PolarisMessageScreen(PolarisMessageCopy(title, body, PolarisMessageKind.Info), modifier) {
                ui.labels.forEachIndexed { i, label -> PolarisSecondaryButton(label, { state.pick(i) }, initialFocus = i == 0) }
                PolarisSecondaryButton(KitCopy.bundled.format("signin.nearby.code", kitLocale()), state::useCode)
            }
        }

        is PolarisNearbyUi.Wait -> {
            val screen = remember(ui.code, ui.device, member) { resolve(nearbyWaitInputs(ui.code, ui.device)) }
            PolarisKitScreen(screen, modifier, onControl = { key -> if (key == "signin.nearby.code") state.useCode() })
        }

        is PolarisNearbyUi.Confirm -> {
            val screen = remember(ui.identity, member) { resolve(nearbyDoneInputs(ui.identity)) }
            PolarisKitScreen(
                screen,
                modifier,
                onControl = { key ->
                    when (key) {
                        "common.continue" -> state.confirm()
                        "signin.nearby.notYou" -> state.notYou()
                    }
                },
            )
        }
    }
}

/**
 * Whether the gate draws nearby sign-in in place of the code view: the person pressed Sign in, nearby exists, and it
 * has not handed over. [PolarisNearbyUi.Idle] counts, so the code view never flashes before nearby has begun.
 */
internal fun nearbyShown(ui: PolarisNearbyUi?, signingIn: Boolean): Boolean = ui != null && signingIn && ui !is PolarisNearbyUi.Over

/** Begin when the person presses Sign in; leaving ends it (declining a sign-in not yet confirmed) and the next press starts again. */
@Composable
internal fun NearbyGateEffect(state: PolarisNearbySignInState?, signingIn: Boolean) {
    if (state == null) return
    LaunchedEffect(state, signingIn) {
        if (signingIn) {
            state.begin()
        } else {
            state.cancel()
            state.reset()
        }
    }
}
