// base64url <-> bytes, mirroring `@polaris-key/jws`'s `base64UrlDecode` / `base64UrlEncode` so the
// verifier is byte-stable against the cross-language corpus.
//
// SP-50: its own codec, not java.util.Base64, which Android has only from API 26 (the SDK's minSdk is
// 24: every client died deriving its device id on API 24 and 25). The decoder is the JDK basic
// decoder's algorithm, step for step (the same inputs refused, the same bytes out, leftover bits
// ignored as the JDK ignores them); Base64UrlTest checks it against the JDK on the JVM.

package im.plrs.key.core

public object Base64Url {
    private const val STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private const val URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val VALUES = IntArray(128) { -1 }.also { table -> STANDARD.forEachIndexed { i, c -> table[c.code] = i } }

    private fun inAlphabet(c: Char): Boolean =
        c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'

    /**
     * Strict base64url decode for WIRE segments (header, payload, signature): the unpadded `-_`
     * alphabet only — no `+` or `/`, no `=`, no whitespace — and only the CANONICAL spelling
     * (WIRE-CONTRACT-V4 §1): a length that is not 1 mod 4 and whose last character's unused low
     * bits are zero, so every byte string has exactly one accepted spelling. Null on any error,
     * never a throw.
     */
    public fun decodeStrict(s: String): ByteArray? {
        if (!isCanonical(s)) return null
        return decode(s)
    }

    /** WIRE-CONTRACT-V4 §1: the alphabet, no padding, `length % 4 != 1`, and zero unused bits. */
    public fun isCanonical(s: String): Boolean {
        for (c in s) if (!inAlphabet(c)) return false
        val rem = s.length % 4
        if (rem == 1) return false
        if (rem == 0) return true
        val last = URL.indexOf(s[s.length - 1])
        return if (rem == 2) last and 0x0f == 0 else last and 0x03 == 0
    }

    /**
     * Lenient decode (URL-safe or standard alphabet, padding optional), as `@polaris-key/jws`
     * decodes trust-set key material. JWS segments use [decodeStrict].
     */
    public fun decode(s: String): ByteArray? {
        var b64 = s.replace('-', '+').replace('_', '/')
        val remainder = b64.length % 4
        if (remainder != 0) b64 += "=".repeat(4 - remainder)
        return decodeBasic(b64)
    }

    /** The JDK's `Base64.getDecoder().decode`, as an algorithm: null where it throws. */
    private fun decodeBasic(src: String): ByteArray? {
        val sl = src.length
        val out = ByteArray(sl / 4 * 3 + 3)
        var dp = 0
        var bits = 0
        var shiftto = 18
        var sp = 0
        while (sp < sl) {
            val c = src[sp++]
            val b = if (c.code < 128) VALUES[c.code] else -1
            if (b < 0) {
                if (c != '=') return null
                // "=" where a unit starts, "x=" (a dangling x), "xx=" not followed by "=": refused.
                if (shiftto == 6 && (sp == sl || src[sp++] != '=') || shiftto == 18) return null
                break
            }
            bits = bits or (b shl shiftto)
            shiftto -= 6
            if (shiftto < 0) {
                out[dp++] = (bits shr 16).toByte()
                out[dp++] = (bits shr 8).toByte()
                out[dp++] = bits.toByte()
                shiftto = 18
                bits = 0
            }
        }
        when (shiftto) {
            6 -> out[dp++] = (bits shr 16).toByte()
            0 -> {
                out[dp++] = (bits shr 16).toByte()
                out[dp++] = (bits shr 8).toByte()
            }
            12 -> return null
        }
        // Anything after the padding is refused.
        if (sp < sl) return null
        return out.copyOf(dp)
    }

    /** Unpadded base64url. */
    public fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        while (i + 3 <= bytes.size) {
            val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8) or (bytes[i + 2].toInt() and 0xff)
            out.append(URL[n shr 18 and 63]).append(URL[n shr 12 and 63]).append(URL[n shr 6 and 63]).append(URL[n and 63])
            i += 3
        }
        when (bytes.size - i) {
            1 -> {
                val n = bytes[i].toInt() and 0xff shl 16
                out.append(URL[n shr 18 and 63]).append(URL[n shr 12 and 63])
            }
            2 -> {
                val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8)
                out.append(URL[n shr 18 and 63]).append(URL[n shr 12 and 63]).append(URL[n shr 6 and 63])
            }
        }
        return out.toString()
    }

    /** Unpadded base64url of a string's UTF-8 bytes. */
    public fun encode(text: String): String = encode(text.toByteArray(Charsets.UTF_8))
}
