// The update decision — plans/P3-01.md §2.8 and §2.9 (WIRE-CONTRACT-V4 §11, informative), ported
// by P6-08 from Swift's `UpdateDecision.swift`; client-core's `decide.ts` is the reference.
//
// A pure, synchronous `decideUpdate` over the verified feed and record, the installed build, the
// outlet and the host's methods, with the pieces every SDK builds its inputs from: the rollout
// bucket and the outlet resolution (the capability tables are `Outlet.kt`'s). `update-matrix.json`
// pins every function here, row for row (`UpdateMatrixTest`). Nothing here does I/O or throws.

package im.plrs.key.core

import java.security.MessageDigest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// ── The rollout bucket (§2.8 "Bucket") ──────────────────────────────────────────────────────────

/**
 * `u32_be(SHA-256(UTF-8(salt) ‖ UTF-8(installId))[0..4]) mod 10000`: the feed's hex salt hashed as
 * text, then the SDK's device id (the `X-PKey-Device` value), with no separator; the first four
 * digest bytes read big-endian as an UNSIGNED integer (`update-matrix.json#/bucketVectors`).
 */
public fun rolloutBucket(salt: String, installId: String): Long {
    val d = MessageDigest.getInstance("SHA-256").digest((salt + installId).toByteArray(Charsets.UTF_8))
    val u32 = ((d[0].toLong() and 0xff) shl 24) or ((d[1].toLong() and 0xff) shl 16) or
        ((d[2].toLong() and 0xff) shl 8) or (d[3].toLong() and 0xff)
    return u32 % ROLLOUT_BUCKETS
}

/** The capability fields as the matrices spell them. */
public val OutletCapabilities.json: JsonObject
    get() = buildJsonObject {
        put("binaryUpdates", JsonPrimitive(binaryUpdates))
        put("codeUpdates", JsonPrimitive(codeUpdates))
        put("dataUpdates", JsonPrimitive(dataUpdates))
        put("channelSwitch", JsonPrimitive(channelSwitch))
        put("commerce", JsonPrimitive(commerce))
        put("downloadedScripts", JsonPrimitive(downloadedScripts))
    }

// ── The decision's outlet (§2.8 "The outlet") ───────────────────────────────────────────────────

/** A host's outlet option: a bare kind (read as `{id: kind, kind}`), or the product's outlet id with its kind. */
public sealed interface HostOutlet {
    public data class Kind(val kind: String) : HostOutlet
    public data class Outlet(val id: String, val kind: String, val subkind: String? = null) : HostOutlet
}

/** The build stamp's outlet fields (P1-11; plans/P3-01.md §8). */
public data class OutletStamp(
    val outlet: String? = null,
    val outletKind: String? = null,
    val outletSubkind: String? = null,
    /** The product's outlet identities, which detection compares launcher signals against. */
    val outletIds: Map<String, String> = emptyMap(),
)

/** The decision's outlet: the product's outlet id (null when unknown) and its kind. */
public data class UpdateOutlet(val id: String?, val kind: String)

/** What [resolveUpdateOutlet] answers: the decision's `outlet` and `subkind`. */
public data class ResolvedOutlet(val id: String?, val kind: String, val subkind: String?) {
    val outlet: UpdateOutlet get() = UpdateOutlet(id, kind)
}

private fun isKind(v: String?): Boolean = v != null && v in OUTLET_KIND_VALUES
private fun isSubkind(v: String?): Boolean = v != null && v in OUTLET_SUBKIND_VALUES

/**
 * True when [host] is a valid host outlet option: a kind among the 17, an id matching
 * [OUTLET_ID_PATTERN], and a subkind (when given) among `OUTLET_SUBKINDS`. An SDK raises
 * `invalid-options` at construction for any other value.
 */
public fun isValidHostOutlet(host: HostOutlet): Boolean = when (host) {
    is HostOutlet.Kind -> isKind(host.kind)
    is HostOutlet.Outlet -> isKind(host.kind) && packMatch(OUTLET_ID_PATTERN, host.id) && (host.subkind == null || isSubkind(host.subkind))
}

/**
 * The decision's outlet, in §2.8's order: a host value wins; else the stamp's kind (its
 * `outletKind`, or its `outlet` when it has none), moved by a detection result when there is one;
 * else `{id: null, kind: "unknown", subkind: null}` (`update-matrix.json#/outletCases`). Null when
 * [host] is present but invalid.
 */
