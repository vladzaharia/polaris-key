// A JVM desktop install driver (SP-K12, notes/SDK-PARITY-PASS.md §3.16 "Kotlin: … desktop installer
// open"): a `binary` decision downloads the build's installer through `release.fetch` (the verified
// record, bearer and X-PKey headers, Range resume, size and SHA-256 checked) into [directory] under
// the artifact's own name, then hands it to the OS (java.awt.Desktop.open: the .msi, .exe, .dmg,
// .pkg or AppImage opens as the user's desktop would open it). A `store` decision opens the listing
// in the browser. Both journal `update_applied` at the hand-off (§3.13; `release.fetch` journals
// `update_downloaded`).
//
// Opt-in: the JVM's default stays JvmInstallDriver (the registry's typed `runtime` N/A, which
// supports() reports), so a server or CLI never opens anything. A desktop app passes it:
//
//   lateinit var client: PolarisKeyClient
//   client = PolarisKeyClient.create(PolarisKeyClientOptions(core = …,
//       update = UpdateClientOptions(pinnedReleaseKeys = KEYS, installDriver = DesktopInstallDriver { client })))
//
// Where no desktop can open a file (headless, no AWT) the installer is still downloaded and the
// result is Failed(unsupported) naming its path, so the host can show it.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.UpdateEvent
import im.plrs.key.release.ReleaseTarget
import im.plrs.key.update.InstallDriver
import im.plrs.key.update.InstallResult
import java.io.File
import java.net.URI
import kotlinx.coroutines.CancellationException

/** Downloads and opens a desktop installer; see the file comment. */
public class DesktopInstallDriver @JvmOverloads constructor(
    /** Where installers are downloaded; null is `updates/` in the store's state directory, else the temp directory. */
    private val directory: File? = null,
    /** Hands a file to the OS; false when nothing can open it. */
    private val open: (File) -> Boolean = ::desktopOpen,
    /** Opens a store listing; false when nothing can. */
    private val browse: (String) -> Boolean = ::desktopBrowse,
    /** Download progress (bytes so far, total). */
    private val onProgress: ((Long, Long) -> Unit)? = null,
    /** The verified release record by hash; null is `client.update.releaseRecord` (the pinned release keys). */
    private val records: (suspend (String) -> im.plrs.key.core.ReleaseRecordDoc)? = null,
    /** The client whose release service downloads and whose journal records (resolved at install time). */
    private val client: () -> PolarisKeyClient,
) : InstallDriver {
    override suspend fun install(check: UpdateCheck): InstallResult {
        val c = client()
        return when (val d = check.decision) {
            is UpdateDecision.Binary -> installBinary(c, d)
            is UpdateDecision.Store -> {
                val url = d.listingUrl ?: return InstallResult.Failed(ErrorCode.unsupported, "the store decision names no listing")
                if (!browse(url)) return InstallResult.Failed(ErrorCode.unsupported, "no browser to open $url")
                c.updateEvents.record(UpdateEvent.updateApplied, d.release.version, fromRelease = c.core.version)
                InstallResult.Started
            }
            else -> InstallResult.NothingToInstall
        }
    }

    private suspend fun installBinary(c: PolarisKeyClient, d: UpdateDecision.Binary): InstallResult {
        val sha = d.release.sha256 ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the decision pins no release record")
        val record = try {
            records?.invoke(sha) ?: c.update.releaseRecord(sha).record
        } catch (e: CancellationException) {
            throw e
        } catch (e: im.plrs.key.core.PolarisException) {
            return InstallResult.Failed(e.code, e.message)
        }
        val artifact = record.builds?.firstOrNull { it.id == d.build }?.artifacts?.filter { it.role == "payload" }?.singleOrNull()
            ?: return InstallResult.Failed(ErrorCode.recordMismatch, "the verified record has no build '${d.build}' with one payload")
        val name = File(artifact.name).name.ifEmpty { "${d.release.version}-${d.build}" }
        val dir = directory ?: c.core.store.stateDirectory?.let { File(it, "updates") } ?: File(System.getProperty("java.io.tmpdir"), "pkey-${c.core.product}-updates")
        dir.mkdirs()
        val fetched = try {
            c.release.fetch(ReleaseTarget.Record(record, d.build), File(dir, name), onProgress)
        } catch (e: CancellationException) {
            throw e
        } catch (e: im.plrs.key.core.PolarisException) {
            return InstallResult.Failed(e.code, e.message)
        }
        if (!open(fetched.path)) {
            return InstallResult.Failed(ErrorCode.unsupported, "no desktop to open the installer; it is at ${fetched.path.absolutePath}")
        }
        c.updateEvents.record(UpdateEvent.updateApplied, d.release.version, fromRelease = c.core.version)
        return InstallResult.Started
    }

    public companion object {
        // java.awt by reflection: :sdk also ships inside Android apps, which have no java.awt.
        private fun desktop(action: String): Any? = try {
            val env = Class.forName("java.awt.GraphicsEnvironment")
            val headless = env.getMethod("isHeadless").invoke(null) as Boolean
            val desktopClass = Class.forName("java.awt.Desktop")
            val supported = desktopClass.getMethod("isDesktopSupported").invoke(null) as Boolean
            if (headless || !supported) {
                null
            } else {
                val desktop = desktopClass.getMethod("getDesktop").invoke(null)
                val actionClass = Class.forName("java.awt.Desktop\$Action")
                val value = actionClass.getMethod("valueOf", String::class.java).invoke(null, action)
                desktop.takeIf { desktopClass.getMethod("isSupported", actionClass).invoke(it, value) as Boolean }
            }
        } catch (e: Throwable) {
            null
        }

        /** java.awt.Desktop.open, or false where there is no desktop. */
        @JvmStatic
        public fun desktopOpen(file: File): Boolean = try {
            desktop("OPEN")?.let { it.javaClass.getMethod("open", File::class.java).invoke(it, file); true } ?: false
        } catch (e: Exception) {
            false
        }

        /** java.awt.Desktop.browse, or false where there is no desktop. */
        @JvmStatic
        public fun desktopBrowse(url: String): Boolean = try {
            desktop("BROWSE")?.let { it.javaClass.getMethod("browse", URI::class.java).invoke(it, URI(url)); true } ?: false
        } catch (e: Exception) {
            false
        }
    }
}
