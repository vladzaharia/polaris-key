extends RefCounted
# `pkey sdk --lang godot --write` (SDK parity pass §3.19, SP-02): tests/sdk_config/
# polaris_key_config.gd is the script the CLI writes, committed and pinned to the renderer by
# packages/cli/test/sdkConfig.test.ts. It loads, and options() / apply() fill PKeyOptions with the
# product facts while leaving every other field alone.

const SAMPLE := "res://tests/sdk_config/polaris_key_config.gd"


func run(t: PKeyTestContext) -> void:
	var script = load(SAMPLE)
	if not t.check("sdk config: the generated script loads", script is GDScript and script.can_instantiate()):
		return
	var opts: PKeyOptions = script.options()
	t.check("sdk config: product and base URL", opts.product == "acme" and opts.base_url == "https://key.plrs.im")
	t.check("sdk config: trust pins", opts.pinned_trust_keys == {"pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"})
	t.check("sdk config: release keys", opts.pinned_release_keys == {"acme-release-2026": "Z6FCkd1K7Om4lxUk4og_J0m73saH4BrrLk8igXzwcJM"})
	t.check("sdk config: expected services", opts.expected_services == PackedStringArray(["license", "config", "release", "update"]))
	var mine := PKeyOptions.new()
	mine.default_channel = "beta"
	mine.version = "2.0.0"
	script.apply(mine)
	t.check("sdk config: apply leaves the game's own fields", mine.default_channel == "beta" and mine.version == "2.0.0" and mine.product == "acme")
	opts.pinned_trust_keys["x"] = "y"
	t.check("sdk config: the constants are copied, not shared", not script.options().pinned_trust_keys.has("x"))
