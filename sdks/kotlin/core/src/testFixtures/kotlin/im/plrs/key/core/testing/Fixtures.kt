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
import java.security.Signature
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A throwaway Ed25519 key and the documents it signs. */
public class TestSigner(public val kid: String = "test-key") {
    private val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val privateKey: PrivateKey = pair.private

    /** The raw 32-byte public key, base64url: the X.509 encoding's last 32 bytes. */
    public val publicKey: String = Base64Url.encode(pair.public.encoded.takeLast(32).toByteArray())

    /** The trust set that pins this key. */
    public val trust: TrustSet = mapOf(kid to publicKey)

    /** A compact JWS over [payload] with header `{alg, typ, kid}`. */
    public fun sign(typ: String, payload: JsonObject): String {
        val header = JsonObject(mapOf("alg" to JsonPrimitive("EdDSA"), "typ" to JsonPrimitive(typ), "kid" to JsonPrimitive(kid)))
        val input = Base64Url.encode(header.toString()) + "." + Base64Url.encode(payload.toString())
        val signature = Signature.getInstance("Ed25519").run {
            initSign(privateKey)
            update(input.toByteArray(Charsets.UTF_8))
            sign()
        }
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
