// @pkey-feature core.sync core.store
//
// SP-50: every public suspend function is main-safe. StrictMode's thread policy is set to
// penaltyDeath on the main thread, the client is built there, and then EVERY public suspend member
// of the client and of each facet it hands out (license, config, identity, release, distribution,
// update, packs, devices, commerce, core), plus the public suspend extensions on the client and the
// core, is called from Dispatchers.Main against a server that splits headers and body. A call may
// refuse (most do, against this server); a disk or network touch on the main thread kills the
// process and fails the run.
//
// The surface is enumerated with kotlin-reflect, OFF the main thread (it reads the APK); each call is
// a plain Java reflective invocation of the method (or of its `$default` twin when a parameter is
// left at its default), so nothing but the SDK runs on the main thread under the policy. A function
// whose parameters cannot be built fails the test by name, so a new one is never skipped silently.

package im.plrs.key.samples.consumer

import android.content.Context
import android.os.StrictMode
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.attestDevice
import im.plrs.key.core.bearerAllowed
import im.plrs.key.core.deauthorizeDevice
import im.plrs.key.core.discoveredEndpoint
import im.plrs.key.core.fetchVerified
import im.plrs.key.core.listDevices
import im.plrs.key.core.registerDevice
import im.plrs.key.core.renameDevice
import im.plrs.key.core.requestDeviceRegistration
import im.plrs.key.core.NoAttestation
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.boot
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn
import kotlin.reflect.KClass
import kotlin.reflect.KFunction
import kotlin.reflect.KParameter
import kotlin.reflect.KType
import kotlin.reflect.KVisibility
import kotlin.reflect.full.isSubclassOf
import kotlin.reflect.full.memberFunctions
import kotlin.reflect.full.primaryConstructor
import kotlin.reflect.jvm.javaMethod
import kotlin.reflect.jvm.jvmErasure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainSafetyTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val signer = DeviceSigner()
    private val product = "sweep-${System.nanoTime()}"

    private val server = SplitServer(splitMillis = 120) { r ->
        val device = r.headers["x-pkey-device"].orEmpty()
        val now = System.currentTimeMillis() / 1000
        when {
            r.path.endsWith("/license/activate") || r.path.endsWith("/license/enroll") || r.path.endsWith("/license/token") ->
                Reply(200, """{"token":"pkeyt_sweep","schemaVersion":4}""")
            r.path.endsWith("/license/document") && device.isNotEmpty() -> Reply(200, signer.licenseDoc(product, device, now), mapOf("ETag" to "\"l\""))
            r.path.endsWith("/devices/report") -> Reply(200, """{"ok":true}""")
            r.path.endsWith("/devices/register") -> Reply(200, """{"token":"pkeyt_sweep","schemaVersion":4}""")
            else -> Reply(404, """{"error":{"code":"not_found","message":"sweep"}}""")
        }
    }

    @After
    fun down() {
        runBlocking(Dispatchers.Main) { StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.LAX) }
        server.close()
    }

    /** One planned call: a label and how to make it. */
    private class Call(val label: String, val run: suspend () -> Any?)

    @Test
    fun everyPublicSuspendFunctionIsMainSafe() {
        Dispatchers.Main.hashCode()
        val options = ConsumerApp.options(server.baseUrl, signer.trust).let {
            it.copy(core = it.core.copy(productSlug = product, expectedServices = ServiceSlug.entries.toList()))
        }
        val client = runBlocking(Dispatchers.Main) {
            StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().penaltyDeath().build())
            PolarisKeyAndroid.client(context, options).also { it.activate("pkey_${product}_key") }
        }

        // Enumerate off the main thread.
        val facets: List<Pair<String, Any>> = listOf(
            "client" to client, "license" to client.license, "config" to client.config, "identity" to client.identity,
            "release" to client.release, "distribution" to client.distribution, "update" to client.update,
            "packs" to client.packs, "devices" to client.devices, "commerce" to client.commerce, "core" to client.core,
        )
        val unbuildable = ArrayList<String>()
        val calls = ArrayList<Call>()
        for ((name, target) in facets) {
            for (f in target::class.memberFunctions) {
                if (!f.isSuspend || f.visibility != KVisibility.PUBLIC) continue
                val call = plan(name, target, f)
                if (call == null) unbuildable += "$name.${f.name}" else calls += call
            }
        }
        val core = client.core
        val scratch = File(context.cacheDir, "sweep-fetch").apply { delete() }
        calls += listOf(
            Call("core.registerDevice") { core.registerDevice() },
            Call("core.requestDeviceRegistration") { core.requestDeviceRegistration() },
            Call("core.listDevices") { core.listDevices() },
            Call("core.renameDevice") { core.renameDevice("other-device", "Sweep") },
            Call("core.deauthorizeDevice") { core.deauthorizeDevice("other-device") },
            Call("core.attestDevice") { core.attestDevice(NoAttestation) },
            Call("core.bearerAllowed") { core.bearerAllowed(server.baseUrl + "/x") },
            Call("core.fetchVerified") { core.fetchVerified(server.baseUrl + "/blob", scratch, 3, "00".repeat(32)) },
            Call("core.discoveredEndpoint") { core.discoveredEndpoint(ServiceSlug.release, "builds") },
            Call("client.boot") { client.boot() },
        )
        if (unbuildable.isNotEmpty()) fail("cannot build the arguments of: $unbuildable")
        // The surface really was enumerated.
        val labels = calls.map { it.label }.toSet()
        for (must in listOf("client.activate", "client.sync", "client.status", "license.deactivate", "config.set", "update.decide", "packs.ensure", "core.start")) {
            assertTrue("$must was not swept ($labels)", must in labels)
        }

        for (call in calls) {
            Log.i(TAG, "sweep ${call.label}")
            runBlocking(Dispatchers.Main) {
                withTimeoutOrNull(5_000) {
                    try {
                        call.run()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        // A refusal is an answer; only a StrictMode death fails this test.
                    }
                }
            }
        }
        Log.i(TAG, "swept ${calls.size} suspend functions on the main thread")
        assertTrue(calls.size > 100)
    }

    // ── Planning one call (off the main thread) ───────────────────────────────────────────────

    private fun plan(facet: String, target: Any, f: KFunction<*>): Call? {
        val method = f.javaMethod ?: return null
        val params = f.parameters.filter { it.kind == KParameter.Kind.VALUE }
        val args = arrayOfNulls<Any?>(params.size)
        var mask = 0
        for ((i, p) in params.withIndex()) {
            if (p.isOptional) {
                mask = mask or (1 shl i)
                args[i] = zero(p.type)
            } else {
                args[i] = build(p.type, 0) ?: if (p.type.isMarkedNullable) null else return null
            }
        }
        // A defaulted parameter goes through the compiler's static `$default` twin:
        // (receiver, the parameters, the continuation, the default mask, a marker).
        val twin: Method? = if (mask == 0) {
            null
        } else {
            // Looked up by its exact signature: listing every method would resolve types an old
            // Android lacks (java.nio.file on API 24, which the pack store needs).
            try {
                method.declaringClass.getDeclaredMethod(
                    method.name + "\$default",
                    method.declaringClass, *method.parameterTypes, Integer.TYPE, Any::class.java,
                ).also { it.isAccessible = true }
            } catch (e: NoSuchMethodException) {
                return null
            }
        }
        return Call("$facet.${f.name}") {
            suspendCoroutineUninterceptedOrReturn<Any?> { cont ->
                try {
                    if (twin == null) method.invoke(target, *args, cont) else twin.invoke(null, target, *args, cont, mask, null)
                } catch (e: InvocationTargetException) {
                    throw e.targetException
                }
            }
        }
    }

    /** The type's class, or null for one kotlin-reflect cannot erase (a suspend function type). */
    private fun erasure(type: KType): KClass<*>? = try {
        type.jvmErasure
    } catch (e: Throwable) {
        null
    }

    /** The placeholder in a defaulted slot: the JVM type's zero. */
    private fun zero(type: KType): Any? = when (erasure(type)) {
        Boolean::class -> false
        Int::class -> 0
        Long::class -> 0L
        Double::class -> 0.0
        Float::class -> 0f
        Short::class -> 0.toShort()
        Byte::class -> 0.toByte()
        Char::class -> ' '
        else -> null
    }

    /** A value for a required parameter, or null when none can be built. */
    private fun build(type: KType, depth: Int): Any? {
        if (type.isMarkedNullable) return null
        val k = erasure(type) ?: return functionType(type)
        return when {
            k == String::class -> "sweep"
            k == Boolean::class -> false
            k == Int::class -> 1
            k == Long::class -> 1L
            k == Double::class -> 1.0
            k == ByteArray::class -> ByteArray(0)
            k == File::class -> File(context.cacheDir, "sweep-${System.nanoTime()}")
            k == JsonPrimitive::class -> JsonPrimitive("sweep")
            k == JsonObject::class || k == JsonElement::class -> JsonObject(emptyMap())
            k == DocumentSlice::class -> DocumentSlice.license
            k.isSubclassOf(Set::class) -> emptySet<Any>()
            k.isSubclassOf(Map::class) -> emptyMap<Any, Any>()
            k.isSubclassOf(Collection::class) || k == Iterable::class -> emptyList<Any>()
            k.isSubclassOf(Function::class) || k.java.name.startsWith("kotlin.jvm.functions.") -> lambda(k.java)
            k.java.isEnum -> k.java.enumConstants!!.first()
            k.objectInstance != null -> k.objectInstance
            k.java.isInterface && !k.isSealed -> proxy(k.java)
            depth > 3 -> null
            k.isSealed -> k.sealedSubclasses.firstNotNullOfOrNull { construct(it, depth) }
            else -> construct(k, depth)
        }
    }

    private fun construct(k: KClass<*>, depth: Int): Any? {
        k.objectInstance?.let { return it }
        val ctor = k.primaryConstructor ?: k.constructors.firstOrNull() ?: return null
        val args = HashMap<KParameter, Any?>()
        for (p in ctor.parameters) {
            if (p.isOptional) continue
            args[p] = build(p.type, depth + 1) ?: if (p.type.isMarkedNullable) null else return null
        }
        return try {
            ctor.callBy(args)
        } catch (e: Throwable) {
            null
        }
    }

    /** A value for a function type kotlin-reflect cannot erase: `suspend (A, B) -> C` is Function3. */
    private fun functionType(type: KType): Any? {
        val text = type.toString()
        if (!text.contains("->")) return null
        val arity = type.arguments.size - 1 + if (text.startsWith("suspend") || text.startsWith("(suspend")) 1 else 0
        return lambda(Class.forName("kotlin.jvm.functions.Function$arity"))
    }

    /** A function value (FunctionN, suspend or not) that returns Unit, false or null. */
    private fun lambda(type: Class<*>): Any = Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, m, _ ->
        when (m.returnType) {
            java.lang.Boolean.TYPE -> false
            else -> if (m.name == "invoke") Unit else null
        }
    }

    private fun proxy(type: Class<*>): Any = Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, m, _ ->
        when (m.returnType) {
            java.lang.Boolean.TYPE -> false
            Integer.TYPE -> 0
            java.lang.Long.TYPE -> 0L
            java.lang.Double.TYPE -> 0.0
            Void.TYPE -> null
            else -> null
        }
    }

    private companion object {
        const val TAG = "SP50"
    }
}
