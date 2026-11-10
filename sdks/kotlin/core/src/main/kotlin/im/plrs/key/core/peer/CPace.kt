// WIRE-CONTRACT-V5 section 15.12, "The mode-q handshake": CPace for account-free local pairing (CC-29.13).
// Suite CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21 in its initiator-responder setting, as client-core's
// `peer/cpace.ts` writes it from the draft's text: the string functions (`prepend_len`, `lv_cat`,
// `generator_string`, `transcript_ir`), `decodeUCoordinate`, the Elligator 2 map, the share check, the ISK, the
// PSK that feeds Noise, and the two frames (C1, C2) that run before it. Nothing here does I/O.
//
// Timing. Every scalar multiplication runs through a [DeviceCurves] backend (the JCA's X25519, or Tink's on
// Android API 24-32), which is constant time. The Elligator 2 map does not: it runs over `BigInteger`, as the
// reference does over `bigint`, whose arithmetic is variable time, and its input is derived from the password.
// The shower makes its generators at every rotation, before its window takes the next C1, and a joiner that
// scanned a QR makes its own before it dials. A joiner that typed a code cannot: the `sid` is the advert's
// instance, so its map runs between a chosen advert and its connection, at most twice per code and 300 s (the
// dial budget, `Local.kt`). Callers MUST make a generator ahead of the connection that needs it, never inside the
// reply to a peer's frame.
//
// A share or a K that breaks a rule is a refusal, not an exception: the caller closes the connection silently and
// counts no failure (section 15.12 step 3).

package im.plrs.key.core.peer

import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.DeviceCurvesSelection
import im.plrs.key.core.X25519Points
import java.math.BigInteger
import java.security.MessageDigest

/** What a pairing's code or QR is made of: `code` for the 6-digit password, `qr` for the 16-byte secret. */
public enum class CpaceKind(public val wire: Int) { code(1), qr(2) }

/** The first byte of both frames. */
public const val CPACE_FRAME_VERSION: Int = 1
public const val CPACE_C1_LENGTH: Int = 34
public const val CPACE_C2_LENGTH: Int = 33
public const val CPACE_SHARE_LENGTH: Int = 32

/** The QR secret, in bytes. */
public const val CPACE_QR_SECRET_BYTES: Int = 16

private const val DSI = "CPace255"
private const val DSI_ISK = "CPace255_ISK"

/** SHA-512's input block size, the draft's `s_in_bytes`. */
private const val S_IN_BYTES = 128
private const val SHARE_BYTES = 32
private const val LEB_GROUP = 128
private const val BYTE = 0xff
private const val TOP_BIT = 0x80
private const val MASK_255 = 0x7f
private const val PASSWORD_DIGITS = 6
private val PASSWORD_RE = Regex("[0-9]{$PASSWORD_DIGITS}")

private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

private fun cat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) {
        p.copyInto(out, off)
        off += p.size
    }
    return out
}

private fun sha512(vararg parts: ByteArray): ByteArray {
    val d = MessageDigest.getInstance("SHA-512")
    for (p in parts) d.update(p)
    return d.digest()
}

// -- The draft's string functions (appendix A) ----------------------------------------------------

/** `prepend_len`: the LEB128 length, then the data. */
public fun prependLen(data: ByteArray): ByteArray {
    val len = ArrayList<Byte>()
    var rest = data.size
    while (rest >= LEB_GROUP) {
        len += ((rest % LEB_GROUP) + LEB_GROUP).toByte()
        rest /= LEB_GROUP
    }
    len += rest.toByte()
    return cat(len.toByteArray(), data)
}

/** `lv_cat`: every argument length-prefixed, then concatenated. */
public fun lvCat(vararg args: ByteArray): ByteArray = cat(*Array(args.size) { prependLen(args[it]) })

/** `generator_string(DSI, PRS, CI, sid, s_in_bytes)`. */
public fun generatorString(dsi: ByteArray, prs: ByteArray, ci: ByteArray, sid: ByteArray, sInBytes: Int): ByteArray {
    val zpad = maxOf(0, sInBytes - 1 - prependLen(prs).size - prependLen(dsi).size)
    return lvCat(dsi, prs, ByteArray(zpad), ci, sid)
}

/** `transcript_ir(Ya, ADa, Yb, ADb)`. */
public fun transcriptIr(ya: ByteArray, ada: ByteArray, yb: ByteArray, adb: ByteArray): ByteArray = cat(lvCat(ya, ada), lvCat(yb, adb))

// -- The field, decodeUCoordinate and the Elligator 2 map -----------------------------------------

/** The prime of Curve25519, 2^255 - 19. */
private val P: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))

/** The Montgomery coefficient A of Curve25519 (B = 1). */
private val A: BigInteger = BigInteger.valueOf(486662)

/** The non-square the draft's `find_z_ell2` finds for Curve25519. */
private val Z: BigInteger = BigInteger.valueOf(2)
private val P_MINUS_TWO: BigInteger = P.subtract(BigInteger.valueOf(2))
private val HALF: BigInteger = P.subtract(BigInteger.ONE).shiftRight(1)

