// User-facing copy for every code the SDK can surface (SDK parity pass §3.2, `core.copy`).
//
//   Copy.message(code, detail?, locale?, params)      the sentence a screen shows
//   Copy.title(code, locale?)                         the short heading above it
//   Copy.activationMessage(kind, locale?, code?, ..)  the sentence for a typed activation result
//   Copy.activationTitle(kind, locale?)               its heading
//
// ENGLISH IS GENERATED. Copy.generated.kt is written by `pnpm gen constants` from
// conformance/parity/copy.en.json with three tables, kept apart on purpose as React reads them:
// COPY_CODES (per error code), COPY_GATE (per licenseStatus) and COPY_ACTIVATION (per
// activationResult). The error code `unauthorized` reads "Not signed in"; the activation result
// `unauthorized` reads "Key not accepted". `message`/`title` look a code up as an error code, then
// as a gate status, then as an activation result; `activationMessage`/`activationTitle` read the
// activation table only.
//
// A code with no entry falls back to COPY_FALLBACK, which names the code and never shows a raw
// server body. `{name}` placeholders are filled from `params` (`{code}` defaults to the code); an
// unfilled placeholder is dropped with the space before it, so a raw `{name}` never shows.
//
// `registerLocale` adds a table for another locale (missing keys fall back to English). For `en` it
// feeds the host's override layer instead, which wins per key over the generated text.

package im.plrs.key.core

import java.util.concurrent.ConcurrentHashMap

/** The core copy catalog over the generated tables, with a host override layer. */
public object Copy {
    /** The host's English override layer (`registerLocale("en", ...)`): code → entry. */
    private val overrides = ConcurrentHashMap<String, CopyEntry>()

    /** Non-English locale tables: tag → code → entry. */
    private val locales = ConcurrentHashMap<String, Map<String, CopyEntry>>()

    private val placeholder = Regex("""( ?)\{(\w+)\}""")
    private val upper = Regex("[A-Z]")

    /**
     * Add entries (code → [CopyEntry]) to a locale. `en` entries override the generated English for
     * those keys only; every other key keeps the generated text. Another locale's table is merged
     * into what it already has; a key it lacks reads English.
     */
    public fun registerLocale(locale: String, table: Map<String, CopyEntry>) {
        val tag = normalise(locale)
        if (tag == "en") {
            overrides.putAll(table)
            return
        }
        locales.compute(tag) { _, old -> (old ?: emptyMap()) + table }
    }

    /** Drop every host override and registered locale (tests, or a host reloading its copy). */
    public fun resetOverrides() {
        overrides.clear()
        locales.clear()
    }

    /** Whether `code` has its own sentence (a locale entry, a host override or generated text). */
    public fun hasCopy(code: String, locale: String? = null): Boolean =
        localised(code, locale) != null || english(code) != null

    /**
     * The sentence for [code]; [detail] (a refusal's reason, say) is appended in parentheses. An
     * unknown code reads [COPY_FALLBACK] naming it, never the server's body.
     */
    public fun message(
        code: String,
        detail: String? = null,
        locale: String? = null,
        params: Map<String, Any> = emptyMap(),
    ): String {
        val text = (localised(code, locale) ?: english(code) ?: COPY_FALLBACK).message
        val out = fill(text, code, params)
        return if (detail.isNullOrEmpty()) out else "$out ($detail)"
    }

    /** The short heading for [code], or [COPY_FALLBACK]'s title. */
    public fun title(code: String, locale: String? = null): String =
        (localised(code, locale) ?: english(code) ?: COPY_FALLBACK).title

    /**
     * The sentence for a typed activation result (`deviceLimit`, `device_limit` or `device-limit`),
     * from the activation table only, never the error-code table. `refused` names the server's
     * [code]. A kind outside the table reads like [message].
     */
    public fun activationMessage(
        kind: String,
        locale: String? = null,
        code: String? = null,
        params: Map<String, Any> = emptyMap(),
    ): String {
        val entry = activationEntry(kind, locale) ?: return message(kind, locale = locale, params = params)
        return fill(entry.message, code ?: kind, params)
    }

    /** The heading for a typed activation result. */
    public fun activationTitle(kind: String, locale: String? = null): String =
        activationEntry(kind, locale)?.title ?: title(kind, locale)

    // ── internals ────────────────────────────────────────────────────────────────────────────

    private fun normalise(locale: String): String = locale.lowercase().replace('_', '-')

    /** `deviceLimit` / `device_limit` / `device-limit` → the activationResult spelling. */
    private fun activationKey(kind: String): String =
        upper.replace(kind) { "-" + it.value.lowercase() }.replace('_', '-')

    /** The generated entry: error code, then gate status, then activation result. */
    private fun english(code: String): CopyEntry? =
        COPY_CODES[code] ?: COPY_GATE[code] ?: COPY_ACTIVATION[activationKey(code)]

    /** A registered non-English entry (exact tag, then its language), else a host override. */
    private fun localised(code: String, locale: String?): CopyEntry? {
        if (!locale.isNullOrEmpty()) {
            val tag = normalise(locale)
            for (candidate in listOf(tag, tag.substringBefore('-'))) {
                locales[candidate]?.get(code)?.let { return it }
            }
        }
        return overrides[code]
    }

    private fun activationEntry(kind: String, locale: String?): CopyEntry? {
        val key = activationKey(kind)
        return localised(key, locale) ?: COPY_ACTIVATION[key]
    }

    private fun fill(text: String, code: String, params: Map<String, Any>): String =
        placeholder.replace(text) { m ->
            val space = m.groupValues[1]
            val name = m.groupValues[2]
            val value = params[name]
            when {
                value != null -> "$space$value"
                name == "code" -> "$space$code"
                else -> ""
            }
        }
}
