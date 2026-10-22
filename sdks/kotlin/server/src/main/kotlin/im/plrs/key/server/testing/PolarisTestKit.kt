// Test helpers for an app that gates routes with the server drop-ins: sign licence documents with a
// throwaway key, get the matching pins and a clock you control, the headers that make a gate answer
// each verdict, and a fake trust service. No network, no Polaris Key.
//
//     val kit = PolarisTestKit(product = "acme")
//     val server = PolarisServer(kit.options())              // trust refresh off, the kit's clock
//     val headers = kit.signedHeaders { entitlements["export.pdf"] = true }
//     val refused = kit.headersFor(BackendRefusal.LicenseStale)
//     val rotated = kit.trust.addKey("rotated-2027")         // a key only the trust manifest vouches for
//     val withTrust = PolarisServer(kit.options(trustRefresh = true))
//
// Never use this from production code: the key it makes signs anything.

package im.plrs.key.server.testing

import im.plrs.key.core.Base64Url
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.TrustSet
import im.plrs.key.server.BackendRefusal
import im.plrs.key.server.BackendWire
import im.plrs.key.server.Holder
import im.plrs.key.server.PolarisProduct
import im.plrs.key.server.PolarisServerOptions
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

private const val HOUR = 3600L
private const val DAY = 86_400L

/** The pairwise subject [TestLicense.signedIn] signs: `ps_` and 22 base64url characters. */
public const val TEST_SUBJECT: String = "ps_AAAAAAAAAAAAAAAAAAAAAA"

/** A clock the test moves. Epoch seconds. */
public class TestClock internal constructor(start: Long) {
    private val value = AtomicLong(start)

    public fun now(): Long = value.get()

    public fun set(seconds: Long) {
        value.set(seconds)
    }

    public fun advance(seconds: Long) {
        value.addAndGet(seconds)
    }
}

/** What a test signs. Every field has the default a passing document needs. */
public class TestLicense {
    /** `true`/`false` for a boolean entitlement, or the value itself (a number, a string, a list of strings, a [JsonElement]). */
    public val entitlements: MutableMap<String, Any> = linkedMapOf()

    /** Becomes the `license.tier` entitlement. */
    public var tier: String? = null

    /** The holder's name and email in the signed profile. Null: no profile name or email. */
    public var holder: Holder? = Holder("Test Holder", "holder@example.com")

    /** The pairwise subject of the signed-in account. Null: nobody is signed in. See [signedIn]. */
    public var userSubject: String? = null

    /** Default the kit's device. */
    public var deviceId: String? = null
    public var licenseId: String = "lic_test"

    /** Default the kit clock's now. */
    public var issuedAt: Long? = null

    /** Seconds the document lives. */
    public var expiresInSeconds: Long = HOUR

    /** Seconds past `expiresAt` the gate still opens. */
    public var graceSeconds: Long = 30 * DAY

    /** Override the audience, to test a document for another product. */
    public var audience: String? = null

    /** Grant boolean entitlements [names]. */
    public fun entitle(vararg names: String) {
        for (n in names) entitlements[n] = true
    }

    /** Sign a signed-in account on the device. */
    public fun signedIn(subject: String = TEST_SUBJECT) {
        userSubject = subject
    }
}

private fun jsonOf(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is String -> JsonPrimitive(value)
    is Iterable<*> -> JsonArray(value.map(::jsonOf))
    else -> throw IllegalArgumentException("an entitlement value is a Boolean, Number, String, list or JsonElement, not ${value::class.simpleName}")
}

internal class TestKey(val kid: String) {
    private val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val privateKey: PrivateKey = pair.private
    val publicKey: String = Base64Url.encode(pair.public.encoded.takeLast(32).toByteArray())

    fun sign(typ: String, payload: JsonObject, tamper: Boolean = false): String {
        val header = buildJsonObject {
            put("alg", JsonPrimitive("EdDSA"))
            put("typ", JsonPrimitive(typ))
            put("kid", JsonPrimitive(kid))
        }
        val input = Base64Url.encode(header.toString()) + "." + Base64Url.encode(payload.toString())
        val signature = Signature.getInstance("Ed25519").run {
            initSign(privateKey)
            update(input.toByteArray(Charsets.UTF_8))
            sign()
        }
        val jws = input + "." + Base64Url.encode(signature)
        // A real signature over the real payload, broken: no key can verify it.
        return if (tamper) jws.dropLast(1) + (if (jws.last() == 'A') 'B' else 'A') else jws
    }
}

