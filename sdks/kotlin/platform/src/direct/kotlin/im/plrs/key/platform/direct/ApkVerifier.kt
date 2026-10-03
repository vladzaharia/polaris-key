package im.plrs.key.platform.direct

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import im.plrs.key.platform.Digests
import im.plrs.key.platform.InstallSource
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** What an APK file declares: package, versionCode and signing-certificate digests. */
public data class ArchiveFacts(val packageName: String, val versionCode: Long, val signers: List<String>)

/** Reads [ArchiveFacts] for an APK and for the installed app; [AndroidPackageFacts] on a device. */
public interface PackageFacts {
    /** The archive's facts, or null when the file is not a parseable APK. */
    public fun archive(path: String): ArchiveFacts?

    public fun installed(): ArchiveFacts

    /** Directories an update APK may be read from: the app's private storage. */
    public fun privateDirs(): List<File>
}

/** [PackageFacts] over `PackageManager.getPackageArchiveInfo` (with `GET_SIGNING_CERTIFICATES`). */
public class AndroidPackageFacts(private val context: Context) : PackageFacts {
    override fun archive(path: String): ArchiveFacts? {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES)
        } ?: return null
        val signers = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.apkContentsSigners?.let { InstallSource.digests(it) } ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            info.signatures?.let { InstallSource.digests(it) } ?: emptyList()
        }
        return ArchiveFacts(info.packageName ?: "", InstallSource.versionCode(info), signers)
    }

    override fun installed(): ArchiveFacts {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return ArchiveFacts(context.packageName, InstallSource.versionCode(info), InstallSource.selfSigners(context))
    }

    override fun privateDirs(): List<File> = listOfNotNull(context.filesDir, context.noBackupFilesDir, context.cacheDir, context.codeCacheDir)
}

/**
 * The verdict on an update APK. [refused] is empty when [ok]; otherwise every reason that applies:
 *
 *   missing_file        no such file (or not a regular file)
 *   path_not_private    outside the app's private storage, where another app could swap it
 *   hash_required       no well-formed expected SHA-256 was given
 *   hash_mismatch       the file's SHA-256 is not the expected one
 *   unparseable         PackageManager cannot read it as an APK
 *   package_mismatch    a different package name
 *   signer_mismatch     its signing-certificate set is not exactly the installed one
 *   version_not_higher  its versionCode is not above the installed one
 *   version_mismatch    its versionCode is not the one the caller expected
 */
public data class Verdict(
    val refused: List<String>,
    val path: String,
    val size: Long,
    val sha256: String?,
    val archive: ArchiveFacts?,
    val installed: ArchiveFacts?,
) {
    val ok: Boolean get() = refused.isEmpty()

    public fun toJson(): JSONObject = JSONObject()
        .put("ok", ok)
        .put("refused", JSONArray(refused))
        .put("path", path)
        .put("size", size)
        .put("sha256", sha256 ?: JSONObject.NULL)
        .put("archive", archive?.let { facts(it) } ?: JSONObject.NULL)
        .put("installed", installed?.let { facts(it) } ?: JSONObject.NULL)

    private fun facts(f: ArchiveFacts) = JSONObject()
        .put("package", f.packageName)
        .put("versionCode", f.versionCode)
        .put("signers", JSONArray(f.signers))
}

/**
 * Checks an update APK BEFORE any PackageInstaller session is opened (notes/S-10 §3: 71–166 ms
 * for 74 MB on the emulator; run it off the game's thread). The download is the caller's; this
 * only reads the file.
 */
public object ApkVerifier {
    public fun verify(file: File, expectedSha256: String?, expectedVersionCode: Long?, facts: PackageFacts): Verdict {
        val refused = mutableListOf<String>()
        val path = file.path
        if (!file.isFile) return Verdict(listOf("missing_file"), path, 0, null, null, null)
        if (!isInside(file, facts.privateDirs())) refused.add("path_not_private")
        val sha = Digests.sha256(file)
        if (!Digests.isSha256Hex(expectedSha256)) {
            refused.add("hash_required")
        } else if (!sha.equals(expectedSha256, ignoreCase = true)) {
            refused.add("hash_mismatch")
        }
        val installed = facts.installed()
        val archive = facts.archive(path)
        if (archive == null) {
            refused.add("unparseable")
        } else {
            if (archive.packageName != installed.packageName) refused.add("package_mismatch")
            if (archive.signers.isEmpty() || archive.signers.toSet() != installed.signers.toSet()) refused.add("signer_mismatch")
            if (archive.versionCode <= installed.versionCode) refused.add("version_not_higher")
            if (expectedVersionCode != null && archive.versionCode != expectedVersionCode) refused.add("version_mismatch")
        }
        return Verdict(refused, path, file.length(), sha, archive, installed)
    }

    internal fun isInside(file: File, dirs: List<File>): Boolean {
        val target = file.canonicalFile
        return dirs.any { dir ->
            val root = dir.canonicalFile
            var p: File? = target.parentFile
            while (p != null) {
                if (p == root) return@any true
                p = p.parentFile
            }
            false
        }
    }
}
