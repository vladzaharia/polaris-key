// The styled components the matrix-driven renderer used to draw as plain lines (UI-KITS.md §4.1):
// LicenseChoice, Paywall, ReleaseNotes, EntitlementGate, CloudSyncStatus and About. They are built
// the way the React and Swift kits build them: KitStates answers the state and the catalog lines
// (a KitScreen), and the row data under those lines (a license's origin and term, a release's
// notes, what a tier adds) arrives as KitRowData, so the same inputs draw the same screen.
//
// Each is stateless over its inputs and exported on its own; PolarisKitScreen routes the matrix
// components here when it is given the rows.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** The catalog lines of one [KitScreen], formatted for one locale, with the dangling ones left out. */
internal class KitLines(private val screen: KitScreen, private val catalog: KitCopy, private val locale: String) {
    /** The formatted line [key], or null when the screen does not carry it or would show an unfilled argument. */
    fun text(key: String): String? =
        screen.copy.firstOrNull { it.key == key }?.takeUnless(catalog::isDangling)?.let { catalog.format(it, locale) }

    fun has(key: String): Boolean = text(key) != null

    /** A line the screen need not carry (a row's own template), formatted from [args]. */
    fun format(key: String, args: Map<String, CopyArgument> = emptyMap()): String = catalog.format(key, locale, args)

    fun format(line: CopyLine): String = catalog.format(line, locale)
}

// ── LicenseChoice ────────────────────────────────────────────────────────────────────────────

/** The states of LicenseChoice that list license rows. */
internal val LicenseChoiceRowStates: Set<String> = setOf("many", "mixed", "current", "one", "all-full")

/**
 * Step 3 of the sign-in form (SIGN-IN.md §3.6; UI-KITS.md 4.1 LicenseChoice): the licenses as one
 * inset list. Each row names the license (its own name, else the product), the tier pill with
 * "{n} of {limit} devices" and a seat meter, the origin in plain words and the term; the chosen
 * row is tinted and checked (rule 2: a tint plus one indicator); a license whose devices are all in
 * use is a row without a radio, never dimmed below its contrast (rule 9).
 *
 * @param screen the LicenseChoice state ([KitStates.resolve]).
 * @param choices the license rows; the preselected one is chosen to start with.
 * @param onContinue the person chose [String] (a license id) and pressed Use this license.
 * @param onAction any other control the state offers (Use a license key instead, ...).
 */
