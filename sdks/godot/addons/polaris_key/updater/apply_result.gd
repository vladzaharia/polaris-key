class_name PKeyApplyResult
extends PKeyResult
## What acting on an update decision did (PolarisKey.update.apply(), an outlet adapter's
## `apply`). When `ok`, `behaviour` is one of:
##
##   link     a page was opened (`url`): a store listing, a source or web-distribution page, a
##            build's download URL, the release page
##   hook     a native updater took over (`bridge`: sparkle, velopack, winsparkle, appimage)
##   staged   a sidecar code pack was downloaded, verified and staged (`version`); the next
##            decision answers code-ready
##   restart  the staged pack was swapped in and the game is restarting
##   reload   a web export reloads the page
##   silent   nothing to do on this outlet (a platform updates the game, or there is no offer)
##
## A failure keeps a typed code: `unsupported` with `detail.reason` `dependency` (a native
## plugin is missing), `swap-refused` with `detail.reason`, `swap-failed`, `payload-mismatch`,
## `record-mismatch`, or the transport's codes for a download.

const LINK := "link"
const HOOK := "hook"
const STAGED := "staged"
const RESTART := "restart"
const RELOAD := "reload"
const SILENT := "silent"

var behaviour := ""
var url := ""
var bridge := ""
var method := ""
var version := ""


static func of(p_behaviour: String, extra: Dictionary = {}) -> PKeyApplyResult:
	var r := PKeyApplyResult.new(true)
	r.behaviour = p_behaviour
	r.url = String(extra.get("url", ""))
	r.bridge = String(extra.get("bridge", ""))
	r.method = String(extra.get("method", ""))
	r.version = String(extra.get("version", ""))
	r.detail = extra
	return r


static func failed(p_code: StringName, p_message: String, p_detail: Variant = null) -> PKeyApplyResult:
	return PKeyApplyResult.new(false, p_code, p_message, p_detail)


## A sidecar swap this install cannot take.
static func refused(reason: String) -> PKeyApplyResult:
	return failed(PKeyErrors.SWAP_REFUSED, "This install cannot take a sidecar-PCK swap (%s)." % reason, {"reason": reason})


## The typed unsupported result a hook stub returns when its native plugin is absent.
static func missing_dependency(what: String) -> PKeyApplyResult:
	return failed(PKeyErrors.UNSUPPORTED, "%s is not installed in this build." % what, {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": PKeyConstants.UnsupportedReason.DEPENDENCY, "bridge": what})


func _to_string() -> String:
	if not ok:
		return "PKeyApplyResult(%s: %s)" % [code, message]
	return "PKeyApplyResult(%s%s)" % [behaviour, (" " + url) if url != "" else ""]
