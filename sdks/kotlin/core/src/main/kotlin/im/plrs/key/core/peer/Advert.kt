// WIRE-CONTRACT-V5 section 15.4: discovery adverts (CC-12.6). Pure functions: the account instance
// name, the product tag, TXT parsing and the browse match. Nothing here does I/O. Mirrors
// client-core's `peer/advert.ts`.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url

/** The advert epoch length. */
public const val ADVERT_EPOCH_SECONDS: Long = 900

private const val BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
private const val DEVICE_ID_CHARS = 32
private const val INSTANCE_CHARS = 16
private const val TAG_CHARS = 16
private const val MAX_KEYS = 2
private const val MAX_ROSTER = 128
private const val BITS_PER_BYTE = 8
private const val BITS_PER_CHAR = 5
private const val CHAR_MASK = 31
private const val BYTE_MASK = 0xff

private val DEVICE_ID = Regex("[A-Za-z0-9_-]{$DEVICE_ID_CHARS}")
private val INSTANCE = Regex("p1-[a-z2-7]{$INSTANCE_CHARS}")
private val TAG = Regex("[0-9a-f]{$TAG_CHARS}")

private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

private fun u64be(n: Long): ByteArray = ByteArray(BITS_PER_BYTE) { i -> (n ushr (BITS_PER_BYTE * (BITS_PER_BYTE - 1 - i))).toByte() }

private fun cat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) {
        p.copyInto(out, off)
        off += p.size
    }
    return out
}

/** The epoch a wall-clock second falls in. */
public fun advertEpoch(nowSeconds: Long): Long = Math.floorDiv(nowSeconds, ADVERT_EPOCH_SECONDS)

/** RFC 4648 base32, lower-case alphabet, no padding. */
public fun base32Lower(b: ByteArray): String {
    var bits = 0
    var acc = 0
    val out = StringBuilder()
    for (x in b) {
        acc = (acc shl BITS_PER_BYTE) or (x.toInt() and BYTE_MASK)
        bits += BITS_PER_BYTE
        while (bits >= BITS_PER_CHAR) {
            out.append(BASE32[(acc shr (bits - BITS_PER_CHAR)) and CHAR_MASK])
            bits -= BITS_PER_CHAR
        }
        acc = acc and ((1 shl bits) - 1)
    }
    if (bits > 0) out.append(BASE32[(acc shl (BITS_PER_CHAR - bits)) and CHAR_MASK])
    return out.toString()
}

/** A device id is 32 base64url characters: the 24 bytes the advert and the relay use. */
public fun deviceIdBytes(id: String): ByteArray {
    require(DEVICE_ID.matches(id)) { "device id" }
    return requireNotNull(Base64Url.decode(id)) { "device id" }
}

/** The mode-a instance name of a device in one epoch under one discovery key. */
public fun accountInstance(kDisc: ByteArray, epoch: Long, deviceId: String): String {
    val mac = hmacSha256(kDisc, cat(utf8("pkey-peer/1 disc"), byteArrayOf(0), u64be(epoch), deviceIdBytes(deviceId)))
    return "p1-" + base32Lower(mac).substring(0, INSTANCE_CHARS)
}

private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

/** The `h` TXT value of the approver and pair adverts. */
public fun productTag(slug: String, epoch: Long): String {
    val salt = sha256(utf8("pkey-peer/1 salt"), byteArrayOf(0), utf8(slug))
    val mac = hmacSha256(salt, cat(utf8("pkey-peer/1 pair"), byteArrayOf(0), u64be(epoch)))
    return hex(mac).substring(0, TAG_CHARS)
}

/** Is [name] the shape of an account instance name? */
public fun isInstanceName(name: String): Boolean = INSTANCE.matches(name)

/** Why a TXT record was refused. The names are the corpus's. */
public enum class TxtRefusal { duplicate, version, mode, tag }

/** The outcome of [parseTxt]. */
public sealed class TxtResult {
    /** A usable record: the [mode] and, for modes v and p, the product tag [h]. */
    public data class Ok(val mode: PeerMode, val h: String? = null) : TxtResult()

    /** A refused record. */
    public data class Refused(val reason: TxtRefusal) : TxtResult()
}

/**
 * An entry splits at its first `=`; one without `=` or with an empty key is ignored; a repeated
 * key refuses.
 */
public fun parseTxt(entries: List<String>): TxtResult {
    val kv = HashMap<String, String>()
    for (e in entries) {
        val at = e.indexOf('=')
        if (at < 1) continue
        val k = e.substring(0, at)
        if (kv.containsKey(k)) return TxtResult.Refused(TxtRefusal.duplicate)
        kv[k] = e.substring(at + 1)
    }
    if (kv["v"] != "1") return TxtResult.Refused(TxtRefusal.version)
    val mode = PeerMode.values().firstOrNull { it.wire == kv["m"] } ?: return TxtResult.Refused(TxtRefusal.mode)
    if (mode == PeerMode.a) return TxtResult.Ok(mode)
    val h = kv["h"]
    if (h == null || !TAG.matches(h)) return TxtResult.Refused(TxtRefusal.tag)
    return TxtResult.Ok(mode, h)
}

/** Which roster device an advert belongs to. */
public data class BrowseHit(
    val deviceId: String,
    /** 0 the current epoch, 1 the previous one. */
    val epochBack: Int,
    /** 0 the newest discovery key, 1 the previous one. */
    val keyIndex: Int,
)

/**
 * Which roster device an account instance belongs to: the current and the previous epoch, the (at
 * most two) delivered keys, newest first. At most 512 HMACs for a 128-device roster.
 */
public fun browseAccountInstance(instance: String, kDiscs: List<ByteArray>, nowSeconds: Long, roster: List<String>): BrowseHit? {
    if (!isInstanceName(instance)) return null
    val epoch = advertEpoch(nowSeconds)
    val devices = roster.take(MAX_ROSTER)
    val keys = kDiscs.take(MAX_KEYS)
    for (epochBack in 0..1) {
        for ((keyIndex, key) in keys.withIndex()) {
            val hit = devices.firstOrNull { accountInstance(key, epoch - epochBack, it) == instance }
            if (hit != null) return BrowseHit(hit, epochBack, keyIndex)
        }
    }
    return null
}
