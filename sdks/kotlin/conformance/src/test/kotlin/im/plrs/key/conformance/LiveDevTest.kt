// The SP-41 live lane for Kotlin: the quickstart as an app applies it, run against a real `pkey dev`.
//
// Nothing here is scripted. The client is the SDK's own PolarisKeyClient, built from the PolarisConfig.kt that
// `pkey sdk --lang kotlin --dev --url <origin> --write` generated (Gradle compiles that file into this source set)
// and sent over its real OkHttp transport. b1 to b5 are the five outcomes of the acceptance item "each SDK's
// quickstart reaches first activation, every refusal kind exactly as the deployed Worker answers it, a config change
// event, device-code sign-in and an update decision", in its order; b0 checks the config they all start from.
//
//   b0  the generated config is the running server's: origin, product, trust pins, release keys, services
//   b1  first activation: the quickstart's gate, `activate`, and a licence the pinned keys verified
//   b2  every outcome the seven seeded keys give, each the way the Worker answers it
//   b3  a config change event, after the dev server's public config route and a sync
//   b4  device-code sign-in: beginSignIn, the harness approver, pollSignIn and waitForSignIn
//   b5  an update decision before and after a release published through the dev server's release route
//
// The harness plays what a person or an operator would do: the approver (`node $PKEY_DEV_APPROVE <verification URL>
// <user code>`) is the person at the sign-in page, and `POST /__dev/config` and `POST /__dev/release` the operator's
// console. Everything the SDK itself does goes through the SDK.
//
// Environment, set by the CI lane (see conformance/build.gradle.kts): PKEY_DEV_BASE_URL, PKEY_DEV_CONFIG and
// PKEY_DEV_APPROVE. Without them every test skips, except on CI, where a lane that forgot them fails.
//
// Run it on a fresh `pkey dev`. A licence admits a few key entries (three on `pkey dev`); a device that does not hold
// its seat spends one by taking it, and entries are never given back. So the paths that succeed use one device per
// role, the same in every test and on every run on this machine, and a refusal comes from a device nobody has seen,
// which costs nothing. The tests never deactivate, so rerunning against the same server spends no further entries;
// only the activation rate limit (30 a minute) bounds how fast.

package im.plrs.key.conformance

import im.plrs.key.config.ConfigSource
import im.plrs.key.core.ActivationSource
import im.plrs.key.core.DeviceId
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.HostOutlet
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.OkHttpTransport
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.Semver
import im.plrs.key.core.Store
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.action
import im.plrs.key.core.storeNamespace
import im.plrs.key.identity.SignInPoll
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.isUsable
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters

/** The installed build the quickstart is given; the update test installs the newest release instead. */
private const val APP_VERSION = "1.0.0"

/** A catalog key of the built-in Tidewater product, and the one the config test changes. */
private const val CONFIG_KEY = "render.quality"

/** The seven keys `pkey dev` seeds, by the state each puts its licence in. */
private val SEEDED_KEYS = setOf("ok", "expired", "disabled", "revoked", "device-limit-full", "key-entry-limit", "floating")

/** Where a device identity with no platform anchor to come from starts: made once, so a run keeps it. */
private val RUN_ID = UUID.randomUUID().toString()

