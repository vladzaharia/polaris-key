// Outlets — plans/P3-01.md §2.9 and §4.7 (`outlet-matrix.json`): the capability defaults per
// outlet kind, their narrowing, and outlet DETECTION.
//
// `detectOutlet(stamp, signals)` is the pure decision every SDK holds: it maps the signals a
// runtime observed, and the build stamp, to `{kind, confidence, source, subkind}` in §2.9's five
// steps. READING the signals is per runtime: Android's readers over :platform's install source are
// the :android module's (P6-12). Detection never widens what an outlet may do.

package im.plrs.key.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** `outlet-matrix.json`'s kind for "no outlet". */
public const val OUTLET_UNKNOWN: String = "unknown"

/** `binaryUpdates` from narrowest to widest. */
public val BINARY_UPDATES_ORDER: List<String> = listOf("none", "store", "self")

/** The six capability fields of an install. */
public data class OutletCapabilities(
    val binaryUpdates: String,
    val codeUpdates: Boolean,
    val dataUpdates: Boolean,
    val channelSwitch: Boolean,
    val commerce: String,
    val downloadedScripts: Boolean,
)

private fun caps(binary: String, code: Boolean, data: Boolean, channel: Boolean, commerce: String, scripts: Boolean) =
    OutletCapabilities(binary, code, data, channel, commerce, scripts)

/** The capability defaults per outlet kind, `unknown` included (`outlet-matrix.json#/kinds`). */
public val OUTLET_CAPABILITY_DEFAULTS: Map<String, OutletCapabilities> = mapOf(
    "direct" to caps("self", true, true, true, "own", true),
    "app-store" to caps("store", false, true, false, "store-iap", false),
    "testflight" to caps("store", false, true, false, "store-iap", false),
    "altstore" to caps("store", false, true, false, "own", false),
    "altstore-pal" to caps("store", false, true, false, "own", false),
    "play" to caps("store", false, true, false, "store-iap", false),
    "play-testing" to caps("store", false, true, false, "store-iap", false),
    "obtainium" to caps("store", false, true, false, "own", false),
    "fdroid-repo" to caps("store", false, true, false, "own", false),
    "ms-store" to caps("store", false, true, false, "store-iap", false),
    "app-installer" to caps("none", false, true, false, "own", false),
    "steam" to caps("none", false, true, false, "steam", false),
    "itch" to caps("none", false, true, false, "own", false),
    "flathub" to caps("none", false, true, false, "own", false),
    "snap" to caps("none", false, true, false, "own", false),
    "winget" to caps("none", false, true, false, "own", false),
    "web" to caps("none", false, true, false, "own", true),
    "unknown" to caps("none", false, false, false, "none", false),
)

/** The platforms each kind serves (`outlet-matrix.json#/kinds/<kind>/platforms`). */
public val OUTLET_PLATFORMS: Map<String, List<String>> = mapOf(
    "direct" to listOf("macos", "windows", "linux", "android", "ios"),
    "app-store" to listOf("ios", "macos"),
    "testflight" to listOf("ios", "macos"),
    "altstore" to listOf("ios"),
    "altstore-pal" to listOf("ios"),
    "play" to listOf("android"),
    "play-testing" to listOf("android"),
    "obtainium" to listOf("android"),
    "fdroid-repo" to listOf("android"),
    "ms-store" to listOf("windows"),
    "app-installer" to listOf("windows"),
    "steam" to listOf("windows", "macos", "linux"),
    "itch" to listOf("windows", "macos", "linux"),
    "flathub" to listOf("linux"),
    "snap" to listOf("linux"),
    "winget" to listOf("windows"),
    "web" to listOf("web"),
    "unknown" to listOf("macos", "ios", "android", "windows", "linux", "web"),
)

