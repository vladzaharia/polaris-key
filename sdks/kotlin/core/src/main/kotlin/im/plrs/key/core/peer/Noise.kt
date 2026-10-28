// WIRE-CONTRACT-V5 section 15.5 and 15.6: the Noise engine of `pkey-peer/1` (CC-12.2). The Noise
// Protocol Framework (revision 34), patterns XX and XXpsk0 over 25519, AESGCM and SHA256, written
// over two ports: an AES-256-GCM `NoiseAead` and the X25519 of `DeviceCurves` (JCA, or Tink on
// Android API 24-32). It mirrors client-core's `peer/noise.ts`. Nothing here does I/O: bytes in,
// bytes out.
//
// The static X25519 private key never enters this file: a static operation is `NoiseStatic.dh`
// (R-6 G1), which a host backs with its `DeviceKeyPort`. Handshake and cipher secrets are wiped
// with `fill(0)` when a handshake dies or ends and when a cipher is wiped.
//
// A failure is a `NoiseException` whose `code` is all a caller may show or log; it carries no key,
// payload or ciphertext. After any failure a handshake is dead and refuses further use.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.DeviceCurvesSelection
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.X25519Points
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// -- Ports ---------------------------------------------------------------------------------------

/** AES-256-GCM with a 96-bit nonce and a 16-byte tag appended to the ciphertext. */
public interface NoiseAead {
    /** The ciphertext with its tag. */
    public fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray

    /** The plaintext, or null when the tag does not verify. */
    public fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, ciphertext: ByteArray): ByteArray?
}

/** [NoiseAead] on the JCA's `AES/GCM/NoPadding`. Every operation gets a fresh `Cipher`. */
public object JcaNoiseAead : NoiseAead {
    private const val TRANSFORM = "AES/GCM/NoPadding"

    private fun run(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray, data: ByteArray): ByteArray {
        val k = SecretKeySpec(key, "AES")
        // A new Cipher each time: a GCM Cipher refuses to reuse a (key, nonce) pair and is not shared.
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(mode, k, GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(data)
    }

    override fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray = try {
        run(Cipher.ENCRYPT_MODE, key, nonce, aad, plaintext)
    } catch (e: GeneralSecurityException) {
        throw NoiseException(NoiseErrorCode.bad_key)
    }

    override fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, ciphertext: ByteArray): ByteArray? = try {
        run(Cipher.DECRYPT_MODE, key, nonce, aad, ciphertext)
    } catch (e: GeneralSecurityException) {
        null
    }
}

/**
 * This side's static X25519 key. A host backs it with its device key port; the engine never sees
 * the private half.
 */
public interface NoiseStatic {
    /** The 32-byte public key. */
    public suspend fun publicKey(): ByteArray

    /** X25519 with the static private key; null when the key is refused or the output is unusable. */
    public suspend fun dh(remotePublic: ByteArray): ByteArray?
}

/** A [NoiseStatic] over a [DeviceKeyPort]'s agreement key (R-6 G1: the private key stays in the port). */
public fun DeviceKeyPort.noiseStatic(): NoiseStatic {
    val port = this
    return object : NoiseStatic {
        override suspend fun publicKey(): ByteArray =
            Base64Url.decodeStrict(port.ensure().agreeKey)?.takeIf { it.size == 32 } ?: throw NoiseException(NoiseErrorCode.bad_key)

        override suspend fun dh(remotePublic: ByteArray): ByteArray? = port.dh(remotePublic)

        override fun toString(): String = "NoiseStatic"
    }
}

/**
 * A [NoiseStatic] over a raw private key held here, for tests and for hosts with no port. The
 * caller owns [privateKey] and may wipe it; this keeps its own copy until [wipe].
 */
public class RawNoiseStatic(privateKey: ByteArray, private val curves: DeviceCurves = DeviceCurvesSelection.curves) : NoiseStatic {
    private val key: ByteArray = privateKey.copyOf()

    init {
        if (key.size != 32) throw NoiseException(NoiseErrorCode.bad_key)
    }

    override suspend fun publicKey(): ByteArray = curves.x25519(key, X25519Points.BASE) ?: throw NoiseException(NoiseErrorCode.bad_key)

    override suspend fun dh(remotePublic: ByteArray): ByteArray? = curves.x25519(key, remotePublic)

