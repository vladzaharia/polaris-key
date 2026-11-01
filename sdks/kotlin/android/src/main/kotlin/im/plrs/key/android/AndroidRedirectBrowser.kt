package im.plrs.key.android

import android.app.Activity
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import im.plrs.key.identity.NativeRedirectOpener
import im.plrs.key.identity.SignInNamespace
import kotlinx.coroutines.CancellationException
import java.lang.ref.WeakReference

/** What a tab launch needs; faked in tests, since Robolectric has no browser. */
internal fun interface TabHost {
    /** Show [url] in the system browser's Custom Tab; false when there is no activity to launch from. */
    fun launchCustomTab(url: Uri): Boolean
}

/**
 * The system browser for a native redirect sign-in on Android: a Custom Tab, never a web view. Create it with [create]
 * and pass it as `SignInOptions.opener` with `native = redirect.options`. The OS delivers the browser's redirect to
 * [PKeyRedirectActivity], which hands it to `signIn.handleRedirect`; closing the tab delivers nothing and leaves
 * the sign-in waiting (SIGN-IN 3.17 reopens it). It opens only the product's own HTTPS authorize page, and only toward
 * a redirect this build registered. The Auth Tab (`androidx.browser` 1.9) needs AGP 8.9.1 and is not linked yet.
 */
public class AndroidRedirectBrowser internal constructor(private val redirect: AndroidRedirect, private val tabs: TabHost) : NativeRedirectOpener {
    override suspend fun open(url: String): Boolean = open(url, redirect.schemeUri ?: redirect.claimedUri.orEmpty())

    override suspend fun open(url: String, redirectUri: String): Boolean {
        val target = Uri.parse(url)
        if (target.scheme != "https" || target.host.isNullOrEmpty() || !redirect.owns(redirectUri)) return false
        return try {
            tabs.launchCustomTab(target)
        } catch (e: CancellationException) {
            throw e
        } catch (_: RuntimeException) {
            false
        }
    }

    public companion object {
        /**
         * [activity] is the one the tab opens from (held weakly); its class is the one the redirect brings back to the
         * front. [signIn] is `client.identity.signIn`: every redirect that arrives is handed to its `handleRedirect`,
         * and a refusal leaves the sign-in waiting. The last browser created is the one that receives redirects.
         */
        @JvmStatic
        public fun create(activity: Activity, signIn: SignInNamespace, redirect: AndroidRedirect): AndroidRedirectBrowser =
            createWith(activity, redirect) { signIn.handleRedirect(it) }

        internal fun createWith(activity: Activity, redirect: AndroidRedirect, handle: suspend (String) -> Unit): AndroidRedirectBrowser {
            RedirectInbox.install(RedirectInbox.Registration(redirect, activity.javaClass, redirectSink(handle)))
            return AndroidRedirectBrowser(redirect, ActivityTabs(WeakReference(activity)))
        }
    }
}

internal class ActivityTabs(private val activity: WeakReference<Activity>) : TabHost {
    override fun launchCustomTab(url: Uri): Boolean {
        val host = activity.get() ?: return false
        CustomTabsIntent.Builder().build().launchUrl(host, url)
        return true
    }
}
