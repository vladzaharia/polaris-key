extends RefCounted
# `pkey sdk --lang godot --write` (SDK parity pass §3.19, SP-02): tests/sdk_config/polaris_key.tres
# is the text resource the CLI writes into a project that has none, committed and pinned to the
# renderer by packages/cli/test/sdkConfig.test.ts. It loads as a PKeyOptions carrying the product
# facts; every other field keeps its default (the CLI leaves a dock-written file's other
# properties alone, which that suite checks on the text).

const SAMPLE := "res://tests/sdk_config/polaris_key.tres"


func run(t: PKeyTestContext) -> void:
	var opts = ResourceLoader.load(SAMPLE, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not t.check("sdk config: the generated resource loads as PKeyOptions", opts is PKeyOptions):
		return
	t.check("sdk config: product and base URL", opts.product == "acme" and opts.base_url == "https://key.plrs.im")
	t.check("sdk config: trust pins", opts.pinned_trust_keys == {"pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"})
	t.check("sdk config: release keys", opts.pinned_release_keys == {"acme-release-2026": "Z6FCkd1K7Om4lxUk4og_J0m73saH4BrrLk8igXzwcJM"})
	t.check("sdk config: expected services", opts.expected_services == PackedStringArray(["license", "config", "release", "update"]))
	var fresh := PKeyOptions.new()
	t.check("sdk config: every other field is the default", opts.default_channel == fresh.default_channel and opts.version == fresh.version and opts.local_only == fresh.local_only and opts.ui_branding == fresh.ui_branding)
