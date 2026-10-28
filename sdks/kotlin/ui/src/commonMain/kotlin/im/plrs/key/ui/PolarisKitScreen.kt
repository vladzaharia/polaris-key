// The screens drawn from the presentation core (UI-KITS.md §4.1; plans/UK-02b.md §5).
//
// `KitStates.resolve(component, inputs)` answers, from wire-free inputs, which state a component is
// in, which catalog lines it shows and which actions it offers. PolarisKitScreen draws that answer
// in the kit's look and hands each action back to the host; it holds no state of its own, so the
// same inputs always draw the same screen (the ui-matrix snapshots run exactly that).
//
// KitSignIn is the SignIn(state, presentation) component: the sign-in form's state from the inputs,
// the product's identity from the SDK's presentation source (the kit fetches nothing itself).

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import im.plrs.key.core.Presentation
import im.plrs.key.core.PresentationSource
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The locale tag the catalog formats in: the device's first locale. */
@Composable
internal fun kitLocale(): String = systemLocaleTag()

/** What a line is on screen: a control, an announcement for assistive tech only, or text. */
internal enum class KitLineRole { Control, Announcement, Text }

private val controlSuffix = Regex(
    "(continue|keyInstead|openBrowser|openSystem|manage|download|install|retry|tryAgain|again|activate|later|notNow|" +
        "restart|signOut|remove|rename|save|done|close|back|cancel|reconnect|newCode|copyLink|open|choose)$",
)

/**
 * The catalog lines that are buttons whatever their name ends in: the welcome's entry points, the
 * status screens' recoveries, the sign-in's choices, the update and paywall verbs.
 */
private val controlKeys = setOf(
    "welcome.signIn", "welcome.useKey", "welcome.trial", "welcome.continueFree", "welcome.restore", "welcome.offline",
    "status.renew", "status.useAnotherLicense", "status.update", "status.switchChannel", "status.contact",
    "signin.menu.signIn", "signin.passkey", "signin.none.get", "signin.none.otherAccount",
    "signin.choice.keyInstead", "signin.key.differentKey", "signin.code.resend", "signin.handoff.useCode",
    "signin.replace.back", "signin.replace.openSystem", "signin.replace.open",
    "update.appStore", "update.googlePlay", "update.steam", "update.openStore", "update.testflight", "update.altstore",
    "update.reload", "update.restartWhenReady", "update.restartNow", "update.checkNow", "update.allChanges",
    "paywall.upgrade", "paywall.redeem", "paywall.portal", "entitlement.unlock", "updateProgress.resume",
    "offlineActivation.copyCode", "offlineActivation.loadFile", "offlineActivation.submit",
    "deviceLimit.primary", "deviceLimit.openBrowser", "devices.manage", "activate.submit", "boot.continueOffline",
    "signin.again", "toast.undo", "common.dismiss",
    "signin.key.ownedSignIn", "signin.auto.confirm.primary", "signin.auto.confirm.other", "signin.linkOffer.primary",
    "signin.linkOffer.decline", "signin.linkOffer.join", "signin.key.signIn", "signin.nearby.code", "signin.nearby.notYou",
    "signin.approve.deny", "signin.nearby.menu",
)

/**
 * Controls that are tertiary: quiet text links at the foot, never a button beside the primary
 * (UI-KITS.md DL4: "Activate offline", "Copy diagnostics" and their kind).
 */
private val tertiaryKeys = setOf(
    "welcome.trial", "welcome.continueFree", "welcome.restore", "welcome.offline", "paywall.redeem",
    "signin.choice.keyInstead", "signin.handoff.useCode", "update.skipVersion", "update.allChanges", "signin.choice.freeDevice",
    "signin.key.differentKey", "signin.auto.confirm.other", "signin.linkOffer.decline", "signin.nearby.code",
    "signin.nearby.notYou", "signin.approve.deny", "signin.linkOffer.join", "common.notNow",
)

/**
 * Lines that only make sense inside a row, a group or a note the matrix carries no data for (a
 * device's meta and tag, a license's origin and term, a setting's provenance, the "What's new"
 * label with no notes under it). They are drawn by the screens that have the rows; here they would
 * be stray fragments, so a state keeps them only when nothing else is left to say.
 */
private val rowOnlyKeys = setOf(
    "signin.replace.leastRecent", "signin.replace.meta", "devices.meta", "devices.count", "part.thisDeviceTitle",
    "update.whatsNew", "settings.on", "settings.off", "settings.reset", "settings.advanced", "settings.range",
    "settings.source.local", "settings.source.env", "settings.source.default", "signin.term.lifetime", "signin.term.until",
    "signin.choice.meta", "signin.choice.metaNew", "signin.choice.devices",
)

internal fun isRowFragment(key: String): Boolean =
    key in rowOnlyKeys || key.startsWith("signin.choice.origin.") || key.startsWith("signin.choice.tag.")

/** The lines whose own sentence reads without the missing name ("{method} sign-in didn't finish"). */
private val sentenceWithoutName = setOf("signIn.methodError")

internal fun kitLineRole(key: String): KitLineRole = when {
    key.startsWith("a11y.") -> KitLineRole.Announcement

    // A sentence that ends in "done" is the verdict, not the Done button (`common.done`); "Up to date"
    // after an update is a status, not an action.
    key == "offlineActivation.done" || key == "updateProgress.done" -> KitLineRole.Text

    key in controlKeys || KitAction.forCopyKey(key) != null || controlSuffix.containsMatchIn(key) -> KitLineRole.Control

    else -> KitLineRole.Text
}

