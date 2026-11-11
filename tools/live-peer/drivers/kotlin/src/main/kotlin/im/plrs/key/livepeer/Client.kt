// The driver's one client: no account, memory-only keys and links, local pairing on, the LAN on loopback.

package im.plrs.key.livepeer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.CloudConnectOptions
import im.plrs.key.sdk.ConnectOptions
import im.plrs.key.sdk.LanOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import java.security.SecureRandom

private const val KEY_BYTES = 32
private const val DEVICE_ID_CHARS = 32
private const val ALPHABET = 26

internal val CATEGORIES = listOf("notes")

private val random = SecureRandom()

private fun randomDeviceId(): String = String(CharArray(DEVICE_ID_CHARS) { 'A' + random.nextInt(ALPHABET) })

internal suspend fun makeClient(): PolarisKeyClient {
    val client =
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core =
                    CoreOptions(
                        productSlug = PRODUCT,
                        baseUrl = "https://k.test",
                        version = "1.0.0",
                        pinnedKeys = mapOf("live-peer-1" to Base64Url.encode(ByteArray(KEY_BYTES).also { random.nextBytes(it) })),
                        trustRefresh = false,
                        store = InMemoryStore(PRODUCT, randomDeviceId()),
                        transport = LocalDiscovery,
                        deviceName = "kotlin",
                    ),
                license = LicenseClientOptions(fingerprint = false),
                connect =
                    ConnectOptions(
                        deviceKeys = DeviceKeyStore(InMemoryDeviceKeyStorage()),
                        allowEphemeralKeys = true,
                        state = InMemoryDeviceKeyStorage(),
                        localState = InMemoryDeviceKeyStorage(),
                    ),
                deviceReports = false,
            ),
        )
    client.discover()
    return client
}

internal suspend fun startLan(
    client: PolarisKeyClient,
    net: BrokerNet,
) {
    client.cloudConnect.start(
        CloudConnectOptions(lan = true, lanOptions = LanOptions(mdns = net, host = LOOP, allowLoopback = true), relay = false),
    )
}
