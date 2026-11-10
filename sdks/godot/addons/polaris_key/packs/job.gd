class_name PKeyPackJob
extends RefCounted
## Run one blocking pack step (a whole-pack SHA-256, a directory check, a rebuild that touches no
## engine state) off the main thread: a WorkerThreadPool task where the build has threads, polled
## once per frame, else inline. Bundle-sized verifies never stall the frame that draws the boot
## screen (S-04). The callable must not touch the SceneTree, mount packs or iterate a const Array.
##
##   var digest = await PKeyPackJob.run(func(): return PKeyByteSource.sha256(src), "pack hash")

## The jobs started and not yet collected, in the whole process. A host that quits (the test runner)
## waits for it to reach zero: a worker task alive at exit crashes the teardown of some engine builds.
static var pending := 0

var _work: Callable
var result: Variant = null


func _init(work: Callable) -> void:
	_work = work


func _run() -> void:
	result = _work.call()


## Whether blocking pack work leaves the main thread here.
static func threaded() -> bool:
	return OS.has_feature("threads") and Engine.get_main_loop() is SceneTree


## Run `work` and return its result. A coroutine.
static func run(work: Callable, label := "PolarisKey pack") -> Variant:
	var job := PKeyPackJob.new(work)
	var tree := Engine.get_main_loop() as SceneTree
	if not threaded() or tree == null:
		job._run()
		return job.result
	pending += 1
	var id := WorkerThreadPool.add_task(job._run, false, label)
	while not WorkerThreadPool.is_task_completed(id):
		await tree.process_frame
	WorkerThreadPool.wait_for_task_completion(id)
	pending -= 1
	return job.result
