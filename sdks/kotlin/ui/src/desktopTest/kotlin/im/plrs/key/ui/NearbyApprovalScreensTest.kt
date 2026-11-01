// @pkey-feature identity.nearby ui.signin
//
// I-45.13: nearby sign-in on the approving device, drawn by the Compose desktop kit over PolarisNearbyApprovalState. The ask
// shows the three codes and Deny (there is no Approve button), a tap on a code answers, a licence is one tap, an outcome has
// one way on, and leaving the screen answers Deny. The account menu offers "Approve a nearby device" only where it can run.
// The kit's own NearbyApproval steps already have their baselines; nothing here adds one.

@file:Suppress("MagicNumber", "EmptyFunctionBlock", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import im.plrs.key.core.LicenseStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonElement
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class NearbyApprovalScreensTest {
    private class Ask(override val device: String? = "Kitchen iPad") : PolarisApprovalAsk {
        override val codes = listOf("111 111", "482 913", "222 222")
        val picked = CopyOnWriteArrayList<String>()
        val denies = AtomicInteger()
        var next: PolarisApprovalOutcome = PolarisApprovalOutcome.Done("approved")

        override suspend fun pick(code: String): PolarisApprovalOutcome {
            picked += code
            return next
        }

        override suspend fun deny(): PolarisApprovalOutcome {
            denies.incrementAndGet()
            return PolarisApprovalOutcome.Done("denied")
        }
    }

    private class Actions(var available: Boolean = true) : PolarisApprovalActions {
        val stops = AtomicInteger()
        var onAsk: ((PolarisApprovalAsk) -> Unit)? = null

        override suspend fun available(): Boolean = available

        override suspend fun listen(onAsk: (PolarisApprovalAsk) -> Unit): PolarisApprovalHandle {
            this.onAsk = onAsk
            return object : PolarisApprovalHandle {
                override suspend fun stop() {
                    stops.incrementAndGet()
                }
            }
        }
    }

    private val settingsActions = object : PolarisSettingsActions {
        override suspend fun license() = PolarisLicenseSummary(LicenseStatus.ok, holder = "Ada")

        override suspend fun entries() = emptyList<PolarisSettingEntry>()

        override suspend fun set(key: String, value: JsonElement) {}

        override suspend fun reset(key: String) {}
    }

    private val devicesActions = object : PolarisDevicesActions {
        override suspend fun list() = emptyList<im.plrs.key.sdk.DeviceInfo>()

        override suspend fun rename(deviceId: String, label: String?) {}

        override suspend fun deauthorize(deviceId: String) {}
    }

    @androidx.compose.runtime.Composable
    @Suppress("ktlint:standard:function-naming")
    private fun AccountWith(nearby: PolarisNearbyApprovalState) {
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val settings = androidx.compose.runtime.remember { PolarisSettingsState(settingsActions, scope) }
        val devices = androidx.compose.runtime.remember { PolarisDevicesState(devicesActions, scope) }
        PolarisAccount(settings, devices, nearby = nearby)
    }

    private fun stateOf(a: Actions): PolarisNearbyApprovalState {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        return PolarisNearbyApprovalState(a, scope, cleanup = scope)
    }

    private fun ComposeUiTest.until(what: String, cond: () -> Boolean) {
        val end = System.nanoTime() + 8_000_000_000L
        while (!cond()) {
            waitForIdle()
            if (System.nanoTime() > end) throw AssertionError("timed out: $what")
            Thread.sleep(10)
        }
    }

    private fun ComposeUiTest.shows(text: String) = onAllNodesWithText(text, substring = true, ignoreCase = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theAskOffersTheThreeCodesAndDenyAndNoApproveButtonAndATapOnACodeApproves() {
        val a = Actions()
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbyApproval(state) }, after = {
            until("advert") { a.onAsk != null }
            val ask = Ask()
            a.onAsk!!(ask)
            until("ask") { shows("482 913") }
            assertTrue(shows("111 111"))
            assertTrue(shows("222 222"))
            assertTrue(shows("Deny"))
            assertTrue(shows("Kitchen iPad"))
            assertFalse(shows("Approve and sign it in"))
            assertTrue(ask.picked.isEmpty())
            onNodeWithText("482 913").performClick()
            until("outcome") { state.ui.value is PolarisApprovalUi.Result }
            assertEquals(listOf("482 913"), ask.picked.toList())
            until("done") { shows("is signed in") }
            onNodeWithText("Done", ignoreCase = true).performClick()
            until("closed") { state.ui.value == PolarisApprovalUi.Closed }
        })
    }

    @Test
    fun aLicenceIsOneTapAndDenyLeavesTheChoice() {
        val chosen = CopyOnWriteArrayList<String?>()
        val cancels = AtomicInteger()
        val choice = PolarisApprovalOutcome.NeedsLicense(
            rows = listOf(PolarisApprovalRow("lic_a", "Home"), PolarisApprovalRow("lic_b", "Studio")),
            canCreate = false,
            onChoose = { id ->
                chosen += id
                PolarisApprovalOutcome.Done("approved")
            },
            onCancel = {
                cancels.incrementAndGet()
                PolarisApprovalOutcome.Done("denied")
            },
        )
        val a = Actions()
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbyApproval(state) }, after = {
            until("advert") { a.onAsk != null }
            a.onAsk!!(Ask().also { it.next = choice })
            until("ask") { shows("482 913") }
            onNodeWithText("482 913").performClick()
            until("choice") { shows("Studio") }
            assertTrue(shows("Home"))
            onNodeWithText("Studio").performClick()
            until("outcome") { state.ui.value is PolarisApprovalUi.Result }
            assertEquals(listOf<String?>("lic_b"), chosen.toList())
        })
    }

    @Test
    fun leavingTheScreenAnswersDenyToTheAskOnIt() {
        val a = Actions()
        val state = stateOf(a)
        val ask = Ask()
        matrixFrame(420, 760, dark = false, content = { PolarisNearbyApproval(state) }, after = {
            until("advert") { a.onAsk != null }
            a.onAsk!!(ask)
            until("ask") { shows("482 913") }
            state.close()
            until("denied") { ask.denies.get() == 1 && a.stops.get() == 1 }
            assertTrue(ask.picked.isEmpty())
        })
    }

    @Test
    fun denyAtTheAskSendsNothingAndSaysDenied() {
        val a = Actions()
        val state = stateOf(a)
        val ask = Ask()
        matrixFrame(420, 760, dark = false, content = { PolarisNearbyApproval(state) }, after = {
            until("advert") { a.onAsk != null }
            a.onAsk!!(ask)
            until("ask") { shows("482 913") }
            onNodeWithText("Deny", ignoreCase = true).performClick()
            until("denied") { state.ui.value is PolarisApprovalUi.Result }
            assertEquals(1, ask.denies.get())
            assertTrue(ask.picked.isEmpty())
        })
    }

    @Test
    fun theAccountMenuOffersTheEntryOnlyWhereNearbyApprovalCanRun() {
        val off = stateOf(Actions(available = false))
        matrixFrame(420, 760, dark = false, content = { AccountWith(off) }, after = {
            waitForIdle()
            Thread.sleep(150)
            waitForIdle()
            assertFalse(shows("Approve a nearby device"))
        })
        val a = Actions()
        val on = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { AccountWith(on) }, after = {
            until("row") { shows("Approve a nearby device") }
            onNodeWithText("Approve a nearby device").performClick()
            until("advert") { a.onAsk != null }
            until("listening") { on.ui.value == PolarisApprovalUi.Listening }
            // Cancel returns to the account list and stops the advert.
            onNodeWithText("Cancel", ignoreCase = true).performClick()
            until("back") { shows("Approve a nearby device") && a.stops.get() == 1 }
        })
    }
}
