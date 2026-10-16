// Product backends — WIRE-CONTRACT-V4 §14.2, the six-step verdict on `X-PKey-License`.
//
// Pinned by `conformance/corpus/v2/backend-matrix.json` (`verdict`), replayed by :conformance. The
// function is pure: the trust sets (the pins plus the last verified manifest, §14.4) come in from
// the caller, it does no I/O and logs nothing, so the header, the document and the holder never
// reach a log. Ed25519 verification is :core's (the JCA, Tink forced in the second conformance pass).

package im.plrs.key.server

import im.plrs.key.core.CLOCK_SKEW_SECONDS
import im.plrs.key.core.ActivationSource
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.GateInput
import im.plrs.key.core.JwsTyp
import im.plrs.key.core.JwsVerifier
import im.plrs.key.core.LicenseDoc
import im.plrs.key.core.SignedInUser
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyOptions
import im.plrs.key.core.boolValue
import im.plrs.key.core.isUsable
import im.plrs.key.core.licenseState
import im.plrs.key.core.objectValue
import im.plrs.key.core.saturatingAdd
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyLicenseDoc
import kotlinx.serialization.json.JsonElement

/** The headers a backend reads (§14.1) and its limits. `Authorization`, cookies and queries are never read. */
public object BackendWire {
    public const val HEADER_LICENSE: String = "X-PKey-License"
    public const val HEADER_DEVICE: String = "X-PKey-Device"
    public const val AUTH_SCHEME: String = "PKey-License"
    public const val LICENSE_MAX_BYTES: Int = 16_384
    public const val TRUST_REFRESH_SECONDS: Long = 900

    /** The list for the app's own CORS allow-list; the drop-ins set no CORS header. */
    public val POLARIS_REQUEST_HEADERS: List<String> = listOf(HEADER_LICENSE, HEADER_DEVICE)
}

/** The codes a backend answers with (§14.2): the four `backend` codes and the existing `not_entitled`. */
public enum class BackendRefusal(public val code: String, public val status: Int) {
    LicenseRequired(ErrorCode.licenseRequired, 401),
    LicenseInvalid(ErrorCode.licenseInvalid, 401),
    LicenseStale(ErrorCode.licenseStale, 401),
    NotEntitled(ErrorCode.notEntitled, 403),
    SignInRequired(ErrorCode.signInRequired, 403),
    ;

    public companion object {
        public fun of(code: String): BackendRefusal? = entries.firstOrNull { it.code == code }
    }
}

/** One requirement of a route, checked at step 6 in the order the route lists them. */
public sealed interface BackendRequirement {
    /** Boolean entitlement [name] must be true. */
    public data class Entitlement(val name: String) : BackendRequirement

    /** A signed-in account's pairwise subject must be present. */
    public data object SignIn : BackendRequirement
}

public data class BackendOptions @JvmOverloads constructor(
    /** The product slugs this backend serves, in order; the first is the challenge's realm. */
    val products: List<String>,
    /** Accept a document up to this many seconds after its `issuedAt` (plus the skew), never past its `graceUntil`. Null: the document's own window. */
    val maxAgeSeconds: Long? = null,
    /** The route's requirements, in order. */
    val require: List<BackendRequirement> = emptyList(),
) {
    init {
        require(products.isNotEmpty() && products.all { it.isNotEmpty() }) { "options.products names no product" }
        require(maxAgeSeconds == null || maxAgeSeconds >= 0) { "options.maxAgeSeconds is not a non-negative integer" }
    }
}

/** What a passing document attaches to the request (§14.2). */
public data class BackendContext(
    val license: LicenseContext,
    /** The signed-in account's pairwise subject (`profile.user.subject`), when valid. */
    val user: SignedInUser?,
) {
    /** Deliberately without the holder's name and email: [toString] never carries them. */
    override fun toString(): String = "BackendContext(product=${license.product}, user=${user != null})"
}

public data class LicenseContext(
    /** The document's `aud`: which configured product it is for. */
    val product: String,
    val id: String,
    val deviceId: String,
    /** The `license.tier` entitlement's value when it is a string. */
    val tier: String?,
    val issuedAt: Long,
    /** `now - issuedAt`, never below 0. */
    val ageSeconds: Long,
    /** The signed profile's name and email, when both are strings. */
    val holder: Holder?,
) {
    override fun toString(): String = "LicenseContext(product=$product, tier=$tier)"
}

public class Holder(public val name: String, public val email: String) {
    // PII: never in a log line or a serialisation.
    override fun toString(): String = "Holder(redacted)"
}

public class BackendVerdict internal constructor(
    /** 200 when every step passes. */
    public val status: Int,
    public val refusal: BackendRefusal?,
    /** Set whenever steps 1 to 5 pass, so on step 6's refusals too. */
    public val context: BackendContext?,
    /** The verified document, whenever [context] is set. */
    internal val document: LicenseDoc?,
    /** The step that refused (1 to 6), for the debug log and `onVerdict`; never in a body. */
    public val step: Int,
) {
    public val code: String? get() = refusal?.code
    override fun toString(): String = "BackendVerdict(status=$status, code=$code)"
}

/** A document that passed steps 2 and 3 (signature and claims), cached by the header's hash. */
internal class VerifiedDocument(val product: String, val doc: LicenseDoc, val holder: Holder?, val kid: String)

private fun asciiLower(s: String): String {
    val out = StringBuilder(s.length)
    for (c in s) out.append(if (c in 'A'..'Z') c + 0x20 else c)
    return out.toString()
}

private fun trimOws(s: String): String = s.trim { it == ' ' || it == '\t' }

/**
 * §14.1: a header's elements. Every field named [name] (any case), each value split at `,`, each
 * element trimmed of spaces and tabs, empty elements dropped.
 */
