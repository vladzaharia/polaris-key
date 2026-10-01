extends RefCounted
## Shared helpers for the config groups.
##
## Most groups need a verified config document carrying particular states. The SDK has no signer
## (every signed fixture comes from a generator-owned mirror), so `inject` places a document in
## the verified-cache slot that `PKeyCache.load_record` / `apply_config` fill after verification;
## the changed group and the transcripts drive the same slot through real signed documents.

const NOW := 1700000000


static func entry(state: String, value: Variant) -> Dictionary:
	return {"state": state, "value": value, "updatedAt": NOW}


## An environment layer that is on and reads only `table` and `args`.
static func env_from(table: Dictionary, args := PackedStringArray(), prefix := "PKEY_CONFIG_") -> PKeyConfigEnv:
	var e := PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_ALWAYS, prefix, true, "linux", args)
	e.reader = func(name: String) -> Variant: return table.get(name)
	return e


static func options(services := PackedStringArray()) -> PKeyOptions:
	var o := PKeyOptions.new()
	o.product = "djdl"
	o.version = "1.0.0"
	o.local_only = true
	o.store = PKeyMemoryStore.new("", "pkeyt_cached")
	o.expected_services = services
	return o


## A started SDK whose verified config document holds `config` and `secrets`, with an empty
## environment layer. Free it with `queue_free()`.
static func sdk_with(config: Dictionary, secrets: Dictionary = {}, services := PackedStringArray()) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(options(services))
	await sdk.start()
	sdk.config.env = env_from({})
	if not config.is_empty() or not secrets.is_empty():
		inject(sdk, config, secrets)
	return sdk


static func inject(sdk: Node, config: Dictionary, secrets: Dictionary = {}, schema_version := 2) -> void:
	sdk.core.cache.config = {"jws": "", "doc": {
		"iss": PKeyClaims.ISSUER, "aud": "djdl", "deviceId": sdk.core.device_id,
		"issuedAt": NOW, "expiresAt": NOW + 3600, "graceUntil": NOW + 86400,
		"schemaVersion": schema_version, "config": config, "secrets": secrets,
	}}
	sdk.config.refresh()


## JSON equality (PKeyConfig._same): numbers by value, containers deeply.
static func same(a: Variant, b: Variant) -> bool:
	return PKeyConfig._same(a, b)
