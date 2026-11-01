@tool
class_name PKeyConnectContacts
extends RefCounted
## Inter-account links as the Godot SDK holds them (CC-19b.G2; WIRE-CONTRACT-V5 section 15.10): the
## `contacts` rows of the `pkey.connect.v1` record and the steps that change them, ported from sdk-node
## `connect/contacts.ts`. The rules (the cap of 64, the pending contacts, the trial order, the 24 h lapse)
## are `PKeyPeerContact`'s; this file carries the SDK's own columns (`created_at`, `reachable`) across
## those calls and keeps the record.
##
## Rules this file keeps:
##   - a contact secret is key material: it is decoded for one call and zeroed after (best effort), it is
##     in no `info()` row, no result, no error and no `str()`, and `info()` carries no key of any kind;
##   - an `id` is derived from the peer's agreeKey (a public key) and names a link on this device only:
##     SHA-256("pkey-contact/1" 0x00 agreeKey)[0..12] in base64url, 16 characters;
##   - a pending contact is dropped 24 h after it was stored, on every read;
##   - a record that cannot be read is never replaced here (`PKeyConnectState` answers an error), and a
##     device with no record has no links: a link needs the account's record around it.
## Every call answers a PKeyResult. Not thread safe: the main thread only.

const ID_PREFIX := "pkey-contact/1"

var _state: PKeyConnectState
var _now: Callable


## `state` is the connect record's store; `now` is Callable() -> epoch seconds (empty: the system clock).
func _init(state: PKeyConnectState, now: Callable = Callable()) -> void:
	_state = state
	_now = now


func _to_string() -> String:
	return "PKeyConnectContacts()"


## The link id for a peer's agreeKey (43 canonical base64url characters); "" otherwise.
static func id_of(agree_key: String) -> String:
	var raw: Variant = PKeyB64Url.decode_strict(agree_key) if agree_key.length() == 43 else null
	if raw == null or (raw as PackedByteArray).size() != 32:
		return ""
	var data := ID_PREFIX.to_utf8_buffer()
	data.append(0)
	data.append_array(raw)
	return PKeyB64Url.encode(PKeySyncHkdf.sha256(data).slice(0, 12))


# -- reads ----------------------------------------------------------------------------------------

## What the host sees of each held link, in the order they are held: Array of {id, label (String or
## null), categories, created_at, reachable, re_pair_pending}. Pending contacts show only as the held
## one's `re_pair_pending`. No key of any kind.
func list() -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var out := _info_of(rows)
	_wipe_rows(rows)
	return PKeyResult.success(out)


## The agreeKey of every active contact (the exchange's `held` list).
func held_keys() -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var out: Array = []
	for r: Row in rows:
		if not r.is_pending():
			out.append(r.agree_key)
	_wipe_rows(rows)
	return PKeyResult.success(out)


## The contacts in `PKeyPeerContact.trial_order` (held first, then pending), at most 72, decoded for a
## session: Array of {id, agree_key, secret (PackedByteArray), label, cats, pending, reachable}. The
## caller zeroes them with `wipe_live`.
func trial_order() -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var out: Array = []
	var ordered := PKeyPeerContact.trial_order(rows.map(func(r: Row) -> PKeyPeerContact.StoredContact: return r.stored))
	for c: PKeyPeerContact.StoredContact in ordered:
		for r: Row in rows:
			if r.stored == c:
				out.append(r.live())
				break
	_wipe_rows(rows)
	return PKeyResult.success(out)


## The live contact for a link id (the held one), or a `link-unknown` failure.
func live(link_id: String) -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var found: Variant = null
	for r: Row in rows:
		if not r.is_pending() and r.id() == link_id:
			found = r.live()
			break
	_wipe_rows(rows)
	if found == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")
	return PKeyResult.success(found)


static func wipe_live(list_of: Array) -> void:
	for c in list_of:
		if c is Dictionary and (c as Dictionary).get("secret") is PackedByteArray:
			# A value read out of a Dictionary is a copy: replace the entry with zeros (best effort).
			var zeros := PackedByteArray()
			zeros.resize(((c as Dictionary)["secret"] as PackedByteArray).size())
			(c as Dictionary)["secret"] = zeros


