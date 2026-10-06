// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode config.mint
// @pkey-feature update.feed release.record update.decide
// @pkey-feature packs.apply.chunk commerce.receipt
// @pkey-feature license.manage
//
// The Kotlin transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, read in place:
// drive the umbrella `PolarisKeyClient` (:sdk) through every recorded conversation
// sdks/kotlin/parity.json makes applicable, against `ReplayServer` (the fake Worker), asserting
// every request and every `expect` key of every step. The verb mapping is Swift's
// (`SwiftReplay.act`), kept in one place below.
//
// Which transcripts run is DATA: one for a feature this SDK has not implemented is skipped, and
// starts running the moment the manifest claims it (P6-06: the core.* transcripts; P6-07: the
// licence, config, devices, identity and release ones). The SDK clock is `CoreOptions.clock`,
// pinned to each step's `now`: the recorded documents were signed at a fixed instant.
//
// Registration and activation send a FIXED hashed fingerprint (`replayFingerprint`), so a replay
// does not depend on what this host can read; the report's software facts are this host's own
// (the transcripts match them by shape).
//
// `updateDecide` (plans/P3-01.md §5, §6; P6-08) is `client.update.decide(channel, staged,
// skipVersion)`, and its `expect` keys are the `UpdateCheck`'s own (`channel`, `decision`, `feed`,
// `record`, `errors`). `initial.update` is the host's configuration: `pinnedReleaseKeys`, `outlet`,
// `platform`, `arch`, `installed` and `methods` become `UpdateClientOptions`, the installed version
// is the client's version, and `cache` seeds the store's `feeds` and `releaseRecords`. A transcript
// with `initial.update` and no `initial.services` runs with Release, Distribution and Update
// expected; one that loads no discovery itself is served the Worker's standard document.
//
// `chunkRange` (P4-32, plans/P4-32.md §5) is `chunkRangeFetch` over the packs facet's own object
// fetch (`client.packs`'s private `fetchObject`, reached by reflection as the Node replayer reaches
// its own through a cast: no public API changes), against the blobs template the last discover
// returned, with the replay server behind the `PackObjectTransport` seam
// (`ReplayPackObjectTransport`, as `ReplayServer` is behind `PolarisTransport`).

package im.plrs.key.conformance

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DiscoveryResult
import im.plrs.key.core.DocOutcome
import im.plrs.key.core.FingerprintSource
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RegisterResult
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.identity.SignInPoll
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.core.JsonText
import im.plrs.key.release.ChangelogEntry
import im.plrs.key.sdk.ClaimResult
import im.plrs.key.sdk.CommerceClient
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.CacheRecord
import im.plrs.key.core.HostOutlet
import im.plrs.key.core.StagedUpdate
import im.plrs.key.core.objectValue
import im.plrs.key.update.UpdateClientOptions
import im.plrs.key.core.PolarisRequest
import im.plrs.key.packs.ByteStream
import im.plrs.key.packs.ChunkRangeRequest
import im.plrs.key.packs.ChunkRangeResponse
import im.plrs.key.packs.ObjectFetch
import im.plrs.key.packs.ObjectRequest
import im.plrs.key.packs.ObjectResponse
import im.plrs.key.packs.PackObjectTransport
import im.plrs.key.packs.PacksClient
import im.plrs.key.packs.chunkRangeFetch
import java.lang.reflect.InvocationTargetException
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A fixed hashed fingerprint, so a replay does not depend on what this host can read. */
val replayFingerprint: FingerprintSource = FingerprintSource {
    HardwareFingerprint(mapOf("machineUuid" to "REPLAYmachineUuid00000"), "REPLAYhwid0000000000000000000000")
}

/**
 * The pack object transport a `chunkRange` step hands the packs facet's `fetchObject` (P4-32): the
 * replay server behind the `PackObjectTransport` seam. It reports bounded ranges (as
 * `OkHttpPackObjectTransport` does), and the recorded `Content-Range` and `ETag`.
 */
class ReplayPackObjectTransport(private val server: ReplayServer) : PackObjectTransport {
    override val supportsRange: Boolean get() = true

    override suspend fun get(url: String, headers: Map<String, String>, timeoutSeconds: Double): ObjectResponse {
        val r = server.send(PolarisRequest(url, "GET", headers, null, timeoutSeconds))
        val lower = r.headers.mapKeys { it.key.lowercase() }
        return ObjectResponse(r.status, lower["content-range"], lower["etag"], if (r.body.isEmpty()) ByteStream.empty else ByteStream.of(r.body))
    }
}