public fun backendHeaderElements(headers: Iterable<Pair<String, String>>, name: String): List<String> {
    val want = asciiLower(name)
    val out = ArrayList<String>()
    for ((n, v) in headers) {
        if (asciiLower(n) != want) continue
        for (element in v.split(',')) {
            val e = trimOws(element)
            if (e.isNotEmpty()) out += e
        }
    }
    return out
}

private val SEGMENTS = Regex("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")

private fun holderOf(profile: JsonElement?): Holder? {
    val o = profile.objectValue ?: return null
    val name = o["name"].stringValue ?: return null
    val email = o["email"].stringValue ?: return null
    return Holder(name, email)
}

/** Steps 2 and 3's signature and claim half for one candidate JWS, or null: no product's trust set accepts it. */
internal fun verifyBackendDocument(jws: String, products: List<String>, trust: Map<String, TrustSet>): VerifiedDocument? {
    for (product in products) {
        val set = trust[product] ?: continue
        val v = JwsVerifier.verify(jws, set, JwsTyp.license, requireTyp = true) ?: continue
        if (v.payload["aud"].stringValue != product) continue
        val deviceId = v.payload["deviceId"].stringValue
        if (deviceId.isNullOrEmpty()) continue
        // §3's licence claims with no anti-replay floor and freshness not asserted.
        val doc = verifyLicenseDoc(
            jws,
            VerifyOptions(trust = set, expectedAud = product, deviceId = deviceId, lastAcceptedIssuedAt = null, checkFreshness = false),
        ) ?: continue
        return VerifiedDocument(product, doc, holderOf(v.payload["profile"]), v.kid)
    }
    return null
}

private fun refused(r: BackendRefusal, step: Int, context: BackendContext? = null, doc: LicenseDoc? = null) =
    BackendVerdict(r.status, r, context, doc, step)

/**
 * §14.2: decide a request to a product backend. The steps run in order and the first that fails
 * decides. Never throws on request input.
 */
public fun backendVerdict(
    headers: Iterable<Pair<String, String>>,
    now: Long,
    options: BackendOptions,
    trust: Map<String, TrustSet>,
): BackendVerdict = decide(headers, now, options) { jws -> verifyBackendDocument(jws, options.products, trust) }

internal fun decide(
    input: Iterable<Pair<String, String>>,
    now: Long,
    options: BackendOptions,
    verify: (String) -> VerifiedDocument?,
): BackendVerdict {
    val headers = input.toList()
    // 1. No `X-PKey-License` element.
    val license = backendHeaderElements(headers, BackendWire.HEADER_LICENSE)
    if (license.isEmpty()) return refused(BackendRefusal.LicenseRequired, 1)
    // 2. More than one element, longer than 16 384 bytes, or not three base64url segments.
    if (license.size != 1) return refused(BackendRefusal.LicenseInvalid, 2)
    val jws = license[0]
    if (jws.length > BackendWire.LICENSE_MAX_BYTES ||
        jws.toByteArray(Charsets.UTF_8).size > BackendWire.LICENSE_MAX_BYTES ||
        !SEGMENTS.matches(jws)
    ) return refused(BackendRefusal.LicenseInvalid, 2)
    // 3. The strict verifier against the trust set of the configured product its `aud` names, the
    //    licence claims, the device the header names, and `issuedAt` no later than now + 300.
    val device = backendHeaderElements(headers, BackendWire.HEADER_DEVICE)
    if (device.size > 1) return refused(BackendRefusal.LicenseInvalid, 3)
    val verified = verify(jws) ?: return refused(BackendRefusal.LicenseInvalid, 3)
    val doc = verified.doc
    if (device.size == 1 && device[0] != doc.deviceId) return refused(BackendRefusal.LicenseInvalid, 3)
    if (doc.issuedAt > saturatingAdd(now, CLOCK_SKEW_SECONDS)) return refused(BackendRefusal.LicenseInvalid, 3)
    // 4. Freshness: the document's own window, or the backend's maximum age within graceUntil.
    val max = options.maxAgeSeconds
    if (max == null) {
        if (now > saturatingAdd(doc.expiresAt, CLOCK_SKEW_SECONDS)) return refused(BackendRefusal.LicenseStale, 4)
    } else if (now - doc.issuedAt > saturatingAdd(max, CLOCK_SKEW_SECONDS) || now > doc.graceUntil) {
        return refused(BackendRefusal.LicenseStale, 4)
    }
    // 5. The shared gate must find the document usable.
    val state = licenseState(GateInput(licenseServiceEnabled = true, activation = ActivationSource.token, doc = doc, now = now))
    if (!isUsable(state.status)) return refused(BackendRefusal.LicenseStale, 5)
    val tier = doc.entitlements["license.tier"]?.value.stringValue
    val context = BackendContext(
        license = LicenseContext(
            product = verified.product,
            id = doc.licenseId,
            deviceId = doc.deviceId,
            tier = tier,
            issuedAt = doc.issuedAt,
            ageSeconds = maxOf(0L, now - doc.issuedAt),
            holder = verified.holder,
        ),
        user = doc.profile?.user,
    )
    // 6. The route's requirements, in order.
    for (requirement in options.require) {
        when (requirement) {
            is BackendRequirement.Entitlement -> {
                val entry = doc.entitlements[requirement.name]
                if (entry == null || entry.value.boolValue != true) return refused(BackendRefusal.NotEntitled, 6, context, doc)
            }
            BackendRequirement.SignIn -> if (context.user == null) return refused(BackendRefusal.SignInRequired, 6, context, doc)
        }
    }
    return BackendVerdict(200, null, context, doc, 0)
}
