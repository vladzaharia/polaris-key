// @pkey-feature ui.boot
//
// conformance/corpus/v2/stage-matrix.json through the one-call boot's loop (:sdk's BootDriver,
// SP-20), not just the pure transition: every row is played against a scripted host. A row's stage
// result (shell.done, guard.done, sync.done, gate.status, decide.done, fetch.done, mount.done) is
// what the host's work for that stage returns when the driver is running it; a `fail` while a stage
// works is that work throwing the code; every other event (start, retry, play-offline, sync.timeout,
// fetch.consent, fetch.progress, background.*, and a stage result the driver is not waiting on) is
// sent from outside, as a screen or a timer would. The emits the driver produced must be the row's,
// in order, and it must end on the row's stage and outcome, confirming the launch at most once.

package im.plrs.key.conformance

import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.stringValue
import im.plrs.key.sdk.BootDriver
import im.plrs.key.sdk.PolarisBootHost
import im.plrs.key.sdk.PolarisFetchReporter
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BootDriverMatrixTest : ConformanceSuite() {
    private val matrix = Corpus.v2("stage-matrix.json")

    /** The stage whose work a row event is the result of; null for an outside event. */
    private fun stageOf(type: String): BootStage? = when (type) {
        "shell.done" -> BootStage.shell
        "guard.done" -> BootStage.guard
        "sync.done" -> BootStage.sync
        "gate.status" -> BootStage.gate
        "decide.done" -> BootStage.decide
        "fetch.done" -> BootStage.fetch
        "mount.done" -> BootStage.mount
        else -> null
    }

    /** A host whose every stage waits for the test to hand it its result (or its failure). */
    private class ScriptedHost : PolarisBootHost {
        var pending: Pair<BootStage, CompletableDeferred<BootEvent>>? = null
        val confirmed = ArrayList<BootOutcome>()

        private suspend fun await(stage: BootStage): BootEvent {
            val d = CompletableDeferred<BootEvent>()
            pending = stage to d
            try {
                return d.await()
            } finally {
                if (pending?.second === d) pending = null
            }
        }

        override suspend fun shell() {
            await(BootStage.shell)
        }
        override suspend fun guard() = (await(BootStage.guard) as BootEvent.GuardDone).result
        override suspend fun sync() = (await(BootStage.sync) as BootEvent.SyncDone).result
        override suspend fun gate(): LicenseStatus = (await(BootStage.gate) as BootEvent.GateStatus).status
        override suspend fun decide() = (await(BootStage.decide) as BootEvent.DecideDone).decision
        override suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> {
            val done = await(BootStage.fetch) as BootEvent.FetchDone
            return done.result to done.installed
        }
        override suspend fun mount() {
            await(BootStage.mount)
        }
        override suspend fun confirm(outcome: BootOutcome) {
            confirmed += outcome
        }
    }

    private fun TestScope.play(row: JsonObject, f: Failures) {
        val name = row["name"].stringValue!!
        val emits = ArrayList<BootEmit>()
        val driver = BootDriver(stageOptions(row["init"]!!.obj)) { t -> emits += t.emits }
        val host = ScriptedHost()
        val steps = row["steps"]!!.arrayValue!!.map { it.obj }
        f.equal("start", steps.first()["event"]!!.obj["type"].stringValue) { "$name starts with start" }
        driver.launch(backgroundScope, host)
        runCurrent()
        for (step in steps.drop(1)) {
            val e = step["event"]!!.obj
            val type = e["type"].stringValue!!
            val event = stageEvent(e)
            val pending = host.pending
            when {
                pending != null && stageOf(type) == pending.first -> pending.second.complete(event)
                pending != null && event is BootEvent.Fail -> pending.second.completeExceptionally(PolarisException(event.code, "scripted"))
                else -> driver.send(event)
            }
            runCurrent()
        }
        val want = JsonArray(steps.flatMap { it["emits"]!!.arrayValue!! })
        val got = JsonArray(emits.map(::stageEmitJson))
        f.check(jsonEquals(want, got)) { "$name: the driver emitted $got, expected $want" }
        val expect = row["expect"]!!.obj
        val state = driver.state.value
        f.equal(expect["stages"]!!.arrayValue!!.last().stringValue, state.stage.wire) { "$name final stage" }
        f.equal(expect["outcome"].stringValue, state.outcome.wire) { "$name outcome" }
        f.check(host.confirmed.size <= 1) { "$name: confirmed ${host.confirmed}" }
        val firstSettle = emits.firstOrNull { it is BootEmit.Waiting || it is BootEmit.Blocked || it is BootEmit.Offline || it is BootEmit.Error || it == BootEmit.BootReady }
        f.equal(firstSettle != null, host.confirmed.isNotEmpty()) { "$name: confirms once the boot settles" }
    }

    @Test
    fun everyRowThroughTheDriver() {
        val f = Failures("stage-matrix rows through BootDriver")
        val rows = matrix["rows"]!!.arrayValue!!.map { it.obj }
        for (row in rows) runTest { play(row, f) }
        f.done(rows.size * 4)
    }
}