/**
 * Keys the kit leaves out on purpose, as the React and Swift kits do: no "Or continue with" divider
 * over the sign-in methods (DL4: it heads a provider list this kit does not draw, and read alone
 * it ends in "with") and no "Sign in..." link on the sign-in step itself.
 */
private val kitLeftOut = setOf("signin.provider.group", "signin.menu.signIn")

private data class KitLine(val key: String, val role: KitLineRole, val text: String, val args: Map<String, CopyArgument>)

/**
 * Whether [line] would show a fragment: an argument the inputs did not fill (a name the template
 * uses with no value, a blank text, a seat limit of 0), so "From {store}", "0 of 0 devices" and
 * "license" never reach the screen (DL8: no dangling text).
 */
internal fun KitCopy.isDangling(line: CopyLine): Boolean {
    val names = argumentNames(line.key)
    if (names.any { it !in line.args }) return true
    return names.any { name ->
        when (val arg = line.args[name]) {
            is CopyArgument.Text -> arg.value.isBlank()
            is CopyArgument.Number -> arg.value == 0 && name == "limit"
            else -> false
        }
    }
}

/** The product the screen names: the first non-blank `product` argument any of its lines carries. */
private fun KitScreen.productName(): String? = copy.firstNotNullOfOrNull {
    (it.args["product"] as? CopyArgument.Text)?.value?.takeIf(String::isNotBlank)
}

/** [text] with its first letter capitalised, for a line whose leading argument was left out. */
private fun String.sentenceStart(): String = trim().replaceFirstChar { it.uppercaseChar() }

/**
 * Draws [screen] (a `KitStates.resolve` answer) in the kit's look: the product header (or, on the
 * Welcome, the hero icon), the title and body lines, the component's own parts (the key field, the
 * seat meter, the account rows), then the controls, the first one primary and the rest tonal, with
 * the tertiary ones as quiet links at the foot. A line that would show an unfilled argument is left
 * out. [onAction] receives the vocabulary action a control stands for, or null for a control the
 * vocabulary has no action for. A hidden screen draws nothing.
 */
@Composable
public fun PolarisKitScreen(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
    requestCode: String? = null,
    addKeyUrl: String? = null,
    onAction: (KitAction?) -> Unit = {},
    rows: KitRowData = KitRowData(),
    onContinue: (String) -> Unit = {},
    onControl: (String) -> Unit = {},
    /** Offered with the license choice when every license is on all its devices (the automatic sign-in). */
    onUseAnotherAccount: (() -> Unit)? = null,
    /** The new recovery code to draw on the RecoveryCode screen (from the host, shown once); without one that screen draws nothing. */
    recoveryCode: PolarisRecoveryCode? = null,
) {
    // The sign-in form and its hand-off (the code, declined, expired) are focused steps: the
    // product header above a start-aligned title.
    val focused =
        screen.component == KitComponent.signIn || screen.component == KitComponent.signInHandoff || screen.component == KitComponent.nearbyApproval
    // The components with a styled part of their own (UI-KITS.md 4.1) draw it from their rows.
    val choices = rows.choices
    when {
        screen.isHidden -> Unit

        screen.component == KitComponent.licenseChoice && choices != null && choices.choices.isNotEmpty() && screen.state in LicenseChoiceRowStates ->
            PolarisLicenseChoice(
                screen,
                choices,
                modifier,
                onContinue = onContinue,
                onAction = onAction,
                catalog = catalog,
                locale = locale,
                onUseAnotherAccount = onUseAnotherAccount,
            )

        screen.component == KitComponent.releaseNotes ->
            PolarisReleaseNotes(screen, rows.releaseNotes, modifier, onRetry = { onAction(KitAction.retry) }, catalog = catalog, locale = locale)

        // Not available is the message KitScreenBody draws; every other state is the Paywall.
        screen.component == KitComponent.paywall && screen.state != "not-available" ->
            PolarisPaywall(screen, rows.features, modifier, onUpgrade = {
                onAction(null)
            }, onPortal = { onAction(null) }, onRedeem = { onAction(null) }, onDone = { onAction(null) }, catalog = catalog, locale = locale)

        screen.component == KitComponent.entitlementGate -> KitEntitlementGate(screen, modifier, catalog, locale) { onAction(null) }

        // The Cloud Sync screens (U-42): drawn from the model, each control reports its matrix action.
        screen.component == KitComponent.unlockSync ->
            PolarisUnlockSync(
                screen, modifier,
                // The typed recovery code goes to onContinue, then the matrix action: the host passes it to `recover` only.
                onUnlock = { typed ->
                    onContinue(typed)
                    onAction(KitAction.unlock)
                },
                onStartOver = { onAction(KitAction.startOver) },
                onConfirmStartOver = { onAction(KitAction.confirmStartOver) },
                onRetry = { onAction(KitAction.retry) },
                onCancel = { onAction(KitAction.cancel) },
                catalog = catalog, locale = locale,
            )

        screen.component == KitComponent.ringChange ->
            PolarisRingChange(
                screen, modifier,
                onAccept = { onAction(KitAction.acceptRingChange) },
                onUseCode = { onAction(KitAction.useRecoveryCode) },
                onCancel = { onAction(KitAction.cancel) },
                catalog = catalog, locale = locale,
            )

        screen.component == KitComponent.recoveryCode ->
            if (recoveryCode != null) {
                // The tick is the screen's own state here; Done follows it (the host gets onAction(null) on Done).
                var saved by remember(screen) { mutableStateOf(screen.state == "saved") }
                PolarisRecoveryCodeScreen(
                    screen, recoveryCode, modifier, onSavedChange = { saved = it }, onDone = { onAction(null) },
                    catalog = catalog, locale = locale, saved = saved,
                )
            }

        screen.component == KitComponent.cloudSyncStatus && (screen.state == "locked" || screen.state == "ring-changed") ->
            PolarisCloudSyncStatus(
                if (screen.state == "locked") PolarisCloudSync.Locked else PolarisCloudSync.RingChanged,
                modifier,
                onUnlock = { onAction(KitAction.unlock) },
                onReview = { onAction(null) },
            )

        else -> KitScreenBody(
            screen, modifier, catalog, locale, onAction, focused = focused, productName = null, requestCode = requestCode,
            addKeyUrl = addKeyUrl, progress = rows.progress, onControl = onControl,
        )
    }
}

