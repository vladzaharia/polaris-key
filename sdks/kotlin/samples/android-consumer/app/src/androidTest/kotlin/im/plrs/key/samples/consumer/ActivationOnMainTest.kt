// @pkey-feature core.verify core.sync license.activate core.store
//
// SP-50's acceptance, on a device or an emulator (the CI lane runs minSdk, 34 and the newest API):
// the documented Android path activates a licence with no workaround in app code.
//
//   client(context) -> activate() -> sync(), every call launched from Dispatchers.Main, against a
//   server that splits headers and body, with StrictMode's thread policy set to penaltyDeath on the
//   main thread before the client is even built: Ok, and the licence applied.
//
// It fails on 0.8.33 three ways: Ed25519 resolved to AndroidKeyStore on API 36 and refused the
// document, the body read threw NetworkOnMainThreadException, and the never-started client sent an
// empty X-PKey-Device.

package im.plrs.key.samples.consumer

import android.content.Context
import android.os.Build
import android.os.StrictMode
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.core.Ed25519
import im.plrs.key.core.HeaderName
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.ServiceSlug
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ActivationOnMainTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val signer = DeviceSigner()
    private val product = "acceptance-${System.nanoTime()}"

    private val server = SplitServer { r ->
        when (r.path) {
            "/$product/license/activate" -> Reply(200, """{"token":"pkeyt_acceptance","schemaVersion":4}""")
            "/$product/license/document" -> {
                val device = r.headers[HeaderName.device.lowercase()].orEmpty()
                if (device.isEmpty()) Reply(400, """{"error":{"code":"bad_request","message":"missing device id"}}""")
                else Reply(200, signer.licenseDoc(product, device, System.currentTimeMillis() / 1000), mapOf("ETag" to "\"lic-1\""))
            }
            "/$product/devices/report" -> Reply(200, """{"ok":true}""")
            else -> Reply(404, """{"error":{"code":"not_found"}}""")
        }
    }

    @After
    fun down() {
        runBlocking(Dispatchers.Main) { StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.LAX) }
        server.close()
    }

    @Test
    fun activateAndSyncFromTheMainThreadAppliesTheLicence() {
        // Dispatchers.Main is created off the main thread (its ServiceLoader reads the APK).
        Dispatchers.Main.hashCode()
        Log.i(TAG, "API ${Build.VERSION.SDK_INT}: Ed25519 backend ${Ed25519.verifier.name}")
        val options = ConsumerApp.options(server.baseUrl, signer.trust).let {
            it.copy(core = it.core.copy(productSlug = product, expectedServices = listOf(ServiceSlug.license)))
        }
        val outcome = runBlocking(Dispatchers.Main) {
            StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().penaltyDeath().build())
            // The README's start, on the main thread: nothing else.
            val client = PolarisKeyAndroid.client(context, options)
            val activation = client.activate("pkey_${product}_key")
            val sync = client.sync()
            listOf(activation, sync, client.status().status, client.license.licenseId())
        }
        val (activation, sync, status, licenseId) = outcome
        assertTrue("$activation", activation is ActivationResult.Ok)
        assertEquals("$sync", LicenseStatus.ok, status)
        // The verified document is the one in force.
        assertEquals("lic_consumer", licenseId)
        // Every request named this device.
        val devices = server.seen.filter { it.path.startsWith("/$product/license/") }.map { it.headers[HeaderName.device.lowercase()] }
        assertTrue("$devices", devices.isNotEmpty() && devices.all { !it.isNullOrEmpty() })
        // The licence is held: a fresh client over the same Keystore store reads it with no network.
        val again = runBlocking(Dispatchers.Main) { PolarisKeyAndroid.create(context, options).status().status }
        assertEquals(LicenseStatus.ok, again)
    }

    private companion object {
        const val TAG = "SP50"
    }
}