public fun resolveUpdateOutlet(host: HostOutlet? = null, stamp: OutletStamp? = null, detected: DetectedOutlet? = null): ResolvedOutlet? {
    if (host != null) {
        if (!isValidHostOutlet(host)) return null
        return when (host) {
            is HostOutlet.Kind -> ResolvedOutlet(host.kind, host.kind, null)
            is HostOutlet.Outlet -> ResolvedOutlet(host.id, host.kind, host.subkind)
        }
    }
    val rawKind = stamp?.outletKind ?: stamp?.outlet
    val kind = rawKind?.takeIf { isKind(it) }
    val id = stamp?.outlet?.takeIf { packMatch(OUTLET_ID_PATTERN, it) }
    val subkind = stamp?.outletSubkind?.takeIf { isSubkind(it) }
    if (detected != null) {
        return if (detected.kind == kind) ResolvedOutlet(id, detected.kind, detected.subkind) else ResolvedOutlet(null, detected.kind, detected.subkind)
    }
    if (kind != null) return ResolvedOutlet(id, kind, subkind)
    return ResolvedOutlet(null, OUTLET_UNKNOWN, null)
}

// ── Inputs and outputs (§2.8) ───────────────────────────────────────────────────────────────────

/** The installed build. */
public data class InstalledBuild(
    /** The running version. */
    val version: String,
    /** The executable's version; null means [version]. */
    val binaryVersion: String? = null,
    /** Informational in v4. */
    val buildNumber: String? = null,
    /** A `Platform` value. */
    val platform: String,
    /** The device's `Arch` value. */
    val arch: String,
    /** The installed build's format; null when unknown (any format is offered). */
    val format: String? = null,
    /** `godot-<major>.<minor>`; null outside Godot. */
    val engine: String? = null,
)

/** An update the host staged and verified, with the `UpdateCheck.channel` it was staged under. */
public data class StagedUpdate(val version: String, val channel: String)

/** `UpdateDecisionInput`. */
public data class UpdateDecisionInput(
    /** The effective clock, epoch seconds. */
    val now: Long,
    val feed: ChannelFeedDoc,
    /** The verified, cross-checked record the target pins; null if absent or refused. */
    val record: ReleaseRecordDoc?,
    val installed: InstalledBuild,
    val outlet: UpdateOutlet,
    val subkind: String? = null,
    val staged: StagedUpdate? = null,
    val skipVersion: String? = null,
    /** [rolloutBucket] for this outlet's rollout salt; null when the host computed none. */
    val bucket: Long? = null,
    /** A subset of `BINARY_METHOD_VALUES`. */
    val methods: List<String> = listOf(BinaryMethod.download),
    /** The content decision's inputs (plans/P4-13.md §2.6). Null: every answer is P3-01's. */
    val content: UpdateContentInput? = null,
)

/** A decision's `release`: `{version, seq}`, plus `sha256` on `code-ready` and `binary`. */
public data class DecisionRelease(val version: String, val seq: Long, val sha256: String? = null) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("version", JsonPrimitive(version))
            put("seq", jsonInt(seq))
            sha256?.let { put("sha256", JsonPrimitive(it)) }
        }
}

/**
 * `UpdateDecision` (§2.8 "Outputs", extended by plans/P4-13.md §2.6): each action carries exactly
 * its members. `contentBlock` (`content-floor` or `revoked-content`) is present only when a content
 * block made the answer.
 */
public sealed interface UpdateDecision {
    public val discardStaged: Boolean

    public data class None(val reason: String, val behind: Boolean, override val discardStaged: Boolean) : UpdateDecision
    public data class CodeReady(val release: DecisionRelease, val critical: Boolean, override val discardStaged: Boolean) : UpdateDecision
    public data class Binary(
        val method: String,
        val release: DecisionRelease,
        val build: String,
        val mandatory: Boolean,
        val critical: Boolean,
        val prestage: List<PackTarget>,
        override val discardStaged: Boolean,
        val contentBlock: String? = null,
    ) : UpdateDecision
    public data class Store(
        val release: DecisionRelease,
        val listingUrl: String?,
        val mandatory: Boolean,
        val critical: Boolean,
        override val discardStaged: Boolean,
        val contentBlock: String? = null,
    ) : UpdateDecision
    public data class Platform(
        val release: DecisionRelease,
        val mandatory: Boolean,
        val critical: Boolean,
        override val discardStaged: Boolean,
        val contentBlock: String? = null,
    ) : UpdateDecision
    public data class Blocked(val reason: String, override val discardStaged: Boolean, val contentBlock: String? = null) : UpdateDecision

