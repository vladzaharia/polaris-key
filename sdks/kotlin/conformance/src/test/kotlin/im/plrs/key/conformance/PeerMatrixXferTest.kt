// @pkey-feature connect.transfer connect.local
//
// The `xfer` section of conformance/corpus/v2/peer-matrix.json (WIRE-CONTRACT-V5 section 15.11): the control-body
// codecs, the partial file's path and the shown name, and every machine row (window, offer, hash, ending, resume,
// limits), each replayed through `XferMachine`. Mirrors `xferRows` in conformance/runners/node/peerMatrixSuites.ts.
// Runs on JCA (`test`) and on Tink (`testTink`).

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.cleanDisplayName
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.RecordMode
import im.plrs.key.core.peer.XFER_ACK_EVERY
import im.plrs.key.core.peer.XFER_CONSENT_SECONDS
import im.plrs.key.core.peer.XFER_DEFAULT_CHUNK
import im.plrs.key.core.peer.XFER_ENDED_IDS
import im.plrs.key.core.peer.XFER_IDLE_SECONDS
import im.plrs.key.core.peer.XFER_MAX_CHUNK
import im.plrs.key.core.peer.XFER_MAX_CONTROL_BYTES
import im.plrs.key.core.peer.XFER_MAX_PARTIALS_PER_PEER
import im.plrs.key.core.peer.XFER_MAX_SIZE
import im.plrs.key.core.peer.XFER_MAX_TRANSFERS
import im.plrs.key.core.peer.XFER_PARTIAL_SECONDS
import im.plrs.key.core.peer.XFER_WINDOW
import im.plrs.key.core.peer.XferAnswer
import im.plrs.key.core.peer.XferEffect
import im.plrs.key.core.peer.XferHandler
import im.plrs.key.core.peer.XferMachine
import im.plrs.key.core.peer.XferMachineOptions
import im.plrs.key.core.peer.XferOfferArgs
import im.plrs.key.core.peer.XferOut
import im.plrs.key.core.peer.XferParams
import im.plrs.key.core.peer.XferPartial
import im.plrs.key.core.peer.XferResult
import im.plrs.key.core.peer.XferSend
import im.plrs.key.core.peer.XferType
import im.plrs.key.core.peer.capsIntersection
import im.plrs.key.core.peer.parseXferCancel
import im.plrs.key.core.peer.parseXferChunk
import im.plrs.key.core.peer.parseXferDone
import im.plrs.key.core.peer.parseXferOffer
import im.plrs.key.core.peer.parseXferOffset
import im.plrs.key.core.peer.xferChunkBody
import im.plrs.key.core.peer.xferDoneBody
import im.plrs.key.core.peer.xferOffsetBody
import im.plrs.key.core.peer.xferPartialPath
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import java.security.MessageDigest

class PeerMatrixXferTest : ConformanceSuite() {
    private val x: JsonObject = Corpus.v2("peer-matrix.json")["xfer"]!!.obj

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.l(name: String): Long = this[name].longValue!!

    private fun JsonObject.o(name: String): JsonObject = this[name]!!.obj

    /** A body row's bytes: hex, or text. */
    private fun rowBytes(r: JsonObject): ByteArray = r["bodyHex"]?.let { unhex(it.stringValue!!) } ?: r.s("body").toByteArray(Charsets.UTF_8)

    /** The content every `xfer` row transfers: byte i is (7 i + 13) mod 256 (`corrupt` flips each). */
    private fun content(from: Long, to: Long, flip: Boolean = false): ByteArray =
        ByteArray((to - from).toInt()) { k -> ((((from + k) * 7 + 13) and 0xff).toInt() xor (if (flip) 0xff else 0)).toByte() }

    private fun num(v: Long): JsonElement = JsonPrimitive(v)

    // -- the constants and the codecs ------------------------------------------------------------------------