/** A key only the fake trust manifest vouches for: its documents verify once the server has fetched the manifest, and are `license_invalid` before. */
public class TestTrustedKey internal constructor(public val kid: String, private val kit: PolarisTestKit, private val key: TestKey) {
    /** Sign a licence document with this key. */
    public fun sign(configure: TestLicense.() -> Unit = {}): String = kit.signWith(key, configure)
}

/**
 * The fake trust service, a [PolarisTransport] that answers `/<product>/.well-known/polaris-trust.jws`
 * with a manifest the kit's key signed. Any other URL answers 404. Hand it to
 * [PolarisServerOptions.transport], or use `kit.options(trustRefresh = true)`.
 */
public class TestTrust internal constructor(private val kit: PolarisTestKit, private val manifest: () -> String) : PolarisTransport {
    private val seen = CopyOnWriteArrayList<String>()

    /** The URLs requested, in order. */
    public val calls: List<String> get() = seen.toList()

    /** True: every fetch fails like an unreachable Polaris Key. Default false. */
    @Volatile
    public var offline: Boolean = false

    /** Publish another signing key in the manifest and return it. */
    public fun addKey(kid: String = "pkey-test-extra-${kit.extraKeyCount() + 1}"): TestTrustedKey = kit.addExtraKey(kid)

    override suspend fun send(request: PolarisRequest): PolarisResponse {
        seen += request.url
        if (offline) throw IOException("trust fetch failed (kit.trust.offline)")
        if (!request.url.contains("/${kit.product}/.well-known/polaris-trust.jws")) return PolarisResponse(404, "not found".toByteArray())
        return PolarisResponse(200, manifest().toByteArray(Charsets.UTF_8), mapOf("content-type" to "application/jose"))
    }
}

/**
 * A throwaway signer for one product, its pins, a [clock] and a fake [trust] service.
 * [product] is the document's `aud`.
 */