/** The EntitlementGate state as a screen: nothing while entitled, the locked card, or the loading line. */
@Composable
private fun KitEntitlementGate(screen: KitScreen, modifier: Modifier, catalog: KitCopy, locale: String, onUnlock: () -> Unit) {
    val tier = screen.copy.firstOrNull {
        it.key == "entitlement.locked"
    }?.args?.get("tier").let { (it as? CopyArgument.Text)?.value?.takeIf(String::isNotBlank) }
    when (screen.state) {
        "entitled" -> Unit

        "loading" -> PolarisProgressScreen(catalog.format("common.loading", locale), modifier)

        else -> PolarisScreen(modifier = modifier, showLogo = false) {
            PolarisEntitlementLocked(tier, onUnlock = onUnlock.takeIf { screen.shows("entitlement.unlock") })
        }
    }
}

/** The components whose screens are centred messages or hero screens, not focused steps. */
private val centredComponents = setOf(
    KitComponent.welcome,
    KitComponent.gate,
    KitComponent.boot,
    KitComponent.statusScreen,
    KitComponent.graceBanner,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KitScreenBody(
    screen: KitScreen,
    modifier: Modifier,
    catalog: KitCopy,
    locale: String,
    onAction: (KitAction?) -> Unit,
    focused: Boolean,
    productName: String?,
    requestCode: String? = null,
    addKeyUrl: String? = null,
    progress: Float? = null,
    onControl: (String) -> Unit = {},
) {
    if (screen.isHidden) return
    val component = screen.component
    val product = productName ?: screen.productName()
    val variant = polarisCopyVariant()
    val kept = remember(screen, catalog, locale) {
        val shown = screen.copy.filter { it.key !in kitLeftOut }
        // Row fragments are left out unless nothing else would be left to say.
        val all = shown.filterNot { isRowFragment(it.key) }.takeIf { rest -> rest.any { kitLineRole(it.key) == KitLineRole.Text } } ?: shown
        // The restart verb is the downloading state's; an offer lists it only as one platform's verb.
        val offered = all.filterNot { it.key == "update.restartWhenReady" && screen.state != "downloading" }.filterNot {
            it.key ==
                "update.skipVersion"
        }
        offered.filterNot { catalog.isDangling(it) }
    }
    // The platform's wording (macOS title case) is for buttons, menu items and window titles only (S4).
    val shapedLines = remember(kept, screen, catalog, locale) {
        val formatted = kept.map { line ->
            KitLine(line.key, kitLineRole(line.key), catalog.format(line, locale, variant.takeIf { isMacVariantRole(line.key) }), line.args)
        }
        // A state whose every sentence lost an argument still says what happened, without the name.
        val fallback = screen.copy.firstOrNull { it.key in sentenceWithoutName }
        if (fallback != null && formatted.none { it.role == KitLineRole.Text }) {
            val args = catalog.argumentNames(fallback.key).associateWith { CopyArgument.Text("") as CopyArgument }
            return@remember listOf(
                KitLine(fallback.key, KitLineRole.Text, catalog.format(CopyLine(fallback.key, args), locale).sentenceStart(), args),
            ) +
                formatted
        }
        formatted
    }
    // GNOME (SIGN-IN.md D-80): the Replace confirm is an AdwAlertDialog, not the inline block. The sign-in
    // step's "Replace…" opens it; the confirm state (replace-open) is the alert itself.
    val onGnome = autoPlatformVariant() == PolarisPlatformVariant.Gnome
    val gnomeReplace = onGnome && component == KitComponent.signIn && screen.state == "replace" &&
        shapedLines.any { it.key == "signin.replace.title" }
    val gnomeConfirm = onGnome && component == KitComponent.licenseChoice && screen.state == "replace-open"
    var replaceOpen by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    val lines = if (gnomeReplace || gnomeConfirm) {
        val drop = setOf("signin.replace.title", "signin.replace.consequence", "signin.replace.confirm", "signin.replace.back")
        val rest = shapedLines.filterNot { it.key in drop }
        if (gnomeReplace) {
            rest +
                KitLine("signin.replace.openSystem", KitLineRole.Control, catalog.format("signin.replace.openSystem", locale), emptyMap())
        } else {
            rest
        }
    } else {
        shapedLines
    }
    // OfflineActivation's Copy code sits with step 1 (it copies the request code), not in the dock.
    val offline = screen.component == KitComponent.offlineActivation
    val controls = lines.filter { it.role == KitLineRole.Control && !(offline && it.key == "offlineActivation.copyCode") }
    // OfflineActivation's request QR label belongs to the code, not to a live announcement.
    val qrLabel = lines.firstOrNull { it.key == "a11y.qrRequest" }?.text
    val announcement = lines.filter { it.role == KitLineRole.Announcement && !(offline && it.key == "a11y.qrRequest") && it.key != "a11y.qrAddKey" }
        .joinToString(". ") { it.text }
    // Busy keeps the button's label and adds the indicator (DL4), so "Activating…" is not a sentence.
    val activating = component == KitComponent.activate && screen.state == "busy"
    val bar = progress != null && screen.state == "downloading" &&
        (component == KitComponent.updateProgress || component == KitComponent.updatePrompt)
    val spoken = lines.filter {
        it.role == KitLineRole.Text && it.key != "part.poweredBy" && !it.key.startsWith("part.keyField.") && it.key != "common.paste" &&
            !(offline && it.key == "offlineActivation.copyCode") && !(activating && it.key == "activate.busy")
    }
    // A download whose byte line is dangling still says what is happening, over its bar.
    val text = if (bar && spoken.isEmpty()) {
        listOf(KitLine("update.availableTitle", KitLineRole.Text, catalog.format("update.availableTitle", locale), emptyMap()))
    } else {
        spoken
    }
    // The optional attribution (UI-KITS.md section 1.6): the line, the pane's last item, after the
    // controls. On when the inputs carry it or the theme's `showPoweredBy` is on, and only on the
    // account pane (the kit has no About); never on a gate.
    val attribution = lines.any { it.key == "part.poweredBy" } ||
        (PolarisTheme.current.showPoweredBy && component == KitComponent.accountAndLicense)
    val clipboard = rememberPolarisClipboard()
    val scope = rememberCoroutineScope()
    val semanticsModifier = modifier.semantics {
        if (announcement.isNotEmpty()) {
            contentDescription = announcement
            liveRegion = LiveRegionMode.Polite
        }
    }
    // A toast is not a screen: it sits at the foot of whatever is under it.
    if (component == KitComponent.toast) {
        KitToast(lines, controls, onAction, semanticsModifier, state = screen.state)
        return
    }
    // The grace banner is a banner over the product; when grace ran out it is the expired stop below.
    if (component == KitComponent.graceBanner && screen.state != "expired") {
        KitGraceBanner(lines, controls, onAction, semanticsModifier)
        return
    }
    // The account pane's controls are its rows; a button list under them would draw each twice.
    val rowsOnly = component == KitComponent.accountAndLicense
    // Boot's "Not now" is paired with Download, so it stays a tonal secondary (UI-KITS.md: "never bare
    // text when paired"); everywhere else it is the quiet decline of an automatic step.
    val deviceLimitStep = component == KitComponent.signIn && screen.state == "device-limit"
    val isTertiary = { key: String ->
        (key in tertiaryKeys || (deviceLimitStep && key == "common.cancel")) &&
            !(key == "common.notNow" && component == KitComponent.boot)
    }
    val tertiary = if (rowsOnly) emptyList() else controls.filter { isTertiary(it.key) }
    val buttons = if (rowsOnly) emptyList() else controls.filter { !isTertiary(it.key) }
    // macOS: a step screen's actions are a trailing row; the Welcome keeps its stacked hero buttons.
    val macRow = autoPlatformVariant() == PolarisPlatformVariant.MacOS && component != KitComponent.welcome && buttons.isNotEmpty()
    // The automatic steps' quiet links (Use another account, Cancel) share the trailing group's one axis on the Mac.
    val quietInRow = macRow && component == KitComponent.signIn && (screen.state == "confirm" || deviceLimitStep)
    val onDefault: (() -> Unit)? = if (macRow &&
        !activating
    ) {
        buttons.firstOrNull()?.let { line ->
            {
                onControl(line.key)
                onAction(KitAction.forCopyKey(line.key))
            }
        }
    } else {
        null
    }
    val actions: (@Composable ColumnScope.() -> Unit)? = if ((controls.isEmpty() || rowsOnly) && !attribution &&
        component != KitComponent.activate
    ) {
        null
    } else {
        {
            if (component == KitComponent.activate && screen.state != "done") KitKeyField(lines, busy = activating)
            if (activating) {
                PolarisPrimaryButton(catalog.format("activate.submit", locale), onClick = {}, busy = true)
                Spacer(Modifier.height(PolarisSpace.controls))
            }
            if (macRow) {
                // macOS (B1): a trailing row sized to the labels, Cancel and Back directly left of the default,
                // emitted left to right so Tab runs the same way; the default has the focus.
                // The quiet links (Use another account, Cancel) are the group's secondaries too: one trailing axis.
                PolarisActionGroup(row = true, visualOrder = true) {
                    for (line in if (quietInRow) tertiary.reversed() else emptyList()) {
                        val action = KitAction.forCopyKey(line.key)
                        PolarisSecondaryButton(line.text, onClick = {
                            onControl(line.key)
                            onAction(action)
                        }, external = KitAction.leavesApp(line.key))
                    }
                    for ((index, line) in buttons.withIndex().reversed()) {
                        val action = KitAction.forCopyKey(line.key)
                        if (isGoogleProviderLine(line.key, line.args)) {
                            PolarisGoogleButton(line.text, onClick = {
                                onControl(line.key)
                                onAction(action)
                            }, initialFocus = index == 0)
                        } else if (index == 0) {
                            PolarisPrimaryButton(line.text, onClick = {
                                onControl(line.key)
                                onAction(action)
                            }, initialFocus = true, external = KitAction.leavesApp(line.key))
                        } else {
                            PolarisSecondaryButton(line.text, onClick = {
                                onControl(line.key)
                                onAction(action)
                            }, external = KitAction.leavesApp(line.key))
                        }
                    }
                }
            } else {
                CompositionLocalProvider(LocalPolarisMacHero provides (polarisWindow.isMac && component == KitComponent.welcome)) {
                    buttons.forEachIndexed { index, line ->
                        val action = KitAction.forCopyKey(line.key)
                        val click: () -> Unit = if (gnomeReplace &&
                            line.key == "signin.replace.openSystem"
                        ) {
                            ({ replaceOpen = true })
                        } else {
                            (
                                {
                                    onControl(line.key)
                                    onAction(action)
                                }
                                )
                        }
                        // One primary, then tonal secondaries (a lone action is always the primary, DL4).
                        val hero = if (polarisWindow.variant.isDesktop &&
                            component == KitComponent.welcome
                        ) {
                            Modifier.widthIn(max = PolarisMac.heroButtonMaxWidth)
                        } else {
                            Modifier
                        }
                        if (isGoogleProviderLine(line.key, line.args)) {
                            PolarisGoogleButton(line.text, onClick = click, modifier = hero)
                        } else if (index == 0) {
                            PolarisPrimaryButton(line.text, onClick = click, modifier = hero, external = KitAction.leavesApp(line.key))
                        } else {
                            PolarisSecondaryButton(line.text, onClick = click, modifier = hero, external = KitAction.leavesApp(line.key))
                        }
                        if (index < buttons.lastIndex) Spacer(Modifier.height(PolarisSpace.controls))
                    }
                }
            }
            if (tertiary.isNotEmpty() && !quietInRow) {
                Spacer(Modifier.height(if (buttons.isEmpty()) 0.dp else 20.dp))
                // The extras: one quiet row of links, no divider and no glyph (UI-KITS.md 4.3 Welcome).
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.hairline, Alignment.CenterHorizontally)) {
                    for (line in tertiary) {
                        PolarisTextButton(line.text, onClick = {
                            onControl(line.key)
                            onAction(KitAction.forCopyKey(line.key))
                        })
                    }
                }
            }
            if (attribution) {
                Spacer(Modifier.height(PolarisSpace.medium))
                PolarisPoweredByLine()
            }
        }
    }
    val body: @Composable ColumnScope.() -> Unit = {
        if (component == KitComponent.welcome) {
            // The icon at hero size, then the title, "by <Developer>" and the lede (the lines in order).
            PolarisHeroIcon(name = product)
        } else if (text.isNotEmpty() || controls.isNotEmpty()) {
            // The product heads every other screen (DL5): the integrator's name, else the product the lines name.
            // A state with nothing to say (the gate let the product through) is not a screen: no header either.
            PolarisProductHeader(productName ?: product, gap = polarisWindow.section)
        }
        if (component == KitComponent.accountAndLicense) {
            KitAccountBody(lines, text, controls, onAction, loading = screen.state == "loading")
        } else {
            // The device-limit step reads: title, count, lede, the meter, then the confirm. The
            // activation hand-off to it leads with the step's own title, not the core refusal's.
            val handoff = component == KitComponent.activate && screen.state == "device-limit"
            val ordered = if (handoff) {
                text.filterNot { it.key == "core.activation.device-limit.title" }.sortedBy {
                    if (it.key ==
                        "deviceLimit.title"
                    ) {
                        0
                    } else {
                        1
                    }
                }
            } else {
                text
            }
            val meters = (component == KitComponent.deviceLimit || handoff) && KitSeatMeterShown(screen)
            if (component == KitComponent.signIn && screen.state == "confirm") {
                KitConfirmLines(text)
            } else {
                ordered.forEachIndexed { index, line ->
                    // The caption belongs to the meter, which draws it.
                    if (meters && line.key == "part.seatMeter.caption") return@forEachIndexed
                    // The add-key page as a QR on a TV; its caption sits under it, only when the host gave the link (DL14).
                    if (line.key == "signin.key.scan" && addKeyUrl != null) {
                        lines.firstOrNull { it.key == "a11y.qrAddKey" }?.let {
                            PolarisQr(addKeyUrl, it.text, Modifier.size(polarisWindow.qrSize))
                            Spacer(Modifier.height(PolarisSpace.tight))
                        }
                    }
                    val step = if (offline) offlineStep(line.key) else null
                    when {
                        // The confirm's first line is bold body text, read before the button (4.3 DeviceLimit item 7).
                        line.key == "deviceLimit.confirmTitle" || line.key == "signin.replace.title" ->
                            Text(
                                line.text,
                                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                                color = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.fillMaxWidth(),
                            )

                        index == 0 && component == KitComponent.welcome && polarisWindow.isMac -> PolarisMacWelcomeTitle(line.text)

                        index == 0 -> PolarisTitle(line.text)

                        step != null -> PolarisStep(step, line.text)

                        else -> PolarisBody(line.text)
                    }
                    Spacer(Modifier.height(if (index == 0) PolarisSpace.tight else 8.dp))
                    // The request QR sits under step 1, and only when the host gave the code to encode: a
                    // kit never makes up a code (DL14).
                    if (step == 1 && requestCode != null && qrLabel != null) {
                        PolarisQr(requestCode, qrLabel, Modifier.size(polarisWindow.qrSize))
                        Spacer(Modifier.height(PolarisSpace.tight))
                    }
                    val copyLine = lines.firstOrNull { it.key == "offlineActivation.copyCode" }
                    if (step == 1 && copyLine != null) {
                        PolarisSecondaryButton(
                            copyLine.text,
                            onClick = {
                                if (requestCode != null) {
                                    scope.launch { clipboard.setText(copyLine.text, requestCode) }
                                }
                                onAction(KitAction.forCopyKey(copyLine.key))
                            },
                        )
                        Spacer(Modifier.height(PolarisSpace.tight))
                    }
                    if (meters && line.key in setOf("deviceLimit.lede", "deviceLimit.browser", "deviceLimit.noManage")) KitSeatMeter(screen)
                }
            }
            // The activation hand-off has no lede line of its own to hang the meter on: it follows the text.
            if (meters && ordered.none { it.key in setOf("deviceLimit.lede", "deviceLimit.browser", "deviceLimit.noManage") }) KitSeatMeter(screen)
            if (bar && progress != null) {
                val percent = java.text.NumberFormat.getPercentInstance(java.util.Locale.forLanguageTag(locale)).format(progress.toDouble())
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisProgressBar(progress, percent)
                Spacer(Modifier.height(PolarisSpace.tight))
                Text(
                    percent,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // With no controls, the line closes the content.
            if (attribution && controls.isEmpty()) PolarisPoweredByLine()
        }
    }
    val asColumn = component in centredComponents
    val screenContent: @Composable () -> Unit = {
        CompositionLocalProvider(LocalPolarisArtName provides (productName ?: product)) {
            if (!asColumn) {
                PolarisScaffold(
                    modifier = semanticsModifier.then(if (macRow) Modifier.polarisMacDefaultKeys(onDefault) else Modifier),
                    anchor = PolarisAnchor.Top,
                    contentAlign = TextAlign.Start,
                    actions = actions,
                    dockActionsAtLargeType = focused,
                    content = body,
                )
            } else {
                PolarisScreen(
                    modifier = semanticsModifier.then(if (macRow) Modifier.polarisMacDefaultKeys(onDefault) else Modifier),
                    showLogo = false,
                    actions = actions,
                    content = body,
                )
            }
        }
    }
    if (gnomeReplace || gnomeConfirm) {
        // The alert's names: the device in the title's argument, this device in the lede's.
        fun arg(key: String, name: String): String =
            ((shapedLines.firstOrNull { it.key == key }?.args?.get(name)) as? CopyArgument.Text)?.value.orEmpty()
        val device = arg("signin.replace.title", "device")
        val thisDevice = arg("signin.replace.lede", "thisDevice").ifEmpty { arg("signin.replace.consequence", "thisDevice") }
        val confirm = KitAction.forCopyKey("signin.replace.confirm")
        val back = KitAction.forCopyKey("signin.replace.back")
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize()) {
            screenContent()
            if (gnomeConfirm || replaceOpen) {
                PolarisReplaceAlertOverlay(
                    device,
                    thisDevice,
                    product.orEmpty(),
                    onReplace = {
                        replaceOpen = false
                        onAction(confirm)
                    },
                    onBack = {
                        replaceOpen = false
                        if (gnomeConfirm) onAction(back)
                    },
                )
            }
        }
    } else {
        screenContent()
    }
}

