// @pkey-feature core.verify
//
// SP-50: the Ed25519 backend is chosen by RFC 8032's known answers, never by whether its classes
// load. Android 16's AndroidKeyStore KeyFactory loads and then refuses every valid signature; a
// backend that behaves like it is skipped, and Tink comes first on Android.
package im.plrs.key.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class Ed25519SelectionTest {
    /** A backend that loads and refuses everything, as AndroidKeyStore's Ed25519 KeyFactory does. */
    private object RefusesEverything : Ed25519Verifier {
        override val name = "refuses"
        override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray) = false
    }

    /** A backend that accepts everything: it must never be chosen. */
    private object AcceptsEverything : Ed25519Verifier {
        override val name = "accepts"
        override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray) = true
    }

    private object Throws : Ed25519Verifier {
        override val name = "throws"
        override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean = throw IllegalStateException("no provider")
    }

    @Test
    fun theRealBackendsPassTheKnownAnswers() {
        assertTrue("JCA", Ed25519.knownAnswer(JcaEd25519Verifier))
        assertTrue("Tink", Ed25519.knownAnswer(TinkEd25519Verifier))
    }

    @Test
    fun aBackendThatRefusesAcceptsOrThrowsFails() {
        assertFalse(Ed25519.knownAnswer(RefusesEverything))
        assertFalse(Ed25519.knownAnswer(AcceptsEverything))
        assertFalse(Ed25519.knownAnswer(Throws))
        assertFalse(Ed25519.knownAnswer(UnavailableEd25519Verifier))
    }

    @Test
    fun selectionSkipsABackendThatFailsAndFailsClosed() {
        assertSame(TinkEd25519Verifier, Ed25519.select(listOf(RefusesEverything, AcceptsEverything, TinkEd25519Verifier, JcaEd25519Verifier)))
        assertSame(JcaEd25519Verifier, Ed25519.select(listOf(Throws, JcaEd25519Verifier)))
        assertSame(UnavailableEd25519Verifier, Ed25519.select(listOf(RefusesEverything, AcceptsEverything, Throws)))
        assertSame(UnavailableEd25519Verifier, Ed25519.select(emptyList()))
    }

    @Test
    fun tinkComesFirstOnAndroidAndTheJcaElsewhere() {
        assertEquals(listOf("tink", "jca"), Ed25519.candidates(android = true).map { it.name })
        assertEquals(listOf("jca", "tink"), Ed25519.candidates(android = false).map { it.name })
        // This JVM has both; the default selection is the JCA, and it passed the known answers.
        assertSame(JcaEd25519Verifier, Ed25519.select(Ed25519.candidates(android = false)))
        assertSame(TinkEd25519Verifier, Ed25519.select(Ed25519.candidates(android = true)))
    }

    @Test
    fun theProcessDefaultIsAWorkingBackend() {
        // The default is chosen while the object initialises: the known answers must exist by then.
        assertTrue(Ed25519.verifier.name, Ed25519.knownAnswer(Ed25519.verifier))
    }
}
