class_name PKeyVersionCheck
extends PKeyResult
## What `PolarisKey.update.check(channel)` returns (sdk-node `VersionCheck`): a PKeyResult that
## also carries the newest build on the channel and whether this build is behind it.
##
##   ok                true when the Worker answered 200 with a version
##   version           the newest version on the requested channel ("" unless ok)
##   tag, url          its release tag and page ("" when the answer omits them)
##   update_available  PKeySemver.compare(PKeyOptions.version, version) < 0: the HOST
##                     application's version, never the SDK's, compared with the gate's semver
##   status            the HTTP status, or 0 when nothing was sent or nothing answered
##
## A failure's `code`: `service-unavailable` (Update is off; nothing was sent), `invalid-options`
## (a malformed channel; nothing was sent), the 403 body's own code (`channel_not_allowed`;
## `forbidden` when the body names none), `not_found` for any other status, `invalid-response`
## for a 200 without a version, or the transport's (`network-error`, `timeout`, `local-only`, …).
##
## In P1 the answer is informational on every outlet: a Steam, itch or store build must not act on
## it by itself (P3-08 makes the decision outlet-aware behind the same signal).

var version := ""
var tag := ""
var url := ""
var update_available := false
var status := 0


static func of(p_version: String, p_tag: String, p_url: String, p_update_available: bool, p_status := 200) -> PKeyVersionCheck:
	var r := PKeyVersionCheck.new(true)
	r.version = p_version
	r.tag = p_tag
	r.url = p_url
	r.update_available = p_update_available
	r.status = p_status
	return r


static func failed(p_code: StringName, p_message: String, p_status := 0) -> PKeyVersionCheck:
	var r := PKeyVersionCheck.new(false, p_code, p_message)
	r.status = p_status
	return r


func _to_string() -> String:
	if not ok:
		return "PKeyVersionCheck(%s: %s)" % [code, message]
	return "PKeyVersionCheck(%s, update_available=%s)" % [version, update_available]
