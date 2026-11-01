// The Cloud Sync file transcripts (U-23.K6; `cloudSyncFile`, `cloudSyncChunk` in packages/worker/test/transcripts/format.ts):
// one step is one request through `HttpFileTransport`, the SDK's own transport. The request bodies the SDK is not the
// author of (a `begin` or `plan` payload; the bytes of a PUT) are the recording's, as in the Node replayer: this holds
// the SDK to the path, the headers (`Content-Digest` included), the allow-list and the reading of the answers. The
// engine's order of calls is `CloudSyncTransferTest`'s.

package im.plrs.key.conformance

import im.plrs.key.core.CoreContext
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.sdk.FileBody
import im.plrs.key.sdk.FileQuery
import im.plrs.key.sdk.FileReply
import im.plrs.key.sdk.FileTarget
import im.plrs.key.sdk.HttpFileTransport
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.util.Base64

object CloudSyncFilesReplay {
    private fun sha256Hex(d: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(d).joinToString("") { "%02x".format(it) }

    private fun recorded(step: JsonObject): JsonObject = step["exchanges"]!!.obj["items"]!!.arrayValue!![0].obj["request"]!!.obj

    private fun recordedJson(step: JsonObject): JsonObject = recorded(step)["body"].objectValue!!["json"].objectValue!!

    private fun recordedBytes(step: JsonObject): ByteArray = Base64.getDecoder().decode(recorded(step)["bodyBase64"].stringValue!!)

    /**
     * The digest the recording sent, as lowercase hex. A mismatch recording sends a digest of other bytes on purpose, so the
     * replay sends the recorded one rather than hashing what it sends.
     */
    private fun recordedDigest(step: JsonObject): String {
        val header = recorded(step)["headers"].objectValue!!["content-digest"].stringValue!!
        val b64 = Regex("^sha-256=:([A-Za-z0-9+/=]+):$").matchEntire(header)!!.groupValues[1]
        return Base64.getDecoder().decode(b64).joinToString("") { "%02x".format(it) }
    }

    private fun <T> refused(out: MutableMap<String, JsonElement>, r: FileReply.Refused) {
        val f = r.refusal
        out["result"] = JsonPrimitive("refused")
        out["status"] = jsonInt(f.status.toLong())
        out["code"] = JsonPrimitive(f.code)
        f.body.objectValue?.get("missing")?.let { out["missing"] = it }
        f.body.objectValue?.get("server").objectValue?.get("version")?.let { out["serverVersion"] = it }
        f.retryAfterSeconds?.let { out["retryAfter"] = jsonInt(it.toLong()) }
    }

    private fun ids(a: JsonElement?): List<String> = a.arrayValue.orEmpty().mapNotNull { it.stringValue }

    suspend fun run(core: CoreContext, step: JsonObject, session: ReplaySession, out: MutableMap<String, JsonElement>) {
        val tap = session.tap ?: throw AssertionError("no header tap")
        val args = step["args"]!!.obj
        val op = args["op"].stringValue!!
        val collection = args["collection"].stringValue!!
        val id = args["id"].stringValue
        val target = FileTarget(collection, id ?: "")
        val transport = HttpFileTransport(core)

        // The recorded path carries the upload id the recording drew (format.ts): the replay sends to that one.
        fun upload() =
            Regex("/upload/([^/?]+)").find(recorded(step)["path"].stringValue!!)?.groupValues?.get(1) ?: throw AssertionError("$op names no upload")

        fun ok(extra: Map<String, JsonElement> = emptyMap()) {
            out["result"] = JsonPrimitive("ok")
            out["status"] = jsonInt(tap.lastStatus.toLong())
            out.putAll(extra)
        }

        fun <T> reply(r: FileReply<T>, onOk: (T) -> Unit) {
            when (r) {
                is FileReply.Ok -> onOk(r.value)
                is FileReply.Refused -> refused<T>(out, r)
            }
        }

        fun fields(o: JsonObject, vararg names: String) = names.mapNotNull { n -> o[n]?.let { n to it } }.toMap()

        fun bytesOf(b: FileBody) = mapOf("size" to jsonInt(b.data.size.toLong()), "sha256" to JsonPrimitive(sha256Hex(b.data)))

        when (op) {
            "begin" -> reply(transport.begin(target, recordedJson(step))) { o ->
                ok(fields(o, "mode", "partBytes"))
            }

            "status" -> reply(transport.status(target, upload())) { o -> ok(fields(o, "mode", "size", "received", "missing")) }

            "put", "putManifest" -> {
                val bytes = recordedBytes(step)
                reply(transport.putSingle(target, upload(), bytes, recordedDigest(step))) { ok() }
            }

            "part" -> {
                val bytes = recordedBytes(step)
                reply(transport.putPart(target, upload(), args["part"].longValue!!.toInt(), bytes, recordedDigest(step))) { ok() }
            }

            "putChunk" -> {
                val bytes = recordedBytes(step)
                reply(transport.putChunk(target, upload(), args["chunk"].stringValue!!, bytes, recordedDigest(step))) { ok() }
            }

            "abort" -> reply(transport.abort(target, upload())) { ok() }

            "plan" -> reply(transport.planChunks(target, upload(), recordedJson(step))) { o ->
                val present = o["present"].arrayValue.orEmpty().sortedBy { it.arrayValue?.firstOrNull().stringValue }
                ok(mapOf("missing" to JsonArray(ids(o["missing"]).sorted().map { JsonPrimitive(it) }), "present" to JsonArray(present)))
            }

            "finalize" -> reply(
                transport.finalize(
                    target,
                    buildJsonObject {
                        put("uploadId", recordedJson(step)["uploadId"].stringValue!!)
                    },
                ),
            ) { o -> ok(fields(o, "version", "size", "sha256", "format")) }

            "download", "downloadManifest" -> reply(transport.getFile(target, FileQuery(version = args["version"].longValue?.toInt()))) { b ->
                ok(bytesOf(b))
            }

            "getChunk" -> reply(transport.getChunk(collection, args["chunk"].stringValue!!)) { bytes ->
                ok(mapOf("size" to jsonInt(bytes.size.toLong()), "sha256" to JsonPrimitive(sha256Hex(bytes))))
            }

            "revisions" -> reply(transport.revisions(target)) { o ->
                val list = o["revisions"].arrayValue.orEmpty().mapNotNull { it.objectValue }
                ok(
                    mapOf(
                        "versions" to JsonArray(list.mapNotNull { it["version"] }),
                        "formats" to JsonArray(list.mapNotNull { it["format"] }.distinct()),
                    ),
                )
            }

            else -> throw AssertionError("unknown file op $op")
        }
    }
}
