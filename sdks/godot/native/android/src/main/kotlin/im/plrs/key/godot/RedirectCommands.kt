package im.plrs.key.godot

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private const val MAX_URL_LENGTH = 4096
private const val LAUNCH_WAIT_SECONDS = 3L
private const val CALLBACK_PATH = "/pkey/callback"
private const val CUSTOM_TAB_SESSION = "android.support.customtabs.extra.SESSION"
private val RESERVED_SCHEMES = setOf("http", "https", "javascript", "data", "file", "content", "intent")
private val SCHEME_RE = Regex("^[a-z][a-z0-9+.-]{0,63}$")

/** How the system browser is shown; faked in tests, since Robolectric has no browser. */
fun interface TabLauncher {
    /** Show [url] in the system browser (a Custom Tab where there is one) from [from]; false when it could not start. */
    fun launch(from: Activity, url: Uri): Boolean
}

/** The Custom Tab launch, with no library: the same intent `CustomTabsIntent` builds, and a plain browser VIEW where none answers. */
object CustomTabLauncher : TabLauncher {
    override fun launch(from: Activity, url: Uri): Boolean = try {
        val intent = Intent(Intent.ACTION_VIEW, url)
        intent.putExtras(Bundle().apply { putBinder(CUSTOM_TAB_SESSION, null) })
        from.startActivity(intent)
        true
    } catch (e: RuntimeException) {
        false
    }
}

/**
 * The redirects one native sign-in may be delivered to: the registered scheme's `<scheme>:/pkey/callback` and the claimed
 * HTTPS link, as full redirect URIs. Held between `auth_open` and the delivery, by [RedirectInbox].
 */
internal class Registration(val uris: List<String>, val host: Class<*>, val sink: (String) -> Unit) {
    /** A delivery worth handing over: one of the redirect URIs with a query, of sane length, no fragment. */
    fun accepts(delivery: String?): Boolean =
        delivery != null && delivery.length <= MAX_URL_LENGTH && delivery.indexOf('#') < 0 && delivery.indexOf('?') > 0 &&
            delivery.substringBefore('?') in uris
}

/** The one place the redirect activity meets the waiting sign-in. One sign-in at a time; a delivery is handed over once. */
internal object RedirectInbox {
    private val current = AtomicReference<Registration?>(null)
    private val last = AtomicReference<String?>(null)

    fun install(registration: Registration) {
        last.set(null)
        current.set(registration)
    }

    fun clear() {
        current.set(null)
        last.set(null)
    }

    fun hostActivity(): Class<*>? = current.get()?.host

    /** Hand [url] to the sink once. False when nobody waits, the URL is not a registered redirect, or it was already handed over. */
    fun deliver(url: String?): Boolean {
        val registration = current.get()
        val ok = registration != null && registration.accepts(url) && last.getAndSet(url) != url
        if (ok) registration?.sink?.invoke(requireNotNull(url))
        return ok
    }
}

/**
 * The native redirect sign-in's system-browser ops (I-48.17b), over the redirect activity of this module:
 *
 * - `auth_open {url, scheme?, claimedUri?, issuerHost}` opens the authorize page in the system browser (a Custom
 *   Tab) from the foreground activity. It refuses, with a fixed reason word and never the URL, anything but an HTTPS
 *   page on `issuerHost`, a redirect that is not the registered scheme's `<scheme>:/pkey/callback` or a claimed HTTPS link,
 *   and a redirect the OS does not route to this app's redirect activity (the export adds that intent filter only
 *   when the project registers a scheme or link). Answers `{ok: true}` once the browser started (or `auth_unavailable`);
 *   the browser's redirect arrives later as the queued event `{ev: "auth_done", url}`, once.
 * - `auth_cancel` forgets the waiting sign-in, so a later redirect is dropped.
 *
 * One sign-in at a time: a new `auth_open` replaces the previous one. The URL carries the authorization code: it is in the
 * event only, and nothing here logs it.
 */
class RedirectCommands(private val c: Commands, private val tabs: TabLauncher = CustomTabLauncher) {
    val ops: Set<String> = setOf("auth_open", "auth_cancel")

    fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "auth_open" -> open(q)
        else -> {
            RedirectInbox.clear()
            JSONObject().put("ok", true)
        }
    }

    private fun open(q: JSONObject): JSONObject {
        val url = q.optString("url")
        val issuerHost = q.optString("issuerHost").lowercase()
        val scheme = q.optString("scheme")
        val claimed = q.optString("claimedUri")
        val from = c.host.foregroundActivity
        val refusal = when {
            !authorizeUrlOk(url, issuerHost) -> "url"
            scheme.isEmpty() && claimed.isEmpty() -> "unregistered"
            scheme.isNotEmpty() && (!SCHEME_RE.matches(scheme) || scheme in RESERVED_SCHEMES) -> "scheme"
            claimed.isNotEmpty() && !claimedOk(claimed) -> "claimed"
            from == null -> "no-activity"
            else -> null
        }
        if (refusal != null) return refuse(refusal)
        val uris = listOfNotNull(if (scheme.isEmpty()) null else "$scheme:$CALLBACK_PATH", claimed.ifEmpty { null })
        if (uris.none { routesHere(it) }) return refuse("not-registered")
        // Replace any earlier sign-in before the browser opens, so a stray earlier redirect is dropped.
        RedirectInbox.install(Registration(uris, requireNotNull(from).javaClass) { delivered -> c.event("auth_done", JSONObject().put("url", delivered)) })
        val target = Uri.parse(url)
        // The browser starts on the UI thread; the reply says whether it did, so GDScript knows at once (a bounded wait).
        val started = AtomicReference<Boolean?>(null)
        val latch = CountDownLatch(1)
        c.host.onUi {
            started.set(
                try {
                    tabs.launch(requireNotNull(from), target)
                } catch (e: RuntimeException) {
                    false
                },
            )
            latch.countDown()
        }
        val shown = latch.await(LAUNCH_WAIT_SECONDS, TimeUnit.SECONDS) && started.get() == true
        if (!shown) RedirectInbox.clear()
        return if (shown) JSONObject().put("ok", true) else Commands.fail("auth_unavailable", null).put("reason", "no-browser")
    }

    private fun refuse(reason: String): JSONObject = Commands.fail("auth_refused", null).put("reason", reason)

    /** The OS would deliver [redirectUri] to the redirect activity of this app (the export's filter is present). */
    private fun routesHere(redirectUri: String): Boolean = try {
        val ctx = c.host.appContext
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse(redirectUri)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(ctx.packageName)
        @Suppress("DEPRECATION")
        ctx.packageManager.queryIntentActivities(probe, 0).any { it.activityInfo?.name == PKeyGodotRedirectActivity::class.java.name }
    } catch (e: RuntimeException) {
        false
    }

    companion object {
        /** An HTTPS authorize page on [issuerHost] and nowhere else: no userinfo, fragment, odd port, whitespace, backslash or control character. */
        internal fun authorizeUrlOk(url: String, issuerHost: String): Boolean {
            if (url.isEmpty() || url.length > MAX_URL_LENGTH || issuerHost.isEmpty() || url.indexOf('#') >= 0) return false
            if (url.any { it.isWhitespace() || it == '\\' || it.isISOControl() }) return false
            val u = Uri.parse(url)
            return u.scheme == "https" && u.userInfo == null && u.host.equals(issuerHost, ignoreCase = true) &&
                u.authority?.contains('@') == false && (u.port == -1 || u.port == 443)
        }

        /** A claimed HTTPS redirect URI: a host, an exact path, no query, fragment or userinfo. */
        internal fun claimedOk(uri: String): Boolean {
            if (uri.length > MAX_URL_LENGTH || uri.indexOf('#') >= 0 || uri.indexOf('?') >= 0) return false
            val u = Uri.parse(uri)
            val path = u.path.orEmpty()
            return u.scheme == "https" && !u.host.isNullOrEmpty() && u.userInfo == null && path.length > 1
        }
    }
}

/**
 * Receives the browser's redirect to the project's registered scheme or claimed link. Declared NOT exported with no
 * intent filter; the Godot export adds the filter (and exported=true) only when the project registers a scheme or
 * link. It reads one VIEW intent, hands the URL to the waiting sign-in, brings the game's activity forward (closing
 * the tab above it) and finishes. Anything that is not a VIEW of a registered redirect is dropped.
 */
class PKeyGodotRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(received: Intent?) {
        val url = if (received?.action == Intent.ACTION_VIEW) received.dataString else null
        // The intent is spent: a re-created activity must not deliver the same URL again.
        setIntent(Intent())
        val delivered = RedirectInbox.deliver(url)
        val host = RedirectInbox.hostActivity()
        if (delivered && host != null) {
            startActivity(Intent(this, host).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}