/**
 * The automatic confirm's lines with their hierarchy (SIGN-IN.md §3.19): "as <email>" under the title,
 * overline labels over their values, the license line strong. A label whose value did not draw
 * (a seat the view does not know) is left out with it. 4 dp inside a group, 16 dp between groups.
 */
@Composable
private fun KitConfirmLines(lines: List<KitLine>) {
    val scheme = MaterialTheme.colorScheme
    val hasLicense = lines.any { it.key == "signin.consent.licenseLine" || it.key == "signin.consent.newLicense" }
    for ((index, line) in lines.withIndex()) {
        if (line.key == "signin.consent.license" && !hasLicense) continue
        when (line.key) {
            "signin.consent.license", "signin.consent.alsoGets" -> {
                if (index > 0 && lines.take(index).any { it.key.startsWith("signin.consent.") }) Spacer(Modifier.height(PolarisSpace.controls))
                Text(line.text, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(PolarisSpace.hairline))
            }

            "signin.consent.licenseLine", "signin.consent.newLicense", "signin.consent.profile" -> {
                val strong = line.key != "signin.consent.profile"
                Text(
                    line.text,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = if (strong) FontWeight.Medium else FontWeight.Normal),
                    color = scheme.onSurface,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(PolarisSpace.hairline))
            }

            "signin.consent.pairwise" -> {
                Text(line.text, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
            }

            "signin.auto.confirm.as", "signin.auto.confirm.asApple" -> {
                PolarisBody(line.text)
                Spacer(Modifier.height(PolarisSpace.controls + 4.dp))
            }

            else -> {
                if (index == 0) {
                    PolarisTitle(line.text)
                    Spacer(Modifier.height(PolarisSpace.hairline))
                } else {
                    PolarisBody(line.text)
                    Spacer(Modifier.height(PolarisSpace.hairline))
                }
            }
        }
    }
}

