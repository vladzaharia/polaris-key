// Cloud Connect's two signed documents (WIRE-CONTRACT-V5 section 15.2, 15.3): the device
// certificate (`pkey-peer+jws`), the roster (`pkey-ring+jws`), roster replacement and peer
// admission. Pure functions over text and a clock; nothing here does I/O or throws. Both documents
// are signed by the product key and verified against the effective product set (section 1).
// Mirrors client-core's peer/cert.ts; the vectors are conformance/corpus/v2/cases.json
// (`peerCertCases`, `ringCases`, `peerAdmissionCases`). A failing check names the step that
// refused the document, in the order section 15.2 lists them.

package im.plrs.key.core

/** `PEER_CERT_SECONDS` and the other constants of section 15.1. */
public object PeerConstants {
    public const val PEER_CERT_SECONDS: Long = 604_800
    public const val MAX_PEER_CERT_SECONDS: Long = 604_800
    public const val PEER_CERT_RENEW_SECONDS: Long = 302_400
    public const val RING_SECONDS: Long = 604_800
    public const val MAX_RING_DEVICES: Int = 128
    public const val CLOCK_SKEW_SECONDS: Long = 300
}

/** One device's identity in a roster or a certificate. */
public data class PeerDeviceKeys(val deviceId: String, val signKey: String, val agreeKey: String)

/** A verified device certificate's claims. */
public data class PeerCert(
    val sub: String,
    val deviceId: String,
    val signKey: String,
    val agreeKey: String,
    val ringEpoch: Long,
    val issuedAt: Long,
    val expiresAt: Long,
)

/** A verified roster's claims. */
public data class Ring(
    val sub: String,
    val epoch: Long,
    val issuedAt: Long,
    val expiresAt: Long,
    val devices: List<PeerDeviceKeys>,
)

/** The step that refused a certificate (the corpus's `reason`), in section 15.2's order. */
public enum class PeerCertRefusal(public val wire: String) {
    jwsRejected("jws-rejected"),
    issuerOrAudience("issuer-or-audience"),
    integer("integer"),
    subjectOrDevice("subject-or-device"),
    keys("keys"),
    lifetime("lifetime"),
    clock("clock"),
    subMismatch("sub-mismatch"),
    ownDevice("own-device"),
    staticMismatch("static-mismatch"),
}

/** The check that refused a roster (the corpus's `reason`). */
public enum class RingRefusal(public val wire: String) {
    jwsRejected("jws-rejected"),
    issuerOrAudience("issuer-or-audience"),
    integer("integer"),
    subject("subject"),
    lifetime("lifetime"),
    devicesSize("devices-size"),
    device("device"),
    keys("keys"),
    unsorted("unsorted"),
    duplicateId("duplicate-id"),
    duplicateKey("duplicate-key"),
}

/** Why a new roster does not replace the held one (the corpus's `reason`). */
public enum class RingReplaceRefusal(public val wire: String) {
    newRejected("new-rejected"),
    otherProductOrSubject("other-product-or-subject"),
    epochNotHigher("epoch-not-higher"),
    newExpired("new-expired"),
}

/** Section 15.2 step 7: the Noise session a certificate is shown in. Mode `a` also names the verifier's own subject and device. */
public data class PeerSession(
    /** `a`, `v` or `p`. */
    val mode: String,
    /** The Noise remote static key, canonical base64url. */
    val remoteStatic: String,
    val ownSub: String? = null,
    val ownDeviceId: String? = null,
)

public sealed interface PeerCertResult {
    public data class Ok(val cert: PeerCert) : PeerCertResult
    public data class Refused(val reason: PeerCertRefusal) : PeerCertResult
}

public sealed interface RingResult {
    public data class Ok(val ring: Ring) : RingResult
    public data class Refused(val reason: RingRefusal) : RingResult
}

public sealed interface RingReplacement {
    public data class Replace(val ring: Ring) : RingReplacement
    public data class Keep(val reason: RingReplaceRefusal) : RingReplacement
}

/** Section 15.3 "Peer admission". [RingSync.request] means ask the peer for `RING`. */
public enum class RingSync(public val wire: String) { none("none"), request("request") }

public sealed interface PeerAdmission {
    public data class Admit(val cert: PeerCert, val ringSync: RingSync) : PeerAdmission
    public data class Refuse(val reason: String) : PeerAdmission {
        public companion object {
            public const val CERT_INVALID: String = "cert-invalid"
            public const val PEER_REVOKED: String = "peer_revoked"
        }
    }
}

public object Peer {
    private val SUB = Regex("^ps_[A-Za-z0-9_-]{22}$")
    private val DEVICE = Regex("^[A-Za-z0-9_-]{32}$")
    private val KEY = Regex("^[A-Za-z0-9_-]{43}$")

