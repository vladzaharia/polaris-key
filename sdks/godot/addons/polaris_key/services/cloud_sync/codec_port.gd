extends RefCounted
## The seam between the Cloud Sync host and the end-to-end codec (U-21.8 plugs the real one in).
## This base class is the codec of a device with no ring yet: it is locked, so an E2E product
## stays `locked` and sends and reads nothing. That is the correct state, not a stub.
##
## A real codec overrides all four. Results are Dictionaries, never exceptions:
##
##   locked()                       true while there is no root (S3: nothing is sent or read)
##   attach(listener: Callable)     `listener(present: bool)` on a lock or unlock; returns a
##                                  detach Callable. The host feeds the machine at its next pump.
##   seal_push(body, routes)        `{ok: true, body}` (the sealed push body), or `{ok: false}`:
##                                  locked, or a mutation that cannot be sealed. Nothing is sent.
##   open_pull(body, mutations, aliases, open_keys, record_keys = [])
##                                  `{ok: true, body, opened}`: the body with the served
##                                  `sealed`/`invalid`/`seq` stripped and the host's own opened
##                                  result (HC-2), or `{ok: false}` (locked since the request left,
##                                  or a repeated mutationId): the answer is dropped, the cursor stays.
##                                  `record_keys` are the `[collection, id]` of the records the machine
##                                  holds, so a record tombstone's blinded id maps back (U-23.G3).
##
## No value, root or key may appear in a log, error or event (H-11).


func locked() -> bool:
	return true


func attach(_listener: Callable) -> Callable:
	return func() -> void: pass


func seal_push(_body: Dictionary, _routes: Array) -> Dictionary:
	return {"ok": false}


## The id a record travels under in end-to-end mode (§13.10.2): blinded under the root. "" while locked.
func blind_record(_collection: String, _id: String) -> String:
	return ""


## Hands the current root to `fn` (a Callable(root) -> Variant); null while locked. How the saves' file
## codec gets the key it seals files under, without the root leaving the ring.
func with_root(_fn: Callable) -> Variant:
	return null


func open_pull(_body: Dictionary, _mutations: Variant, _aliases: Variant, _open_keys: Array, _record_keys: Array = []) -> Dictionary:
	return {"ok": false}
