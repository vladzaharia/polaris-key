// Compose-free settings presentation models, catalog-editor mapping and state. Renderers provide
// labels and user-facing failure copy; this layer preserves typed SDK failures for them to map.
package im.plrs.key.ui

import im.plrs.key.config.CatalogEntry
import im.plrs.key.config.ConfigSource
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
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

/** A settings operation's SDK error; renderers map [code] to catalog copy and never expose [detail] verbatim. */
public data class PolarisSettingsFailure(val code: String, val detail: String? = null)

public data class PolarisSettingsUi(
    val loading: Boolean = true,
    val license: PolarisLicenseSummary? = null,
    val entries: List<PolarisSettingEntry> = emptyList(),
    /** The last refused edit, or null. */
    val error: PolarisSettingsFailure? = null,
    /** A values-read failure; the renderer offers Try again. */
    val loadFailure: PolarisSettingsFailure? = null,
)

/** The SDK calls the settings screen makes. [PolarisKeyClient.settingsActions] adapts the umbrella client. */
public interface PolarisSettingsActions {
    public suspend fun license(): PolarisLicenseSummary?
    public suspend fun entries(): List<PolarisSettingEntry>

    /** Persist [value] for [key] (a local override). Throws the SDK's refusal. */
    public suspend fun set(key: String, value: JsonElement)

    /** Clear the local override for [key]. */
    public suspend fun reset(key: String)
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

/** The settings state holder: [load] reads the licence summary and values. */
public class PolarisSettingsState(private val actions: PolarisSettingsActions, private val scope: CoroutineScope) {
    private val _ui = MutableStateFlow(PolarisSettingsUi())
    public val ui: StateFlow<PolarisSettingsUi> = _ui.asStateFlow()

    public fun load() {
        scope.launch {
            _ui.value = _ui.value.copy(loading = true, error = null)
            val license = attempt { actions.license() }
            val entries = attempt { actions.entries() }
            _ui.value = PolarisSettingsUi(
                loading = false,
                license = license.getOrNull(),
                entries = entries.getOrNull().orEmpty(),
                loadFailure = entries.exceptionOrNull()?.toSettingsFailure(),
            )
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
        val failure = attempt(block).exceptionOrNull()?.toSettingsFailure()
        val entries = attempt { actions.entries() }.getOrNull() ?: _ui.value.entries
        _ui.value = _ui.value.copy(entries = entries, error = failure)
    }

    private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }
}

private fun Throwable.toSettingsFailure(): PolarisSettingsFailure = when (this) {
    is PolarisException -> PolarisSettingsFailure(code, message)
    else -> PolarisSettingsFailure(ErrorCode.platformError, message)
}
