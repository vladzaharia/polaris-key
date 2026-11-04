// @pkey-feature ui.kit.holders
// The two screens activation without an account adds (UK-43.9), drawn from the holders family of the
// presentation core: ActivateDone (the step after a license key: "<Product> is ready", the license
// line and, once, a quiet recommendation to keep the license in an account) and AddToAccount (name and
// email; the browser confirms the email). They are the views of KitHolderStates.kt, so the same inputs
// draw the same screen as the matrix says.
//
// Rules this file keeps:
//  - Start using is the one primary; the recommendation is a quiet card whose action is tonal; "or
//    continue without an account" is a sentence, never a second control.
//  - The lead-in of a reason (`**Get your license back** if ...`) is a SemiBold run of a
//    buildAnnotatedString; the text is never handed to a markup parser.
//  - The form's title is the action that opened it (`activate.recommend.action`): text, never a button.
//  - Each step is wrapped in key(screen.state), so focus and the screen reader move on every step.
//  - Back and Escape never cancel or decline work in flight: while the sign-in runs they do nothing;
//    Cancel is the one way out. Elsewhere the host's own Back applies.
//  - A busy Continue shows progress and the fields are disabled. Open the browser again and Cancel stay
//    live then: they are the exits from a wait that happens in the browser.
//  - A problem line stays on its screen in the danger tone.
//  - Desktop button order: Windows primary first, GNOME's default pill last, macOS Cancel left of the
//    default with title-case labels (the catalog's `macos` variant).
//  - TV: the controls take D-pad focus; the first one holds it as the screen opens.
@file:Suppress(
    "ktlint:standard:function-naming",
    "FunctionNaming",
    "TooManyFunctions",
    "MatchingDeclarationName",
    "CyclomaticComplexMethod",
    "LongMethod",
    "LongParameterList",
)

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** What each control of a holder screen does. The default of every one is nothing; the host (the gate) wires them. */
internal class HolderHandlers(
    /** "Start using <Product>": the one primary of Done, Added, email-bound and other-account. */
    val onStartUsing: () -> Unit = {},
    /** The recommendation's action, "Sign in as <email>" and the owned step's sign-in: begin the account step. */
    val onAdd: () -> Unit = {},
    /** Continue on the form. */
    val onSubmit: () -> Unit = {},
    val onTryAgain: () -> Unit = {},
    val onReopen: () -> Unit = {},
    val onCancel: () -> Unit = {},
    /** "Sign in to that account" on the owned step. */
    val onSignIn: () -> Unit = {},
    /** "Verify that email" opens the portal. */
    val onVerify: () -> Unit = {},
    /** "Use another account" on the email-bound step. */
    val onOtherAccount: () -> Unit = {},
    /** Done, when the form was opened from Settings. */
    val onDone: () -> Unit = {},
)

/** Whether [screen] is one the holders draw: the two components, or the sign-in form's three holder steps. */
internal fun isHolderScreen(screen: KitScreen): Boolean = when (screen.component) {
    KitComponent.activateDone, KitComponent.addToAccount -> true
    KitComponent.signIn -> screen.state == "key-done" || screen.state == "attach" || screen.state == "added"
    else -> false
}

/**
 * ActivateDone for [screen] (a `KitStates.resolve(KitComponent.activateDone, ...)` answer). Done is a
 * stateless view: the host decides what Start using and the recommendation do.
 */
@Composable
public fun PolarisActivateDone(screen: KitScreen, onStartUsing: () -> Unit, onAdd: () -> Unit, modifier: Modifier = Modifier) {
    PolarisHolderScreen(screen, modifier, handlers = HolderHandlers(onStartUsing = onStartUsing, onAdd = onAdd))
}

/**
 * AddToAccount over [state]. Continue, Try again and Open again run the state's own calls unless the host
 * overrides them (a gate arms its browser tab first when [PolarisAddToAccountState.willOpenBrowser] says
 * the press will open one). [onCancel] runs after the state let go of the attempt; [onStartUsing] and the
 * rest are the screen's exits.
 */
