// @pkey-feature release.download update.feed release.fetch release.distribution update.feeds crash.tags
//
// The delivery helpers of the SDK parity pass (notes/SDK-PARITY-PASS.md §3.5–§3.8, §3.14): the
// verified, resumable build download (discovery's builds template, the bearer and X-PKey headers,
// Range windows with If-Range, nothing left at `to` unless size and SHA-256 match), the updater feed
// URLs from discovery (a missing template is the typed `product` N/A), the download page model and
// the crash tags. There is no portal URL builder (owner decision Q6).

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ReleaseRecordArtifact
import im.plrs.key.core.ReleaseRecordBuild
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.UpdateEvent
import im.plrs.key.core.fetchVerified
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.release.ReleaseTarget
import im.plrs.key.core.bearerAllowed
import im.plrs.key.core.fetchVerified
import im.plrs.key.update.FeedKind
import im.plrs.key.update.UpdateClientOptions
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DeliveryHelpersTest {
    private val signer = TestSigner()
    private val payload = ByteArray(20_000) { (it % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }

    private val discovery = """{"product":"djdl","services":{
        "license":{"enabled":true},
        "release":{"enabled":true,"endpoints":{"builds":"https://key.plrs.im/djdl/release/builds/{selector}/{buildId}"}},
        "distribution":{"enabled":true,"endpoints":{"builds":"https://dl.plrs.im/djdl/distribution/builds/{selector}/{buildId}"}},
        "update":{"enabled":true,"endpoints":{"appcast":"https://key.plrs.im/djdl/update/appcast.xml","channelAppcast":"https://key.plrs.im/djdl/update/{channel}/appcast.xml","velopack":"https://key.plrs.im/djdl/update/{channel}/velopack/releases.{velopackChannel}.json"}}
    }}"""

    private fun record(size: Long = payload.size.toLong(), hash: String = sha, tag: String? = null) = ReleaseRecordDoc(
        schemaVersion = 1, aud = "djdl", deliverable = "app", kind = "app", version = "1.4.0", seq = 14, issuedAt = 1_700_000_000, tag = tag,
        builds = listOf(ReleaseRecordBuild("linux-x64", "linux", "x86_64", "appimage", artifacts = listOf(ReleaseRecordArtifact("djdl.AppImage", "payload", hash, size)))),
        json = JsonObject(emptyMap()),
    )

    /** Serves the payload honouring Range (as the Worker's bytes routes do). */
    private fun serving(r: PolarisRequest, failAfter: Int? = null, calls: IntArray = IntArray(1)): PolarisResponse {
        if (r.path == "/djdl/.well-known/polaris.json") return respond(200, discovery)
        if (r.path != "/djdl/distribution/builds/1.4.0/linux-x64") return respond(404)
        calls[0]++
        if (failAfter != null && calls[0] > failAfter) throw PolarisException(ErrorCode.networkError, "reset")
        val range = r.headers["range"]?.let { Regex("bytes=(\\d+)-(\\d*)").find(it) } ?: return PolarisResponse(200, payload, mapOf("etag" to "\"v1\""))
        val start = range.groupValues[1].toInt()
        val end = minOf(range.groupValues[2].toIntOrNull() ?: (payload.size - 1), payload.size - 1)
        return PolarisResponse(206, payload.copyOfRange(start, end + 1), mapOf("content-range" to "bytes $start-$end/${payload.size}", "etag" to "\"v1\""))
    }

    private fun client(handler: (PolarisRequest) -> PolarisResponse, update: UpdateClientOptions? = null): PolarisKeyClient = runBlocking {
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.3.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }, transport = ScriptedTransport(handler), clock = { 1_700_000_000L },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.release, ServiceSlug.distribution, ServiceSlug.update),
                ),
                license = LicenseClientOptions(fingerprint = false),
                update = update,
            ),
        )
    }

    private fun tmp(): File = Files.createTempDirectory("pkey-fetch").toFile()

    @Test
    fun fetchStreamsVerifiesAndJournals() = runBlocking {
        val dir = tmp()
        val transport = mutableListOf<PolarisRequest>()
        val c = client({ transport += it; serving(it) })
        var last = 0L
        val out = c.release.fetch(ReleaseTarget.Record(record(), "linux-x64"), File(dir, "djdl.AppImage")) { got, _ -> last = got }
        assertEquals(payload.size.toLong(), out.size)
        assertEquals(sha, out.sha256)
        assertTrue(out.path.readBytes().contentEquals(payload))
        assertEquals(payload.size.toLong(), last)
        val get = transport.first { it.path.endsWith("/linux-x64") }
        // Discovery's Distribution template (the bytes host), with the bearer and the X-PKey headers.
        assertTrue(get.url.startsWith("https://dl.plrs.im/"))
        assertEquals("Bearer pkeyt_held", get.headers["authorization"])
        assertEquals("dev1", get.headers.entries.first { it.key.equals("x-pkey-device", true) }.value)
        assertEquals("identity", get.headers["accept-encoding"])
        assertFalse(File(dir, "djdl.AppImage.part").exists())
        assertEquals(UpdateEvent.updateDownloaded, c.updateEvents.events().single().event)
        assertEquals("1.4.0", c.updateEvents.events().single().release)
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun theBearerGoesOnlyToTheControlPlaneOrDiscoverysBytesHost() = runBlocking {
        val dir = tmp()
        val transport = mutableListOf<PolarisRequest>()
        val c = client({ transport += it; serving(it) })
        c.core.discover()
        // Another origin serving the same path gets the download, never the device token.
        c.core.fetchVerified("https://evil.example/djdl/distribution/builds/1.4.0/linux-x64", File(dir, "x"), payload.size.toLong(), sha)
        assertTrue(transport.filter { it.url.startsWith("https://evil.example/") }.all { it.headers["authorization"] == null })
        // The bytes host discovery's builds template names, and the control plane's origin, do.
        assertTrue(c.core.bearerAllowed("https://dl.plrs.im/djdl/distribution/builds/1.4.0/linux-x64"))
        assertTrue(c.core.bearerAllowed("https://key.plrs.im/djdl/release/builds/1.4.0/linux-x64"))
        assertFalse(c.core.bearerAllowed("https://dl.plrs.im.evil.example/x"))
        assertFalse(c.core.bearerAllowed("http://dl.plrs.im/x"))
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun aTaggedRecordsDownloadIsJournaledUnderItsTag() = runBlocking {
        val dir = tmp()
        val c = client({ serving(it) })
        c.release.fetch(ReleaseTarget.Record(record(tag = "v1.4.0"), "linux-x64"), File(dir, "djdl.AppImage"))
        // The Worker counts an update-health event only under Release's releaseId: the tag when set.
        assertEquals("v1.4.0", c.updateEvents.events().single().release)
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun anInterruptedDownloadResumesWithIfRange() = runBlocking {
        val dir = tmp()
        val dest = File(dir, "djdl.AppImage")
        val calls = IntArray(1)
        // A tiny window: the first attempt dies after two windows.
        val c = client({ serving(it, failAfter = 2, calls = calls) })
        val core = c.core
        try {
            core.fetchVerified("https://dl.plrs.im/djdl/distribution/builds/1.4.0/linux-x64", dest, payload.size.toLong(), sha, window = 4096)
            fail("expected a network error")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.networkError, e.code)
        }
        assertEquals(8192L, File(dir, "djdl.AppImage.part").length())
        assertFalse(dest.exists())
        val seen = mutableListOf<PolarisRequest>()
        val again = client({ seen += it; serving(it) })
        again.core.fetchVerified("https://dl.plrs.im/djdl/distribution/builds/1.4.0/linux-x64", dest, payload.size.toLong(), sha, window = 4096)
        assertTrue(dest.readBytes().contentEquals(payload))
        assertEquals("bytes=8192-12287", seen.first().headers["range"])
        assertEquals("\"v1\"", seen.first().headers["if-range"])
        // The last window is open-ended (release-fetch-gated.json's resume).
        assertEquals("bytes=16384-", seen.last().headers["range"])
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun aMismatchLeavesNothing() = runBlocking {
        val dir = tmp()
        val c = client({ serving(it) })
        try {
            c.release.fetch(ReleaseTarget.Record(record(hash = "0".repeat(64)), "linux-x64"), File(dir, "x"))
            fail("expected payload-mismatch")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.payloadMismatch, e.code)
        }
        assertTrue(dir.listFiles()!!.isEmpty())
        try {
            c.release.fetch(ReleaseTarget.Record(record(), "windows-x64"), File(dir, "x"))
            fail("expected record-mismatch")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.recordMismatch, e.code)
        }
        // A gated refusal keeps the Worker's code.
        val gated = client({ r -> if (r.path.endsWith("/linux-x64")) respond(403, """{"error":{"code":"not_entitled"}}""") else serving(r) })
        try {
            gated.release.fetch(ReleaseTarget.Record(record(), "linux-x64"), File(dir, "x"))
            fail("expected not_entitled")
        } catch (e: PolarisException) {
            assertEquals("not_entitled", e.code)
        }
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun feedUrlsComeFromDiscovery() = runBlocking {
        val c = client({ serving(it) })
        assertEquals("https://key.plrs.im/djdl/update/appcast.xml", c.update.appcastUrl())
        assertEquals("https://key.plrs.im/djdl/update/beta/appcast.xml", c.update.feedUrl(FeedKind.appcast, channel = "beta"))
        assertEquals("https://key.plrs.im/djdl/update/stable/velopack/releases.win-x64.json", c.update.feedUrl(FeedKind.velopack, velopackChannel = "win-x64"))
        // Without a velopackChannel: the feed directory Velopack's UpdateManager opens.
        assertEquals("https://key.plrs.im/djdl/update/stable/velopack/", c.update.feedUrl(FeedKind.velopack))
        for (call in listOf<suspend () -> String>({ c.update.feedUrl(FeedKind.winsparkle) }, { c.update.feedUrl(FeedKind.zsync, buildId = "linux-x64") })) {
            try {
                call()
                fail("expected the product N/A")
            } catch (e: UnsupportedException) {
                assertEquals(UnsupportedReason.product, e.unsupported.reason)
            }
        }
    }

    @Test
    fun theDownloadModelIsTyped() = runBlocking {
        val model = """{"schemaVersion":1,"product":{"slug":"djdl","name":"Diceroll"},"channel":"stable","pageUrl":"https://dl.plrs.im/djdl",
            "platforms":[{"platform":"android","label":"Android","primary":"play","actions":["play","apk"],"builds":[]},
                         {"platform":"linux","label":"Linux","primary":"dl-linux","actions":["dl-linux"],"builds":[{"releaseId":"r","version":"1.4.0","buildId":"linux-x64","platform":"linux","arch":"x86_64","format":"appimage","name":"Diceroll.AppImage","size":20000,"minOs":null,"url":"https://dl.plrs.im/x","outletId":"download"}]}],
            "actions":[{"id":"play","kind":"store","outletId":"play","platforms":["android"],"label":"Get it on Google Play","url":"https://play.google.com/store/apps/details?id=gg.vlad.diceroll","deepLink":null,"qr":null,"command":null,"fingerprint":null,"version":null,"build":null},
                       {"id":"dl-linux","kind":"download","outletId":"download","platforms":["linux"],"label":"Download","url":"https://dl.plrs.im/x","deepLink":null,"qr":null,"command":null,"fingerprint":null,"version":"1.4.0","build":null}],
            "keys":[]}"""
        val c = client({ r -> if (r.path == "/djdl/distribution/download.json") respond(200, model) else respond(404) })
        val m = c.distribution.downloadModel()
        assertEquals("Diceroll", m.productName)
        assertEquals(2, m.platforms.size)
        assertEquals(20_000L, m.platforms[1].builds.single().size)
        val here = c.distribution.thisPlatform("android")
        assertEquals("Get it on Google Play", here.primaryAction?.label)
        assertEquals(listOf("linux"), here.others.map { it.platform })
    }

    @Test
    fun crashTagsFollowTheSentryConvention() = runBlocking {
        val c = client({ respond(404) }, UpdateClientOptions(pinnedReleaseKeys = TestSigner("rel").trust, outlet = im.plrs.key.core.HostOutlet.Kind("play"), buildNumber = "77", platform = "android", arch = "arm64"))
        assertEquals(mapOf("release" to "app@1.3.0+77", "environment" to "stable", "pkey.outlet" to "play"), c.crashTags())
        assertEquals(mapOf("release" to "app@1.3.0", "environment" to "stable"), client({ respond(404) }).crashTags())
    }
}
