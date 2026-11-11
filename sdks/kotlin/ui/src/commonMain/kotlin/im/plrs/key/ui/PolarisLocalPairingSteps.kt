// @pkey-feature connect.local ui.kit
// The steps of Pair with a Code other than show (CC-29K.2): choose, closed, enter, confirm, waiting, paired, failed and the refusals.
// First focus on a consent is Not now, never Pair; a control drawn but unavailable stays pressable, dimmed, with its reason as state.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign

private const val DIMMED = 0.5f

@Composable
private fun ColumnScope.Lede(text: String) {
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(text, textAlign = TextAlign.Start)
}

@Composable
internal fun ColumnScope.PairChoose(c: PairCtx) {
    Lede(if (c.ui.full) "" else c.text("localPairing.chooseBody"))
    if (c.ui.full) {
        PairNotice(
            c.text("core.codes.local-links-full.title"),
            c.lines.text("core.codes.local-links-full.message"),
            action = c.lines.text("localPairing.pairedDevices")?.let { it to c.actions::openPairedDevices },
        )
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    // Either device can show the code: neither way is the filled one.
    Column(Modifier.fillMaxWidth().alpha(if ("localPairing.show" in c.disabled) DIMMED else 1f)) {
        PolarisSecondaryButton(c.button("localPairing.show"), c.actions::show)
        Spacer(Modifier.height(PolarisSpace.controls))
        PolarisSecondaryButton(c.button("localPairing.enter"), c.actions::enter)
    }
    c.lines.text("localPairing.prePrompt")?.let {
        Spacer(Modifier.height(PolarisSpace.controls))
        Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Spacer(Modifier.height(polarisWindow.section))
    PairActionRow(c.button("common.cancel"), c.actions::close, initialFocus = false)
}

@Composable
internal fun ColumnScope.PairClosed(c: PairCtx) {
    Lede(c.lines.text("localPairing.failedTooMany") ?: c.text("localPairing.failedExpired"))
    if (c.ui.warn) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(c.text("localPairing.tooManyAgainTitle"), c.lines.text("localPairing.tooManyAgainBody"), warning = true)
    }
    Spacer(Modifier.height(polarisWindow.section))
    val cooling = "localPairing.showNewIn" in c.disabled
    // The wait is stated in the label (its line carries the time) and the dimmed button says why it is not yet available.
    val label = if (cooling) c.text("localPairing.showNewIn") else c.button("localPairing.showNew")
    Column(Modifier.fillMaxWidth()) {
        Column(Modifier.alpha(if (cooling) DIMMED else 1f).semantics { if (cooling) stateDescription = label }) {
            PolarisPrimaryButton(label, { if (!cooling) c.actions.showNew() }, initialFocus = !cooling)
        }
        Spacer(Modifier.height(PolarisSpace.controls))
        PairActionRow(c.button("common.close"), c.actions::close, initialFocus = false)
    }
}

@Composable
internal fun ColumnScope.PairEnter(c: PairCtx) {
    val joining = c.ui.step == "joining"
    Lede(c.text("localPairing.enterBody"))
    if (c.ui.error == "too-many" || c.ui.error == "not-found") {
        Spacer(Modifier.height(PolarisSpace.controls))
        val key = if (c.ui.error == "too-many") "localPairing.cooldown" else "localPairing.notFound"
        PairNotice(c.text("${key}Title"), c.lines.text("${key}Body"))
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    val message = listOf("localPairing.wrongCode", "localPairing.notACode", "localPairing.spentCode").firstNotNullOfOrNull(c.lines::text)
    PairCodeField(c, message, joining)
    if (joining) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairWait(c.text("a11y.busy"))
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    Shares(c.lines, c.ui.categories, c.labels)
    Spacer(Modifier.height(PolarisSpace.group))
    val dim = !joining && "localPairing.pair" in c.disabled
    Column(Modifier.alpha(if (dim) DIMMED else 1f).semantics { if (dim && message != null) stateDescription = message }) {
        PolarisPrimaryButton(c.button("localPairing.pair"), { if (!joining) c.actions.pair() })
    }
    Spacer(Modifier.height(PolarisSpace.controls))
    if (joining) {
        PairActionRow(c.button("common.cancel"), c.actions::cancel, initialFocus = false)
    } else {
        PairActionRow(c.button("common.back"), c.actions::back, c.button("localPairing.toShow") to c.actions::show, initialFocus = false)
    }
}

@Composable
private fun PairCodeField(c: PairCtx, message: String?, joining: Boolean) {
    val invalid = c.ui.error == "wrong" || c.ui.error == "not-a-code"
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    PolarisTextField(
        value = c.ui.entry.orEmpty(),
        onValueChange = c.actions::setEntry,
        label = c.text("localPairing.codeLabel"),
        placeholder = c.lines.text("localPairing.codePlaceholder"),
        enabled = !joining,
        error = if (invalid) message else null,
        supporting = listOfNotNull(message.takeIf { !invalid }, c.lines.text("localPairing.triesLeft").takeIf { !joining }),
        focusRequester = focus,
        monospace = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { c.actions.pair() }),
    )
}

@Composable
internal fun ColumnScope.PairConfirm(c: PairCtx, armed: Boolean) {
    Lede(c.text("localPairing.confirmBody"))
    Spacer(Modifier.height(PolarisSpace.medium))
    Shares(c.lines, c.ui.categories, c.labels)
    Spacer(Modifier.height(polarisWindow.section))
    val busy = c.ui.busy
    // The first focus is the safe verb, never Pair: a stray Enter or D-pad press never pairs.
    Column(Modifier.fillMaxWidth().alpha(if (busy == "not-now") DIMMED else 1f)) {
        PolarisPrimaryButton(c.button("localPairing.pair"), { if (armed && busy == null) c.actions.confirm() })
    }
    Spacer(Modifier.height(PolarisSpace.controls))
    Column(Modifier.fillMaxWidth().alpha(if (busy == "pair") DIMMED else 1f)) {
        PolarisSecondaryButton(c.button("common.notNow"), { if (armed && busy == null) c.actions.notNow() }, initialFocus = true)
    }
    if (busy != null) {
        Spacer(Modifier.height(PolarisSpace.controls))
        PairWait(c.text("a11y.busy"))
    }
}

@Composable
internal fun ColumnScope.PairWaiting(c: PairCtx) {
    Spacer(Modifier.height(PolarisSpace.medium))
    // The title says the wait; the line says with whom, and only when the other device named itself.
    c.lines.text("localPairing.waitingWith")?.let {
        PairWait(it)
        Spacer(Modifier.height(PolarisSpace.medium))
    }
    Shares(c.lines, c.ui.categories, c.labels)
    Spacer(Modifier.height(polarisWindow.section))
    PairActionRow(c.button("common.cancel"), c.actions::cancel)
}

@Composable
internal fun ColumnScope.PairPaired(c: PairCtx) {
    Lede(c.text("localPairing.pairedBody"))
    if (c.ui.cantConnect) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(
            c.text("localPairing.cantConnectTitle"),
            c.lines.text("localPairing.cantConnectBody"),
            action = c.lines.text("localPairing.pairedDevices")?.let { it to c.actions::openPairedDevices },
        )
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    PolarisTextField(
        value = c.ui.name,
        onValueChange = c.actions::setName,
        label = c.text("localPairing.nameLabel"),
        error = if (c.ui.nameError) c.lines.text("devices.renameFailed") else null,
        supporting = listOfNotNull(c.lines.text("localPairing.nameHint").takeIf { !c.ui.nameError }),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { c.actions.done() }),
    )
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(listOf(ConnectButton(c.button("common.done"), c.actions::done, primary = true, focus = true)))
}

