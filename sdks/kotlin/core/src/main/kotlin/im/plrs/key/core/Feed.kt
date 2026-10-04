// The channel feed — WIRE-CONTRACT-V4 §2.3 and client steps 3–9 (plans/P3-01.md §2.3, §2.5),
// pinned by `cases.json`'s `feedCases`. A port of Swift's `Feed.swift` (P6-08); client-core's
// `feed.ts` is the reference.
//
// `feedClaims` is steps 4–6, `verifyFeed` steps 3–8 (with the `seq` floor of the canonical
// channel), `reloadFeeds` the reload path, and `commitFeed` step 9's write as a pure function over
// the `feeds` slice. Nothing here does I/O or throws: a refused feed is a typed refusal.
//
// The claims are checked over the decoded JSON tree, because member presence is part of the
// contract (V4 §3): a required member is present (`floor` and `live` may be `null`, never missing),
// and an optional one is absent or of its type (a present `null` is refused). Every pattern is
// matched against the whole string with ASCII classes, every length counts UTF-8 bytes, and every
// integer field is an integer claim decided from its token at its RFC 6901 pointer.

package im.plrs.key.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// ── Constants (`@polaris-key/protocol/update` and `/distribution`) ──────────────────────────────

/** `expiresAt = issuedAt + FEED_TTL_SECONDS` for every feed the Worker signs. */
public const val FEED_TTL_SECONDS: Long = 900

/** A verifier refuses `expiresAt > issuedAt + MAX_FEED_TTL_SECONDS`. */
public const val MAX_FEED_TTL_SECONDS: Long = 3600

/** `rolloutBucket`'s modulus, and the ceiling of a rollout's `bp`. */
public const val ROLLOUT_BUCKETS: Long = 10_000

/** A target's `platform`. Unknown values that match are allowed. */
public const val FEED_PLATFORM_PATTERN: String = "[a-z][a-z0-9-]{0,63}"

/** A product outlet id, and an outlet kind's shape (P2b-02). */
public const val OUTLET_ID_PATTERN: String = "[a-z][a-z0-9-]{0,63}"

/** The `commerce` vocabulary. */
public val COMMERCE_VALUES: List<String> = listOf("own", "store-iap", "steam", "none")

internal const val SALT_PATTERN = "[0-9a-f]{32}"
private const val MAX_LISTING_URL_BYTES = 2048
private val CAPABILITY_BOOLEANS = listOf("codeUpdates", "dataUpdates", "channelSwitch", "downloadedScripts")

/** RFC 6901 escaping of one reference token. */
internal fun pointerToken(raw: String): String = raw.replace("~", "~0").replace("/", "~1")

// ── The verified document ────────────────────────────────────────────────────────────────────

/** A release named by its record hash, `seq` and version: a feed target's pin, a content pin or hold. */
public data class ReleasePin(val sha256: String, val seq: Long, val version: String) {
    /** `{sha256, seq, version}`. */
    public val json: JsonObject
        get() = buildJsonObject {
            put("sha256", JsonPrimitive(sha256))
            put("seq", jsonInt(seq))
            put("version", JsonPrimitive(version))
        }
}

/** `targets[].release`: the pin. */
public typealias FeedRelease = ReleasePin

/** `targets[].floor` when it is not null. */
public data class FeedTargetFloor(val minVersion: String)

/** `outlets.*.live`: the newest release of the app live on that outlet for that platform. */
public data class FeedLive(val version: String, val seq: Long)

/** `outlets.*.rollout`: basis points out of [ROLLOUT_BUCKETS] and a 32-hex salt. */
public data class FeedRollout(val bp: Long, val salt: String)

/** One outlet's entry in a target, keyed by the product's outlet id. */
public data class FeedOutletEntry(
    val kind: String,
    val live: FeedLive?,
    val halted: Boolean,
    val rollout: FeedRollout? = null,
    val listingUrl: String? = null,
    /** A narrowing of the kind's defaults. Unknown keys are kept and ignored. */
    val capabilities: Map<String, JsonElement>? = null,
)

