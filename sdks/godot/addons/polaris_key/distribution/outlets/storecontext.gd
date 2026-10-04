class_name PKeyStoreContextBridge
extends PKeyNativeBridge
## Microsoft Store updates from inside a Store MSIX (P5-07; notes/E3 §A1.3, notes/S-11 §4.4): the
## hook PKeyMsStoreAdapter takes for a `store` answer when the PKeyStoreContext facade is usable
## (Windows, the GDExtension installed, package identity). `install_and_relaunch()` asks the Store
## to download and install the pending package updates behind the OS consent dialog, owned by the
## game window; the Store closes the game to install. There is no feed URL: the Store knows the
## package. Anywhere else every call answers `unsupported` and the adapter opens the listing.


func id() -> String:
	return "storecontext"


func singleton_name() -> String:
	return "PolarisKeyStoreContext"


func make_facade() -> PKeyNativeFacade:
	return PKeyStoreContext.new(env)
