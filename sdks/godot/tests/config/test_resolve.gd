extends RefCounted
# client-core `config.ts`, case for case (the cases sdk-node/test/config.test.ts pins through the
# Node client): enforced and hidden are locked, a default key follows local > env > remote
# default > fallback, the env-var name, JSON coercion of environment values, and the user list.

const S := preload("res://tests/config/support.gd")


func _ctx(remote: Variant, local: Dictionary = {}, env: Dictionary = {}, prefix := PKeyConfigResolve.DEFAULT_ENV_PREFIX) -> PKeyConfigResolve.Context:
	return PKeyConfigResolve.Context.from_tables(remote, local, env, prefix)


func run(t: PKeyTestContext) -> void:
	_locked(t)
	_default_precedence(t)
	_env_naming(t)
	_env_coercion(t)
	_list(t)


func _locked(t: PKeyTestContext) -> void:
	var c := _ctx({"quality.floor": S.entry("enforced", "flac")}, {"quality.floor": "mp3"}, {"PKEY_CONFIG_quality__floor": "wav"})
	t.check("resolve: enforced beats a local override and an env value", PKeyConfigResolve.resolve_value(c, "quality.floor") == ["flac"] and PKeyConfigResolve.resolve_source(c, "quality.floor") == PKeyConfigResolve.ENFORCED)
	c = _ctx({"secret.knob": S.entry("hidden", "locked")}, {"secret.knob": "nope"}, {"PKEY_CONFIG_secret__knob": "nope2"})
	t.check("resolve: hidden is applied and beats both overrides", PKeyConfigResolve.resolve_value(c, "secret.knob") == ["locked"] and PKeyConfigResolve.resolve_source(c, "secret.knob") == PKeyConfigResolve.HIDDEN)
	c = _ctx({"k": S.entry("enforced", null)}, {"k": 1})
	t.check("resolve: an enforced null is a value, not a miss", PKeyConfigResolve.resolve_value(c, "k") == [null] and PKeyConfigResolve.resolve_source(c, "k") == PKeyConfigResolve.ENFORCED)


func _default_precedence(t: PKeyTestContext) -> void:
	var remote := {"run.concurrency": S.entry("default", 4)}
	var c := _ctx(remote, {"run.concurrency": 8}, {"PKEY_CONFIG_run__concurrency": "16"})
	t.check("resolve: local beats env and remote default", PKeyConfigResolve.resolve_value(c, "run.concurrency") == [8] and PKeyConfigResolve.resolve_source(c, "run.concurrency") == PKeyConfigResolve.LOCAL)
	c = _ctx(remote, {}, {"PKEY_CONFIG_run__concurrency": "16"})
	t.check("resolve: env beats remote default (JSON-parsed)", S.same(PKeyConfigResolve.resolve_value(c, "run.concurrency"), [16]) and PKeyConfigResolve.resolve_source(c, "run.concurrency") == PKeyConfigResolve.ENV)
	c = _ctx({"log.level": S.entry("default", "info")}, {}, {"PKEY_CONFIG_log__level": "debug"})
	t.check("resolve: a raw env string is kept when not JSON-shaped", PKeyConfigResolve.resolve_value(c, "log.level") == ["debug"] and PKeyConfigResolve.resolve_source(c, "log.level") == PKeyConfigResolve.ENV)
	c = _ctx(remote)
	t.check("resolve: remote default when nothing overrides", PKeyConfigResolve.resolve_value(c, "run.concurrency") == [4] and PKeyConfigResolve.resolve_source(c, "run.concurrency") == PKeyConfigResolve.REMOTE_DEFAULT)
	c = _ctx({})
	t.check("resolve: fallback when the key is absent everywhere", PKeyConfigResolve.resolve_value(c, "missing.key") == [] and PKeyConfigResolve.resolve_source(c, "missing.key") == PKeyConfigResolve.FALLBACK)
	c = _ctx(null, {"run.concurrency": 8}, {"PKEY_CONFIG_log__level": "debug"})
	t.check("resolve: without a document the local and env layers still resolve", PKeyConfigResolve.resolve_value(c, "run.concurrency") == [8] and PKeyConfigResolve.resolve_value(c, "log.level") == ["debug"])
	c = _ctx(remote, {"run.concurrency": null})
	t.check("resolve: a local null override is an override", PKeyConfigResolve.resolve_value(c, "run.concurrency") == [null] and PKeyConfigResolve.resolve_source(c, "run.concurrency") == PKeyConfigResolve.LOCAL)
	c = _ctx({"k": S.entry("default", 1), "odd": "not an entry"}, {})
	t.check("resolve: a malformed entry reads as absent", PKeyConfigResolve.resolve_source(c, "odd") == PKeyConfigResolve.FALLBACK)
	c = _ctx(remote, {}, {"DJDL_run__concurrency": "32"}, "DJDL_")
	t.check("resolve: a custom prefix is honoured", S.same(PKeyConfigResolve.resolve_value(c, "run.concurrency"), [32]) and PKeyConfigResolve.resolve_source(c, "run.concurrency") == PKeyConfigResolve.ENV)


