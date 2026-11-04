// The AddToAccount driver over the umbrella SDK (UK-43.8): sign in with the hints (channel redirect and no
// redirect URI, so the SDK picks the platform's native redirect: a loopback listener on a JVM desktop, a Custom
// Tab and a registered scheme or claimed link on Android), keep this device's license with
// `identity.choice.complete`, attach with `identity.attach`. Where the SDK answers `redirect-unavailable` it
// asks for a device code instead (nothing was sent). The model in PolarisAddToAccountState.kt knows nothing else.
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.identity.AccountOpener
import im.plrs.key.identity.AttachResult
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.NativeRedirectOptions
import im.plrs.key.identity.SignInChannel
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.SignInPurpose
import im.plrs.key.identity.SignInSession
import im.plrs.key.sdk.PolarisKeyClient

/**
 * The AddToAccount driver over [PolarisKeyClient]'s identity service. [native] is the host's native redirect
 * setup (its registered schemes, its opener); null leaves the SDK's defaults.
 */
public fun PolarisKeyClient.addToAccountDriver(
    native: NativeRedirectOptions? = null,
    /** Opens the verification page of the device-code fallback (the redirect opens its own); null leaves it to the person. */
    opener: ((String) -> Boolean)? = null,
): AddToAccountDriver {
    val identity = this.identity
    return object : AddToAccountDriver {
        override suspend fun signIn(hints: AddToAccountHints): AddToAccountHandle {
            val purpose = SignInPurpose.entries.firstOrNull { it.wire == hints.purpose }
            fun options(channel: SignInChannel) = SignInOptions(
                channel = channel,
                loginHint = hints.loginHint,
                nameHint = hints.nameHint,
                purpose = purpose,
                licenseChoice = "app",
                native = if (channel == SignInChannel.Redirect) native else null,
                opener = if (channel == SignInChannel.DeviceCode && opener != null) AccountOpener { opener(it) } else null,
            )
            val session = try {
                identity.signIn.start(options(SignInChannel.Redirect))
            } catch (e: PolarisException) {
                if (e.code != ErrorCode.redirectUnavailable) throw e
                // Headless, or no class applies: the person confirms a code instead (nothing was sent).
                identity.signIn.start(options(SignInChannel.DeviceCode))
            }
            return SessionHandle(session)
        }

        override suspend fun complete(grant: String): Boolean = identity.choice.complete(grant, LicenseChoice.Keep) is ChoiceResult.Ok

        override suspend fun attach(confirm: Boolean): AddToAccountAttach = when (val r = identity.attach(confirm)) {
            is AttachResult.Confirm, is AttachResult.Ok -> AddToAccountAttach.Ok

            is AttachResult.Refused -> AddToAccountAttach.Refused(r.code)

            // The product publishes no attach endpoint: nothing can be added.
            AttachResult.Unavailable -> AddToAccountAttach.Refused("unavailable")
        }
    }
}

/** A running [SignInSession] as the model sees it. */
private class SessionHandle(private val session: SignInSession) : AddToAccountHandle {
    // A redirect session has no code to show.
    override val userCode: String? = session.userCode.takeIf { it.isNotEmpty() }
    override val address: String? = session.verificationUri.takeIf { it.isNotEmpty() }
    override val link: String? = session.verificationUriComplete.takeIf { it.isNotEmpty() }

    override suspend fun wait(): AddToAccountWait = when (val o = session.wait()) {
        is SignInOutcome.SignedIn -> AddToAccountWait.SignedIn(o.identity?.email)

        is SignInOutcome.Choose -> AddToAccountWait.Choose(o.grant)

        SignInOutcome.Cancelled -> AddToAccountWait.Cancelled

        // Expired, or an outcome this flow does not handle (a key return): a failed attempt.
        else -> AddToAccountWait.Expired
    }

    override suspend fun reopen(): Boolean = session.reopen()

    override fun cancel() = session.cancel()
}

/**
 * Sign in to an account for the holders' steps that need one (someone else attached the license, the license's email
 * is another's, the license waits for an email): a redirect sign-in with [loginHint] (the device code where redirect is
 * unavailable), waited to its end. True when signed in, false when it did not finish: the caller shows the problem on
 * its own screen. Nothing here is fire and forget.
 */
public suspend fun PolarisKeyClient.signInToAccount(
    loginHint: String?,
    native: NativeRedirectOptions? = null,
    opener: ((String) -> Boolean)? = null,
): Boolean {
    val identity = this.identity
    fun options(channel: SignInChannel) = SignInOptions(
        channel = channel,
        loginHint = loginHint?.takeIf { it.isNotBlank() },
        native = if (channel == SignInChannel.Redirect) native else null,
        opener = if (channel == SignInChannel.DeviceCode && opener != null) AccountOpener { opener(it) } else null,
    )
    return try {
        val session = try {
            identity.signIn.start(options(SignInChannel.Redirect))
        } catch (e: PolarisException) {
            if (e.code != ErrorCode.redirectUnavailable) throw e
            identity.signIn.start(options(SignInChannel.DeviceCode))
        }
        session.wait() is SignInOutcome.SignedIn
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }
}
