// @pkey-feature ui.kit.holders
// The holders' steps wired to a live client (UK-43.10): the gate's Done step after a key activates (the key
// held in memory until Start using), the account step it leads to, and the same account step from Settings.
//
//   done  ActivateDone (PolarisHolders.kt). Start using ends the flow and forgets the key. The recommendation
//         opens the account step; where the kit has no in-app channel (Android TV) or Identity is off it opens
//         the portal instead, through PolarisOpener, with `#key=` on a phone or a desktop and never on a TV,
//         which shows the manage QR (D5).
//   qr    The TV's manage QR, with no key in it.
//   add   AddToAccount over PolarisAddToAccountState and the SDK driver. A press that will open the browser
//         arms the host's tab first (PolarisHolderOptions.armTab), then runs.
//
// Rules: Back is never a decline and never cancels work in flight (PolarisHolders.kt owns that on the
// form; here Back from an idle form goes back to Done); problems stay on their screen.

@file:Suppress(
    "ktlint:standard:function-naming",
    "FunctionNaming",
    "LongMethod",
    "CyclomaticComplexMethod",
    "LongParameterList",
    "MatchingDeclarationName",
    "ReturnCount",
)

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import im.plrs.key.core.CUSTOMER_ORIGIN_DEFAULT
import im.plrs.key.core.ManageLink
import im.plrs.key.identity.NativeRedirectOptions
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What a host gives the holders' account step.
 *
 * @param native the host's native redirect setup (registered schemes, claimed links); null leaves the SDK's defaults.
 * @param armTab runs inside a press that is about to open the browser, before it does (an Android host registers the
 *   launcher its Custom Tab returns to here). The press is the one `willOpenBrowser` says opens a tab.
 */
public class PolarisHolderOptions(public val native: NativeRedirectOptions? = null, public val armTab: () -> Unit = {})

/** "this phone": the noun the Done line uses for this device. */
@Composable
private fun holderDeviceKind(): String = when (val own = ownFormFactor()) {
    "desktop" -> "computer"
    "tv" -> "TV"
    else -> own
}

/** Loads the facts once for [client]; null until they are read. */
@Composable
internal fun rememberHolderFacts(client: PolarisKeyClient, key: PolarisKeyDone?): HolderFacts? {
    val tv = isTelevision()
    val kind = holderDeviceKind()
    var facts by remember(client) { mutableStateOf<HolderFacts?>(null) }
    LaunchedEffect(client, tv, kind) {
        facts = client.holderFacts(if (tv) HOLDER_ADD_IN_PORTAL else HOLDER_ADD_IN_APP, kind, key)
    }
    return facts
}

/** The facts' input under the product's identity (the presentation member, else the theme's name). */
@Composable
private fun holderBase(client: PolarisKeyClient, facts: HolderFacts): JsonObject {
    val member = rememberPresentation(client.presentationSource)
    val themeName = PolarisTheme.copy.productName
    return remember(facts, member, themeName) {
        val presentation = member?.toInput() ?: JsonObject(mapOf("name" to JsonPrimitive(themeName), "icon" to JsonPrimitive(false)))
        JsonObject(facts.base + ("presentation" to presentation))
    }
}

/** The portal opened through the validating opener; false when the link was missing or refused. */
internal fun PolarisOpener.openPortal(link: String?, key: String?, tv: Boolean): Boolean {
    val target = link ?: return false
    // `#key=` rides only a phone's or a desktop's link; a TV's code is shown on a shared screen and holds none.
    return this(if (key != null && !tv) ManageLink.withKey(target, key) else target)
}

private enum class HolderStage { Done, Qr, Add }

/**
 * The Done step after a key activates, and what it leads to. [done] holds the key in memory; [onFinish] is Start using
 * (the gate forgets the key and shows the product).
 */
@Composable
internal fun PolarisKeyDoneFlow(
    client: PolarisKeyClient,
    done: PolarisKeyDone,
    options: PolarisHolderOptions,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val facts = rememberHolderFacts(client, done)
    if (facts == null) {
        PolarisProgressScreen(PolarisTheme.copy.gateLoading, modifier)
        return
    }
    PolarisHolderSteps(client, facts, done.key, fromSettings = false, options, onFinish, modifier)
}

/**
 * The steps over loaded [facts]. [key] is the activated key when the flow starts at Done, null from Settings (which
 * starts at the account step, or the QR on a TV).
 */
