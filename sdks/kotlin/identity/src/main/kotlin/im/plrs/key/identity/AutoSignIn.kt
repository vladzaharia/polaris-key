// `identity.autoSignIn()`: the automatic sign-in ladder (CC-01-auto-sign-in section 1, I-45.2).
//
//   rung 1  a stored credential and a licence: `SignedIn`, no network
//   rung 2  silent restore (I-49): skipped here
//   rung 3  the platform provider, silently, over a fresh Worker nonce, then `exchange`
//   rung 4  the provider's one OS sheet (`prompt = OPTIONAL`), then `exchange`
//   rung 5+ are the app's: the regular sign-in form is `NeedsSignIn` / `Unavailable`
//
// The JVM desktop has no platform provider (Q-7): the ladder is rung 1, then `NeedsSignIn`
// (`NoCredential`). Android installs one through `installPlatformIdentity` (the `:android`
// `PlatformSignIn` adapter).
//
// Sign-out rules:
//   - `signOut()` sets `explicitSignOut` (CoreContext, persisted beside the credential) once the
//     Worker accepted it, and runs the provider's `signOutCleanup()`. While it is set rungs 3 and 4
//     do not run: nothing silent signs the person back in. The next explicit sign-in (a token
//     stored from a sign-in) clears it. A stored session (rung 1) is the person's own and is not
//     touched by the flag.
//   - A provider that reports its credential revoked at launch signs the device out through
//     `signOut()`. If the Worker cannot be reached the flag stays unset and the check repeats at
//     the next launch.
//
// A refusal from the exchange is a [PolarisException]; the ladder maps it to a result and never
// throws (coroutine cancellation excepted). Nothing here logs, prints or keeps a token, a grant or
// a link handle; the results redact them. There is no `syncKey` until U-39 (Q-8).

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.TokenProvenance
import kotlinx.coroutines.CancellationException

/** What a platform provider hands the exchange: an identity token bound to the nonce. A secret. */
public class PlatformSubjectToken(public val token: String, public val nonce: String) {
    override fun toString(): String = "PlatformSubjectToken(<redacted>)"
}

/**
 * The platform's identity (Google on Android) behind the ladder. The nonce is the Worker's, passed
 * on as it is. [silent] and [sheet] answer null when the platform has no token to give (none, or
 * the person dismissed the sheet); they may throw, which reads the same.
 */
public interface PlatformIdentityProvider {
    /** Which `exchange` kind this provider's tokens are. */
    public val kind: ExchangeKind

    /** An identity token with no UI. [serverClientId] is the product's (`exchange.google.serverClientId`), when published. */
    public suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken?

    /** An identity token through the platform's one account sheet. */
    public suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken?

    /**
     * The sign-in form's explicit provider row ("Continue with Google", `GetSignInWithGoogleOption` on Android): the
     * person pressed it, so it may show the OS sheet. Defaults to [sheet].
     */
    public suspend fun providerSheet(nonce: String, serverClientId: String?): PlatformSubjectToken? = sheet(nonce, serverClientId)

    /** Forget the platform's session state (called by `identity.signOut()`). Must not throw. */
    public suspend fun signOutCleanup()

    /** True when the platform says the person revoked this app's credential. */
    public suspend fun credentialRevoked(): Boolean
}

/** Whether the ladder may show the provider's sheet (rung 4). */
public enum class AutoSignInPrompt {
    /** Rung 3 only (silent). The default. */
    NEVER,

    /** Rung 4 after rung 3 finds nothing: at most one OS sheet. The developer opts in. */
    OPTIONAL,
}

public data class AutoSignInOptions @JvmOverloads constructor(
    /** The provider to use; null uses the one installed on the client (`installPlatformIdentity`). */
    val provider: PlatformIdentityProvider? = null,
    val prompt: AutoSignInPrompt = AutoSignInPrompt.NEVER,
)

/** Why `autoSignIn` found no session. */
public enum class AutoSignInReason(public val wire: String) {
    /** The platform account is not linked to a Polaris Locker account: sign in, then offer the link. */
    NoLink("no_link"),

