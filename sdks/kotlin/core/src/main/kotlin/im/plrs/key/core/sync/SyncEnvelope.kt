// `pkey-sync-value/1` (WIRE-CONTRACT-V5 §13.10.4): one sealed setting, record, member, field or
// element value.
//
//   0x01 | kid(16) | salt(16) | AES-256-GCM(K_msg, nonce 0x00*12, aad = the first 33 bytes, P)
//
// `P` is the UTF-8 canonical JSON `{"k": name, "v": value}` padded with 0x80 then zeros to a
// multiple of 64 bytes (at least one byte of padding).

package im.plrs.key.core.sync

import im.plrs.key.core.JsonSyntaxException
import im.plrs.key.core.JsonText
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

public object SyncEnvelope {
    public const val VERSION: Int = 0x01

    /** Version, kid and salt: the associated data. */
    public const val HEADER_BYTES: Int = 33

    /** Header and tag. */
    public const val FIXED_BYTES: Int = 49

    public const val PAD_BLOCK: Int = 64

    /** Fixed bytes and at most one block of padding. */
    public const val OVERHEAD_BYTES: Int = 113

    private const val PAD_MARK = 0x80
    private const val BYTE_MASK = 0xff
    private const val MEMBERS = 2

    /** Why a reader refuses an envelope, in the order it checks. [wire] is the corpus word. */
    public enum class Invalid(public val wire: String) {
        Shape("shape"),
        Version("version"),
        Kid("kid"),
        Auth("auth"),
        Padding("padding"),
        Json("json"),
        Name("name"),
    }

    /** The result of an open. An opened value is the person's data: nothing prints it. */
    public sealed class Opened {
        public class Ok(public val name: String, public val value: JsonElement) : Opened() {
            override fun toString(): String = "SyncEnvelope.Opened.Ok(name=$name, value=<redacted>)"
        }

        public class Refused(public val reason: Invalid) : Opened() {
            override fun toString(): String = "SyncEnvelope.Opened.Refused(${reason.wire})"
        }
    }

    private fun pad(p: ByteArray): ByteArray {
        val total = (p.size / PAD_BLOCK) * PAD_BLOCK + PAD_BLOCK
        val out = ByteArray(total)
        p.copyInto(out)
        out[p.size] = PAD_MARK.toByte()
        return out
    }

    /** The bytes before the padding, or null when the padding is not `0x80` and zeros. */
    private fun unpad(p: ByteArray): ByteArray? {
        var end = p.size
        while (end > 0 && p[end - 1].toInt() == 0) end--
        if (end == 0 || (p[end - 1].toInt() and BYTE_MASK) != PAD_MARK) return null
        return p.copyOf(end - 1)
    }

    /**
     * Seals [value] under [name] in [collection]. [salt] (16 bytes) is fresh randomness unless a
     * test fixes it. Throws [SyncCryptoException] for a value canonical JSON refuses.
     */
    public fun seal(
        root: ByteArray,
        collection: String,
        name: String,
        value: JsonElement,
        salt: ByteArray = SyncCrypto.random(SyncCrypto.VALUE_SALT_BYTES),
    ): ByteArray {
        if (salt.size != SyncCrypto.VALUE_SALT_BYTES) throw SyncCryptoException("bad salt length")
        val kid = SyncKeys.deriveKid(root)
        val key = SyncKeys.deriveValueKey(SyncKeys.deriveCollKey(root, collection), salt)
        val header = SyncCrypto.cat(byteArrayOf(VERSION.toByte()), kid, salt)
        val p = pad(CanonicalJson.encodeBytes(JsonObject(mapOf("k" to JsonPrimitive(name), "v" to value))))
        return SyncCrypto.cat(header, SyncCrypto.aesGcmSeal(key, header, p))
    }

    /**
     * Opens an envelope for [name] (or one of its [aliases]) in [collection]. The checks run in
     * the order of [Invalid]; the kid is checked before any decryption so a caller can look for
     * another root. A match on an alias answers that alias as the name.
     */
    public fun open(root: ByteArray, collection: String, name: String, envelope: ByteArray, aliases: List<String> = emptyList()): Opened =
        openEnvelope(root, collection, envelope) { it == name || it in aliases }

    /**
     * Opens an envelope whose name the caller does not know yet (a blinded open key or merge
     * member: the name is inside). It answers the envelope's own `k`. The caller MUST check that
     * `k` is the name it expected before it trusts the value.
     */
    public fun openAnyName(root: ByteArray, collection: String, envelope: ByteArray): Opened = openEnvelope(root, collection, envelope) { true }

    /** A refusal, thrown inside [openEnvelope] so its checks read in order. */
    private class Refusal(val reason: Invalid) : Exception()

    private fun refuse(reason: Invalid): Nothing = throw Refusal(reason)

    private fun openEnvelope(root: ByteArray, collection: String, env: ByteArray, accepts: (String) -> Boolean): Opened = try {
        val n = env.size
        if (n < FIXED_BYTES + PAD_BLOCK || (n - FIXED_BYTES) % PAD_BLOCK != 0) refuse(Invalid.Shape)
        if ((env[0].toInt() and BYTE_MASK) != VERSION) refuse(Invalid.Version)
        val kid = SyncKeys.deriveKid(root)
        if (!SyncCrypto.equalBytes(kid, env.copyOfRange(1, 1 + SyncCrypto.KID_BYTES))) refuse(Invalid.Kid)

        val header = env.copyOfRange(0, HEADER_BYTES)
        val salt = env.copyOfRange(1 + SyncCrypto.KID_BYTES, HEADER_BYTES)
        val key = SyncKeys.deriveValueKey(SyncKeys.deriveCollKey(root, collection), salt)
        val padded = SyncCrypto.aesGcmOpen(key, header, env.copyOfRange(HEADER_BYTES, n)) ?: refuse(Invalid.Auth)
        val body = unpad(padded) ?: refuse(Invalid.Padding)
        val (name, value) = parseBody(body) ?: refuse(Invalid.Json)
        if (!accepts(name)) refuse(Invalid.Name)
        Opened.Ok(name, value)
    } catch (r: Refusal) {
        Opened.Refused(r.reason)
    }

    private fun decodeUtf8(body: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(body)).toString()
    } catch (ignored: CharacterCodingException) {
        null
    }

    private fun parseBody(body: ByteArray): Pair<String, JsonElement>? {
        val o = try {
            decodeUtf8(body)?.let { JsonText.parse(it) } as? JsonObject
        } catch (ignored: JsonSyntaxException) {
            null
        }
        val k = o?.get("k")
        val v = o?.get("v")
        val shaped = o != null && o.size == MEMBERS && k is JsonPrimitive && k.isString && v != null
        return if (shaped) k.stringValue!! to v else null
    }
}
