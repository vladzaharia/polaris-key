// The settings screen: the licence (an entitlement badge, who it is licensed to, the entitlements
// it grants) and the product's user-facing configuration values with where each comes from.
//
// The headless half is editable (`settingsActions(editable = true)`, notes/SDK-PARITY-PASS.md §3.11):
// each row the catalog types carries a PolarisSettingEditor, PolarisSettingsState.set/reset persist a
// local override (`config.set` / `config.clear`), and an enforced row has no editor. The screen still
// renders the read-only summary: drawing the inputs is the UI-kit program's (docs/design/UI-KITS.md).

package im.plrs.key.ui

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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import im.plrs.key.config.CatalogEntry
import im.plrs.key.config.ConfigSource
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** The licence as the settings screen summarises it. */
public data class PolarisLicenseSummary(
    val status: LicenseStatus,
    /** The licence holder's display name, when the licence carries a profile. */
    val holder: String? = null,
    /** Entitlements granted (true flags, or any non-false value), by name. */
    val entitlements: List<String> = emptyList(),
)

/** How an editable row takes a new value, typed from the catalog entry's schema. */
public sealed interface PolarisSettingEditor {
    public data class Toggle(val checked: Boolean) : PolarisSettingEditor

    /** One of [options] (label to value); [selected] is the current value's index, or -1. */
    public data class Choice(val options: List<Pair<String, JsonElement>>, val selected: Int) : PolarisSettingEditor

    public data class Number(val value: String, val integer: Boolean, val min: Double? = null, val max: Double? = null) : PolarisSettingEditor

    public data class Text(val value: String, val maxLength: Int? = null) : PolarisSettingEditor
}

/** One configuration value. */
public data class PolarisSettingEntry(
    val key: String,
    /** What the row shows as its name; the key by default. */
    val label: String = key,
    /** The value as text. */
    val value: String,
    val source: ConfigSource? = null,
    /** The input an editable screen renders; null keeps the row read-only. */
    val editor: PolarisSettingEditor? = null,
    /** The catalog's description, shown under an editable row. */
    val description: String? = null,
)

public data class PolarisSettingsUi(
    val loading: Boolean = true,
    val license: PolarisLicenseSummary? = null,
    val entries: List<PolarisSettingEntry> = emptyList(),
    /** The copy of the last refused change (a value the catalog refuses, an enforced key), or null. */
    val error: String? = null,
)

/** The SDK calls the settings screen makes. [PolarisKeyClient.settingsActions] adapts the umbrella client. */
public interface PolarisSettingsActions {
    public suspend fun license(): PolarisLicenseSummary?
    public suspend fun entries(): List<PolarisSettingEntry>

    /** Persist [value] for [key] (a local override). Throws the SDK's refusal. */
    public suspend fun set(key: String, value: JsonElement) {}

    /** Clear the local override for [key]. */
    public suspend fun reset(key: String) {}
}