    @Test
    fun constants() {
        val c = x.o("constants")
        val f = Failures("peer-matrix xfer constants")
        f.equal(c.l("maxControlBytes"), XFER_MAX_CONTROL_BYTES.toLong()) { "maxControlBytes" }
        f.equal(c.l("maxSize"), XFER_MAX_SIZE) { "maxSize" }
        f.equal(c.l("defaultChunk"), XFER_DEFAULT_CHUNK.toLong()) { "defaultChunk" }
        f.equal(c.l("maxChunk"), XFER_MAX_CHUNK.toLong()) { "maxChunk" }
        f.equal(c.l("window"), XFER_WINDOW.toLong()) { "window" }
        f.equal(c.l("ackEvery"), XFER_ACK_EVERY.toLong()) { "ackEvery" }
        f.equal(c.l("maxTransfers"), XFER_MAX_TRANSFERS.toLong()) { "maxTransfers" }
        f.equal(c.l("consentSeconds"), XFER_CONSENT_SECONDS.toLong()) { "consentSeconds" }
        f.equal(c.l("idleSeconds"), XFER_IDLE_SECONDS.toLong()) { "idleSeconds" }
        f.equal(c.l("partialSeconds"), XFER_PARTIAL_SECONDS.toLong()) { "partialSeconds" }
        f.equal(c.l("maxPartialsPerPeer"), XFER_MAX_PARTIALS_PER_PEER.toLong()) { "maxPartialsPerPeer" }
        f.equal(c.l("endedIds"), XFER_ENDED_IDS.toLong()) { "endedIds" }
        f.done(12)
    }

    @Test
    fun codecs() {
        val codecs = x.o("codecs")
        val f = Failures("peer-matrix xfer codecs")
        for (r in rows(codecs["offer"])) {
            val b = rowBytes(r)
            val id = r.s("id")
            f.equal(r.l("length"), b.size.toLong()) { "$id length" }
            val v = parseXferOffer(b, r.l("maxMessage"))
            val got: JsonObject = if (v == null) {
                buildJsonObject { put("ok", false) }
            } else {
                buildJsonObject {
                    put("ok", true)
                    put(
                        "offer",
                        buildJsonObject {
                            put("id", v.id)
                            v.name?.let { put("name", it) }
                            v.type?.let { put("type", it) }
                            put("size", v.size)
                            put("sha256", v.sha256)
                            v.cat?.let { put("cat", it) }
                            put("chunk", v.chunk)
                        },
                    )
                }
            }
            f.equal(r["want"], got) { "offer $id" }
        }
        for (r in rows(codecs["offsetBodies"])) {
            val v = parseXferOffset(r.s("kind") == "ACK", rowBytes(r), XferParams(r.l("size"), r.l("chunk").toInt()))
            val got = if (v == null) {
                buildJsonObject { put("ok", false) }
            } else {
                buildJsonObject {
                    put("ok", true)
                    put("id", v.first)
                    put("offset", v.second)
                }
            }
            f.equal(r["want"], got) { "offset ${r.s("id")}" }
        }
        for (r in rows(codecs["done"])) {
            val v = parseXferDone(rowBytes(r), r.s("toward") == "receiver")
            val got = if (v == null) {
                buildJsonObject { put("ok", false) }
            } else {
                buildJsonObject {
                    put("ok", true)
                    put("id", v.id)
                    v.sha256?.let { put("sha256", it) }
                }
            }
            f.equal(r["want"], got) { "done ${r.s("id")}" }
        }
        for (r in rows(codecs["cancel"])) {
            val v = parseXferCancel(rowBytes(r))
            val got = if (v == null) {
                buildJsonObject { put("ok", false) }
            } else {
                buildJsonObject {
                    put("ok", true)
                    put("id", v.first)
                    put("reason", v.second.name)
                }
            }
            f.equal(r["want"], got) { "cancel ${r.s("id")}" }
        }
        for (r in rows(codecs["chunk"])) {
            val head = unhex(r.s("head"))
            val body = ByteArray(head.size + r.l("dataLength").toInt()) { 0xab.toByte() }
            head.copyInto(body, 0)
            val v = parseXferChunk(body, r.l("size"), r.l("chunk").toInt(), r.l("expect"))
            val got = if (v == null) {
                buildJsonObject { put("ok", false) }
            } else {
                buildJsonObject {
                    put("ok", true)
                    put("id", v.id)
                    put("offset", v.offset)
                    put("length", v.length)
                }
            }
            f.equal(r["want"], got) { "chunk ${r.s("id")}" }
        }
        f.done(150)
    }

