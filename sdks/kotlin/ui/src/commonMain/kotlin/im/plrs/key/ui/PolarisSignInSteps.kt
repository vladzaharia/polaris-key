// @pkey-feature identity.link
// @pkey-feature identity.redirect.native
// The sign-in's browser hand-off (rung 6) and the link offer that follows it (identity.link). The
// hand-off is the matrix's SignInHandoff `waiting`, `no-browser` and `link-copied` states: the system
// browser has the sign-in, with Open browser again, Use a code instead and Cancel. The link steps are
// the SignIn form's `link-offer`, `link-done` and `link-conflict`: one decision per screen, the title
// takes focus, and the state is announced once (the kit screen's title is a polite live region).
// Copy comes only from the kit's table; nothing here logs a link, a handle or a proof.
package im.plrs.key.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What the hand-off and link steps ask of the state holder; the stateless screen takes them as one value. */
@Suppress("LongParameterList")
public class PolarisSignInSteps(
    public val onReopen: () -> Unit = {},
    public val onLinkCopied: () -> Unit = {},
    /** The text Copy link puts on the clipboard (the authorize page address), or null. */
    public val redirectLink: () -> String? = { null },
    public val onUseCode: () -> Unit = {},
    public val onLinkAccept: () -> Unit = {},
    public val onLinkDecline: () -> Unit = {},
    public val onLinkFinished: () -> Unit = {},
    public val onLinkSignInAgain: () -> Unit = {},
    /** Back on the offer: close it without a decline, and finish. */
    public val onLinkClose: () -> Unit = {},
)

/** Help: what the link conflict step points to (Polaris Locker's site, the one end users see). */
internal const val JOIN_ACCOUNTS_URL: String =
    im.plrs.key.core.CUSTOMER_ORIGIN_DEFAULT + "/docs/help/join-accounts/#if-another-account-uses-the-address"

/**
 * Resolves a kit component to its screen with the product's presentation (or, with no source, the theme's name
 * standing in), as the automatic sign-in steps do.
 */
@Composable
internal fun rememberKitResolver(): (KitComponent, KitInputs) -> Pair<KitScreen, KitInputs> {
    val member = rememberPresentation(LocalPolarisKey.current?.presentationSource)
    val themeName = PolarisTheme.copy.productName
    return remember(member, themeName) {
        { component, inputs ->
            val withMember = inputs.withPresentation(member).let {
                if (member == null && !it.has("presentation")) {
                    it.with("presentation", JsonObject(mapOf("name" to JsonPrimitive(themeName), "icon" to JsonPrimitive(false))))
                } else {
                    it
                }
            }
            KitStates.resolve(component, withMember) to withMember
        }
    }
}

/** The hand-off: the browser has the sign-in. */
@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@Composable
internal fun PolarisRedirectWait(ui: PolarisSignInUi.Redirecting, steps: PolarisSignInSteps, onCancel: () -> Unit, modifier: Modifier = Modifier) {
    val resolve = rememberKitResolver()
    val (screen, _) = remember(ui.opened, ui.copied) { resolve(KitComponent.signInHandoff, redirectWaitInputs(ui.opened, ui.copied)) }
    val clipboard = rememberPolarisClipboard()
    val scope = rememberCoroutineScope()
    val copy = PolarisTheme.copy
    // Back cancels the sign-in: the screen always backs out (UI-KITS.md DL9).
    val back = PolarisBackHandler(onBack = onCancel)
    PolarisKitScreen(
        screen,
        modifier.then(back),
        onControl = { key ->
            when (key) {
                "signin.handoff.again" -> steps.onReopen()

                "signin.handoff.useCode" -> steps.onUseCode()

                "common.cancel" -> onCancel()

                "signin.handoff.copyLink" -> {
                    // Only a plain https link is ever copied.
                    val link = steps.redirectLink()?.takeIf(::isSafeSignInLink)
                    if (link != null) {
                        scope.launch { clipboard.setText(copy.signInCopyLink, link) }
                        steps.onLinkCopied()
                    }
                }
            }
        },
    )
}

/** The link offer and its two results. System Back (Escape on the desktop) is Done, or, on the offer, No thanks without remembering. */
@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@Composable
internal fun PolarisLinkStep(ui: PolarisSignInUi, steps: PolarisSignInSteps, modifier: Modifier = Modifier) {
    val back = PolarisBackHandler(onBack = if (ui is PolarisSignInUi.LinkOffer) steps.onLinkClose else steps.onLinkFinished)
    val resolve = rememberKitResolver()
    val opener = rememberPolarisOpener()
    val inputs = when (ui) {
        is PolarisSignInUi.LinkOffer -> linkStepInputs("link-offer", ui.provider, ui.reach, ui.problem?.wire)
        is PolarisSignInUi.LinkDone -> linkStepInputs("link-done", ui.provider)
        is PolarisSignInUi.LinkConflict -> linkStepInputs("link-conflict", ui.provider)
        else -> return
    }
    val (screen, _) = remember(inputs) { resolve(KitComponent.signIn, inputs) }
    val busy = (ui as? PolarisSignInUi.LinkOffer)?.busy == true
    // Each step is built fresh: its title and primary take the focus again (the desktop keys, TalkBack's announcement),
    // and so does the primary when a request ends and the offer stays (a problem shares the "link-offer" state).
    key(screen.state, busy) {
        PolarisKitScreen(
            screen,
            modifier.then(back),
            busy = busy,
            onControl = { key ->
                when (key) {
                    "signin.linkOffer.primary" -> steps.onLinkAccept()
                    "signin.linkOffer.decline" -> steps.onLinkDecline()
                    "signin.again" -> steps.onLinkSignInAgain()
                    "common.done" -> steps.onLinkFinished()
                    "signin.linkOffer.join" -> opener(JOIN_ACCOUNTS_URL)
                }
            },
        )
    }
}
