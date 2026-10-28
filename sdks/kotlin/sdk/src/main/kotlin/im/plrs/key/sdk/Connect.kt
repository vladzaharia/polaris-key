// `client.connect` -- Cloud Connect's identity half (WIRE-CONTRACT-V5 section 15.2, 15.3, 15.4, 15.8;
// plans/CC-01-cloud-connect.md). On first need it makes this device's keys and registers them
// (`registerDeviceKeys`), fetches `GET /<p>/connect/identity` (the roster, this device's certificate
// and K_disc), verifies both documents against the effective product set, and keeps them as
// `pkey.connect.v1` beside the device keys. The LAN, TCP and relay halves follow in later slices and
// read this state. Mirrors Node's `client.connect` (packages/sdk-node/src/connect).
//
// Rules this file keeps:
//  - the keys never leave the `DeviceKeyPort`; a memory-only port refuses unless the host opts in
//    (`allowEphemeralKeys`), because every restart would be a key change and the Worker allows four
//    a day; an unreadable key record is an error, never replaced;
//  - a roster or certificate that does not verify is never stored. A roster that is expired, for
//    another subject or device, certifies other keys than this device's, or would replace the held
//    roster with a lower epoch (stale) or another subject (foreign) is refused, and what is held
//    stays;
//  - K_disc is stored exactly as the latest answer delivered it. The previous key is dropped when the
//    roster lost a device or changed a device's keys since the held one (the Worker drops it for a
//    leave; this is the same rule on the client), after a `leave()`, and 24 hours after it was first
//    seen;
//  - K_disc is held in the state record, which is written through the same file storage as the device
//    keys (owner-only, replaced atomically, sealed on Android), and it appears in no return value,
//    error or string except the bytes `discoveryKeys()` hands to the advert code.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreContext
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeysUnreadableException
import im.plrs.key.core.DeviceKeyUnsupportedException
import im.plrs.key.core.DevicePublicKeys
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.JsonText
import im.plrs.key.core.Peer
import im.plrs.key.core.PeerCert
import im.plrs.key.core.PeerCertResult
import im.plrs.key.core.PeerConstants
import im.plrs.key.core.PeerDeviceKeys
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.Ring
import im.plrs.key.core.RingResult
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.StoreException
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.defaultDeviceKeyStore
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.registerDeviceKeys
import im.plrs.key.core.stringValue
import im.plrs.key.core.wireRefusal
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The Worker keeps the previous K_disc for 24 hours after a bump (section 15.4). */
public const val PREV_DISC_KEY_SECONDS: Long = 86_400

/** The state record's schema tag and file name. */
public const val CONNECT_STATE_SCHEMA: String = "pkey.connect.v1"
public const val CONNECT_STATE_FILE: String = "pkey.connect.v1.json"

/** What the host may give Cloud Connect. */
public data class ConnectOptions @JvmOverloads constructor(
    /**
     * This device's keys. Default: [im.plrs.key.core.defaultDeviceKeyStore] over the client's state
     * directory (the 0600 file). Android has no default: pass `androidDeviceKeyStore(...)`.
     */
    val deviceKeys: DeviceKeyPort? = null,
    /** Allow a memory-only key store. Off by default: its keys die with the process, so every restart would register a new pair. */
    val allowEphemeralKeys: Boolean = false,
    /**
     * Where the held roster, certificate and K_disc live. Default: the 0600 file `pkey.connect.v1.json`
     * in the state directory. Android has no default: pass a Keystore-sealed [FileDeviceKeyStorage]
     * (`leave()` deletes the record with `deleteRecord()`, which never destroys a sealer key, so a sealer
     * shared with the device keys is safe).
     */
    val state: DeviceKeyStorage? = null,
)

/** What the host sees of the held identity. No K_disc, no private key. */
public data class ConnectIdentity(
    /** The pairwise subject (`ps_...`) the roster belongs to. */
    val sub: String,
    val deviceId: String,
    /** The roster's epoch. */
    val epoch: Long,
    /** Every device of the person: id and public keys. */
    val devices: List<PeerDeviceKeys>,
    /** This device's `pkey-peer+jws` (shown to peers in a handshake; not secret). */
    val certificate: String,
    val certificateExpiresAt: Long,
    /** The held `pkey-ring+jws` (sent to a peer that asks for `RING`). */
    val ring: String,
    val ringExpiresAt: Long,
)

