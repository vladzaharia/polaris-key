package im.plrs.key.platform

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * Facts about this build of polaris-key-platform. The flavour is fixed at build time: a `play`
 * build carries Play In-App Updates and Play Asset Delivery and no self-update code; a `direct`
 * build carries the verified PackageInstaller self-update and no Play Core library.
 */
public object PolarisKeyPlatform {
    /** The JSON command protocol the Godot binding speaks (bumped on an incompatible change). */
    public const val PROTOCOL: Int = 1

    public const val FLAVOR_PLAY: String = "play"
    public const val FLAVOR_DIRECT: String = "direct"

    /** `play` or `direct`. */
    public val flavor: String get() = BuildConfig.FLAVOR

    public val isPlay: Boolean get() = flavor == FLAVOR_PLAY
    public val isDirect: Boolean get() = flavor == FLAVOR_DIRECT
}

/** Lower-case hex SHA-256 helpers. */
public object Digests {
    public fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    public fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return hex(md.digest())
    }

    public fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    /** True for 64 lower- or upper-case hex characters. */
    public fun isSha256Hex(s: String?): Boolean =
        s != null && s.length == 64 && s.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    private val HEX = "0123456789abcdef".toCharArray()
}