/** Failed, the network answer and the refusals: the reason first, then the way out (Close is never the filled one on a refusal). */
@Composable
internal fun ColumnScope.PairEnding(c: PairCtx) {
    when (c.ui.step) {
        "failed" -> {
            val full = c.ui.reason == "full"
            Spacer(Modifier.height(PolarisSpace.tight))
            ConnectNotice(c.reason)
            Spacer(Modifier.height(polarisWindow.section))
            val retry = ConnectButton(c.button("common.tryAgain"), c.actions::retry, primary = !full, focus = !full)
            val close = ConnectButton(c.button("common.close"), c.actions::close, primary = full, focus = full)
            ConnectActions(if (full) listOf(close, retry) else listOf(retry, close))
        }

        "network-blocked" -> {
            Spacer(Modifier.height(polarisWindow.section))
            val settings = c.ui.canOpenSettings
            ConnectActions(
                buildList {
                    if (settings) add(ConnectButton(c.button("localPairing.openSettings"), c.actions::openSettings, primary = true, focus = true))
                    add(ConnectButton(c.button("common.tryAgain"), c.actions::retry, primary = !settings, focus = !settings))
                    add(ConnectButton(c.button("common.close"), c.actions::close))
                },
            )
        }

        else -> {
            Spacer(Modifier.height(polarisWindow.section))
            ConnectActions(listOf(ConnectButton(c.button("common.close"), c.actions::close, focus = true)))
        }
    }
}