/** The little-endian integer of [b], bit 255 cleared: `decodeUCoordinate(u, 255)`, not reduced. */
private fun decodeU(b: ByteArray): BigInteger {
    val be = ByteArray(SHARE_BYTES) { b[SHARE_BYTES - 1 - it] }
    be[0] = (be[0].toInt() and MASK_255).toByte()
    return BigInteger(1, be)
}

/** 32 little-endian bytes of a field element in `[0, p)`. */
private fun encodeU(x: BigInteger): ByteArray {
    val be = x.toByteArray()
    val out = ByteArray(SHARE_BYTES)
    // `toByteArray` is big-endian with an optional sign byte: copy the low 32 bytes, little-endian.
    for (i in 0 until minOf(be.size, SHARE_BYTES)) out[i] = be[be.size - 1 - i]
    return out
}

/** The map's answer for 32 input bytes. */
public class Elligator2Result(
    /** `decodeUCoordinate(input) mod p`, 32 bytes. */
    public val r: ByteArray,
    /** Whether `v = -A / (1 + 2 r^2)` is on the curve; otherwise the result comes from the twist. */
    public val onCurve: Boolean,
    /** The u-coordinate of the result, 32 bytes little-endian. */
    public val u: ByteArray,
) {
    override fun toString(): String = "Elligator2Result(onCurve=$onCurve)"
}

/**
 * The draft's `map_to_curve_elligator2` for Curve25519 (Z = 2) on 32 input bytes. It is variable time (see the file
 * header): run it ahead of the connection, never on the network path.
 */
public fun elligator2(input: ByteArray): Elligator2Result {
    require(input.size == SHARE_BYTES) { "elligator2: 32 bytes" }
    val r = decodeU(input).mod(P)
    // 1 + 2 r^2 is never 0: -1/2 is a non-square mod p, since p = 5 (mod 8).
    val v = A.negate().multiply(BigInteger.ONE.add(Z.multiply(r).multiply(r)).modPow(P_MINUS_TWO, P)).mod(P)
    val gv = v.pow(3).add(A.multiply(v).multiply(v)).add(v).mod(P)
    val eps = gv.modPow(HALF, P)
    // g(v) is never 0 (A^2 - 4 is a non-square), so eps is 1 or p - 1.
    require(eps == BigInteger.ONE || eps == P.subtract(BigInteger.ONE)) { "elligator2: g(v) is zero" }
    val onCurve = eps == BigInteger.ONE
    return Elligator2Result(encodeU(r), onCurve, encodeU(if (onCurve) v else v.negate().subtract(A).mod(P)))
}

// -- The password-related string and the generator ------------------------------------------------

/** `"pkey-peer/1 code" 0x00 <the 6 ASCII password digits>`. */
public fun cpacePrsCode(digits: String): ByteArray {
    require(PASSWORD_RE.matches(digits)) { "cpace: password" }
    return cat(utf8("pkey-peer/1 code"), byteArrayOf(0), utf8(digits))
}

/** `"pkey-peer/1 qr" 0x00 <the 16 secret bytes>`. */
public fun cpacePrsQr(secret: ByteArray): ByteArray {
    require(secret.size == CPACE_QR_SECRET_BYTES) { "cpace: QR secret" }
    return cat(utf8("pkey-peer/1 qr"), byteArrayOf(0), secret)
}

/**
 * The generator: `g = elligator2(SHA-512(generator_string(DSI, PRS, CI, sid, 128))[0..32])`, its u-coordinate as 32
 * bytes. [ci] is the mode-q prologue and [sid] the window's 10 bytes.
 */
public fun cpaceGenerator(prs: ByteArray, ci: ByteArray, sid: ByteArray): ByteArray {
    val hash = sha512(generatorString(utf8(DSI), prs, ci, sid, S_IN_BYTES)).copyOf(SHARE_BYTES)
    return elligator2(hash).u
}

// -- Shares and the refusals (section 15.12 step 3) -----------------------------------------------

/** The verdict on one share. */
public sealed class ShareVerdict {
    public object Ok : ShareVerdict()

    public class Refused(public val reason: String) : ShareVerdict() {
        override fun toString(): String = "Refused($reason)"
    }
}

/**
 * A share is 32 bytes, canonical (bit 255 clear and u < 2^255 - 19) and not one of the low-order points. The
 * canonical check comes first, so the low-order points at or above p refuse as non-canonical. This is stricter than
 * the draft, which processes a non-canonical share.
 */
public fun checkShare(y: ByteArray): ShareVerdict {
    if (y.size != CPACE_SHARE_LENGTH) return ShareVerdict.Refused("length")
    if ((y[SHARE_BYTES - 1].toInt() and TOP_BIT) != 0 || decodeU(y) >= P) return ShareVerdict.Refused("non-canonical")
    if (X25519Points.isLowOrder(y)) return ShareVerdict.Refused("low-order")
    return ShareVerdict.Ok
}

