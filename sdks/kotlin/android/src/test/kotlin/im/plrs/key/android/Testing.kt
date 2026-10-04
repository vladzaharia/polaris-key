package im.plrs.key.android

import android.os.Looper
import im.plrs.key.core.JsonText
import im.plrs.key.platform.KeyProvider
import java.io.File
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.serialization.json.JsonElement
import org.json.JSONObject
import org.robolectric.Shadows.shadowOf

/** A software AES key store standing in for AndroidKeyStore (which Robolectric does not provide). */
class SoftKeyProvider : KeyProvider {
    val keys = mutableMapOf<String, SecretKey>()

    /** When set, every call fails as a broken Keystore would. */
    var broken = false

    private fun check() {
        if (broken) throw GeneralSecurityException("keystore unavailable")
    }

    override fun get(alias: String): SecretKey? {
        check()
        return keys[alias]
    }

    override fun create(alias: String): SecretKey {
        check()
        return KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { keys[alias] = it }
    }

    override fun delete(alias: String) {
        check()
        keys.remove(alias)
    }

    override fun describe(alias: String): JSONObject = JSONObject().put("backend", "soft").put("exists", keys.containsKey(alias))
}

/** The repository's conformance corpus (`pkey.repoRoot`, set by the build). */
object Corpus {
    private val root: File = File(System.getProperty("pkey.repoRoot") ?: "../../..")

    fun load(name: String): JsonElement {
        val f = File(root, "conformance/corpus/v2/$name")
        return JsonText.parseOrNull(f.readText()) ?: error("cannot parse $f")
    }
}

/**
 * Runs a suspend [block] on the main thread, pumping the paused main looper until it finishes, so
 * Play callbacks (posted to the main looper) can resume it.
 */
fun <T> pumped(block: suspend () -> T): T {
    val job = CoroutineScope(Dispatchers.Unconfined).async { block() }
    val looper = shadowOf(Looper.getMainLooper())
    var spins = 0
    while (!job.isCompleted) {
        looper.idle()
        if (++spins > 10_000) error("the block did not finish")
        Thread.sleep(1)
    }
    @Suppress("OPT_IN_USAGE")
    return job.getCompleted()
}
