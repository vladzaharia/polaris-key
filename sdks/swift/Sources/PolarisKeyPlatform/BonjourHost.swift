// The Bonjour ops of the Godot binary entry (CC-14b.4, D-16): browse and advertise `_pkeypeer._tcp`
// over `BonjourBrowse` and `BonjourListener`, driven by ops and reported as binary events.
// CC-14b.5 adds the byte pipes (dial, accepted sockets, send, credit, close).
//
// Ops (all synchronous; the input is UTF-8 JSON of at most 4 KiB unless noted; the reply is one
// status byte: 1 ok, 0 nothing to do, 3 bad input, 4 permission denied, 5 not configured, 6 other
// failure, 7 already running):
//
//   bj_browse_start   {"p2p": bool}                  start the one browse
//   bj_browse_stop
//   bj_accept         concatenated instance names     the roster names to report (19 bytes each, at
//                                                     most 512); everything else is dropped in Swift
//                                                     before it takes a table slot or an event
//   bj_advertise_start {"slot","instance","txt":[…],"p2p"}  listen on a random port and register the advert;
//                                                     slot "a" (default), "v" or "p": one listener each,
//                                                     each under its own G7 limits
//   bj_advertise_update {"slot","instance","txt":[…]}  the next epoch or K_disc, same port
//   bj_advertise_stop  {"slot"}?                     one slot (none: "a"); stopping "a" withdraws the contacts
//   bj_contacts       {"adverts":[{"instance","txt"}…]} at most 8; replaces the whole contact set, registered on
//                                                     slot a's port (none while slot a is down); the set is
//                                                     registered again when that port changes
//   bj_accept_tags    {"v":[h…],"p":[h…]}            at most 2 each: a result whose TXT has m=<k> and h=<tag>
//                                                     enters the table whatever its name (same 256 rows)
//   bj_caps                                          {"slots":1}
//   bj_stop_all                                      browse, every advert, the contacts and every pipe
//
// Pipes (CC-14b.5; ids are u32, big endian, in the binary ops):
//
//   bj_dial   {"instance"}           → 1 ‖ id | 0 unknown instance | 7 too many pipes. Result: bj_open or bj_closed.
//   bj_send   id ‖ bytes              → 1 queued | 0 unknown or closing | 7 queue full (4 MiB) | 3 bad
//   bj_credit id ‖ n(u32)             the host has taken n received bytes; reading resumes under 256 KiB unread
//   bj_admit  id                      the session was admitted: the socket leaves the G7 pre-auth limits
//   bj_close  id ‖ mode               mode 0: close after what is queued is sent; 1: abort now
//
// Pipe events: bj_accepted {"id","remote","slot"} · bj_open {"id"} · bj_data id ‖ bytes ·
// bj_closed {"id","reason":"eof"|"error"|"refused"|"timeout"|"closed"|"unresolvable"} (not sent for a close
// the host asked for). The pipe table is at most 64; a received chunk is at most 64 KiB and at most 256 KiB
// are unread at once per pipe, so a peer that sends faster than the host reads is stopped by TCP, not by
// memory.
//
// Events (kind, UTF-8 JSON payload):
//
//   bj_found {"instance","txt":[…]} · bj_lost {"instance"} ·
//   bj_error {"scope":"browse"|"advertise","error":"permission_denied"|"not_configured"|"unavailable"} ·
//   bj_advertise {"slot","ok":true,"port":N} | {"slot","ok":false,"error":…} · bj_registered {"slot","instance"} ·
//   bj_withdrawn {"slot","requested","got"} (slot "c" for a contact name)
//
// Permission is asked when the browse or listener starts, never at launch (L-11). Nothing here sees a
// key; a found row carries only what a peer put in its own advert, bounded as `BonjourTable` bounds it.

import Foundation

