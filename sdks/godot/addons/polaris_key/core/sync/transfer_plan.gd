@tool
class_name PKeySyncTransferPlan
extends RefCounted
## The upload planner (WIRE-CONTRACT-V5 §13.8.1): from a stored size and the collection's
## `files.delta`, the mode of a file transfer, the part size of a multipart one and its part
## count. `begin` answers the same numbers; a client plans first so it can pick `format` and
## slice parts.
##
##   too_large  over SYNC_FILE_MAX_BYTES (1 GiB)
##   chunks     files.delta and at least 1 MiB (chunked, never multipart)
##   single     at most SYNC_SINGLE_PUT_MAX_BYTES (16 MiB): one PUT
##   multipart  otherwise: partBytes = clamp(8 MiB .. 64 MiB, ceil(size / 9,999) up to a MiB)
##
## A plan is `{"mode": String, "part_bytes": int, "parts": int}`; the last two are 0 unless the
## mode is `multipart`. The stored size is the sealed size in E2E mode
## (`PKeySyncFileStream.sealed_size`).

## A file below this is never chunked, even when its collection has `files.delta`.
const CHUNKED_MIN_BYTES := 1048576

const MODE_SINGLE := "single"
const MODE_MULTIPART := "multipart"
const MODE_CHUNKS := "chunks"
const MODE_TOO_LARGE := "too_large"


## The plan for a stored file of `size` bytes. An empty dictionary for a negative size.
static func plan(size: int, delta: bool) -> Dictionary:
	if size < 0:
		return {}
	if size > PKeyConstants.SYNC_FILE_MAX_BYTES:
		return _plan(MODE_TOO_LARGE)
	if delta and size >= CHUNKED_MIN_BYTES:
		return _plan(MODE_CHUNKS)
	if size <= PKeyConstants.SYNC_SINGLE_PUT_MAX_BYTES:
		return _plan(MODE_SINGLE)
	var round_to: int = PKeyConstants.SYNC_PART_ROUND_BYTES
	var per_part: int = (size + PKeyConstants.SYNC_MAX_PARTS - 1) / PKeyConstants.SYNC_MAX_PARTS
	var rounded := (per_part + round_to - 1) / round_to * round_to
	var part_bytes := mini(maxi(PKeyConstants.SYNC_PART_MIN_BYTES, rounded), PKeyConstants.SYNC_PART_MAX_BYTES)
	return _plan(MODE_MULTIPART, part_bytes, (size + part_bytes - 1) / part_bytes)


## Part `n` (from 1) of a multipart plan as a half-open byte range of the stored file:
## `{"start": int, "end": int}`. An empty dictionary for a plan that is not multipart or a part
## number outside it.
static func part_range(p: Dictionary, size: int, n: int) -> Dictionary:
	if p.get("mode") != MODE_MULTIPART or int(p.get("part_bytes", 0)) <= 0:
		return {}
	if n < 1 or n > int(p["parts"]):
		return {}
	var start: int = (n - 1) * int(p["part_bytes"])
	return {"start": start, "end": mini(size, start + int(p["part_bytes"]))}


static func _plan(mode: String, part_bytes := 0, parts := 0) -> Dictionary:
	return {"mode": mode, "part_bytes": part_bytes, "parts": parts}