    /** A canonical base64url string of exactly 32 bytes, decoded; null otherwise. */
    private fun keyBytes(v: String?): ByteArray? {
        if (v == null || !KEY.matches(v)) return null
        return Base64Url.decodeStrict(v)?.takeIf { it.size == 32 }
    }

    /** Section 15.2 step 4 for one `(signKey, agreeKey)` pair. */
    public fun keysOk(signKey: String?, agreeKey: String?): Boolean {
        val s = keyBytes(signKey) ?: return false
        val a = keyBytes(agreeKey) ?: return false
        return Ed25519Strict.isAcceptablePoint(s) && !X25519Points.isLowOrder(a)
    }

    private fun intClaim(d: kotlinx.serialization.json.JsonObject, name: String, min: Long, nonWire: NonWireIntegers): Long? {
        val v = d[name].longValue ?: return null
        return if (wireInteger(v, "/$name", min, nonWire)) v else null
    }

    /** Section 15.2 steps 1 to 7, in order; the first failing step names the reason. */
    public fun verifyCert(
        jws: String,
        trust: TrustSet,
        expectedAud: String,
        now: Long = System.currentTimeMillis() / 1000,
        session: PeerSession? = null,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): PeerCertResult {
        fun fail(r: PeerCertRefusal) = PeerCertResult.Refused(r)
        val v = JwsVerifier.verify(jws, trust, JwsTyp.peer, requireTyp = true, verifier = verifier) ?: return fail(PeerCertRefusal.jwsRejected)
        val d = v.payload
        if (d["iss"].stringValue != POLARIS_ISSUER || d["aud"].stringValue != expectedAud) return fail(PeerCertRefusal.issuerOrAudience)
        val nw = v.nonWireIntegers
        val epoch = intClaim(d, "ringEpoch", 1, nw)
        val iat = intClaim(d, "issuedAt", 0, nw)
        val exp = intClaim(d, "expiresAt", 0, nw)
        if (epoch == null || iat == null || exp == null) return fail(PeerCertRefusal.integer)
        val sub = d["sub"].stringValue
        val deviceId = d["deviceId"].stringValue
        if (sub == null || !SUB.matches(sub) || deviceId == null || !DEVICE.matches(deviceId)) return fail(PeerCertRefusal.subjectOrDevice)
        val signKey = d["signKey"].stringValue
        val agreeKey = d["agreeKey"].stringValue
        if (!keysOk(signKey, agreeKey)) return fail(PeerCertRefusal.keys)
        if (exp - iat < 1 || exp - iat > PeerConstants.MAX_PEER_CERT_SECONDS) return fail(PeerCertRefusal.lifetime)
        val skew = PeerConstants.CLOCK_SKEW_SECONDS
        if (iat > saturatingAdd(now, skew) || now > saturatingAdd(exp, skew)) return fail(PeerCertRefusal.clock)
        if (session != null) {
            if (session.mode == "a") {
                if (sub != session.ownSub) return fail(PeerCertRefusal.subMismatch)
                if (deviceId == session.ownDeviceId) return fail(PeerCertRefusal.ownDevice)
            }
            if (agreeKey != session.remoteStatic) return fail(PeerCertRefusal.staticMismatch)
        }
        return PeerCertResult.Ok(PeerCert(sub, deviceId, signKey!!, agreeKey!!, epoch, iat, exp))
    }

