// @pkey-feature core.discover core.sync core.cache
//
// The Kotlin transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, read in place:
// drive :core's `CoreContext` through every recorded conversation sdks/kotlin/parity.json makes
// applicable, against `ReplayServer` (the fake Worker), asserting every request and every `expect`
// key of every step.
//
// Which transcripts run is DATA: one for a feature this SDK has not implemented is skipped, and
// starts running the moment the manifest claims it (P6-06: the core.* transcripts,
// discovery-capabilities, discovery-failure, sync-etag-304 and sync-errors). The SDK clock is
// `CoreOptions.clock`, pinned to each step's `now`.
//
// Until the umbrella client lands (P6-07), this file composes what the facade will: the §5
// re-acquire is `POST /license/token` through `CoreContext.request` (the route
// `chooseReacquireRoute` picks for these transcripts), and the device report posts the verified
// config values and entitlements through `CoreContext.reportSnapshot`.

package im.plrs.key.conformance

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DiscoveryResult
import im.plrs.key.core.DocOutcome
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.Reacquired
import im.plrs.key.core.ReacquireRoute
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.chooseReacquireRoute
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

object KotlinReplay {
    /** THE mapping from transcript verbs and `expect` keys onto :core. */
    suspend fun act(core: CoreContext, store: InMemoryStore, step: JsonObject): Map<String, JsonElement> {
        val out = LinkedHashMap<String, JsonElement>()
        val args = step["args"]!!.obj
        when (val action = step["action"].stringValue) {
            "discover" -> out["result"] = JsonPrimitive(
                when (core.discover()) {
                    is DiscoveryResult.Ok -> "ok"
                    DiscoveryResult.NotFound -> "not-found"
                    is DiscoveryResult.Invalid -> "invalid"
                    is DiscoveryResult.Error -> "error"
                },
            )
            "sync" -> {
                val r = core.sync(
                    force = args["force"].boolValue == true,
                    reacquire = { current, source -> reacquire(core, current, source) },
                    report = { report(core) },
                )
                out["applied"] = JsonPrimitive(r.applied)
                out["unauthorized"] = JsonPrimitive(r.unauthorized)
                out["blocked"] = JsonPrimitive(r.blocked)
                val docs = LinkedHashMap<String, JsonElement>()
                for ((slice, outcome) in r.documents) {
                    val word = when (outcome) {
                        DocOutcome.Applied -> "applied"
                        DocOutcome.Unchanged -> "unchanged"
                        DocOutcome.Unauthorized -> "unauthorized"
                        is DocOutcome.Blocked -> "blocked"
                        is DocOutcome.DeviceCap -> "device-cap"
                        DocOutcome.Error -> "error"
                        DocOutcome.Skipped -> null
                    }
                    if (word != null) docs[slice.wire] = JsonPrimitive(word)
                }
                out["documents"] = JsonObject(docs)
            }
            else -> throw AssertionError("the Kotlin replayer has no mapping for \"$action\" (a later slice adds it)")
        }
        out["services"] = JsonObject(core.services().entries.associate { it.key.slug to JsonPrimitive(it.value) })
        out["licenseStatus"] = JsonPrimitive(core.licenseStatus().status.wire)
        out["tokenHeld"] = JsonPrimitive(store.getToken() != null)
        return out
    }

    /** §5's single re-acquire, as the umbrella client (P6-07) will compose it. */
    private suspend fun reacquire(core: CoreContext, current: String, source: TokenSource?): Reacquired? {
        if (chooseReacquireRoute(core.enabled(ServiceSlug.license), source) != ReacquireRoute.licenseToken) return null
        val response = core.request(core.endpoints.licenseToken, method = "POST", headers = mapOf("authorization" to "Bearer $current"))
        if (!response.isOk) return null
        val token = JsonText.parseOrNull(response.text).objectValue?.get("token").stringValue ?: return null
        return Reacquired(token, TokenSource.reacquire)
    }

    /** The device report: the flat `{config, entitlements}` body the Worker's allowlist reads. */
    private suspend fun report(core: CoreContext) {
        val body = JsonObject(mapOf("config" to core.configValues(), "entitlements" to core.entitlementValues()))
        core.reportSnapshot(body.toString().toByteArray(Charsets.UTF_8))
    }

