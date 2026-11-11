// @pkey-feature connect.local
// What Scan a code reads from (CC-29K.3): a small seam the Compose screens take, so the kit never links Google Play
// services. The Play flavour of `:android` supplies the one over Google's code scanner (GmsBarcodeScanning, QR only,
// its own UI, no camera permission); the direct flavour and the desktop supply none, so the scan entry is hidden. The
// scanned text goes to join(text) unchanged, as the SDK defines.
package im.plrs.key.ui

/** What one scan came to. */
public sealed interface PolarisScanResult {
    /** A QR code was read: its text, for join. */
    public data class Text(val text: String) : PolarisScanResult

    /** The person closed the scanner. */
    public data object Cancelled : PolarisScanResult

    /** The scanner is not there (no Play services module, or it cannot run now). */
    public data object Unavailable : PolarisScanResult
}

/** A QR scanner the host provides. */
public interface PolarisCodeScanner {
    /** True when [scan] can run now. A false answer hides the scan entry: a dead button is never drawn. */
    public suspend fun available(): Boolean

    /** Opens the scanner and answers with the text, a cancel or that it is unavailable. Never throws for those three. */
    public suspend fun scan(): PolarisScanResult
}