    /** Wipes this copy of the key. */
    public fun wipe() {
        key.fill(0)
    }

    override fun toString(): String = "RawNoiseStatic"
}

/** The ports of an engine: AES-256-GCM, X25519 for ephemeral keys, and randomness for them. */
public class NoisePorts(
    public val aead: NoiseAead = JcaNoiseAead,
    public val curves: DeviceCurves = DeviceCurvesSelection.curves,
    /** Random bytes for ephemeral keys. */
    public val random: (Int) -> ByteArray = defaultRandom,
) {
    public companion object {
        private val rng = SecureRandom()
        internal val defaultRandom: (Int) -> ByteArray = { n -> ByteArray(n).also { rng.nextBytes(it) } }
    }
}

// -- Errors --------------------------------------------------------------------------------------

public enum class NoiseErrorCode {
    /** A Noise message or record fails its tag (wrong key, PSK, prologue or tampering). */
    decrypt,

    /** A DH output is all zeros or refused (a low-order point). */
    dh_zero,

    /** A message is shorter than its tokens need, or longer than 65,535 bytes. */
    malformed,

    /** A call out of order, after the handshake ended, or after a failure. */
    state,

    /** The nonce counter is exhausted. */
    nonce_exhausted,

    /** A key or the PSK has the wrong length, or the backend refuses a key. */
    bad_key,
}

/** A Noise failure. The message is the code alone: no key, payload or ciphertext. */
public class NoiseException(public val code: NoiseErrorCode) : Exception("noise: ${code.name}")

/** A Noise message is at most 65,535 bytes (Noise section 3), and a TCP frame carries one (15.6). */
public const val NOISE_MAX_MESSAGE: Int = 65535
private const val TAG = 16

// -- Hash and KDF --------------------------------------------------------------------------------

private fun cat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) {
        p.copyInto(out, off)
        off += p.size
    }
    return out
}

private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

private fun isZero(b: ByteArray): Boolean = b.all { it.toInt() == 0 }

/** SHA-256 of the concatenation of [parts]. */
public fun sha256(vararg parts: ByteArray): ByteArray {
    val d = MessageDigest.getInstance("SHA-256")
    for (p in parts) d.update(p)
    return d.digest()
}

/** HMAC-SHA256. */
public fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    // A JCA key spec refuses an empty key; an empty HMAC key is HashLen zeros of padding, the same.
    val spec = SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256")
    mac.init(spec)
    return mac.doFinal(data)
}

/** HKDF-SHA256 (RFC 5869). An empty salt is HashLen zero bytes, as the RFC defines. */
public fun hkdfSha256(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
    val prk = hmacSha256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
    var t = ByteArray(0)
    val out = java.io.ByteArrayOutputStream()
    var i = 1
    while (out.size() < length) {
        t = hmacSha256(prk, cat(t, info, byteArrayOf(i.toByte())))
        out.write(t)
        i++
    }
    prk.fill(0)
    return out.toByteArray().copyOf(length)
}

// -- Protocol names, prologue, PSK (15.5) --------------------------------------------------------

/** The three channel modes of `pkey-peer/1`. */
public enum class PeerMode(public val wire: String) { a("a"), v("v"), p("p") }

/** The Noise protocol name of a mode: XXpsk0 for `a` (R-1), plain XX for `v` and `p`. */
public fun peerNoiseProtocol(mode: PeerMode): String = if (mode == PeerMode.a) "Noise_XXpsk0_25519_AESGCM_SHA256" else "Noise_XX_25519_AESGCM_SHA256"

/** `"pkey-peer/1" 0x00 slug 0x00 mode 0x00`. */
public fun peerPrologue(slug: String, mode: PeerMode): ByteArray =
    cat(utf8("pkey-peer/1"), byteArrayOf(0), utf8(slug), byteArrayOf(0), utf8(mode.wire), byteArrayOf(0))

/**
 * The mode-a PSK: HKDF-SHA256 with an empty salt, the 32-byte discovery key as the input keying
 * material and `"pkey-peer/1 psk" 0x00 slug` as info, 32 bytes out (V5 15.5 pins this order).
 */