@Composable
public fun PolarisAddToAccount(
    state: PolarisAddToAccountState,
    modifier: Modifier = Modifier,
    onStartUsing: () -> Unit = {},
    onCancel: () -> Unit = {},
    onSignIn: () -> Unit = {},
    onVerify: () -> Unit = {},
    onOtherAccount: () -> Unit = {},
    onDone: () -> Unit = {},
    onSubmit: () -> Unit = { state.submit() },
    onTryAgain: () -> Unit = { state.tryAgain() },
    onReopen: () -> Unit = { state.reopen() },
) {
    val ui by state.ui.collectAsState()
    val screen = remember(ui) { state.screen() }
    PolarisHolderScreen(
        screen,
        modifier,
        ui = ui,
        onNameChange = { state.setField(AddToAccountField.Name, it) },
        onEmailChange = { state.setField(AddToAccountField.Email, it) },
        handlers = HolderHandlers(
            onStartUsing = onStartUsing,
            onSubmit = onSubmit,
            onTryAgain = onTryAgain,
            onReopen = onReopen,
            onCancel = {
                state.cancel()
                onCancel()
            },
            onSignIn = onSignIn,
            onVerify = onVerify,
            onOtherAccount = onOtherAccount,
            onDone = onDone,
        ),
    )
}

/** One control of a holder screen, before it is placed. */
private class HolderButton(
    val label: String,
    val onClick: () -> Unit,
    val enabled: Boolean = true,
    val busy: Boolean = false,
    val external: Boolean = false,
)

@Composable
internal fun PolarisHolderScreen(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    ui: PolarisAddToAccountUi = PolarisAddToAccountUi(),
    onNameChange: (String) -> Unit = {},
    onEmailChange: (String) -> Unit = {},
    handlers: HolderHandlers = HolderHandlers(),
) {
    if (screen.isHidden || !isHolderScreen(screen)) return
    val catalog = remember { KitCopy.bundled }
    val locale = kitLocale()
    val variant = polarisCopyVariant()
    val lines = remember(screen, catalog, locale, variant) { HolderLines(screen, catalog, locale, variant) }
    val product = remember(screen) {
        screen.copy.firstNotNullOfOrNull { (it.args["product"] as? CopyArgument.Text)?.value?.takeIf(String::isNotBlank) }
    }
    val step = screen.state
    val adding = screen.component == KitComponent.addToAccount || step == "attach" || step == "added"
    // The sign-in is running: Back does nothing, Cancel is the way out.
    val inFlight = adding && (step == "busy" || step == "waiting")
    val back = PolarisBackHandler(enabled = inFlight) {}
    // Each step is its own screen: focus and the screen reader start over on it.
    key(step) {
        val spec = remember(screen, lines, handlers) { holderSpec(screen, lines, handlers) }
        val mac = polarisWindow.isMac
        PolarisScaffold(
            modifier = modifier.then(back).then(if (mac) Modifier.polarisMacDefaultKeys(spec.default) else Modifier),
            anchor = PolarisAnchor.Top,
            contentAlign = androidx.compose.ui.text.style.TextAlign.Start,
            dockActionsAtLargeType = true,
            content = {
                PolarisProductHeader(product)
                HolderBody(screen, lines, ui, onNameChange, onEmailChange, handlers)
            },
            actions = if (spec.primary == null && spec.secondary.isEmpty() && spec.quiet.isEmpty()) null else ({ HolderControls(spec) }),
        )
    }
}

/** The controls of a step, placed by [HolderControls]. */
private class HolderSpec(
    val primary: HolderButton?,
    val secondary: List<HolderButton>,
    /** Quiet text links under the group (Use another account). */
    val quiet: List<HolderButton>,
) {
    /** What Return does on the Mac. */
    val default: (() -> Unit)? get() = primary?.takeIf { it.enabled && !it.busy }?.onClick
}

/** The catalog lines of one screen, formatted for the platform (macOS title case on buttons). */
private class HolderLines(
    private val screen: KitScreen,
    private val catalog: KitCopy,
    private val locale: String,
    private val variant: CopyVariant?,
) {
    private fun line(key: String) = screen.copy.firstOrNull { it.key == key }?.takeUnless(catalog::isDangling)

    fun text(key: String): String? = line(key)?.let { catalog.format(it, locale, variant.takeIf { isMacVariantRole(key) }) }

    fun has(key: String): Boolean = line(key) != null

    fun arg(key: String, name: String): String? = (line(key)?.args?.get(name) as? CopyArgument.Text)?.value?.takeIf(String::isNotBlank)

    fun parts(key: String): List<LeadPart> = text(key)?.let(catalog::leadParts).orEmpty()
}

