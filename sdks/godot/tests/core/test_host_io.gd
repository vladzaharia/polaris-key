extends RefCounted
# `PKeyHostIo.run` is bounded (CC-14 follow-up, the bounded host-process helper): a command that
# prints is read, a non-zero exit and a missing program are null, a child that never exits is killed at
# the time limit and costs no more, a child that prints too much is killed, and a chatty child (more
# than a pipe holds, on both pipes) does not block. The never-exiting child is `sleep` (ping on
# Windows); the others are `sh` or `cmd` one-liners. Mobile and web run no commands: those hosts check
# only that nothing runs.


func run(t: PKeyTestContext) -> void:
	var io := PKeyHostIo.new()
	if not OS.has_feature("pc"):
		t.check("host io: a mobile or web host runs nothing", io.run("echo", PackedStringArray(["x"])) == null and io.last_outcome == &"unavailable")
		return
	var windows := OS.get_name() == "Windows"
	t.info("host io: pipes are %s on this engine" % ("bounded" if PKeyHostIo._bounded_pipes() else "unbounded (OS.execute)"))
	_defaults(t, io)
	_prints(t, io, windows)
	_fails(t, io, windows)
	if not PKeyHostIo._bounded_pipes():
		t.info("host io: the time limit needs Godot 4.5; the unbounded OS.execute runs here")
		return
	_never_exits(t, io, windows)
	_too_much(t, io, windows)
	_chatty(t, io, windows)
	_many(t, windows)


func _defaults(t: PKeyTestContext, io: PKeyHostIo) -> void:
	var limit := io._limit()
	var want := PKeyHostIo.WINDOWS_TIMEOUT_MSEC if PKeyHeaders.update_platform() == "windows" else PKeyHostIo.TIMEOUT_MSEC
	t.check("host io: the default limit is 30 s on Windows and 10 s elsewhere", limit == want, str(limit))
	io.timeout_msec = 123
	t.check("host io: a test can set the limit", io._limit() == 123)
	io.timeout_msec = 0


func _shell(windows: bool) -> String:
	return "cmd.exe" if windows else "/bin/sh"


func _script(windows: bool, text: String) -> PackedStringArray:
	return PackedStringArray(["/d", "/c", text] if windows else ["-c", text])


func _prints(t: PKeyTestContext, io: PKeyHostIo, windows: bool) -> void:
	var out: Variant = io.run(_shell(windows), _script(windows, "echo hi"))
	t.check("host io: a command's stdout is returned", out is String and (out as String).strip_edges() == "hi" and io.last_outcome == &"", str(out))
	out = io.run(_shell(windows), _script(windows, "echo café" if not windows else "exit 0"))
	t.check("host io: and decoded as UTF-8", out is String and (not windows and (out as String).strip_edges() == "café" or windows))
	# A successful command that prints nothing is an empty string, as OS.execute answered.
	out = io.run(_shell(windows), _script(windows, "exit 0"))
	t.check("host io: a command with no output is an empty string", out is String and (out as String).is_empty() and io.last_outcome == &"", str(out))


func _fails(t: PKeyTestContext, io: PKeyHostIo, windows: bool) -> void:
	var out: Variant = io.run(_shell(windows), _script(windows, "exit 3"))
	t.check("host io: a non-zero exit is null", out == null and io.last_outcome == &"exit")
	out = io.run("pkey-no-such-program-" + str(Time.get_ticks_usec()), PackedStringArray())
	t.check("host io: a program that is not there is null", out == null and (io.last_outcome == &"exit" or io.last_outcome == &"start"), str(io.last_outcome))


func _never_exits(t: PKeyTestContext, io: PKeyHostIo, windows: bool) -> void:
	io.timeout_msec = 600
	var started := Time.get_ticks_msec()
	# A child that would run for a minute: sleep, or ping with sixty echoes a second apart.
	var out: Variant = io.run("ping.exe" if windows else "sleep", PackedStringArray(["-n", "60", "127.0.0.1"] if windows else ["60"]))
	var took := Time.get_ticks_msec() - started
	t.check("host io: a child that never exits is null, outcome timeout", out == null and io.last_outcome == &"timeout", str(io.last_outcome))
	t.check("host io: it costs the limit and not much more", took >= 600 and took < 5000, "%d ms" % took)
	# And a child that exits first is not delayed to the limit.
	io.timeout_msec = 20000
	started = Time.get_ticks_msec()
	var quick: Variant = io.run(_shell(windows), _script(windows, "echo ok"))
	t.check("host io: a quick child returns at once, not at the limit", quick is String and Time.get_ticks_msec() - started < 10000)
	io.timeout_msec = 0


func _too_much(t: PKeyTestContext, io: PKeyHostIo, windows: bool) -> void:
	if windows:
		t.info("host io: the output cap is checked on Unix hosts")
		return
	io.timeout_msec = 20000
	var out: Variant = io.run("/bin/sh", PackedStringArray(["-c", "yes | head -c 6000000; sleep 20"]))
	t.check("host io: a child that prints past the cap is killed and null", out == null and io.last_outcome == &"output", str(io.last_outcome))
	io.timeout_msec = 0


func _chatty(t: PKeyTestContext, io: PKeyHostIo, windows: bool) -> void:
	if windows:
		return
	# 300 KB on stderr and 300 KB on stdout: neither pipe is allowed to fill and stop the child.
	io.timeout_msec = 20000
	var out: Variant = io.run("/bin/sh", PackedStringArray(["-c", "head -c 300000 /dev/zero | tr '\\0' 'e' >&2; head -c 300000 /dev/zero | tr '\\0' 'x'"]))
	t.check("host io: a child that fills both pipes still finishes", out is String and (out as String).length() == 300000 and io.last_outcome == &"", str(io.last_outcome))
	io.timeout_msec = 0


func _many(t: PKeyTestContext, windows: bool) -> void:
	# From a worker thread, as PKeyFingerprint.capture calls it, and four at once.
	# One box a task, so no two threads write the same Array.
	var boxes: Array = []
	var ids: Array[int] = []
	for i in 4:
		var box: Array = []
		boxes.append(box)
		var one := PKeyHostIo.new()
		ids.append(WorkerThreadPool.add_task(func() -> void: box.append(one.run(_shell(windows), _script(windows, "echo n%d" % i))), false, "host io test"))
	for id in ids:
		WorkerThreadPool.wait_for_task_completion(id)
	var texts := boxes.map(func(b: Array) -> String: return str(b[0]).strip_edges() if not b.is_empty() else "")
	texts.sort()
	t.check("host io: four commands from worker threads at once all answer", texts == ["n0", "n1", "n2", "n3"], str(texts))
	t.check("host io: the shared capability check ran once", PKeyHostIo._pipes_checked)