@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class LiveDevTest : ConformanceSuite() {
    private lateinit var live: Live
    private val devices = CopyOnWriteArrayList<Device>()

    @Before
    fun connect() {
        val missing = missingEnv()
        assumeTrue("no live pkey dev: ${missing.joinToString()} not set. $HOW_TO_RUN", missing.isEmpty())
        live = Live.open()
    }

    @After
    fun releaseDevices() {
        try {
            for (device in devices) {
                assertEquals("requests that left the dev origin", emptyList<String>(), device.transport.strays.toList())
            }
        } finally {
            devices.forEach { it.release() }
            devices.clear()
        }
    }

    // ── b0 ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun b0_theGeneratedConfigIsTheServers() {
        val info = live.server.info()
        val quickstart = live.quickstart
        assertEquals(live.origin, info.string("baseUrl"))
        assertEquals(live.origin, quickstart.baseUrl)
        assertEquals(info.string("product"), quickstart.productSlug)
        assertEquals(info.obj("trust").strings("pinnedKeys"), quickstart.pinnedKeys)
        assertEquals(info.strings("releaseKeys"), quickstart.pinnedReleaseKeys)
        assertEquals(info.array("services").toSet(), quickstart.expectedServices.toSet())
        assertEquals(SEEDED_KEYS, info.strings("keys").keys)

        // What the quickstart hands the app: the same facts, with the update client pinned to the release keys.
        val options = quickstart.clientOptions(APP_VERSION)
        assertEquals(live.origin, options.core.baseUrl)
        assertEquals(APP_VERSION, options.core.version)
        assertEquals(quickstart.pinnedKeys, options.core.pinnedKeys)
        assertEquals(quickstart.pinnedReleaseKeys, options.update?.pinnedReleaseKeys)

        // A dev origin never shares stored state with production's: its namespace is not the bare product slug.
        val namespace = storeNamespace(quickstart.productSlug, live.origin)
        assertTrue("the dev origin's state namespace is $namespace", namespace.startsWith("${quickstart.productSlug}@"))
    }

    // ── b1 ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun b1_firstActivation() = scenario {
        val device = device("ok")
        val client = device.client
        // The quickstart, as written: `if (!isUsable(client.status())) client.license.activateWithKey(userEnteredKey)`.
        assertFalse("a new install is not usable", isUsable(client.status()))
        assertEquals(LicenseStatus.needsActivation, client.status().status)
        activate(client, "ok")

        // The licence the Worker signed verified under the pins the generated config carries.
        assertTrue(isUsable(client.status()))
        assertEquals(LicenseStatus.ok, client.status().status)
        assertEquals(ActivationSource.token, client.license.activation())
        assertNotNull(client.license.getLicenseId())
        assertTrue("the ok licence carries exportPro", client.entitlements.has("exportPro"))
        assertTrue(device.transport.sent.any { it.startsWith("POST ${live.origin}/${live.quickstart.productSlug}/license/activate") })
    }

    // ── b2 ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun b2_everyOutcomeTheSeededKeysGive() = scenario {
        // The two keys that activate. `floating` is a bulk key with no account behind it.
        val floating = device("floating")
        activate(floating.client, "floating")
        assertEquals(LicenseStatus.ok, floating.client.status().status)

        // The Worker does not say why an expired, disabled or revoked key is refused: all three get one answer.
        for (state in listOf("expired", "disabled", "revoked")) {
            val result = refused(state)
            assertEquals("$state: $result", ActivationResult.Unauthorized, result)
            assertEquals(ErrorCode.unauthorized, result.code)
        }

        // Another device holds every seat of the licence. How many, and where to free one, are the host's to show
        // and not part of what the Worker promises, so only the kind of refusal is asserted.
        val full = refused("device-limit-full")
        assertTrue("device-limit-full: $full", full is ActivationResult.DeviceLimit)
        assertEquals(ErrorCode.deviceLimit, full.code)

        // The licence has used every key entry its product allows: no result of its own, the server's code.
        val entries = refused("key-entry-limit")
        assertTrue("key-entry-limit: $entries", entries is ActivationResult.Refused)
        entries as ActivationResult.Refused
        assertEquals(ErrorCode.keyEntryLimit, entries.code)
        assertEquals(403, entries.status)
    }

    // ── b3 ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun b3_configChangeEvent() = scenario {
        val client = device("ok").client
        activate(client, "ok")
        client.sync()

        // A value other than the one in force, so a rerun against the same server still changes something.
        val next = JsonPrimitive(if (client.config.get(CONFIG_KEY, JsonPrimitive("draft")) == JsonPrimitive("high")) "standard" else "high")

        // Listening before the change, on the multi-subscriber stream a UI layer reads.
        val event = CompletableDeferred<PolarisEvent.Config>()
        val listener = launch(start = CoroutineStart.UNDISPATCHED) {
            event.complete(client.events.filterIsInstance<PolarisEvent.Config>().first { it.change.key == CONFIG_KEY && it.change.value == next })
        }
        // Signed documents carry whole-second timestamps: one issued in the same second is not newer.
        delay(1_100)
        val answer = live.server.control(
            "config",
            buildJsonObject {
                put("name", CONFIG_KEY)
                put("value", next)
                put("key", "ok")
            },
        )
        assertEquals(true, answer["ok"]?.jsonPrimitive?.content?.toBoolean())
        client.sync()

        val change = withTimeout(10.seconds) { event.await() }.change
        listener.cancel()
        assertEquals(CONFIG_KEY, change.key)
        assertEquals(next, change.value)
        assertEquals(ConfigSource.enforced, change.source)
        assertEquals(next, client.config.get(CONFIG_KEY, JsonPrimitive("draft")))
    }

    // ── b4 ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun b4_deviceCodeSignIn() = scenario {
        val client = device("signin").client
        val prompt = client.identity.beginSignIn("Kotlin live test")
        assertTrue("the sign-in page is the dev server's: ${prompt.verificationUriComplete}", prompt.verificationUriComplete.startsWith("${live.origin}/"))
        assertTrue(prompt.userCode.isNotEmpty())
        assertNull(client.core.token())

        // Nobody has approved yet.
        assertEquals(SignInPoll.Pending, client.identity.pollSignIn(prompt))

        approve(prompt)

        assertEquals(SignInResult.Ready, withTimeout(60.seconds) { client.identity.waitForSignIn(prompt) })
        assertNotNull("the sign-in stored a device token", client.core.token())
        assertEquals(ActivationSource.token, client.license.activation())

        // The licence it brought is the signed-in person's: the fake identity provider's, named in the signed document.
        assertEquals(LicenseStatus.ok, client.status().status)
        val person = live.server.info().obj("idp").obj("person")
        val profile = client.getSyncState().doc?.profile
        assertEquals(person.string("name"), profile?.name)
        assertEquals(person.string("email"), profile?.email)
    }

    // ── b5 ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun b5_updateDecisionBeforeAndAfterARelease() = scenario {
        // The installed build is the newest stable release, so nothing is newer until one is published.
        val published = live.server.info().array("releases").map { it.jsonObject }
        val newest = published.filter { it.string("channel") == "stable" }.map { it.string("version") }.maxWithOrNull(Semver::compare)!!
        val client = device("ok", newest).client
        activate(client, "ok")

        val before = client.update.decide(channel = "latest")
        assertEquals("the alias latest is the stable channel", "stable", before.channel)
        assertEquals("up to date: ${before.decision}", "none", before.decision.action)
        assertEquals(emptyList<Any>(), before.errors)

        val parsed = Semver.parse(newest)!!
        val release = "${parsed.major}.${parsed.minor + 1}.0"
        val answer = live.server.control(
            "release",
            buildJsonObject {
                put("version", release)
                put("channel", "stable")
            },
        )
        assertEquals(true, answer["ok"]?.jsonPrimitive?.content?.toBoolean())

        val after = client.update.decide(channel = "latest")
        val decision = after.decision
        assertTrue("a newer stable release is offered, got $decision", decision is UpdateDecision.Binary)
        decision as UpdateDecision.Binary
        assertEquals(release, decision.release.version)
        assertEquals(emptyList<Any>(), after.errors)
    }

    // ── plumbing ─────────────────────────────────────────────────────────────────────────────

    /** One test body: a coroutine in real time, bounded. */
    private fun scenario(block: suspend CoroutineScope.() -> Unit) = runBlocking { withTimeout(120.seconds) { block() } }

    private fun key(state: String): String = live.keys.getValue(state)

    /** [client] takes the seeded key [state], which must activate it. */
    private suspend fun activate(client: PolarisKeyClient, state: String) {
        val result = client.license.activateWithKey(key(state))
        assertTrue("the $state key activates, got $result", result is ActivationResult.Ok)
    }

    /**
     * A device with nothing stored yet, on the quickstart's options. A [role] names the identity of a device that
     * succeeds (see the header); without one the device is new to the server, as a refusal's must be.
     */
    private suspend fun device(role: String? = null, version: String = APP_VERSION): Device {
        val dir = Files.createTempDirectory("pkey-live-kotlin-")
        val transport = DevTransport(OkHttpTransport(), live.origin)
        val quickstart = live.quickstart.clientOptions(version)
        val namespace = storeNamespace(quickstart.core.productSlug, quickstart.core.baseUrl)
        // A store with no platform anchor: the platform would give every device on this machine one id.
        val store = OwnDeviceStore(FileStore(namespace, dir.toFile()))
        val identity = if (role == null) UUID.randomUUID().toString() else "pkey-live-kotlin:$role:${DeviceId.anchored(namespace) ?: RUN_ID}"
        store.replaceDeviceId(DeviceId.fromRaw(namespace, identity))
        val options = quickstart.copy(
            core = quickstart.core.copy(store = store, transport = transport),
            // Tidewater ships one macOS universal zip, so a JVM on any host asks as that build's platform.
            update = quickstart.update?.copy(outlet = HostOutlet.Kind("direct"), format = "zip", platform = "macos"),
        )
        return Device(PolarisKeyClient.create(options), transport, dir).also { devices += it }
    }

    /** A new device's attempt with [state]'s key: the answer, and the device left as it was. */
    private suspend fun refused(state: String): ActivationResult {
        val client = device().client
        val result = client.license.activateWithKey(key(state))
        assertFalse("$state must not activate", result is ActivationResult.Ok)
        assertEquals(LicenseStatus.needsActivation, client.status().status)
        assertNull(client.license.activation())
        return result
    }

    /** The person at the verification page, as the harness plays them. */
    private suspend fun approve(prompt: SignInPrompt) = withContext(Dispatchers.IO) {
        val log = Files.createTempFile("pkey-dev-approve-", ".log")
        try {
            val process = ProcessBuilder("node", live.approve.absolutePath, prompt.verificationUriComplete, prompt.userCode)
                .redirectErrorStream(true)
                .redirectOutput(log.toFile())
                .start()
            if (!process.waitFor(60, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                fail("${live.approve.name} did not finish within 60 s: ${Files.readString(log)}")
            }
            assertEquals("${live.approve.name} answered: ${Files.readString(log)}", 0, process.exitValue())
        } finally {
            Files.deleteIfExists(log)
        }
    }

    companion object {
        private val LIVE_ENV = listOf("PKEY_DEV_BASE_URL", "PKEY_DEV_CONFIG", "PKEY_DEV_APPROVE")
        private const val HOW_TO_RUN =
            "Start `pkey dev --auto-approve`, write its quickstart with `pkey sdk --lang kotlin --dev --url <origin> --write`, " +
                "and run `./gradlew :conformance:liveDevTest` with PKEY_DEV_BASE_URL, PKEY_DEV_CONFIG and PKEY_DEV_APPROVE set."

        private fun missingEnv(): List<String> = LIVE_ENV.filter { System.getenv(it).isNullOrBlank() }

        /** On CI a lane that forgot its server fails once, loudly, and does not pass by skipping every test. */
        @BeforeClass
        @JvmStatic
        fun aCiLaneNamesItsServer() {
            val missing = missingEnv()
            if (missing.isNotEmpty() && System.getProperty("pkey.liveDev.require") == "true") {
                fail("CI must run the live suite against a server, but ${missing.joinToString()} not set. $HOW_TO_RUN")
            }
        }
    }
}

