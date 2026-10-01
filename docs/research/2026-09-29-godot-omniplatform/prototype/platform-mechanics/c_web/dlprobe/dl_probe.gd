class_name DlProbe
extends SceneTree
## S-05: does HTTPRequest.download_file keep the file when the body length is unknown?
## args: url [url ...]   (each downloaded to user://dl_<i>.bin)
var urls: PackedStringArray
var i := 0

func _initialize() -> void:
	urls = OS.get_cmdline_user_args()
	_next()

func _next() -> void:
	if i >= urls.size():
		quit()
		return
	var h := HTTPRequest.new()
	root.add_child(h)
	h.download_file = "user://dl_%d.bin" % i
	h.request_completed.connect(func(res, code, _hd, _b):
		var p := "user://dl_%d.bin" % i
		var sz := FileAccess.open(p, FileAccess.READ).get_length() if FileAccess.file_exists(p) else -1
		print("S05DL|%s|result=%d code=%d body_size=%d downloaded=%d file_exists=%s file_size=%d" % [urls[i], res, code, h.get_body_size(), h.get_downloaded_bytes(), FileAccess.file_exists(p), sz])
		h.queue_free()
		i += 1
		_next())
	h.request.call_deferred(urls[i])
