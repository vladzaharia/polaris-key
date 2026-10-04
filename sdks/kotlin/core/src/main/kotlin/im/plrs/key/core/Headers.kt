// The `X-PKey-Platform` and `X-PKey-Arch` values — WIRE-CONTRACT-V3 §5.2, pinned by
// `conformance/corpus/v2/headers.json`. A runtime's own spelling is ASCII-lowercased (never a
// locale-aware fold) and looked up in the generated spelling tables; a spelling the table lacks
// has no canonical value and its header is omitted.

package im.plrs.key.core

private fun foldAscii(raw: String): String {
    val out = StringBuilder(raw.length)
    for (c in raw) out.append(if (c in 'A'..'Z') c + 0x20 else c)
    return out.toString()
}

/** The canonical platform for a runtime's spelling, or null. */
public fun canonicalPlatform(raw: String): String? = PLATFORM_SPELLINGS[foldAscii(raw)]

/** The canonical arch for a runtime's spelling, or null. */
public fun canonicalArch(raw: String): String? = ARCH_SPELLINGS[foldAscii(raw)]

/** This process's runtime facts, as the JVM and Android report them. */
public object RuntimeFamily {
    /** True on Android (ART), false on a JVM desktop. */
    public val isAndroid: Boolean by lazy {
        val vm = System.getProperty("java.vm.name").orEmpty()
        val runtime = System.getProperty("java.runtime.name").orEmpty()
        vm.contains("Dalvik", ignoreCase = true) || runtime.contains("Android", ignoreCase = true)
    }

    /** The runtime's platform token: `Android`, else `os.name` reduced to `macOS`, `Windows` or `Linux`. */
    public val platformToken: String? by lazy {
        if (isAndroid) return@lazy "Android"
        val os = System.getProperty("os.name").orEmpty()
        when {
            os.startsWith("Mac", ignoreCase = true) || os.startsWith("Darwin", ignoreCase = true) -> "macOS"
            os.startsWith("Windows", ignoreCase = true) -> "Windows"
            os.startsWith("Linux", ignoreCase = true) -> "Linux"
            else -> os.ifEmpty { null }
        }
    }

    /** The runtime's arch token (`os.arch`: `aarch64`, `amd64`, `x86_64`, `arm`, …). */
    public val archToken: String? by lazy { System.getProperty("os.arch")?.ifEmpty { null } }

    /** The `X-PKey-Platform` value, or null when the spelling has no canonical value. */
    public val platformHeader: String? get() = platformToken?.let(::canonicalPlatform)

    /** The `X-PKey-Arch` value, or null when the spelling has no canonical value. */
    public val archHeader: String? get() = archToken?.let(::canonicalArch)

    /** The capability table's runtime id for this process: `android` or `jvm`. */
    public val capabilityRuntime: String get() = if (isAndroid) "android" else "jvm"
}
