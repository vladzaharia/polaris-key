// WIRE-CONTRACT-V5 sections 15.6 and 15.6.1: display data from a peer that is not yet verified (a mode v
// or p HELLO, a `VOUCH_REQ`) is cleaned the same way wherever it is read. One file, so the channel and
// the vouch codecs cannot drift apart. Mirrors client-core's `peer/display.ts`.

package im.plrs.key.core.peer

import im.plrs.key.core.cleanDisplayLabel

/** What a field that fails cleaning is shown as. */
internal const val UNKNOWN_DISPLAY: String = "Unknown"

/** Section 15.6: `platform` is shown as sent only when it is up to 32 of these characters. */
private val PLATFORM_DISPLAY = Regex("[A-Za-z0-9 ._+-]{1,32}")

/** The device-label cleaning with NFC after the strip (sections 12.7.1 and 15.6): null when nothing is left. */
internal fun cleanLabel(raw: String): String? = cleanDisplayLabel(raw)

/** The platform as sent when it is up to 32 plain characters, else "Unknown". */
internal fun cleanPlatform(raw: String): String = if (PLATFORM_DISPLAY.matches(raw)) raw else UNKNOWN_DISPLAY

/** The app name, cleaned like a label; "Unknown" when nothing is left. */
internal fun cleanApp(raw: String): String = cleanLabel(raw) ?: UNKNOWN_DISPLAY

/** The `platform` a mode-v `HELLO` carries (display data): `android`, `darwin`, `win32` or `linux`. */
public fun peerHostPlatform(): String {
    if (System.getProperty("java.vendor").orEmpty().contains("Android")) return "android"
    val os = System.getProperty("os.name").orEmpty().lowercase()
    return when {
        os.startsWith("mac") -> "darwin"
        os.startsWith("win") -> "win32"
        else -> "linux"
    }
}
