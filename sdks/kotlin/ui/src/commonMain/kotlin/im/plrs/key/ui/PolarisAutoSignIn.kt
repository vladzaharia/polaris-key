// @pkey-feature identity.autosignin
// The gate's automatic sign-in steps (I-45.6), drawn from the kit's v7 `autoSignIn` states over
// PolarisAutoSignInState: the consent (Continue; "Use another account" goes to the sign-in form), the
// licence choice, the device limit (with Replace, or the browser page), and the sign-in form whose
// provider row ("Continue with Google", Android with a provider installed) runs the OS sheet. Idle
// draws nothing: the gate's own screens stay. Nothing here logs or keeps a grant.
package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Whether [ui] replaces the gate's own screens. */
internal fun PolarisAutoSignInUi.takesOver(): Boolean = this !is PolarisAutoSignInUi.Idle && this !is PolarisAutoSignInUi.Done

/** The automatic sign-in step for [state]; nothing while [PolarisAutoSignInUi.Idle]. */
@Composable
public fun PolarisAutoSignIn(state: PolarisAutoSignInState, modifier: Modifier = Modifier) {
    val ui by state.ui.collectAsState()
    PolarisAutoSignInScreen(ui, state, modifier)
}

/** True while the app's window is in the foreground; a test provides its own. */
internal val LocalPolarisForeground = androidx.compose.runtime.staticCompositionLocalOf<(() -> Boolean)?> { null }

/**
 * After Replace opened the browser, the person comes back: the window leaves the foreground and returns.
 * That return runs the sign-in once more ([PolarisAutoSignInState.returned]), so they do not start again by hand.
 */
@Composable
private fun ResumeAfterReplace(state: PolarisAutoSignInState) {
    val awaiting by state.awaitingReturn.collectAsState()
    val windowInfo = androidx.compose.ui.platform.LocalWindowInfo.current
    val foreground = LocalPolarisForeground.current ?: { windowInfo.isWindowFocused }
    androidx.compose.runtime.LaunchedEffect(awaiting) {
        if (!awaiting) return@LaunchedEffect
        // Away, then back: the browser took the window and gave it up.
        androidx.compose.runtime.snapshotFlow(foreground).first { !it }
        androidx.compose.runtime.snapshotFlow(foreground).first { it }
        state.returned()
    }
}

@Composable
internal fun PolarisAutoSignInScreen(ui: PolarisAutoSignInUi, state: PolarisAutoSignInState, modifier: Modifier = Modifier) {
    ResumeAfterReplace(state)
    val opener = rememberPolarisOpener()
    val member = rememberPresentation(LocalPolarisKey.current?.presentationSource)
    // With no presentation source the theme's product name stands in, so the lines still name the app.
    val themeName = PolarisTheme.copy.productName
    fun resolve(component: KitComponent, inputs: KitInputs): Pair<KitScreen, KitInputs> {
        val withMember = inputs.withPresentation(member).let {
            if (member == null &&
                !it.has("presentation")
            ) {
                it.with("presentation", JsonObject(mapOf("name" to JsonPrimitive(themeName), "icon" to JsonPrimitive(false))))
            } else {
                it
            }
        }
        return KitStates.resolve(component, withMember) to withMember
    }
    when (ui) {
        PolarisAutoSignInUi.Idle, PolarisAutoSignInUi.Done -> Unit

        PolarisAutoSignInUi.Running -> PolarisProgressScreen(PolarisTheme.copy.gateLoading, modifier)

        is PolarisAutoSignInUi.Confirm -> {
            // The line reads on after a separator: the host's own device line, else the model's lower-case "this phone".
            val device = PolarisTheme.copy.deviceThis.takeIf { it != PolarisCopy().deviceThis }
            val (screen, _) = remember(ui.consent, member) { resolve(KitComponent.signIn, ui.consent.toKitInputs(device)) }
            Retryable(ui.failed, modifier) {
                PolarisKitScreen(
                    screen,
                    onControl = { key ->
                        when (key) {
                            "signin.auto.confirm.primary" -> state.continueConsent()
                            "signin.auto.confirm.other" -> state.useAnotherAccount()
                        }
                    },
                )
            }
        }

        is PolarisAutoSignInUi.SignInForm -> {
            val (screen, _) = remember(ui.provider, member) { resolve(KitComponent.signIn, signInFormInputs(ui.provider)) }
            Retryable(ui.failed, modifier) {
                PolarisKitScreen(
                    screen,
                    onAction = { action -> if (action == KitAction.cancel) state.dismiss() },
                    onControl = { key ->
                        // The provider row is the one control with no action in the vocabulary.
                        if (key == "signin.provider.continue" && ui.provider) {
                            state.signInWithProvider()
                        } // Any other method is the gate's own sign-in (the code, the key): hand back to its screens.
                        else if (key != "common.cancel") {
                            state.dismiss()
                        }
                    },
                )
            }
        }

        is PolarisAutoSignInUi.Choose -> PolarisAutoChoice(ui.choice, state, modifier, ::resolve)

        is PolarisAutoSignInUi.DeviceLimit -> {
            val view = ui.view
            val manage = ui.manageUrl
            // Replace opened the browser: the next return runs the sign-in once more (state.returned()).
            val openManage = {
                state.replaceOpened()
                if (manage != null) opener(manage)
            }
            if (view == null) {
                // No license rows: the sign-in's own device-limit step (Replace, Use another account, Cancel).
                val (screen, _) = remember(ui, member) { resolve(KitComponent.signIn, deviceLimitInputs(manage, provider = false)) }
                PolarisKitScreen(
                    screen,
                    modifier,
                    onAction = { action ->
                        when (action) {
                            KitAction.openManageUrl, KitAction.replaceInBrowser -> openManage()
                            KitAction.cancel -> state.dismiss()
                            else -> Unit
                        }
                    },
                    onControl = { key -> if (key == "signin.auto.confirm.other") state.useAnotherAccount() },
                )
            } else {
                val (screen, withMember) = remember(ui, member) { resolve(KitComponent.licenseChoice, view.toDeviceLimitInputs()) }
                PolarisKitScreen(
                    screen,
                    modifier,
                    rows = KitRowData.from(withMember),
                    onAction = { action ->
                        when (action) {
                            KitAction.replaceInBrowser, KitAction.openManageUrl -> openManage()
                            KitAction.cancel -> state.dismiss()
                            else -> Unit
                        }
                    },
                    onControl = { key -> if (key == "common.back") state.dismiss() },
                    onUseAnotherAccount = { state.useAnotherAccount() },
                )
            }
        }
    }
}

