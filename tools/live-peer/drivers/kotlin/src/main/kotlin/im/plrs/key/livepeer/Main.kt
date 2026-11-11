// The Kotlin live-peer driver (CC-29X.2): :sdk's local links behind the JSON-lines contract in
// tools/live-peer/README.md. One client, no account, local pairing on; discovery is answered by a local
// transport, mDNS by the harness's broker; every dial is real TCP on 127.0.0.1.

package im.plrs.key.livepeer

import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.lan.MdnsAdvert
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException
import java.nio.file.Files
import kotlin.system.exitProcess

private typealias Command = suspend (JsonObject) -> JsonObject

private fun advertOf(m: JsonObject): MdnsAdvert {
    val a = m.getValue("advert").jsonObject
    val txt = (a.getValue("txt") as JsonArray).map { it.jsonPrimitive.content }
    return MdnsAdvert(requireNotNull(a.str("instance")), a.getValue("port").jsonPrimitive.int, txt)
}

private suspend fun answer(
    commands: Map<String, Command>,
    m: JsonObject,
) {
    val seq: JsonElement? = m["seq"]
    try {
        val run = commands[m.str("cmd")] ?: throw Refusal(buildJsonObject { put("message", "unknown command ${m.str("cmd")}") })
        sendAnswer(seq, true, run(m))
    } catch (e: Refusal) {
        sendAnswer(seq, false, e.extra + ("error" to e.error))
    } catch (e: PolarisException) {
        sendAnswer(seq, false, mapOf("error" to errorOf(e)))
    } catch (e: IllegalArgumentException) {
        sendAnswer(seq, false, mapOf("error" to errorOf(e)))
    } catch (e: IllegalStateException) {
        sendAnswer(seq, false, mapOf("error" to errorOf(e)))
    } catch (e: IOException) {
        sendAnswer(seq, false, mapOf("error" to errorOf(e)))
    }
}

private fun parse(line: String): JsonObject? =
    try {
        Json.parseToJsonElement(line).jsonObject
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

fun main() =
    runBlocking {
        System.setOut(System.err)
        val root = Files.createTempDirectory("pkey-live-kotlin-").toFile()
        val recvDir = root.resolve("recv").also { it.mkdirs() }
        val net = BrokerNet()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val client = makeClient()
        val cc = client.cloudConnect
        val pairing = Pairing(cc.localLinks, net, scope)
        val sessions = Sessions(cc.localLinks, cc.transfer, recvDir)
        sessions.start()
        startLan(client, net)

        fun shutdown(): Nothing {
            runBlocking {
                runCatching { pairing.stop() }
                runCatching { cc.stop() }
            }
            client.close()
            root.deleteRecursively()
            exitProcess(0)
        }

        val commands =
            mapOf<String, Command>(
                "show" to pairing::show,
                "join" to pairing::join,
                "list" to { pairing.list() },
                "forget" to pairing::forget,
                "open" to sessions::open,
                "send" to sessions::send,
                "recv" to { sessions.recv() },
                "events" to { sessions.drain() },
                "quit" to { JsonObject(emptyMap()) },
            )
        send(
            buildJsonObject {
                put("ready", true)
                put("driver", "kotlin")
            },
        )
        val reader = System.`in`.bufferedReader()
        while (true) {
            val line = withContext(Dispatchers.IO) { reader.readLine() } ?: shutdown()
            val m = parse(line) ?: continue
            when (m.str("mdns")) {
                "up" -> {
                    net.remoteUp(advertOf(m))
                }

                "down" -> {
                    net.remoteDown(requireNotNull(m.str("instance")))
                }

                else -> {
                    scope.launch {
                        answer(commands, m)
                        if (m.str("cmd") == "quit") shutdown()
                    }
                }
            }
        }
    }