private fun holderSpec(screen: KitScreen, lines: HolderLines, h: HolderHandlers): HolderSpec {
    fun button(key: String, onClick: () -> Unit, enabled: Boolean = true, busy: Boolean = false, external: Boolean = false) =
        lines.text(key)?.let { HolderButton(it, onClick, enabled, busy, external) }
    val start = button("signin.done.start", h.onStartUsing)
    return when (screen.state) {
        "ready" -> HolderSpec(start, emptyList(), emptyList())

        "waiting" -> if (screen.component == KitComponent.activateDone) {
            // The license was sent to an email: signing in as it is the way to keep it; Start using stays the primary.
            HolderSpec(start, listOfNotNull(button("activate.waitingSignIn", h.onAdd)), emptyList())
        } else {
            // The wait for the browser: the code is shown, the way back to the tab and the way out are live.
            HolderSpec(null, listOfNotNull(button("activate.attach.reopen", h.onReopen), button("common.cancel", h.onCancel)), emptyList())
        }

        "key-done" -> if (lines.has("activate.waiting")) {
            HolderSpec(start, listOfNotNull(button("activate.waitingSignIn", h.onAdd)), emptyList())
        } else {
            HolderSpec(start, emptyList(), emptyList())
        }

        "form", "attach", "invalid" -> HolderSpec(
            button("common.continue", h.onSubmit),
            listOfNotNull(button("common.cancel", h.onCancel)),
            emptyList(),
        )

        "busy" -> HolderSpec(
            button("common.continue", {}, enabled = false, busy = true),
            listOfNotNull(button("signin.handoff.again", h.onReopen), button("common.cancel", h.onCancel)),
            emptyList(),
        )

        "added" -> HolderSpec(
            // From Settings the screen closes with Done; from the gate Start using goes on.
            button("common.done", h.onDone) ?: start,
            emptyList(),
            emptyList(),
        )

        "owned" -> HolderSpec(
            button("signin.key.ownedSignIn", h.onSignIn),
            listOfNotNull(button("common.cancel", h.onCancel)),
            emptyList(),
        )

        "email-bound" -> HolderSpec(
            start,
            listOfNotNull(button("activate.otherEmail.verify", h.onVerify, external = true)),
            listOfNotNull(button("signin.auto.confirm.other", h.onOtherAccount)),
        )

        "other-account" -> HolderSpec(start, listOfNotNull(button("common.tryAgain", h.onTryAgain)), emptyList())

        "failed" -> HolderSpec(
            button("common.tryAgain", h.onTryAgain),
            listOfNotNull(button("common.cancel", h.onCancel)),
            emptyList(),
        )

        else -> HolderSpec(null, emptyList(), emptyList())
    }
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ColumnScopeSpace(height: androidx.compose.ui.unit.Dp) = Spacer(Modifier.height(height))

@Composable
private fun HolderBody(
    screen: KitScreen,
    lines: HolderLines,
    ui: PolarisAddToAccountUi,
    onNameChange: (String) -> Unit,
    onEmailChange: (String) -> Unit,
    handlers: HolderHandlers,
) {
    val step = screen.state
    val stateKey = step
    when (step) {
        "ready" -> DoneBody(lines, stateKey, handlers)

        "waiting" ->
            if (screen.component == KitComponent.activateDone) {
                TitleAndBody(lines, "activate.done.title", listOf("activate.done.device", "activate.waiting"), stateKey)
            } else {
                WaitBody(lines, stateKey, ui)
            }

        "key-done" -> if (lines.has("activate.waiting")) {
            TitleAndBody(lines, "activate.done.title", listOf("activate.done.device", "activate.waiting"), stateKey)
        } else {
            DoneBody(lines, stateKey, handlers)
        }

        "form", "attach", "invalid", "busy" -> FormBody(lines, step, stateKey, ui, onNameChange, onEmailChange, handlers)

        "added" -> {
            PolarisIconBadge(PolarisSymbols.Check, PolarisTheme.status.successContainer, PolarisTheme.status.success)
            ColumnScopeSpace(PolarisSpace.controls)
            TitleAndBody(lines, "activate.attach.done", listOf("activate.attach.syncOn"), stateKey)
        }

        "owned" -> TitleAndBody(lines, "activate.owned.title", listOf("activate.owned.lede"), stateKey)

        "email-bound" -> TitleAndBody(lines, "activate.otherEmail.title", listOf("activate.otherEmail.body"), stateKey)

        "other-account" -> TitleAndBody(lines, "activate.otherAccount.title", listOf("activate.otherAccount.body"), stateKey)

        "failed" -> {
            // The title stays the action that opened the form; the problem is a danger line on this screen.
            lines.text("activate.recommend.action")?.let { PolarisTitle(it, key = stateKey) }
            ColumnScopeSpace(PolarisSpace.tight)
            lines.text("activate.attach.failed")?.let { HolderProblem(it) }
        }
    }
}

@Composable
private fun TitleAndBody(lines: HolderLines, titleKey: String, bodyKeys: List<String>, stateKey: String) {
    lines.text(titleKey)?.let { PolarisTitle(it, key = stateKey) }
    for (key in bodyKeys) {
        val text = lines.text(key) ?: continue
        ColumnScopeSpace(PolarisSpace.tight)
        PolarisBody(text)
    }
}

/** A problem on its own screen: the danger tone, announced, never a dialog and never a dead end. */
@Composable
private fun HolderProblem(text: String) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = scheme.errorContainer,
        contentColor = scheme.onErrorContainer,
    ) {
        Row(
            Modifier.padding(horizontal = PolarisSpace.medium, vertical = PolarisSpace.controls).semantics {
                liveRegion = LiveRegionMode.Assertive
                error(text)
            },
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        ) {
            Icon(PolarisSymbols.Warning, contentDescription = null, modifier = Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Paragraph))
        }
    }
}

