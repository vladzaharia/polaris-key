// base64url <-> bytes, mirroring `@polaris-key/jws`'s `base64UrlDecode` / `base64UrlEncode` so the
// verifier is byte-stable against the cross-language corpus.

package im.plrs.key.core

import java.util.Base64

public object Base64Url {
    private fun inAlphabet(c: Char): Boolean =
        c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'

    /**
     * Strict base64url decode for WIRE segments (header, payload, signature): the unpadded `-_`
     * alphabet only — no `+` or `/`, no `=`, no whitespace (WIRE-CONTRACT-V2 §2.3, audit R2-05).
     * Null on any error, never a throw.
     */
    public fun decodeStrict(s: String): ByteArray? {
        for (c in s) if (!inAlphabet(c)) return null
        return decode(s)
    }

    /**
     * Lenient decode (URL-safe or standard alphabet, padding optional), as `@polaris-key/jws`
     * decodes trust-set key material. JWS segments use [decodeStrict].
     */
    public fun decode(s: String): ByteArray? {
        var b64 = s.replace('-', '+').replace('_', '/')
        val remainder = b64.length % 4
        if (remainder != 0) b64 += "=".repeat(4 - remainder)
        return try {
            Base64.getDecoder().decode(b64)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** Unpadded base64url. */
    public fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Unpadded base64url of a string's UTF-8 bytes. */
    public fun encode(text: String): String = encode(text.toByteArray(Charsets.UTF_8))
}