# -- changes --------------------------------------------------------------------------------------

## Store a contact the pairing produced. `incoming`: {agree_key, secret, label?, cats}. ok with
## {pending: bool} (a peer already held waits as a pending contact); a failure `full` at 64 contacts.
## The new contact is reachable. The caller's secret is not kept or zeroed here.
func store(incoming: Dictionary) -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var rec: PKeyConnectState.Record = loaded.detail["record"]
	var now := _seconds()
	var candidate := Row.new(incoming["agree_key"], incoming["secret"], str(incoming.get("label", "")), incoming["cats"], now, true, -1)
	var verdict := PKeyPeerContact.store(rows.map(func(r: Row) -> PKeyPeerContact.StoredContact: return r.stored), candidate.stored, now)
	if not verdict["ok"]:
		candidate.wipe()
		_wipe_rows(rows)
		return PKeyResult.failure(&"full", "No room for another link.")
	var next := _rows_after(rows, verdict["contacts"], candidate)
	var written := _write(rec, next)
	var pending: bool = verdict["pending"]
	candidate.wipe()
	_wipe_rows(next)
	_wipe_rows(rows)
	if not written.ok:
		return written
	return PKeyResult.success({"pending": pending})


## A handshake under the pending contact of `agree_key` passed the pin: it takes the held one's place,
## the held one's `reachable` choice kept.
func promote(agree_key: String) -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var pend: Row = null
	var held: Row = null
	for r: Row in rows:
		if r.agree_key == agree_key:
			if r.is_pending():
				pend = r
			else:
				held = r
	if pend == null:
		_wipe_rows(rows)
		return PKeyResult.success()
	var next: Array = []
	for c: PKeyPeerContact.StoredContact in PKeyPeerContact.promote(rows.map(func(r: Row) -> PKeyPeerContact.StoredContact: return r.stored), agree_key):
		if not c.is_pending() and c.agree_key == agree_key:
			next.append(Row.new(agree_key, pend.stored.secret, pend.stored.label, pend.stored.cats, pend.created_at, held.reachable if held != null else pend.reachable, -1))
		else:
			for r: Row in rows:
				if r.stored == c:
					next.append(r.copy())
					break
	var written := _write(loaded.detail["record"], next)
	_wipe_rows(rows)
	_wipe_rows(next)
	return written


## Whether the host advertises and keeps a relay room for this link. `link-unknown` for no such link.
func set_reachable(link_id: String, reachable: bool) -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var hit := false
	for r: Row in rows:
		if r.id() == link_id:
			r.reachable = reachable
			hit = true
	var written := _write(loaded.detail["record"], rows) if hit else PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")
	_wipe_rows(rows)
	return written


## Remove a link, its pending re-pair included: the secrets are gone from the record before this
## answers. `link-unknown` for no such link.
func remove(link_id: String) -> PKeyResult:
	var loaded := _load()
	if not loaded.ok:
		return loaded
	var rows: Array = loaded.detail["rows"]
	var keep: Array = []
	var hit := false
	for r: Row in rows:
		if r.id() == link_id:
			hit = true
		else:
			keep.append(r)
	if not hit:
		_wipe_rows(rows)
		return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")
	var written := _write(loaded.detail["record"], keep)
	_wipe_rows(rows)
	return written


# -- the record -----------------------------------------------------------------------------------

## ok with {record, rows}, the rows decoded and the stale pending ones dropped; a failure when the record
## is unusable or when none exists (`connect-unavailable`).
func _load() -> PKeyResult:
	var r := _state.read()
	if not r.ok:
		return r
	if r.detail == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "No Cloud Connect record is held.")
	var rec: PKeyConnectState.Record = r.detail
	var rows: Array = []
	for raw: Dictionary in rec.contacts:
		rows.append(Row.from_raw(raw))
	var kept := PKeyPeerContact.drop_stale_pending(rows.map(func(x: Row) -> PKeyPeerContact.StoredContact: return x.stored), _seconds())
	if kept.size() != rows.size():
		var fresh: Array = []
		for x: Row in rows:
			if kept.has(x.stored):
				fresh.append(x)
			else:
				x.wipe()
		rows = fresh
		# Best effort: the lapse is applied again on the next read if this write fails.
		_write(rec, rows)
	return PKeyResult.success({"record": rec, "rows": rows})


