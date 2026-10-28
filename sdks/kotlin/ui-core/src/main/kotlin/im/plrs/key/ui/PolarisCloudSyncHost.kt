// The Cloud Sync kit host (U-42.4T, Q-7): drives the status row from the real Cloud Sync client and
// switches between the UnlockSync, RingChange and RecoveryCode screens. A [PolarisCloudSyncSource]
// stands in for `client.cloudSync`, `client.events` and the key ring, so the binding is testable with a
// fake. Nothing here keeps a recovery code beyond the screens' own state, and no event carries a value.
package im.plrs.key.ui

import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.sync.SyncStatus
import im.plrs.key.sdk.CloudSyncEvent
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.SyncUnlockResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the host reads of the client. [asCloudSyncSource] is the live form. */
public interface PolarisCloudSyncSource {
    /** `client.cloudSync.status()`. Throws the typed N/A when the product does not run Sync. */
    public suspend fun status(): SyncStatus

    /** `client.cloudSync.flush()`. */
    public suspend fun flush(): SyncStatus

    /** `client.keyring.unlock()`, asked while locked to tell a changed ring from a plain lock. Never accepts a ring. */
    public suspend fun probe(): SyncUnlockResult

    /** `client.events`, narrowed to Cloud Sync's. */
    public val events: Flow<CloudSyncEvent>

    /** The screens' actions; "New recovery code" goes through `client.cloudSync`. */
    public val actions: PolarisSyncActions
}

/** The live source: `client.cloudSync`, `client.events` and `client.keyring`. */
public fun PolarisKeyClient.asCloudSyncSource(): PolarisCloudSyncSource {
    val client = this
    val ring = keyring.asSyncActions()
    return object : PolarisCloudSyncSource {
        override suspend fun status(): SyncStatus = client.cloudSync.status()

        override suspend fun flush(): SyncStatus = client.cloudSync.flush()

        override suspend fun probe(): SyncUnlockResult = client.keyring.unlock()

        override val events: Flow<CloudSyncEvent> = client.events.filterIsInstance<PolarisEvent.CloudSync>().map { it.event }

        override val actions: PolarisSyncActions = object : PolarisSyncActions by ring {
            override suspend fun newRecoveryCode(): String = client.cloudSync.newRecoveryCode()
        }
    }
}

/** The status row's state, in the kit's words. */
public enum class PolarisCloudSyncRow { Synced, Syncing, Offline, Error, SignedOut, Locked, RingChanged }

/** The row to draw; [syncedAtMillis] is set only for [PolarisCloudSyncRow.Synced] after a change was seen. */
public data class PolarisCloudSyncStatusState(val row: PolarisCloudSyncRow, val syncedAtMillis: Long? = null)

