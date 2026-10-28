// `client.keyring` -- the Cloud Sync key ring (U-39.8; WIRE-CONTRACT-V5 section 13.10, 13.11): create
// the ring, hold its root `R`, wrap `R` to another device, set the recovery code and recover from it,
// reset, adopt, and seal and open values with the root's keys. Mirrors Swift's `SyncKeyring`; the
// crypto is :core's `im.plrs.key.core.sync`.
//
// Rules this file keeps:
//  - `R` is held in memory and in one owner-only record (`SyncRootRecord`, below). It is never
//    returned, logged, put in an error or printed: every type that holds it prints as redacted. A
//    restart gets it back from the record, or through `unlock()`, which opens this device's own wrap.
//  - The device's agreement key never leaves its `DeviceKeyPort`: a wrap is opened through the
//    port's `dh`.
//  - The recovery code is returned once, to the caller, and kept nowhere.
//  - A wrap is accepted only when `kid(R)` equals the ring's `rootKid`.
//  - The first root this client acquires (create, recover, unlock) pins `{ringId, epoch, rootKid}`
//    (no secret). A served ring or wrap that differs is never opened: `unlock()` answers
//    `RingChanged`, and only the recovery code (`recover`) or an explicit `acceptRingChange`
//    re-pins. `forget()` drops the pin and the stored root; the sign-out hook calls it. The stored
//    root is used only while it matches the pin.
//  - Where the root lives (the host may pass `KeyringOptions.rootStorage`): Android seals it with
//    its own Keystore alias (`androidSyncRootStorage`); on a JVM desktop it is the owner-only 0600
//    file the device keys use (the JVM has no OS keyring); with no state directory it is memory
//    only, and `status().rootPersistence` says so.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreContext
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeysUnreadableException
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.defaultDeviceKeyStore
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncHpke
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncRecovery
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The Cloud Sync key ring: `client.keyring`. Every verb is serialised. */
public class SyncKeyring internal constructor(private val core: CoreContext, options: KeyringOptions = KeyringOptions()) {
    private val gate = Mutex()
    private val memory = RingMemory()
    private val vault = RingVault(core, options)
    private val wire = RingWire(core)
    private var port: DeviceKeyPort? = options.keys
    private var ring: SyncKeyringRing? = null

    /** What the E2E machine seals and opens with; it reads the ring's current root on every call. */
    public val codec: SyncCodec = SyncCodec(memory)

    override fun toString(): String = "SyncKeyring"

    /** Use these device keys from now on. */
    internal suspend fun useDeviceKeys(keys: DeviceKeyPort): Unit = gate.withLock { port = keys }

    // -- State -----------------------------------------------------------------------------------

    /** Feeds the machine: it is told now, and on every unlock and lock. Returns a detach function. */
    public fun attach(listener: SyncRootListener): () -> Unit = memory.attach(listener)

    /** Whether this device holds a root right now. */
    public val unlocked: Boolean get() = memory.held != null

    /**
     * What this device holds, with no request. A stored root that matches the pin is taken back
     * first, so a restart is unlocked offline.
     */
    public suspend fun status(): SyncKeyringStatus = gate.withLock {
        restoreStored()
        val h = memory.held
        SyncKeyringStatus(
            unlocked = h != null,
            ringId = h?.ringId,
            epoch = h?.epoch,
            pinned = vault.pin(),
            rootStored = vault.load() != null,
            rootPersistence = vault.persistence,
        )
    }

    /**
     * Forgets every root held in memory (quit). The stored root, the pin and the server's rows and
     * wraps are untouched; [forget] is the sign-out.
     */
    public fun lock() {
        memory.set(null, emptyList())
        ring = null
    }

    /**
     * Sign-out: forgets every root, in memory and in storage, and drops the pin, so the next person
     * on this device starts clean. A root that cannot be deleted throws, so the sign-out stops
     * rather than leave it behind.
     */
    public suspend fun forget(): Unit = gate.withLock {
        lock()
        vault.clear()
    }

    /** The pinned ring, or null before this client first acquired a root. Only [forget] drops it. */
    public suspend fun pin(): SyncRingPin? = vault.pin()

