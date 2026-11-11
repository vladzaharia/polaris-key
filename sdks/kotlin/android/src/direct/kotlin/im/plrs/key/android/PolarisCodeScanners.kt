// @pkey-feature connect.local
// Scan a code, the direct flavour (CC-29K.3): there is none. This build links no Google Play services, so the kit hides Scan a code and
// typing stays the way in.

package im.plrs.key.android

import android.content.Context
import im.plrs.key.ui.PolarisCodeScanner

/** The scanners this flavour offers: none. */
public object PolarisCodeScanners {
    private val none: PolarisCodeScanner? = null

    /** Always null: a direct build has no scanner. */
    @Suppress("UNUSED_PARAMETER")
    public fun create(context: Context): PolarisCodeScanner? = none
}
