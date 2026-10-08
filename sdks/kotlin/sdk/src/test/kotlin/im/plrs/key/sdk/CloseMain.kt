package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.OkHttpTransport
import im.plrs.key.core.ServiceSlug
import kotlinx.coroutines.runBlocking

/** A JVM `main` that uses a client over the real OkHttp transport, closes it, and returns (SP-51). */
object CloseMain {
    @JvmStatic
    fun main(args: Array<String>) = runBlocking {
        val client = PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", baseUrl = args[0], version = "1.0.0", pinnedKeys = mapOf("k" to "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"),
                    trustRefresh = false, store = InMemoryStore("djdl", "dev-close"), transport = OkHttpTransport(),
                    expectedServices = listOf(ServiceSlug.license),
                ),
                refreshIntervalSeconds = 3600.0,
            ),
        )
        client.start()
        client.discover()
        client.close()
        println("CLOSED " + System.currentTimeMillis())
    }
}
