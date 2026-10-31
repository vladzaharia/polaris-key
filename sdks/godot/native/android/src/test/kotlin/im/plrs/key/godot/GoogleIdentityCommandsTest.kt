package im.plrs.key.godot

import android.content.Context
import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import im.plrs.key.platform.PlatformIdentityToken
import im.plrs.key.platform.PolarisKeyPlatform
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A [PlatformIdentity] that answers [next] to every call and records what it was asked. */
private class FakeIdentity(var next: PlatformIdentityResult) : PlatformIdentity {
    val calls = mutableListOf<List<String>>()
    var cleared = true
    var contexts = 0
    override val isSupported: Boolean get() = true
    override val kinds: Set<String> get() = setOf(PlatformIdentity.KIND_GOOGLE)

    private fun record(kind: String, context: Context, id: String, nonce: String, cb: (PlatformIdentityResult) -> Unit) {
        contexts++
        calls += listOf(kind, id, nonce)
        cb(next)
    }

    override fun silent(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit) =
        record("silent", context, serverClientId, nonce, callback)

    override fun sheet(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit) =
        record("sheet", context, serverClientId, nonce, callback)

    override fun provider(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit) =
        record("provider", context, serverClientId, nonce, callback)

    override fun signOutCleanup(context: Context, callback: (Boolean) -> Unit) = callback(cleared)
}

private class FakeBackend(
    val identity: FakeIdentity,
    var play: Boolean = true,
    var dependency: Boolean = true,
    var linkError: Boolean = false,
) : GoogleIdentityCommands.Backend {
    override fun dependencyPresent(): Boolean = dependency

    override fun flavorHasGoogle(): Boolean = play

    override fun identity(): PlatformIdentity = if (linkError) throw NoClassDefFoundError("androidx/credentials/CredentialManager") else identity
}

@RunWith(RobolectricTestRunner::class)
class GoogleIdentityCommandsTest {
    private val token = PlatformIdentityToken("google", "eyJ.google.SECRET")
    private val fake = FakeIdentity(PlatformIdentityResult.Success(token))
    private val backend = FakeBackend(fake)
    private val host = TestHost()
    private val c = Commands(host, identity = backend)

    private fun run(op: String, id: String? = "web-client.apps.googleusercontent.com", nonce: String? = "bm9uY2U"): JSONObject {
        val q = JSONObject().put("op", op)
        if (id != null) q.put("serverClientId", id)
        if (nonce != null) q.put("nonce", nonce)
        val ack = c.json(q)
        assertTrue(ack.getBoolean("ok"))
        return c.awaitResult(ack.getInt("req"))
    }

    @Test
    fun theThreeSignInOpsCarryTheTokenInTheEventOnly() {
        for ((op, kind) in listOf("gid_silent" to "silent", "gid_sheet" to "sheet", "gid_provider" to "provider")) {
            val ack = c.json(JSONObject().put("op", op).put("serverClientId", "id").put("nonce", "n"))
            assertFalse("the ack carries no token", ack.has("token"))
            val ev = c.awaitResult(ack.getInt("req"))
            assertTrue(ev.getBoolean("ok"))
            assertEquals("eyJ.google.SECRET", ev.getString("token"))
            assertEquals(listOf(kind, "id", "n"), fake.calls.last())
        }
    }

    @Test
    fun aDismissedSheetIsCancelled() {
        fake.next = PlatformIdentityResult.Cancelled
        val ev = run("gid_sheet")
        assertFalse(ev.getBoolean("ok"))
        assertEquals("cancelled", ev.getString("error"))
        assertFalse(ev.has("token"))
    }

