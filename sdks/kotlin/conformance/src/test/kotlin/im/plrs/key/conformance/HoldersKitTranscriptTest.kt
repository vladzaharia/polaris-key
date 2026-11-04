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

    private val happy = Transcript.load().first { it.id == "devicecode-happy" }

    private fun steps(t: Transcript) = (t.json["steps"] as JsonArray).map { it as JsonObject }

    private fun items(step: JsonObject) = ((step["exchanges"] as JsonObject)["items"] as JsonArray).map { it as JsonObject }

    private fun obj(o: JsonObject, key: String) = o[key] as JsonObject

    /**
     * Another account signs in: the recording's device start, its poll request answered `ready` as devicecode-happy
     * records it but showing jo@other.com, the sync that follows (it runs beside the preview, so unordered), and the attach preview.
     * The confirmed attach is
     * not in the conversation, so the replayer fails if the holder sends it.
     */
    private fun otherAccount(): Transcript {
        val rest = steps(original).drop(1)
        val ready = steps(happy).last()
        val readyItems = items(ready).mapIndexed { i, item ->
            if (i != 0) return@mapIndexed item
            // The poll request is the recording's own (this device code); the answer is happy's, with an email.
            val answer = obj(obj(item, "response"), "body")
            val shown = JsonObject(mapOf("name" to JsonPrimitive("Jo"), "email" to JsonPrimitive("jo@other.com")))
            JsonObject(
                items(rest[1]).first() + mapOf(
                    "response" to JsonObject(obj(item, "response") + ("body" to JsonObject(answer + ("identity" to shown)))),
                    "capture" to (item["capture"] as JsonElement),
                ),
            )
        }
        val all = items(rest[0]) + readyItems + items(rest[3])
        val step = JsonObject(
            rest[0] + mapOf(
                "now" to (ready["now"] ?: JsonPrimitive(happy.now + 7)),
                "args" to obj(rest[0], "args"),
                "exchanges" to JsonObject(mapOf("ordered" to JsonPrimitive(false), "items" to JsonArray(all))),
                "expect" to JsonObject(emptyMap()),
            ),
        )
        return Transcript(JsonObject(original.json + ("steps" to JsonArray(listOf(steps(original).first(), step)))))
    }

    @Test
    fun anotherAccountSigningInIsToldAndNothingIsAttached() {
        assumeTrue("sdks/kotlin/parity.json does not claim the transcript's features", Transcript.applies(original, Transcript.manifestStatuses()))
        val seen = HashMap<String, String?>()
        drive(otherAccount()) { state ->
            seen["step"] = state.ui.value.step
            seen["view"] = state.screen().state
            seen["typed"] = state.ui.value.typedEmail
            seen["signed"] = state.ui.value.signedEmail
        }
        assertEquals(
            mapOf(
                "step" to "other-account",
                "view" to "other-account",
                "typed" to "a\u2022\u2022\u2022@example.com",
                "signed" to "j\u2022\u2022\u2022@other.com",
            ),
            seen,
        )
    }

    @Test
    fun theHolderReplaysTheRecordedConversation() {
        assumeTrue("sdks/kotlin/parity.json does not claim the transcript's features", Transcript.applies(original, Transcript.manifestStatuses()))
        val seen = HashMap<String, String?>()
        drive(merged()) { state ->
            seen["step"] = state.ui.value.step
            seen["view"] = state.screen().state
        }
        assertEquals(mapOf("step" to "added", "view" to "added"), seen)
    }

    /** Replay [t], running the holder over the real driver at its `beginSignIn` step. */
    private fun drive(t: Transcript, after: (PolarisAddToAccountState) -> Unit) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            KotlinReplay.replay(t) { client, step ->
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
                after(state)
                emptyMap()
            }
        } finally {
            scope.cancel()
        }
    }

    private companion object {
        const val ID = "holders-add-to-account-preview"
    }
}