// ── ActivateDone ─────────────────────────────────────────────────────────────────────────────

private val REASON_ICONS: Map<String, ImageVector> by lazy {
    mapOf(
        "activate.recommend.sync" to PolarisSymbols.Refresh,
        "activate.recommend.recover" to PolarisSymbols.Lock,
        "activate.recommend.devices" to PolarisSymbols.Devices,
        "activate.recommend.portal" to PolarisSymbols.Check,
    )
}

@Composable
private fun DoneBody(lines: HolderLines, stateKey: String, handlers: HolderHandlers) {
    lines.text("activate.done.title")?.let { PolarisTitle(it, key = stateKey) }
    lines.text("activate.done.device")?.let {
        ColumnScopeSpace(PolarisSpace.tight)
        PolarisBody(it)
    }
    val reasons = REASON_ICONS.keys.filter { lines.has(it) }
    val title = lines.text("activate.recommend.title")
    if (title != null) {
        ColumnScopeSpace(polarisWindow.section)
        RecommendationCard(lines, title, reasons, handlers)
        lines.text("activate.recommend.skip")?.let {
            ColumnScopeSpace(PolarisSpace.controls)
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Paragraph),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * The quiet recommendation: a tonal card, the title with the Recommended badge, up to three reason lines
 * (an icon and a sentence whose lead-in is SemiBold), then the action as a tonal button. Never the primary.
 */
@Composable
private fun RecommendationCard(lines: HolderLines, title: String, reasons: List<String>, handlers: HolderHandlers) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        color = scheme.surfaceContainerLow,
        contentColor = scheme.onSurface,
    ) {
        Column(Modifier.padding(PolarisSpace.medium), verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                lines.text("activate.recommend.badge")?.let { KitTag(it) }
            }
            for (key in reasons) ReasonRow(lines, key)
            // Identity off, or a kit with no in-app channel: the action opens Polaris Locker (an external link).
            val portal = lines.has("signin.key.addInLocker")
            val label = lines.text(if (portal) "signin.key.addInLocker" else "activate.recommend.action")
            if (label != null) {
                PolarisSecondaryButton(label, onClick = handlers.onAdd, external = portal)
            }
        }
    }
}

@Composable
private fun ReasonRow(lines: HolderLines, key: String) {
    val strong = SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
    val parts = lines.parts(key)
    if (parts.isEmpty()) return
    val text = buildAnnotatedString {
        for (part in parts) {
            if (part.strong) withStyle(strong) { append(part.text) } else append(part.text)
        }
    }
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
    ) {
        REASON_ICONS[key]?.let {
            Icon(it, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Paragraph),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
    }
}