    /** Section 15.3: the roster's own checks. The clock is a separate question ([ringExpired]). */
    public fun verifyRing(
        jws: String,
        trust: TrustSet,
        expectedAud: String,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): RingResult {
        fun fail(r: RingRefusal) = RingResult.Refused(r)
        val v = JwsVerifier.verify(jws, trust, JwsTyp.ring, requireTyp = true, verifier = verifier) ?: return fail(RingRefusal.jwsRejected)
        val d = v.payload
        if (d["iss"].stringValue != POLARIS_ISSUER || d["aud"].stringValue != expectedAud) return fail(RingRefusal.issuerOrAudience)
        val nw = v.nonWireIntegers
        val epoch = intClaim(d, "epoch", 1, nw)
        val iat = intClaim(d, "issuedAt", 0, nw)
        val exp = intClaim(d, "expiresAt", 0, nw)
        if (epoch == null || iat == null || exp == null) return fail(RingRefusal.integer)
        val sub = d["sub"].stringValue
        if (sub == null || !SUB.matches(sub)) return fail(RingRefusal.subject)
        val span = exp - iat
        if (span < 1 || span > PeerConstants.RING_SECONDS) return fail(RingRefusal.lifetime)
        val list = d["devices"].arrayValue
        if (list == null || list.size < 1 || list.size > PeerConstants.MAX_RING_DEVICES) return fail(RingRefusal.devicesSize)
        val devices = ArrayList<PeerDeviceKeys>(list.size)
        for (e in list) {
            val o = e.objectValue
            val id = o?.get("deviceId").stringValue
            if (o == null || id == null || !DEVICE.matches(id)) return fail(RingRefusal.device)
            val sk = o["signKey"].stringValue
            val ak = o["agreeKey"].stringValue
            if (!keysOk(sk, ak)) return fail(RingRefusal.keys)
            devices += PeerDeviceKeys(id, sk!!, ak!!)
        }
        // Device ids must ascend strictly: an equal neighbour is a duplicate, a lower one unsorted.
        for (k in 1 until devices.size) {
            val c = devices[k - 1].deviceId.compareTo(devices[k].deviceId)
            if (c == 0) return fail(RingRefusal.duplicateId)
            if (c > 0) return fail(RingRefusal.unsorted)
        }
        if (devices.map { it.signKey }.toSet().size != devices.size || devices.map { it.agreeKey }.toSet().size != devices.size) {
            return fail(RingRefusal.duplicateKey)
        }
        return RingResult.Ok(Ring(sub, epoch, iat, exp, devices))
    }

    /** Section 15.3: a roster is expired once `now > expiresAt + 300`, the certificate's clock rule. */
    public fun ringExpired(ring: Ring, now: Long = System.currentTimeMillis() / 1000): Boolean =
        now > saturatingAdd(ring.expiresAt, PeerConstants.CLOCK_SKEW_SECONDS)

    /** The held ring, or null when there is none, it does not verify or it is expired. */
    private fun liveRing(held: String?, trust: TrustSet, aud: String, now: Long, verifier: Ed25519Verifier): Ring? {
        if (held == null) return null
        val r = verifyRing(held, trust, aud, verifier) as? RingResult.Ok ?: return null
        return r.ring.takeUnless { ringExpired(it, now) }
    }

    /**
     * Section 15.3 "Held ring and replacement": the held ring is replaced only by a roster that
     * verifies, has the same `aud` and `sub`, a higher epoch and is not expired. An expired held ring
     * counts as no ring at all.
     */
    public fun replaceRing(
        heldJws: String?,
        newJws: String,
        trust: TrustSet,
        expectedAud: String,
        now: Long = System.currentTimeMillis() / 1000,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): RingReplacement {
        val next = (verifyRing(newJws, trust, expectedAud, verifier) as? RingResult.Ok)?.ring
            ?: return RingReplacement.Keep(RingReplaceRefusal.newRejected)
        val held = liveRing(heldJws, trust, expectedAud, now, verifier)
        if (held != null) {
            if (next.sub != held.sub) return RingReplacement.Keep(RingReplaceRefusal.otherProductOrSubject)
            if (next.epoch <= held.epoch) return RingReplacement.Keep(RingReplaceRefusal.epochNotHigher)
        }
        if (ringExpired(next, now)) return RingReplacement.Keep(RingReplaceRefusal.newExpired)
        return RingReplacement.Replace(next)
    }

    /** Section 15.3 "Peer admission" with certificate [certJws] against the held ring. */
    public fun admitPeer(
        certJws: String,
        heldRingJws: String?,
        trust: TrustSet,
        expectedAud: String,
        now: Long = System.currentTimeMillis() / 1000,
        session: PeerSession? = null,
        verifier: Ed25519Verifier = Ed25519.verifier,
    ): PeerAdmission {
        val c = verifyCert(certJws, trust, expectedAud, now, session, verifier) as? PeerCertResult.Ok
            ?: return PeerAdmission.Refuse(PeerAdmission.Refuse.CERT_INVALID)
        val ring = liveRing(heldRingJws, trust, expectedAud, now, verifier) ?: return PeerAdmission.Admit(c.cert, RingSync.none)
        // A certificate of another account is judged by the session's own checks, never by this
        // ring's epoch: its numbers belong to a different roster.
        if (c.cert.sub != ring.sub) return PeerAdmission.Refuse(PeerAdmission.Refuse.CERT_INVALID)
        if (ring.epoch > c.cert.ringEpoch) {
            val listed = ring.devices.contains(PeerDeviceKeys(c.cert.deviceId, c.cert.signKey, c.cert.agreeKey))
            return if (listed) PeerAdmission.Admit(c.cert, RingSync.none) else PeerAdmission.Refuse(PeerAdmission.Refuse.PEER_REVOKED)
        }
        return PeerAdmission.Admit(c.cert, if (c.cert.ringEpoch > ring.epoch) RingSync.request else RingSync.none)
    }
}
