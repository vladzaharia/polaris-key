// The one-liner for a Compose app (UK-09b.3, UI-KITS.md D-2):
//
//   setContent { PolarisKeyGate(client) { App() } }
//
// PolarisKeyGate is what PolarisKeyApp was: it starts the client (once, main-safe), then composes the
// boot shell, the gate, pack progress and the update surfaces over it, provides the client to the tree
// through LocalPolarisKey and shows [content] once the licence allows it. It adds no look of its own.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import im.plrs.key.core.BootOptions
import im.plrs.key.sdk.PolarisKeyClient

/**
 * The whole kit wired to [client]: boot (with the gate, pack progress and the update banner) and
 * then [content]. [onSignIn] starts sign-in from the activation screen (null hides the button);
 * [signIn] runs the device-code sign-in inside the gate instead, whose "Use a license key instead"
 * and Cancel come back to the key field; [autoSignIn] runs the automatic sign-in ladder once at boot; [onQuit] is the
 * host's quit, called once a desktop installer
 * is open (the kit never quits by itself); [packs] shows per-pack progress during the boot fetch.
 */
@Composable
public fun PolarisKeyGate(
    client: PolarisKeyClient,
    modifier: Modifier = Modifier,
    bootOptions: BootOptions = BootOptions(),
    onSignIn: (() -> Unit)? = null,
    packs: Boolean = client.packs.configured,
    signIn: Boolean = false,
    onQuit: (() -> Unit)? = null,
    /** False turns automatic sign-in off: the gate shows its own screens and runs no `autoSignIn()` (Q-12). */
    autoSignIn: Boolean = true,
    /**
     * The in-gate sign-in's native redirect (rung 6): the system browser, with a code where no redirect can start (and
     * always on a television). Android passes `AndroidRedirect.options` and an `AndroidRedirectBrowser` here; the default
     * suits the desktop. Null signs in with a code only.
     */
    redirect: PolarisRedirect? = PolarisRedirect(),
    /** False goes straight to the product after a license key activates, with no Done step (UK-43). */
    keyDone: Boolean = true,
    /** The Done step's account step: the native redirect setup and the tab to arm before the browser opens. */
    holders: PolarisHolderOptions = PolarisHolderOptions(),
    content: @Composable () -> Unit,
) {
    val update = remember(client) { PolarisUpdateState() }
    val updateActions = remember(client) { client.updateActions() }
    PolarisKeyAppHost(
        client, modifier, bootOptions, onSignIn, packs, signIn, onQuit, update, updateActions,
        optionalUpdateInDialog = true, autoSignIn = autoSignIn, redirect = redirect, keyDone = keyDone, holders = holders, content = content,
    )
}
