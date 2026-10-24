extends RefCounted
# The `event(kind, data)` stream (SP-35b.6): beside state_changed, store_error, the pack progress
# and update_available, with snake_case Dictionary payloads; nothing before configure(); no token
# or path in any payload. The config and updateAvailable kinds are asserted over real flows in
# config/test_local.gd and update/test_decide.gd.


func run(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var events: Array = []
	sdk.event.connect(func(k, d): events.append([k, d]))
	sdk.update.packs.pack_phase.emit({"pack": "p", "phase": "download", "done": 1, "total": 2})
	sdk._emit_state()
	t.check("events: none before configure", events.is_empty(), str(events))

	var o := PKeyOptions.new()
	o.product_slug = "djdl"
	o.version = "1.0.0"
	o.store = PKeyMemoryStore.new()
	o.build_stamp_path = ""
	t.check("events: configure ok", sdk.configure(o).ok)

	var states: Array = []
	sdk.state_changed.connect(func(s): states.append(s))
	sdk._last_state = {"status": "active"}
	sdk._emit_state()
	t.check("events: license beside state_changed", states.size() == 1 and events == [[PKeyConstants.EventKind.LICENSE, {"status": "needs-activation", "previous": "active"}]], str(events))
	events.clear()
	sdk._emit_state()
	t.check("events: no license event when the state did not change", events.is_empty(), str(events))

	var errs: Array = []
	sdk.store_error.connect(func(e): errs.append(e))
	sdk.core.store_error.emit({"op": "write", "path": "/secret/path/token", "error": 1, "message": "disk full"})
	t.check("events: store beside store_error, without the path", errs.size() == 1 and events == [[PKeyConstants.EventKind.STORE, {"reason": PKeyConstants.ErrorCode.STORE_FAILED, "detail": "disk full"}]], str(events))
	events.clear()

	sdk.update.packs._on_progress({"packId": "djdl.core", "phase": "apply", "done": 5, "total": 5})
	t.check("events: packs carries pack, phase, done, total", events == [[PKeyConstants.EventKind.PACKS, {"pack": "djdl.core", "phase": "apply", "done": 5, "total": 5}]], str(events))
	events.clear()

	sdk.update.update_available.emit(PKeyVersionCheck.new(true))
	t.check("events: a v3 check() answer raises no updateAvailable event", events.is_empty(), str(events))
	t.check("events: every kind used is a generated EventKind", PKeyConstants.EVENT_KIND_VALUES.has(PKeyConstants.EventKind.UPDATEAVAILABLE))
	sdk.queue_free()
