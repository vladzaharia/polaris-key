// The sample's command line (UK-10.10). Every flag has a default, so `run` with no arguments is the whole walk.

package im.plrs.key.samples.composedesktop

import kotlin.system.exitProcess

/** Where the walk starts. The first four need no more than a window; `walk` and `activate` wait for a person (or `--shots`). */
internal enum class Start(val wire: String) {
    /** Not activated: activation, then sign-in, device limit, the app, update and Settings by hand. */
    Walk("walk"),

    /** Not activated, and nothing else on screen. */
    Activate("activate"),

    /** Activated: the app behind the gate. */
    Gate("gate"),

    /** Activated; a 2.5.0 update is offered a moment after the window opens. */
    Update("update"),

    /** The same, with the installer download in flight. */
    Progress("progress"),

    /** Not activated; `--shots` enters a key that is over the device limit. */
    Limit("limit"),

    /** Activated; the Settings window opens on Account. */
    Settings("settings"),

    /** Activated; the Settings window opens on Devices. */
    Devices("devices"),
    ;

    companion object {
        fun of(wire: String): Start? = entries.firstOrNull { it.wire == wire }
    }
}

internal data class Options(
    val live: Boolean = false,
    val start: Start = Start.Walk,
    /** null follows the OS. */
    val dark: Boolean? = null,
    /** true: the Polaris Key preset; false: the native one. */
    val polaris: Boolean = true,
    /** `macos`, `windows` or `gnome`; null is this OS. */
    val platform: String? = null,
    val width: Int = 960,
    val height: Int = 640,
    val shots: String? = null,
    val smoke: Boolean = false,
    /** Draw under the macOS title bar (the Mac sheet floats 52 dp down). */
    val fullSize: Boolean = true,
) {
    companion object {
        const val USAGE = """usage: [--live] [--state walk|activate|limit|gate|update|progress|settings|devices] [--scheme light|dark]
       [--preset polaris|native] [--platform macos|windows|gnome] [--size WxH] [--plain]
       [--shots <dir>] [--smoke]
  --live reads PKEY_PRODUCT, PKEY_BASE_URL and PKEY_TRUST (k1=<key>,...); PKEY_RELEASE_KEYS pins the update keys."""

        fun parse(args: Array<String>): Options {
            var o = Options()
            var i = 0
            fun value(flag: String): String = args.getOrNull(++i) ?: fail("$flag needs a value")
            while (i < args.size) {
                when (val flag = args[i]) {
                    "--live" -> o = o.copy(live = true)
                    "--smoke" -> o = o.copy(smoke = true, start = Start.Gate)
                    "--plain" -> o = o.copy(fullSize = false)
                    "--state" -> o = o.copy(start = Start.of(value(flag)) ?: fail("unknown --state"))
                    "--scheme" -> o = o.copy(dark = when (value(flag)) { "dark" -> true; "light" -> false; else -> fail("--scheme is light or dark") })
                    "--preset" -> o = o.copy(polaris = when (value(flag)) { "polaris" -> true; "native" -> false; else -> fail("--preset is polaris or native") })
                    "--platform" -> o = o.copy(platform = value(flag).lowercase().takeIf { it in setOf("macos", "windows", "gnome") } ?: fail("--platform is macos, windows or gnome"))
                    "--size" -> {
                        val parts = value(flag).lowercase().split('x')
                        o = o.copy(width = parts.getOrNull(0)?.toIntOrNull() ?: fail("--size is WxH"), height = parts.getOrNull(1)?.toIntOrNull() ?: fail("--size is WxH"))
                    }
                    "--shots" -> o = o.copy(shots = value(flag))
                    else -> fail("unknown flag $flag")
                }
                i++
            }
            return o
        }

        private fun fail(message: String): Nothing {
            System.err.println("$message\n$USAGE")
            exitProcess(64)
        }
    }
}