/** The packs facet's private `fetchObject(transport, req)` over [transport], by reflection. */
fun packsObjectFetch(packs: PacksClient, transport: PackObjectTransport): ObjectFetch {
    val m = PacksClient::class.java.getDeclaredMethod(
        "fetchObject", PackObjectTransport::class.java, ObjectRequest::class.java, Continuation::class.java,
    ).apply { isAccessible = true }
    return { req ->
        suspendCoroutineUninterceptedOrReturn<ObjectResponse> { cont ->
            try {
                m.invoke(packs, transport, req, cont)
            } catch (e: InvocationTargetException) {
                throw e.targetException
            }
        }
    }
}

/** The replay's memory between steps: the prompt the last `beginSignIn` returned. */
class ReplaySession {
    var prompt: SignInPrompt? = null
}

object KotlinReplay {
    /** THE mapping from transcript verbs and `expect` keys onto the Kotlin SDK. */
    suspend fun act(
        client: PolarisKeyClient,
        store: InMemoryStore,
        step: JsonObject,
        session: ReplaySession,
        objects: PackObjectTransport? = null,
    ): Map<String, JsonElement> {
        val out = LinkedHashMap<String, JsonElement>()
        val args = step["args"]!!.obj
        when (val action = step["action"].stringValue) {
            "chunkRange" -> {
                val transport = objects ?: throw AssertionError("chunkRange without a pack object transport")
                val fetchRange = chunkRangeFetch(packsObjectFetch(client.packs, transport))
                val r = fetchRange(
                    ChunkRangeRequest(args["bundle"].stringValue ?: "", args["offset"].longValue ?: 0, args["length"].longValue ?: 0),
                )
                when (r) {
                    ChunkRangeResponse.Refused -> out["range"] = JsonPrimitive("refused")
                    is ChunkRangeResponse.Ok -> {
                        val bytes = java.io.ByteArrayOutputStream()
                        while (true) bytes.write(r.body.next() ?: break)
                        out["range"] = JsonPrimitive("ok")
                        out["bytes"] = JsonPrimitive(bytes.toByteArray().toString(Charsets.ISO_8859_1))
                    }
                }
            }
            "updateDecide" -> {
                val staged = args["staged"].objectValue?.let { st ->
                    val v = st["version"].stringValue
                    val c = st["channel"].stringValue
                    if (v != null && c != null) StagedUpdate(v, c) else null
                }
                try {
                    val check = client.update.decide(args["channel"].stringValue, staged, args["skipVersion"].stringValue)
                    out.putAll(check.json)
                    out["result"] = JsonPrimitive("ok")
                } catch (e: PolarisException) {
                    out["result"] = JsonPrimitive("error")
                    out["code"] = JsonPrimitive(e.code)
                }
            }
            "discover" -> out["result"] = JsonPrimitive(
                when (client.discover()) {
                    is DiscoveryResult.Ok -> "ok"
                    DiscoveryResult.NotFound -> "not-found"
                    is DiscoveryResult.Invalid -> "invalid"
                    is DiscoveryResult.Error -> "error"
                },
            )
            "sync" -> {
                val r = client.sync(force = args["force"].boolValue == true)
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
            "activate", "enroll" -> {
                val r = if (action == "activate") client.activate(args["key"].stringValue ?: "") else client.enroll()
                out["result"] = JsonPrimitive(activationKind(r))
                // PX-W8: the refusal link, exactly as served; null when the result carries none.
                if (r is ActivationResult.DeviceLimit) out["manageUrl"] = r.manageUrl?.let { JsonPrimitive(it) } ?: JsonNull
            }
            "deactivate" -> client.deactivate()
            "register" -> out["result"] = JsonPrimitive(
                when (client.register()) {
                    is RegisterResult.Ok -> "ok"
                    RegisterResult.RegistrationClosed -> "registration-closed"
                    RegisterResult.RateLimited -> "rate-limited"
                    RegisterResult.NotConfigured -> "not-configured"
                    is RegisterResult.Error -> "error"
                },
            )
            "report" -> out["result"] = JsonPrimitive(client.report())
            "fetchSchema" -> out["catalog"] = client.config.fetchSchema()?.let { JsonText.parse(it.toString(Charsets.UTF_8)) } ?: JsonNull
            "mintToken" -> try {
                val minted = client.config.mintToken(args["recipeId"].stringValue ?: "")
                out["result"] = JsonPrimitive("ok")
                out["token"] = JsonPrimitive(minted.token)
                out["expiresAt"] = jsonInt(minted.expiresAt)
            } catch (e: PolarisException) {
                out["result"] = JsonPrimitive(e.code)
            }
            "beginSignIn" -> {
                val p = client.identity.beginSignIn(args["deviceName"].stringValue)
                session.prompt = p
                out["prompt"] = JsonObject(
                    mapOf(
                        "userCode" to JsonPrimitive(p.userCode),
                        "verificationUri" to JsonPrimitive(p.verificationUri),
                        "verificationUriComplete" to JsonPrimitive(p.verificationUriComplete),
                        "expiresIn" to jsonInt(p.expiresIn),
                        "interval" to jsonInt(p.interval),
                    ),
                )
            }
            "pollSignIn" -> {
                val prompt = session.prompt ?: throw AssertionError("pollSignIn before beginSignIn")
                when (val poll = client.identity.pollSignIn(prompt)) {
                    SignInPoll.Pending -> out["result"] = JsonPrimitive("pending")
                    is SignInPoll.SlowDown -> {
                        out["result"] = JsonPrimitive("slow-down")
                        out["interval"] = jsonInt(poll.interval)
                    }
                    SignInPoll.Ready -> out["result"] = JsonPrimitive("ready")
                    SignInPoll.Expired -> out["result"] = JsonPrimitive("expired")
                    is SignInPoll.Error -> out["result"] = JsonPrimitive("error")
                }
            }
            "waitForSignIn" -> {
                val prompt = session.prompt ?: throw AssertionError("waitForSignIn before beginSignIn")
                out["result"] = JsonPrimitive(
                    when (client.identity.waitForSignIn(prompt)) {
                        SignInResult.Ready -> "ready"
                        SignInResult.Expired -> "expired"
                        is SignInResult.Error -> "error"
                    },
                )
            }
            "changelog" -> try {
                out["entries"] = JsonArray(client.release.changelog().map(::entryValue))
                out["result"] = JsonPrimitive("ok")
            } catch (e: PolarisException) {
                out["result"] = JsonPrimitive("error")
                out["code"] = JsonPrimitive(e.code)
            }
            "commerceBinding" -> try {
                val b = client.commerce.binding()
                out["result"] = JsonPrimitive("ok")
                out["bindingId"] = JsonPrimitive(b.bindingId)
                out["products"] = JsonArray(
                    b.products.map {
                        JsonObject(
                            mapOf(
                                "store" to JsonPrimitive(it.store), "productId" to JsonPrimitive(it.productId),
                                "flag" to JsonPrimitive(it.flag), "deliverable" to JsonPrimitive(it.deliverable),
                            ),
                        )
                    },
                )
            } catch (e: PolarisException) {
                out["result"] = JsonPrimitive(e.code)
            }
            "commerceClaim" -> {
                val payload = args["payload"].objectValue?.mapValues { it.value.stringValue ?: it.value.toString() } ?: emptyMap()
                when (val r = client.commerce.claim(args["store"].stringValue ?: "", payload)) {
                    is ClaimResult.Ok -> {
                        out["result"] = JsonPrimitive("ok")
                        out["flag"] = r.flag?.let { JsonPrimitive(it) } ?: JsonNull
                        out["state"] = r.state?.let { JsonPrimitive(it) } ?: JsonNull
                        out["granted"] = JsonPrimitive(r.granted)
                    }
                    is ClaimResult.NotOwned -> {
                        out["result"] = JsonPrimitive(r.code)
                        out["reason"] = JsonPrimitive(CommerceClient.NOT_OWNED)
                    }
                    ClaimResult.AttestationRequired -> out["result"] = JsonPrimitive("attestation_required")
                    is ClaimResult.Refused -> {
                        out["result"] = JsonPrimitive(r.code)
                        out["reason"] = r.reason?.let { JsonPrimitive(it) } ?: JsonNull
                    }
                    is ClaimResult.Error -> out["result"] = JsonPrimitive(r.code)
                }
            }
            "installUrl" -> out["url"] = JsonPrimitive(client.release.installUrl())
            "downloadUrl" -> out["url"] = JsonPrimitive(
                client.release.downloadUrl(
                    version = args["version"].stringValue ?: "",
                    binary = args["binary"].stringValue ?: "",
                    arch = args["arch"].stringValue ?: "",
                    checksum = args["checksum"].boolValue == true,
                    dmg = args["dmg"].boolValue == true,
                ),
            )
            else -> throw AssertionError("the Kotlin replayer has no mapping for \"$action\" (a later slice adds it)")
        }
        out["services"] = JsonObject(client.capabilities().entries.associate { it.key.slug to JsonPrimitive(it.value) })
        out["licenseStatus"] = JsonPrimitive(client.status().status.wire)
        out["tokenHeld"] = JsonPrimitive(store.getToken() != null)
        return out
    }

    /** `initial.update.outlet`: a kind, or `{id, kind, subkind?}`. */
    private fun hostOutlet(v: JsonElement?): HostOutlet? = when {
        v == null || v is JsonNull -> null
        v is JsonPrimitive && v.isString -> HostOutlet.Kind(v.content)
        v is JsonObject -> HostOutlet.Outlet(v["id"].stringValue!!, v["kind"].stringValue!!, v["subkind"].stringValue)
        else -> throw AssertionError("initial.update.outlet is not an outlet")
    }

    /** A changelog entry in the transcript's JSON vocabulary (null ⇒ `null`). */
    private fun entryValue(e: ChangelogEntry): JsonElement = JsonObject(
        mapOf(
            "version" to JsonPrimitive(e.version), "tag" to JsonPrimitive(e.tag),
            "date" to (e.date?.let { JsonPrimitive(it) } ?: JsonNull),
            "summary" to (e.summary?.let { JsonPrimitive(it) } ?: JsonNull),
            "url" to JsonPrimitive(e.url),
        ),
    )

    private fun activationKind(r: ActivationResult): String = when (r) {
        is ActivationResult.Ok -> "ok"
        is ActivationResult.DeviceLimit -> "device-limit"
        ActivationResult.Unauthorized -> "unauthorized"
        ActivationResult.FingerprintRequired -> "fingerprint-required"
        is ActivationResult.HardwareMismatch -> "hardware-mismatch"
        ActivationResult.EnrollDisabled -> "enroll-disabled"
        ActivationResult.EnrollClaimed -> "enroll-claimed"
        ActivationResult.LicenseDisabled -> "license-disabled"
        ActivationResult.LicenseExpired -> "license-expired"
        ActivationResult.AttestationRequired -> "attestation-required"
        is ActivationResult.RateLimited -> "rate-limited"
        is ActivationResult.Refused -> "refused"
        is ActivationResult.Error -> "error"
    }

    /** Replay [t] step by step; throws on the first step whose traffic or outcome disagrees. */
    fun replay(t: Transcript) = runBlocking {
        val server = ReplayServer(t)
        var clock = t.now
        val store = InMemoryStore(t.product, t.initial["deviceId"].stringValue!!)
        t.initial["token"].stringValue?.let { store.setToken(it) }
        val u = t.initial["update"].objectValue
        u?.get("cache").objectValue?.let { cache ->
            fun strings(k: String) = cache[k].objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()
            store.writeCache(CacheRecord(feeds = strings("feeds"), releaseRecords = strings("releaseRecords")))
        }
        val services = (t.initial["services"]?.arrayValue?.map { it.stringValue!! } ?: if (u != null) listOf("release", "distribution", "update") else null)
            ?.mapNotNull { ServiceSlug.of(it) }
        val installed = u?.get("installed").objectValue
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = t.product, baseUrl = t.baseUrl,
                    version = installed?.get("version").stringValue ?: t.initial["version"].stringValue!!,
                    pinnedKeys = t.trust, store = store, transport = server, requestTimeoutSeconds = 0.0,
                    expectedServices = services, clock = { clock },
                ),
                license = LicenseClientOptions(fingerprintSource = replayFingerprint),
                update = u?.let {
                    UpdateClientOptions(
                        pinnedReleaseKeys = it["pinnedReleaseKeys"]!!.obj.mapValues { e -> e.value.stringValue!! },
                        outlet = hostOutlet(it["outlet"]),
                        buildNumber = installed?.get("buildNumber").stringValue,
                        format = installed?.get("format").stringValue,
                        methods = it["methods"]?.arrayValue?.map { m -> m.stringValue!! } ?: listOf(BinaryMethod.download),
                        binaryVersion = installed?.get("binaryVersion").stringValue,
                        engine = installed?.get("engine").stringValue,
                        platform = it["platform"].stringValue,
                        arch = it["arch"].stringValue,
                    )
                },
            ),
        )
        val session = ReplaySession()
        try {
            t.steps.forEachIndexed { i, _ ->
                val step = server.beginStep(i)
                clock = step["now"].longValue ?: t.now
                val observed = act(client, store, step, session, ReplayPackObjectTransport(server))
                server.endStep()
                for ((key, want) in step["expect"]!!.obj.entries.sortedBy { it.key }) {
                    val got = observed[key]
                    if (got == null || !jsonEquals(want, got)) {
                        throw AssertionError("${t.id} step $i (${step["action"].stringValue}): $key: expected $want, got $got")
                    }
                }
            }
        } finally {
            client.close()
        }
    }
}

