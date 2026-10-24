// The sample's navigation (UK-09b.3, UI-KITS.md D-3): navigation-compose is the host's, the kit's screens are its
// destinations, and a deep link reaches them only through PolarisKeyLinks.
//
//   adb shell am start -a android.intent.action.VIEW -d tidewater://polaris/account
//   adb shell am start -a android.intent.action.VIEW -d 'tidewater://polaris?route=devices'
//
// The manifest's intent filter admits tidewater://polaris; PolarisKeyLinks admits only the five routes (account,
// devices, settings, update, sign-in) and refuses everything else. Navigation's own `deepLinks` are not used:
// they would open a destination without the allow-list. A link waits until the gate has let the product through,
// so an unlicensed device is never taken past it. One that opens nothing says so.

package im.plrs.key.samples.composeandroid

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.ui.PolarisAccount
import im.plrs.key.ui.PolarisDevices
import im.plrs.key.ui.PolarisDevicesState
import im.plrs.key.ui.PolarisKeyLinks
import im.plrs.key.ui.PolarisKeyRoute
import im.plrs.key.ui.PolarisSettings
import im.plrs.key.ui.PolarisSettingsState
import im.plrs.key.ui.PolarisUpdatePromptDialog
import im.plrs.key.ui.PolarisUpdateState
import im.plrs.key.ui.devicesActions
import im.plrs.key.ui.polarisLinkUnavailable
import im.plrs.key.ui.settingsActions
import im.plrs.key.ui.updateActions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The return URI this app declares: the manifest's intent filter and [PolarisKeyLinks] agree on it. */
internal const val RETURN_URI = "tidewater://polaris"

private const val HOME = "home"

/** The product's own screen, shown once the licence allows it: home, and the kit's screens as destinations. */
@Composable
internal fun TidewaterApp(client: PolarisKeyClient, world: Tidewater?, options: Options, link: String?, onLinkHandled: () -> Unit) {
    val scope = rememberCoroutineScope()
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    val links = remember(client) { PolarisKeyLinks(RETURN_URI, client) }
    val settings = remember(client) { PolarisSettingsState(client.settingsActions(editable = true), scope) }
    val devices = remember(client) { PolarisDevicesState(client.devicesActions(), scope) }

    // Fixtures: the update comes from the sample, because the scripted Worker serves no signed feed. Live, the
    // kit's own PolarisKeyGate offers the real one, so this holder stays empty.
    val update = remember(world) { PolarisUpdateState() }
    val actions = world?.updateActions ?: client.updateActions()
    LaunchedEffect(world) {
        if (world == null) return@LaunchedEffect
        update.follow(actions, this)
        if (options.start == Start.Update || options.start == Start.Progress) {
            delay(1_500)
            update.show(world.offer())
            if (options.start == Start.Progress) update.install(actions, scope)
        }
    }
    val offer by update.offer.collectAsState()
    offer?.let { ui ->
        PolarisUpdatePromptDialog(
            ui,
            onUpdate = { update.install(actions, scope) },
            onLater = update::dismiss,
            onSkip = if (ui.mandatory) null else update::skip,
        )
    }

    val unavailable = polarisLinkUnavailable()
    LaunchedEffect(link) {
        val uri = link ?: return@LaunchedEffect
        val route = links.handle(uri)
        val opened = when (route) {
            PolarisKeyRoute.Account, PolarisKeyRoute.Devices, PolarisKeyRoute.Settings -> {
                // handle() suspends on the client's sync; the NavController's lifecycle needs the main thread.
                withContext(Dispatchers.Main.immediate) { nav.go(route) }
                true
            }
            // Fixtures only: the live kit offers the real update by itself.
            PolarisKeyRoute.Update -> world?.let { update.show(it.offer()) } != null
            // Already signed in: the kit's sign-in belongs to the gate and has nothing to open here.
            PolarisKeyRoute.SignIn, null -> false
        }
        if (!opened) {
            snackbar.currentSnackbarData?.dismiss()
            scope.launch { snackbar.showSnackbar(unavailable) }
        }
        onLinkHandled()
    }

    val start = if (options.start == Start.Account) PolarisKeyRoute.Account.wire else HOME
    Column(Modifier.fillMaxSize()) {
        NavHost(nav, startDestination = start, modifier = Modifier.weight(1f)) {
            composable(HOME) { Home(world, onAccount = { nav.go(PolarisKeyRoute.Account) }, onCheck = { world?.let { update.show(it.offer()) } }) }
            composable(PolarisKeyRoute.Account.wire) { PolarisAccount(settings, devices) }
            composable(PolarisKeyRoute.Devices.wire) { PolarisDevices(devices) }
            composable(PolarisKeyRoute.Settings.wire) { PolarisSettings(settings) }
        }
        SnackbarHost(snackbar, Modifier.safeDrawingPadding())
    }
}

/** One copy of each destination, whatever the order the links arrive in. */
private fun NavHostController.go(route: PolarisKeyRoute) = navigate(route.wire) { launchSingleTop = true }

@Composable
private fun Home(world: Tidewater?, onAccount: () -> Unit, onCheck: () -> Unit) {
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.licensed_title), style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
        Text(stringResource(R.string.licensed_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
        Button(onClick = onAccount) { Text(stringResource(R.string.open_account)) }
        if (world != null) {
            OutlinedButton(onClick = onCheck) { Text(stringResource(R.string.check_updates)) }
        }
    }
}
