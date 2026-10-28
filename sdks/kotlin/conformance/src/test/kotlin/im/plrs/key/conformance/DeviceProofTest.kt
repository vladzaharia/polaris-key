package im.plrs.key.conformance

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.DeviceProof
import im.plrs.key.core.DeviceProofFields
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.Ed25519
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.JcaDeviceCurves
import im.plrs.key.core.JsonText
import im.plrs.key.core.TinkDeviceCurves
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * device-proof.json (pkey-proof/1, CC-26.5): every case reaches its verdict, the message bytes are the
 * corpus's, and for every valid purpose the Kotlin signer builds the same bytes, signs them and the
 * result verifies, on the Ed25519 backend this run forces (JCA, then Tink).
 */
class DeviceProofTest : ConformanceSuite() {
    private val corpus = Corpus.v2("device-proof.json")
    private val cases = (corpus["cases"] as JsonArray).map { it as JsonObject }
    private fun s(o: JsonObject, k: String) = (o[k] as JsonPrimitive).content
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun proofOf(c: JsonObject) =
        DeviceProof(DeviceProofFields(s(c, "purpose"), s(c, "product"), s(c, "deviceId"), s(c, "value"), s(c, "tokenHash")), s(c, "signKey"), s(c, "sig"))

    @Test
    fun everyCaseReachesItsVerdictOnThisBackend() {
        val fails = Failures("device-proof")
        for (c in cases) {
            val got = DeviceProofs.verify(proofOf(c), (c["now"] as? JsonPrimitive)?.content?.toLong(), Corpus.verifier)
            fails.equal(s(c, "verdict") == "ok", got) { s(c, "id") }
        }
        fails.done(cases.size)
    }

    @Test
    fun theMessageBytesAreTheCorpusBytes() {
        val fails = Failures("device-proof")
        for (c in cases.filter { s(it, "verdict") == "ok" && it["messageHex"] != null }) {
            val msg = DeviceProofs.message(proofOf(c).fields)
            fails.check(msg != null && hex(msg) == s(c, "messageHex")) { "${s(c, "id")}: message bytes differ" }
        }
        fails.done(9)
    }

    @Test
    fun theKeysValueCasesMatch() {
        for (k in (corpus["keyValueCases"] as JsonArray).map { it as JsonObject }) {
            assertEquals(s(k, "value"), DeviceProofs.keysValue(s(k, "signKey"), s(k, "agreeKey"), s(k, "issuedAt").toLong()))
        }
    }

    @Test
    fun theSignerSignsEveryValidPurposeToTheCorpusMessageAndItVerifies() = runBlocking {
        val curves: DeviceCurves = if (Corpus.backend == "tink") TinkDeviceCurves else JcaDeviceCurves
        val store = DeviceKeyStore(InMemoryDeviceKeyStorage(), { curves })
        val valid = cases.filter { s(it, "verdict") == "ok" && s(it, "id").startsWith("valid-") }
        assertEquals(DeviceProofPurpose.entries.size, valid.size)
        for (c in valid) {
            val purpose = DeviceProofPurpose.fromWire(s(c, "purpose"))!!
            val now = (c["now"] as JsonPrimitive).content.toLong()
            val proof = if (purpose == DeviceProofPurpose.keys) {
                // The keys value names the signer's own keys: sign for the store's keys, at the corpus's clock.
                DeviceProofs.signKeysProof(store, s(c, "product"), s(c, "deviceId"), now, allowEphemeral = true, verifier = Corpus.verifier).proof
            } else {
                DeviceProofs.sign(store, purpose, s(c, "product"), s(c, "deviceId"), s(c, "value"), s(c, "tokenHash"), now, Corpus.verifier)
            }
            // Same line format as the corpus: only the key-dependent keys value differs.
            val msg = String(DeviceProofs.message(proof.fields)!!, Charsets.US_ASCII).split("\n")
            assertEquals(listOf("pkey-proof/1", s(c, "purpose"), s(c, "product"), s(c, "deviceId")), msg.take(4))
            assertEquals(s(c, "tokenHash"), msg[5])
            if (purpose != DeviceProofPurpose.keys) assertEquals(s(c, "value"), msg[4])
            assertTrue(s(c, "id"), DeviceProofs.verify(proof, now, Corpus.verifier))
            assertTrue(s(c, "id"), Ed25519.verifier.verify(Base64Url.decodeStrict(proof.signKey)!!, DeviceProofs.message(proof.fields)!!, Base64Url.decodeStrict(proof.sig)!!))
        }
    }
}