    /** The product's terms version is unaccepted; only the sign-in card takes acceptance. */
    Terms("terms"),

    /** The person signed out on this device; the next sign-in is theirs to start. */
    SignedOut("signed_out"),

    /** The platform offered no credential (none, dismissed, or the sheet was not allowed). */
    NoCredential("no_credential"),
}

/** What the ladder answered. */
public sealed interface AutoSignInResult {
    /** The session is there. */
    public data class SignedIn(val subject: String?, val licenseId: String?) : AutoSignInResult

    /** Show [pending]'s consent, then `identity.choice.complete(grant, null, consent)`. */
    public class Confirm(public val pending: ExchangeOutcome.PendingConsent) : AutoSignInResult {
        override fun toString(): String = "AutoSignInResult.Confirm"
    }

    /** The licence choice: show [pending]'s choices, then `identity.choice.complete(grant, choice)`. */
    public class Choose(public val pending: ExchangeOutcome.PendingSignIn) : AutoSignInResult {
        override fun toString(): String = "AutoSignInResult.Choose"
    }

    /** `linkHandle` is present for `NoLink` after an exchange; used once, by the link offer. `toString` redacts it. */
    public class NeedsSignIn(public val linkHandle: String?, public val reason: AutoSignInReason) : AutoSignInResult {
        override fun toString(): String =
            "AutoSignInResult.NeedsSignIn(linkHandle=${if (linkHandle == null) "null" else "[redacted]"}, reason=${reason.wire})"
    }

    /**
     * Every seat is taken; [manageUrl] is the Worker's page for freeing one and [view] is the choice view (with the
     * replace rows) when the Worker sent it.
     */
    public class DeviceLimit(public val manageUrl: String?, public val view: LicenseChoiceView?) : AutoSignInResult {
        override fun toString(): String = "AutoSignInResult.DeviceLimit"
    }

    /**
     * No exchange here, or a refusal: [code] is the Worker's or `platform-identity-unavailable`. [reason] is why
     * the exchange was unavailable (no device keys, not served, ...) when that is what ended the ladder.
     */
    public data class Unavailable @JvmOverloads constructor(val code: String, val reason: ExchangeUnavailableReason? = null) : AutoSignInResult
}

internal suspend fun IdentityClient.runAutoSignIn(options: AutoSignInOptions): AutoSignInResult {
    val provider = options.provider ?: platformProvider.get()
    if (provider != null && safeRevoked(provider)) signOutAfterRevocation(provider)

    // Captured after a revocation sign-out (which bumps it): a later sign-out stops this ladder storing a token.
    val generation = core.signOutGeneration()

    // Rung 1: the stored session.
    if (core.token() != null && core.tokenProvenance() == TokenProvenance.signin) {
        val license = core.cache().license
        if (license != null) return AutoSignInResult.SignedIn(core.storedSubject(), license.doc.licenseId)
    }
    // Signed out on purpose: rungs 2-4 stay quiet.
    if (core.explicitSignOut()) return AutoSignInResult.NeedsSignIn(null, AutoSignInReason.SignedOut)
    // The JVM desktop has no provider: the regular form is next.
    if (provider == null) return AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential)

    attempt(provider, silent = true, generation)?.let { return it }
    if (options.prompt == AutoSignInPrompt.OPTIONAL) attempt(provider, silent = false, generation)?.let { return it }
    return AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential)
}

/**
 * The sign-in form's provider row: the person pressed it, so the provider's explicit sheet runs and the
 * exchange is `personInitiated` (it clears the sign-out flag). Never throws: a dismissed sheet is
 * `NeedsSignIn(NoCredential)`, a refusal is a result like the ladder's.
 */
