class_name PKeyDeviceBinding
extends RefCounted
## Device-id binding (wire contract v4 §6, part 1): a copied state directory must not carry a
## device's identity to another machine. On a store with a desktop file behind it
## (`PKeyStore.bindable()`: PKeyFileStore, PKeyKeyringStore) the device id is RE-DERIVED from the
## platform anchor (PKeyDeviceId.anchor(): MachineGuid, IOPlatformUUID, the machine-id) at every
## start instead of trusted from the `device` file:
##
##   - no anchor readable (mobile, web, a sandbox that refuses the probe): the stored id stands;
##   - a stored id that agrees: nothing changes;
##   - a stored id that disagrees is not this machine's: it is discarded together with the token
##     and every grant slice of the cache (`trustJws`, `docs`, `etags`, `bundle`, any
##     `lastSyncUnauthorized` and `blocked` hint), exactly a deactivate without the network call.
##     The update slices (`feeds`, `releaseRecords`) are signed public documents and carry each
##     channel's `seq` floor, and `pinRevocations` is security state, not a grant: they stay. Re-activation seats this machine once.
##
## The Keychain, Keystore, in-memory and host stores keep their stored id.

## The device id this process runs as, after binding `store`. A coroutine.
static func bind(store: PKeyStore, product: String, stored: String) -> String:
	if not store.bindable():
		return stored
	var anchor := await PKeyDeviceId.anchor()
	if anchor == "":
		return stored
	var derived := PKeyDeviceId.from_raw(product, anchor)
	if stored == derived:
		return stored
	store.clear_token()
	var rec = store.read_cache()
	var kept := {}
	if rec is Dictionary:
		for slice in PKeyCache.UPDATE_SLICES + ["pinRevocations"]:
			if rec.get(slice) is Dictionary and not rec[slice].is_empty():
				kept[slice] = rec[slice]
	if kept.is_empty():
		store.clear_cache()
	else:
		kept["v"] = PKeyCache.VERSION
		store.write_cache(kept)
	# A failed write is surfaced by the store (`failed`); this session still runs as this machine.
	store.set_device_id(derived)
	return derived
