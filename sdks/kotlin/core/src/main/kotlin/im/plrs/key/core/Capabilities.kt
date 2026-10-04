// Typed "unsupported here" (PARITY §2.2, P1b-10): `supports(feature)` and the capability list.
// The table is GENERATED from `sdks/kotlin/parity.json` into `Constants.generated.kt`
// (`CAPABILITIES`, `pnpm gen:constants`), so what this SDK answers is what its parity row says.
//
// The order every SDK applies:
//   1. an unknown feature id                     → `version` (a newer feature)
//   2. a `runtime` N/A on this runtime           → `runtime` (or any N/A here when the row is `na`)
//   3. a `planned` feature                       → `version` (this SDK does not have it yet)
//   4. an opt-in service discovery says is off   → `product`
//   5. any other declared N/A on this runtime    → its detector decides (`dependency`, `outlet`, …)
//   6. otherwise                                 → supported
//
// `supports()` never probes by calling: it reads the table, the client's resolved services and
// detectors that answer from state already held. Side-effect free and offline.

package im.plrs.key.core

/** Why a feature is unsupported here. */
public data class Unsupported(
    /** The parity feature id (`Feature.coreStore`, …). */
    val feature: String,
    /** One of `UNSUPPORTED_REASON_VALUES`. */
    val reason: String,
    /** Human text: what is missing. Never a credential. */
    val detail: String,
) {
    override fun toString(): String = "$feature is not supported here ($reason): $detail"
}

/** `supports(feature)`'s answer. */
public sealed interface Support {
    public val isSupported: Boolean

    public data class Supported(val feature: String) : Support {
        override val isSupported: Boolean get() = true
    }

    public data class Unavailable(val unsupported: Unsupported) : Support {
        override val isSupported: Boolean get() = false
    }
}

/** What a call into an unsupported feature throws; code `ErrorCode.unsupported`. */
public class UnsupportedException(public val unsupported: Unsupported) : Exception(unsupported.toString()) {
    public val code: String = ErrorCode.unsupported
}

/** A detector for one conditional (non-`runtime`) N/A: a detail when unsupported now, else null. */
public typealias CapabilityDetector = () -> String?

/** The detector key: `"<feature>#<reason>"`. */
public fun capabilityDetectorKey(feature: String, reason: String): String = "$feature#$reason"

/** A detector set that does not match the capability table: a programming error. */
public class CapabilityTableException(public val problems: List<String>) : Exception(problems.joinToString("; "))

/** The capability engine: the generated table, the runtime and the detectors. */
public class Capabilities(
    public val detectors: Map<String, CapabilityDetector>,
    public val table: Map<String, CapabilityRow> = CAPABILITIES,
    public val runtime: String = RuntimeFamily.capabilityRuntime,
    public val runtimes: List<String> = CAPABILITY_RUNTIMES,
) {
    init {
        val problems = mutableListOf<String>()
        val declared = HashSet<String>()
        for ((feature, row) in table) {
            if (row.status == "na") continue
            for (na in row.na) {
                if (na.reason == UnsupportedReason.runtime) continue
                val key = capabilityDetectorKey(feature, na.reason)
                if (na.runtime in runtimes) declared += key
                if (na.runtime == runtime && detectors[key] == null) {
                    problems += "no detector for $feature ${na.reason} on $runtime"
                }
            }
        }
        for (key in detectors.keys.sorted()) {
            if (key !in declared) problems += "detector $key names no conditional N/A in the table"
        }
        if (problems.isNotEmpty()) throw CapabilityTableException(problems.sorted())
    }

    /** The answer for one feature, given the services the client believes the product runs. */
    public fun supports(feature: String, services: ServicesMap): Support {
        fun no(reason: String, detail: String): Support = Support.Unavailable(Unsupported(feature, reason, detail))
        val row = table[feature]
            ?: return no(UnsupportedReason.version, "PolarisKey $POLARIS_SDK_VERSION does not know the feature $feature")
        val here = row.na.filter { it.runtime == runtime }
        if (row.status == "na" && here.isNotEmpty()) return no(here.first().reason, "$feature is not available on $runtime")
        here.firstOrNull { it.reason == UnsupportedReason.runtime }?.let {
            return no(it.reason, "$feature is not available on $runtime")
        }
        if (row.status == "na") return no(UnsupportedReason.runtime, "$feature is not available on $runtime")
        if (row.status == "planned") {
            return no(UnsupportedReason.version, "PolarisKey $POLARIS_SDK_VERSION does not implement $feature yet")
        }
        val slug = ServiceSlug.of(row.service)
        if (slug != null && services[slug] != true) {
            return no(UnsupportedReason.product, "the product does not run the ${row.service} service")
        }
        for (na in here) {
            if (na.reason == UnsupportedReason.runtime) continue
            val detail = detectors[capabilityDetectorKey(feature, na.reason)]?.invoke()
            if (detail != null) return no(na.reason, detail)
        }
        return Support.Supported(feature)
    }

    /** The supported feature ids, in registry order: the `caps` telemetry value. */
    public fun caps(services: ServicesMap): List<String> = FEATURE_VALUES.filter { supports(it, services).isSupported }

    public companion object {
        /**
         * This SDK's detectors. The conditional N/As in `parity.json`: `core.store` on the JVM
         * (`except jvm:dependency`): a JVM process reaches no OS keyring without a native library,
         * so the token lives in a 0600 file and `supports(core.store)` says `dependency`; and
         * `packs.apply.delta` on Android and the JVM (`dependency`) when zstd-jni cannot load.
         */
        public val sdkDetectors: Map<String, CapabilityDetector> = mapOf(
            capabilityDetectorKey(Feature.coreStore, UnsupportedReason.dependency) to {
                "a JVM process reaches no OS keyring without a native library; the token lives in a 0600 file (keyring-unavailable)"
            },
            // P6-08: deltas decode through zstd-jni's native libzstd (:packs' LibZstd). Where that
            // library cannot load (an OS or arch it ships no binary for, an Android build without
            // the AAR's natives), `packs.apply.delta` is `dependency`, never `runtime`. Probed by
            // reflection: :core never links the zstd binding.
            capabilityDetectorKey(Feature.packsApplyDelta, UnsupportedReason.dependency) to {
                if (zstdNativeLoads) null else "zstd-jni's native libzstd does not load on this runtime"
            },
        )

        /** Whether zstd-jni's native library loads here (probed once, by reflection). */
        private val zstdNativeLoads: Boolean by lazy {
            try {
                val native = Class.forName("com.github.luben.zstd.util.Native")
                native.getMethod("load").invoke(null)
                native.getMethod("isLoaded").invoke(null) == true
            } catch (e: Throwable) {
                false
            }
        }

        /** The engine for this process. */
        public fun sdk(): Capabilities = Capabilities(sdkDetectors)
    }
}
