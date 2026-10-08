// @pkey-feature core.sync
//
// SP-50: OkHttpTransport is main-safe. A server that sends the headers, waits, then sends the body
// (what every real network does to a large enough response) used to leave the body read on the
// caller's dispatcher: on Android's main thread that threw NetworkOnMainThreadException. The body is
// now read on Dispatchers.IO; OkHttp's event listener names the thread that read it.

package im.plrs.key.core

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class MainSafeTransportTest {
    @OptIn(ExperimentalCoroutinesApi::class, kotlinx.coroutines.DelicateCoroutinesApi::class)
    @Test
    fun theBodyOfASplitResponseIsNeverReadOnTheCallersThread() {
        val server = MockWebServer()
        val body = "{\"ok\":true,\"pad\":\"" + "x".repeat(4000) + "\"}"
        // Headers first, the body 300 ms later.
        server.enqueue(MockResponse().setBody(body).setBodyDelay(300, TimeUnit.MILLISECONDS))
        server.start()
        val reader = AtomicReference<Thread>()
        val client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun responseBodyEnd(call: Call, byteCount: Long) {
                reader.set(Thread.currentThread())
            }
        }).build()
        val main = newSingleThreadContext("pkey-test-main")
        try {
            val mainThread = runBlocking(main) { Thread.currentThread() }
            val response = runBlocking(main) {
                withContext(main) { OkHttpTransport(client).send(PolarisRequest(server.url("/split").toString())) }
            }
            assertEquals(200, response.status)
            assertEquals(body, response.text)
            assertNotNull("the body was read", reader.get())
            assertNotEquals("the body was read on the caller's thread", mainThread, reader.get())
        } finally {
            main.close()
            server.shutdown()
        }
    }
}

class TransportCloseTest {
    @org.junit.Test
    fun closeLeavesAHostSuppliedClientAlone() {
        val host = okhttp3.OkHttpClient()
        OkHttpTransport(host).close()
        org.junit.Assert.assertFalse(host.dispatcher.executorService.isShutdown)
        // Its own client is shut down.
        val own = OkHttpTransport()
        val field = OkHttpTransport::class.java.getDeclaredField("base").apply { isAccessible = true }
        val ownClient = field.get(own) as okhttp3.OkHttpClient
        own.close()
        own.close()
        org.junit.Assert.assertTrue(ownClient.dispatcher.executorService.isShutdown)
    }
}
