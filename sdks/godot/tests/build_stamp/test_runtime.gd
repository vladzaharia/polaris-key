extends RefCounted
# PolarisKey.build_info() and the pkey_* feature tags on THIS target. In the editor there is no
# stamp: the fallback carries the setup dock's editor channel (the harness res://polaris_key.tres
# says `dev`) and no outlet, and no pkey_* tag exists. On a release template the pack is the one
# run_tests.sh exported with PKEY_BUILD_OUTLET=steam, PKEY_BUILD_CHANNEL=beta and
# PKEY_BUILD_NUMBER=42 over the "Conformance (Linux)" preset, so those values are asserted.

## The preset's polaris_key/outlet_ids (export_presets.cfg).
const PRESET_OUTLET_IDS := {"caskToken": "polaris-key-sdk", "itchGameId": "1000", "msixFamilyName": "PolarisKey.SDK_8wekyb3d8bbwe", "steamAppId": "480"}


func run(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var info: Dictionary = sdk.build_info()
	var version := str(ProjectSettings.get_setting("application/config/version", ""))
	t.info("build_info: %s" % JSON.stringify(info, "", true))
	t.check("build_info: pkeyBuild 1", info.get("pkeyBuild") == 1)
	t.check("build_info: the version is application/config/version", info.get("version") == version and PKeySemver.is_valid(version), str(info.get("version")))
	if OS.has_feature("editor"):
		t.check("editor: no stamp in the project", not FileAccess.file_exists(PKeyBuildStamp.PATH))
		t.check("editor: the fallback has no outlet", info.get("outlet") == "" and info.get("outletIds") == {})
		t.check("editor: the fallback carries the dock's editor channel", info.get("channel") == "dev", str(info.get("channel")))
		t.check("editor: the fallback product is the dock's", info.get("product") == "pkey-harness")
		t.check("editor: build 0, this platform and arch", info.get("build") == 0 and info.get("platform") == PKeyHeaders.platform() and info.get("arch") == PKeyHeaders.arch())
		t.check("editor: no pkey_* feature tags", not OS.has_feature("pkey_outlet_steam") and not OS.has_feature("pkey_channel_beta"))
	else:
		var raw := FileAccess.get_file_as_string(PKeyBuildStamp.PATH)
		t.check("template: the stamp is in the pack", raw != "", PKeyBuildStamp.PATH)
		t.check("template: OS.has_feature(pkey_outlet_steam)", OS.has_feature("pkey_outlet_steam"))
		t.check("template: OS.has_feature(pkey_channel_beta)", OS.has_feature("pkey_channel_beta"))
		t.check("template: no other outlet tag", not OS.has_feature("pkey_outlet_direct"))
		t.check("template: build_info() returns the stamp", info == PKeyBuildStamp.read(), JSON.stringify(info))
		t.check("template: outlet steam, channel beta, build 42", info.get("outlet") == "steam" and info.get("channel") == "beta" and info.get("build") == 42)
		t.check("template: the preset's outlet ids, unchanged", info.get("outletIds") == PRESET_OUTLET_IDS, JSON.stringify(info.get("outletIds")))
		t.check("template: the preset's platform and arch", info.get("platform") == "linux" and info.get("arch") == "x86_64")
		t.check("template: the product from res://polaris_key.tres", info.get("product") == "pkey-harness")
		t.check("template: no timestamp in the stamp", not raw.to_lower().contains("time") and not raw.contains("At\""))
		t.check("template: the stamp's bytes are the canonical encoding", PKeyBuildStamp.read() is Dictionary and raw.to_utf8_buffer() == PKeyBuildStamp.encode(PKeyBuildStamp.read()))
		# A configured core sends the stamped channel even over default_channel.
		var o := PKeyOptions.new()
		o.product = "pkey-harness"
		o.local_only = true
		o.store = PKeyMemoryStore.new()
		o.default_channel = "dev"
		var r: PKeyResult = sdk.configure(o)
		t.check("template: the core sends the stamped channel", r.ok and sdk.core.channel == "beta" and sdk.core.outlet() == "steam", r.message)
	sdk.queue_free()
