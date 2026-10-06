// Java interop (SP-K11, notes/SDK-PARITY-PASS.md §2.5 "Java callers"): every suspend call a Java
// app needs, as a CompletableFuture. The options data classes carry @JvmOverloads constructors, so
// Java builds them without naming every default:
//
//   PolarisKeyClient client = PolarisKeyFutures.create(options).get();
//   PolarisKeyFutures pk = new PolarisKeyFutures(client);
//   pk.start().get();
//   pk.sync().get();
//   if (pk.isEntitled("pro").get()) { … }
//
// The futures run on [scope] (Dispatchers.Default by default); cancelling a future cancels the call.
// Results and failures are the Kotlin API's: a refusal completes the future exceptionally with the
// same PolarisException (or UnsupportedException) a Kotlin caller would catch.

package im.plrs.key.sdk

import im.plrs.key.core.LicenseState
import im.plrs.key.core.SyncResult
import im.plrs.key.core.UpdateCheck
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseInfo
import im.plrs.key.core.FetchedFile
import im.plrs.key.core.RegisterResult
import im.plrs.key.release.ReleaseTarget
import im.plrs.key.update.InstallResult
import java.io.File
import java.util.concurrent.CompletableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.future.future
import kotlinx.serialization.json.JsonElement

/** [client]'s suspend API as CompletableFutures, for Java callers; see the file comment. */
public class PolarisKeyFutures @JvmOverloads constructor(
    public val client: PolarisKeyClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private fun <T> call(block: suspend () -> T): CompletableFuture<T> = scope.future { block() }

    // ── Lifecycle and sync ───────────────────────────────────────────────────────────────────

    /** `client.start()`: load the device id, token and cached documents. No network. */
    public fun start(): CompletableFuture<Unit> = call { client.start() }

    @JvmOverloads
    public fun sync(force: Boolean = false): CompletableFuture<SyncResult> = call { client.sync(force) }

    public fun report(): CompletableFuture<Boolean> = call { client.report() }

    // ── Licence ──────────────────────────────────────────────────────────────────────────────

    public fun status(): CompletableFuture<LicenseState> = call { client.status() }

    public fun isLicensed(): CompletableFuture<Boolean> = call { client.isLicensed() }

    /** False whenever the gate is not usable (S-19 G11). */
    public fun isEntitled(name: String): CompletableFuture<Boolean> = call { client.license.isEntitled(name) }

    public fun licenseInfo(): CompletableFuture<LicenseInfo?> = call { client.license.licenseInfo() }

    public fun activate(key: String): CompletableFuture<ActivationResult> = call { client.activate(key) }

    public fun enroll(): CompletableFuture<ActivationResult> = call { client.enroll() }

    public fun deactivate(): CompletableFuture<Unit> = call { client.deactivate() }

    // ── Config ───────────────────────────────────────────────────────────────────────────────

    public fun config(key: String, default: JsonElement): CompletableFuture<JsonElement> = call { client.config(key, default) }

    /** A persisted local override (`config.local`). */
    public fun setConfig(key: String, value: JsonElement): CompletableFuture<Unit> = call { client.config.set(key, value) }

    public fun clearConfig(key: String): CompletableFuture<Unit> = call { client.config.clear(key) }

    // ── Devices ──────────────────────────────────────────────────────────────────────────────

    public fun register(): CompletableFuture<RegisterResult> = call { client.register() }

    public fun listDevices(): CompletableFuture<List<DeviceInfo>> = call { client.listDevices() }

    // ── Updates and downloads ────────────────────────────────────────────────────────────────

    public fun decide(): CompletableFuture<UpdateCheck> = call { client.update.decide() }

    public fun install(check: UpdateCheck): CompletableFuture<InstallResult> = call { client.update.install(check) }

    /** `release.fetch`: the verified build download. */
    public fun fetch(target: ReleaseTarget, to: File): CompletableFuture<FetchedFile> = call { client.release.fetch(target, to) }

    // ── Channels, links, tags ────────────────────────────────────────────────────────────────

    public fun channelChoices(): CompletableFuture<ChannelChoices> = call { client.channelChoices() }

    public fun setChannel(channel: String?): CompletableFuture<Unit> = call { client.setChannel(channel) }

    public fun crashTags(): CompletableFuture<Map<String, String>> = call { client.crashTags() }

    public companion object {
        /** `PolarisKeyClient.create(options)` as a future. */
        @JvmStatic
        public fun create(options: PolarisKeyClientOptions): CompletableFuture<PolarisKeyClient> =
            CoroutineScope(Dispatchers.Default).future { PolarisKeyClient.create(options) }
    }
}
