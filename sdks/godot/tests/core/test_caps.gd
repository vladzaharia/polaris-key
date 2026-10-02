extends RefCounted
# @pkey-feature core.caps
# PolarisKey.supports() and caps() (P1b-10, PARITY §2.2): the generated capability table, the
# reason order (unknown -> version, runtime, planned -> version, product, detectors), the
# product reason following discovery, and the detector-table validation.

const F := PKeyConstants.Feature
const R := PKeyConstants.UnsupportedReason


func run(t: PKeyTestContext) -> void:
	_table(t)
	_engine(t)
	await _discovery(t)
	_validation(t)


func _opts() -> PKeyOptions:
	var o := PKeyOptions.new()
	o.product = "djdl"
	o.version = "1.0.0"
	o.store = PKeyMemoryStore.new()
	o.build_stamp_path = ""
	return o


static func _is(r: PKeyResult, reason: String) -> bool:
	return not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail is Dictionary and r.detail.get("reason") == reason and String(r.detail.get("detail", "")) != "" and r.message == r.detail["detail"]


func _table(t: PKeyTestContext) -> void:
	var table := PKeyConstants.capabilities()
	t.check("caps: the table names this SDK and every registry feature", PKeyConstants.CAPABILITY_SDK == "godot" and table.keys() == PKeyConstants.FEATURE_VALUES.duplicate(), str(table.size()))
	t.check("caps: the table digest is generated", String(PKeyConstants.CAPABILITY_DIGEST).length() == 64)
	t.check("caps: a fresh Dictionary per call", PKeyConstants.capabilities() != null and not is_same(table, PKeyConstants.capabilities()))
	t.check("caps: this runtime is a manifest runtime", PKeyConstants.CAPABILITY_RUNTIMES.duplicate().has(PKeyCaps.detect_runtime()), PKeyCaps.detect_runtime())


func _engine(t: PKeyTestContext) -> void:
	var all_on := func() -> Dictionary: return PKeyDiscovery.services_where(func(_s): return true)
	var linux := PKeyCaps.new(all_on, "0.1.0", "linux")
	var web := PKeyCaps.new(all_on, "0.1.0", "web")
	var r := linux.supports(F.CONFIG_SECRET)
	t.check("caps: config.secret is supported off the web", r.ok and r.detail == {"feature": F.CONFIG_SECRET}, str(r))
	t.check("caps: license.enroll on web -> runtime", _is(web.supports(F.LICENSE_ENROLL), R.RUNTIME), str(web.supports(F.LICENSE_ENROLL)))
	t.check("caps: license.enroll off the web is supported", linux.supports(F.LICENSE_ENROLL).ok)
	t.check("caps: devices.fingerprint on web -> runtime", _is(web.supports(F.DEVICES_FINGERPRINT), R.RUNTIME))
	t.check("caps: supports_on asks as another runtime", _is(linux.supports_on(F.LICENSE_ENROLL, "web"), R.RUNTIME))
	for planned in [F.CORE_STORE, F.IDENTITY_OIDC, F.PACKS_RECORD]:
		t.check("caps: planned %s -> version" % planned, _is(linux.supports(planned), R.VERSION), str(linux.supports(planned)))
	var unknown := linux.supports("future.feature")
	t.check("caps: an unknown feature id -> version", _is(unknown, R.VERSION) and unknown.detail["feature"] == "future.feature", str(unknown))
	# A planned feature also unsupported on this runtime answers runtime first.
	t.check("caps: runtime wins over planned", _is(web.supports(F.PACKS_TRANSPORT_APPLE), R.RUNTIME))
	var want: Array = []
	for feature in PKeyConstants.capabilities():
		if linux.supports(feature).ok:
			want.append(feature)
	t.check("caps: caps() is the supported set in registry order", linux.caps() == want and want.has(F.CORE_VERIFY) and not want.has(F.CORE_STORE), str(linux.caps()))