/** One platform's target. */
public data class FeedTarget(
    val platform: String,
    val release: FeedRelease,
    val floor: FeedTargetFloor?,
    val critical: Boolean,
    val outlets: Map<String, FeedOutletEntry>,
) {
    public companion object {
        /** The typed view of a target object (SHAPE only), or null. */
        public fun from(json: JsonElement?): FeedTarget? {
            val t = json.objectValue ?: return null
            val platform = t["platform"].stringValue ?: return null
            val release = t["release"].objectValue ?: return null
            val sha = release["sha256"].stringValue ?: return null
            val seq = release["seq"].longValue ?: return null
            val version = release["version"].stringValue ?: return null
            val critical = t["critical"].boolValue ?: return null
            val rawOutlets = t["outlets"].objectValue ?: return null
            val floor = when (val f = t["floor"]) {
                is JsonNull -> null
                is JsonObject -> FeedTargetFloor(f["minVersion"].stringValue ?: return null)
                else -> return null
            }
            val outlets = LinkedHashMap<String, FeedOutletEntry>()
            for ((id, raw) in rawOutlets) {
                val e = raw.objectValue ?: return null
                val kind = e["kind"].stringValue ?: return null
                val halted = e["halted"].boolValue ?: return null
                val live = when (val l = e["live"]) {
                    is JsonNull -> null
                    is JsonObject -> FeedLive(l["version"].stringValue ?: return null, l["seq"].longValue ?: return null)
                    else -> return null
                }
                val rollout = if (e.containsKey("rollout")) {
                    val ro = e["rollout"].objectValue ?: return null
                    FeedRollout(ro["bp"].longValue ?: return null, ro["salt"].stringValue ?: return null)
                } else null
                val listingUrl = if (e.containsKey("listingUrl")) e["listingUrl"].stringValue ?: return null else null
                val capabilities = if (e.containsKey("capabilities")) e["capabilities"].objectValue ?: return null else null
                outlets[id] = FeedOutletEntry(kind, live, halted, rollout, listingUrl, capabilities)
            }
            return FeedTarget(platform, FeedRelease(sha, seq, version), floor, critical, outlets)
        }
    }
}

/** `app`. */
public data class FeedApp(val deliverable: String, val versionScheme: String, val targets: List<FeedTarget>)

/** A verified `pkey-feed+jws` payload (WIRE-CONTRACT-V4 §2.3). */
public class ChannelFeedDoc(
    public val schemaVersion: Long = 1,
    public val iss: String = POLARIS_ISSUER,
    public val aud: String,
    /** The canonical channel (§2.3): it keys `feeds` and the floors, and is the decision's channel. */
    public val channel: String,
    /** `selector.platform`, when the Worker split the channel per platform. */
    public val selectorPlatform: String? = null,
    public val seq: Long,
    public val issuedAt: Long,
    public val expiresAt: Long,
    public val app: FeedApp,
    /** The payload as decoded, reserved members (`packSets`, …) included. */
    public val json: JsonObject = JsonObject(emptyMap()),
    /** The verified payload's non-wire integer pointers (V4 §3.1). Equality ignores them. */
    public val nonWireIntegers: NonWireIntegers = NonWireIntegers(),
) {
    /** [feedContent] over this payload with its own non-wire pointers (plans/P4-13.md §2.5 step 10). */
    public val content: FeedContent get() = feedContent(json, nonWireIntegers)

    override fun equals(other: Any?): Boolean =
        other is ChannelFeedDoc && schemaVersion == other.schemaVersion && iss == other.iss && aud == other.aud &&
            channel == other.channel && selectorPlatform == other.selectorPlatform && seq == other.seq &&
            issuedAt == other.issuedAt && expiresAt == other.expiresAt && app == other.app && jsonEquals(json, other.json)

    override fun hashCode(): Int = (channel.hashCode() * 31 + seq.hashCode()) * 31 + issuedAt.hashCode()

    override fun toString(): String = "ChannelFeedDoc(channel=$channel, seq=$seq, issuedAt=$issuedAt)"

    public companion object {
        /**
         * The typed view of a feed object, or null when it lacks a member or a member has the wrong
         * type. SHAPE only — [feedClaims] is the contract; a payload that passed it always converts.
         */
        public fun from(json: JsonElement?, nonWireIntegers: NonWireIntegers = NonWireIntegers()): ChannelFeedDoc? {
            val o = json.objectValue ?: return null
            val selector = o["selector"].objectValue ?: return null
            val app = o["app"].objectValue ?: return null
            val rawTargets = app["targets"].arrayValue ?: return null
            val targets = rawTargets.map { FeedTarget.from(it) ?: return null }
            return ChannelFeedDoc(
                schemaVersion = o["schemaVersion"].longValue ?: return null,
                iss = o["iss"].stringValue ?: return null,
                aud = o["aud"].stringValue ?: return null,
                channel = o["channel"].stringValue ?: return null,
                selectorPlatform = selector["platform"].stringValue,
                seq = o["seq"].longValue ?: return null,
                issuedAt = o["issuedAt"].longValue ?: return null,
                expiresAt = o["expiresAt"].longValue ?: return null,
                app = FeedApp(
                    app["deliverable"].stringValue ?: return null,
                    app["versionScheme"].stringValue ?: return null,
                    targets,
                ),
                json = o,
                nonWireIntegers = nonWireIntegers,
            )
        }
    }
}

