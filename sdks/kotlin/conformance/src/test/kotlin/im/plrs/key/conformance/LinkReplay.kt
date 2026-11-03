// @pkey-feature identity.link
//
// The link verbs of the Kotlin transcript replayer (identity.link, I-45.10): `linkOffer` and `link` drive
// `client.identity.link` after a redirect sign-in the recorded client made. link-game also pins Game Center, which
// this SDK does not run, so it is replayed without the Game Center exchange and its link by handle.

package im.plrs.key.conformance

import im.plrs.key.core.jsonInt
import im.plrs.key.core.stringValue
import im.plrs.key.identity.ConformanceReplayOnly
import im.plrs.key.identity.ExchangeKind
import im.plrs.key.identity.LinkAcceptResult
import im.plrs.key.identity.LinkOfferEntry
import im.plrs.key.identity.LinkOfferResult
import im.plrs.key.identity.PlatformIdentityProvider
import im.plrs.key.identity.PlatformSubjectToken
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** The platform provider of a recorded `link` step: it hands back the recorded token whatever the nonce. */
private class RecordedProvider(override val kind: ExchangeKind, private val token: String) : PlatformIdentityProvider {
    override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? = null

    override suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken? = PlatformSubjectToken(token, nonce)

    override suspend fun signOutCleanup() = Unit

    override suspend fun credentialRevoked(): Boolean = false
}

private fun nullable(value: String?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)

@OptIn(ConformanceReplayOnly::class)
object LinkReplay {
    /** One `linkOffer` or `link` step; a refusal is a result. */
    suspend fun step(client: PolarisKeyClient, session: ReplaySession, args: JsonObject, action: String, out: MutableMap<String, JsonElement>) {
        val label = args["keyLabel"].stringValue
        if (label != null && session.keyLabel != label) {
            session.keys.use(label)
            session.keyLabel = label
        }
        client.identity.useDeviceKeys(session.keys)
        // A step that names a server auth code is Play Games' link by token: the provider hands it back over the nonce.
        args["serverAuthCode"].stringValue?.let { client.identity.installPlatformIdentity(RecordedProvider(ExchangeKind.pgs, it)) }
        if (action == "linkOffer") {
            offer(client.identity.link.offer(), out)
        } else {
            accept(client.identity.link.acceptRecorded(args["linkHandle"].stringValue, args["proofValue"].stringValue), out)
        }
    }

    private fun entry(e: LinkOfferEntry) = JsonObject(mapOf("kind" to JsonPrimitive(e.kind), "reach" to nullable(e.reach)))

    private fun offer(r: LinkOfferResult, out: MutableMap<String, JsonElement>) {
        when (r) {
            is LinkOfferResult.Ok -> {
                out["result"] = JsonPrimitive("ok")
                out["offer"] = JsonArray(r.kinds.map(::entry))
            }

            LinkOfferResult.Unavailable -> out["result"] = JsonPrimitive("unavailable")
        }
    }

    private fun accept(r: LinkAcceptResult, out: MutableMap<String, JsonElement>) {
        when (r) {
            is LinkAcceptResult.Linked -> {
                out["result"] = JsonPrimitive("ok")
                out["linked"] = JsonObject(mapOf("kind" to JsonPrimitive(r.kind), "reach" to nullable(r.reach)))
            }

            is LinkAcceptResult.Refused -> {
                out["result"] = JsonPrimitive("refused")
                out["status"] = jsonInt(r.status.toLong())
                out["code"] = JsonPrimitive(r.code)
            }

            LinkAcceptResult.Unavailable -> out["result"] = JsonPrimitive("unavailable")
        }
    }
}

class LinkTranscriptTest : ConformanceSuite() {
    /**
     * `link-game` also pins Game Center, which this SDK does not run (`identity.gamecenter` is not applicable here):
     * the conversation is replayed without the Game Center exchange and its link by handle, the Play Games half.
     */
    @Test
    fun linkGameReplaysItsPlayGamesHalf() {
        val t = Transcript.load().first { it.id == "link-game" }
        val steps = t.steps
        assertEquals("gamecenter", steps.first()["args"]!!.obj["kind"].stringValue)
        val byHandle = steps.indexOfFirst { it["action"].stringValue == "link" && it["args"]!!.obj["linkHandle"] != null }
        assertEquals("gamecenter", steps[byHandle]["expect"]!!.obj["linked"]!!.obj["kind"].stringValue)
        assertEquals("pgs", steps.last()["expect"]!!.obj["linked"]!!.obj["kind"].stringValue)
        val half = steps.filterIndexed { i, _ -> i != 0 && i != byHandle }
        KotlinReplay.replay(Transcript(JsonObject(t.json + ("steps" to JsonArray(half)))))
    }
}
