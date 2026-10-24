// The sample's launch options (UK-09b.2): intent extras, mirroring the iOS sample's launch arguments. Every
// extra has a default, so a plain launch is the whole walk on the fixtures.
//
//   adb shell am start -n im.plrs.key.samples.composeandroid/.MainActivity \
//     --es pkeyState update --es pkeyScheme dark --es pkeyPreset native --es pkeyAccent '#26847a'
//   adb shell am start -n ... --ez pkey.live true     the real client, from BuildConfig

package im.plrs.key.samples.composeandroid

import android.content.Intent
import androidx.compose.ui.graphics.Color

/** Where the walk starts. */
internal enum class Start(val wire: String) {
    /** Not activated: activation, then sign-in, device limit and the app by hand. */
    Walk("walk"),

    /** Not activated, and nothing else on screen. */
    Activate("activate"),

    /** Not activated; type a key containing FULL to meet the device limit. */
    Limit("limit"),

    /** Activated: the app behind the gate. */
    Gate("gate"),

    /** Activated; a 2.5.0 update is offered a moment after the app opens. */
    Update("update"),

    /** The same, with the installer download already in flight. */
    Progress("progress"),

    /** Activated; the account screen (settings and devices) is open. */
    Account("account"),
    ;

    companion object {
        fun of(wire: String?): Start? = entries.firstOrNull { it.wire == wire }
    }
}

internal data class Options(
    val live: Boolean = false,
    val start: Start = Start.Walk,
    /** null follows the system. */
    val dark: Boolean? = null,
    /** true: the Polaris look (the kit's default); false: the native preset over the host's Material theme. */
    val polaris: Boolean = true,
    /** The product accent, or null for the kit's own. */
    val accent: Color? = null,
) {
    companion object {
        const val LIVE = "pkey.live"
        const val STATE = "pkeyState"
        const val SCHEME = "pkeyScheme"
        const val PRESET = "pkeyPreset"
        const val ACCENT = "pkeyAccent"

        /** An unknown value keeps the default: a typo in an adb command must not crash the sample. */
        fun from(intent: Intent?): Options {
            val x = intent?.extras ?: return Options()
            return Options(
                live = x.getBoolean(LIVE, false),
                start = Start.of(x.getString(STATE)) ?: Start.Walk,
                dark = when (x.getString(SCHEME)) { "dark" -> true; "light" -> false; else -> null },
                polaris = x.getString(PRESET) != "native",
                accent = x.getString(ACCENT)?.let(::parseAccent),
            )
        }

        /** `#rrggbb` only. */
        fun parseAccent(text: String): Color? {
            val hex = text.removePrefix("#")
            if (hex.length != 6 || hex.any { it !in "0123456789abcdefABCDEF" }) return null
            return Color(0xFF000000L or hex.toLong(16))
        }
    }
}
