extends RefCounted
# @pkey-feature ui.kit
# The model behind Paired devices (PKeyPairedDevicesModel) over a scripted `local_links`: the first
# read, Rename and Forget in the row and their store failures, where focus goes, the switches and the
# cap of eight, the gate, an unreadable record and the answers of the app's own connections.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_paired_devices

const Fake := preload("res://tests/support/fake_local_links.gd")


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _paired_devices(t)
	return true


static func _list_model(f) -> PKeyPairedDevicesModel:
	return PKeyPairedDevicesModel.new({"links": f})


func _paired_devices(t: PKeyTestContext) -> void:
	var f := Fake.new()
	f.links = [Fake.row("L1", "Device 1"), Fake.row("L2", "Device 2", null), Fake.row("L3", null)]
	var m := _list_model(f)
	t.check(
		"devices model: nothing is said before the first read",
		(
			m.snapshot()["step"] == "loading"
			and m.view()["state"] == "loading"
			and not m.view()["copy"].has("pairedDevices.empty")
		)
	)
	m.start()
	t.check(
		"devices model: the first read lists the rows",
		(
			m.view()["state"] == "list"
			and m.snapshot()["devices"].size() == 3
			and m.snapshot()["entryVisible"] == true
			and f.listeners() == 1
		)
	)
	t.check(
		"devices model: with every device on and 8 or fewer there is no switch column",
		not m.view()["copy"].has("pairedDevices.canConnect")
	)
	f.links.append(Fake.row("L4", "Device 4", 1, false))
	f.notify()
	(
		t
		. check(
			"devices model: a change elsewhere shows without a refresh, and a device off brings the column",
			m.snapshot()["devices"].size() == 4 and m.view()["copy"].has("pairedDevices.canConnect")
		)
	)
	m.start_rename("L2")
	t.check(
		"devices model: Rename works in the row, the field starting with the name held",
		(
			m.view()["state"] == "renaming"
			and m.snapshot()["draft"] == "Device 2"
			and m.view()["decisions"]["focus"] == "devices.renameLabel"
		)
	)
	m.set_draft("   ")
	m.save_rename()
	t.check(
		"devices model: a name that is empty once cleaned is refused with its text kept",
		(
			m.snapshot()["renameError"] == "empty"
			and m.snapshot()["draft"] == "   "
			and f.renamed.is_empty()
		)
	)
	m.set_draft("x".repeat(65))
	m.save_rename()
	t.check(
		"devices model: a name over 64 characters is refused",
		m.snapshot()["renameError"] == "long" and m.view()["args"]["max"] == 64
	)
	m.set_draft("Desk")
	f.rename_result = Fake.fail("storage-failed")
	m.save_rename()
	t.check(
		"devices model: a store that cannot keep it says so and the row stays open",
		(
			m.snapshot()["renameError"] == "failed"
			and m.view()["state"] == "renaming"
			and m.view()["copy"].has("devices.renameFailed")
		)
	)
	f.rename_result = Fake.fail("invalid-options", {"reason": "bad_input"})
	m.save_rename()
	t.check(
		"devices model: a name the SDK cleans to nothing is the empty line",
		m.snapshot()["renameError"] == "empty"
	)
	f.rename_result = null
	m.save_rename()
	t.check(
		"devices model: a kept name closes the row, focus back on its menu, the list re-read",
		(
			m.view()["state"] == "list"
			and f.renamed.back() == ["L2", "Desk"]
			and m.snapshot()["focus"] == {"kind": "row", "id": "L2"}
			and m.snapshot()["devices"][1]["label"] == "Desk"
		)
	)
	m.ask_forget("L2")
	t.check(
		"devices model: Forget asks inside the row",
		m.view()["state"] == "forgetting" and m.view()["decisions"]["focus"] == "common.cancel"
	)
	f.remove_result = Fake.fail("storage-failed")
	m.confirm_forget()
	t.check(
		"devices model: a store that cannot forget keeps the question, with the reason",
		m.snapshot()["forgetError"] == true and m.view()["copy"].has("pairedDevices.forgetFailed")
	)
	f.remove_result = null
	m.confirm_forget()
	t.check(
		"devices model: after a Forget focus moves to the next row",
		(
			m.view()["state"] == "list"
			and f.removed == ["L2", "L2"]
			and m.snapshot()["focus"] == {"kind": "row", "id": "L3"}
		)
	)
	m.ask_forget("L4")
	m.cancel_edit()
	t.check(
		"devices model: Cancel puts the row back",
		m.view()["state"] == "list" and m.snapshot()["focus"] == {"kind": "row", "id": "L4"}
	)
	m.ask_forget("L4")
	m.confirm_forget()
	m.ask_forget("L3")
	m.confirm_forget()
	m.ask_forget("L1")
	m.confirm_forget()
	t.check(
		"devices model: forgetting the last row moves focus to the title and says none yet",
		m.snapshot()["focus"] == {"kind": "title"} and m.view()["state"] == "empty"
	)
	# Rows that vanish while one is edited.
	f.links = [Fake.row("A", "A"), Fake.row("B", "B")]
	m.refresh()
	m.start_rename("A")
	f.links = [Fake.row("B", "B")]
	f.notify()
	t.check(
		"devices model: a row that went away while edited ends the edit",
		m.view()["state"] == "list" and not m.snapshot().has("target")
	)
	# The gate.
	f.gate = false
	f.notify()
	(
		t
		. check(
			"devices model: with the gate off only Rename and Forget remain, and the entry shows while a link is held",
			m.view()["state"] == "off" and m.snapshot()["entryVisible"] == true
		)
	)
	f.gate = true
	f.list_failure = true
	m.refresh()
	t.check(
		"devices model: an unreadable record is load-failed with Try again",
		m.view()["state"] == "load-failed" and m.snapshot()["entryVisible"] == false
	)
	f.list_failure = false
	m.refresh()
	t.check("devices model: Try again reads it again", m.view()["state"] == "list")
	# The switch.
	f.links = []
	for i in 9:
		f.links.append(Fake.row("D%d" % i, "D%d" % i, 1, i < 8))
	m.refresh()
	t.check(
		"devices model: eight on and more paired: the off switches wait",
		m.view()["copy"].has("pairedDevices.reachableFullTitle")
	)
	m.set_reachable("D8", true)
	t.check(
		"devices model: a ninth is refused by the SDK and the re-read puts the switch back",
		(
			f.reachable_calls.back() == ["D8", true]
			and m.snapshot()["devices"][8]["reachable"] == false
		)
	)
	m.set_reachable("D0", false)
	t.check(
		"devices model: turning one off leaves room",
		(
			m.snapshot()["devices"][0]["reachable"] == false
			and not m.view()["copy"].has("pairedDevices.reachableFullTitle")
		)
	)
	# The host's answers.
	m.report("D1", "busy")
	t.check(
		"devices model: the app's own connection's answer shows with the list",
		m.view()["copy"].has("pairedDevices.busyTitle") and m.view()["args"]["device"] == "D1"
	)
	m.report("D1", "")
	t.check("devices model: and clears", not m.view()["copy"].has("pairedDevices.busyTitle"))
	m.request_pair()
	t.check(
		"devices model: Pair with a Code is the host's to open", m.snapshot()["pairAnother"] == true
	)
	m.done()
	t.check(
		"devices model: Done unsubscribes and leaves",
		m.snapshot()["left"] == true and f.listeners() == 0
	)
