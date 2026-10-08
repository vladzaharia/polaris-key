// The Release sub-client — the software TRUTH store's public face (D-05). A port of Swift's
// `ReleaseClient`, the same surface as `@polaris-key/node`'s and `polaris_key`'s release clients
// (pinned by the release-changelog transcripts).
//
// Release owns what the software is and where it comes from: the changelog, the install script,
// the artifacts and the signed release record. Update owns the FEED over it (P6-08). The changelog
// and the URLs are public GETs with no signed document and so no verification: a release note is
// not a grant. When Release's access mode is `entitled` (D-13) the server refuses without a usable
// licence; this client forwards the bearer when one is held and reports a refusal by the body's own
// code rather than inventing a retry.
//
// The release RECORD (`pkey-release+jws`) is verified against the keys the APP pins, never a
// product key; the verifier is :core's `verifyReleaseRecord` (the update engine uses it too).
//
// Every verb refuses with `service-unavailable` when the product does not run Release: a client
// that has not been told the service exists must not probe for it (D-21).

package im.plrs.key.release

import im.plrs.key.core.CoreContext
import im.plrs.key.core.FetchedFile
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.UpdateEvent
import im.plrs.key.core.attestAndRetry
import im.plrs.key.core.discoveredEndpoint
import im.plrs.key.core.expandTemplate
import im.plrs.key.core.fetchVerified
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyReleaseRecordResult
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyReleaseRecord
import kotlinx.serialization.json.JsonElement

/** One published release, as `GET /<p>/release/changelog` reports it. */
public data class ChangelogEntry(
    val version: String,
    val tag: String,
    /** ISO-8601 publication time, or null for an undated release. */
    val date: String?,
    /** The curated summary, or null when the release body yielded none. */
    val summary: String?,
    val url: String,
)

/** What `fetch()` downloads: one build of a release, by the record that pins it. */
public sealed interface ReleaseTarget {
    /** A `binary` update decision: its release (version and record hash) and build. */
    public data class FromDecision(val decision: UpdateDecision.Binary) : ReleaseTarget

    /** A build named by version, build id and the lowercase hex SHA-256 of its release record. */
    public data class Build(val version: String, val buildId: String, val recordSha256: String) : ReleaseTarget

    /** A record the caller already verified, and the build in it. */
    public data class Record(val record: ReleaseRecordDoc, val buildId: String) : ReleaseTarget
}

/**
 * @param records the VERIFIED release record by its SHA-256 (the facade wires
 *   `update.releaseRecord(sha).record`, which verifies against the app's pinned release keys only).
 *   Null: `fetch()` takes a [ReleaseTarget.Record] only.
 */
