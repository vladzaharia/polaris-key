// @pkey-feature identity.redirect.native
//
// The native redirect sign-in against the redirect-native-* and locker-redirect-native recordings (I-15b.5). The SDK
// pushes the request itself and the recording pins every byte it sends; the browser's half is the recording's. A
// loopback listener is the replay's own (the recorded port, no socket); a scheme delivery goes through
// `signIn.handleRedirect`.

package im.plrs.key.conformance

import im.plrs.key.core.stringValue
import im.plrs.key.identity.ConformanceReplayOnly
import im.plrs.key.identity.NativeListenerReply
import im.plrs.key.identity.NativeLoopbackListener
import im.plrs.key.identity.NativeRedirect
import im.plrs.key.identity.NativeRedirectClass
import im.plrs.key.identity.NativeRedirectOptions
import im.plrs.key.identity.RedirectEntropy
import im.plrs.key.identity.ReplayPending
import im.plrs.key.identity.SignInChannel
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.SignInPurpose
import im.plrs.key.identity.SignInSession
import im.plrs.key.identity.nativeListenerFactory
import im.plrs.key.identity.redirectEntropy
import im.plrs.key.identity.replayNativeCallback
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.serialization.json.JsonObject

/**
 * The loopback listener of a recorded conversation: the recorded port, no socket. The redirect is handed to the
 * session's own callback handler, as the listener would.
 */
class ReplayListener(override val port: Int) : NativeLoopbackListener {
    private var accept: ((String) -> NativeListenerReply)? = null

    @Volatile
    private var shut = false

    override fun start(accept: (String) -> NativeListenerReply) {
        this.accept = accept
    }

    override fun close() {
        shut = true
    }

    override val closed: Boolean get() = shut

    fun deliver(url: String): NativeListenerReply? = accept?.invoke(url)
}

@OptIn(ConformanceReplayOnly::class)
object NativeReplay {
    private const val RECORDED_STATE = "tidewater-state-0123456789"
    private const val RECORDED_VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private val PORT = Regex(":(\\d+)/")

    private fun queryValue(url: String, name: String): String? =
        url.substringAfter('?', "").split('&').firstOrNull { it.startsWith("$name=") }?.removePrefix("$name=")

    /** The options that make the SDK choose the recorded redirect URI's class; a loopback gets the replay's listener. */
    private fun optionsFor(client: PolarisKeyClient, redirectUri: String, returnUri: String?, session: ReplaySession): NativeRedirectOptions {
        val base = NativeRedirectOptions(returnUri = returnUri, openBrowser = false, loopback = false)
        return when (NativeRedirect.classify(redirectUri)) {
            NativeRedirectClass.Loopback -> {
                val port = PORT.find(redirectUri)?.groupValues?.get(1)?.toInt() ?: 0
                client.identity.nativeListenerFactory = { ReplayListener(port).also { session.nativeListener = it } }
                base.copy(loopback = true)
            }

            NativeRedirectClass.Scheme -> base.copy(registeredSchemes = listOf(redirectUri))

            NativeRedirectClass.Claimed -> base.copy(registeredClaimed = listOf(redirectUri))

            null -> throw AssertionError("the recorded push names no native redirect URI: $redirectUri")
        }
    }

    /**
     * A native sign-in as the host would start it: the SDK pushes the request itself, the label and options being the
     * recorded push's, and the recording pins every byte it sends.
     */
    suspend fun start(client: PolarisKeyClient, step: JsonObject, session: ReplaySession): SignInSession {
        val body = pushedForm(step)
        val args = step["args"] as JsonObject
        val redirectUri = body["redirect_uri"] ?: args["redirectUri"].stringValue.orEmpty()
        client.identity.redirectEntropy = RedirectEntropy(body["state"] ?: RECORDED_STATE, args["codeVerifier"].stringValue ?: RECORDED_VERIFIER)
        val native = optionsFor(client, redirectUri, body["return_uri"], session)
        session.asksAppChoice = body["license_choice"] == "app"
        val options = SignInOptions(
            channel = SignInChannel.Redirect,
            deviceName = body["device_name"],
            scope = body["scope"]?.split(' '),
            loginHint = body["login_hint"],
            nameHint = body["name_hint"],
            purpose = SignInPurpose.entries.firstOrNull { it.wire == body["purpose"] },
            licenseChoice = if (session.asksAppChoice) "app" else null,
            native = native,
        )
        return client.identity.signIn.start(options).also { session.nativeSession = it }
    }

    /** A loopback delivery through the replay's listener; the 303 to the return page is asserted. */
    private suspend fun deliverLoopback(live: SignInSession, session: ReplaySession, url: String, returnPage: String): SignInOutcome {
        val listener = session.nativeListener
        val reply = listener?.deliver(url)
        val handle = queryValue(url, "request").orEmpty()
        val wanted = "$returnPage?request=$handle"
        val problem = when {
            reply == null -> "the loopback listener was not started"
            reply.location != null && reply.location != wanted -> "the listener answered 303 to ${reply.location}"
            !reply.final -> "the listener kept waiting for the redirect"
            else -> null
        }
        if (problem != null) throw AssertionError(problem)
        return live.wait()
    }

    /**
     * Hand the recorded redirect to the sign-in waiting for it: a loopback one through its listener, a scheme one
     * through `signIn.handleRedirect`. A sign-in already settled is single use, so a replayed callback is played
     * against a fresh one built on the same pending request (the recording pins the Worker's refusal of the code,
     * which the SDK would not even ask).
     */
    suspend fun complete(client: PolarisKeyClient, args: JsonObject, session: ReplaySession, transcript: Transcript): SignInOutcome {
        val url = args["callbackUrl"].stringValue.orEmpty()
        val live = session.nativeSession
        val waiting = live != null && live.outcome is SignInOutcome.Pending
        return when {
            waiting && live?.redirectClass == NativeRedirectClass.Loopback ->
                deliverLoopback(requireNotNull(live), session, url, "${transcript.baseUrl}/signin/return")

            waiting -> client.identity.signIn.handleRedirect(url)

            else -> replayAgain(client, args, session, transcript, url)
        }
    }

    private suspend fun replayAgain(
        client: PolarisKeyClient,
        args: JsonObject,
        session: ReplaySession,
        transcript: Transcript,
        url: String,
    ): SignInOutcome {
        val issuer = "${transcript.baseUrl}/${transcript.product}/identity"
        val recorded = ReplayPending(
            url.substringBefore('?'),
            args["state"].stringValue ?: RECORDED_STATE,
            args["codeVerifier"].stringValue ?: RECORDED_VERIFIER,
            issuer,
            session.asksAppChoice,
        )
        return client.identity.replayNativeCallback(recorded, url)
    }
}
