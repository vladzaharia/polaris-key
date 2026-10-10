// @pkey-feature license.signedinuser
//
// SP-54b: the signed-in user reader (V4 §3.2) is total over any `profile`. The corpus rows replay in
// :conformance (CorpusV2Test.licenseUserCases).

package im.plrs.key.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class LicenseUserTest {
    private val subject = "ps_" + "a".repeat(22)

    private fun profile(json: String): DocProfile = DocProfile.from(JsonText.parse(json))!!

    @Test
    fun aValidSubjectIsRead() {
        val p = profile("""{"name":"N","email":"h@x.io","user":{"subject":"$subject","extra":1}}""")
        assertEquals(SignedInUser(subject), licenseUser(p))
    }

    @Test
    fun malformedOrAbsentIsNull() {
        val bad = listOf(
            "null", "[]", "\"$subject\"", "{}", """{"subject":7}""",
            """{"subject":"ps_${"a".repeat(21)}"}""", """{"subject":"ps_${"a".repeat(23)}"}""",
            """{"subject":"$subject\n"}""", """{"subject":"ps_${"é".repeat(22)}"}""",
            """{"subject":"us_${"a".repeat(22)}"}""",
        )
        for (b in bad) assertNull(b, licenseUser(profile("""{"user":$b}""")))
        assertNull(licenseUser(profile("""{"email":"h@x.io"}""")))
        assertNull(licenseUser(null as LicenseDoc?))
    }

    @Test
    fun aKeyActivatedHolderEmailIsNotSignedIn() {
        val p = profile("""{"name":"N","email":"holder@x.io"}""")
        assertNotNull(p.email)
        assertNull(p.user)
    }
}