/** The licence choice and its Replace step over [choice]. */
@Composable
private fun PolarisAutoChoice(
    choice: PolarisLicenseChoiceState,
    state: PolarisAutoSignInState,
    modifier: Modifier,
    resolve: (KitComponent, KitInputs) -> Pair<KitScreen, KitInputs>,
) {
    val ui by choice.ui.collectAsState()
    when (val now = ui) {
        is PolarisLicenseChoiceUi.Choosing -> {
            val (screen, inputs) = remember(now.view) { resolve(KitComponent.licenseChoice, now.view.toKitInputs()) }
            PolarisKitScreen(
                screen,
                modifier,
                rows = KitRowData.from(inputs),
                onContinue = choice::choose,
                onAction = { action ->
                    if (action == KitAction.cancel) {
                        choice.cancel()
                        state.dismiss()
                    }
                },
            )
        }

        is PolarisLicenseChoiceUi.Replacing -> {
            val inputs = now.view.toKitInputs().with(
                "signIn",
                JsonObject(
                    mapOf(
                        "channel" to JsonPrimitive("browser"),
                        "outcome" to JsonPrimitive("choose"),
                        "replace" to JsonPrimitive("inline"),
                        "event" to JsonPrimitive("open-replace"),
                    ),
                ),
            ).with("replaceView", now.devices.raw)
            val (screen, _) = remember(now.devices) { resolve(KitComponent.licenseChoice, inputs) }
            val target =
                now.devices.devices.firstOrNull { (it["leastRecent"] as? JsonPrimitive)?.content == "true" } ?: now.devices.devices.firstOrNull()
            PolarisKitScreen(
                screen,
                modifier,
                onControl = { key ->
                    when (key) {
                        "signin.replace.confirm" -> target?.get("id")?.let { id -> (id as? JsonPrimitive)?.content }?.let(choice::replace)
                        "signin.replace.back" -> choice.back()
                    }
                },
            )
        }

        is PolarisLicenseChoiceUi.Failed -> PolarisMessageScreen(PolarisTheme.copy.coreMessage(SIGN_IN_FAILED, PolarisMessageKind.Danger), modifier) {
            PolarisPrimaryButton(PolarisTheme.copy.retry, choice::retry, initialFocus = true)
            PolarisSecondaryButton(PolarisTheme.copy.cancel, {
                choice.cancel()
                state.dismiss()
            })
        }

        // Done is the holder's: the session is there. Expired and cancelled end the choice: the gate's own screens.
        is PolarisLicenseChoiceUi.Done -> Unit

        PolarisLicenseChoiceUi.Expired, PolarisLicenseChoiceUi.Cancelled -> androidx.compose.runtime.LaunchedEffect(Unit) { state.dismiss() }
    }
}

/** [content], with the sign-in failure line above it when [failed]. */
@Composable
private fun Retryable(failed: Boolean, modifier: Modifier, content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.Column(modifier) {
        if (failed) {
            PolarisInlineNotice(
                KitCopy.bundled.format(
                    "core.codes.sign-in-failed.message",
                    kitLocale(),
                    mapOf("product" to CopyArgument.Text(PolarisTheme.copy.productName)),
                ),
            )
        }
        content()
    }
}
