// Starting a native redirect sign-in (WIRE-CONTRACT-V5 §12.12; I-15b.5): the app pushes its authorization request,
// opens the system browser at `authorize` with the `request_uri` it got back, and receives the code on a
// redirect it owns: a loopback listener (the JVM desktop default), a registered scheme or a claimed HTTPS
// link. `signIn.start(SignInOptions(channel = Redirect))` with no `redirectUri` begins one;
// `signIn.handleRedirect(url)` takes a scheme or claimed delivery.
//
// The order of a loopback start is the listener's bind, the pushed request, then the browser, so the port
// is held before the Worker learns it. A pending request is used for ONE callback check and one token
// request, then dropped; the verifier, the code and the token are never put in a URL, a log or a message.

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug

private const val MAX_RETRY_AFTER_SECONDS = 3600
private const val MAX_RETRY_AFTER_DIGITS = 9
private const val HTTP_SERVER_ERROR = 500

/**
 * The first class that applies: loopback (unless `loopback = false`, or the host is headless or has no browser to
 * open), a registered scheme, a claimed HTTPS link; none is `redirect-unavailable` (nothing was sent).
 */
private fun IdentityClient.chooseClass(facts: NativeFacts, options: SignInOptions): RedirectChoice {
    val native = options.native ?: NativeRedirectOptions()
    val hasOpener = options.opener != null || opener != null
    val browserOpens = !native.openBrowser || hasOpener || DesktopBrowser.available()
    val canListen = (native.loopback ?: (!NativeHost.isHeadless() && browserOpens)) && facts.returnPage != null
    val choice = NativeRedirect.chooseClass(facts.request, facts.offer.classes, canListen, native.registeredSchemes, native.registeredClaimed)
    if (choice is RedirectChoice.Unavailable) {
        throw PolarisException(ErrorCode.redirectUnavailable, "no native redirect can start here; sign in with a code instead (${choice.reason}).")
    }
    return choice
}

private fun redirectUriOf(choice: RedirectChoice, listener: NativeLoopbackListener?): String = when (choice) {
    RedirectChoice.Loopback -> NativeRedirect.loopbackUri(requireNotNull(listener).port)
    is RedirectChoice.Scheme -> choice.redirectUri
    is RedirectChoice.Claimed -> choice.redirectUri
    is RedirectChoice.Unavailable -> error("no class applies")
}

private fun retryAfter(response: PolarisResponse, fromBody: Int?): Int? =
    fromBody ?: response.header("retry-after")?.trim()?.takeIf { it.length in 1..MAX_RETRY_AFTER_DIGITS && it.all(Char::isDigit) }
        ?.toInt()?.coerceAtMost(MAX_RETRY_AFTER_SECONDS)

/** `POST` the pushed form with the device's headers; a transport failure is `network-error`. */
private suspend fun IdentityClient.postForm(request: PushedRequest): PolarisResponse = try {
    core.request(
        request.url,
        method = "POST",
        headers = mapOf("content-type" to request.contentType),
        body = request.body.toByteArray(Charsets.UTF_8),
    )
} catch (e: PolarisException) {
    throw if (e.code == ErrorCode.localOnly) e else PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
} catch (e: java.io.IOException) {
    throw PolarisException(ErrorCode.networkError, "network error", cause = e)
}

private suspend fun IdentityClient.push(request: PushedRequest): PushedAnswer.Pushed {
    val response = postForm(request)
    return when (val answer = NativeRedirect.parsePushedAnswer(response.status, JsonText.parseOrNull(response.text))) {
        is PushedAnswer.Pushed -> answer

        is PushedAnswer.Refused -> throw SignInError(
            if (answer.status >= HTTP_SERVER_ERROR) ErrorCode.serverError else answer.error,
            "the Worker refused the sign-in request (${answer.error}).",
            retryAfter(response, answer.retryAfterSeconds),
        )

        PushedAnswer.Malformed -> throw PolarisException(ErrorCode.badResponse, "the request endpoint answered without a complete pushed request.")
    }
}

private fun IdentityClient.entropyOf() = PushEntropy(state = redirectEntropyValue?.state, codeVerifier = redirectEntropyValue?.codeVerifier)

private suspend fun IdentityClient.pushOptions(facts: NativeFacts, options: SignInOptions): PushOptions = PushOptions(
    deviceName = core.deviceLabel(options.deviceName),
    returnUri = options.native?.returnUri,
    scope = options.scope,
    hints = PushHints(options.loginHint, options.nameHint, options.purpose?.wire),
    licenseChoiceApp = options.licenseChoice == "app" && facts.offer.choiceAvailable,
)

/** Bind (a loopback), push, and build the flow; the listener is not serving yet. */
private suspend fun IdentityClient.pushed(
    facts: NativeFacts,
    choice: RedirectChoice,
    listener: NativeLoopbackListener?,
    options: SignInOptions,
): NativeFlow {
    val product = core.endpoints.url("")
    val endpoints = facts.endpoints(core.product)?.takeIf {
        it.tokenEndpoint.startsWith(product) && it.requestEndpoint.startsWith(product)
    } ?: throw PolarisException(ErrorCode.badResponse, "an endpoint points outside this product.")
    val pushing = pushOptions(facts, options)
    val request = NativeRedirect.pushRequest(endpoints, redirectUriOf(choice, listener), pushing, entropyOf())
    val answer = push(request)
    val authorizeUrl = NativeRedirect.authorizeUrlFor(endpoints.authorizeEndpoint, core.product, answer.requestUri)
    val links = NativeLinks(authorizeUrl, core.now() + answer.expiresIn, facts.returnPage, pushing.deviceName)
    return NativeFlow(this, request.pending, links, listener, options.opener ?: opener)
}

/**
 * Begin a native redirect sign-in (§12.12). The order of a loopback start is the listener's bind, the pushed request,
 * then the browser, so the port is held before the Worker learns it. Every endpoint is used only when discovery
 * names it, and the ones the device's headers reach must be on this product.
 */
internal suspend fun IdentityClient.startNative(options: SignInOptions): NativeFlow {
    val facts = loadFacts()
    val choice = chooseClass(facts, options)
    val listener = if (choice is RedirectChoice.Loopback) (nativeListenerFactoryValue?.invoke() ?: LoopbackListener()) else null
    var started = false
    val flow = try {
        pushed(facts, choice, listener, options).also { started = true }
    } finally {
        if (!started) listener?.close()
    }
    // One native sign-in waits for a redirect at a time: a new start ends the last.
    nativeActive.getAndSet(flow)?.cancel()
    listener?.start(flow::onListenerCallback)
    return flow
}
