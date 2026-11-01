// @pkey-feature identity.nearby
// The nearby sign-in conversations (I-45.12; WIRE-CONTRACT-V5 section 12.11.5), replayed for the NEW device D: its
// `nearby/start` and `nearby/poll` must reproduce every recorded request byte for byte, proofs included (the fixture
// device keys of each step's `keyLabel`), and every recorded answer must read as the transcript's `expect`. The
// approving device's `nearbyApprove` steps are served from the recording: that half is I-45.13's, which maps them to its
// own routes. These six also run in `TranscriptTest` once `parity.json` claims `identity.nearby`.

package im.plrs.key.conformance

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NearbyTranscriptTest : ConformanceSuite() {
    private val nearby = Transcript.load().filter { it.id.startsWith("nearby-") }
    private val heldBack = setOf("nearbyApprove")

    @Test
    fun theSixScenariosArePresent() = assertEquals(
        listOf("nearby-choose", "nearby-denied", "nearby-disabled", "nearby-errors", "nearby-gate-off", "nearby-happy"),
        nearby.map { it.id }.sorted(),
    )

    @Test
    fun everyRequestIsTheRecordedOneAndEveryAnswerIsReadAsRecorded() {
        for (t in nearby) KotlinReplay.replay(t, heldBack)
    }

    private fun item(t: Transcript, step: Int, edit: (JsonObject) -> JsonObject): Transcript = t.doctor(step) { items ->
        items[0] = edit(items[0] as JsonObject)
    }

    private fun alterProof(o: JsonObject): JsonObject {
        val request = o["request"] as JsonObject
        val body = request["body"] as JsonObject
        val json = body["json"] as JsonObject
        val proof = (json["proof"] as JsonPrimitive).content
        val changed = proof.dropLast(1) + if (proof.last() == 'A') 'B' else 'A'
        return JsonObject(
            o + (
                "request" to JsonObject(
                    request + ("body" to JsonObject(body + ("json" to JsonObject(json + ("proof" to JsonPrimitive(changed)))))),
                )
                ),
        )
    }

    private fun failsWith(t: Transcript, needle: String) {
        try {
            KotlinReplay.replay(t, heldBack)
        } catch (e: AssertionError) {
            assertTrue("expected \"$needle\" in: ${e.message}", e.message.orEmpty().contains(needle))
            return
        }
        fail("the doctored transcript replayed cleanly")
    }

    /** A proof that is not the recorded one fails the replay: D's start and D's poll are held to the recording's bytes. */
    @Test
    fun aProofThatIsNotTheRecordedOneFails() {
        val happy = nearby.first { it.id == "nearby-happy" }
        failsWith(item(happy, 1, ::alterProof), "proof")
        failsWith(item(happy, 5, ::alterProof), "proof")
    }

    @Test
    fun aDifferentAnswerFails() {
        val happy = nearby.first { it.id == "nearby-happy" }
        failsWith(happy.withExpect(1, "interval", JsonPrimitive(9)), "step 1 (nearbyStart): interval")
        failsWith(happy.withExpect(5, "tokenHeld", JsonPrimitive(false)), "step 5 (nearbyPoll): tokenHeld")
    }

    @Test
    fun aRequestThatWasNotSentFails() {
        val happy = nearby.first { it.id == "nearby-happy" }
        failsWith(happy.doctor(2) { items -> items.add(items[0] as JsonElement) }, "expected request not sent")
    }
}
