// The Compose Android sample (UK-09b.2): the kit's PolarisKeyApp over Tidewater fixtures, or live. See README.md.

package im.plrs.key.samples.composeandroid

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.ui.PolarisAccount
import im.plrs.key.ui.PolarisBranding
import im.plrs.key.ui.PolarisDevicesState
import im.plrs.key.ui.PolarisKeyApp
import im.plrs.key.ui.PolarisSettingsState
import im.plrs.key.ui.PolarisTheme
import im.plrs.key.ui.PolarisUpdatePromptDialog
import im.plrs.key.ui.PolarisUpdateState
import im.plrs.key.ui.devicesActions
import im.plrs.key.ui.settingsActions
import im.plrs.key.ui.updateActions
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val options = Options.from(intent)
        // One world per process and start: a rotation or a theme change must not forget that the device is activated.
        val world = if (options.live) null else World.of(options.start)
        val client = world?.client ?: liveClient(applicationContext)
        setContent {
            val dark = options.dark ?: isSystemInDarkTheme()
            // The native preset draws from the host's own Material theme; Polaris carries its own.
            val host = if (dark) darkColorScheme() else lightColorScheme()
            MaterialTheme(colorScheme = host) {
                PolarisTheme(
                    branding = if (options.polaris) PolarisBranding.PolarisKey else PolarisBranding.None,
                    darkTheme = dark,
                    accent = options.accent,
                ) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        if (client == null) {
                            Text(stringResource(R.string.live_needs_product), Modifier.safeDrawingPadding().padding(24.dp), color = MaterialTheme.colorScheme.error)
                        } else {
                            PolarisKeyApp(client, signIn = true) { TidewaterApp(client, world, options) }
                        }
                    }
                }
            }
        }
    }
}

/** The fixtures, kept for the process; [Start] decides whether the device starts activated. */
internal object World {
    private var held: Pair<Start, Tidewater>? = null

    @Synchronized
    fun of(start: Start): Tidewater = held?.takeIf { it.first == start }?.second ?: Tidewater(start).also { held = start to it }
}

/** The product's own screen, shown once the licence allows it. */
@Composable
private fun TidewaterApp(client: PolarisKeyClient, world: Tidewater?, options: Options) {
    val scope = rememberCoroutineScope()
    var account by rememberSaveable { mutableStateOf(options.start == Start.Account) }
    val settings = remember(client) { PolarisSettingsState(client.settingsActions(editable = true), scope) }
    val devices = remember(client) { PolarisDevicesState(client.devicesActions(), scope) }

    // Fixtures: the update comes from the sample, because the scripted Worker serves no signed feed. Live, the
    // kit's own PolarisKeyApp offers the real one, so this holder stays empty.
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

    if (account) {
        BackHandler { account = false }
        PolarisAccount(settings, devices)
    } else {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.licensed_title), style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
            Text(stringResource(R.string.licensed_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(24.dp))
            Button(onClick = { account = true }) { Text(stringResource(R.string.open_account)) }
            if (world != null) {
                OutlinedButton(onClick = { update.show(world.offer()) }) { Text(stringResource(R.string.check_updates)) }
            }
        }
    }
}
