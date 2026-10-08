// The JVM desktop entry point (UK-40, SP-K12): what PolarisKeyAndroid is to Android, for a JVM
// desktop app (Compose Desktop, Swing, a CLI). It fills in every desktop edge the host left unset:
//
//   core.store      KeyringStore: the token in the OS keyring (Keychain, Credential Manager, Secret
//                   Service) through java-keyring, the device id and cache in 0600 files under the
//                   data directory. Without java-keyring at runtime, or with no reachable keyring,
//                   the token stays in the 0600 file, storeStatus() says `keyring-unavailable` and
//                   supports(core.store) answers the registry's jvm `dependency` N/A.
//   update.driver   DesktopInstallDriver (unless UpdateClientOptions.installDriver is set): the
//                   installer for this OS and arch, fetched resumably, verified against the signed
//                   release record, then opened by the OS.
//   update.bootguard  slots(): the default UpdateSlots (DirUpdateSlots) and bootGuard(): the GUARD
//                   stage over them, its state in `<data>/updates/state.json`.
//
// The data directory defaults to FileStore.defaultDirectory(product): `~/Library/Application
// Support/polaris-key/<product>`, `%LOCALAPPDATA%\polaris-key\<product>` or
// `$XDG_STATE_HOME/polaris-key/<product>`, the same place a FileStore build kept its token, so an
// earlier build's token moves into the keyring on the first read.
//
// SP-50: this is the desktop artifact, im.plrs.key:polaris-key-desktop. It brings java-keyring (and
// JNA) at runtime, so the one dependency line gives a desktop app the OS keyring; :core declares
// java-keyring compileOnly so Android builds never carry JNA. Where the keyring still cannot take the
// token, the store keeps it in the 0600 file and warns once per run (DegradedStoreWarning).
//
//     implementation("im.plrs.key:polaris-key-desktop:<version>")

package im.plrs.key.desktop

import im.plrs.key.core.FileStore
import im.plrs.key.core.JavaKeyringBackend
import im.plrs.key.core.KeyringBackend
import im.plrs.key.core.KeyringStore
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.update.BootGuard
import im.plrs.key.update.DesktopInstallDriver
import im.plrs.key.update.DirUpdateSlots
import im.plrs.key.update.FileBootGuardStore
import im.plrs.key.update.InstallerOpener
import im.plrs.key.update.JvmInstallDriver
import im.plrs.key.update.OkHttpArtifactFetch
import im.plrs.key.update.SystemInstallerOpener
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** The desktop-only inputs to [PolarisKeyDesktop.client]. */
public data class DesktopOptions(
    /** Where the store, installers and update slots live; default FileStore.defaultDirectory(product). */
    val dataDirectory: File? = null,
    /** The OS keyring binding; default java-keyring. */
    val keyring: KeyringBackend = JavaKeyringBackend(),
    /** What opens a verified installer; default the OS launcher. */
    val opener: InstallerOpener = SystemInstallerOpener(),
    /** Installer download progress: (received, total) bytes. */
    val downloadProgress: ((Long, Long) -> Unit)? = null,
)

/** The JVM desktop entry point. */
public object PolarisKeyDesktop {
    /** The data directory for [productSlug] under [desktop]. */
    public fun dataDirectory(productSlug: String, desktop: DesktopOptions = DesktopOptions()): File =
        desktop.dataDirectory ?: FileStore.defaultDirectory(productSlug)

    /** The keyring store [client] uses when the host sets none. */
    public fun store(productSlug: String, desktop: DesktopOptions = DesktopOptions()): KeyringStore =
        KeyringStore(productSlug, dataDirectory(productSlug, desktop), desktop.keyring)

    /** The default update slots: `<data>/updates/slots/{staged,current,previous}`. */
    public fun slots(productSlug: String, desktop: DesktopOptions = DesktopOptions()): DirUpdateSlots =
        DirUpdateSlots(File(dataDirectory(productSlug, desktop), "updates/slots"))

    /** The GUARD stage over [slots], its state in `<data>/updates/state.json`. Run it before anything else loads. */
    public fun bootGuard(productSlug: String, runningVersion: String, desktop: DesktopOptions = DesktopOptions(), engine: String? = null): BootGuard =
        BootGuard(FileBootGuardStore(File(dataDirectory(productSlug, desktop), "updates/state.json")), slots(productSlug, desktop), runningVersion, engine)

    /** [options] with every desktop edge the host left unset filled in; see the file comment. */
    public fun client(options: PolarisKeyClientOptions, desktop: DesktopOptions = DesktopOptions()): PolarisKeyClient {
        val product = options.core.productSlug
        val dir = dataDirectory(product, desktop)
        val self = AtomicReference<PolarisKeyClient>()
        fun client(): PolarisKeyClient = self.get() ?: error("the client is still being constructed")

        val core = options.core.copy(store = options.core.store ?: store(product, desktop))
        val update = options.update?.let { u ->
            if (u.installDriver !== JvmInstallDriver) return@let u
            u.copy(
                installDriver = DesktopInstallDriver(
                    records = { sha -> client().update.releaseRecord(sha).record },
                    buildUrl = { version, build -> client().update.buildUrl(version, build) },
                    fetch = { url, part, size, progress -> OkHttpArtifactFetch(client().core).fetch(url, part, size, progress) },
                    dir = File(dir, "updates/installer"),
                    opener = desktop.opener,
                    progress = desktop.downloadProgress,
                ),
            )
        }
        return PolarisKeyClient(options.copy(core = core, update = update)).also {
            self.set(it)
            // Usable at once: it starts itself; this warms the start (SP-50).
            it.startInBackground()
        }
    }

    /** [client], then `start()` (token, device id and cache, NO network). */
    public suspend fun create(options: PolarisKeyClientOptions, desktop: DesktopOptions = DesktopOptions()): PolarisKeyClient =
        client(options, desktop).also { it.start() }
}
