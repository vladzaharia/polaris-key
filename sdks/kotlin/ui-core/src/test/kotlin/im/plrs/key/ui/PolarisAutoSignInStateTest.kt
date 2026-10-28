// @pkey-feature identity.autosignin
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.AutoSignInReason
import im.plrs.key.identity.AutoSignInResult
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.ConsentInput
import im.plrs.key.identity.ExchangeConsentView
import im.plrs.key.identity.ExchangeOutcome
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The automatic sign-in holder: one run at boot, every result mapped, the opt-out, and no grant in a value. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolarisAutoSignInStateTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private val consent: ExchangeConsentView = ExchangeConsentView.of(
        obj(
            """{"client":{"appName":"Drift Kart","nameVerified":true},"as":{"provider":"google","email":"a@example.com"},""" +
                """"items":[{"kind":"license","anchor":{"name":"Drift Kart Pro","tierName":"Pro",""" +
                """"term":"perpetual","seat":{"position":2,"limit":3}},"more":0},""" +
                """{"kind":"profile","claims":["name","email"]}],"scopeHash":"abc","firstTime":true,"changed":false}""",
        ),
    )!!

    private class Fake(
        var ladder: AutoSignInResult,
        var provider: AutoSignInResult = AutoSignInResult.SignedIn("ps_x", "lic"),
        override val hasProvider: Boolean = true,
    ) : PolarisAutoSignInActions {
        var ladderCalls = 0
        var providerCalls = 0
        var completed: Pair<String, ConsentInput>? = null
        var cancelled: String? = null
        var completeResult: ChoiceResult<ChoiceCompleted> = ChoiceResult.Ok(ChoiceCompleted("lic", "ps_x", "profile"))
        override suspend fun autoSignIn(): AutoSignInResult = ladder.also { ladderCalls++ }
        override suspend fun completeConsent(grant: String, consent: ConsentInput): ChoiceResult<ChoiceCompleted> {
            completed = grant to consent
            return completeResult
        }
        override suspend fun cancelGrant(grant: String) {
            cancelled = grant
        }
        override suspend fun providerSignIn(): AutoSignInResult = provider.also { providerCalls++ }
        override fun choiceActions(): PolarisLicenseChoiceActions = object : PolarisLicenseChoiceActions {
            override suspend fun licenses(grant: String) = error("not used")
            override suspend fun devices(grant: String, licenseId: String) = error("not used")
            override suspend fun complete(grant: String, choice: im.plrs.key.identity.LicenseChoice) = error("not used")
            override suspend fun cancel(grant: String) = error("not used")
        }
    }

    private val grant = "sg_" + "B".repeat(43)

    @Test
    fun runsTheLadderOnceAndTheOptOutRunsNone() = runTest {
        val on = Fake(AutoSignInResult.SignedIn("ps_x", "lic"))
        var signedIn = 0
        val state = PolarisAutoSignInState(on, backgroundScope, onSignedIn = { signedIn++ })
        state.start()
        state.start()
        runCurrent()
        assertEquals(1, on.ladderCalls)
        assertEquals(PolarisAutoSignInUi.Done, state.ui.value)
        assertEquals(1, signedIn)
        val off = Fake(AutoSignInResult.SignedIn("ps_x", "lic"))
        val quiet = PolarisAutoSignInState(off, backgroundScope, enabled = false)
        quiet.start()
        runCurrent()
        assertEquals(0, off.ladderCalls)
        assertEquals(PolarisAutoSignInUi.Idle, quiet.ui.value)
    }

    @Test
    fun confirmContinuesWithTheListedClaimsAndOtherAccountGivesTheGrantUp() = runTest {
        val fake = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        val state = PolarisAutoSignInState(fake, backgroundScope)
        state.start()
        runCurrent()
        assertTrue(state.ui.value is PolarisAutoSignInUi.Confirm)
        state.continueConsent()
        runCurrent()
        assertEquals(grant to ConsentInput(listOf("name", "email")), fake.completed)
        assertEquals(PolarisAutoSignInUi.Done, state.ui.value)

        val other = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        val second = PolarisAutoSignInState(other, backgroundScope)
        second.start()
        runCurrent()
        second.useAnotherAccount()
        runCurrent()
        assertEquals(grant, other.cancelled)
        assertEquals(PolarisAutoSignInUi.SignInForm(provider = true), second.ui.value)
    }

    @Test
    fun aRefusedContinueStaysOnTheConsentAndAnExpiredGrantFallsBack() = runTest {
        val fake = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        fake.completeResult = ChoiceResult.Refused(ErrorCode.rateLimited, 429)
        val state = PolarisAutoSignInState(fake, backgroundScope)
        state.start()
        runCurrent()
        state.continueConsent()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.Confirm(consent, busy = false, failed = true), state.ui.value)
        fake.completeResult = ChoiceResult.Refused(ErrorCode.invalidGrant, 400)
        state.continueConsent()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.Idle, state.ui.value)
    }

    @Test
    fun chooseAndDeviceLimitMapAndTheRestFallBackSilently() = runTest {
        val view = LicenseChoiceView.of(obj("""{"state":"choose","choices":[{"id":"lic_1","state":"free"}]}"""))!!
        val choose = Fake(AutoSignInResult.Choose(ExchangeOutcome.PendingSignIn(grant, 300.0, view)))
        val c = PolarisAutoSignInState(choose, backgroundScope)
        c.start()
        runCurrent()
        assertTrue(c.ui.value is PolarisAutoSignInUi.Choose)

        val limit = Fake(AutoSignInResult.DeviceLimit("https://key.plrs.im/djdl/manage", view))
        val l = PolarisAutoSignInState(limit, backgroundScope)
        l.start()
        runCurrent()
        val shown = l.ui.value as PolarisAutoSignInUi.DeviceLimit
        assertEquals("https://key.plrs.im/djdl/manage", shown.manageUrl)

        for (quiet in listOf(
            AutoSignInResult.Unavailable("platform-identity-unavailable"),
            AutoSignInResult.NeedsSignIn(null, AutoSignInReason.SignedOut),
        )) {
            val s = PolarisAutoSignInState(Fake(quiet), backgroundScope)
            s.start()
            runCurrent()
            assertEquals(PolarisAutoSignInUi.Idle, s.ui.value)
        }
        // A desktop with no provider has nothing to add to the gate; a linked-account stop shows the form.
        val desktop =
            PolarisAutoSignInState(Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential), hasProvider = false), backgroundScope)
        desktop.start()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.Idle, desktop.ui.value)
        val terms = PolarisAutoSignInState(Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.Terms), hasProvider = false), backgroundScope)
        terms.start()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.SignInForm(provider = false), terms.ui.value)
    }

    @Test
    fun theProviderRowSignsInOrSaysItDidNotFinish() = runTest {
        val fake = Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential), provider = AutoSignInResult.Unavailable("network-error"))
        val state = PolarisAutoSignInState(fake, backgroundScope)
        state.start()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.SignInForm(provider = true), state.ui.value)
        state.signInWithProvider()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.SignInForm(provider = true, failed = true), state.ui.value)
        fake.provider = AutoSignInResult.SignedIn("ps_x", "lic")
        state.signInWithProvider()
        runCurrent()
        assertEquals(PolarisAutoSignInUi.Done, state.ui.value)
        assertEquals(2, fake.providerCalls)
    }

    @Test
    fun theGateStateRunsItOnceAndRereadsTheLicenceWhenSignedIn() = runTest {
        val auto = Fake(AutoSignInResult.SignedIn("ps_x", "lic"))
        var reads = 0
        val actions = object : PolarisGateActions {
            override val autoSignIn: PolarisAutoSignInActions = auto
            override suspend fun status(): LicenseState = LicenseState(if (reads++ == 0) LicenseStatus.needsActivation else LicenseStatus.ok)
            override suspend fun activate(key: String): ActivationResult = ActivationResult.Error("unused")
        }
        val gate = PolarisGateState(actions, backgroundScope)
        gate.start()
        runCurrent()
        assertEquals(1, auto.ladderCalls)
        assertEquals(LicenseStatus.ok, gate.gate.value.license?.status)
        // Turned off: none runs, and a gate with no automatic sign-in has no holder.
        val off = Fake(AutoSignInResult.SignedIn("ps_x", "lic"))
        val optOut = PolarisGateState(
            object : PolarisGateActions {
                override val autoSignIn: PolarisAutoSignInActions = off
                override suspend fun status(): LicenseState = LicenseState(LicenseStatus.needsActivation)
                override suspend fun activate(key: String): ActivationResult = ActivationResult.Error("unused")
            },
            backgroundScope,
            autoSignIn = false,
        )
        optOut.start()
        runCurrent()
        assertEquals(0, off.ladderCalls)
        assertNull(PolarisGateState(Fake2, backgroundScope).auto)
        assertFalse(optOut.auto?.enabled ?: true)
    }

    private object Fake2 : PolarisGateActions {
        override suspend fun status(): LicenseState = LicenseState(LicenseStatus.ok)
        override suspend fun activate(key: String): ActivationResult = ActivationResult.Error("unused")
    }

    @Test
    fun theConsentLineCarriesLicenseTermDevicePositionAndLimit() {
        val screen = KitStates.resolve(KitComponent.signIn, consent.toKitInputs(device = "Pixel 9"))
        assertEquals("confirm", screen.state)
        val line = screen.copy.first { it.key == "signin.consent.licenseLine" }
        assertEquals(
            setOf("license", "term", "device", "position", "limit"),
            line.args.keys.filter {
                it in
                    setOf("license", "term", "device", "position", "limit")
            }.toSet(),
        )
        assertEquals(CopyArgument.Text("Drift Kart Pro"), line.args["license"])
        assertEquals(CopyArgument.Number(2), line.args["position"])
        assertEquals(CopyArgument.Number(3), line.args["limit"])
        val term = (line.args["term"] as CopyArgument.Line).value
        assertEquals("signin.term.lifetime", term.key)
        val text = KitCopy.bundled.format(line, "en")
        assertEquals("Drift Kart Pro · Lifetime · Pixel 9 becomes device 2 of 3", text)
        assertTrue(screen.shows("signin.auto.confirm.primary") && screen.shows("signin.auto.confirm.other"))
    }

    @Test
    fun comingBackFromReplaceRunsTheProviderSignInOnceMore() = runTest {
        val fake =
            Fake(
                AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null),
                provider = AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null),
            )
        var signedIn = 0
        val state = PolarisAutoSignInState(fake, backgroundScope, onSignedIn = { signedIn++ })
        state.start()
        runCurrent()
        val limit = state.ui.value
        assertTrue(limit is PolarisAutoSignInUi.DeviceLimit)
        // No Replace yet: a return runs nothing.
        state.returned()
        runCurrent()
        assertEquals(0, fake.providerCalls)
        state.replaceOpened()
        assertTrue(state.awaitingReturn.value)
        // Back, the seat still taken: the step they left, and one run only.
        state.returned()
        runCurrent()
        assertEquals(1, fake.providerCalls)
        assertTrue(state.ui.value is PolarisAutoSignInUi.DeviceLimit)
        state.returned()
        runCurrent()
        assertEquals(1, fake.providerCalls)
        // Replace again, the seat freed: signed in.
        fake.provider = AutoSignInResult.SignedIn("ps_x", "lic")
        state.replaceOpened()
        state.returned()
        runCurrent()
        assertEquals(2, fake.providerCalls)
        assertEquals(PolarisAutoSignInUi.Done, state.ui.value)
        assertEquals(1, signedIn)
        assertEquals(1, fake.ladderCalls)
    }

    @Test
    fun withNoProviderTheReturnRunsTheLadderAndCancelEndsTheWait() = runTest {
        val fake = Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null), hasProvider = false)
        val state = PolarisAutoSignInState(fake, backgroundScope)
        state.start()
        runCurrent()
        // A desktop with a stored session after the browser: the ladder is rung 1.
        state.replaceOpened()
        fake.ladder = AutoSignInResult.SignedIn("ps_x", "lic")
        state.returned()
        runCurrent()
        assertEquals(2, fake.ladderCalls)
        assertEquals(0, fake.providerCalls)
        assertEquals(PolarisAutoSignInUi.Done, state.ui.value)

        val other = Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null))
        val second = PolarisAutoSignInState(other, backgroundScope)
        second.start()
        runCurrent()
        second.replaceOpened()
        second.dismiss()
        second.returned()
        runCurrent()
        assertEquals(0, other.providerCalls)
        assertEquals(PolarisAutoSignInUi.Idle, second.ui.value)
    }

    @Test
    fun replaceIsOfferedOnlyWhenSomeRowCanBeReplaced() {
        fun view(replace: String) = LicenseChoiceView.of(
            obj(
                """{"state":"choose","choices":[{"id":"lic_1","state":"full","name":"Pro","origin":"signin",""" +
                    """"seats":{"used":3,"limit":3},"replace":$replace}]}""",
            ),
        )!!
        val allowed = KitStates.resolve(KitComponent.licenseChoice, view("""{"allowed":true}""").toDeviceLimitInputs())
        assertTrue(KitAction.replaceInBrowser in allowed.actions)
        val refused = KitStates.resolve(KitComponent.licenseChoice, view("""{"allowed":false,"retryAfter":60}""").toDeviceLimitInputs())
        assertFalse(KitAction.replaceInBrowser in refused.actions)
        assertTrue(refused.shows("signin.choice.noneReplaceable"))
    }

    @Test
    fun theNoRowsLimitIsASignInStepWithReplaceUseAnotherAccountAndCancel() {
        val screen = KitStates.resolve(KitComponent.signIn, deviceLimitInputs("https://polaris.locker/#/p/x/free-device?license=lic_pro"))
        assertEquals("device-limit", screen.state)
        assertTrue(screen.shows("signin.deviceLimit.replace") && screen.shows("signin.auto.confirm.other") && screen.shows("common.cancel"))
        assertFalse(screen.shows("part.keyField.label") || screen.shows("signin.key.differentKey"))
        val bare = KitStates.resolve(KitComponent.signIn, deviceLimitInputs(null))
        assertFalse(bare.shows("signin.deviceLimit.replace"))
        assertTrue(bare.shows("deviceLimit.noManage"))
    }
}
