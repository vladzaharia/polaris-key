// @pkey-feature ui.kit
package im.plrs.key.ui

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KitRowsTest {
    private fun inputs(text: String): KitInputs = KitInputs.fromJson(Json.parseToJsonElement(text) as JsonObject)

    private val many = inputs(
        """{"choices":{"state":"choose","preselected":"lic_pro","choices":[
          {"id":"lic_pro","tierName":"Pro","name":null,"origin":"purchase","access":"seats","seats":{"used":1,"limit":3},"current":false,"expiresAt":null,"state":"free"},
          {"id":"lic_store","tierName":"Pro","origin":"store","seats":{"used":1,"limit":3},"expiresAt":1798761600,"state":"free"},
          {"id":"lic_edu","tierName":"Edu","name":"Fennick Studio Edu","origin":"developer","seats":{"used":3,"limit":3},"expiresAt":1798761600,"state":"full"},
          {"tierName":"no id"}]}}""",
    )

    @Test
    fun theLicenseRowsAreReadFromTheChoicesMember() {
        val choices = KitRowData.from(many).choices!!
        assertEquals("lic_pro", choices.preselected)
        assertEquals(listOf("lic_pro", "lic_store", "lic_edu"), choices.choices.map { it.id })
        val edu = choices.choices[2]
        assertEquals("Fennick Studio Edu", edu.name)
        assertEquals(KitSeats(3, 3), edu.seats)
        assertTrue(edu.isFull)
        assertFalse(choices.choices[0].isFull)
        assertNull(choices.choices[0].name)
        assertNull(choices.choices[0].expiresAt)
        assertEquals(1_798_761_600L, choices.choices[1].expiresAt)
    }

    @Test
    fun originsReadInPlainWordsAndAKeyOrAPurchaseReadsAddedWithAKey() {
        val c = KitRowData.from(many).choices!!.choices
        assertEquals("signin.choice.origin.keyAdded", c[0].originKey())
        assertEquals("signin.choice.origin.store", c[1].originKey())
        assertEquals("signin.choice.origin.developer", c[2].originKey())
        val bundled = KitCopy.bundled
        assertEquals("Added with a key", bundled.format(c[0].originLine("Harbor Audio", "Google Play"), "en"))
        assertEquals("From Google Play", bundled.format(c[1].originLine("Harbor Audio", "Google Play"), "en"))
        assertEquals("From Harbor Audio", bundled.format(c[2].originLine("Harbor Audio", "Google Play"), "en"))
    }

    @Test
    fun theMetaLineJoinsOriginAndTerm() {
        val c = KitRowData.from(many).choices!!.choices
        val bundled = KitCopy.bundled
        assertEquals("Added with a key · Lifetime", bundled.format(c[0].metaLine("Harbor Audio", "Google Play", null), "en"))
        val date = kitDate(1_798_761_600, "en")
        assertEquals("From Google Play · Until $date", bundled.format(c[1].metaLine("Harbor Audio", "Google Play", date), "en"))
        assertEquals("1 of 3 devices", bundled.format(c[0].seatsLine()!!, "en"))
        assertEquals("3 of 3 devices", bundled.format(c[2].seatsLine()!!, "en"))
    }

    @Test
    fun datesAreTheReadersAndNeverTheRawText() {
        assertEquals("Jan 1, 2027", kitDate(1_798_761_600, "en"))
        assertEquals("Sep 30, 2026", kitDay("2026-09-30", "en"))
        assertEquals("not a date", kitDay("not a date", "en"))
        assertTrue(kitDay("2026-09-30", "de").contains("2026"))
    }

    @Test
    fun releaseNotesAndFeaturesAreReadAndAMissingMemberIsEmpty() {
        val data = KitRowData.from(
            KitInputs.fromJson(
                buildJsonObject {
                    put(
                        "releaseNotes",
                        JsonArray(listOf(buildJsonObject { put("version", "2.5.0"); put("date", "2026-09-30"); put("notes", "Faster sync.") }, buildJsonObject { put("date", "x") })),
                    )
                    put("offers", buildJsonObject { put("features", JsonArray(listOf(JsonPrimitive("Export"), JsonPrimitive("Sync")))) })
                },
            ),
        )
        assertEquals(listOf(KitReleaseNote("2.5.0", "2026-09-30", "Faster sync.")), data.releaseNotes)
        assertEquals(listOf("Export", "Sync"), data.features)
        val empty = KitRowData.from(KitInputs.of(emptyMap()))
        assertNull(empty.choices)
        assertTrue(empty.releaseNotes.isEmpty() && empty.features.isEmpty())
    }

    @Test
    fun diagnosticsLoseKeysTokensEmailAndBearerValues() {
        val text = "Diceroll 2.4.1\nkey pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV\ndevice pkeyt_0123456789abcdef\nci pkeyci_9f8e7d6c5b4a\nada@fennick.studio\nAuthorization: Bearer abc.def-ghi\nhwid: 0123456789abcdef0123456789abcdef"
        val redacted = redactDiagnostics(text)
        for (secret in listOf("pkey_djdl", "pkeyt_", "pkeyci_", "fennick", "abc.def-ghi", "0123456789abcdef0123")) {
            assertFalse("$secret survived in $redacted", redacted.contains(secret))
        }
        assertTrue(redacted.startsWith("Diceroll 2.4.1"))
        assertTrue(redacted.contains("Bearer [redacted]"))
        // Ordinary text is untouched.
        assertEquals("Android 15 · build 241", redactDiagnostics("Android 15 · build 241"))
    }
}
