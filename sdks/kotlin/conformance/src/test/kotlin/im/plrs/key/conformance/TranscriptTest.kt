// @pkey-feature sync.settings
// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode identity.devicelabel identity.toggle config.mint
// @pkey-feature update.feed release.record update.decide
// @pkey-feature packs.apply.chunk commerce.receipt
// @pkey-feature license.refusals telemetry.updates release.fetch release.distribution ui.boot
// @pkey-feature license.manage identity.keyentry
// @pkey-feature core.presentation identity.account identity.attach
// @pkey-feature identity.redirect.web identity.signin.hints identity.choice connect.identity connect.relay
// @pkey-feature identity.exchange sync.keyring sync.settings
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
// `activate`/`enroll` also report the refusal's registry `code` (license.refusals). `report` reports
// `updatesPending`, the journalled update events still held; `initial.updateJournal` seeds that
// journal as an earlier run left it (`update-events.json` in the store's state directory).
// `releaseFetch` is `client.release.fetch` of a `ReleaseTarget.Record` built from the step's target
// (the record a host verified), into a fresh directory; `partial` seeds the interrupted download an
// earlier call would have left (the payload's first bytes in `<to>.part` and the build route's ETag,
// the quoted SHA-256, beside it), so the SDK resumes with Range and If-Range. `downloadModel` is
// `client.distribution.thisPlatform(initial.platform)`.
//
// `discover` also reports `presentation`, the member `client.presentation()` exposes after it (null
// when the document carries none: the client drops what it showed rather than keep a stale one).
//
// `chunkRange` (P4-32, plans/P4-32.md §5) is `chunkRangeFetch` over the packs facet's own object
// fetch (`client.packs`'s private `fetchObject`, reached by reflection as the Node replayer reaches
// its own through a cast: no public API changes), against the blobs template the last discover
// returned, with the replay server behind the `PackObjectTransport` seam
// (`ReplayPackObjectTransport`, as `ReplayServer` is behind `PolarisTransport`).

package im.plrs.key.conformance

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DevicePublicKeys
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.sdk.ConnectOptions
import im.plrs.key.sdk.KeyringOptions
import im.plrs.key.sdk.RelayException
import im.plrs.key.core.DiscoveryResult
import im.plrs.key.core.DocOutcome
import im.plrs.key.core.FingerprintSource
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.ERROR_CODE_VALUES
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.ReleaseRecordArtifact
import im.plrs.key.core.ReleaseRecordBuild
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.Store
import im.plrs.key.core.PolarisException
import im.plrs.key.sdk.ClientBootOptions
import im.plrs.key.sdk.boot
import im.plrs.key.core.RegisterResult
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.identity.AttachResult
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.ConsentInput
import im.plrs.key.identity.ExchangeKind
import im.plrs.key.identity.ExchangeNonce
import im.plrs.key.identity.ExchangeOutcome
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.ConformanceReplayOnly
import im.plrs.key.identity.RedirectEntropy
import im.plrs.key.identity.redirectAcquisitionSync
import im.plrs.key.identity.redirectEntropy
import im.plrs.key.identity.SignInChannel
import im.plrs.key.identity.SignInPurpose
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.SignOutResult
import im.plrs.key.identity.SubjectResult
import im.plrs.key.identity.SignInSession
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.core.JsonText
import im.plrs.key.release.ChangelogEntry
import im.plrs.key.release.DownloadBuild
import im.plrs.key.release.ReleaseTarget
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

/** The replay's memory between steps: the session the last `beginSignIn` started, the last whole
 *  `releaseFetch` payload, the scratch directories to remove and the device's `initial.platform`. */
class ReplaySession(val platform: String? = null) {
    /** The fixture device keys behind `client.connect` and the label they were last set to. */
    val keys = FixtureKeyPort()
    var keyLabel: String? = null

    /** The ring id of the first ring this conversation created (`keyringAdopt` adopts its root). */
    var firstRingId: String? = null
    var prompt: SignInSession? = null

    /** Cloud Sync's replay memory (U-07.K11): the last pull's ETag, the next mutation id, the header tap and the codec. */
    var syncEtag: String = ""
    var syncNextId: Int = 1
    var tap: HeaderTap? = null

    /** The host codec over a fixture root of its own (`cloudsync-e2e-settings`). */
    var codec: FixtureSyncCodec? = null

    /** The SDK clock of the step being replayed (seconds), for an action that reports a time left. */
    var now: Long = 0
    var payload: ByteArray? = null
    val dirs = ArrayList<java.io.File>()
}

/**
 * The fixture device keys of a label (format.ts, `connectIdentity`) as a key port: the Ed25519 seed is
 * SHA-256(label), the agreement key's 32 bytes are SHA-256(label + ":agree") with the top bit of the last
 * byte clear. The agreement key has no private half here (identity needs none), so `dh` answers null.
 * Test-only; [use] with another label is a key rotation.
 */
class FixtureKeyPort : DeviceKeyPort {
    private var seed = ByteArray(32)
    private var keys = DevicePublicKeys("", "", 1)