public class PolarisCloudSyncHost(
    private val source: PolarisCloudSyncSource,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow<PolarisCloudSyncStatusState?>(null)

    /** The row; null while Cloud Sync has nothing to say (local, or the service off). */
    public val status: StateFlow<PolarisCloudSyncStatusState?> = _status.asStateFlow()

    private val _flow = MutableStateFlow<PolarisSyncState?>(null)

    /** The screen flow in front, if any: draw it with `PolarisSyncFlow`. */
    public val flow: StateFlow<PolarisSyncState?> = _flow.asStateFlow()

    private val _newCodeFailed = MutableStateFlow(false)

    /** "New recovery code" could not make one (the previous code still works). */
    public val newCodeFailed: StateFlow<Boolean> = _newCodeFailed.asStateFlow()

    private var pump: Job? = null
    private var watch: Job? = null
    private var generation = 0
    private var signedOut = false
    private var lastSynced: Long? = null

    /** Follows the client's events and reads the status once. */
    public fun start() {
        pump?.cancel()
        pump = scope.launch { source.events.collect { handle(it) } }
        scope.launch { refresh() }
    }

    public fun stop() {
        pump?.cancel()
        pump = null
    }

    // ── status ──

    /** Reads the machine's status and redraws the row. */
    public suspend fun refresh() {
        val mine = ++generation
        val status = try {
            source.status()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The service is off (typed N/A) or unreadable: no row, never a dead one.
            if (mine == generation) setRow(null)
            return
        }
        if (mine != generation) return
        signedOut = false
        when (status.state) {
            SyncState.Local, SyncState.Unsupported -> setRow(null)

            SyncState.Locked -> locked(mine)

            SyncState.Idle, SyncState.Pending -> setRow(PolarisCloudSyncRow.Synced)

            SyncState.Syncing -> setRow(PolarisCloudSyncRow.Syncing)

            SyncState.Offline, SyncState.Paused -> setRow(PolarisCloudSyncRow.Offline)

            SyncState.Blocked -> {
                signedOut = status.reason == "accountRequired" || status.reason == "unauthorized"
                setRow(if (signedOut) PolarisCloudSyncRow.SignedOut else PolarisCloudSyncRow.Error)
            }
        }
    }

    // Locked: the key ring says whether the ring changed under this device.
    private suspend fun locked(mine: Int) {
        val result = try {
            source.probe()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        if (mine != generation) return
        when (result) {
            is SyncUnlockResult.RingChanged -> setRow(PolarisCloudSyncRow.RingChanged)

            is SyncUnlockResult.Unlocked -> {
                val next = try {
                    source.status()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
                if (mine != generation) return
                if (next != null && next.state != SyncState.Locked) refresh() else setRow(PolarisCloudSyncRow.Locked)
            }

            else -> setRow(PolarisCloudSyncRow.Locked)
        }
    }

    private suspend fun handle(event: CloudSyncEvent) {
        when (event) {
            // Not a fault: the row says so and offers to sign in.
            is CloudSyncEvent.SignedOut, is CloudSyncEvent.SignInOffered -> {
                generation++
                signedOut = true
                setRow(PolarisCloudSyncRow.SignedOut)
            }

            is CloudSyncEvent.Change -> {
                lastSynced = clock()
                refresh()
            }

            is CloudSyncEvent.Rejected, is CloudSyncEvent.UnsyncedData, CloudSyncEvent.PurgeFailed -> refresh()
        }
    }

    private fun setRow(row: PolarisCloudSyncRow?) {
        _status.value = row?.let { PolarisCloudSyncStatusState(it, if (it == PolarisCloudSyncRow.Synced) lastSynced else null) }
    }

    // ── screens ──

    /** The row's Unlock sync, or Review (which shows the ring to confirm): one flow that opens the right screen. */
    public fun openUnlock() {
        if (_flow.value != null) return
        begin().open()
    }

    /** Review a changed ring: the flow's unlock shows the ring it was served and accepts that one, never a fresh read. */
    public fun openReview(): Unit = openUnlock()

    /** Settings' "New recovery code": makes one through `client.cloudSync` and shows it once. The old code stops working only once the new one is held. */
    public fun requestNewRecoveryCode() {
        if (_flow.value != null) return
        _newCodeFailed.value = false
        scope.launch {
            val code = try {
                // Never cancelled midway: the server may already hold the new code.
                withContext(NonCancellable) { source.actions.newRecoveryCode() }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _newCodeFailed.value = true
                return@launch
            }
            if (_flow.value == null) begin().showCode(code)
        }
    }

    /** Leaves the screens. An unsaved new code, and a key being made, are never dropped. */
    public fun dismiss() {
        _flow.value?.cancel()
    }

    private fun begin(): PolarisSyncState {
        val state = PolarisSyncState(source.actions, scope, clock)
        _flow.value = state
        watch?.cancel()
        watch = scope.launch {
            var active = false
            state.ui.collect { ui ->
                when {
                    ui == PolarisSyncUi.Done -> {
                        finish(true)
                        return@collect
                    }

                    ui == PolarisSyncUi.Idle && active -> {
                        finish(false)
                        return@collect
                    }

                    ui != PolarisSyncUi.Idle -> active = true
                }
            }
        }
        return state
    }

    private fun finish(refreshing: Boolean) {
        _flow.value = null
        watch?.cancel()
        if (!refreshing) return
        scope.launch {
            // The key is held: send what was waiting, then redraw from the machine.
            try {
                source.flush()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            refresh()
        }
    }
}
