package im.plrs.key.ui

import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisUpdateStateTest {
    @Test
    fun decisionsMapToOffers() {
        val release = DecisionRelease("2.5.0", 7)
        assertEquals(
            PolarisUpdateUi("2.5.0", mandatory = true, critical = false),
            PolarisUpdateUi.from(UpdateDecision.Binary("apk", release, "b1", mandatory = true, critical = false, prestage = emptyList(), discardStaged = false)),
        )
        assertEquals(
            PolarisUpdateUi("2.5.0", mandatory = false, critical = true),
            PolarisUpdateUi.from(UpdateDecision.Store(release, null, mandatory = false, critical = true, discardStaged = false)),
        )
        assertEquals(
            PolarisUpdateUi("2.5.0", mandatory = false, critical = false),
            PolarisUpdateUi.from(UpdateDecision.Platform(release, mandatory = false, critical = false, discardStaged = false)),
        )
        assertEquals(
            PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart),
            PolarisUpdateUi.from(UpdateDecision.CodeReady(release, critical = false, discardStaged = false)),
        )
        assertNull(PolarisUpdateUi.from(UpdateDecision.None("current", behind = false, discardStaged = false)))
        assertNull(PolarisUpdateUi.from(UpdateDecision.Blocked("content-floor", discardStaged = false)))
        assertNull(PolarisUpdateUi.from(UpdateDecision.Packs(emptyList(), emptyList(), emptyList(), discardStaged = false)))
    }

    @Test
    fun dismissedVersionsStayDismissedUnlessMandatory() {
        val state = PolarisUpdateState()
        state.show(PolarisUpdateUi("2.5.0"))
        state.dismiss()
        assertNull(state.offer.value)
        state.show(PolarisUpdateUi("2.5.0"))
        assertNull(state.offer.value)
        state.show(PolarisUpdateUi("2.6.0"))
        assertEquals("2.6.0", state.offer.value?.version)
        state.show(PolarisUpdateUi("2.6.0", mandatory = true))
        state.dismiss()
        assertEquals("2.6.0", state.offer.value?.version)
    }

    @Test
    fun followsABackgroundInstallAndFinishesIt() = runTest {
        val stages = MutableStateFlow<InstallStage>(InstallStage.Idle)
        val calls = mutableListOf<String>()
        val actions = object : PolarisUpdateActions {
            override suspend fun install(check: UpdateCheck): InstallResult {
                calls += "install"
                return InstallResult.Started
            }

            override suspend fun finish(): InstallResult {
                calls += "finish"
                return InstallResult.Started
            }

            override val stages = stages
        }
        val state = PolarisUpdateState()
        state.follow(actions, backgroundScope)
        state.show(
            UpdateCheck(
                "stable",
                UpdateDecision.Store(DecisionRelease("2.0.0", 20), null, false, false, false),
                UpdateCheck.FeedSource.network,
                UpdateCheck.RecordSource.none,
                emptyList(),
            ),
        )
        state.install(actions, backgroundScope)
        runCurrent()
        stages.value = InstallStage.Downloading(5, 10)
        runCurrent()
        assertEquals(5L to 10L, state.offer.value?.progress)
        stages.value = InstallStage.ReadyToRestart
        runCurrent()
        assertEquals(PolarisUpdateUi.Kind.Restart, state.offer.value?.kind)
        state.install(actions, backgroundScope)
        runCurrent()
        assertEquals(listOf("install", "finish"), calls)
        stages.value = InstallStage.Failed("platform_error")
        runCurrent()
        assertEquals(PolarisUpdateFailure("platform_error"), state.offer.value?.error)
    }
}