    private fun keyPort(): DeviceKeyPort? =
        port ?: if (RuntimeFamily.isAndroid) null else defaultDeviceKeyStore(core.store.stateDirectory).also { port = it }

    // -- Reads -----------------------------------------------------------------------------------

    /** `GET /<p>/devices/keyring`: the ring, and this device's own wrap. */
    public suspend fun read(): SyncKeyringState = gate.withLock { readState() }

    private suspend fun readState(): SyncKeyringState {
        val res = wire.request("GET", "devices/keyring")
        val out = wire.parseState(res.text) ?: throw badResponse("The key ring answer is not in the contract shape.")
        ring = out.ring
        return out
    }

    /** The unlock decided without going on: thrown inside [unlockWith] so its steps read in order. */
    private class Decided(val result: SyncUnlockResult) : Exception()

    private fun decided(result: SyncUnlockResult): Nothing = throw Decided(result)

    /**
     * Opens this device's wrap and holds the root. A device with no ring, no wrap, or a wrap it
     * cannot use stays locked (a result, not an error); a network or server failure throws.
     */
    public suspend fun unlock(): SyncUnlockResult = gate.withLock { unlockWith(null) }

    /**
     * The person confirmed that the ring they were shown (`served` of a `RingChanged` answer) is
     * theirs: open this device's wrap for it and pin it. If the Worker now serves another, the
     * answer is `RingChanged` again. Call it only from confirmed UI.
     */
    public suspend fun acceptRingChange(confirmed: SyncRingPin): SyncUnlockResult = gate.withLock { unlockWith(confirmed) }

    private suspend fun unlockWith(accept: SyncRingPin?): SyncUnlockResult = try {
        unlockSteps(accept)
    } catch (d: Decided) {
        d.result
    }

