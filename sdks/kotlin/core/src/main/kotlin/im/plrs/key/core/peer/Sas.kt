// WIRE-CONTRACT-V5 section 15.5: the short authentication code of modes v and p, with its commit
// and reveal (CC-12.6). Nonces and commitments travel as 43 canonical base64url characters.
// Mirrors client-core's `peer/sas.ts`.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

private const val SAS_BYTES = 32
private const val SAS_CHARS = 43
private const val CODE_MODULUS = 1_000_000L
private const val CODE_DIGITS = 6
private const val TRIPLE = 3
private val SAS_TEXT = Regex("[A-Za-z0-9_-]{$SAS_CHARS}")

/** The commitment to a nonce: SHA-256. */
public fun sasCommit(nD: ByteArray): ByteArray = sha256(nD)

/** 32 bytes as 43 base64url characters. */
public fun encodeSasValue(b: ByteArray): String {
    require(b.size == SAS_BYTES) { "sas value" }
    return Base64Url.encode(b)
}

/** 43 canonical base64url characters to 32 bytes; anything else is null. */
public fun decodeSasValue(text: String): ByteArray? {
    if (!SAS_TEXT.matches(text)) return null
    val b = Base64Url.decodeStrict(text) ?: return null
    return b.takeIf { it.size == SAS_BYTES }
}

/** The member a SAS body carries. The names are the wire's. */
public enum class SasMember { c, nM, nD }

/** The body of SAS_COMMIT, SAS_NONCE or SAS_REVEAL: compact JSON, one member. */
public fun sasBody(member: SasMember, value: ByteArray): ByteArray =
    ("{\"" + member.name + "\":\"" + encodeSasValue(value) + "\"}").toByteArray(Charsets.UTF_8)

/** Read a body; null when it is anything but the canonical one-member object. */
public fun parseSasBody(member: SasMember, body: ByteArray): ByteArray? {
    val text = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(body)).toString()
    } catch (e: CharacterCodingException) {
        return null
    }
    val m = Regex("\\{\"" + member.name + "\":\"([A-Za-z0-9_-]+)\"\\}").matchEntire(text) ?: return null
    return decodeSasValue(m.groupValues[1])
}

/** The code, 0..999999, from the handshake hash and both nonces. */
public fun sasValue(h: ByteArray, nD: ByteArray, nM: ByteArray, mode: PeerMode): Int {
    val info = "pkey-peer/1 sas".toByteArray(Charsets.UTF_8) + byteArrayOf(0) + mode.wire.toByteArray(Charsets.UTF_8)
    val okm = hkdfSha256(h, nD + nM, info, SAS_BYTES)
    val word = ByteBuffer.wrap(okm).int.toLong() and 0xffffffffL
    return (word % CODE_MODULUS).toInt()
}

/** Six digits with leading zeros, a space between the triples. */
public fun sasDisplay(n: Int): String {
    val s = n.toString().padStart(CODE_DIGITS, '0')
    return s.substring(0, TRIPLE) + " " + s.substring(TRIPLE)
}

/** Does the revealed nonce match the commitment? Both are the base64url spelling. Constant time. */
public fun sasRevealOk(c: String, nD: String): Boolean {
    val commit = decodeSasValue(c) ?: return false
    val nonce = decodeSasValue(nD) ?: return false
    return MessageDigest.isEqual(sha256(nonce), commit)
}
