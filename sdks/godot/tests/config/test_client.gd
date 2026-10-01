extends RefCounted
# PolarisKey.config's wiring over the verified config document: values and sources, the
# user list at EFFECTIVE values, secrets as a separate map with no override layers, the
# schema version, a product with Config disabled (D-08), the compiled-default fallback, and the
# state before configure().

const S := preload("res://tests/config/support.gd")


func run(t: PKeyTestContext) -> void:
	await _values(t)
	await _list(t)
	await _secrets(t)
	await _disabled(t)
	await _before_configure(t)


func _values(t: PKeyTestContext) -> void:
	var sdk: Node = await S.sdk_with({
		"quality.floor": S.entry("enforced", "flac"),
		"run.concurrency": S.entry("default", 4),
		"tuning": S.entry("default", {"easy": [1, 2]}),
	})
	var cfg: PKeyConfig = sdk.config
	cfg.set_override_store(PKeyOverrideStore.new({"quality.floor": "mp3", "local.only": "yes"}))
	cfg.env = S.env_from({"PKEY_CONFIG_quality__floor": "wav", "PKEY_CONFIG_run__concurrency": "16"})
	t.check("client: enforced wins over a local and an env value", cfg.get_value("quality.floor", "x") == "flac" and cfg.get_source("quality.floor") == &"enforced")
	t.check("client: env beats remote default", S.same(cfg.get_value("run.concurrency", 1), 16) and cfg.get_source("run.concurrency") == &"env")
	t.check("client: a key only the store has resolves locally", cfg.get_value("local.only") == "yes" and cfg.get_source("local.only") == &"local")
	t.check("client: the caller's fallback when nothing resolves", cfg.get_value("missing", 99) == 99 and cfg.get_value("missing") == null and cfg.get_source("missing") == &"fallback")
	var v: Dictionary = cfg.get_value("tuning")
	v["easy"].append(3)
	t.check("client: containers are copies (the document is not mutated)", cfg.get_value("tuning") == {"easy": [1, 2]})
	t.check("client: schema_version from the document", cfg.schema_version() == 2)
	t.check("client: enabled() follows the capability map", cfg.enabled())
	# The compiled mirror's default stands in for a missing fallback, and only then.
	cfg.set_compiled_catalog({"CATALOG_VERSION": 3, "ENTRIES": [{"key": "dice.animSpeed", "kind": "config", "accessor": "dice.animSpeed"}], "DEFAULTS": {"dice.animSpeed": 1.25}})
	t.check("client: no fallback uses the compiled default", cfg.get_value("dice.animSpeed") == 1.25 and cfg.get_source("dice.animSpeed") == &"fallback")
	t.check("client: the caller's fallback beats the compiled default", cfg.get_value("dice.animSpeed", 2.0) == 2.0)
	t.check("client: the compiled catalog backs catalog()", cfg.catalog().get("schemaVersion") == 3 and cfg.catalog_entry("dice.animSpeed").get("accessor") == "dice.animSpeed")
	sdk.queue_free()


func _list(t: PKeyTestContext) -> void:
	var sdk: Node = await S.sdk_with({
		"run.concurrency": S.entry("default", 4),
		"quality.floor": S.entry("enforced", "flac"),
		"secret.knob": S.entry("hidden", "locked"),
	})
	var cfg: PKeyConfig = sdk.config
	cfg.set_override_store(PKeyOverrideStore.new({"run.concurrency": 9, "quality.floor": "mp3"}))
	var list := cfg.list_user_config()
	var keys := list.map(func(e: PKeyConfigEntry) -> String: return e.key)
	t.check("client: list_user_config drops hidden keys", keys == ["run.concurrency", "quality.floor"], str(keys))
	var by := {}
	for e in list:
		by[e.key] = e
	t.check("client: an enforced row is flagged at its remote value", by["quality.floor"].enforced and by["quality.floor"].value == "flac" and by["quality.floor"].source == &"enforced")
	t.check("client: an overridable row shows its effective value", not by["run.concurrency"].enforced and by["run.concurrency"].value == 9 and by["run.concurrency"].source == &"local")
	t.check("client: a hidden key is still applied", cfg.get_value("secret.knob", "x") == "locked")
	t.check("client: list rows are typed PKeyConfigEntry", list.get_typed_script() == PKeyConfigEntry)
	sdk.queue_free()


func _secrets(t: PKeyTestContext) -> void:
	var sdk: Node = await S.sdk_with(
		{"api.token": S.entry("default", "not-a-secret")},
		{"api.key": S.entry("enforced", "sk_live_123"), "num.key": S.entry("enforced", 12345)})
	var cfg: PKeyConfig = sdk.config
	cfg.set_override_store(PKeyOverrideStore.new({"api.key": "local-attempt"}))
	cfg.env = S.env_from({"PKEY_CONFIG_api__key": "env-attempt"})
	t.check("client: get_secret reads the secrets map, not the layers", cfg.get_secret("api.key") == "sk_live_123")
	t.check("client: a config key is not a secret", cfg.get_secret("api.token") == null)
	t.check("client: an absent secret is null", cfg.get_secret("nope") == null)
	t.check("client: a non-string secret is null", cfg.get_secret("num.key") == null)
	t.check("client: secrets are never listed", cfg.list_user_config().all(func(e): return e.key != "api.key"))
	sdk.queue_free()


func _disabled(t: PKeyTestContext) -> void:
	var sdk: Node = await S.sdk_with({}, {}, PackedStringArray(["license"]))
	var cfg: PKeyConfig = sdk.config
	t.check("client: Config disabled reports enabled() false", not cfg.enabled())
	t.check("client: Config disabled falls back everywhere", cfg.get_value("run.concurrency", 1) == 1 and cfg.get_source("run.concurrency") == &"fallback" \
			and cfg.list_user_config().is_empty() and cfg.get_secret("api.key") == null and cfg.schema_version() == null)
	cfg.set_override_store(PKeyOverrideStore.new({"run.concurrency": 8}))
	cfg.env = S.env_from({"PKEY_CONFIG_log__level": "debug"})
	t.check("client: Config disabled still honours local and env", cfg.get_value("run.concurrency", 1) == 8 and cfg.get_value("log.level", "info") == "debug")
	var fetched = await cfg.fetch_schema()
	var minted: PKeyMintResult = await cfg.mint_token("anything")
	t.check("client: Config disabled: no catalog fetch, no mint", fetched == null and minted.code == PKeyErrors.SERVICE_UNAVAILABLE and minted.kind == PKeyMintResult.KIND_REFUSED and sdk.core.transport.sent.is_empty())
	sdk.queue_free()


func _before_configure(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var cfg: PKeyConfig = sdk.config
	t.check("client: config exists before configure()", cfg != null and not cfg.enabled())
	t.check("client: reads fall back before configure()", cfg.get_value("k", 5) == 5 and cfg.get_source("k") == &"fallback" and cfg.get_secret("k") == null)
	var m: PKeyMintResult = await cfg.mint_token("x")
	t.check("client: mint before configure() is refused", m.code == PKeyErrors.NOT_CONFIGURED)
	t.check("client: fetch before configure() is null", (await cfg.fetch_schema()) == null)
	sdk.queue_free()
