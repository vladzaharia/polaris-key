// The Kotlin transcript replay engine (P1b-03, PARITY §4.2): a port of
// conformance/runners/node/transcriptReplay.ts, so every SDK is held to one recording in one way.
// The format is documented once, in packages/worker/test/transcripts/format.ts; the files are read
// IN PLACE from conformance/transcripts/ (no mirror).
//
// `ReplayServer` is a `PolarisTransport`: the SDK under test is pointed at it, it serves the
// Worker's recorded responses and asserts every request against the recording. It never throws
// out of `send` (an SDK may swallow a transport error, so a thrown mismatch could vanish): every
// problem is RECORDED and answered with a 599, and `endStep()` fails with the full list.

package im.plrs.key.conformance

import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.io.File
import java.net.URI
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One recorded conversation, as parsed JSON with typed accessors. */
class Transcript(val json: JsonObject) {
    val id: String get() = json["id"].stringValue!!
    val features: List<String> get() = json["features"]!!.arrayValue!!.map { it.stringValue!! }
    val requires: List<String> get() = json["requires"]!!.arrayValue!!.map { it.stringValue!! }
    val product: String get() = json["product"].stringValue!!
    val baseUrl: String get() = json["baseUrl"].stringValue!!
    val now: Long get() = (json["now"] as JsonPrimitive).content.toLong()
    val trust: Map<String, String> get() = json["trust"]!!.obj.mapValues { it.value.stringValue!! }
    val initial: JsonObject get() = json["initial"]!!.obj
    val steps: List<JsonObject> get() = json["steps"]!!.arrayValue!!.map { it.obj }

    /** A deep copy with one step's exchange items edited: the doctored transcripts. */
    fun doctor(stepIndex: Int, edit: (MutableList<JsonElement>) -> Unit): Transcript {
        val steps = json["steps"]!!.arrayValue!!.toMutableList()
        val step = steps[stepIndex].obj
        val exchanges = step["exchanges"]!!.obj
        val items = exchanges["items"]!!.arrayValue!!.toMutableList()
        edit(items)
        steps[stepIndex] = JsonObject(step + ("exchanges" to JsonObject(exchanges + ("items" to JsonArray(items)))))
        return Transcript(JsonObject(json + ("steps" to JsonArray(steps))))
    }

    /** A deep copy with one step's `expect` edited. */
    fun withExpect(stepIndex: Int, key: String, value: JsonElement): Transcript {
        val steps = json["steps"]!!.arrayValue!!.toMutableList()
        val step = steps[stepIndex].obj
        steps[stepIndex] = JsonObject(step + ("expect" to JsonObject(step["expect"]!!.obj + (key to value))))
        return Transcript(JsonObject(json + ("steps" to JsonArray(steps))))
    }

    companion object {
        /** The committed transcripts directory (the parity gate's token). */
        const val DIR = "conformance/transcripts"

        /** Every committed transcript, in file-name order. */
        fun load(): List<Transcript> =
            File(Corpus.repoRoot, DIR).listFiles { f -> f.name.endsWith(".json") }!!
                .sortedBy { it.name }
                .map { Transcript(JsonText.parse(it.readText()) as JsonObject) }

        /** sdks/kotlin/parity.json's statuses. */
        fun manifestStatuses(): Map<String, String> {
            val m = JsonText.parse(File(Corpus.repoRoot, "sdks/kotlin/parity.json").readText()).obj
            return m["features"]!!.obj.mapValues { it.value.obj["status"].stringValue!! }
        }

        /** Every feature it proves is implemented and none it presupposes is `na` (as parity:check). */
        fun applies(t: Transcript, statuses: Map<String, String>): Boolean =
            t.features.all { statuses[it] == "implemented" } && t.requires.all { statuses[it] != "na" }
    }
}

private fun typeOf(v: JsonElement?): String = when (v) {
    null, is JsonNull -> "null"
    is JsonArray -> "array"
    is JsonObject -> "object"
    is JsonPrimitive -> if (v.isString) "string" else if (v.content == "true" || v.content == "false") "boolean" else "number"
}