public class PolarisTestKit @JvmOverloads constructor(
    public val product: String = "test-product",
    public val kid: String = "pkey-test-2026",
    start: Long = 1_700_000_000L,
) {
    public val clock: TestClock = TestClock(start)
    public val deviceId: String = "dev_test"
    private val key = TestKey(kid)
    private val extra = CopyOnWriteArrayList<TestKey>()
    private val manifestSeq = AtomicLong(0)

    /** `kid` to the raw Ed25519 public key (base64url): the pins. */
    public val pinnedKeys: TrustSet = mapOf(kid to key.publicKey)

    /** The product with the kit's pins, for `PolarisServerOptions(listOf(kit.polarisProduct))` or a Ktor `product(...)`. */
    public val polarisProduct: PolarisProduct = PolarisProduct(product, pinnedKeys)

    /** The fake trust service. */
    public val trust: TestTrust = TestTrust(this) { manifest() }

    internal fun extraKeyCount(): Int = extra.size

    internal fun addExtraKey(kid: String): TestTrustedKey {
        val k = TestKey(kid)
        extra += k
        return TestTrustedKey(kid, this, k)
    }

    private fun manifest(): String {
        val issuedAt = clock.now() + manifestSeq.getAndIncrement()
        val keys = (listOf(key) + extra).map {
            buildJsonObject {
                put("kid", JsonPrimitive(it.kid))
                put("alg", JsonPrimitive("EdDSA"))
                put("kty", JsonPrimitive("OKP"))
                put("crv", JsonPrimitive("Ed25519"))
                put("publicKey", JsonPrimitive(it.publicKey))
                put("status", JsonPrimitive("active"))
            }
        }
        return key.sign(
            "pkey-trust+jws",
            buildJsonObject {
                put("iss", JsonPrimitive("key.plrs.im"))
                put("aud", JsonPrimitive(product))
                put("schemaVersion", JsonPrimitive(1))
                put("issuedAt", JsonPrimitive(issuedAt))
                put("expiresAt", JsonPrimitive(issuedAt + 300))
                put("jwksUrl", JsonPrimitive("https://key.plrs.im/$product/.well-known/jwks.json"))
                put("cacheSeconds", JsonPrimitive(300))
                put("keys", JsonArray(keys))
            },
        )
    }

    internal fun signWith(signer: TestKey, configure: TestLicense.() -> Unit): String = signDocument(signer, TestLicense().apply(configure))

    private fun signDocument(signer: TestKey, o: TestLicense, tamper: Boolean = false): String {
        val issuedAt = o.issuedAt ?: clock.now()
        val expiresAt = issuedAt + o.expiresInSeconds
        val values = LinkedHashMap<String, Any>(o.entitlements)
        o.tier?.let { values["license.tier"] = it }
        val payload = buildJsonObject {
            put("iss", JsonPrimitive("key.plrs.im"))
            put("aud", JsonPrimitive(o.audience ?: product))
            put("deviceId", JsonPrimitive(o.deviceId ?: deviceId))
            put("issuedAt", JsonPrimitive(issuedAt))
            put("expiresAt", JsonPrimitive(expiresAt))
            put("graceUntil", JsonPrimitive(expiresAt + o.graceSeconds))
            put("licenseId", JsonPrimitive(o.licenseId))
            if (o.holder != null || o.userSubject != null) {
                put(
                    "profile",
                    buildJsonObject {
                        o.holder?.let {
                            put("name", JsonPrimitive(it.name))
                            put("firstName", JsonPrimitive(it.name.substringBefore(' ')))
                            put("email", JsonPrimitive(it.email))
                        }
                        put("activatedAt", JsonPrimitive(issuedAt))
                        o.userSubject?.let { put("user", buildJsonObject { put("subject", JsonPrimitive(it)) }) }
                    },
                )
            }
            put(
                "entitlements",
                JsonObject(
                    values.mapValues { (_, v) ->
                        buildJsonObject {
                            put("state", JsonPrimitive("enforced"))
                            put("value", jsonOf(v))
                            put("updatedAt", JsonPrimitive(issuedAt))
                        }
                    },
                ),
            )
        }
        return signer.sign("pkey-license+jws", payload, tamper)
    }

    /** Sign a licence document. */
    public fun sign(configure: TestLicense.() -> Unit = {}): String = signDocument(key, TestLicense().apply(configure))

    /** The request headers a client sends: `X-PKey-License` and `X-PKey-Device`. */
    @JvmOverloads
    public fun headers(jws: String, deviceId: String = this.deviceId): Map<String, String> =
        linkedMapOf(BackendWire.HEADER_LICENSE to jws, BackendWire.HEADER_DEVICE to deviceId)

    /** Sign and return the headers in one step. */
    public fun signedHeaders(configure: TestLicense.() -> Unit = {}): Map<String, String> {
        val license = TestLicense().apply(configure)
        return headers(signDocument(key, license), license.deviceId ?: deviceId)
    }

    /**
     * The headers that make a gate answer [refusal]; null signs exactly what [configure] says, so
     * grant what the route needs. [BackendRefusal.NotEntitled] and [BackendRefusal.SignInRequired]
     * sign a license with no entitlements and no signed-in account unless [configure] says
     * otherwise; [BackendRefusal.LicenseRequired] sends no header.
     */
    public fun headersFor(refusal: BackendRefusal?, configure: TestLicense.() -> Unit = {}): Map<String, String> = when (refusal) {
        BackendRefusal.LicenseRequired -> emptyMap()
        BackendRefusal.LicenseInvalid -> headers(signDocument(key, TestLicense().apply(configure), tamper = true))
        BackendRefusal.LicenseStale -> signedHeaders {
            // Past expiresAt plus the 300 s skew, still inside the grace window.
            issuedAt = clock.now() - 2 * HOUR
            expiresInSeconds = HOUR
            configure()
        }
        BackendRefusal.NotEntitled, BackendRefusal.SignInRequired, null -> signedHeaders(configure)
    }

    /**
     * The options for a server or an adapter: the kit's product and clock, with the trust refresh
     * off. `trustRefresh = true` serves the refresh from [trust]. `copy(...)` the result to change
     * the rest.
     */
    @JvmOverloads
    public fun options(trustRefresh: Boolean = false): PolarisServerOptions = PolarisServerOptions(
        products = listOf(polarisProduct),
        trustRefresh = trustRefresh,
        transport = if (trustRefresh) trust else null,
        clock = clock::now,
    )
}
