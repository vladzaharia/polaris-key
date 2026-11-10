// @pkey-feature connect.local
//
// The `local` section of conformance/corpus/v2/peer-matrix.json (WIRE-CONTRACT-V5 section 15.12, account-free local
// pairing), read in place, as suites over :core's `peer/Local.kt` and the codecs it builds on; it mirrors
// conformance/runners/node/localSuites.ts. Every sub-section but `xfer` runs here (`xfer` is `PeerMatrixXferTest`'s,
// which replays the mode-`l` machine rows). The record rows check the mode rules of section 15.6 through
// `RecordAssembler`; the table's names and capability needs are the TypeScript table's metadata, which :core's does not
// carry.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.AssembleResult
import im.plrs.key.core.peer.CodeVerdict
import im.plrs.key.core.peer.DialBudget
import im.plrs.key.core.peer.DialOutcome
import im.plrs.key.core.peer.DrawSource
import im.plrs.key.core.peer.GATED_CALLS
import im.plrs.key.core.peer.HandshakeLimiter
import im.plrs.key.core.peer.JoinInput
import im.plrs.key.core.peer.JoinPlan
import im.plrs.key.core.peer.LOCAL_GROUP_PER_MINUTE
import im.plrs.key.core.peer.LOCAL_JOIN_BROWSE_SECONDS
import im.plrs.key.core.peer.LOCAL_JOIN_CANDIDATES
import im.plrs.key.core.peer.LOCAL_PAIR_FAILURES
import im.plrs.key.core.peer.LOCAL_PAIR_SECONDS
import im.plrs.key.core.peer.LOCAL_QR_SECRET_BYTES
import im.plrs.key.core.peer.LocalAdmission
import im.plrs.key.core.peer.LocalExchange
import im.plrs.key.core.peer.LocalExchangeEvent
import im.plrs.key.core.peer.LocalLinkKey
import im.plrs.key.core.peer.LocalPairingGate
import im.plrs.key.core.peer.LocalTxtResult
import im.plrs.key.core.peer.MAX_LINK_SECRETS
import im.plrs.key.core.peer.MAX_LIVE_LOCAL_ADVERTS
import im.plrs.key.core.peer.MAX_LOCAL_LINKS
import im.plrs.key.core.peer.PairingWindow
import im.plrs.key.core.peer.PayloadVerdict
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.PeerRecord
import im.plrs.key.core.peer.QrVerdict
import im.plrs.key.core.peer.RecordAssembler
import im.plrs.key.core.peer.RecordMode
import im.plrs.key.core.peer.TxtResult
import im.plrs.key.core.peer.base32Lower
import im.plrs.key.core.peer.browseLocalInstance
import im.plrs.key.core.peer.buildLocalLink
import im.plrs.key.core.peer.capsIntersection
import im.plrs.key.core.peer.displayCode
import im.plrs.key.core.peer.drawNameplate
import im.plrs.key.core.peer.drawPassword
import im.plrs.key.core.peer.listenerTrialOrder
import im.plrs.key.core.peer.localInstance
import im.plrs.key.core.peer.localLinkSecret
import im.plrs.key.core.peer.localPin
import im.plrs.key.core.peer.makeQr
import im.plrs.key.core.peer.negotiateLocalCaps
import im.plrs.key.core.peer.pairingInstance
import im.plrs.key.core.peer.pairingRemoteOk
import im.plrs.key.core.peer.parseCode
import im.plrs.key.core.peer.parseHandshakePayload
import im.plrs.key.core.peer.parseLocalLink
import im.plrs.key.core.peer.parseLocalTxt
import im.plrs.key.core.peer.parseQr
import im.plrs.key.core.peer.parseTxt
import im.plrs.key.core.peer.trialPadding
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class PeerMatrixLocalTest : ConformanceSuite() {
    private val l: JsonObject = Corpus.v2("peer-matrix.json")["local"]!!.obj

    private fun bytes(h: String): ByteArray = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.sOrNull(name: String): String? = this[name].stringValue

    private fun JsonObject.i(name: String): Int = this[name].longValue!!.toInt()

    private fun JsonObject.d(name: String): Double = (this[name] as JsonPrimitive).content.toDouble()

    private fun JsonObject.o(name: String): JsonObject = this[name]!!.obj

    private fun strings(e: JsonElement?): List<String> = e!!.arrayValue!!.map { it.stringValue!! }

    /** A JSON value as plain Kotlin: a map, a list, a string, a boolean, a long, a double or null. */
    private fun plain(e: JsonElement?): Any? = when (e) {
        null, JsonNull -> null

        is JsonObject -> e.entries.associate { it.key to plain(it.value) }

        is JsonArray -> e.map(::plain)

        is JsonPrimitive -> when {
            e.isString -> e.content
            e.content == "true" -> true
            e.content == "false" -> false
            else -> e.content.toLongOrNull() ?: e.content.toDouble()
        }
    }

    private fun consts(): JsonObject = l.o("constants")

    private fun const(name: String): Int = consts().i(name)

    @Test
    fun constantsMatchCore() {
        assertEquals(LOCAL_PAIR_SECONDS, const("pairSeconds"))
        assertEquals(l.o("codes").i("digits"), const("codeDigits"))
        assertEquals(LOCAL_PAIR_FAILURES, const("pairFailures"))
        assertEquals(LOCAL_QR_SECRET_BYTES, const("qrSecretBytes"))
        assertEquals(l.o("qr").i("secretBytes"), const("qrSecretBytes"))
        assertEquals(LOCAL_JOIN_CANDIDATES, const("joinCandidates"))
        assertEquals(LOCAL_JOIN_BROWSE_SECONDS, const("joinBrowseSeconds"))
        assertEquals(MAX_LOCAL_LINKS, const("maxLinks"))
        assertEquals(l.o("adverts").i("maxLinks"), const("maxLinks"))
        assertEquals(MAX_LIVE_LOCAL_ADVERTS, const("maxLiveAdverts"))
        assertEquals(l.o("adverts").i("maxLive"), const("maxLiveAdverts"))
        assertEquals(MAX_LINK_SECRETS, const("maxLinkSecrets"))
        assertEquals(const("maxContactSecrets") + const("maxLinks"), const("maxLinkSecrets"))
        assertEquals(LOCAL_GROUP_PER_MINUTE, const("admissionGroupPerMinute"))
    }

    // -- admission ------------------------------------------------------------------------------------

    /**
     * The limiter's answers to one admission row. A `later` event is admitted and held open (its trial is not judged yet);
     * `settle: i` judges event `i`'s trial: a hit refunds the group's live count and takes a waiting slot, a miss spends the
     * shared budget.
     */
    private fun admissionAnswers(r: JsonObject): List<Map<String, Any?>> {
        var now = 0.0
        val lim = HandshakeLimiter(const("admissionSharedPerMinute"), const("admissionWaiting"), const("admissionGroupPerMinute")) { now }
        val holds = HashMap<Int, () -> Unit>()
        val open = HashMap<Int, LocalAdmission.Admitted>()
        return rows(r["events"]).mapIndexed { i, e ->
            now = e.d("t")
            when {
                e["release"] != null -> {
                    holds.remove(e.i("release"))?.invoke()
                    mapOf("result" to "released")
                }

                e["settle"] != null -> settleAnswer(rows(r["events"]), e.i("settle"), open, holds)

                else -> when (val a = lim.beginLocal(e.s("group"))) {
                    is LocalAdmission.Refused -> mapOf("result" to "refused", "by" to a.by)
                    is LocalAdmission.Admitted -> admittedAnswer(i, e, a, open, holds)
                }
            }
        }
    }

    private fun admittedAnswer(
        i: Int,
        e: JsonObject,
        a: LocalAdmission.Admitted,
        open: MutableMap<Int, LocalAdmission.Admitted>,
        holds: MutableMap<Int, () -> Unit>,
    ): Map<String, Any?> {
        if (e["later"].boolValue == true) {
            open[i] = a
            return mapOf("result" to "tried")
        }
        val opens = e["opens"].boolValue == true
        if (opens) holds[i] = a.hit() else a.miss()
        return mapOf("result" to "tried", "hit" to opens)
    }

    private fun settleAnswer(
        events: List<JsonObject>,
        at: Int,
        open: MutableMap<Int, LocalAdmission.Admitted>,
        holds: MutableMap<Int, () -> Unit>,
    ): Map<String, Any?> {
        val a = checkNotNull(open.remove(at)) { "settle $at: no admission is held open" }
        val opens = events[at]["opens"].boolValue == true
        if (opens) holds[at] = a.hit() else a.miss()
        return mapOf("result" to "settled", "hit" to opens)
    }

    private fun admissionRow(f: Failures, r: JsonObject) {
        val kept = setOf("result", "hit", "by")
        // The state columns are the corpus's own bookkeeping; the limiter's answers are the rows'.
        val want = rows(r["want"]).map { w -> w.entries.filter { it.key in kept }.associate { it.key to plain(it.value) } }
        f.equal(want, admissionAnswers(r)) { r.s("id") }
    }

    @Test
    fun admissionTheGroupsBudgetThenTheSharedLimiterThatOnlyAFailedTrialSpends() {
        val f = Failures("peer-matrix local admission")
        for (r in rows(l["admission"])) admissionRow(f, r)
        f.done(11)
    }

    /**
     * The two rows of the Node/Python corpus that hold an admission open and settle it later (`later`, `settle`), kept here
     * until the corpus on this branch carries them: a refund reaches the group's live count after other messages came in, and a
     * late failure spends the shared budget when it is settled.
     */
    @Test
    fun anAdmissionHeldOpenIsSettledByALaterEvent() {
        val f = Failures("peer-matrix local admission (later, settle)")
        val fixture = """
            [{"id": "a-refund-after-other-messages", "events": [{"t": 0, "group": "g1", "opens": true, "later": true},
              {"t": 1, "group": "g2", "opens": false}, {"t": 2, "group": "g3", "opens": false}, {"t": 3, "settle": 0},
              {"t": 4, "group": "g1", "opens": false}, {"t": 5, "group": "g1", "opens": false}, {"t": 6, "group": "g1", "opens": false}],
              "want": [{"result": "tried"}, {"result": "tried", "hit": false}, {"result": "tried", "hit": false},
              {"result": "settled", "hit": true}, {"result": "tried", "hit": false}, {"result": "tried", "hit": false},
              {"result": "refused", "by": "group"}]},
             {"id": "a-late-failure-spends-the-shared-budget-when-settled", "events": [{"t": 0, "group": "g1", "opens": false, "later": true},
              {"t": 1, "group": "g2", "opens": false}, {"t": 2, "settle": 0}, {"t": 3, "group": "g1", "opens": false},
              {"t": 4, "group": "g1", "opens": false}],
              "want": [{"result": "tried"}, {"result": "tried", "hit": false}, {"result": "settled", "hit": false},
              {"result": "tried", "hit": false}, {"result": "refused", "by": "group"}]}]
        """.trimIndent()
        for (r in rows(kotlinx.serialization.json.Json.parseToJsonElement(fixture))) admissionRow(f, r)
        f.done(2)
    }

    // -- codes ----------------------------------------------------------------------------------------

    private class Stream(h: String) {
        private val all = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        var at = 0
            private set
        val source = DrawSource { n ->
            if (at + n > all.size) {
                null
            } else {
                all.copyOfRange(at, at + n).also { at += n }
            }
        }
    }

    @Test
    fun codes() {
        val f = Failures("peer-matrix local codes")
        val codes = l.o("codes")
        for (r in rows(codes["nameplate"])) {
            val s = Stream(r.s("stream"))
            f.equal(r.o("want").sOrNull("nameplate"), drawNameplate(s.source, strings(r["inUse"]))) { "${r.s("id")} nameplate" }
            f.equal(r.o("want").i("consumed"), s.at) { "${r.s("id")} consumed" }
        }
        for (r in rows(codes["password"])) {
            val s = Stream(r.s("stream"))
            f.equal(r.o("want").sOrNull("password"), drawPassword(s.source)) { "${r.s("id")} password" }
            f.equal(r.o("want").i("consumed"), s.at) { "${r.s("id")} consumed" }
        }
        for (r in rows(codes["display"])) f.equal(r.s("want"), displayCode(r.s("nameplate"), r.s("password"))) { "${r.s("id")} display" }
        for (r in rows(codes["parse"])) {
            val got = parseCode(r.s("text"))
            val want = r.o("want")
            f.equal(want["ok"].boolValue, got is CodeVerdict.Ok) { "${r.s("id")} ok" }
            if (got is CodeVerdict.Ok) {
                f.equal(want.s("nameplate"), got.nameplate) { "${r.s("id")} nameplate" }
                f.equal(want.s("password"), got.password) { "${r.s("id")} password" }
            }
        }
        f.done(20)
    }

    // -- qr -------------------------------------------------------------------------------------------

    @Test
    fun qr() {
        val f = Failures("peer-matrix local qr")
        val qr = l.o("qr")
        for (r in rows(qr["make"])) {
            f.equal(r.s("instance"), pairingInstance(bytes(r.s("sid")))) { "${r.s("id")} instance" }
            f.equal(r.s("want"), makeQr(r.s("slug"), r.s("instance"), bytes(r.s("secret")))) { "${r.s("id")} make" }
        }
        for (r in rows(qr["parse"])) {
            val want = r.o("want")
            val got = parseQr(r.s("text"), r.s("own"))
            val result = when (got) {
                is QrVerdict.Ok -> "ok"
                QrVerdict.OtherApp -> "other-app"
                QrVerdict.Invalid -> "invalid"
            }
            f.equal(want.s("result"), result) { "${r.s("id")} result" }
            if (got is QrVerdict.Ok) {
                f.equal(want.s("slug"), got.slug) { "${r.s("id")} slug" }
                f.equal(want.s("instance"), got.instance) { "${r.s("id")} instance" }
                f.equal(want.s("secret"), base32Lower(got.secret)) { "${r.s("id")} secret" }
            }
        }
        f.done(10)
    }

    // -- adverts and txt ------------------------------------------------------------------------------

    @Test
    fun adverts() {
        val f = Failures("peer-matrix local adverts")
        val a = l.o("adverts")
        assertEquals(900, a.i("epochSeconds"))
        for (r in rows(a["pairing"])) f.equal(r.s("instance"), pairingInstance(bytes(r.s("sid")))) { "${r.s("id")} pairing" }
        for (r in rows(a["names"])) {
            f.equal(r.s("instance"), localInstance(bytes(r.s("secret")), bytes(r.s("ownLinkKey")), r["epoch"].longValue!!)) { "${r.s("id")} name" }
        }
        for (r in rows(a["browse"])) {
            val links = rows(r["links"]).map { LocalLinkKey(bytes(it.s("secret")), bytes(it.s("peerKey"))) }
            val got = browseLocalInstance(r.s("instance"), links, r["now"].longValue!!)
            val want = r["want"]
            if (want == null || want is JsonNull) {
                f.check(got == null) { "${r.s("id")}: expected no hit, got $got" }
            } else {
                f.equal(want.obj.i("link") to want.obj.i("epochBack"), got?.let { it.link to it.epochBack }) { "${r.s("id")} browse" }
            }
        }
        f.done(10)
    }

    @Test
    fun txt() {
        val f = Failures("peer-matrix local txt")
        for (r in rows(l["txt"])) {
            val entries = strings(r["entries"])
            val got: Map<String, Any?> = if (r.s("parser") == "txt") {
                when (val v = parseTxt(entries)) {
                    is TxtResult.Ok -> buildMap {
                        put("ok", true)
                        put("mode", v.mode.wire)
                        v.h?.let { put("h", it) }
                        v.n?.let { put("n", it) }
                    }

                    is TxtResult.Refused -> mapOf("ok" to false, "reason" to v.reason.name)
                }
            } else {
                when (val v = parseLocalTxt(entries)) {
                    LocalTxtResult.Ok -> mapOf("ok" to true, "mode" to "l")
                    is LocalTxtResult.Refused -> mapOf("ok" to false, "reason" to v.reason)
                }
            }
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(40)
    }

    // -- body and secrets -----------------------------------------------------------------------------

    private fun bodyBytes(r: JsonObject): ByteArray = r["bodyHex"]?.let { bytes(it.stringValue!!) }
        ?: r["bodyPad"]?.obj?.let { p -> (p.s("prefix") + p.s("fill").repeat(p.i("count")) + p.s("suffix")).toByteArray(Charsets.UTF_8) }
        ?: r.s("body").toByteArray(Charsets.UTF_8)

    @Test
    fun theLocalLinkBody() {
        val f = Failures("peer-matrix local body")
        for (r in rows(l["body"])) {
            val id = r.s("id")
            val b = bodyBytes(r)
            f.equal(r.i("length"), b.size) { "$id length" }
            val got = parseLocalLink(b)
            val want = r.o("want")
            f.equal(want["ok"].boolValue, got != null) { "$id ok" }
            if (got != null) {
                f.equal(want.sOrNull("label"), got.label) { "$id label" }
                f.equal(strings(want["cats"]), got.cats) { "$id cats" }
                // What a side builds, the peer reads back.
                val again = parseLocalLink(buildLocalLink(got.label, got.cats))
                f.equal(got.label to got.cats, again?.let { it.label to it.cats }) { "$id round trip" }
            }
        }
        f.done(30)
    }

    @Test
    fun theLinkSecretHkdfOverHAndTheIskTheKeysByByteOrder() {
        val f = Failures("peer-matrix local secrets")
        for (r in rows(l["secrets"])) {
            f.equal(r.s("secret"), hex(localLinkSecret(bytes(r.s("h")), bytes(r.s("isk")), bytes(r.s("keyA")), bytes(r.s("keyB"))))) { r.s("id") }
        }
        f.done(10)
    }

    // -- handshake payloads ---------------------------------------------------------------------------

    @Test
    fun handshakePayloadsAndNegotiation() {
        val f = Failures("peer-matrix local handshake payloads")
        val hp = l.o("handshakePayloads")
        for (r in rows(hp["payloads"])) {
            val id = r.s("id")
            val b = r["payloadHex"]?.let { bytes(it.stringValue!!) } ?: r.s("payload").toByteArray(Charsets.UTF_8)
            f.equal(r.i("length"), b.size) { "$id length" }
            val got = parseHandshakePayload(PeerMode.valueOf(r.s("mode")), r.i("message"), b)
            val want = r.o("want")
            f.equal(want["ok"].boolValue, got is PayloadVerdict.Accepted) { "$id ok" }
            if (got is PayloadVerdict.Accepted && want["caps"] != null) f.equal(strings(want["caps"]), got.caps) { "$id caps" }
        }
        for (r in rows(hp["negotiate"])) {
            val got = negotiateLocalCaps(PeerMode.valueOf(r.s("mode")), strings(r["local"]), strings(r["remote"]))
            val want = r.o("want")
            f.equal(strings(want["caps"]), got.caps) { "${r.s("id")} caps" }
            f.equal(want.sOrNull("close"), got.close?.name) { "${r.s("id")} close" }
            f.equal(capsIntersection(strings(r["local"]), strings(r["remote"])), got.caps) { "${r.s("id")} intersection" }
        }
        f.done(20)
    }

    // -- window, joinBudget, join, exchange -----------------------------------------------------------

    /** What one window event produced: the outcome, or the word of a permit that was denied or given. */
    private class WindowStep(val out: im.plrs.key.core.peer.WindowOutcome, val denied: String?)

    @Suppress("CyclomaticComplexMethod")
    private fun applyWindowEvent(w: PairingWindow, s: JsonObject, t: Double, id: Int, row: String): WindowStep {
        var out = im.plrs.key.core.peer.WindowOutcome()
        var denied: String? = null
        when (val e = s.s("event")) {
            "open" -> out = w.open(t)

            "c1" -> out = w.c1(t, s["valid"].boolValue == true)

            "begin-guess" -> denied = if (w.beginGuess(id, t)) "permit" else "denied"

            "msg1" -> {
                val m = w.msg1(id, t, s["opens"].boolValue == true)
                if (m == null) denied = "denied" else out = m
            }

            "guess-opened" -> out = w.guessOpened(id, t)

            "guess-failed" -> out = w.guessFailed(id, t)

            "abandon" -> out = w.abandon(id, t)

            "rotated" -> w.rotated(t)

            "session-end" -> out = w.sessionEnd(t, s["stored"].boolValue == true)

            "tick" -> w.tick(t)

            "close" -> out = w.close(t)

            else -> error("$row: event $e")
        }
        return WindowStep(out, denied)
    }

    private fun windowView(w: PairingWindow, step: WindowStep): Map<String, Any?> {
        val st = w.state
        return buildMap {
            (step.denied ?: step.out.result?.wire)?.let { put("result", it) }
            step.out.id?.let { put("id", it.toLong()) }
            put("open", st.open)
            put("holder", st.holder?.wire)
            put("failures", st.failures.toLong())
            put("rotations", st.rotations.toLong())
            put("closed", st.closed?.wire)
            step.out.host?.let { put("host", it) }
        }
    }

    @Test
    fun window() {
        val f = Failures("peer-matrix local window")
        for (r in rows(l["window"])) {
            val w = PairingWindow()
            // An event without an `id` names the latest attempt handed out.
            var last = 0
            val got = rows(r["steps"]).map { s ->
                val t = if (s["t"] != null) s.d("t") else 0.0
                val id = if (s["id"] != null) s.i("id") else last
                val step = applyWindowEvent(w, s, t, id, r.s("id"))
                step.out.id?.let { if (s.s("event") == "c1") last = it }
                windowView(w, step)
            }
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(60)
    }

    @Test
    fun joinBudget() {
        val f = Failures("peer-matrix local joinBudget")
        for (r in rows(l["joinBudget"])) {
            val budget = DialBudget()
            val got = rows(r["joins"]).map { j ->
                val input = j.o("input")
                if (input.s("kind") == "qr") {
                    mapOf<String, Any?>("allowed" to true, "used" to 0L)
                } else {
                    val v = budget.check(input.s("nameplate"), j.d("t"))
                    if (v.allowed) budget.spend(input.s("nameplate"), j.d("t"), j.i("dials"))
                    mapOf("allowed" to v.allowed, "used" to v.used.toLong())
                }
            }
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(9)
    }

    @Test
    fun join() {
        val f = Failures("peer-matrix local join")
        for (r in rows(l["join"])) {
            val i = r.o("input")
            val plan = JoinPlan(
                when (i.s("kind")) {
                    "code" -> JoinInput.Code(i.s("nameplate"))
                    "qr" -> JoinInput.Qr(i.s("instance"))
                    else -> JoinInput.Invalid
                },
            )
            for (a in rows(r["adverts"])) plan.see(a.s("instance"), a.s("h") == "current" || a.s("h") == "previous", a.s("n"))
            val dialled = ArrayList<String>()
            for (o in strings(r["dials"])) {
                val next = plan.next() ?: break
                dialled += next
                plan.ended(
                    when (o) {
                        "transport" -> DialOutcome.Transport
                        "before-c2" -> DialOutcome.BeforeC2
                        else -> DialOutcome.AfterC2
                    },
                )
            }
            val got = mapOf<String, Any?>(
                "browsed" to plan.browses,
                "kept" to plan.kept,
                "dialled" to dialled.toList(),
                "result" to plan.result().wire,
            )
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(20)
    }

    @Test
    fun exchange() {
        val f = Failures("peer-matrix local exchange")
        for (r in rows(l["exchange"])) {
            val x = LocalExchange(r.i("held"), strings(r["cats"]))
            val got = rows(r["steps"]).map { s ->
                val step = x.step(
                    when (val e = s.s("event")) {
                        "own-confirm" -> LocalExchangeEvent.OwnConfirm
                        "own-decline" -> LocalExchangeEvent.OwnDecline
                        "peer-confirm" -> LocalExchangeEvent.PeerConfirm
                        "peer-link" -> LocalExchangeEvent.PeerLink(s.s("body").toByteArray(Charsets.UTF_8))
                        "timeout-confirm" -> LocalExchangeEvent.TimeoutConfirm
                        "timeout-exchange" -> LocalExchangeEvent.TimeoutExchange
                        else -> error("${r.s("id")}: event $e")
                    },
                )
                buildMap<String, Any?> {
                    put("sends", step.sends)
                    step.close?.let { put("close", it.name) }
                    step.stored?.let { st ->
                        put(
                            "stored",
                            buildMap<String, Any?> {
                                st.label?.let { put("label", it) }
                                put("cats", st.cats)
                            },
                        )
                    }
                }
            }
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(30)
    }

    // -- pin, trial order, records, gate --------------------------------------------------------------

    @Test
    fun pin() {
        val f = Failures("peer-matrix local pin")
        for (r in rows(l["pin"])) {
            val id = r.s("id")
            val got: Map<String, Any?> = if (r.s("mode") == "l") {
                val ok = localPin(bytes(strings(r["held"])[r.i("matched")]), bytes(r.s("remoteStatic")))
                if (ok) mapOf("ok" to true) else mapOf("ok" to false, "close" to "peer_revoked", "sends" to 0L)
            } else {
                val ok = pairingRemoteOk(bytes(r.s("own")), bytes(r.s("remoteStatic")))
                if (ok) mapOf("ok" to true) else mapOf("ok" to false, "close" to "silent", "sends" to 0L)
            }
            f.equal(plain(r["want"]), got) { id }
            // The initiator asks after message 2, the responder after message 3.
            f.equal(if (r.s("role") == "initiator") 2 else 3, r.i("checkedAfter")) { "$id checkedAfter" }
        }
        f.done(10)
    }

    private fun opensTrial(opens: JsonObject?, e: im.plrs.key.core.peer.TrialEntry): Boolean {
        if (opens == null || opens.s("mode") != e.kind.toString()) return false
        val want = when (opens.s("mode")) {
            "a" -> opens.i("key")
            "c" -> opens.i("contact")
            else -> opens.i("link")
        }
        return want == e.index
    }

    @Test
    fun trialOrder() {
        val f = Failures("peer-matrix local trialOrder")
        for (r in rows(l["trialOrder"])) {
            val account = r["account"]?.takeIf { it !is JsonNull }?.arrayValue?.map { it.takeIf { k -> k !is JsonNull }?.let { k -> k.stringValue } }
            val contacts = r["contacts"]!!.arrayValue!!.size
            val locals = r["locals"]!!.arrayValue!!.size
            val plan = listenerTrialOrder(account, contacts, locals)
            val opens = r["opens"]?.takeIf { it !is JsonNull }?.obj
            // The contact limiter admits the secret trials once; a refusal tries no secret.
            val refusedAt = if (r.s("limiter") == "refuse") plan.indexOfFirst { it.kind != 'a' } else -1
            val reachable = if (refusedAt >= 0) plan.subList(0, refusedAt) else plan
            val hitAt = reachable.indexOfFirst { opensTrial(opens, it) }
            val tried = (if (hitAt >= 0) reachable.subList(0, hitAt + 1) else reachable).map { "${it.kind}:${it.index}" }
            val hit = if (hitAt >= 0) tried.last() else null
            val close = when {
                hit != null -> null
                refusedAt >= 0 -> "peer_busy"
                else -> "handshake_failed"
            }
            val behind = contacts + locals > 0
            val got = mapOf<String, Any?>(
                "tried" to tried,
                "hit" to hit,
                "slot" to (hit != null && hit[0] != 'a'),
                "close" to close,
                "dummy" to (if (close == "handshake_failed" && behind) trialPadding(tried.size) else 0).toLong(),
            )
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(20)
    }

    @Test
    fun records() {
        val f = Failures("peer-matrix local records")
        for (r in rows(l["records"])) {
            val id = r.s("id")
            val type = r.s("type").toInt(16)
            val body = ByteArray(if (type == 0x0004 || type == 0x0005) 8 else 0)
            val got = RecordAssembler(RecordMode.valueOf(r.s("mode"))).push(PeerRecord(type, 0, body))
            val want = r.o("want")
            when {
                want["ignored"].boolValue == true -> f.check(got === AssembleResult.Ignored) { "$id: expected ignored, got $got" }
                want["allowed"].boolValue == true -> f.check(got is AssembleResult.Message) { "$id: expected a message, got $got" }
                else -> f.equal(want.s("close"), (got as? AssembleResult.Close)?.code?.name) { "$id close" }
            }
        }
        f.done(70)
    }

    @Test
    fun gate() {
        val f = Failures("peer-matrix local gate")
        val gated = GATED_CALLS.toSet()
        for (r in rows(l["gate"])) {
            val g = LocalPairingGate(im.plrs.key.core.peer.GateState.entries.first { it.wire == r.s("start") })
            val got = rows(r["steps"]).map { s ->
                if (s["call"] != null) {
                    mapOf<String, Any?>("cached" to g.state.wire, "call" to if (s.s("call") in gated) g.check() else "ok")
                } else {
                    val effects = when (s.s("read")) {
                        "ok" -> g.readOk(s["body"])
                        "not-found" -> g.readNotFound()
                        else -> g.readError()
                    }
                    buildMap<String, Any?> {
                        put("cached", g.state.wire)
                        if (effects.isNotEmpty()) put("effects", effects.map { it.wire })
                    }
                }
            }
            f.equal(plain(r["want"]), got) { r.s("id") }
        }
        f.done(30)
    }
}
