// Layered config resolution (WIRE-CONTRACT-V3 §2.2.1), pinned by `config-matrix.json`. Pure: the
// same rules as `@polaris-key/client-core`'s `config.ts`, Python's `config/resolve.py` and Swift's
// `ConfigResolution`, named the same up to casing; `ConfigClient` delegates to it.
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// Rule 2, the environment value, is strict JSON decided from the text alone (`readEnvValue`).
// Member names compare by scalar value (a Kotlin String compares UTF-16 code units), so two
// canonically equivalent names are two members here, as in client-core.

package im.plrs.key.config

import im.plrs.key.core.ManagedEntry
import im.plrs.key.core.ManagementState
import im.plrs.key.core.StrictJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Where a resolved config value came from, for diagnostics and settings UIs. */
public enum class ConfigSource(public val wire: String) {
    /** Remote `enforced` entry: the server value wins, no override possible. */
    enforced("enforced"),

    /** Remote `hidden` entry: the server value wins and the key is withheld from enumeration. */
    hidden("hidden"),

    /** A caller-supplied `localOverrides` value. */
    local("local"),

    /** An environment-variable override. */
    env("env"),

    /** A remote `default`-state value (no local or environment override present). */
    remoteDefault("remote-default"),

    /** No remote entry and no override: the caller's fallback. */
    fallback("fallback"),
}

/**
 * One user-facing catalog entry, for settings UIs. `hidden` keys are excluded (they are still
 * APPLIED by `config(key, default)`); `enforced` keys are shown read-only.
 */
public data class UserConfigEntry(val key: String, val value: JsonElement, val enforced: Boolean)

/** The inputs one resolution needs. */
public data class ResolveContext(
    /** The verified config document's `config` map, or null before the first document. */
    val remote: Map<String, ManagedEntry>?,
    /** User/local overrides (beat a remote `default`, never an `enforced`/`hidden` entry). */
    val localOverrides: Map<String, JsonElement>,
    /** The environment lookup table (empty on a host without an environment layer, rule 3). */
    val env: Map<String, String>,
    /** `${envPrefix}${key with "." → "__"}` is the variable name (rule 1). */
    val envPrefix: String,
)

public object ConfigResolution {
    /**
     * The effective value for [key], or null when no layer answered (the caller substitutes its
     * fallback). A layer holding JSON null answers `JsonNull`.
     */
    public fun resolveValue(ctx: ResolveContext, key: String): JsonElement? {
        val entry = ctx.remote?.get(key)
        if (entry != null && (entry.state == ManagementState.enforced || entry.state == ManagementState.hidden)) return entry.value
        if (ctx.localOverrides.containsKey(key)) return ctx.localOverrides[key]
        envValue(ctx, key)?.let { return it }
        if (entry != null) return entry.value
        return null
    }

    /** Where [resolveValue] sources its answer from. */
    public fun resolveSource(ctx: ResolveContext, key: String): ConfigSource {
        val entry = ctx.remote?.get(key)
        if (entry?.state == ManagementState.enforced) return ConfigSource.enforced
        if (entry?.state == ManagementState.hidden) return ConfigSource.hidden
        if (ctx.localOverrides.containsKey(key)) return ConfigSource.local
        if (envValue(ctx, key) != null) return ConfigSource.env
        if (entry != null) return ConfigSource.remoteDefault
        return ConfigSource.fallback
    }

    /**
     * The user-visible list (rule 4): every document entry except `hidden` ones, each with its
     * resolved value. A key only a local override or the environment supplies is not listed. The
     * order is not specified.
     */
    public fun listUserEntries(ctx: ResolveContext): List<UserConfigEntry> {
        val remote = ctx.remote ?: return emptyList()
        return remote.filter { it.value.state != ManagementState.hidden }.map { (key, entry) ->
            UserConfigEntry(key, resolveValue(ctx, key) ?: entry.value, entry.state == ManagementState.enforced)
        }
    }

    private fun envValue(ctx: ResolveContext, key: String): JsonElement? {
        val raw = ctx.env[ctx.envPrefix + key.replace(".", "__")] ?: return null
        return readEnvValue(raw)
    }

    /**
     * Rule 2: the parsed value when [raw] is one strict JSON text, else the raw string. Never
     * throws, decided from the text alone: a lone surrogate keeps the raw string (it has no UTF-8
     * form); otherwise `StrictJson.parseValue` applies the scans client-core runs (nesting at most
     * 64, every number in range from its digits, no duplicate or U+0000 member name, RFC 8259
     * syntax with no trailing comma, BOM or non-JSON whitespace).
     */
    public fun readEnvValue(raw: String): JsonElement {
        if (hasLoneSurrogate(raw)) return JsonPrimitive(raw)
        return StrictJson.parseValue(raw.toByteArray(Charsets.UTF_8)) ?: JsonPrimitive(raw)
    }

    private fun hasLoneSurrogate(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])) return true
                i += 2
                continue
            }
            if (Character.isLowSurrogate(c)) return true
            i++
        }
        return false
    }
}
