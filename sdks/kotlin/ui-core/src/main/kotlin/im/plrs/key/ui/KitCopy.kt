// @pkey-feature ui.i18n
// Locale tables generated from packages/brand/kit-copy. This core formats the deliberately small
// ICU MessageFormat subset so every Kotlin host gets the same presentation text without ICU.
package im.plrs.key.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
/** An English platform-specific variant of a catalog line. */
public enum class CopyVariant(public val id: String) {
    macos("macos"),
    ios("ios"),
    tv("tv"),
    terminal("terminal"),
}

/**
 * The generated kit copy catalog, including all launch locales and host overrides.
 *
 * Lookup is key-by-key: requested-locale override, matching locale table, English override, then
 * English. Unknown strings remain visible as their keys rather than silently disappearing.
 */
public class KitCopy(
    public val locales: List<String>,
    private val tables: Map<String, Map<String, String>>,
    private val variants: Map<String, Map<String, String>> = emptyMap(),
    public val overrides: Map<String, Map<String, String>> = emptyMap(),
) {
    public companion object {
        /** The generator-produced catalog packaged with `polaris-key-ui-core`. */
        public val bundled: KitCopy by lazy {
            val source = KitCopy::class.java.getResourceAsStream("/kit-copy.json")
                ?: return@lazy KitCopy(listOf("en"), mapOf("en" to emptyMap()))
            val root = source.bufferedReader().use {
                Json.parseToJsonElement(it.readText()) as? JsonObject ?: JsonObject(emptyMap())
            }
            val locales = root["locales"]?.let { value ->
                value.toStringList()
            } ?: listOf("en")
            val tables = root["tables"]?.asObjectMap() ?: emptyMap()
            val variants = root["variants"]?.asObjectMap() ?: emptyMap()
            KitCopy(locales, tables, variants)
        }
    }

    /** Returns a copy with [more] merged over existing overrides per locale and key. */
    public fun overriding(more: Map<String, Map<String, String>>): KitCopy {
        val merged: MutableMap<String, MutableMap<String, String>> = overrides
            .mapValuesTo(linkedMapOf()) { (_, values) -> values.toMutableMap() }
        for ((locale, values) in more) {
            merged.getOrPut(locale) { linkedMapOf() }.putAll(values)
        }
        return KitCopy(locales, tables, variants, merged)
    }

    /** Whether the English table has [key]. */
    public fun has(key: String): Boolean = tables["en"]?.containsKey(key) == true

    /** Selects the supplied launch locale, its language, or English. */
    public fun packLocale(requested: String): String {
        val normalized = requested.replace('_', '-')
        if (tables.containsKey(normalized)) return normalized
        locales.firstOrNull { it.equals(normalized, ignoreCase = true) }?.let { return it }
        val lower = normalized.lowercase()
        if (lower == "zh" || lower.startsWith("zh-hans") || lower.startsWith("zh-cn") || lower.startsWith("zh-sg")) {
            return if (locales.contains("zh-Hans")) "zh-Hans" else "en"
        }
        val language = lower.substringBefore('-')
        return locales.firstOrNull { it.lowercase().substringBefore('-') == language } ?: "en"
    }

    /** Finds the unformatted line by the UI-KITS fallback order. */
    public fun message(key: String, locale: String, variant: CopyVariant? = null): String? {
        val pack = packLocale(locale)
        return overrides[locale]?.get(key)
            ?: overrides[pack]?.get(key)
            ?: tables[pack]?.get(key)?.takeIf { pack != "en" }
            ?: overrides["en"]?.get(key)
            ?: variant?.let { variants[key]?.get(it.id) }
            ?: tables["en"]?.get(key)
    }

    /** Formats [key] with [args] in [locale]. */
    public fun format(
        key: String,
        locale: String,
        args: Map<String, CopyArgument> = emptyMap(),
        variant: CopyVariant? = null,
    ): String {
        val message = message(key, locale, variant) ?: return key
        return KitMessageFormat.format(message, packLocale(locale), args, this, variant)
    }

    /** Formats one catalog [line] in [locale]. */
    public fun format(line: CopyLine, locale: String, variant: CopyVariant? = null): String =
        format(line.key, locale, line.args, variant)

    /** Returns English message argument names, for avoiding partial visible lines. */
    public fun argumentNames(key: String): Set<String> =
        tables["en"]?.get(key)?.let(KitMessageFormat::argumentNames) ?: emptySet()
}

/** The deliberately restricted ICU MessageFormat formatter shared by Kotlin kit hosts. */
public object KitMessageFormat {
    /** Formats a generated catalog message. Malformed generated text is returned visibly unchanged. */
    public fun format(
        message: String,
        locale: String,
        args: Map<String, CopyArgument>,
        catalog: KitCopy = KitCopy.bundled,
        variant: CopyVariant? = null,
    ): String {
        val complex = complexIn(message)
        if (complex == null) return renderPlain(message, args, catalog, locale, variant)
        val renderedHead = renderPlain(message.substring(0, complex.start), args, catalog, locale, variant)
        val renderedTail = renderPlain(message.substring(complex.end + 1), args, catalog, locale, variant)
        val argument = args[complex.argument]
        val branch = when (complex.kind) {
            "plural" -> {
                val number = argument.integerValue()
                val category = PluralRules.category(number ?: 0, locale)
                complex.cases[category] ?: complex.cases["other"] ?: ""
            }
            "select" -> complex.cases[argument.rendered(catalog, locale, variant)]
                ?: complex.cases["other"]
                ?: ""
            else -> return message
        }
        return renderedHead + renderPlain(
            branch,
            args,
            catalog,
            locale,
            variant,
            if (complex.kind == "plural") argument.integerValue() else null,
        ) + renderedTail
    }