#if canImport(Network)

    public final class BonjourHost: @unchecked Sendable {
        public static let maxControlBytes = 4096
        public static let maxAccepted = 512
        public static let maxTxtEntries = 8
        public static let maxTxtBytes = 255
        public static let maxContacts = 8
        public static let maxTags = 2
        static let slots: Set<String> = ["a", "v", "p"]

        static let ok: UInt8 = 1
        static let none: UInt8 = 0
        static let badInput: UInt8 = 3
        static let permissionDenied: UInt8 = 4
        static let notConfigured: UInt8 = 5
        static let failed: UInt8 = 6
        static let busy: UInt8 = 7

        public static let maxPipes = 64
        public static let readWindow = 256 * 1024
        public static let maxQueuedBytes = 4 * 1024 * 1024
        /// A write the peer does not take within this long ends the pipe.
        public static let writeSeconds: TimeInterval = 10
        /// After a graceful close is asked for, the pipe is aborted this long after if it is still up.
        public static let closeSeconds: TimeInterval = 10

        let sink: PlatformEventSink
        private let allowLoopback: Bool
        private let writeSeconds: TimeInterval
        private let closeSeconds: TimeInterval
        private let makeDriver: @Sendable () -> (any BonjourBrowseDriver)?
        private let makeListener: @Sendable (Bool) -> BonjourListener
        private let configurationCheck: @Sendable () -> BonjourBrowseError?
        private let lock = NSLock()
        private var browse: BonjourBrowse?
        private var allowed = Set<String>()
        private var listeners: [String: BonjourListener] = [:]
        private var generations: [String: Int] = [:]
        private var ports: [String: UInt16] = [:]
        private var tags: [String: [String]] = [:]
        private var contactWanted: [BonjourAdvert] = []
        private let contacts: BonjourContactAdverts
        private var endpoints: [String: BonjourEndpoint] = [:]
        private var pipes: [UInt32: PipeState] = [:]
        private var nextId: UInt32 = 0

        public init(
            sink: PlatformEventSink,
            makeDriver: @escaping @Sendable () -> (any BonjourBrowseDriver)? = { nil },
            makeListener: (@Sendable (Bool) -> BonjourListener)? = nil, allowLoopback: Bool = false,
            writeSeconds: TimeInterval = BonjourHost.writeSeconds,
            closeSeconds: TimeInterval = BonjourHost.closeSeconds,
            configurationCheck: (@Sendable () -> BonjourBrowseError?)? = nil,
            contacts: BonjourContactAdverts? = nil
        ) {
            self.sink = sink
            self.contacts =
                contacts
                ?? BonjourContactAdverts(onWithdrawn: { [weak sink] name in
                    guard let sink,
                        let d = try? JSONSerialization.data(
                            withJSONObject: ["slot": "c", "requested": name, "got": ""], options: [.sortedKeys])
                    else { return }
                    sink.emitBinary("bj_withdrawn", [UInt8](d))
                })
            self.makeDriver = makeDriver
            self.allowLoopback = allowLoopback
            self.writeSeconds = writeSeconds
            self.closeSeconds = closeSeconds
            self.makeListener =
                makeListener ?? {
                    BonjourListener(peerToPeer: $0, policy: BonjourDialPolicy(allowLoopback: allowLoopback))
                }
            self.configurationCheck = configurationCheck ?? BonjourBrowse.processConfigurationCheck
        }

        public func register(into ops: inout [String: PlatformBinaryOp]) {
            ops["bj_browse_start"] = { [self] in browseStart($0) }
            ops["bj_browse_stop"] = { [self] _ in browseStop() }
            ops["bj_accept"] = { [self] in setAccepted($0) }
            ops["bj_advertise_start"] = { [self] in advertiseStart($0) }
            ops["bj_advertise_update"] = { [self] in advertiseUpdate($0) }
            ops["bj_advertise_stop"] = { [self] in advertiseStop($0) }
            ops["bj_contacts"] = { [self] in setContacts($0) }
            ops["bj_accept_tags"] = { [self] in setTags($0) }
            ops["bj_caps"] = { _ in Array(#"{"slots":1}"#.utf8) }
            ops["bj_stop_all"] = { [self] _ in stopAll() }
            ops["bj_dial"] = { [self] in dial($0) }
            ops["bj_send"] = { [self] in send($0) }
            ops["bj_credit"] = { [self] in credit($0) }
            ops["bj_admit"] = { [self] in admit($0) }
            ops["bj_close"] = { [self] in close($0) }
        }

        // MARK: helpers

        private static func object(_ input: UnsafeBufferPointer<UInt8>) -> [String: Any]? {
            guard input.count <= maxControlBytes, input.count > 0,
                let o = try? JSONSerialization.jsonObject(with: Data(input)) as? [String: Any]
            else { return nil }
            return o
        }

        private func emit(_ kind: String, _ payload: [String: Any]) {
            guard let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
            sink.emitBinary(kind, [UInt8](d))
        }

        static func code(_ e: BonjourBrowseError) -> UInt8 {
            switch e {
            case .permissionDenied: return permissionDenied
            case .notConfigured: return notConfigured
            case .unavailable: return failed
            }
        }

        static func name(_ e: BonjourBrowseError) -> String {
            switch e {
            case .permissionDenied: return "permission_denied"
            case .notConfigured: return "not_configured"
            case .unavailable: return "unavailable"
            }
        }

        /// The advert from a control object, or nil when it is malformed: a valid instance name and at
        /// most 8 TXT entries of at most 255 bytes each.
        static func advert(_ o: [String: Any]) -> BonjourAdvert? {
            guard let instance = o["instance"] as? String, BonjourTable.isInstanceName(instance),
                let txt = o["txt"] as? [String], txt.count <= maxTxtEntries,
                txt.allSatisfy({ $0.utf8.count <= maxTxtBytes && !$0.isEmpty })
            else { return nil }
            return BonjourAdvert(instance: instance, txt: txt)
        }

        private func isAllowed(_ name: String) -> Bool { lock.withLock { allowed.contains(name) } }

        /// A `p1-` result whose TXT says `m=<k>` and `h=<tag>` for a tag pushed for k. The consumer checks the
        /// TXT again.
        private func tagMatch(_ f: BonjourFound) -> Bool {
            let t = lock.withLock { tags }
            for (k, list) in t where f.txt.contains("m=\(k)") {
                for h in list where f.txt.contains("h=\(h)") { return true }
            }
            return false
        }

        private static func slot(_ o: [String: Any]) -> String? {
            guard let v = o["slot"] else { return "a" }
            guard let s = v as? String, slots.contains(s) else { return nil }
            return s
        }

        // MARK: browse

        func browseStart(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input) else { return [Self.badInput] }
            let p2p = o["p2p"] as? Bool ?? false
            let existing = lock.withLock { browse != nil }
            if existing { return [Self.busy] }
            let b = BonjourBrowse(
                options: BonjourBrowseOptions(peerToPeer: p2p), driver: makeDriver(),
                configurationCheck: configurationCheck,
                accept: { [weak self] in self?.isAllowed($0) ?? false },
                admitAlso: { [weak self] in self?.tagMatch($0) ?? false })
            let first = lock.withLock { () -> Bool in
                if browse != nil { return false }
                browse = b
                return true
            }
            guard first else { return [Self.busy] }
            do {
                try b.start(
                    onUp: { [weak self] f in
                        self?.lock.withLock { self?.endpoints[f.instance] = f.endpoint }
                        self?.emit("bj_found", ["instance": f.instance, "txt": f.txt])
                    },
                    onDown: { [weak self] n in
                        self?.lock.withLock { _ = self?.endpoints.removeValue(forKey: n) }
                        self?.emit("bj_lost", ["instance": n])
                    },
                    onError: { [weak self] e in self?.emit("bj_error", ["scope": "browse", "error": Self.name(e)]) })
            } catch let e as BonjourBrowseError {
                lock.withLock { if browse === b { browse = nil } }
                return [Self.code(e)]
            } catch {
                lock.withLock { if browse === b { browse = nil } }
                return [Self.failed]
            }
            return [Self.ok]
        }

        func browseStop() -> [UInt8] {
            let b = lock.withLock { () -> BonjourBrowse? in
                defer {
                    browse = nil
                    endpoints = [:]
                }
                return browse
            }
            b?.stop()
            return [b == nil ? Self.none : Self.ok]
        }

        func setAccepted(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            let n = BonjourTable.nameBytes
            guard input.count % n == 0, input.count / n <= Self.maxAccepted else { return [Self.badInput] }
            var names = Set<String>()
            for i in stride(from: 0, to: input.count, by: n) {
                guard let s = String(bytes: input[i..<(i + n)], encoding: .utf8), BonjourTable.isInstanceName(s) else {
                    return [Self.badInput]
                }
                names.insert(s)
            }
            let b = lock.withLock { () -> BonjourBrowse? in
                allowed = names
                endpoints = endpoints.filter { names.contains($0.key) }
                return browse
            }
            b?.rescan()
            return [Self.ok]
        }

        // MARK: advertise

        func advertiseStart(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input), let advert = Self.advert(o), let slot = Self.slot(o) else {
                return [Self.badInput]
            }
            if let e = configurationCheck() { return [Self.code(e)] }
            let l = makeListener(o["p2p"] as? Bool ?? false)
            let gen = lock.withLock { () -> Int? in
                if listeners[slot] != nil { return nil }
                listeners[slot] = l
                generations[slot, default: 0] += 1
                return generations[slot]
            }
            guard let gen else { return [Self.busy] }
            Task.detached { [self] in
                do {
                    let port = try await l.start(
                        advert: advert,
                        onPipe: { [weak self] pipe in self?.accepted(pipe, slot: slot) },
                        onEvent: { [weak self] ev in self?.listenerEvent(ev, slot: slot) })
                    // A stop that raced the start leaves nothing listening.
                    let live = lock.withLock { () -> Bool in
                        guard generations[slot] == gen, listeners[slot] === l else { return false }
                        ports[slot] = port
                        return true
                    }
                    if live {
                        emit("bj_advertise", ["slot": slot, "ok": true, "port": Int(port)])
                        if slot == "a" { refreshContacts() }
                    } else {
                        l.stop()
                    }
                } catch {
                    let live = lock.withLock { () -> Bool in
                        guard generations[slot] == gen, listeners[slot] === l else { return false }
                        listeners[slot] = nil
                        return true
                    }
                    l.stop()
                    if live {
                        emit("bj_advertise", ["slot": slot, "ok": false, "error": Self.advertiseError(error)])
                    }
                }
            }
            return [Self.ok]
        }

        static func advertiseError(_ error: Error) -> String {
            if case BonjourPipeError.browse(let e) = error { return name(e) }
            return "unavailable"
        }

        private func listenerEvent(_ ev: BonjourListenerEvent, slot: String) {
            switch ev {
            case .registered(let n): emit("bj_registered", ["slot": slot, "instance": n])
            case .withdrawn(let requested, let got):
                emit("bj_withdrawn", ["slot": slot, "requested": requested, "got": got ?? ""])
            case .failed(let e): emit("bj_error", ["scope": "advertise", "slot": slot, "error": Self.name(e)])
            }
        }

        /// A socket accepted by the listener of `slot`: a pipe id, an event, and a read loop. The socket
        /// keeps its G7 slot until `bj_admit` (or the 30 s pre-auth close).
        func accepted(_ pipe: NWPipe, slot: String = "a") {
            guard let state = reserve() else {
                Task { await pipe.close() }
                return
            }
            state.attach(pipe)
            emit("bj_accepted", ["id": Int(state.id), "remote": pipe.remoteAddress, "slot": slot])
            run(state)
        }

        func advertiseUpdate(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input), let advert = Self.advert(o), let slot = Self.slot(o) else {
                return [Self.badInput]
            }
            guard let l = lock.withLock({ listeners[slot] }) else { return [Self.none] }
            l.update(advert: advert)
            return [Self.ok]
        }

        /// No input stops slot a; `{"slot"}` stops that one. Stopping a withdraws the contact adverts.
        func advertiseStop(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            var slot = "a"
            if input.count > 0 {
                guard let o = Self.object(input), let s = Self.slot(o) else { return [Self.badInput] }
                slot = s
            }
            return [stopSlot(slot) ? Self.ok : Self.none]
        }

        private func stopSlot(_ slot: String) -> Bool {
            let l = lock.withLock { () -> BonjourListener? in
                defer {
                    listeners[slot] = nil
                    ports[slot] = nil
                }
                generations[slot, default: 0] += 1
                return listeners[slot]
            }
            l?.stop()
            if slot == "a" { contacts.stop() }
            return l != nil
        }

        // MARK: contacts and tags

        /// Make the live contact set exactly `adverts` on slot a's port (CC-19 R-9b N3).
        func setContacts(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input), let list = o["adverts"] as? [[String: Any]],
                list.count <= Self.maxContacts
            else { return [Self.badInput] }
            var adverts: [BonjourAdvert] = []
            for item in list {
                guard let a = Self.advert(item), !adverts.contains(where: { $0.instance == a.instance }) else {
                    return [Self.badInput]
                }
                adverts.append(a)
            }
            lock.withLock { contactWanted = adverts }
            refreshContacts()
            return [Self.ok]
        }

        /// Register the wanted contact set on slot a's current port, or withdraw it while slot a is down.
        private func refreshContacts() {
            let (wanted, port) = lock.withLock { (contactWanted, ports["a"]) }
            if let port, !wanted.isEmpty {
                contacts.update(wanted, port: port)
            } else {
                contacts.stop()
            }
        }

        /// The tags a `p1-` result may match without being on the roster: at most 2 per kind, each 16 of `0-9a-f`.
        /// A bad list clears both kinds.
        func setTags(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            var next: [String: [String]] = [:]
            var good = false
            if let o = Self.object(input), Set(o.keys).isSubset(of: ["v", "p"]) {
                good = true
                for (k, v) in o {
                    guard let list = v as? [String], list.count <= Self.maxTags,
                        list.allSatisfy({ Self.isTag($0) })
                    else {
                        good = false
                        break
                    }
                    next[k] = list
                }
            }
            if !good { next = [:] }
            let b = lock.withLock { () -> BonjourBrowse? in
                tags = next
                return browse
            }
            b?.rescan()
            return [good ? Self.ok : Self.badInput]
        }

        static func isTag(_ s: String) -> Bool {
            s.utf8.count == 16 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
        }

        func stopAll() -> [UInt8] {
            _ = browseStop()
            for slot in Self.slots.sorted() { _ = stopSlot(slot) }
            lock.withLock { contactWanted = [] }
            contacts.stop()
            let all = lock.withLock { () -> [PipeState] in
                defer { pipes = [:] }
                return Array(pipes.values)
            }
            for p in all { p.abort() }
            return [Self.ok]
        }

        // MARK: pipes

        /// A table slot and an id, or nil when the table is full.
        func reserve() -> PipeState? {
            lock.withLock {
                guard pipes.count < Self.maxPipes else { return nil }
                repeat { nextId &+= 1 } while nextId == 0 || pipes[nextId] != nil
                let state = PipeState(id: nextId)
                pipes[nextId] = state
                return state
            }
        }

        private func state(_ id: UInt32) -> PipeState? { lock.withLock { pipes[id] } }

        private func forget(_ state: PipeState) {
            lock.withLock { if pipes[state.id] === state { pipes[state.id] = nil } }
        }

        private static func id(_ i: UnsafeBufferPointer<UInt8>) -> UInt32? {
            guard i.count >= 4 else { return nil }
            return (UInt32(i[0]) << 24) | (UInt32(i[1]) << 16) | (UInt32(i[2]) << 8) | UInt32(i[3])
        }

        /// A slot's port, as a started listener reports it (tests).
        func learnPort(_ slot: String, _ port: UInt16?) {
            lock.withLock { ports[slot] = port }
            if slot == "a" { refreshContacts() }
        }

        /// A browse row learned outside a browse (tests).
        func learn(_ instance: String, _ endpoint: BonjourEndpoint) {
            lock.withLock { endpoints[instance] = endpoint }
        }

        func dial(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input), let instance = o["instance"] as? String,
                BonjourTable.isInstanceName(instance)
            else { return [Self.badInput] }
            guard let endpoint = lock.withLock({ endpoints[instance] }) else { return [Self.none] }
            guard let state = reserve() else { return [Self.busy] }
            let options = BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: allowLoopback))
            Task.detached { [self] in
                do {
                    let pipe = try await BonjourPipes.dial(endpoint, options: options)
                    guard state.attach(pipe) else {
                        await pipe.close()
                        return
                    }
                    emit("bj_open", ["id": Int(state.id)])
                    drain(state)  // writes that waited for the connection
                    run(state)
                } catch {
                    if state.finish() {
                        forget(state)
                        emit("bj_closed", ["id": Int(state.id), "reason": Self.reason(error)])
                    }
                }
            }
            return [
                Self.ok, UInt8(state.id >> 24 & 255), UInt8(state.id >> 16 & 255), UInt8(state.id >> 8 & 255),
                UInt8(state.id & 255),
            ]
        }

        static func reason(_ error: Error) -> String {
            switch error as? BonjourPipeError {
            case .addressRefused?: return "refused"
            case .timedOut?: return "timeout"
            case .unresolvable?: return "unresolvable"
            case .closed?: return "closed"
            default: return "error"
            }
        }

        /// Read loop of one pipe: pull a chunk, report it, and wait for credit once 256 KiB are unread.
        private func run(_ state: PipeState) {
            Task.detached { [self] in
                var reason = "eof"
                while true {
                    await state.waitForCredit()
                    guard let pipe = state.pipe, !state.isFinished else { return }
                    do {
                        guard let chunk = try await pipe.read() else { break }
                        guard state.received(chunk.count) else { return }
                        let head = [
                            UInt8(state.id >> 24 & 255), UInt8(state.id >> 16 & 255), UInt8(state.id >> 8 & 255),
                            UInt8(state.id & 255),
                        ]
                        sink.emitBinary("bj_data", head + [UInt8](chunk))
                    } catch {
                        reason = "error"
                        break
                    }
                }
                if state.finish() {
                    forget(state)
                    emit("bj_closed", ["id": Int(state.id), "reason": reason])
                    state.pipe?.shutDown()
                }
            }
        }

        func send(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let id = Self.id(input) else { return [Self.badInput] }
            guard let state = state(id) else { return [Self.none] }
            let data = Data(input[4...])
            switch state.enqueue(data) {
            case .queued:
                drain(state)
                return [Self.ok]
            case .full: return [Self.busy]
            case .closed: return [Self.none]
            }
        }

        /// One writer per pipe, in order. A write failure or a write the peer does not take within
        /// `writeSeconds` ends the pipe. `nextChunk` clears `draining` under the lock that finds the queue
        /// empty, so a send that follows always starts a new drainer.
        private func drain(_ state: PipeState) {
            guard state.startDrain() else { return }
            let seconds = writeSeconds
            Task.detached { [self] in
                while let chunk = state.nextChunk() {
                    guard let pipe = state.pipe else { return }
                    let wrote = await Self.write(pipe, chunk, seconds: seconds)
                    if wrote {
                        state.sent(chunk.count)
                    } else {
                        if state.finish() {
                            forget(state)
                            emit("bj_closed", ["id": Int(state.id), "reason": "timeout"])
                        }
                        pipe.shutDown()
                        return
                    }
                }
                if state.closeIfDrained() {
                    state.closeNow()
                    forget(state)
                }
            }
        }

        /// The write, or false if it failed or was not taken in time (the pipe is shut then, which
        /// completes the pending send).
        static func write(_ pipe: NWPipe, _ chunk: Data, seconds: TimeInterval) async -> Bool {
            await withTaskGroup(of: Bool?.self) { group in
                group.addTask { (try? await pipe.write(chunk)) != nil ? true : false }
                group.addTask {
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    return nil
                }
                var result = false
                if let first = await group.next() {
                    if let ok = first {
                        result = ok
                    } else {
                        pipe.shutDown()  // timed out: ends the send
                    }
                }
                group.cancelAll()
                return result
            }
        }

        func credit(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard input.count == 8, let id = Self.id(input) else { return [Self.badInput] }
            let n = (Int(input[4]) << 24) | (Int(input[5]) << 16) | (Int(input[6]) << 8) | Int(input[7])
            guard let state = state(id) else { return [Self.none] }
            state.credit(n)
            return [Self.ok]
        }

        func admit(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard input.count == 4, let id = Self.id(input) else { return [Self.badInput] }
            guard let state = state(id) else { return [Self.none] }
            state.pipe?.markAuthenticated()
            return [Self.ok]
        }

        func close(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard input.count == 5, let id = Self.id(input), input[4] <= 1 else { return [Self.badInput] }
            guard let state = state(id) else { return [Self.none] }
            if input[4] == 1 {
                forget(state)
                state.abort()
            } else if state.requestClose() {
                forget(state)
            } else {
                // What is queued gets `closeSeconds` to go out; then the pipe is dropped whatever its state.
                let seconds = closeSeconds
                Task.detached { [self] in
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    if !state.isFinished {
                        forget(state)
                        state.abort()
                    }
                }
            }
            return [Self.ok]
        }
    }

    /// One pipe's state. Everything is behind one lock; nothing is awaited while it is held.
    final class PipeState: @unchecked Sendable {
        enum Enqueue { case queued, full, closed }

        let id: UInt32
        private let lock = NSLock()
        private(set) var pipe: NWPipe?
        private var finished = false
        private var unread = 0
        private var waiter: CheckedContinuation<Void, Never>?
        private var queue: [Data] = []
        private var queuedBytes = 0
        private var draining = false
        private var closing = false

        init(id: UInt32) { self.id = id }

        var isFinished: Bool { lock.withLock { finished } }

        /// False when the pipe was already ended (an abort during the dial).
        @discardableResult
        func attach(_ p: NWPipe) -> Bool {
            lock.withLock {
                guard !finished else { return false }
                pipe = p
                return true
            }
        }

        /// Ends the pipe once; true for the caller that ended it.
        func finish() -> Bool {
            let (first, w) = lock.withLock { () -> (Bool, CheckedContinuation<Void, Never>?) in
                let was = finished
                finished = true
                queue = []
                queuedBytes = 0
                defer { waiter = nil }
                return (!was, waiter)
            }
            w?.resume()
            return first
        }

        func shutNow() { pipe?.shutDown() }

        func abort() {
            _ = finish()
            pipe?.shutDown()
        }

        func closeNow() {
            _ = finish()
            pipe?.shutDown()
        }

        func waitForCredit() async {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                let now = lock.withLock { () -> Bool in
                    if finished || unread < BonjourHost.readWindow { return true }
                    waiter = c
                    return false
                }
                if now { c.resume() }
            }
        }

        /// Count a received chunk; false when the pipe ended meanwhile.
        func received(_ n: Int) -> Bool {
            lock.withLock {
                guard !finished else { return false }
                unread += n
                return true
            }
        }

        func credit(_ n: Int) {
            let w = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                unread = max(0, unread - n)
                guard unread < BonjourHost.readWindow else { return nil }
                defer { waiter = nil }
                return waiter
            }
            w?.resume()
        }

        func enqueue(_ d: Data) -> Enqueue {
            lock.withLock {
                guard !finished, !closing else { return .closed }
                guard queuedBytes + d.count <= BonjourHost.maxQueuedBytes else { return .full }
                if !d.isEmpty {
                    queue.append(d)
                    queuedBytes += d.count
                }
                return .queued
            }
        }

        /// Tests start a drain without a pipe.
        func testStartDrain() -> Bool {
            lock.withLock {
                guard !draining, !queue.isEmpty, !finished else { return false }
                draining = true
                return true
            }
        }

        func startDrain() -> Bool {
            lock.withLock {
                guard !draining, !queue.isEmpty, pipe != nil, !finished else { return false }
                draining = true
                return true
            }
        }

        /// The next chunk, or nil with `draining` cleared in the same critical section.
        func nextChunk() -> Data? {
            lock.withLock {
                guard !finished, !queue.isEmpty else {
                    draining = false
                    return nil
                }
                return queue.removeFirst()
            }
        }

        func sent(_ n: Int) { lock.withLock { queuedBytes = max(0, queuedBytes - n) } }

        /// True when a close was asked for and nothing is queued or being written.
        func closeIfDrained() -> Bool {
            lock.withLock { closing && queue.isEmpty && !draining && !finished }
        }

        /// Close after the queue is sent. True when it can close now (nothing queued and not draining).
        func requestClose() -> Bool {
            let now = lock.withLock { () -> Bool in
                closing = true
                return queue.isEmpty && !draining
            }
            if now { closeNow() }
            return now
        }
    }

#endif
