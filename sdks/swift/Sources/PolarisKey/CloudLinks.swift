// Inter-account links, `client.cloudConnect.links` (CC-19.7; WIRE-CONTRACT-V5 §15.10): pair two devices of two
// accounts once, in person, and open sessions to the contact later without a new pairing, on the LAN first and
// then through the contact relay. Mirrors sdk-node's `connect/links.ts`.
//
//   pair(_:)               open the pairing window: show each code, `confirm()` or `decline()`, and a link is
//                          stored on both devices. LAN only (mode `p`)
//   list()                 the links this device holds
//   remove(_:)             delete a link: its secret goes, open sessions with it hear `peer_revoked`, the other
//                          device finds the link "not reachable"
//   setReachable(_:_:)     advertise a link on the LAN and keep a relay room for it, or stop
//   open(_:)               a session to the contact: LAN first, the contact relay after a failed or timed-out LAN
//                          attempt (unless the host turned the relay off)
//   onLink(_:)             called with each session a contact opened to this device
//   interAccount()         the cached discovery answer links are gated on
//
// Rules this file keeps:
//  - links are the developer's opt-in in every transport (D-12): `pair`, the adverts and the mode-`c` answer need
//    the cached discovery `interAccount` to be true. Without it `pair` and `open` throw `CloudLinksDisabled` (code
//    `connect_links_disabled`), nothing is advertised and no mode `c` is answered; when a refresh says false the
//    adverts and rooms are withdrawn and the open contact sessions end with `peer_bye`;
//  - a link is a secret and a key on this device only. `ContactInfo` carries neither; a deleted contact's secret is
//    gone from the record before `remove` returns;
//  - the order is LAN, then the contact relay, as for the person's own devices (CloudConnect).

import Foundation
import PolarisKeyCore