/** Problems with [actual] under [mode] (`exact`, `subset`, `shape`), as `$.path: message`. */
fun bodyProblems(expected: JsonElement, actual: JsonElement?, mode: String, path: String = "$"): List<String> {
    if (mode == "exact") {
        return if (jsonEquals(expected, actual ?: JsonNull)) emptyList() else listOf("$path: expected $expected, got $actual")
    }
    if (expected is JsonObject) {
        if (actual !is JsonObject) return listOf("$path: expected an object, got ${typeOf(actual)}")
        return expected.flatMap { (k, v) ->
            if (!actual.containsKey(k)) listOf("$path.$k: missing") else bodyProblems(v, actual[k], mode, "$path.$k")
        }
    }
    if (mode == "shape") {
        return if (typeOf(expected) == typeOf(actual)) emptyList() else listOf("$path: expected a ${typeOf(expected)}, got ${typeOf(actual)}")
    }
    return if (jsonEquals(expected, actual ?: JsonNull)) emptyList() else listOf("$path: expected $expected, got $actual")
}

private val PLACEHOLDER = Regex("""\{([A-Za-z][A-Za-z0-9]*)\}""")

/** The fake Worker a replay points the SDK at. */
class ReplayServer(private val transcript: Transcript) : PolarisTransport {
    private val lock = Mutex()
    val bindings = HashMap<String, String>()
    private val failures = ArrayList<String>()
    private var step: JsonObject? = null
    private var stepIndex = -1
    private var served = BooleanArray(0)
    private var discoveryLoaded = false

    init {
        bindings["deviceId"] = transcript.initial["deviceId"].stringValue!!
        bindings["version"] = transcript.initial["version"].stringValue!!
        transcript.initial["token"].stringValue?.let { bindings["token"] = it }
    }

    private fun items(s: JsonObject): List<JsonObject> = s["exchanges"]!!.obj["items"]!!.arrayValue!!.map { it.obj }

    suspend fun beginStep(index: Int): JsonObject = lock.withLock {
        val s = transcript.steps[index]
        step = s
        stepIndex = index
        served = BooleanArray(items(s).size)
        for ((k, v) in s["args"]!!.obj) v.stringValue?.let { bindings[k] = it }
        s
    }

    /** Throw with every problem the step produced, including requests it never sent. */
    suspend fun endStep(): Unit = lock.withLock {
        val s = step
        if (s != null) {
            items(s).forEachIndexed { i, item ->
                if (!served[i]) {
                    val r = item["request"]!!.obj
                    failures += "expected request not sent: ${r["method"].stringValue} ${r["path"].stringValue}"
                }
            }
        }
        step = null
        if (failures.isNotEmpty()) {
            val all = failures.joinToString("\n  ")
            failures.clear()
            throw AssertionError("${transcript.id} step $stepIndex (${s?.get("action").stringValue ?: "?"}):\n  $all")
        }
    }

    private fun substitute(template: String): Pair<String?, String?> {
        var unbound: String? = null
        val value = PLACEHOLDER.replace(template) { m ->
            val name = m.groupValues[1]
            bindings[name] ?: run {
                unbound = name
                ""
            }
        }
        return if (unbound != null) null to unbound else value to null
    }

    /** Why [req] does not satisfy [item]; empty when it does. */
    private fun problems(item: JsonObject, method: String, headers: Map<String, String>, body: String?): List<String> {
        val out = ArrayList<String>()
        val expected = item["request"]!!.obj
        for ((name, template) in expected["headers"]!!.obj) {
            val (value, unbound) = substitute(template.stringValue!!)
            val actual = headers[name.lowercase()]
            when {
                unbound != null -> out += "header $name: sent before {$unbound} was bound (an earlier response it depends on)"
                actual == null -> out += "header $name: missing"
                actual != value -> out += "header $name: expected \"$value\", got \"$actual\""
            }
        }
        for (name in expected["requiredHeaders"]!!.arrayValue!!) {
            if (headers[name.stringValue!!.lowercase()] == null) out += "required header ${name.stringValue}: missing"
        }
        val hasBody = body != null && body.isNotEmpty()
        val expectedBody = expected["body"]
        if (expectedBody == null || expectedBody is JsonNull) {
            if (hasBody) out += "body: expected none, got ${body!!.take(120)}"
        } else if (!hasBody) {
            out += "body: expected a JSON body, got none"
        } else {
            val parsed = JsonText.parseOrNull(body!!)
            if (parsed == null) {
                out += "body: not JSON"
                return out
            }
            val b = expectedBody.obj
            out += bodyProblems(b["json"]!!, parsed, b["match"].stringValue!!).map { "body $it" }
            val allowed = b["allowedKeys"]?.arrayValue?.map { it.stringValue!! }?.toSet()
            if (allowed != null && parsed is JsonObject) {
                for (k in parsed.keys) if (k !in allowed) out += "body: key \"$k\" is not allowed"
            }
        }
        return out
    }