    /** The argument names a message names, including its plural/select selector. */
    public fun argumentNames(message: String): Set<String> =
        ARGUMENT.findAll(message).map { it.groupValues[1] }.toSet()

    private fun renderPlain(
        source: String,
        args: Map<String, CopyArgument>,
        catalog: KitCopy,
        locale: String,
        variant: CopyVariant?,
        pluralNumber: Int? = null,
    ): String {
        val output = StringBuilder()
        var index = 0
        while (index < source.length) {
            when (source[index]) {
                '#' -> {
                    output.append(pluralNumber?.toString() ?: "#")
                    index += 1
                }
                '{' -> {
                    val end = source.indexOf('}', index + 1)
                    if (end < 0) {
                        output.append(source[index])
                        index += 1
                    } else {
                        val name = source.substring(index + 1, end).trim()
                        if (name.matches(IDENTIFIER)) {
                            output.append(args[name].rendered(catalog, locale, variant) ?: "{$name}")
                        } else {
                            output.append(source, index, end + 1)
                        }
                        index = end + 1
                    }
                }
                else -> {
                    output.append(source[index])
                    index += 1
                }
            }
        }
        return output.toString()
    }

    private fun complexIn(message: String): Complex? {
        var start = message.indexOf('{')
        while (start >= 0) {
            val end = matchingBrace(message, start) ?: return null
            val content = message.substring(start + 1, end)
            val first = content.indexOf(',')
            if (first >= 0) {
                val second = content.indexOf(',', first + 1)
                if (second >= 0) {
                    val argument = content.substring(0, first).trim()
                    val kind = content.substring(first + 1, second).trim()
                    if (argument.matches(IDENTIFIER) && (kind == "plural" || kind == "select")) {
                        return Complex(start, end, argument, kind, cases(content.substring(second + 1)))
                    }
                }
            }
            start = message.indexOf('{', start + 1)
        }
        return null
    }

    private fun matchingBrace(source: String, start: Int): Int? {
        var depth = 0
        for (index in start until source.length) {
            when (source[index]) {
                '{' -> depth += 1
                '}' -> {
                    depth -= 1
                    if (depth == 0) return index
                }
            }
        }
        return null
    }

    private fun cases(source: String): Map<String, String> {
        val output = linkedMapOf<String, String>()
        var index = 0
        while (index < source.length) {
            while (index < source.length && source[index].isWhitespace()) index += 1
            val nameStart = index
            while (index < source.length && (source[index].isLetterOrDigit() || source[index] == '-')) index += 1
            if (nameStart == index) break
            val name = source.substring(nameStart, index)
            while (index < source.length && source[index].isWhitespace()) index += 1
            if (index >= source.length || source[index] != '{') break
            val end = matchingBrace(source, index) ?: break
            output[name] = source.substring(index + 1, end)
            index = end + 1
        }
        return output
    }

    private data class Complex(
        val start: Int,
        val end: Int,
        val argument: String,
        val kind: String,
        val cases: Map<String, String>,
    )

    private val IDENTIFIER: Regex = Regex("[A-Za-z][A-Za-z0-9]*")
    // The closing brace is escaped: Android's ICU regex engine rejects a bare `}` (the JVM accepts it).
    private val ARGUMENT: Regex = Regex("\\{([A-Za-z][A-Za-z0-9]*)\\s*(?:,|\\})")
}

/** CLDR cardinal categories for the launch locales and the catalog's integer-only subset. */
public object PluralRules {
    /** Returns the cardinal category for integer [number] in [locale]. */
    public fun category(number: Int, locale: String): String {
        val language = locale.lowercase().substringBefore('-').substringBefore('_')
        val millions = number != 0 && number % 1_000_000 == 0
        return when (language) {
            "ja", "ko", "zh" -> "other"
            "fr", "pt" -> when {
                number == 0 || number == 1 -> "one"
                millions -> "many"
                else -> "other"
            }
            "es", "it" -> when {
                number == 1 -> "one"
                millions -> "many"
                else -> "other"
            }
            else -> if (number == 1) "one" else "other"
        }
    }
}

private fun CopyArgument?.rendered(catalog: KitCopy, locale: String, variant: CopyVariant?): String? = when (this) {
    is CopyArgument.Text -> value
    is CopyArgument.Number -> value.toString()
    is CopyArgument.Line -> catalog.format(value, locale, variant)
    null -> null
}

private fun CopyArgument?.integerValue(): Int? = when (this) {
    is CopyArgument.Number -> value
    is CopyArgument.Text -> value.toIntOrNull()
    else -> null
}

private fun kotlinx.serialization.json.JsonElement.toStringList(): List<String> =
    (this as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it.string() } ?: emptyList()

private fun kotlinx.serialization.json.JsonElement.asObjectMap(): Map<String, Map<String, String>> =
    ((this as? JsonObject) ?: emptyMap()).mapValues { (_, values) ->
        ((values as? JsonObject) ?: emptyMap()).mapNotNull { (key, value) ->
            value.string()?.let { key to it }
        }.toMap()
    }
