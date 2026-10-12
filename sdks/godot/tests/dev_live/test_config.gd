extends RefCounted
# @pkey-feature core.sync
# A change event from the live server: a device holding the `ok` key reads a config value, the
# server's control surface changes it (`POST /__dev/config`, what `pkey dev config` calls), and
# the next sync delivers the new signed config document, so PolarisKey.config emits one
# `config_changed` naming the key and the value is the server's, enforced. A second sync that
# changes nothing emits nothing.
#
# The server signs documents in whole seconds and one signed in the same second as the last is not
# newer, so a second passes between the activation's document and the change. The value is set on
# the `ok` key alone (`key` names the test key), and it is whichever of two the document does not
# hold, so a rerun on the same server still changes something.

const KEY := "render.quality"
const VALUES := ["high", "standard"]


func run(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	var sdk: Node = await bed.sdk("key")
	if not t.check("config: the SDK is configured from the quickstart", bed.last_configure.ok, str(bed.last_configure)):
		bed.drop(sdk)
		return
	var activated: PKeyActivationResult = await sdk.license.activate_with_key(bed.key("ok"))
	if not t.check("config: the ok key activates", activated.ok, str(activated)):
		bed.drop(sdk)
		return
	t.check("config: the activation's sync applied a config document", sdk.core.cache.config != null)

	var held = sdk.config.get_value(KEY)
	var target: String = VALUES[0] if held != VALUES[0] else VALUES[1]
	var events := []
	sdk.config.config_changed.connect(func(keys: PackedStringArray) -> void: events.append(Array(keys)))

	await PKeyDevLive.pause(1.1)
	var posted := await bed.control("config", {"name": KEY, "value": target, "key": "ok"})
	t.check("config: the server accepts the change", posted["status"] == 200 and posted["body"] is Dictionary and posted["body"].get("ok") == true, str(posted))

	var synced: PKeySyncResult = await sdk.sync(true)
	t.check("config: the next sync applies the new config document", synced.ok and synced.documents.get("config") == "applied", str(synced.documents))
	t.check("config: config_changed fires once and names the key", events.size() == 1 and events[0] == [KEY], str(events))
	t.check("config: the value is the server's and the source is enforced", sdk.config.get_value(KEY) == target and sdk.config.get_source(KEY) == &"enforced", "%s from %s" % [sdk.config.get_value(KEY), sdk.config.get_source(KEY)])

	events.clear()
	await sdk.sync(true)
	t.check("config: a sync that changes nothing emits nothing", events.is_empty(), str(events))
	bed.drop(sdk)
