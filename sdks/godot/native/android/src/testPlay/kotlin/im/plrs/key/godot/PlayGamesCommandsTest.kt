package im.plrs.key.godot

import android.app.Activity
import android.content.Context
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Play Games Services v2, scripted: whether the player is signed in, what a code request yields, and what was asked. */
private class FakePlayGames : PlayGamesBackend {
    var present = true
    var authenticated: Result<Boolean> = Result.success(true)
    var signInResult: Result<Boolean> = Result.success(true)
    var code: Result<String> = Result.success("4/transcript-server-auth-code")
    val calls = mutableListOf<String>()

    override fun dependencyPresent(): Boolean = present

    override fun isAuthenticated(activity: Activity, callback: (Result<Boolean>) -> Unit) {
        calls += "isAuthenticated"
        callback(authenticated)
    }

    override fun signIn(activity: Activity, callback: (Result<Boolean>) -> Unit) {
        calls += "signIn"
        callback(signInResult)
    }

    override fun requestServerSideAccess(activity: Activity, serverClientId: String, callback: (Result<String>) -> Unit) {
        calls += "requestServerSideAccess:$serverClientId"
        callback(code)
    }
}

@RunWith(RobolectricTestRunner::class)
class PlayGamesCommandsTest {
    private val fake = FakePlayGames()
    private val host = TestHost()
    private val c = Commands(host, flavorFactory = { PlayCommands(it, playGamesBackend = fake) })

    private fun run(op: String, id: String? = "123456789012-pgs.apps.googleusercontent.com"): JSONObject {
        val q = JSONObject().put("op", op)
        if (id != null) q.put("serverClientId", id)
        val ack = c.json(q)
        assertTrue(ack.getBoolean("ok"))
        assertFalse("the ack carries no code", ack.has("code"))
        return c.awaitResult(ack.getInt("req"))
    }

    @Test
    fun aSignedInPlayerYieldsTheServerAuthCodeInTheEventOnly() {
        val ev = run("pgs_code")
        assertTrue(ev.getBoolean("ok"))
        assertEquals("4/transcript-server-auth-code", ev.getString("code"))
        assertEquals(listOf("isAuthenticated", "requestServerSideAccess:123456789012-pgs.apps.googleusercontent.com"), fake.calls)
    }

    @Test
    fun thisOpNeverStartsPlayGamesSignIn() {
        fake.authenticated = Result.success(false)
        val ev = run("pgs_code")
        assertEquals("unavailable", ev.getString("error"))
        assertEquals("not-authenticated", ev.getString("reason"))
        assertEquals(listOf("isAuthenticated"), fake.calls)
    }

    @Test
    fun failuresAreFixedWordsNeverTheExceptionText() {
        fake.authenticated = Result.failure(IllegalStateException("secret text"))
        assertEquals("failed", run("pgs_code").getString("reason"))
        fake.authenticated = Result.success(true)
        fake.code = Result.failure(IllegalStateException("secret text"))
        val ev = run("pgs_code")
        assertEquals("failed", ev.getString("reason"))
        assertFalse(ev.toString().contains("secret text"))
    }

    @Test
    fun anEmptyServerClientIdIsRefusedBeforePlayGamesIsAsked() {
        for (id in listOf("", null, "  ")) {
            assertEquals("refused", run("pgs_code", id).getString("reason"))
        }
        assertTrue(fake.calls.isEmpty())
    }

    @Test
    fun withoutTheLibraryTheAnswerIsDependency() {
        fake.present = false
        for (op in listOf("pgs_code", "pgs_sign_in")) assertEquals("dependency", run(op).getString("reason"))
        assertTrue(fake.calls.isEmpty())
        assertFalse(c.json(JSONObject().put("op", "capabilities")).getBoolean("playGames"))
    }

    @Test
    fun theRowSignsInAndReportsWhetherThePlayerIsAuthenticated() {
        val ev = run("pgs_sign_in", id = null)
        assertTrue(ev.getBoolean("ok"))
        assertTrue(ev.getBoolean("authenticated"))
        fake.signInResult = Result.success(false)
        assertFalse(run("pgs_sign_in", id = null).getBoolean("authenticated"))
        fake.signInResult = Result.failure(IllegalStateException("x"))
        assertEquals("failed", run("pgs_sign_in", id = null).getString("reason"))
    }

    @Test
    fun noForegroundActivityIsUnavailable() {
        val none = object : Host {
            override val appContext: Context get() = host.appContext
            override val foregroundActivity: Activity? get() = null
            override fun onUi(r: Runnable) = r.run()
        }
        val cc = Commands(none, flavorFactory = { PlayCommands(it, playGamesBackend = fake) })
        val ack = cc.json(JSONObject().put("op", "pgs_code").put("serverClientId", "id"))
        assertEquals("no-activity", cc.awaitResult(ack.getInt("req")).getString("reason"))
        assertTrue(fake.calls.isEmpty())
    }

    @Test
    fun capabilitiesReportTheOpsWhenTheLibraryIsThere() {
        assertTrue(c.json(JSONObject().put("op", "capabilities")).getBoolean("playGames"))
    }

    @Test
    fun theDefaultBackendJudgesThePresenceByClassNameAndNeverCrashes() {
        val system = SystemPlayGames { host.appContext }
        system.dependencyPresent()
    }
}
