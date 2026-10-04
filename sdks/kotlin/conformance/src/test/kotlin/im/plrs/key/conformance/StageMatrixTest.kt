// @pkey-feature ui.stages update.bootguard packs.state
//
// The Kotlin runner for conformance/corpus/v2/stage-matrix.json (version 3), mirroring the Node
// runner (conformance/runners/node/stageMatrix.test.ts): every row's emits (as values), the stage
// sequence built from the actual `stage_changed` emits, the final stage and outcome; at the initial
// state and after every step, every probe is sent and must come back unchanged with no emits
// exactly when its type is not in `accepts` for that state. Then the guard and confirm cases.

package im.plrs.key.conformance

import im.plrs.key.core.BOOT_EMIT_TYPES
import im.plrs.key.core.BOOT_EVENT_TYPES
import im.plrs.key.core.BOOT_OK_SECONDS
import im.plrs.key.core.BootConfirmation
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootGuardAction
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.BootState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.MAX_FAILED_BOOTS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.bootConfirmation
import im.plrs.key.core.bootGuardAction
import im.plrs.key.core.bootTransition
import im.plrs.key.core.initialBootState
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class StageMatrixTest : ConformanceSuite() {
    private val matrix = Corpus.v2("stage-matrix.json")

    private fun strings(e: JsonElement?) = e!!.arrayValue!!.map { it.stringValue!! }

    private fun options(o: JsonObject) = BootOptions(
        allowOffline = o["allowOffline"].boolValue ?: true,
        allowGrace = o["allowGrace"].boolValue ?: true,
        requiredPacks = o["requiredPacks"]?.let(::strings) ?: emptyList(),
        essentialPacks = o["essentialPacks"]?.let(::strings) ?: emptyList(),
    )

    private fun event(e: JsonObject): BootEvent = when (val type = e["type"].stringValue) {
        "start" -> BootEvent.Start
        "shell.done" -> BootEvent.ShellDone
        "guard.done" -> BootEvent.GuardDone(BootEvent.GuardResult.entries.first { it.wire == e["result"].stringValue })
        "sync.done" -> BootEvent.SyncDone(BootEvent.SyncResult.entries.first { it.wire == e["result"].stringValue })
        "sync.timeout" -> BootEvent.SyncTimeout
        "gate.status" -> BootEvent.GateStatus(LicenseStatus.of(e["status"].stringValue)!!)
        "decide.done" -> BootEvent.DecideDone(BootEvent.Decision.entries.first { it.wire == e["decision"].stringValue })
        "fetch.done" -> BootEvent.FetchDone(
            BootEvent.FetchResult.entries.first { it.wire == e["result"].stringValue }, strings(e["installed"]),
        )
        "mount.done" -> BootEvent.MountDone
        "background.start" -> BootEvent.BackgroundStart
        "background.done" -> BootEvent.BackgroundDone
        "retry" -> BootEvent.Retry
        "play-offline" -> BootEvent.PlayOffline
        "fail" -> BootEvent.Fail(e["code"].stringValue!!)
        "fetch.consent" -> BootEvent.FetchConsent(e["bytes"].longValue!!, e["metered"].boolValue!!)
        "fetch.progress" -> BootEvent.FetchProgress(e["done"].longValue!!, e["total"].longValue!!)
        else -> error("the Kotlin runner has no mapping for event $type")
    }

    /** An emit in the corpus's JSON vocabulary. */
    private fun json(emit: BootEmit): JsonObject {
        val m = linkedMapOf<String, JsonElement>("type" to JsonPrimitive(emit.type))
        when (emit) {
            is BootEmit.StageChanged -> {
                m["stage"] = JsonPrimitive(emit.stage.wire)
                m["previous"] = JsonPrimitive(emit.previous.wire)
            }
            is BootEmit.Waiting -> m["status"] = JsonPrimitive(emit.status.wire)
            is BootEmit.Blocked -> m["reason"] = JsonPrimitive(emit.reason.wire)
            is BootEmit.Offline -> m["canPlayOffline"] = JsonPrimitive(emit.canPlayOffline)
            is BootEmit.Error -> m["code"] = JsonPrimitive(emit.code)
            is BootEmit.ConsentNeeded -> {
                m["bytes"] = jsonInt(emit.bytes)
                m["metered"] = JsonPrimitive(emit.metered)
            }
            is BootEmit.FetchProgress -> {
                m["done"] = jsonInt(emit.done)
                m["total"] = jsonInt(emit.total)
            }
            else -> Unit
        }
        return JsonObject(m)
    }

    private fun acceptsKey(s: BootState): String = when {
        s.stage == BootStage.gate && s.outcome == BootOutcome.waiting -> "gate:waiting"
        s.stage == BootStage.fetch && s.outcome == BootOutcome.waiting -> "fetch:waiting"
        s.stage == BootStage.offline && s.canPlayOffline -> "offline:playable"
        else -> s.stage.wire
    }

    private var probes = 0

    private fun probe(state: BootState, where: String, f: Failures) {
        val accepted = matrix["accepts"]!!.obj[acceptsKey(state)]?.let(::strings)
        f.check(accepted != null) { "$where: accepts has no ${acceptsKey(state)}" }
        for (p in matrix["probes"]!!.arrayValue!!) {
            val e = p.obj
            val result = bootTransition(state, event(e))
            val ignored = result.emits.isEmpty() && result.state == state
            val type = e["type"].stringValue!!
            f.equal(!(accepted ?: emptyList()).contains(type), ignored) { "$where: probe $type in ${acceptsKey(state)}" }
            probes++
        }
    }

    @Test
    fun versionAndConstants() {
        assertEquals(3L, matrix["stageMatrixVersion"].longValue)
        assertEquals(MAX_FAILED_BOOTS.toLong(), matrix["maxFailedBoots"].longValue)
        assertEquals(BOOT_OK_SECONDS.toLong(), matrix["bootOkSeconds"].longValue)
    }

    @Test
    fun vocabularyInOrder() {
        val v = matrix["vocabulary"]!!.obj
        assertEquals(strings(v["stages"]), BootStage.entries.map { it.wire })
        assertEquals(strings(v["outcomes"]), BootOutcome.entries.map { it.wire })
        assertEquals(strings(v["events"]), BOOT_EVENT_TYPES)
        assertEquals(strings(v["emits"]), BOOT_EMIT_TYPES)
        assertEquals(strings(v["guardActions"]), BootGuardAction.entries.map { it.wire })
        assertEquals(strings(v["confirmations"]), BootConfirmation.entries.map { it.wire })
        assertEquals(strings(v["events"]), matrix["probes"]!!.arrayValue!!.map { it.obj["type"].stringValue })
    }

    @Test
    fun everyRowAndEveryProbe() {
        val f = Failures("stage-matrix rows")
        val rows = matrix["rows"]!!.arrayValue!!.map { it.obj }
        var states = 0
        for (row in rows) {
            val name = row["name"].stringValue!!
            var state = initialBootState(options(row["init"]!!.obj))
            val stages = ArrayList<String>()
            probe(state, "$name, initial state", f)
            states++
            for ((i, stepEl) in row["steps"]!!.arrayValue!!.withIndex()) {
                val step = stepEl.obj
                val e = step["event"]!!.obj
                val where = "$name, step ${i + 1} (${e["type"].stringValue})"
                val result = bootTransition(state, event(e))
                val got = JsonArray(result.emits.map(::json))
                f.check(jsonEquals(step["emits"], got)) { "$where: emits $got, expected ${step["emits"]}" }
                for (emit in result.emits) if (emit is BootEmit.StageChanged) stages += emit.stage.wire
                state = result.state
                val off = result.emits.filterIsInstance<BootEmit.Offline>().firstOrNull()
                if (off != null) f.equal(off.canPlayOffline, state.canPlayOffline) { "$where canPlayOffline" }
                else if (result.emits.isNotEmpty()) f.equal(false, state.canPlayOffline) { "$where canPlayOffline" }
                probe(state, "$where, after", f)
                states++
            }
            val expect = row["expect"]!!.obj
            f.equal(strings(expect["stages"]), stages) { "$name stages" }
            f.equal(strings(expect["stages"]).last(), state.stage.wire) { "$name final stage" }
            f.equal(expect["outcome"].stringValue, state.outcome.wire) { "$name outcome" }
        }
        f.equal(states * matrix["probes"]!!.arrayValue!!.size, probes) { "every probe at every state" }
        f.done(69)
    }

    @Test
    fun guardCases() {
        val f = Failures("guardCases")
        for (c in matrix["guardCases"]!!.arrayValue!!.map { it.obj }) {
            val input = c["input"]!!.obj
            val got = bootGuardAction(input["staged"].boolValue!!, input["failedBoots"].longValue!!)
            f.equal(c["expect"].objectValue!!["action"].stringValue, got.wire) { "guard: ${c["name"].stringValue}" }
        }
        f.done(7)
    }

    @Test
    fun confirmCases() {
        val f = Failures("confirmCases")
        val cases = matrix["confirmCases"]!!.arrayValue!!.map { it.obj }
        f.equal(BootOutcome.entries.map { it.wire }.sorted(), cases.map { it["outcome"].stringValue!! }.sorted()) { "one case per outcome" }
        for (c in cases) {
            val outcome = BootOutcome.entries.first { it.wire == c["outcome"].stringValue }
            f.equal(c["expect"].stringValue, bootConfirmation(outcome).wire) { "confirm: ${outcome.wire}" }
        }
        f.done(6)
    }
}
