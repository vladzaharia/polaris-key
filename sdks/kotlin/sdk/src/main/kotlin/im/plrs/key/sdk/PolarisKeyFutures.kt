// Java interop (SP-K11, notes/SDK-PARITY-PASS.md §2.5 "Java callers"): every suspend call a Java
// app needs, as a CompletableFuture. The options data classes carry @JvmOverloads constructors, so
// Java builds them without naming every default:
//
//   PolarisKeyClient client = PolarisKeyFutures.create(options).get();
//   PolarisKeyFutures pk = new PolarisKeyFutures(client);
//   pk.start().get();
//   pk.sync().get();
//   if (pk.hasEntitlement("pro").get()) { … }
//
// The futures run on [scope] (Dispatchers.Default by default); cancelling a future cancels the call.
// Results and failures are the Kotlin API's: a refusal completes the future exceptionally with the
// same PolarisException (or UnsupportedException) a Kotlin caller would catch.

package im.plrs.key.sdk

import im.plrs.key.core.FetchedFile
import im.plrs.key.core.LicenseState
import im.plrs.key.core.RegisterResult
import im.plrs.key.core.SyncResult
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.peer.nearby.ApproveAnswerInput
import im.plrs.key.core.peer.nearby.ChosenCode
import im.plrs.key.core.peer.nearby.FinishOutcome
import im.plrs.key.core.peer.nearby.NearbyApproval
import im.plrs.key.core.peer.nearby.NearbyApprovalHandler
import im.plrs.key.core.peer.nearby.NearbyApproverHandle
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyRequest
import im.plrs.key.core.peer.nearby.NearbyRequestOptions
import im.plrs.key.core.peer.nearby.PickOutcome
import im.plrs.key.core.sync.SyncStatus
import im.plrs.key.identity.AttachResult
import im.plrs.key.identity.AutoSignInOptions
import im.plrs.key.identity.AutoSignInResult
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.ConsentInput
import im.plrs.key.identity.ExchangeKind
import im.plrs.key.identity.ExchangeNonce
import im.plrs.key.identity.ExchangeNonceResult
import im.plrs.key.identity.ExchangeOutcome
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.identity.ReplaceView
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.SignInSession
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseInfo
import im.plrs.key.release.ReleaseTarget
import im.plrs.key.update.InstallResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.future.future
import kotlinx.serialization.json.JsonElement
import java.io.File
import java.util.concurrent.CompletableFuture

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
    public fun hasEntitlement(name: String): CompletableFuture<Boolean> = call { client.entitlements.has(name) }

    public fun licenseInfo(): CompletableFuture<LicenseInfo?> = call { client.license.licenseInfo() }

    public fun activateWithKey(key: String): CompletableFuture<ActivationResult> = call { client.license.activateWithKey(key) }

    public fun enroll(): CompletableFuture<ActivationResult> = call { client.enroll() }

    public fun deactivate(): CompletableFuture<Unit> = call { client.deactivate() }

    /** `identity.signIn.start(options)`: the device-code session to show and wait on. */
    @JvmOverloads
    public fun signInStart(options: SignInOptions = SignInOptions()): CompletableFuture<SignInSession> =
        call { client.identity.signIn.start(options) }

    /** `session.wait(once)`: poll until the sign-in settles; a refusal completes it exceptionally with `SignInError`. */
    @JvmOverloads
    public fun signInWait(session: SignInSession, once: Boolean = false): CompletableFuture<SignInOutcome> = call { session.wait(once) }

    /** Redirect channel: `session.complete(callbackUrl)`; a refusal completes it exceptionally with `SignInError`. */
    public fun signInComplete(session: SignInSession, callbackUrl: String): CompletableFuture<SignInOutcome> = call { session.complete(callbackUrl) }

    /** `identity.choice.licenses(grant)`: the licences the account can run this device on; a refusal is a `ChoiceResult.Refused`. */
    public fun choiceLicenses(grant: String): CompletableFuture<ChoiceResult<LicenseChoiceView>> = call { client.identity.choice.licenses(grant) }

    /** `identity.choice.devices(grant, licenseId)`: a full licence's seated devices, for Replace. */
    public fun choiceDevices(grant: String, licenseId: String): CompletableFuture<ChoiceResult<ReplaceView>> =
        call { client.identity.choice.devices(grant, licenseId) }

    /**
     * `identity.choice.complete(grant, choice, consent)`: finish the sign-in with the person's choice and, after an
     * exchange's `PendingConsent`, their consent.
     */
    @JvmOverloads
    public fun choiceComplete(
        grant: String,
        choice: LicenseChoice?,
        consent: ConsentInput? = null,
    ): CompletableFuture<ChoiceResult<ChoiceCompleted>> = call { client.identity.choice.complete(grant, choice, consent) }

    /** `identity.exchangeNonce(kind)`: a single-use nonce for the platform provider to sign into its token. */
    public fun exchangeNonce(kind: ExchangeKind): CompletableFuture<ExchangeNonceResult> = call { client.identity.exchangeNonce(kind) }

    /**
     * `identity.exchange(kind, subjectToken, nonce)`: the platform's ID token for a device token; a Worker refusal
     * fails the future with a PolarisException.
     */
    public fun exchange(kind: ExchangeKind, subjectToken: String, nonce: ExchangeNonce): CompletableFuture<ExchangeOutcome> =
        call { client.identity.exchange(kind, subjectToken, nonce) }

    /** `identity.autoSignIn(options)`: the automatic sign-in ladder; never fails except by cancellation. */
    @JvmOverloads
    public fun autoSignIn(options: AutoSignInOptions = AutoSignInOptions()): CompletableFuture<AutoSignInResult> =
        call { client.identity.autoSignIn(options) }

    /** `identity.choice.cancel(grant)`: give the grant up. */
    public fun choiceCancel(grant: String): CompletableFuture<ChoiceResult<Unit>> = call { client.identity.choice.cancel(grant) }

    /** `identity.attach(confirm)`: preview (false) or add the device's licence to the signed-in account (true). */
    public fun attach(confirm: Boolean): CompletableFuture<AttachResult> = call { client.identity.attach(confirm) }

    // ── Config ───────────────────────────────────────────────────────────────────────────────

    public fun getConfig(key: String, default: JsonElement): CompletableFuture<JsonElement> = call { client.config.get(key, default) }

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

    // ── Cloud Sync ───────────────────────────────────────────────────────────────────────────────

    /** `client.cloudSync.status()`: the machine's status (`local` before Cloud Sync has started). */
    public fun statusFuture(): CompletableFuture<SyncStatus> = call { client.cloudSync.status() }

    /** `client.cloudSync.flush()`: send what is waiting (bounded), then answer the status. */
    public fun flushFuture(): CompletableFuture<SyncStatus> = call { client.cloudSync.flush() }

    /** `client.cloudSync.newRecoveryCode()`: a new recovery code, shown once and kept nowhere. */
    public fun newRecoveryCodeFuture(): CompletableFuture<String> = call { client.cloudSync.newRecoveryCode() }

    // ── Cloud Connect ────────────────────────────────────────────────────────────────────────

    /** `cloudConnect.start(options)`. */
    @JvmOverloads
    public fun cloudConnectStart(options: CloudConnectOptions = CloudConnectOptions()): CompletableFuture<Unit> =
        call { client.cloudConnect.start(options) }

    /** `cloudConnect.stop()`: bounded; a timeout completes the future exceptionally with `LanException(closed)`. */
    public fun cloudConnectStop(): CompletableFuture<Unit> = call { client.cloudConnect.stop() }

    /** `cloudConnect.open(deviceId, relay, lanAttemptSeconds)`. */
    @JvmOverloads
    public fun cloudConnectOpen(deviceId: String, relay: Boolean = true, lanAttemptSeconds: Double? = null): CompletableFuture<ConnectSession> =
        call { client.cloudConnect.open(deviceId, relay, lanAttemptSeconds) }

    /** `cloudConnect.devices()`. */
    public fun cloudConnectDevices(): CompletableFuture<List<ConnectDevice>> = call { client.cloudConnect.devices() }

    /** `cloudConnect.refreshPeers()`. */
    public fun cloudConnectRefreshPeers(): CompletableFuture<List<CloudPeer>> = call { client.cloudConnect.refreshPeers() }

    // ── Cloud Connect: inter-account links ───────────────────────────────────────────────────

    /** `cloudConnect.links.pair(options)`: the pairing window (completes exceptionally with `LinksDisabledException` while links are off). */
    public fun cloudLinksPair(options: LinkPairOptions): CompletableFuture<LinkPairHandle> = call { client.cloudConnect.links.pair(options) }

    /** `cloudConnect.links.list()`. */
    public fun cloudLinksList(): CompletableFuture<List<ContactInfo>> = call { client.cloudConnect.links.list() }

    /** `cloudConnect.links.remove(id)`: false when [id] names no link. */
    public fun cloudLinksRemove(id: String): CompletableFuture<Boolean> = call { client.cloudConnect.links.remove(id) }

    /** `cloudConnect.links.setReachable(id, reachable)`: false when [id] names no link. */
    public fun cloudLinksSetReachable(id: String, reachable: Boolean): CompletableFuture<Boolean> =
        call { client.cloudConnect.links.setReachable(id, reachable) }

    /** `cloudConnect.links.open(id, relay, lanAttemptSeconds)`. */
    @JvmOverloads
    public fun cloudLinksOpen(id: String, relay: Boolean = true, lanAttemptSeconds: Double? = null): CompletableFuture<ConnectSession> =
        call { client.cloudConnect.links.open(id, relay, lanAttemptSeconds) }

    /** `cloudConnect.links.interAccount()`. */
    public fun cloudLinksInterAccount(): CompletableFuture<Boolean> = call { client.cloudConnect.links.interAccount() }

    // ── Nearby approval (CC-15) ──────────────────────────────────────────────────────────────

    /**
     * `cloudConnect.nearby.request(options)`: D browses for approvers. The typed N/A (`nearby-unsupported`,
     * `service-unavailable`) completes the future exceptionally with a PolarisException.
     */
    public fun nearbyRequest(options: NearbyRequestOptions): CompletableFuture<NearbyRequest> = call { client.cloudConnect.nearby.request(options) }

    /** `request.choose(id)`: the person tapped this approver; answers D's code to show. */
    public fun nearbyChoose(request: NearbyRequest, id: String): CompletableFuture<ChosenCode> = call { request.choose(id) }

    /** `request.confirmAccount()`: the person confirmed the signed-in account; held records are handed over. */
    public fun nearbyConfirmAccount(request: NearbyRequest): CompletableFuture<Unit> = call { request.confirmAccount() }

    /** `request.declineAccount()`: the person declined; every held record is dropped. */
    public fun nearbyDeclineAccount(request: NearbyRequest): CompletableFuture<Unit> = call { request.declineAccount() }

    /** `request.close()`: end the request. */
    public fun nearbyClose(request: NearbyRequest): CompletableFuture<Unit> = call { request.close() }

    /** `cloudConnect.nearby.onRequest(handler, options)`: M advertises and hands each session to [handler]. */
    public fun nearbyOnRequest(handler: NearbyApprovalHandler, options: NearbyApproverOptions): CompletableFuture<NearbyApproverHandle> =
        call { client.cloudConnect.nearby.onRequest(handler, options) }

    /** `approver.stop()`, `.pause()`, `.resume()`, `.setPrompt(open)` and `.reopen()`. */
    public fun nearbyStop(approver: NearbyApproverHandle): CompletableFuture<Unit> = call { approver.stop() }

    public fun nearbyPause(approver: NearbyApproverHandle): CompletableFuture<Unit> = call { approver.pause() }

    public fun nearbyResume(approver: NearbyApproverHandle): CompletableFuture<Unit> = call { approver.resume() }

    public fun nearbySetPrompt(approver: NearbyApproverHandle, open: Boolean): CompletableFuture<Unit> = call { approver.setPrompt(open) }

    public fun nearbyReopen(approver: NearbyApproverHandle): CompletableFuture<Unit> = call { approver.reopen() }

    /** `approval.pick(code)`: the person picked a code. */
    public fun nearbyPick(approval: NearbyApproval, code: String): CompletableFuture<PickOutcome> = call { approval.pick(code) }

    /** `approval.decline()`: "None of these match". */
    public fun nearbyDecline(approval: NearbyApproval): CompletableFuture<Unit> = call { approval.decline() }

    /** `approval.finish(answer)`: give the answer of `nearby/approve` back. */
    public fun nearbyFinish(approval: NearbyApproval, answer: ApproveAnswerInput): CompletableFuture<FinishOutcome> = call { approval.finish(answer) }

    /** `approval.sendRecord(type, body)`: a Sync record (`0x0030` to `0x003F`) to D, after `approved`. */
    public fun nearbySendRecord(approval: NearbyApproval, type: Int, body: ByteArray): CompletableFuture<Unit> =
        call { approval.sendRecord(type, body) }

    /** `approval.close()`: the host leaves; the session closes `peer_bye`. */
    public fun nearbyCloseApproval(approval: NearbyApproval): CompletableFuture<Unit> = call { approval.close() }

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
