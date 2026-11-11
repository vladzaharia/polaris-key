// @pkey-feature connect.local
package im.plrs.key.android

import im.plrs.key.ui.PolarisScanResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GmsCodeScannerTest {
    private class Fake(private val run: (onText: (String) -> Unit, onCancel: () -> Unit, onFailure: (Throwable) -> Unit) -> Unit) : QrScanClient {
        var starts = 0

        override fun start(onText: (String) -> Unit, onCancel: () -> Unit, onFailure: (Throwable) -> Unit) {
            starts++
            run(onText, onCancel, onFailure)
        }
    }

    @Test
    fun theScannedTextIsTheResultUnchanged() = runTest {
        val text = "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y"
        val scanner = GmsCodeScanner(Fake { onText, _, _ -> onText(text) }) { true }
        assertEquals(PolarisScanResult.Text(text), scanner.scan())
    }

    @Test
    fun aClosedScannerIsACancel() = runTest {
        val scanner = GmsCodeScanner(Fake { _, onCancel, _ -> onCancel() }) { true }
        assertEquals(PolarisScanResult.Cancelled, scanner.scan())
    }

    @Test
    fun aFailureIsUnavailableNeverAnException() = runTest {
        val scanner = GmsCodeScanner(Fake { _, _, onFailure -> onFailure(IllegalStateException("module missing")) }) { true }
        assertEquals(PolarisScanResult.Unavailable, scanner.scan())
    }

    @Test
    fun withoutPlayServicesNothingStartsAndTheEntryIsHidden() = runTest {
        val client = Fake { onText, _, _ -> onText("x") }
        val scanner = GmsCodeScanner(client) { false }
        assertFalse(scanner.available())
        assertEquals(PolarisScanResult.Unavailable, scanner.scan())
        assertEquals(0, client.starts)
        assertTrue(GmsCodeScanner(client) { true }.available())
    }
}
