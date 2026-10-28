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
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
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
            PolarisWaitIndicator()
            Spacer(Modifier.height(PolarisSpace.controls))
            Text(
                lines.text("common.working").orEmpty(),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
            )
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

        "start-over-failed" -> PolarisSyncStep(
            host,
            title = lines.text("unlockSync.title").orEmpty(),
            actions = {
                PolarisPrimaryButton(lines.text("common.tryAgain").orEmpty(), onRetry, initialFocus = true)
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
            },
        ) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisErrorLine(lines.text("unlockSync.startOverFailed").orEmpty())
        }

        // The account has no recovery code: nothing to enter. Start over opens its warning (it replaces nothing here).
        "no-code" -> PolarisSyncStep(
            host,
            title = lines.text("unlockSync.title").orEmpty(),
            actions = {
                PolarisPrimaryButton(lines.text("unlockSync.startOver").orEmpty(), onStartOver)
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
            },
        ) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(lines.text("unlockSync.noCode").orEmpty(), textAlign = TextAlign.Start)
        }

        "start-over" -> {
            // The confirm takes taps only once the warning has been up for a moment: a double tap on the opener
            // lands on this button, and must not replace the key (T22).
            var armed by remember { mutableStateOf(false) }
            LaunchedEffect(Unit) {
                delay(CONFIRM_ARMING_MS)
                armed = true
            }
            PolarisSyncStep(
                host,
                title = lines.text("unlockSync.startOverTitle").orEmpty(),
                actions = {
                    // Start over first, in the danger fill; Cancel last and first to take focus.
                    PolarisPrimaryButton(
                        lines.text("unlockSync.startOverConfirm").orEmpty(),
                        { if (armed) onConfirmStartOver() },
                        danger = true,
                    )
                    Spacer(Modifier.height(PolarisSpace.controls))
                    PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel, initialFocus = true)
                },
            ) {
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisBody(lines.text("unlockSync.startOverWarning").orEmpty(), textAlign = TextAlign.Start)
            }
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
                        // One line of text, wrapped for the eye: a hardware Enter is not a character of the code.
                        val lineBreak = it.any { c -> c == '\n' || c == '\r' }
                        code = it.filterNot { c -> c == '\n' || c == '\r' }
                        // A physical keyboard's Enter ends the entry, as the Done key does.
                        if (lineBreak) submit()
                        edited = true
                        onEdit()
                    },
                    label = lines.text("unlockSync.field").orEmpty(),
                    error = if (invalid) lines.text("unlockSync.invalid") else null,
                    focusRequester = field,
                    monospace = true,
                    multiline = true,
                    visualTransformation = CodeGroupBreaks,
                    // Paste replaces what is typed, so it shows only while the field is empty.
                    trailing = if (code.isEmpty()) {
                        {
                            PolarisPasteButton(paste) {
                                code = it
                                edited = true
                                onEdit()
                            }
                        }
                    } else {
                        null
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

/**
 * Breaks the typed code only between groups: a zero-width space after each hyphen (a hyphen before a digit
 * is otherwise glued to it, so a line could break inside the next group). The text itself is unchanged.
 */
private val CodeGroupBreaks = VisualTransformation { text ->
    val zwsp = '\u200B'
    val raw = text.text
    val out = buildString {
        for (c in raw) {
            append(c)
            if (c == '-') append(zwsp)
        }
    }
    val toTransformed = IntArray(raw.length + 1)
    var added = 0
    for (i in raw.indices) {
        toTransformed[i] = i + added
        if (raw[i] == '-') added++
    }
    toTransformed[raw.length] = raw.length + added
    TransformedText(
        AnnotatedString(out),
        object : OffsetMapping {
            override fun originalToTransformed(offset: Int): Int = toTransformed[offset.coerceIn(0, raw.length)]

            override fun transformedToOriginal(offset: Int): Int {
                var o = 0
                while (o < raw.length && toTransformed[o + 1] <= offset) o++
                return o
            }
        },
    )
}

private const val CONFIRM_ARMING_MS = 500L

private const val CLIPBOARD_CLEAR_MS = 120_000L

private const val COPIED_MS = 2_000L

/** Clears the clipboard after a recovery code was copied, even after the screen is gone. */
private val clipboardClearScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

// ── RecoveryCode ─────────────────────────────────────────────────────────────────────────────

/**
 * RecoveryCode: the new code, shown once and never an input. Copy code puts it on the clipboard,
 * flagged sensitive (and clears it again after two minutes); "I've saved my recovery code" must be
 * ticked before Done appears. Copy, the tick and Done are the step's actions, so in two panes they
 * sit beside the code and on a phone they dock under it, in view.
 *
 * @param code what to draw, from `client.keyring` (create, reset or setRecoveryCode); the kit keeps it nowhere.
 * @param saved whether the person confirmed they saved it; defaults to the screen's own `saved` state.
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
    saved: Boolean = screen.state == "saved",
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val clipboard = rememberPolarisClipboard()
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(COPIED_MS)
            copied = false
        }
    }
    val copy = lines.text("recoveryCode.copy").orEmpty()
    // Back and the system gesture do nothing until the code is marked saved; then they are Done.
    PolarisSyncStep(
        modifier.then(PolarisBackHandler(enabled = true) { if (saved) onDone() }),
        title = lines.text("recoveryCode.title").orEmpty(),
        actions = {
            PolarisSecondaryButton(
                if (copied) lines.format("common.copied") else copy,
                onClick = {
                    val text = code.reveal()
                    scope.launch { copied = clipboard.setText(copy, text, sensitive = true) }
                    // The code does not stay on the clipboard: cleared after two minutes if it is still there.
                    clipboardClearScope.launch {
                        delay(CLIPBOARD_CLEAR_MS)
                        if (clipboard.getText() == text) clipboard.clear()
                    }
                },
            )
            Spacer(Modifier.height(PolarisSpace.controls))
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .toggleable(value = saved, role = Role.Checkbox, onValueChange = onSavedChange),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // The box grows with the text size, so it stays in proportion to its label at large type.
                val grow = LocalDensity.current.fontScale.coerceIn(1f, 2f)
                Checkbox(checked = saved, onCheckedChange = null, modifier = Modifier.scale(grow))
                Spacer(Modifier.width(PolarisSpace.controls + PolarisSpace.tight * (grow - 1f)))
                Text(
                    lines.text("recoveryCode.saved").orEmpty(),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            if (saved) {
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisPrimaryButton(lines.format("common.done"), onDone, initialFocus = true)
            }
        },
    ) {
        Spacer(Modifier.height(PolarisSpace.tight))
        PolarisBody(lines.text("recoveryCode.lede").orEmpty(), textAlign = TextAlign.Start)
        Spacer(Modifier.height(PolarisSpace.medium))
        PolarisSection(title = null) { PolarisCodeGrid(code.groups(), lines) }
        Spacer(Modifier.height(PolarisSpace.medium))
        lines.text("recoveryCode.noAsk")?.let { PolarisInlineNotice(it) }
    }
}

/**
 * The code as whole groups in rows. How many groups share a row is measured: four when four groups and
 * their gaps fit the width, else two, else one, so a group is never cut or split at any window or font
 * size (DL11). The groups keep their own width and a fixed gap, so they read as one code.
 */
@Composable
private fun PolarisCodeGrid(groups: List<String>, lines: KitLines) {
    val style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val gap = PolarisSpace.medium
    BoxWithConstraints(Modifier.fillMaxWidth().padding(PolarisSpace.medium)) {
        val groupWidth = with(density) { groups.maxOf { measurer.measure(it, style).size.width }.toDp() }
        val perRow = listOf(4, 2).firstOrNull { groupWidth * it + gap * (it - 1) <= maxWidth } ?: 1
        // Spoken as the catalog line with the groups apart, not as one run of characters.
        val spoken = lines.format("a11y.recoveryCode", mapOf("code" to CopyArgument.Text(groups.joinToString(" "))))
        Column(Modifier.clearAndSetSemantics { contentDescription = spoken }, verticalArrangement = Arrangement.spacedBy(PolarisSpace.tight)) {
            for (row in groups.chunked(perRow)) {
                Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                    for (group in row) {
                        Text(group, style = style, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
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
        (lines.text("ringChange.warning") ?: lines.text("ringChange.warningNoServed"))?.let { PolarisInlineNotice(it) }
        lines.text("ringChange.failed")?.let {
            Spacer(Modifier.height(PolarisSpace.controls))
            PolarisErrorLine(it)
        }
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
            saved = step.saved,
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
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(PolarisSymbols.Warning, contentDescription = null, tint = PolarisTheme.status.danger, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
    }
}
