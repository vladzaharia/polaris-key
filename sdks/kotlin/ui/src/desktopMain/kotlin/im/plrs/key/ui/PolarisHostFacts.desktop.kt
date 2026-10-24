// The desktop's host facts (UK-10.4, K2): dark, accent, high contrast and reduced transparency, read
// from the OS by fixed argv. No shell, and no input from anyone ever enters an argv: every command
// below is a constant. Each read has a 500 ms budget, then the process is destroyed and the field
// keeps its default. Output is drained to a small cap and parsed; nothing is logged or executed.
// The reads run on Dispatchers.IO, never on the UI thread.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext

/** Runs a fixed argv and answers its stdout, or null on a failure, a non-zero exit or the timeout. */
internal fun interface HostCommandRunner {
    fun run(argv: List<String>, timeoutMs: Long): String?
}

internal const val HOST_READ_TIMEOUT_MS: Long = 500
private const val HOST_OUTPUT_CAP = 4096

/** The real runner: `ProcessBuilder(argv)` (no shell), stderr discarded, stdout drained and capped, destroyed on timeout. */
internal val SystemHostCommandRunner = HostCommandRunner { argv, timeoutMs ->
    runCatching {
        val p = ProcessBuilder(argv)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .redirectInput(ProcessBuilder.Redirect.from(java.io.File(if (System.getProperty("os.name").orEmpty().lowercase().contains("win")) "NUL" else "/dev/null")))
            .start()
        val out = ByteArrayOutputStream()
        // Drain on a daemon thread so a chatty or stuck child can never fill its pipe or hold this call.
        val drain = Thread {
            runCatching {
                val buf = ByteArray(1024)
                p.inputStream.use { s ->
                    while (true) {
                        val n = s.read(buf)
                        if (n < 0) break
                        if (out.size() < HOST_OUTPUT_CAP) out.write(buf, 0, minOf(n, HOST_OUTPUT_CAP - out.size()))
                    }
                }
            }
        }.apply { isDaemon = true; name = "pkey-host-drain"; start() }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        val done = p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!done) {
            p.destroyForcibly()
            drain.interrupt()
            return@runCatching null
        }
        drain.join(maxOf(1L, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())))
        if (p.exitValue() != 0) null else synchronized(out) { out.toString(Charsets.UTF_8) }
    }.getOrNull()
}

// ── macOS: `defaults read` ─────────────────────────────────────────────────────────────────────
internal val MAC_DARK_ARGV: List<String> = listOf("/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle")
internal val MAC_ACCENT_ARGV: List<String> = listOf("/usr/bin/defaults", "read", "-g", "AppleAccentColor")
internal val MAC_CONTRAST_ARGV: List<String> = listOf("/usr/bin/defaults", "read", "com.apple.universalaccess", "increaseContrast")
internal val MAC_TRANSPARENCY_ARGV: List<String> = listOf("/usr/bin/defaults", "read", "com.apple.universalaccess", "reduceTransparency")

// ── Windows: `reg query` ───────────────────────────────────────────────────────────────────────
/** `reg.exe` by absolute path: CreateProcess would otherwise search the app directory and the cwd before System32. */
internal val WIN_REG: String = (System.getenv("SystemRoot")?.takeIf { it.isNotBlank() } ?: "C:\\Windows") + "\\System32\\reg.exe"
private const val WIN_PERSONALIZE = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
internal val WIN_DARK_ARGV: List<String> = listOf(WIN_REG, "query", WIN_PERSONALIZE, "/v", "AppsUseLightTheme")
internal val WIN_TRANSPARENCY_ARGV: List<String> = listOf(WIN_REG, "query", WIN_PERSONALIZE, "/v", "EnableTransparency")
internal val WIN_ACCENT_ARGV: List<String> = listOf(WIN_REG, "query", "HKCU\\Software\\Microsoft\\Windows\\DWM", "/v", "AccentColor")
internal val WIN_CONTRAST_ARGV: List<String> = listOf(WIN_REG, "query", "HKCU\\Control Panel\\Accessibility\\HighContrast", "/v", "Flags")

// ── Linux: the Settings portal ─────────────────────────────────────────────────────────────────
private fun portal(key: String): List<String> = listOf(
    "gdbus", "call", "--session",
    "--dest", "org.freedesktop.portal.Desktop",
    "--object-path", "/org/freedesktop/portal/desktop",
    "--method", "org.freedesktop.portal.Settings.ReadOne",
    "org.freedesktop.appearance", key,
)
internal val PORTAL_COLOR_SCHEME_ARGV: List<String> = portal("color-scheme")
internal val PORTAL_ACCENT_ARGV: List<String> = portal("accent-color")
internal val PORTAL_CONTRAST_ARGV: List<String> = portal("contrast")

// ── Parsers (pure; each answers null when the output is not what the tool prints) ───────────────

/** `defaults read -g AppleInterfaceStyle` prints `Dark`; light mode has no key (exit 1, so null here). */
internal fun parseMacDark(out: String?): Boolean? = out?.trim()?.let { it.equals("Dark", ignoreCase = true) }

/** `AppleAccentColor`: -1 graphite, 0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 purple, 6 pink. */
internal fun parseMacAccent(out: String?): Int? = when (out?.trim()?.toIntOrNull()) {
    -1 -> 0x8C8C8C
    0 -> 0xFF5257
    1 -> 0xF7821B
    2 -> 0xFFC600
    3 -> 0x62BA46
    4 -> 0x007AFF
    5 -> 0xA550A7
    6 -> 0xF74F9E
    else -> null
}