@Composable
public fun PolarisLicenseChoice(
    screen: KitScreen,
    choices: KitLicenseChoices,
    modifier: Modifier = Modifier,
    onContinue: (String) -> Unit = {},
    onAction: (KitAction?) -> Unit = {},
    onSelect: (String) -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
    /** The automatic sign-in's "Use another account", offered with every license on all its devices. */
    onUseAnotherAccount: (() -> Unit)? = null,
) {
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val firstFree = choices.choices.firstOrNull { !it.isFull }?.id
    var selected by rememberSaveable(choices) { mutableStateOf(choices.preselected?.takeIf { id -> choices.choices.any { it.id == id && !it.isFull } } ?: firstFree) }
    val theme = PolarisTheme.current
    val developer = theme.developer ?: productName(theme.copy) ?: ""
    val product = productName(theme.copy).orEmpty()
    val controls = screen.copy.filter { kitLineRole(it.key) == KitLineRole.Control && !catalog.isDangling(it) }
    val body = screen.copy.filter {
        kitLineRole(it.key) == KitLineRole.Text && !isRowFragment(it.key) &&
            it.key != "signin.choice.title" && it.key != "signin.choice.group" && !catalog.isDangling(it)
    }
    PolarisScaffold(
        modifier = modifier,
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        dockActionsAtLargeType = true,
        content = {
            PolarisProductHeader()
            PolarisTitle(lines.text("signin.choice.title") ?: lines.format("signin.choice.title"))
            Spacer(Modifier.height(PolarisSpace.tight))
            for (line in body) {
                PolarisBody(catalog.format(line, locale))
                Spacer(Modifier.height(PolarisSpace.tight))
            }
            Spacer(Modifier.height(PolarisSpace.controls))
            PolarisSection(title = lines.text("signin.choice.group")) {
                // Android (Expressive): a connected group, large outer corners, small inner ones, a 2 dp gap.
                val connected = polarisConnectedRows
                val outer = MaterialTheme.shapes.medium
                choices.choices.forEachIndexed { i, choice ->
                    if (i > 0 && connected) Spacer(Modifier.height(PolarisConnectedGap))
                    if (i > 0 && !connected) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    PolarisLicenseRow(
                        choice = choice,
                        title = choice.name ?: product.ifEmpty { choice.tierName },
                        selected = choice.id == selected,
                        shape = if (connected) polarisConnectedShape(i, choices.choices.size, outer) else RectangleShape,
                        lines = lines,
                        developer = developer,
                        store = STORE_NAME,
                        locale = locale,
                        onClick = {
                            selected = choice.id
                            onSelect(choice.id)
                        },
                    )
                }
            }
        },
        actions = {
            controls.forEachIndexed { index, line ->
                val text = catalog.format(line, locale)
                if (line.key == "signin.choice.continue") {
                    PolarisPrimaryButton(text, onClick = { selected?.let(onContinue) }, enabled = selected != null, initialFocus = true)
                } else if (index == 0 && controls.none { it.key == "signin.choice.continue" }) {
                    PolarisPrimaryButton(text, onClick = { onAction(KitAction.forCopyKey(line.key)) }, external = KitAction.leavesApp(line.key))
                } else {
                    PolarisTextButton(text, onClick = { onAction(KitAction.forCopyKey(line.key)) })
                }
                if (index < controls.lastIndex) Spacer(Modifier.height(PolarisSpace.controls))
            }
            if (screen.state == "all-full") {
                // Every license is on all its devices: Replace a device where the host can send the person there,
                // and always a way back to the gate (never a dead end, UI-KITS.md 4.1 LicenseChoice).
                if (KitAction.replaceInBrowser in screen.actions) {
                    PolarisPrimaryButton(
                        catalog.format("signin.replace.open", locale),
                        onClick = { onAction(KitAction.replaceInBrowser) },
                        external = true,
                        initialFocus = true,
                    )
                    Spacer(Modifier.height(PolarisSpace.controls))
                }
                onUseAnotherAccount?.let {
                    PolarisTextButton(catalog.format("signin.auto.confirm.other", locale), onClick = it)
                }
                PolarisTextButton(catalog.format("common.cancel", locale), onClick = { onAction(KitAction.cancel) })
            }
        },
    )
}

/** The store named by a store-bought license when the sign-in view does not say which (Play on Android). */
private const val STORE_NAME: String = "Google Play"

/** One license row of [PolarisLicenseChoice]. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PolarisLicenseRow(
    choice: KitLicenseChoice,
    title: String,
    selected: Boolean,
    shape: Shape = RectangleShape,
    lines: KitLines,
    developer: String,
    store: String,
    locale: String,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val date = choice.expiresAt?.let { kitDate(it, locale) }
    val seats = choice.seatsLine()?.let(lines::format)
    val meta = lines.format(choice.metaLine(developer, store, date))
    val tag = when {
        choice.isFull -> lines.format("signin.choice.tag.full")
        choice.current -> lines.format("signin.choice.tag.current")
        else -> null
    }
    val fill = when {
        selected -> scheme.primaryContainer
        shape !== RectangleShape -> scheme.surfaceContainerHigh
        else -> androidx.compose.ui.graphics.Color.Transparent // polaris-lint: allow-colour (no fill)
    }
    val base = Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(shape).background(fill) // polaris-lint: allow-colour (no fill)
    // A full license is a row without a radio: readable, not selectable.
    val clickable = if (choice.isFull) {
        base.semantics(mergeDescendants = true) {}
    } else {
        base.selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
    }
    Row(clickable.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                if (choice.tierName.isNotBlank()) KitTag(choice.tierName)
                if (seats != null) Text(seats, style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = "tnum"), color = scheme.onSurfaceVariant)
                if (tag != null) Text(tag, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
            }
            choice.seats?.takeIf { it.limit > 0 }?.let { s ->
                PolarisSeatMeter(
                    used = s.used,
                    limit = s.limit,
                    caption = null,
                    description = lines.format("a11y.seatMeter", mapOf("used" to CopyArgument.Number(s.used), "limit" to CopyArgument.Number(s.limit))),
                    modifier = Modifier.width(112.dp),
                )
            }
            Text(meta, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
        }
        if (selected) {
            Spacer(Modifier.width(12.dp))
            Icon(PolarisSymbols.Check, contentDescription = null, tint = PolarisTheme.accentText, modifier = Modifier.size(24.dp))
        }
    }
}

/** The quiet neutral tag of the kit (`k-tag`: 12 px 500, full radius, the strongest text at 9 %). */
@Composable
internal fun KitTag(text: String) {
    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.09f), contentColor = MaterialTheme.colorScheme.onSurface) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
    }
}

