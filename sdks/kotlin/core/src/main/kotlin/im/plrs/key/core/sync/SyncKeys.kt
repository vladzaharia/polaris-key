// The key hierarchy of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10.2): every key is
// HKDF-SHA256 of a root or of a key below it. A label that scopes by name is followed by a NUL and
// then the UTF-8 name.

package im.plrs.key.core.sync

public object SyncKeys {
    /** The HKDF `info` labels, ASCII, without the NUL that scopes some of them. */
    public object Label {
        public const val KID: String = "pkey-sync/1 kid"
        public const val COLL: String = "pkey-sync/1 coll"
        public const val NAMES: String = "pkey-sync/1 names"
        public const val CHUNK_ID: String = "pkey-sync/1 chunk-id"
        public const val VALUE: String = "pkey-sync/1 value"
        public const val FILE: String = "pkey-sync/1 file"
        public const val CHUNK: String = "pkey-sync/1 chunk"
        public const val RECOVERY: String = "pkey-sync/1 recovery"
        public const val ADOPT: String = "pkey-sync/1 adopt"
    }

    /** The label, then (when [name] is given) a NUL and the UTF-8 name. */
    private fun info(label: String, name: String? = null): ByteArray = SyncCrypto.utf8(if (name == null) label else "$label\u0000$name")

    /** The `kid` of a root: in every envelope header, in the clear. */
    public fun deriveKid(root: ByteArray): ByteArray = SyncCrypto.hkdf(root, ByteArray(0), info(Label.KID), SyncCrypto.KID_BYTES)

    /** `K_coll(c)`: [collection] is `"$settings"` or the concrete collection name. */
    public fun deriveCollKey(root: ByteArray, collection: String): ByteArray =
        SyncCrypto.hkdf(root, ByteArray(0), info(Label.COLL, collection), SyncCrypto.KEY_BYTES)

    /** `K_names`: keys every blinded name. */
    public fun deriveNamesKey(root: ByteArray): ByteArray = SyncCrypto.hkdf(root, ByteArray(0), info(Label.NAMES), SyncCrypto.KEY_BYTES)

    /** `K_cid(c)`: keys the chunk ids of one collection. */
    public fun deriveChunkIdKey(root: ByteArray, collection: String): ByteArray =
        SyncCrypto.hkdf(root, ByteArray(0), info(Label.CHUNK_ID, collection), SyncCrypto.KEY_BYTES)

    /** `K_msg`: one key per value, from `K_coll` and a 16-byte salt. */
    public fun deriveValueKey(collKey: ByteArray, salt: ByteArray): ByteArray =
        SyncCrypto.hkdf(collKey, salt, info(Label.VALUE), SyncCrypto.KEY_BYTES)

    /** `K_file`: one key per file version, from `K_coll` and a 32-byte salt. */
    public fun deriveFileKey(collKey: ByteArray, salt: ByteArray): ByteArray = SyncCrypto.hkdf(collKey, salt, info(Label.FILE), SyncCrypto.KEY_BYTES)

    /** `K_chunk`: one key per chunk id (its 32 raw bytes are the salt). */
    public fun deriveChunkKey(collKey: ByteArray, chunkId: ByteArray): ByteArray =
        SyncCrypto.hkdf(collKey, chunkId, info(Label.CHUNK), SyncCrypto.KEY_BYTES)

    /** `K_rec`: the 16-byte recovery code is the key material and the `ringId` text is the salt. */
    public fun deriveRecoveryKey(code: ByteArray, ringId: String): ByteArray =
        SyncCrypto.hkdf(code, SyncCrypto.utf8(ringId), info(Label.RECOVERY), SyncCrypto.KEY_BYTES)

    /** `K_adopt`: wraps a foreign root after an account merge. */
    public fun deriveAdoptKey(root: ByteArray): ByteArray = SyncCrypto.hkdf(root, ByteArray(0), info(Label.ADOPT), SyncCrypto.KEY_BYTES)
}
