// The Polaris Key wire types — Kotlin mirrors of `@polaris-key/protocol`'s v3/v4 tree, decoded by
// hand from the verified `JsonObject` so the presence and type rules are the corpus's
// (WIRE-CONTRACT-V4 §3 "Members outside the claims"), not a serialization library's. Each decoder
// follows Swift's PolarisKeyCore model of the same name; a decoder that returns null refuses the
// document.
//
// Times are epoch SECONDS (the JOSE world the Worker signs in), never millis.

package im.plrs.key.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

// ── Wire constants (§2, §8) ──────────────────────────────────────────────────────────────────

/** The `iss` every Polaris Key document carries; never derived from the base URL (Amendment A1). */
public const val POLARIS_ISSUER: String = "key.plrs.im"

/** Short signed-document lifetime (seconds). */
public const val DOC_EXPIRY_SECONDS: Long = 3600

/** Seconds per day. */
public const val SECONDS_PER_DAY: Long = 86_400

/** Tolerance on every clock comparison, identical in all implementations (§2, R2-08). */
public const val CLOCK_SKEW_SECONDS: Long = 300

/** Upper bound on `graceUntil - issuedAt`, applied at VERIFY time (§3.3). */
public const val MAX_GRACE_SECONDS: Long = 365 * SECONDS_PER_DAY

/** How close to `expiresAt` a cached document may drift before a 304 escalates to a full fetch (§5). */
public const val REFRESH_MARGIN_SECONDS: Long = DOC_EXPIRY_SECONDS / 2

/** Maximum decoded payload bytes for `pkey-bundle+jws` (§1). */
public const val MAX_BUNDLE_BYTES: Int = 262_144

/** Trust-manifest wire versions this SDK understands; an unknown one fails closed. */
public val SUPPORTED_TRUST_SCHEMA_VERSIONS: Set<Long> = setOf(1L)

/** On-disk cache format version (§4.1). Any other value is discarded, never migrated. */
public const val CACHE_RECORD_VERSION: Int = 3

/** The `X-PKey-SDK` value: this SDK's id in the generated `SdkId`. */
public const val POLARIS_SDK_NAME: String = SdkId.kotlin

/** The `X-PKey-SDK-Version` value. */
public const val POLARIS_SDK_VERSION: String = "0.1.0"

/** The device credential prefix (§6). */
public const val DEVICE_TOKEN_PREFIX: String = "pkeyt_"

/** Saturating add: claim arithmetic on attacker-influenced timestamps must not overflow. */
public fun saturatingAdd(a: Long, b: Long): Long {
    val r = a + b
    if (((a xor r) and (b xor r)) < 0) return if (b > 0) Long.MAX_VALUE else Long.MIN_VALUE
    return r
}

// ── Managed values ───────────────────────────────────────────────────────────────────────────

/** Per-key MDM-style management state. */
public enum class ManagementState(public val wire: String) {
    default("default"),
    enforced("enforced"),
    hidden("hidden"),
    ;

    public companion object {
        public fun of(wire: String?): ManagementState? = entries.firstOrNull { it.wire == wire }
    }
}

/** A managed value, its management state and when it last changed server-side (epoch seconds). */
public data class ManagedEntry(
    val state: ManagementState,
    val value: JsonElement,
    val updatedAt: Long,
) {
    public companion object {
        /**
         * TOTAL (V4 §3): a non-object reads `{default, null, 0}`, an unknown or non-string `state`
         * reads `default`, a missing `value` reads null, a non-integer `updatedAt` reads 0.
         */
        public fun from(element: JsonElement?): ManagedEntry {
            val o = element.objectValue ?: return ManagedEntry(ManagementState.default, JsonNull, 0)
            return ManagedEntry(
                state = ManagementState.of(o["state"].stringValue) ?: ManagementState.default,
                value = o["value"] ?: JsonNull,
                updatedAt = o["updatedAt"].longValue ?: 0,
            )
        }

        internal fun map(element: JsonElement?): Map<String, ManagedEntry>? {
            val o = element.objectValue ?: return null
            return o.mapValues { from(it.value) }
        }
    }
}

// ── The shared envelope (§2) ─────────────────────────────────────────────────────────────────

/** The claims every per-service signed document carries. */
public interface DocClaims {
    public val iss: String
    public val aud: String
    public val deviceId: String
    public val issuedAt: Long
    public val expiresAt: Long
    public val graceUntil: Long
}

/**
 * The person signed in on this device: `profile.user` (V4 §2.1, plans/SP-54.md). The pairwise
 * subject only: no name, email or account id.
 */
