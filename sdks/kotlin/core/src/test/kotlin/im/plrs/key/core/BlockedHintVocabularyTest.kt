// @pkey-feature license.gate core.cache core.sync
//
// The unsigned `blocked` hint's VOCABULARY (WIRE-CONTRACT-V4 §4.1).
//
// The hint stays unsigned because a forged one can only make the gate STRICTER, and that is a claim
// about its reason: the gate reports the reason AS the status, and `ok`, `grace` and `not-applicable`
// are usable. Kotlin keeps the claim true by TYPE (`BlockReason` is a closed enum of the three
// non-usable reasons, so the gate cannot be handed another), which leaves two things to pin:
//
//   - the enum itself: exactly the three 403 reasons, none of them usable, and nothing else answers
//     `BlockReason.of`
//   - the two edges that decode a reason from UNSIGNED JSON: a 403 body claiming a reason outside the
//     vocabulary reads as the stricter block and never as a licensed client; a cache record whose hint
//     is outside it loads WITHOUT the hint and is otherwise kept
//
// plus the gate's own order, which no hint can rearrange. The corpus rows that carry a poisoned hint
// (`gate-matrix.json`, `license.blocked`) run in :conformance.

package im.plrs.key.core

import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockedHintVocabularyTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val licenseJws = signer.licenseDoc("djdl", "dev1", now)

    private fun core(store: Store, handler: (PolarisRequest) -> PolarisResponse = { respond(404) }) = CoreContext(
        CoreOptions(
            productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
            store = store, transport = ScriptedTransport(handler), clock = { now },
        ),
    )

    // ── The enum, and the gate over it ───────────────────────────────────────────────────────

    private val doc = LicenseDoc("key.plrs.im", "djdl", "dev_gate", 1000, 4600, 2_593_000, "lic_gate", null, emptyMap())

    private fun state(
        hint: BlockInfo?,
        activation: ActivationSource? = ActivationSource.token,
        licenseServiceEnabled: Boolean = true,
        held: LicenseDoc? = doc,
    ) = licenseState(
        GateInput(licenseServiceEnabled = licenseServiceEnabled, activation = activation, doc = held, now = 1500, blocked = hint),
    )

    @Test
    fun theVocabularyIsTheThreeNonUsable403Reasons() {
        assertEquals(listOf("version-too-old", "version-too-new", "channel-not-entitled"), BlockReason.entries.map { it.wire })
        for (reason in BlockReason.entries) {
            val status = state(BlockInfo(reason)).status
            assertEquals(reason.wire, status.wire)
            assertFalse("$reason is usable: the vocabulary could loosen the gate", isUsable(status))
        }
    }

    @Test
    fun nothingOutsideTheVocabularyIsABlockReason() {
        val outside = listOf(
            "ok", "grace", "expired", "revoked", "needs-activation", "not-applicable", "definitely-fine", "",
            "Version-Too-Old", " version-too-old", "version-too-old ", "version_too_old", null,
        )
        for (value in outside) assertNull("$value", BlockReason.of(value))
        for (reason in BlockReason.entries) assertEquals(reason, BlockReason.of(reason.wire))
    }

    @Test
    fun everyMemberIsHonouredVerbatimWithItsRange() {
        for (reason in BlockReason.entries) {
            val st = state(BlockInfo(reason, AllowedRange(min = "1.0.0")))
            assertEquals(reason.wire, st.status.wire)
            assertEquals(AllowedRange(min = "1.0.0"), st.allowedRange)
        }
    }

    @Test
    fun theGuardsThatPrecedeTheHintStillPrecedeIt() {
        val hint = BlockInfo(BlockReason.versionTooNew)
        assertEquals(LicenseStatus.needsActivation, state(hint, activation = null, held = null).status)
        assertEquals(LicenseStatus.notApplicable, state(hint, activation = null, licenseServiceEnabled = false, held = null).status)
        // The hint itself is read BEFORE the no-document check, so it needs no document to block.
        assertEquals(LicenseStatus.versionTooNew, state(hint).status)
        assertEquals(LicenseStatus.versionTooNew, state(hint, held = null).status)
    }

    // ── The 403 body ─────────────────────────────────────────────────────────────────────────

    private fun blockedBy(body: String): DocumentResult.Blocked = runBlocking {
        val core = core(InMemoryStore("djdl", "dev1")) { respond(403, body) }
        core.start()
        core.getDocument(DocumentSlice.license, "pkeyt_held") as DocumentResult.Blocked
    }

    @Test
    fun a403BodyNamingAReasonOutsideTheVocabularyReadsAsTheStricterBlock() {
        for (body in listOf(
            """{"error":{"code":"version_blocked","reason":"ok"}}""",
            """{"reason":"grace"}""",
            """{"error":{"reason":"not-applicable"}}""",
            """{"error":{"reason":5},"reason":["version-too-old"]}""",
            """{"error":{"reason":""},"reason":null}""",
            """{"error":{"reason":"Version-Too-Old"}}""",
            """{"error":"ok","reason":"ok"}""",
            """{}""", """[]""", "", "not json",
        )) {
            assertEquals(body, BlockReason.versionTooOld, blockedBy(body).reason)
        }
    }

    @Test
    fun a403TakesTheFirstReasonInsideTheVocabulary() {
        assertEquals(BlockReason.versionTooNew, blockedBy("""{"error":{"reason":"ok"},"reason":"version-too-new"}""").reason)
        assertEquals(
            BlockReason.channelNotEntitled,
            blockedBy("""{"error":{"reason":"channel-not-entitled"},"reason":"version-too-new"}""").reason,
        )
    }

    @Test
    fun aReasonOutsideTheVocabularyFallsBackToTheErrorCode() {
        assertEquals(BlockReason.channelNotEntitled, blockedBy("""{"error":{"code":"channel_not_allowed","reason":"ok"}}""").reason)
        assertEquals(BlockReason.versionTooOld, blockedBy("""{"error":{"code":"version_blocked","reason":"ok"}}""").reason)
    }

    @Test
    fun theAllowedRangeSurvivesAPoisonedReason() {
        val blocked = blockedBy("""{"error":{"reason":"ok"},"allowedRange":{"min":"1.0.0","max":"3.0.0"}}""")
        assertEquals(BlockReason.versionTooOld, blocked.reason)
        assertEquals(AllowedRange("1.0.0", "3.0.0"), blocked.allowedRange)
    }

    @Test
    fun a403BodyNamingAUsableReasonCannotLicenceTheClient() = runBlocking {
        for (body in listOf(
            """{"error":{"code":"version_blocked","reason":"ok"}}""",
            """{"reason":"grace"}""",
            """{"error":{"reason":"not-applicable"}}""",
        )) {
            val store = InMemoryStore("djdl", "dev1")
            store.setToken("pkeyt_held")
            store.writeCache(CacheRecord(docs = mapOf(DocumentSlice.license to licenseJws), etags = mapOf(DocumentSlice.license to "\"e1\"")))
            val core = core(store) { r -> if (r.path == "/djdl/license/document") respond(403, body) else respond(404) }
            core.start()
            assertEquals(LicenseStatus.ok, core.licenseStatus().status)

            assertTrue(body, core.sync().blocked)
            val status = core.licenseStatus().status
            assertEquals(body, LicenseStatus.versionTooOld, status)
            assertFalse(body, isUsable(status))
            assertEquals(body, BlockReason.versionTooOld, store.readCache()!!.blocked!!.reason)
        }
    }

    // ── The cache record ─────────────────────────────────────────────────────────────────────

    private fun record(blocked: String) =
        """{"v":3,"trustJws":"t.t.t","docs":{"license":"l.l.l"},"etags":{"license":"\"e\""},"blocked":$blocked}"""

    /** The hint is dropped, never coerced into a block, and the record is never discarded with it. */
    @Test
    fun aCacheRecordWhoseHintIsOutsideTheVocabularyLoadsWithoutIt() {
        for (hint in listOf(
            """{"reason":"ok"}""", """{"reason":"grace"}""", """{"reason":"not-applicable"}""", """{"reason":"expired"}""",
            """{"reason":""}""", """{"reason":"Version-Too-Old"}""", """{"reason":5}""", """{"reason":["version-too-old"]}""",
            """{"reason":null}""", """{"allowedRange":{"min":"2.0.0"}}""", "{}", "\"ok\"", "[\"ok\"]", "5", "null",
        )) {
            val loaded = CacheRecord.fromJson(JsonText.parse(record(hint)))
            assertNotNull(hint, loaded)
            assertNull(hint, loaded!!.blocked)
            assertEquals(hint, "t.t.t", loaded.trustJws)
            assertEquals(hint, mapOf(DocumentSlice.license to "l.l.l"), loaded.docs)
            assertEquals(hint, mapOf(DocumentSlice.license to "\"e\""), loaded.etags)
        }
        for (member in BlockReason.entries) {
            val loaded = CacheRecord.fromJson(JsonText.parse(record("""{"reason":"${member.wire}","allowedRange":{"min":"2.0.0","x":1}}""")))
            assertEquals(BlockInfoRecord(member, AllowedRange(min = "2.0.0")), loaded!!.blocked)
        }
    }

    /** A FileStore that reads no platform anchor, so the test does not depend on the machine it runs on. */
    private class UnanchoredFileStore(inner: FileStore) : Store by inner {
        override suspend fun anchoredDeviceId(): String? = null
    }

    /** The gate state of an install whose `cache.json` was hand-edited to carry [hint] and nothing else. */
    private suspend fun statusWithPlantedHint(hint: String): LicenseState {
        val root = Files.createTempDirectory("pkey-planted").toFile()
        try {
            val dir = File(root, "djdl")
            val files = FileStore("djdl", dir)
            files.setToken("pkeyt_held")
            File(dir, "cache.json").writeText("""{"v":3,"blocked":$hint}""")
            val core = core(UnanchoredFileStore(files))
            core.start()
            return core.licenseStatus()
        } finally {
            root.deleteRecursively()
        }
    }

    /**
     * `{"v":3,"blocked":{"reason":"ok"}}` written into the cache file is read BEFORE the no-document check,
     * so it would need neither a document nor a signature. The decode drops a hint outside the
     * vocabulary, leaving the install un-activated; a member of the vocabulary still blocks.
     */
    @Test
    fun aBlockHintPlantedInTheCacheFileCannotLicenceTheClient() = runBlocking {
        for (hint in listOf("""{"reason":"ok"}""", """{"reason":"grace"}""", """{"reason":"not-applicable"}""", """{"reason":5}""")) {
            val st = statusWithPlantedHint(hint)
            assertEquals(hint, LicenseStatus.needsActivation, st.status)
            assertFalse(hint, isUsable(st.status))
        }
        val st = statusWithPlantedHint("""{"reason":"version-too-new","allowedRange":{"min":"2.0.0"}}""")
        assertEquals(LicenseStatus.versionTooNew, st.status)
        assertEquals(AllowedRange(min = "2.0.0"), st.allowedRange)
    }
}
