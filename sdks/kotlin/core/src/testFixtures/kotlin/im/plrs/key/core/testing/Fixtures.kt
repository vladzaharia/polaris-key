// Test fixtures shared by the Kotlin SDK's module tests (`testFixtures(project(":core"))`): a
// throwaway Ed25519 signer that mints wire-shaped licence and config documents (the JDK's own
// Ed25519, JDK 15+), and a scripted `PolarisTransport`. Never published: the conformance corpus,
// not these, is the cross-SDK proof; these let a module test drive a client end to end.

package im.plrs.key.core.testing

import im.plrs.key.core.Base64Url
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.TrustSet
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Security
import java.security.Signature
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One throwaway Ed25519 key pair. The JDK's provider signs on the JVM; on Android `getInstance("Ed25519")` resolves to
 * the AndroidKeyStore provider (API 33+), which cannot make a plain key, so the key is made by another JCA provider and,
 * where none has Ed25519, by Tink (`tink-android`, which `:android` brings; reached by reflection, as `:core` only
 * compiles against it).
 */
private class Ed25519Keys(val publicKey: ByteArray, val sign: (ByteArray) -> ByteArray) {
    fun sign(data: ByteArray): ByteArray = sign.invoke(data)

    companion object {
        fun create(): Ed25519Keys = jca() ?: tink()

        private fun jca(): Ed25519Keys? = Security.getProviders().filter { it.name != "AndroidKeyStore" }.firstNotNullOfOrNull { provider ->
            runCatching {
                val pair = KeyPairGenerator.getInstance("Ed25519", provider).generateKeyPair()
                val privateKey: PrivateKey = pair.private
                Ed25519Keys(pair.public.encoded.takeLast(32).toByteArray()) { data ->
                    Signature.getInstance("Ed25519", provider).run {
                        initSign(privateKey)
                        update(data)
                        sign()
                    }
                }
            }.getOrNull()
        }

        private fun tink(): Ed25519Keys {
            val signClass = Class.forName("com.google.crypto.tink.subtle.Ed25519Sign")
            val pairClass = Class.forName("com.google.crypto.tink.subtle.Ed25519Sign\$KeyPair")
            val pair = pairClass.getMethod("newKeyPair").invoke(null)
            val publicKey = pairClass.getMethod("getPublicKey").invoke(pair) as ByteArray
            val privateKey = pairClass.getMethod("getPrivateKey").invoke(pair) as ByteArray
            val signer = signClass.getConstructor(ByteArray::class.java).newInstance(privateKey)
            val sign = signClass.getMethod("sign", ByteArray::class.java)
            return Ed25519Keys(publicKey) { data -> sign.invoke(signer, data) as ByteArray }
        }
    }
}

/** A throwaway Ed25519 key and the documents it signs. */
public class TestSigner(public val kid: String = "test-key") {
    private val keys: Ed25519Keys = Ed25519Keys.create()

    /** The raw 32-byte public key, base64url: the X.509 encoding's last 32 bytes. */
    public val publicKey: String = Base64Url.encode(keys.publicKey)

    /** The trust set that pins this key. */
    public val trust: TrustSet = mapOf(kid to publicKey)

    /** A compact JWS over [payload] with header `{alg, typ, kid}` ([headerKid] overrides the kid, as a delegated content key's `pkd1-` kid). */
    public fun sign(typ: String, payload: JsonObject, headerKid: String = kid): String {
        val header = JsonObject(mapOf("alg" to JsonPrimitive("EdDSA"), "typ" to JsonPrimitive(typ), "kid" to JsonPrimitive(headerKid)))
        val input = Base64Url.encode(header.toString()) + "." + Base64Url.encode(payload.toString())
        val signature = keys.sign(input.toByteArray(Charsets.UTF_8))
        return input + "." + Base64Url.encode(signature)
    }

    private fun envelope(aud: String, deviceId: String, now: Long): Map<String, JsonElement> = mapOf(
        "iss" to JsonPrimitive("key.plrs.im"),
        "aud" to JsonPrimitive(aud),
        "deviceId" to JsonPrimitive(deviceId),
        "issuedAt" to JsonPrimitive(now),
        "expiresAt" to JsonPrimitive(now + 3600),
        "graceUntil" to JsonPrimitive(now + 7 * 86_400),
    )

    /** `pkey-license+jws` with [entitlements] as `default`-state managed values. */
    public fun licenseDoc(
        aud: String,
        deviceId: String,
        now: Long,
        entitlements: Map<String, JsonElement> = emptyMap(),
        licenseId: String = "lic_test",
        profile: JsonObject? = null,
    ): String {
        val payload = LinkedHashMap(envelope(aud, deviceId, now))
        payload["licenseId"] = JsonPrimitive(licenseId)
        profile?.let { payload["profile"] = it }
        payload["entitlements"] = managed(entitlements)
        return sign("pkey-license+jws", JsonObject(payload))
    }

    /** `pkey-config+jws` with [config] and [secrets] as managed values (`state` per key, default `default`). */
    public fun configDoc(
        aud: String,
        deviceId: String,
        now: Long,
        config: Map<String, JsonElement> = emptyMap(),
        secrets: Map<String, JsonElement> = emptyMap(),
        states: Map<String, String> = emptyMap(),
    ): String {
        val payload = LinkedHashMap(envelope(aud, deviceId, now))
        payload["schemaVersion"] = JsonPrimitive(1)
        payload["config"] = managed(config, states)
        payload["secrets"] = managed(secrets)
        return sign("pkey-config+jws", JsonObject(payload))
    }

    private fun managed(values: Map<String, JsonElement>, states: Map<String, String> = emptyMap()): JsonObject = JsonObject(
        values.mapValues { (k, v) ->
            JsonObject(mapOf("state" to JsonPrimitive(states[k] ?: "default"), "value" to v, "updatedAt" to JsonPrimitive(1)))
        },
    )
}

/** A fake server: [handler] answers every request, and every request is recorded. */
public class ScriptedTransport(private val handler: (PolarisRequest) -> PolarisResponse) : PolarisTransport {
    private val lock = Mutex()
    private val sent = ArrayList<PolarisRequest>()

    public suspend fun requests(): List<PolarisRequest> = lock.withLock { sent.toList() }

    override suspend fun send(request: PolarisRequest): PolarisResponse {
        lock.withLock { sent += request }
        return handler(request)
    }

    public companion object {
        /** A response with a UTF-8 body. */
        public fun respond(status: Int, body: String = "", headers: Map<String, String> = emptyMap()): PolarisResponse =
            PolarisResponse(status, body.toByteArray(Charsets.UTF_8), headers)
    }
}

/** The path of [request]'s URL after the host (`/djdl/license/document`). */
public val PolarisRequest.path: String get() = java.net.URI(url).rawPath