    private fun capture(item: JsonObject) {
        val cap = item["capture"].objectValue ?: return
        for ((name, pathEl) in cap) {
            var cur: JsonElement? = item["response"]!!.obj["body"]
            for (part in pathEl.stringValue!!.removePrefix("$.").split('.')) cur = cur.objectValue?.get(part)
            val s = cur.stringValue
            if (s != null) bindings[name] = s else failures += "capture $name (${pathEl.stringValue}) found no string"
        }
    }

    /**
     * The Worker's standard discovery document, for a transcript that loads discovery nowhere itself
     * (P3-03's update transcripts): served once, to a request for the discovery path that the current
     * step does not record. Null for every other request (as Swift's and Node's replayers).
     */
    private fun standardDiscovery(path: String, s: JsonObject): String? {
        val discoveryPath = "/${transcript.product}/.well-known/polaris.json"
        if (path != discoveryPath || discoveryLoaded) return null
        if (transcript.steps.any { it["action"].stringValue == "discover" }) return null
        if (items(s).any { it["request"]!!.obj["path"].stringValue == discoveryPath }) return null
        discoveryLoaded = true
        val base = "${transcript.baseUrl}/${transcript.product}"
        fun service(endpoints: Map<String, String>) = JsonObject(
            mapOf("enabled" to JsonPrimitive(true), "endpoints" to JsonObject(endpoints.mapValues { JsonPrimitive(it.value) })),
        )
        return JsonObject(
            mapOf(
                "product" to JsonPrimitive(transcript.product),
                "services" to JsonObject(
                    mapOf(
                        "release" to service(mapOf("record" to "$base/release/records/{sha256}")),
                        "distribution" to service(mapOf("builds" to "$base/distribution/builds/{selector}/{buildId}")),
                        "update" to service(mapOf("feed" to "$base/update/{channel}/feed.jws")),
                    ),
                ),
            ),
        ).toString()
    }

    override suspend fun send(request: PolarisRequest): PolarisResponse = lock.withLock {
        val uri = URI(request.url)
        val origin = URI(transcript.baseUrl)
        val headers = request.headers.mapKeys { it.key.lowercase() }
        val method = request.method.uppercase()
        val body = if (method == "GET" || method == "HEAD") null else request.body?.toString(Charsets.UTF_8)
        if (uri.scheme != origin.scheme || uri.host != origin.host || uri.port != origin.port) {
            failures += "request to a foreign origin: ${request.url}"
            return@withLock PolarisResponse(599, "replay: foreign origin".toByteArray())
        }
        val path = uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: "")
        val label = "$method $path"
        val s = step ?: run {
            failures += "unexpected request outside a step: $label"
            return@withLock PolarisResponse(599, "replay: no step".toByteArray())
        }
        standardDiscovery(path, s)?.let { return@withLock PolarisResponse(200, it.toByteArray(Charsets.UTF_8), mapOf("content-type" to "application/json")) }
        val all = items(s)
        var candidates = all.withIndex().filter { (i, item) ->
            val r = item["request"]!!.obj
            !served[i] && r["method"].stringValue == method && r["path"].stringValue == path
        }
        if (s["exchanges"]!!.obj["ordered"] == JsonPrimitive(true)) {
            val next = served.indexOfFirst { !it }
            candidates = candidates.filter { it.index == next }
        }
        if (candidates.isEmpty()) {
            failures += "unexpected request: $label"
            return@withLock PolarisResponse(599, "replay: no matching exchange".toByteArray())
        }
        for ((i, item) in candidates) {
            if (problems(item, method, headers, body).isNotEmpty()) continue
            served[i] = true
            capture(item)
            val response = item["response"]!!.obj
            val status = (response["status"] as JsonPrimitive).content.toInt()
            val b = response["body"]
            val text = if (b is JsonPrimitive && b.isString) b.content else b.toString()
            val nullBody = status in setOf(101, 204, 205, 304)
            return@withLock PolarisResponse(
                status,
                if (nullBody) ByteArray(0) else text.toByteArray(Charsets.UTF_8),
                response["headers"]!!.obj.mapValues { it.value.stringValue!! },
            )
        }
        val first = candidates.first().value
        failures += "request $label does not match the recording:\n    " + problems(first, method, headers, body).joinToString("\n    ")
        PolarisResponse(599, "replay: no matching exchange".toByteArray())
    }
}