/** What the lane names. */
private class Live private constructor(
    val origin: String,
    val server: DevServer,
    val quickstart: Quickstart,
    val approve: File,
    /** The seeded keys, by state, as the server's own info route lists them. */
    val keys: Map<String, String>,
) {
    companion object {
        fun open(): Live {
            val origin = System.getenv("PKEY_DEV_BASE_URL").trim().trimEnd('/')
            val server = DevServer(origin)
            val config = File(System.getenv("PKEY_DEV_CONFIG").trim())
            val approve = File(System.getenv("PKEY_DEV_APPROVE").trim())
            assertTrue("PKEY_DEV_CONFIG is not a file: $config", config.isFile)
            assertTrue("PKEY_DEV_APPROVE is not a file: $approve", approve.isFile)
            return Live(origin, server, Quickstart.of(config), approve, server.info().strings("keys"))
        }
    }
}

/**
 * The generated `PolarisConfig`, through its public surface. Gradle compiled the file the lane named, so a config
 * that no longer compiles against this SDK fails the build; the class is found by the file's own `package` line
 * (the quickstart's `--package`), so any package works.
 */
private class Quickstart private constructor(private val type: Class<*>) {
    private val instance: Any = type.getField("INSTANCE").get(null)

    val productSlug: String = type.getField("PRODUCT_SLUG").get(null) as String
    val baseUrl: String = type.getField("BASE_URL").get(null) as String
    val pinnedKeys: Map<String, String> = getter("getPinnedKeys")
    val pinnedReleaseKeys: Map<String, String> = getter("getPinnedReleaseKeys")
    val expectedServices: List<String> = getter<List<Any>>("getExpectedServices").map { service ->
        service.javaClass.getMethod("getSlug").invoke(service) as String
    }

