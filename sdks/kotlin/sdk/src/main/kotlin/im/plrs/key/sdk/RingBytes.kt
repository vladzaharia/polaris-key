// Hex and base64url helpers of `client.keyring` (U-39.8): strict, lowercase, canonical.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url

internal const val HEX_DIGITS = "0123456789abcdef"
private const val NIBBLE_BITS = 4
private const val NIBBLE_MASK = 0xf

internal fun hex(b: ByteArray): String = buildString(b.size * 2) {
    for (x in b) {
        append(HEX_DIGITS[(x.toInt() shr NIBBLE_BITS) and NIBBLE_MASK])
        append(HEX_DIGITS[x.toInt() and NIBBLE_MASK])
    }
}

/** Lowercase hex to bytes; null for anything else. */
internal fun unhex(s: String): ByteArray? = if (s.length % 2 != 0 || s.any { it !in HEX_DIGITS }) {
    null
} else {
    ByteArray(s.length / 2) { (HEX_DIGITS.indexOf(s[it * 2]) * (NIBBLE_MASK + 1) + HEX_DIGITS.indexOf(s[it * 2 + 1])).toByte() }
}

/** A strict, canonical base64url value of [bytes] bytes (any length when null). */
internal fun unb64(s: String, bytes: Int? = null): ByteArray? {
    val d = if (s.isEmpty()) null else Base64Url.decodeStrict(s)
    return d?.takeIf { bytes == null || it.size == bytes }
}
