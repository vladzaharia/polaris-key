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
import im.plrs.key.core.FileDeviceKeyStorage
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
import java.io.File

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
 * These connect options with the Android defaults: the device keys, and the state in [androidConnectStateStorage]
 * (without them `connect.identity()` is invalid-options on Android). A storage the host chose is kept.
 */
internal fun ConnectOptions.withAndroidDefaults(
    context: Context,
    productSlug: String,
    keys: KeyProvider = AndroidKeyStoreProvider(context),
): ConnectOptions = copy(
    deviceKeys = deviceKeys ?: androidDeviceKeyStore(context, productSlug, keys),
    state = state ?: androidConnectStateStorage(context, productSlug, keys),
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
