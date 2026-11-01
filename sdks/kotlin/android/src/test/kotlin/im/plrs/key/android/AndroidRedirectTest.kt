// @pkey-feature identity.redirect.native
//
// I-15b.6: the Android half of the native redirect sign-in. The Custom Tab's intent, the redirect activity's
// delivery (one, and only of a registered redirect), and the refusals that leave the
// waiting sign-in alone. The wire conversation itself is :identity's (NativeSignInTest, TranscriptTest).

package im.plrs.key.android

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import im.plrs.key.identity.SignInError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class AndroidRedirectTest {
    private val scheme = "com.tidewater.studio"
    private val schemeUri = "com.tidewater.studio:/pkey/callback"
    private val claimed = "https://tidewater.example/pkey/callback"
    private val authorize =
        "https://key.example/djdl/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc"
    private val redirect = AndroidRedirect(scheme = scheme, claimedUri = claimed)

    @After
    fun clear() {
        RedirectInbox.reset()
    }

    private class RecordingTabs : TabHost {
        val customTabs = mutableListOf<Uri>()

        override fun launchCustomTab(url: Uri): Boolean {
            customTabs += url
            return true
        }
    }

    private val delivered = mutableListOf<String>()

    private fun install(host: Class<*> = Activity::class.java) = RedirectInbox.install(RedirectInbox.Registration(redirect, host) { delivered += it })

    // ── The registration ─────────────────────────────────────────────────────────────────

    @Test
    fun theOptionsNeverAskForALoopbackAndNameWhatWasRegistered() {
        val o = redirect.options
        assertEquals(false, o.loopback)
        assertEquals(listOf(schemeUri), o.registeredSchemes)
        assertEquals(listOf(claimed), o.registeredClaimed)
    }

    @Test
    fun aRegistrationNeedsAUsableRedirect() {
        for (bad in listOf<() -> Unit>(
            { AndroidRedirect() },
            { AndroidRedirect(scheme = "Bad Scheme") },
            { AndroidRedirect(scheme = "http") },
            { AndroidRedirect(claimedUri = "http://127.0.0.1:5000/pkey/callback") },
            { AndroidRedirect(claimedUri = "https://tidewater.example/") },
        )) {
            try {
                bad()
                fail("accepted")
            } catch (_: IllegalArgumentException) {
                // refused
            } catch (_: im.plrs.key.core.PolarisException) {
                // refused
            }
        }
    }

    // ── The tab ──────────────────────────────────────────────────────────────────────────

    @Test
    fun theCustomTabOpensTheAuthorizeUrlForTheChosenRedirect() = runBlocking {
        val tabs = RecordingTabs()
        val browser = AndroidRedirectBrowser(redirect, tabs)
        assertTrue(browser.open(authorize, schemeUri))
        assertTrue(browser.open(authorize, claimed))
        assertEquals(listOf(Uri.parse(authorize), Uri.parse(authorize)), tabs.customTabs)
    }

    @Test
    fun theRealTabIsAViewIntentForTheSystemBrowser() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).create().get()
        val browser = AndroidRedirectBrowser.createWith(activity, redirect) {}
        assertTrue(browser.open(authorize, schemeUri))
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals(Uri.parse(authorize), started.data)
        assertNull(started.component)
    }

    @Test
    fun noActivityIsNoTab() = runBlocking {
        assertFalse(ActivityTabs(java.lang.ref.WeakReference(null)).launchCustomTab(Uri.parse(authorize)))
    }

    @Test
    fun onlyTheProductsHttpsPageOpensTowardARegisteredRedirect() = runBlocking {
        val tabs = RecordingTabs()
        val browser = AndroidRedirectBrowser(redirect, tabs)
        assertFalse(browser.open("http://key.example/djdl/identity/authorize", schemeUri))
        assertFalse(browser.open("javascript:alert(1)", schemeUri))
        assertFalse(browser.open("intent://x#Intent;end", schemeUri))
        assertFalse(browser.open(authorize, "com.other.app:/pkey/callback"))
        assertFalse(browser.open(authorize, "http://127.0.0.1:5000/pkey/callback"))
        assertTrue(tabs.customTabs.isEmpty())
    }

    // ── The redirect activity ────────────────────────────────────────────────────────────

    private fun launch(intent: Intent) = Robolectric.buildActivity(PKeyRedirectActivity::class.java, intent).create().get()

    private fun view(url: String?) = Intent(Intent.ACTION_VIEW).apply { if (url != null) data = Uri.parse(url) }

    @Test
    fun theActivityHandsOneRegisteredRedirectToTheSignInAndFinishes() {
        install()
        val url = "$claimed?code=c&state=s&iss=i"
        val activity = launch(view(url))
        assertEquals(listOf(url), delivered)
        assertTrue(activity.isFinishing)
        // The host's own activity comes to the front, clearing the tab above it.
        val next = shadowOf(activity).nextStartedActivity
        assertEquals(ComponentName(activity, Activity::class.java), next.component)
        assertTrue(next.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)
        // The intent is spent: nothing left to deliver again.
        assertNull(activity.intent.data)
    }

    @Test
    fun foreignAndMalformedDeliveriesAreDroppedWithoutTouchingTheSignIn() {
        install()
        val cases = listOf(
            view("com.other.app:/pkey/callback?code=c&state=s"),
            view("https://evil.example/pkey/callback?code=c&state=s"),
            view("$schemeUri/extra?code=c"),
            view("$schemeUri?code=c#frag"),
            view("$schemeUri?code=" + "a".repeat(5000)),
            view("http://127.0.0.1:5000/pkey/callback?code=c&state=s"),
            view(null),
            Intent(Intent.ACTION_SEND).setData(Uri.parse("$schemeUri?code=c&state=s")),
            Intent(),
        )
        for (intent in cases) {
            val activity = launch(intent)
            assertTrue(activity.isFinishing)
            assertNull(shadowOf(activity).nextStartedActivity)
        }
        assertTrue(delivered.isEmpty())
    }

    @Test
    fun withNoSignInRegisteredADeliveryGoesNowhere() {
        val activity = launch(view("$schemeUri?code=c&state=s"))
        assertTrue(activity.isFinishing)
        assertTrue(delivered.isEmpty())
    }

    // ── Delivery to the sign-in ──────────────────────────────────────────────────────────

    @Test
    fun aRefusalFromTheSignInDoesNotStopLaterDeliveries() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val seen = java.util.Collections.synchronizedList(mutableListOf<String>())
        val second = CompletableDeferred<Unit>()
        val sink = redirectSink(scope) { url ->
            seen += url
            if (url == "first") throw SignInError("sign-in-failed", "refused")
            second.complete(Unit)
        }
        sink("first")
        sink("second")
        withTimeout(5_000) { second.await() }
        assertEquals(setOf("first", "second"), seen.toSet())
    }

    // ── The manifest ─────────────────────────────────────────────────────────────────────

    @Test
    fun theLibraryExposesNothingByItself() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val info = context.packageManager.getActivityInfo(ComponentName(context, PKeyRedirectActivity::class.java), 0)
        assertFalse(info.exported)
        val browsable = Intent(Intent.ACTION_VIEW, Uri.parse("$schemeUri?code=c")).addCategory(Intent.CATEGORY_BROWSABLE)
        val matches = context.packageManager.queryIntentActivities(browsable, PackageManager.MATCH_ALL)
        assertTrue(matches.none { it.activityInfo.name == PKeyRedirectActivity::class.java.name })
    }
}