    /** Replay [t] step by step; throws on the first step whose traffic or outcome disagrees. */
    fun replay(t: Transcript) = runBlocking {
        val server = ReplayServer(t)
        var clock = t.now
        val store = InMemoryStore(t.product, t.initial["deviceId"].stringValue!!)
        t.initial["token"].stringValue?.let { store.setToken(it) }
        val services = t.initial["services"]?.arrayValue?.mapNotNull { ServiceSlug.of(it.stringValue) }
        val core = CoreContext(
            CoreOptions(
                productSlug = t.product, baseUrl = t.baseUrl, version = t.initial["version"].stringValue!!,
                pinnedKeys = t.trust, store = store, transport = server, requestTimeoutSeconds = 0.0,
                expectedServices = services, clock = { clock },
            ),
        )
        core.start()
        t.steps.forEachIndexed { i, _ ->
            val step = server.beginStep(i)
            clock = step["now"].longValue ?: t.now
            val observed = act(core, store, step)
            server.endStep()
            for ((key, want) in step["expect"]!!.obj.entries.sortedBy { it.key }) {
                val got = observed[key]
                if (got == null || !jsonEquals(want, got)) {
                    throw AssertionError("${t.id} step $i (${step["action"].stringValue}): $key: expected $want, got $got")
                }
            }
        }
    }
}

class TranscriptTest {
    init {
        Corpus.backend
    }

    private val transcripts = Transcript.load()

    @Test
    fun theTranscriptSetIsPresent() = assertTrue(transcripts.isNotEmpty())

    @Test
    fun replaysEveryApplicableTranscript() {
        val statuses = Transcript.manifestStatuses()
        val replayed = ArrayList<String>()
        val problems = ArrayList<String>()
        for (t in transcripts) {
            if (!Transcript.applies(t, statuses)) continue
            try {
                KotlinReplay.replay(t)
            } catch (e: AssertionError) {
                problems += e.message ?: e.toString()
            }
            replayed += t.id
        }
        println("transcripts replayed by Kotlin (${Transcript.DIR}): ${replayed.joinToString(", ")}")
        if (problems.isNotEmpty()) fail(problems.joinToString("\n"))
        for (id in listOf("discovery-capabilities", "discovery-failure", "sync-etag-304", "sync-errors")) {
            assertTrue("$id replayed", id in replayed)
        }
    }

    // ── The replayer fails on a doctored transcript ────────────────────────────────────────

    private fun base(): Transcript = transcripts.first { it.id == "sync-etag-304" }

    private fun assertReplayFails(t: Transcript, needle: String) {
        try {
            KotlinReplay.replay(t)
        } catch (e: AssertionError) {
            assertTrue("expected \"$needle\" in: ${e.message}", e.message.orEmpty().contains(needle))
            return
        }
        fail("the doctored transcript replayed cleanly")
    }

    private fun path(item: JsonElement) = item.obj["request"]!!.obj["path"].stringValue!!

    @Test
    fun anExtraRequestFails() = assertReplayFails(
        base().doctor(0) { items -> items.removeAll { path(it).endsWith("/devices/report") } },
        "unexpected request: POST /djdl/devices/report",
    )

    @Test
    fun anOmittedRequestFails() = assertReplayFails(
        base().doctor(0) { items -> items.add(items[0]) },
        "expected request not sent: GET /djdl/.well-known/polaris-trust.jws",
    )

    @Test
    fun aDroppedRequiredHeaderFails() = assertReplayFails(
        base().doctor(0) { items ->
            for (i in items.indices) {
                if (!path(items[i]).endsWith("/license/document")) continue
                val item = items[i].obj
                val request = item["request"]!!.obj
                val required = JsonArray(request["requiredHeaders"]!!.arrayValue!! + JsonPrimitive("x-pkey-doctored"))
                items[i] = JsonObject(item + ("request" to JsonObject(request + ("requiredHeaders" to required))))
            }
        },
        "required header x-pkey-doctored: missing",
    )

    @Test
    fun aDifferentOutcomeFails() = assertReplayFails(
        base().withExpect(1, "documents", JsonObject(mapOf("license" to JsonPrimitive("applied"), "config" to JsonPrimitive("applied")))),
        "step 1 (sync): documents",
    )

    @Test
    fun aDifferentLicenceStatusFails() {
        val t = transcripts.first { it.id == "sync-errors" }.withExpect(1, "licenseStatus", JsonPrimitive("ok"))
        assertReplayFails(t, "step 1 (sync): licenseStatus")
    }

    @Test
    fun aTranscriptForAPlannedFeatureDoesNotApply() {
        val statuses = Transcript.manifestStatuses()
        assertFalse(Transcript.applies(transcripts.first { it.id == "devicecode-happy" }, statuses))
    }
}
