// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode config.mint
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
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
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

/** The replay's memory between steps: the prompt the last `beginSignIn` returned. */
class ReplaySession {
    var prompt: SignInPrompt? = null
}

object KotlinReplay {
    /** THE mapping from transcript verbs and `expect` keys onto the Kotlin SDK. */
    suspend fun act(client: PolarisKeyClient, store: InMemoryStore, step: JsonObject, session: ReplaySession): Map<String, JsonElement> {
        val out = LinkedHashMap<String, JsonElement>()
        val args = step["args"]!!.obj
        when (val action = step["action"].stringValue) {
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
            "activate" -> out["result"] = JsonPrimitive(activationKind(client.activate(args["key"].stringValue ?: "")))
            "enroll" -> out["result"] = JsonPrimitive(activationKind(client.enroll()))
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
        is ActivationResult.Error -> "error"
    }

    /** Replay [t] step by step; throws on the first step whose traffic or outcome disagrees. */
    fun replay(t: Transcript) = runBlocking {
        val server = ReplayServer(t)
        var clock = t.now
        val store = InMemoryStore(t.product, t.initial["deviceId"].stringValue!!)
        t.initial["token"].stringValue?.let { store.setToken(it) }
        val services = t.initial["services"]?.arrayValue?.mapNotNull { ServiceSlug.of(it.stringValue) }
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = t.product, baseUrl = t.baseUrl, version = t.initial["version"].stringValue!!,
                    pinnedKeys = t.trust, store = store, transport = server, requestTimeoutSeconds = 0.0,
                    expectedServices = services, clock = { clock },
                ),
                license = LicenseClientOptions(fingerprintSource = replayFingerprint),
            ),
        )
        val session = ReplaySession()
        try {
            t.steps.forEachIndexed { i, _ ->
                val step = server.beginStep(i)
                clock = step["now"].longValue ?: t.now
                val observed = act(client, store, step, session)
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
        // commerce.receipt stays planned and unowned (as in Swift); the update transcripts are P6-08's.
        assertFalse(Transcript.applies(transcripts.first { it.id == "commerce-claim" }, statuses))
        assertFalse(Transcript.applies(transcripts.first { it.id == "update-record-by-hash" }, statuses))
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
        /** Every transcript this SDK's implemented rows make applicable (P6-06 and P6-07). */
        val REQUIRED = listOf(
            "discovery-capabilities", "discovery-failure", "sync-etag-304", "sync-errors",
            "activate-enroll-deactivate", "config-schema-fetch", "devicecode-expired", "devicecode-happy",
            "edge-mint", "register-open", "register-reregister-401", "release-changelog",
            "release-changelog-entitled", "telemetry-report",
        )
    }
}
