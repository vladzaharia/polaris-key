class_name PKeyUpdatePromptController
extends RefCounted
## PKeyUpdatePrompt's headless logic, mirroring React's `<UpdatePrompt>` states
## (packages/sdk-react/src/components/UpdatePrompt.tsx): what an update answer says, whether the
## player may dismiss it, and which action (if any) it offers on this build.
##
## Two sources, both delivered by PolarisKey.update.update_available(result):
##   PKeyUpdateCheck   wire v4's signed decision: code-ready, binary, store, platform, blocked
##                     (none shows nothing, or "up to date" when asked)
##   PKeyVersionCheck  the v3 version check: a newer version exists
##
## A mandatory binary, store or platform answer and every blocked answer is LOCKED: a persistent
## banner with no dismiss control, whatever the requested mode, and never a full-screen cover —
## no v4 answer stops play (plans/P3-01.md §2.8, decision 1). Only a dismissable answer may use
## the modal mode.
##
## The action in P1 never downloads (P3-10 owns install and apply): a store answer opens its
## `listingUrl`; a binary answer on a direct build opens the release page the game gave
## (`release_url`) or, for the v3 check, the answer's `url`; code-ready, platform and blocked
## offer no action; and a store, Steam or itch build never opens a download page (store link or
## nothing).

## Only a direct build (or the editor, which has no outlet) may open a download page; every other
## outlet installs through its store, platform or package manager.
const DOWNLOAD_OUTLETS := ["", "direct"]


## The prompt's model for `result` (or null): {visible, state, title, body, body_arg, action,
## action_url, locked, version}. `state` is the action (code-ready, binary, store, platform,
## blocked), `version` for the v3 check, `current` for an up-to-date answer shown on request, or
## "" when nothing shows. `outlet` is the build's outlet ("" in the editor).
static func model(result: Variant, outlet := "", release_url := "", show_when_current := false) -> Dictionary:
	var out := {"visible": false, "state": "", "title": "", "body": "", "body_arg": null, "action": "", "action_url": "", "locked": false, "version": ""}
	if result is PKeyVersionCheck:
		var v: PKeyVersionCheck = result
		if not v.ok:
			return out
		if not v.update_available:
			if show_when_current:
				out.merge({"visible": true, "state": "current", "body": "update_up_to_date"}, true)
			return out
		out.merge({"visible": true, "state": "version", "title": "update_title", "body": "update_body_version", "body_arg": v.version, "version": v.version}, true)
		var url := v.url if v.url != "" else release_url
		if url != "" and not _store_outlet(outlet):
			out["action"] = "update_action"
			out["action_url"] = url
		return out
	if not (result is PKeyUpdateCheck) or not result.ok:
		return out
	var check: PKeyUpdateCheck = result
	var d: Dictionary = check.decision
	var action := String(d.get("action", ""))
	if action == "none" or action == "":
		if show_when_current and d.get("reason") == "up-to-date":
			out.merge({"visible": true, "state": "current", "body": "update_up_to_date"}, true)
		return out
	var version := ""
	if action != "blocked" and d.get("release") is Dictionary and d["release"].get("version") is String:
		version = d["release"]["version"]
	var locked := PKeyDecision.is_undismissable(d)
	var mandatory: bool = action in ["binary", "store", "platform"] and d.get("mandatory") == true
	out.merge({"visible": true, "state": action, "locked": locked, "version": version, "title": "update_title"}, true)
	_body(out, "update_body", version)
	match action:
		"code-ready":
			out["title"] = "update_ready_title"
			out["body"] = "update_ready_body"
			out["body_arg"] = null
		"binary":
			if release_url != "" and not _store_outlet(outlet):
				out["action"] = "update_action"
				out["action_url"] = release_url
		"store":
			if d.get("listingUrl") is String and d["listingUrl"] != "":
				out["action"] = "update_store"
				out["action_url"] = d["listingUrl"]
		"platform":
			out["body"] = "update_platform_body"
			out["body_arg"] = null
		"blocked":
			out["title"] = "update_blocked_title"
			out["body"] = "update_blocked_body"
			out["body_arg"] = null
	if mandatory:
		out["body"] = "update_mandatory_body"
		out["body_arg"] = null
	return out


static func _body(out: Dictionary, key: String, version: String) -> void:
	if version != "":
		out["body"] = key + "_version"
		out["body_arg"] = version
	else:
		out["body"] = key
		out["body_arg"] = null


static func _store_outlet(outlet: String) -> bool:
	return not PackedStringArray(DOWNLOAD_OUTLETS).has(outlet)


## The URL the gate's "update required" screen offers for this build, or "": a store listing
## from a decision, the v3 answer's page on a non-store build, or `release_url` on a direct build.
static func update_url(result: Variant, outlet := "", release_url := "") -> String:
	var m := model(result, outlet, release_url)
	if m["action_url"] != "":
		return m["action_url"]
	return release_url if release_url != "" and not _store_outlet(outlet) else ""