public data class SignedInUser(val subject: String) {
    public companion object {
        private val SUBJECT = Regex(PAIRWISE_SUBJECT_PATTERN)

        /** Total over any value: an object whose `subject` wholly matches the pattern, else null.
         *  Unknown members are ignored. */
        public fun from(element: JsonElement?): SignedInUser? {
            val subject = element.objectValue?.get("subject").stringValue ?: return null
            return if (SUBJECT.matches(subject)) SignedInUser(subject) else null
        }
    }
}

/**
 * The signed profile block. [user] is set only when an account signed in on this device
 * (SP-54); a key-activated device has the holder's [email] and no [user].
 */
public data class DocProfile(
    val name: String,
    val firstName: String,
    val email: String,
    val activatedAt: Long,
    val user: SignedInUser? = null,
) {
    public companion object {
        /** Total over the members; only a non-object refuses (the licence). */
        public fun from(element: JsonElement?): DocProfile? {
            val o = element.objectValue ?: return null
            return DocProfile(
                name = o["name"].stringValue ?: "",
                firstName = o["firstName"].stringValue ?: "",
                email = o["email"].stringValue ?: "",
                activatedAt = o["activatedAt"].longValue ?: 0,
                user = SignedInUser.from(o["user"]),
            )
        }
    }
}

/**
 * Port of client-core `licenseUserOf`: the signed-in subject of a VERIFIED licence document, or
 * null. Total: a malformed or absent member is null, never an error.
 */
public fun licenseUser(doc: LicenseDoc?): SignedInUser? = doc?.profile?.user

/** The same reader over a decoded profile. */
public fun licenseUser(profile: DocProfile?): SignedInUser? = profile?.user

/** The license document (`pkey-license+jws`, §2.1) — the only carrier of grant data (D-20). */
public data class LicenseDoc(
    override val iss: String,
    override val aud: String,
    override val deviceId: String,
    override val issuedAt: Long,
    override val expiresAt: Long,
    override val graceUntil: Long,
    val licenseId: String,
    val profile: DocProfile?,
    val entitlements: Map<String, ManagedEntry>,
) : DocClaims {
    public companion object {
        /** V4 §3 presence: `profile` is absent or an object; a present `null` refuses. */
        public fun from(o: JsonObject): LicenseDoc? {
            var profile: DocProfile? = null
            if (o.containsKey("profile")) profile = DocProfile.from(o["profile"]) ?: return null
            return LicenseDoc(
                iss = o["iss"].stringValue ?: return null,
                aud = o["aud"].stringValue ?: return null,
                deviceId = o["deviceId"].stringValue ?: return null,
                issuedAt = o["issuedAt"].longValue ?: return null,
                expiresAt = o["expiresAt"].longValue ?: return null,
                graceUntil = o["graceUntil"].longValue ?: return null,
                licenseId = o["licenseId"].stringValue ?: return null,
                profile = profile,
                entitlements = ManagedEntry.map(o["entitlements"]) ?: return null,
            )
        }
    }
}

/** The config document (`pkey-config+jws`, §2.2) — config + secrets, no licence fields. */
public data class ConfigDoc(
    override val iss: String,
    override val aud: String,
    override val deviceId: String,
    override val issuedAt: Long,
    override val expiresAt: Long,
    override val graceUntil: Long,
    /** The product's active CATALOG version, not the wire protocol version. */
    val schemaVersion: Long,
    val config: Map<String, ManagedEntry>,
    val secrets: Map<String, ManagedEntry>,
) : DocClaims {
    public companion object {
        public fun from(o: JsonObject): ConfigDoc? {
            return ConfigDoc(
                iss = o["iss"].stringValue ?: return null,
                aud = o["aud"].stringValue ?: return null,
                deviceId = o["deviceId"].stringValue ?: return null,
                issuedAt = o["issuedAt"].longValue ?: return null,
                expiresAt = o["expiresAt"].longValue ?: return null,
                graceUntil = o["graceUntil"].longValue ?: return null,
                schemaVersion = o["schemaVersion"].longValue ?: return null,
                config = ManagedEntry.map(o["config"]) ?: return null,
                secrets = ManagedEntry.map(o["secrets"]) ?: return null,
            )
        }
    }
}

/** The inner-document slice of a bundle; a present `null` member refuses (V4 §3). */
public data class BundleDocs(val license: String?, val config: String?) {
    public companion object {
        public fun from(element: JsonElement?): BundleDocs? {
            val o = element.objectValue ?: return null
            fun member(key: String): Result<String?> =
                if (!o.containsKey(key)) Result.success(null)
                else o[key].stringValue?.let { Result.success(it) } ?: Result.failure(IllegalStateException(key))
            return BundleDocs(
                license = member("license").getOrElse { return null },
                config = member("config").getOrElse { return null },
            )
        }
    }
}