    /** Install exact releases and unmount revoked packs; lists sorted by pack-id bytes. */
    public data class Packs(
        val install: List<PackTarget>,
        val revoke: List<String>,
        val set: List<PackSetMember>,
        override val discardStaged: Boolean,
    ) : UpdateDecision
}

/** The `UpdateAction` value. */
public val UpdateDecision.action: String
    get() = when (this) {
        is UpdateDecision.None -> UpdateAction.none
        is UpdateDecision.CodeReady -> UpdateAction.codeReady
        is UpdateDecision.Binary -> UpdateAction.binary
        is UpdateDecision.Store -> UpdateAction.store
        is UpdateDecision.Platform -> UpdateAction.platform
        is UpdateDecision.Blocked -> UpdateAction.blocked
        is UpdateDecision.Packs -> UpdateAction.packs
    }

/** The answer's `contentBlock`, when it has one. */
public val UpdateDecision.contentBlock: String?
    get() = when (this) {
        is UpdateDecision.Binary -> contentBlock
        is UpdateDecision.Store -> contentBlock
        is UpdateDecision.Platform -> contentBlock
        is UpdateDecision.Blocked -> contentBlock
        else -> null
    }

/** The decision as the wire and the matrices spell it, with exactly its action's members. */
public val UpdateDecision.json: JsonObject
    get() = buildJsonObject {
        put("action", JsonPrimitive(action))
        put("discardStaged", JsonPrimitive(discardStaged))
        when (val d = this@json) {
            is UpdateDecision.None -> {
                put("reason", JsonPrimitive(d.reason))
                put("behind", JsonPrimitive(d.behind))
            }
            is UpdateDecision.CodeReady -> {
                put("release", d.release.json)
                put("critical", JsonPrimitive(d.critical))
            }
            is UpdateDecision.Binary -> {
                put("method", JsonPrimitive(d.method))
                put("release", d.release.json)
                put("build", JsonPrimitive(d.build))
                put("mandatory", JsonPrimitive(d.mandatory))
                put("critical", JsonPrimitive(d.critical))
                put("prestage", JsonArray(d.prestage.map { it.json }))
            }
            is UpdateDecision.Store -> {
                put("release", d.release.json)
                put("listingUrl", d.listingUrl?.let { JsonPrimitive(it) } ?: JsonNull)
                put("mandatory", JsonPrimitive(d.mandatory))
                put("critical", JsonPrimitive(d.critical))
            }
            is UpdateDecision.Platform -> {
                put("release", d.release.json)
                put("mandatory", JsonPrimitive(d.mandatory))
                put("critical", JsonPrimitive(d.critical))
            }
            is UpdateDecision.Blocked -> put("reason", JsonPrimitive(d.reason))
            is UpdateDecision.Packs -> {
                put("install", JsonArray(d.install.map { it.json }))
                put("revoke", JsonArray(d.revoke.map { JsonPrimitive(it) }))
                put("set", JsonArray(d.set.map { it.json }))
            }
        }
        contentBlock?.let { put("contentBlock", JsonPrimitive(it)) }
    }

// ── The decision (§2.8 "Algorithm") ─────────────────────────────────────────────────────────────

/** The feed's target for [platform], if there is one. */
public fun feedTarget(targets: List<FeedTarget>, platform: String): FeedTarget? = targets.firstOrNull { it.platform == platform }

/**
 * The install's entry in a target (§2.8 step 3): `outlets[outlet.id]` when that entry's kind is the
 * outlet's kind; otherwise the ONE entry of that kind; otherwise none. `unknown` never has an entry.
 */
public fun outletEntry(target: FeedTarget?, outlet: UpdateOutlet): FeedOutletEntry? = outletEntryKey(target, outlet)?.let { target!!.outlets[it] }

/** The key of the install's entry in a target ([outletEntry]'s rule), or null. */
public fun outletEntryKey(target: FeedTarget?, outlet: UpdateOutlet): String? {
    if (target == null || outlet.kind == OUTLET_UNKNOWN) return null
    val id = outlet.id
    if (id != null) target.outlets[id]?.let { if (it.kind == outlet.kind) return id }
    val ofKind = target.outlets.filter { it.value.kind == outlet.kind }
    return if (ofKind.size == 1) ofKind.keys.first() else null
}

