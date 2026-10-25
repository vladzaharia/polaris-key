// `pkey.live`: the real client over the Android Keystore and the Play-free (direct) installer, configured from
// BuildConfig (-Ppkey.product, -Ppkey.baseUrl, -Ppkey.trust, -Ppkey.releaseKeys) like the desktop sample's env vars.

package im.plrs.key.samples.composeandroid

import android.content.Context
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.core.CoreOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.update.UpdateClientOptions

/** `k1=<key>,k2=<key>` as a map; malformed pairs are left out. */
internal fun parseKeys(text: String): Map<String, String> =
    text.split(',').mapNotNull { pair -> pair.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() } }.toMap()

/** The live client, or null when the build named no product. */
internal fun liveClient(context: Context): PolarisKeyClient? {
    if (BuildConfig.PKEY_PRODUCT.isBlank()) return null
    val core = CoreOptions(
        productSlug = BuildConfig.PKEY_PRODUCT,
        version = BuildConfig.VERSION_NAME,
        pinnedKeys = parseKeys(BuildConfig.PKEY_TRUST),
        baseUrl = BuildConfig.PKEY_BASE_URL,
    )
    val update = UpdateClientOptions(pinnedReleaseKeys = parseKeys(BuildConfig.PKEY_RELEASE_KEYS))
    return PolarisKeyAndroid.client(context, PolarisKeyClientOptions(core = core, update = update))
}