/** The editor the catalog [entry] implies for [value], or null when the kit has no input for it. */
public fun settingEditor(entry: CatalogEntry?, value: JsonElement): PolarisSettingEditor? {
    val type = entry?.type ?: when {
        value is JsonPrimitive && value.isString -> "string"
        value is JsonPrimitive && value.booleanOrNull != null -> "boolean"
        value is JsonPrimitive && value.content.toBigDecimalOrNull() != null -> if (value.content.toBigDecimal().stripTrailingZeros().scale() <= 0) "integer" else "number"
        else -> null
    }
    entry?.enumValues?.let { options ->
        val labelled = options.map { settingText(it) to it }
        return PolarisSettingEditor.Choice(labelled, options.indexOf(value))
    }
    fun num(name: String) = (entry?.schema?.get(name) as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()
    return when (type) {
        "boolean" -> PolarisSettingEditor.Toggle((value as? JsonPrimitive)?.booleanOrNull == true)
        "integer", "number" -> PolarisSettingEditor.Number(settingText(value).takeIf { value !is JsonNull } ?: "", type == "integer", num("minimum"), num("maximum"))
        "string" -> PolarisSettingEditor.Text((value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "", num("maxLength")?.toInt())
        else -> null
    }
}

/** A JSON config value as the text a settings row shows. */
public fun settingText(value: JsonElement): String = when {
    value is JsonNull -> "—"
    value is JsonPrimitive && value.isString -> value.content
    value is JsonPrimitive -> value.booleanOrNull?.toString() ?: value.content
    else -> value.toString()
}

/**
 * The umbrella client as settings reads: the licence summary and the user-facing config values.
 * With [editable], each row the catalog (`config.fetchCatalog()`) types gets an input, and changes
 * persist as local overrides (`config.set` / `config.clear`); catalog labels and descriptions win
 * over [labels] unless [labels] names the key.
 */
public fun PolarisKeyClient.settingsActions(labels: Map<String, String> = emptyMap(), editable: Boolean = false): PolarisSettingsActions {
    val client = this
    return object : PolarisSettingsActions {
        override suspend fun set(key: String, value: JsonElement) {
            client.config.set(key, value)
        }

        override suspend fun reset(key: String) {
            client.config.clear(key)
        }

        override suspend fun license(): PolarisLicenseSummary {
            val state: LicenseState = client.status()
            val profile = client.license.profile()
            val granted = client.license.entitlements().filter { (_, v) -> !(v is JsonPrimitive && v.booleanOrNull == false) }.keys.sorted()
            return PolarisLicenseSummary(state.status, profile?.name?.takeIf { it.isNotBlank() }, granted)
        }

        override suspend fun entries(): List<PolarisSettingEntry> {
            val catalog = if (editable) client.config.catalog ?: client.config.fetchCatalog() else client.config.catalog
            return client.config.listUserConfig().map { entry ->
                val item = catalog?.entry(entry.key)
                val source = if (entry.enforced) ConfigSource.enforced else client.config.configSource(entry.key)
                PolarisSettingEntry(
                    key = entry.key,
                    label = labels[entry.key] ?: item?.label ?: entry.key,
                    value = settingText(entry.value),
                    source = source,
                    editor = if (editable && !entry.enforced && item?.kind != "secret") settingEditor(item, entry.value) else null,
                    description = if (editable) item?.description else null,
                )
            }
        }
    }
}

/** The settings state holder: [load] reads the licence summary and the values. */
public class PolarisSettingsState(private val actions: PolarisSettingsActions, private val scope: CoroutineScope) {
    private val _ui = MutableStateFlow(PolarisSettingsUi())
    public val ui: StateFlow<PolarisSettingsUi> = _ui.asStateFlow()

    public fun load() {
        scope.launch {
            _ui.value = _ui.value.copy(loading = true)
            val license = guarded { actions.license() }
            val entries = guarded { actions.entries() } ?: emptyList()
            _ui.value = PolarisSettingsUi(loading = false, license = license, entries = entries)
        }
    }

    /** Change [key] to [value] (an editable row's input), then re-read the rows. */
    public fun set(key: String, value: JsonElement) {
        scope.launch { change { actions.set(key, value) } }
    }

    /** Clear [key]'s local override (the row's Reset), then re-read the rows. */
    public fun reset(key: String) {
        scope.launch { change { actions.reset(key) } }
    }

    /** Dismiss the last refusal. */
    public fun dismissError() {
        _ui.value = _ui.value.copy(error = null)
    }

    private suspend fun change(block: suspend () -> Unit) {
        val error = try {
            block()
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: im.plrs.key.core.PolarisException) {
            if (e.code == im.plrs.key.core.ErrorCode.managedByAdmin) PolarisCopy().settingsLocked else e.message ?: e.code
        } catch (e: Exception) {
            e.message ?: "error"
        }
        val entries = guarded { actions.entries() } ?: _ui.value.entries
        _ui.value = _ui.value.copy(entries = entries, error = error)
    }

    private suspend fun <T> guarded(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

// ── Composables ──────────────────────────────────────────────────────────────────────────────

@Composable
public fun PolarisSettings(state: PolarisSettingsState, modifier: Modifier = Modifier) {
    val ui by state.ui.collectAsState()
    androidx.compose.runtime.LaunchedEffect(state) { state.load() }
    PolarisSettingsScreen(ui, modifier)
}

/** The stateless settings screen. */
@Composable
public fun PolarisSettingsScreen(ui: PolarisSettingsUi, modifier: Modifier = Modifier) {
    val copy = PolarisTheme.copy
    if (ui.loading) {
        PolarisProgressScreen(copy.loading, modifier)
        return
    }
    PolarisScreen(modifier = modifier, showLogo = false) {
        PolarisTitle(copy.settingsTitle)
        Spacer(Modifier.height(24.dp))
        val license = ui.license
        if (license != null) {
            PolarisSection(copy.settingsLicense) {
                PolarisLicenseRow(license)
            }
            Spacer(Modifier.height(16.dp))
        }
        PolarisSection(copy.settingsValues) {
            if (ui.entries.isEmpty()) {
                Text(
                    text = copy.settingsEmpty,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
            ui.entries.forEachIndexed { i, entry ->
                if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                PolarisSettingRow(entry)
            }
        }
    }
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

/** The entitlement badge: the licence status as a coloured pill with a section dot. */
@Composable
public fun PolarisEntitlementBadge(status: LicenseStatus, modifier: Modifier = Modifier) {
    val (container, content) = entitlementColors(status)
    Surface(modifier = modifier, shape = CircleShape, color = container, contentColor = content) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Surface(Modifier.size(8.dp), shape = CircleShape, color = PolarisTheme.accent("license")) {}
            Spacer(Modifier.width(8.dp))
            Text(PolarisTheme.copy.entitlementLabel(status), style = MaterialTheme.typography.labelLarge)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PolarisLicenseRow(license: PolarisLicenseSummary) {
    val copy = PolarisTheme.copy
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PolarisEntitlementBadge(license.status)
        if (license.holder != null) {
            Text(copy.format(copy.licensedTo, license.holder), style = MaterialTheme.typography.bodyLarge)
        }
        if (license.entitlements.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (name in license.entitlements) {
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

/** The supporting text for where a value comes from, or null for nothing to say. */
public fun PolarisCopy.sourceLabel(source: ConfigSource?): String? = when (source) {
    ConfigSource.enforced, ConfigSource.hidden -> settingsLocked
    ConfigSource.local -> settingsSourceLocal
    ConfigSource.env -> settingsSourceEnv
    ConfigSource.remoteDefault -> settingsSourceDefault
    ConfigSource.fallback -> settingsSourceFallback
    null -> null
}

@Composable
internal fun PolarisSettingRow(entry: PolarisSettingEntry) {
    val copy = PolarisTheme.copy
    val locked = entry.source == ConfigSource.enforced || entry.source == ConfigSource.hidden
    // At large font scales the value moves under its name, so neither is squeezed into a sliver.
    val stacked = LocalDensity.current.fontScale >= 1.5f
    val value: @Composable (Modifier) -> Unit = { modifier ->
        Row(modifier, verticalAlignment = Alignment.CenterVertically) {
            if (locked) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(
                text = entry.value,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (stacked) Int.MAX_VALUE else 3,
                overflow = TextOverflow.Ellipsis,
                textAlign = if (stacked) TextAlign.Start else TextAlign.End,
            )
        }
    }
    val source = copy.sourceLabel(entry.source)
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
        value(Modifier.weight(0.8f, fill = false))
    }
}
