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
 * and Cancel come back to the key field; [onQuit] is the host's quit, called once a desktop installer
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
    content: @Composable () -> Unit,
) {
    val update = remember(client) { PolarisUpdateState() }
    val updateActions = remember(client) { client.updateActions() }
    PolarisKeyAppHost(client, modifier, bootOptions, onSignIn, packs, signIn, onQuit, update, updateActions, optionalUpdateInDialog = true, content)
}
