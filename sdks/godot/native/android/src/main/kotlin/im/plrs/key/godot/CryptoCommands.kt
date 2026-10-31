package im.plrs.key.godot

import im.plrs.key.platform.PlatformCrypto
import im.plrs.key.platform.PlatformCryptoException

/**
 * The binary crypto entry of the Godot plugin (CC-14b.8, D-3, D-12): `byte[]` in, `byte[]` out, so a
 * key or a message never becomes a JSON string or base64 text. Every reply starts with a status byte:
 * [OK] then the result, or one byte alone: [REFUSED] (a tag that does not verify, an all-zero DH
 * output), [UNSUPPORTED] (X25519 below API 33) or [BAD_INPUT] (a length the op does not take). A caller
 * tells a valid empty message from a refusal by that byte. Lengths are checked here, at the plugin
 * boundary, before the platform call. Nothing is logged and no reply or exception carries input bytes.
 */
class CryptoCommands(private val crypto: PlatformCrypto = PlatformCrypto()) {
    val x25519Supported: Boolean get() = crypto.x25519Supported

    fun seal(key: ByteArray?, nonce: ByteArray?, aad: ByteArray?, plain: ByteArray?): ByteArray {
        if (key == null || nonce == null || aad == null || plain == null) return status(BAD_INPUT)
        return guarded { ok(crypto.aesGcmSeal(key, nonce, aad, plain)) }
    }

    fun open(key: ByteArray?, nonce: ByteArray?, aad: ByteArray?, sealed: ByteArray?): ByteArray {
        if (key == null || nonce == null || aad == null || sealed == null) return status(BAD_INPUT)
        return guarded { crypto.aesGcmOpen(key, nonce, aad, sealed)?.let { ok(it) } ?: status(REFUSED) }
    }

    fun x25519(privateKey: ByteArray?, peerPublic: ByteArray?): ByteArray {
        if (privateKey == null || peerPublic == null) return status(BAD_INPUT)
        return guarded { ok(crypto.x25519(privateKey, peerPublic)) }
    }

    fun x25519Public(privateKey: ByteArray?): ByteArray {
        if (privateKey == null) return status(BAD_INPUT)
        return guarded { ok(crypto.x25519Public(privateKey)) }
    }

    private fun guarded(block: () -> ByteArray): ByteArray = try {
        block()
    } catch (e: PlatformCryptoException) {
        status(
            when (e.reason) {
                PlatformCryptoException.DH_ZERO -> REFUSED
                PlatformCryptoException.UNSUPPORTED -> UNSUPPORTED
                else -> BAD_INPUT
            },
        )
    } catch (e: Exception) {
        // Unknown fault: refuse, and say nothing about the inputs.
        status(REFUSED)
    }

    private fun ok(body: ByteArray): ByteArray {
        val out = ByteArray(body.size + 1)
        out[0] = OK
        body.copyInto(out, 1)
        body.fill(0)
        return out
    }

    private fun status(b: Byte): ByteArray = byteArrayOf(b)

    companion object {
        const val OK: Byte = 1
        const val REFUSED: Byte = 0
        const val UNSUPPORTED: Byte = 2
        const val BAD_INPUT: Byte = 3
    }
}