    @Test
    fun partialPathAndShownName() {
        val name = x.o("name")
        val f = Failures("peer-matrix xfer names")
        for (r in rows(name["paths"])) {
            f.equal(r.s("path"), xferPartialPath(unhex(r.s("key")), r.s("xferId"), r.s("sha256"))) { "path ${r.s("id")}" }
        }
        for (r in rows(name["rows"])) {
            val offer = parseXferOffer(r.s("body").toByteArray(Charsets.UTF_8), 1_048_576)
            f.check(offer != null) { "${r.s("id")} parses" }
            if (offer == null) continue
            f.equal(r["display"].stringValue, cleanDisplayName(offer.name)) { "display ${r.s("id")}" }
            f.equal(r["type"].stringValue, offer.type) { "type ${r.s("id")}" }
            f.equal(r.s("path"), xferPartialPath(unhex(name.s("key")), offer.id, offer.sha256)) { "path ${r.s("id")}" }
        }
        f.done(20)
    }

    // -- the machine rows ------------------------------------------------------------------------------------

    @Test
    fun windowRows() = section("window")

    @Test
    fun offerRows() = section("offer")

    @Test
    fun hashRows() = section("hash")

    @Test
    fun endingRows() = section("ending")

    @Test
    fun resumeRows() = section("resume")

    @Test
    fun limitsRows() = section("limits")

    /** The mode-`l` rows of `local.xfer` (section 15.11 "Where it runs", section 15.12): the same machine, the link's category rule. */
    @Test
    fun localModeRows() {
        val f = Failures("peer-matrix local xfer")
        val list = rows(Corpus.v2("peer-matrix.json")["local"]!!.obj["xfer"])
        for (row in list) run(row, f)
        f.done(list.size)
    }

    private fun section(name: String) {
        val f = Failures("peer-matrix xfer $name")
        val list = rows(x[name])
        for (row in list) run(row, f)
        f.done(list.size)
    }

    private fun send(s: XferSend): JsonObject = buildJsonObject {
        when (s) {
            is XferSend.Offer -> {
                put("t", "OFFER")
                put("id", s.id)
                put("size", s.size)
                put("chunk", s.chunk)
                put("sha256", s.sha256)
                s.cat?.let { put("cat", it) }
                s.name?.let { put("name", it) }
                s.type?.let { put("type", it) }
            }

            is XferSend.Accept -> {
                put("t", "ACCEPT")
                put("id", s.id)
                put("offset", s.offset)
            }

            is XferSend.Chunks -> {
                put("t", "CHUNKS")
                put("id", s.id)
                put("offset", s.offset)
                put("bytes", s.bytes)
            }

            is XferSend.Ack -> {
                put("t", "ACK")
                put("id", s.id)
                put("offset", s.offset)
            }

            is XferSend.Done -> {
                put("t", "DONE")
                put("id", s.id)
                s.sha256?.let { put("sha256", it) }
            }

            is XferSend.Cancel -> {
                put("t", "CANCEL")
                put("id", s.id)
                put("reason", s.reason.name)
            }
        }
    }

