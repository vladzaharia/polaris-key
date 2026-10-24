// The Compose Android sample (UK-09b.2): the kit's PolarisKeyGate over Tidewater fixtures, or live. See README.md.

package im.plrs.key.samples.composeandroid

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.PolarisBranding
import im.plrs.key.ui.PolarisKeyGate
import im.plrs.key.ui.PolarisTheme

class MainActivity : ComponentActivity() {
    /** The link waiting to be handled (set by a launch or [onNewIntent]); Navigation.kt consumes it. */
    private var link by mutableStateOf<String?>(null)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        link = intent.dataString
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val options = Options.from(intent)
        // One world per process and start: a rotation or a theme change must not forget that the device is activated.
        val world = if (options.live) null else World.of(options.start)
        val client = world?.client ?: liveClient(applicationContext)
        // A link that started this activity; a rotation must not replay it.
        if (savedInstanceState == null) link = intent?.dataString
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
                            PolarisKeyGate(client, signIn = true) { TidewaterApp(client, world, options, link) { link = null } }
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

