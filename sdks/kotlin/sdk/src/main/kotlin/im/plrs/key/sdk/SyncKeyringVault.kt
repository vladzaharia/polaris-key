// Where the Cloud Sync root and the ring pin live (U-39.8). The root: one record in the host's
// `KeyringOptions.rootStorage` (Android: Keystore-sealed under its own alias), else the owner-only 0600
// file beside the device keys, else memory. The pin `{ringId, epoch, rootKid}` holds no secret: a file
// beside it (or memory without a state directory).

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeysUnreadableException
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.StoreException
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonObject
import java.io.File

/** The stored root and the ring it belongs to. Never printed. */
internal class SyncRootRecord(val ringId: String, val epoch: Int, val kid: String, val root: String) {
    override fun toString(): String = "SyncRootRecord(redacted)"

    fun encode(): ByteArray = obj(
        "v" to jsonInt(VERSION.toLong()),
        "ringId" to str(ringId),
        "epoch" to jsonInt(epoch.toLong()),
        "kid" to str(kid),
        "root" to str(root),
    ).toString().toByteArray(Charsets.UTF_8)

    companion object {
        const val VERSION = 1

        fun parse(raw: ByteArray): SyncRootRecord? {
            val o = JsonText.parseOrNull(raw.toString(Charsets.UTF_8)).objectValue
            val ringId = o?.get("ringId").stringValue
            val epoch = o?.get("epoch").longValue
            val kid = o?.get("kid").stringValue
            val root = o?.get("root").stringValue
            val ok = o != null && o["v"].longValue == VERSION.toLong() && !anyNull(ringId, epoch, kid, root)
            return if (ok) SyncRootRecord(ringId!!, epoch!!.toInt(), kid!!, root!!) else null
        }
    }
}

internal class RingVault(private val core: CoreContext, private val options: KeyringOptions) {
    private var rootStore: DeviceKeyStorage? = null
    private var pinStore: DeviceKeyStorage? = null
    private var memoryPin: SyncRingPin? = null

    val persistence: DeviceKeyPersistence get() = roots().persistence

    private fun roots(): DeviceKeyStorage =
        rootStore ?: (options.rootStorage ?: defaultStorage(SYNC_ROOT_FILE, "pkey-sync-root/1")).also { rootStore = it }

    private fun pins(): DeviceKeyStorage = pinStore ?: defaultStorage(SYNC_PIN_FILE, "pkey-sync-pin/1").also { pinStore = it }

    private fun defaultStorage(name: String, context: String): DeviceKeyStorage {
        val dir: File? = core.store.stateDirectory
        return if (dir == null) {
            InMemoryDeviceKeyStorage()
        } else {
            FileDeviceKeyStorage(File(dir, name), null, context.toByteArray(Charsets.UTF_8))
        }
    }

    private inline fun <T> guarded(onFail: (Exception) -> T, block: () -> T): T = try {
        block()
    } catch (e: StoreException) {
        onFail(e)
    } catch (e: DeviceKeysUnreadableException) {
        onFail(e)
    } catch (e: java.io.IOException) {
        onFail(e)
    }

    /**
     * Whether a pin or a root may be held, without creating a directory, lock file or key where none exists.
     * Unknown (a storage that cannot be read) counts as held, so the caller forgets rather than skips.
     */
    suspend fun mightHold(): Boolean {
        val dir: File? = core.store.stateDirectory
        val custom = options.rootStorage
        return memoryPin != null || (dir != null && File(dir, SYNC_PIN_FILE).exists()) ||
            when {
                custom is FileDeviceKeyStorage -> custom.mightHold()
                custom != null -> guarded({ true }) { custom.get() != null }
                dir != null -> File(dir, SYNC_ROOT_FILE).exists()
                else -> guarded({ true }) { roots().get() != null }
            }
    }

    /**
     * The pinned ring, or null before this client first acquired a root. Only [clear] drops it. With [checked], a pin that
     * cannot be read (I/O, permission, a refused loose or linked file) is an error, never an absent pin; a record that does
     * not parse, or names another product, is absent.
     */
    suspend fun pin(checked: Boolean = false): SyncRingPin? =
        parsePin(core.product, guarded({ if (checked) throw storeFault(it) else null }) { pins().get() }) ?: memoryPin

    suspend fun writePin(p: SyncRingPin) {
        memoryPin = p
        val rec: JsonObject = obj(
            "product" to str(core.product),
            "ringId" to str(p.ringId),
            "epoch" to jsonInt(p.epoch.toLong()),
            "rootKid" to str(p.rootKid),
        )
        guarded({ throw storeFault(it) }) { pins().put(rec.toString().toByteArray(Charsets.UTF_8)) }
    }

    /**
     * The stored root. With [checked], one that cannot be read is not an absent root: a storage fault is `store-failed`,
     * a record that is present but cannot be opened or decoded is `device-keys-unreadable`.
     */
    suspend fun load(checked: Boolean = false): SyncRootRecord? {
        val raw = guarded({ if (checked) throw rootFault(it) else null }) { roots().get() }
        val record = raw?.let { SyncRootRecord.parse(it) }
        if (checked && raw != null && record == null) throw rootFault(null)
        return record
    }

    /** A failure leaves the root in memory only; the next start unlocks through this device's wrap. */
    suspend fun save(r: SyncRootRecord) {
        guarded({ }) { roots().put(r.encode()) }
    }

    /**
     * Drops the root, then the pin (a stored root never outlives its pin). A root that cannot be deleted
     * throws before the pin is touched, so the sign-out stops rather than leave it behind.
     */
    suspend fun clear() {
        guarded({ throw storeFault(it) }) { roots().clear() }
        guarded({ throw storeFault(it) }) { pins().clear() }
        memoryPin = null
    }
}

private fun parsePin(product: String, raw: ByteArray?): SyncRingPin? {
    val o = raw?.let { JsonText.parseOrNull(it.toString(Charsets.UTF_8)).objectValue }
    val id = o?.get("ringId").stringValue
    val epoch = o?.get("epoch").longValue
    val kid = o?.get("rootKid").stringValue
    return if (o?.get("product").stringValue == product && !anyNull(id, epoch, kid)) SyncRingPin(id!!, epoch!!.toInt(), kid!!) else null
}

/** A storage fault is `store-failed`; a root that cannot be opened or decoded is `device-keys-unreadable`. */
private fun rootFault(e: Exception?): PolarisException = when (e) {
    is StoreException, is java.io.IOException -> storeFault(e)
    else -> PolarisException(ErrorCode.deviceKeysUnreadable, "The stored key ring root cannot be opened.", cause = e)
}

private fun storeFault(e: Exception): PolarisException =
    PolarisException(ErrorCode.storeFailed, "The key ring state could not be used: ${e.message}", cause = e)
