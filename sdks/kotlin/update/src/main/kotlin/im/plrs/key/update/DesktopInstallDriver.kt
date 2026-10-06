// update.driver on a JVM desktop (UK-40, SP-K12): download the installer for this OS and arch,
// verify it against the signed release record, and open it. The desktop sibling of Android's
// DirectInstallDriver (P6-12), on :update's InstallDriver port:
//
//   1. `binary` with method `download` or `native` (a JVM app has no other native updater); a
//      `store` decision is declined with its listing, `sidecar-pck` is declined, anything else has
//      nothing to install;
//   2. the VERIFIED release record the decision pins (UpdateClient.releaseRecord), and its build
//      `decision.build` — the decision already chose the build for this install's platform and arch
//      — with exactly one `payload` artifact (else `record-mismatch`);
//   3. the bytes from discovery's builds route (UpdateClient.buildUrl) through [ArtifactFetch] into
//      `<dir>/<artifact name>.part` (resumable), then checked against the artifact's size and
//      SHA-256 BEFORE anything opens it (else `payload-mismatch`, the `.part` removed, nothing
//      opened);
//   4. the verified file moved to `<dir>/<artifact name>` and handed to [InstallerOpener]: the OS
//      opens a `.dmg`/`.pkg`, an `.msi`/`.exe`, a `.deb`/`.rpm`, or runs an `.AppImage`.
//
// Nothing comes from an unsigned field: the URL is only where the bytes are fetched from, and the
// file name is the record's artifact name reduced to a safe basename. `Started` means the installer
// is open; the host then quits so the installer can replace the app (UK-10's UpdatePrompt says so).

package im.plrs.key.update

import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleaseRecordBuild
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Opens a verified installer with the OS. */
public fun interface InstallerOpener {
    /** Open [installer] (built as [build]); throws when the OS cannot. */
    public fun open(installer: File, build: ReleaseRecordBuild)
}

/**
 * [InstallerOpener] through the OS's own launcher: `open` on macOS, the shell's `ShellExec` on
 * Windows (no `cmd` parsing of the path), and on Linux `xdg-open`, except an AppImage, which is made
 * executable and run.
 */
public class SystemInstallerOpener(
    private val osName: String = System.getProperty("os.name").orEmpty(),
    private val launch: (List<String>) -> Unit = { ProcessBuilder(it).inheritIO().start() },
) : InstallerOpener {
    /** The command that opens [installer]. */
    public fun command(installer: File, build: ReleaseRecordBuild): List<String> {
        val path = installer.absolutePath
        return when {
            osName.startsWith("Mac", true) -> listOf("open", path)
            osName.startsWith("Windows", true) -> listOf("rundll32.exe", "shell32.dll,ShellExec_RunDLL", path)
            isAppImage(installer, build) -> listOf(path)
            else -> listOf("xdg-open", path)
        }
    }

    override fun open(installer: File, build: ReleaseRecordBuild) {
        val cmd = command(installer, build)
        if (cmd.size == 1 && !installer.setExecutable(true, true)) throw IOException("could not make $installer executable")
        launch(cmd)
    }

    private fun isAppImage(installer: File, build: ReleaseRecordBuild): Boolean =
        installer.name.endsWith(".AppImage", ignoreCase = true) || build.format.equals("appimage", ignoreCase = true)
}