internal suspend fun IdentityClient.runProviderSignIn(): AutoSignInResult {
    val provider = platformProvider.get() ?: return AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential)
    try {
        val nonce = when (val n = exchangeNonce(provider.kind)) {
            is ExchangeNonceResult.Issued -> n.nonce
            is ExchangeNonceResult.Ended -> return unavailable(n.outcome)
        }
        val audience = core.discoveryDocument()?.identity?.exchange?.googleServerClientId
        val subject = try {
            provider.providerSheet(nonce.value, audience)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential)
        val port = deviceKeyPort() ?: return AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable)
        return result(exchangeTokens(provider.kind, subject.token, nonce, port, personInitiated = true))
    } catch (e: CancellationException) {
        throw e
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.deviceLimit) return AutoSignInResult.DeviceLimit(e.manageUrl, LicenseChoiceView.of(e.view))
        return AutoSignInResult.Unavailable(e.code)
    } catch (e: Exception) {
        return AutoSignInResult.Unavailable(ErrorCode.networkError)
    }
}

/** Called by `signOut()` once the Worker accepted it. */
internal suspend fun IdentityClient.markSignedOut() {
    core.setExplicitSignOut(true)
    platformProvider.get()?.let { safeCleanup(it) }
}

private suspend fun safeCleanup(provider: PlatformIdentityProvider) {
    try {
        provider.signOutCleanup()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // Cleanup is best effort: the sign-out stands.
    }
}

private suspend fun safeRevoked(provider: PlatformIdentityProvider): Boolean = try {
    provider.credentialRevoked()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    false
}

/** One rung: a result that ends the ladder, or null to try the next rung. */
private suspend fun IdentityClient.attempt(provider: PlatformIdentityProvider, silent: Boolean, generation: Long): AutoSignInResult? {
    try {
        val nonce = when (val n = exchangeNonce(provider.kind)) {
            is ExchangeNonceResult.Issued -> n.nonce
            is ExchangeNonceResult.Ended -> return unavailable(n.outcome)
        }
        val audience = core.discoveryDocument()?.identity?.exchange?.googleServerClientId
        val subject = try {
            if (silent) provider.silent(nonce.value, audience) else provider.sheet(nonce.value, audience)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return null
        if (core.signOutGeneration() != generation) return signedOutResult()
        val port = deviceKeyPort() ?: return AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable)
        return result(
            exchangeTokens(provider.kind, subject.token, nonce, port) { core.signOutGeneration() == generation && !core.explicitSignOut() },
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: SignedOutDuringExchange) {
        return signedOutResult()
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.deviceLimit) return AutoSignInResult.DeviceLimit(e.manageUrl, LicenseChoiceView.of(e.view))
        return AutoSignInResult.Unavailable(e.code)
    } catch (e: Exception) {
        return AutoSignInResult.Unavailable(ErrorCode.networkError)
    }
}

private fun signedOutResult() = AutoSignInResult.NeedsSignIn(null, AutoSignInReason.SignedOut)

private fun result(outcome: ExchangeOutcome): AutoSignInResult = when (outcome) {
    is ExchangeOutcome.SignedIn -> AutoSignInResult.SignedIn(outcome.subject, outcome.licenseId)

    is ExchangeOutcome.PendingConsent -> AutoSignInResult.Confirm(outcome)

    is ExchangeOutcome.PendingSignIn -> AutoSignInResult.Choose(outcome)

    is ExchangeOutcome.NeedsSignIn -> AutoSignInResult.NeedsSignIn(
        outcome.linkHandle,
        if (outcome.reason == "terms") AutoSignInReason.Terms else AutoSignInReason.NoLink,
    )

    is ExchangeOutcome.Unavailable -> AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable, outcome.reason)
}

/** The ladder's answer when the nonce step ended it: the exchange's own reason is kept, not flattened. */
private fun unavailable(outcome: ExchangeOutcome): AutoSignInResult =
    AutoSignInResult.Unavailable(ErrorCode.platformIdentityUnavailable, (outcome as? ExchangeOutcome.Unavailable)?.reason)

/** Scenario 11. With a session this is the regular `signOut()`; with none, only the local state. */
private suspend fun IdentityClient.signOutAfterRevocation(provider: PlatformIdentityProvider) {
    if (core.token() == null) {
        core.setExplicitSignOut(true)
        safeCleanup(provider)
    } else {
        try {
            signOut()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The Worker could not be reached: the flag stays unset and the check repeats at the next launch.
        }
        // signOut() cleans up the installed provider; the one passed in the options is the one that reported it.
        if (provider !== platformProvider.get()) safeCleanup(provider)
    }
}