#if canImport(Network)

    /// Links between accounts are off for this product (the typed N/A, code `connect_links_disabled`).
    public struct CloudLinksDisabled: Error, Sendable, Equatable, CustomStringConvertible {
        public let code = ErrorCode.connectLinksDisabled
        public let unsupported: Unsupported
        init(_ what: String) {
            unsupported = Unsupported(
                feature: Feature.connectLinks, reason: "product",
                detail: "Links between accounts are off for this product (\(what)).")
        }
        public var description: String { unsupported.description }
    }

    public final class CloudLinks: Sendable {
        let core: LinksCore

        init(connect: ConnectClient) { core = LinksCore(connect: connect) }

        /// For the transfer service: every session a link opens or receives, and the `agreeKey` of a link that was
        /// removed.
        func hook(adopt: @escaping @Sendable (ConnectSession) -> Void, removed: @escaping @Sendable (String) -> Void) {
            core.hooks.adopt.set(adopt)
            core.hooks.removed.set(removed)
        }

        /// The cached discovery answer `services.connect.interAccount`: true only while the product's setting,
        /// `launch.connectLinks` and the service are on (§15.9). False before discovery.
        public func interAccount() async -> Bool { await core.connect.interAccount() }

        /// The links this device holds.
        public func list() async -> [ContactInfo] { ConnectContacts.info(await core.connect.contactRows()) }

        /// Delete a link (and a re-pair waiting on it). Its secret is dropped from the record, and an open session
        /// with that contact is closed with `peer_revoked`. False when `id` names no link.
        public func remove(_ id: String) async -> Bool { await core.remove(id) }

        /// Advertise a link on the LAN and keep a relay room for it (at most 8 at once), or stop. False when `id`
        /// names no link.
        public func setReachable(_ id: String, _ reachable: Bool) async -> Bool {
            var found = false
            _ = try? await core.connect.updateContacts { rows, _ in
                found = rows.contains { ConnectContacts.id($0.agreeKey) == id }
                return found
                    ? rows.map { r in
                        var r = r
                        if ConnectContacts.id(r.agreeKey) == id { r.reachable = reachable }
                        return r
                    } : nil
            }
            return found
        }

        /// Called with each session a contact opened to this device, on either path. Returns the unsubscribe.
        @discardableResult
        public func onLink(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
            core.listeners.add(fn)
        }

        /// Open the pairing window. Both people do it; each device advertises, finds the other and runs the code.
        /// Throws `CloudLinksDisabled` while links are off, `ConnectLanError` for bad options or no identity. The
        /// returned handle closes the window (`stop()`); it also closes by itself after `seconds` (at most 300) and
        /// once a link is made.
        public func pair(_ options: LinkPairOptions) async throws -> LinkPairHandle { try await core.pair(options) }

        /// A session to a contact: LAN first when it was seen on the network, the contact relay after a failed or
        /// timed-out LAN attempt (unless disabled). A pending contact (a re-pair) is tried before the held one.
        /// Throws `CloudLinksDisabled` while links are off, `ConnectLanError` `notStarted` before
        /// `cloudConnect.start()`, and the last `ConnectLanError` or `ConnectRelayError` when no path works.
        public func open(_ id: String, relay: Bool = true, lanAttemptSeconds: TimeInterval? = nil) async throws
            -> ConnectSession
        {
            try await core.open(id, relay: relay, lanAttempt: lanAttemptSeconds)
        }

        // MARK: Wiring (CloudConnect.start and stop)

        func attach(lan: ConnectLanService?, relay: ConnectContactRelay?, lanAttempt: TimeInterval, relayOn: Bool)
            async
        {
            await core.attach(lan: lan, relay: relay, lanAttempt: lanAttempt, relayOn: relayOn)
        }

        func detach() async { await core.detach() }
    }

    final class LinkListeners: Sendable {
        private struct S {
            var next = 0
            var fns: [(Int, @Sendable (ConnectSession) -> Void)] = []
        }
        private let state = LockedValue(S())
        func add(_ fn: @escaping @Sendable (ConnectSession) -> Void) -> @Sendable () -> Void {
            let id = state.with { s -> Int in
                s.next += 1
                s.fns.append((s.next, fn))
                return s.next
            }
            return { [state] in state.with { $0.fns.removeAll { $0.0 == id } } }
        }
        func fire(_ s: ConnectSession) { for f in state.with({ $0.fns.map(\.1) }) { f(s) } }
    }

    final class LinkHooks: Sendable {
        let adopt = LockedValue<(@Sendable (ConnectSession) -> Void)?>(nil)
        let removed = LockedValue<(@Sendable (String) -> Void)?>(nil)
    }

    actor LinksCore {
        nonisolated let connect: ConnectClient
        nonisolated let listeners = LinkListeners()
        nonisolated let hooks = LinkHooks()
        private var lan: ConnectLanService?
        private var relay: ConnectContactRelay?
        private var lanAttempt = cloudConnectLanAttemptSeconds
        private var relayOn = false
        private var unsub: [@Sendable () -> Void] = []
        private var sessions: [ObjectIdentifier: ConnectSession] = [:]
        private var pairings: [ObjectIdentifier: LinkPairHandle] = [:]

        init(connect: ConnectClient) { self.connect = connect }

        private func requireOn(_ what: String) async throws {
            if !(await connect.interAccount()) { throw CloudLinksDisabled(what) }
        }

        func attach(lan: ConnectLanService?, relay: ConnectContactRelay?, lanAttempt: TimeInterval, relayOn: Bool) {
            detachSync()
            self.lan = lan
            self.relay = relay
            self.lanAttempt = lanAttempt
            self.relayOn = relayOn
            if let lan {
                unsub.append(
                    lan.onContactSession { [weak self] s in
                        guard let self else { return }
                        Task { await self.inbound(s) }
                    })
            }
            if let relay {
                unsub.append(
                    relay.onSession { [weak self] s in
                        guard let self else { return }
                        Task { await self.inbound(s) }
                    })
            }
            // The list or the gate moved: end the sessions that no longer have a footing.
            unsub.append(
                connect.onContactsChanged { [weak self] in
                    guard let self else { return }
                    Task { await self.reconcile() }
                })
        }

        private func detachSync() {
            for u in unsub { u() }
            unsub = []
            lan = nil
            relay = nil
        }

        func detach() async {
            detachSync()
            let pairs = Array(pairings.values)
            pairings = [:]
            let open = Array(sessions.values)
            sessions = [:]
            for p in pairs { await p.stop() }
            for s in open { await s.close() }
        }

        private func closePairings() async {
            let pairs = Array(pairings.values)
            pairings = [:]
            for p in pairs { await p.stop() }
        }

        func inbound(_ s: ConnectSession) async {
            // The handshake may have begun before the contact was removed or the gate went off: the session is handed
            // to Direct Transfer and delivered only while the contact (same secret) is held and links are on.
            if await stillHeld(s) {
                track(s)
                listeners.fire(s)
            }
        }

        /// Close `s` (`peer_revoked`, or `peer_bye` when the gate is off) unless its contact is still held.
        private func stillHeld(_ s: ConnectSession) async -> Bool {
            guard let ref = s.contact else { return true }
            let on = await connect.interAccount()
            if on, await connect.holdsContact(agreeKey: ref.agreeKey, tag: ref.tag) { return true }
            await s.close(on ? .peerRevoked : .peerBye)
            return false
        }

        private func trackHeld(_ s: ConnectSession) async throws -> ConnectSession {
            track(s)
            if await stillHeld(s) { return s }
            throw ConnectLanError(.unknownPeer, "That link was removed.")
        }

        private func track(_ s: ConnectSession) {
            let id = ObjectIdentifier(s)
            sessions[id] = s
            hooks.adopt.current?(s)
            s.onClose { [weak self] _ in
                guard let self else { return }
                Task { await self.untrack(id) }
            }
        }

        private func untrack(_ id: ObjectIdentifier) { sessions[id] = nil }

        /// The gate or the list moved: a closed gate ends every contact session (`peer_bye`), a deleted contact's
        /// ends `peer_revoked`.
        private func reconcile() async {
            let on = await connect.interAccount()
            if !on {
                for s in Array(sessions.values) { await s.close(.peerBye) }
                await closePairings()
                return
            }
            let have = Set((await connect.contactRows()).map { ConnectContacts.id($0.agreeKey) })
            for s in Array(sessions.values) {
                if let c = s.contact, !have.contains(c.id) { await s.close(.peerRevoked) }
            }
        }

        func remove(_ id: String) async -> Bool {
            var found = false
            var gone: [String] = []
            _ = try? await connect.updateContacts { rows, _ in
                let next = rows.filter { ConnectContacts.id($0.agreeKey) != id }
                found = next.count != rows.count
                gone = rows.filter { ConnectContacts.id($0.agreeKey) == id }.map(\.agreeKey)
                return found ? next : nil
            }
            if found {
                await reconcile()
                for k in gone { hooks.removed.current?(k) }
            }
            return found
        }

        func pair(_ o: LinkPairOptions) async throws -> LinkPairHandle {
            try await requireOn("pair")
            switch await connect.identity() {
            case .ready: break
            default: throw ConnectLanError(.noIdentity, "No Cloud Connect identity is held; call identity() first.")
            }
            let c = connect
            let src = PairSource(
                slug: c.core.product, now: { Int(Date().timeIntervalSince1970) },
                agreeKey: { try await c.ownAgreeKey() },
                held: { (await c.contactRows()).filter { $0.pendingSince == nil }.map(\.agreeKey) },
                store: { key, secret, label, cats in
                    var out: (id: String, pending: Bool)?
                    _ = try? await c.updateContacts { rows, now in
                        guard
                            let v = ConnectContacts.store(
                                rows, agreeKey: key, secret: secret, label: label, cats: cats, now: now)
                        else { return nil }
                        out = (ConnectContacts.id(key), v.pending)
                        return v.rows
                    }
                    return out
                },
                allowed: { await c.interAccount() })
            let h = try await LinkPairing.start(src, o)
            pairings[ObjectIdentifier(h)] = h
            return h
        }

        func open(_ id: String, relay relayOpt: Bool, lanAttempt attempt: TimeInterval?) async throws -> ConnectSession
        {
            try await requireOn("open")
            if lan == nil && relay == nil { throw ConnectLanError(.notStarted, "Cloud Connect is not started.") }
            let rows = (await connect.contactRows()).filter { ConnectContacts.id($0.agreeKey) == id }
            if rows.isEmpty { throw ConnectLanError(.unknownPeer, "That is not a link on this device.") }
            // The newest secret first: the pending one of a re-pair, then the held one.
            let order =
                rows.filter { $0.pendingSince != nil }.map { _ in true }
                + rows.filter { $0.pendingSince == nil }.map { _ in false }
            var last: Error?
            for pending in order {
                if let lan, await lan.currentContactPeers().contains(where: { $0.id == id && $0.pending == pending }) {
                    let outcome = await CloudConnectCore.race(
                        attempt ?? lanAttempt, { try await lan.connectContact(id, pending: pending) },
                        late: { await $0.close() })
                    switch outcome {
                    case .value(let s):
                        return try await trackHeld(s)
                    case .failed(let e): last = e
                    case .timedOut:
                        last = ConnectLanError(.connectFailed, "The LAN attempt took too long; trying the relay.")
                    }
                }
                if let relay, relayOpt, relayOn {
                    do {
                        let s = try await relay.dial(id, pending: pending)
                        return try await trackHeld(s)
                    } catch { last = error }
                }
            }
            throw last
                ?? ConnectLanError(.unknownPeer, "That contact was not found on this network, and the relay is off.")
        }
    }
#endif
