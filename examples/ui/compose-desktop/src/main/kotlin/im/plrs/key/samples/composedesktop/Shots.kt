// `--shots <dir>` (UK-10.10): drives the sample through the walk and writes a window-only PNG of each window it
// shows, then exits. It captures with java.awt.Robot, cropped to one window's bounds (never the whole screen), so
// macOS needs Screen Recording permission for the JVM (and Accessibility for the key presses). When the capture
// is refused (a flat, near-empty image) the run says so and exits 3 rather than writing shots that lie.
//
// Input never leaves the process: keys are posted to the window's own AWT event queue, and the menu's two actions
// (Check for updates, Manage license) are the same PolarisKeyWindowState calls the menu items make, because the
// macOS menu bar is native and no synthetic event reaches it. Nothing here types into another application.

package im.plrs.key.samples.composedesktop

import java.awt.Component
import java.awt.Container
import java.awt.Rectangle
import java.awt.Toolkit
import java.awt.Robot
import java.awt.Window
import java.awt.event.KeyEvent
import java.awt.image.BufferedImage
import im.plrs.key.ui.PolarisKeyWindowState
import im.plrs.key.ui.PolarisSettingsPane
import java.io.File
import javax.imageio.ImageIO

internal class Shots(private val dir: String, private val o: Options) {
    private val robot by lazy { Robot() }
    private val tag = listOf(
        o.platform ?: "native", if (o.polaris) "polaris" else "native-preset", when (o.dark) { true -> "dark"; false -> "light"; null -> "os" }, "${o.width}x${o.height}",
    ).joinToString("-")
    private val out = File(dir, tag).apply { mkdirs() }
    private val written = mutableListOf<String>()

    fun launch() {
        Thread {
            try {
                script()
                println("shots: ${written.size} written to ${out.path}")
                Runtime.getRuntime().halt(0)
            } catch (t: Throwable) {
                System.err.println("shots: ${t.message ?: t}")
                Runtime.getRuntime().halt(if (t is Refused) 3 else 1)
            }
        }.apply { isDaemon = true; name = "pkey-sample-shots"; start() }
    }

    private class Refused(message: String) : RuntimeException(message)

    // ── The script ──────────────────────────────────────────────────────────────────────────

    private fun script() {
        val main = window(null)
        settle(main, 2_500)
        when (o.start) {
            Start.Walk -> walk(main)
            Start.Limit -> limit(main)
            Start.Activate -> shot(main, "01-activate")
            Start.Gate -> shot(main, "01-gate")
            Start.Update -> shot(window("Tidewater Studio 2.5.0", "Update", "2.5.0"), "01-update")
            Start.Progress -> shot(window("Tidewater Studio 2.5.0", "Update", "2.5.0"), "01-update-progress")
            Start.Settings -> shot(window("Account", "Settings"), "01-settings-account")
            Start.Devices -> shot(window("Devices"), "01-settings-devices")
        }
    }

    /** The whole walk in one run: gate, sign-in, the app, an update with progress, then Settings. */
    private fun walk(main: Window) {
        shot(main, "01-activate")
        key(main, KeyEvent.VK_ENTER) // "Sign In" holds the first focus
        settle(main, 1_500)
        shot(main, "02-sign-in")
        Thread.sleep((SIGN_IN_SECONDS + 5) * 1000)
        shot(main, "03-app")
        Hooks.windowState?.requestCheck()
        val update = window("Update", "2.5.0")
        settle(update, 1_500)
        shot(update, "04-update")
        key(update, KeyEvent.VK_ENTER) // "Update" holds the first focus
        Thread.sleep(3_500)
        shot(update, "05-update-progress")
        Hooks.windowState?.manageLicense()
        val settings = window("Account")
        settle(settings, 1_500)
        shot(settings, "06-settings-account")
        Hooks.windowState?.settings?.open(PolarisSettingsPane.Devices)
        settle(settings, 1_500)
        shot(window("Devices"), "07-settings-devices")
        // The sign-out question, in the platform's own chrome, over the gate window.
        Hooks.windowState?.requestSignOut()
        settle(main, 1_200)
        shot(main, "08-sign-out")
    }

