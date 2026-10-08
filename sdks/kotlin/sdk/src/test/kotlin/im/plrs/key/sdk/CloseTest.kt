// @pkey-feature core.sync
//
// SP-51: close() releases everything the client started, so a JVM `main` that used it ends. The child
// JVM below builds a client over the real OkHttp transport, makes a request (which starts OkHttp's
// non-daemon threads), starts the refresh loop, closes, and returns from main: it must exit in 1 s.

package im.plrs.key.sdk

import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CloseTest {
    @Test
    fun aJvmMainExitsWithinOneSecondOfClose() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(404))
        server.start()
        try {
            val java = System.getProperty("java.home") + "/bin/java"
            val process = ProcessBuilder(java, "-cp", System.getProperty("java.class.path"), "im.plrs.key.sdk.CloseMain", server.url("/").toString().trimEnd('/'))
                .redirectErrorStream(true).start()
            val exited = process.waitFor(30, TimeUnit.SECONDS)
            val endedAt = System.currentTimeMillis()
            val output = process.inputStream.bufferedReader().readText()
            assertTrue("the child never exited: $output", exited)
            assertEquals(output, 0, process.exitValue())
            // The child stamps the moment close() returned; the JVM must be gone within a second.
            val closedAt = Regex("CLOSED (\\d+)").find(output)?.groupValues?.get(1)?.toLong() ?: error("close() never returned: $output")
            assertTrue("exit took ${endedAt - closedAt} ms after close()", endedAt - closedAt <= 1_000)
        } finally {
            server.shutdown()
        }
    }
}
