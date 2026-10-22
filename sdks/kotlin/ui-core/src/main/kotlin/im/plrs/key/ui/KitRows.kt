// @pkey-feature ui.kit ui.settings ui.paywall
// The row data the styled parts draw (UI-KITS.md §4.1): a license's origin and term, the notes of a
// release, what a tier adds. KitStates answers which state a component is in and which catalog lines
// it shows; the rows are the data under those lines, in the matrix's own wire-free shapes, so a
// Compose host, a snapshot and a headless integration read the same values.
package im.plrs.key.ui

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/** The seats a license has: [used] of [limit]. */
public data class KitSeats(val used: Int, val limit: Int)

/** One license row of the sign-in's step 3 (SIGN-IN.md §3.6). */
public data class KitLicenseChoice(
    val id: String,
    val tierName: String,
    /** The license's own name, when the holder gave it one ("Fennick Studio Edu"). */
    val name: String? = null,
    /** `purchase`, `store`, `key`, `free`, `developer` or `signin`. */
    val origin: String = "key",
    /** `seats` or `account`. */
    val access: String = "seats",
    val seats: KitSeats? = null,
    val current: Boolean = false,
    /** Epoch seconds the license ends; null is a lifetime license. */
    val expiresAt: Long? = null,
    /** `free` or `full`. */
    val state: String = "free",
) {
    /** Every device of the license is in use: a row without a radio. */
    val isFull: Boolean get() = state == "full"
}

/** The license choice of a sign-in. */
public data class KitLicenseChoices(
    val choices: List<KitLicenseChoice>,
    /** A license id, or null. */
    val preselected: String? = null,
)

/** One version's notes. Plain text: remote markup shows as text and never runs. */
public data class KitReleaseNote(val version: String, val date: String, val notes: String)

/** The row data of the styled parts, read from a state's inputs. */
public data class KitRowData(
    val choices: KitLicenseChoices? = null,
    val releaseNotes: List<KitReleaseNote> = emptyList(),
    /** What the tier adds, as the product names it. */
    val features: List<String> = emptyList(),
) {
    public companion object {
        /** The row data in [inputs] (the matrix's `choices`, `releaseNotes` and `offers.features` members). */
        public fun from(inputs: KitInputs): KitRowData {
            val choices = inputs.obj("choices")?.array("choices")?.objects()?.mapNotNull(::choiceOf)
            val notes = inputs.array("releaseNotes")?.objects()?.mapNotNull { n ->
                KitReleaseNote(n.string("version") ?: return@mapNotNull null, n.string("date").orEmpty(), n.string("notes").orEmpty())
            }
            return KitRowData(
                choices = choices?.let { KitLicenseChoices(it, inputs.obj("choices").string("preselected")) },
                releaseNotes = notes.orEmpty(),
                features = inputs.obj("offers")?.array("features")?.strings().orEmpty(),
            )
        }

        private fun choiceOf(o: JsonObject): KitLicenseChoice? {
            val seats = o.obj("seats")
            return KitLicenseChoice(
                id = o.string("id") ?: return null,
                tierName = o.string("tierName").orEmpty(),
                name = KitIdentity.nonEmpty(o.string("name")),
                origin = o.string("origin") ?: "key",
                access = o.string("access") ?: "seats",
                seats = seats?.let { s -> KitSeats(s.integer("used") ?: return@let null, s.integer("limit") ?: return@let null) },
                current = o.boolean("current") == true,
                expiresAt = o["expiresAt"].double()?.toLong(),
                state = o.string("state") ?: "free",
            )
        }
    }
}

/** The origin of a license in plain words (SIGN-IN.md §3.6, O-17). A key or a purchase reads "Added with a key". */
public fun KitLicenseChoice.originKey(): String = when (origin) {
    "signin" -> "signin.choice.origin.signIn"
    "store" -> "signin.choice.origin.store"
    "free" -> "signin.choice.origin.free"
    "developer" -> "signin.choice.origin.developer"
    else -> "signin.choice.origin.keyAdded"
}

/** The origin line of [this]; the developer's name and the store fill the origins that name them. */
public fun KitLicenseChoice.originLine(developer: String, store: String): CopyLine =
    CopyLine(originKey(), mapOf("developer" to CopyArgument.Text(developer), "store" to CopyArgument.Text(store)))

/** The term line of [this]: "Lifetime", or "Until {date}" with [date] already in the reader's style. */
public fun KitLicenseChoice.termLine(date: String?): CopyLine =
    if (expiresAt == null || date == null) CopyLine("signin.term.lifetime") else CopyLine("signin.term.until", mapOf("date" to CopyArgument.Text(date)))

/** The meta line under a license row: "{origin} · {term}". */
public fun KitLicenseChoice.metaLine(developer: String, store: String, date: String?): CopyLine = CopyLine(
    "signin.choice.meta",
    mapOf(
        "origin" to CopyArgument.Line(originLine(developer, store)),
        "term" to CopyArgument.Line(termLine(date)),
    ),
)

/** The seats line under a tier: "{used} of {limit} devices"; null when the license reports none. */
public fun KitLicenseChoice.seatsLine(): CopyLine? = seats?.let {
    CopyLine("signin.choice.devices", mapOf("used" to CopyArgument.Number(it.used), "limit" to CopyArgument.Number(it.limit)))
}

/**
 * Diagnostics text with what must not leave the device removed (UI-KITS.md 4.1 About, Must not:
 * copy diagnostics unredacted): licence keys and every `pkey*_` token, bearer values, email
 * addresses and hardware ids.
 */
public fun redactDiagnostics(text: String): String = text
    .replace(Regex("""\bpkey[a-z]*_[A-Za-z0-9_\-]{6,}"""), "[redacted]")
    .replace(Regex("""(?i)\bbearer\s+[A-Za-z0-9._\-]+"""), "Bearer [redacted]")
    .replace(Regex("""[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"""), "[redacted]")
    .replace(Regex("""(?i)\bhwid[=: ]+[0-9a-f]{16,}"""), "hwid: [redacted]")

private fun dateStyle(locale: String): DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.forLanguageTag(locale))

/** Epoch [seconds] as a calendar date in the reader's locale ("Until {date}"), never a raw timestamp (DL8). */
public fun kitDate(seconds: Long, locale: String = "en"): String =
    dateStyle(locale).format(Instant.ofEpochSecond(seconds).atZone(ZoneOffset.UTC).toLocalDate())

/** A calendar day as release notes carry it (`2026-09-30`) in the reader's locale; anything else is shown as given. */
public fun kitDay(iso: String, locale: String = "en"): String =
    try {
        dateStyle(locale).format(LocalDate.parse(iso.take(10)))
    } catch (_: java.time.format.DateTimeParseException) {
        iso
    }
