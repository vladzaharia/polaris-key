// The Cloud Sync screens (U-42; ui-matrix `cloudSync` family): UnlockSync (the recovery code, start
// over), RecoveryCode (shown once) and RingChange (confirm a changed ring). Each draws the catalog
// lines of a KitScreen that KitStates resolved, the way the styled parts do, so the same inputs draw
// the same screen as the other kits. They are stateless over their callbacks; PolarisSyncFlow wires
// them to PolarisSyncState, whose verbs are `client.keyring`'s (unlock, recover, reset, create,
// setRecoveryCode, acceptRingChange).
//
// Security points kept here (S5, S13, T22, T23):
//  - the recovery code the person types lives in this composition only (never saved state), and the
//    shown code is never an input;
//  - both code screens say "No one will ever ask for this code";
//  - Start over opens its warning first and Cancel takes the first focus there, never the confirm;
//  - the copied code is flagged sensitive for the clipboard.
// A screen reader lands on the title as a step opens (PolarisTitle); the wait indicator is still
// under Reduce motion.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

// ── UnlockSync ───────────────────────────────────────────────────────────────────────────────

/**
 * UnlockSync (UI-KITS.md 4.1): the recovery code and Start over. The nearby option is not offered in
 * v0.10.0. [screen] is one of the component's states: code, invalid, working, failed or start-over.
 *
 * @param onUnlock the typed code; the host passes it to `client.keyring.recover` and nowhere else.
 */
@Composable
public fun PolarisUnlockSync(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    onUnlock: (String) -> Unit = {},
    onStartOver: () -> Unit = {},
    onConfirmStartOver: () -> Unit = {},
    onRetry: () -> Unit = {},
    onCancel: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
    /** Called when the person edits the code, so the host clears an `invalid` step. */
    onEdit: () -> Unit = {},
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    // Held across the steps, so a code that failed its check stays in the field to fix; never saved state.
    var code by remember { mutableStateOf("") }
    val back = PolarisBackHandler(enabled = true, onBack = onCancel)
    val host = modifier.then(back)
    when (screen.state) {
        "working" -> PolarisSyncStep(host, title = lines.text("unlockSync.title").orEmpty()) {
            Spacer(Modifier.height(PolarisSpace.group))
            PolarisProgress(lines.text("common.working").orEmpty())
        }

        "failed" -> PolarisSyncStep(
            host,
            title = lines.text("unlockSync.title").orEmpty(),
            actions = {
                PolarisPrimaryButton(lines.text("common.tryAgain").orEmpty(), onRetry, initialFocus = true)
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
            },
        ) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisErrorLine(lines.text("unlockSync.failed").orEmpty())
        }

        "start-over" -> PolarisSyncStep(
            host,
            title = lines.text("unlockSync.startOverTitle").orEmpty(),
            actions = {
                // Start over first, in the danger fill; Cancel last and first to take focus (T22).
                PolarisPrimaryButton(lines.text("unlockSync.startOverConfirm").orEmpty(), onConfirmStartOver, danger = true)
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel, initialFocus = true)
            },
        ) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(lines.text("unlockSync.startOverWarning").orEmpty(), textAlign = TextAlign.Start)
        }

        else -> {
            // "That code isn't right" goes as soon as the person edits (the host's step follows through onEdit).
            var edited by remember(screen.state) { mutableStateOf(false) }
            val invalid = screen.state == "invalid" && !edited
            val field = remember { FocusRequester() }
            val screenReader = rememberScreenReaderOn()
            // The field takes the first focus; with a screen reader the heading does (PolarisTitle).
            if (!screenReader && LocalPolarisInitialFocus.current) LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
            val submit = { if (code.isNotBlank()) onUnlock(code) }
            PolarisSyncStep(
                host,
                title = lines.text("unlockSync.title").orEmpty(),
                actions = {
                    PolarisPrimaryButton(lines.text("unlockSync.unlock").orEmpty(), submit, enabled = code.isNotBlank())
                    Spacer(Modifier.height(PolarisSpace.controls))
                    lines.text("unlockSync.startOver")?.let { PolarisTextButton(it, onStartOver) }
                    PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
                },
            ) {
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisBody(lines.text("unlockSync.lede").orEmpty(), textAlign = TextAlign.Start)
                Spacer(Modifier.height(PolarisSpace.medium))
                val paste = lines.format("common.paste")
                PolarisTextField(
                    value = code,
                    onValueChange = {
                        code = it
                        edited = true
                        onEdit()
                    },
                    label = lines.text("unlockSync.field").orEmpty(),
                    error = if (invalid) lines.text("unlockSync.invalid") else null,
                    focusRequester = field,
                    monospace = true,
                    trailing = {
                        PolarisPasteButton(paste) {
                            code = it
                            edited = true
                            onEdit()
                        }
                    },
                    // A secret: no suggestions, no autocorrect, no learning.
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Characters,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { submit() }, onGo = { submit() }),
                )
                Spacer(Modifier.height(PolarisSpace.medium))
                lines.text("recoveryCode.noAsk")?.let { PolarisInlineNotice(it) }
            }
        }
    }
}