@Composable
internal fun PolarisHolderSteps(
    client: PolarisKeyClient,
    facts: HolderFacts,
    key: String?,
    fromSettings: Boolean,
    options: PolarisHolderOptions,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tv = isTelevision()
    val base = holderBase(client, facts)
    val opener = rememberPolarisOpener()
    val scope = rememberCoroutineScope()
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    var stage by rememberSaveable {
        mutableStateOf(
            if (key != null) {
                HolderStage.Done
            } else if (facts.portalOnly) {
                HolderStage.Qr
            } else {
                HolderStage.Add
            },
        )
    }
    // What the screens report beyond the state: the device-code page opened once, a page that did not open, a sign-in that runs.
    var opened by remember { mutableStateOf(false) }
    var openFailed by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    val noBrowser = catalog.format("signin.handoff.noBrowser", locale)
    // The device-code fallback opens its page through the host's opener inside the press that started it.
    val pageOpener: (String) -> Boolean = { url ->
        val ok = opener(url)
        if (ok) opened = true
        openFailed = !ok
        ok
    }
    val driver = remember(client, options.native) { client.addToAccountDriver(options.native, pageOpener) }
    val kind = holderDeviceKind()
    // Held above the steps: Cancel or Back within the flow keeps what was typed.
    val state = remember(driver, base, kind, fromSettings) { PolarisAddToAccountState(driver, scope, base, kind, fromSettings) }
    val ui by state.ui.collectAsState()
    val product = PolarisTheme.copy.productName
    val signInFailed = catalog.format("activate.attach.failed", locale, mapOf("product" to CopyArgument.Text(product)))
    fun signInAs(hint: String?) {
        if (working) return
        working = true
        failed = null
        options.armTab()
        job = scope.launch {
            val ok = client.signInToAccount(hint, options.native, pageOpener)
            working = false
            if (ok) onFinish() else failed = signInFailed
        }
    }
    fun leave() {
        job?.cancel()
        working = false
        failed = null
        if (key != null) stage = HolderStage.Done else onFinish()
    }
    val problem = if (openFailed) noBrowser else failed
    when (stage) {
        HolderStage.Done -> {
            val screen = remember(base) { KitStates.resolve(KitComponent.activateDone, KitInputs.fromJson(base)) }
            PolarisActivateDone(
                screen,
                onStartUsing = onFinish,
                onAdd = {
                    when {
                        !screen.shows("signin.key.addInLocker") -> stage = HolderStage.Add

                        tv -> stage = HolderStage.Qr

                        else -> {
                            val shown = opener.openPortal(facts.portal, key, tv)
                            openFailed = !shown
                        }
                    }
                },
                // "Sign in as m•••@…": the sign-in for that address, never the blank form.
                onWaitingSignIn = { signInAs(facts.holderEmail) },
                extras = HolderExtras(problem = problem, working = working, noAddAction = facts.portal == null),
                modifier = modifier,
            )
        }

        HolderStage.Qr -> HolderQr(facts.portal, modifier, onBack = ::leave)

        HolderStage.Add -> {
            val idle = ui.step != "busy" && !working
            // Back from an idle form goes back to Done; from Added it goes on, as Start using does (Done would offer a second Add).
            val back = PolarisBackHandler(enabled = idle) { if (ui.step == "added") onFinish() else leave() }
            fun arm() {
                if (state.willOpenBrowser) options.armTab()
            }
            Box(modifier.then(back)) {
                PolarisAddToAccount(
                    state,
                    onStartUsing = onFinish,
                    onDone = onFinish,
                    // Cancel on a running sign-in leaves it and keeps the form; Cancel anywhere else leaves the step.
                    onCancel = {
                        val running = ui.step == "busy"
                        job?.cancel()
                        working = false
                        failed = null
                        openFailed = false
                        if (!running) leave()
                    },
                    onSubmit = {
                        opened = false
                        openFailed = false
                        arm()
                        state.submit()
                    },
                    onTryAgain = {
                        opened = false
                        openFailed = false
                        arm()
                        state.tryAgain()
                    },
                    onReopen = {
                        state.reopen()
                    },
                    // Both ways into an account sign in for real and wait for it: finish when signed in, else say so here.
                    onVerify = { openFailed = !opener.openPortal(facts.account, null, tv) },
                    onOtherAccount = { signInAs(facts.holderEmail) },
                    onSignIn = { signInAs(ui.email.takeIf { it.isNotBlank() }) },
                    extras = HolderExtras(
                        opened = opened || ui.address == null,
                        problem = problem,
                        working = working,
                        noVerify = facts.account == null,
                    ),
                )
            }
        }
    }
}