    private fun effect(e: XferEffect): JsonObject? = when (e) {
        is XferEffect.Create -> buildJsonObject { put("create", e.ref) }
        is XferEffect.Truncate -> buildJsonObject {
            put("truncate", e.ref)
            put("to", e.to)
        }
        is XferEffect.Discard -> buildJsonObject { put("discard", e.ref) }
        is XferEffect.Evict -> buildJsonObject { put("evict", e.ref) }
        is XferEffect.Keep -> buildJsonObject { put("keep", e.ref) }
        is XferEffect.Delete -> buildJsonObject { put("delete", e.ref) }
        is XferEffect.Finalize -> buildJsonObject { put("finalize", e.ref) }
        is XferEffect.Write -> null
    }

    private fun result(r: XferResult): JsonObject = buildJsonObject {
        put("id", r.id)
        when (r) {
            is XferResult.Delivered -> put("outcome", "delivered")
            is XferResult.Cancelled -> {
                put("outcome", "cancelled")
                put("reason", r.reason.name)
            }
            is XferResult.Closed -> put("outcome", "closed")
        }
    }

    /** Consecutive `CHUNKS` of one id that continue each other, summed. */
    private fun mergeSends(list: List<JsonObject>): List<JsonObject> {
        val out = ArrayList<JsonObject>()
        for (e in list) {
            val last = out.lastOrNull()
            if (e.s("t") == "CHUNKS" && last != null && last.s("t") == "CHUNKS" && last.s("id") == e.s("id") &&
                last.l("offset") + last.l("bytes") == e.l("offset")
            ) {
                out[out.size - 1] = buildJsonObject {
                    for ((k, v) in last) if (k != "bytes") put(k, v)
                    put("bytes", last.l("bytes") + e.l("bytes"))
                }
            } else {
                out += e
            }
        }
        return out
    }

    /** The machine's step output as the row's `want` writes it (writes into a partial are not in it). */
    private fun want(o: XferOut, f: Failures, at: String): JsonObject {
        val sends = mergeSends(o.send.map(::send))
        return buildJsonObject {
            if (sends.isNotEmpty()) put("send", JsonArray(sends))
            o.close?.let { put("close", it.name) }
            o.ask?.let { a ->
                put(
                    "ask",
                    buildJsonObject {
                        put("id", a.id)
                        a.name?.let { put("name", it) }
                        a.type?.let { put("type", it) }
                        put("size", a.size)
                        a.cat?.let { put("cat", it) }
                    },
                )
            }
            if (o.withdraw.isNotEmpty()) {
                f.check(o.withdraw.size == 1) { "$at: one withdraw" }
                put("withdraw", o.withdraw[0])
            }
            if (o.results.isNotEmpty()) {
                f.check(o.results.size == 1) { "$at: one result" }
                put("result", result(o.results[0]))
            }
            val partial = o.partial.mapNotNull(::effect)
            if (partial.isNotEmpty()) put("partial", JsonArray(partial))
            if (o.refused) put("refused", "busy")
            if (o.drop) put("drop", true)
        }
    }

    /** The row's own `want` with consecutive `CHUNKS` of one id summed. */
    private fun merged(w: JsonElement): JsonObject {
        val o = w.obj
        val s = o["send"]?.arrayValue ?: return o
        return buildJsonObject {
            for ((k, v) in o) if (k != "send") put(k, v)
            put("send", JsonArray(mergeSends(s.map { it.obj })))
        }
    }