// ── Paywall ──────────────────────────────────────────────────────────────────────────────────

/**
 * The upsell (UI-KITS.md 4.1 Paywall): what the tier adds, and the way to get it, never an invented
 * checkout. The kit computes no price: the store (Play Billing here) draws the purchase, or the
 * portal opens in the browser. States: offers, purchasing, restore (busy), purchased, loading.
 * "Not available here" is [PolarisKitScreen]'s message and not drawn here.
 *
 * @param features what the tier adds, as the product names it.
 * @param onUpgrade the person asked to buy ([onPortal] when the build has no purchase capability).
 */
@Composable
public fun PolarisPaywall(
    screen: KitScreen,
    features: List<String>,
    modifier: Modifier = Modifier,
    onUpgrade: () -> Unit = {},
    onPortal: () -> Unit = {},
    onRedeem: () -> Unit = {},
    onDone: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val copy = PolarisTheme.copy
    when (screen.state) {
        "loading" -> PolarisProgressScreen(lines.text("common.loading") ?: copy.loading, modifier)
        "purchased" -> PolarisMessageLayout(
            modifier = modifier,
            emblem = { PolarisIconBadge(PolarisSymbols.Check, PolarisTheme.status.successContainer, PolarisTheme.status.success) },
            title = lines.text("paywall.purchased").orEmpty(),
            body = null,
            actions = { PolarisPrimaryButton(lines.text("common.done").orEmpty(), onDone, initialFocus = true) },
        )
        else -> PolarisScreen(
            modifier = modifier,
            showLogo = false,
            actions = {
                val busy = screen.state == "purchasing" || screen.state == "restore"
                when (screen.state) {
                    "purchasing" -> PolarisPrimaryButton(lines.text("paywall.purchasing").orEmpty(), onClick = {}, busy = true)
                    "restore" -> PolarisSecondaryButton(lines.text("paywall.restore").orEmpty(), onClick = {}, busy = true)
                    else -> {
                        lines.text("paywall.upgrade")?.let { PolarisPrimaryButton(it, onUpgrade, initialFocus = true) }
                        lines.text("paywall.portal")?.let { PolarisPrimaryButton(it, onPortal, initialFocus = true, external = true) }
                    }
                }
                if (!busy) lines.text("paywall.redeem")?.let {
                    Spacer(Modifier.height(PolarisSpace.controls))
                    PolarisTextButton(it, onRedeem)
                }
            },
        ) {
            PolarisProductHeader()
            PolarisTitle(lines.text("paywall.title") ?: "")
            val includes = lines.text("paywall.includes")
            if (includes != null && features.isNotEmpty()) {
                Spacer(Modifier.height(polarisWindow.section))
                PolarisSection(title = includes) {
                    for (feature in features) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.Top) {
                            Icon(PolarisSymbols.Check, contentDescription = null, tint = PolarisTheme.accentText, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(12.dp))
                            Text(feature, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            }
        }
    }
}

// ── ReleaseNotes ─────────────────────────────────────────────────────────────────────────────

/**
 * The changelog (UI-KITS.md 4.1 ReleaseNotes). One inset card per version: the version at the start
 * and the release date (in the reader's style, never the ISO text) at the end, the notes under
 * them. Notes are plain text: remote markup shows as text and never runs. States: loading, list,
 * empty, error (with Try again).
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
public fun PolarisReleaseNotes(
    screen: KitScreen,
    notes: List<KitReleaseNote>,
    modifier: Modifier = Modifier,
    onRetry: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val copy = PolarisTheme.copy
    if (screen.state == "loading") {
        PolarisProgressScreen(lines.text("common.loading") ?: copy.loading, modifier)
        return
    }
    PolarisScaffold(
        modifier = modifier,
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        actions = if (screen.state == "error") {
            { PolarisSecondaryButton(lines.text("common.tryAgain") ?: copy.retry, onRetry, initialFocus = true) }
        } else {
            null
        },
    ) {
        PolarisProductHeader()
        when (screen.state) {
            "error" -> PolarisBody(lines.text("releaseNotes.error").orEmpty())
            "empty" -> PolarisBody(lines.text("releaseNotes.empty").orEmpty())
            else -> {
                PolarisTitle(lines.text("releaseNotes.title") ?: "")
                Spacer(Modifier.height(polarisWindow.section))
                notes.forEachIndexed { i, note ->
                    if (i > 0) Spacer(Modifier.height(PolarisSpace.controls))
                    PolarisSection(title = null) {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            // The date wraps under the version when they do not fit one line, so no word is cut (DL11).
                            FlowRow(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
                                itemVerticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    lines.format("releaseNotes.version", mapOf("version" to CopyArgument.Text(note.version))),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    modifier = Modifier.semantics { heading() },
                                )
                                if (note.date.isNotBlank()) {
                                    Text(
                                        lines.format("releaseNotes.released", mapOf("date" to CopyArgument.Text(kitDay(note.date, locale)))),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            // Plain text: markup in a note is shown, never executed.
                            Text(note.notes, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            }
        }
    }
}

// ── EntitlementGate ──────────────────────────────────────────────────────────────────────────

/**
 * Renders [content] only while the entitlement holds (UI-KITS.md 4.1 EntitlementGate); otherwise
 * [locked], which defaults to the kit's locked card ("This feature needs {tier}." and Unlock).
 * Only [entitled] decides: a theme or a style never unlocks anything. Null is still loading.
 *
 * @param tier the tier that grants it, in the product's words, when known.
 * @param onUnlock opens the Paywall (or the host's own upsell); null leaves the card without a button.
 */
@Composable
public fun PolarisEntitlementGate(
    entitled: Boolean?,
    modifier: Modifier = Modifier,
    tier: String? = null,
    onUnlock: (() -> Unit)? = null,
    locked: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    when (entitled) {
        true -> content()
        null -> Row(modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
            PolarisProgress(PolarisTheme.copy.loading)
        }
        false -> if (locked != null) locked() else PolarisEntitlementLocked(tier, modifier, onUnlock)
    }
}

/** [PolarisEntitlementGate] over the provided client: [name] is the entitlement, live. */
@Composable
public fun PolarisEntitlementGate(
    name: String,
    modifier: Modifier = Modifier,
    tier: String? = null,
    onUnlock: (() -> Unit)? = null,
    locked: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val entitled by rememberPolarisEntitled(name)
    PolarisEntitlementGate(entitled, modifier, tier, onUnlock, locked, content)
}

/** The locked card: the lock, the sentence naming the tier, and Unlock. */
@Composable
public fun PolarisEntitlementLocked(tier: String? = null, modifier: Modifier = Modifier, onUnlock: (() -> Unit)? = null) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val sentence = tier?.takeIf { it.isNotBlank() }?.let { catalog.format("entitlement.locked", locale, mapOf("tier" to CopyArgument.Text(it))) }
    PolarisSection(title = null, modifier = modifier) {
        // With no tier to name there is no sentence: the row is the Unlock action itself.
        val actsItself = sentence == null && onUnlock != null
        val base = Modifier.fillMaxWidth().heightIn(min = 52.dp)
        Row(
            (if (actsItself) base.clickable(role = Role.Button, onClick = onUnlock!!) else base)
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(PolarisSymbols.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(12.dp))
            Text(
                sentence ?: catalog.format("entitlement.unlock", locale),
                style = MaterialTheme.typography.bodyLarge,
                color = if (actsItself) PolarisTheme.accentText else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
        }
        if (onUnlock != null && sentence != null) {
            // A lone action is the primary (DL4).
            Box(Modifier.fillMaxWidth().padding(PolarisSpace.controls)) {
                PolarisPrimaryButton(catalog.format("entitlement.unlock", locale), onUnlock)
            }
        }
    }
}

// ── CloudSyncStatus ──────────────────────────────────────────────────────────────────────────

/** What Cloud Sync is doing (UI-KITS.md 4.1 CloudSyncStatus). */
public enum class PolarisCloudSync {
    Synced, Syncing, Offline, Conflict, Error, SignedOut,

    /** This device holds no sync key: it says so and offers Unlock sync (never a sync time). */
    Locked,

    /** A different key ring is served: Review confirms it first, Unlock is never offered in its place. */
    RingChanged,
}

/**
 * A small status for Cloud Sync: when it last synced, that it is syncing, that changes wait for the
 * connection, that some conflict, or that it could not. An icon and words, never colour alone. It
 * claims nothing it does not know (no "backed up"). [onOpen] makes the whole line open the details;
 * a failed sync offers Try again, a signed-out one offers Sign in to sync, a locked one Unlock sync
 * and a changed ring Review (U-42; the host's own status source binds these later, Q-7).
 *
 * @param syncedAtMillis epoch milliseconds of the last sync, for "Synced 5 minutes ago".
 */
@Composable
public fun PolarisCloudSyncStatus(
    status: PolarisCloudSync,
    modifier: Modifier = Modifier,
    syncedAtMillis: Long? = null,
    nowMillis: Long = System.currentTimeMillis(),
    onOpen: (() -> Unit)? = null,
    onRetry: (() -> Unit)? = null,
    onSignIn: (() -> Unit)? = null,
    onUnlock: (() -> Unit)? = null,
    onReview: (() -> Unit)? = null,
) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val scheme = MaterialTheme.colorScheme
    val state = PolarisTheme.status
    val copy = PolarisTheme.copy
    val text = when (status) {
        PolarisCloudSync.Synced ->
            if (syncedAtMillis != null) catalog.format("cloudSync.synced", locale, mapOf("time" to CopyArgument.Text(copy.ago(((nowMillis - syncedAtMillis) / 1000).coerceAtLeast(0)))))
            else catalog.format("account.cloudSync", locale)
        PolarisCloudSync.Syncing -> catalog.format("cloudSync.syncing", locale)
        PolarisCloudSync.Offline -> catalog.format("cloudSync.offline", locale)
        PolarisCloudSync.Conflict -> catalog.format("cloudSync.conflict", locale)
        PolarisCloudSync.Error -> catalog.format("cloudSync.error", locale)
        PolarisCloudSync.SignedOut -> catalog.format("cloudSync.signedOut", locale)
        PolarisCloudSync.Locked -> catalog.format("cloudSync.locked", locale)
        PolarisCloudSync.RingChanged -> catalog.format("cloudSync.ringChanged", locale)
    }
    val (glyph, tint) = when (status) {
        PolarisCloudSync.Synced -> PolarisSymbols.Check to state.success
        PolarisCloudSync.Syncing -> PolarisSymbols.Refresh to scheme.onSurfaceVariant
        PolarisCloudSync.Offline, PolarisCloudSync.SignedOut -> PolarisSymbols.Info to scheme.onSurfaceVariant
        PolarisCloudSync.Locked -> PolarisSymbols.Lock to scheme.onSurfaceVariant
        PolarisCloudSync.RingChanged -> PolarisSymbols.Warning to state.warning
        PolarisCloudSync.Conflict -> PolarisSymbols.Warning to state.warning
        PolarisCloudSync.Error -> PolarisSymbols.Warning to state.danger
    }
    PolarisSection(title = null, modifier = modifier) {
        val row = Modifier.fillMaxWidth().heightIn(min = 52.dp)
        Row(
            (if (onOpen != null) row.clickable(role = Role.Button, onClick = onOpen) else row)
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.Top,
        ) {
            // The glyph sits on the first line of the label, not centred on a wrapped one (large fonts).
            val line = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toDp() }
            Icon(glyph, contentDescription = null, tint = tint, modifier = Modifier.padding(top = ((line - 20.dp) / 2).coerceAtLeast(0.dp)).size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(text, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface, modifier = Modifier.weight(1f))
        }
        val action = when {
            status == PolarisCloudSync.Error && onRetry != null -> catalog.format("common.tryAgain", locale) to onRetry
            status == PolarisCloudSync.SignedOut && onSignIn != null -> catalog.format("cloudSync.signIn", locale) to onSignIn
            status == PolarisCloudSync.Locked && onUnlock != null -> catalog.format("cloudSync.unlock", locale) to onUnlock
            status == PolarisCloudSync.RingChanged && onReview != null -> catalog.format("common.review", locale) to onReview
            else -> null
        }
        if (action != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) { PolarisTextButton(action.first, action.second) }
        }
    }
}

