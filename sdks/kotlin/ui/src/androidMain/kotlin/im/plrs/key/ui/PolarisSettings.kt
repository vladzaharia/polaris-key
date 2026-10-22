// The settings screen: the licence (an entitlement badge, who it is licensed to, the entitlements
// it grants) and the product's user-facing configuration values with where each comes from.
//
// The headless half is editable (`settingsActions(editable = true)`, notes/SDK-PARITY-PASS.md §3.11):
// each row the catalog types carries a PolarisSettingEditor, PolarisSettingsState.set/reset persist a
// local override (`config.set` / `config.clear`), and an enforced row has no editor. The screen still
// renders the read-only summary: drawing the inputs is the UI-kit program's (docs/design/UI-KITS.md).

package im.plrs.key.ui

import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import im.plrs.key.config.ConfigSource
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseStatus
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/**
 * @param entitlementLabel the label an entitlement shows, or null to keep it off the screen: the
 *   kit never shows a raw entitlement name (UI-KITS.md §1.5 rule 11), so none shows by default.
 * @param navigationIcon an optional control above the title (a Back for the host's navigation).
 */
@Composable
public fun PolarisSettings(
    state: PolarisSettingsState,
    modifier: Modifier = Modifier,
    entitlementLabel: (String) -> String? = { null },
    navigationIcon: (@Composable () -> Unit)? = null,
) {
    val ui by state.ui.collectAsState()
    androidx.compose.runtime.LaunchedEffect(state) { state.load() }
    PolarisSettingsScreen(
        ui,
        modifier,
        entitlementLabel = entitlementLabel,
        onRetry = state::load,
        navigationIcon = navigationIcon,
        onSet = state::set,
        onReset = state::reset,
    )
}

/**
 * The stateless settings screen: a list screen, top-anchored under a start-aligned title. In a
 * landscape window 600 dp wide or more the licence and the configuration sit side by side.
 */
@Composable
public fun PolarisSettingsScreen(
    ui: PolarisSettingsUi,
    modifier: Modifier = Modifier,
    entitlementLabel: (String) -> String? = { null },
    onRetry: () -> Unit = {},
    navigationIcon: (@Composable () -> Unit)? = null,
    onSet: ((String, JsonElement) -> Unit)? = null,
    onReset: ((String) -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    if (ui.loading) {
        PolarisProgressScreen(copy.loading, modifier)
        return
    }
    PolarisSurface(modifier) { window, _ ->
        val sideBySide = window.width >= 600.dp && window.width > window.height
        PolarisScaffold(
            anchor = PolarisAnchor.Top,
            contentAlign = TextAlign.Start,
            maxContentWidth = if (sideBySide) 960.dp else Dp.Unspecified,
            navigationIcon = navigationIcon,
        ) {
            PolarisProductHeader()
            PolarisTitle(copy.settingsTitle)
            Spacer(Modifier.height(polarisWindow.section))
            // A refused edit is announced under the title, named by the catalog's copy (never the backend's detail).
            ui.error?.let {
                PolarisInlineNotice(copy.settingsFailureMessage(it))
                Spacer(Modifier.height(PolarisSpace.controls))
            }
            val license = ui.license
            val licenseCard: @Composable (Modifier) -> Unit = { m ->
                if (license != null) PolarisSection(null, m) { PolarisLicenseRow(license, entitlementLabel) }
            }
            val valuesCard: @Composable (Modifier) -> Unit = { m ->
                Column(m, verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
                    if (ui.loadFailure != null) {
                        PolarisSection(null) {
                            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                                PolarisInlineNotice(copy.settingsFailureMessage(ui.loadFailure))
                                Spacer(Modifier.height(PolarisSpace.controls))
                                PolarisSecondaryButton(copy.retry, onRetry)
                            }
                        }
                    } else if (ui.entries.isEmpty()) {
                        PolarisSection(null) {
                            Text(
                                text = copy.settingsEmpty,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            )
                        }
                    }
                    // Groups by provenance (UI-KITS.md 4.3): the developer's defaults under "From <Developer>",
                    // the rows a policy locks under "Managed settings", everything else in one list with no header.
                    for (group in settingGroups(ui.entries, PolarisTheme.current.developer)) {
                        PolarisSection(group.title) {
                            group.entries.forEachIndexed { i, entry ->
                                if (i > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                                PolarisSettingRow(entry, onSet, onReset)
                            }
                        }
                    }
                }
            }
            if (sideBySide && license != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group), verticalAlignment = Alignment.Top) {
                    licenseCard(Modifier.weight(1f))
                    valuesCard(Modifier.weight(1.4f))
                }
            } else {
                if (license != null) {
                    licenseCard(Modifier)
                    Spacer(Modifier.height(PolarisSpace.controls))
                }
                valuesCard(Modifier)
            }
            // The optional attribution is the screen's last item (UI-KITS.md section 1.6).
            if (PolarisTheme.current.showPoweredBy) {
                Spacer(Modifier.height(PolarisSpace.group))
                PolarisPoweredByLine()
            }
        }
    }
}

