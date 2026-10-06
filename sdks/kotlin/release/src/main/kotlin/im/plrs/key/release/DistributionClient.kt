// `client.distribution` (notes/SDK-PARITY-PASS.md §3.8): the typed download model of the product's
// public download page, `GET /<p>/distribution/download.json` (P2b-06,
// `W/services/distribution/page/model.ts`): every platform with its primary action and builds, and
// every store or download action. A "Download" button renders this platform first and the rest as
// "Also on". Public, unsigned and read-only: it says where the product is offered, never what a
// licence grants, so nothing here is verified and nothing here unlocks anything.

package im.plrs.key.release

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** One downloadable build on the page. */
public data class DownloadBuild(
    val version: String,
    val buildId: String,
    val platform: String,
    val arch: String,
    val format: String?,
    val name: String,
    val size: Long?,
    val minOs: String?,
    val url: String,
    val outletId: String,
    /** The page's release id (`app@1.0.0`), or null when the model names none. */
    val releaseId: String? = null,
    /** The build's lowercase hex SHA-256 as the page lists it (informational: verify against the signed record). */
    val sha256: String? = null,
)

/** One way to get the product: a store listing, a direct download, a package-manager command. */
public data class DownloadAction(
    val id: String,
    /** The action kind (`store`, `download`, `command`, …), as the page model names it. */
    val kind: String,
    val outletId: String,
    val platforms: List<String>,
    val label: String,
    val url: String?,
    val deepLink: String?,
    val qr: String?,
    val command: String?,
    val version: String?,
    val build: DownloadBuild?,
)

/** One platform's group: its primary action and every action and build for it. */
public data class DownloadPlatform(
    val platform: String,
    val label: String,
    /** The id of the action the page leads with, or null. */
    val primary: String?,
    val actions: List<String>,
    val builds: List<DownloadBuild>,
)

/** The page model. [json] is the document as served, for anything this type does not lift. */
public data class DownloadModel(
    val schemaVersion: Long,
    val productName: String,
    val channel: String,
    val pageUrl: String?,
    val platforms: List<DownloadPlatform>,
    val actions: List<DownloadAction>,
    val json: JsonObject,
) {
    /** The action with [id], or null. */
    public fun action(id: String): DownloadAction? = actions.firstOrNull { it.id == id }
}

/** `thisPlatform()`'s answer: this platform's group (when the page has one) and every other one. */
public data class PlatformDownloads(val current: DownloadPlatform?, val others: List<DownloadPlatform>, val model: DownloadModel) {
    /** The action to lead with here: this platform's primary, else its first. */
    val primaryAction: DownloadAction? get() = current?.let { c -> (c.primary ?: c.actions.firstOrNull())?.let { model.action(it) } }
}

/** The distribution sub-client. */
public class DistributionClient(private val core: CoreContext) {
    /**
     * The download page model. Throws [PolarisException]: `service-unavailable` when the product does
     * not run Distribution, `not_found` when it publishes no page, `rate_limited`, `bad_response`.
     */
    public suspend fun downloadModel(): DownloadModel {
        core.requireService(ServiceSlug.distribution, Feature.releaseDownload)
        val r = core.request(core.endpoints.url("distribution/download.json"), headers = mapOf("accept" to "application/json"))
        if (!r.isOk) throw PolarisException(ReleaseClient.refusalCode(r.body) ?: ErrorCode.notFound, "distribution/download.json answered HTTP ${r.status}.")
        val o = JsonText.parseOrNull(r.text).objectValue ?: throw PolarisException(ErrorCode.badResponse, "the download model is not a JSON object")
        return parse(o) ?: throw PolarisException(ErrorCode.badResponse, "the download model has no platforms or actions")
    }

    /** The model split into this runtime's platform (the `X-PKey-Platform` value) and the rest. */
    public suspend fun thisPlatform(platform: String? = RuntimeFamily.platformHeader): PlatformDownloads {
        val model = downloadModel()
        val current = model.platforms.firstOrNull { it.platform == platform }
        return PlatformDownloads(current, model.platforms.filter { it !== current }, model)
    }

    public companion object {
        /** A served model, or null when it lacks the lists every model has. Unknown members are kept in `json`. */
        public fun parse(o: JsonObject): DownloadModel? {
            val platforms = o["platforms"].arrayValue ?: return null
            val actions = o["actions"].arrayValue ?: return null
            return DownloadModel(
                schemaVersion = o["schemaVersion"].longValue ?: 1,
                productName = o["product"].objectValue?.get("name").stringValue ?: "",
                channel = o["channel"].stringValue ?: "stable",
                pageUrl = o["pageUrl"].stringValue,
                platforms = platforms.mapNotNull(::platform),
                actions = actions.mapNotNull(::action),
                json = o,
            )
        }

        private fun build(e: JsonElement?): DownloadBuild? {
            val b = e.objectValue ?: return null
            return DownloadBuild(
                version = b["version"].stringValue ?: return null,
                buildId = b["buildId"].stringValue ?: return null,
                platform = b["platform"].stringValue ?: return null,
                arch = b["arch"].stringValue ?: "any",
                format = b["format"].stringValue,
                name = b["name"].stringValue ?: "",
                size = b["size"].longValue,
                minOs = b["minOs"].stringValue,
                url = b["url"].stringValue ?: return null,
                outletId = b["outletId"].stringValue ?: "download",
                releaseId = b["releaseId"].stringValue,
                sha256 = b["sha256"].stringValue,
            )
        }

        private fun action(e: JsonElement?): DownloadAction? {
            val a = e.objectValue ?: return null
            return DownloadAction(
                id = a["id"].stringValue ?: return null,
                kind = a["kind"].stringValue ?: return null,
                outletId = a["outletId"].stringValue ?: "",
                platforms = a["platforms"].arrayValue?.mapNotNull { it.stringValue } ?: emptyList(),
                label = a["label"].stringValue ?: "",
                url = a["url"].stringValue,
                deepLink = a["deepLink"].stringValue,
                qr = a["qr"].stringValue,
                command = a["command"].stringValue,
                version = a["version"].stringValue,
                build = build(a["build"]),
            )
        }

        private fun platform(e: JsonElement?): DownloadPlatform? {
            val p = e.objectValue ?: return null
            return DownloadPlatform(
                platform = p["platform"].stringValue ?: return null,
                label = p["label"].stringValue ?: "",
                primary = p["primary"].stringValue,
                actions = p["actions"].arrayValue?.mapNotNull { it.stringValue } ?: emptyList(),
                builds = p["builds"].arrayValue?.mapNotNull(::build) ?: emptyList(),
            )
        }
    }
}
