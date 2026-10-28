extends RefCounted
## Cloud Sync setting routes and the `user` block rules: a port of Python `cloud_sync/routes.py`
## and `packages/shared-catalog/src/cloudSync.ts` (`syncedSettings`, `settingRoute`,
## `userSettingIssues`, `mergeMembersOverLimit`). The corpus pins it (`sync-scenarios.json`
## `settingCases`). Entries are Dictionaries, as a catalog document carries them.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

const USER_SETTING_SYNC_SCOPES := ["user", "platform", "local"]
const USER_SETTING_CONFLICTS := ["lastWrite", "max", "min", "merge"]
const CLOUD_SYNC_MAX_MERGE_MEMBERS := PKeyConstants.SYNC_MAX_MERGE_MEMBERS
const CLOUD_SYNC_ENCRYPTION_MODES := ["e2e", "server"]
const _USER_BLOCK_MEMBERS := ["sync", "conflict", "listed"]


static func _one_of(v: Variant, values: Array) -> bool:
	return Types.is_string(v) and values.has(String(v))


## A catalog's effective mode: its declaration, else `e2e`.
static func cloud_sync_encryption(catalog: Dictionary) -> String:
	var block: Variant = catalog.get("cloudSync")
	if block is Dictionary and Types.is_string(block.get("encryption")) and String(block["encryption"]) == "server":
		return "server"
	return "e2e"


## Whether a `config` entry is Editable: no `managementDefault` locks it.
static func is_editable(entry: Dictionary) -> bool:
	var md: Variant = entry.get("managementDefault")
	return not (Types.is_string(md) and (String(md) == "enforced" or String(md) == "hidden"))


## One entry's route (see `synced_settings`).
static func setting_route(entry: Dictionary) -> Dictionary:
	var key: Variant = entry["key"]
	var kind: Variant = entry.get("kind")
	if not (Types.is_string(kind) and String(kind) == "config"):
		return {"key": key, "route": "refused"}
	if not is_editable(entry):
		return {"key": key, "route": "locked"}
	var user: Variant = entry.get("user")
	if user == null:
		user = {}
	var sync: Variant = user.get("sync")
	if sync == null:
		sync = "user"
	if Types.is_string(sync) and String(sync) == "local":
		return {"key": key, "route": "local"}
	var conflict: Variant = user.get("conflict")
	var listed: Variant = user.get("listed")
	var route := {
		"key": key,
		"route": "synced",
		"scope": sync,
		"policy": "lastWrite" if conflict == null else conflict,
		"listed": true if listed == null else listed,
	}
	if entry.has("schema"):
		route["schema"] = entry["schema"]
	return route


## One route per declared key, in catalog order. A catalog that carries its `cloudSync` block gets
## the mode on every route; one that hands over entries only gets the routes alone.
static func synced_settings(catalog: Dictionary) -> Array:
	var routes: Array = []
	for e in catalog["entries"]:
		routes.append(setting_route(e))
	if not catalog.has("cloudSync"):
		return routes
	var mode := cloud_sync_encryption(catalog)
	for r: Dictionary in routes:
		r["encryption"] = mode
	return routes


static func _schema_type_in(schema: Dictionary, types: Array) -> bool:
	var t: Variant = schema.get("type")
	if Types.is_string(t):
		return types.has(String(t))
	if t is Array and not t.is_empty():
		for v in t:
			if not _one_of(v, types):
				return false
		return true
	return false


## Rule 5: a `merge` value merges at most `CLOUD_SYNC_MAX_MERGE_MEMBERS` top-level members.
static func merge_members_over_limit(schema: Dictionary) -> bool:
	var mx: Variant = schema.get("maxProperties")
	var props: Variant = schema.get("properties")
	var declared: int = props.size() if props is Dictionary else 0
	return (Types.is_number(mx) and mx > CLOUD_SYNC_MAX_MERGE_MEMBERS) or declared > CLOUD_SYNC_MAX_MERGE_MEMBERS


static func _issue(out: Array, code: String, at: String, message: String, severity: String = "error") -> void:
	out.append({"code": code, "severity": severity, "at": at, "message": message})


## Every problem with `entry["user"]` (S-17 section 5.3 rules 1-5 and the block's shape), or `[]`.
## Each issue is `{code, severity, at, message}`; only `severity == "error"` blocks.
static func user_setting_issues(entry: Dictionary) -> Array:
	var out: Array = []
	if not entry.has("user"):
		return out
	var user: Variant = entry["user"]
	if not (user is Dictionary):
		_issue(out, "invalid_user_setting", "user", "user must be an object with optional sync (user, platform or local), conflict and listed.")
		return out
	for member in user:
		if not _USER_BLOCK_MEMBERS.has(member):
			_issue(out, "invalid_user_setting", "user.%s" % member, "user.%s is not a synced-setting member (sync, conflict, listed)." % member)
	var sync: Variant = user.get("sync")
	if Types.is_string(sync) and String(sync) == "device":
		_issue(out, "invalid_user_setting", "user.sync", "user.sync device is retired: a reinstall gets a new device id, so the value could not survive it. Use local to keep a value on the device.")
	elif user.has("sync") and not _one_of(sync, USER_SETTING_SYNC_SCOPES):
		_issue(out, "invalid_user_setting", "user.sync", "user.sync must be user, platform or local.")
	if user.has("listed") and typeof(user["listed"]) != TYPE_BOOL:
		_issue(out, "invalid_user_setting", "user.listed", "user.listed must be a boolean.")
	var conflict: Variant = user.get("conflict")
	if Types.is_string(conflict) and String(conflict) == "union":
		_issue(out, "user_conflict_union", "user.conflict", "user.conflict cannot be union; hold a set as an object of booleans with conflict: merge.")
	elif user.has("conflict") and not _one_of(conflict, USER_SETTING_CONFLICTS):
		_issue(out, "invalid_user_setting", "user.conflict", "user.conflict must be lastWrite, max, min or merge.")
	var kind: Variant = entry.get("kind")
	if not (Types.is_string(kind) and String(kind) == "config"):
		_issue(out, "user_setting_wrong_kind", "user", "user is only valid on config entries.")
	var md: Variant = entry.get("managementDefault")
	if Types.is_string(md) and (String(md) == "enforced" or String(md) == "hidden"):
		_issue(out, "user_setting_locked_default", "user", "user has no effect on a key whose managementDefault is enforced or hidden: the key is locked, so it never syncs.", "warning")
	var raw_schema: Variant = entry.get("schema")
	var schema: Dictionary = raw_schema if raw_schema is Dictionary else {}
	var c := String(conflict) if Types.is_string(conflict) else ""
	if (c == "max" or c == "min") and not _schema_type_in(schema, ["number", "integer"]):
		_issue(out, "user_conflict_type_mismatch", "user.conflict", "user.conflict %s needs a number schema." % c)
	if c == "merge":
		if not _schema_type_in(schema, ["object"]):
			_issue(out, "user_conflict_type_mismatch", "user.conflict", "user.conflict merge needs an object schema; a set is an object of booleans.")
		elif merge_members_over_limit(schema):
			_issue(out, "merge_members_over_limit", "schema", "A merged value has at most %d top-level members (maxProperties and declared properties)." % CLOUD_SYNC_MAX_MERGE_MEMBERS)
	return out