class TranscriptTest : ConformanceSuite() {
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
        for (id in REQUIRED) {
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
        // SP-K05 implemented commerce.receipt: the commerce transcript now applies.
        assertTrue(Transcript.applies(transcripts.first { it.id == "commerce-claim" }, statuses))
        // P6-08 implemented update.decide and update.feed: the update transcripts now apply.
        assertTrue(Transcript.applies(transcripts.first { it.id == "update-record-by-hash" }, statuses))
        assertTrue(Transcript.applies(transcripts.first { it.id == "update-feed-rollback" }, statuses))
    }

    /** The update transcripts are held as tightly: an `UpdateCheck` member that disagrees fails. */
    @Test
    fun aDoctoredUpdateDecisionFails() {
        assertReplayFails(transcripts.first { it.id == "update-feed-rollback" }.withExpect(0, "channel", JsonPrimitive("latest")), "step 0 (updateDecide): channel")
        assertReplayFails(transcripts.first { it.id == "update-record-by-hash" }.withExpect(1, "record", JsonPrimitive("network")), "step 1 (updateDecide): record")
    }

    /** `packs-chunk-range` passes only when the SDK reads the exact run: a recorded `Content-Range`
     *  altered to another range must be refused, so the step fails (keys are compared in sorted
     *  order, so the first to fail is `bytes`: a refused fetch returns none). */
    @Test
    fun aChunkRangeWithAnotherContentRangeFails() {
        val t = transcripts.first { it.id == "packs-chunk-range" }.doctor(1) { items ->
            for (i in items.indices) {
                val item = items[i].obj
                val response = item["response"]!!.obj
                val headers = JsonObject(response["headers"]!!.obj + ("content-range" to JsonPrimitive("bytes 17-40/64")))
                items[i] = JsonObject(item + ("response" to JsonObject(response + ("headers" to headers))))
            }
        }
        assertReplayFails(t, "step 1 (chunkRange): bytes: expected \"ghijklmnopqrstuvwxyzABCD\", got null")
    }

