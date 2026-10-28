// The device proof `pkey-proof/1` (WIRE-CONTRACT-V5 section 12.11.1, 15.8; plans/CC-01.md R-6): the
// message a device signs, a verifier for it and the signer over a [DeviceKeyPort]. Mirrors
// client-core's deviceProof.ts and deviceKeys.ts. The vectors are
// conformance/corpus/v2/device-proof.json.

package im.plrs.key.core

import java.math.BigInteger

/** The nine purposes, in the order of V5 section 12.11.1. */
public enum class DeviceProofPurpose(public val wire: String) {
    keys("keys"),
    nonce("nonce"),
    exchange("exchange"),
    link("link"),
    nearbyStart("nearby-start"),
    nearbyPoll("nearby-poll"),
    nearbyApprove("nearby-approve"),
    vouch("vouch"),
    restore("restore"),
    ;

    public companion object {
        public fun fromWire(s: String): DeviceProofPurpose? = entries.firstOrNull { it.wire == s }
    }
}

/** The fields of the six message lines. [purpose] is the wire word, so an unknown one is representable (and refused). */
public data class DeviceProofFields(
    val purpose: String,
    /** The product slug. */
    val product: String,
    /** The `X-PKey-Device` value. */
    val deviceId: String,
    /** The purpose's value (line 5). */
    val value: String,
    /** Base64url SHA-256 of the presented provider token, or `-` when none (line 6). */
    val tokenHash: String = "-",
)

/** A signed proof: the fields, the signing key (raw 32 bytes, base64url) and the 64-byte signature (base64url). */
public data class DeviceProof(val fields: DeviceProofFields, val signKey: String, val sig: String) {
    val purpose: String get() = fields.purpose
}

/** A proof could not be built or did not verify. The text never names a key or a signature. */
public class DeviceProofException(message: String) : Exception(message)

public object DeviceProofs {
    public const val LINE1: String = "pkey-proof/1"

    /** The `keys` proof's skew window, in seconds either side of now. */
    public const val KEYS_SKEW_SECONDS: Long = 300

    private val PRODUCT_SLUG = Regex("^[a-z0-9][a-z0-9-]{0,63}$")
    private val KEYS_VALUE = Regex("^([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})\\.(0|[1-9][0-9]{0,15})$")
    private const val MAX_SAFE = 9007199254740991L

    /** The `keys` purpose's value: `<signKey>.<agreeKey>.<issuedAt>`. */
    public fun keysValue(signKey: String, agreeKey: String, issuedAt: Long): String = "$signKey.$agreeKey.$issuedAt"

    private fun lineOk(s: String): Boolean = s.isNotEmpty() && s.all { it.code in 0x21..0x7e }

    /** The bytes a device signs, or null when a field would break the line format. */
    public fun message(f: DeviceProofFields): ByteArray? {
        val lines = listOf(LINE1, f.purpose, f.product, f.deviceId, f.value, f.tokenHash)
        if (!lines.all(::lineOk)) return null
        return lines.joinToString("\n").toByteArray(Charsets.US_ASCII)
    }

    private fun raw32(s: String): ByteArray? =
        if (s.length != 43) null else Base64Url.decodeStrict(s)?.takeIf { it.size == 32 }

    private fun keysValueOk(p: DeviceProof, now: Long?): Boolean {
        if (p.fields.tokenHash != "-" || now == null) return false
        val m = KEYS_VALUE.matchEntire(p.fields.value) ?: return false
        if (m.groupValues[1] != p.signKey) return false
        val agree = raw32(m.groupValues[2]) ?: return false
        if (!X25519Points.isAcceptableAgreeKey(agree)) return false
        val issuedAt = BigInteger(m.groupValues[3])
        if (issuedAt > BigInteger.valueOf(MAX_SAFE)) return false
        return (issuedAt.toLong() - now).let { if (it < 0) -it else it } <= KEYS_SKEW_SECONDS
    }

