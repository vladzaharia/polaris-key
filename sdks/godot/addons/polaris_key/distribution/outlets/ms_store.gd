class_name PKeyMsStoreAdapter
extends PKeyStoreAdapter
## The Microsoft Store: the listing under `https://apps.microsoft.com/detail/` (`ms-windows-store://`
## is never opened). Inside a Store MSIX with P5-07's StoreContext plugin
## (`ctx.store_bridge_available`: Windows, the GDExtension installed, package identity), a `store`
## answer instead asks the Store to download and install the update behind the OS consent dialog
## (PKeyStoreContextBridge); if that is unavailable or fails, the listing opens as before.


func _init() -> void:
	kind = "ms-store"
	action_key = "update_store"


func describe(decision: Dictionary, ctx: Dictionary) -> Dictionary:
	var p := super(decision, ctx)
	if decision.get("action") == "store" and ctx.get("store_bridge_available") == true:
		return plan(PKeyApplyResult.HOOK, action_key, "", "", "storecontext", String(p.get("url", "")))
	return p
