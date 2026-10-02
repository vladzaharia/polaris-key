class_name PKeyByteSource
extends RefCounted
## A readable run of bytes of a known length (client-core `ByteSource`, plans/P4-01.md §2.13):
## bytes in memory, a file on disk, or a range of another source. `read(offset, length)` returns
## exactly `length` bytes, or fewer only at the end or on an I/O error (then `error` is set and
## the short read makes every hash check fail closed). Payloads stream through sources in
## READ_CHUNK steps rather than sitting whole in memory.
##
##   PKeyByteSource.memory(bytes)            PKeyByteSource.file(path, size = -1)
##   PKeyByteSource.slice(source, offset, size)
##   PKeyByteSource.read_all(source)         every byte (callers bound the size first)
##   PKeyByteSource.sha256(source)           lowercase hex SHA-256, read in chunks
##
## Reads never touch shared state, so a source may be read on a WorkerThreadPool task.

## The chunk every helper reads in: 1 MiB (a byte loop runs at about 30 MB/s; whole-buffer
## operations at native speed).
const READ_CHUNK := 1 << 20

const KIND_MEMORY := 0
const KIND_FILE := 1
const KIND_SLICE := 2

var size := 0
## The last I/O error (`Error`), OK when every read so far succeeded.
var error := OK
var _kind := KIND_MEMORY
var _bytes := PackedByteArray()
var _path := ""
var _base: PKeyByteSource = null
var _offset := 0


static func memory(bytes: PackedByteArray) -> PKeyByteSource:
	var s := PKeyByteSource.new()
	s._kind = KIND_MEMORY
	s._bytes = bytes
	s.size = bytes.size()
	return s


## A file on disk. `size < 0` reads its length now (`error` set when it cannot be opened).
static func file(path: String, p_size := -1) -> PKeyByteSource:
	var s := PKeyByteSource.new()
	s._kind = KIND_FILE
	s._path = path
	if p_size >= 0:
		s.size = p_size
	else:
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null:
			s.error = FileAccess.get_open_error()
			s.size = 0
		else:
			s.size = int(f.get_length())
			f.close()
	return s


static func slice(source: PKeyByteSource, offset: int, p_size: int) -> PKeyByteSource:
	var s := PKeyByteSource.new()
	s._kind = KIND_SLICE
	s._base = source
	s._offset = offset
	s.size = p_size
	return s


## The path behind a file source, or behind the file a slice reads ("" for memory).
func file_path() -> String:
	if _kind == KIND_FILE:
		return _path
	if _kind == KIND_SLICE and _base != null:
		return _base.file_path()
	return ""


## Where this source starts inside `file_path()` (0 for a whole file).
func file_offset() -> int:
	if _kind == KIND_SLICE and _base != null:
		return _offset + _base.file_offset()
	return 0


func read(offset: int, length: int) -> PackedByteArray:
	var n := mini(length, size - offset)
	if n <= 0 or offset < 0:
		return PackedByteArray()
	match _kind:
		KIND_MEMORY:
			return _bytes.slice(offset, offset + n)
		KIND_SLICE:
			var out := _base.read(_offset + offset, n)
			if _base.error != OK:
				error = _base.error
			return out
		_:
			var f := FileAccess.open(_path, FileAccess.READ)
			if f == null:
				error = FileAccess.get_open_error()
				return PackedByteArray()
			f.seek(offset)
			var out := f.get_buffer(n)
			var e := f.get_error()
			if out.size() != n and e != OK and e != ERR_FILE_EOF:
				error = e
			f.close()
			return out


## Every byte of a source, in one buffer. Only for objects the caller has bounded.
static func read_all(source: PKeyByteSource) -> PackedByteArray:
	if source == null:
		return PackedByteArray()
	if source._kind == KIND_MEMORY:
		return source._bytes
	var out := PackedByteArray()
	var at := 0
	while at < source.size:
		var chunk := source.read(at, mini(READ_CHUNK, source.size - at))
		if chunk.is_empty():
			break
		out.append_array(chunk)
		at += chunk.size()
	return out


## The SHA-256 of a whole source, read in chunks.
static func sha256(source: PKeyByteSource) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	var at := 0
	while at < source.size:
		var chunk := source.read(at, mini(READ_CHUNK, source.size - at))
		if chunk.is_empty():
			break
		h.update(chunk)
		at += chunk.size()
	return h.finish().hex_encode()
