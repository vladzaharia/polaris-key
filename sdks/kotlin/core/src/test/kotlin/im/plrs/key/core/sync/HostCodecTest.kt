// @pkey-feature sync.settings
//
// The host codec boundary (U-07.K5): what `sealPush` sends, what `openPull` proves, and that the machine
// only ever takes the host's own open result. The cases are client-core's `hostCodec.test.ts` and the
// SEC-SYNC-HOST 1, 3 and 9 proofs, over a fixture root. HC-1 to HC-6 each name their test.

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A codec over a fixture root, with a switch for "locked" and a count of seals. */
private class FixtureCodec(private val root: ByteArray) : SyncCodecPort {
    var isLocked = false
    var seals = 0
    override val locked: Boolean get() = isLocked

    override fun seal(collection: String, name: String, value: JsonElement): ByteArray {
        seals++
        return SyncEnvelope.seal(root, collection, name, value)
    }

    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(root, collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(root, collection, envelope)

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String) = SyncBlind.blind(root, kind, ctx, name)
}

private val ROOT = ByteArray(32) { (3 * it + 7).toByte() }
private val OTHER_ROOT = ByteArray(32) { (250 - 5 * it).toByte() }
private const val VOL = "audio.volume"
private const val BIND = "input.bindings"
private const val OPEN = "my.private.key"
private val DECLARED = listOf(VOL, BIND)
private const val C = HostCodec.SETTINGS_COLLECTION

private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

private fun str(s: String) = JsonPrimitive(s)

private fun sealedCt(name: String, v: JsonElement, root: ByteArray = ROOT): String = Base64Url.encode(SyncEnvelope.seal(root, C, name, v))

private fun bl(kind: SyncBlind.Kind, ctx: String, n: String) = SyncBlind.blind(ROOT, kind, ctx, n)

private fun push(vararg mutations: JsonElement): JsonElement = JsonObject(
    mapOf("clientId" to str("c_x"), "cursor" to JsonPrimitive(0), "atomic" to JsonPrimitive(false), "mutations" to JsonArray(mutations.toList())),
)

private fun set(id: Int, setting: String, value: JsonElement): JsonElement =
    j("""{"mutationId":$id,"target":{"setting":${Json.encodeToString(JsonPrimitive.serializer(), str(setting))},"scope":"user"},"op":"set"}""")
        .let { JsonObject((it as JsonObject) + ("value" to value)) }

private fun mutationOf(id: Int, setting: String) = set(id, setting, JsonPrimitive(1))

private fun changes(b: JsonElement): List<JsonObject> = b.objectValue!!["changes"].arrayValue!!.map { it as JsonObject }

private fun results(b: JsonElement): List<JsonObject> = b.objectValue!!["results"].arrayValue!!.map { it as JsonObject }

private fun codeOf(f: () -> Unit): String? = try {
    f()
    null
} catch (e: PolarisException) {
    e.code
} catch (e: SyncCryptoException) {
    "crypto:" + e.message
}

private val codec = FixtureCodec(ROOT)
private val SEALED = OpenedRow(sealed = true)
private val INVALID = OpenedRow(invalid = true)

private fun pull(
    body: JsonElement,
    mutations: List<JsonElement> = emptyList(),
    aliases: Map<String, String> = emptyMap(),
    openKeys: List<String> = emptyList(),
    c: SyncCodecPort = codec,
) = HostCodec.openPull(body, c, mutations, aliases, openKeys)

