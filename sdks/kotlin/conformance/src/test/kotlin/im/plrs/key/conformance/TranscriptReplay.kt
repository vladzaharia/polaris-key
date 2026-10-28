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

import im.plrs.key.core.CoreContext
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.sync.HostCodec
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.sync.SyncResponse
import im.plrs.key.sdk.CloudSyncTransport
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.net.URI

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
        fun load(): List<Transcript> = File(Corpus.repoRoot, DIR).listFiles { f -> f.name.endsWith(".json") }!!
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

    is JsonPrimitive -> if (v.isString) {
        "string"
    } else if (v.content == "true" || v.content == "false") {
        "boolean"
    } else {
        "number"
    }
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
class ReplayServer(val transcript: Transcript) : PolarisTransport {
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
        for ((k, v) in s["args"]!!.obj) {
            // `deviceId` in a key ring step names the TARGET device (the path); the `{deviceId}` in a header stays
            // the calling device's, which is `initial.deviceId`.
            if (k == "deviceId" && s["action"].stringValue.orEmpty().startsWith("keyring")) continue
            v.stringValue?.let { bindings[k] = it }
        }
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
        // `token` (WIRE-CONTRACT-V4 §12.5): a request that asserts a form content type carries its `body.json` members as the form's fields.
        val isForm = expected["headers"]!!.obj["content-type"].stringValue?.startsWith("application/x-www-form-urlencoded") == true
        if (expectedBody == null || expectedBody is JsonNull) {
            if (hasBody) out += "body: expected none, got ${body!!.take(120)}"
        } else if (!hasBody) {
            out += "body: expected a JSON body, got none"
        } else {
            val parsed: JsonElement? = if (isForm) formFields(body!!, out) else JsonText.parseOrNull(body!!)
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

    private fun formFields(body: String, out: MutableList<String>): JsonElement? {
        val fields = LinkedHashMap<String, JsonElement>()
        for (pair in body.split('&').filter { it.isNotEmpty() }) {
            val eq = pair.indexOf('=')
            val name = formDecode(if (eq == -1) pair else pair.substring(0, eq))
            val value = formDecode(if (eq == -1) "" else pair.substring(eq + 1))
            if (name == null || value == null) {
                out += "body: not a form"
                return JsonObject(emptyMap())
            }
            if (fields.containsKey(name)) out += "body: repeated field $name"
            fields[name] = JsonPrimitive(value)
        }
        return JsonObject(fields)
    }

    private fun formDecode(s: String): String? = try {
        java.net.URLDecoder.decode(s, "UTF-8")
    } catch (e: IllegalArgumentException) {
        null
    }

    /**
     * A `browser` step's exchanges: the requests a person's browser makes in a redirect sign-in. They are
     * served from the recording and asserted by nothing (`format.ts`).
     */
    suspend fun serveBrowserExchanges(): Unit = lock.withLock {
        val s = step ?: return@withLock
        items(s).forEachIndexed { i, item ->
            served[i] = true
            capture(item)
        }
    }

    suspend fun recordFailure(message: String): Unit = lock.withLock { failures += message }

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
        // The redirect transcripts (identity.redirect.web, identity.signin.hints) ride a product that runs Identity;
        // the fragment names `authorize` and `token`, and the issuer the recorded callback carries (RFC 9207),
        // else the Worker's own `<base>/identity`.
        if (transcript.steps.any { it["action"].stringValue in setOf("browser", "redirectComplete") }) {
            val choice = transcript.steps.any { it["action"].stringValue?.startsWith("choice") == true }
            var issuer = "$base/identity"
            for (st in transcript.steps) {
                if (st["action"].stringValue != "redirectComplete") continue
                val raw = st["args"]!!.obj["callbackUrl"].stringValue ?: continue
                val iss = raw.substringAfter('?', "").substringBefore('#').split('&')
                    .map { it.split('=', limit = 2) }.firstOrNull { it[0] == "iss" }?.getOrNull(1)
                if (iss != null) {
                    issuer = java.net.URLDecoder.decode(iss, "UTF-8")
                    break
                }
            }
            val identity = JsonObject(
                mapOf(
                    "enabled" to JsonPrimitive(true),
                    "configured" to JsonPrimitive(true),
                    "issuer" to JsonPrimitive(issuer),
                    "endpoints" to JsonObject(
                        buildMap {
                            put("authorize", JsonPrimitive("$base/identity/authorize"))
                            put("token", JsonPrimitive("$base/identity/token"))
                            if (choice) {
                                for (name in listOf("licenses", "devices", "complete", "cancel")) {
                                    put("choice" + name.replaceFirstChar { it.uppercase() }, JsonPrimitive("$base/identity/choice/$name"))
                                }
                            }
                        },
                    ),
                ),
            )
            return JsonObject(
                mapOf("product" to JsonPrimitive(transcript.product), "services" to JsonObject(mapOf("identity" to identity))),
            ).toString()
        }
        // identity.exchange (I-45.3): a transcript with an `exchange` step and no discover step rides a product whose
        // Identity fragment offers the rung (V5 section 12.11.6): the kinds, the Google audience, the nonce and token routes,
        // and the grant-completion route a confirm or choose answer is finished at.
        if (transcript.steps.any { it["action"].stringValue == "exchange" }) {
            val endpoints = mapOf(
                "nonce" to "$base/identity/nonce",
                "token" to "$base/identity/token",
                "choiceComplete" to "$base/identity/choice/complete",
            )
            val exchange = JsonObject(
                mapOf(
                    "kinds" to JsonArray(listOf(JsonPrimitive("google"), JsonPrimitive("apple"))),
                    "google" to JsonObject(mapOf("serverClientId" to JsonPrimitive("1234-web.apps.googleusercontent.com"))),
                ),
            )
            val identity = JsonObject(
                mapOf(
                    "enabled" to JsonPrimitive(true),
                    "exchange" to exchange,
                    "endpoints" to JsonObject(endpoints.mapValues { JsonPrimitive(it.value) }),
                ),
            )
            return JsonObject(
                mapOf("product" to JsonPrimitive(transcript.product), "services" to JsonObject(mapOf("identity" to identity))),
            ).toString()
        }
        val services = if ("identity.account" in transcript.features || "identity.attach" in transcript.features) {
            // identity.account: Identity with its account endpoints, beside the licence the steps use.
            mapOf(
                "license" to service(mapOf("activate" to "$base/license/activate", "document" to "$base/license/document")),
                "config" to service(mapOf("document" to "$base/config/document")),
                "identity" to JsonObject(
                    mapOf(
                        "enabled" to JsonPrimitive(true),
                        "account" to JsonPrimitive(true),
                        "endpoints" to JsonObject(
                            mapOf(
                                "attach" to "$base/identity/attach",
                                "subject" to "$base/identity/subject",
                                "signout" to "$base/identity/signout",
                                "accountPortal" to "${transcript.baseUrl}/#/p/${transcript.product}",
                            ).mapValues { JsonPrimitive(it.value) },
                        ),
                    ),
                ),
            )
        } else {
            mapOf(
                "release" to service(mapOf("record" to "$base/release/records/{sha256}")),
                "distribution" to service(mapOf("builds" to "$base/distribution/builds/{selector}/{buildId}")),
                "update" to service(mapOf("feed" to "$base/update/{channel}/feed.jws")),
            )
        }
        return JsonObject(mapOf("product" to JsonPrimitive(transcript.product), "services" to JsonObject(services))).toString()
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
        standardDiscovery(path, s)?.let {
            return@withLock PolarisResponse(200, it.toByteArray(Charsets.UTF_8), mapOf("content-type" to "application/json"))
        }
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

// ── Cloud Sync settings (U-07.K11, `sync.settings`) ─────────────────────────────────────────

/**
 * Forwards to the replay server, remembers the last response's headers (lower-cased: `SyncResponse` does not
 * carry the ETag or Retry-After) and adds the last pull's ETag as If-None-Match to the next pull.
 */
class HeaderTap(private val inner: PolarisTransport) : PolarisTransport {
    @Volatile
    var lastHeaders: Map<String, String> = emptyMap()
        private set

    /** The ETag the next pull sends as If-None-Match; empty sends none. */
    @Volatile
    var ifNoneMatch: String = ""

    override suspend fun send(request: PolarisRequest): PolarisResponse {
        lastHeaders = emptyMap()
        val sent = if (request.method == "GET" && ifNoneMatch.isNotEmpty()) {
            request.copy(headers = request.headers + ("if-none-match" to ifNoneMatch))
        } else {
            request
        }
        val r = inner.send(sent)
        lastHeaders = r.headers.mapKeys { it.key.lowercase() }
        return r
    }
}

/** The host codec over a root made for the replay: not the recorder's, so every recorded `ct` reads invalid. */
class FixtureSyncCodec(private val root: ByteArray) : SyncCodecPort {
    override val locked: Boolean get() = false
    override fun seal(collection: String, name: String, value: JsonElement): ByteArray = SyncEnvelope.seal(root, collection, name, value)
    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(root, collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(root, collection, envelope)
    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String): String = SyncBlind.blind(root, kind, ctx, name)
}

object CloudSyncReplay {
    private val declared = listOf("ui.theme", "audio.volume")
    private val e2eNames = listOf("ui.theme", "my.open.key", "game.best")
    private val e2eDeclared = listOf("ui.theme", "game.best")
    private const val CLIENT_ID = "c_AAAAAAAAAAAAAAAAAAAAAA"
    private const val HLC = "018bcfe56418:0000"

    /** A ring root made for the replay. */
    val root: ByteArray = ByteArray(32) { (11 * it + 5).toByte() }

    /** One label per mutation result, in the transcript format's words. */
    fun resultLabel(r: JsonElement): String {
        val o = r as? JsonObject
        val status = o?.get("status").stringValue ?: return "?"
        return when (status) {
            "ok" -> when {
                o!!["renamedTo"].stringValue != null -> "ok:renamedTo:" + o["renamedTo"].stringValue
                o["dropped"].boolValue == true -> "ok:dropped"
                else -> "ok"
            }

            "rejected" -> {
                val code = o!!["code"].stringValue ?: "?"
                o["scope"].stringValue?.let { "rejected:$code:$it" } ?: "rejected:$code"
            }

            else -> status
        }
    }

    private fun number(v: JsonElement?): Boolean = (v as? JsonPrimitive)?.let { !it.isString && it.content.toDoubleOrNull() != null } == true

    /**
     * `cloudSyncPull` / `cloudSyncPush` through `CloudSyncTransport` (the bearer and the X-PKey headers). A pull
     * sends the last ETag it saw as If-None-Match. The end-to-end transcript is sealed by `HostCodec.sealPush`
     * and opened by `openPull` over a fixture root, so every recorded `ct` reads invalid.
     */
    suspend fun run(core: CoreContext, step: JsonObject, session: ReplaySession, out: MutableMap<String, JsonElement>) {
        val tap = session.tap ?: throw AssertionError("no header tap")
        val codec = session.codec
        val pull = step["action"].stringValue == "cloudSyncPull"
        val args = step["args"]!!.obj
        val cursor = args["cursor"].longValue ?: 0L
        val mutations = ArrayList<JsonElement>()
        val request: JsonObject
        if (pull) {
            tap.ifNoneMatch = session.syncEtag
            request = JsonObject(mapOf("method" to JsonPrimitive("GET"), "path" to JsonPrimitive("/${core.product}/sync?cursor=$cursor")))
        } else {
            tap.ifNoneMatch = ""
            val names = if (codec != null) e2eNames else declared
            for (i in 0 until (args["mutations"].longValue ?: 0L).toInt()) {
                val id = session.syncNextId + i
                mutations += JsonObject(
                    mapOf(
                        "mutationId" to jsonInt(id.toLong()),
                        "target" to JsonObject(mapOf("setting" to JsonPrimitive(names[i % names.size]), "scope" to JsonPrimitive("user"))),
                        "op" to JsonPrimitive("set"),
                        "value" to JsonPrimitive("generated-$id"),
                        "editedHlc" to JsonPrimitive(HLC),
                    ),
                )
            }
            val body = LinkedHashMap<String, JsonElement>()
            body["clientId"] = JsonPrimitive(CLIENT_ID)
            body["cursor"] = jsonInt(cursor)
            body["mutations"] = JsonArray(mutations)
            if (args["atomic"].boolValue == true) body["atomic"] = JsonPrimitive(true)
            var sealed: JsonElement = JsonObject(body)
            if (codec != null) sealed = HostCodec.sealPush(sealed, codec, e2eDeclared)
            request = JsonObject(mapOf("method" to JsonPrimitive("POST"), "path" to JsonPrimitive("/${core.product}/sync/ops"), "body" to sealed))
        }
        val answer: SyncResponse = CloudSyncTransport.send(core, request)
        if (answer.transportError) {
            out["result"] = JsonPrimitive("transport")
            return
        }
        val headers = tap.lastHeaders
        val status = answer.status
        if (pull) headers["etag"]?.let { session.syncEtag = it }
        if (status == 304) {
            out["result"] = JsonPrimitive("not-modified")
            return
        }
        if (status < 200 || status >= 300) {
            out["result"] = JsonPrimitive("refused")
            out["status"] = jsonInt(status.toLong())
            answer.body.objectValue?.get("error").objectValue?.get("code").stringValue?.takeIf { it.isNotEmpty() }
                ?.let { out["code"] = JsonPrimitive(it) }
            headers["retry-after"]?.toLongOrNull()?.let { out["retryAfter"] = jsonInt(it) }
            return
        }
        var served: JsonElement? = answer.body
        if (codec != null && answer.body != null) {
            val opened = HostCodec.openPull(answer.body!!, codec, mutations)
            served = opened.body
            val rows = opened.opened.changes.filterNotNull() + opened.opened.conflicts.values.filterNotNull()
            for (row in rows) {
                if (!(row.invalid && !row.sealed)) throw AssertionError("a fixture ct opened: $row")
            }
            if (rows.isEmpty() && answer.body.objectValue?.get("changes").arrayValue?.isNotEmpty() == true) {
                throw AssertionError("e2e answer carried changes but no opened rows")
            }
        }
        out["result"] = JsonPrimitive("ok")
        val b = served as? JsonObject ?: return
        b["cursor"]?.takeIf { number(it) }?.let { out["cursor"] = it }
        b["more"].boolValue?.let { out["more"] = JsonPrimitive(it) }
        out["empty"] = JsonPrimitive(b["empty"].boolValue == true)
        val names = (b["changes"].arrayValue ?: JsonArray(emptyList())).mapNotNull { it.objectValue?.get("setting").stringValue }
        out["settings"] = JsonArray(names.sortedWith { x, y -> compareUtf16(x, y) }.map { JsonPrimitive(it) })
        b["quota"].objectValue?.let { q ->
            q["bytes"]?.takeIf { number(it) }?.let { out["quotaBytes"] = it }
            q["files"].boolValue?.let { out["files"] = JsonPrimitive(it) }
        }
        b["encryption"].stringValue?.let { out["encryption"] = JsonPrimitive(it) }
        b["encryptionSince"]?.takeIf { number(it) }?.let { out["encryptionSince"] = it }
        b["aliases"]?.takeIf { it is JsonObject }?.let { out["aliases"] = it }
        if (!pull) {
            val last = b["lastMutationId"]
            if (last != null && last.longValue != null) {
                out["lastMutationId"] = last
                session.syncNextId = last.longValue!!.toInt() + 1
            }
            out["results"] = JsonArray((b["results"].arrayValue ?: JsonArray(emptyList())).map { JsonPrimitive(resultLabel(it)) })
        }
    }

    private fun compareUtf16(a: String, b: String): Int = a.compareTo(b)

    /**
     * A CORS exchange (`cloudsync-cors`): the browser's own. The preflight is the test's own bare request (no SDK
     * headers); the push is the SDK's own POST with its headers, the bearer and the recorded origin.
     */
    suspend fun cors(core: CoreContext, step: JsonObject, transport: PolarisTransport) {
        for (item in step["exchanges"]!!.obj["items"]!!.arrayValue!!) {
            val req = item.obj["request"]!!.obj
            val method = req["method"].stringValue!!
            val url = core.endpoints.baseUrl + req["path"].stringValue
            val given = req["headers"].objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()
            if (method == "OPTIONS") {
                runCatching { transport.send(PolarisRequest(url = url, method = "OPTIONS", headers = given)) }
                continue
            }
            val extra = linkedMapOf("content-type" to "application/json", "accept" to "application/json")
            given["origin"]?.let { extra["origin"] = it }
            core.token()?.let { extra["authorization"] = "Bearer $it" }
            val body = req["body"]?.takeIf { it !is JsonNull }?.obj?.get("json")?.toString()?.toByteArray(Charsets.UTF_8)
            runCatching { transport.send(PolarisRequest(url = url, method = method, headers = core.headers(extra), body = body)) }
        }
    }
}
