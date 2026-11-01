// Replays one `sync-scenarios.json` scenario against the Kotlin CloudSyncMachine, as Python's
// `test_scenario` does: build the machine from `init`, run the steps, and compare every `assert`.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.CallResult
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.CloudSyncOptions
import im.plrs.key.core.sync.OpenedBody
import im.plrs.key.core.sync.OpenedRow
import im.plrs.key.core.sync.PutAtResult
import im.plrs.key.core.sync.RecordFile
import im.plrs.key.core.sync.SyncJson
import im.plrs.key.core.sync.SyncResponse
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Assert.fail

class SyncScenarioDriver(private val product: String, private val sc: JsonObject) {
    private val name = sc["name"].stringValue!!
    private val init = sc["init"] as JsonObject
    private val licence: JsonElement? = init["licence"]
    private lateinit var opts: CloudSyncOptions
    private lateinit var machine: CloudSyncMachine
    private val outcomes = mutableListOf<JsonElement>()

    private fun obj(v: JsonElement?): JsonObject = v as JsonObject

    private fun options(): CloudSyncOptions {
        val ids = ArrayDeque(init["clientIds"].arrayValue!!.map { it.stringValue!! })
        val clock = obj(init["clock"])
        return CloudSyncOptions(product, obj(init["catalog"]), obj(init["document"]), clock["now"].longValue!!) {
            check(ids.isNotEmpty()) { "init.clientIds exhausted" }
            ids.removeFirst()
        }.also {
            it.offsetMs = clock["offsetMs"].longValue!!
            it.contacted = clock["contacted"].boolValue!!
            it.subject = init["subject"].stringValue
            it.network = init["network"].stringValue!!
            it.onSignOut = obj(init["options"])["onSignOut"].stringValue!!
            it.encryption = init["encryption"].stringValue
            it.hasRoot = init["hasRoot"].boolValue!!
        }
    }

    fun run() {
        opts = options()
        machine = CloudSyncMachine(opts)
        machine.onOutcome { outcomes.add(it.toJson()) }
        (init["legacyLocal"] as? JsonObject)?.let { check(machine.importLocal(it) == CallResult.Ok) { "$name: import" } }
        sc["steps"].arrayValue!!.forEachIndexed { i, step ->
            val (kind, raw) = (step as JsonObject).entries.single()
            val where = "$name, step ${i + 1} ($kind)"
            step(kind, obj(raw), where)
        }
    }

    private fun step(kind: String, raw: JsonObject, where: String) {
        when (kind) {
            "local" -> local(raw, where)

            "respond" -> respond(raw)

            "advance" -> machine.advance(raw["ms"].longValue!!)

            "network" -> machine.setNetwork(raw["state"].stringValue!!)

            "root" -> machine.setRoot(raw["has"].boolValue == true)

            "signIn" -> machine.signIn(raw["subject"].stringValue!!)

            "signOut" -> machine.signOut(raw["discardUnsynced"].boolValue == true)

            "relaunch" -> {
                machine = CloudSyncMachine.relaunch(machine, opts, raw["journal"].stringValue == "lost")
                machine.onOutcome { outcomes.add(it.toJson()) }
            }

            "assert" -> assertions(raw, where)

            else -> fail("$where: the machine slice that ports `$kind` has not landed")
        }
    }

    private fun respond(raw: JsonObject) {
        val res = if (raw["error"] != null) SyncResponse.TRANSPORT else SyncResponse(raw["status"].longValue!!.toInt(), raw["body"])
        machine.receive(res, (raw["opened"] as? JsonObject)?.let { opened(it) })
    }

    private fun row(v: JsonElement?): OpenedRow? =
        (v as? JsonObject)?.let { OpenedRow(it["sealed"].boolValue == true, it["invalid"].boolValue == true, it["seq"].longValue) }

    private fun opened(o: JsonObject): OpenedBody = OpenedBody(
        o["changes"].arrayValue.orEmpty().map { row(it) },
        (o["conflicts"] as? JsonObject).orEmpty().entries.associate { it.key.toLong() to row(it.value) },
    )

    private fun putAt(args: JsonArray): PutAtResult =
        machine.putAt(args[0].stringValue!!, args[1].stringValue!!, args[2], args[3], RecordFile.of(args.getOrNull(4)))

    private fun local(raw: JsonObject, where: String) {
        val args = raw["args"].arrayValue ?: JsonArray(emptyList())
        val result: JsonElement = when (val call = raw["call"].stringValue) {
            "set" -> machine.set(args[0].stringValue!!, args[1]).toJson()
            "clear" -> machine.clear(args[0].stringValue!!).toJson()
            "put" -> machine.put(args[0].stringValue!!, args[1].stringValue!!, args[2]).toJson()
            "add" -> machine.add(args[0].stringValue!!, args[1].stringValue!!, args[2]).toJson()
            "remove" -> machine.remove(args[0].stringValue!!, args[1].stringValue!!, args[2]).toJson()
            "putAt" -> putAt(args).toJson()
            "removeAt" -> machine.removeAt(args[0].stringValue!!, args[1].stringValue!!, args[2]).toJson()
            "flush" -> machine.flush().toJson()
            "refresh" -> machine.refresh().toJson()
            else -> fail("$where: the machine slice that ports `$call` has not landed").let { JsonNull }
        }
        raw["expect"]?.let { assertTrue("$where: expect", SyncJson.jsonEqual(it, result)) }
    }

    private fun same(where: String, what: String, want: JsonElement?, got: JsonElement) =
        assertTrue("$where: $what\nwant $want\ngot  $got", SyncJson.jsonEqual(want, got))

    /** The `fileRecordCases` family's asserts: the outcomes since the last assert, and a collection's cloud rows. */
    private fun fileRecordAssertions(raw: JsonObject, where: String) {
        val drained = JsonArray(outcomes.toList())
        outcomes.clear()
        raw["outcomes"]?.let { same(where, "outcomes", it, drained) }
        (raw["rows"] as? JsonObject)?.forEach { (collection, want) ->
            same(where, "rows.$collection", want, JsonArray(machine.records(collection).map { it.toJson() }))
        }
    }

    private fun assertions(raw: JsonObject, where: String) {
        val requests = JsonArray(machine.takeRequests())
        val events = JsonArray(machine.takeEvents().map { it.toJson() })
        raw["requests"]?.let { same(where, "requests", it, requests) }
        raw["events"]?.let { same(where, "events", it, events) }
        (raw["values"] as? JsonObject)?.forEach { (k, want) -> same(where, "values.$k", want, machine.get(k).toJson()) }
        (raw["states"] as? JsonObject)?.forEach { (k, want) -> same(where, "states.$k", want, machine.settingState(k).toJson()) }
        (raw["records"] as? JsonObject)?.forEach { (k, want) ->
            val (collection, id) = k.split("/", limit = 2)
            same(where, "records.$k", want, machine.record(collection, id)?.toJson() ?: JsonNull)
        }
        fileRecordAssertions(raw, where)
        raw["journal"]?.let { same(where, "journal", it, machine.journal()) }
        raw["status"]?.let { same(where, "status", it, machine.status().toJson()) }
        if (raw.containsKey("encryptionSince")) {
            same(where, "encryptionSince", raw["encryptionSince"], machine.encryptionSince()?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        raw["licence"]?.let { same(where, "licence", it, licence ?: JsonNull) }
    }
}