/**
 * The locked and changed-ring statuses bound to the kit's own unlock flow: Unlock sync and Review both
 * call [PolarisSyncState.open], which unlocks this device or shows the ring to confirm, and
 * [PolarisSyncFlow] draws the screens. Use this where the host has no handler of its own (the status
 * source itself binds with the host settings, Q-7).
 */
@Composable
public fun PolarisCloudSyncStatus(status: PolarisCloudSync, syncState: PolarisSyncState, modifier: Modifier = Modifier) {
    PolarisCloudSyncStatus(status, modifier, onUnlock = syncState::open, onReview = syncState::open)
}

// ── About ────────────────────────────────────────────────────────────────────────────────────

/** What About shows (UI-KITS.md 4.1 About). */
public class PolarisAboutInfo(
    public val version: String,
    /** The build identifier, when the host has one. */
    public val build: String? = null,
    /**
     * The diagnostics text Copy diagnostics puts on the clipboard (the host's own: versions, the
     * platform, the licence status). It is redacted before it is copied: tokens, keys and email
     * addresses never leave the device.
     */
    public val diagnostics: String = "",
)

/**
 * About: the product, its version and build, the legal rows, the Powered-by badge when the theme
 * asks for it, and Copy diagnostics (redacted, [redactDiagnostics]). A row whose callback is null is
 * not drawn.
 *
 * @param onCopied called with the redacted text that went on the clipboard.
 */