/** A `defaults` boolean prints `1` or `0`. */
internal fun parseMacBool(out: String?): Boolean? = when (out?.trim()) { "1" -> true; "0" -> false; else -> null }

private val REG_DWORD = Regex("""REG_DWORD\s+0x([0-9a-fA-F]{1,8})""")
private val REG_SZ = Regex("""REG_SZ\s+(\S+)""")

private fun regDword(out: String?): Long? = out?.let { REG_DWORD.find(it)?.groupValues?.get(1)?.toLongOrNull(16) }

/** `AppsUseLightTheme REG_DWORD 0x0` is dark. */
internal fun parseWinDark(out: String?): Boolean? = regDword(out)?.let { it == 0L }

/** `EnableTransparency REG_DWORD 0x0` is reduced transparency. */
internal fun parseWinReducedTransparency(out: String?): Boolean? = regDword(out)?.let { it == 0L }

/** `AccentColor REG_DWORD 0xffd77800` is 0xAABBGGRR; the answer is 0xRRGGBB. */
internal fun parseWinAccent(out: String?): Int? = regDword(out)?.let { v ->
    val r = (v and 0xFF).toInt()
    val g = ((v shr 8) and 0xFF).toInt()
    val b = ((v shr 16) and 0xFF).toInt()
    (r shl 16) or (g shl 8) or b
}

/** `Flags REG_SZ 126`: bit 0 (HCF_HIGHCONTRASTON) is set when a contrast theme is on. */
internal fun parseWinHighContrast(out: String?): Boolean? = out?.let { REG_SZ.find(it)?.groupValues?.get(1)?.toIntOrNull() }?.let { it and 1 == 1 }

private val PORTAL_UINT = Regex("""uint32\s+(\d+)""")
private val PORTAL_RGB = Regex("""\(\s*(-?[0-9.eE+-]+)\s*,\s*(-?[0-9.eE+-]+)\s*,\s*(-?[0-9.eE+-]+)\s*\)""")

/** `(<<uint32 1>>,)`: 1 is dark, 2 light, 0 no preference. */
internal fun parsePortalDark(out: String?): Boolean? = out?.let { PORTAL_UINT.find(it)?.groupValues?.get(1)?.toIntOrNull() }?.let { it == 1 }

/** `(<<uint32 1>>,)`: 1 asks for more contrast. */
internal fun parsePortalHighContrast(out: String?): Boolean? = parsePortalDark(out)

/** `(<<(0.2078, 0.5176, 0.8941)>>,)`: three doubles in 0..1; an out-of-range triple is not an accent. */
internal fun parsePortalAccent(out: String?): Int? {
    val m = out?.let { PORTAL_RGB.find(it) } ?: return null
    val c = m.groupValues.drop(1).map { it.toDoubleOrNull() ?: return null }
    if (c.any { it.isNaN() || it < 0.0 || it > 1.0 }) return null
    val (r, g, b) = c.map { Math.round(it * 255).toInt() }
    return (r shl 16) or (g shl 8) or b
}

/** Reads the host facts for [variant] with [runner]; every failed read leaves its default. Blocking: call off the UI thread. */
internal suspend fun readHostFacts(
    variant: PolarisPlatformVariant,
    runner: HostCommandRunner = SystemHostCommandRunner,
    timeoutMs: Long = HOST_READ_TIMEOUT_MS,
): PolarisHostFacts = withContext(Dispatchers.IO) {
    coroutineScope {
        fun read(argv: List<String>) = async { runner.run(argv, timeoutMs) }
        when (variant) {
            PolarisPlatformVariant.MacOS -> {
                val d = read(MAC_DARK_ARGV); val a = read(MAC_ACCENT_ARGV); val c = read(MAC_CONTRAST_ARGV); val t = read(MAC_TRANSPARENCY_ARGV)
                PolarisHostFacts(
                    dark = parseMacDark(d.await()) ?: false,
                    accent = parseMacAccent(a.await()),
                    highContrast = parseMacBool(c.await()) ?: false,
                    reducedTransparency = parseMacBool(t.await()) ?: false,
                )
            }
            PolarisPlatformVariant.Windows -> {
                val d = read(WIN_DARK_ARGV); val a = read(WIN_ACCENT_ARGV); val c = read(WIN_CONTRAST_ARGV); val t = read(WIN_TRANSPARENCY_ARGV)
                PolarisHostFacts(
                    dark = parseWinDark(d.await()) ?: false,
                    accent = parseWinAccent(a.await()),
                    highContrast = parseWinHighContrast(c.await()) ?: false,
                    reducedTransparency = parseWinReducedTransparency(t.await()) ?: false,
                )
            }
            PolarisPlatformVariant.Gnome -> {
                val d = read(PORTAL_COLOR_SCHEME_ARGV); val a = read(PORTAL_ACCENT_ARGV); val c = read(PORTAL_CONTRAST_ARGV)
                PolarisHostFacts(
                    dark = parsePortalDark(d.await()) ?: false,
                    accent = parsePortalAccent(a.await()),
                    highContrast = parsePortalHighContrast(c.await()) ?: false,
                )
            }
            PolarisPlatformVariant.Android -> PolarisHostFacts()
        }
    }
}

/** The host facts, defaults first and the real ones once the reads finish (off the UI thread). */
@Composable
public fun rememberPolarisHostFacts(): PolarisHostFacts {
    var facts by remember { mutableStateOf(PolarisHostFacts()) }
    LaunchedEffect(Unit) { facts = readHostFacts(autoPlatformVariant()) }
    return facts
}
