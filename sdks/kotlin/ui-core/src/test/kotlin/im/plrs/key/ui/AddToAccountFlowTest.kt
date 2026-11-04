// @pkey-feature ui.kit.holders
//
// The holdersFlow family of ui-matrix.json (UK-43.8): the AddToAccount state holder over a scripted driver,
// the same 20 scenarios every native port replays. A driver call past its script answers ok (preview, attach)
// or cancelled (waits).
package im.plrs.key.ui

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

class AddToAccountFlowTest {
    private val flow: JsonObject = run {
        val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui-core's test task" }
        (Json.parseToJsonElement(File(root, "conformance/corpus/v2/ui-matrix.json").readText()) as JsonObject)["holdersFlow"] as JsonObject
    }

    private val platformBase = JsonObject(
        mapOf(
            "platform" to JsonObject(mapOf("os" to JsonPrimitive("macos"), "formFactor" to JsonPrimitive("mac"))),
            "presentation" to JsonObject(mapOf("name" to JsonPrimitive("Tidewater Studio"), "icon" to JsonPrimitive(true))),
            "services" to JsonArray(listOf(JsonPrimitive("license"), JsonPrimitive("identity"))),
        ),
    )

    private class Network : RuntimeException()

    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    private fun wait(raw: JsonObject): AddToAccountWait = when (raw["outcome"].text()) {
        "pending" -> AddToAccountWait.Pending
        "signedIn" -> AddToAccountWait.SignedIn(raw["email"].text())
        "choose" -> AddToAccountWait.Choose(raw["grant"].text()!!)
        "cancelled" -> AddToAccountWait.Cancelled
        else -> AddToAccountWait.Expired
    }

    private fun attach(raw: JsonElement): AddToAccountAttach {
        if (raw is JsonPrimitive) throw Network()
        val o = raw.jsonObject
        return if (o["kind"].text() == "refused") AddToAccountAttach.Refused(o["code"].text()!!) else AddToAccountAttach.Ok
    }

    private inner class Scripted(val script: JsonObject) : AddToAccountDriver {
        val waits =
            ArrayDeque((script["waits"]?.jsonArray ?: listOf(JsonObject(mapOf("outcome" to JsonPrimitive("signedIn"))))).map { wait(it.jsonObject) })
        val preview = ArrayDeque(script["preview"]?.jsonArray ?: emptyList())
        val attachScript = ArrayDeque(script["attach"]?.jsonArray ?: emptyList())
        val calls = mutableListOf<String>()
        val hints = mutableListOf<Map<String, String>>()
        var duringFirstWait: (() -> Unit)? = null
        private var waited = false

        override suspend fun signIn(hints: AddToAccountHints): AddToAccountHandle {
            calls += "signIn"
            this.hints += mapOf("loginHint" to hints.loginHint, "nameHint" to hints.nameHint, "purpose" to hints.purpose)
            if (script["signInError"] != null) throw Network()
            return object : AddToAccountHandle {
                override suspend fun wait(): AddToAccountWait {
                    val hook = duringFirstWait
                    if (!waited && hook != null) {
                        waited = true
                        hook()
                    }
                    return waits.removeFirstOrNull() ?: AddToAccountWait.Cancelled
                }

                override suspend fun reopen(): Boolean = true

                override fun cancel() {
                    calls += "cancel"
                }
            }
        }

        override suspend fun complete(grant: String): Boolean {
            calls += "complete:$grant:keep"
            return script["complete"]?.jsonObject?.get("outcome").text()?.let { it == "signedIn" } ?: true
        }

        override suspend fun attach(confirm: Boolean): AddToAccountAttach {
            calls += if (confirm) "attach" else "preview"
            val queue = if (confirm) attachScript else preview
            return queue.removeFirstOrNull()?.let { attach(it) } ?: AddToAccountAttach.Ok
        }
    }

    @Test
    fun theRunnerCoversEveryScenario() {
        assertEquals(20, flow["scenarios"]!!.jsonArray.size)
    }

    @Test
    fun everyScenario() = runBlocking {
        val failures = mutableListOf<String>()
        for (sc in flow["scenarios"]!!.jsonArray.map { it.jsonObject }) {
            val name = sc["name"].text()!!
            try {
                runScenario(sc, this)
            } catch (e: AssertionError) {
                failures += "$name: ${e.message}"
            }
        }
        assertEquals(emptyList<String>(), failures)
    }

    private suspend fun runScenario(sc: JsonObject, scope: kotlinx.coroutines.CoroutineScope) {
        val driver = Scripted(sc["driver"]!!.jsonObject)
        val holder = flow["base"]!!.jsonObject
        val state = PolarisAddToAccountState(
            driver = driver,
            scope = scope,
            base = JsonObject(platformBase + ("licenseHolder" to holder["licenseHolder"]!!)),
            deviceKind = holder["deviceKind"].text(),
        )
        val fields = sc["fields"]?.jsonObject
        state.setField(AddToAccountField.Name, fields?.get("name")?.text() ?: "Ada Lovelace")
        state.setField(AddToAccountField.Email, fields?.get("email")?.text() ?: "ada@example.com")
        val steps = mutableListOf<String>()
        for (action in sc["actions"]!!.jsonArray.map { it.text()!! }) {
            when (action) {
                "submit-then-cancel" -> {
                    // The cancel lands while the sign-in's first wait is in flight.
                    driver.duringFirstWait = { state.cancel() }
                    state.submit().join()
                }

                "submit" -> state.submit().join()

                "tryAgain" -> state.tryAgain().join()

                else -> throw AssertionError("unknown action $action")
            }
            steps += state.ui.value.step
        }
        val want = sc["expect"]!!.jsonObject
        assertEquals("steps", want["steps"]!!.jsonArray.map { it.text() }, steps)
        assertEquals("calls", want["calls"]!!.jsonArray.map { it.text() }, driver.calls)
        assertEquals(
            "hints",
            want["hints"]!!.jsonArray.map { h -> h.jsonObject.mapValues { it.value.text()!! } },
            driver.hints,
        )
        assertEquals("view state", want["viewState"].text(), state.screen().state)
        val ui = state.ui.value
        want["field"]?.let { assertEquals("field", it.text(), ui.field) }
        want["typedEmail"]?.let { assertEquals("typedEmail", it.text(), ui.typedEmail) }
        want["signedEmail"]?.let { assertEquals("signedEmail", it.text(), ui.signedEmail) }
    }

    @Test
    fun theTypedValuesStayOutOfTheViewsInput() {
        runBlocking {
            val state = PolarisAddToAccountState(Scripted(JsonObject(emptyMap())), this, platformBase, "Mac")
            state.setField(AddToAccountField.Name, "Ada Lovelace")
            state.setField(AddToAccountField.Email, "ada@example.com")
            val text = state.inputs().raw.toString()
            assertFalse(text.contains("Ada Lovelace"))
            assertFalse(text.contains("ada@example.com"))
        }
    }
}
