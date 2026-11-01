@tool
class_name PKeyPeerContactFlow
extends RefCounted
## The contact parts of a `PKeyPeerSession` (CC-19b.G2; WIRE-CONTRACT-V5 section 15.10), kept out of the
## session's file: the checks of the `contacts` and `exchange` options, the key trial of a responder's
## message 1, and the `contact` event the exchange ends with. Static functions over what the session hands
## in; nothing here keeps state, and no key or secret is put in `str()`.


## What is wrong with the `contacts` and `exchange` options of a session, or "".
static func options_problem(mode: String, role: String, options: Dictionary) -> String:
	var contacts: Variant = options.get("contacts")
	if contacts == null:
		if mode == "c":
			return "contacts"
	else:
		var bad := _contacts_problem(mode, role, contacts)
		if bad != "":
			return bad
		if role == "responder" and not options.get("admission") is PKeyPeerLimiter:
			return "a contact responder needs an admission limiter"
	var offer: Variant = options.get("exchange")
	if offer != null and (mode != "p" or not offer is Dictionary or not PKeyPeerContact.build_contact(offer).ok or not (offer as Dictionary).get("held", []) is Array):
		return "exchange"
	return ""


static func _contacts_problem(mode: String, role: String, contacts: Variant) -> String:
	if not contacts is Array or not (mode == "c" or (mode == "a" and role == "responder")):
		return "contacts"
	var n: int = (contacts as Array).size()
	if n < 1 or n > PKeyPeerContact.MAX_CONTACT_SECRETS or (mode == "c" and role == "initiator" and n != 1):
		return "contacts"
	for c in contacts:
		if not _contact_ok(c):
			return "contacts"
	return ""


static func _contact_ok(c: Variant) -> bool:
	if not c is Dictionary:
		return false
	var d: Dictionary = c
	return d.get("secret") is PackedByteArray and (d["secret"] as PackedByteArray).size() == 32 and d.get("agree_key") is String and (d["agree_key"] as String).length() == 43


## The PSK of a mode: the discovery key's in mode a, the contact secret itself in mode c, null in v and p.
## Empty when the key is unusable.
static func psk_for(slug: String, mode: String, key: Variant) -> Variant:
	if mode == "a":
		return PKeyPeerNoise.psk(key if key is PackedByteArray else PackedByteArray(), slug)
	if mode == "c":
		return key if key is PackedByteArray else PackedByteArray()
	return null


## Message 1 of a responder (section 15.5 and 15.10): the keys are tried in a fixed order, the account's
## discovery keys (mode a, the current then the previous) and then the contact secrets in the order given
## (at most 72), by `PKeyPeerContact.listener_trial`; modes v and p have one plain XX trial. The limiter's
## `begin()` comes after the account keys and before the first secret, and a refusal is `peer_busy` with
## nothing tried. No static DH runs before a tag verifies. The whole trial is one offloaded task and
## touches only what `ctx` hands it: {mode, slug, static_key, crypto, admission, account (Array or null),
## secrets (Array of PackedByteArray)}. A coroutine. Answers {hit ("" none, "a:<i>", "c:<i>" or "p:0"),
## close (StringName), hs, payload, ticket (a limiter ticket the caller now owns, or null)}.
static func first_message(noise: PackedByteArray, ctx: Dictionary, offload: Callable) -> Dictionary:
	var box := {"hs": null, "payload": PackedByteArray(), "ticket": null}
	var work := func() -> Dictionary:
		if ctx["mode"] == "v" or ctx["mode"] == "p":
			return _plain_open(noise, ctx, box)
		var admit := func() -> bool: return _admit(ctx, box)
		var try_open := func(kind: String, index: int) -> bool: return _try(kind, index, noise, ctx, box)
		return PKeyPeerContact.listener_trial(ctx["account"], (ctx["secrets"] as Array).size(), admit, try_open)
	var out: Variant = work.call() if not offload.is_valid() else await offload.call(work)
	var res := {"hit": "", "close": &"", "hs": box["hs"], "payload": box["payload"], "ticket": box["ticket"]}
	if out is Dictionary:
		res["hit"] = (out as Dictionary)["hit"]
		res["close"] = (out as Dictionary)["close"]
	return res


static func _admit(ctx: Dictionary, box: Dictionary) -> bool:
	box["ticket"] = (ctx["admission"] as PKeyPeerLimiter).begin()
	return box["ticket"] != null


static func _plain_open(noise: PackedByteArray, ctx: Dictionary, box: Dictionary) -> Dictionary:
	var mode: String = ctx["mode"]
	var started := PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name(mode), PKeyPeerNoise.prologue(ctx["slug"], mode), ctx["static_key"], null, null, ctx["crypto"])
	var r: PKeyResult = (started.detail as PKeyPeerNoise.Handshake).read_message(noise) if started.ok else started
	if not r.ok:
		return {"hit": "", "close": &""}
	box["hs"] = started.detail
	box["payload"] = r.detail
	return {"hit": "p:0", "close": &""}


## Whether message 1 opens under the account key (`kind` "a") or contact secret (`kind` "c") `index`.
static func _try(kind: String, index: int, noise: PackedByteArray, ctx: Dictionary, box: Dictionary) -> bool:
	var m := "a" if kind == "a" else "c"
	var key: Variant = (ctx["account"] as Array)[index] if kind == "a" else (ctx["secrets"] as Array)[index]
	var psk: Variant = psk_for(ctx["slug"], m, key)
	if (psk as PackedByteArray).is_empty():
		return false
	var started := PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name(m), PKeyPeerNoise.prologue(ctx["slug"], m), ctx["static_key"], psk, null, ctx["crypto"])
	if not started.ok:
		return false
	var trial: PKeyPeerNoise.Handshake = started.detail
	var r := trial.read_message(noise)
	if not r.ok:
		return false
	box["hs"] = trial
	box["payload"] = r.detail
	return true


## The `contact` event for the peer's CONTACT the exchange stored, or an empty Dictionary when a key does
## not decode or the secret cannot be made. `stored` is {agree_key, label?, cats, pending}.
static func contact_event(stored: Dictionary, own_agree_key: String, h: PackedByteArray, n_d: PackedByteArray, n_m: PackedByteArray) -> Dictionary:
	var own: Variant = PKeyB64Url.decode_strict(own_agree_key)
	var peer: Variant = PKeyB64Url.decode_strict(stored["agree_key"])
	if own == null or peer == null:
		return {}
	var secret := PKeyPeerContact.contact_secret(h, n_d, n_m, own, peer)
	if secret.is_empty():
		return {}
	var out := {"type": &"contact", "secret": secret, "agree_key": stored["agree_key"], "cats": stored["cats"], "pending": stored["pending"]}
	if stored.has("label"):
		out["label"] = stored["label"]
	return out