/** One of the person's devices, display data only (`GET /<p>/connect/devices`). */
public data class ConnectDevice(
    val deviceId: String,
    val label: String?,
    val platform: String?,
    val lastSeen: Long?,
    val self: Boolean,
)

/** The discovery keys as bytes, newest first (section 15.4). A device advertises under [current] only. */
public class DiscoveryKeys internal constructor(public val current: ByteArray, public val previous: ByteArray?) {
    override fun toString(): String = "DiscoveryKeys(redacted)"
}

/** The `pkey.connect.v1` record. Never printed. */
internal class ConnectStateRecord(
    val product: String,
    val deviceId: String,
    val ring: String,
    val certificate: String,
    val discKeys: List<String>,
    val prevUntil: Long?,
    val epoch: Long,
    val registeredSign: String?,
    val registeredAgree: String?,
    val storedAt: Long,
) {
    override fun toString(): String = "ConnectStateRecord(redacted)"

    fun encode(): ByteArray = JsonObject(
        mapOf(
            "schema" to JsonPrimitive(CONNECT_STATE_SCHEMA),
            "product" to JsonPrimitive(product),
            "deviceId" to JsonPrimitive(deviceId),
            "ring" to JsonPrimitive(ring),
            "certificate" to JsonPrimitive(certificate),
            "discKeys" to JsonArray(discKeys.map { JsonPrimitive(it) }),
            "prevUntil" to (prevUntil?.let { jsonInt(it) } ?: JsonNull),
            "epoch" to jsonInt(epoch),
            "registered" to if (registeredSign != null && registeredAgree != null) {
                JsonObject(mapOf("signKey" to JsonPrimitive(registeredSign), "agreeKey" to JsonPrimitive(registeredAgree)))
            } else {
                JsonNull
            },
            "storedAt" to jsonInt(storedAt),
        ),
    ).toString().toByteArray(Charsets.UTF_8)

    companion object {
        private val KEY = Regex("^[A-Za-z0-9_-]{43}$")

        /** Strict parse; null when the bytes are not a record of this schema. */
        fun parse(raw: ByteArray): ConnectStateRecord? {
            val v = JsonText.parseOrNull(raw.toString(Charsets.UTF_8)).objectValue ?: return null
            if (v["schema"].stringValue != CONNECT_STATE_SCHEMA) return null
            val keys = v["discKeys"].arrayValue?.map { it.stringValue ?: return null } ?: return null
            if (keys.size !in 1..2 || !keys.all { KEY.matches(it) }) return null
            val prev = v["prevUntil"]
            val prevUntil = if (prev == null || prev is JsonNull) null else prev.longValue ?: return null
            val reg = v["registered"]
            var rs: String? = null
            var ra: String? = null
            if (reg != null && reg !is JsonNull) {
                val o = reg.objectValue ?: return null
                rs = o["signKey"].stringValue ?: return null
                ra = o["agreeKey"].stringValue ?: return null
            }
            return ConnectStateRecord(
                product = v["product"].stringValue ?: return null,
                deviceId = v["deviceId"].stringValue ?: return null,
                ring = v["ring"].stringValue ?: return null,
                certificate = v["certificate"].stringValue ?: return null,
                discKeys = keys,
                prevUntil = prevUntil,
                epoch = v["epoch"].longValue ?: return null,
                registeredSign = rs,
                registeredAgree = ra,
                storedAt = v["storedAt"].longValue ?: return null,
            )
        }
    }
}

/** An answer that is not in the contract's shape (`bad_response`), apart from one that fails verification. */
private fun malformed(reason: String): PolarisException =
    PolarisException(ErrorCode.badResponse, "The Cloud Connect identity was refused: $reason.")

private fun refuse(reason: String): PolarisException =
    PolarisException(ErrorCode.peerCertInvalid, "The Cloud Connect identity was refused: $reason.")

