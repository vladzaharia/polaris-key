// Device-id binding (part 1 of the local-trust set) — wire contract v4 §6.
//
// A copied state directory must not carry a device's identity to another machine. On a desktop
// FILE-backed store the device id is therefore RE-DERIVED from the platform anchor at every
// start (`DeviceID.fromRaw(productSlug:raw:)`) rather than trusted from the `device` file:
//
//   * a stored id is used only when no anchor is readable;
//   * a stored id that disagrees with the derived one is discarded together with the token and
//     the grant slices of the cache: `clearAll()` without the network call. The update slices
//     (feeds, releaseRecords) are kept, because they carry each channel's `seq` floor, and so is the
//     pin evidence (`pinRevocations`): a tombstone is security state, not a grant.
//
// Stores that hold the id somewhere a copy cannot reach (the iOS/tvOS Keychain-backed host
// store, an in-memory store, a host's own store) do not conform to `DeviceIdRebindable` and keep
// their stored id; so does every platform with no anchor (`DeviceID.anchorRaw()` is nil there).

import Foundation

/// A store whose device id lives in a copyable file and can be replaced by the one derived from
/// the platform anchor. Conformance is the opt-in to device binding.
public protocol DeviceIdRebindable: Store {
    func setDeviceId(_ id: String) async throws
}

/// The device id this process runs as, after binding `store` to the platform anchor.
///
/// - Parameter readAnchor: the raw anchor; defaults to the platform's (nil off macOS).
func bindDeviceId(
    productSlug: String, store: any Store,
    readAnchor: @Sendable () -> String? = { DeviceID.anchorRaw() }
) async throws -> String {
    let stored = try await store.getDeviceId()
    guard let rebindable = store as? any DeviceIdRebindable,
        let anchor = readAnchor(), !anchor.isEmpty
    else { return stored }
    let derived = DeviceID.fromRaw(productSlug: productSlug, raw: anchor)
    if stored == derived { return stored }
    // The stored id is not this machine's: a copied or restored state directory. Drop every
    // credential and grant it carried; re-activation seats this machine once.
    try await store.clearToken()
    if let cache = await store.readCache(),
        !cache.feeds.isEmpty || !cache.releaseRecords.isEmpty || !cache.pinRevocations.isEmpty
    {
        try await store.writeCache(
            CacheRecord(
                feeds: cache.feeds, releaseRecords: cache.releaseRecords,
                pinRevocations: cache.pinRevocations))
    } else {
        try await store.clearCache()
    }
    try await rebindable.setDeviceId(derived)
    return derived
}