func _discovery(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	# Before configure: the default capabilities (licence and config only).
	t.check("caps: before configure, update.decide -> product", _is(sdk.supports(F.UPDATE_DECIDE), R.PRODUCT), str(sdk.supports(F.UPDATE_DECIDE)))
	t.check("caps: before configure, config.resolve is supported", sdk.supports(F.CONFIG_RESOLVE).ok)
	var tr = PKeyTestFixtures.transcript("discovery-capabilities")
	var doc: Dictionary = tr["steps"][0]["exchanges"]["items"][0]["response"]["body"]
	var off := doc.duplicate(true)
	off["services"]["update"] = {"enabled": false}
	var on := doc.duplicate(true)
	on["services"]["update"] = {"enabled": true}
	var answers := [{"status": 200, "body": JSON.stringify(off)}]
	var server := PKeyTestFixtures.new_server(func(_r): return answers[0])
	var o := _opts()
	o.base_url = server.base_url()
	o.expected_services = PackedStringArray(["config", "update"])
	sdk.configure(o)
	await sdk.start()
	t.check("caps: expected_services enables update.decide before discovery", sdk.supports(F.UPDATE_DECIDE).ok)
	var d: PKeyResult = await sdk.discover()
	var r: PKeyResult = sdk.supports(F.UPDATE_DECIDE)
	t.check("caps: Update disabled in discovery -> product", d.ok and _is(r, R.PRODUCT) and r.detail["detail"].contains("update"), str(r))
	t.check("caps: caps() leaves out the disabled service's features", not sdk.caps().has(F.UPDATE_DECIDE) and sdk.caps().has(F.CORE_VERIFY))
	answers[0] = {"status": 200, "body": JSON.stringify(on)}
	d = await sdk.discover()
	t.check("caps: Update enabled in discovery -> supported", d.ok and sdk.supports(F.UPDATE_DECIDE).ok, str(sdk.supports(F.UPDATE_DECIDE)))
	t.check("caps: the real table and detectors agree", sdk.core.capability_engine().validate().is_empty(), str(sdk.core.capability_engine().validate()))
	server.queue_free()
	sdk.queue_free()


func _validation(t: PKeyTestContext) -> void:
	var fake := {
		"demo.driver": {"status": "implemented", "service": "update", "na": [{"runtime": "ios", "reason": "outlet"}]},
		"demo.store": {"status": "implemented", "service": "core", "na": [{"runtime": "linux", "reason": "dependency"}]},
		"demo.ui": {"status": "na", "service": "sdk", "na": [{"runtime": "linux", "reason": "runtime"}]},
	}
	var e := PKeyCaps.new(func() -> Dictionary: return PKeyDiscovery.services_where(func(_s): return true), "0.1.0", "linux")
	e.table = fake
	var problems := e.validate()
	t.check("caps: a conditional N/A here without a detector is a problem", problems.size() == 1 and problems[0].contains("demo.store"), str(problems))
	e.detectors = {"demo.store|dependency": func() -> String: return "", "demo.other|outlet": func() -> String: return "x"}
	problems = e.validate()
	t.check("caps: a detector naming no conditional N/A is a problem", problems.size() == 1 and problems[0].contains("demo.other"), str(problems))
	e.detectors = {"demo.store|dependency": func() -> String: return "the keyring is missing"}
	t.check("caps: detectors matching the table validate", e.validate().is_empty())
	var r := e.supports("demo.store")
	t.check("caps: a detector's detail -> its reason", _is(r, R.DEPENDENCY) and r.detail["detail"] == "the keyring is missing", str(r))
	e.detectors = {"demo.store|dependency": func() -> String: return ""}
	t.check("caps: an empty detector answer is supported", e.supports("demo.store").ok)
	t.check("caps: an na feature here -> its reason", _is(e.supports("demo.ui"), R.RUNTIME))
	t.check("caps: another runtime's conditional N/A is not consulted", e.supports("demo.driver").ok)
