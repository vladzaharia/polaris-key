// Client-side semver and channel helpers, mirroring client-core's semver.ts (WIRE-CONTRACT-V3 §5.1).
// Patterns match the WHOLE string with ASCII classes only (WIRE-CONTRACT-V4 §3): `1.2.3\n` and
// Arabic-Indic digits do not parse.

package im.plrs.key.core

public data class ParsedSemver(val major: Long, val minor: Long, val patch: Long, val prerelease: List<String>)

/** The channel family a build's version implies (§5.1 rule 2). */
public enum class Channel(public val wire: String) {
    stable(CHANNEL_STABLE),
    beta(CHANNEL_BETA),
    pr(CHANNEL_PR),
    dev(CHANNEL_DEV),
}

public object Semver {
    private val PATTERN = Regex("""([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?""")
    private val PR_PREFIX = Regex("""^0\.0\.0-pr-?[0-9]+""")

    /** Parse `MAJOR.MINOR.PATCH[-prerelease][+build]`, or null. */
    public fun parse(v: String): ParsedSemver? {
        val m = PATTERN.matchEntire(v) ?: return null
        val maj = m.groupValues[1].toLongOrNull() ?: return null
        val min = m.groupValues[2].toLongOrNull() ?: return null
        val pat = m.groupValues[3].toLongOrNull() ?: return null
        val pre = m.groups[4]?.value?.split('.') ?: emptyList()
        return ParsedSemver(maj, min, pat, pre)
    }

    /** -1, 0 or 1; prereleases sort before their release; unparseable inputs compare equal. */
    public fun compare(a: String, b: String): Int {
        val pa = parse(a) ?: return 0
        val pb = parse(b) ?: return 0
        for ((x, y) in listOf(pa.major to pb.major, pa.minor to pb.minor, pa.patch to pb.patch)) {
            if (x != y) return if (x < y) -1 else 1
        }
        if (pa.prerelease.isEmpty() && pb.prerelease.isNotEmpty()) return 1
        if (pa.prerelease.isNotEmpty() && pb.prerelease.isEmpty()) return -1
        val n = maxOf(pa.prerelease.size, pb.prerelease.size)
        for (i in 0 until n) {
            val x = pa.prerelease.getOrNull(i) ?: return -1
            val y = pb.prerelease.getOrNull(i) ?: return 1
            val xi = x.toLongOrNull()
            val yi = y.toLongOrNull()
            if (xi != null && yi != null) {
                if (xi != yi) return if (xi < yi) -1 else 1
            } else if (x != y) {
                return if (x < y) -1 else 1
            }
        }
        return 0
    }

    /** The channel family of a build version: only the `0.0.0-<word>` sentinels carry one. */
    public fun channelForVersion(version: String): Channel = when {
        version.startsWith("0.0.0-dev") -> Channel.dev
        version.startsWith("0.0.0-beta") || version.startsWith("0.0.0-staging") -> Channel.beta
        PR_PREFIX.containsMatchIn(version) -> Channel.pr
        else -> Channel.stable
    }

    /** A `0.0.0-dev…` build. */
    public fun isDevBuild(version: String): Boolean = version.startsWith("0.0.0-dev")
}