// ── Steps 4–6: the claims, the channel binding and the selector ─────────────────────────────────

/** Why [feedClaims] refused (steps 4, 5 and 6). */
public enum class FeedClaimsRefusal(public val wire: String) { claims("claims"), channel("channel"), selector("selector") }

private fun capabilitiesOk(value: JsonElement?): Boolean {
    val c = value.objectValue ?: return false
    if (c.containsKey("binaryUpdates")) {
        val s = c["binaryUpdates"].stringValue ?: return false
        if (s !in BINARY_UPDATES_ORDER) return false
    }
    for (key in CAPABILITY_BOOLEANS) if (c.containsKey(key) && c[key].boolValue == null) return false
    if (c.containsKey("commerce")) {
        val s = c["commerce"].stringValue ?: return false
        if (s !in COMMERCE_VALUES) return false
    }
    return true
}

/** `listingUrl`: 1–2048 bytes, each 0x21–0x7E. */
private fun isPrintableAscii(v: String, max: Int): Boolean {
    val bytes = v.toByteArray(Charsets.UTF_8)
    if (bytes.isEmpty() || bytes.size > max) return false
    return bytes.all { it in 0x21..0x7E }
}

/** Step 4: every claim of §2.3. */
private fun feedClaimsHold(doc: JsonObject, expectedAud: String, nonWire: NonWireIntegers): Boolean {
    fun int(v: JsonElement?, pointer: String, min: Long): Long? {
        val i = v.longValue ?: return null
        return if (wireInteger(i, pointer, min, nonWire)) i else null
    }

    if (int(doc["schemaVersion"], "/schemaVersion", 1) != 1L) return false
    if (doc["iss"].stringValue != POLARIS_ISSUER) return false
    if (doc["aud"].stringValue != expectedAud) return false
    val channel = doc["channel"].stringValue ?: return false
    if (!packMatch(CHANNEL_NAME_PATTERN, channel)) return false
    val selector = doc["selector"].objectValue ?: return false
    val selectorPlatform: String? = if (selector.containsKey("platform")) selector["platform"].stringValue ?: return false else null
    if (int(doc["seq"], "/seq", 1) == null) return false
    val issuedAt = int(doc["issuedAt"], "/issuedAt", 0) ?: return false
    val expiresAt = int(doc["expiresAt"], "/expiresAt", 1) ?: return false
    if (issuedAt >= expiresAt || expiresAt > saturatingAdd(issuedAt, MAX_FEED_TTL_SECONDS)) return false

    val app = doc["app"].objectValue ?: return false
    if (app["deliverable"].stringValue != "app") return false
    val scheme = app["versionScheme"].stringValue ?: return false
    if (scheme !in FEED_VERSION_SCHEMES) return false
    fun version(v: JsonElement?): String? = v.stringValue?.takeIf { parseVersion(scheme, it) != null }
    val targets = app["targets"].arrayValue ?: return false

    val platforms = HashSet<String>()
    for ((i, rawTarget) in targets.withIndex()) {
        val at = "/app/targets/$i"
        val target = rawTarget.objectValue ?: return false
        val platform = target["platform"].stringValue ?: return false
        if (!packMatch(FEED_PLATFORM_PATTERN, platform)) return false
        if (!platforms.add(platform)) return false
        if (selectorPlatform != null && platform != selectorPlatform) return false

        val release = target["release"].objectValue ?: return false
        val sha = release["sha256"].stringValue ?: return false
        if (!isSha256Hex(sha)) return false
        if (int(release["seq"], "$at/release/seq", 1) == null) return false
        val pinVersion = version(release["version"]) ?: return false

        if (!target.containsKey("floor")) return false
        when (val floor = target["floor"]) {
            is JsonNull -> {}
            is JsonObject -> {
                val min = version(floor["minVersion"]) ?: return false
                val c = compareVersions(scheme, min, pinVersion) ?: return false
                if (c > 0) return false
            }
            else -> return false
        }
        if (target["critical"].boolValue == null) return false

        val outlets = target["outlets"].objectValue ?: return false
        for ((id, rawEntry) in outlets) {
            val pointer = "$at/outlets/${pointerToken(id)}"
            if (!packMatch(OUTLET_ID_PATTERN, id)) return false
            val entry = rawEntry.objectValue ?: return false
            val kind = entry["kind"].stringValue ?: return false
            if (!packMatch(OUTLET_ID_PATTERN, kind) || kind == OUTLET_UNKNOWN) return false
            if (!entry.containsKey("live")) return false
            when (val live = entry["live"]) {
                is JsonNull -> {}
                is JsonObject -> {
                    if (version(live["version"]) == null) return false
                    if (int(live["seq"], "$pointer/live/seq", 1) == null) return false
                }
                else -> return false
            }
            if (entry["halted"].boolValue == null) return false
            if (entry.containsKey("rollout")) {
                val rollout = entry["rollout"].objectValue ?: return false
                val bp = int(rollout["bp"], "$pointer/rollout/bp", 0) ?: return false
                if (bp > ROLLOUT_BUCKETS) return false
                val salt = rollout["salt"].stringValue ?: return false
                if (!packMatch(SALT_PATTERN, salt)) return false
            }
            if (entry.containsKey("listingUrl")) {
                val url = entry["listingUrl"].stringValue ?: return false
                if (kind in OUTLET_KIND_VALUES) {
                    val prefixes = LISTING_URL_PREFIXES[kind] ?: emptyList()
                    if (!isPrintableAscii(url, MAX_LISTING_URL_BYTES)) return false
                    if (prefixes.none { url.startsWith(it) }) return false
                }
            }
            if (entry.containsKey("capabilities") && !capabilitiesOk(entry["capabilities"])) return false
        }
    }
    return true
}