    fun use(label: String) {
        val sha = java.security.MessageDigest.getInstance("SHA-256")
        seed = sha.digest(label.toByteArray(Charsets.UTF_8))
        val agree = sha.digest("$label:agree".toByteArray(Charsets.UTF_8))
        agree[31] = (agree[31].toInt() and 0x7f).toByte()
        val pub = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        keys = DevicePublicKeys(Base64Url.encode(pub), Base64Url.encode(agree), 1)
    }

    override suspend fun ensure(): DevicePublicKeys = keys
    override suspend fun publicKeys(): DevicePublicKeys? = keys
    override suspend fun sign(message: ByteArray): ByteArray = com.google.crypto.tink.subtle.Ed25519Sign(seed).sign(message)
    override suspend fun dh(peerPublic: ByteArray): ByteArray? = null
    override suspend fun rotate(): DevicePublicKeys = keys
    override suspend fun wipe() {}
}

/** An in-memory store with a state directory, for a transcript that seeds the update journal. */
class ReplayStore(inner: InMemoryStore, override val stateDirectory: java.io.File?) : Store by inner

object KotlinReplay {
    /** THE mapping from transcript verbs and `expect` keys onto the Kotlin SDK. */
    @OptIn(ConformanceReplayOnly::class)
    suspend fun act(
        client: PolarisKeyClient,
        store: Store,
        step: JsonObject,
        session: ReplaySession,
        objects: PackObjectTransport? = null,
        server: ReplayServer? = null,
    ): Map<String, JsonElement> {
        val out = LinkedHashMap<String, JsonElement>()
        val args = step["args"]!!.obj
        when (val action = step["action"].stringValue) {
            "cloudSyncPull", "cloudSyncPush" -> CloudSyncReplay.run(client.core, step, session, out)
            "browser" -> if (server?.transcript?.id == "cloudsync-cors") {
                CloudSyncReplay.cors(client.core, step, session.tap ?: throw AssertionError("no header tap"))
            } else {
                // The browser's half is the recording's; the SDK's half is the authorize URL it builds for the
                // request the Worker answered with a 303 to the card.
                val replay = server ?: throw AssertionError("browser without a replay server")
                val authorize = step["exchanges"]!!.obj["items"]!!.arrayValue!!.map { it.obj }.firstOrNull {
                    val r = it["request"]!!.obj
                    r["method"].stringValue == "GET" && (it["response"]!!.obj["status"] as JsonPrimitive).content == "303" &&
                        r["path"].stringValue!!.contains("/identity/authorize?")
                }
                if (authorize != null) {
                    val started = redirectSession(client, args, replay.transcript)
                    val want = replay.transcript.baseUrl + authorize["request"]!!.obj["path"].stringValue
                    if (started.authorizeUrl != want) {
                        replay.recordFailure("authorize URL differs from the recording:\n    want $want\n    got  ${started.authorizeUrl}")
                    }
                }
                replay.serveBrowserExchanges()
                // Facts the recorder read off the browser's pages; nothing of the SDK's.
                for ((key, value) in step["expect"]!!.obj) out[key] = value
            }
            "redirectComplete" -> {
                val s = redirectSession(client, args, server?.transcript)
                try {
                    when (val o = s.complete(args["callbackUrl"].stringValue ?: "")) {
                        is SignInOutcome.SignedIn -> {
                            out["result"] = JsonPrimitive("ok")
                            out["scope"] = o.scope?.let { JsonPrimitive(it) } ?: JsonNull
                            out["subject"] = o.subject?.let { JsonPrimitive(it) } ?: JsonNull
                            out["licenseId"] = o.licenseId?.let { JsonPrimitive(it) } ?: JsonNull
                        }
                        is SignInOutcome.Choose -> out["result"] = JsonPrimitive("choose")
                        SignInOutcome.Cancelled -> out["result"] = JsonPrimitive("cancelled")
                        else -> out["result"] = JsonPrimitive("error")
                    }
                } catch (e: SignInError) {
                    out["result"] = JsonPrimitive(redirectResult(e.code))
                    out["code"] = JsonPrimitive(e.code)
                } catch (e: PolarisException) {
                    out["result"] = JsonPrimitive("error")
                    out["code"] = JsonPrimitive(e.code)
                }
            }
            "choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel" -> {
                // The grant routes (I-10b.19): `client.identity.choice.*`, a refusal being a result.
                val grant = args["grant"].stringValue ?: ""
                val choice = client.identity.choice
                var refused: ChoiceResult.Refused? = null
                when (action) {
                    "choiceLicenses" -> when (val r = choice.licenses(grant)) {
                        is ChoiceResult.Ok -> {
                            out["state"] = JsonPrimitive(r.value.state)
                            out["licenses"] = JsonArray(r.value.licenseIds.map { JsonPrimitive(it) })
                        }
                        is ChoiceResult.Refused -> refused = r
                    }
                    "choiceDevices" -> when (val r = choice.devices(grant, args["licenseId"].stringValue ?: "")) {
                        is ChoiceResult.Ok -> out["devices"] = JsonArray(r.value.deviceIds.map { JsonPrimitive(it) })
                        is ChoiceResult.Refused -> refused = r
                    }
                    "choiceComplete" -> {
                        // The step's own `choice` arg, else the one the recording's request carries; a recording with
                        // none is the Worker's 409 `license_choice_required`, sent as recorded (no `choice`).
                        val recorded = args["choice"].objectValue
                            ?: step["exchanges"]!!.obj["items"]!!.arrayValue!!.firstOrNull()?.obj?.get("request")?.obj
                                ?.get("body").objectValue?.get("json").objectValue?.get("choice").objectValue
                        // The consent the person gave rides the same request (identity.exchange, confirm).
                        val consent = step["exchanges"]!!.obj["items"]!!.arrayValue!!.firstOrNull()?.obj?.get("request")?.obj
                            ?.get("body").objectValue?.get("json").objectValue?.get("consent").objectValue
                            ?.get("claims")?.arrayValue?.map { it.stringValue!! }?.let { ConsentInput(it) }
                        val r = if (consent != null) choice.complete(grant, recorded?.let { LicenseChoice.fromJson(it)!! }, consent)
                        else if (recorded == null) choice.completeRecorded(grant, null) else choice.complete(grant, LicenseChoice.fromJson(recorded)!!)
                        when (r) {
                            is ChoiceResult.Ok -> {
                                out["licenseId"] = r.value.licenseId?.let { JsonPrimitive(it) } ?: JsonNull
                                out["subject"] = JsonPrimitive(r.value.subject)
                                out["scope"] = JsonPrimitive(r.value.scope)
                                r.value.keyEntries?.let { out["keyEntries"] = JsonObject(mapOf("used" to jsonInt(it.used), "limit" to jsonInt(it.limit))) }
                            }
                            is ChoiceResult.Refused -> refused = r
                        }
                    }
                    else -> when (val r = choice.cancel(grant)) {
                        is ChoiceResult.Ok -> Unit
                        is ChoiceResult.Refused -> refused = r
                    }
                }
                out["result"] = JsonPrimitive(if (refused != null) "refused" else "ok")
                refused?.let { out["code"] = JsonPrimitive(it.code) }
            }
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
            "discover" -> {
                out["result"] = JsonPrimitive(
                    when (client.discover()) {
                        is DiscoveryResult.Ok -> "ok"
                        DiscoveryResult.NotFound -> "not-found"
                        is DiscoveryResult.Invalid -> "invalid"
                        is DiscoveryResult.Error -> "error"
                    },
                )
                // core.presentation: the member the client now exposes (null when it went away).
                out["presentation"] = client.presentation()?.toJson() ?: JsonNull
                // identity.exchange: the Identity fragment's `exchange` member and nonce route.
                client.core.discoveryDocument()?.let { doc ->
                    val identity = doc.services[ServiceSlug.identity]
                    out["exchange"] = if (identity?.enabled == true) identity.extras["exchange"] ?: JsonNull else JsonNull
                    out["nonceEndpoint"] = JsonPrimitive(identity?.enabled == true && identity.endpoints["nonce"] != null)
                }
            }
            // `client.identity.exchange` (I-45.3, `identity.exchange`): a platform ID token for a device token. A step with
            // no `nonce` asks for its own (the recordings do); one with a `nonce` spends that recorded one. A refusal is thrown.
            "exchange" -> {
                val label = args["keyLabel"].stringValue!!
                if (session.keyLabel != label) {
                    session.keys.use(label)
                    session.keyLabel = label
                }
                client.identity.useDeviceKeys(session.keys)
                // `tokenHeld` is whether this step stored a device token (an earlier step's stays in the store).
                val before = store.getToken()
                val kind = ExchangeKind.entries.first { it.wire == args["kind"].stringValue }
                // A step that dials nothing (the product offers no exchange) carries no token; the SDK never reads it.
                val subject = args["subjectToken"].stringValue ?: "not-a-token"
                try {
                    val outcome = args["nonce"].stringValue?.let { client.identity.exchange(kind, subject, ExchangeNonce(it)) }
                        ?: client.identity.exchangeWithFreshNonce(kind, subject)
                    when (outcome) {
                        is ExchangeOutcome.SignedIn -> {
                            out["result"] = JsonPrimitive("ok")
                            out["scope"] = JsonPrimitive(outcome.scope)
                            out["issuedTokenType"] = outcome.issuedTokenType?.let { JsonPrimitive(it) } ?: JsonNull
                            out["licenseId"] = outcome.licenseId?.let { JsonPrimitive(it) } ?: JsonNull
                        }
                        is ExchangeOutcome.PendingConsent -> {
                            out["result"] = JsonPrimitive("confirm")
                            out["firstTime"] = JsonPrimitive(outcome.consent.firstTime)
                            out["changed"] = JsonPrimitive(outcome.consent.changed)
                            out["as"] = JsonObject(
                                mapOf(
                                    "provider" to (outcome.consent.asProvider?.let { JsonPrimitive(it) } ?: JsonNull),
                                    "email" to (outcome.consent.asEmail?.let { JsonPrimitive(it) } ?: JsonNull),
                                ),
                            )
                        }
                        is ExchangeOutcome.PendingSignIn -> out["result"] = JsonPrimitive("choose")
                        is ExchangeOutcome.NeedsSignIn -> {
                            out["result"] = JsonPrimitive("interstitial-required")
                            out["reason"] = JsonPrimitive(outcome.reason)
                            out["url"] = outcome.url?.let { JsonPrimitive(it) } ?: JsonNull
                            out["linkHandle"] = outcome.linkHandle?.let { JsonPrimitive(it) } ?: JsonNull
                            out["expiresIn"] = outcome.expiresInSeconds?.let { JsonPrimitive(it) } ?: JsonNull
                        }
                        is ExchangeOutcome.Unavailable -> out["result"] = JsonPrimitive("unavailable")
                    }
                } catch (e: PolarisException) {
                    out["result"] = JsonPrimitive("refused")
                    out["code"] = JsonPrimitive(e.code)
                }
                out["tokenHeld"] = JsonPrimitive(store.getToken().let { it != null && it != before })
            }
            // `client.connect` (CC-06.4, `connect.identity`): the identity and the device list.
            "connectIdentity", "connectDevices" -> {
                val label = args["keyLabel"].stringValue!!
                if (session.keyLabel != label) {
                    // A different label is a different key pair: the next call registers it.
                    session.keys.use(label)
                    session.keyLabel = label
                }
                try {
                    if (action == "connectIdentity") {
                        val id = client.connect.identity(refresh = args["refresh"].boolValue == true)
                        out["result"] = JsonPrimitive("ok")
                        out["epoch"] = jsonInt(id.epoch)
                        out["devices"] = JsonArray(id.devices.map { JsonPrimitive(it.deviceId) })
                        out["deviceId"] = JsonPrimitive(id.deviceId)
                        out["discKeys"] = jsonInt(if (client.connect.discoveryKeys()?.previous != null) 2 else 1)
                    } else {
                        out["result"] = JsonPrimitive("ok")
                        out["devices"] = JsonArray(
                            client.connect.listDevices().map { d ->
                                JsonObject(
                                    mapOf(
                                        "deviceId" to JsonPrimitive(d.deviceId),
                                        "label" to (d.label?.let { JsonPrimitive(it) } ?: JsonNull),
                                        "platform" to (d.platform?.let { JsonPrimitive(it) } ?: JsonNull),
                                        "lastSeen" to (d.lastSeen?.let { jsonInt(it) } ?: JsonNull),
                                        "self" to JsonPrimitive(d.self),
                                    ),
                                )
                            },
                        )
                    }
                } catch (e: PolarisException) {
                    if (e.unsupported != null) {
                        out["result"] = JsonPrimitive("unavailable")
                    } else {
                        out["result"] = JsonPrimitive("refused")
                        out["code"] = JsonPrimitive(e.code)
                    }
                }
            }
            // The key ring verbs (U-39.9, `sync.keyring`) over `client.keyring`. The transcripts hold no key material
            // the client could use, so the client makes its own: create and reset draw a root, wrap seals it to a
            // fresh agreement key for the named device (`deviceId` is the TARGET), and adopt takes the root of the
            // first ring this conversation created. A refusal reads as `refused` with the status and the code.
            "keyringGet", "keyringCreate", "keyringReset", "keyringWrap", "keyringUnwrap", "keyringAdopt",
            "keyringRecoverySet", "keyringRecoveryGet",
            -> keyring(client, step, session, out)
            // `client.connect.relayTicket()` (CC-12.4, `connect.relay`). A refusal reads as `result: "refused"`
            // with the status, the Worker's code and, where it answers them, `retryAfter` and `scope`.
            "relayTicket" -> {
                try {
                    val g = client.connect.relayTicket()
                    out["result"] = JsonPrimitive("ok")
                    out["protocol"] = JsonPrimitive(g.protocol)
                    out["url"] = JsonPrimitive(g.url)
                    out["expiresIn"] = jsonInt(g.expiresAt - session.now)
                } catch (e: PolarisException) {
                    out["result"] = JsonPrimitive("refused")
                    out["status"] = e.httpStatus?.let { jsonInt(it.toLong()) } ?: JsonNull
                    out["code"] = JsonPrimitive(e.code)
                    e.retryAfterSeconds?.let { out["retryAfter"] = jsonInt(it.toLong()) }
                    (e as? RelayException)?.scope?.let { out["scope"] = JsonPrimitive(it.name) }
                }
            }
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
                val r = if (action == "activate") client.license.activateWithKey(args["key"].stringValue ?: "") else client.enroll()
                out["result"] = JsonPrimitive(activationKind(r))
                r.code?.let { out["code"] = JsonPrimitive(it) }
                // PX-W8: the refusal link, exactly as served; null when the result carries none.
                if (r is ActivationResult.DeviceLimit) out["manageUrl"] = r.manageUrl?.let { JsonPrimitive(it) } ?: JsonNull
                if (r is ActivationResult.KeyEntryLimit) out["manageUrl"] = r.manageUrl?.let { JsonPrimitive(it) } ?: JsonNull
                // identity.keyentry: the count the answer carried, null when it carried none.
                val entries = when (r) {
                    is ActivationResult.Ok -> r.keyEntries
                    is ActivationResult.KeyEntryLimit -> r.keyEntries
                    else -> null
                }
                if (r is ActivationResult.Ok || r is ActivationResult.KeyEntryLimit) {
                    out["keyEntries"] = entries?.let { JsonObject(mapOf("used" to jsonInt(it.used), "limit" to jsonInt(it.limit))) } ?: JsonNull
                }
            }
            "releaseFetch" -> out.putAll(releaseFetch(client, args, session))
            "downloadModel" -> {
                val here = client.distribution.thisPlatform(session.platform)
                out["result"] = JsonPrimitive("ok")
                out["platforms"] = JsonArray(here.model.platforms.map { JsonPrimitive(it.platform) })
                out["current"] = here.current?.let { c ->
                    JsonObject(
                        mapOf(
                            "platform" to JsonPrimitive(c.platform), "label" to JsonPrimitive(c.label),
                            "primary" to (c.primary?.let { JsonPrimitive(it) } ?: JsonNull),
                            "actions" to JsonArray(c.actions.map { JsonPrimitive(it) }),
                            "builds" to JsonArray(c.builds.map(::buildValue)),
                        ),
                    )
                } ?: JsonNull
            }
            "deactivate" -> client.deactivate()
            // SP-20: the one-call boot, to its first stop (no delayed launch confirmation in a replay).
            "boot" -> out["bootOutcome"] = JsonPrimitive(client.boot(ClientBootOptions(autoConfirm = false)).outcome.wire)
            "register" -> out["result"] = JsonPrimitive(
                when (client.register()) {
                    is RegisterResult.Ok -> "ok"
                    RegisterResult.RegistrationClosed -> "registration-closed"
                    RegisterResult.RateLimited -> "rate-limited"
                    RegisterResult.NotConfigured -> "not-configured"
                    is RegisterResult.Error -> "error"
                },
            )
            "report" -> {
                out["result"] = JsonPrimitive(client.report())
                out["updatesPending"] = JsonPrimitive(client.updateEvents.events().size)
            }
            "fetchSchema" -> out["catalog"] = client.config.fetchSchema()?.let { JsonText.parse(it.toString(Charsets.UTF_8)) } ?: JsonNull
            "mintToken" -> try {
                val minted = client.config.mintToken(args["recipeId"].stringValue ?: "")
                out["result"] = JsonPrimitive("ok")
                out["token"] = JsonPrimitive(minted.token)
                out["expiresAt"] = jsonInt(minted.expiresAt)
            } catch (e: PolarisException) {
                out["result"] = JsonPrimitive(e.code)
            }
            // D-6: the recorded action names map onto the session (`signIn.start`, `wait`).
            "beginSignIn" -> try {
                val p = client.identity.signIn.start(SignInOptions(deviceName = args["deviceName"].stringValue))
                session.prompt = p
                out["prompt"] = JsonObject(
                    mapOf(
                        "userCode" to JsonPrimitive(p.userCode),
                        "verificationUri" to JsonPrimitive(p.verificationUri),
                        "verificationUriComplete" to JsonPrimitive(p.verificationUriComplete),
                        "expiresIn" to jsonInt(p.expiresIn),
                        "interval" to jsonInt(p.interval),
                        "deviceName" to (p.deviceName?.let { JsonPrimitive(it) } ?: JsonNull),
                    ),
                )
            } catch (e: PolarisException) {
                // identity-disabled: the refusal is the step's result.
                out["result"] = JsonPrimitive(e.code)
            }
            "pollSignIn" -> {
                val sess = session.prompt ?: throw AssertionError("pollSignIn before beginSignIn")
                try {
                    when (val o = sess.wait(once = true)) {
                        is SignInOutcome.Pending -> if (o.slowDown) {
                            out["result"] = JsonPrimitive("slow-down")
                            out["interval"] = jsonInt(o.interval)
                        } else out["result"] = JsonPrimitive("pending")
                        is SignInOutcome.SignedIn -> out["result"] = JsonPrimitive("ready")
                        SignInOutcome.Expired -> out["result"] = JsonPrimitive("expired")
                        SignInOutcome.Cancelled -> out["result"] = JsonPrimitive("cancelled")
                        is SignInOutcome.Choose -> out["result"] = JsonPrimitive("choose")
                    }
                } catch (e: SignInError) {
                    out["result"] = JsonPrimitive("error")
                    out["code"] = JsonPrimitive(e.code)
                } catch (e: PolarisException) {
                    // I-37d: no answer or a 5xx on the poll is transient; a wait loop keeps polling.
                    if (e.code != "server-error" && e.code != "network-error") throw e
                    out["result"] = JsonPrimitive("transient")
                    out["code"] = JsonPrimitive(e.code)
                }
            }
            // identity.account: the subject the device reports (null for a key-only device), and the sign-out.
            "subject" -> out["subject"] = when (val r = client.identity.subject()) {
                is SubjectResult.Subject -> JsonPrimitive(r.subject)
                SubjectResult.None -> JsonNull
                SubjectResult.Unavailable -> JsonPrimitive("unavailable")
            }
            "signOut" -> when (val r = client.identity.signOut()) {
                is SignOutResult.SignedOut -> out["released"] = JsonPrimitive(r.released)
                SignOutResult.Unavailable -> out["result"] = JsonPrimitive("unavailable")
            }
            // identity.attach: the preview, the confirm, and the typed refusals.
            "attach" -> when (val r = client.identity.attach(args["confirm"].boolValue == true)) {
                is AttachResult.Confirm -> {
                    out["result"] = JsonPrimitive("confirm")
                    out["license"] = JsonObject(
                        mapOf(
                            "id" to JsonPrimitive(r.license.id),
                            "tierId" to (r.license.tierId?.let { JsonPrimitive(it) } ?: JsonNull),
                            "name" to (r.license.name?.let { JsonPrimitive(it) } ?: JsonNull),
                        ),
                    )
                }
                is AttachResult.Ok -> {
                    out["result"] = JsonPrimitive("ok")
                    out["attached"] = r.attached?.let { JsonPrimitive(it) } ?: JsonNull
                    out["subject"] = r.subject?.let { JsonPrimitive(it) } ?: JsonNull
                }
                is AttachResult.Refused -> {
                    out["result"] = JsonPrimitive("refused")
                    out["code"] = JsonPrimitive(r.code)
                }
                AttachResult.Unavailable -> out["result"] = JsonPrimitive("unavailable")
            }
            "waitForSignIn" -> {
                val sess = session.prompt ?: throw AssertionError("waitForSignIn before beginSignIn")
                try {
                    when (val done = sess.wait()) {
                        is SignInOutcome.SignedIn -> out["result"] = JsonPrimitive("ready")
                        else -> out["result"] = JsonPrimitive(done.kind)
                    }
                } catch (e: SignInError) {
                    out["result"] = JsonPrimitive("error")
                    out["code"] = JsonPrimitive(e.code)
                }
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
        // The `exchange` verb reports its own: whether that step stored a token.
        out.putIfAbsent("tokenHeld", JsonPrimitive(store.getToken() != null))
        return out
    }

    /** The recorder's constants for a redirect conversation (`packages/worker/test/transcripts`). */
    private const val RECORDED_STATE = "tidewater-state-0123456789"
    private const val RECORDED_VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private const val RECORDED_REDIRECT = "https://app.example/auth/callback"

    /** A redirect session the way the step's `args` ask for one: the recorded `state` and verifier (a step may name its own), the hints it carries, the recorded redirect URI. */
    @OptIn(ConformanceReplayOnly::class)
    private suspend fun redirectSession(client: PolarisKeyClient, args: JsonObject, transcript: Transcript?): SignInSession {
        client.identity.redirectEntropy = RedirectEntropy(
            args["state"].stringValue ?: RECORDED_STATE, args["codeVerifier"].stringValue ?: RECORDED_VERIFIER,
        )
        return client.identity.signIn.start(
            SignInOptions(
                channel = SignInChannel.Redirect, redirectUri = args["redirectUri"].stringValue ?: RECORDED_REDIRECT,
                loginHint = args["loginHint"].stringValue, nameHint = args["nameHint"].stringValue,
                purpose = SignInPurpose.entries.firstOrNull { it.wire == args["purpose"].stringValue },
                // The recorded authorize request asked the app to show the licence choice.
                licenseChoice = if (transcript?.asksAppChoice() == true) "app" else null,
            ),
        )
    }

    private fun Transcript.asksAppChoice(): Boolean = steps.any { st ->
        st["exchanges"]!!.obj["items"]!!.arrayValue!!.any { it.obj["request"]!!.obj["path"].stringValue?.contains("license_choice=app") == true }
    }

    /** `redirectComplete`'s `result` for a refusal's code (`format.ts`). */
    private fun redirectResult(code: String): String = when (code) {
        "invalid_grant", "invalid_request", "invalid_client", "license_choice_required", "rate_limited" -> code.replace('_', '-')
        else -> "error"
    }

    /** `initial.update.outlet`: a kind, or `{id, kind, subkind?}`. */
    private fun hostOutlet(v: JsonElement?): HostOutlet? = when {
        v == null || v is JsonNull -> null
        v is JsonPrimitive && v.isString -> HostOutlet.Kind(v.content)
        v is JsonObject -> HostOutlet.Outlet(v["id"].stringValue!!, v["kind"].stringValue!!, v["subkind"].stringValue)
        else -> throw AssertionError("initial.update.outlet is not an outlet")
    }

    /** A download-page build in the model's JSON vocabulary (null ⇒ `null`). */
    private fun buildValue(b: DownloadBuild): JsonElement {
        fun str(v: String?): JsonElement = v?.let { JsonPrimitive(it) } ?: JsonNull
        return JsonObject(
            mapOf(
                "releaseId" to str(b.releaseId), "version" to JsonPrimitive(b.version), "buildId" to JsonPrimitive(b.buildId),
                "platform" to JsonPrimitive(b.platform), "arch" to JsonPrimitive(b.arch), "format" to str(b.format),
                "name" to JsonPrimitive(b.name), "size" to (b.size?.let { jsonInt(it) } ?: JsonNull), "sha256" to str(b.sha256),
                "minOs" to str(b.minOs), "url" to JsonPrimitive(b.url), "outletId" to JsonPrimitive(b.outletId),
            ),
        )
    }

    /** `releaseFetch`: the build of a record built from the step's target, into a fresh directory. */
    private suspend fun releaseFetch(client: PolarisKeyClient, args: JsonObject, session: ReplaySession): Map<String, JsonElement> {
        val sha = args["sha256"].stringValue!!
        val size = args["size"].longValue!!
        val buildId = args["build"].stringValue!!
        val record = ReleaseRecordDoc(
            schemaVersion = 1, aud = client.core.product, deliverable = "app", kind = "app", version = args["version"].stringValue!!,
            seq = 1, issuedAt = 1, tag = null,
            builds = listOf(
                ReleaseRecordBuild(buildId, args["platform"].stringValue!!, args["arch"].stringValue!!, "tar.gz", artifacts = listOf(ReleaseRecordArtifact("payload", "payload", sha, size))),
            ),
            json = JsonObject(emptyMap()),
        )
        val dir = java.nio.file.Files.createTempDirectory("pkey-replay").toFile().also { session.dirs += it }
        val to = java.io.File(dir, "payload")
        val partial = args["partial"].longValue
        if (partial != null && partial > 0) {
            val whole = session.payload ?: throw AssertionError("a partial releaseFetch needs an earlier whole fetch")
            java.io.File(dir, "payload.part").writeBytes(whole.copyOfRange(0, partial.toInt()))
            java.io.File(dir, "payload.part.etag").writeText("\"$sha\"")
        }
        return try {
            val got = client.release.fetch(ReleaseTarget.Record(record, buildId), to)
            val data = got.path.readBytes()
            session.payload = data
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
            mapOf("result" to JsonPrimitive("ok"), "size" to jsonInt(data.size.toLong()), "sha256" to JsonPrimitive(digest))
        } catch (e: PolarisException) {
            mapOf("result" to JsonPrimitive(if (e.code in ERROR_CODE_VALUES) "refused" else "error"), "code" to JsonPrimitive(e.code))
        }
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
        is ActivationResult.KeyEntryLimit -> "key-entry-limit"
        // Recorded as a plain refusal carrying `code: license_owned` (keyentry-owned).
        is ActivationResult.LicenseOwned -> "refused"
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

    /** The key ring verbs of [act]; see there. */
    private suspend fun keyring(
        client: PolarisKeyClient,
        step: JsonObject,
        session: ReplaySession,
        out: MutableMap<String, JsonElement>,
    ) {
        val k = client.keyring
        val action = step["action"].stringValue
        val args = step["args"]!!.obj
        try {
            when (action) {
                "keyringGet" -> {
                    val r = k.read()
                    out["ring"] = r.ring?.let { g ->
                        JsonObject(
                            mapOf(
                                "ringId" to JsonPrimitive(g.ringId), "epoch" to jsonInt(g.epoch.toLong()), "rootKid" to JsonPrimitive(g.rootKid),
                                "state" to JsonPrimitive(g.state), "recoverySet" to JsonPrimitive(g.recoverySet),
                                "previous" to (g.previous?.let { JsonPrimitive(it.ringId) } ?: JsonNull),
                                "adopted" to JsonArray(g.adopted.map { JsonPrimitive(it.ringId) }),
                            ),
                        )
                    } ?: JsonNull
                    out["wrap"] = r.wrap?.let { w ->
                        JsonObject(
                            mapOf(
                                "epoch" to jsonInt(w.epoch.toLong()), "kid" to JsonPrimitive(w.kid),
                                "by" to (w.by?.let { JsonPrimitive(it) } ?: JsonNull),
                            ),
                        )
                    } ?: JsonNull
                }
                "keyringCreate", "keyringReset" -> {
                    val made = if (action == "keyringCreate") k.create() else k.reset()
                    if (action == "keyringCreate" && session.firstRingId == null) session.firstRingId = made.ringId
                    // The ring id is the client's own draw and the recording's is a fixture: both must be a well
                    // formed id, and the replay reports the recorded one when ours is.
                    val ok = Regex("^rg_[A-Za-z0-9_-]{22}$").matches(made.ringId)
                    out["ringId"] = if (ok) (step["expect"]!!.obj["ringId"] ?: JsonPrimitive(made.ringId)) else JsonPrimitive(made.ringId)
                    out["epoch"] = jsonInt(made.epoch.toLong())
                }
                "keyringWrap" -> k.wrapTo(args["deviceId"].stringValue ?: "", DeviceKeyStore(InMemoryDeviceKeyStorage()).ensure().agreeKey)
                "keyringUnwrap" -> k.removeWrap(args["deviceId"].stringValue ?: "")
                "keyringAdopt" -> k.adopt(session.firstRingId ?: "")
                "keyringRecoverySet" -> k.setRecoveryCode()
                else -> out["ct"] = JsonPrimitive(k.recoveryBlob().ct)
            }
            out["result"] = JsonPrimitive("ok")
        } catch (e: PolarisException) {
            out["result"] = JsonPrimitive("refused")
            e.httpStatus?.let { out["status"] = jsonInt(it.toLong()) }
            out["code"] = JsonPrimitive(e.code)
        }
    }

    /** Replay [t] step by step; throws on the first step whose traffic or outcome disagrees. */
    fun replay(t: Transcript) = runBlocking {
        val server = ReplayServer(t)
        var clock = t.now
        val memory = InMemoryStore(t.product, t.initial["deviceId"].stringValue!!)
        val journal = t.initial["updateJournal"]?.arrayValue
        val stateDir = journal?.let { events ->
            java.nio.file.Files.createTempDirectory("pkey-replay-state").toFile().also { d ->
                java.io.File(d, "update-events.json").writeText(JsonObject(mapOf("v" to jsonInt(1), "events" to JsonArray(events))).toString())
            }
        }
        val store: Store = if (stateDir != null) ReplayStore(memory, stateDir) else memory
        t.initial["token"].stringValue?.let { store.setToken(it) }
        val u = t.initial["update"].objectValue
        u?.get("cache").objectValue?.let { cache ->
            fun strings(k: String) = cache[k].objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap()
            store.writeCache(CacheRecord(feeds = strings("feeds"), releaseRecords = strings("releaseRecords")))
        }
        // The redirect conversations ride a product that runs Identity (their discovery names it).
        val redirects = t.id != "cloudsync-cors" && t.steps.any { it["action"].stringValue in setOf("browser", "redirectComplete") }
        val services = (
            t.initial["services"]?.arrayValue?.map { it.stringValue!! }
                ?: if (u != null) listOf("release", "distribution", "update") else if (redirects) listOf("license", "config", "identity") else null
            )
            ?.mapNotNull { ServiceSlug.of(it) }
        val installed = u?.get("installed").objectValue
        val session = ReplaySession(t.initial["platform"].stringValue)
        val tap = HeaderTap(server)
        session.tap = tap
        if (t.id == "cloudsync-e2e-settings") session.codec = FixtureSyncCodec(CloudSyncReplay.root)
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                connect = ConnectOptions(deviceKeys = session.keys, state = InMemoryDeviceKeyStorage()),
                // The key ring's own device keys and root storage: memory only, nothing touches a file or a keystore.
                keyring = KeyringOptions(keys = DeviceKeyStore(InMemoryDeviceKeyStorage()), rootStorage = InMemoryDeviceKeyStorage()),
                core = CoreOptions(
                    productSlug = t.product, baseUrl = t.baseUrl,
                    version = installed?.get("version").stringValue ?: t.initial["version"].stringValue!!,
                    pinnedKeys = t.trust, store = store, transport = tap, requestTimeoutSeconds = 0.0,
                    expectedServices = services, clock = { clock },
                    // PX-W13: `initial.deviceName` stands in for the platform's device name; absent = none.
                    deviceName = t.initial["deviceName"].stringValue ?: "",
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
        // The redirect and platform-exchange recordings hold the token exchange, not the sync a sign-in triggers after it.
        @OptIn(ConformanceReplayOnly::class)
        if (redirects || t.steps.any { it["action"].stringValue == "exchange" }) client.identity.redirectAcquisitionSync = false
        try {
            t.steps.forEachIndexed { i, _ ->
                val step = server.beginStep(i)
                clock = step["now"].longValue ?: t.now
                session.now = clock
                val observed = act(client, store, step, session, ReplayPackObjectTransport(server), server)
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
            session.dirs.forEach { it.deleteRecursively() }
            stateDir?.deleteRecursively()
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
            "activate-enroll-deactivate", "config-schema-fetch", "devicecode-denied", "devicecode-failed", "devicecode-mint-retry", "devicecode-expired", "devicecode-happy",
            // U-07.KF: Cloud Sync (`sync.settings`).
            "cloudsync-account-required", "cloudsync-atomic", "cloudsync-client-mismatch", "cloudsync-conflict",
            "cloudsync-cors", "cloudsync-cursor-expired", "cloudsync-duplicate", "cloudsync-e2e-settings",
            "cloudsync-first-signin", "cloudsync-hlc-clamp", "cloudsync-members", "cloudsync-migrations",
            "cloudsync-open-settings", "cloudsync-paused", "cloudsync-push-pull", "cloudsync-quota",
            "cloudsync-trust",
            // U-39.9: the key ring (`sync.keyring`).
            "keyring-create", "keyring-wrap", "keyring-wrap-read", "keyring-recovery", "keyring-adopt-reset", "keyring-gate-off", "keyring-sync-off",
            "edge-mint", "register-open", "register-reregister-401", "release-changelog",
            "release-changelog-entitled", "telemetry-report",
            // P6-08: the v4 update decision.
            "update-feed-rollback", "update-record-by-hash",
            // P4-32: the chunk-bundle Range + If-Range fetch.
            "packs-chunk-range",
            // SP-K05: the commerce bridge.
            "commerce-claim",
            // SP-K01, SP-K03, SP-K13: typed refusals, update-health events, verified download, the download model.
            "activate-refusals", "telemetry-report-updates", "release-fetch-gated", "distribution-download-model",
            // SP-20: the one-call boot.
            "boot-cold-register",
            // I-10b.15: the account on the device.
            "discovery-identity", "locker-discovery-identity", "identity-subject-signout",
            // I-10b.16: attach.
            "identity-attach", "identity-attach-errors",
            // I-10b.18: the redirect core and the request hints.
            "redirect-web-happy", "redirect-web-errors", "locker-redirect-web", "identity-request-hints",
            // I-10b.19: the licence choice.
            "choice-key-app", "choice-replace-app", "choice-grant-errors",
            // I-45.3: the platform-token exchange.
            "discovery-identity-exchange", "exchange-silent", "exchange-confirm", "exchange-choose", "exchange-no-link",
            "exchange-errors", "exchange-disabled", "exchange-gate-off", "exchange-gate-off-stale",
        )
    }
}
