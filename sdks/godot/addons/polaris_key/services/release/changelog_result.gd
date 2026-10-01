class_name PKeyChangelogResult
extends PKeyResult
## What `PolarisKey.release.changelog()` returns: a PKeyResult carrying the entries.
##
##   ok       true for a 200 (a body without an `entries` array is ok with no entries)
##   entries  Array[PKeyChangelogEntry], newest first, as the Worker ordered them; empty unless ok
##   status   the HTTP status, or 0 when nothing was sent or nothing answered
##
## A failure's `code`: `service-unavailable` (Release is off; nothing was sent), a 401's or 403's
## own code in either body spelling (`unauthorized` / `forbidden` when the body names none, or
## e.g. `channel_not_allowed`, `download_auth_required`), `not_found` for any other status,
## `invalid-response` for a 200 that is not a JSON object, or the transport's.

var entries: Array[PKeyChangelogEntry] = []
var status := 0


static func failed(p_code: StringName, p_message: String, p_status := 0) -> PKeyChangelogResult:
	var r := PKeyChangelogResult.new(false, p_code, p_message)
	r.status = p_status
	return r


## The entries in their wire spelling (PKeyChangelogEntry.to_dict).
func to_array() -> Array:
	var out: Array = []
	for e in entries:
		out.append(e.to_dict())
	return out