/**
 * Client steps 4–6 over a verified feed payload: the claims, the channel binding (the claim is
 * never `latest`, and equals the requested name or, when that name is an alias,
 * `CHANNEL_ALIASES[requested]`) and the selector. Null when all three pass.
 *
 * @param requested the channel name the client REQUESTED (it may be an alias).
 * @param platform the client's platform; when given, a `selector.platform` must equal it.
 */
public fun feedClaims(
    payload: JsonElement?,
    expectedAud: String,
    requested: String,
    platform: String?,
    nonWire: NonWireIntegers = NonWireIntegers(),
): FeedClaimsRefusal? {
    val doc = payload.objectValue ?: return FeedClaimsRefusal.claims
    if (!feedClaimsHold(doc, expectedAud, nonWire)) return FeedClaimsRefusal.claims
    val claim = doc["channel"].stringValue ?: return FeedClaimsRefusal.claims
    val selector = doc["selector"].objectValue ?: return FeedClaimsRefusal.claims
    if (claim == "latest") return FeedClaimsRefusal.channel
    if (claim != requested && claim != CHANNEL_ALIASES[requested]) return FeedClaimsRefusal.channel
    if (selector.keys.any { it != "platform" }) return FeedClaimsRefusal.selector
    val sp = selector["platform"].stringValue
    if (sp != null && platform != null && sp != platform) return FeedClaimsRefusal.selector
    return null
}

// ── Steps 3–8: the verifier, and the floor ──────────────────────────────────────────────────────

/** The `seq` floor of one canonical channel: the committed feed's `seq` and `issuedAt`. */
public data class FeedFloor(val seq: Long, val issuedAt: Long)

/** The floor a committed feed sets for its canonical channel. */
public fun feedFloor(feed: ChannelFeedDoc): FeedFloor = FeedFloor(feed.seq, feed.issuedAt)

/** Why [verifyFeed] refused, by client step (`feedCases` `expect.reason`). */
public enum class FeedRefusal(public val wire: String) {
    jws("jws"),
    claims("claims"),
    channel("channel"),
    selector("selector"),
    freshness("freshness"),
    notNewer("not-newer"),
    rollback("rollback"),
}

public data class VerifyFeedOptions(
    /** The EFFECTIVE product trust set (pins ∪ manifest keys), as for documents (step 3). */
    val trust: TrustSet,
    /** The product: `aud` must equal it. */
    val expectedAud: String,
    /** The channel name the client REQUESTED (it may be an alias). */
    val channel: String,
    /** The client's platform (step 6). Null skips only the platform comparison. */
    val platform: String?,
    /** The effective clock, epoch seconds. Defaults to the system clock. */
    val now: Long? = null,
    /** Step 7, on the network path only (the default). False on the reload path. */
    val checkFreshness: Boolean = true,
    /** The floors, keyed by CANONICAL channel. */
    val floors: Map<String, FeedFloor> = emptyMap(),
)

public sealed interface VerifyFeedResult {
    public data class Ok(val feed: ChannelFeedDoc) : VerifyFeedResult

    /** [channel] is the canonical channel, present only when the feed passed step 5. */
    public data class Refused(val reason: FeedRefusal, val channel: String?) : VerifyFeedResult
}

