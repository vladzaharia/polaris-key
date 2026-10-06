// A command-line app on the Polaris Key Kotlin SDK (SP-K14): what a JVM tool needs, end to end.
//
//   PKEY_PRODUCT=djdl PKEY_BASE_URL=https://key.plrs.im PKEY_TRUST=k1=<base64url key> \
//     ./gradlew :sample-cli:run --args="status"
//
// Commands: status (sync, then the gate, the licence summary and the entitlements), activate <key>,
// config <key>, set <key> <json>, channels, update (the decision), tags (crash-reporter tags).
// Everything is the SDK's public API; nothing here is sample-only plumbing.

package im.plrs.key.samples.cli

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.isUsable
import im.plrs.key.license.ActivationResult
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import java.io.PrintStream
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull

/** Run one [command] against [client], printing to [out]; returns the process exit code. */
public suspend fun run(client: PolarisKeyClient, command: List<String>, out: PrintStream): Int {
    client.start()
    try {
        when (command.firstOrNull() ?: "status") {
            "status" -> {
                runCatching { client.sync() }.onFailure { out.println("offline: ${it.message}") }
                val state = client.status()
                out.println("gate: ${state.status.wire}${if (isUsable(state.status)) "" else " (not usable)"}")
                client.license.licenseInfo()?.let { info ->
                    out.println("licence: ${info.licenseId} tier=${info.tier ?: "-"} devices=${info.deviceLimit ?: "-"}")
                }
                out.println("entitlements: ${client.license.entitlements().keys.sorted().joinToString(", ").ifEmpty { "-" }}")
            }
            "activate" -> {
                val key = command.getOrNull(1) ?: return usage(out)
                when (val r = client.activate(key)) {
                    is ActivationResult.Ok -> out.println("activated")
                    else -> {
                        out.println("refused: $r")
                        return 2
                    }
                }
            }
            "config" -> {
                val key = command.getOrNull(1) ?: return usage(out)
                out.println("$key = ${client.config(key, JsonNull)} (${client.config.configSource(key)?.name ?: "unset"})")
            }
            "set" -> {
                val key = command.getOrNull(1) ?: return usage(out)
                val value = command.getOrNull(2)?.let { JsonText.parseOrNull(it) } ?: return usage(out)
                client.config.set(key, value)
                out.println("$key = $value (local)")
            }
            "channels" -> {
                val c = client.channelChoices()
                out.println("channel: ${c.current} (build: ${c.buildChannel}); options: ${c.options.joinToString(", ")}${c.lockedBy?.let { "; locked by $it" } ?: ""}")
            }
            "update" -> out.println("decision: ${client.update.decide().decision}")
            "tags" -> client.crashTags().forEach { (k, v) -> out.println("$k=$v") }
            else -> return usage(out)
        }
    } catch (e: PolarisException) {
        out.println("error: ${e.code}: ${e.message}")
        return 1
    }
    return 0
}

private fun usage(out: PrintStream): Int {
    out.println("usage: status | activate <key> | config <key> | set <key> <json> | channels | update | tags")
    return 64
}

/** `k1=<key>,k2=<key>` to a trust set. */
public fun parseTrust(text: String): Map<String, String> =
    text.split(',').mapNotNull { pair -> pair.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() } }.toMap()

public fun main(args: Array<String>) {
    val env = System.getenv()
    val product = env["PKEY_PRODUCT"] ?: error("set PKEY_PRODUCT")
    val client = runBlocking {
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = product,
                    baseUrl = env["PKEY_BASE_URL"] ?: "https://key.plrs.im",
                    version = env["PKEY_VERSION"] ?: "1.0.0",
                    pinnedKeys = parseTrust(env["PKEY_TRUST"] ?: error("set PKEY_TRUST")),
                ),
            ),
        )
    }
    val code = runBlocking { run(client, args.toList(), System.out) }
    client.close()
    kotlin.system.exitProcess(code)
}