/** A fresh 32-byte scalar. X25519 clamps it. */
public fun cpaceScalar(random: (Int) -> ByteArray = NoisePorts().random): ByteArray = random(SHARE_BYTES)

/**
 * A DH output is usable when it is 32 bytes and not all zero. The test ORs every byte, with no early exit, so it does not
 * branch on the secret; a backend may answer zeros rather than refuse a low-order share.
 */
private fun usable(k: ByteArray?): Boolean {
    if (k == null || k.size != SHARE_BYTES) return false
    var acc = 0
    for (b in k) acc = acc or (b.toInt() and BYTE)
    return acc != 0
}

/** `Y = X25519(y, g)`. Null when the backend refuses (a degenerate generator). */
public fun cpaceShare(y: ByteArray, g: ByteArray, curves: DeviceCurves = DeviceCurvesSelection.curves): ByteArray? =
    curves.x25519(y, g)?.takeIf { usable(it) }

/**
 * `ISK = SHA-512(lv_cat("CPace255_ISK", sid, K) || transcript_ir(Ya, "", Yb, ""))`, 64 bytes, or null when K is 32
 * zero bytes (or the backend refuses the peer's share): the attempt aborts silently. The peer's share must already
 * have passed [checkShare]. [scalar] is overwritten. [ya] is the joiner's share and [yb] the shower's, as they
 * appear on the wire.
 */
public fun cpaceIsk(
    sid: ByteArray,
    scalar: ByteArray,
    ya: ByteArray,
    yb: ByteArray,
    initiator: Boolean,
    curves: DeviceCurves = DeviceCurvesSelection.curves,
): ByteArray? {
    val peer = if (initiator) yb else ya
    val k = curves.x25519(scalar, peer)
    scalar.fill(0)
    if (!usable(k)) return null
    val empty = ByteArray(0)
    val isk = sha512(lvCat(utf8(DSI_ISK), sid, k!!), transcriptIr(ya, empty, yb, empty))
    k.fill(0)
    return isk
}

/** The Noise PSK of a pairing attempt: `HKDF-SHA256(salt = empty, ikm = ISK, info = "pkey-peer/1 cpace" 0x00 slug)`. */
public fun cpacePsk(isk: ByteArray, slug: String): ByteArray =
    hkdfSha256(ByteArray(0), isk, cat(utf8("pkey-peer/1 cpace"), byteArrayOf(0), utf8(slug)), SHARE_BYTES)

// -- The frames C1 and C2 (section 15.12 step 2) --------------------------------------------------

/** C1, joiner to shower: `0x01 || kind || Ya`, 34 bytes. */
public fun encodeC1(kind: CpaceKind, ya: ByteArray): ByteArray = cat(byteArrayOf(CPACE_FRAME_VERSION.toByte(), kind.wire.toByte()), ya)

/** C2, shower to joiner: `0x01 || Yb`, 33 bytes. */
public fun encodeC2(yb: ByteArray): ByteArray = cat(byteArrayOf(CPACE_FRAME_VERSION.toByte()), yb)

/** The receiver's judgement of a frame. */
public sealed class FrameVerdict {
    public class Ok(public val kind: CpaceKind?, public val share: ByteArray) : FrameVerdict() {
        override fun toString(): String = "Ok(kind=$kind)"
    }

    /** [reason]: length, version, kind, non-canonical or low-order. */
    public class Refused(public val reason: String) : FrameVerdict() {
        override fun toString(): String = "Refused($reason)"
    }
}

private fun shareOf(share: ByteArray, kind: CpaceKind?): FrameVerdict = when (val v = checkShare(share)) {
    ShareVerdict.Ok -> FrameVerdict.Ok(kind, share)
    is ShareVerdict.Refused -> FrameVerdict.Refused(v.reason)
}

/** The receiver's judgement of C1: length, version, kind, then the share. */
public fun parseC1(b: ByteArray): FrameVerdict {
    if (b.size != CPACE_C1_LENGTH) return FrameVerdict.Refused("length")
    if ((b[0].toInt() and BYTE) != CPACE_FRAME_VERSION) return FrameVerdict.Refused("version")
    val kind = CpaceKind.entries.firstOrNull { it.wire == (b[1].toInt() and BYTE) } ?: return FrameVerdict.Refused("kind")
    return shareOf(b.copyOfRange(2, CPACE_C1_LENGTH), kind)
}

/** The receiver's judgement of C2: length, version, then the share. */
public fun parseC2(b: ByteArray): FrameVerdict {
    if (b.size != CPACE_C2_LENGTH) return FrameVerdict.Refused("length")
    if ((b[0].toInt() and BYTE) != CPACE_FRAME_VERSION) return FrameVerdict.Refused("version")
    return shareOf(b.copyOfRange(1, CPACE_C2_LENGTH), null)
}
