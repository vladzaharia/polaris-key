// @pkey-feature ui.kit.holders
//
// UK-43.8: the product page link (WIRE-CONTRACT-V4 section 5.7) over every row of
// conformance/corpus/v2/portal-matrix.json: parseCases (`PortalLink.parse`) and linkCases (`PortalLink.link`).

package im.plrs.key.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PortalLinkTest {
    private val matrix = JsonText.parse(
        File(System.getProperty("pkey.repoRoot"), "conformance/corpus/v2/portal-matrix.json").readText(),
    ) as JsonObject

    private fun member(v: kotlinx.serialization.json.JsonElement?): PortalMember? {
        val o = v as? JsonObject ?: return null
        return PortalMember(o["enabled"].boolValue == true, o["activate"].stringValue)
    }

    @Test
    fun theVersionIsTheOneTheSdkWasBuiltAgainst() {
        assertEquals(PORTAL_MATRIX_VERSION.toLong(), matrix["portalMatrixVersion"].longValue)
    }

    @Test
    fun parseCases() {
        val rows = matrix["parseCases"].arrayValue!!
        assertTrue(rows.size >= 10)
        for (row in rows.map { it as JsonObject }) {
            val core = row["core"]
            assertEquals(row["name"].stringValue, member(row["expect"]), PortalLink.parse(if (core is JsonNull) null else core))
        }
    }

    @Test
    fun linkCases() {
        val rows = matrix["linkCases"].arrayValue!!
        assertTrue(rows.size >= 10)
        for (row in rows.map { it as JsonObject }) {
            assertEquals(
                row["name"].stringValue,
                row["expect"].stringValue,
                PortalLink.link(row["served"].stringValue, member(row["portal"]), row["baseUrl"].stringValue!!, row["product"].stringValue!!),
            )
        }
    }
}
