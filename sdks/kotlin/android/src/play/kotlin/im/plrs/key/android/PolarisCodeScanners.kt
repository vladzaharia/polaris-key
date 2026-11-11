// @pkey-feature connect.local
// Scan a code, the Play flavour (CC-29K.3): Google's code scanner (play-services-code-scanner, GmsBarcodeScanning, QR only) behind the
// kit's PolarisCodeScanner. It runs in Play services with its own UI and needs no camera permission. A device without the module, or
// one where it cannot run, answers Unavailable, so the kit hides Scan a code rather than drawing a dead button.

package im.plrs.key.android

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import im.plrs.key.ui.PolarisCodeScanner
import im.plrs.key.ui.PolarisScanResult
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** The scanners this flavour offers. */
public object PolarisCodeScanners {
    /** Google's code scanner over [context]; a host passes it to the kit's pairing state. */
    public fun create(context: Context): PolarisCodeScanner? {
        val app = context.applicationContext
        return GmsCodeScanner(GmsQrClient(app)) {
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) == ConnectionResult.SUCCESS
        }
    }
}

/** One scan as the three things that can end it. */
internal interface QrScanClient {
    fun start(onText: (String) -> Unit, onCancel: () -> Unit, onFailure: (Throwable) -> Unit)
}

/** The adapter: a client and a check that Play services are there, as the kit's [PolarisCodeScanner]. */
internal class GmsCodeScanner(private val client: QrScanClient, private val servicesReady: () -> Boolean) : PolarisCodeScanner {
    override suspend fun available(): Boolean = servicesReady()

    override suspend fun scan(): PolarisScanResult {
        if (!servicesReady()) return PolarisScanResult.Unavailable
        return suspendCancellableCoroutine { cont ->
            fun finish(result: PolarisScanResult) {
                if (cont.isActive) cont.resume(result)
            }
            runCatching {
                client.start(
                    onText = { text -> finish(if (text.isEmpty()) PolarisScanResult.Cancelled else PolarisScanResult.Text(text)) },
                    onCancel = { finish(PolarisScanResult.Cancelled) },
                    onFailure = { finish(PolarisScanResult.Unavailable) },
                )
            }.onFailure { finish(PolarisScanResult.Unavailable) }
        }
    }
}

/** GmsBarcodeScanning with QR only; a closed scanner is a cancel, any other failure is "not available". */
private class GmsQrClient(private val context: Context) : QrScanClient {
    override fun start(onText: (String) -> Unit, onCancel: () -> Unit, onFailure: (Throwable) -> Unit) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { barcode -> onText(barcode.rawValue.orEmpty()) }
            .addOnCanceledListener { onCancel() }
            .addOnFailureListener { e ->
                if (e is MlKitException && e.errorCode == MlKitException.CODE_SCANNER_CANCELLED) onCancel() else onFailure(e)
            }
    }
}
