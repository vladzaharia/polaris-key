// @pkey-feature packs.state packs.handlers packs.provides packs.revoke packs.delegation packs.delta.feed
//
// The pack pipeline end to end over a fake byte server (P6-08): install by `full`, the install
// state (commit, previous, rollback, confirm, garbage collection, resume after an interrupted
// download, persistence and a torn `state.json` under DirPackStorage), the handler contract,
// save compatibility (`provides`), revocations (stored, refused, unmounted), content-key delegation
// (a delegated release installs; a non-data-only one is refused), and feed-offered deltas (at most
// one per install, a failed one falling back).

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FeedDelta
import im.plrs.key.core.jsonInt
import im.plrs.key.core.recordHash
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.delegatedKid
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PackEngineTest {
    private suspend fun expectPackError(code: String, body: suspend () -> Unit): PackException {
        try {
            body()
        } catch (e: PackException) {
            assertEquals(e.message, code, e.code)
            return e
        }
        fail("expected $code")
        throw IllegalStateException()
    }

    @Test
    fun installsATreePackByFullCommitsAndActivates() = runBlocking {
        val v1 = treePack("djdl.levels", "1.0.0", 1, mapOf("a.txt" to "alpha".toByteArray(), "dir/b.txt" to "beta".toByteArray()))
        val server = ByteServer(v1)
        val engine = engineOf(server, stampOf(v1))
        engine.load()
        val installs = engine.ensure(listOf("djdl.levels"))
        assertEquals(v1.sha256, installs[0].recordSha256)
        val s = engine.state()
        assertEquals(v1.sha256, s.active["djdl.levels"]?.recordSha256)
        assertEquals(v1.sha256, s.running["djdl.levels"]?.recordSha256)
        val files = engine.open("djdl.levels")!!.files!!.associate { it.path to String(readAll(it.source)) }
        assertEquals(mapOf("a.txt" to "alpha", "dir/b.txt" to "beta"), files)
        assertEquals(packSetId(listOf(PackSetEntry("djdl.levels", v1.sha256))), engine.packSetId())
        // Already current: no second download.
        val before = server.objectRequests.size
        engine.ensure(listOf("djdl.levels"))
        assertEquals(before, server.objectRequests.size)
    }

    @Test
    fun aSecondReleaseKeepsPreviousRollsBackConfirmsAndCollects() = runBlocking {
        val v1 = treePack("djdl.levels", "1.0.0", 1, mapOf("a.txt" to "one".toByteArray()))
        val v2 = treePack("djdl.levels", "1.1.0", 2, mapOf("a.txt" to "two".toByteArray()))
        val v3 = treePack("djdl.levels", "1.2.0", 3, mapOf("a.txt" to "three".toByteArray()))
        val server = ByteServer(v1, v2, v3)
        val storage = MemoryPackStorage()
        val engine = engineOf(server, stampOf(v1), storage)
        engine.load()
        engine.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.levels", v1.pin)))
        engine.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.levels", v2.pin)))
        var s = engine.state()
        assertEquals(v2.sha256, s.active["djdl.levels"]?.recordSha256)
        assertEquals(v1.sha256, s.previous["djdl.levels"]?.recordSha256)
        assertTrue(engine.rollback("djdl.levels"))
        s = engine.state()
        assertEquals(v1.sha256, s.active["djdl.levels"]?.recordSha256)
        assertEquals(v1.sha256, s.running["djdl.levels"]?.recordSha256)
        assertFalse(engine.rollback("djdl.levels"))
        engine.confirm()
        assertEquals(engine.state().bootSeq, engine.state().confirmedBootSeq)
        // A third release: v2's payload (neither active nor previous now) is collected.
        engine.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.levels", v3.pin)))
        val locations = storage.list().first
        assertEquals(2, locations.size)
        assertFalse(locations.any { it.endsWith(v2.payloadSha256) })
    }

    @Test
    fun anInterruptedDownloadResumesWithRange() = runBlocking {
        val big = ByteArray(200_000) { (it % 251).toByte() }
        val v1 = treePack("djdl.levels", "1.0.0", 1, mapOf("big.bin" to big))
        val server = ByteServer(v1)
        server.cutAfter[sha256Of(v1.payload)] = 50_000
        val engine = engineOf(server, stampOf(v1))
        engine.load()
        val e = expectPackError(ErrorCode.networkError) { engine.ensure(listOf("djdl.levels")) }
        assertEquals("djdl.levels", e.packId)
        assertEquals(1, engine.state().inflight.size)
        engine.ensure(listOf("djdl.levels"))
        val resumed = server.objectRequests.last { it.sha256 == sha256Of(v1.payload) }
        assertEquals(50_000L, resumed.offset)
        assertEquals("\"${sha256Of(v1.payload)}\"", resumed.ifRange)
        assertEquals(0, engine.state().inflight.size)
    }

    @Test
    fun theDirectoryStorePersistsAndATornStateIsHeldAside() = runBlocking {
        val dir = Files.createTempDirectory("pkey-packs")
        val v1 = treePack("djdl.levels", "1.0.0", 1, mapOf("a.txt" to "alpha".toByteArray()))
        val server = ByteServer(v1)
        val storage = DirPackStorage(dir)
        val engine = engineOf(server, stampOf(v1), storage, storage.stateStore(), storage.revocationStore())
        engine.load()
        engine.ensure(listOf("djdl.levels"))
        val location = engine.state().active["djdl.levels"]!!.location
        assertTrue(Files.isRegularFile(dir.resolve("state.json")))
        assertEquals("alpha", String(Files.readAllBytes(java.nio.file.Paths.get(location, "a.txt"))))

        // A second process: the install is re-verified and running again.
        val again = engineOf(server, stampOf(v1), DirPackStorage(dir), DirPackStateStore(dir), DirPackStateStore(dir, "revocations.json"))
        again.load()
        assertEquals(v1.sha256, again.state().running["djdl.levels"]?.recordSha256)
        assertNull(again.state().stateIssue)

        // A torn state.json is held aside, never read as empty; GC waits.
        Files.write(dir.resolve("state.json"), "{\"v\":1,\"act".toByteArray())
        val torn = engineOf(server, stampOf(v1), DirPackStorage(dir), DirPackStateStore(dir), DirPackStateStore(dir, "revocations.json"))
        torn.load()
        assertEquals("torn", torn.state().stateIssue)
        assertTrue(Files.isRegularFile(dir.resolve("state.json.torn")))
        assertTrue(Files.isDirectory(java.nio.file.Paths.get(location)))
        torn.recoverState()
        assertNull(torn.state().stateIssue)
        assertFalse(Files.exists(dir.resolve("state.json.torn")))
    }

    @Test
    fun aHandlerCheckRefusalIsPackTypeCheckFailedAndActivationRuns() = runBlocking {
        val good = treePack("djdl.balance", "1.0.0", 1, mapOf("hp.json" to "{\"hp\":10}".toByteArray()), type = "data.json")
        val bad = treePack("djdl.broken", "1.0.0", 1, mapOf("hp.json" to "{\"hp\":10,}".toByteArray()), type = "data.json")
        val server = ByteServer(good, bad)
        val data = DataJsonHandler()
        val engine = engineOf(server, stampOf(good, bad), handlers = listOf(data))
        engine.load()
        engine.ensure(listOf("djdl.balance"))
        assertEquals(listOf("hp.json"), data.documents("djdl.balance")?.map { it.path })
        val e = expectPackError(ErrorCode.packTypeCheckFailed) { engine.ensure(listOf("djdl.broken")) }
        assertEquals("json", e.detail)
        assertEquals("hp.json", e.path)
        assertNull(engine.state().active["djdl.broken"])
        // A custom type is registered at run time; an unknown one is refused.
        val custom = treePack("djdl.dialogue", "1.0.0", 1, mapOf("d.txt" to "hi".toByteArray()), type = "custom.dialogue")
        server.add(custom)
        val engine2 = engineOf(server, stampOf(custom))
        engine2.load()
        expectPackError(ErrorCode.packTypeUnsupported) { engine2.ensure(listOf("djdl.dialogue")) }
        var activated: String? = null
        engine2.registerHandler(object : PackHandler {
            override val type = "custom.dialogue"
            override val layout = "tree"
            override val activation = "hot"
            override fun supports(formatVersion: Long) = formatVersion == 1L
            override suspend fun activate(install: PackInstall, payload: PackPayloadReader) {
                activated = payload.read()?.files?.single()?.path
            }
        })
        engine2.ensure(listOf("djdl.dialogue"))
        assertEquals("d.txt", activated)
        try {
            engine2.registerHandler(object : PackHandler {
                override val type = "custom.bad"
                override val layout = "zip"
                override val activation = "hot"
                override fun supports(formatVersion: Long) = true
            })
            fail("an unknown layout is refused")
        } catch (e: PackException) {
            assertEquals(ErrorCode.invalidOptions, e.code)
        }
    }

    @Test
    fun providesAnswersForTheRunningSetAndPackForTheTargets() = runBlocking {
        val provides = mapOf("provides" to JsonArray(listOf(JsonPrimitive("level:winter"), JsonPrimitive("skin:gold"))))
        val v1 = treePack("djdl.winter", "1.0.0", 1, mapOf("a.txt" to "x".toByteArray()), extra = provides)
        val gated = treePack(
            "djdl.gold", "1.0.0", 1, mapOf("b.txt" to "y".toByteArray()),
            extra = mapOf("provides" to JsonArray(listOf(JsonPrimitive("skin:platinum"))), "entitlement" to JsonPrimitive("gold")),
        )
        val server = ByteServer(v1, gated)
        val engine = engineOf(server, stampOf(v1, gated), entitlements = emptySet())
        engine.load()
        assertFalse(engine.isAvailable("level:winter"))
        assertEquals("djdl.winter", engine.packFor("level:winter")?.packId)
        assertNull(engine.packFor("skin:platinum")) // unentitled: never answers
        engine.ensure(listOf("djdl.winter"))
        assertTrue(engine.isAvailable("level:winter"))
        assertTrue(engine.isAvailable("skin:gold"))
        assertFalse(engine.isAvailable("level:summer"))
        assertTrue(isContentId("a!~"))
        assertFalse(isContentId("has space"))
        assertEquals(emptySet<String>(), providesOf(buildJsonObject { put("provides", JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("a")))) }))
    }

    @Test
    fun aRevokedReleaseIsRefusedUnmountedAndRemembered() = runBlocking {
        val v1 = treePack("djdl.levels", "1.0.0", 1, mapOf("a.txt" to "alpha".toByteArray()))
        val server = ByteServer(v1)
        val revStore = MemoryPackStateStore()
        val state = MemoryPackStateStore()
        val engine = engineOf(server, stampOf(v1), state = state, revocations = revStore)
        engine.load()
        engine.ensure(listOf("djdl.levels"))
        assertNotNull(engine.state().running["djdl.levels"])
        engine.recordRevocations(listOf(revocationOf(v1)))
        assertTrue(engine.isRevoked(v1.sha256))
        assertNull(engine.state().running["djdl.levels"])
        expectPackError(ErrorCode.packRevoked) { engine.ensure(listOf("djdl.levels")) }
        // Persisted: the flag in state.json first, then the sibling file; a new process still refuses.
        assertTrue(state.text!!.contains("\"revocationsStored\":true"))
        assertNotNull(revStore.text)
        val again = engineOf(server, stampOf(v1), state = state, revocations = revStore)
        again.load()
        assertTrue(again.isRevoked(v1.sha256))
        assertNull(again.state().running["djdl.levels"])
        assertEquals(v1.sha256, again.revocations().verified[v1.sha256]?.target)
        // A torn revocations.json re-learns the stamp's packs.
        revStore.text = "{not json"
        val torn = engineOf(server, stampOf(v1), state = state, revocations = revStore)
        torn.load()
        assertEquals("torn", torn.revocations().issue)
        assertEquals(listOf("djdl.levels"), torn.revocations().relearn)
    }

    @Test
    fun aDelegatedReleaseInstallsAndANonDataOnlyOneIsRefused() = runBlocking {
        val content = TestSigner("content")
        val delegationPayload = buildJsonObject {
            put("schemaVersion", jsonInt(1))
            put("aud", JsonPrimitive(PackFixtures.product))
            put("deliverable", JsonPrimitive("djdl.events"))
            put("kind", JsonPrimitive("delegation"))
            put("version", JsonPrimitive("1.0.0"))
            put("seq", jsonInt(1))
            put("issuedAt", jsonInt(PackFixtures.issuedAt))
            put("expiresAt", jsonInt(PackFixtures.issuedAt + 86_400 * 30))
            put("delegate", buildJsonObject { put("publicKey", JsonPrimitive(content.publicKey)) })
            put("types", JsonArray(listOf(JsonPrimitive("data.json"))))
        }
        val delegation = PackFixtures.release.sign("pkey-release+jws", delegationPayload)
        // The content key signs under the pkd1- kid naming its delegation.
        val kid = delegatedKid(recordHash(delegation))
        val good = treePack("djdl.events.winter", "1.0.0", 2, mapOf("e.json" to "{\"id\":\"snow\"}".toByteArray()), type = "data.json", signer = content, kid = kid)
        val bad = treePack("djdl.events.code", "1.0.0", 2, mapOf("e.gd" to "extends Node".toByteArray()), type = "data.json", signer = content, kid = kid)
        val server = ByteServer(good, bad)
        server.records[recordHash(delegation)] = delegation
        val engine = engineOf(server, stampOf(), handlers = listOf(DataJsonHandler()))
        engine.load()
        // Not the stamp's pin: the delegated surface (a feed target).
        val install = engine.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.events.winter", good.pin))).single()
        assertEquals(delegation, install.delegation)
        assertEquals(recordHash(delegation), engine.delegatedReleases()[good.sha256]?.delegation)
        val e = expectPackError(ErrorCode.packNotDataOnly) { engine.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.events.code", bad.pin))) }
        assertEquals("extension", e.detail)
        assertEquals("e.gd", e.path)
        // A pinned release never takes the delegated path: refused at `jws`.
        val pinned = engineOf(server, stampOf(good), handlers = listOf(DataJsonHandler()))
        pinned.load()
        val r = expectPackError(ErrorCode.recordRejected) { pinned.ensure(listOf("djdl.events.winter")) }
        assertEquals("jws", r.detail)
    }

    @Test
    fun aFeedDeltaIsTriedOnceAndFallsBack() = runBlocking {
        val base = ByteArray(40_000) { (it * 7 % 251).toByte() }
        val target = base.copyOf().also { for (i in 1000 until 1200) it[i] = 1 }
        val v1 = containerPack("djdl.blob", "1.0.0", 1, base)
        val v2 = containerPack("djdl.blob", "2.0.0", 2, target)
        val frame = patchFrom(base, target)
        val menu = mapOf(v2.payloadSha256 to listOf(FeedDelta(sha256Of(base), "zstd-patch-from", (base.size + target.size).toLong(), sha256Of(frame), frame.size.toLong())))
        val server = ByteServer(v1, v2)
        server.objects[sha256Of(frame)] = frame
        val engine = engineOf(server, stampOf(v1), feedDeltas = { menu })
        engine.load()
        engine.ensure(listOf("djdl.blob"))
        server.objectRequests.clear()
        engine.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.blob", v2.pin)))
        assertEquals(listOf(sha256Of(frame)), server.fetchedObjects())
        assertEquals(v2.sha256, engine.state().active["djdl.blob"]?.recordSha256)

        // A feed delta that cannot be fetched (a cold delta's 404) falls back to full, once.
        val v3target = target.copyOf().also { it[5] = 9 }
        val v3 = containerPack("djdl.blob", "3.0.0", 3, v3target)
        val frame3 = patchFrom(target, v3target)
        server.add(v3)
        server.missing += sha256Of(frame3)
        val menu3 = mapOf(v3.payloadSha256 to listOf(FeedDelta(sha256Of(target), "zstd-patch-from", (target.size + v3target.size).toLong(), sha256Of(frame3), frame3.size.toLong())))
        val engine3 = engineOf(server, stampOf(v1), feedDeltas = { menu3 }, storage = MemoryPackStorage())
        engine3.load()
        engine3.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.blob", v2.pin)))
        server.objectRequests.clear()
        engine3.ensureReleases(listOf(im.plrs.key.core.PackTarget("djdl.blob", v3.pin)))
        assertEquals(listOf(sha256Of(frame3), sha256Of(v3.payload)), server.fetchedObjects())
        assertEquals(v3.sha256, engine3.state().active["djdl.blob"]?.recordSha256)
    }
}
