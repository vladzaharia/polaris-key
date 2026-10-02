class_name PKeyWebAdapter
extends PKeyPlatformAdapter
## A web export: always current. A `platform` answer offers one action, a reload of the page (the
## PWA's "new version, reload"); nothing is downloaded or staged, and `user://` on the web lives in
## memory, so no pack is kept there.


func _init() -> void:
	kind = "web"
	body_key = "update_platform_web"


func describe(decision: Dictionary, ctx: Dictionary) -> Dictionary:
	if decision.get("action") == "platform":
		return plan(PKeyApplyResult.RELOAD, "update_reload", "", body_key)
	return super(decision, ctx)