    @Test
    fun unavailableCarriesAFixedReason() {
        fake.next = PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_NO_CREDENTIAL)
        val ev = run("gid_silent")
        assertEquals("unavailable", ev.getString("error"))
        assertEquals("no-credential", ev.getString("reason"))
    }

    @Test
    fun emptyArgumentsAreRefusedBeforeTheOsIsAsked() {
        for (ev in listOf(run("gid_silent", id = ""), run("gid_silent", nonce = ""), run("gid_sheet", id = null))) {
            assertEquals("unavailable", ev.getString("error"))
            assertEquals("refused", ev.getString("reason"))
        }
        assertTrue(fake.calls.isEmpty())
    }

    @Test
    fun withoutTheLibrariesTheAnswerIsDependencyAndNoClassIsLoaded() {
        backend.dependency = false
        for (op in listOf("gid_silent", "gid_sheet", "gid_provider")) {
            val ev = run(op)
            assertEquals("unavailable", ev.getString("error"))
            assertEquals("dependency", ev.getString("reason"))
        }
        assertTrue(fake.calls.isEmpty())
        assertFalse(c.json(JSONObject().put("op", "capabilities")).getBoolean("googleId"))
        // Nothing was signed in, so the sign-out has nothing to clear and asks nobody.
        backend.linkError = true
        val out = c.json(JSONObject().put("op", "gid_sign_out"))
        assertTrue(out.getBoolean("ok"))
        assertTrue(out.getBoolean("cleared"))
    }

    @Test
    fun aLinkageErrorAfterTheCheckIsStillDependencyNeverACrash() {
        backend.linkError = true
        val ev = run("gid_silent")
        assertEquals("dependency", ev.getString("reason"))
        val out = c.awaitResult(c.json(JSONObject().put("op", "gid_sign_out")).getInt("req"))
        assertTrue(out.getBoolean("ok"))
    }

    @Test
    fun theDirectFlavourAnswersOutlet() {
        backend.play = false
        val ev = run("gid_silent")
        assertEquals("outlet", ev.getString("reason"))
        assertFalse(c.json(JSONObject().put("op", "capabilities")).getBoolean("googleId"))
        assertTrue(fake.calls.isEmpty())
    }

    @Test
    fun capabilitiesReportTheOpsWhenTheyCanRun() {
        assertTrue(c.json(JSONObject().put("op", "capabilities")).getBoolean("googleId"))
    }

    @Test
    fun signOutReportsWhetherTheStateWasCleared() {
        for (cleared in listOf(true, false)) {
            fake.cleared = cleared
            val ack = c.json(JSONObject().put("op", "gid_sign_out"))
            val ev = c.awaitResult(ack.getInt("req"))
            assertTrue(ev.getBoolean("ok"))
            assertEquals(cleared, ev.getBoolean("cleared"))
        }
    }

    @Test
    fun noForegroundActivityIsUnavailable() {
        val noActivity = object : Host {
            override val appContext: Context get() = host.appContext
            override val foregroundActivity: android.app.Activity? get() = null
            override fun onUi(r: Runnable) = r.run()
        }
        val ev = Commands(noActivity, identity = backend).let { cc ->
            val ack = cc.json(JSONObject().put("op", "gid_silent").put("serverClientId", "id").put("nonce", "n"))
            cc.awaitResult(ack.getInt("req"))
        }
        assertEquals("no-activity", ev.getString("reason"))
        assertTrue(fake.calls.isEmpty())
    }

    @Test
    fun theDefaultBackendNamesTheFlavourAndDoesNotCrashOnMissingClasses() {
        val real = GoogleIdentityCommands.Real
        assertEquals(PolarisKeyPlatform.isPlay, real.flavorHasGoogle())
        // A class-presence check answers either way; it never throws.
        real.dependencyPresent()
    }

    @Test
    fun theDependencyCheckNamesTheCredentialProviderArtifactToo() {
        // SR-4 L2: without the provider artifact Credential Manager finds no Google provider.
        assertTrue(GoogleIdentityCommands.DEPENDENCY_CLASSES.contains("androidx.credentials.playservices.CredentialProviderPlayServicesImpl"))
    }
}