class HostCodecTest {
    @Test
    fun sealsDeclaredBlindsOpenAndMemberAndSendsNoPlaintext() {
        val body = push(
            set(1, VOL, JsonPrimitive(0.5)),
            set(2, OPEN, str("secret-value")),
            j("""{"mutationId":3,"target":{"setting":"$BIND","scope":"user"},"op":"setMember","member":"jump","value":"space"}"""),
            j("""{"mutationId":4,"target":{"setting":"$BIND","scope":"user"},"op":"removeMember","member":"run"}"""),
            j("""{"mutationId":5,"target":{"setting":"$VOL","scope":"user"},"op":"clear"}"""),
        )
        val out = HostCodec.sealPush(body, codec, DECLARED)
        val ms = out.objectValue!!["mutations"].arrayValue!!.map { it as JsonObject }
        fun target(m: JsonObject) = m["target"].objectValue!!["setting"].stringValue
        fun open(m: JsonObject, name: String) =
            SyncEnvelope.open(ROOT, C, name, Base64Url.decodeStrict(m["ct"].stringValue!!)!!) as SyncEnvelope.Opened.Ok
        assertEquals(VOL, target(ms[0]))
        assertNull(ms[0]["value"])
        assertTrue(SyncJson.jsonEqual(JsonPrimitive(0.5), open(ms[0], VOL).value))
        assertEquals(bl(SyncBlind.Kind.Setting, C, OPEN), target(ms[1]))
        assertTrue(SyncBlind.isBlindedName(target(ms[1])!!))
        assertEquals(str("secret-value"), open(ms[1], OPEN).value)
        assertEquals(BIND, target(ms[2]))
        assertEquals(str(bl(SyncBlind.Kind.Member, BIND, "jump")), ms[2]["member"])
        val m2 = open(ms[2], HostCodec.memberEnvelopeName(BIND, "jump"))
        assertEquals("$BIND\u0000jump", m2.name)
        assertEquals(str("space"), m2.value)
        assertEquals(str(bl(SyncBlind.Kind.Member, BIND, "run")), ms[3]["member"])
        assertNull(ms[3]["ct"])
        assertTrue(SyncJson.jsonEqual(j("""{"mutationId":5,"target":{"setting":"$VOL","scope":"user"},"op":"clear"}"""), ms[4]))
        val wire = out.toString()
        for (plain in listOf("secret-value", "space", OPEN, "\"jump\"", "\"run\"")) assertFalse(plain, wire.contains(plain))
    }

    @Test
    fun hc6LockedCodecRefusesAndSealsNothing() {
        val c = FixtureCodec(ROOT).also { it.isLocked = true }
        assertEquals(ErrorCode.syncLocked, codeOf { HostCodec.sealPush(push(set(1, VOL, JsonPrimitive(1))), c, DECLARED) })
        assertEquals(0, c.seals)
        assertEquals(ErrorCode.syncLocked, codeOf { HostCodec.openPull(j("""{"changes":[]}"""), c) })
    }

    @Test
    fun hc6RefusesRecordMutationHalfValidBatchAndUnsealableValue() {
        val record = j("""{"mutationId":2,"target":{"record":["slots","a"]},"op":"set","value":1}""")
        val c = FixtureCodec(ROOT)
        // The valid mutation before it is not returned: the call threw.
        assertEquals(ErrorCode.invalidOptions, codeOf { HostCodec.sealPush(push(set(1, VOL, JsonPrimitive(1)), record), c, DECLARED) })
        // A value canonical JSON refuses (an integer over 2^53) seals nothing.
        val big = Json.parseToJsonElement("9007199254740993")
        assertTrue(codeOf { HostCodec.sealPush(push(set(1, VOL, big)), c, DECLARED) }!!.startsWith("crypto:"))
    }

    @Test
    fun refusesAMemberOpOnAnOpenKey() {
        val m = j("""{"mutationId":1,"target":{"setting":"$OPEN","scope":"user"},"op":"setMember","member":"m","value":1}""")
        assertEquals(ErrorCode.invalidOptions, codeOf { HostCodec.sealPush(push(m), codec, DECLARED) })
    }

    @Test
    fun sealPushRoundTripsThroughOpenPull() {
        val out = HostCodec.sealPush(push(set(1, OPEN, j("""{"a":1}"""))), codec, DECLARED)
        val m = out.objectValue!!["mutations"].arrayValue!![0] as JsonObject
        val change = JsonObject(
            mapOf(
                "setting" to m["target"].objectValue!!["setting"]!!,
                "scope" to str("user"),
                "ct" to m["ct"]!!,
                "version" to JsonPrimitive(4),
            ),
        )
        val r = pull(JsonObject(mapOf("changes" to JsonArray(listOf(change)))))
        assertEquals(str(OPEN), changes(r.body)[0]["setting"])
        assertTrue(SyncJson.jsonEqual(j("""{"a":1}"""), changes(r.body)[0]["value"]))
        assertEquals(listOf<OpenedRow?>(SEALED), r.opened.changes)
    }

