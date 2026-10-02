class_name PKeyOutletAdapters
extends RefCounted
## The adapter for each of the 17 outlet kinds (plans/P3-01.md §2.9), and the silent fallback for
## `unknown`, which is never offered anything.
##
##   PKeyOutletAdapters.for_outlet(PolarisKey.update.outlet())   # {id, kind, subkind}
##   PKeyOutletAdapters.for_kind("steam")


## The adapter for a resolved outlet ({id, kind, subkind}); the id is kept when it differs from
## the kind.
static func for_outlet(outlet: Dictionary) -> PKeyOutletAdapter:
	var a := for_kind(String(outlet.get("kind", "")) if outlet.get("kind") is String else "")
	var id = outlet.get("id")
	if id is String and id != "" and id != a.kind:
		a.outlet_id = id
	return a


static func for_kind(kind: String) -> PKeyOutletAdapter:
	match kind:
		"direct":
			return PKeyDirectAdapter.new()
		"app-store":
			return PKeyAppStoreAdapter.new()
		"testflight":
			return PKeyTestFlightAdapter.new()
		"altstore":
			return PKeyAltStoreAdapter.new()
		"altstore-pal":
			return PKeyAltStorePalAdapter.new()
		"play":
			return PKeyPlayAdapter.new()
		"play-testing":
			return PKeyPlayTestingAdapter.new()
		"obtainium":
			return PKeyObtainiumAdapter.new()
		"fdroid-repo":
			return PKeyFdroidRepoAdapter.new()
		"ms-store":
			return PKeyMsStoreAdapter.new()
		"app-installer":
			return PKeyAppInstallerAdapter.new()
		"steam":
			return PKeySteamAdapter.new()
		"itch":
			return PKeyItchAdapter.new()
		"flathub":
			return PKeyFlathubAdapter.new()
		"snap":
			return PKeySnapAdapter.new()
		"winget":
			return PKeyWingetAdapter.new()
		"web":
			return PKeyWebAdapter.new()
	return PKeyOutletAdapter.new()
