// The approving device's side of nearby sign-in (I-45.13; WIRE-CONTRACT-V5 section 12.11.5, 13.11.3, 15.6.1). M is a device
// that is signed in. `identity.nearby.onRequest(handler, options)` advertises only while the host's prompt is open (or
// while the person allowed background approval); the SDK never advertises on its own. Each session that reaches the code
// stage becomes a [NearbyAsk] handed to the handler: show it, and call [NearbyAsk.pick] with the code the new device
// shows. Mirrors sdk-node's `identity/nearbyApprover.ts` and Python's `nearby_approver.py`.
//
// Rules this file keeps:
//  - NO SILENT APPROVAL: `nearby/approve` is reachable only through [NearbyAsk.pick] with the code that matched on that
//    session and whose `VOUCH_REQ` verified. The permit ([NearbyVouch]) is made from that one result and nothing else;
//    D's device id, handle and keys go to the Worker from the permit, never from anything the host passes;
//  - a wrong code is [NearbyApprovalStep.Mismatch] and calls no route; "None of these match" before a matched pick closes
//    the session and sends nothing; a deny is sent only after a matched code;
//  - leaving the licence choice answers a deny ([NearbyApprovalStep.Choose.cancel]);
//  - a `404` is read through a fresh discovery (N11) by the vouch's finish step, not from the status;
//  - after `approved` the approver seals its key ring root to the verified request's agreement key, sends the wrap over
//    the channel as `KEYRING_WRAP` and only then stores the same bytes (`PUT`): a refused store cannot take the channel
//    copy with it, and a lost channel leaves the stored copy. Once, and skipped without a root held here;
//  - nothing here prints or keeps the handle, the proofs, the keys, the code or the token in a `toString`.

@file:Suppress(
    "TooGenericExceptionCaught",
    "SwallowedException",
    "ReturnCount",
    "CyclomaticComplexMethod",
    "TooManyFunctions",
    "ThrowsCount",
    "LongParameterList",
    "MemberNameEqualsClassName",
)

package im.plrs.key.identity

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.VouchRequest
import im.plrs.key.core.peer.nearby.ApproveAnswerInput
import im.plrs.key.core.peer.nearby.FinishOutcome
import im.plrs.key.core.peer.nearby.NearbyApproval
import im.plrs.key.core.peer.nearby.NearbyApprovalHandler
import im.plrs.key.core.peer.nearby.NearbyApproverHandle
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyException
import im.plrs.key.core.peer.nearby.PickOutcome
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** M's credentials for one `nearby/approve`: its device id, its bearer and the key port that signs the proof. */
internal class NearbyCreds(val deviceId: String, val token: String?, val port: DeviceKeyPort) {
    override fun toString(): String = "NearbyCreds"
}

/**
 * The permit: D's verified `VOUCH_REQ` for a session whose person picked the matching code (rule 10). `nearby/approve`
 * takes nothing else. It has no public constructor; only [NearbyAsk.pick] makes one, right after a code matched.
 */
public class NearbyVouch private constructor(
    internal val request: String,
    internal val deviceId: String,
    internal val signKey: String,
    internal val agreeKey: String,
) {
    override fun toString(): String = "NearbyVouch"

    internal companion object {
        fun of(v: VouchRequest): NearbyVouch = NearbyVouch(v.request, v.deviceId, v.signKey, v.agreeKey)

        /** Conformance replay only: vouches for what a recording sent (it may carry other keys than D's). */
        fun replay(request: String, deviceId: String, signKey: String, agreeKey: String): NearbyVouch =
            NearbyVouch(request, deviceId, signKey, agreeKey)
    }
}

/** `nearby/approve`'s answer as the finish step of the vouch reads it: [http] is the status, [body] the text it reads. */
internal class NearbyApproveAnswer(val http: Int?, val body: String?, val keysRetried: Boolean) {
    override fun toString(): String = "NearbyApproveAnswer(http=$http)"
}

/** One `nearby/approve` answer. A denial and a refusal are outcomes, not errors. */
internal sealed interface NearbyApprove {
    /** D is bound; [deviceLabel] is the label the Worker stored. */
    class Approved(val deviceLabel: String?, val answer: NearbyApproveAnswer) : NearbyApprove

