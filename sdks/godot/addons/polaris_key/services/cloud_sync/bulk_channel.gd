extends RefCounted
## The bulk-body channel of Cloud Sync file transfers (U-41.G; GODOT-MOBILE-SYNC D-5, D-6): the port a native
## lane implements so a save's large request bodies are queued with the operating system and finish while the
## game is suspended. The engine, the journal, the codec and the JSON calls stay in GDScript; this port
## carries only sealed PUT bodies and GET answers. This base class is the contract and the "no channel"
## answer: `available()` is false and every call refuses.
##
## A head is a Dictionary:
##   req        positive int, unique among the requests in flight (1..2^31-1)
##   transfer   the journal id of the transfer the request belongs to (1..256 characters)
##   url        the absolute URL of one of the product's file routes
##   headers    request headers; never `authorization` (the native lane refuses it)
##   bearer     the token, for this request only; kept out of every other field, event and file
##   max_body   the most bytes an answer may carry
##   part       a small int that tags the request (a part number; 0 otherwise)
##
## `put` and `fetch` are coroutines. An answer is `{status, headers (lower-case names), body}`, or
## `{fail: "network" | "oversize"}`. A request that gets no answer simply does not return: the caller owns
## the deadline and then calls `cancel(req)`. (`fetch` is the plan's `get`; `get` is a built-in of every
## Object and cannot be overridden.)
##
## A native lane must not follow redirects: a 3xx is answered as it is (the caller refuses it), so the bearer
## and the body never leave the product's origin.

## Whether requests can be queued now.
func available() -> bool:
	return false


## Reconcile with the system at start. `keep_ids` are the journaled transfer ids to keep; tasks of any other
## transfer are cancelled and their spool files swept. A coroutine answering `{resume: [transfer id...],
## cancelled: int, swept: int}`: `resume` names the transfers whose tasks were lost and must be sent again.
func open(_keep_ids: Array) -> Dictionary:
	return {"resume": [], "cancelled": 0, "swept": 0}


## Queue one PUT: `head` and the request body.
func put(_head: Dictionary, _body: PackedByteArray) -> Dictionary:
	return {"fail": "network"}


## Queue one GET.
func fetch(_head: Dictionary) -> Dictionary:
	return {"fail": "network"}


## Cancel one request (an int `req`) or every request of a transfer (a String id). Final: a late answer
## for a cancelled request is dropped.
func cancel(_what: Variant) -> void:
	pass


## Cancel everything and release the session. Safe to call more than once.
func close() -> void:
	pass