    /**
     * True only for a strict Ed25519 proof by `signKey` (V5 section 12.11.1); it never says why not.
     * [now] (epoch seconds) is needed for purpose `keys`, whose `issuedAt` must lie within the skew window.
     */
    public fun verify(proof: DeviceProof, now: Long? = null, verifier: Ed25519Verifier = Ed25519.verifier): Boolean {
        val purpose = DeviceProofPurpose.fromWire(proof.fields.purpose) ?: return false
        val key = raw32(proof.signKey) ?: return false
        val message = message(proof.fields) ?: return false
        if (purpose == DeviceProofPurpose.keys && !keysValueOk(proof, now)) return false
        if (proof.sig.length != 86) return false
        val sig = Base64Url.decodeStrict(proof.sig)?.takeIf { it.size == 64 } ?: return false
        if (!Ed25519Strict.prechecks(key, sig)) return false
        return verifier.verify(key, message, sig)
    }

    private suspend fun refuseMemoryOnly(port: DeviceKeyPort, allowEphemeral: Boolean) {
        if (allowEphemeral) return
        if (port.persistence() == DeviceKeyPersistence.memory) throw DeviceKeyUnsupportedException("memory-only")
    }

    /**
     * Builds the `pkey-proof/1` message for [purpose], signs it through the port, checks the result
     * with the strict verifier and returns the proof. Refuses `keys` (use [signKeysProof]).
     * Throws [DeviceProofException] when a field breaks the line format, when the keys changed while
     * signing, or when the result would not verify.
     */
    public suspend fun sign(
        port: DeviceKeyPort,
        purpose: DeviceProofPurpose,
        product: String,
        deviceId: String,
        value: String,
        tokenHash: String = "-",
        now: Long = System.currentTimeMillis() / 1000,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): DeviceProof {
        if (purpose == DeviceProofPurpose.keys) throw DeviceProofException("device proof: use signKeysProof for keys")
        return signAny(port, DeviceProofFields(purpose.wire, product, deviceId, value, tokenHash), now, verifier)
    }

    private suspend fun signAny(port: DeviceKeyPort, fields: DeviceProofFields, now: Long, verifier: Ed25519Verifier): DeviceProof {
        val before = port.ensure()
        val message = message(fields) ?: throw DeviceProofException("device proof: bad field")
        val sig = Base64Url.encode(port.sign(message))
        val after = port.publicKeys()
        if (after == null || after.signKey != before.signKey || after.generation != before.generation) {
            throw DeviceProofException("device proof: keys changed while signing")
        }
        val proof = DeviceProof(fields, before.signKey, sig)
        if (!verify(proof, now, verifier)) throw DeviceProofException("device proof: did not verify")
        return proof
    }

    /** The result of [signKeysProof]. */
    public class KeysProof(public val proof: DeviceProof, public val keys: DevicePublicKeys, public val issuedAt: Long)

    /**
     * The `keys` proof: the value names the port's own `signKey` and `agreeKey` and [issuedAt]. Refuses a
     * memory-only port unless [allowEphemeral] (a flow that registers nothing).
     */
    public suspend fun signKeysProof(
        port: DeviceKeyPort,
        product: String,
        deviceId: String,
        issuedAt: Long = System.currentTimeMillis() / 1000,
        allowEphemeral: Boolean = false,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): KeysProof {
        if (!PRODUCT_SLUG.matches(product)) throw DeviceProofException("device proof: bad product")
        refuseMemoryOnly(port, allowEphemeral)
        val keys = port.ensure()
        val fields = DeviceProofFields(DeviceProofPurpose.keys.wire, product, deviceId, keysValue(keys.signKey, keys.agreeKey, issuedAt))
        val proof = signAny(port, fields, issuedAt, verifier)
        if (proof.signKey != keys.signKey) throw DeviceProofException("device proof: keys changed while signing")
        return KeysProof(proof, keys, issuedAt)
    }

    /** The body of `PUT /<p>/devices/keys` (CC-03.2): `sig` is the `keys` proof. */
    public data class DeviceKeysRequest(val signKey: String, val agreeKey: String, val issuedAt: Long, val sig: String)

    /** The path and body of `PUT <base>/<product>/devices/keys` for the port's keys. Resending it is safe. */
    public suspend fun buildDeviceKeysRequest(
        port: DeviceKeyPort,
        product: String,
        deviceId: String,
        issuedAt: Long = System.currentTimeMillis() / 1000,
        allowEphemeral: Boolean = false,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): Pair<String, DeviceKeysRequest> {
        val r = signKeysProof(port, product, deviceId, issuedAt, allowEphemeral, verifier)
        return "/$product/devices/keys" to DeviceKeysRequest(r.keys.signKey, r.keys.agreeKey, r.issuedAt, r.proof.sig)
    }
}
