class_name PKeyReleaseRecordResult
extends PKeyResult
## What `await PolarisKey.update.release_record(sha256)` returns: one release record
## (`pkey-release+jws`) by its hash, after plans/P3-01.md §2.5 steps 11–16. When `ok`:
##
##   sha256      the record's lowercase hex SHA-256 (the pin)
##   record_doc  the verified record
##   source      "cache" or "network"
##   pinned      true when a committed feed's target for this platform pins the hash: the record
##               was cross-checked against that pin (`kind` app, deliverable, version, `seq`) and
##               is kept in the cache. false: only steps 12–14 ran, and nothing was kept
##
## A failure's `code`: `not-configured` (no configure(), or empty pinned_release_keys),
## `service-unavailable`, `record-rejected` (`detail` is the step: hash, jws or claims),
## `record-mismatch`, or the transport's code.

var sha256 := ""
var record_doc: Dictionary = {}
var source := ""
var pinned := false


static func of(p_sha256: String, p_record: Dictionary, p_source: String, p_pinned: bool) -> PKeyReleaseRecordResult:
	var r := PKeyReleaseRecordResult.new(true)
	r.sha256 = p_sha256
	r.record_doc = p_record
	r.source = p_source
	r.pinned = p_pinned
	return r


static func failed(p_code: StringName, p_message: String, p_detail: Variant = null) -> PKeyReleaseRecordResult:
	return PKeyReleaseRecordResult.new(false, p_code, p_message, p_detail)


func _to_string() -> String:
	if not ok:
		return "PKeyReleaseRecordResult(%s: %s)" % [code, message]
	return "PKeyReleaseRecordResult(%s %s, %s)" % [record_doc.get("version"), sha256.left(12), source]
