// @pkey-feature ui.kit.holders identity.devicecode.choice identity.attach
//
// The AddToAccount state holder and its SDK driver over the recorded `holders-add-to-account-preview`
// conversation (UK-43.8), through TranscriptTest's replayer. The recording is one flow the holder drives end to
// end: key activation, then the sign-in the driver starts (channel redirect with no redirect URI; no native
// redirect is available here, so it answers redirect-unavailable and the driver asks for a device code with the
// hints), the poll that answers `choose`, `choice.complete` keeping this device's license, the attach preview
// (`confirm: false`) and the confirmed attach. The five recorded steps after the activation are replayed as one
// ordered step, so the replayer asserts every request and nothing else is sent.

package im.plrs.key.conformance

import im.plrs.key.ui.AddToAccountField
import im.plrs.key.ui.PolarisAddToAccountState
import im.plrs.key.ui.addToAccountDriver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

class HoldersKitTranscriptTest : ConformanceSuite() {
    private val original = Transcript.load().first { it.id == ID }

    /** The transcript with everything after the activation as one ordered step. */
    private fun merged(): Transcript {
        val steps = original.json["steps"] as JsonArray
        val first = steps.first()
        val rest = steps.drop(1).map { it as JsonObject }
        assertEquals(
            listOf("beginSignIn", "pollSignIn", "choiceComplete", "attach", "attach"),
            rest.map { (it["action"] as JsonPrimitive).content },
        )
        val items = rest.flatMap { ((it["exchanges"] as JsonObject)["items"] as JsonArray) }
        val args = rest.fold(emptyMap<String, JsonElement>()) { acc, s -> acc + (s["args"] as JsonObject) }
        val step = JsonObject(
            rest.first() + mapOf(
                "args" to JsonObject(args),
                "exchanges" to JsonObject(mapOf("ordered" to JsonPrimitive(true), "items" to JsonArray(items))),
                "expect" to JsonObject(emptyMap()),
            ),
        )
        return Transcript(JsonObject(original.json + ("steps" to JsonArray(listOf(first, step)))))
    }

    @Test
    fun theHolderReplaysTheRecordedConversation() {
        assumeTrue("sdks/kotlin/parity.json does not claim the transcript's features", Transcript.applies(original, Transcript.manifestStatuses()))
        val seen = HashMap<String, String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            KotlinReplay.replay(merged()) { client, step ->
                if ((step["action"] as JsonPrimitive).content != "beginSignIn") return@replay null
                val state = PolarisAddToAccountState(
                    driver = client.addToAccountDriver(),
                    scope = scope,
                    base = JsonObject(
                        mapOf(
                            "platform" to JsonObject(mapOf("os" to JsonPrimitive("macos"), "formFactor" to JsonPrimitive("mac"))),
                            "presentation" to JsonObject(mapOf("name" to JsonPrimitive("Tidewater Studio"), "icon" to JsonPrimitive(true))),
                            "services" to JsonArray(listOf(JsonPrimitive("license"), JsonPrimitive("identity"))),
                            "licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive("ada@example.com"))),
                        ),
                    ),
                    deviceKind = "Mac",
                )
                state.setField(AddToAccountField.Name, "Ada")
                state.setField(AddToAccountField.Email, "ada@example.com")
                state.submit().join()
                seen["step"] = state.ui.value.step
                seen["view"] = state.screen().state
                emptyMap()
            }
        } finally {
            scope.cancel()
        }
        assertEquals(mapOf("step" to "added", "view" to "added"), seen)
    }

    private companion object {
        const val ID = "holders-add-to-account-preview"
    }
}
