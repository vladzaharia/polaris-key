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
// SP-41: state belongs to ONE control plane. The directory above is production's (`https://key.plrs.im`);
// any other `baseUrl` (a local `pkey dev` Worker, a staging Worker) keeps its token, device id, cache,
// installers, update slots and guard state in `<product>@<host>[_<port>]` instead (`storeNamespace`), and
// its keyring entry under the service `pkey:<product>@<host>`, so a local run never reads, overwrites or
// applies production's. DesktopOptions.dataDirectory follows the same rule: it stays production's
// directory exactly as before, and every other control plane nests `<dataDirectory>/<product>@<host>`
// beneath it. `client` reads the control plane from its options; `dataDirectory`, `store`, `slots` and
// `bootGuard` run before a client exists, so they take the same `baseUrl` (null: production).
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
import im.plrs.key.core.storeNamespace
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
    /**
     * Where the store, installers and update slots live for the production control plane
     * (`https://key.plrs.im`); default FileStore.defaultDirectory(product). A client whose `baseUrl`
     * is anything else keeps its state in `<dataDirectory>/<product>@<host>` beneath it
     * ([storeNamespace]), never in this directory itself.
     */
    val dataDirectory: File? = null,
    /** The OS keyring binding; default java-keyring. */
    val keyring: KeyringBackend = JavaKeyringBackend(),
    /** What opens a verified installer; default the OS launcher. */
    val opener: InstallerOpener = SystemInstallerOpener(),
    /** Installer download progress: (received, total) bytes. */
    val downloadProgress: ((Long, Long) -> Unit)? = null,
)

/**
 * The JVM desktop entry point. Everything it keeps on disk belongs to one control plane: [client]
 * reads that control plane from its options, and the helpers that run before a client exists take its
 * `baseUrl` (what `CoreOptions.baseUrl` says; null is production, the default).
 */
public object PolarisKeyDesktop {
    /**
     * The data directory for [productSlug] against the control plane at [baseUrl] under [desktop]:
     * [DesktopOptions.dataDirectory] itself for production and `<dataDirectory>/<storeNamespace>` for
     * any other control plane; without a [DesktopOptions.dataDirectory], FileStore.defaultDirectory of
     * the [storeNamespace].
     */
    public fun dataDirectory(productSlug: String, desktop: DesktopOptions = DesktopOptions(), baseUrl: String? = null): File {
        val namespace = namespace(productSlug, baseUrl)
        val explicit = desktop.dataDirectory ?: return FileStore.defaultDirectory(namespace)
        return if (namespace == productSlug) explicit else File(explicit, namespace)
    }

    /** The keyring store [client] uses when the host sets none; its service tag is `pkey:<storeNamespace>`. */
    public fun store(productSlug: String, desktop: DesktopOptions = DesktopOptions(), baseUrl: String? = null): KeyringStore =
        KeyringStore(namespace(productSlug, baseUrl), dataDirectory(productSlug, desktop, baseUrl), desktop.keyring)

    /** The default update slots: `<data>/updates/slots/{staged,current,previous}`, under [dataDirectory] for the control plane at [baseUrl]. */
    public fun slots(productSlug: String, desktop: DesktopOptions = DesktopOptions(), baseUrl: String? = null): DirUpdateSlots =
        DirUpdateSlots(File(dataDirectory(productSlug, desktop, baseUrl), "updates/slots"))

    /**
     * The GUARD stage over [slots], its state in `<data>/updates/state.json`. Both belong to the control
     * plane at [baseUrl], so a payload staged for a local control plane is never applied by production's
     * launch. Run it before anything else loads.
     */
    public fun bootGuard(
        productSlug: String,
        runningVersion: String,
        desktop: DesktopOptions = DesktopOptions(),
        engine: String? = null,
        baseUrl: String? = null,
    ): BootGuard =
        BootGuard(FileBootGuardStore(File(dataDirectory(productSlug, desktop, baseUrl), "updates/state.json")), slots(productSlug, desktop, baseUrl), runningVersion, engine)

    /** [options] with every desktop edge the host left unset filled in; see the file comment. */
    public fun client(options: PolarisKeyClientOptions, desktop: DesktopOptions = DesktopOptions()): PolarisKeyClient {
        val product = options.core.productSlug
        val baseUrl = options.core.baseUrl
        val dir = dataDirectory(product, desktop, baseUrl)
        val self = AtomicReference<PolarisKeyClient>()
        fun client(): PolarisKeyClient = self.get() ?: error("the client is still being constructed")

        val core = options.core.copy(store = options.core.store ?: store(product, desktop, baseUrl))
        val update = options.update?.let { u ->
            if (u.installDriver !== JvmInstallDriver) return@let u
            u.copy(
                installDriver = DesktopInstallDriver(
                    records = { sha -> client().update.releaseRecord(sha).record },
                    buildUrl = { version, build -> client().update.buildUrl(version, build) },
                    fetch = { url, part, size, progress -> OkHttpArtifactFetch(client().core).fetch(url, part, size, progress) },
                    dir = File(dir, "updates/installer"),
                    opener = desktop.opener,
                    onBytes = desktop.downloadProgress,
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

    /** The name [productSlug]'s state is kept under against [baseUrl]: the bare slug for production (null), else [storeNamespace]. */
    private fun namespace(productSlug: String, baseUrl: String?): String =
        if (baseUrl == null) productSlug else storeNamespace(productSlug, baseUrl)
}
