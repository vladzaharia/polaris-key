// @pkey-feature connect.local ui.kit
// The camera screens of Pair with a Code (CC-29K.3): the pre-prompt, the scan view and camera off, and the "... instead" link the choose,
// show and field screens draw when the device can scan. The Play build never reaches the camera screens (Google's scanner is its own
// sheet); they are drawn for a host with a camera of its own, from the same states the SwiftUI kit draws.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
private fun ColumnScope.Lede(text: String) {
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(text, textAlign = TextAlign.Start)
}

/** A "… instead" link when the state draws it, else null. */
@Composable
internal fun linkFor(c: PairCtx, key: String, action: () -> Unit): Pair<String, () -> Unit>? = if (c.lines.text(key) !=
    null
) {
    c.button(key) to action
} else {
    null
}

/**
 * The camera screens (pre-prompt, scan, camera off). The Play build never reaches them (Google's scanner is its own sheet); they are
 * drawn for a host with a camera of its own, from the same states the SwiftUI kit draws.
 */
@Composable
internal fun ColumnScope.PairScan(c: PairCtx) {
    when (c.ui.step) {
        "scan-prompt" -> {
            Lede(c.text("localPairing.cameraPrePrompt"))
            Spacer(Modifier.height(polarisWindow.section))
            PolarisPrimaryButton(c.button("common.continue"), c.actions::continueToCamera, initialFocus = false)
            PairLink(c.button("localPairing.enterInstead"), c.actions::enterInstead)
        }

        "scan" -> {
            Lede(c.text("localPairing.scanBody"))
            Spacer(Modifier.height(PolarisSpace.medium))
            Box(
                Modifier.fillMaxWidth().height(CAMERA_HEIGHT).background(MaterialTheme.colorScheme.scrim).semantics {
                    contentDescription =
                        c.text("a11y.cameraView")
                },
            )
            c.lines.text("localPairing.otherApp")?.let {
                Spacer(Modifier.height(PolarisSpace.controls))
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(PolarisSpace.medium))
            Shares(c.lines, c.ui.categories, c.labels)
            Spacer(Modifier.height(polarisWindow.section))
            PairActionRow(c.button("common.cancel"), c.actions::cancel, c.button("localPairing.enterInstead") to c.actions::enterInstead)
        }

        else -> {
            Spacer(Modifier.height(PolarisSpace.tight))
            Text(c.text("localPairing.cameraOffTitle"), style = MaterialTheme.typography.titleMedium)
            Lede(c.text("localPairing.cameraOffBody"))
            Spacer(Modifier.height(PolarisSpace.medium))
            Shares(c.lines, c.ui.categories, c.labels)
            Spacer(Modifier.height(polarisWindow.section))
            if (c.lines.text("localPairing.openSettings") != null) {
                PolarisPrimaryButton(c.button("localPairing.openSettings"), c.actions::openSettings, initialFocus = false)
            }
            PairActionRow(c.button("common.cancel"), c.actions::cancel, c.button("localPairing.enterInstead") to c.actions::enterInstead)
        }
    }
}

private val CAMERA_HEIGHT = 280.dp