/** The offline activation bundle payload (`pkey-bundle+jws`, §7). Not a [DocClaims]. */
public data class BundleDoc(
    val bundleId: String,
    val aud: String,
    val deviceId: String,
    val issuedAt: Long,
    /** The operator's IMPORT deadline. */
    val expiresAt: Long,
    val docs: BundleDocs,
    /** The trust manifest (`pkey-trust+jws`). */
    val trust: String,
) {
    public companion object {
        public fun from(o: JsonObject): BundleDoc? {
            return BundleDoc(
                bundleId = o["bundleId"].stringValue ?: return null,
                aud = o["aud"].stringValue ?: return null,
                deviceId = o["deviceId"].stringValue ?: return null,
                issuedAt = o["issuedAt"].longValue ?: return null,
                expiresAt = o["expiresAt"].longValue ?: return null,
                docs = BundleDocs.from(o["docs"]) ?: return null,
                trust = o["trust"].stringValue ?: return null,
            )
        }
    }
}

/** One key a trust manifest publishes. */
public data class TrustManifestKey(
    val kid: String,
    val alg: String,
    val kty: String,
    val crv: String,
    val publicKey: String,
    val status: String,
) {
    public companion object {
        /** `kid` and `publicKey` must be strings; the rest read "" when missing or mistyped. */
        public fun from(element: JsonElement?): TrustManifestKey? {
            val o = element.objectValue ?: return null
            return TrustManifestKey(
                kid = o["kid"].stringValue ?: return null,
                alg = o["alg"].stringValue ?: "",
                kty = o["kty"].stringValue ?: "",
                crv = o["crv"].stringValue ?: "",
                publicKey = o["publicKey"].stringValue ?: return null,
                status = o["status"].stringValue ?: "",
            )
        }
    }
}

/** The signed trust manifest (`pkey-trust+jws`, §2.3). */
public data class TrustManifestDoc(
    val schemaVersion: Long,
    val aud: String,
    val iss: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val jwksUrl: String,
    val cacheSeconds: Long,
    val keys: List<TrustManifestKey>,
) {
    public companion object {
        public fun from(o: JsonObject): TrustManifestDoc? {
            val rawKeys = o["keys"].arrayValue ?: return null
            val keys = rawKeys.map { TrustManifestKey.from(it) ?: return null }
            return TrustManifestDoc(
                schemaVersion = o["schemaVersion"].longValue ?: return null,
                aud = o["aud"].stringValue ?: return null,
                iss = o["iss"].stringValue ?: return null,
                issuedAt = o["issuedAt"].longValue ?: return null,
                expiresAt = o["expiresAt"].longValue ?: return null,
                jwksUrl = o["jwksUrl"].stringValue ?: "",
                cacheSeconds = o["cacheSeconds"].longValue ?: 0,
                keys = keys,
            )
        }
    }
}

// ── Gate vocabulary (§5) ─────────────────────────────────────────────────────────────────────

/** A 403 block reason from `GET /<product>/license/document`. */
public enum class BlockReason(public val wire: String) {
    versionTooOld("version-too-old"),
    versionTooNew("version-too-new"),
    channelNotEntitled("channel-not-entitled"),
    ;

    public companion object {
        public fun of(wire: String?): BlockReason? = entries.firstOrNull { it.wire == wire }
    }
}

/** The version window a blocked client may run within. */
public data class AllowedRange(val min: String? = null, val max: String? = null)

/** The terminal gate state a client renders from. */
public enum class LicenseStatus(public val wire: String) {
    ok("ok"),
    grace("grace"),
    expired("expired"),
    revoked("revoked"),
    needsActivation("needs-activation"),
    versionTooOld("version-too-old"),
    versionTooNew("version-too-new"),
    channelNotEntitled("channel-not-entitled"),
    notApplicable("not-applicable"),
    ;

    public companion object {
        public fun of(wire: String?): LicenseStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** How this install became activated (§7). */
public enum class ActivationSource(public val wire: String) {
    token("token"),
    bundle("bundle"),
}

/** Per-product device registration policy (§6). */
public enum class RegistrationPolicy(public val wire: String) {
    `open`("open"),
    requiresIdentity("requires-identity"),
    requiresLicense("requires-license"),
    ;

    public companion object {
        public fun of(wire: String?): RegistrationPolicy? = entries.firstOrNull { it.wire == wire }
    }
}
