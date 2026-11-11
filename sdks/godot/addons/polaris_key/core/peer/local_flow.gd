@tool
class_name PKeyPeerLocalFlow
extends RefCounted
## The local-link parts of a `PKeyPeerSession` (WIRE-CONTRACT-V5 section 15.12), kept out of the session's file like
## `PKeyPeerContactFlow`: the checks of the `locals`, `admission_group` and `pair` options, the held links, the
## key trial of a responder's message 1 in the shared listener (account keys, then contact secrets, then
## local-link secrets, under one limiter, padded to `TRIAL_TOTAL` trials on a miss) and the mode-q shower's single
## tag trial. Static functions over what the session hands in; no key or secret is put in `str()`.


## What is wrong with the local options of a session, or "".
static func options_problem(mode: String, role: String, options: Dictionary) -> String:
	var pair_bad := PKeyPeerLocalPairing.problem(mode, role, options.get("pair"))
	if pair_bad != "":
		return pair_bad
	var group: Variant = options.get("admission_group")
	if group != null and not (group is String and group != "" and role == "responder"):
		return "admission_group"
	var locals: Variant = options.get("locals")
	if locals == null:
		return "locals" if mode == "l" else ""
	if not locals is Array or not (mode == "l" or (role == "responder" and (mode == "a" or mode == "c"))):
		return "locals"
	var n: int = (locals as Array).size()
	if n < 1 or n > PKeyPeerLocal.MAX_LOCAL_LINKS or (mode == "l" and role == "initiator" and n != 1):
		return "locals"
	for l in locals:
		if not _link_ok(l):
			return "locals"
	if role == "responder" and not options.get("admission") is PKeyPeerLimiter:
		return "a local-link responder needs an admission limiter"
	if mode == "l" and options.has("contacts") and (role != "responder" or options.get("static_key") == null):
		return "contacts"
	return ""


static func _link_ok(l: Variant) -> bool:
	if not l is Dictionary:
		return false
	var d: Dictionary = l
	for k in ["secret", "peer_key"]:
		if not d.get(k) is PackedByteArray or (d[k] as PackedByteArray).size() != 32:
			return false
	var own: Variant = d.get("own_key")
	if own is PackedByteArray:
		return (own as PackedByteArray).size() == 32
	return own is Object and (own as Object).has_method("public_key") and (own as Object).has_method("dh")


## The links the session holds: its own copies of the secrets, the own key as a raw key or a port.
static func hold(raw: Array) -> Array:
	var out: Array = []
	for l: Dictionary in raw:
		var own: Variant = l["own_key"]
		out.append({
			"secret": (l["secret"] as PackedByteArray).duplicate(), "peer_key": (l["peer_key"] as PackedByteArray).duplicate(),
			"own": (own as PackedByteArray).duplicate() if own is PackedByteArray else PKeyPeerStaticPort.new(own, (own as Object).call("public_key")),
		})
	return out


## Zero the held secrets (best effort) and any raw own key.
static func wipe(held: Array) -> void:
	for l: Dictionary in held:
		(l["secret"] as PackedByteArray).fill(0)
		if l["own"] is PackedByteArray:
			(l["own"] as PackedByteArray).fill(0)


## Message 1 of a responder that serves local links (mode l, or the shared listener with `locals`). The keys are tried
## in a fixed order inside one offloaded task: the account's keys (mode a, the current then the previous), then
## each contact's secret, then each local link's secret. The limiter comes after the account keys and before the
## first secret: the source group's budget when no account key was tried and a group is known (only a failed
## trial then spends the shared one), else the shared limiter's `begin()`. A refusal tries no secret and is
## `peer_busy`. A miss on every one is padded with dummy trials to `TRIAL_TOTAL`, so it costs the same whatever
## the host holds. `ctx`: {slug, static_key, crypto, admission, group, account (Array or null), secrets (Array of
## PackedByteArray), locals (held links)}. A coroutine. Answers what `PKeyPeerContactFlow.first_message` does,
## with the hit "a:<i>", "c:<i>" or "l:<i>".
static func first_message(noise: PackedByteArray, ctx: Dictionary, offload: Callable) -> Dictionary:
	var box := {"hs": null, "payload": PackedByteArray(), "ticket": null}
	var work := func() -> Dictionary: return _trial(noise, ctx, box)
	var out: Variant = work.call() if not offload.is_valid() else await offload.call(work)
	var res := {"hit": "", "close": &"", "hs": box["hs"], "payload": box["payload"], "ticket": box["ticket"]}
	if out is Dictionary:
		res["hit"] = (out as Dictionary)["hit"]
		res["close"] = (out as Dictionary)["close"]
	return res


