class_name PKeyBannerController
extends RefCounted
## PKeyStatusBanner's headless logic: the non-blocking lines a licence state and an update earn.
##
##   grace          "Offline — N days left", from graceUntil − the effective now
##   last verified  "Checked 3 hours ago", from lastVerifiedAt (shown with grace, or when asked)
##   update         "An update is available"
##
## Returns an Array of [copy key, argument] pairs, empty when there is nothing to say (the banner
## then hides: an empty strip reserving layout is its own bug).


static func lines(state: Dictionary, now: float, update_available := false, show_last_verified := false, copy: PKeyUiCopy = null) -> Array:
	var t := copy if copy != null else PKeyUiCopy.shared()
	var out: Array = []
	var grace: bool = state.get("status") == "grace"
	if grace and PKeyClaims.is_number(state.get("grace_until")):
		out.append(["banner_grace", t.duration(float(state["grace_until"]) - now)])
	if (grace or show_last_verified) and PKeyClaims.is_number(state.get("last_verified_at")):
		var ago := now - float(state["last_verified_at"])
		if ago < 60.0:
			out.append(["banner_checked_now", null])
		else:
			out.append(["banner_checked", t.duration(ago)])
	if update_available:
		out.append(["banner_update", null])
	return out
