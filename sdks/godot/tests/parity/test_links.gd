extends RefCounted
# @pkey-feature crash.tags
# Crash tags (SDK parity §3.14): the release/environment/outlet tags W/services/distribution/
# sentry.ts maps. No portal URLs are built client-side (owner decision Q6): a server-supplied
# manageUrl (PX-W8) is the only portal link.

const S := preload("res://tests/license/support.gd")


func run(t: PKeyTestContext) -> void:
	var cold := PKeyTestFixtures.new_sdk()
	var tags: Dictionary = cold.crash_tags()
	t.check("crash tags: before configure() the build fallback still names the release", String(tags.get("release", "")).begins_with("app@") and tags.has("environment"), str(tags))
	cold.queue_free()

	var h := PKeyLicenseTestSupport.new()
	var sdk = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]))
	t.check("portal: no client-side builder (owner Q6)", sdk.get("portal") == null)
	var panel := PKeyActivationPanel.new()
	panel.sdk = sdk
	t.check("portal: Replace a device has no URL until the server supplies manageUrl", panel.manage_url == "")
	panel.free()
	tags = sdk.crash_tags()
	t.check("crash tags: release is app@<version> (no +0 in the editor)", tags["release"] == "app@%s" % h.F["version"], str(tags))
	t.check("crash tags: environment is the update channel", tags["environment"] == sdk.update.get_channel() and tags["environment"] != "")
	t.check("crash tags: no outlet tag when the outlet is unknown", not tags.has("pkey.outlet") or tags["pkey.outlet"] == sdk.core.reported_outlet())
	sdk.core.options.update_outlet = "steam"
	t.check("crash tags: the reported outlet rides as pkey.outlet", sdk.crash_tags().get("pkey.outlet") == "steam", str(sdk.crash_tags()))
	t.check("crash tags: a deliverable can be named", sdk.crash_tags("dlc.soundtrack")["release"].begins_with("dlc.soundtrack@"))
	# sentry.ts reads `<deliverable>@<version>[+<build>]`: a stamped build number rides after `+`.
	var stamp := PKeyBuildStamp.fallback(sdk.core.channel, sdk.core.product, "2.3.4")
	stamp["build"] = 57
	sdk.core.build_stamp = stamp
	t.check("crash tags: a stamped build is app@<version>+<build>", sdk.crash_tags()["release"] == "app@2.3.4+57", str(sdk.crash_tags()))
	sdk.core.build_stamp = null
	sdk.queue_free()
	h.free_server()