    private fun run(row: JsonObject, f: Failures) {
        val id = row.s("id")
        val c = row.o("ctx")
        val partials = rows(c["partials"])
        val corrupt = partials.associate { it.s("ref") to (it["corrupt"].boolValue == true) }
        var next = 1
        val handler: XferHandler? = when (c.s("handler")) {
            "none" -> null
            "ask" -> XferHandler { XferAnswer.ask }
            "decline" -> XferHandler { XferAnswer.decline }
            else -> XferHandler { XferAnswer.accept }
        }
        val free = c["free"]?.takeIf { it !is JsonNull }.longValue
        val limit = c["hostLimit"]?.takeIf { it !is JsonNull }.longValue
        val mach = XferMachine(
            XferMachineOptions(
                mode = RecordMode.valueOf(c.s("mode")),
                caps = capsIntersection(c["capsLocal"]!!.arrayValue!!.map { it.stringValue!! }, c["capsRemote"]!!.arrayValue!!.map { it.stringValue!! }),
                maxMessage = c.l("maxMessage"),
                peerKey = unhex(c.s("peerKey")),
                handler = handler,
                hostLimit = limit,
                free = { free },
                categories = c["cats"]!!.arrayValue!!.map { it.stringValue!! },
                partials = partials.filter { it["otherPeer"].boolValue != true }.map { p ->
                    XferPartial(
                        ref = p.s("ref"),
                        id = p.s("id"),
                        sha256 = p.s("sha256"),
                        size = p.l("size"),
                        chunk = p.l("chunk").toInt(),
                        bytes = p.l("bytes"),
                        writtenAt = (p["writtenAt"] as JsonPrimitive).content.toDouble(),
                        held = p["held"].boolValue == true,
                        reread = p["reread"]?.longValue,
                    )
                },
                rehash = { ref, offset -> MessageDigest.getInstance("SHA-256").also { it.update(content(0, offset, corrupt[ref] == true)) } },
                newRef = { _, _ -> "n${next++}" },
                withholdAcks = c["withholdAcks"].boolValue == true,
            ),
        )
        val steps = rows(row["steps"])
        val wants = row["want"]!!.arrayValue!!
        f.check(steps.size == wants.size) { "$id: one want per step" }
        for ((i, st) in steps.withIndex()) {
            val at = (st["at"] as JsonPrimitive).content.toDouble()
            val out: XferOut = try {
                step(mach, st, at)
            } catch (e: RuntimeException) {
                f.check(false) { "$id step $i threw $e" }
                continue
            }
            if (i >= wants.size) continue
            f.equal(merged(wants[i]), want(out, f, "$id step $i")) { "$id step $i" }
        }
    }

    private fun step(m: XferMachine, st: JsonObject, at: Double): XferOut {
        st["host"]?.let { h ->
            return when (h.stringValue) {
                "tick" -> m.tick(at)
                "offer" -> m.offer(
                    at,
                    XferOfferArgs(
                        id = st.s("id"),
                        size = st.l("size"),
                        chunk = st.l("chunk").toInt(),
                        sha256 = st.s("sha256"),
                        cat = st["cat"]?.stringValue,
                        seekable = st["seekable"]?.boolValue ?: true,
                    ),
                )
                "consent" -> m.consent(at, st.s("id"), st.s("answer") == "accept")
                "cancel" -> m.cancel(at, st.s("id"))
                "close" -> m.close(at)
                "newSession" -> m.newSession(at)
                else -> error("host ${h.stringValue}")
            }
        }
        val more = st["more"].boolValue == true
        return when (val rx = st.s("rx")) {
            "PING" -> m.tick(at)
            "OFFER" -> m.receive(at, XferType.OFFER, st.s("body").toByteArray(Charsets.UTF_8), more)
            "ACCEPT" -> m.receive(at, XferType.ACCEPT, xferOffsetBody(st.s("id"), st.l("offset")), more)
            "ACK" -> m.receive(at, XferType.ACK, xferOffsetBody(st.s("id"), st.l("offset")), more)
            "CHUNK" -> {
                val off = st.l("offset")
                m.receive(
                    at,
                    XferType.CHUNK,
                    xferChunkBody(st.s("id"), off, content(off, off + st.l("length"), st["data"]?.stringValue == "corrupt")),
                    more,
                )
            }
            "DONE" -> m.receive(at, XferType.DONE, xferDoneBody(st.s("id"), st["sha256"]?.stringValue), more)
            "CANCEL" -> m.receive(at, XferType.CANCEL, """{"id":"${st.s("id")}","reason":${JsonPrimitive(st.s("reason"))}}""".toByteArray(Charsets.UTF_8), more)
            else -> error("rx $rx")
        }
    }
}