/** Per platform, per kind: a narrowing applied before the subkind's and the feed's. */
public val PLATFORM_NARROWING: Map<String, Map<String, Map<String, JsonElement>>> = mapOf(
    "ios" to mapOf(
        "direct" to mapOf(
            "binaryUpdates" to kotlinx.serialization.json.JsonPrimitive("store"),
            "codeUpdates" to kotlinx.serialization.json.JsonPrimitive(false),
            "downloadedScripts" to kotlinx.serialization.json.JsonPrimitive(false),
        ),
    ),
)

private val PACKAGE_MANAGED: Map<String, JsonElement> = mapOf(
    "binaryUpdates" to kotlinx.serialization.json.JsonPrimitive("none"),
    "codeUpdates" to kotlinx.serialization.json.JsonPrimitive(false),
)

/** How a `direct` install was put on the device narrows who updates it. */
public val SUBKIND_NARROWING: Map<String, Map<String, JsonElement>> = mapOf(
    "homebrew" to PACKAGE_MANAGED, "npm" to PACKAGE_MANAGED, "pnpm" to PACKAGE_MANAGED,
    "npx" to PACKAGE_MANAGED, "scoop" to PACKAGE_MANAGED, "chocolatey" to PACKAGE_MANAGED,
    "flatpak" to PACKAGE_MANAGED, "appimage" to emptyMap(),
)

/** The prefixes a feed's `listingUrl` may start with, per kind. */
public val LISTING_URL_PREFIXES: Map<String, List<String>> = mapOf(
    "app-store" to listOf("https://apps.apple.com/", "itms-apps://apps.apple.com/"),
    "testflight" to listOf("https://testflight.apple.com/join/"),
    "play" to listOf("https://play.google.com/store/apps/details?id=", "market://details?id="),
    "play-testing" to listOf(
        "https://play.google.com/apps/testing/", "https://play.google.com/store/apps/details?id=", "market://details?id=",
    ),
    "ms-store" to listOf("https://apps.microsoft.com/detail/", "ms-windows-store://pdp/?productid="),
)

private fun narrow(c: OutletCapabilities, n: Map<String, JsonElement>?): OutletCapabilities {
    if (n == null) return c
    var out = c
    n["codeUpdates"].boolValue?.let { out = out.copy(codeUpdates = out.codeUpdates && it) }
    n["dataUpdates"].boolValue?.let { out = out.copy(dataUpdates = out.dataUpdates && it) }
    n["channelSwitch"].boolValue?.let { out = out.copy(channelSwitch = out.channelSwitch && it) }
    n["downloadedScripts"].boolValue?.let { out = out.copy(downloadedScripts = out.downloadedScripts && it) }
    val b = n["binaryUpdates"].stringValue
    val k = BINARY_UPDATES_ORDER.indexOf(b)
    val current = BINARY_UPDATES_ORDER.indexOf(out.binaryUpdates)
    if (b != null && k >= 0 && current >= 0 && k < current) out = out.copy(binaryUpdates = BINARY_UPDATES_ORDER[k])
    if (n["commerce"].stringValue == "none") out = out.copy(commerce = "none")
    return out
}

/** The capabilities of an install: kind defaults, narrowed by platform, subkind, then the feed. */
public fun effectiveCapabilities(
    kind: String,
    platform: String,
    subkind: String? = null,
    server: Map<String, JsonElement>? = null,
): OutletCapabilities {
    var out = OUTLET_CAPABILITY_DEFAULTS[kind] ?: OUTLET_CAPABILITY_DEFAULTS.getValue(OUTLET_UNKNOWN)
    out = narrow(out, PLATFORM_NARROWING[platform]?.get(kind))
    if (subkind != null) out = narrow(out, SUBKIND_NARROWING[subkind])
    return narrow(out, server)
}

// ── Detection ────────────────────────────────────────────────────────────────────────────────

/** One detection signal and its confidence; null for the two diagnostic signals. */
public data class OutletSignalSpec(val signal: String, val confidence: String?)