/** The accepted feed, or null. */
public val VerifyFeedResult.feed: ChannelFeedDoc? get() = (this as? VerifyFeedResult.Ok)?.feed

/** The refusal, or null. */
public val VerifyFeedResult.refusal: FeedRefusal? get() = (this as? VerifyFeedResult.Refused)?.reason

/**
 * Client steps 3–8 (plans/P3-01.md §2.5): `verify` with the effective trust set and `typ`
 * `pkey-feed+jws`, the claims, the channel binding, the selector, freshness on the network path,
 * and the `seq` floor of the canonical channel. Never throws.
 */
public fun verifyFeed(jws: String, options: VerifyFeedOptions): VerifyFeedResult {
    val v = JwsVerifier.verify(jws, options.trust, JwsTyp.feed, requireTyp = true)
        ?: return VerifyFeedResult.Refused(FeedRefusal.jws, null)
    val payload = v.payload
    val refusal = feedClaims(payload, options.expectedAud, options.channel, options.platform, v.nonWireIntegers)
    if (refusal == FeedClaimsRefusal.claims) return VerifyFeedResult.Refused(FeedRefusal.claims, null)
    if (refusal == FeedClaimsRefusal.channel) return VerifyFeedResult.Refused(FeedRefusal.channel, null)
    val feed = ChannelFeedDoc.from(payload, v.nonWireIntegers) ?: return VerifyFeedResult.Refused(FeedRefusal.claims, null)
    val channel = feed.channel
    if (refusal == FeedClaimsRefusal.selector) return VerifyFeedResult.Refused(FeedRefusal.selector, channel)
    if (options.checkFreshness) {
        val now = options.now ?: (System.currentTimeMillis() / 1000)
        if (feed.issuedAt > saturatingAdd(now, CLOCK_SKEW_SECONDS) || feed.expiresAt <= saturatingAdd(now, -CLOCK_SKEW_SECONDS)) {
            return VerifyFeedResult.Refused(FeedRefusal.freshness, channel)
        }
    }
    options.floors[channel]?.let { floor ->
        if (feed.seq < floor.seq) return VerifyFeedResult.Refused(FeedRefusal.rollback, channel)
        if (feed.seq == floor.seq && feed.issuedAt <= floor.issuedAt) return VerifyFeedResult.Refused(FeedRefusal.notNewer, channel)
    }
    return VerifyFeedResult.Ok(feed)
}

// ── The reload path and step 9 ──────────────────────────────────────────────────────────────────

/** One committed feed that survived the reload path. */
public data class CommittedFeed(val jws: String, val feed: ChannelFeedDoc)

/** The survivors of the reload path, keyed by canonical channel, and the floors they set. */
public data class ReloadedFeeds(
    val feeds: Map<String, CommittedFeed> = emptyMap(),
    /** `floors[k] = feedFloor(feeds[k])`: what [verifyFeed] reads at step 8. Never persisted. */
    val floors: Map<String, FeedFloor> = emptyMap(),
)

/**
 * The reload path (plans/P3-01.md §2.5): every `feeds[k]` goes through steps 3–6 with `k` as the
 * requested name, no freshness and no floor, and its claim must equal `k`. Never throws.
 */
public fun reloadFeeds(cached: Map<String, String>, trust: TrustSet, expectedAud: String, platform: String?): ReloadedFeeds {
    val feeds = LinkedHashMap<String, CommittedFeed>()
    val floors = LinkedHashMap<String, FeedFloor>()
    for ((k, jws) in cached) {
        val feed = verifyFeed(jws, VerifyFeedOptions(trust, expectedAud, k, platform, checkFreshness = false)).feed ?: continue
        if (feed.channel != k) continue
        feeds[k] = CommittedFeed(jws, feed)
        floors[k] = feedFloor(feed)
    }
    return ReloadedFeeds(feeds, floors)
}

/**
 * Step 9's write over the `feeds` slice: `feeds[claim] = jws`, and when the claim is not the
 * requested name (an alias answer) the same write removes `feeds[requested]`.
 */
public fun commitFeed(feeds: Map<String, String>, requested: String, claim: String, jws: String): Map<String, String> {
    val next = LinkedHashMap(feeds)
    if (claim != requested) next.remove(requested)
    next[claim] = jws
    return next
}

/** The keys a request binds to (step 5): the requested name and, when it is an alias, its target. */
public fun boundChannels(requested: String): List<String> {
    val alias = CHANNEL_ALIASES[requested]
    return if (alias == null || alias == requested) listOf(requested) else listOf(requested, alias)
}
