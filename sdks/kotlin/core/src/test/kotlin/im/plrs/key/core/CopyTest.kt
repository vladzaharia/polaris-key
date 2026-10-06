// @pkey-feature core.copy
//
// `Copy` over the generated catalog (SDK parity pass §3.2, `core.copy`; SP-21): every table reads
// as copy.en.json says, the code-versus-activation split holds, an unknown code reads the fallback
// naming it, placeholders fill or drop, and the host override layer wins per key.

package im.plrs.key.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CopyTest {
    private val source: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("pkey.repoRoot")).resolve("conformance/parity/copy.en.json").readText(),
    ).jsonObject

    private fun table(name: String): Map<String, CopyEntry> =
        source.getValue(name).jsonObject.mapValues { (_, v) ->
            CopyEntry(v.jsonObject.getValue("title").jsonPrimitive.content, v.jsonObject.getValue("message").jsonPrimitive.content)
        }

    /** What `message(code)` should read for a raw catalog string: `{code}` filled, others dropped. */
    private fun filled(text: String, code: String): String =
        Regex("""( ?)\{(\w+)\}""").replace(text) { m -> if (m.groupValues[2] == "code") m.groupValues[1] + code else "" }

    @After
    fun reset() = Copy.resetOverrides()

    @Test
    fun generatedTablesMatchTheCatalog() {
        assertEquals(table("codes"), COPY_CODES)
        assertEquals(table("gate"), COPY_GATE)
        assertEquals(table("activation"), COPY_ACTIVATION)
        val fallback = source.getValue("fallback").jsonObject
        assertEquals(CopyEntry(fallback.getValue("title").jsonPrimitive.content, fallback.getValue("message").jsonPrimitive.content), COPY_FALLBACK)
    }

    @Test
    fun everyErrorCodeReadsItsOwnEntry() {
        assertTrue(COPY_CODES.size > 50)
        for ((code, entry) in COPY_CODES) {
            assertEquals(code, filled(entry.message, code), Copy.message(code))
            assertEquals(code, entry.title, Copy.title(code))
            assertTrue(code, Copy.hasCopy(code))
        }
    }

    @Test
    fun everyGateStatusReads() {
        for (status in LicenseStatus.entries) {
            val entry = COPY_GATE.getValue(status.wire)
            // An error code of the same name wins in message(); the gate table answers the rest.
            val expected = COPY_CODES[status.wire] ?: entry
            assertEquals(status.wire, filled(expected.message, status.wire), Copy.message(status.wire))
            assertEquals(status.wire, expected.title, Copy.title(status.wire))
        }
        assertEquals("Signed out", Copy.title("revoked"))
        assertEquals("Update required", Copy.title("version-too-old"))
    }

    @Test
    fun everyActivationResultReadsTheActivationTable() {
        for ((result, entry) in COPY_ACTIVATION) {
            assertEquals(result, filled(entry.message, result), Copy.activationMessage(result))
            assertEquals(result, entry.title, Copy.activationTitle(result))
        }
        // Each spelling of a kind reaches the same entry.
        val limit = COPY_ACTIVATION.getValue("device-limit")
        for (kind in listOf("deviceLimit", "device_limit", "device-limit")) {
            assertEquals(limit.message, Copy.activationMessage(kind))
            assertEquals(limit.title, Copy.activationTitle(kind))
        }
    }

    @Test
    fun activationAndErrorCodeAreSeparateTables() {
        // The error code `unauthorized` is a session; the activation result is a key.
        assertEquals("Not signed in", Copy.title("unauthorized"))
        assertEquals("Key not accepted", Copy.activationTitle("unauthorized"))
        assertNotEquals(Copy.message("unauthorized"), Copy.activationMessage("unauthorized"))
        assertEquals(COPY_CODES.getValue("unauthorized").message, Copy.message("unauthorized"))
        assertEquals(COPY_ACTIVATION.getValue("unauthorized").message, Copy.activationMessage("unauthorized"))
        // `message` reaches the activation table for a code no other table has.
        assertEquals(COPY_ACTIVATION.getValue("device-limit").message, Copy.message("deviceLimit"))
        // `refused` names the server's code; a kind outside the table reads like message().
        assertEquals("Activation was refused (license_owned).", Copy.activationMessage("refused", code = "license_owned"))
        assertEquals("Activation was refused (refused).", Copy.activationMessage("refused"))
        assertEquals(Copy.message("not_found"), Copy.activationMessage("not_found"))
    }

    @Test
    fun unknownCodeReadsTheFallbackNamingIt() {
        assertFalse(Copy.hasCopy("no-such-code"))
        assertEquals("Something went wrong (no-such-code). Try again.", Copy.message("no-such-code"))
        assertEquals(COPY_FALLBACK.title, Copy.title("no-such-code"))
        assertEquals(COPY_FALLBACK.title, Copy.activationTitle("no-such-code"))
        assertEquals("Something went wrong (no-such-code). Try again.", Copy.activationMessage("no-such-code"))
    }

    @Test
    fun placeholdersFillOrDrop() {
        Copy.registerLocale(
            "en",
            mapOf("x" to CopyEntry("T", "Used {deviceCount} of {limit} devices; wait {retryAfterSeconds}s on {product} ({code}).")),
        )
        assertEquals(
            "Used 3 of 3 devices; wait 30s on Diceroll (x).",
            Copy.message("x", params = mapOf("deviceCount" to 3, "limit" to 3, "retryAfterSeconds" to 30, "product" to "Diceroll")),
        )
        // Unfilled placeholders drop with the space before them; `{code}` defaults to the code.
        assertEquals("Used of devices; waits on (x).", Copy.message("x"))
        assertEquals("Used 1 of 2 devices; waits on (ABC).", Copy.message("x", params = mapOf("deviceCount" to 1, "limit" to 2, "code" to "ABC")))
        // Every generated string comes out without a raw placeholder.
        for (table in listOf(COPY_CODES, COPY_GATE, COPY_ACTIVATION)) {
            for (code in table.keys) assertFalse(code, Copy.message(code).contains('{'))
        }
    }

    @Test
    fun detailIsAppended() {
        assertEquals("${COPY_CODES.getValue("forbidden").message} (seat taken)", Copy.message("forbidden", detail = "seat taken"))
        assertEquals(COPY_CODES.getValue("forbidden").message, Copy.message("forbidden", detail = ""))
    }

    @Test
    fun hostOverridesWinPerKey() {
        Copy.registerLocale("en", mapOf("forbidden" to CopyEntry("Nope", "You can't do that here."), "brand-new" to CopyEntry("New", "A new one ({code}).")))
        assertEquals("You can't do that here.", Copy.message("forbidden"))
        assertEquals("Nope", Copy.title("forbidden"))
        assertEquals("A new one (brand-new).", Copy.message("brand-new"))
        assertTrue(Copy.hasCopy("brand-new"))
        // Every other key keeps the generated text.
        assertEquals(COPY_CODES.getValue("not_found").message, Copy.message("not_found"))
        // An activation override is keyed by the activationResult spelling.
        Copy.registerLocale("en", mapOf("device-limit" to CopyEntry("Full", "No seats left.")))
        assertEquals("No seats left.", Copy.activationMessage("deviceLimit"))
        assertEquals("Full", Copy.activationTitle("device_limit"))
        Copy.resetOverrides()
        assertEquals(COPY_CODES.getValue("forbidden").message, Copy.message("forbidden"))
    }

    @Test
    fun localesFallBackToEnglish() {
        Copy.registerLocale("fr", mapOf("forbidden" to CopyEntry("Interdit", "Votre licence ne vous permet pas de faire cela.")))
        assertEquals("Votre licence ne vous permet pas de faire cela.", Copy.message("forbidden", locale = "fr"))
        assertEquals("Interdit", Copy.title("forbidden", locale = "fr-CA"))
        assertEquals("Interdit", Copy.title("forbidden", locale = "FR_ca"))
        // A key the locale lacks reads English; English itself is untouched.
        assertEquals(COPY_CODES.getValue("not_found").message, Copy.message("not_found", locale = "fr"))
        assertEquals(COPY_CODES.getValue("forbidden").message, Copy.message("forbidden"))
    }
}