// ── AddToAccount ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun FormBody(
    lines: HolderLines,
    step: String,
    stateKey: String,
    ui: PolarisAddToAccountUi,
    onNameChange: (String) -> Unit,
    onEmailChange: (String) -> Unit,
    handlers: HolderHandlers,
) {
    val busy = step == "busy"
    val nameFocus = remember { FocusRequester() }
    val emailFocus = remember { FocusRequester() }
    val nameError = lines.text("activate.attach.nameRequired")
    val emailError = lines.text("signin.email.invalid")
    // A step starts with the field to fill: the first wrong one after a failed Continue, else the name.
    if (!busy) {
        LaunchedEffect(step) {
            runCatching { (if (nameError == null && emailError != null) emailFocus else nameFocus).requestFocus() }
        }
    }
    // The title is the action that opened the form: text, not a button.
    lines.text("activate.recommend.action")?.let { PolarisTitle(it, key = stateKey) }
    lines.text("activate.attach.lede")?.let {
        ColumnScopeSpace(PolarisSpace.tight)
        PolarisBody(it)
    }
    ColumnScopeSpace(polarisWindow.section)
    PolarisTextField(
        value = ui.name,
        onValueChange = onNameChange,
        label = lines.text("activate.attach.name").orEmpty(),
        enabled = !busy,
        error = nameError,
        focusRequester = nameFocus,
        fieldContentType = ContentType.PersonFullName,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Words,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.Next,
        ),
    )
    ColumnScopeSpace(PolarisSpace.controls)
    PolarisTextField(
        value = ui.email,
        onValueChange = onEmailChange,
        label = lines.text("signin.email.label").orEmpty(),
        enabled = !busy,
        error = emailError,
        focusRequester = emailFocus,
        fieldContentType = ContentType.EmailAddress,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Email,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = { if (!busy) handlers.onSubmit() }),
    )
    lines.text("activate.attach.fine")?.let {
        ColumnScopeSpace(PolarisSpace.controls)
        Text(
            it,
            style = MaterialTheme.typography.bodySmall.copy(lineBreak = LineBreak.Paragraph),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(horizontal = PolarisSpace.medium),
        )
    }
}

/** The wait for the browser: the title, the code to check against Polaris Locker's, and the instruction. */
@Composable
private fun WaitBody(lines: HolderLines, stateKey: String, ui: PolarisAddToAccountUi) {
    lines.text("activate.attach.waitTitle")?.let { PolarisTitle(it, key = stateKey) }
    val code = lines.arg("a11y.code", "code") ?: ui.userCode
    if (!code.isNullOrEmpty()) {
        ColumnScopeSpace(polarisWindow.section)
        lines.text("part.code.label")?.let {
            Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ColumnScopeSpace(PolarisSpace.hairline)
        }
        val copyLabel = lines.text("a11y.copyCode")
        val clipboard = rememberPolarisClipboard()
        val scope = rememberCoroutineScope()
        PolarisUserCode(
            code,
            Modifier.fillMaxWidth(),
            onCopy = copyLabel?.let { label ->
                label to { value: String ->
                    scope.launch { clipboard.setText(label, value) }
                    Unit
                }
            },
        )
    }
    lines.text("activate.attach.waitCheck")?.let {
        ColumnScopeSpace(PolarisSpace.controls)
        PolarisBody(it)
    }
}

// ── Controls ─────────────────────────────────────────────────────────────────────────────────

/**
 * The step's controls in the platform's order. Phone and TV: stacked, the primary first. Desktop: one
 * trailing row, where Windows puts the primary first, GNOME's default pill sits last and macOS puts Cancel
 * directly left of the default. The quiet links sit under the group.
 */
@Composable
private fun HolderControls(spec: HolderSpec) {
    val window = polarisWindow
    val tv = window.tv
    val primary = spec.primary
    val first: HolderButton? = primary ?: spec.secondary.firstOrNull()

    @Composable
    fun draw(button: HolderButton, isPrimary: Boolean) {
        val focus = button === first && (tv || window.variant.isDesktop)
        if (isPrimary) {
            PolarisPrimaryButton(
                button.label,
                button.onClick,
                enabled = button.enabled,
                busy = button.busy,
                initialFocus = focus,
                external = button.external,
            )
        } else {
            PolarisSecondaryButton(button.label, button.onClick, enabled = button.enabled, initialFocus = focus, external = button.external)
        }
    }
    if (window.variant.isDesktop && !tv) {
        PolarisActionGroup(row = true, visualOrder = window.isMac) {
            if (window.isMac) {
                // Left to right: the others, then the default.
                for (button in spec.secondary.asReversed()) draw(button, false)
                if (primary != null) draw(primary, true)
            } else {
                if (primary != null) draw(primary, true)
                for (button in spec.secondary) draw(button, false)
            }
        }
    } else {
        if (primary != null) draw(primary, true)
        for ((i, button) in spec.secondary.withIndex()) {
            if (primary != null || i > 0) Spacer(Modifier.height(PolarisSpace.controls))
            draw(button, primary == null && i == 0)
        }
    }
    if (spec.quiet.isNotEmpty()) {
        Spacer(Modifier.height(PolarisSpace.controls))
        for (button in spec.quiet) PolarisTextButton(button.label, button.onClick, enabled = button.enabled)
    }
}
