package im.plrs.key.samples.consumer

import android.app.Application
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.OkHttpTransport
import im.plrs.key.core.TrustSet
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions

/**
 * The README's Android start, as written: the client is built in `Application.onCreate` on the main
 * thread and used at once. No `start()`, no Ed25519 backend override, no dispatcher of its own.
 */
class ConsumerApp : Application() {
    lateinit var client: PolarisKeyClient
        private set

    override fun onCreate() {
        super.onCreate()
        client = PolarisKeyAndroid.client(this, options(PRODUCTION))
    }

    companion object {
        const val PRODUCT = "consumer"
        const val PRODUCTION = "https://key.plrs.im"

        /** The RFC 8032 TEST 1 key, base64url: a stand-in pin for a product this sample never reaches. */
        val PINNED: TrustSet = mapOf("sample" to "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")

        fun options(baseUrl: String, pinned: TrustSet = PINNED) = PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = PRODUCT,
                baseUrl = baseUrl,
                version = "1.0.0",
                pinnedKeys = pinned,
                // The default transport, named so this sample proves an app can (SP-50: OkHttp's
                // types reach the app's compile classpath).
                transport = OkHttpTransport(),
            ),
        )
    }
}
