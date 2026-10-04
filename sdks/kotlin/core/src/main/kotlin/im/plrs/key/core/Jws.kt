// Compact JWS (EdDSA / Ed25519) verification — a byte-for-byte re-implementation of
// `@polaris-key/jws`'s `verifyJws` and Swift's `JWSVerifier`, pinned identical by the corpus
// (`conformance/corpus/v2`, `jwsCases`). docs/security/WIRE-CONTRACT-V4.md §1 is the normative
// order this file implements:
//
//   protected header = {"alg":"EdDSA","kid":<kid>,"typ":<typ>}
//   signingInput     = base64url(header) "." base64url(payload)
//   signature        = Ed25519 over the ASCII bytes of signingInput
//
// SECURITY: the key is selected by the header `kid` from a caller-supplied trust set, never from
// the document; `alg` is asserted `EdDSA` before any signature math; the signature is checked
// over the ORIGINAL encoded substrings (the payload is never re-serialised); and the payload is
// parsed only after the signature verifies. `requireTyp` is true on every v3 path, and the
// payload cap may only be RAISED, and only together with a required `typ` (§1, §2).

package im.plrs.key.core

/** A trust set: `kid` → raw 32-byte Ed25519 public key, base64url. */
public typealias TrustSet = Map<String, String>

/** Document-type domain separators (§2). */
public enum class JwsTyp(public val wire: String) {
    license("pkey-license+jws"),
    config("pkey-config+jws"),
    trust("pkey-trust+jws"),
    bundle("pkey-bundle+jws"),
    feed("pkey-feed+jws"),
    release("pkey-release+jws"),
    ;

    public companion object {
        public fun of(wire: String?): JwsTyp? = entries.firstOrNull { it.wire == wire }
    }
}

/** A verified JWS: the selected `kid`, the signed payload, and its non-wire-integer pointers. */
public class VerifiedJws(
    public val kid: String,
    public val payloadBytes: ByteArray,
    public val payload: kotlinx.serialization.json.JsonObject,
    public val nonWireIntegers: NonWireIntegers,
)

public object JwsVerifier {
    /** Hard cap on the decoded payload (§1); `pkey-bundle+jws` raises it to [MAX_BUNDLE_BYTES]. */
    public const val MAX_PAYLOAD_BYTES: Int = 65_536

    /** Hard cap on the decoded protected header (audit R2-04). */
    public const val MAX_HEADER_BYTES: Int = 1_024

    internal fun b64Cap(bytes: Int): Int = (bytes * 4 + 2) / 3 + 4

    public val MAX_HEADER_B64: Int = b64Cap(MAX_HEADER_BYTES)
    public val MAX_PAYLOAD_B64: Int = b64Cap(MAX_PAYLOAD_BYTES)

    /**
     * Verify [jws] against [trust]. Null on ANY failure, never a throw.
     *
     * @param typ the document type the CALL SITE expects; a different header `typ` is refused.
     * @param requireTyp refuse a header with no `typ` (true on every v3 path).
     * @param maxPayloadBytes raise the payload cap (raise-only, and only with a required `typ`).
     */
    public fun verify(
        jws: String,
        trust: TrustSet,
        typ: JwsTyp?,
        requireTyp: Boolean = true,
        maxPayloadBytes: Int? = null,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): VerifiedJws? {
        val payloadCap = maxOf(maxPayloadBytes ?: MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES)
        if (payloadCap > MAX_PAYLOAD_BYTES && (typ == null || !requireTyp)) return null
        val payloadCapB64 = b64Cap(payloadCap)

        // 1. Exactly three "."-separated segments.
        val parts = jws.split('.')
        if (parts.size != 3) return null
        val (encHeader, encPayload, encSig) = parts

        // 2-3. Bound the ENCODED segments before decoding anything (UTF-8 length, as Swift).
        if (encHeader.toByteArray(Charsets.UTF_8).size > MAX_HEADER_B64) return null
        if (encPayload.toByteArray(Charsets.UTF_8).size > payloadCapB64) return null

        // 4-5. Strict base64url, then bound the decoded header.
        val headerBytes = Base64Url.decodeStrict(encHeader) ?: return null
        if (headerBytes.size > MAX_HEADER_BYTES) return null

        // 6. Parse the header under V4 §1.2 (duplicate names refused).
        val header = StrictJson.validate(headerBytes)?.value ?: return null
        fun optionalString(name: String): Result<String?> {
            val v = header[name]
            return when {
                v == null || v.isNull -> Result.success(null)
                v.stringValue != null -> Result.success(v.stringValue)
                else -> Result.failure(IllegalStateException(name))
            }
        }
        val alg = optionalString("alg").getOrElse { return null }
        val headerTyp = optionalString("typ").getOrElse { return null }
        val kid = optionalString("kid").getOrElse { return null }

        // 7. alg == EdDSA, BEFORE any signature math (the downgrade guard).
        if (alg != "EdDSA") return null

        // 8. Domain separation (§2).
        if (requireTyp && headerTyp == null) return null
        if (headerTyp != null && typ != null && headerTyp != typ.wire) return null

        // 9-10. The key comes FROM THE TRUST SET; a revoked kid is absent by construction.
        if (kid == null) return null
        val rawKeyB64 = trust[kid] ?: return null
        val rawKey = Base64Url.decode(rawKeyB64) ?: return null
        if (rawKey.size != 32) return null

        // 11-12. V4 §1.1 prechecks, then the backend, over the ORIGINAL substrings.
        val sig = Base64Url.decodeStrict(encSig) ?: return null
        if (!Ed25519Strict.prechecks(rawKey, sig)) return null
        val signingInput = "$encHeader.$encPayload".toByteArray(Charsets.UTF_8)
        if (!verifier.verify(rawKey, signingInput, sig)) return null

        // 13. ONLY NOW decode the payload, bound it, and validate it under V4 §1.2.
        val payloadBytes = Base64Url.decodeStrict(encPayload) ?: return null
        if (payloadBytes.size > payloadCap) return null
        val parsed = StrictJson.validate(payloadBytes) ?: return null
        return VerifiedJws(kid, payloadBytes, parsed.value, parsed.nonWireIntegers)
    }
}