    /** `PolarisConfig.clientOptions(version)`: what the quickstart passes to `PolarisKeyClient.create`. */
    fun clientOptions(version: String): PolarisKeyClientOptions =
        type.getMethod("clientOptions", String::class.java, String::class.java).invoke(instance, version, null) as PolarisKeyClientOptions

    @Suppress("UNCHECKED_CAST")
    private fun <T> getter(name: String): T = type.getMethod(name).invoke(instance) as T

    companion object {
        fun of(file: File): Quickstart {
            val pkg = Regex("""(?m)^package\s+([A-Za-z_][\w.]*)""").find(file.readText())?.groupValues?.get(1)
            assertNotNull("${file.path} declares no package", pkg)
            val type = try {
                Class.forName("$pkg.PolarisConfig")
            } catch (e: ClassNotFoundException) {
                throw AssertionError("$pkg.PolarisConfig is not on the test classpath: run through Gradle with PKEY_DEV_CONFIG set, which compiles ${file.path} in", e)
            }
            return Quickstart(type)
        }
    }
}

/** What the harness may ask of a running `pkey dev` itself: its info page and its public control routes. */
private class DevServer(private val origin: String) {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    fun info(): JsonObject = send("GET", "/__dev/info", null)

    /** `POST /__dev/<command>`, with the header the server asks of any caller that is not a web page. */
    fun control(command: String, body: JsonObject): JsonObject = send("POST", "/__dev/$command", body)