    @Test
    fun opensDeclaredTakesSeqFromVersionOnPlaintextRowsAndStripsCt() {
        val body = j(
            """{"changes":[{"setting":"$VOL","scope":"user","ct":"${sealedCt(VOL, JsonPrimitive(0.3))}","version":9,"editedHlc":"h"},
               {"setting":"legacy","scope":"user","value":1,"version":2}]}""",
        )
        val r = pull(body)
        assertTrue(SyncJson.jsonEqual(j("""{"setting":"$VOL","scope":"user","value":0.3,"version":9,"editedHlc":"h"}"""), changes(r.body)[0]))
        assertTrue(SyncJson.jsonEqual(j("""{"setting":"legacy","scope":"user","value":1,"version":2}"""), changes(r.body)[1]))
        assertEquals(listOf<OpenedRow?>(SEALED, OpenedRow(seq = 2)), r.opened.changes)
    }

    // HC-2
    @Test
    fun hc2StripsSealedInvalidAndSeqTheBodyClaims() {
        val r = pull(
            j(
                """{"sealed":true,"changes":[{"setting":"p","scope":"user","value":666,"version":50,"sealed":true,"invalid":false,"seq":1}],
                   "results":[{"mutationId":1,"status":"ok","version":1,"sealed":true,"seq":1}]}""",
            ),
        )
        assertNull(r.body.objectValue!!["sealed"])
        assertTrue(SyncJson.jsonEqual(j("""{"setting":"p","scope":"user","value":666,"version":50}"""), changes(r.body)[0]))
        assertTrue(SyncJson.jsonEqual(j("""{"mutationId":1,"status":"ok","version":1}"""), results(r.body)[0]))
        assertEquals(listOf<OpenedRow?>(OpenedRow(seq = 50)), r.opened.changes)
    }

    // HC-5
    @Test
    fun hc5UnopenableCtIsInvalidWithNoValue() {
        val good = sealedCt(VOL, JsonPrimitive(1))
        val tampered = Base64Url.decodeStrict(good)!!.also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        val cases =
            listOf(
                sealedCt(VOL, JsonPrimitive(1), OTHER_ROOT),
                Base64Url.encode(tampered),
                sealedCt("other.key", JsonPrimitive(1)),
                "not base64 !",
                "$good=",
                "",
            )
        for (ct in cases) {
            val change = JsonObject(
                mapOf(
                    "setting" to str(VOL),
                    "scope" to str("user"),
                    "ct" to str(ct),
                    "value" to JsonPrimitive(7),
                    "version" to JsonPrimitive(3),
                ),
            )
            val r = pull(JsonObject(mapOf("changes" to JsonArray(listOf(change)))))
            assertNull(changes(r.body)[0]["value"])
            assertNull(changes(r.body)[0]["ct"])
            assertEquals(listOf<OpenedRow?>(INVALID), r.opened.changes)
        }
    }

