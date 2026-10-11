package im.plrs.key.ui

import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The Compose-free gate holder keeps the current UI contract independently of any renderer. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolarisGateStateTest {
    private class FakeGate(
        var state: LicenseState,
        val result: ActivationResult = ActivationResult.Ok("pkeyt_x", 1),
    ) : PolarisGateActions {
        val pushed = MutableSharedFlow<LicenseState>()
        var activatedWith: String? = null
        var syncs = 0

        override suspend fun status(): LicenseState = state

        override suspend fun activate(key: String): ActivationResult {
            activatedWith = key
            if (result is ActivationResult.Ok) state = LicenseState(LicenseStatus.ok)
            return result
        }

        override suspend fun sync() {
            syncs++
        }

        override val changes = pushed
    }

    @Test
    fun readsStatusAndFollowsChanges() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation))
        val gate = PolarisGateState(fake, backgroundScope, clock = { 10 })
        assertNull(gate.gate.value.license)

        gate.start()
        runCurrent()
        assertEquals(LicenseStatus.needsActivation, gate.gate.value.license?.status)

        fake.pushed.emit(LicenseState(LicenseStatus.grace, graceUntil = 99))
        runCurrent()
        assertEquals(LicenseStatus.grace, gate.gate.value.license?.status)
        assertEquals(10, gate.gate.value.nowSeconds)
    }

    @Test
    fun refusesAnEmptyKeyLocallyAndClearsItOnEdit() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation))
        val gate = PolarisGateState(fake, backgroundScope)

        gate.onKeyChange("   ")
        gate.activate()
        assertEquals(PolarisActivationError.KeyEmpty, gate.activation.value.error)
        assertNull(fake.activatedWith)

        gate.onKeyChange("pkey_1")
        assertNull(gate.activation.value.error)
    }

    @Test
    fun successfulActivationClearsTheFormAndReloads() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation))
        val gate = PolarisGateState(fake, backgroundScope)

        gate.onKeyChange("  pkey_abc ")
        gate.activate()
        runCurrent()

        assertEquals("pkey_abc", fake.activatedWith)
        assertEquals(PolarisActivationUi(), gate.activation.value)
        assertEquals(LicenseStatus.ok, gate.gate.value.license?.status)
    }

    @Test
    fun refusedActivationKeepsTheKeyAndShowsTheRefusal() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation), ActivationResult.Unauthorized)
        val gate = PolarisGateState(fake, backgroundScope)

        gate.onKeyChange("pkey_bad")
        gate.activate()
        runCurrent()

        val ui = gate.activation.value
        assertEquals("pkey_bad", ui.key)
        assertFalse(ui.busy)
        assertEquals(PolarisActivationError.Refused(ActivationResult.Unauthorized), ui.error)
    }

    @Test
    fun refreshSyncsThenReloads() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.expired))
        val gate = PolarisGateState(fake, backgroundScope)

        gate.refresh()
        runCurrent()

        assertEquals(1, fake.syncs)
        assertFalse(gate.gate.value.refreshing)
        assertEquals(LicenseStatus.expired, gate.gate.value.license?.status)
    }

    @Test
    fun continueFreeEnrolsAndSurfacesARefusal() = runTest {
        class EnrollGate(private val result: ActivationResult) : PolarisGateActions {
            var state = LicenseState(LicenseStatus.needsActivation)
            var enrollments = 0
            override suspend fun status(): LicenseState = state
            override suspend fun activate(key: String): ActivationResult = ActivationResult.EnrollDisabled
            override suspend fun enroll(): ActivationResult {
                enrollments++
                if (result is ActivationResult.Ok) state = LicenseState(LicenseStatus.ok)
                return result
            }
        }
        val allowedActions = EnrollGate(ActivationResult.Ok("pkeyt_free", 1))
        val allowed = PolarisGateState(allowedActions, backgroundScope)
        allowed.continueFree()
        runCurrent()
        assertEquals(1, allowedActions.enrollments)
        assertEquals(LicenseStatus.ok, allowed.gate.value.license?.status)
        assertNull(allowed.activation.value.error)

        val refused = PolarisGateState(EnrollGate(ActivationResult.EnrollDisabled), backgroundScope)
        refused.continueFree()
        runCurrent()
        assertEquals(PolarisActivationError.Refused(ActivationResult.EnrollDisabled), refused.activation.value.error)
    }
}
