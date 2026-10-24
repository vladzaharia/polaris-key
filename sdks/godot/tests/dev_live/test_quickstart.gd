extends RefCounted
# @pkey-feature license.activate core.discover
# The quickstart against the live server: the polaris_key.tres that `pkey sdk --lang godot
# --dev --write` generated is this server's (its product, origin, trust pins, release keys and
# services), PolarisKey.configure() accepts its options, the SDK discovers the product over
# HTTP, and the first activation with the `ok` test key stores a token and opens the gate on a
# license document the SDK verified against the generated pins.


func run(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	_config(t, bed)
	await _first_activation(t, bed)


func _config(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	var c := bed.config
	var info := bed.info
	var trust: Dictionary = info.get("trust", {})
	t.check("config: the file names the server's product", c.product_slug == info.get("product") and c.product_slug != "", "%s vs %s" % [c.product_slug, info.get("product")])
	t.check("config: base_url is the origin the lane started, which is the server's own", c.base_url == bed.base_url and info.get("baseUrl") == bed.base_url, "%s, %s, %s" % [c.base_url, bed.base_url, info.get("baseUrl")])
	t.check("config: pinned_keys are the server's signing pins", PKeyDevLive.same_pairs(c.pinned_keys, trust.get("pinnedKeys")), "%s vs %s" % [c.pinned_keys, trust.get("pinnedKeys")])
	t.check("config: pinned_release_keys are the server's release keys", PKeyDevLive.same_pairs(c.pinned_release_keys, info.get("releaseKeys")), "%s vs %s" % [c.pinned_release_keys, info.get("releaseKeys")])
	t.check("config: expected_services are the services the server runs", PKeyDevLive.same_set(c.expected_services, info.get("services")), "%s vs %s" % [c.expected_services, info.get("services")])
	var opts := bed.options()
	t.check("config: options is a PKeyOptions carrying the product, the origin and both pin sets", opts != null and opts.product_slug == c.product_slug and opts.base_url == bed.base_url \
			and PKeyDevLive.same_pairs(opts.pinned_keys, trust.get("pinnedKeys")) and PKeyDevLive.same_pairs(opts.pinned_release_keys, info.get("releaseKeys")) \
			and PKeyDevLive.same_set(opts.expected_services, info.get("services")))


func _first_activation(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	var sdk: Node = await bed.sdk("key")
	if not t.check("quickstart: configure() accepts the generated options", bed.last_configure.ok, str(bed.last_configure)):
		bed.drop(sdk)
		return
	t.check("quickstart: before activation the gate asks for one", sdk.status().get("status") == "needs-activation" and not sdk.is_licensed() and sdk.license.activation() == &"")

	var found: PKeyResult = await sdk.discover()
	t.check("quickstart: discovery over HTTP answers", found.ok, str(found))
	var enabled := []
	for slug in sdk.capabilities():
		if sdk.capabilities()[slug].get("enabled") == true:
			enabled.append(slug)
	t.check("quickstart: the capability map is the server's service list", PKeyDevLive.same_set(enabled, bed.info.get("services")), "%s vs %s" % [enabled, bed.info.get("services")])

	var result: PKeyActivationResult = await sdk.license.activate_with_key(bed.key("ok"))
	if not t.check("first activation: the ok test key activates", result.ok and result.kind == PKeyActivationResult.KIND_OK, str(result)):
		bed.drop(sdk)
		return
	t.check("first activation: the device token is held and stored", result.stored and sdk.core.tokens.has_token() and sdk.license.activation() == &"token" and String(sdk.core.store.token).begins_with("pkeyt_"))
	t.check("first activation: the license document verified against the generated pins", sdk.core.cache.license != null and sdk.license.get_license_id() != "", str(sdk.core.sync_state().get("doc")))
	t.check("first activation: the gate is open", sdk.is_licensed() and sdk.status().get("status") == "ok", str(sdk.status()))
	t.check("first activation: the sync that came with it fetched the config document", sdk.core.cache.config != null)

	# A dev run never reaches production: every request went to the dev server, and the SDK's
	# persistent state would sit under the dev host's own name, never the bare product's.
	var strays: Array = sdk.core.transport.sent.filter(func(r: Dictionary) -> bool: return not String(r["url"]).begins_with(bed.base_url + "/"))
	t.check("first activation: every request the SDK sent went to the dev server", not sdk.core.transport.sent.is_empty() and strays.is_empty(), str(strays))
	t.check("first activation: the SDK's state is namespaced by the dev host, not the production product", sdk.core.storage_namespace == PKeyCore.store_namespace_for(sdk.core.product, bed.base_url) \
			and sdk.core.storage_namespace != sdk.core.product and sdk.core.storage_namespace.begins_with(sdk.core.product + "@"), sdk.core.storage_namespace)

	# The device keeps its seat: a key entry is counted for every seat a key claims, so freeing it
	# here would make the next group's activation a second entry on a licence that allows three.
	bed.drop(sdk)