/** One list of rows under an optional catalog header. */
internal class SettingGroup(val title: String?, val entries: List<PolarisSettingEntry>)

/**
 * The settings' groups (UI-KITS.md 4.3): the developer's pushed defaults the person can still change
 * under "From <Developer>" (only when the developer is known, else they stay with the rest), then the
 * rows a policy locks under "Managed settings", then everything else with no header. Empty groups
 * are not drawn; a row belongs to exactly one.
 */
internal fun settingGroups(entries: List<PolarisSettingEntry>, developer: String?, locale: String = coreLocale()): List<SettingGroup> {
    fun locked(e: PolarisSettingEntry) = e.source == ConfigSource.enforced || e.source == ConfigSource.hidden
    val fromDeveloper = if (developer != null) entries.filter { !locked(it) && it.source == ConfigSource.remoteDefault } else emptyList()
    val managed = entries.filter(::locked)
    val rest = entries - fromDeveloper.toSet() - managed.toSet()
    val catalog = KitCopy.bundled
    return listOfNotNull(
        SettingGroup(catalog.format("settings.fromDeveloper", locale, mapOf("developer" to CopyArgument.Text(developer.orEmpty()))), fromDeveloper).takeIf { fromDeveloper.isNotEmpty() },
        SettingGroup(catalog.format("account.managedSettings", locale), managed).takeIf { managed.isNotEmpty() },
        SettingGroup(null, rest).takeIf { rest.isNotEmpty() },
    )
}

/** The colours of an entitlement badge for [status]. */
@Composable
internal fun entitlementColors(status: LicenseStatus): Pair<Color, Color> {
    val s = PolarisTheme.status
    return when (status) {
        LicenseStatus.ok, LicenseStatus.notApplicable -> s.successContainer to s.onSuccessContainer
        LicenseStatus.grace, LicenseStatus.expired -> s.warningContainer to s.onWarningContainer
        LicenseStatus.revoked, LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled ->
            s.dangerContainer to s.onDangerContainer
        LicenseStatus.needsActivation -> MaterialTheme.colorScheme.surfaceContainerHighest to MaterialTheme.colorScheme.onSurfaceVariant
    }
}

/** The entitlement badge: the licence status as a coloured pill, with no service-accent dot (UI-KITS.md 1.2). */
@Composable
public fun PolarisEntitlementBadge(status: LicenseStatus, modifier: Modifier = Modifier) {
    val (container, content) = entitlementColors(status)
    Surface(modifier = modifier, shape = CircleShape, color = container, contentColor = content) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(PolarisTheme.copy.entitlementLabel(status), style = MaterialTheme.typography.labelLarge)
        }
    }
}

/**
 * The licence card's row: the status chip, the licensee once (the chip already says "Licensed"),
 * and the entitlements the host labelled ([entitlementLabel]; an unlabelled one never shows).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PolarisLicenseRow(license: PolarisLicenseSummary, entitlementLabel: (String) -> String? = { null }) {
    val labelled = license.entitlements.mapNotNull(entitlementLabel)
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PolarisEntitlementBadge(license.status)
        license.holder?.let { holder ->
            Text(holder, style = MaterialTheme.typography.bodyLarge)
        }
        if (labelled.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (name in labelled) {
                    Surface(
                        shape = MaterialTheme.shapes.small,
                        color = MaterialTheme.colorScheme.surfaceContainerHighest,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                    ) {
                        Text(name, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
    }
}

/** The text a row shows for its value: On and Off for a boolean, the value as text otherwise. */
public fun PolarisCopy.settingValue(entry: PolarisSettingEntry): String = when {
    entry.editor is PolarisSettingEditor.Toggle -> if ((entry.editor as PolarisSettingEditor.Toggle).checked) settingsOn else settingsOff
    entry.value == "true" -> settingsOn
    entry.value == "false" -> settingsOff
    else -> entry.value
}

