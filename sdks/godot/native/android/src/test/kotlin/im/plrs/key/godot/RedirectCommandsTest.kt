package im.plrs.key.godot

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

private const val ISSUER = "key.example.test"
private const val AUTHORIZE = "https://key.example.test/authorize?client_id=app&request_uri=urn%3Aexample%3A1"
private const val SCHEME_URI = "com.example.game:/pkey/callback"
private const val CLAIMED = "https://game.example.test/pkey/callback"

@RunWith(RobolectricTestRunner::class)
class RedirectCommandsTest {
    private val shown = mutableListOf<Uri>()
    private var canShow = true
    private val host = TestHost()
    private val c = Commands(host, tabs = { _, url -> shown += url; canShow })

    @Before
    fun registerFilter() {
        // What the export's manifest filter does: the OS routes the registered redirects to the redirect activity.
        val pm = shadowOf(host.appContext.packageManager)
        val component = ComponentName(host.appContext.packageName, PKeyGodotRedirectActivity::class.java.name)
        pm.addActivityIfNotPresent(component)
        pm.addIntentFilterForActivity(component, IntentFilter(Intent.ACTION_VIEW).apply {
            addCategory(Intent.CATEGORY_DEFAULT)
            addCategory(Intent.CATEGORY_BROWSABLE)
            addDataScheme("com.example.game")
            addDataPath("/pkey/callback", android.os.PatternMatcher.PATTERN_LITERAL)
        })
    }

    @After
    fun reset() = RedirectInbox.clear()

    private fun open(url: String = AUTHORIZE, issuer: String = ISSUER, scheme: String? = "com.example.game", claimed: String? = null): JSONObject {
        val q = JSONObject().put("op", "auth_open").put("url", url).put("issuerHost", issuer)
        if (scheme != null) q.put("scheme", scheme)
        if (claimed != null) q.put("claimedUri", claimed)
        return c.json(q)
    }

    private fun events(): List<JSONObject> {
        val a = c.json(JSONObject().put("op", "poll")).getJSONArray("events")
        return (0 until a.length()).map { a.getJSONObject(it) }
    }

    private fun deliverViaActivity(url: String?) {
        val intent = Intent(Intent.ACTION_VIEW, url?.let { Uri.parse(it) })
        val activity = Robolectric.buildActivity(PKeyGodotRedirectActivity::class.java, intent).create().get()
        assertTrue(activity.isFinishing)
    }

    @Test
    fun opensTheAuthorizePageOnTheIssuerHostOnly() {
        val ack = open()
        assertTrue(ack.getBoolean("ok"))
        assertEquals(listOf(Uri.parse(AUTHORIZE)), shown)
    }

    @Test
    fun anOffHostOrMalformedAuthorizeUrlIsRefusedWithoutOpeningAnything() {
        val bad = listOf(
            "https://evil.example.test/authorize?x=1",
            "http://key.example.test/authorize?x=1",
            "https://key.example.test.evil.test/authorize",
            "https://user@key.example.test/authorize",
            "https://key.example.test/authorize#frag",
            "javascript:alert(1)",
            "",
        )
        for (u in bad) {
            val r = open(url = u)
            assertFalse(u, r.getBoolean("ok"))
            assertEquals("url", r.getString("reason"))
        }
        assertEquals("url", open(issuer = "").getString("reason"))
        assertTrue(shown.isEmpty())
    }

    @Test
    fun aRedirectThatIsNotRegisteredIsRefused() {
        assertEquals("unregistered", open(scheme = null).getString("reason"))
        assertEquals("scheme", open(scheme = "https").getString("reason"))
        assertEquals("scheme", open(scheme = "Bad Scheme").getString("reason"))
        assertEquals("claimed", open(scheme = null, claimed = "http://game.example.test/pkey/callback").getString("reason"))
        assertEquals("claimed", open(scheme = null, claimed = "https://game.example.test/pkey/callback?x=1").getString("reason"))
        // Well formed, but the manifest carries no filter for it: the OS would not deliver it here.
        assertEquals("not-registered", open(scheme = "com.other.game").getString("reason"))
        assertEquals("not-registered", open(scheme = null, claimed = CLAIMED).getString("reason"))
        assertTrue(shown.isEmpty())
    }

    @Test
    fun aBrowserThatCannotStartAnswersUnavailableAndDropsTheWait() {
        canShow = false
        val r = open()
        assertFalse(r.getBoolean("ok"))
        assertEquals("no-browser", r.getString("reason"))
        deliverViaActivity("$SCHEME_URI?code=a&state=b")
        assertTrue(events().none { it.optString("ev") == "auth_done" })
    }

    @Test
    fun theRegisteredRedirectIsDeliveredOnce() {
        open()
        val url = "$SCHEME_URI?code=abc&state=xyz&iss=key.example.test"
        deliverViaActivity(url)
        deliverViaActivity(url)
        val done = events().filter { it.optString("ev") == "auth_done" }
        assertEquals(1, done.size)
        assertEquals(url, done[0].getString("url"))
    }

    @Test
    fun foreignAndMalformedIntentsAreDropped() {
        open()
        deliverViaActivity(null)
        deliverViaActivity("com.example.game:/other?code=a")
        deliverViaActivity("com.other.game:/pkey/callback?code=a")
        deliverViaActivity("https://evil.example.test/pkey/callback?code=a")
        deliverViaActivity("$SCHEME_URI")
        deliverViaActivity("$SCHEME_URI?code=a#frag")
        deliverViaActivity("$SCHEME_URI?code=" + "a".repeat(5000))
        val wrongAction = Robolectric.buildActivity(PKeyGodotRedirectActivity::class.java, Intent(Intent.ACTION_SEND).setData(Uri.parse("$SCHEME_URI?code=a"))).create().get()
        assertTrue(wrongAction.isFinishing)
        assertTrue(events().none { it.optString("ev") == "auth_done" })
    }

    @Test
    fun nothingIsDeliveredWithNoSignInWaitingOrAfterACancel() {
        deliverViaActivity("$SCHEME_URI?code=a&state=b")
        open()
        assertTrue(c.json(JSONObject().put("op", "auth_cancel")).getBoolean("ok"))
        deliverViaActivity("$SCHEME_URI?code=a&state=b")
        assertTrue(events().none { it.optString("ev") == "auth_done" })
    }

    @Test
    fun aNewOpenReplacesTheEarlierSignInAndAllowsItsRedirectAgain() {
        open()
        val url = "$SCHEME_URI?code=a&state=b"
        deliverViaActivity(url)
        open()
        deliverViaActivity(url)
        assertEquals(2, events().count { it.optString("ev") == "auth_done" })
    }

    @Test
    fun capabilitiesNameTheOps() {
        assertTrue(c.json(JSONObject().put("op", "capabilities")).getBoolean("authRedirect"))
    }
}
