// @pkey-feature ui.kit
// A moment as a short, worded phrase for "Saved {when}": a relative day and the short time ("today, 10:42",
// "yesterday, 21:40"), else the short date with no year inside the current year ("Oct 30, 10:12"), and the
// year only for another year. Lower case inside the sentence. The same rule as the other kits, over java.time's
// localized patterns; java.time has no relative words, so the nine launch locales' are listed here.
package im.plrs.key.ui

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.util.Locale

public object PolarisWhen {
    private val words = mapOf(
        "en" to ("today" to "yesterday"),
        "de" to ("heute" to "gestern"),
        "es" to ("hoy" to "ayer"),
        "fr" to ("aujourd’hui" to "hier"),
        "it" to ("oggi" to "ieri"),
        "pt" to ("hoje" to "ontem"),
        "ja" to ("今日" to "昨日"),
        "ko" to ("오늘" to "어제"),
        "zh" to ("今天" to "昨天"),
    )

    /**
     * [savedAt] (epoch milliseconds) worded for [locale]. [now] and [zone] are for tests.
     */
    public fun worded(
        savedAt: Long,
        locale: Locale = Locale.getDefault(),
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): String {
        val at = Instant.ofEpochMilli(savedAt).atZone(zone)
        val today: LocalDate = now.atZone(zone).toLocalDate()
        val day = at.toLocalDate()
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(at)
        val relative = words[locale.language]
        val dayWord = when {
            relative != null && day == today -> relative.first
            relative != null && day == today.minusDays(1) -> relative.second
            else -> null
        }
        if (dayWord != null) return "$dayWord${separator(locale)}$time"
        var pattern = DateTimeFormatterBuilder.getLocalizedDateTimePattern(FormatStyle.MEDIUM, null, IsoChronology.INSTANCE, locale)
        if (day.year == today.year) pattern = withoutYear(pattern)
        val date = DateTimeFormatter.ofPattern(pattern, locale).format(at)
        return "$date${separator(locale)}$time"
    }

    /** CJK words read with a space ("今日 10:42"), the rest with a comma. */
    private fun separator(locale: Locale): String = if (locale.language in setOf("ja", "ko", "zh")) " " else ", "

    /** A localized date pattern without its year and the separator that joined it ("MMM d, y" to "MMM d"). */
    internal fun withoutYear(pattern: String): String {
        val trailing = Regex("""[,\s./-]*y+(年|년)?\.?\s*$""")
        val inner = Regex("""[,\s./-]*y+(年|년)?\.?[,\s./-]*""")
        val leading = Regex("""^y+(年|년)?[,\s./-]*""")
        return when {
            leading.containsMatchIn(pattern) -> pattern.replace(leading, "")
            trailing.containsMatchIn(pattern) -> pattern.replace(trailing, "")
            else -> pattern.replace(inner, " ")
        }.trim()
    }
}
