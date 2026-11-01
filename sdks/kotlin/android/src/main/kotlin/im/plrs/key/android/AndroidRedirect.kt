// The Android native redirect sign-in (WIRE-CONTRACT-V5 section 12.12; I-15b.6). The browser lands on a redirect the
// app owns: a registered scheme or a claimed HTTPS link. There is no loopback listener on Android.
//
//   AndroidRedirect         what this build registered with the OS (the scheme, the claimed link) and the
//                           `NativeRedirectOptions` that follow from it.
//   AndroidRedirectBrowser  the opener: a Custom Tab; the OS delivers the redirect to PKeyRedirectActivity.
//                           (The Auth Tab needs androidx.browser 1.9, hence AGP 8.9.1; not linked yet.)
//   PKeyRedirectActivity    the manifest-declared activity that receives the VIEW intent.
//
// Every delivery goes to `signIn.handleRedirect`, which checks the redirect URI, `state` and `iss` before
// anything is sent. A delivery that is not for the waiting sign-in is dropped here or refused there; it never
// ends the sign-in. Nothing here logs or prints a URL: it carries the code.

package im.plrs.key.android

import im.plrs.key.identity.NativeRedirect
import im.plrs.key.identity.NativeRedirectClass
import im.plrs.key.identity.NativeRedirectOptions
import im.plrs.key.identity.SignInError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

private const val MAX_DELIVERY_LENGTH = 4096

/**
 * The redirects this build has registered with the OS: [scheme] is the reverse-DNS scheme name the manifest
 * filter declares, [claimedUri] the full HTTPS redirect URI the app has verified App Links for. At least one.
 */
public class AndroidRedirect @JvmOverloads constructor(public val scheme: String? = null, public val claimedUri: String? = null) {
    /** `<scheme>:/pkey/callback`, or null. */
    public val schemeUri: String? = scheme?.let { NativeRedirect.schemeUri(it) }

    init {
        require(scheme != null || claimedUri != null) { "register a scheme or a claimed link" }
        require(claimedUri == null || NativeRedirect.classify(claimedUri) == NativeRedirectClass.Claimed) {
            "the claimed link is not a claimed HTTPS redirect URI"
        }
    }

    /**
     * The options for `signIn.start(SignInOptions(channel = Redirect, native = redirect.options))`: no loopback, and
     * the registered redirect URIs for the class chooser.
     */
    public val options: NativeRedirectOptions
        get() = NativeRedirectOptions(
            loopback = false,
            registeredSchemes = listOfNotNull(schemeUri),
            registeredClaimed = listOfNotNull(claimedUri),
        )

    /** Whether [uri] is one of the registered redirect URIs. */
    internal fun owns(uri: String): Boolean = uri == schemeUri || uri == claimedUri

    /**
     * A delivery worth handing to the sign-in: a registered redirect URI with a query, of sane length. Anything
     * else is dropped without touching the sign-in.
     */
    internal fun accepts(delivery: String?): Boolean =
        delivery != null && delivery.length <= MAX_DELIVERY_LENGTH && delivery.indexOf('#') < 0 && owns(delivery.substringBefore('?'))
}

/** The one place the redirect activity and the Auth Tab result meet the waiting sign-in. */
internal object RedirectInbox {
    internal class Registration(val redirect: AndroidRedirect, val host: Class<*>, val sink: (String) -> Unit)

    private val current = AtomicReference<Registration?>(null)

    fun install(registration: Registration) {
        current.set(registration)
    }

    fun remove(registration: Registration) {
        current.compareAndSet(registration, null)
    }

    /** Test hook: forget any registration. */
    fun reset() {
        current.set(null)
    }

    fun hostActivity(): Class<*>? = current.get()?.host

    /** Hand a delivery to the sink once. False when nobody waits or the URL is not a registered redirect. */
    fun deliver(url: String?): Boolean {
        val registration = current.get()
        val ok = registration != null && url != null && registration.redirect.accepts(url)
        if (ok) registration?.sink?.invoke(requireNotNull(url))
        return ok
    }
}

private val deliveryScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * A sink that hands each URL to [handle] (`signIn.handleRedirect`) off the main thread. A refusal ([SignInError]: not
 * this sign-in's, or already finished) is dropped, so a stray delivery never ends the waiting sign-in.
 */
internal fun redirectSink(handle: suspend (String) -> Unit): (String) -> Unit = redirectSink(deliveryScope, handle)

internal fun redirectSink(scope: CoroutineScope, handle: suspend (String) -> Unit): (String) -> Unit = { url ->
    scope.launch {
        try {
            handle(url)
        } catch (_: SignInError) {
            // The sign-in went on waiting (or was over already); the person can open the browser again.
        }
    }
}