    /** A licence choice is due; nothing was written. */
    class Choose(val choices: LicenseChoiceView, val answer: NearbyApproveAnswer) : NearbyApprove

    class Denied(val answer: NearbyApproveAnswer) : NearbyApprove

    /** The Worker said no: [code] is its wire code (`not_nearby`, `device_limit`, `account_required`, `invalid_grant`, ...). */
    class Refused(val code: String?, val status: Int, val retryAfterSeconds: Int?, val answer: NearbyApproveAnswer) : NearbyApprove

    /** Discovery names no `nearby` / `nearbyApprove` here (nothing was sent). */
    data object Unavailable : NearbyApprove
}

/** Where an approval stands: one of the `NearbyApproval` states of the UI matrix, one to one. */
public sealed interface NearbyApprovalStep {
    /** D is bound. [wrapSent]: this device's key ring wrap went to the new device (over the channel, or as the server's copy; either reaches it). */
    public data class Approved(val deviceLabel: String?, val wrapSent: Boolean) : NearbyApprovalStep

    /** The code was not the one D shows: the session closed and no route was called. */
    public data object Mismatch : NearbyApprovalStep

    /** The Worker found the two devices not nearby each other. */
    public data object NotNearby : NearbyApprovalStep

    public data object Denied : NearbyApprovalStep

    /** The request lapsed, or the session ended under the person. */
    public data object Expired : NearbyApprovalStep

    public data object DeviceLimit : NearbyApprovalStep

    public data object AccountRequired : NearbyApprovalStep

    public data class RateLimited(val retryAfterSeconds: Int?) : NearbyApprovalStep

    /** A licence is to be chosen on this device. [choose] and [cancel] (a deny) finish the same approval. */
    public class Choose internal constructor(
        public val choices: LicenseChoiceView,
        private val onChoose: suspend (LicenseChoice) -> NearbyApprovalStep,
        private val onCancel: suspend () -> NearbyApprovalStep,
    ) : NearbyApprovalStep {
        /** Approve with [choice]: a [LicenseChoice.License] from [choices], or [LicenseChoice.Create]. */
        public suspend fun choose(choice: LicenseChoice): NearbyApprovalStep = onChoose(choice)

        /** The person leaves the choice: a deny (the code matched). */
        public suspend fun cancel(): NearbyApprovalStep = onCancel()

        override fun toString(): String = "Choose(${choices.licenseIds.size} licences)"
    }
}

/** Called with each session that reaches the code stage while the prompt is open. A fun interface, so Java passes a lambda too. */
public fun interface NearbyAskHandler {
    public fun onAsk(ask: NearbyAsk)
}

/** A licence choice is asked again (a lost mint) at most this often in one pick. */
private const val MAX_ASKS = 3
private const val KEYRING_WRAP_RECORD = 0x0030

/**
 * One session asking for approval (see the file comment). Made by the SDK for the handler, never by a host. [device] is what
 * D's `HELLO` reported (cleaned): "reported by the device", never proof of who is asking.
 */