/** The 25 signals in vocabulary order (`outlet-matrix.json#/signals`). */
public val OUTLET_SIGNALS: List<OutletSignalSpec> = listOf(
    OutletSignalSpec("ios.appDistributor", "attested"),
    OutletSignalSpec("ios.bundleIdRewrite", "declared"),
    OutletSignalSpec("ios.provisioningProfile", "heuristic"),
    OutletSignalSpec("macos.masReceipt", "attested"),
    OutletSignalSpec("macos.receiptSandbox", "attested"),
    OutletSignalSpec("macos.signingLeaf", "attested"),
    OutletSignalSpec("macos.homebrewCask", "heuristic"),
    OutletSignalSpec("macos.homebrewFormula", "heuristic"),
    OutletSignalSpec("windows.packageIdentity", "attested"),
    OutletSignalSpec("windows.signatureKind", "attested"),
    OutletSignalSpec("windows.appInstallerUri", "attested"),
    OutletSignalSpec("windows.externalLocation", "attested"),
    OutletSignalSpec("windows.pathConvention", "heuristic"),
    OutletSignalSpec("linux.flatpakInfo", "attested"),
    OutletSignalSpec("linux.snapEnv", "declared"),
    OutletSignalSpec("linux.appImageEnv", "declared"),
    OutletSignalSpec("steam.libraryManifest", "declared"),
    OutletSignalSpec("steam.appIdEnv", "heuristic"),
    OutletSignalSpec("steam.appIdFile", null),
    OutletSignalSpec("itch.receipt", "declared"),
    OutletSignalSpec("itch.appEnv", null),
    OutletSignalSpec("android.installSource", "declared"),
    OutletSignalSpec("android.installerMismatch", "declared"),
    OutletSignalSpec("web.displayMode", "heuristic"),
    OutletSignalSpec("node.packageManager", "heuristic"),
)

/** The platform facts detection reads (`outlet-matrix.json#/platformData`, less the listing prefixes). */
public data class OutletPlatformData(
    val playStoreCertSha256s: List<String>,
    val altStorePalMarketplaceIds: List<String>,
    val playPackages: List<String>,
    val obtainiumPackages: List<String>,
    val fdroidClientPackages: List<String>,
    val systemInstallerPackages: List<String>,
    val macosStoreLeaves: Map<String, String>,
    val deadlineMs: Long,
)

/** The values `outlet-matrix.json` fixes. */
public val OUTLET_PLATFORM_DATA: OutletPlatformData = OutletPlatformData(
    playStoreCertSha256s = emptyList(),
    altStorePalMarketplaceIds = emptyList(),
    playPackages = listOf("com.android.vending"),
    obtainiumPackages = listOf("dev.imranr.obtainium", "dev.imranr.obtainium.fdroid"),
    fdroidClientPackages = listOf("org.fdroid.fdroid", "com.looker.droidify", "com.machiav3lli.fdroid"),
    systemInstallerPackages = listOf("com.google.android.packageinstaller", "com.android.packageinstaller"),
    macosStoreLeaves = mapOf("Apple Mac OS Application Signing" to "app-store", "TestFlight Beta Distribution" to "testflight"),
    deadlineMs = 2000,
)

/** The stamp as detection reads it: outlet KIND, subkind and the product's outlet identities. */
public data class DetectionStamp(
    val outletKind: String,
    val subkind: String? = null,
    val outletIds: Map<String, String> = emptyMap(),
)

/** A detection result. */
public data class DetectedOutlet(
    val kind: String,
    val confidence: String? = null,
    val source: String? = null,
    val subkind: String? = null,
)

/** `{kind: "unknown"}`. */
public val UNKNOWN_DETECTION: DetectedOutlet = DetectedOutlet(OUTLET_UNKNOWN)

private class Evidence(val signal: String, var confidence: String) {
    var names: Pair<String, String?>? = null
    var vetoes: List<String> = emptyList()
}

