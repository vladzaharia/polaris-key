class_name PKeyPlayAdapter
extends PKeyStoreAdapter
## Google Play: Play In-App Updates (P5-06) on a play build that Play installed, else the listing
## (`https://play.google.com/store/apps/details?id=`; `market://` is never opened).
##
## Play is authoritative for availability on its outlet: rollouts are staged per device, so the
## server's "latest" is advisory (notes/E2 §A2). A `store` answer asks Play (PKeyAndroid.update_check)
## and acts on what Play says (notes/S-10 §Results 1):
##
##   Play says                               not urgent                urgent (mandatory or critical)
##   downloaded (installStatus 11)           complete (restarts)       complete (restarts)
##   in progress (availability 3, 1–3)       progress, nothing to do   resume the immediate flow
##   available (2), the type allowed         flexible flow             immediate if allowed, else flexible
##   not offered yet (1)                     silent: Play is staging   the listing (and the prompt's
##                                                                     mandatory screen)
##   any failure, or not a Play install      the listing               the listing
##
## The flow's outcome arrives as PKeyAndroid.update_result; a failed or canceled flow is offered
## again at the next check. Every other answer behaves as the base store adapter.

## The bridge name a Play In-App Updates hook reports.
const BRIDGE := "play-in-app-updates"

## The Android facade (PKeyAndroid.shared() when null; tests inject one).
var android: PKeyAndroid = null


func _init() -> void:
	kind = "play"
	action_key = "update_store"


func apply(decision: Dictionary, host: Object, check: PKeyUpdateCheck = null) -> PKeyApplyResult:
	if decision.get("action") == "store":
		var a := android if android != null else PKeyAndroid.shared()
		if a.updates_availability().ok:
			var r: PKeyApplyResult = await in_app_update(a, decision)
			if r != null:
				return r
	return await super(decision, host, check)


## Act on `decision` through Play In-App Updates; null means "use the listing instead".
func in_app_update(a: PKeyAndroid, decision: Dictionary) -> PKeyApplyResult:
	var urgent: bool = decision.get("mandatory") == true or decision.get("critical") == true
	var c := await a.update_check()
	if not c.ok or not (c.detail is Dictionary):
		return null
	var s: Dictionary = c.detail
	var availability := int(s.get("availability", 0))
	var status := int(s.get("installStatus", 0))
	if s.get("readyToComplete") == true or status == PKeyAndroid.INSTALL_STATUS_DOWNLOADED:
		var done := await a.update_complete()
		return _hook("complete", s) if done.ok else null
	if availability == PKeyAndroid.AVAILABILITY_IN_PROGRESS and status >= 1 and status <= 3:
		# Play's resume rule: an interrupted immediate update is started again, whatever the
		# allowed types say while it is in progress.
		if urgent:
			return await _start(a, "immediate", s)
		return _hook("progress", s)
	if availability == PKeyAndroid.AVAILABILITY_AVAILABLE:
		var type := ""
		if urgent and s.get("immediateAllowed") == true:
			type = "immediate"
		elif s.get("flexibleAllowed") == true:
			type = "flexible"
		elif s.get("immediateAllowed") == true:
			type = "immediate"
		if type == "":
			return null
		return await _start(a, type, s)
	if availability == PKeyAndroid.AVAILABILITY_NOT_AVAILABLE and not urgent:
		# Play has not offered this update to this device yet (a staged rollout): nothing to show.
		return PKeyApplyResult.of(PKeyApplyResult.SILENT, {"bridge": BRIDGE, "reason": "play-staging", "play": s})
	return null


func _start(a: PKeyAndroid, type: String, s: Dictionary) -> PKeyApplyResult:
	var st := await a.update_start(type)
	if st.ok and st.detail is Dictionary and st.detail.get("started") == true:
		var r := _hook("start", s)
		r.detail["type"] = type
		return r
	return null


static func _hook(step: String, s: Dictionary) -> PKeyApplyResult:
	return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": BRIDGE, "method": "in-app-update", "step": step, "play": s})