private fun archRank(b: ReleaseRecordBuild, arch: String): Int = if (b.arch == arch) 0 else if (b.arch == "universal") 1 else 2

/** The device's own arch before `universal`, `universal` before `any`; ties by build id bytes. */
private fun pickBuild(builds: List<ReleaseRecordBuild>, arch: String): ReleaseRecordBuild? {
    var best: ReleaseRecordBuild? = null
    for (b in builds) {
        val current = best
        if (current == null) {
            best = b
            continue
        }
        val r = archRank(b, arch) - archRank(current, arch)
        if (r < 0 || (r == 0 && compareUtf8Bytes(b.id, current.id) < 0)) best = b
    }
    return best
}

/** §2.8 "Eligible builds". */
private fun eligible(b: ReleaseRecordBuild, platform: String, arch: String, scheme: String): Boolean {
    if (b.artifacts.count { it.role == "payload" } != 1) return false
    if (b.platform != platform) return false
    if (b.arch != arch && b.arch != "universal" && b.arch != "any") return false
    val req = b.requires
    if (req != null) {
        if (req.containsKey("engine") && req["engine"].stringValue == null) return false
        if (req.containsKey("minBinary")) {
            val s = req["minBinary"].stringValue ?: return false
            if (parseVersion(scheme, s) == null) return false
        }
    }
    return true
}

/**
 * The update decision (plans/P3-01.md §2.8, extended by plans/P4-13.md §2.6 when `content` is
 * given). Synchronous and total; each answer has exactly the members the output tables list.
 */
public fun decideUpdate(input: UpdateDecisionInput): UpdateDecision {
    val app = decideApp(input)
    val content = input.content ?: return app
    return decideContent(input, content, app)
}