public class ReleaseClient(
    private val core: CoreContext,
    private val records: (suspend (String) -> ReleaseRecordDoc)? = null,
    /** §3.10's attest-and-retry for gated delivery; null: an `attestation_required` refusal stands. */
    private val attest: (suspend () -> Boolean)? = null,
) {
    /**
     * Download one build and verify it (notes/SDK-PARITY-PASS.md §3.6): the verified record names
     * exactly one `payload` artifact for the build; its bytes stream from discovery's builds
     * template (Distribution's, else Release's) with the device bearer and the `X-PKey-*` headers
     * gated delivery reads, resume with `Range`/`If-Range`, and are checked against the artifact's
     * size and SHA-256 before anything is left at [to]. Journals `update_downloaded`.
     *
     * Throws [PolarisException]: `record-mismatch` (no such build, or not one payload),
     * `service-unavailable` (discovery names no builds route), the Worker's refusal code,
     * `network-error`, `payload-mismatch`.
     */
    public suspend fun fetch(target: ReleaseTarget, to: java.io.File, onProgress: ((Long, Long) -> Unit)? = null): FetchedFile = io {
        core.requireService(ServiceSlug.release, Feature.releaseDownload)
        val (record, buildId, version) = when (target) {
            is ReleaseTarget.Record -> Triple(target.record, target.buildId, target.record.version)
            is ReleaseTarget.Build -> Triple(recordOf(target.recordSha256), target.buildId, target.version)
            is ReleaseTarget.FromDecision -> {
                val sha = target.decision.release.sha256 ?: throw PolarisException(ErrorCode.recordMismatch, "the decision pins no release record")
                Triple(recordOf(sha), target.decision.build, target.decision.release.version)
            }
        }
        val artifact = record.builds?.firstOrNull { it.id == buildId }?.artifacts?.filter { it.role == "payload" }?.singleOrNull()
            ?: throw PolarisException(ErrorCode.recordMismatch, "the verified record has no build '$buildId' with one payload")
        if (core.discoveryDocument() == null && !core.localOnly) {
            try {
                core.discover()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // Falls to the refusal below.
            }
        }
        val template = core.discoveredEndpoint(ServiceSlug.distribution, "builds") ?: core.discoveredEndpoint(ServiceSlug.release, "builds")
            ?: throw PolarisException(ErrorCode.serviceUnavailable, "discovery names no builds route for this product")
        val url = expandTemplate(template, core.endpoints.baseUrl, mapOf("selector" to version, "buildId" to buildId))
            ?: throw PolarisException(ErrorCode.serviceUnavailable, "the builds template does not expand")
        val fetched = attestAndRetry(attest) { core.fetchVerified(url, to, artifact.size, artifact.sha256.lowercase(), bearer = true, onProgress = onProgress) }
        // Named by the record's tag when it has one, else the version (the Worker's releaseId).
        core.updateEvents.record(UpdateEvent.updateDownloaded, im.plrs.key.core.releaseId(version, record.tag), fromRelease = core.version)
        return@io fetched
    }

    /** SP-50: `fetch` journals and writes files; it runs on `Dispatchers.IO`. */
    private suspend inline fun <T> io(crossinline block: suspend () -> T): T =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { block() }

    private suspend fun recordOf(sha256: String): ReleaseRecordDoc {
        val r = records ?: throw PolarisException(ErrorCode.notConfigured, "fetch() by hash needs pinned release keys (UpdateClientOptions.pinnedReleaseKeys); pass a verified ReleaseTarget.Record instead.")
        return r(sha256)
    }

    /**
     * `GET /<p>/release/changelog`: the published release list, newest first.
     *
     * Throws [PolarisException]: `service-unavailable` when the product does not run Release; the
     * refusal body's code (`unauthorized`, `channel_not_allowed`, `download_auth_required`, …) for
     * a 401 or 403; `not_found` for any other failure status.
     */
    public suspend fun changelog(): List<ChangelogEntry> {
        core.requireService(ServiceSlug.release, Feature.releaseChangelog)
        val headers = linkedMapOf("accept" to "application/json")
        // Forwarded when held so an `entitled` feed can authenticate; a public feed ignores it.
        core.token()?.let { headers["authorization"] = "Bearer $it" }
        val response = core.request(core.endpoints.releaseChangelog, headers = headers)
        val path = "release/changelog"
        if (response.status == 401 || response.status == 403) {
            throw PolarisException(
                refusalCode(response.body) ?: if (response.status == 401) ErrorCode.unauthorized else ErrorCode.forbidden,
                if (response.status == 401) "$path refused: this feed needs a usable licence."
                else "$path refused: this build is not entitled to that feed.",
            )
        }
        if (!response.isOk) throw PolarisException(ErrorCode.notFound, "$path failed with status ${response.status}.")
        val entries = JsonText.parseOrNull(response.text).objectValue?.get("entries").arrayValue ?: return emptyList()
        return entries.mapNotNull { entry(it) }
    }

    /** The canonical install-script URL, for a host that wants to print it rather than run it. */
    public suspend fun installUrl(): String {
        core.requireService(ServiceSlug.release, Feature.releaseDownload)
        return core.endpoints.releaseInstall
    }

    /**
     * `GET /<p>/release/dl/:version/:binary-:arch[.dmg]`: the artifact URL, with `?checksum=sha256`
     * when [checksum] is set (the server then serves the artifact's sha256 digest). Built, not
     * fetched: the caller streams it.
     */
    public suspend fun downloadUrl(version: String, binary: String, arch: String, checksum: Boolean = false, dmg: Boolean = false): String {
        core.requireService(ServiceSlug.release, Feature.releaseDownload)
        val url = core.endpoints.releaseDownload(version, "$binary-$arch${if (dmg) ".dmg" else ""}")
        return if (checksum) "$url?checksum=sha256" else url
    }

    /**
     * Verify a `pkey-release+jws` record (client steps 12–15) against [releaseKeys], the release
     * keys THIS APP pins, with the client's effective product trust set as the set a release key
     * must never be in, the product as the audience, [expectedHash] as the feed's pin and [pin] as
     * the cross-check. Never throws; a refusal names the step.
     */
    public suspend fun verifyRecord(
        jws: String,
        releaseKeys: TrustSet,
        expectedHash: String,
        pin: ReleaseRecordPin? = null,
    ): VerifyReleaseRecordResult = verifyReleaseRecord(
        jws, VerifyReleaseRecordOptions(releaseKeys, core.trust(), core.product, expectedHash, pin),
    )

    public companion object {
        /** The refusal's own code: nested (`{"error":{"code":…}}`) or flat (`{"error":"…"}`). */
        internal fun refusalCode(body: ByteArray): String? {
            val root = JsonText.parseOrNull(body.toString(Charsets.UTF_8)).objectValue ?: return null
            root["error"].stringValue?.takeIf { it.isNotEmpty() }?.let { return it }
            return root["error"].objectValue?.get("code").stringValue?.takeIf { it.isNotEmpty() }
        }

        /** One entry, tolerant of a missing field: strings default to empty, `date`/`summary` stay null. */
        internal fun entry(value: JsonElement): ChangelogEntry? {
            val o = value.objectValue ?: return null
            return ChangelogEntry(
                version = o["version"].stringValue ?: "",
                tag = o["tag"].stringValue ?: "",
                date = o["date"].stringValue,
                summary = o["summary"].stringValue,
                url = o["url"].stringValue ?: "",
            )
        }
    }
}