    /** The device-limit refusal: "Use a License Key", a key that is over the limit, Return. */
    private fun limit(main: Window) {
        shot(main, "01-activate")
        key(main, KeyEvent.VK_TAB)
        key(main, KeyEvent.VK_ENTER)
        settle(main, 800)
        shot(main, "02-license-key")
        // The form's first focus is "Activate License"; the field is two stops back.
        key(main, KeyEvent.VK_TAB, KeyEvent.SHIFT_DOWN_MASK)
        key(main, KeyEvent.VK_TAB, KeyEvent.SHIFT_DOWN_MASK)
        type(main, "tide-full-0001")
        key(main, KeyEvent.VK_ENTER)
        settle(main, 2_000)
        shot(main, "03-device-limit")
    }

    // ── Windows, keys and pixels ────────────────────────────────────────────────────────────

    /** The showing window whose title contains one of [needles] (any window when none), waiting up to 30 s. */
    private fun window(vararg needles: String?): Window {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            Window.getWindows()
                .firstOrNull { w -> w.isShowing && w.width > 100 && titleOf(w).let { t -> needles.all { it == null } || needles.any { n -> n != null && t.contains(n, ignoreCase = true) } } }
                ?.let { return it }
            Thread.sleep(200)
        }
        throw IllegalStateException("no window titled ${needles.toList()} appeared")
    }

    private fun titleOf(w: Window): String = (w as? java.awt.Frame)?.title ?: (w as? java.awt.Dialog)?.title ?: ""

    private fun settle(w: Window, ms: Long) {
        EventQueueIdle.await()
        Thread.sleep(ms)
    }

    /** The component that owns the Compose canvas: the deepest focusable one under [w]. */
    private fun canvas(w: Window): Component {
        fun walk(c: Component): Component? =
            (c as? Container)?.components?.asSequence()?.mapNotNull { walk(it) }?.firstOrNull() ?: c.takeIf { it.isFocusable && it.isShowing && it !== w }
        return walk(w) ?: w
    }

    private fun type(w: Window, text: String) {
        for (c in text) post(w, KeyEvent.VK_UNDEFINED, c)
    }

    private fun key(w: Window, code: Int, mods: Int = 0) = post(w, code, KeyEvent.CHAR_UNDEFINED, mods)

    private fun post(w: Window, code: Int, char: Char, mods: Int = 0) {
        val target = canvas(w)
        val queue = Toolkit.getDefaultToolkit().systemEventQueue
        val vk = if (code == KeyEvent.VK_UNDEFINED) KeyEvent.getExtendedKeyCodeForChar(char.code) else code
        val t = System.currentTimeMillis()
        queue.postEvent(KeyEvent(target, KeyEvent.KEY_PRESSED, t, mods, vk, if (code == KeyEvent.VK_UNDEFINED) char else KeyEvent.CHAR_UNDEFINED))
        if (code == KeyEvent.VK_UNDEFINED) queue.postEvent(KeyEvent(target, KeyEvent.KEY_TYPED, t, 0, KeyEvent.VK_UNDEFINED, char))
        queue.postEvent(KeyEvent(target, KeyEvent.KEY_RELEASED, t, mods, vk, if (code == KeyEvent.VK_UNDEFINED) char else KeyEvent.CHAR_UNDEFINED))
        Thread.sleep(40)
    }

    /**
     * One window's PNG. On macOS the window is found by its own pid and bounds in the window list and captured by id
     * (`screencapture -l`), so what covers it never enters the image. Elsewhere the Robot reads the window's rectangle.
     */
    private fun shot(w: Window, name: String) {
        w.toFront()
        Thread.sleep(400)
        val file = File(out, "$name.png")
        val image = if (System.getProperty("os.name").startsWith("Mac")) captureMac(w, file) else captureRobot(w).also { ImageIO.write(it, "png", file) }
        if (isBlank(image)) {
            file.delete()
            throw Refused("the capture of ${titleOf(w)} is blank: grant Screen Recording to this JVM and run again")
        }
        written += file.path
        println("shots: ${file.path} (${image.width}x${image.height}, window ${titleOf(w)})")
    }

    private fun captureRobot(w: Window): BufferedImage =
        robot.createMultiResolutionScreenCapture(Rectangle(w.locationOnScreen, w.size)).resolutionVariants.last() as BufferedImage

    private fun captureMac(w: Window, file: File): BufferedImage {
        val pid = ProcessHandle.current().pid()
        val script = "ObjC.import('CoreGraphics');" +
            "var l=ObjC.deepUnwrap(ObjC.castRefToObject(\$.CGWindowListCopyWindowInfo(1,0)));" +
            "JSON.stringify(l.filter(function(x){return x.kCGWindowOwnerPID==$pid&&x.kCGWindowLayer==0}).map(function(x){var b=x.kCGWindowBounds;return [x.kCGWindowNumber,b.X,b.Y,b.Width,b.Height]}))"
        val p = w.locationOnScreen
        // The window-open animation scales the window up for a moment; wait for the frame to settle at its own bounds.
        var listed = ""
        var id: Long? = null
        val deadline = System.currentTimeMillis() + 8_000
        while (id == null && System.currentTimeMillis() < deadline) {
            listed = run("osascript", "-l", "JavaScript", "-e", script)
            id = Regex("""\[(\d+),(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\]""").findAll(listed)
                .map { m -> m.groupValues.drop(1).map { it.toDouble() } }
                .firstOrNull { (_, x, y, wd, ht) -> Math.abs(x - p.x) <= 2 && Math.abs(y - p.y) <= 2 && Math.abs(wd - w.width) <= 2 && Math.abs(ht - w.height) <= 2 }
                ?.first()?.toLong()
            if (id == null) Thread.sleep(300)
        }
        if (id == null) {
            // macOS can hold a window at 0.9 scale (its open animation) for as long as the app is not active; take the one
            // window of this process that has the window's proportions.
            id = Regex("""\[(\d+),(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\]""").findAll(listed)
                .map { m -> m.groupValues.drop(1).map { it.toDouble() } }
                .filter { (_, _, _, wd, ht) -> Math.abs(wd / ht - w.width.toDouble() / w.height) < 0.02 }
                .toList().singleOrNull()?.first()?.toLong()
        }
        if (id == null) throw IllegalStateException("window ${titleOf(w)} is not in the window list (AWT ${p.x},${p.y} ${w.width}x${w.height}): $listed")
        val said = run("/usr/sbin/screencapture", "-x", "-o", "-l$id", file.path)
        if (!file.isFile) throw Refused("screencapture wrote nothing for ${titleOf(w)} (window $id): $said")
        return ImageIO.read(file) ?: throw Refused("screencapture wrote nothing for ${titleOf(w)}")
    }

    private fun run(vararg argv: String): String {
        val p = ProcessBuilder(*argv).redirectErrorStream(true).start()
        val text = p.inputStream.readBytes().toString(Charsets.UTF_8)
        p.waitFor()
        return text
    }

    /** A refused capture is the desktop alone: almost no colours. A real window has text, a button and a ground. */
    private fun isBlank(image: BufferedImage): Boolean {
        val seen = HashSet<Int>()
        var y = 0
        while (y < image.height) {
            var x = 0
            while (x < image.width) {
                seen += image.getRGB(x, y)
                if (seen.size > 24) return false
                x += 7
            }
            y += 7
        }
        return true
    }
}

/** Lets the AWT event queue drain once (a window just opened, a key was pressed). */
private object EventQueueIdle {
    fun await() = java.awt.EventQueue.invokeAndWait { }
}

/** What the shots driver may call on the running window: the menu's own state holder. */
internal object Hooks {
    @Volatile var windowState: PolarisKeyWindowState? = null
}