/** The key field of Activate (UI-KITS.md 4.3): label inside, the paste control in the field, the live verdict under it. */
@Composable
private fun KitKeyField(lines: List<KitLine>, busy: Boolean) {
    val label = lines.firstOrNull { it.key == "part.keyField.label" }?.text ?: return
    val placeholder = lines.firstOrNull { it.key == "part.keyField.placeholder" }?.text
    val paste = lines.firstOrNull { it.key == "common.paste" }?.text
    var value by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf("") }
    // The verdict and the shape errors sit under the field (DL7); only the key's own shape is danger.
    val error = lines.firstOrNull {
        it.key == "part.keyField.cutShort" || it.key == "part.keyField.malformed" || it.key == "part.keyField.empty"
    }?.text
    val hints = lines.filter { it.key == "part.keyField.forProduct" || it.key == "part.keyField.verdict" }.map { it.text }
    PolarisTextField(
        value = value,
        onValueChange = { value = it },
        label = label,
        placeholder = placeholder,
        enabled = !busy,
        monospace = true,
        error = error,
        supporting = hints,
        trailing = paste?.let { description -> { PolarisPasteButton(description) { value = it } } },
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Ascii,
        ),
    )
    Spacer(Modifier.height(PolarisSpace.controls))
}

/** The paste control inside the key field: reads the clipboard text into the field. */
@Composable
internal fun PolarisPasteButton(description: String, onPaste: (String) -> Unit) {
    val clipboard = rememberPolarisClipboard()
    val scope = rememberCoroutineScope()
    PolarisIconButton(onClick = {
        scope.launch { clipboard.getText()?.trim()?.let(onPaste) }
    }) {
        Icon(PolarisPasteIcon, contentDescription = description, tint = PolarisTheme.accentText)
    }
}

