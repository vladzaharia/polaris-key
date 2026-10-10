extends SceneTree
## The exit-leak probe (suite_exit_leaks.gd runs it as `godot -s`): the SDK as a game uses it, then
## a quit. Godot reports leaked objects and resources still in use when it exits, in an editor or
## debug build; a game that boots Polaris Key must not cause either. The flows below are the ones
## that built reference cycles: configure and start, the drop-in boot with its gate, the update prompt,
## the persistent gate, the settings panel, a sign-in dialog begun and a sign-out.


func _initialize() -> void:
	_run()


func _run() -> void:
	var pk := root.get_node("PolarisKey")
	var o := PKeyOptions.new()
	o.product = "djdl"
	o.version = "1.0.0"
	o.base_url = "http://127.0.0.1:9"
	o.store = PKeyMemoryStore.new()
	o.request_timeout_seconds = 1.0
	o.persist_settings = false
	var configured: PKeyResult = pk.configure(o)
	print("PROBE configure ", configured.ok)
	var started: PKeyResult = await pk.start()
	print("PROBE start ", started.ok)
	# The drop-in boot, left waiting at its gate, with the gate kept for the session and then gone.
	pk.boot({"persistent_gate": true, "allow_offline": true, "sync_timeout_seconds": 2})
	for i in 30:
		await process_frame
	print("PROBE boot ", pk.boot_view != null)
	var layer: Node = pk.boot_view.get_parent() if pk.boot_view != null else null
	if layer != null:
		layer.queue_free()
	await process_frame
	# An update prompt and the settings panel on a live SDK.
	var prompt := PKeyUpdatePrompt.new()
	prompt.sdk = pk
	root.add_child(prompt)
	var settings := PKeySettingsPanel.new()
	settings.sdk = pk
	root.add_child(settings)
	var dialog := PKeySignInDialog.new()
	dialog.sdk = pk
	root.add_child(dialog)
	for i in 10:
		await process_frame
	for n in [prompt, settings, dialog]:
		n.queue_free()
	await process_frame
	await pk.identity.sign_out()
	await process_frame
	print("PROBE done")
	quit()
