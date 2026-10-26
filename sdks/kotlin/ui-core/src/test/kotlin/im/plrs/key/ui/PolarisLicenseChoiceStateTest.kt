package im.plrs.key.ui

import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.identity.ReplaceView
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The licence-choice model works without a Compose runtime. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolarisLicenseChoiceStateTest {
    private fun view(vararg rows: String, pre: String = "null") = LicenseChoiceView.of(
        Json.parseToJsonElement("""{"state":"choose","choices":[${rows.joinToString(",")}],"preselected":$pre}""").jsonObject,
    )!!

    private val full = """{"id":"lic_team","state":"full"}"""
    private val ok = """{"id":"lic_pro","state":"ok"}"""
    private val completed = ChoiceCompleted("lic_pro", "ps_x", "profile")

    private class Fake : PolarisLicenseChoiceActions {
        val completes = ArrayList<LicenseChoice>()
        var complete: ChoiceResult<ChoiceCompleted> = ChoiceResult.Refused("invalid_grant", 400)
        var devices: ChoiceResult<ReplaceView> = ChoiceResult.Refused("not_found", 404)
        var cancel: ChoiceResult<Unit> = ChoiceResult.Ok(Unit)
        override suspend fun licenses(grant: String): ChoiceResult<LicenseChoiceView> = ChoiceResult.Refused("rate_limited", 429)
        override suspend fun devices(grant: String, licenseId: String) = devices
        override suspend fun complete(grant: String, choice: LicenseChoice): ChoiceResult<ChoiceCompleted> {
            completes += choice
            return complete
        }
        override suspend fun cancel(grant: String) = cancel
    }

    @Test
    fun startsOnTheSentViewWithItsPreselection() = runTest {
        val state = PolarisLicenseChoiceState(Fake(), backgroundScope, "sg_x", view(ok, pre = "\"lic_pro\""))
        val ui = state.ui.value as PolarisLicenseChoiceUi.Choosing
        assertEquals("lic_pro", ui.preselected)
    }

    @Test
    fun choosingAnOpenLicenceCompletesAndKeepIsAttachable() = runTest {
        val fake = Fake().apply { complete = ChoiceResult.Ok(completed.copy(attachable = true)) }
        var done: ChoiceCompleted? = null
        val state = PolarisLicenseChoiceState(fake, backgroundScope, "sg_x", view(ok), onCompleted = { done = it })
        state.keep()
        runCurrent()
        assertEquals(listOf<LicenseChoice>(LicenseChoice.Keep), fake.completes)
        assertTrue((state.ui.value as PolarisLicenseChoiceUi.Done).completed.attachable)
        assertTrue(done!!.attachable)
    }

    @Test
    fun aFullLicenceGoesToReplaceThenCompletesWithTheDevice() = runTest {
        val devices = ReplaceView("lic_team", emptyList(), Json.parseToJsonElement("""{"licenseId":"lic_team","devices":[]}""").jsonObject)
        val fake = Fake().apply { this.devices = ChoiceResult.Ok(devices); complete = ChoiceResult.Ok(completed) }
        val state = PolarisLicenseChoiceState(fake, backgroundScope, "sg_x", view(full, ok))
        state.choose("lic_team")
        runCurrent()
        assertTrue(state.ui.value is PolarisLicenseChoiceUi.Replacing)
        state.replace("OTHER")
        runCurrent()
        assertEquals(listOf<LicenseChoice>(LicenseChoice.License("lic_team", "OTHER")), fake.completes)
        assertTrue(state.ui.value is PolarisLicenseChoiceUi.Done)
    }

    @Test
    fun aDeviceLimitRefusalReturnsToTheFreshViewWithTheNotice() = runTest {
        val fresh = view(ok)
        val refused = ChoiceResult.Refused("device_limit", 403, manageUrl = "https://m", view = fresh)
        val fake = Fake().apply { complete = refused }
        val state = PolarisLicenseChoiceState(fake, backgroundScope, "sg_x", view(full))
        state.create()
        runCurrent()
        val ui = state.ui.value as PolarisLicenseChoiceUi.Choosing
        assertEquals(fresh, ui.view)
        assertEquals("https://m", ui.notice!!.manageUrl)
        assertEquals(false, ui.busy)
    }

    @Test
    fun invalidGrantEndsTheChoiceAndCancelIsTerminal() = runTest {
        val expired = PolarisLicenseChoiceState(Fake(), backgroundScope, "sg_x", view(ok))
        expired.enterKey("pkey_x")
        runCurrent()
        assertEquals(PolarisLicenseChoiceUi.Expired, expired.ui.value)

        val cancelled = PolarisLicenseChoiceState(Fake(), backgroundScope, "sg_x", view(ok))
        cancelled.cancel()
        runCurrent()
        assertEquals(PolarisLicenseChoiceUi.Cancelled, cancelled.ui.value)
    }

    @Test
    fun aThrownFailureIsRetryable() = runTest {
        var calls = 0
        val fake = object : PolarisLicenseChoiceActions {
            override suspend fun licenses(grant: String) = throw IllegalStateException()
            override suspend fun devices(grant: String, licenseId: String) = throw IllegalStateException()
            override suspend fun complete(grant: String, choice: LicenseChoice): ChoiceResult<ChoiceCompleted> {
                if (calls++ == 0) error("offline")
                return ChoiceResult.Ok(completed)
            }
            override suspend fun cancel(grant: String) = throw IllegalStateException()
        }
        val state = PolarisLicenseChoiceState(fake, backgroundScope, "sg_x", view(ok))
        state.keep()
        runCurrent()
        assertEquals(PolarisLicenseChoiceUi.Failed("offline"), state.ui.value)
        state.retry()
        runCurrent()
        assertTrue(state.ui.value is PolarisLicenseChoiceUi.Done)
    }
}
