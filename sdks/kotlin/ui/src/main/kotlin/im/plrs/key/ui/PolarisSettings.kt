// The settings screen: the licence (an entitlement badge, who it is licensed to, the entitlements
// it grants) and the product's user-facing configuration values with where each comes from.
// Read-only: the kit renders what the SDK resolved; changing a value is the product's own UI.

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

/** One configuration value. */
public data class PolarisSettingEntry(
    val key: String,
    /** What the row shows as its name; the key by default. */
    val label: String = key,
    /** The value as text. */
    val value: String,
    val source: ConfigSource? = null,
)

public data class PolarisSettingsUi(
    val loading: Boolean = true,
    val license: PolarisLicenseSummary? = null,
    val entries: List<PolarisSettingEntry> = emptyList(),
)

/** The SDK reads the settings screen makes. [PolarisKeyClient.settingsActions] adapts the umbrella client. */
public interface PolarisSettingsActions {
    public suspend fun license(): PolarisLicenseSummary?
    public suspend fun entries(): List<PolarisSettingEntry>
}

/** A JSON config value as the text a settings row shows. */
public fun settingText(value: JsonElement): String = when {
    value is JsonNull -> "—"
    value is JsonPrimitive && value.isString -> value.content
    value is JsonPrimitive -> value.booleanOrNull?.toString() ?: value.content
    else -> value.toString()
}

/** The umbrella client as settings reads: the licence summary and the user-facing config values. */
public fun PolarisKeyClient.settingsActions(labels: Map<String, String> = emptyMap()): PolarisSettingsActions {
    val client = this
    return object : PolarisSettingsActions {
        override suspend fun license(): PolarisLicenseSummary {
            val state: LicenseState = client.status()
            val profile = client.license.profile()
            val granted = client.license.entitlements().filter { (_, v) -> !(v is JsonPrimitive && v.booleanOrNull == false) }.keys.sorted()
            return PolarisLicenseSummary(state.status, profile?.name?.takeIf { it.isNotBlank() }, granted)
        }

        override suspend fun entries(): List<PolarisSettingEntry> =
            client.config.listUserConfig().map { entry ->
                PolarisSettingEntry(
                    key = entry.key,
                    label = labels[entry.key] ?: entry.key,
                    value = settingText(entry.value),
                    source = if (entry.enforced) ConfigSource.enforced else client.config.configSource(entry.key),
                )
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
