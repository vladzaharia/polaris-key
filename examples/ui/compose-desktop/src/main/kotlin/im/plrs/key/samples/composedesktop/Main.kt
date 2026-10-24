// The Compose desktop sample (UK-10.10): the kit's real windows over Tidewater fixtures, or `--live` over the
// OS keyring and the desktop updater. See README.md for the flags.

package im.plrs.key.samples.composedesktop

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import im.plrs.key.core.CoreOptions
import im.plrs.key.desktop.PolarisKeyDesktop
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.ui.PolarisBranding
import im.plrs.key.ui.PolarisCopy
import im.plrs.key.ui.PolarisKeyWindow
import im.plrs.key.ui.PolarisKeyWindowState
import im.plrs.key.ui.PolarisSettingsPane
import im.plrs.key.ui.rememberPolarisOpener
import im.plrs.key.update.UpdateClientOptions
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The kit's test hook for the platform variant (`PolarisPlatformVariant.FORCE_PROPERTY`). */
private const val FORCE_PLATFORM = "pkey.kit.platform"

fun main(args: Array<String>) {
    val options = Options.parse(args)
    options.platform?.let {
        System.setProperty(FORCE_PLATFORM, when (it) { "macos" -> "MacOS"; "windows" -> "Windows"; else -> "Gnome" })
    }
    if (options.smoke) {
        // The gate must be reached on the fixtures; a hang is a failure, not a pass.
        Thread {
            Thread.sleep(60_000)
            System.err.println("smoke: the gate was not reached in 60 s")
            Runtime.getRuntime().halt(1)
        }.apply { isDaemon = true; start() }
    }
    options.shots?.let { Shots(it, options).launch() }

    application {
        val scope = rememberCoroutineScope()
        val world = remember { if (options.live) null else Tidewater(options.start) }
        val client = remember { world?.client ?: liveClient() }
        val windowState = remember { PolarisKeyWindowState().also { Hooks.windowState = it } }
        val title = if (options.live) client.product else PRODUCT_NAME
        PolarisKeyWindow(
            client = client,
            title = title,
            state = windowState,
            windowState = rememberWindowState(size = DpSize(options.width.dp, options.height.dp), position = WindowPosition(Alignment.Center)),
            branding = if (options.polaris) PolarisBranding.PolarisKey else PolarisBranding.None,
            signIn = true,
            fullSizeContent = options.fullSize,
            // Fixtures never quit: the installer is a fake. Live, the kit quits once the verified installer is open.
            onQuit = if (world == null) ::exitApplication else ({ println("fixtures: the installer would open and ${PRODUCT_NAME} would quit") }),
            onSignOut = { scope.launch { client.license.deactivate() } },
            darkTheme = options.dark,
            copy = PolarisCopy(productName = title),
            decide = { world?.decide() ?: client.update.decide() },
        ) {
            TidewaterApp(title, smoke = options.smoke, openLink = options.openLink)
        }
        LaunchedEffect(options.start) {
            when (options.start) {
                Start.Update, Start.Progress -> { delay(2_500); windowState.requestCheck() }
                Start.Settings -> windowState.settings.open(PolarisSettingsPane.Account)
                Start.Devices -> windowState.settings.open(PolarisSettingsPane.Devices)
                else -> Unit
            }
        }
    }
}

/** The product's own screen, shown once the licence allows it. */
@Composable
private fun TidewaterApp(title: String, smoke: Boolean, openLink: String?) {
    val opener = rememberPolarisOpener()
    LaunchedEffect(smoke) {
        if (smoke) {
            if (openLink != null) {
                // The Flatpak portal check: the link goes through the kit's opener, and the Settings-portal reads
                // (made when the window opened) get a moment to land before the process exits.
                println("smoke: link ${if (opener(openLink)) "handed to the desktop" else "refused"}")
                delay(2_000)
            }
            println("smoke: the gate let $title through")
            exitProcess(0)
        }
    }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
        Text("Licensed. Use the menu to check for updates or manage the license.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** `--live`: the OS keyring and the desktop updater, configured like `sample-cli` (PKEY_PRODUCT, PKEY_BASE_URL, PKEY_TRUST). */
private fun liveClient(): PolarisKeyClient {
    fun env(name: String) = System.getenv(name)?.takeIf { it.isNotBlank() }
    fun keys(text: String?): Map<String, String> =
        text.orEmpty().split(',').mapNotNull { pair -> pair.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() } }.toMap()
    val product = env("PKEY_PRODUCT") ?: run {
        System.err.println("--live needs PKEY_PRODUCT (and PKEY_TRUST=k1=<key>; PKEY_BASE_URL defaults to https://key.plrs.im)")
        exitProcess(64)
    }
    val core = CoreOptions(
        productSlug = product, version = env("PKEY_VERSION") ?: "1.0.0", pinnedKeys = keys(env("PKEY_TRUST")),
        baseUrl = env("PKEY_BASE_URL") ?: "https://key.plrs.im",
    )
    return PolarisKeyDesktop.client(PolarisKeyClientOptions(core = core, update = UpdateClientOptions(pinnedReleaseKeys = keys(env("PKEY_RELEASE_KEYS")))))
}