private fun width(kind: String, subkind: String?): Int =
    BINARY_UPDATES_ORDER.indexOf(effectiveCapabilities(kind, "", subkind).binaryUpdates).coerceAtLeast(0)

/**
 * Detect the outlet from the build stamp and the observed signals: filter (identity conditions,
 * diagnostics), attested naming, the stamp, vetoes, then the restricting declared and heuristic
 * signals. A malformed value is no evidence; never throws.
 */
public fun detectOutlet(stamp: DetectionStamp?, signals: Map<String, JsonElement>): DetectedOutlet {
    val st = stamp?.takeIf { it.outletKind in OUTLET_KIND_VALUES }
    val ids = st?.outletIds ?: emptyMap()
    fun field(s: String, key: String): JsonElement? = signals[s].objectValue?.get(key)
    fun names(key: String, value: JsonElement?): Boolean {
        val want = ids[key] ?: return false
        val got = value.stringValue ?: return false
        return got == want
    }
    fun identityHolds(s: String): Boolean = when (s) {
        "ios.bundleIdRewrite" -> names("bundleId", field(s, "altBundleIdentifier"))
        "macos.receiptSandbox" -> signals["macos.masReceipt"].boolValue == true
        "macos.homebrewCask" -> names("caskToken", signals[s])
        "macos.homebrewFormula" -> names("homebrewFormula", signals[s])
        "windows.packageIdentity", "windows.signatureKind", "windows.appInstallerUri", "windows.externalLocation" ->
            names("msixFamilyName", signals["windows.packageIdentity"])
        "linux.flatpakInfo" -> names("flatpakId", signals[s])
        "linux.snapEnv" -> names("snapName", field(s, "name"))
        "linux.appImageEnv" -> {
            val exe = field(s, "exePath").stringValue
            val dir = field(s, "appDir").stringValue
            exe != null && dir != null && exe.startsWith(dir)
        }
        "steam.libraryManifest" -> names("steamAppId", signals[s])
        "steam.appIdEnv" -> names("steamAppId", field(s, "appId"))
        "itch.receipt" -> names("itchGameId", signals[s])
        "android.installSource" -> {
            val installer = field(s, "installer")
            val initiator = field(s, "initiator")
            when {
                installer == null || initiator == null -> false
                installer is JsonNull && initiator is JsonNull -> true
                installer.stringValue != null && initiator.stringValue != null -> installer.stringValue == initiator.stringValue
                else -> false
            }
        }
        "node.packageManager" -> field(s, "packageMatch").boolValue == true
        else -> true
    }

    val data = OUTLET_PLATFORM_DATA
    val evidence = ArrayList<Evidence>()
    // 1. Filter, and read each surviving signal's effect.
    for (spec in OUTLET_SIGNALS) {
        val confidence = spec.confidence ?: continue
        val value = signals[spec.signal] ?: continue
        if (!identityHolds(spec.signal)) continue
        val e = Evidence(spec.signal, confidence)
        when (spec.signal) {
            "ios.appDistributor" -> {
                val v = value.stringValue
                when {
                    v == "appStore" -> e.names = "app-store" to null
                    v == "testFlight" -> e.names = "testflight" to null
                    v == "web" -> e.names = "direct" to null
                    v != null && v.startsWith("marketplace:") ->
                        if (v.removePrefix("marketplace:") in data.altStorePalMarketplaceIds) e.names = "altstore-pal" to null
                        else e.vetoes = listOf("app-store", "testflight")
                }
            }
            "ios.bundleIdRewrite" -> e.names = "altstore" to null
            "ios.provisioningProfile" -> if (value.boolValue == true) e.vetoes = listOf("app-store")
            "macos.masReceipt" -> if (value.boolValue == true) {
                e.names = (if (signals["macos.receiptSandbox"].boolValue == true) "testflight" else "app-store") to null
            }
            "macos.signingLeaf" -> {
                val kind = value.stringValue?.let { data.macosStoreLeaves[it] }
                if (kind != null) e.names = kind to null else e.vetoes = listOf("app-store", "testflight")
            }
            "macos.homebrewCask", "macos.homebrewFormula" -> e.names = "direct" to "homebrew"
            "windows.signatureKind" -> when (value.stringValue) {
                "Store" -> e.names = "ms-store" to null
                "Developer", "Enterprise" -> e.vetoes = listOf("ms-store")
            }
            "windows.appInstallerUri" -> if (value !is JsonNull) e.names = "app-installer" to null
            "windows.pathConvention" -> when (value.stringValue) {
                "winget" -> e.names = "winget" to null
                "scoop" -> e.names = "direct" to "scoop"
                "chocolatey" -> e.names = "direct" to "chocolatey"
            }
            "linux.flatpakInfo" ->
                e.names = if (st?.outletKind == "direct" && st.subkind == "flatpak") "direct" to "flatpak" else "flathub" to null
            "linux.snapEnv" -> {
                val rev = field(spec.signal, "revision").stringValue
                if (rev != null && rev.startsWith("x")) e.vetoes = listOf("snap") else e.names = "snap" to null
            }
            "linux.appImageEnv" -> e.names = "direct" to "appimage"
            "steam.libraryManifest", "steam.appIdEnv" -> e.names = "steam" to null
            "itch.receipt" -> e.names = "itch" to null
            "android.installSource" -> {
                val installer = field(spec.signal, "installer")
                val i = installer.stringValue
                when {
                    i != null && i in data.playPackages -> {
                        e.names = "play" to null
                        val digest = field(spec.signal, "initiatorCertSha256").stringValue
                        if (digest != null && digest in data.playStoreCertSha256s) e.confidence = "attested"
                    }
                    i != null && i in data.obtainiumPackages -> e.names = "obtainium" to null
                    i != null && i in data.fdroidClientPackages -> e.names = "fdroid-repo" to null
                    installer is JsonNull || i == "com.android.shell" || (i != null && i in data.systemInstallerPackages) ->
                        e.names = "direct" to null
                }
            }
            "android.installerMismatch" -> if (value.boolValue == true) e.vetoes = listOf("play", "play-testing")
            "web.displayMode" -> e.names = "web" to null
            "node.packageManager" -> {
                val m = field(spec.signal, "manager").stringValue
                if (m != null && m in listOf("npm", "pnpm", "npx")) e.names = "direct" to m
            }
        }
        evidence += e
    }
    fun vetoed(kind: String) = evidence.any { kind in it.vetoes }

    // 2. Attested naming.
    val attested = evidence.filter { it.confidence == "attested" && it.names != null }
    attested.firstOrNull()?.let { first ->
        val named = first.names!!
        if (attested.any { it.names?.first != named.first }) return UNKNOWN_DETECTION
        if (vetoed(named.first)) return UNKNOWN_DETECTION
        return DetectedOutlet(named.first, "attested", first.signal, named.second)
    }

    // 3. The stamp.
    if (st == null) return UNKNOWN_DETECTION
    val curSub = st.subkind?.takeIf { it in OUTLET_SUBKIND_VALUES }

    // 4. Vetoes.
    if (vetoed(st.outletKind)) return UNKNOWN_DETECTION

    // 5. Restricting signals: declared, then heuristic, each in vocabulary order.
    val ceiling = width(st.outletKind, curSub)
    for (conf in listOf("declared", "heuristic")) {
        for (e in evidence) {
            if (e.confidence != conf) continue
            val named = e.names ?: continue
            if (width(named.first, named.second) > ceiling) continue
            return DetectedOutlet(
                named.first, conf, e.signal,
                named.second ?: if (named.first == st.outletKind) curSub else null,
            )
        }
    }
    return DetectedOutlet(st.outletKind, "stamp", "stamp", curSub)
}