/** Whether the state's lines carry the seat counts the meter needs. */
private fun KitSeatMeterShown(screen: KitScreen): Boolean {
    val caption = screen.copy.firstOrNull { it.key == "part.seatMeter.caption" } ?: return false
    return (caption.args["used"] as? CopyArgument.Number) != null && ((caption.args["limit"] as? CopyArgument.Number)?.value ?: 0) > 0
}

/** The seat meter of a device-limit state, when its lines carry the counts. */
@Composable
private fun KitSeatMeter(screen: KitScreen) {
    val caption = screen.copy.firstOrNull { it.key == "part.seatMeter.caption" } ?: return
    val used = (caption.args["used"] as? CopyArgument.Number)?.value ?: return
    val limit = (caption.args["limit"] as? CopyArgument.Number)?.value?.takeIf { it > 0 } ?: return
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    PolarisSeatMeter(
        used = used,
        limit = limit,
        caption = catalog.format(caption, locale),
        description = catalog.format("a11y.seatMeter", locale, mapOf("used" to CopyArgument.Number(used), "limit" to CopyArgument.Number(limit))),
    )
    Spacer(Modifier.height(polarisWindow.section))
}

/** A toast at the foot: the first sentence, the consequence under it, the actions (UI-KITS.md 4.1 Toast). */
@Composable
private fun KitToast(lines: List<KitLine>, controls: List<KitLine>, onAction: (KitAction?) -> Unit, modifier: Modifier, state: String) {
    val text = lines.filter { it.role == KitLineRole.Text }
    val kind = when (state) {
        "success" -> PolarisToastKind.Success
        "warning" -> PolarisToastKind.Warning
        "error" -> PolarisToastKind.Error
        else -> PolarisToastKind.Info
    }
    // A progress toast whose counts the inputs did not give still says what it tracks.
    val message = text.firstOrNull()?.text
        ?: if (state == "with-progress") KitCopy.bundled.format("updateProgress.contentTitle", kitLocale()) else ""
    Box(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.BottomCenter) {
        PolarisToast(
            message = message,
            kind = kind,
            detail = text.getOrNull(1)?.text,
            actions = controls.map { line -> PolarisToastAction(line.text) { onAction(KitAction.forCopyKey(line.key)) } },
        )
    }
}

