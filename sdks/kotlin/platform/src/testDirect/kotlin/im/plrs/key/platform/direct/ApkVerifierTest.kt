package im.plrs.key.platform.direct

import im.plrs.key.platform.Digests
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.nio.file.Files

const val SIGNER_A = "b258a7ba00000000000000000000000000000000000000000000000000009f11bd"
const val SIGNER_B = "0ther000000000000000000000000000000000000000000000000000000000000"

/** [PackageFacts] with a fixed installed app and per-path archive facts. */
class FakeFacts(
    val dirs: List<File>,
    var installed: ArchiveFacts = ArchiveFacts("gg.vlad.diceroll", 10, listOf(SIGNER_A)),
) : PackageFacts {
    val archives = mutableMapOf<String, ArchiveFacts?>()
    var onArchive: ((String) -> Unit)? = null

    override fun archive(path: String): ArchiveFacts? {
        onArchive?.invoke(path)
        return archives[path]
    }

    override fun installed(): ArchiveFacts = installed

    override fun privateDirs(): List<File> = dirs
}

/** Every refusal in PackageInstaller verification, each checked before any session exists. */
@RunWith(RobolectricTestRunner::class)
class ApkVerifierTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var priv: File
    private lateinit var facts: FakeFacts
    private lateinit var apk: File
    private lateinit var sha: String

    @Before
    fun setUp() {
        priv = tmp.newFolder("files")
        facts = FakeFacts(listOf(priv))
        apk = File(priv, "updates/diceroll-11.apk").apply {
            parentFile!!.mkdirs()
            writeBytes(ByteArray(4096) { (it % 251).toByte() })
        }
        sha = Digests.sha256(apk)
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 11, listOf(SIGNER_A))
    }

    private fun verify(file: File = apk, hash: String? = sha, vc: Long? = 11) = ApkVerifier.verify(file, hash, vc, facts)

    @Test
    fun aGoodUpdatePasses() {
        val v = verify()
        assertTrue(v.refused.toString(), v.ok)
        assertEquals(sha, v.sha256)
        assertEquals(4096L, v.size)
        assertEquals(11L, v.archive!!.versionCode)
        assertTrue(v.toJson().getBoolean("ok"))
        // The expected versionCode is optional; the hash compares case-insensitively.
        assertTrue(verify(vc = null, hash = sha.uppercase()).ok)
    }

    @Test
    fun missingFile() {
        assertEquals(listOf("missing_file"), verify(File(priv, "nope.apk")).refused)
        assertEquals(listOf("missing_file"), verify(priv).refused)
    }

    @Test
    fun hashRequired() {
        assertEquals(listOf("hash_required"), verify(hash = null).refused)
        assertEquals(listOf("hash_required"), verify(hash = "").refused)
        assertEquals(listOf("hash_required"), verify(hash = "abc123").refused)
        assertEquals(listOf("hash_required"), verify(hash = "z".repeat(64)).refused)
    }

    @Test
    fun wrongHash() {
        val other = "0".repeat(64)
        assertEquals(listOf("hash_mismatch"), verify(hash = other).refused)
    }

    @Test
    fun wrongSigner() {
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 11, listOf(SIGNER_B))
        assertEquals(listOf("signer_mismatch"), verify().refused)
    }

    @Test
    fun signerSetMustBeExactlyEqual() {
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 11, listOf(SIGNER_A, SIGNER_B))
        assertEquals(listOf("signer_mismatch"), verify().refused)
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 11, emptyList())
        assertEquals(listOf("signer_mismatch"), verify().refused)
        facts.installed = ArchiveFacts("gg.vlad.diceroll", 10, emptyList())
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 11, emptyList())
        assertEquals(listOf("signer_mismatch"), verify().refused)
    }

    @Test
    fun lowerVersionCode() {
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 9, listOf(SIGNER_A))
        assertEquals(listOf("version_not_higher", "version_mismatch"), verify().refused)
        assertEquals(listOf("version_not_higher"), verify(vc = 9).refused)
    }

    @Test
    fun equalVersionCode() {
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 10, listOf(SIGNER_A))
        assertEquals(listOf("version_not_higher"), verify(vc = 10).refused)
    }

    @Test
    fun unexpectedVersionCode() {
        facts.archives[apk.path] = ArchiveFacts("gg.vlad.diceroll", 12, listOf(SIGNER_A))
        assertEquals(listOf("version_mismatch"), verify(vc = 11).refused)
    }

    @Test
    fun otherPackage() {
        facts.archives[apk.path] = ArchiveFacts("com.evil.game", 11, listOf(SIGNER_A))
        assertEquals(listOf("package_mismatch"), verify().refused)
    }

    @Test
    fun unparseable() {
        facts.archives[apk.path] = null
        assertEquals(listOf("unparseable"), verify().refused)
    }

    @Test
    fun outsidePrivateStorage() {
        val outside = tmp.newFile("Download.apk").apply { writeBytes(apk.readBytes()) }
        facts.archives[outside.path] = ArchiveFacts("gg.vlad.diceroll", 11, listOf(SIGNER_A))
        assertEquals(listOf("path_not_private"), verify(outside).refused)
    }

    @Test
    fun aSymlinkOutOfPrivateStorageIsOutside() {
        val outside = tmp.newFile("elsewhere.apk").apply { writeBytes(apk.readBytes()) }
        val link = File(priv, "link.apk")
        Files.createSymbolicLink(link.toPath(), outside.toPath())
        facts.archives[link.path] = ArchiveFacts("gg.vlad.diceroll", 11, listOf(SIGNER_A))
        assertEquals(listOf("path_not_private"), verify(link).refused)
    }

    @Test
    fun theDirectoryItselfIsNotInsideAnotherWithTheSamePrefix() {
        val sibling = tmp.newFolder("files-evil")
        val f = File(sibling, "x.apk").apply { writeBytes(apk.readBytes()) }
        facts.archives[f.path] = ArchiveFacts("gg.vlad.diceroll", 11, listOf(SIGNER_A))
        assertFalse(ApkVerifier.isInside(f, listOf(priv)))
        assertEquals(listOf("path_not_private"), verify(f).refused)
    }

    @Test
    fun everyReasonIsReportedTogether() {
        facts.archives[apk.path] = ArchiveFacts("com.evil.game", 3, listOf(SIGNER_B))
        assertEquals(
            listOf("hash_mismatch", "package_mismatch", "signer_mismatch", "version_not_higher", "version_mismatch"),
            verify(hash = "1".repeat(64)).refused,
        )
    }
}