/**
 * The manage QR a TV shows for adding the license in the portal: the key-free link, scanned on a phone. With no link it draws
 * no "Scan" sentence: it says it could not open and gives the portal's address as text.
 */
@Composable
internal fun HolderQr(portal: String?, modifier: Modifier, onBack: () -> Unit) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val back = PolarisBackHandler(enabled = true, onBack = onBack)
    val link = portal?.takeIf { isSafeHttpsLink(it) }
    PolarisScaffold(
        modifier = modifier.then(back),
        anchor = PolarisAnchor.Top,
        contentAlign = androidx.compose.ui.text.style.TextAlign.Start,
        content = {
            PolarisProductHeader()
            PolarisTitle(catalog.format("signin.key.addInLocker", locale))
            Spacer(Modifier.height(PolarisSpace.tight))
            if (link != null) {
                PolarisBody(catalog.format("signin.key.scan", locale))
                Spacer(Modifier.height(polarisWindow.section))
                PolarisQr(link, catalog.format("a11y.qrManage", locale), Modifier.size(polarisWindow.qrSize))
            } else {
                HolderProblem(catalog.format("signin.handoff.noBrowser", locale))
            }
            Spacer(Modifier.height(PolarisSpace.controls))
            PolarisBody(catalog.format("signin.handoff.url", locale, mapOf("url" to CopyArgument.Text(link ?: CUSTOMER_ORIGIN_DEFAULT))))
        },
        actions = { PolarisPrimaryButton(catalog.format("common.done", locale), onClick = onBack, initialFocus = true) },
    )
}

/**
 * The gate's Done step for the boot shell: draws it (and answers true) while a key has just activated, the license is usable
 * and the step is on. Without a client, or with the step off, the key is forgotten at once and the product shows as before.
 */
@Composable
internal fun PolarisGateKeyDone(
    gate: PolarisGateState?,
    client: PolarisKeyClient?,
    enabled: Boolean,
    options: PolarisHolderOptions,
    modifier: Modifier,
): Boolean {
    val done = gate?.keyDone?.collectAsState()?.value
    val usable = gate?.gate?.collectAsState()?.value?.license?.status?.let { im.plrs.key.core.isUsable(it) } == true
    LaunchedEffect(done, client, enabled) { if (done != null && (client == null || !enabled)) gate?.finishKeyDone() }
    if (!enabled || !usable) return false
    if (gate == null || client == null || done == null) return false
    PolarisKeyDoneFlow(client, done, options, onFinish = gate::finishKeyDone, modifier = modifier)
    return true
}

/** Settings' view of a floating license: the Add row's action, and the screen it opens in place of the list. */
internal class FloatingAdd(val onAdd: (() -> Unit)?, val external: Boolean, val screen: (@Composable () -> Unit)?, val problem: String? = null)

/**
 * Add your name and email from Settings (UK-43): a license held by its key alone offers it. Identity off opens the portal in the
 * browser; a TV shows the manage QR; everywhere else the account form takes the list's place until it is done ([onClosed]).
 */
@Composable
internal fun rememberFloatingAdd(
    client: PolarisKeyClient?,
    floating: Boolean,
    options: PolarisHolderOptions,
    modifier: Modifier,
    onClosed: () -> Unit,
): FloatingAdd {
    val facts = if (floating && client != null) rememberHolderFacts(client, null) else null
    var adding by rememberSaveable { mutableStateOf(false) }
    val opener = rememberPolarisOpener()
    val tv = isTelevision()
    var openFailed by remember { mutableStateOf(false) }
    val noBrowser = KitCopy.bundled.format("signin.handoff.noBrowser", kitLocale())
    if (client == null || facts == null) return FloatingAdd(null, false, null)
    val screen: (@Composable () -> Unit)? = if (adding) {
        {
            PolarisHolderSteps(
                client,
                facts,
                key = null,
                fromSettings = true,
                options = options,
                onFinish = {
                    adding = false
                    onClosed()
                },
                modifier = modifier,
            )
        }
    } else {
        null
    }
    val external = facts.portalOnly && !tv
    // A portal with no link behind it is not offered; one that does not open says so under the rows.
    return FloatingAdd(
        onAdd = (
            {
                if (external) openFailed = !opener.openPortal(facts.portal, null, tv) else adding = true
            }
            ).takeUnless { external && facts.portal == null },
        external = external,
        screen = screen,
        problem = noBrowser.takeIf { openFailed },
    )
}
