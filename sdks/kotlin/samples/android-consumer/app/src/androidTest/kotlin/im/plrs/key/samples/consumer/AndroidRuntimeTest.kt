// @pkey-feature core.verify core.store packs.apply.delta
//
// SP-50 on a real Android runtime: the Ed25519 backend is chosen by RFC 8032's known answers (Tink
// on Android; on API 36 the JCA's Ed25519 resolves to AndroidKeyStore and fails them), a client with
// no store fails clearly instead of writing under `/`, and the pack decoder is there exactly when
// the app added polaris-key-zstd (the `packs` flavour) and absent from the `lean` one.

package im.plrs.key.samples.consumer

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.Ed25519
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JcaEd25519Verifier
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.TinkEd25519Verifier
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.packs.LibZstd
import im.plrs.key.packs.selectZstd
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidRuntimeTest {
    @Test
    fun ed25519IsChosenByItsKnownAnswersAndIsTinkHere() {
        Log.i("SP50", "API ${Build.VERSION.SDK_INT}: JCA known answers ${Ed25519.knownAnswer(JcaEd25519Verifier)}, Tink ${Ed25519.knownAnswer(TinkEd25519Verifier)}")
        assertTrue(RuntimeFamily.isAndroid)
        assertSame(TinkEd25519Verifier, Ed25519.verifier)
        assertTrue(Ed25519.knownAnswer(Ed25519.verifier))
    }

    @Test
    fun aClientWithNoStoreFailsClearly() {
        val options = PolarisKeyClientOptions(
            core = CoreOptions(productSlug = "nostore", version = "1.0.0", pinnedKeys = ConsumerApp.PINNED),
        )
        for (build in listOf<() -> Unit>({ PolarisKeyClient(options) }, { runBlocking { PolarisKeyClient.create(options) } })) {
            try {
                build()
                fail("a client without a store must not fall back to a FileStore under user.home on Android")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.invalidOptions, e.code)
                assertTrue(e.message!!, e.message!!.contains("PolarisKeyAndroid.client"))
            }
        }
    }

    @Test
    fun thePackDecoderIsThereExactlyWhenTheAppAddedIt() {
        val (_, info) = selectZstd()
        if (BuildConfig.FLAVOR == "packs") {
            assertTrue("polaris-key-zstd brings zstd-jni's Android natives", LibZstd.available)
            assertEquals(listOf("zstd-patch-from"), info.patchMethods)
        } else {
            assertFalse(LibZstd.available)
            assertEquals(UnsupportedReason.dependency, info.unsupported?.reason)
        }
    }
}