/** The grace banner over a blank product: the headline, the deadline under it, Reconnect and Dismiss. */
@Composable
private fun KitGraceBanner(lines: List<KitLine>, controls: List<KitLine>, onAction: (KitAction?) -> Unit, modifier: Modifier) {
    val text = lines.filter { it.role == KitLineRole.Text }
    val reconnect = controls.firstOrNull { it.key == "common.reconnect" }
    val dismiss = controls.firstOrNull { it.key == "common.dismiss" }
    Box(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.TopCenter) {
        PolarisGraceBanner(
            body = text.getOrNull(1)?.text.orEmpty(),
            title = text.firstOrNull()?.text ?: return@Box,
            onReconnect = reconnect?.let { { onAction(KitAction.forCopyKey(it.key)) } },
            onDismiss = dismiss?.let { { onAction(null) } },
            modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)),
        )
    }
}

/**
 * The account pane (UI-KITS.md 4.3 AccountAndLicense): inset grouped rows, the product first. Rows
 * the account has (tier, holder, Manage with the new-window glyph, Devices, Cloud Sync, managed
 * settings) are one group, the update settings another under their header, and Sign out sits in its
 * own group in danger text.
 */
@Composable
private fun ColumnScope.KitAccountBody(
    lines: List<KitLine>,
    text: List<KitLine>,
    controls: List<KitLine>,
    onAction: (KitAction?) -> Unit,
    loading: Boolean = false,
) {
    fun has(key: String) = lines.firstOrNull { it.key == key }
    text.firstOrNull { it.key == "account.title" }?.let {
        PolarisTitle(it.text)
        Spacer(Modifier.height(polarisWindow.section))
    }
    // Loading draws the rows' shapes, shimmering, and says "Loading…" to assistive tech only (DL7).
    if (loading) {
        KitAccountSkeleton(has("common.loading")?.text.orEmpty())
        return
    }
    // State lines that are not rows ("Activated with a license key", "Offline · showing the last saved details").
    for (line in text.filter { it.key in setOf("account.keyOnly", "account.offline", "part.status.grace") }) {
        PolarisBody(line.text)
        Spacer(Modifier.height(PolarisSpace.controls))
    }
    val identityRows = listOfNotNull(has("account.tier"), has("account.holder"))
    val manage = has("common.manage")
    val navRows = listOfNotNull(has("account.devices"), has("account.cloudSync"), has("account.managedSettings"))
    if (identityRows.isNotEmpty() || manage != null) {
        PolarisSection(title = null) {
            for (row in identityRows) KitRow(row.text)
            manage?.let { KitRow(it.text, onClick = { onAction(KitAction.forCopyKey(it.key)) }, external = true) }
        }
        Spacer(Modifier.height(PolarisSpace.controls))
    }
    if (navRows.isNotEmpty()) {
        PolarisSection(title = null) { for (row in navRows) KitRow(row.text) }
        Spacer(Modifier.height(PolarisSpace.controls))
    }
    val updates = has("account.updates")
    val updateRows = listOf("account.autoUpdate", "account.channel", "update.checkNow", "account.version").any { has(it) != null }
    // The Updates group is its header and its rows; a header with no rows under it is not drawn.
    if (updates != null && updateRows) {
        PolarisSection(title = updates.text) {
            has("account.autoUpdate")?.let { KitRow(it.text) }
            has("account.channel")?.let { KitRow(it.text) }
            has("update.checkNow")?.let { KitRow(it.text, onClick = { onAction(KitAction.forCopyKey(it.key)) }) }
            has("account.version")?.let { KitRow(it.text) }
        }
        Spacer(Modifier.height(PolarisSpace.controls))
    }
    // Sign out is its own group, in danger text (not a button beside a primary).
    controls.firstOrNull { it.key == "common.signOut" }?.let { signOut ->
        PolarisSection(title = null) {
            KitRow(signOut.text, onClick = { onAction(KitAction.forCopyKey(signOut.key)) }, danger = true)
        }
    }
}

