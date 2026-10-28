class_name PKeyCloudSyncController
extends RefCounted
## What the Cloud Sync screens do with `PolarisKey.keyring` (PKeySyncRing), headless: no node here
## (U-42.5). Each verb is a coroutine over `sdk.keyring` and answers a PKeyResult or a Dictionary
## the screens read; a missing key ring is a failure result, never an assert.
##
##   recover(sdk, text)         the recovery code typed in the app -> `unlock_step()` says what the
##                              screen shows next
##   start_over(sdk)            `keyring.reset(true)`: a new ring and a new recovery code, shown once
##   accept(sdk, served)        `keyring.accept_ring_change(served)`: only the ring the person was
##                              shown, only after they confirmed it
##   begin(sdk)                 `keyring.unlock()`: which screen this device needs (below)
##   new_recovery_code(sdk)     `keyring.set_recovery_code()`: the previous code stops working
##
## The recovery code is returned to the caller once and kept nowhere here. Nothing is logged.

## The step UnlockSync shows after `recover()`: "" for an unlocked device, "invalid" for a code that
## failed its check or does not open the ring, "no-code" when the account holds none (only Start over
## helps), else "failed" (a network or server failure).
static func unlock_step(r: PKeyResult) -> String:
	if r.ok:
		return ""
	if r.code == StringName(PKeyConstants.ErrorCode.RECOVERY_CODE_INVALID):
		return "invalid"
	if r.code == PKeyErrors.NOT_FOUND:
		return "no-code"
	return "failed"


static func recover(sdk: Object, text: String) -> PKeyResult:
	var ring := _ring(sdk)
	if ring == null:
		return _missing()
	return await ring.recover(text)


## ok with `{ring_id, epoch, root_kid, recovery_code}`: the code is the one to show, once.
static func start_over(sdk: Object) -> PKeyResult:
	var ring := _ring(sdk)
	if ring == null:
		return _missing()
	return await ring.reset(true)


## ok with `kind: "unlocked"` when the ring now opened, or with `kind: "ring-changed"` (and the new
## `served` and `by`) when the Worker changed the ring again: the screen then shows the new ring and
## asks again. Anything else is a failure.
static func accept(sdk: Object, served: Dictionary) -> PKeyResult:
	var ring := _ring(sdk)
	if ring == null:
		return _missing()
	var r: PKeyResult = await ring.accept_ring_change(served)
	if r.ok and not (r.detail is Dictionary and (r.detail.get("kind") == "unlocked" or r.detail.get("kind") == "ring-changed")):
		return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.BAD_RESPONSE), "The key ring is not the one that was shown.")
	return r


## ok with the code text to show.
static func new_recovery_code(sdk: Object) -> PKeyResult:
	var ring := _ring(sdk)
	if ring == null:
		return _missing()
	return await ring.set_recovery_code()


## The screen this device needs. `{screen, ...}`:
##   ""             unlocked: nothing to show
##   "recovery_code"  there was no ring, so one was created: `{code}` is its recovery code, shown once
##                    (a locked device with no ring is the create path, never a recovery-code ask)
##   "unlock_sync"  a ring exists and this device has no usable wrap: ask for the recovery code
##   "ring_change"  the Worker serves another ring than the pinned one: `{by, served}`
##   "failed"       the key ring could not be read or created
static func begin(sdk: Object) -> Dictionary:
	var ring := _ring(sdk)
	if ring == null:
		return {"screen": "failed"}
	var r: PKeyResult = await ring.unlock()
	if not r.ok or not (r.detail is Dictionary):
		return {"screen": "failed"}
	var d: Dictionary = r.detail
	match String(d.get("kind", "")):
		"unlocked":
			return {"screen": ""}
		"ring-changed":
			return {"screen": "ring_change", "by": d.get("by"), "served": d.get("served", {})}
		"locked":
			if d.get("reason") == "no-ring":
				var made: PKeyResult = await ring.create(true)
				if not made.ok or not (made.detail is Dictionary):
					return {"screen": "failed"}
				return {"screen": "recovery_code", "code": String(made.detail.get("recovery_code", ""))}
			return {"screen": "unlock_sync"}
	return {"screen": "failed"}


## Tests only: keep the clipboard in memory (a headless display server has none).
static var memory_clipboard := false
static var _memory := ""


static func clipboard_get() -> String:
	return _memory if memory_clipboard else DisplayServer.clipboard_get()


static func clipboard_set(text: String) -> void:
	if memory_clipboard:
		_memory = text
	else:
		DisplayServer.clipboard_set(text)


## The code as groups of four: spaces and hyphens are stripped and the characters regrouped in
## fours, whatever the engine or a host joined them with. What RecoveryCode draws, whole.
static func groups_of(code: String) -> PackedStringArray:
	var chars := ""
	for i in code.length():
		var c := code.unicode_at(i)
		if c == 45 or c == 32 or c == 9 or c == 10 or c == 13 or c == 0xA0 or c == 0x2011:
			continue
		chars += code[i]
	var out := PackedStringArray()
	for i in range(0, chars.length(), 4):
		out.append(chars.substr(i, 4))
	return out


## The hyphenated form the person copies: "XXXX-XXXX-...".
static func hyphenated(code: String) -> String:
	return "-".join(groups_of(code))


static func _ring(sdk: Object) -> Object:
	if sdk == null or not is_instance_valid(sdk):
		return null
	var r = sdk.get("keyring")
	return r if r is Object else null


static func _missing() -> PKeyResult:
	return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "Cloud Sync's key ring is not available here.")
