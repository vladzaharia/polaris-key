// `rememberLicenseChoiceState` (I-10b.20): the Compose handle on the Compose-free `PolarisLicenseChoiceState`.
// After a redirect sign-in settled `SignInOutcome.Choose`, hold the choice here and finish it through
// `identity.choice.*`. The screen for the choice is the host's (or UK-42/UK-43's); this is the state it reads.
package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.sdk.PolarisKeyClient

/**
 * The licence-choice state for a settled [SignInOutcome.Choose], or null when the Worker's `choices` is not a
 * view (the card chooses instead). It lives as long as the composition and is rebuilt for a new grant; the
 * grant is a credential and is never saved with the instance state, so a process death ends the choice
 * (the person signs in again). [onCompleted] runs once when the choice is made (the SDK has stored the token and synced).
 */
@Composable
public fun rememberLicenseChoiceState(
    choose: SignInOutcome.Choose,
    client: PolarisKeyClient = polarisKey(),
    onCompleted: (ChoiceCompleted) -> Unit = {},
): PolarisLicenseChoiceState? = rememberLicenseChoiceState(choose, remember(client) { client.licenseChoiceActions() }, onCompleted)

/** As above over any [PolarisLicenseChoiceActions] (a fake in a test, or a host's own transport). */
@Composable
public fun rememberLicenseChoiceState(
    choose: SignInOutcome.Choose,
    actions: PolarisLicenseChoiceActions,
    onCompleted: (ChoiceCompleted) -> Unit = {},
): PolarisLicenseChoiceState? {
    val scope = rememberCoroutineScope()
    val latest = rememberUpdatedState(onCompleted)
    val first: LicenseChoiceView? = remember(choose.grant) { PolarisLicenseChoiceState.firstView(choose) }
    return remember(choose.grant, actions, scope) {
        first?.let { PolarisLicenseChoiceState(actions, scope, choose.grant, it, onCompleted = { done -> latest.value(done) }) }
    }
}
