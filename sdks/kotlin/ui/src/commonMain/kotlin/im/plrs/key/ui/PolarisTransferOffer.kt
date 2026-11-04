// @pkey-feature ui.kit
// TransferOffer (CC-19.10; ui-matrix `connect`, D-8): a contact offers to send something. Its label and the name it chose are shown
// and nothing is received until the person presses Accept; then a progress, and Done or a failure that kept nothing. Drawn over
// PolarisTransferOfferState; the Kotlin twin of the React kit's <TransferOffer> and SwiftUI's TransferOffer.
//
// Rules the screens keep:
//  - consent per transfer: Accept never takes the first focus. On a TV or with a keyboard the first focus is Decline, and a press
//    that arrives as the prompt opens is ignored for 250 ms;
//  - the heading carries the name shortened (the middle elided, the extension kept); the whole name sits on its own row, at most
//    three lines, with the size and type when the contact said, all isolated text the contact chose;
//  - a transfer in flight is stopped by its own Cancel; Back and Escape do nothing then, and decline an offer being asked;
//  - a failed transfer says nothing was saved and never reads as received.
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "CyclomaticComplexMethod", "LongParameterList", "LongMethod")

package im.plrs.key.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow

/** The prompt on screen in [offers], or nothing. [onClose] runs when the person closes one (Decline, Done); the next one shows. */
@Composable
public fun PolarisTransferOffer(offers: PolarisTransferOffers, modifier: Modifier = Modifier, onClose: () -> Unit = {}) {
    val current by offers.current.collectAsState()
    current?.let { PolarisTransferOffer(it, modifier, onClose) }
}

/** One offer's prompt, bound to [state]. */
@Composable
public fun PolarisTransferOffer(state: PolarisTransferOfferState, modifier: Modifier = Modifier, onClose: () -> Unit = {}) {
    val ui by state.ui.collectAsState()
    val inputs = PolarisTransferOfferState.inputsFor(ui) ?: return
    val screen = remember(ui) { KitStates.resolve(KitComponent.transferOffer, inputs) }
    PolarisTransferOfferScreen(
        screen,
        name = ui.name,
        modifier = modifier,
        size = ui.size,
        type = ui.type,
        onAccept = state::accept,
        onDecline = {
            state.decline()
            onClose()
        },
        onCancel = state::cancel,
        onDone = {
            state.close()
            onClose()
        },
    )
}

/**
 * TransferOffer's states as the matrix resolves them (ask, receiving, done, failed), stateless over its callbacks. [name] is the file
 * name the contact chose, [size] its size in bytes and [type] its media type when the contact said.
 */
@Composable
public fun PolarisTransferOfferScreen(
    screen: KitScreen,
    name: String,
    modifier: Modifier = Modifier,
    size: Long? = null,
    type: String? = null,
    onAccept: () -> Unit = {},
    onDecline: () -> Unit = {},
    onCancel: () -> Unit = {},
    onDone: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val window = polarisWindow
    // A transfer in flight is stopped by its own Cancel, never by a stray key or gesture.
    val escape: (() -> Unit)? = when (screen.state) {
        "ask" -> onDecline
        "receiving" -> null
        else -> onDone
    }
    val armed = rememberArmed(screen.state, window.tv)
    val host = modifier.then(PolarisBackHandler(enabled = escape != null, onBack = escape ?: {}))
    fun text(key: String): String = lines.text(key).orEmpty()
    // The platform's wording (macOS title case) is for buttons only (S4).
    val variant = polarisCopyVariant()

    fun button(key: String): String = catalog.format(key, locale, variant = variant)
    val title = listOf("transferOffer.ask", "transferOffer.askUnnamed", "transferOffer.receiving", "transferOffer.done", "transferOffer.failed")
        .firstNotNullOfOrNull(lines::text).orEmpty()
    ConnectStep(host, title, screen.state) {
        when (screen.state) {
            "ask" -> {
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisBody(text("transferOffer.askBody"), textAlign = TextAlign.Start)
                Spacer(Modifier.height(PolarisSpace.medium))
                if (name.isNotEmpty()) OfferedFile(name, size, type)
                Spacer(Modifier.height(window.section))
                // Consent is a deliberate press: the first focus is Decline.
                ConnectActions(
                    listOf(
                        ConnectButton(button("transferOffer.accept"), { if (armed) onAccept() }, primary = true),
                        ConnectButton(button("transferOffer.decline"), { if (armed) onDecline() }, focus = true),
                    ),
                )
            }

            "receiving" -> {
                Spacer(Modifier.height(PolarisSpace.group))
                PolarisProgressBar(null, null)
                Spacer(Modifier.height(window.section))
                ConnectActions(listOf(ConnectButton(button("common.cancel"), onCancel, focus = true)))
            }

            "done" -> {
                Spacer(Modifier.height(PolarisSpace.medium))
                PolarisIconBadge(PolarisSymbols.Check, MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
                Spacer(Modifier.height(window.section))
                ConnectActions(listOf(ConnectButton(button("common.done"), onDone, primary = true, focus = true)))
            }

            "failed" -> {
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisErrorLine(text("transferOffer.failedBody"))
                Spacer(Modifier.height(window.section))
                ConnectActions(listOf(ConnectButton(button("common.done"), onDone, primary = true, focus = true)))
            }
        }
    }
}

/** The offered file on its own row: the whole name (three lines at most), then the size and type when the contact said. */
@Composable
private fun OfferedFile(name: String, size: Long?, type: String?) {
    val facts = listOfNotNull(size?.let(KitFormat::bytes), type?.takeIf { it.isNotBlank() }?.let(KitConnect::isolate)).joinToString(" · ")
    PolarisSection(title = null) {
        Column(Modifier.fillMaxWidth().padding(PolarisSpace.medium)) {
            Text(
                KitConnect.isolate(name),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            if (facts.isNotEmpty()) {
                Spacer(Modifier.height(PolarisSpace.hairline))
                Text(facts, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
