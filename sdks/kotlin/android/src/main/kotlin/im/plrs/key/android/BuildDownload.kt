// Where the direct flavour's install driver downloads a build from (P6-12). Flavour-neutral so the
// umbrella wiring (PolarisKeyAndroid) is the same in both flavours; only the direct build uses it.

package im.plrs.key.android

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.bearerAllowed
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** Downloads one build into [dest]; throws on any failure. */
public fun interface BuildDownload {
    public suspend fun download(url: String, dest: File)
}

/**
 * [BuildDownload] over OkHttp with Core's headers; the device bearer goes only to the control
 * plane's own origin. Any answer but 200 fails; redirects to another origin carry no bearer.
 */
public class OkHttpBuildDownload(
    private val core: CoreContext,
    private val client: OkHttpClient = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build(),
) : BuildDownload {
    override suspend fun download(url: String, dest: File) {
        val headers = LinkedHashMap(core.headers())
        if (core.bearerAllowed(url)) core.token()?.let { headers["authorization"] = "Bearer $it" }
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(url).apply { for ((k, v) in headers) header(k, v) }.build()
            client.newCall(req).execute().use { res ->
                if (res.code != 200) throw PolarisException(ErrorCode.httpError, "the build download answered ${res.code}")
                val body = res.body ?: throw PolarisException(ErrorCode.invalidResponse, "the build download has no body")
                dest.outputStream().use { out -> body.byteStream().copyTo(out, 1 shl 16) }
            }
        }
    }
}
