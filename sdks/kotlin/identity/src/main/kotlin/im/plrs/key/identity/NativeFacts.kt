// What discovery says about the native redirect of a product (WIRE-CONTRACT-V5 §12.6, §12.12; I-15b.5): every
// endpoint is used only when discovery names it, and the customer-host return page must be the product's own.

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException

private const val ENDPOINT_COUNT = 4

private fun origin(url: String): String? = Regex("([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*).*", RegexOption.DOT_MATCHES_ALL).matchEntire(url)
    ?.let { "${it.groupValues[1].lowercase()}://${it.groupValues[2].lowercase()}" }

/** The classes the product accepts, and whether it lists the four licence-choice routes. */
internal class NativeOffer(val classes: NativeRedirectDiscovery?, val choiceAvailable: Boolean)

/** What discovery says about the native redirect of a product; every endpoint is used only when it names it. */
internal class NativeFacts(
    val request: String?,
    val authorize: String?,
    val token: String?,
    val issuer: String?,
    val returnPage: String?,
    val offer: NativeOffer,
) {
    /** The endpoints as a set, or null when one is missing. */
    fun endpoints(clientId: String): NativeEndpoints? {
        val parts = listOfNotNull(request, authorize, token, issuer)
        return parts.takeIf {
            it.size == ENDPOINT_COUNT
        }?.let { NativeEndpoints(it.component1(), it.component2(), it.component3(), it.component4(), clientId) }
    }
}

private suspend fun IdentityClient.facts(): NativeFacts {
    val fragment = core.discoveryDocument()?.services?.get(ServiceSlug.identity)
    val endpoints = fragment?.endpoints.orEmpty()
    val extras = fragment?.extras.orEmpty()
    fun endpoint(name: String) = endpoints[name]?.takeIf { it.isNotEmpty() }
    return NativeFacts(
        request = endpoint("request"),
        authorize = endpoint("authorize"),
        token = endpoint("token"),
        issuer = extras["issuer"].stringValue?.takeIf { it.isNotEmpty() },
        returnPage = endpoint("signinReturn"),
        offer = NativeOffer(
            NativeRedirectDiscovery.parse(extras["nativeRedirect"]),
            listOf("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel").all { endpoint(it) != null },
        ),
    )
}

/** The 303 target is the product's own customer host: the API origin or the issuer's, over https, with no stray characters. */
private fun IdentityClient.checkReturnPage(facts: NativeFacts) {
    val page = facts.returnPage ?: return
    val allowed = setOfNotNull(origin(core.endpoints.baseUrl), facts.issuer?.let(::origin))
    val ok = !NativeUri.hasForbiddenChar(page) && page.startsWith("https://") && origin(page) in allowed
    if (!ok) throw PolarisException(ErrorCode.badResponse, "the return page points outside this product.")
}

internal suspend fun IdentityClient.loadFacts(): NativeFacts {
    if (core.discoveryDocument() == null) {
        runCatching { core.discover() }.onFailure { if (it is CancellationException) throw it }
        // `requireService` below answers for a product whose discovery is unknown.
    }
    core.requireService(ServiceSlug.identity, Feature.identityRedirectNative)
    val facts = facts()
    checkReturnPage(facts)
    val serves = facts.request == null || facts.endpoints(core.product) != null
    if (!serves) throw PolarisException(ErrorCode.signInUnavailable, "this product's discovery serves no redirect sign-in.")
    return facts
}
