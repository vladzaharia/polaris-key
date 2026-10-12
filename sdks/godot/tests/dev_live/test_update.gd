extends RefCounted
# @pkey-feature update.decide release.record
# The update decision against the live server, with the signed feed and release record verified
# against the release key the generated config pinned. The install is a macOS `direct` build (the
# one platform `pkey dev` publishes for) stamped at the newest stable release the server holds:
#
#   before   decide() is `none`, up to date: nothing to show, so no `update_available`
#   after    the server publishes the next patch release on stable (`POST /__dev/release`, what
#            `pkey dev release` calls) and decide() is a `binary` offer of it by download, with
#            the record fetched and verified and `update_available` fired once
#
# The release cannot be taken back, so the newest stable release is read at the start and the next
# patch number published: a rerun on the same server starts from the release this run left.


func run(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	await bed.refresh_info()
	var installed := bed.latest_stable()
	var next := PKeyDevLive.next_patch(installed)
	if not t.check("update: the server holds a stable release for the build to be current on", installed != "" and next != "", str(bed.info.get("releases"))):
		return
	var stamp := bed.write_stamp(installed)
	if not t.check("update: the build stamp is written", stamp != ""):
		return

	var sdk: Node = await bed.sdk("key", func(opts: PKeyOptions) -> void:
		opts.version = installed
		opts.build_stamp_path = stamp)
	if not t.check("update: the SDK is configured from the quickstart", bed.last_configure.ok, str(bed.last_configure)):
		bed.drop(sdk)
		return
	var shown := []
	sdk.update.update_available.connect(func(c: PKeyResult) -> void: shown.append(c))

	var before: PKeyUpdateCheck = await sdk.update.decide()
	t.check("update: a build at %s, the newest stable release, is offered nothing" % installed, before.ok and before.action() == "none" and before.decision.get("reason") == "up-to-date", str(before))
	t.check("update: the decision is on the stable channel from the server's feed, with nothing wrong on the way", before.ok and before.channel == "stable" and before.feed == "network" and before.errors.is_empty(), str(before))
	t.check("update: nothing to show means no update_available", shown.is_empty(), str(shown.size()))

	var published := await bed.control("release", {"version": next, "channel": "stable"})
	t.check("update: the server publishes %s on stable" % next, published["status"] == 200 and published["body"] is Dictionary and published["body"].get("ok") == true, str(published))

	var after: PKeyUpdateCheck = await sdk.update.decide()
	var release: Dictionary = after.decision.get("release", {}) if after.ok else {}
	t.check("update: the same build is now offered %s by download" % next, after.ok and after.action() == "binary" and after.decision.get("method") == "download" and release.get("version") == next, str(after))
	t.check("update: the feed and the release record came from the server and verified, with nothing wrong on the way", after.ok and after.channel == "stable" and after.feed == "network" and after.record == "network" and after.errors.is_empty(), str(after))
	t.check("update: update_available fired once with that offer", shown.size() == 1 and shown[0] == after and after.boot == PKeyDecision.BOOT_OPTIONAL, str(shown.size()))
	bed.drop(sdk)
