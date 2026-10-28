// Blinded names (WIRE-CONTRACT-V5 §13.10.3):
// `blind(kind, ctx, n) = "x:" + base64url(HMAC-SHA256(K_names, kind 0x00 ctx 0x00 n))`.
// The server compares blinded names by bytes and never learns the plaintext.

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url

public object SyncBlind {
    /** What a blinded name names; [wire] is the word the HMAC input carries. */
    public enum class Kind(public val wire: String) {
        Setting("setting"),
        Member("member"),
        Record("record"),
        Field("field"),
        Element("element"),
        ;

        public companion object {
            public fun fromWire(s: String): Kind? = entries.firstOrNull { it.wire == s }
        }
    }

    /** The prefix no declared key or collection name may carry. */
    public const val PREFIX: String = "x:"

    private const val SHAPE_LENGTH = 45

    /**
     * [ctx] is the declared setting key or collection name that scopes the name, [n] the person's
     * own name (an element is its canonical JSON, see [CanonicalJson]).
     */
    public fun blind(root: ByteArray, kind: Kind, ctx: String, n: String): String {
        val key = SyncKeys.deriveNamesKey(root)
        val mac = SyncCrypto.hmac(key, SyncCrypto.utf8("${kind.wire}\u0000$ctx\u0000$n"))
        return PREFIX + Base64Url.encode(mac)
    }

    /** True for the shape of a blinded name (`^x:[A-Za-z0-9_-]{43}$`). */
    public fun isBlindedName(s: String): Boolean = s.length == SHAPE_LENGTH && s.startsWith(PREFIX) &&
        s.substring(PREFIX.length).all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
}