public class NearbyAsk internal constructor(
    private val approval: NearbyApproval,
    private val routes: NearbyRoutes,
    private val creds: suspend () -> NearbyCreds,
    private val sealer: NearbyWrapSealer?,
) {
    private val lock = Mutex()
    private var vouch: NearbyVouch? = null
    private var done = false
    private var asks = 0
    private var wrapped = false

    public val device: String? = approval.label
    public val platform: String = approval.platform

    /** The three codes, in the order to show them, each like `123 456`. */
    public val codes: List<String> = approval.codes.toList()

    override fun toString(): String = "NearbyAsk"

    private fun answered() = PolarisException(ErrorCode.invalidOptions, "This request has been answered.")

    /**
     * The person picked [code]. A wrong one closes the session and answers [NearbyApprovalStep.Mismatch] (no route is
     * called); the right one approves, and the step says how it went.
     */
    public suspend fun pick(code: String): NearbyApprovalStep = lock.withLock {
        if (done || vouch != null) throw answered()
        val picked = try {
            approval.pick(code)
        } catch (e: CancellationException) {
            throw e
        } catch (e: NearbyException) {
            // The session ended under the person (D left, the deadline passed).
            done = true
            return@withLock NearbyApprovalStep.Expired
        }
        when (picked) {
            PickOutcome.Mismatch -> {
                done = true
                NearbyApprovalStep.Mismatch
            }

            // D's request did not verify and the session closed: nothing is sent.
            PickOutcome.Invalid -> {
                done = true
                NearbyApprovalStep.Expired
            }

            is PickOutcome.Verified -> {
                // The code matched and D's request verified: the one place a permit is made.
                vouch = NearbyVouch.of(picked.request)
                send("approve", null)
            }
        }
    }

    /** Before a matched pick: "None of these match" (the session closes, no route is called). After one: sends `deny`. */
    public suspend fun deny(): NearbyApprovalStep = lock.withLock {
        if (done) throw answered()
        if (vouch == null) {
            done = true
            try {
                approval.decline()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The session is gone already.
            }
            return@withLock NearbyApprovalStep.Denied
        }
        send("deny", null)
    }

    private suspend fun choose(choice: LicenseChoice): NearbyApprovalStep = lock.withLock {
        if (done || vouch == null) throw answered()
        if (choice !is LicenseChoice.License && choice !is LicenseChoice.Create) {
            throw PolarisException(ErrorCode.invalidOptions, "nearby: a choice is a licence or a new one.")
        }
        send("approve", choice)
    }

    private suspend fun cancelChoice(): NearbyApprovalStep = lock.withLock {
        if (done || vouch == null) throw answered()
        send("deny", null)
    }

    // ── The Worker's answer, through the vouch's finish step ────────────────────────────────

    private suspend fun send(decision: String, choice: LicenseChoice?): NearbyApprovalStep {
        val v = vouch ?: throw answered()
        asks++
        val r = try {
            routes.approve(creds(), v, decision, choice?.toJson())
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            when (e.code) {
                // No answer: the session closes and the request lapses on the Worker.
                ErrorCode.networkError, ErrorCode.serverError -> return end(NearbyApprovalStep.Expired)

                ErrorCode.noToken -> return end(NearbyApprovalStep.AccountRequired)
            }
            end(NearbyApprovalStep.Expired)
            throw e
        }
        return finish(r, decision)
    }

    private suspend fun finish(r: NearbyApprove, decision: String): NearbyApprovalStep {
        val answer = when (r) {
            NearbyApprove.Unavailable -> return end(NearbyApprovalStep.Expired)
            is NearbyApprove.Approved -> r.answer
            is NearbyApprove.Choose -> r.answer
            is NearbyApprove.Denied -> r.answer
            is NearbyApprove.Refused -> r.answer
        }
        val input = routes.answerFor(answer)
        val out: FinishOutcome? = try {
            if (answer.keysRetried) {
                // The route client already registered M's keys and asked once more: tell the machine, so a second
                // `device_keys_required` closes instead of waiting.
                approval.finish(ApproveAnswerInput(HTTP_CONFLICT, """{"code":"${ErrorCode.deviceKeysRequired}"}""", true))
            }
            approval.finish(input)
        } catch (e: CancellationException) {
            throw e
        } catch (e: NearbyException) {
            // The LAN session ended under us (D left). The Worker's answer still stands.
            null
        }
        if (out is FinishOutcome.Wait && out.what == "choice") {
            if (r is NearbyApprove.Choose) {
                return NearbyApprovalStep.Choose(r.choices, ::choose, ::cancelChoice)
            }
            // A lost mint (409 `license_choice_required`): the machine still waits for a choice, so ask again with no
            // choice to show the licences afresh (at most MAX_ASKS times).
            if (decision == "approve" && asks < MAX_ASKS) return send("approve", null)
            return end(NearbyApprovalStep.Expired)
        }
        if (r is NearbyApprove.Choose) {
            done = true
            return NearbyApprovalStep.Expired
        }
        done = true
        return when (r) {
            // The Worker bound D whatever the LAN says: VOUCH_RESULT is D's display, the poll its authority.
            is NearbyApprove.Approved -> NearbyApprovalStep.Approved(r.deviceLabel, sendWrap())

            is NearbyApprove.Denied -> NearbyApprovalStep.Denied

            is NearbyApprove.Refused -> refused(r)

            else -> NearbyApprovalStep.Expired
        }
    }

    private fun refused(r: NearbyApprove.Refused): NearbyApprovalStep = when {
        r.code == ErrorCode.notNearby -> NearbyApprovalStep.NotNearby
        r.code == ErrorCode.deviceLimit -> NearbyApprovalStep.DeviceLimit
        r.code == ErrorCode.accountRequired -> NearbyApprovalStep.AccountRequired
        r.status == HTTP_TOO_MANY || r.code == ErrorCode.rateLimited -> NearbyApprovalStep.RateLimited(r.retryAfterSeconds)
        else -> NearbyApprovalStep.Expired
    }

    /**
     * After `approved`, once (V5 section 13.11.3): seal the root for the verified request's agreement key (and only that
     * one), send the wrap over the channel (`KEYRING_WRAP`), and only then store the same wrap as the server's copy. Skipped
     * without a root held here (the new device opens a ring with its recovery code; this device never opens one on its own).
     */
    private suspend fun sendWrap(): Boolean {
        val v = vouch
        val s = sealer
        if (wrapped || s == null || v == null) return false
        val sealed = try {
            s.seal(v.deviceId, v.agreeKey)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return false
        wrapped = true
        var sent = false
        try {
            approval.sendRecord(KEYRING_WRAP_RECORD, sealed.record)
            sent = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The LAN session ended: the server's copy stands.
        } finally {
            sealed.record.fill(0)
        }
        return try {
            sealed.store()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            sent // a conflict or the network: the channel copy, if it arrived, still stands
        }
    }

    private suspend fun end(step: NearbyApprovalStep): NearbyApprovalStep {
        done = true
        try {
            approval.close()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Already closed.
        }
        return step
    }

    private companion object {
        const val HTTP_CONFLICT = 409
        const val HTTP_TOO_MANY = 429
    }
}

/** `identity.nearby.onRequest`: advertise and hand each session that reaches the code to [handler] as a [NearbyAsk]. */
internal suspend fun IdentityClient.startNearbyApprover(handler: NearbyAskHandler, options: NearbyApproverOptions): NearbyApproverHandle {
    val host = nearbyHost.get()
    val start = host?.approver ?: throw PolarisException(ErrorCode.nearbyUnsupported, "Nearby approval is not set up on this client.")
    val creds: suspend () -> NearbyCreds = {
        val signer = host.signer()
        NearbyCreds(signer.deviceId, core.token(), signer.port)
    }
    return start(
        NearbyApprovalHandler { approval -> handler.onAsk(NearbyAsk(approval, nearbyRoutes, creds, host.sealer)) },
        options,
    )
}

/** Conformance replay only: one `nearby/approve` as the approving device M, answered as the transcripts' `result` vocabulary. */
@ConformanceReplayOnly
public suspend fun IdentityClient.replayNearbyApprove(
    approverDeviceId: String,
    approverToken: String,
    approverKeys: DeviceKeyPort,
    request: String,
    deviceId: String,
    signKey: String,
    agreeKey: String,
    decision: String,
    choice: kotlinx.serialization.json.JsonObject?,
): NearbyReplayApprove {
    val vouch = NearbyVouch.replay(request, deviceId, signKey, agreeKey)
    val creds = NearbyCreds(approverDeviceId, approverToken, approverKeys)
    return when (val r = nearbyRoutes.approve(creds, vouch, decision, choice)) {
        is NearbyApprove.Approved -> NearbyReplayApprove("approved", deviceLabel = r.deviceLabel)
        is NearbyApprove.Choose -> NearbyReplayApprove("choose", choices = r.choices.raw)
        is NearbyApprove.Denied -> NearbyReplayApprove("denied")
        is NearbyApprove.Refused -> NearbyReplayApprove("refused", status = r.status, code = r.code)
        NearbyApprove.Unavailable -> NearbyReplayApprove("unavailable")
    }
}

public class NearbyReplayApprove(
    public val result: String,
    public val deviceLabel: String? = null,
    public val choices: kotlinx.serialization.json.JsonObject? = null,
    public val status: Int? = null,
    public val code: String? = null,
)