static func _trial(noise: PackedByteArray, ctx: Dictionary, box: Dictionary) -> Dictionary:
	var miss := {"hit": "", "close": PKeyPeerContact.CLOSE_HANDSHAKE_FAILED}
	var account: Variant = ctx["account"]
	var tried := 0
	if account is Array:
		for i in mini((account as Array).size(), PKeyPeerContact.MAX_ACCOUNT_TRIALS):
			if (account as Array)[i] == null:
				continue
			tried += 1
			if PKeyPeerContactFlow.open_with("a", i, noise, ctx, box):
				return {"hit": "a:%d" % i, "close": &""}
	var secrets: Array = ctx["secrets"]
	var locals: Array = ctx["locals"]
	var attempt: PKeyPeerLimiter.LocalAdmission = null
	if tried == 0 and ctx["group"] != "":
		var begun: Dictionary = (ctx["admission"] as PKeyPeerLimiter).begin_local(ctx["group"])
		if not begun["ok"]:
			return {"hit": "", "close": PKeyPeerContact.CLOSE_BUSY}
		attempt = begun["admission"]
	else:
		box["ticket"] = (ctx["admission"] as PKeyPeerLimiter).begin()
		if box["ticket"] == null:
			return {"hit": "", "close": PKeyPeerContact.CLOSE_BUSY}
	var real := tried
	for i in mini(secrets.size(), PKeyPeerContact.MAX_CONTACT_SECRETS):
		real += 1
		if PKeyPeerContactFlow.open_with("c", i, noise, ctx, box):
			return _hit("c:%d" % i, attempt, box)
	for i in mini(locals.size(), PKeyPeerLocal.MAX_LOCAL_LINKS):
		real += 1
		if _try_local(locals[i], noise, ctx, box):
			return _hit("l:%d" % i, attempt, box)
	if attempt != null:
		attempt.miss()
	_pad(noise, ctx["slug"], PKeyPeerLocal.trial_padding(real))
	return miss


static func _hit(hit: String, attempt: PKeyPeerLimiter.LocalAdmission, box: Dictionary) -> Dictionary:
	if attempt != null:
		box["ticket"] = attempt.hit()
	return {"hit": hit, "close": &""}


static func _try_local(link: Dictionary, noise: PackedByteArray, ctx: Dictionary, box: Dictionary) -> bool:
	var started := PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name("l"), PKeyPeerNoise.prologue(ctx["slug"], "l"), link["own"], link["secret"], null, ctx["crypto"])
	if not started.ok:
		return false
	var trial: PKeyPeerNoise.Handshake = started.detail
	var r := trial.read_message(noise)
	if not r.ok:
		return false
	box["hs"] = trial
	box["payload"] = r.detail
	return true


## Dummy trials under random secrets on the platform port, so a host's own port counts only the real ones.
static func _pad(noise: PackedByteArray, slug: String, count: int) -> void:
	var crypto := PKeyPeerCrypto.for_platform()
	var rnd := Crypto.new()
	for n in count:
		var started := PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name("l"), PKeyPeerNoise.prologue(slug, "l"), rnd.generate_random_bytes(32), rnd.generate_random_bytes(32), null, crypto)
		if started.ok:
			(started.detail as PKeyPeerNoise.Handshake).read_message(noise)


## The trial of message 1 for a listener: the mode-q shower's single tag when `pairing` is held (and its permit
## and 30 s allow; `guess` is raised through `emit`), else the local-link listener's, else the contact and
## account listener's. `ctx` is `first_message`'s plus {mode, psk}. A coroutine.
static func first_trial(noise: PackedByteArray, ctx: Dictionary, pairing: PKeyPeerLocalPairing, offload: Callable, emit: Callable) -> Dictionary:
	if ctx["mode"] == "q":
		if pairing.spent() or not pairing.permit():
			return {"hit": "", "close": PKeyPeerContact.CLOSE_HANDSHAKE_FAILED, "hs": null, "payload": PackedByteArray(), "ticket": null}
		ctx["psk"] = pairing.psk
		var tried := await pair_trial(noise, ctx, offload)
		emit.call({"type": &"guess", "opens": tried["hit"] != ""})
		return tried
	if ctx["mode"] == "l" or not (ctx["locals"] as Array).is_empty():
		return await first_message(noise, ctx, offload)
	return await PKeyPeerContactFlow.first_message(noise, ctx, offload)


## The mode-q shower's one tag trial under the code's PSK, offloaded. Answers the same shape as `first_message`
## with the hit "q:0" or "".
static func pair_trial(noise: PackedByteArray, ctx: Dictionary, offload: Callable) -> Dictionary:
	var box := {"hs": null, "payload": PackedByteArray(), "ticket": null}
	var work := func() -> bool:
		var started := PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name("q"), PKeyPeerNoise.prologue(ctx["slug"], "q"), ctx["static_key"], ctx["psk"], null, ctx["crypto"])
		var r: PKeyResult = (started.detail as PKeyPeerNoise.Handshake).read_message(noise) if started.ok else started
		if r.ok:
			box["hs"] = started.detail
			box["payload"] = r.detail
		return r.ok
	var opened: Variant = work.call() if not offload.is_valid() else await offload.call(work)
	var ok: bool = opened is bool and opened
	return {"hit": "q:0" if ok else "", "close": &"", "hs": box["hs"] if ok else null, "payload": box["payload"], "ticket": null}
