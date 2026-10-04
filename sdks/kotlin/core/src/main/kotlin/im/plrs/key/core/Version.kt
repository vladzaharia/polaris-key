// Version ordering under a product's scheme — plans/P3-01.md §2.8 "Versions" (WIRE-CONTRACT-V4
// §11). Every comparison is on ASCII digit strings, so no SDK loses precision past 2^53, and every
// grammar is matched against the WHOLE string with ASCII classes (a trailing line terminator does
// not parse). `update-matrix.json#/versionCases` pins it; client-core's `version.ts` is the
// reference and Swift's `Version.swift` the structural model (P6-08).
//
// The version schemes are not an `enums.json` enum (`semver+build` and `4part` are not valid
// identifiers), so they are this hand-written list, which `UpdateMatrixTest` asserts against
// `update-matrix.json#/vocabulary/schemes`.

package im.plrs.key.core

/** The version schemes a feed may name, in this order. */
public val FEED_VERSION_SCHEMES: List<String> = listOf("semver", "semver+build", "4part")

private val SEMVER_REGEX = Regex(
    "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" +
        "(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?" +
        "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?",
)

private val FOUR_PART_REGEX = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")

/** A version parsed under its scheme. */
public sealed interface ParsedVersion {
    /** `semver` and `semver+build`: the core parts as digit strings, the prerelease ids, the build. */
    public data class SemverVersion(val core: List<String>, val prerelease: List<String>?, val build: String?) : ParsedVersion

    /** `4part`: the four parts as digit strings. */
    public data class FourPart(val core: List<String>) : ParsedVersion
}

/** Parse [version] under [scheme], or null when it does not parse (or the scheme is unknown). */
public fun parseVersion(scheme: String, version: String): ParsedVersion? = when (scheme) {
    "semver", "semver+build" -> SEMVER_REGEX.matchEntire(version)?.let { m ->
        val g = m.groups
        ParsedVersion.SemverVersion(
            listOf(g[1]!!.value, g[2]!!.value, g[3]!!.value),
            g[4]?.value?.split('.'),
            g[5]?.value,
        )
    }
    "4part" -> FOUR_PART_REGEX.matchEntire(version)?.let { m ->
        ParsedVersion.FourPart((1..4).map { m.groups[it]!!.value })
    }
    else -> null
}

private fun isDigits(s: String): Boolean = s.isNotEmpty() && s.all { it in '0'..'9' }

/** Byte-order comparison of two ASCII strings. */
private fun compareBytes(a: String, b: String): Int {
    val c = compareUtf8Bytes(a, b)
    return if (c == 0) 0 else if (c < 0) -1 else 1
}

/** Two unbounded non-negative integers as ASCII digit strings: leading zeros off, length, then bytes. */
private fun compareDigits(a: String, b: String): Int {
    fun strip(s: String): String = s.trimStart('0').ifEmpty { "0" }
    val x = strip(a)
    val y = strip(b)
    if (x.length != y.length) return if (x.length < y.length) -1 else 1
    return compareBytes(x, y)
}

/** SemVer 2.0 §11 precedence; build metadata is ignored. */
private fun comparePrecedence(a: List<String>, pa: List<String>?, b: List<String>, pb: List<String>?): Int {
    for (k in 0 until 3) {
        val c = compareDigits(a[k], b[k])
        if (c != 0) return c
    }
    if (pa == null && pb == null) return 0
    if (pa == null) return 1
    if (pb == null) return -1
    for (k in 0 until minOf(pa.size, pb.size)) {
        val xn = isDigits(pa[k])
        val yn = isDigits(pb[k])
        val c = when {
            xn && yn -> compareDigits(pa[k], pb[k])
            xn -> -1
            yn -> 1
            else -> compareBytes(pa[k], pb[k])
        }
        if (c != 0) return c
    }
    return if (pa.size == pb.size) 0 else if (pa.size < pb.size) -1 else 1
}

/**
 * `cmp(a, b)` under [scheme]: -1, 0 or 1, or null when either side does not parse. `semver+build`
 * breaks a precedence tie with build metadata that is ASCII digits only, compared as an unbounded
 * integer; a version without such metadata is lower than one with it.
 */
public fun compareVersions(scheme: String, a: String, b: String): Int? {
    val pa = parseVersion(scheme, a) ?: return null
    val pb = parseVersion(scheme, b) ?: return null
    if (pa is ParsedVersion.FourPart && pb is ParsedVersion.FourPart) {
        for (k in 0 until 4) {
            val c = compareDigits(pa.core[k], pb.core[k])
            if (c != 0) return c
        }
        return 0
    }
    if (pa is ParsedVersion.SemverVersion && pb is ParsedVersion.SemverVersion) {
        val c = comparePrecedence(pa.core, pa.prerelease, pb.core, pb.prerelease)
        if (c != 0 || scheme != "semver+build") return c
        val na = pa.build?.takeIf { isDigits(it) }
        val nb = pb.build?.takeIf { isDigits(it) }
        return when {
            na == null && nb == null -> 0
            na == null -> -1
            nb == null -> 1
            else -> compareDigits(na, nb)
        }
    }
    return null
}
