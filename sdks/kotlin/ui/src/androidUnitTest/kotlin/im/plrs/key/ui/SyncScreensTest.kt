// @pkey-feature ui.kit
// The Cloud Sync screens (U-42; ui-matrix `cloudSync`): UnlockSync, RecoveryCode, RingChange and the
// locked and ring-changed CloudSyncStatus. What each shows, what each control reports, and the
// security points the screens keep: the typed code goes to one callback, the shown code is never an
// input, "No one will ever ask" is on both code screens, Start over warns first with Cancel focused,
// Accept exists only for a served ring, and Done waits for "I've saved my recovery code".

package im.plrs.key.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.sync.SyncStatus
import im.plrs.key.sdk.SyncRingPin
import im.plrs.key.sdk.SyncUnlockResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class SyncScreensTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setContent {
            StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { content() } }
        }
        rule.waitForIdle()
    }

    private fun unlock(step: String) = syncScreen(KitComponent.unlockSync, "unlockSync", "step" to step)

    @Test
    fun theCodeStepTakesTheCodeToOneCallbackAndSaysNoOneWillAsk() {
        val sent = mutableListOf<String>()
        var startedOver = 0
        show { PolarisUnlockSync(unlock("code"), onUnlock = { sent += it }, onStartOver = { startedOver++ }) }
        rule.onNodeWithText("Unlock your synced data").assertIsDisplayed()
        rule.onNodeWithText("No one will ever ask for this code. Enter it only in the app.").assertIsDisplayed()
        rule.onNodeWithText("Unlock").assertIsNotEnabled()
        rule.onNode(hasSetTextAction()).performTextInput("AAAA-BBBB")
        rule.onNodeWithText("Unlock").assertIsEnabled().performClick()
        assertEquals(listOf("AAAA-BBBB"), sent)
        rule.onNodeWithText("Start over").performClick()
        assertEquals(1, startedOver)
        // The nearby option is not offered in v0.10.0.
        rule.onNodeWithText("Use a nearby device").assertDoesNotExist()
    }

    @Test
    fun theInvalidLineGoesAsSoonAsThePersonEdits() {
        var edits = 0
        show { PolarisUnlockSync(unlock("invalid"), onEdit = { edits++ }) }
        rule.onNodeWithText("That code isn't right. Check it and try again.").assertIsDisplayed()
        rule.onNode(hasSetTextAction()).performTextInput("A")
        rule.waitForIdle()
        rule.onNodeWithText("That code isn't right. Check it and try again.").assertDoesNotExist()
        assertEquals(1, edits)
    }

    @Test
    fun theKeyboardDoneKeySubmitsTheCode() {
        val sent = mutableListOf<String>()
        show { PolarisUnlockSync(unlock("code"), onUnlock = { sent += it }) }
        rule.onNode(hasSetTextAction()).performTextInput("AAAA")
        rule.onNode(hasSetTextAction()).performImeAction()
        assertEquals(listOf("AAAA"), sent)
    }

    @Test
    fun aPhysicalKeyboardEnterSubmitsTheCodeAndIsNotPartOfIt() {
        val sent = mutableListOf<String>()
        show { PolarisUnlockSync(unlock("code"), onUnlock = { sent += it }) }
        rule.onNode(hasSetTextAction()).performTextInput("AAAA-BBBB\n")
        assertEquals(listOf("AAAA-BBBB"), sent)
    }

    @Test
    fun aFailedStartOverHasItsOwnLine() {
        var retried = 0
        show { PolarisUnlockSync(unlock("start-over-failed"), onRetry = { retried++ }) }
        rule.onNodeWithText("Couldn't start over. Check your connection and try again.").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retried)
    }

    @Test
    fun theRecoveryCodeIsAGridOfWholeGroups() {
        show { PolarisRecoveryCodeScreen(syncScreen(KitComponent.recoveryCode, "recoveryCode"), sampleRecoveryCode) }
        val tops = listOf("K7QM", "2XRD", "9TBA", "WF4N", "HC6P", "VJ3E", "M4TS", "8YGK").map {
            rule.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        }
        // Four to a row on a phone: two rows of four.
        assertEquals(setOf(tops[0]), tops.take(4).toSet())
        assertEquals(setOf(tops[4]), tops.drop(4).toSet())
        assertTrue(tops[4] > tops[0])
    }

    @Test
    fun anInvalidCodeIsNamedUnderTheFieldAndKeepsWhatWasTyped() {
        show { PolarisUnlockSync(unlock("invalid")) }
        rule.onNodeWithText("That code isn't right. Check it and try again.").assertIsDisplayed()
        rule.onNodeWithText("Unlock").assertIsNotEnabled()
    }

    @Test
    fun workingStepHasNoControls() {
        show { PolarisUnlockSync(unlock("working")) }
        rule.onNodeWithText("Working…").assertIsDisplayed()
        rule.onNodeWithText("Unlock").assertDoesNotExist()
    }

    @Test
    fun aFailedStepOffersTryAgainAndCancel() {
        var retried = 0
        var cancelled = 0
        show { PolarisUnlockSync(unlock("failed"), onRetry = { retried++ }, onCancel = { cancelled++ }) }
        rule.onNodeWithText("Couldn't unlock. Check your connection and try again.").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(1, retried)
        assertEquals(1, cancelled)
    }

    @Test
    fun startOverWarnsFirstAndCancelHasTheFocus() {
        var confirmed = 0
        var cancelled = 0
        // The first focus goes in where a keyboard (or a D-pad) is in use.
        rule.setContent {
            CompositionLocalProvider(LocalInputModeManager provides FixedInputMode(InputMode.Keyboard)) {
                StockHost(false) {
                    PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                        PolarisUnlockSync(unlock("start-over"), onConfirmStartOver = { confirmed++ }, onCancel = { cancelled++ })
                    }
                }
            }
        }
        rule.mainClock.advanceTimeBy(300)
        // A double tap on the opener lands here before the confirm is armed: it must not confirm.
        rule.onNodeWithText("Start over").performClick()
        rule.onNodeWithText("Start over").performClick()
        assertEquals(0, confirmed)
        rule.mainClock.advanceTimeBy(600)
        rule.onNodeWithText("Start over?").assertIsDisplayed()
        rule.onNodeWithText("Your current synced data will be lost. Start over only if you can't find your recovery code.").assertIsDisplayed()
        rule.onNodeWithText("Unlock").assertDoesNotExist()
        rule.onNodeWithText("Cancel").assertIsFocused()
        rule.onNodeWithText("Start over").performClick()
        assertEquals(1, confirmed)
        assertEquals(0, cancelled)
    }

    @Test
    fun theTitleIsTheHeading() {
        show { PolarisUnlockSync(unlock("code")) }
        val headings = rule.onAllNodes(androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).fetchSemanticsNodes()
        assertTrue(headings.isNotEmpty())
    }

    @Test
    fun theRecoveryCodeIsShownNotTypedAndDoneWaitsForSaved() {
        val saved = mutableListOf<Boolean>()
        show {
            var done by remember { mutableStateOf(false) }
            PolarisRecoveryCodeScreen(
                syncScreen(KitComponent.recoveryCode, "recoveryCode", "saved" to done),
                sampleRecoveryCode,
                onSavedChange = {
                    saved += it
                    done = it
                },
            )
        }
        rule.onNodeWithText("K7QM", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("8YGK", useUnmergedTree = true).assertIsDisplayed()
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        rule.onNodeWithText("No one will ever ask for this code. Enter it only in the app.").assertIsDisplayed()
        rule.onNodeWithText("Done").assertDoesNotExist()
        rule.onNodeWithText("I've saved my recovery code").performClick()
        assertEquals(listOf(true), saved)
        rule.onNodeWithText("Done").assertIsDisplayed()
    }

    @Test
    fun copyCodePutsTheCodeOnTheClipboard() {
        show { PolarisRecoveryCodeScreen(syncScreen(KitComponent.recoveryCode, "recoveryCode"), sampleRecoveryCode) }
        rule.onNodeWithText("Copy code").performClick()
        rule.waitForIdle()
        val manager = ApplicationProvider.getApplicationContext<Context>().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals("K7QM-2XRD-9TBA-WF4N-HC6P-VJ3E-M4TS-8YGK", manager.primaryClip?.getItemAt(0)?.text?.toString())
        rule.onNodeWithText("Copied").assertIsDisplayed()
    }

    @Test
    fun aChangedRingNamesTheDeviceAndAcceptsOnlyTheRingShown() {
        var accepted = 0
        var code = 0
        show {
            PolarisRingChange(
                syncScreen(KitComponent.ringChange, "ringChange", "by" to "Maya's MacBook", "served" to true),
                onAccept = { accepted++ },
                onUseCode = { code++ },
            )
        }
        rule.onNodeWithText("Your sync key changed").assertIsDisplayed()
        rule.onNodeWithText("Maya's MacBook set up a new key for your synced data.").assertIsDisplayed()
        rule.onNodeWithText("Use recovery code").performClick()
        rule.onNodeWithText("That was me").performClick()
        assertEquals(1, code)
        assertEquals(1, accepted)
    }

    @Test
    fun withoutAServedRingThereIsNothingToAcceptAndNoDeviceIsInvented() {
        show { PolarisRingChange(syncScreen(KitComponent.ringChange, "ringChange")) }
        rule.onNodeWithText("A device set up a new key for your synced data.").assertIsDisplayed()
        rule.onNodeWithText("That was me").assertDoesNotExist()
        rule.onNodeWithText("Use recovery code").assertIsDisplayed()
    }

    @Test
    fun theStatusOffersNothingTheHostCannotDoUnlessItIsBoundToTheKitsFlow() {
        show { PolarisCloudSyncStatus(PolarisCloudSync.RingChanged) }
        rule.onNodeWithText("Review").assertDoesNotExist()
    }

    @Test
    fun boundToTheFlowReviewAndUnlockOpenIt() {
        var opened = 0
        val actions = object : PolarisSyncActions {
            override suspend fun unlock(): SyncUnlockResult {
                opened++
                return SyncUnlockResult.Unlocked("r", 1)
            }
            override suspend fun recover(code: String) = Unit
            override suspend fun startOver(): String? = null
            override suspend fun create(): String? = null
            override suspend fun newRecoveryCode(): String = "X"
            override suspend fun acceptRingChange(served: SyncRingPin) = SyncUnlockResult.Unlocked("r", 1)
        }
        val state = PolarisSyncState(actions, CoroutineScope(Dispatchers.Unconfined))
        show { PolarisCloudSyncStatus(PolarisCloudSync.RingChanged, state) }
        rule.onNodeWithText("Review").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun noCodeSaysSoAndOffersStartOverWhichOnlyOpensTheWarning() {
        var startOver = 0
        var confirmed = 0
        show { PolarisUnlockSync(unlock("no-code"), onStartOver = { startOver++ }, onConfirmStartOver = { confirmed++ }) }
        rule.onNodeWithText("This account has no recovery code. Start over to keep syncing.").assertIsDisplayed()
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        rule.onNodeWithText("Start over").performClick()
        assertEquals(1, startOver)
        assertEquals(0, confirmed)
    }

    @Test
    fun aFailedAcceptSaysSoAndKeepsAccept() {
        show { PolarisRingChange(syncScreen(KitComponent.ringChange, "ringChange", "by" to "Maya", "served" to true, "failed" to true)) }
        rule.onNodeWithText("Couldn't confirm the new key. Try again, or use your recovery code.").assertIsDisplayed()
        rule.onNodeWithText("That was me").assertIsDisplayed()
    }

    @Test
    fun theCodeGridIsReadAsOneCodeWithTheGroupsApart() {
        show { PolarisRecoveryCodeScreen(syncScreen(KitComponent.recoveryCode, "recoveryCode"), sampleRecoveryCode) }
        rule.onNodeWithContentDescription("Recovery code K7QM 2XRD 9TBA WF4N HC6P VJ3E M4TS 8YGK").assertExists()
    }

    @Test
    fun theKitScreenRouteCarriesTheTypedCodeAndTheSavedTick() {
        val typed = mutableListOf<String>()
        val actions = mutableListOf<KitAction?>()
        show {
            Column {
                PolarisKitScreen(unlock("code"), onContinue = { typed += it }, onAction = { actions += it })
            }
        }
        rule.onNode(hasSetTextAction()).performTextInput("AAAA-BBBB")
        rule.onNodeWithText("Unlock").performClick()
        assertEquals(listOf("AAAA-BBBB"), typed)
        assertEquals(listOf<KitAction?>(KitAction.unlock), actions)
    }

    @Test
    fun theKitScreenRouteLetsThePersonTickSavedAndFinish() {
        val actions = mutableListOf<KitAction?>()
        show {
            PolarisKitScreen(
                syncScreen(KitComponent.recoveryCode, "recoveryCode"),
                recoveryCode = sampleRecoveryCode,
                onAction = { actions += it },
            )
        }
        rule.onNodeWithText("Done").assertDoesNotExist()
        rule.onNodeWithText("I've saved my recovery code").performClick()
        rule.onNodeWithText("Done").performClick()
        assertEquals(listOf<KitAction?>(null), actions)
    }

    @Test
    fun theStatusSaysLockedOrChangedAndOffersTheRightControl() {
        var unlocked = 0
        var reviewed = 0
        show {
            Column {
                PolarisCloudSyncStatus(PolarisCloudSync.Locked, onUnlock = { unlocked++ }, onReview = { reviewed++ })
                PolarisCloudSyncStatus(PolarisCloudSync.RingChanged, onUnlock = { unlocked++ }, onReview = { reviewed++ })
            }
        }
        rule.onNodeWithText("Sync is locked.").assertIsDisplayed()
        rule.onNodeWithText("Your sync key changed.").assertIsDisplayed()
        rule.onNodeWithText("Unlock sync").performClick()
        rule.onNodeWithText("Review").performClick()
        assertEquals(1, unlocked)
        assertEquals(1, reviewed)
    }

    @Test
    fun theFlowDrivesTheKeyringVerbsFromTheTypedCode() {
        val recovered = mutableListOf<String>()
        val actions = object : PolarisSyncActions {
            override suspend fun unlock() = SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap)
            override suspend fun recover(code: String) {
                recovered += code
                if (code == "BAD") throw PolarisException(ErrorCode.recoveryCodeInvalid, "no")
            }
            override suspend fun startOver(): String? = "NEW"
            override suspend fun create(): String? = null
            override suspend fun newRecoveryCode(): String = "NEW"
            override suspend fun acceptRingChange(served: SyncRingPin) = SyncUnlockResult.Unlocked("r", 1)
        }
        val state = PolarisSyncState(actions, CoroutineScope(Dispatchers.Unconfined))
        var done = 0
        state.open()
        show { PolarisSyncFlow(state, onDone = { done++ }) }
        rule.onNodeWithText("Recovery code").assertIsDisplayed()
        rule.onNode(hasSetTextAction()).performTextInput("BAD")
        rule.onNodeWithText("Unlock").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("That code isn't right. Check it and try again.").assertIsDisplayed()
        rule.onNode(hasSetTextAction()).performTextInput("2")
        rule.onNodeWithText("Unlock").performClick()
        rule.waitForIdle()
        assertEquals(listOf("BAD", "BAD2"), recovered)
        assertEquals(1, done)
    }

    private class FakeSource : PolarisCloudSyncSource {
        var status = SyncStatus(SyncState.Locked, 0)
        var flushes = 0
        override suspend fun status() = status
        override suspend fun flush(): SyncStatus {
            flushes++
            return status
        }
        override suspend fun probe(): SyncUnlockResult = SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap)
        override val events: kotlinx.coroutines.flow.Flow<im.plrs.key.sdk.CloudSyncEvent> = kotlinx.coroutines.flow.emptyFlow()
        override val actions = object : PolarisSyncActions {
            override suspend fun unlock(): SyncUnlockResult = SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap)
            override suspend fun recover(code: String) = Unit
            override suspend fun startOver(): String? = null
            override suspend fun create(): String? = null
            override suspend fun newRecoveryCode(): String = "ABCD-EFGH"
            override suspend fun acceptRingChange(served: SyncRingPin) = SyncUnlockResult.Unlocked("r", 1)
        }
    }

    @Test
    fun theKitHostDrawsTheRowThenTheScreensAndBackToTheRow() {
        val source = FakeSource()
        val host = PolarisCloudSyncHost(source, CoroutineScope(Dispatchers.Unconfined))
        show { PolarisCloudSyncKit(host) }
        rule.onNodeWithText("Sync is locked.").assertIsDisplayed()
        rule.onNodeWithText("Unlock sync").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Unlock your synced data").assertIsDisplayed()
        rule.onNodeWithText("Sync is locked.").assertDoesNotExist()
        source.status = SyncStatus(SyncState.Idle, 0)
        host.dismiss()
        rule.waitForIdle()
        rule.onNodeWithText("Sync is locked.").assertIsDisplayed()
    }

    @Test
    fun theKitHostShowsTheNewRecoveryCodeUntilItIsSaved() {
        val source = FakeSource()
        source.status = SyncStatus(SyncState.Idle, 0)
        val host = PolarisCloudSyncHost(source, CoroutineScope(Dispatchers.Unconfined))
        show { PolarisCloudSyncKit(host) }
        host.requestNewRecoveryCode()
        rule.waitForIdle()
        rule.onNodeWithText("I've saved my recovery code").performClick()
        rule.onNodeWithText("Done").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Done").assertDoesNotExist()
        assertEquals(1, source.flushes)
    }
}