/** P3-01's decision, unchanged (plans/P3-01.md §2.8). */
private fun decideApp(input: UpdateDecisionInput): UpdateDecision {
    val feed = input.feed
    val scheme = feed.app.versionScheme
    fun cmp(a: String, b: String): Int? = compareVersions(scheme, a, b)
    val staged = input.staged
    fun discard(codeReady: Boolean = false): Boolean = staged != null && !codeReady
    fun none(reason: String): UpdateDecision = UpdateDecision.None(reason, reason == UpdateNoneReason.behind, discard())
    fun blocked(): UpdateDecision = UpdateDecision.Blocked(UpdateBlockedReason.appFloor, discard())

    // 1. Stale: freeze, and keep what is staged.
    if (input.now >= saturatingAdd(feed.expiresAt, CLOCK_SKEW_SECONDS)) {
        return UpdateDecision.None(UpdateNoneReason.stale, false, false)
    }

    // 2. Unknown version.
    val run = input.installed.version
    val bin = input.installed.binaryVersion ?: run
    if (parseVersion(scheme, run) == null || parseVersion(scheme, bin) == null) return none(UpdateNoneReason.unknownVersion)

    // 3. Setup.
    val target = feedTarget(feed.app.targets, input.installed.platform)
    val entry = outletEntry(target, input.outlet)
    val caps = effectiveCapabilities(input.outlet.kind, input.installed.platform, input.subkind, entry?.capabilities)
    var belowFloor = false
    target?.floor?.let { f -> cmp(bin, f.minVersion)?.let { if (it < 0) belowFloor = true } }

    // 4. The offer.
    var offer: Triple<String, Long, String?>? = null
    if (entry != null && target != null) {
        if (caps.binaryUpdates == "self") {
            val live = entry.live
            if (live != null && live.seq == target.release.seq && input.record != null) {
                offer = Triple(target.release.version, target.release.seq, target.release.sha256)
            }
        } else {
            entry.live?.let { offer = Triple(it.version, it.seq, null) }
        }
    }
    val o = offer
    if (o == null || entry == null || target == null) return if (belowFloor) blocked() else none(UpdateNoneReason.notAvailable)
    val (offerVersion, offerSeq, offerSha) = o

    // 5. Behind: no downgrade, and the floor is suppressed.
    val runCmp = cmp(offerVersion, run)
    if (runCmp != null && runCmp < 0) return none(UpdateNoneReason.behind)

    // 6. Up to date.
    val newerRun = (runCmp ?: 0) > 0
    val newerBin = (cmp(offerVersion, bin) ?: 0) > 0
    if (!newerRun && !(belowFloor && newerBin)) return if (belowFloor) blocked() else none(UpdateNoneReason.upToDate)

    // 7. Halted.
    if (entry.halted) return if (belowFloor) blocked() else none(UpdateNoneReason.halted)

    // 8. Rollout: a critical release and a below-floor device bypass it; a null bucket is out.
    val rollout = entry.rollout
    if (rollout != null && !belowFloor && !target.critical) {
        val bucket = input.bucket
        if (bucket == null || bucket >= rollout.bp) return none(UpdateNoneReason.outOfBucket)
    }

    val critical = target.critical
    val short = DecisionRelease(offerVersion, offerSeq)

    // 9. Platform.
    if (caps.binaryUpdates == "none") return UpdateDecision.Platform(short, belowFloor, critical, discard())

    // 10. Store.
    if (caps.binaryUpdates == "store") return UpdateDecision.Store(short, entry.listingUrl, belowFloor, critical, discard())

    // 11. Self-updating outlets. The offer is the pin here, so it carries its sha256.
    val full = DecisionRelease(offerVersion, offerSeq, offerSha)
    val notSkipped = offerVersion != input.skipVersion

    // a. code-ready.
    if (!belowFloor && newerRun && caps.codeUpdates && staged != null && staged.channel == feed.channel &&
        staged.version == offerVersion && notSkipped
    ) {
        return UpdateDecision.CodeReady(full, critical, false)
    }

    val builds = (input.record?.builds ?: emptyList()).filter { eligible(it, input.installed.platform, input.installed.arch, scheme) }
    val engine = input.installed.engine
    val codePacks = builds.filter { b ->
        if (b.format != "pck" || engine == null) return@filter false
        val required = b.requires?.get("engine").stringValue ?: return@filter false
        if (required != engine) return@filter false
        val min = b.requires?.get("minBinary").stringValue ?: return@filter true
        val c = cmp(bin, min) ?: return@filter false
        c >= 0
    }
    val format = input.installed.format
    val binaries = builds.filter { it.format != "pck" && (format == null || it.format == format) }
    fun binary(method: String, build: ReleaseRecordBuild): UpdateDecision =
        UpdateDecision.Binary(method, full, build.id, belowFloor, critical, emptyList(), discard())

    // b. sidecar-pck.
    if (!belowFloor && newerRun && caps.codeUpdates && BinaryMethod.sidecarPck in input.methods && notSkipped) {
        pickBuild(codePacks, input.installed.arch)?.let { return binary(BinaryMethod.sidecarPck, it) }
    }

    // c. native, then download.
    val pick = pickBuild(binaries, input.installed.arch)
    if (newerBin && pick != null) {
        if (BinaryMethod.native in input.methods) return binary(BinaryMethod.native, pick)
        if (BinaryMethod.download in input.methods) return binary(BinaryMethod.download, pick)
    }

    // d. Otherwise.
    if (belowFloor) return blocked()
    if (!notSkipped) return none(UpdateNoneReason.skipped)
    if (pick == null) return none(UpdateNoneReason.noBuild)
    return none(UpdateNoneReason.noMethod)
}

/**
 * The stage machine's `decide.done` for a decision (plans/P3-01.md §2.8 "bootDecision", amended by
 * plans/P4-13.md §2.6): a revoked REQUIRED pack gives `required`; `packs` gives `none`; a content
 * floor gives `optional`; otherwise `none` (and a non-mandatory `platform`) give `none`, every other
 * answer `optional`.
 */
public fun bootDecision(decision: UpdateDecision): BootEvent.Decision {
    if (decision is UpdateDecision.Blocked && decision.reason == UpdateBlockedReason.revokedContent) return BootEvent.Decision.required
    if (decision.contentBlock == UpdateBlockedReason.revokedContent) return BootEvent.Decision.required
    return when (decision) {
        is UpdateDecision.Packs -> BootEvent.Decision.none
        is UpdateDecision.None -> BootEvent.Decision.none
        is UpdateDecision.Platform -> if (!decision.mandatory) BootEvent.Decision.none else BootEvent.Decision.optional
        else -> BootEvent.Decision.optional
    }
}

/** True when the host must render [decision] as a prompt the player cannot dismiss (§2.8). */
public fun isUndismissable(decision: UpdateDecision): Boolean = when (decision) {
    is UpdateDecision.Blocked -> true
    is UpdateDecision.Binary -> decision.mandatory
    is UpdateDecision.Store -> decision.mandatory
    is UpdateDecision.Platform -> decision.mandatory
    else -> false
}
