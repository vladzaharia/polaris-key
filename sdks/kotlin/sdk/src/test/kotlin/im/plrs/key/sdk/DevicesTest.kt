// @pkey-feature devices.manage devices.facts devices.report devices.register
//
// The device principal through the umbrella client: the roster is blended with this device's own
// state (and is this device alone without a credential), rename and deauthorize carry the bearer
// and fail with their own codes, deauthorizing THIS device is a full local deactivation; the
// facts source answers declared probes only; the report body stays inside the Worker's allowlist
// and carries the verified document values and the capability list.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceFacts
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.JvmDeviceFactsSource
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ProbeDeclaration
import im.plrs.key.core.ProbeResult
import im.plrs.key.core.RegisterResult
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Support
import im.plrs.key.core.TokenSource
import im.plrs.key.core.listDevices
import im.plrs.key.core.objectValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DevicesTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()

    private fun client(token: String? = "pkeyt_held", handler: (PolarisRequest) -> PolarisResponse): Triple<PolarisKeyClient, ScriptedTransport, InMemoryStore> =
        runBlocking {
            val store = InMemoryStore("djdl", "dev1")
            token?.let { store.setToken(it) }
            val transport = ScriptedTransport(handler)
            val client = PolarisKeyClient.create(
                PolarisKeyClientOptions(
                    core = CoreOptions(
                        productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                        store = store, transport = transport, clock = { now },
                    ),
                    license = LicenseClientOptions(fingerprint = false),
                    factsSource = { DeviceFacts(DeviceFacts.Os("linux"), DeviceFacts.Hardware(cpuCores = 4), DeviceFacts.Runtime("kotlin", "2.1")) },
                ),
            )
            Triple(client, transport, store)
        }

    @Test
    fun withoutACredentialTheRosterIsThisDeviceAlone() = runBlocking {
        val (client, transport, _) = client(token = null) { respond(500) }
        val devices = client.listDevices()
        assertEquals(1, devices.size)
        assertEquals("dev1", devices[0].id)
        assertTrue(devices[0].current)
        assertEquals(LicenseStatus.needsActivation, devices[0].status)
        assertTrue(transport.requests().isEmpty())
    }

    @Test
    fun theRosterIsBlendedWithThisDevicesOwnState() = runBlocking {
        val roster = """{"devices":[{"id":"dev1","label":"Desk","licenseId":"lic_1"},{"id":"dev2","current":false,"label":"Laptop"},{"label":"no id"}]}"""
        val (client, transport, _) = client { r -> if (r.path == "/djdl/devices") respond(200, roster) else respond(404) }
        val devices = client.listDevices()
        assertEquals(listOf("dev1", "dev2"), devices.map { it.id })
        assertTrue(devices[0].current)
        assertEquals("lic_1", devices[0].licenseId)
        assertFalse(devices[1].current)
        assertEquals(LicenseStatus.ok, devices[1].status) // another device's status is the server's, never invented
        assertEquals("Bearer pkeyt_held", transport.requests().single().headers["authorization"])
    }

    @Test
    fun renameAndDeauthorizeCarryTheBearerAndTheirOwnFailureCodes() = runBlocking {
        val (client, transport, _) = client { r ->
            when ("${r.method} ${r.path}") {
                "PATCH /djdl/devices/dev2", "DELETE /djdl/devices/dev2" -> respond(200, "{}")
                else -> respond(403)
            }
        }
        client.renameDevice("dev2", null)
        client.deauthorizeDevice("dev2")
        val (rename, delete) = transport.requests()
        assertEquals("""{"label":null}""", rename.body!!.toString(Charsets.UTF_8))
        assertEquals("Bearer pkeyt_held", rename.headers["authorization"])
        assertEquals("DELETE", delete.method)
        for ((expected, call) in listOf<Pair<String, suspend () -> Unit>>(
            ErrorCode.deviceRenameFailed to { client.renameDevice("dev3", "x") },
            ErrorCode.deviceDeauthorizeFailed to { client.deauthorizeDevice("dev3") },
            ErrorCode.deviceListFailed to { client.core.listDevices() },
        )) {
            try {
                call()
                fail("$expected did not throw")
            } catch (e: PolarisException) {
                assertEquals(expected, e.code)
            }
        }
    }

    @Test
    fun withoutACredentialManagementIsUnsupported() = runBlocking {
        val (client, _, _) = client(token = null) { respond(200, "{}") }
        try {
            client.renameDevice("dev2", "x")
            fail("renamed without a credential")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.deviceManagementUnsupported, e.code)
        }
    }

    @Test
    fun deauthorizingThisDeviceIsAFullDeactivation() = runBlocking {
        val (client, transport, store) = client { respond(200, "{}") }
        client.deauthorizeDevice("dev1")
        assertNull(store.getToken())
        assertEquals("/djdl/license/deauthorize", transport.requests().single().path)
    }

    @Test
    fun registrationStoresTheTokenWithItsSourceAndDoesNotSync() = runBlocking {
        val (client, transport, store) = client(token = null) { r ->
            if (r.path == "/djdl/devices/register") respond(200, """{"token":"pkeyt_reg","deviceId":"dev1"}""") else respond(404)
        }
        assertEquals(RegisterResult.Ok("pkeyt_reg", "dev1"), client.register())
        assertEquals("pkeyt_reg", store.getToken())
        assertEquals(TokenSource.register, client.core.tokenSource())
        val request = transport.requests().single()
        assertFalse("authorization" in request.headers)
        assertNull(request.body) // fingerprinting is off here: no body at all
        val (closed, _, _) = client(token = null) { respond(403) }
        assertEquals(RegisterResult.RegistrationClosed, closed.register())
    }

    @Test
    fun theReportStaysInsideTheAllowlistAndCarriesVerifiedValues() = runBlocking {
        val license = signer.licenseDoc("djdl", "dev1", now, mapOf("polarisVpn" to JsonPrimitive(true)))
        val config = signer.configDoc("djdl", "dev1", now, config = mapOf("ui.theme" to JsonPrimitive("dark")))
        val (client, transport, _) = client { r ->
            when (r.path) {
                "/djdl/license/document" -> respond(200, license)
                "/djdl/config/document" -> respond(200, config)
                "/djdl/devices/report" -> respond(200, """{"ok":true}""")
                else -> respond(404)
            }
        }
        client.sync()
        val body = JsonText.parse(transport.requests().last { it.path == "/djdl/devices/report" }.body!!.toString(Charsets.UTF_8)).objectValue!!
        val allowed = setOf(
            "os", "hardware", "runtime", "locale", "timezone", "probes", "sdk", "sdkVersion", "appVersion", "platform", "arch",
            "gate", "config", "entitlements", "timestamp", "engine", "outlet", "content", "updates", "caps", "packInstalls",
        )
        assertTrue(body.keys.toString(), allowed.containsAll(body.keys))
        assertEquals(JsonPrimitive("dark"), body["config"]!!.objectValue!!["ui.theme"])
        assertEquals(JsonPrimitive(true), body["entitlements"]!!.objectValue!!["polarisVpn"])
        assertEquals(JsonPrimitive("linux"), body["os"]!!.objectValue!!["name"])
        assertTrue(body["caps"].toString().contains(Feature.licenseGate))
        assertTrue(client.report())
        assertTrue(client.supports(Feature.devicesReport) is Support.Supported)
    }

    @Test
    fun theJvmFactsSourceAnswersDeclaredProbesOnly() {
        val dir = Files.createTempDirectory("pkey-probe").toFile()
        val present = File(dir, "Companion.app").also { it.mkdirs() }
        val absent = File(dir, "Missing.app")
        val facts = JvmDeviceFactsSource.collect(
            listOf(
                ProbeDeclaration("here", macos = present.path, linux = present.path, windows = present.path),
                ProbeDeclaration("gone", macos = absent.path, linux = absent.path, windows = absent.path),
                ProbeDeclaration("android-only", android = "com.example.companion"),
            ),
        )
        assertEquals(mapOf("here" to ProbeResult(true), "gone" to ProbeResult(false)), facts.probes)
        assertTrue(facts.os.name in setOf("darwin", "win32", "linux"))
        assertEquals("kotlin", facts.runtime.name)
        assertTrue((facts.hardware.cpuCores ?: 0) >= 1)
        val json = facts.toJson()
        assertEquals(setOf("os", "hardware", "runtime", "locale", "timezone", "probes").containsAll(json.keys), true)
        // No probes declared, no `probes` member.
        assertNull(JvmDeviceFactsSource.collect(emptyList()).toJson()["probes"])
        dir.deleteRecursively()
    }
}
