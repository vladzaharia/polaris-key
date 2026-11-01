@tool
class_name PKeyPeerXferDelivered
extends RefCounted
## What a receiver remembers of the transfers it delivered, so a re-offer is answered as done and not
## received again. Per peer key the last `MAX_DELIVERED_PER_PEER` entries, each for
## `DELIVERED_SECONDS`; at most `MAX_DELIVERED_PEERS` peer keys, the least recently used going first.
## Ids, hashes and sizes only, never content, a name or a path; memory only. One Mutex guards it (a
## machine may run on a worker thread while the host forgets a peer).

var _peers := {}
var _mutex := Mutex.new()


func _to_string() -> String:
	return "PKeyPeerXferDelivered()"


## The view of one peer key (32 raw bytes) for a machine's `delivered` option.
func for_peer(peer_key: PackedByteArray) -> View:
	return View.new(self, peer_key.hex_encode())


## Forget one peer key (a link removed, a device left the roster).
func forget(peer_key: PackedByteArray) -> void:
	_mutex.lock()
	_peers.erase(peer_key.hex_encode())
	_mutex.unlock()


## Forget everything (sign-out).
func clear() -> void:
	_mutex.lock()
	_peers.clear()
	_mutex.unlock()


## The number of peer keys held.
func peer_count() -> int:
	_mutex.lock()
	var n := _peers.size()
	_mutex.unlock()
	return n


func _has(key: String, id: String, sha: String, size: int, at: float) -> bool:
	_mutex.lock()
	var found := false
	for r in _fresh(key, at):
		if r["id"] == id and r["sha"] == sha and r["size"] == size:
			found = true
			break
	_mutex.unlock()
	return found


func _add(key: String, id: String, sha: String, size: int, at: float) -> void:
	_mutex.lock()
	var rows := _fresh(key, at)
	rows.append({"id": id, "sha": sha, "size": size, "at": at})
	while rows.size() > PKeyPeerXfer.MAX_DELIVERED_PER_PEER:
		rows.pop_front()
	# Most recently used peer last.
	_peers.erase(key)
	_peers[key] = rows
	while _peers.size() > PKeyPeerXfer.MAX_DELIVERED_PEERS:
		_peers.erase(_peers.keys()[0])
	_mutex.unlock()


## The live rows of a peer (the mutex is held).
func _fresh(key: String, at: float) -> Array:
	var rows: Array = []
	for r in _peers.get(key, []):
		if at - float(r["at"]) <= PKeyPeerXfer.DELIVERED_SECONDS and at >= float(r["at"]):
			rows.append(r)
	if rows.is_empty():
		_peers.erase(key)
	else:
		_peers[key] = rows
	return rows


## A machine's window on one peer key: `has(id, sha256, size, at)` and `add(id, sha256, size, at)`.
class View extends RefCounted:
	var _mem: PKeyPeerXferDelivered
	var _key: String


	func _init(mem: PKeyPeerXferDelivered, key: String) -> void:
		_mem = mem
		_key = key


	func _to_string() -> String:
		return "PKeyPeerXferDelivered.View()"


	func has(id: String, sha256: String, size: int, at: float) -> bool:
		return _mem._has(_key, id, sha256, size, at)


	func add(id: String, sha256: String, size: int, at: float) -> void:
		_mem._add(_key, id, sha256, size, at)