/** Cloud Connect's identity: `client.connect`. Every call is serialised. */
public class ConnectClient internal constructor(
    private val core: CoreContext,
    private val options: ConnectOptions = ConnectOptions(),
) {
    private val lock = Mutex()
    private var port: DeviceKeyPort? = options.deviceKeys
    private var storage: DeviceKeyStorage? = null

    override fun toString(): String = "ConnectClient"

    /** Use these device keys from now on. */
    public suspend fun useDeviceKeys(keys: DeviceKeyPort): Unit = lock.withLock {
        port = keys
        storage = null
    }

    // ── Public API ───────────────────────────────────────────────────────────────────────────

    /**
     * The held identity, fetching it first when none is held, when it is nearing its end (the
     * certificate has less than `PEER_CERT_RENEW_SECONDS` left, or the roster expired), when this
     * device's keys changed, or when [refresh] is set. Makes and registers the device keys on first
     * need. Throws [PolarisException]: `connect-unavailable` (Connect off here), `invalid-options` (a
     * memory-only key store the host did not allow), `no-token`, `device-keys-unreadable`, the
     * Worker's own refusals (`account_required`, `device_keys_required`, `ring_too_large`, ...) and
     * `peer-cert-invalid` for an answer that fails verification.
     */
    public suspend fun identity(refresh: Boolean = false): ConnectIdentity = lock.withLock { loadIdentity(refresh) }

    /**
     * The held identity as it stands, verified again now; null when none is held, it does not verify
     * any more or its roster expired. Sends nothing and makes no keys.
     */
    public suspend fun current(): ConnectIdentity? = lock.withLock {
        val held = load() ?: return@withLock null
        val v = verifyHeld(held)
        val ring = v.first
        val cert = v.second
        if (ring == null || cert == null || Peer.ringExpired(ring, core.now())) null else view(held, ring, cert)
    }

    /** `GET /<p>/connect/devices`: the person's devices, display data only. */
    public suspend fun listDevices(): List<ConnectDevice> = lock.withLock {
        available()
        requireToken()
        val p = usePort()
        registerIfNeeded(p, load())
        val body = get(core.endpoints.connectDevices, "connect devices")
        val list = JsonText.parseOrNull(body).objectValue?.get("devices").arrayValue
        if (list == null || list.size > PeerConstants.MAX_RING_DEVICES) throw malformed("the device list is not in the contract shape")
        list.map { d ->
            val o = d.objectValue
            val id = o?.get("deviceId").stringValue
            val self = o?.get("self").boolValue
            if (o == null || id == null || self == null) throw malformed("a device entry is not in the contract shape")
            ConnectDevice(id, o["label"].stringValue, o["platform"].stringValue, o["lastSeen"].longValue, self)
        }
    }

    /**
     * K_disc as bytes for the advert code (CC-12.2), or null when none is held. The previous key is
     * left out once 24 hours have passed since it was first seen.
     */
    public suspend fun discoveryKeys(): DiscoveryKeys? = lock.withLock {
        val held = load() ?: return@withLock null
        val prev = if (held.discKeys.size == 2 && held.prevUntil != null && core.now() < held.prevUntil) {
            Base64Url.decode(held.discKeys[1])
        } else {
            null
        }
        DiscoveryKeys(Base64Url.decode(held.discKeys[0])!!, prev)
    }

    /**
     * Forget the held roster, certificate and K_disc (sign-out, leaving the person's devices). The
     * device keys are untouched, and so is the Worker's roster.
     */
    public suspend fun leave(): Unit = lock.withLock {
        // Nothing held means nothing to forget, and sign-out must not depend on a store it never
        // used: no directory, lock file or Keystore call is made for an absent record.
        if (storage == null && options.state == null) {
            if (RuntimeFamily.isAndroid) return@withLock
            val dir = core.store.stateDirectory
            if (dir == null || !File(dir, CONNECT_STATE_FILE).exists()) return@withLock
        }
        try {
            val s = store()
            if (options.state != null && s.persistence == DeviceKeyPersistence.durable) {
                val held = try {
                    s.get()
                } catch (e: DeviceKeysUnreadableException) {
                    ByteArray(0) // present but unusable: still delete it
                }
                if (held == null) return@withLock
                held.fill(0)
            }
            // The record goes; a sealer shared with the device keys is never destroyed with it.
            // A record that cannot be deleted throws, and sign-out stops (fail closed).
            s.deleteRecord()
        } catch (e: StoreException) {
            throw storeError(e)
        } catch (e: DeviceKeysUnreadableException) {
            throw storeError(e)
        }
    }

    // ── Identity ─────────────────────────────────────────────────────────────────────────────

    private suspend fun loadIdentity(refresh: Boolean): ConnectIdentity {
        available()
        requireToken()
        val p = usePort()
        val mine = ensureKeys(p)
        val now = core.now()
        val held = load()
        val heldOk = held?.let { verifyHeld(it) }
        val heldRing = heldOk?.first
        val heldCert = heldOk?.second
        if (!refresh && held != null && heldRing != null && heldCert != null && fresh(held, heldRing, heldCert, mine, now)) {
            return view(held, heldRing, heldCert)
        }
        val registeredNow = registerIfNeeded(p, held)
        val text = try {
            get(core.endpoints.connectIdentity, "connect identity")
        } catch (e: PolarisException) {
            if (registeredNow || e.code != ErrorCode.deviceKeysRequired) throw e
            // The Worker forgot the keys (a purge): register once more and ask again.
            register(p)
            get(core.endpoints.connectIdentity, "connect identity")
        }
        val answer = parseAnswer(text)
        val accepted = accept(answer, mine, heldRing, held, now)
        try {
            store().put(accepted.first.encode())
        } catch (e: StoreException) {
            throw storeError(e)
        } catch (e: DeviceKeysUnreadableException) {
            throw storeError(e)
        }
        return accepted.second
    }

    private class Answer(val ring: String, val certificate: String, val discKeys: List<String>)

    private fun parseAnswer(text: String): Answer {
        val o = JsonText.parseOrNull(text).objectValue ?: throw malformed("the answer is not in the contract shape")
        val ring = o["ring"].stringValue
        val cert = o["certificate"].stringValue
        val keys = o["discKeys"].arrayValue?.map { it.stringValue ?: throw malformed("the answer is not in the contract shape") }
        if (ring == null || cert == null || keys == null || keys.size !in 1..2 ||
            !keys.all { validDiscKey(it) } || (keys.size == 2 && keys[0] == keys[1])
        ) {
            throw malformed("the answer is not in the contract shape")
        }
        return Answer(ring, cert, keys)
    }

    private fun validDiscKey(k: String): Boolean =
        k.length == 43 && Base64Url.decodeStrict(k)?.size == 32

    private fun sameDevice(a: PeerDeviceKeys, b: PeerDeviceKeys): Boolean = a == b

    /** Verify the answer and decide what to store. Throws `peer-cert-invalid` on any refusal; nothing is written before this returns. */
    private suspend fun accept(
        a: Answer,
        mine: DevicePublicKeys,
        priorRing: Ring?,
        held: ConnectStateRecord?,
        now: Long,
    ): Pair<ConnectStateRecord, ConnectIdentity> {
        val trust = core.trust()
        val aud = core.product
        val r = Peer.verifyRing(a.ring, trust, aud)
        val ring = (r as? RingResult.Ok)?.ring ?: throw refuse("the roster does not verify (${(r as RingResult.Refused).reason.wire})")
        val c = Peer.verifyCert(a.certificate, trust, aud, now)
        val cert = (c as? PeerCertResult.Ok)?.cert ?: throw refuse("the certificate does not verify (${(c as PeerCertResult.Refused).reason.wire})")
        if (Peer.ringExpired(ring, now)) throw refuse("the roster is expired")
        if (cert.sub != ring.sub) throw refuse("the certificate and roster name different subjects")
        if (cert.deviceId != core.deviceId()) throw refuse("the certificate is for another device")
        if (cert.signKey != mine.signKey || cert.agreeKey != mine.agreeKey) throw refuse("the certificate certifies other keys than this device's")
        if (cert.ringEpoch != ring.epoch) throw refuse("the certificate and roster are at different epochs")
        if (ring.devices.none { sameDevice(it, PeerDeviceKeys(cert.deviceId, cert.signKey, cert.agreeKey)) }) {
            throw refuse("this device is not in the roster")
        }

        // The held roster is replaced only by a newer one of the same subject (section 15.3). An
        // expired held roster counts as none. The same epoch may be refreshed, never changed.
        val prior = priorRing?.takeUnless { Peer.ringExpired(it, now) }
        if (prior != null) {
            if (prior.sub != ring.sub) throw refuse("the roster is for another subject")
            if (ring.epoch < prior.epoch) throw refuse("the roster is stale")
            if (ring.epoch == prior.epoch && ring.devices != prior.devices) throw refuse("the roster differs at the held epoch")
        }

        var keys = a.discKeys
        if (keys.size == 2 && prior != null && ring.epoch > prior.epoch) {
            // A leave, or a device that changed its keys, takes the previous key away (section 15.4).
            val intact = prior.devices.all { d -> ring.devices.any { sameDevice(it, d) } }
            if (!intact) keys = listOf(keys[0])
        }
        val sameEpochPrev = held != null && prior != null && prior.epoch == ring.epoch &&
            held.discKeys.size == 2 && keys.size == 2 && held.discKeys[1] == keys[1]
        val prevUntil = when {
            keys.size != 2 -> null
            sameEpochPrev && held!!.prevUntil != null -> held.prevUntil
            else -> now + PREV_DISC_KEY_SECONDS
        }
        val rec = ConnectStateRecord(
            product = core.product, deviceId = core.deviceId(), ring = a.ring, certificate = a.certificate,
            discKeys = keys, prevUntil = prevUntil, epoch = ring.epoch,
            registeredSign = mine.signKey, registeredAgree = mine.agreeKey, storedAt = now,
        )
        return rec to view(rec, ring, cert)
    }

    /** Whether the held identity can be used as it is. */
    private fun fresh(held: ConnectStateRecord, ring: Ring, cert: PeerCert, mine: DevicePublicKeys, now: Long): Boolean =
        held.registeredSign == mine.signKey && held.registeredAgree == mine.agreeKey &&
            cert.signKey == mine.signKey && cert.agreeKey == mine.agreeKey &&
            !Peer.ringExpired(ring, now) &&
            cert.expiresAt - now > PeerConstants.PEER_CERT_RENEW_SECONDS &&
            cert.ringEpoch == ring.epoch

    /** Each half of the held record verified on its own: a lapsed certificate must not cost the roster the next replacement is judged against. */
    private suspend fun verifyHeld(held: ConnectStateRecord): Pair<Ring?, PeerCert?> {
        val trust = core.trust()
        val aud = core.product
        val r = Peer.verifyRing(held.ring, trust, aud)
        val c = Peer.verifyCert(held.certificate, trust, aud, core.now())
        return (r as? RingResult.Ok)?.ring to (c as? PeerCertResult.Ok)?.cert
    }

    private fun view(rec: ConnectStateRecord, ring: Ring, cert: PeerCert): ConnectIdentity = ConnectIdentity(
        sub = ring.sub, deviceId = rec.deviceId, epoch = ring.epoch, devices = ring.devices,
        certificate = rec.certificate, certificateExpiresAt = cert.expiresAt, ring = rec.ring, ringExpiresAt = ring.expiresAt,
    )

    // ── Keys, state and transport ────────────────────────────────────────────────────────────

    /** Connect must be on for this product, per discovery when it is known. */
    private suspend fun available() {
        if (core.discoveryDocument() == null) {
            try {
                core.discover()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // An unreachable Worker is not "Connect is off": the call that follows says what is wrong.
            }
        }
        val doc = core.discoveryDocument() ?: return
        val f = doc.services[ServiceSlug.connect]
        fun off(detail: String): PolarisException {
            val u = Unsupported(Feature.connectIdentity, UnsupportedReason.product, detail)
            return PolarisException(ErrorCode.connectUnavailable, "The connect service is not enabled for ${core.product}.", detail = detail, unsupported = u)
        }
        if (f == null || !f.enabled) throw off("this product has Cloud Connect off")
        if (f.endpoints.isNotEmpty() && "identity" !in f.endpoints) throw off("this product's discovery names no connect identity endpoint")
    }

    private suspend fun usePort(): DeviceKeyPort {
        val p = port ?: run {
            if (RuntimeFamily.isAndroid) {
                throw PolarisException(ErrorCode.invalidOptions, "Pass ConnectOptions.deviceKeys (androidDeviceKeyStore) on Android.")
            }
            defaultDeviceKeyStore(core.store.stateDirectory).also { port = it }
        }
        if (p.persistence() == DeviceKeyPersistence.memory && !options.allowEphemeralKeys) {
            throw PolarisException(
                ErrorCode.invalidOptions,
                "The device keys are held in memory only, so every restart would register a new pair. Use a durable key store or set allowEphemeralKeys.",
            )
        }
        return p
    }

    private suspend fun ensureKeys(p: DeviceKeyPort): DevicePublicKeys = keysCall { p.ensure() }

    /** Register the port's keys unless the held record says this pair was already registered. True when a registration was sent. */
    private suspend fun registerIfNeeded(p: DeviceKeyPort, held: ConnectStateRecord?): Boolean {
        val mine = ensureKeys(p)
        if (held?.registeredSign == mine.signKey && held.registeredAgree == mine.agreeKey) return false
        register(p)
        return true
    }

    private suspend fun register(p: DeviceKeyPort) {
        core.registerDeviceKeys(p, options.allowEphemeralKeys)
    }

    private suspend fun <T> keysCall(block: suspend () -> T): T = try {
        block()
    } catch (e: DeviceKeysUnreadableException) {
        throw PolarisException(ErrorCode.deviceKeysUnreadable, "The stored device keys cannot be opened.", cause = e)
    } catch (e: DeviceKeyUnsupportedException) {
        throw PolarisException(ErrorCode.invalidOptions, "The device keys cannot be used here: ${e.message}", cause = e)
    } catch (e: StoreException) {
        throw PolarisException(ErrorCode.storeFailed, "The device keys could not be used: ${e.message}", cause = e)
    }

    private suspend fun requireToken(): String =
        core.token() ?: throw PolarisException(ErrorCode.noToken, "Register or sign in before using Cloud Connect.")

    /** One bearer GET; the body text, or the Worker's refusal as a typed exception. */
    private suspend fun get(url: String, what: String): String {
        val token = requireToken()
        val res: PolarisResponse = core.request(url, headers = mapOf("authorization" to "Bearer $token"))
        if (!res.isOk) throw wireRefusal(res, what)
        return res.text
    }

    private suspend fun store(): DeviceKeyStorage {
        storage?.let { return it }
        val s = options.state ?: run {
            if (RuntimeFamily.isAndroid) {
                throw PolarisException(ErrorCode.invalidOptions, "Pass ConnectOptions.state (a Keystore-sealed storage) on Android.")
            }
            val dir: File? = core.store.stateDirectory
            val memoryKeys = port?.persistence() == DeviceKeyPersistence.memory
            if (dir == null || memoryKeys) {
                InMemoryDeviceKeyStorage()
            } else {
                FileDeviceKeyStorage(File(dir, CONNECT_STATE_FILE), null, "pkey-connect-state/1".toByteArray(Charsets.UTF_8))
            }
        }
        storage = s
        return s
    }

    private suspend fun load(): ConnectStateRecord? {
        val raw = try {
            store().get()
        } catch (e: StoreException) {
            throw storeError(e)
        } catch (e: DeviceKeysUnreadableException) {
            throw storeError(e)
        } ?: return null
        try {
            val rec = ConnectStateRecord.parse(raw)
                ?: throw PolarisException(ErrorCode.storeFailed, "The Cloud Connect state record is unreadable; leave() clears it.")
            // A record for another product or device is not this device's state.
            return if (rec.product == core.product && rec.deviceId == core.deviceId()) rec else null
        } finally {
            raw.fill(0)
        }
    }

    private fun storeError(e: Exception): PolarisException =
        PolarisException(ErrorCode.storeFailed, "The Cloud Connect state could not be used: ${e.message}", cause = e)
}