public fun peerPsk(discKey: ByteArray, slug: String): ByteArray {
    if (discKey.size != 32) throw NoiseException(NoiseErrorCode.bad_key)
    return hkdfSha256(ByteArray(0), discKey, cat(utf8("pkey-peer/1 psk"), byteArrayOf(0), utf8(slug)), 32)
}

// -- CipherState ---------------------------------------------------------------------------------

private const val MAX_NONCE: Long = -1L // 2^64 - 1 as an unsigned counter

private fun noiseNonce(n: Long): ByteArray {
    val out = ByteArray(12)
    for (i in 0 until 8) out[11 - i] = (n ushr (8 * i)).toByte()
    return out
}

/**
 * One direction of the transport, or the handshake's cipher. Calls run one at a time under a
 * mutex, so two concurrent calls never share a nonce. A failed read does not advance the counter
 * (Noise 5.1).
 */
public class CipherState internal constructor(private var k: ByteArray?, private val aead: NoiseAead) {
    private var n: Long = 0L
    private val lock = Mutex()

    internal fun hasKey(): Boolean = k != null

    internal fun setKey(key: ByteArray) {
        k?.fill(0)
        k = key
        n = 0L
    }

    /** Encrypts [plaintext] under the next nonce; with no key, returns it unchanged. */
    public suspend fun encrypt(ad: ByteArray, plaintext: ByteArray): ByteArray = lock.withLock {
        val key = k ?: return@withLock plaintext
        if (n == MAX_NONCE) throw NoiseException(NoiseErrorCode.nonce_exhausted)
        if (plaintext.size + TAG > NOISE_MAX_MESSAGE) throw NoiseException(NoiseErrorCode.malformed)
        val nonce = noiseNonce(n)
        n++
        aead.seal(key, nonce, ad, plaintext)
    }

    /** Decrypts [ciphertext]; a failed tag throws `decrypt` and leaves the counter alone. */
    public suspend fun decrypt(ad: ByteArray, ciphertext: ByteArray): ByteArray = lock.withLock {
        val key = k ?: return@withLock ciphertext
        if (n == MAX_NONCE) throw NoiseException(NoiseErrorCode.nonce_exhausted)
        if (ciphertext.size < TAG || ciphertext.size > NOISE_MAX_MESSAGE) throw NoiseException(NoiseErrorCode.malformed)
        val pt = aead.open(key, noiseNonce(n), ad, ciphertext) ?: throw NoiseException(NoiseErrorCode.decrypt)
        n++
        pt
    }

    /** REKEY (Noise 4.2): `k = ENCRYPT(k, 2^64 - 1, "", zeros(32))[0..32]`. The counter stays. */
    public suspend fun rekey(): Unit = lock.withLock {
        val key = k ?: throw NoiseException(NoiseErrorCode.state)
        val out = aead.seal(key, noiseNonce(MAX_NONCE), ByteArray(0), ByteArray(32))
        key.fill(0)
        k = out.copyOf(32)
        out.fill(0)
    }

    /** Wipes the key. The cipher then passes data through, so a caller drops it. */
    public fun wipe() {
        k?.fill(0)
        k = null
    }

    override fun toString(): String = "CipherState"
}

/** The two directions of a finished handshake. */
public class NoiseTransport(public val send: CipherState, public val receive: CipherState) {
    /** Wipes both keys. */
    public fun wipe() {
        send.wipe()
        receive.wipe()
    }

    override fun toString(): String = "NoiseTransport"
}

// -- HandshakeState ------------------------------------------------------------------------------

public enum class NoiseRole { initiator, responder }

private enum class Token { e, s, ee, es, se, psk }

/** Message token lists of XX, initiator first. */
private val XX: List<List<Token>> = listOf(
    listOf(Token.e),
    listOf(Token.e, Token.ee, Token.s, Token.es),
    listOf(Token.s, Token.se),
)

/** What a handshake needs. */
public class NoiseHandshakeOptions(
    public val role: NoiseRole,
    /** `Noise_XX_25519_AESGCM_SHA256` or `Noise_XXpsk0_25519_AESGCM_SHA256`. */
    public val protocol: String,
    public val prologue: ByteArray,
    /** The 32-byte PSK; required exactly when the protocol is XXpsk0. */
    public val psk: ByteArray? = null,
    /** This side's static key. */
    public val staticKey: NoiseStatic,
    /** A fixed 32-byte ephemeral private key, for known-answer tests only. Default: random. */
    public val ephemeralKey: ByteArray? = null,
    public val ports: NoisePorts = NoisePorts(),
) {
    override fun toString(): String = "NoiseHandshakeOptions"
}

