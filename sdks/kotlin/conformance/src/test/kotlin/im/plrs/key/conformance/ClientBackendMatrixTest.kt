// @pkey-feature core.backend
//
// The client half of product backends — WIRE-CONTRACT-V4 §14.5, the `client` section of
// conformance/corpus/v2/backend-matrix.json (read in place): {document, now, response, retried}
// -> {action}, through `clientBackendAction` in :sdk. Like every suite it runs on the JCA and
// again with Tink forced.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.sdk.BackendAction
import im.plrs.key.sdk.BackendDocument
import im.plrs.key.sdk.BackendResponse
import im.plrs.key.sdk.clientBackendAction
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientBackendMatrixTest : ConformanceSuite() {
    private val matrix: JsonObject = Corpus.v2("backend-matrix.json")

    @Test
    fun everyClientRowReplays() {
        assertEquals(1L, matrix["backendMatrixVersion"].longValue!!)
        val rows = matrix["client"]!!.arrayValue!!.map { it as JsonObject }
        assertTrue(rows.size >= 17)
        val f = Failures("client backend")
        for (row in rows) {
            val input = row["input"] as JsonObject
            val doc = (input["document"] as? JsonObject)?.let {
                BackendDocument(it["issuedAt"].longValue!!, it["expiresAt"].longValue!!)
            }
            val resp = (input["response"] as? JsonObject)?.let {
                BackendResponse(it["status"].longValue!!.toInt(), it["code"].let { c -> if (c == null || c is JsonNull) null else c.stringValue })
            }
            val retried = (input["retried"] as kotlinx.serialization.json.JsonPrimitive).content == "true"
            val got = clientBackendAction(doc, input["now"].longValue!!, resp, retried).wire
            val want = ((row["expect"] as JsonObject)["action"]).stringValue
            f.check(got == want) { "${row["id"].stringValue}: got $got, want $want" }
        }
        f.done()
    }

    @Test
    fun theWireNamesAreTheEnumsNames() {
        assertEquals(
            listOf("send", "refresh-then-send", "refresh-and-retry", "surface"),
            BackendAction.values().map { it.wire },
        )
    }
}
