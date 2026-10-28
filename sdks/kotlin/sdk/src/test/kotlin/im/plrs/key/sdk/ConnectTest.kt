// @pkey-feature connect.identity
//
// `client.connect` (CC-12.1): device keys on first need, registration, the identity fetch, the
// verified roster and certificate, K_disc and its previous-key rule, `listDevices()` and the typed
// refusals. A scripted Worker signs real `pkey-ring+jws` and `pkey-peer+jws` documents with a test
// product key. The corpus rows themselves run in :conformance (PeerCasesTest).

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ConnectTest {
    @get:Rule val tmp = TemporaryFolder()

    private val deviceId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val signer = TestSigner()
    private var now = 1_700_000_000L

    private fun b64(seed: Int) = Base64Url.encode(ByteArray(32) { (seed + it).toByte() })

    /** Another device of the person: a generated pair under a fixed id. */
    private class Other(val deviceId: String, val keys: im.plrs.key.core.DevicePublicKeys)

    private fun other(id: String): Other = runBlocking {
        Other(id, DeviceKeyStore(InMemoryDeviceKeyStorage()).ensure())
    }

    /** The scripted Worker: signs whatever roster it is told to hold. */
    private inner class Worker(val port: () -> DeviceKeyPort) {
        var epoch = 1L
        var others: List<Other> = emptyList()
        var discKeys: List<String> = listOf(b64(1))
        var connectOn = true
        var identityStatus = 200
        var identityCode: String? = null
        var certKeysOverride: Pair<String, String>? = null
        var devicesBody: String? = null
        var keysPuts = 0
        var identityGets = 0
        var lastPut: JsonObject? = null
        var requireKeysOnce = false
        var subject = sub

        fun handle(r: PolarisRequest): PolarisResponse = when {
            r.path.endsWith("/.well-known/polaris.json") -> respond(
                200,
                """{"product":"djdl","services":{"connect":{"enabled":$connectOn,"endpoints":{"identity":"x","devices":"y"}}}}""",
            )
            r.path.endsWith("/devices/keys") -> {
                keysPuts++
                lastPut = JsonText.parseOrNull(r.body!!.toString(Charsets.UTF_8)).objectValue
                respond(200, """{"keySeq":$keysPuts}""")
            }
            r.path.endsWith("/connect/identity") -> {
                identityGets++
                if (requireKeysOnce) {
                    requireKeysOnce = false
                    respond(409, """{"error":{"code":"device_keys_required"}}""")
                } else if (identityStatus != 200) {
                    respond(identityStatus, """{"error":{"code":"$identityCode"}}""")
                } else {
                    runBlocking { identityBody() }
                }
            }
            r.path.endsWith("/connect/devices") -> respond(200, devicesBody ?: """{"devices":[{"deviceId":"$deviceId","label":"Mac","platform":"macos","lastSeen":1700000000,"self":true}]}""")
            else -> respond(404, "")
        }

        suspend fun identityBody(): PolarisResponse {
            val mine = port().ensure()
            val all = (others.map { Triple(it.deviceId, it.keys.signKey, it.keys.agreeKey) } + Triple(deviceId, mine.signKey, mine.agreeKey))
                .sortedBy { it.first }
            val ring = ring(epoch, all, subject)
            val ck = certKeysOverride ?: (mine.signKey to mine.agreeKey)
            val cert = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(subject),
                        "deviceId" to JsonPrimitive(deviceId), "signKey" to JsonPrimitive(ck.first), "agreeKey" to JsonPrimitive(ck.second),
                        "ringEpoch" to jsonInt(epoch), "issuedAt" to jsonInt(now), "expiresAt" to jsonInt(now + 604_800),
                    ),
                ),
            )
            val body = JsonObject(
                mapOf("ring" to JsonPrimitive(ring), "certificate" to JsonPrimitive(cert), "discKeys" to JsonArray(discKeys.map { JsonPrimitive(it) })),
            )
            return respond(200, body.toString())
        }

        fun ring(epoch: Long, devs: List<Triple<String, String, String>>, subject: String): String = signer.sign(
            "pkey-ring+jws",
            JsonObject(
                mapOf(
                    "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(subject),
                    "epoch" to jsonInt(epoch), "issuedAt" to jsonInt(now), "expiresAt" to jsonInt(now + 604_800),
                    "devices" to JsonArray(
                        devs.map {
                            JsonObject(mapOf("deviceId" to JsonPrimitive(it.first), "signKey" to JsonPrimitive(it.second), "agreeKey" to JsonPrimitive(it.third)))
                        },
                    ),
                ),
            ),
        )
    }

    private class Rig(val client: PolarisKeyClient, val transport: ScriptedTransport, val worker: ConnectTest.Worker, val port: DeviceKeyPort)

    private fun rig(
        port: DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage()),
        options: ConnectOptions = ConnectOptions(deviceKeys = port, allowEphemeralKeys = true),
        token: String? = "pkeyt_held",
    ): Rig = runBlocking {
        val worker = Worker { port }
        val store = InMemoryStore("djdl", deviceId)
        token?.let { store.setToken(it) }
        val transport = ScriptedTransport(worker::handle)
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = store, transport = transport, clock = { now }, deviceName = "Test Device",
                ),
                license = LicenseClientOptions(fingerprint = false),
                connect = options,
            ),
        )
        Rig(client, transport, worker, port)
    }

    private inline fun refusal(code: String, block: () -> Unit) {
        try {
            block()
        } catch (e: PolarisException) {
            assertEquals(code, e.code)
            return
        }
        fail("expected $code")
    }

    @Test
    fun registersKeysOnFirstNeedFetchesAndHoldsTheIdentity() = runBlocking {
        val r = rig()
        r.worker.others = listOf(other("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"))
        assertNull(r.port.publicKeys())
        val id = r.client.connect.identity()
        assertEquals(1, r.worker.keysPuts)
        assertEquals(sub, id.sub)
        assertEquals(2, id.devices.size)
        assertEquals(now + 604_800, id.certificateExpiresAt)
        val mine = r.port.publicKeys()!!
        assertEquals(mine.signKey, r.worker.lastPut!!["signKey"].stringValue)
        assertEquals(mine.agreeKey, r.worker.lastPut!!["agreeKey"].stringValue)
        // Held: a second read sends nothing; a refresh asks again but does not re-register an unchanged pair.
        r.client.connect.identity()
        assertEquals(1, r.worker.identityGets)
        r.client.connect.identity(refresh = true)
        assertEquals(2, r.worker.identityGets)
        assertEquals(1, r.worker.keysPuts)
        assertNotNull(r.client.connect.current())
        // The value shown to a host has no K_disc.
        assertFalse(id.toString().contains(r.worker.discKeys[0]))
    }

    @Test
    fun aMemoryOnlyKeyStoreRefusesUnlessAllowed() = runBlocking {
        val r = rig(options = ConnectOptions(deviceKeys = DeviceKeyStore(InMemoryDeviceKeyStorage())))
        refusal(ErrorCode.invalidOptions) { runBlocking { r.client.connect.identity() } }
        assertTrue(r.transport.requests().none { it.path.endsWith("/devices/keys") || it.path.endsWith("/connect/identity") })
    }

    @Test
    fun withoutATokenItAsksForSignIn() = runBlocking {
        val r = rig(token = null)
        refusal(ErrorCode.noToken) { runBlocking { r.client.connect.identity() } }
    }

    @Test
    fun connectOffIsTheTypedUnavailableResult() = runBlocking {
        val r = rig()
        r.worker.connectOn = false
        try {
            r.client.connect.identity()
            fail("expected connect-unavailable")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.connectUnavailable, e.code)
            assertEquals("connect.identity", e.unsupported!!.feature)
            assertEquals("product", e.unsupported!!.reason)
        }
        assertEquals(0, r.worker.keysPuts)
    }

    @Test
    fun theWorkersRefusalsKeepTheirCodes() = runBlocking {
        for (code in listOf("account_required" to 403, "ring_too_large" to 409)) {
            val r = rig()
            r.worker.identityStatus = code.second
            r.worker.identityCode = code.first
            refusal(code.first) { runBlocking { r.client.connect.identity() } }
        }
    }

    @Test
    fun aForgottenKeyRegistrationIsRepeatedOnce() = runBlocking {
        val r = rig()
        r.client.connect.identity()
        r.worker.requireKeysOnce = true
        r.client.connect.identity(refresh = true)
        assertEquals(2, r.worker.keysPuts)
    }

    @Test
    fun aCertificateForOtherKeysIsRefusedAndNothingIsStored() = runBlocking {
        val r = rig()
        r.worker.certKeysOverride = other("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC").keys.let { it.signKey to it.agreeKey }
        refusal(ErrorCode.peerCertInvalid) { runBlocking { r.client.connect.identity() } }
        assertNull(r.client.connect.current())
        assertNull(r.client.connect.discoveryKeys())
    }

    @Test
    fun aStaleRosterIsRefusedAndTheHeldOneStays() = runBlocking {
        val r = rig()
        r.worker.epoch = 5
        r.client.connect.identity()
        r.worker.epoch = 4
        refusal(ErrorCode.peerCertInvalid) { runBlocking { r.client.connect.identity(refresh = true) } }
        assertEquals(5L, r.client.connect.current()!!.epoch)
    }

    @Test
    fun aRosterForAnotherSubjectIsRefusedAndTheHeldOneStays() = runBlocking {
        val r = rig()
        r.client.connect.identity()
        r.worker.subject = "ps_ZyXwVuTsRqPoNmLkJiHgFe"
        r.worker.epoch = 9
        refusal(ErrorCode.peerCertInvalid) { runBlocking { r.client.connect.identity(refresh = true) } }
        assertEquals(sub, r.client.connect.current()!!.sub)
        assertEquals(1L, r.client.connect.current()!!.epoch)
    }

    @Test
    fun thePreviousDiscoveryKeyFollowsTheRosterAndLeaveDropsEverything() = runBlocking {
        val r = rig()
        val a = other("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
        r.worker.others = listOf(a)
        r.worker.epoch = 1
        r.worker.discKeys = listOf(b64(1))
        r.client.connect.identity()
        // A device joins (epoch 2): the Worker answers the new key and the one before it.
        r.worker.others = listOf(a, other("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"))
        r.worker.epoch = 2
        r.worker.discKeys = listOf(b64(2), b64(1))
        r.client.connect.identity(refresh = true)
        val keys = r.client.connect.discoveryKeys()!!
        assertEquals(b64(2), Base64Url.encode(keys.current))
        assertEquals(b64(1), Base64Url.encode(keys.previous!!))
        assertFalse(keys.toString().contains(b64(2)))
        // The previous key lapses 24 hours after it was first seen.
        now += 86_401
        assertNull(r.client.connect.discoveryKeys()!!.previous)
        now -= 86_401
        // A device leaves (epoch 3) and the Worker still sends two keys: the client drops the old one.
        r.worker.others = listOf(a)
        r.worker.epoch = 3
        r.worker.discKeys = listOf(b64(3), b64(2))
        r.client.connect.identity(refresh = true)
        assertNull(r.client.connect.discoveryKeys()!!.previous)
        // After a leave nothing is held.
        r.client.connect.leave()
        assertNull(r.client.connect.discoveryKeys())
        assertNull(r.client.connect.current())
    }

    @Test
    fun listDevicesRegistersFirstAndReadsTheDisplayList() = runBlocking {
        val r = rig()
        val list = r.client.connect.listDevices()
        assertEquals(1, r.worker.keysPuts)
        assertEquals(1, list.size)
        assertEquals("Mac", list[0].label)
        assertTrue(list[0].self)
        r.worker.devicesBody = """{"devices":[{"label":"x"}]}"""
        refusal(ErrorCode.badResponse) { runBlocking { r.client.connect.listDevices() } }
    }

    @Test
    fun anUnreadableKeyRecordIsAnErrorAndIsNotReplaced() = runBlocking {
        val file = File(tmp.root, "keys/device-keys.json")
        val port = DeviceKeyStore(FileDeviceKeyStorage(file))
        port.ensure()
        file.writeText("not a key record")
        val r = rig(port = port, options = ConnectOptions(deviceKeys = port))
        refusal(ErrorCode.deviceKeysUnreadable) { runBlocking { r.client.connect.identity() } }
        assertEquals("not a key record", file.readText())
    }

    @Test
    fun theStateFileIsOwnerOnlyAndHoldsNoPlainDiscoveryKeyInAnyReturnedText() = runBlocking {
        val dir = tmp.newFolder("state")
        val keyFile = File(dir, "device-keys.json")
        val port = DeviceKeyStore(FileDeviceKeyStorage(keyFile))
        val stateFile = File(dir, "pkey.connect.v1.json")
        val r = rig(port = port, options = ConnectOptions(deviceKeys = port, state = FileDeviceKeyStorage(stateFile)))
        r.client.connect.identity()
        val perms = Files.getPosixFilePermissions(stateFile.toPath())
        assertEquals(setOf(java.nio.file.attribute.PosixFilePermission.OWNER_READ, java.nio.file.attribute.PosixFilePermission.OWNER_WRITE), perms)
        assertEquals("ConnectClient", r.client.connect.toString())
    }

    @Test
    fun leaveWithNoStateCreatesNothingAndSucceeds() = runBlocking {
        val dir = tmp.newFolder("untouched")
        // A store whose state directory is `dir`: nothing of Connect's exists there.
        val worker = Worker { DeviceKeyStore(InMemoryDeviceKeyStorage()) }
        val store = object : im.plrs.key.core.Store by InMemoryStore("djdl", deviceId) {
            override val stateDirectory: File get() = dir
        }
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = store, transport = ScriptedTransport(worker::handle), clock = { now },
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
        client.connect.leave()
        assertEquals(0, dir.list()!!.size)
    }

    @Test
    fun leaveKeepsASharedSealerKeyAndTheDeviceKeys() = runBlocking {
        val sealer = CountingSealer()
        val keyFile = File(tmp.root, "sealed/device-keys.json")
        val port = DeviceKeyStore(FileDeviceKeyStorage(keyFile, sealer))
        val stateFile = File(tmp.root, "sealed/pkey.connect.v1.json")
        val r = rig(port = port, options = ConnectOptions(deviceKeys = port, state = FileDeviceKeyStorage(stateFile, sealer)))
        r.client.connect.identity()
        val before = port.publicKeys()!!
        r.client.connect.leave()
        assertFalse(stateFile.exists())
        assertEquals(0, sealer.destroyed)
        assertEquals(before, port.publicKeys())
        assertNull(r.client.connect.discoveryKeys())
    }

    @Test
    fun aRecordThatCannotBeDeletedStopsLeave() = runBlocking {
        val inner = InMemoryDeviceKeyStorage()
        val failing = object : im.plrs.key.core.DeviceKeyStorage by inner {
            override suspend fun deleteRecord() = throw im.plrs.key.core.StoreException("disk")
            override suspend fun clear() = throw im.plrs.key.core.StoreException("disk")
        }
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val r = rig(port = port, options = ConnectOptions(deviceKeys = port, allowEphemeralKeys = true, state = failing))
        r.client.connect.identity()
        refusal(ErrorCode.storeFailed) { runBlocking { r.client.connect.leave() } }
    }

    @Test
    fun refreshBypassesTheHeldIdentity() = runBlocking {
        val r = rig()
        r.client.connect.identity()
        r.client.connect.identity()
        assertEquals(1, r.worker.identityGets)
        r.worker.epoch = 2
        assertEquals(2L, r.client.connect.identity(refresh = true).epoch)
        assertEquals(2, r.worker.identityGets)
    }

    /** XOR "sealer": enough to prove a sealed record round-trips and to count destroy() calls. */
    private class CountingSealer : im.plrs.key.core.DeviceKeySealer {
        var destroyed = 0
        override fun seal(plain: ByteArray, context: ByteArray) = plain.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        override fun open(blob: ByteArray, context: ByteArray) = blob.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        override fun destroy() {
            destroyed++
        }
    }
}