/**
 * One handshake. Alternate [writeMessage] and [readMessage] as the role dictates (the initiator
 * writes first); after the third message [transport] yields the two ciphers. Any thrown
 * [NoiseException] kills the handshake and wipes its secrets.
 */
public class NoiseHandshake(o: NoiseHandshakeOptions) {
    private val ports: NoisePorts = o.ports
    private val initiator: Boolean = o.role == NoiseRole.initiator
    private val usesPsk: Boolean
    private val psk: ByteArray?
    private val staticKey: NoiseStatic = o.staticKey
    private var e: ByteArray?
    private var re: ByteArray? = null
    private var rs: ByteArray? = null
    private var sPub: ByteArray? = null
    private var h: ByteArray
    private var ck: ByteArray
    private val cs: CipherState = CipherState(null, o.ports.aead)
    private var index = 0
    private var dead = false
    private val lock = Mutex()

    init {
        val m = Regex("^Noise_XX(psk0)?_25519_AESGCM_SHA256$").matchEntire(o.protocol) ?: throw NoiseException(NoiseErrorCode.state)
        usesPsk = m.groups[1] != null
        if (usesPsk != (o.psk != null)) throw NoiseException(NoiseErrorCode.bad_key)
        if (o.psk != null && o.psk.size != 32) throw NoiseException(NoiseErrorCode.bad_key)
        if (o.ephemeralKey != null && o.ephemeralKey.size != 32) throw NoiseException(NoiseErrorCode.bad_key)
        psk = o.psk?.copyOf()
        e = o.ephemeralKey?.copyOf()
        val name = utf8(o.protocol)
        h = if (name.size <= 32) name.copyOf(32) else sha256(name)
        ck = h.copyOf()
        h = sha256(h, o.prologue)
    }

    /** True once all three messages are written and read. */
    public val finished: Boolean get() = index == XX.size

    /** The peer's static public key, once its `s` token has been read. */
    public val remoteStatic: ByteArray? get() = rs?.copyOf()

    /** The handshake hash `h`: the channel binding, once finished. */
    public val handshakeHash: ByteArray
        get() {
            if (!finished) throw NoiseException(NoiseErrorCode.state)
            return h.copyOf()
        }

    private fun mixHash(data: ByteArray) {
        h = sha256(h, data)
    }

    private fun kdf(ikm: ByteArray, outputs: Int): List<ByteArray> {
        val temp = hmacSha256(ck, ikm)
        val o1 = hmacSha256(temp, byteArrayOf(1))
        val o2 = hmacSha256(temp, cat(o1, byteArrayOf(2)))
        val out = if (outputs == 2) listOf(o1, o2) else listOf(o1, o2, hmacSha256(temp, cat(o2, byteArrayOf(3))))
        temp.fill(0)
        return out
    }

    private fun mixKey(ikm: ByteArray) {
        val (nck, k) = kdf(ikm, 2)
        ck.fill(0)
        ck = nck
        cs.setKey(k)
    }

    private fun mixKeyAndHash(ikm: ByteArray) {
        val (nck, th, k) = kdf(ikm, 3)
        ck.fill(0)
        ck = nck
        mixHash(th)
        th.fill(0)
        cs.setKey(k)
    }

    private suspend fun encryptAndHash(pt: ByteArray): ByteArray {
        val ct = cs.encrypt(h, pt)
        mixHash(ct)
        return ct
    }

    private suspend fun decryptAndHash(ct: ByteArray): ByteArray {
        val pt = cs.decrypt(h, ct)
        mixHash(ct)
        return pt
    }

    private fun publicOfEphemeral(priv: ByteArray): ByteArray =
        ports.curves.x25519(priv, X25519Points.BASE)?.takeIf { it.size == 32 } ?: throw NoiseException(NoiseErrorCode.bad_key)