func _env_naming(t: PKeyTestContext) -> void:
	t.check("resolve: dots become double underscores", PKeyConfigResolve.env_var_name("PKEY_CONFIG_", "run.concurrency") == "PKEY_CONFIG_run__concurrency" and PKeyConfigResolve.env_var_name("P_", "a.b.c") == "P_a__b__c")
	var remote := {"run.concurrency": S.entry("default", 4)}
	var c := _ctx(remote, {}, {"PLRS_CONFIG_run__concurrency": "16"})
	t.check("resolve: the withdrawn PLRS_CONFIG_ prefix is not read", PKeyConfigResolve.resolve_value(c, "run.concurrency") == [4] and PKeyConfigResolve.resolve_source(c, "run.concurrency") == PKeyConfigResolve.REMOTE_DEFAULT)
	c = _ctx(remote, {}, {"PKEY_CONFIG_run_concurrency": "16"})
	t.check("resolve: a single underscore does not match a dotted key", PKeyConfigResolve.resolve_value(c, "run.concurrency") == [4])


func _env_coercion(t: PKeyTestContext) -> void:
	var cases := [
		["a number", "16", 16],
		["a negative float", "-2.5", -2.5],
		["an exponent", "1e3", 1000],
		["true", "true", true],
		["false", "false", false],
		["null", "null", null],
		["an object", "{\"a\":1}", {"a": 1}],
		["an array", "[1,2,3]", [1, 2, 3]],
		["a quoted string", "\"quoted\"", "quoted"],
		["padded JSON", "  42 ", 42],
		["malformed JSON-looking text (kept raw)", "{\"a\":", "{\"a\":"],
		["lenient JSON (kept raw: strict parsing)", "[1,]", "[1,]"],
		["a plain word", "debug", "debug"],
		["a number-ish word", "1.2.3", "1.2.3"],
		["an empty string", "", ""],
	]
	for row in cases:
		var c := _ctx({"run.knob": S.entry("default", "remote")}, {}, {"PKEY_CONFIG_run__knob": row[1]})
		var got := PKeyConfigResolve.resolve_value(c, "run.knob")
		t.check("resolve: env coercion, %s" % row[0], got.size() == 1 and S.same(got[0], row[2]) and PKeyConfigResolve.resolve_source(c, "run.knob") == PKeyConfigResolve.ENV, JSON.stringify(got))
	t.check("resolve: looks_like_json", PKeyConfigResolve.looks_like_json(" true") and PKeyConfigResolve.looks_like_json("-0.5e-3") and PKeyConfigResolve.looks_like_json("[") and not PKeyConfigResolve.looks_like_json("") and not PKeyConfigResolve.looks_like_json("yes") and not PKeyConfigResolve.looks_like_json("+1"))


func _list(t: PKeyTestContext) -> void:
	var rows := PKeyConfigResolve.list_user_entries({
		"run.concurrency": S.entry("default", 4),
		"quality.floor": S.entry("enforced", "flac"),
		"secret.knob": S.entry("hidden", "locked"),
	})
	t.check("resolve: the user list drops hidden keys, in document order", rows.map(func(r): return r["key"]) == ["run.concurrency", "quality.floor"], str(rows))
	t.check("resolve: enforced rows are flagged", rows[1] == {"key": "quality.floor", "value": "flac", "enforced": true} and rows[0]["enforced"] == false)
	t.check("resolve: no document lists nothing", PKeyConfigResolve.list_user_entries(null).is_empty())