    // HC-5
    @Test
    fun hc5BlindedNameAcceptedOnlyWhenOpenedKeyReblindsToIt() {
        val honest = bl(SyncBlind.Kind.Setting, C, OPEN)
        val ct = sealedCt(OPEN, str("v"))

        fun change(name: String, extra: String) = j("""{"changes":[{"setting":"$name","scope":"user","version":1,$extra}]}""")
        val ok = pull(change(honest, """"ct":"$ct""""))
        assertEquals(str(OPEN), changes(ok.body)[0]["setting"])
        val other = bl(SyncBlind.Kind.Setting, C, "another.key")
        val moved = pull(change(other, """"ct":"$ct""""))
        assertEquals(str(other), changes(moved.body)[0]["setting"])
        assertNull(changes(moved.body)[0]["value"])
        assertEquals(listOf<OpenedRow?>(INVALID), moved.opened.changes)
        assertEquals(listOf<OpenedRow?>(OpenedRow(seq = 1)), pull(change(honest, """"value":1""")).opened.changes)
    }

    private fun memberRow(member: String, v: JsonElement, setting: String = BIND, blindCtx: String = BIND) = """{"member":"${bl(
        SyncBlind.Kind.Member,
        blindCtx,
        member,
    )}","ct":"${sealedCt(HostCodec.memberEnvelopeName(setting, member), v)}","editedHlc":"h"}"""

    private fun membersBody(vararg members: String) =
        j("""{"changes":[{"setting":"$BIND","scope":"user","members":[${members.joinToString(",")}],"version":5}]}""")

    @Test
    fun opensMergeMembersIntoOneValueAndChecksEachBlindedMember() {
        val jump = memberRow("jump", str("space"))
        val run = memberRow("run", str("shift"))
        val r = pull(membersBody(jump, run))
        assertTrue(SyncJson.jsonEqual(j("""{"jump":"space","run":"shift"}"""), changes(r.body)[0]["value"]))
        assertNull(changes(r.body)[0]["members"])
        assertEquals(listOf<OpenedRow?>(SEALED), r.opened.changes)
        // a member moved under another member's blinded name
        val moved = jump.replace(bl(SyncBlind.Kind.Member, BIND, "jump"), bl(SyncBlind.Kind.Member, BIND, "run"))
        assertEquals(listOf<OpenedRow?>(INVALID), pull(membersBody(moved, run)).opened.changes)
        // a member of another merge setting (the D-2 name binds the setting)
        val foreign = memberRow("jump", JsonPrimitive(1), setting = "other.merge")
        assertEquals(listOf<OpenedRow?>(INVALID), pull(membersBody(foreign)).opened.changes)
        // the same member twice
        assertEquals(listOf<OpenedRow?>(INVALID), pull(membersBody(jump, jump)).opened.changes)
    }

    // HC-1
    @Test
    fun hc1ConflictCopyOpensOnlyForAMutationOfTheRequest() {
        val ms = listOf(mutationOf(7, VOL), mutationOf(8, OPEN))
        val body = j(
            """{"results":[
              {"mutationId":7,"status":"conflict","server":{"ct":"${sealedCt(VOL, JsonPrimitive(0.9))}","version":40,"sealed":true}},
              {"mutationId":8,"status":"conflict","server":{"ct":"${sealedCt("wrong.name", JsonPrimitive(1))}","version":41}},
              {"mutationId":9,"status":"conflict","server":{"ct":"${sealedCt(VOL, JsonPrimitive(1))}","version":42}},
              {"mutationId":10,"status":"conflict","server":{"value":3,"version":3,"seq":0}}]}""",
        )
        val r = pull(body, ms)
        assertTrue(SyncJson.jsonEqual(j("""{"value":0.9,"version":40}"""), results(r.body)[0]["server"]))
        assertEquals(mapOf<Long, OpenedRow?>(7L to SEALED, 8L to INVALID, 9L to INVALID, 10L to OpenedRow(seq = 3)), r.opened.conflicts)
    }

    @Test
    fun mapsTombstonesOfKnownOpenKeysBackToTheirNames() {
        val body = j("""{"tombstones":[{"setting":"${bl(SyncBlind.Kind.Setting, C, OPEN)}","editedHlc":"h"},{"setting":"$VOL","editedHlc":"h"}]}""")
        val names = pull(body, openKeys = listOf(OPEN)).body.objectValue!!["tombstones"].arrayValue!!.map { it.objectValue!!["setting"] }
        assertEquals(listOf<JsonElement?>(str(OPEN), str(VOL)), names)
    }

    // HC-3
    @Test
    fun hc3RenamesComeFromTheAppNeverTheServedBody() {
        val served = j(
            """{"changes":[{"setting":"new.name","scope":"user","ct":"${sealedCt(
                "old.name",
                JsonPrimitive(1),
            )}","version":1}],"aliases":{"old.name":"new.name"}}""",
        )
        assertEquals(listOf<OpenedRow?>(INVALID), pull(served).opened.changes)
        assertEquals(listOf<OpenedRow?>(SEALED), pull(served, aliases = mapOf("old.name" to "new.name")).opened.changes)
    }

    // HC-3 (SEC-SYNC-HOST 3)
    @Test
    fun hc3ServesNoAliasOrRenameTheAppDidNotDeclare() {
        val ms = listOf(mutationOf(1, "old.k"), mutationOf(2, "x.k"))
        val body = j(
            """{"aliases":{"foo":"bar"},"results":[{"mutationId":1,"status":"ok","version":1,"renamedTo":"new.k"},
                {"mutationId":2,"status":"ok","version":2,"renamedTo":"evil"}]}""",
        )
        val r = pull(body, ms, mapOf("old.k" to "new.k"))
        assertTrue(SyncJson.jsonEqual(j("""{"old.k":"new.k"}"""), r.body.objectValue!!["aliases"]))
        assertEquals(str("new.k"), results(r.body)[0]["renamedTo"])
        assertNull(results(r.body)[1]["renamedTo"])
        assertTrue(SyncJson.jsonEqual(j("{}"), pull(body).body.objectValue!!["aliases"]))
    }

    // HC-1 (SEC-SYNC-HOST 1)
    @Test
    fun hc1RepeatedMutationIdFailsTheWholeAnswerClosed() {
        val ms = listOf(mutationOf(1, VOL))
        fun conflict(id: String, server: String) = """{"mutationId":$id,"status":"conflict","server":$server}"""
        val forged = """{"value":"FORGED","version":90}"""
        val real = """{"ct":"${sealedCt(VOL, JsonPrimitive(0.9))}","version":91}"""
        for ((a, b) in listOf("1" to "1", "1" to "1.0")) {
            val code = codeOf { pull(j("""{"results":[${conflict(a, forged)},${conflict(b, real)}]}"""), ms) }
            assertEquals("$a vs $b", ErrorCode.syncFailed, code)
        }
        // 1 and true are different ids.
        pull(j("""{"results":[${conflict("1", forged)},${conflict("true", real)}]}"""), ms)
    }

    // HC-4 (SEC-SYNC-HOST 9): refused by code point, so a NUL followed by a combining mark counts.
    @Test
    fun hc4RefusesU0000InASettingOrMemberNameOnPushAndPull() {
        fun refused(name: String) = codeOf { HostCodec.sealPush(push(set(1, name, JsonPrimitive(1))), codec, DECLARED) }
        assertEquals(ErrorCode.invalidOptions, refused("a\u0000b"))
        assertEquals(ErrorCode.invalidOptions, refused("a\u0000́b"))
        val setMember = JsonObject(
            mapOf(
                "mutationId" to JsonPrimitive(1),
                "target" to j("""{"setting":"$BIND","scope":"user"}"""),
                "op" to str("setMember"),
                "member" to str("j\u0000k"),
                "value" to JsonPrimitive(1),
            ),
        )
        assertEquals(ErrorCode.invalidOptions, codeOf { HostCodec.sealPush(push(setMember), codec, DECLARED) })
        // An open key sealed with a NUL by a hostile peer.
        val nul = "a\u0000b"
        val change = JsonObject(
            mapOf(
                "setting" to str(bl(SyncBlind.Kind.Setting, C, nul)),
                "scope" to str("user"),
                "ct" to str(sealedCt(nul, JsonPrimitive(1))),
                "version" to JsonPrimitive(1),
            ),
        )
        assertEquals(listOf<OpenedRow?>(INVALID), pull(JsonObject(mapOf("changes" to JsonArray(listOf(change))))).opened.changes)
        // A member name with a NUL, sealed under the setting prefix.
        assertEquals(listOf<OpenedRow?>(INVALID), pull(membersBody(memberRow("j\u0000k", JsonPrimitive(1)))).opened.changes)
    }

    @Test
    fun aRecordChangeWithCtReadsAsInvalidAndAPlainOneIsLegacy() {
        val r = pull(j("""{"changes":[{"record":["slots","a"],"ct":"AAAA","version":1},{"record":["slots","b"],"version":2},3]}"""))
        assertEquals(listOf(INVALID, OpenedRow(seq = 2), null), r.opened.changes)
    }

    private fun vector(id: String): JsonObject =
        im.plrs.key.core.JsonText.parse(java.io.File(repoRoot(), "conformance/corpus/v2/sync-vectors.json").readText())
            .objectValue!!["envelopeCases"].arrayValue!!.map { it as JsonObject }.first { it["id"].stringValue == id }

    private fun repoRoot(): java.io.File = System.getProperty("pkey.repoRoot")?.let { java.io.File(it) } ?: java.io.File("../..").canonicalFile

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun served(c: JsonObject, setting: String, member: String): JsonElement {
        val root = unhex(c["rootHex"].stringValue!!)
        val m = """{"member":"${SyncBlind.blind(
            root,
            SyncBlind.Kind.Member,
            setting,
            member,
        )}","ct":"${Base64Url.encode(unhex(c["envelopeHex"].stringValue!!))}","editedHlc":"h"}"""
        return j("""{"changes":[{"setting":"$setting","scope":"user","version":4,"members":[$m]}]}""")
    }

    @Test
    fun memberEnvelopeNamesFollowTheCorpusRows() {
        val seal = vector("seal-member")
        assertEquals(seal["name"].stringValue, HostCodec.memberEnvelopeName("inventory", "gold"))
        val vCodec = FixtureCodec(unhex(seal["rootHex"].stringValue!!))
        val ok = pull(served(seal, "inventory", "gold"), c = vCodec)
        assertTrue(SyncJson.jsonEqual(j("""{"gold":3}"""), changes(ok.body)[0]["value"]))
        assertEquals(listOf<OpenedRow?>(SEALED), ok.opened.changes)
        assertEquals(listOf<OpenedRow?>(INVALID), pull(served(vector("member-swapped"), "inventory", "silver"), c = vCodec).opened.changes)
        assertEquals(listOf<OpenedRow?>(INVALID), pull(served(vector("member-wrong-setting"), "equipment", "gold"), c = vCodec).opened.changes)
    }

    // openPull into receive: the machine reads only what the host's own open proved.
    private fun machine(): CloudSyncMachine {
        val ids = ArrayDeque(listOf("c_000000000000000client1"))
        val catalog = j("""{"settings":[{"key":"$VOL","route":"synced","scope":"user","policy":"lastWrite"}]}""") as JsonObject
        val opts = CloudSyncOptions("demo", catalog, j("""{"values":{"$VOL":0.8}}""") as JsonObject, 1_760_000_000_000L) { ids.removeFirst() }
        opts.contacted = true
        opts.subject = "sub_alice"
        opts.encryption = "e2e"
        opts.hasRoot = true
        opts.discovery = SyncDiscovery("e2e")
        return CloudSyncMachine(opts).also { it.takeRequests() }
    }

    @Test
    fun openPullFeedsReceiveAndAForgedPlaintextRowIsNotRead() {
        val sealedBody =
            j(
                """{"encryption":"e2e","cursor":4,"changes":[{"setting":"$VOL","scope":"user","ct":"${sealedCt(
                    VOL,
                    JsonPrimitive(0.3),
                )}","version":4}]}""",
            )
        val m = machine()
        val r = pull(sealedBody)
        m.receive(SyncResponse(200, r.body), r.opened)
        assertEquals(ReadResult(JsonPrimitive(0.3), "cloud"), m.get(VOL))
        // A Worker that claims the plaintext row is sealed: the claim is stripped, so the row is unreadable.
        val forged =
            j("""{"encryption":"e2e","cursor":4,"changes":[{"setting":"$VOL","scope":"user","value":0.99,"version":4,"sealed":true,"seq":0}]}""")
        val m2 = machine()
        val f = pull(forged)
        m2.receive(SyncResponse(200, f.body), f.opened)
        assertEquals("document", m2.get(VOL).from)
        assertEquals(listOf<OpenedRow?>(OpenedRow(seq = 4)), f.opened.changes)
    }
}
