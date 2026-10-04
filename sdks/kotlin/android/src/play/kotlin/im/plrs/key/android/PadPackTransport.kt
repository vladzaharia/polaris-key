// packs.transport.play on a play build (P6-12): PlayPackTransport over :platform's AssetPacks (Play
// Core's AssetPackManager, one pack per call, notes/S-10 §2). See PlayPacks.kt for the layering rule.
//
// ensure(): fetch is only "accepted" (PENDING); state arrives through the listener and the fetch
// answer, and the wait ends at COMPLETED (success), FAILED or CANCELED, or after [fetchTimeoutMs].
// WAITING_FOR_WIFI / REQUIRES_USER_CONFIRMATION ask [confirm] (the game's size disclosure; absent:
// yes) and then show Play's dialog through the host activity, once per ensure. Call from Android's
// main thread: Play's callbacks arrive there.

package im.plrs.key.android

import android.app.Activity
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Unsupported
import im.plrs.key.packs.EmbeddedPack
import im.plrs.key.platform.play.AssetPacks
import im.plrs.key.platform.play.PackError
import im.plrs.key.platform.play.PackState
import kotlin.coroutines.resume
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

/** Play Asset Delivery over [AssetPacks]. */
public class PadPackTransport(
    private val assetPacks: AssetPacks,
    override val packs: List<String>,
    private val activity: () -> Activity? = { null },
    private val confirm: (suspend (packId: String, state: PlayPackState) -> Boolean)? = null,
    /** How long [ensure] waits for Play to finish. */
    private val fetchTimeoutMs: Long = 60 * 60 * 1000L,
) : PlayPackTransport {
    override fun availability(): Unsupported? = null

    override fun installed(): List<EmbeddedPack> = packs.mapNotNull { located(it) }

    /** The baseline Play holds for [packId] now, or null. */
    public fun located(packId: String): EmbeddedPack? {
        val loc = try {
            assetPacks.location(PlayPackTransport.padName(packId))
        } catch (e: Exception) {
            null
        } ?: return null
        // The install-time pack is APK_ASSETS with no path: not a file this transport can measure.
        if (loc.installTime) return null
        val assets = loc.assetsPath?.takeIf { it.isNotEmpty() } ?: return null
        val dir = PlayPackTransport.payloadDir(assets) ?: return null
        return PlayPackTransport.probe(dir)
    }

    override suspend fun ensure(packId: String): PlayPackResult {
        if (packId !in packs) return PlayPackResult.Failed(ErrorCode.invalidOptions, "$packId is not one of this transport's packs")
        val name = PlayPackTransport.padName(packId)
        val states = Channel<Result<PackState>>(Channel.UNLIMITED)
        val listener: (PackState) -> Unit = { s -> if (s.name == name) states.trySend(Result.success(s)) }
        assetPacks.listen(listener)
        try {
            assetPacks.fetch(name) { states.trySend(it) }
            return withTimeout(fetchTimeoutMs) { await(packId, name, states) }
        } catch (e: TimeoutCancellationException) {
            return PlayPackResult.Failed(ErrorCode.timeout, "Play Asset Delivery did not finish $name in time")
        } finally {
            assetPacks.unlisten(listener)
            states.close()
        }
    }

    private suspend fun await(packId: String, name: String, states: Channel<Result<PackState>>): PlayPackResult {
        var confirmed = false
        var last: PlayPackState? = null
        while (true) {
            val next = states.receive()
            val s = next.getOrElse { e ->
                val code = (e as? PackError)?.errorCode
                return PlayPackResult.Failed(ErrorCode.platformError, "Play Asset Delivery refused $name: ${e.message}${code?.let { " (error $it)" } ?: ""}", last)
            }
            val state = PlayPackState(s.name, s.status, s.errorCode, s.bytesDownloaded, s.totalBytes)
            last = state
            when (state.status) {
                PlayPackState.COMPLETED -> return PlayPackResult.Completed(state)
                PlayPackState.FAILED -> return PlayPackResult.Failed(ErrorCode.platformError, "Play Asset Delivery stopped $name (error ${state.errorCode})", state)
                PlayPackState.CANCELED -> return PlayPackResult.Failed(ErrorCode.cancelled, "Play Asset Delivery cancelled $name", state)
                PlayPackState.WAITING_FOR_WIFI, PlayPackState.REQUIRES_USER_CONFIRMATION -> if (!confirmed) {
                    confirmed = true
                    val go = confirm?.invoke(packId, state) ?: true
                    if (!go) {
                        try {
                            assetPacks.cancel(name)
                        } catch (e: Exception) {
                            // The download stays paused; Play reports it on the next fetch.
                        }
                        return PlayPackResult.Failed(ErrorCode.cancelled, "The download of $name was declined", state)
                    }
                    val host = activity() ?: return PlayPackResult.Failed(ErrorCode.platformError, "Play needs the player's confirmation for $name, and no activity is available to show it", state)
                    val shown = suspendCancellableCoroutine { cont -> assetPacks.confirm(host) { cont.resume(it) } }
                    if (shown.isFailure) return PlayPackResult.Failed(ErrorCode.platformError, "Play's confirmation dialog failed: ${shown.exceptionOrNull()?.message}", state)
                    if (shown.getOrNull() == Activity.RESULT_CANCELED) return PlayPackResult.Failed(ErrorCode.cancelled, "The player declined Play's confirmation for $name", state)
                }
            }
        }
    }
}
