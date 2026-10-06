// A verified, resumable download to a file (notes/SDK-PARITY-PASS.md §3.6; Godot's
// `core/download.gd` the model): the bytes of a release build, checked against the size and
// SHA-256 the VERIFIED release record names before the file is handed back.
//
//   - It goes through `CoreContext.request`, so every request carries the `X-PKey-*` headers gated
//     delivery reads, the transport's redirect rules (the bearer never crosses a redirect, no
//     https → http) and local-only's refusal.
//   - Bounded memory: the body is read in `Range` windows of [DOWNLOAD_WINDOW] bytes, appended to
//     `<dest>.part`. A `.part` already there is resumed (`If-Range` with the ETag kept beside it);
//     a 200 starts over; a `Content-Range` that is not the window asked for is refused.
//   - `Accept-Encoding: identity`: compression breaks `Range`.
//   - Nothing is left at `dest` unless it verified: a size or SHA-256 mismatch deletes the `.part`
//     and throws `payload-mismatch`; the verified bytes are renamed into place.

package im.plrs.key.core

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest

/** At most this many bytes per request window. */
public const val DOWNLOAD_WINDOW: Int = 8 * 1024 * 1024

/** A verified download. */
public data class FetchedFile(val path: File, val size: Long, val sha256: String)

/**
 * Whether the device bearer may go to [url]: the control plane's own origin ([sameOrigin]), or the
 * bytes host discovery declares, which is the origin of its Distribution or Release `builds` template
 * (`dl.plrs.im`, the same Worker answering byte routes only; docs/security/THREAT-MODEL.md "the bytes
 * host"). Any other origin never sees the token.
 */
public suspend fun CoreContext.bearerAllowed(url: String): Boolean {
    if (sameOrigin(url, endpoints.baseUrl)) return true
    return listOf(ServiceSlug.distribution, ServiceSlug.release).any { slug ->
        discoveredEndpoint(slug, "builds")?.let { template ->
            // Only the origin matters: the placeholders are blanked so the template parses as a URL.
            expandTemplate(template.replace(Regex("\\{[^}]*\\}"), "_"), endpoints.baseUrl, emptyMap())?.let { sameOrigin(url, it) }
        } == true
    }
}

/**
 * Download [url] to [dest], verifying [size] and [sha256] (lowercase hex). [bearer] sends the device
 * token, but only where [bearerAllowed] holds: the control plane's origin or discovery's bytes host.
 * [onProgress] gets (bytes so far, [size]). Throws [PolarisException]: the Worker's code for a
 * refusal (`attestation_required`, `unauthorized`, `not_entitled`, …), `network-error`,
 * `payload-mismatch`.
 */
public suspend fun CoreContext.fetchVerified(
    url: String,
    dest: File,
    size: Long,
    sha256: String,
    bearer: Boolean = true,
    onProgress: ((Long, Long) -> Unit)? = null,
    window: Int = DOWNLOAD_WINDOW,
): FetchedFile {
    require(size >= 0 && window > 0)
    val part = File(dest.absoluteFile.parentFile, dest.name + ".part")
    // Private resume sidecar `<dest>.part.etag` (the ETag as plain text). Not a public format,
    // but the conformance TranscriptTest seeds it (with `.part`) to replay an interrupted fetch,
    // so a change here must change the replayer too.
    val etagFile = File(dest.absoluteFile.parentFile, dest.name + ".part.etag")
    dest.absoluteFile.parentFile?.let { if (!it.isDirectory && !it.mkdirs() && !it.isDirectory) throw PolarisException(ErrorCode.storeFailed, "cannot create $it") }
    var etag: String? = if (part.isFile) etagFile.takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null } else null
    if (etag == null) {
        part.delete()
        etagFile.delete()
    }
    val sendBearer = bearer && bearerAllowed(url)
    var offset = if (part.isFile) part.length() else 0L
    if (offset > size) {
        part.delete()
        offset = 0
    }
    onProgress?.invoke(offset, size)
    while (offset < size || (size == 0L && !part.isFile)) {
        val end = minOf(size, offset + window) - 1
        val headers = linkedMapOf("accept-encoding" to "identity")
        // The last window is open-ended (`bytes=<offset>-`, the resume release-fetch-gated.json
        // pins); the answer's Content-Range is still checked against the window below.
        if (size > 0) headers["range"] = if (end == size - 1) "bytes=$offset-" else "bytes=$offset-$end"
        if (offset > 0) etag?.let { headers["if-range"] = it }
        if (sendBearer) token()?.let { headers["authorization"] = "Bearer $it" }
        val response = try {
            request(url, headers = headers, timeoutSeconds = 120.0)
        } catch (e: PolarisException) {
            if (e.code == ErrorCode.localOnly) throw e
            throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
        }
        when (response.status) {
            206 -> {
                val range = response.header("content-range")?.let { Regex("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$").find(it.trim()) }
                val start = range?.groupValues?.get(1)?.toLongOrNull()
                val last = range?.groupValues?.get(2)?.toLongOrNull()
                if (start != offset || last == null || last > end || response.body.size.toLong() != last - start + 1) {
                    part.delete()
                    etagFile.delete()
                    throw PolarisException(ErrorCode.payloadMismatch, "the server answered another range than bytes=$offset-$end")
                }
                FileOutputStream(part, true).use { it.write(response.body) }
                offset += response.body.size
            }
            200 -> {
                // A server that ignores Range (or an If-Range that no longer matches) sends it all.
                if (response.body.size.toLong() > size) {
                    part.delete()
                    etagFile.delete()
                    throw PolarisException(ErrorCode.payloadMismatch, "the download is larger than the record says")
                }
                FileOutputStream(part, false).use { it.write(response.body) }
                offset = response.body.size.toLong()
                if (offset < size) {
                    part.delete()
                    etagFile.delete()
                    throw PolarisException(ErrorCode.payloadMismatch, "the download is shorter than the record says")
                }
            }
            416 -> if (offset >= size) break else {
                part.delete()
                etagFile.delete()
                offset = 0
                etag = null
                continue
            }
            else -> throw PolarisException(wireErrorCode(response.body) ?: ErrorCode.httpError, "the download answered HTTP ${response.status}.")
        }
        response.header("etag")?.let {
            etag = it
            etagFile.writeText(it)
        }
        onProgress?.invoke(offset, size)
        if (size == 0L) break
    }
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(part).use { input ->
        val buf = ByteArray(1 shl 16)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            digest.update(buf, 0, n)
        }
    }
    val got = digest.digest().joinToString("") { "%02x".format(it) }
    if (part.length() != size || !got.equals(sha256, ignoreCase = true)) {
        part.delete()
        etagFile.delete()
        throw PolarisException(ErrorCode.payloadMismatch, "the download does not match the record's size and SHA-256; nothing was kept")
    }
    dest.delete()
    if (!part.renameTo(dest)) throw PolarisException(ErrorCode.storeFailed, "the verified download could not be moved to $dest")
    etagFile.delete()
    return FetchedFile(dest, size, got)
}

/** A service's discovery endpoint by key (`builds`, `feed`, `appcast`, …); null when discovery has not named it. */
public suspend fun CoreContext.discoveredEndpoint(slug: ServiceSlug, key: String): String? =
    discoveryDocument()?.services?.get(slug)?.endpoints?.get(key)