func _write(rec: PKeyConnectState.Record, rows: Array) -> PKeyResult:
	var next := rec.duplicate_record()
	next.contacts = rows.map(func(r: Row) -> Dictionary: return r.raw())
	return _state.write(next)


## The rows of a list `PKeyPeerContact` returned, each carrying its own columns: a row that was held
## before keeps them (matched by key and pending state), the incoming one takes `candidate`'s.
func _rows_after(before: Array, after: Array, candidate: Row) -> Array:
	var out: Array = []
	for c: PKeyPeerContact.StoredContact in after:
		var was: Row = null
		for r: Row in before:
			# `PKeyPeerContact.store` keeps the rows it did not touch by identity.
			if r.stored == c:
				was = r
				break
		if was != null:
			out.append(was.copy())
		else:
			# The incoming contact (active, or pending with the time the store stamped).
			out.append(Row.new(c.agree_key, c.secret, c.label, c.cats, candidate.created_at, true, c.pending_since))
	return out


func _info_of(rows: Array) -> Array:
	var pending := {}
	for r: Row in rows:
		if r.is_pending():
			pending[r.agree_key] = true
	var out: Array = []
	for r: Row in rows:
		if r.is_pending():
			continue
		out.append({
			"id": r.id(), "label": null if r.stored.label == "" else r.stored.label, "categories": r.stored.cats.duplicate(),
			"created_at": r.created_at, "reachable": r.reachable, "re_pair_pending": pending.has(r.agree_key),
		})
	return out


func _seconds() -> int:
	return int(_now.call()) if _now.is_valid() else PKeyClaims.system_now()


static func _wipe_rows(rows: Array) -> void:
	for r: Row in rows:
		r.wipe()


## One contact as it rests in the record, decoded. `wipe()` zeroes the secret.
class Row extends RefCounted:
	var stored: PKeyPeerContact.StoredContact
	var created_at: int
	var reachable: bool
	var agree_key: String:
		get:
			return stored.agree_key


	func _init(p_agree_key: String, p_secret: PackedByteArray, p_label: String, p_cats: Array, p_created_at: int, p_reachable: bool, p_pending_since: int) -> void:
		stored = PKeyPeerContact.StoredContact.new(p_agree_key, p_secret, p_label, p_cats, p_pending_since)
		created_at = p_created_at
		reachable = p_reachable


	func _to_string() -> String:
		return "PKeyConnectContacts.Row()"


	static func from_raw(d: Dictionary) -> Row:
		var secret: Variant = PKeyB64Url.decode_strict(d["secret"])
		return Row.new(d["agreeKey"], secret if secret != null else PackedByteArray(), str(d.get("label", "")), d["cats"], int(d["createdAt"]), d["reachable"], int(d.get("pendingSince", -1)))


	func raw() -> Dictionary:
		var d := {"agreeKey": stored.agree_key, "secret": PKeyB64Url.encode(stored.secret), "cats": stored.cats.duplicate(), "createdAt": created_at, "reachable": reachable}
		if stored.label != "":
			d["label"] = stored.label
		if stored.is_pending():
			d["pendingSince"] = stored.pending_since
		return d


	func is_pending() -> bool:
		return stored.is_pending()


	func id() -> String:
		return PKeyConnectContacts.id_of(stored.agree_key)


	func copy() -> Row:
		return Row.new(stored.agree_key, stored.secret, stored.label, stored.cats, created_at, reachable, stored.pending_since)


	## The contact for a session; its secret is a copy the caller zeroes.
	func live() -> Dictionary:
		return {
			"id": id(), "agree_key": stored.agree_key, "secret": stored.secret.duplicate(), "label": stored.label,
			"cats": stored.cats.duplicate(), "pending": is_pending(), "reachable": reachable,
		}


	func wipe() -> void:
		stored.wipe()
