// @pkey-feature license.manage
// PX-W8: the refusal link helpers (WIRE-CONTRACT-V4 §5.3). The same table as client-core's
// `test/manage.test.ts`, so the links a Kotlin host builds are byte-identical to every other SDK's.

package im.plrs.key.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ManageLinkTest {
    private val free = "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64"
    private val activate = "https://key.plrs.im/activate?product=djdl"

    @Test
    fun readKeepsOnlyValidLinks() {
        val cases = listOf(
            Triple("a free-device link", listOf(free, null), free),
            Triple("an activate link", listOf(activate, null), activate),
            Triple(
                "a loopback http link",
                listOf("http://localhost:8787/activate?product=djdl", null),
                "http://localhost:8787/activate?product=djdl",
            ),
            Triple("a nested member", listOf(null, free), free),
            Triple("javascript:", listOf("javascript:alert(1)", null), null),
            Triple("plain http", listOf("http://key.plrs.im/activate", null), null),
            Triple("userinfo", listOf("https://user:pw@key.plrs.im/activate", null), null),
            Triple("relative", listOf("/activate?product=djdl", null), null),
            Triple("no //", listOf("https:key.plrs.im/activate", null), null),
            Triple("a backslash in the authority", listOf("https://key.plrs.im\\@evil.example/activate", null), null),
            Triple("a backslash as a separator", listOf("https://key.plrs.im\\evil/activate", null), null),
            Triple("whitespace", listOf("https://key.plrs.im/a b", null), null),
            Triple("absent", listOf(null, null), null),
        )
        for ((name, candidates, want) in cases) {
            assertEquals(name, want, ManageLink.read(*candidates.toTypedArray()))
        }
    }

    @Test
    fun readDropsAnOverlongLink() {
        assertEquals(2048, ManageLink.MAX_LENGTH)
        val base = "https://key.plrs.im/activate?product="
        val exact = base + "a".repeat(ManageLink.MAX_LENGTH - base.length)
        assertTrue(ManageLink.isValid(exact))
        assertNull(ManageLink.read(exact + "a"))
    }

    @Test
    fun withReturn() {
        assertEquals(
            "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64&return=myapp%3A%2F%2Fdone",
            ManageLink.withReturn(free, "myapp://done"),
        )
        assertEquals(
            "https://key.plrs.im/activate?product=djdl&return=https%3A%2F%2Fapp.example%2Fa+b",
            ManageLink.withReturn(activate, "https://app.example/a b"),
        )
        assertEquals("https://key.plrs.im/activate?product=djdl&return=x#key=k", ManageLink.withReturn("$activate#key=k", "x"))
        assertEquals(
            "https://key.plrs.im/#/p/djdl/free-device?return=new",
            ManageLink.withReturn("https://key.plrs.im/#/p/djdl/free-device?return=old", "new"),
        )
        assertEquals(
            "https://key.plrs.im/#/p/djdl/free-device?return=new",
            ManageLink.withReturn("https://key.plrs.im/#/p/djdl/free-device", "new"),
        )
        assertEquals("javascript:alert(1)", ManageLink.withReturn("javascript:alert(1)", "x"))
        assertEquals(free, ManageLink.withReturn(free, ""))
    }

    @Test
    fun withKey() {
        assertEquals(
            "https://key.plrs.im/activate?product=djdl#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
            ManageLink.withKey(activate, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"),
        )
        assertEquals(
            "https://key.plrs.im/activate?product=djdl&next=free-device#key=k+y",
            ManageLink.withKey("https://key.plrs.im/activate?product=djdl&next=free-device#key=old", "k y"),
        )
        assertEquals(free, ManageLink.withKey(free, "pkey_x"))
        assertEquals("https://key.plrs.im/signin?product=djdl", ManageLink.withKey("https://key.plrs.im/signin?product=djdl", "k"))
        assertEquals("javascript:alert(1)", ManageLink.withKey("javascript:alert(1)", "k"))
        assertEquals(activate, ManageLink.withKey(activate, ""))
    }

    @Test
    fun formEncode() {
        assertEquals("aZ09*-._+%7E%2F%3A%C3%A9", ManageLink.formEncode("aZ09*-._ ~/:é"))
    }
}