private const val LARGE_TYPE = 1.5f

// ── RecoveryCode ─────────────────────────────────────────────────────────────────────────────

/**
 * RecoveryCode: the new code, shown once and never an input. Copy code puts it on the clipboard,
 * flagged sensitive; "I've saved my recovery code" must be ticked before Done appears.
 *
 * @param code what to draw, from `client.keyring` (create, reset or setRecoveryCode); the kit keeps it nowhere.
 */
@Composable
public fun PolarisRecoveryCodeScreen(
    screen: KitScreen,
    code: PolarisRecoveryCode,
    modifier: Modifier = Modifier,
    onSavedChange: (Boolean) -> Unit = {},
    onDone: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val saved = screen.state == "saved"
    val clipboard = rememberPolarisClipboard()
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    val copy = lines.text("recoveryCode.copy").orEmpty()
    // Back and the system gesture do nothing until the code is marked saved; then they are Done.
    PolarisSyncStep(
        modifier.then(PolarisBackHandler(enabled = true) { if (saved) onDone() }),
        title = lines.text("recoveryCode.title").orEmpty(),
        actions = {
            lines.text("common.done")?.let { PolarisPrimaryButton(it, onDone, initialFocus = true) }
        },
    ) {
        Spacer(Modifier.height(PolarisSpace.tight))
        PolarisBody(lines.text("recoveryCode.lede").orEmpty(), textAlign = TextAlign.Start)
        Spacer(Modifier.height(PolarisSpace.medium))
        PolarisSection(title = null) {
            // A grid of whole groups, four to a row (two at a large font), so a group never splits (8 groups of 4).
            val perRow = if (LocalDensity.current.fontScale >= LARGE_TYPE) 2 else 4
            Column(
                Modifier.fillMaxWidth().padding(16.dp).semantics(mergeDescendants = true) {},
                verticalArrangement = Arrangement.spacedBy(PolarisSpace.tight),
            ) {
                for (row in code.reveal().split('-').chunked(perRow)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.medium)) {
                        for (group in row) {
                            Text(
                                group,
                                style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurface,
                                softWrap = false,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        // A short last row keeps its column widths.
                        repeat(perRow - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        Spacer(Modifier.height(PolarisSpace.controls))
        PolarisSecondaryButton(
            if (copied) lines.format("common.copied") else copy,
            onClick = {
                scope.launch { copied = clipboard.setText(copy, code.reveal(), sensitive = true) }
            },
        )
        Spacer(Modifier.height(PolarisSpace.medium))
        lines.text("recoveryCode.noAsk")?.let { PolarisInlineNotice(it) }
        Spacer(Modifier.height(PolarisSpace.medium))
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .toggleable(value = saved, role = Role.Checkbox, onValueChange = onSavedChange),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = saved, onCheckedChange = null)
            Spacer(Modifier.width(12.dp))
            Text(lines.text("recoveryCode.saved").orEmpty(), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

// ── RingChange ───────────────────────────────────────────────────────────────────────────────

/**
 * RingChange: the sync key changed. It names the device (or says a device did), warns, and offers
 * the recovery code first. "That was me" appears only when a ring was served to confirm; the host
 * hands that ring, never a fresh read, to `client.keyring.acceptRingChange`.
 */
@Composable
public fun PolarisRingChange(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    onAccept: () -> Unit = {},
    onUseCode: () -> Unit = {},
    onCancel: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val body = lines.text("ringChange.body") ?: lines.text("ringChange.bodyUnknown").orEmpty()
    PolarisSyncStep(
        modifier.then(PolarisBackHandler(enabled = true, onBack = onCancel)),
        title = lines.text("ringChange.title").orEmpty(),
        actions = {
            PolarisPrimaryButton(lines.text("ringChange.useCode").orEmpty(), onUseCode, initialFocus = true)
            lines.text("ringChange.accept")?.let {
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisSecondaryButton(it, onAccept)
            }
            Spacer(Modifier.height(PolarisSpace.controls))
            PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
        },
    ) {
        Spacer(Modifier.height(PolarisSpace.tight))
        PolarisBody(body, textAlign = TextAlign.Start)
        Spacer(Modifier.height(PolarisSpace.medium))
        lines.text("ringChange.warning")?.let { PolarisInlineNotice(it) }
    }
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────

/**
 * The unlock flow drawn from [state]: the step's screen, its controls bound to the state's verbs.
 * [onDone] is called once when the device is unlocked (or a new code is confirmed saved). Nothing
 * draws while the flow is idle. [base] carries the host's other matrix inputs (services, platform).
 */
@Composable
public fun PolarisSyncFlow(
    state: PolarisSyncState,
    modifier: Modifier = Modifier,
    onDone: () -> Unit = {},
    base: Map<String, JsonElement> = emptyMap(),
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    val ui by state.ui.collectAsState()
    val step = ui
    if (step == PolarisSyncUi.Done) {
        LaunchedEffect(step) { onDone() }
        return
    }
    val screen = remember(step) { step.kitScreen(base) } ?: return
    when (step) {
        is PolarisSyncUi.Unlock -> PolarisUnlockSync(
            screen, modifier, state::submitCode, state::startOver, state::confirmStartOver, state::retry, state::cancel,
            catalog, locale, state::editCode,
        )

        is PolarisSyncUi.RecoveryCode -> PolarisRecoveryCodeScreen(
            screen,
            step.code,
            modifier,
            state::markSaved,
            state::done,
            catalog,
            locale,
        )

        is PolarisSyncUi.RingChange -> PolarisRingChange(
            screen,
            modifier,
            state::acceptRingChange,
            state::useRecoveryCode,
            state::cancel,
            catalog,
            locale,
        )

        else -> Unit
    }
}

// ── Parts ────────────────────────────────────────────────────────────────────────────────────

/** One focused step: a start-aligned title (the heading), its content and a docked action group. */
@Composable
private fun PolarisSyncStep(
    modifier: Modifier,
    title: String,
    actions: (@Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit)? = null,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    PolarisScaffold(
        modifier = modifier,
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        actions = actions,
        dockActionsAtLargeType = true,
    ) {
        PolarisProductHeader()
        PolarisTitle(title)
        content()
    }
}

/** A failure the person can act on: the warning glyph and the sentence, announced as it appears. */
@Composable
private fun PolarisErrorLine(text: String) {
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Assertive },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(PolarisSymbols.Warning, contentDescription = null, tint = PolarisTheme.status.danger, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
    }
}
