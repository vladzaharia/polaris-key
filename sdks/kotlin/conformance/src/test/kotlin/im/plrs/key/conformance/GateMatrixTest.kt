// @pkey-feature license.gate
//
// Cross-SDK gate parity — wire contract v3 §5, driven off conformance/corpus/v2's
// "gate-matrix.json" (version 2, 38 rows), read in place.
//
// Each row carries the BUILD-gate inputs (version, channel, compat window, entitlements) and the
// LICENCE-state inputs, paired with one expected decision. The build-gate half is a PORT, as in
// every runner: `checkBuildGate` mirrors the Worker's (WIRE-CONTRACT-V3 §5.1), rebuilt from
// `Semver`, with the fixture as the oracle (the Worker replays the same rows through its real gate
// in packages/worker/test/gateMatrixCorpus.test.ts). The duplication is deliberate: the matrix
// proves independent implementations agree. The licence half is :core's `licenseState`, which
// `LicenseClient.status()` calls.

package im.plrs.key.conformance

import im.plrs.key.core.ActivationSource
import im.plrs.key.core.AllowedRange
import im.plrs.key.core.BlockInfo
import im.plrs.key.core.BlockReason
import im.plrs.key.core.GateInput
import im.plrs.key.core.LicenseDoc
import im.plrs.key.core.ManagedEntry
import im.plrs.key.core.Semver
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.licenseState
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.license.isUsable
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GateMatrixTest : ConformanceSuite() {
    private val matrix = Corpus.v2("gate-matrix.json")
    private val rows: List<JsonObject> = matrix["rows"]!!.arrayValue!!.map { it.obj }

    // ── The Worker's build gate, ported ──────────────────────────────────────────────────────
    private fun tighterMin(a: String?, b: String?): String? = when {
        a == null -> b
        b == null -> a
        else -> if (Semver.compare(a, b) >= 0) a else b
    }

    private fun tighterMax(a: String?, b: String?): String? = when {
        a == null -> b
        b == null -> a
        else -> if (Semver.compare(a, b) <= 0) a else b
    }

    private val channelAliases = mapOf("staging" to "beta", "latest" to "stable")
    private val prNumberMaxDigits = 7

    private fun prChannel(digits: String) = if (digits.length > prNumberMaxDigits) "pr" else "pr-$digits"

    /** §5.1 rule 2: the family, with a PR build narrowed to its own `pr-<n>`. */
    private fun impliedChannel(version: String): String {
        val family = Semver.channelForVersion(version).wire
        if (family != "pr") return family
        return Regex("^0\\.0\\.0-pr-?([0-9]+)").find(version)?.groupValues?.get(1)?.let(::prChannel) ?: "pr"
    }

    /** §5.1 rule 3: null is a malformed header, which the gate refuses. */
    private fun normalizeChannelHeader(header: String, version: String): String? {
        channelAliases[header]?.let { return it }
        if (header == "pr") {
            val implied = impliedChannel(version)
            return if (Regex("^pr-[0-9]+$").matches(implied)) implied else "pr"
        }
        Regex("^pr-?([0-9]+)$").matchEntire(header)?.let { return prChannel(it.groupValues[1]) }
        return if (Regex("^[a-z0-9][a-z0-9-]{0,63}$").matches(header)) header else null
    }

    /** §5.1 rule 4: `stable` always; exact name; `staging` covers `beta`; `pr` covers `pr-<n>`. */
    private fun channelEntitled(granted: List<String>, channel: String): Boolean {
        if (channel == "stable" || channel in granted) return true
        if (channel == "beta" && "staging" in granted) return true
        return Regex("^pr-[0-9]+$").matches(channel) && "pr" in granted
    }

    /** §5.1 rule 5, in order: dev bypass by grant, version window, malformed header, channels. */
    private fun checkBuildGate(g: JsonObject): BlockInfo? {
        val version = g["version"].stringValue!!
        val entitlements = g["entitlements"].objectValue!!.mapValues { ManagedEntry.from(it.value) }
        val granted = entitlements["channels"]?.value.arrayValue?.mapNotNull { it.stringValue } ?: listOf("stable")
        if (Semver.isDevBuild(version) && "dev" in granted) return null
        val minV = tighterMin(g["compatMin"].stringValue, entitlements["app.minVersion"]?.value.stringValue)
        val maxV = tighterMax(g["compatMax"].stringValue, entitlements["app.maxVersion"]?.value.stringValue)
        val range = AllowedRange(minV, maxV)
        if (minV != null && Semver.compare(version, minV) < 0) return BlockInfo(BlockReason.versionTooOld, range)
        if (maxV != null && Semver.compare(version, maxV) > 0) return BlockInfo(BlockReason.versionTooNew, range)
        var declared: String? = null
        g["channel"].stringValue?.let { header ->
            declared = normalizeChannelHeader(header, version) ?: return BlockInfo(BlockReason.channelNotEntitled)
        }
        for (channel in listOfNotNull(impliedChannel(version), declared).toSet()) {
            if (!channelEntitled(granted, channel)) return BlockInfo(BlockReason.channelNotEntitled)
        }
        return null
    }

    /** Null unless all three timestamps are present: the "token held, nothing cached yet" rows. */
    private fun buildDoc(l: JsonObject): LicenseDoc? {
        val issuedAt = l["issuedAt"].longValue ?: return null
        val expiresAt = l["expiresAt"].longValue ?: return null
        val graceUntil = l["graceUntil"].longValue ?: return null
        return LicenseDoc("key.plrs.im", "djdl", "dev_matrix", issuedAt, expiresAt, graceUntil, "lic_matrix", null, emptyMap())
    }

    // ── The parity assertions ────────────────────────────────────────────────────────────────
    @Test
    fun theMatrixIsV2AndPopulated() {
        assertEquals(2L, matrix["gateMatrixVersion"].longValue)
        assertEquals(38, rows.size)
    }

    @Test
    fun everyRowDecidesAsTheMatrixSays() {
        val f = Failures("gate-matrix.json")
        for (row in rows) {
            val name = row["name"].stringValue!!
            val l = row["license"]!!.obj
            val expect = row["expect"]!!.obj
            val blocked = checkBuildGate(row["gate"]!!.obj)
            val state = licenseState(
                GateInput(
                    licenseServiceEnabled = l["licenseServiceEnabled"].boolValue!!,
                    activation = l["activation"].stringValue?.let { a -> ActivationSource.entries.first { it.wire == a } },
                    doc = buildDoc(l),
                    now = l["now"].longValue!!,
                    lastSyncUnauthorized = l["lastSyncUnauthorized"].boolValue ?: false,
                    blocked = blocked,
                    lastVerifiedAt = l["lastVerifiedAt"].longValue,
                ),
            )
            f.equal(expect["status"].stringValue, state.status.wire) { "$name status" }
            f.equal(expect["ok"].boolValue, isUsable(state)) { "$name usable" }
            // `expect.reason` names the DERIVED build-gate hint, which on the activation-precedes-
            // blocked row is deliberately not the status.
            expect["reason"].stringValue?.let { f.equal(it, blocked?.reason?.wire) { "$name reason" } }
            val range = expect["allowedRange"].objectValue?.let { AllowedRange(it["min"].stringValue, it["max"].stringValue) }
            f.equal(range, state.allowedRange) { "$name allowedRange" }
        }
        f.done(rows.size * 3)
    }

    @Test
    fun theMatrixCarriesTheV3AdditionsAndChannelRows() {
        val names = rows.map { it["name"].stringValue!! }.toSet()
        for (name in listOf(
            "not-applicable — license service disabled, nothing cached",
            "ok — bundle activation inside the document window",
            "needs-activation — unactivated device with a build block (activation precedes blocked)",
            "ok — beta header, channels [stable, staging] (alias)",
            "channel-not-entitled — malformed channel header",
            "ok — dev build with the dev entitlement bypasses the window (R3-01)",
        )) {
            assertTrue("gate-matrix v2 must carry: $name", name in names)
        }
    }
}