    /** One DH token. The backend may refuse a low-order point or return zeros; both abort (15.5). */
    private suspend fun dh(token: Token) {
        val mineIsStatic = when (token) {
            Token.ee -> false

            Token.es -> !initiator

            // es: initiator e with responder s
            else -> initiator // se: initiator s with responder e
        }
        val remoteIsStatic = when (token) {
            Token.ee -> false
            Token.es -> initiator
            else -> !initiator
        }
        val remote = (if (remoteIsStatic) rs else re) ?: throw NoiseException(NoiseErrorCode.state)
        if (remote.size != 32 || X25519Points.isLowOrder(remote)) throw NoiseException(NoiseErrorCode.dh_zero)
        val out = if (mineIsStatic) {
            staticKey.dh(remote)
        } else {
            ports.curves.x25519(e ?: throw NoiseException(NoiseErrorCode.state), remote)
        }
        if (out == null || out.size != 32 || isZero(out)) {
            out?.fill(0)
            throw NoiseException(NoiseErrorCode.dh_zero)
        }
        mixKey(out)
        out.fill(0)
    }

    private fun wipeSecrets() {
        e?.fill(0)
        e = null
        psk?.fill(0)
        ck.fill(0)
        cs.wipe()
    }

    private suspend fun <T> guard(turn: Boolean, fn: suspend () -> T): T = lock.withLock {
        if (dead || finished || initiator != turn) throw NoiseException(NoiseErrorCode.state)
        try {
            fn()
        } catch (err: Throwable) {
            dead = true
            wipeSecrets()
            throw when (err) {
                is NoiseException, is kotlinx.coroutines.CancellationException -> err
                else -> NoiseException(NoiseErrorCode.state)
            }
        }
    }

    private fun tokens(): List<Token> = if (index == 0 && usesPsk) listOf(Token.psk) + XX[0] else XX[index]

    /** Writes the next handshake message carrying [payload]. */
    public suspend fun writeMessage(payload: ByteArray): ByteArray = guard(index % 2 == 0) {
        var wire = ByteArray(0)
        for (t in tokens()) {
            when (t) {
                Token.psk -> mixKeyAndHash(psk!!)

                Token.e -> {
                    val eph = e ?: ports.random(32).also { e = it }
                    val pub = publicOfEphemeral(eph)
                    wire = cat(wire, pub)
                    mixHash(pub)
                    if (usesPsk) mixKey(pub)
                }

                Token.s -> {
                    val pub = sPub ?: staticKey.publicKey().also { sPub = it }
                    wire = cat(wire, encryptAndHash(pub))
                }

                else -> dh(t)
            }
        }
        wire = cat(wire, encryptAndHash(payload))
        if (wire.size > NOISE_MAX_MESSAGE) throw NoiseException(NoiseErrorCode.malformed)
        index++
        wire
    }

    /** Reads the next handshake message; returns its payload. */
    public suspend fun readMessage(message: ByteArray): ByteArray = guard(index % 2 == 1) {
        if (message.size > NOISE_MAX_MESSAGE) throw NoiseException(NoiseErrorCode.malformed)
        var off = 0
        for (t in tokens()) {
            when (t) {
                Token.psk -> mixKeyAndHash(psk!!)

                Token.e -> {
                    if (message.size < off + 32) throw NoiseException(NoiseErrorCode.malformed)
                    val r = message.copyOfRange(off, off + 32)
                    re = r
                    off += 32
                    mixHash(r)
                    if (usesPsk) mixKey(r)
                }

                Token.s -> {
                    val len = if (cs.hasKey()) 32 + TAG else 32
                    if (message.size < off + len) throw NoiseException(NoiseErrorCode.malformed)
                    rs = decryptAndHash(message.copyOfRange(off, off + len))
                    off += len
                }

                else -> dh(t)
            }
        }
        val payload = decryptAndHash(message.copyOfRange(off, message.size))
        index++
        payload
    }

    /**
     * The transport ciphers of a finished handshake: `send` for this side's writes, `receive` for
     * its reads. The handshake object is spent afterwards and its secrets are wiped.
     */
    public suspend fun transport(): NoiseTransport = lock.withLock {
        if (dead || !finished) throw NoiseException(NoiseErrorCode.state)
        dead = true
        val (k1, k2) = kdf(ByteArray(0), 2)
        val a = CipherState(k1, ports.aead)
        val b = CipherState(k2, ports.aead)
        wipeSecrets()
        if (initiator) NoiseTransport(a, b) else NoiseTransport(b, a)
    }

    override fun toString(): String = "NoiseHandshake"
}