    private fun send(method: String, path: String, body: JsonObject?): JsonObject {
        val request = HttpRequest.newBuilder(URI.create(origin + path)).timeout(Duration.ofSeconds(30))
        if (body == null) {
            request.GET()
        } else {
            request.header("x-pkey-dev", "1").header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString()))
        }
        val response = http.send(request.build(), HttpResponse.BodyHandlers.ofString())
        assertEquals("$method $path answered ${response.body()}", 200, response.statusCode())
        return Json.parseToJsonElement(response.body()).jsonObject
    }
}

/**
 * The SDK's real transport with a watch on where it goes: a request that names any origin but the dev server's is
 * refused and recorded, so a test cannot reach production by leaving an option at its default.
 */
private class DevTransport(private val inner: OkHttpTransport, private val origin: String) : PolarisTransport, AutoCloseable {
    val sent = CopyOnWriteArrayList<String>()
    val strays = CopyOnWriteArrayList<String>()

    override suspend fun send(request: PolarisRequest): PolarisResponse {
        sent += "${request.method} ${request.url}"
        if (request.url != origin && !request.url.startsWith("$origin/")) {
            strays += request.url
            throw PolarisException(ErrorCode.transport, "refused: ${request.url} is not the dev server")
        }
        return inner.send(request)
    }

    override fun close() = inner.close()
}

/** A [FileStore] with no platform anchor: the device id it holds is the one it was given. */
private class OwnDeviceStore(files: FileStore) : Store by files {
    override suspend fun anchoredDeviceId(): String? = null
}

/** One install: its client, the transport it sends on and the directory its store keeps. */
private class Device(val client: PolarisKeyClient, val transport: DevTransport, private val dir: Path) {
    /** Stops the client's threads and removes its store. The seat it holds stays with the server, which is thrown away. */
    fun release() {
        client.close()
        dir.toFile().deleteRecursively()
    }
}

private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content

private fun JsonObject.obj(name: String): JsonObject = getValue(name).jsonObject

private fun JsonObject.array(name: String): JsonArray = getValue(name).jsonArray

private fun JsonObject.strings(name: String): Map<String, String> = obj(name).mapValues { it.value.jsonPrimitive.content }

private fun JsonArray.toSet(): Set<String> = map { it.jsonPrimitive.content }.toSet()
