@tool
class_name PKeyPeerPump
extends RefCounted
## The frame-driven poller of the Cloud Connect links, and the place Noise work leaves the main
## thread (CC-14.10a, D-2).
##
## Polling. A pump polls every link added to it once a frame (`SceneTree.process_frame`), without
## blocking: a link reads its pipe, cuts frames, feeds its session and runs its deadlines. A link
## that answers false from `poll()` is finished and is let go. The pump listens to the tree only while
## it holds a link. `poll_once()` does one round by hand (tests, and hosts with no tree).
##
## Offloading. `offload(work)` is the session's `offload` option: a coroutine that runs `work` (a
## Callable that touches only what it was handed) as a `WorkerThreadPool` task and answers its
## result. At most MAX_TASKS tasks run at once, so a burst of unauthenticated sockets (32 are
## allowed) cannot take every core; the rest wait for a slot, a frame at a time. Without threads
## (a web export, or `threads` false) `work` runs inline on the calling thread. The result is read
## after the task completes, on the calling thread; nothing a task does is shared with the main
## thread while it runs (the session is busy, see PKeyPeerSession).
##
## What a session's steps cost: a handshake is about 21 ms of X25519 ladders in a release build and
## 35 ms in the editor (CC-13); JWS checks and the AEAD of the transport run on the calling thread.

const MAX_TASKS := 2

## The number of tasks running now and the most that ever ran together (a test reads them).
var in_flight := 0
var peak_in_flight := 0
## `OS.get_thread_caller_id()` of the thread the last task ran on; 0 before one ran.
var last_thread := 0
## How many tasks ran, and how many ran inline.
var tasks_run := 0
var inline_run := 0

var _tree: SceneTree
var _threads: bool
var _links: Array[PKeyPeerLink] = []
var _listening := false


## `tree` null: the running main loop, when it is a SceneTree. `threads` false forces the inline mode.
func _init(tree: SceneTree = null, threads := true) -> void:
	_tree = tree if tree != null else (Engine.get_main_loop() as SceneTree)
	_threads = threads and OS.has_feature("threads")


func _to_string() -> String:
	return "PKeyPeerPump()"


## True when tasks leave the main thread.
func uses_threads() -> bool:
	return _threads and _tree != null


## Starts polling `link` every frame, until it is finished.
func add(link: PKeyPeerLink) -> void:
	if _links.has(link):
		return
	_links.append(link)
	_listen()


func remove(link: PKeyPeerLink) -> void:
	_links.erase(link)
	if _links.is_empty():
		_unlisten()


func count() -> int:
	return _links.size()


## One round: every link polled once; the finished ones are let go.
func poll_once() -> void:
	for link in _links.duplicate():
		if not link.poll():
			_links.erase(link)
	if _links.is_empty():
		_unlisten()


## Runs `work` off the main thread (inline without threads) and answers its result. A coroutine.
func offload(work: Callable) -> Variant:
	if not uses_threads():
		inline_run += 1
		return work.call()
	while in_flight >= MAX_TASKS:
		await _tree.process_frame
	in_flight += 1
	peak_in_flight = maxi(peak_in_flight, in_flight)
	var box: Array = []
	var id := WorkerThreadPool.add_task(func() -> void: box.append([work.call(), OS.get_thread_caller_id()]), false, "PolarisKey peer")
	while not WorkerThreadPool.is_task_completed(id):
		await _tree.process_frame
	WorkerThreadPool.wait_for_task_completion(id)
	in_flight -= 1
	tasks_run += 1
	if box.is_empty():
		return null
	last_thread = box[0][1]
	return box[0][0]


func _listen() -> void:
	if _listening or _tree == null:
		return
	_listening = true
	_tree.process_frame.connect(poll_once)


func _unlisten() -> void:
	if not _listening or _tree == null:
		return
	_listening = false
	if _tree.process_frame.is_connected(poll_once):
		_tree.process_frame.disconnect(poll_once)