@Composable
public fun PolarisAbout(
    info: PolarisAboutInfo,
    modifier: Modifier = Modifier,
    onPrivacy: (() -> Unit)? = null,
    onSupport: (() -> Unit)? = null,
    onLicenses: (() -> Unit)? = null,
    onCopied: (String) -> Unit = {},
) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val copy = PolarisTheme.copy
    val clipboard = rememberPolarisClipboard()
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    val name = productName(copy)
    PolarisScaffold(modifier = modifier, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        PolarisProductHeader()
        PolarisTitle(if (name != null) catalog.format("about.title", locale, mapOf("product" to CopyArgument.Text(name))) else catalog.format("about.nav", locale))
        Spacer(Modifier.height(PolarisSpace.tight))
        val version = catalog.format("about.version", locale, mapOf("version" to CopyArgument.Text(info.version)))
        PolarisBody(listOfNotNull(version, info.build?.takeIf { it.isNotBlank() }).joinToString(" · "))
        Spacer(Modifier.height(polarisWindow.section))
        PolarisSection(title = null) {
            val rows = listOfNotNull(
                onPrivacy?.let { Triple(catalog.format("about.privacy", locale), true, it) },
                onSupport?.let { Triple(catalog.format("about.support", locale), true, it) },
                onLicenses?.let { Triple(catalog.format("about.licenses", locale), true, it) },
                Triple(catalog.format("about.copyDiagnostics", locale), false) {
                    val text = redactDiagnostics(info.diagnostics)
                    scope.launch { clipboard.setText(catalog.format("about.copyDiagnostics", locale), text) }
                    copied = true
                    onCopied(text)
                },
            )
            rows.forEachIndexed { i, (label, external, action) ->
                if (i > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(role = Role.Button, onClick = action).polarisExternalSemantics(external).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
                    if (external) PolarisNewWindowGlyph()
                }
            }
        }
        if (copied) {
            Spacer(Modifier.height(PolarisSpace.controls))
            Text(
                catalog.format("about.diagnosticsCopied", locale),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        // The attribution is the pane's last item, only when the theme asks for it (section 1.6).
        if (PolarisTheme.current.showPoweredBy) {
            Spacer(Modifier.height(PolarisSpace.group))
            PolarisPoweredBy()
        }
    }
}
