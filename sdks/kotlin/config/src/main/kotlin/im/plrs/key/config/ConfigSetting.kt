// A handle on one config key (`config.setting(key)`, the D9 setting handle): read it, write it,
// follow it. The reads are the last resolution `ConfigClient` published for the key, kept current
// by every `set()`/`clear()` and every new verified document, so they never block.

package im.plrs.key.config

import im.plrs.key.core.SettingVisibility
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonElement
import java.util.concurrent.CopyOnWriteArrayList

/** A listener registration. [cancel] stops delivery and is idempotent. */
public class ConfigSubscription internal constructor(private val onCancel: () -> Unit) {
    @Volatile private var cancelled = false

    public fun cancel() {
        if (cancelled) return
        cancelled = true
        onCancel()
    }

    /** Whether [cancel] has run. */
    public val isCancelled: Boolean get() = cancelled
}

/** The shared, mutable side of one key's handle; `ConfigClient` keeps one per key. */
internal class SettingState {
    val value = MutableStateFlow<JsonElement?>(null)
    @Volatile var source: ConfigSource = ConfigSource.fallback
    @Volatile var locked: Boolean = false
    @Volatile var visibility: String = SettingVisibility.editable
    val listeners = CopyOnWriteArrayList<(ConfigChange) -> Unit>()

    fun update(value: JsonElement?, source: ConfigSource) {
        this.value.value = value
        this.source = source
        locked = source == ConfigSource.enforced || source == ConfigSource.hidden
        visibility = when (source) {
            ConfigSource.enforced -> SettingVisibility.readonly
            ConfigSource.hidden -> SettingVisibility.hidden
            else -> SettingVisibility.editable
        }
    }
}

/** A handle on one key: `client.config.setting(key)`. */
public class ConfigSetting internal constructor(
    public val key: String,
    private val client: ConfigClient,
    private val state: SettingState,
) {
    /** The effective value; null when no layer has one (the source is then `fallback`). */
    public val value: JsonElement? get() = state.value.value

    /** Where the effective value comes from. */
    public val source: ConfigSource get() = state.source

    /** Whether the operator locked the key (`enforced` or `hidden`): [set] would be refused. */
    public val locked: Boolean get() = state.locked

    /** How the setting appears: `editable`, `readonly` or `hidden` (`SettingVisibility`). */
    public val visibility: String get() = state.visibility

    /** The effective value, live: the current one now, then every change. */
    public val flow: StateFlow<JsonElement?> get() = state.value.asStateFlow()

    /** `config.set(key, value)`. */
    public suspend fun set(value: JsonElement): Unit = client.set(key, value)

    /** `config.clear(key)`. */
    public suspend fun clear(): Unit = client.clear(key)

    /** Call [listener] on every change to this key's effective value, until the result is cancelled. */
    public fun on(listener: (ConfigChange) -> Unit): ConfigSubscription {
        state.listeners += listener
        return ConfigSubscription { state.listeners -= listener }
    }
}
