// The device label (WIRE-CONTRACT-V5 §12.7.1, plans/PX-W13.md §2.1), pinned by
// `device-label.json` (`deviceLabelVersion` 2): the human name of this device the sign-in page
// shows ("Living room TV"), sent as `deviceName` on device-code sign-in, licence activation and
// registration. Display data only; no server decision reads it. The Worker applies the same
// normalisation on receipt:
//
//   1. map every White_Space code point and U+2800 to a space;
//   2. delete the controls, format characters, default-ignorable code points and surrogates;
//   3. collapse runs of spaces to one, then trim;
//   4. keep at most DEVICE_LABEL_MAX_CODEPOINTS code points (never UTF-16 units), and trim a space
//      the cut exposes;
//   5. an empty result is no label (null).
//
// normalizeDeviceLabel is steps 1 to 5 with no Unicode normalisation. cleanDisplayLabel is the
// peer HELLO cleaner (section 15.6): steps 1 and 2, NFC, then steps 3 to 5. Cleaning a cleaned
// label changes nothing. Nothing is ever rejected.

package im.plrs.key.core

import java.net.InetAddress
import java.text.Normalizer

/** Step 1's table, frozen at Unicode 16.0; the corpus `ranges.space` section pins it. */
public val DEVICE_LABEL_SPACE_RANGES: List<IntRange> = listOf(
    0x0009..0x000D, 0x0085..0x0085, 0x00A0..0x00A0, 0x1680..0x1680, 0x2000..0x200A,
    0x2028..0x2029, 0x202F..0x202F, 0x205F..0x205F, 0x2800..0x2800, 0x3000..0x3000,
)

/** Step 2's table, frozen at Unicode 16.0; the corpus `ranges.strip` section pins it. */
public val DEVICE_LABEL_STRIP_RANGES: List<IntRange> = listOf(
    0x0000..0x001F, 0x007F..0x009F, 0x00AD..0x00AD, 0x034F..0x034F, 0x0600..0x0605,
    0x061C..0x061C, 0x06DD..0x06DD, 0x070F..0x070F, 0x0890..0x0891, 0x08E2..0x08E2,
    0x115F..0x1160, 0x17B4..0x17B5, 0x180B..0x180F, 0x200B..0x200F, 0x202A..0x202E,
    0x2060..0x206F, 0x3164..0x3164, 0xD800..0xDFFF, 0xFE00..0xFE0F, 0xFEFF..0xFEFF,
    0xFFA0..0xFFA0, 0xFFF0..0xFFFB, 0x110BD..0x110BD, 0x110CD..0x110CD, 0x13430..0x1343F,
    0x1BCA0..0x1BCA3, 0x1D173..0x1D17A, 0xE0000..0xE0FFF,
)

/** Steps 1 and 2: a space for each blank, nothing for each invisible code point (a lone surrogate included). */
private fun mapAndStrip(raw: String): String {
    val out = StringBuilder(raw.length)
    raw.codePoints().forEach { cp ->
        if (DEVICE_LABEL_SPACE_RANGES.any { cp in it }) {
            out.append(' ')
        } else if (DEVICE_LABEL_STRIP_RANGES.none { cp in it }) {
            out.appendCodePoint(cp)
        }
    }
    return out.toString()
}

/** Steps 3 to 5. */
private fun collapseAndCut(text: String): String? {
    val kept = ArrayList<Int>()
    text.codePoints().forEach { cp ->
        if (cp == 0x20 && (kept.isEmpty() || kept.last() == 0x20)) return@forEach
        kept.add(cp)
    }
    while (kept.isNotEmpty() && kept.last() == 0x20) kept.removeAt(kept.size - 1)
    val cut = ArrayList(kept.take(DEVICE_LABEL_MAX_CODEPOINTS.toInt()))
    while (cut.isNotEmpty() && cut.last() == 0x20) cut.removeAt(cut.size - 1)
    if (cut.isEmpty()) return null
    val out = StringBuilder()
    cut.forEach { out.appendCodePoint(it) }
    return out.toString()
}

/** §12.7.1: the label to send and store, or null when nothing is left of [raw]. */
public fun normalizeDeviceLabel(raw: String?): String? =
    if (raw == null) null else collapseAndCut(mapAndStrip(raw))

/**
 * §15.6: a peer's `label` or `app` as shown. Steps 1 and 2, NFC, then steps 3 to 5 (the cut counts
 * code points after NFC). Null when nothing is left.
 */
public fun cleanDisplayLabel(raw: String?): String? =
    if (raw == null) null else collapseAndCut(Normalizer.normalize(mapAndStrip(raw), Normalizer.Form.NFC))

private val HOST_SUFFIX = Regex("\\.(local|lan|home)$", RegexOption.IGNORE_CASE)

/** The JVM's name for this machine: the local host name without `.local`, `.lan` or `.home`. */
public fun jvmDefaultDeviceName(): String? = try {
    InetAddress.getLocalHost().hostName.replace(HOST_SUFFIX, "").ifEmpty { null }
} catch (e: Exception) {
    null
}

/**
 * [override] (per call) wins, then [configured] (the client option), then [platformDefault].
 * `""` at either level sends none.
 */
public fun resolveDeviceLabel(override: String?, configured: String?, platformDefault: () -> String? = ::jvmDefaultDeviceName): String? =
    when {
        override != null -> normalizeDeviceLabel(override)
        configured != null -> normalizeDeviceLabel(configured)
        else -> normalizeDeviceLabel(platformDefault())
    }
