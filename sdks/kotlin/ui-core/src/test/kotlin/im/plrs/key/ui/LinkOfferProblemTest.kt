// @pkey-feature identity.link
package im.plrs.key.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A failed Link keeps the link offer's screen and changes only its primary and its problem line. */
class LinkOfferProblemTest {
    private fun keys(problem: String?): List<String> =
        KitStates.resolve(KitComponent.signIn, linkStepInputs("link-offer", "Google", "global", problem)).copyKeys

    @Test
    fun noProblemIsThePlainOffer() {
        assertEquals(
            listOf("signin.linkOffer.bodyGlobal", "signin.linkOffer.decline", "signin.linkOffer.primary", "signin.linkOffer.title"),
            keys(null),
        )
    }

    @Test
    fun staleSwapsLinkForSignInAgain() {
        val k = keys("link-stale")
        assertTrue("signin.again" in k && "signin.linkOffer.stale" in k && "signin.linkOffer.title" in k)
        assertFalse("signin.linkOffer.primary" in k)
    }

    @Test
    fun aRefusedDeviceDropsLink() {
        val k = keys("link-failed")
        assertTrue("signin.linkOffer.failed" in k && "signin.linkOffer.decline" in k)
        assertFalse("signin.linkOffer.primary" in k)
    }

    @Test
    fun aLostConnectionKeepsLink() {
        val k = keys("network")
        assertTrue("signin.linkOffer.primary" in k && "core.codes.network.message" in k)
    }
}