    @Test
    fun aDoctoredSignInPromptFails() {
        val t = transcripts.first { it.id == "devicecode-happy" }
            .withExpect(2, "interval", JsonPrimitive(5))
        assertReplayFails(t, "step 2 (pollSignIn): interval")
    }

    @Test
    fun aDoctoredMintCacheFails() {
        // Step 1 reuses the token minted at step 0 with no request; a recording that expects one fails.
        val t = transcripts.first { it.id == "edge-mint" }
        val withRequest = t.doctor(1) { items -> items.add(t.steps[0]["exchanges"]!!.obj["items"]!!.arrayValue!![0]) }
        assertReplayFails(withRequest, "expected request not sent: GET /djdl/config/mint/transcript-token/token")
    }

    @Test
    fun aDoctoredActivationBodyFails() {
        // The activation body is the fingerprint and nothing else (allowedKeys); one extra key fails.
        val t = transcripts.first { it.id == "activate-enroll-deactivate" }.doctor(0) { items ->
            for (i in items.indices) {
                if (!path(items[i]).endsWith("/license/activate")) continue
                val item = items[i].obj
                val request = item["request"]!!.obj
                val body = request["body"]!!.obj
                val doctored = JsonObject(body + ("allowedKeys" to JsonArray(listOf(JsonPrimitive("nothing")))))
                items[i] = JsonObject(item + ("request" to JsonObject(request + ("body" to doctored))))
            }
        }
        assertReplayFails(t, "body: key \"fingerprint\" is not allowed")
    }

    companion object {
        /** Every transcript this SDK's implemented rows make applicable (P6-06, P6-07 and P6-08). */
        val REQUIRED = listOf(
            "discovery-capabilities", "discovery-failure", "sync-etag-304", "sync-errors",
            "activate-enroll-deactivate", "config-schema-fetch", "devicecode-expired", "devicecode-happy",
            "edge-mint", "register-open", "register-reregister-401", "release-changelog",
            "release-changelog-entitled", "telemetry-report",
            // P6-08: the v4 update decision.
            "update-feed-rollback", "update-record-by-hash",
            // P4-32: the chunk-bundle Range + If-Range fetch.
            "packs-chunk-range",
            // SP-K05: the commerce bridge.
            "commerce-claim",
        )
    }
}