    private suspend fun unlockSteps(accept: SyncRingPin?): SyncUnlockResult {
        val state = readState()
        val ring = state.ring ?: decided(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoRing))
        val pinned = vault.pin()
        // An accept holds only for the ring the person was shown; a ring that moved since is reported again.
        val expected = accept ?: pinned
        val served = SyncRingPin(ring.ringId, ring.epoch, ring.rootKid)
        if (expected != null && expected != served) {
            decided(SyncUnlockResult.RingChanged(pinned ?: expected, served, ring.createdAt, state.wrap?.by))
        }
        val unlocked = SyncUnlockResult.Unlocked(ring.ringId, ring.epoch)
        val kid = unhex(ring.rootKid) ?: decided(UNUSABLE)
        val h = memory.held
        if (h != null && h.matches(ring.ringId, ring.epoch, kid)) decided(unlocked)
        // The stored root, when it is this ring's (and, when a pin stands, the pinned one).
        val stored = storedRoot(served)
        if (stored != null) {
            hold(stored, store = false)
            decided(unlocked)
        }
        val wrap = state.wrap ?: decided(SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap))
        val root = openOwnWrap(ring, wrap, kid) ?: decided(UNUSABLE)
        hold(HeldRoot(ring.ringId, ring.epoch, kid, root), store = true)
        return unlocked
    }

    private suspend fun openOwnWrap(ring: SyncKeyringRing, wrap: SyncKeyringWrapInfo, kid: ByteArray): ByteArray? {
        val keys = keyPort()
        val enc = unb64(wrap.enc, SyncHpke.ENC_BYTES)
        val ct = unb64(wrap.ct)
        val usable = !anyNull(keys, enc, ct) && wrap.kid == ring.rootKid && wrap.epoch == ring.epoch && kemOk(wrap.kem)
        val root = if (usable) unwrap(keys!!, ring, kid, SyncHpke.Wrap(SyncHpke.KEM_X25519, enc!!, ct!!)) else null
        return root?.takeIf { SyncCrypto.equalBytes(SyncKeys.deriveKid(it), kid) }
    }

    private suspend fun unwrap(keys: DeviceKeyPort, ring: SyncKeyringRing, kid: ByteArray, wrap: SyncHpke.Wrap): ByteArray? = try {
        SyncHpke.unwrapRoot(keys, wrapContext(ring.ringId, ring.epoch), kid, wrap)
    } catch (e: DeviceKeysUnreadableException) {
        throw PolarisException(ErrorCode.deviceKeysUnreadable, "The stored device keys cannot be opened.", cause = e)
    }

    private fun kemOk(k: JsonElement): Boolean = k.stringValue == "x25519" || k.longValue == SyncHpke.KEM_X25519.toLong()

    // -- Writes ----------------------------------------------------------------------------------

    /**
     * Makes the ring: a fresh root, a wrap to this device, and (by default) a recovery blob. The
     * root is held on success. `keyring_conflict` (a ring exists) leaves nothing held: [unlock].
     */
    public suspend fun create(recovery: Boolean = true): SyncCreatedRing = gate.withLock { makeRing("devices/keyring", recovery) }

    /**
     * Starts over: a new ring and root, optionally a new recovery code. The server keeps the old
     * ring as `previous` for 30 days; a root this device held is kept in memory for [adopt].
     */
    public suspend fun reset(recovery: Boolean = true): SyncCreatedRing = gate.withLock { makeRing("devices/keyring/reset", recovery) }

    /**
     * Wraps the root to another device of the same person (`PUT .../wraps/{deviceId}`). [agreeKey] is
     * that device's X25519 key, from the nearby approval.
     */
    public suspend fun wrapTo(deviceId: String, agreeKey: ByteArray): Unit = gate.withLock { putWrap(deviceId, agreeKey) }

    /** [wrapTo] with the key as base64url text, as a nearby approval carries it. */
    public suspend fun wrapTo(deviceId: String, agreeKey: String) {
        wrapTo(deviceId, unb64(agreeKey, SyncHpke.ENC_BYTES) ?: throw badArg("The agreement key must be 32 bytes."))
    }

    private suspend fun putWrap(deviceId: String, agreeKey: ByteArray) {
        val h = need()
        needDeviceId(deviceId)
        if (agreeKey.size != SyncHpke.ENC_BYTES) throw badArg("The agreement key must be 32 bytes.")
        val w = SyncHpke.wrapRoot(agreeKey, wrapContext(h.ringId, h.epoch, deviceId), h.kid, h.root)
        val body = JsonObject(mapOf("epoch" to jsonInt(h.epoch.toLong()), "kid" to str(hex(h.kid))) + wire.wireWrap(w))
        wire.send("PUT", "devices/keyring/wraps/${segment(deviceId)}", body)
    }

    /** `DELETE .../wraps/{deviceId}`: the Worker removes a device's own wrap only. */
    public suspend fun removeWrap(deviceId: String): Unit = gate.withLock {
        needDeviceId(deviceId)
        wire.send("DELETE", "devices/keyring/wraps/${segment(deviceId)}")
    }

    /**
     * Makes a new recovery code, seals the root under it and stores the blob. The previous code
     * stops working. Returns the code to show the person; it is kept nowhere.
     */
    public suspend fun setRecoveryCode(): String = gate.withLock {
        val h = need()
        val code = SyncRecovery.newCode()
        val blob = SyncRecovery.wrap(code, SyncRecovery.RingRef(h.ringId, h.epoch, h.kid), h.root)
        wire.send(
            "PUT",
            "devices/keyring/recovery",
            obj("ct" to str(Base64Url.encode(blob)), "epoch" to jsonInt(h.epoch.toLong()), "kid" to str(hex(h.kid))),
        )
        SyncRecovery.encode(code)
    }

    /** `GET .../recovery`: the sealed blob (5 reads a day per device; the account is emailed). */
    public suspend fun recoveryBlob(): SyncRecoveryBlob = gate.withLock { readRecoveryBlob() }

    private suspend fun readRecoveryBlob(): SyncRecoveryBlob {
        val v = JsonText.parseOrNull(wire.request("GET", "devices/keyring/recovery").text).objectValue
        val ct = v?.get("ct").stringValue
        val epoch = v?.get("epoch").longValue
        val kid = v?.get("kid").stringValue
        return if (ct != null && epoch != null && kid != null) {
            SyncRecoveryBlob(ct, epoch.toInt(), kid)
        } else {
            throw badResponse("The recovery answer is not in the contract shape.")
        }
    }

    private fun notFoundRecovery() = PolarisException(ErrorCode.notFound, "There is no recovery code for this key ring.")

    private fun recoveredRoot(code: ByteArray, ring: SyncKeyringRing, kid: ByteArray, blob: SyncRecoveryBlob): ByteArray {
        val mine = blob.epoch == ring.epoch && blob.kid == ring.rootKid
        if (!mine) refuse(ErrorCode.badResponse, "The recovery blob does not belong to the current ring.")
        val bytes = unb64(blob.ct)
        val root = bytes?.let { SyncRecovery.unwrap(code, SyncRecovery.RingRef(ring.ringId, ring.epoch, kid), it) }
        return root?.takeIf { SyncCrypto.equalBytes(SyncKeys.deriveKid(it), kid) } ?: throw invalidCode()
    }

    private fun invalidCode() = PolarisException(ErrorCode.recoveryCodeInvalid, "The recovery code is not valid for this key ring.")

    /**
     * Recovers the root from the typed or pasted recovery code. The code is checked before any
     * request; a bad checksum or a failed unwrap is `recovery-code-invalid`. On success the root is
     * held and pinned, and this device deposits its own wrap so the next start unlocks without the code.
     */
    public suspend fun recover(codeText: String): SyncRecovered = gate.withLock {
        val code = SyncRecovery.parse(codeText) ?: throw invalidCode()
        val ring = readState().ring?.takeIf { it.recoverySet } ?: throw notFoundRecovery()
        val kid = unhex(ring.rootKid) ?: throw badResponse("Bad ring kid.")
        val root = recoveredRoot(code, ring, kid, readRecoveryBlob())
        hold(HeldRoot(ring.ringId, ring.epoch, kid, root), store = true)
        SyncRecovered(ring.ringId, ring.epoch, depositOwnWrap())
    }

    /**
     * Adopts an earlier or merged root under the current one (`POST .../adopt`): the id of a ring
     * whose root this client holds (kept by [reset] or [openAdopted]). The root is sealed under
     * `K_adopt` of the current root.
     */
    public suspend fun adopt(ringId: String): Unit = gate.withLock {
        need()
        postAdopt(memory.others.firstOrNull { it.ringId == ringId } ?: throw badArg("No root is held for that ring."))
    }

    /** Adopts a root the host has: `{ringId, epoch, root}`. */
    public suspend fun adopt(ringId: String, epoch: Int, root: ByteArray): Unit = gate.withLock {
        need()
        if (!RING_ID.matches(ringId) || root.size != SyncCrypto.ROOT_BYTES) throw badArg("No root is held for that ring.")
        postAdopt(HeldRoot(ringId, epoch, SyncKeys.deriveKid(root), root))
    }

    private suspend fun postAdopt(old: HeldRoot) {
        val h = need()
        if (!RING_ID.matches(old.ringId) || old.epoch < 1) throw badArg("No root is held for that ring.")
        val blob = SyncRecovery.sealAdopt(h.root, SyncRecovery.RingRef(old.ringId, old.epoch, old.kid), old.root)
        wire.send(
            "POST",
            "devices/keyring/adopt",
            obj(
                "fromRingId" to str(old.ringId),
                "epoch" to jsonInt(old.epoch.toLong()),
                "kid" to str(hex(old.kid)),
                "ct" to str(Base64Url.encode(blob)),
            ),
        )
    }

    /**
     * Opens the ring's `adopted` candidates with the current root and keeps the roots they hold, so
     * `codec.open` reads data sealed under them. Returns the ring ids it opened; a candidate that
     * does not open (or names a different `kid`) is skipped.
     */
    public suspend fun openAdopted(): List<String> = gate.withLock {
        val h = need()
        val current = ring ?: readState().ring
        current?.adopted.orEmpty().mapNotNull { a ->
            val kid = unhex(a.kid)
            val ct = unb64(a.ct)
            val root = if (kid != null && ct != null) SyncRecovery.openAdopt(h.root, SyncRecovery.RingRef(a.ringId, a.epoch, kid), ct) else null
            if (root != null && SyncCrypto.equalBytes(SyncKeys.deriveKid(root), kid!!)) {
                memory.addOther(HeldRoot(a.ringId, a.epoch, kid, root))
                a.ringId
            } else {
                null
            }
        }
    }

    // -- Internals -------------------------------------------------------------------------------

    private fun need(): HeldRoot = memory.held ?: throw lockedError()

    /**
     * Takes a freshly acquired root: pinned first (no root is held without a pin), then kept in
     * storage (a failure there leaves the root in memory only), then held.
     */
    private suspend fun hold(h: HeldRoot, store: Boolean) {
        val pinned = SyncRingPin(h.ringId, h.epoch, hex(h.kid))
        if (vault.pin() != pinned) vault.writePin(pinned)
        if (store) vault.save(SyncRootRecord(h.ringId, h.epoch, hex(h.kid), Base64Url.encode(h.root)))
        val old = memory.held
        val others = if (old != null && (old.ringId != h.ringId || old.epoch != h.epoch)) memory.others + old else memory.others
        memory.set(h, others)
    }

    /** The stored root, when it is for [ring] and still derives its own `kid`. */
    private suspend fun storedRoot(ring: SyncRingPin): HeldRoot? {
        val s = vault.load()?.takeIf { it.ringId == ring.ringId && it.epoch == ring.epoch && it.kid == ring.rootKid }
        val root = s?.let { unb64(it.root, SyncCrypto.ROOT_BYTES) }
        val kid = s?.let { unhex(it.kid) }
        val derives = root != null && kid != null && SyncCrypto.equalBytes(SyncKeys.deriveKid(root), kid)
        return if (derives) HeldRoot(s!!.ringId, s.epoch, kid!!, root!!) else null
    }

    /** A restart: the stored root comes back only while it is the pinned ring's. */
    private suspend fun restoreStored() {
        val p = if (memory.held == null) vault.pin() else null
        p?.let { storedRoot(it) }?.let { memory.set(it) }
    }

    private suspend fun wrapContext(ringId: String, epoch: Int, deviceId: String? = null): SyncHpke.WrapContext =
        SyncHpke.WrapContext(core.product, deviceId ?: core.deviceId(), ringId, epoch)

    private suspend fun agreeKey(): ByteArray {
        val keys = keyPort() ?: refuse(ErrorCode.deviceKeysRequired, "Device keys are needed for the key ring; give the client a DeviceKeyPort.")
        val pub = try {
            unb64(keys.ensure().agreeKey, SyncHpke.ENC_BYTES)
        } catch (e: DeviceKeysUnreadableException) {
            refuse(ErrorCode.deviceKeysUnreadable, "The stored device keys cannot be opened.", e)
        }
        return pub ?: refuse(ErrorCode.deviceKeysInvalid, "The device agreement key is not usable.")
    }

    private suspend fun makeRing(path: String, withRecovery: Boolean): SyncCreatedRing {
        val agree = agreeKey()
        val root = SyncCrypto.random(SyncCrypto.ROOT_BYTES)
        val kid = SyncKeys.deriveKid(root)
        val ringId = "rg_" + Base64Url.encode(SyncCrypto.random(RING_ID_RANDOM))
        val epoch = 1
        val ref = SyncRecovery.RingRef(ringId, epoch, kid)
        val body = LinkedHashMap<String, JsonElement>()
        body["ringId"] = str(ringId)
        body["rootKid"] = str(hex(kid))
        body["wrap"] = JsonObject(wire.wireWrap(SyncHpke.wrapRoot(agree, wrapContext(ringId, epoch), kid, root)))
        val code = if (withRecovery) SyncRecovery.newCode() else null
        if (code != null) body["recovery"] = obj("ct" to str(Base64Url.encode(SyncRecovery.wrap(code, ref, root))))
        wire.send("POST", path, JsonObject(body))
        hold(HeldRoot(ringId, epoch, kid, root), store = true)
        ring = null
        return SyncCreatedRing(ringId, epoch, hex(kid), code?.let { SyncRecovery.encode(it) })
    }

    /** After a recovery: stores this device's own wrap. Never throws; false when it could not. */
    private suspend fun depositOwnWrap(): Boolean = try {
        putWrap(core.deviceId(), agreeKey())
        true
    } catch (ignored: PolarisException) {
        false
    }

    private companion object {
        const val RING_ID_RANDOM = 16
        val UNUSABLE = SyncUnlockResult.Locked(SyncUnlockResult.LockReason.UnusableWrap)
    }
}
