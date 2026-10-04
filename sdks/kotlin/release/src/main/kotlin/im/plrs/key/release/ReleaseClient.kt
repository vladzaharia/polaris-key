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

public class ReleaseClient(private val core: CoreContext) {
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
