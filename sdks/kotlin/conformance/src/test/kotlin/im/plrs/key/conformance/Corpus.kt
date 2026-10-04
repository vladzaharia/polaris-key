// Shared plumbing for the Kotlin conformance runner (P6-06): where the repository is, how a corpus
// file is read (IN PLACE from conformance/corpus/v2/, never from a mirror), which Ed25519 backend
// this run forces, and a soft-assertion collector so one run reports every failing vector.
//
// The Gradle `test` task runs every suite on the JCA backend and depends on `testTink`, which runs
// them again with `-Dpkey.ed25519=tink`; a verdict that differs between the two fails one of them.

package im.plrs.key.conformance

import im.plrs.key.core.Ed25519
import im.plrs.key.core.JcaEd25519Verifier
import im.plrs.key.core.JsonText
import im.plrs.key.core.TinkEd25519Verifier
import java.io.File
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertTrue
import org.junit.Assert.fail

object Corpus {
    /** The repository root, from `-Dpkey.repoRoot` (set by the Gradle test tasks). */
    val repoRoot: File by lazy {
        val prop = System.getProperty("pkey.repoRoot")
        val root = if (prop != null) File(prop) else File("../..").canonicalFile
        check(File(root, "conformance/corpus/v2").isDirectory) { "no conformance/corpus/v2 under $root" }
        root
    }

    /** `conformance/corpus/v2/<name>`, parsed. */
    fun v2(name: String): JsonObject = JsonText.parse(File(repoRoot, "conformance/corpus/v2/$name").readText()) as JsonObject

    /** The backend this run forces (`-Dpkey.ed25519=jca|tink`), installed process-wide. */
    val backend: String by lazy {
        val wanted = System.getProperty("pkey.ed25519") ?: "jca"
        Ed25519.verifier = when (wanted) {
            "tink" -> TinkEd25519Verifier.also { check(it.isAvailable) { "Tink is not on the test classpath" } }
            "jca" -> JcaEd25519Verifier.also { check(it.isAvailable) { "this JDK has no Ed25519" } }
            else -> error("unknown -Dpkey.ed25519=$wanted")
        }
        println("[conformance-kotlin] ed25519 ${Ed25519.verifier.name} · java ${System.getProperty("java.version")} · " +
            "${System.getProperty("os.name")} ${System.getProperty("os.arch")}")
        wanted
    }
}

/** Collects every failure of a suite, then fails once with the full list. */
class Failures(private val suite: String) {
    private val problems = ArrayList<String>()
    var checked = 0
        private set

    fun check(ok: Boolean, what: () -> String) {
        checked++
        if (!ok) problems += what()
    }

    fun equal(want: Any?, got: Any?, what: () -> String) =
        check(want == got) { "${what()}: expected $want, got $got" }

    fun done(minimum: Int = 1) {
        if (problems.isNotEmpty()) fail("$suite (${Corpus.backend}): ${problems.size} of $checked failed:\n  " + problems.joinToString("\n  "))
        assertTrue("$suite checked nothing", checked >= minimum)
    }
}

val JsonElement.obj: JsonObject get() = this as JsonObject
