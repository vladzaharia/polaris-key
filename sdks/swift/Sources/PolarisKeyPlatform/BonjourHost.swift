// The Bonjour ops of the Godot binary entry (CC-14b.4, D-16): browse and advertise `_pkeypeer._tcp`
// over `BonjourBrowse` and `BonjourListener`, driven by ops and reported as binary events.
// The pipes (dial, send, close and accepted sockets) are CC-14b.5.
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
//   bj_advertise_start {"instance","txt":[…],"p2p"}  listen on a random port and register the advert
//   bj_advertise_update {"instance","txt":[…]}       the next epoch or K_disc, same port
//   bj_advertise_stop
//   bj_stop_all                                      browse, advert and (CC-14b.5) every pipe
//
// Events (kind, UTF-8 JSON payload):
//
//   bj_found {"instance","txt":[…]} · bj_lost {"instance"} ·
//   bj_error {"scope":"browse"|"advertise","error":"permission_denied"|"not_configured"|"unavailable"} ·
//   bj_advertise {"ok":true,"port":N} | {"ok":false,"error":…} · bj_registered {"instance"} ·
//   bj_withdrawn {"requested","got"}
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

        static let ok: UInt8 = 1
        static let none: UInt8 = 0
        static let badInput: UInt8 = 3
        static let permissionDenied: UInt8 = 4
        static let notConfigured: UInt8 = 5
        static let failed: UInt8 = 6
        static let busy: UInt8 = 7

        let sink: PlatformEventSink
        private let makeDriver: @Sendable () -> (any BonjourBrowseDriver)?
        private let makeListener: @Sendable (Bool) -> BonjourListener
        private let configurationCheck: @Sendable () -> BonjourBrowseError?
        private let lock = NSLock()
        private var browse: BonjourBrowse?
        private var allowed = Set<String>()
        private var listener: BonjourListener?
        private var generation = 0

        public init(
            sink: PlatformEventSink,
            makeDriver: @escaping @Sendable () -> (any BonjourBrowseDriver)? = { nil },
            makeListener: @escaping @Sendable (Bool) -> BonjourListener = { BonjourListener(peerToPeer: $0) },
            configurationCheck: (@Sendable () -> BonjourBrowseError?)? = nil
        ) {
            self.sink = sink
            self.makeDriver = makeDriver
            self.makeListener = makeListener
            self.configurationCheck = configurationCheck ?? BonjourBrowse.processConfigurationCheck
        }

        public func register(into ops: inout [String: PlatformBinaryOp]) {
            ops["bj_browse_start"] = { [self] in browseStart($0) }
            ops["bj_browse_stop"] = { [self] _ in browseStop() }
            ops["bj_accept"] = { [self] in setAccepted($0) }
            ops["bj_advertise_start"] = { [self] in advertiseStart($0) }
            ops["bj_advertise_update"] = { [self] in advertiseUpdate($0) }
            ops["bj_advertise_stop"] = { [self] _ in advertiseStop() }
            ops["bj_stop_all"] = { [self] _ in stopAll() }
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

        // MARK: browse

        func browseStart(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input) else { return [Self.badInput] }
            let p2p = o["p2p"] as? Bool ?? false
            let existing = lock.withLock { browse != nil }
            if existing { return [Self.busy] }
            let b = BonjourBrowse(
                options: BonjourBrowseOptions(peerToPeer: p2p), driver: makeDriver(), configurationCheck: configurationCheck,
                accept: { [weak self] in self?.isAllowed($0) ?? false })
            let first = lock.withLock { () -> Bool in
                if browse != nil { return false }
                browse = b
                return true
            }
            guard first else { return [Self.busy] }
            do {
                try b.start(
                    onUp: { [weak self] f in self?.emit("bj_found", ["instance": f.instance, "txt": f.txt]) },
                    onDown: { [weak self] n in self?.emit("bj_lost", ["instance": n]) },
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
                defer { browse = nil }
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
                return browse
            }
            b?.rescan()
            return [Self.ok]
        }

        // MARK: advertise

        func advertiseStart(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input), let advert = Self.advert(o) else { return [Self.badInput] }
            if let e = configurationCheck() { return [Self.code(e)] }
            let l = makeListener(o["p2p"] as? Bool ?? false)
            let gen = lock.withLock { () -> Int? in
                if listener != nil { return nil }
                listener = l
                generation += 1
                return generation
            }
            guard let gen else { return [Self.busy] }
            Task.detached { [self] in
                do {
                    let port = try await l.start(
                        advert: advert,
                        onPipe: { [weak self] pipe in self?.accepted(pipe) },
                        onEvent: { [weak self] ev in self?.listenerEvent(ev) })
                    // A stop that raced the start leaves nothing listening.
                    if lock.withLock({ generation != gen || listener !== l }) {
                        l.stop()
                    } else {
                        emit("bj_advertise", ["ok": true, "port": Int(port)])
                    }
                } catch {
                    let live = lock.withLock { () -> Bool in
                        guard generation == gen, listener === l else { return false }
                        listener = nil
                        return true
                    }
                    l.stop()
                    if live { emit("bj_advertise", ["ok": false, "error": Self.advertiseError(error)]) }
                }
            }
            return [Self.ok]
        }

        static func advertiseError(_ error: Error) -> String {
            if case BonjourPipeError.browse(let e) = error { return name(e) }
            return "unavailable"
        }

        private func listenerEvent(_ ev: BonjourListenerEvent) {
            switch ev {
            case .registered(let n): emit("bj_registered", ["instance": n])
            case .withdrawn(let requested, let got):
                emit("bj_withdrawn", ["requested": requested, "got": got ?? ""])
            case .failed(let e): emit("bj_error", ["scope": "advertise", "error": Self.name(e)])
            }
        }

        /// A socket accepted by the listener. CC-14b.5 routes it to a pipe; until then it is closed.
        func accepted(_ pipe: NWPipe) {
            Task { await pipe.close() }
        }

        func advertiseUpdate(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
            guard let o = Self.object(input), let advert = Self.advert(o) else { return [Self.badInput] }
            guard let l = lock.withLock({ listener }) else { return [Self.none] }
            l.update(advert: advert)
            return [Self.ok]
        }

        func advertiseStop() -> [UInt8] {
            let l = lock.withLock { () -> BonjourListener? in
                defer { listener = nil }
                generation += 1
                return listener
            }
            l?.stop()
            return [l == nil ? Self.none : Self.ok]
        }

        func stopAll() -> [UInt8] {
            _ = browseStop()
            _ = advertiseStop()
            return [Self.ok]
        }
    }

#endif