/** Three row-shaped bars in an inset group, shimmering; [label] is the announcement. */
@Composable
private fun KitAccountSkeleton(label: String) {
    val scheme = MaterialTheme.colorScheme
    val phase = rememberShimmerPhase()
    Column(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            contentDescription = label
            liveRegion = LiveRegionMode.Polite
        },
        verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
    ) {
        for (width in listOf(0.7f, 0.5f, 0.6f)) {
            SkeletonBar(phase, scheme.surfaceContainerHighest, scheme.onSurface.copy(alpha = 0.08f), Modifier.fillMaxWidth(width).height(20.dp))
        }
    }
}

/** One row of the account pane: the label at the start, 52 dp at least, a 48 dp target when it acts. */
@Composable
private fun KitRow(label: String, onClick: (() -> Unit)? = null, danger: Boolean = false, external: Boolean = false) {
    val color = if (danger) PolarisTheme.status.danger else MaterialTheme.colorScheme.onSurface
    val base = Modifier.fillMaxWidth().heightIn(min = 52.dp)
    Row(
        modifier = (
            if (onClick !=
                null
            ) {
                base.clickable(role = Role.Button, onClick = onClick)
            } else {
                base
            }
            ).polarisExternalSemantics(external).padding(horizontal = PolarisSpace.medium, vertical = PolarisSpace.controls),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = color)
        if (external) PolarisNewWindowGlyph()
    }
}

/** The step an OfflineActivation sentence is: 1 sends the request, 2 loads the response. */
private fun offlineStep(key: String): Int? = when (key) {
    "offlineActivation.request" -> 1
    "offlineActivation.loadHint" -> 2
    else -> null
}

/** One numbered step: the kit draws the number (a formatted integer, not copy); the sentence is the step. */
@Composable
private fun PolarisStep(number: Int, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls), verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(24.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
                .clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            Text(number.toString(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
        }
        PolarisBody(text, textAlign = TextAlign.Start, modifier = Modifier.weight(1f))
    }
}

/** The presentation member as the matrix's wire-free input. */
internal fun Presentation.toInput(): JsonObject {
    val out = linkedMapOf<String, JsonElement>("name" to JsonPrimitive(name), "icon" to JsonPrimitive(icon != null))
    developerName?.let { out["developerName"] = JsonPrimitive(it) }
    accent?.let { out["accent"] = JsonPrimitive(it) }
    accentDark?.let { out["accentDark"] = JsonPrimitive(it) }
    return JsonObject(out)
}

/** [this] with `presentation` set from [member] unless the inputs carry their own. */
public fun KitInputs.withPresentation(member: Presentation?): KitInputs =
    if (member == null || has("presentation")) this else with("presentation", member.toInput())

/**
 * The sign-in form for [inputs] (the matrix's `signIn`, `capabilities`, `services` ... members),
 * under the product's identity from [presentation]: the product header (icon and name) above the
 * title, then the controls in the kit's buttons. Wrap it in [PolarisTheme] with the same source to
 * draw the product's accent and icon.
 */
@Composable
public fun KitSignIn(
    inputs: KitInputs,
    presentation: PresentationSource? = null,
    modifier: Modifier = Modifier,
    onAction: (KitAction?) -> Unit = {},
    /** The catalog key of any control pressed (the provider row has no action in the vocabulary). */
    onControl: (String) -> Unit = {},
) {
    val member = rememberPresentation(presentation)
    KitScreenBody(
        screen = remember(inputs, member) { KitStates.resolve(KitComponent.signIn, inputs.withPresentation(member)) },
        modifier = modifier,
        catalog = KitCopy.bundled,
        locale = kitLocale(),
        onAction = onAction,
        focused = true,
        productName = member?.name,
        onControl = onControl,
    )
}
