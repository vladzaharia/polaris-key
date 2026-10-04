// URL construction — the canonical route table, in one place. The four permanent server aliases
// exist for hosts that hard-coded them; this SDK does not use them.

package im.plrs.key.core

import java.net.URI

/** The two signed documents Core fetches, caches and floors; also the cache slice key (§4.1). */
public enum class DocumentSlice(public val wire: String) {
    license("license"),
    config("config"),
    ;

    public companion object {
        public fun of(wire: String?): DocumentSlice? = entries.firstOrNull { it.wire == wire }
    }
}

/** A validated base URL plus a product slug: everything needed to name any route. */
public class Endpoints(baseUrl: String, public val product: String) {
    /** Normalized, scheme-checked, trailing slashes stripped. */
    public val baseUrl: String

    init {
        val trimmed = baseUrl.replace(Regex("/+$"), "")
        val uri = try {
            URI(trimmed)
        } catch (e: Exception) {
            null
        }
        val scheme = uri?.scheme?.lowercase()
        val host = uri?.host?.lowercase()
        if (scheme == null || host == null) {
            throw PolarisException(ErrorCode.insecureBaseUrl, "baseUrl is not a valid URL: $baseUrl")
        }
        val loopback = scheme == "http" && host in LOOPBACK_HOSTS
        if (scheme != "https" && !loopback) {
            throw PolarisException(
                ErrorCode.insecureBaseUrl,
                "baseUrl must be https: (got $scheme://$host); plaintext http:// is only accepted for localhost/127.0.0.1.",
            )
        }
        this.baseUrl = trimmed
    }

    /** `<baseUrl>/<product>/<path>`; [path] is a literal from the table below. */
    public fun url(path: String): String = "$baseUrl/${segment(product)}/$path"

    public val discovery: String get() = url(".well-known/polaris.json")
    public val trustManifest: String get() = url(".well-known/polaris-trust.jws")
    public val jwks: String get() = url(".well-known/jwks.json")
    public val devicesRegister: String get() = url("devices/register")
    public val devicesReport: String get() = url("devices/report")
    public val devices: String get() = url("devices")

    public fun device(id: String): String = url("devices/${segment(id)}")

    public val licenseActivate: String get() = url("license/activate")
    public val licenseEnroll: String get() = url("license/enroll")
    public val licenseToken: String get() = url("license/token")
    public val licenseDeauthorize: String get() = url("license/deauthorize")
    public val licenseDocument: String get() = url("license/document")
    public val configDocument: String get() = url("config/document")
    public val configSchema: String get() = url("config/schema")

    /** The signed-document route for one cache slice. */
    public fun document(slice: DocumentSlice): String = when (slice) {
        DocumentSlice.license -> licenseDocument
        DocumentSlice.config -> configDocument
    }

    public companion object {
        private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1", "[::1]")

        /** Percent-escape ONE path segment: a `/` in a value can never introduce a segment. */
        public fun segment(raw: String): String {
            val out = StringBuilder()
            for (b in raw.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt() and 0xff
                val ch = c.toChar()
                val allowed = ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch in "-._~!$&'()*+,;=:@"
                if (allowed && c < 0x80) out.append(ch) else out.append('%').append("%02X".format(c))
            }
            return out.toString()
        }
    }
}
