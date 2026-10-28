extends RefCounted
# @pkey-feature license.activate license.refusals
# Every outcome the seven seeded test keys reach through license.activate_with_key, as the Worker
# answers it: the SDK maps the answer, and the server's code and status come through. `ok` and
# `floating` (a bulk key with no account) activate. `expired`, `disabled` and `revoked` all answer
# 401 `unauthorized`, so a caller cannot tell a dead key from an unknown one. `device-limit-full`
# (its one seat is held by another device) answers 403 `device_limit` with a manage link, and
# `key-entry-limit` 403 `key_entry_limit`, a typed kind of its own (identity.keyentry, I-10b.14).
#
# What is checked is the code, the status and the shape of the answer: the manage link is on the
# server's own origin here and on the production one elsewhere, and the counters depend on how
# many devices the server has seen, so neither is compared to a value.
#
# Each row runs as the device of its `device` role (PKeyDevLive.device_id): `ok` and `floating`
# claim a seat once and keep it, and the refused keys come from a device that holds none.

const ROWS := [
	{"key": "ok", "device": "key", "kind": &"ok"},
	{"key": "floating", "device": "floating", "kind": &"ok"},
	{"key": "expired", "device": "refused", "kind": &"unauthorized", "status": 401, "code": &"unauthorized"},
	{"key": "disabled", "device": "refused", "kind": &"unauthorized", "status": 401, "code": &"unauthorized"},
	{"key": "revoked", "device": "refused", "kind": &"unauthorized", "status": 401, "code": &"unauthorized"},
	{"key": "device-limit-full", "device": "refused", "kind": &"device-limit", "status": 403, "code": &"device_limit"},
	{"key": "key-entry-limit", "device": "refused", "kind": &"key-entry-limit", "status": 403, "code": &"key_entry_limit"},
]


func run(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	var rows := []
	for row in ROWS:
		rows.append(row["key"])
	var seeded: Array = bed.info.get("keys", {}).keys()
	t.check("refusals: the server seeds the seven test keys and each has a row here", PKeyDevLive.same_set(seeded, PKeyDevLive.KEYS) and PKeyDevLive.same_set(rows, PKeyDevLive.KEYS), "seeded %s, rows %s" % [seeded, rows])

	var dead := []
	for row in ROWS:
		var got = await _try(t, bed, row)
		if row["kind"] == &"unauthorized" and got != null:
			dead.append(got)
	t.check("refusals: expired, disabled and revoked are one answer", dead.size() == 3 and dead[0] == dead[1] and dead[1] == dead[2], str(dead))


## One key through activate_with_key on a fresh SDK. The refusal's {kind, code, status, message}
## for the three that must read alike, else null.
func _try(t: PKeyTestContext, bed: PKeyDevLive, row: Dictionary) -> Variant:
	var name: String = row["key"]
	var sdk: Node = await bed.sdk(row["device"])
	if not t.check("%s: the SDK is configured from the quickstart" % name, bed.last_configure.ok, str(bed.last_configure)):
		bed.drop(sdk)
		return null
	var r: PKeyActivationResult = await sdk.license.activate_with_key(bed.key(name))
	var kind: StringName = row["kind"]
	t.check("%s: activate_with_key answers kind %s" % [name, kind], r.kind == kind and r.ok == (kind == PKeyActivationResult.KIND_OK), str(r))
	var summary: Variant = null
	if kind == PKeyActivationResult.KIND_OK:
		t.check("%s: the token is stored and the verified document opens the gate" % name, r.stored and sdk.core.tokens.has_token() and sdk.is_licensed() and sdk.status().get("status") == "ok", str(sdk.status()))
	else:
		t.check("%s: the server's answer is HTTP %d with code %s" % [name, row["status"], row["code"]], r.status == row["status"] and r.code == row["code"], "%d %s" % [r.status, r.code])
		t.check("%s: nothing is stored and the gate still asks for activation" % name, not sdk.core.tokens.has_token() and String(sdk.core.store.token) == "" and sdk.status().get("status") == "needs-activation" and not sdk.is_licensed(), str(sdk.status()))
		if kind == PKeyActivationResult.KIND_UNAUTHORIZED:
			summary = [r.kind, r.code, r.status, r.message]
		if kind == PKeyActivationResult.KIND_DEVICE_LIMIT:
			t.check("%s: the refusal carries the seat limit and device count as numbers and a manage link" % name, r.limit is int and r.device_count is int and PKeyManage.is_valid(r.manage_url), "limit %s, count %s, link %s" % [r.limit, r.device_count, r.manage_url])
	bed.drop(sdk)
	return summary
