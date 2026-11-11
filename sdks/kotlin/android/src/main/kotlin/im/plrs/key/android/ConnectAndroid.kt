// Cloud Connect on Android (CC-12b.5; plans CC-12b D-3, D-4): where the Connect state lives, and the
// platform edge `CloudConnect` and `CloudNearby` use when the host supplied no discovery adapter.
//
// The state (K_disc, the roster, the certificate) is a Keystore-wrapped file with its OWN wrapping alias
// (`pkey:<product>:connect`), apart from the device keys and the Sync root. `leave()` deletes the file and
// destroys that alias and no other.
//
// The permission is the host's: this library declares none, because a permission in the AAR lands in every
// app that links it, Connect or not. From Android 17, for an app targeting 37, `ACCESS_LOCAL_NETWORK` is
// enforced: not declared answers `not-configured`, declared but denied answers `nearby-permission-denied`.
// Nothing here asks the person; the host or the UI kit asks.

package im.plrs.key.android

import android.content.Context
import android.os.Build
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeysUnreadableException
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.StoreException
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.platform.AndroidKeyStoreProvider
import im.plrs.key.platform.KeyProvider
import im.plrs.key.platform.KeystoreSealer
import im.plrs.key.platform.LocalNetworkAccess
import im.plrs.key.platform.LocalNetworkState
import im.plrs.key.platform.PeerNsd
import im.plrs.key.sdk.ConnectOptions
import im.plrs.key.sdk.ConnectPlatform
import im.plrs.key.sdk.ConnectPlatforms
import im.plrs.key.sdk.LocalNetworkVerdict
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.security.GeneralSecurityException

/** The record, and a `deleteRecord()` that also destroys the wrapping key: it has no other user. */
private class ConnectStateStorage(private val inner: FileDeviceKeyStorage) : DeviceKeyStorage by inner {
    override suspend fun deleteRecord() = inner.clear()
}

/**
 * Where Cloud Connect's state lives on Android: the Keystore-wrapped file
 * `noBackupFilesDir/pkey/<product>/connect-state.bin`, never backed up, under its own alias
 * ([KeystoreSealer.connectAliasFor]). `PolarisKeyAndroid.client` uses it unless the host chose a storage.
 */
public fun androidConnectStateStorage(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
    file: File? = null,
): DeviceKeyStorage = ConnectStateStorage(
    FileDeviceKeyStorage(
        fileOrNoBackup(context, productSlug, file, "connect-state.bin"),
        AndroidDeviceKeySealer(KeystoreSealer(keys, KeystoreSealer.connectAliasFor(productSlug))),
        "pkey-connect-state/1/$productSlug".toByteArray(Charsets.UTF_8),
    ),
)

/**
 * The local-link record, and a `deleteRecord()` that also destroys the wrapping key: the local links have no other user of
 * it. A record whose wrapping key is gone (lost, or permanently invalidated, which [KeystoreSealer] destroys) can never be
 * opened again: it is deleted and the store starts empty, as after a reinstall. A record that fails under a live key (a bad
 * tag, a foreign file) is kept and refused, never replaced.
 */
private class LocalStateStorage(private val inner: FileDeviceKeyStorage, private val keys: KeyProvider, private val alias: String) :
    DeviceKeyStorage by inner {
    private val lock = Mutex()

    override suspend fun deleteRecord() = inner.clear()

    override suspend fun get(): ByteArray? = lock.withLock {
        try {
            inner.get()
        } catch (e: DeviceKeysUnreadableException) {
            if (keyPresent()) throw e
            inner.clear()
            null
        }
    }

    override suspend fun update(transform: (ByteArray?) -> ByteArray?): Boolean = lock.withLock {
        try {
            inner.update(transform)
        } catch (e: DeviceKeysUnreadableException) {
            if (keyPresent()) throw e
            inner.clear()
            inner.update(transform)
        }
    }

    /** True unless the alias is confirmed absent; a Keystore fault surfaces as a store error, never as "gone". */
    private fun keyPresent(): Boolean = try {
        keys.exists(alias)
    } catch (e: GeneralSecurityException) {
        throw StoreException("local links: the Keystore failed (${e.message})", e)
    }
}

/**
 * Where the local links live on Android (`pkey.connect.local.v1`, CC-29b): the link private keys, the link secrets and
 * the rest of the record, in a Keystore-wrapped file `noBackupFilesDir/pkey/<product>/local-links.bin`, never backed up,
 * under its own alias ([KeystoreSealer.localAliasFor]). `PolarisKeyAndroid.client` uses it unless the host chose a storage.
 * [DeviceKeyStorage.clear] deletes the file and destroys the alias, and no other.
 */
public fun androidLocalStorage(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
    file: File? = null,
): DeviceKeyStorage {
    val alias = KeystoreSealer.localAliasFor(productSlug)
    return LocalStateStorage(
        FileDeviceKeyStorage(
            fileOrNoBackup(context, productSlug, file, "local-links.bin"),
            AndroidDeviceKeySealer(KeystoreSealer(keys, alias)),
            "pkey-connect-local-state/1/$productSlug".toByteArray(Charsets.UTF_8),
        ),
        keys,
        alias,
    )
}

/**
 * These connect options with the Android defaults: the device keys, the state in [androidConnectStateStorage] and the local
 * links in [androidLocalStorage] (without them `connect.identity()` and the local links are invalid-options on Android). A
 * storage the host chose is kept.
 */
internal fun ConnectOptions.withAndroidDefaults(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
): ConnectOptions = copy(
    deviceKeys = deviceKeys ?: androidDeviceKeyStore(context, productSlug, keys),
    state = state ?: androidConnectStateStorage(context, productSlug, keys),
    localState = localState ?: androidLocalStorage(context, productSlug, keys),
)

/** Installs [AndroidConnectPlatform] process-wide, unless the host installed a platform of its own. */
internal fun installConnectPlatform(context: Context) {
    val now = ConnectPlatforms.installed
    if (now == null || now is AndroidConnectPlatform) ConnectPlatforms.installed = AndroidConnectPlatform(context)
}

/**
 * The platform edge `PolarisKeyAndroid.client` installs: [AndroidMdns] from Android 14 (null below), and the
 * local-network permission read from [LocalNetworkAccess].
 */
public class AndroidConnectPlatform internal constructor(private val adapter: () -> MdnsAdapter?, private val access: () -> LocalNetworkState) :
    ConnectPlatform {
    public constructor(context: Context) : this(
        { if (Build.VERSION.SDK_INT >= PeerNsd.MIN_SDK) AndroidMdns(context.applicationContext) else null },
        { LocalNetworkAccess.check(context) },
    )

    // Built when LAN first starts: the NSD service is not touched by a client that never uses Connect.
    override val mdns: MdnsAdapter? by lazy(adapter)

    override suspend fun localNetwork(): LocalNetworkVerdict = when (access()) {
        LocalNetworkState.Ok -> LocalNetworkVerdict.Ok
        LocalNetworkState.NotDeclared -> LocalNetworkVerdict.NotDeclared
        LocalNetworkState.Denied -> LocalNetworkVerdict.Denied
    }
}