/** The supporting text for where a value comes from, or null for nothing to say. */
public fun PolarisCopy.sourceLabel(source: ConfigSource?): String? = when (source) {
    ConfigSource.enforced, ConfigSource.hidden -> settingsLocked
    ConfigSource.local -> settingsSourceLocal
    ConfigSource.env -> settingsSourceEnv
    ConfigSource.remoteDefault -> settingsSourceDefault
    ConfigSource.fallback -> settingsSourceFallback
    null -> null
}

/** Catalog copy for a typed settings failure; never display a backend detail verbatim. */
internal fun PolarisCopy.settingsFailureMessage(failure: PolarisSettingsFailure?): String = when (failure?.code) {
    ErrorCode.managedByAdmin -> settingsLocked
    else -> settingsLoadFailed
}

@Composable
internal fun PolarisSettingRow(entry: PolarisSettingEntry, onSet: ((String, JsonElement) -> Unit)? = null, onReset: ((String) -> Unit)? = null) {
    val copy = PolarisTheme.copy
    val locked = entry.source == ConfigSource.enforced || entry.source == ConfigSource.hidden
    val toggle = (entry.editor as? PolarisSettingEditor.Toggle)?.takeIf { !locked && onSet != null }
    if (toggle != null) {
        PolarisSwitchRow(entry, toggle.checked, onSet!!, onReset)
        return
    }
    // At large font scales the value moves under its name, so neither is squeezed into a sliver.
    val stacked = LocalDensity.current.fontScale >= 1.5f
    val value: @Composable (Modifier) -> Unit = { modifier ->
        Row(
            modifier,
            horizontalArrangement = if (stacked) Arrangement.Start else Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (locked) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(
                text = copy.settingValue(entry),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (stacked) Int.MAX_VALUE else 3,
                overflow = TextOverflow.Ellipsis,
                textAlign = if (stacked) TextAlign.Start else TextAlign.End,
            )
        }
    }
    // A locked row names its config source: "Set by <Developer>" when the product's developer is known.
    val source = if (locked) PolarisTheme.current.developer?.let { KitCopy.bundled.format("settings.setBy", kitLocale(), mapOf("org" to CopyArgument.Text(it))) } ?: copy.sourceLabel(entry.source) else copy.sourceLabel(entry.source)
    val rowModifier = Modifier
        .fillMaxWidth()
        .heightIn(min = 56.dp)
        .padding(horizontal = 16.dp, vertical = 12.dp)
        .semantics(mergeDescendants = true) {}
    if (stacked) {
        Column(rowModifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(entry.label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            value(Modifier)
            source?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        return
    }
    Row(rowModifier, verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(entry.label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            source?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Spacer(Modifier.width(16.dp))
        // The value fills its share and sits at the row's trailing edge.
        value(Modifier.weight(0.8f))
    }
}

/**
 * A boolean setting as a switch row (UI-KITS.md 4.3: typed controls from the catalog schema): the
 * label and its provenance text at the start, the switch at the end, at least 52 dp and a 48 dp
 * target. A locked setting is never a dimmed switch: it is [PolarisSettingRow]'s text row. A change
 * the person made on this device offers "Reset to default" under the row.
 */
@Composable
internal fun PolarisSwitchRow(entry: PolarisSettingEntry, checked: Boolean, onSet: (String, JsonElement) -> Unit, onReset: ((String) -> Unit)?) {
    val copy = PolarisTheme.copy
    val source = copy.sourceLabel(entry.source)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .toggleable(value = checked, role = Role.Switch, onValueChange = { onSet(entry.key, JsonPrimitive(it)) })
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(entry.label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
                source?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            Spacer(Modifier.width(16.dp))
            // The row is the control (one target, one name): the switch only draws the state.
            Switch(checked = checked, onCheckedChange = null)
        }
        if (entry.source == ConfigSource.local && onReset != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                PolarisTextButton(KitCopy.bundled.format("settings.reset", kitLocale()), onClick = { onReset(entry.key) })
            }
        }
    }
}
