// The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §2.1), pinned by
// `device-label.json`: the human name of this device the sign-in page shows ("Living room TV"),
// sent as `deviceName` on device-code sign-in, licence activation and registration. Display data
// only; no server decision reads it. The Worker applies the same normalisation on receipt:
//
//   1. map the whitespace controls (U+0009–000D, U+0085, U+00A0, U+2028, U+2029, U+3000) to a
//      space;
//   2. delete the controls, zero-width and bidi code points;
//   3. collapse runs of spaces to one, then trim;
//   4. keep at most DEVICE_LABEL_MAX_CODEPOINTS code points (never UTF-16 units), and trim a space
//      the cut exposes;
//   5. an empty result is no label (null).
//
// No Unicode normalisation; nothing is ever rejected.

package im.plrs.key.core

import java.net.InetAddress

private val SPACE_RANGES: List<IntRange> = listOf(0x0009..0x000D, 0x0085..0x0085, 0x00A0..0x00A0, 0x2028..0x2029, 0x3000..0x3000)
private val STRIP_RANGES: List<IntRange> = listOf(
    0x0000..0x001F, 0x007F..0x009F, 0x061C..0x061C, 0x200B..0x200F,
    0x202A..0x202E, 0x2060..0x2064, 0x2066..0x2069, 0xFEFF..0xFEFF,
)

/** §12.7.1: the label to send and store, or null when nothing is left of [raw]. */
public fun normalizeDeviceLabel(raw: String?): String? {
    if (raw == null) return null
    val kept = ArrayList<Int>()
    raw.codePoints().forEach { original ->
        var cp = original
        if (SPACE_RANGES.any { cp in it }) {
            cp = 0x20
        } else if (STRIP_RANGES.any { cp in it }) {
            return@forEach
        }
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