/** The verified desktop installer hand-off as :update's install driver (see the file comment). */
public class DesktopInstallDriver(
    /** The verified release record by its SHA-256 (UpdateClient.releaseRecord). */
    private val records: suspend (String) -> ReleaseRecordDoc,
    /** A build's download URL (UpdateClient.buildUrl). */
    private val buildUrl: suspend (version: String, buildId: String) -> String?,
    private val fetch: ArtifactFetch,
    /** The app-private directory installers are downloaded into (created 0700). */
    private val dir: File,
    private val opener: InstallerOpener = SystemInstallerOpener(),
    /** Download progress: (received, total) bytes. */
    private val progress: ((Long, Long) -> Unit)? = null,
) : InstallDriver {
    /** The installer the last successful [install] opened, or null. */
    @Volatile public var lastInstaller: File? = null
        private set

    override suspend fun install(check: UpdateCheck): InstallResult {
        val d = check.decision
        return when {
            d is UpdateDecision.Binary && (d.method == BinaryMethod.download || d.method == BinaryMethod.native) -> installBuild(d)
            d is UpdateDecision.Binary -> InstallResult.Declined("binary ${d.method}: a JVM desktop app installs whole builds only")
            d is UpdateDecision.Store -> InstallResult.Declined("a store updates this install${d.listingUrl?.let { ": $it" } ?: ""}")
            else -> InstallResult.NothingToInstall
        }
    }

    private suspend fun installBuild(d: UpdateDecision.Binary): InstallResult {
        val sha = d.release.sha256 ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the decision pins no release record")
        val record = try {
            records(sha)
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            return InstallResult.Failed(e.code, e.message)
        } catch (e: Exception) {
            return InstallResult.Failed(ErrorCode.recordRejected, e.message)
        }
        val build = record.builds?.firstOrNull { it.id == d.build }
            ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the verified record has no build '${d.build}'")
        val artifact = build.artifacts.filter { it.role == PAYLOAD }.singleOrNull()
            ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the verified record's build '${d.build}' has no single payload")
        val url = try {
            buildUrl(d.release.version, d.build)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return InstallResult.Failed(ErrorCode.serviceUnavailable, "discovery names no builds route")
        val name = safeName(artifact.name)
        val part = File(dir, "$name.part")
        val installer = File(dir, name)
        try {
            ensureDir()
            fetch.fetch(url, part, artifact.size, progress)
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            return InstallResult.Failed(e.code, e.message)
        } catch (e: IOException) {
            return InstallResult.Failed(ErrorCode.storeFailed, e.message)
        } catch (e: Exception) {
            return InstallResult.Failed(ErrorCode.networkError, e.message)
        }
        // The installer is verified against the signed record BEFORE anything opens it.
        val ok = withContext(Dispatchers.IO) { part.isFile && part.length() == artifact.size && sha256(part).equals(artifact.sha256, ignoreCase = true) }
        if (!ok) {
            part.delete()
            return InstallResult.Failed(ErrorCode.payloadMismatch, "the downloaded installer does not match the record's size and SHA-256; nothing was opened")
        }
        try {
            withContext(Dispatchers.IO) { Files.move(part.toPath(), installer.toPath(), StandardCopyOption.REPLACE_EXISTING) }
        } catch (e: IOException) {
            part.delete()
            return InstallResult.Failed(ErrorCode.storeFailed, "the verified installer could not be moved into place: ${e.message}")
        }
        try {
            withContext(Dispatchers.IO) { opener.open(installer, build) }
        } catch (e: Exception) {
            return InstallResult.Failed(ErrorCode.platformError, "the OS could not open the installer: ${e.message ?: e.javaClass.simpleName}")
        }
        lastInstaller = installer
        return InstallResult.Started
    }

    /**
     * Remove installers a previous launch opened (call at launch, once the new version runs); a
     * `.part` is kept for resumption unless [partials]. Returns the files removed.
     */
    public fun cleanup(partials: Boolean = false): List<File> {
        val files = dir.listFiles()?.filter { it.isFile && (partials || !it.name.endsWith(".part")) }.orEmpty()
        return files.filter { it.delete() }
    }

    private fun ensureDir() {
        if (dir.isDirectory) return
        if (!dir.mkdirs() && !dir.isDirectory) throw IOException("cannot create $dir")
        try {
            Files.setPosixFilePermissions(dir.toPath(), PosixFilePermissions.fromString("rwx------"))
        } catch (e: UnsupportedOperationException) {
            // Windows: the user profile's ACL applies.
        }
    }

    public companion object {
        public const val PAYLOAD: String = "payload"

        /** The record's artifact name as a safe basename: no directories, no leading dot, `[A-Za-z0-9._-]` only. */
        public fun safeName(name: String): String {
            val base = name.substringAfterLast('/').substringAfterLast('\\')
            val cleaned = base.map { if (it.isLetterOrDigit() && it.code < 128 || it == '.' || it == '-' || it == '_') it else '_' }.joinToString("")
            val trimmed = cleaned.trimStart('.')
            return trimmed.ifEmpty { "installer" }.take(128)
        }

        internal fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }
    }
}
