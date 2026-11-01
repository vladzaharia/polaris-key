@tool
class_name PKeyConnectLanContacts
extends RefCounted
## The inter-account half of the LAN service (CC-19b.G3; WIRE-CONTRACT-V5 sections 15.4 and 15.10), ported from
## the contact parts of sdk-node `connect/lan.ts`: the contacts the host holds, the adverts that announce
## the reachable ones, the instance names the browse lets in and the contacts seen on the network. It is
## state over one `PKeyConnectLan`; the service calls it and owns the listener, the lane and the sessions.
##
## Rules this file keeps:
##  - nothing here runs without contacts: the host's `contacts` Callable answers none while the cached
##    discovery `interAccount` is false, so there are then no adverts, no accepted names and no mode-c answers
##    (R-9a B5). The service reads it again whenever `refresh_contacts()` is called;
##  - at most 8 adverts are live (`m=c`, slot c, the service's own port), one per reachable contact, named by
##    `PKeyPeerContact.instance` with this device's agreeKey, and renewed at each 15-minute epoch;
##  - a name is accepted when one of the first 72 contacts, in the order given, would announce it in this or
##    the previous epoch; the first contact wins a tie. It is worked out once per epoch, so a forged name is
##    an O(1) miss;
##  - the secrets are the host's copies: they are zeroed when replaced, on `stop()` and in `wipe()`. No key,
##    secret or name is put in `str()`.

const MAX_LIVE := PKeyPeerContact.MAX_LIVE_CONTACT_ADVERTS

## The contacts, in trial order, as `PKeyConnectContacts.trial_order` answers them: {id, agree_key, secret,
## label, cats, pending, reachable}.
var contacts: Array = []
## The names `accepts` lets in -> the index in `contacts`.
var names: Dictionary = {}
var names_epoch := -1
## A short digest of the contacts: the service folds it into its own names signature.
var sig := ""

var _source: Callable
var _peers: Dictionary = {}
var _adverts: Dictionary = {}


## `source` is Callable() -> Array of live contacts (empty when links are off).
func _init(source: Callable) -> void:
	_source = source


func _to_string() -> String:
	return "PKeyConnectLanContacts(%d)" % contacts.size()


## Read the contacts again; the old secrets are zeroed. A peer seen under a contact that is gone is forgotten.
func load_contacts() -> void:
	var next: Variant = _source.call() if _source.is_valid() else []
	var old := contacts
	contacts = next if next is Array else []
	var parts := PackedStringArray()
	for c: Dictionary in contacts:
		parts.append("%s%s%s" % [c["id"], "p" if c["pending"] else "h", "r" if c["reachable"] else "-"])
	sig = ",".join(parts)
	PKeyConnectContacts.wipe_live(old)
	var have := {}
	for c: Dictionary in contacts:
		have["%s|%s" % [c["id"], c["pending"]]] = true
	for k: String in _peers.keys():
		var p: Dictionary = _peers[k]
		if not have.has("%s|%s" % [p["id"], p["pending"]]):
			_peers.erase(k)
	names_epoch = -1


## Work the accepted names out for `epoch` (this and the last), over the first 72 contacts.
func refresh_names(epoch: int) -> void:
	names = {}
	for i in mini(contacts.size(), PKeyPeerContact.MAX_CONTACT_SECRETS):
		var c: Dictionary = contacts[i]
		var key: Variant = PKeyB64Url.decode_strict(c["agree_key"])
		if key == null:
			continue
		for back in 2:
			var name := PKeyPeerContact.instance(c["secret"], key, epoch - back)
			if name != "" and not names.has(name):
				names[name] = i
	names_epoch = epoch


func accepts(instance: String) -> bool:
	return names.has(instance)


## The `{id, pending}` of contact `index`: what a session under it shows the host.
func ref_of(index: int) -> Dictionary:
	var c: Dictionary = contacts[index]
	return {"id": c["id"], "pending": c["pending"]}


## What a responder session is given: a copy of each secret (the session zeroes its own; the caller zeroes
## these) and the agreeKey, and the matching refs.
func links() -> Array:
	var out: Array = []
	for c: Dictionary in contacts:
		out.append({"secret": (c["secret"] as PackedByteArray).duplicate(), "agree_key": c["agree_key"]})
	return out


func refs() -> Array:
	var out: Array = []
	for i in contacts.size():
		out.append(ref_of(i))
	return out


## The index of the contact `id` (the pending secret of a re-pair when `pending`), or -1.
func find(id: String, pending: bool) -> int:
	for i in contacts.size():
		if contacts[i]["id"] == id and bool(contacts[i]["pending"]) == pending:
			return i
	return -1


## A browse hit that parsed as a contact advert: remember the contact it belongs to. `f` is the browse row,
## `hosts` the addresses that may be dialled. False when the name is not one of the accepted names.
func note_found(f: Dictionary, hosts: Array) -> bool:
	var index: Variant = names.get(str(f.get("instance", "")))
	if index == null or int(index) >= contacts.size():
		return false
	var c: Dictionary = contacts[int(index)]
	var peer := {
		"id": c["id"], "pending": c["pending"], "instance": str(f["instance"]), "hosts": hosts, "port": int(f.get("port", 0)),
		"native": bool(f.get("native", false)),
	}
	_peers["%s|%s" % [c["id"], c["pending"]]] = peer
	return true


## The contacts seen on this network now: [{id, pending}].
func seen() -> Array:
	var out: Array = []
	for p: Dictionary in _peers.values():
		out.append({"id": p["id"], "pending": p["pending"]})
	return out


## The address row of a contact seen now, or an empty Dictionary.
func peer_of(id: String, pending: bool) -> Dictionary:
	return (_peers.get("%s|%s" % [id, pending], {}) as Dictionary).duplicate(true)


func gone(instance: String) -> void:
	for k: String in _peers.keys():
		if _peers[k]["instance"] == instance:
			_peers.erase(k)


## Bring the live adverts to the reachable contacts (at most 8) for `epoch`, on `port`. `lane` is the discovery
## lane; a lane that says it has no slots gets none. ok, or the lane's failure for the first advert it refused.
func advertise(lane: Object, port: int, agree_public: PackedByteArray, epoch: int) -> PKeyResult:
	if lane.has_method("capabilities") and not bool((lane.call("capabilities") as Dictionary).get("slots", false)):
		stop_adverts()
		return PKeyResult.success()
	var want: Array = []
	for c: Dictionary in contacts:
		if want.size() < MAX_LIVE and bool(c["reachable"]):
			var name := PKeyPeerContact.instance(c["secret"], agree_public, epoch)
			if name != "" and not want.has(name):
				want.append(name)
	for name: String in _adverts.keys():
		if not want.has(name):
			(_adverts[name] as Object).call("stop")
			_adverts.erase(name)
	for name: String in want:
		if _adverts.has(name):
			continue
		var made: PKeyResult = lane.call("advertise", {"instance": name, "port": port, "txt": ["v=1", "m=c"], "slot": "c"})
		if not made.ok:
			return made
		_adverts[name] = made.detail
	return PKeyResult.success()


## Names of the live adverts (a test reads it).
func advert_names() -> Array:
	return _adverts.keys()


func stop_adverts() -> void:
	for h: Object in _adverts.values():
		h.call("stop")
	_adverts = {}


## Stop the adverts, forget the peers and zero the secrets.
func stop() -> void:
	stop_adverts()
	_peers = {}
	names = {}
	PKeyConnectContacts.wipe_live(contacts)
	contacts = []
	sig = ""
	names_epoch = -1
