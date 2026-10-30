// The system network of nearby approval (CC-15.S2, CC-15.S3; WIRE-CONTRACT-V5 §15.4, §15.6.1): the approver's
// listener and `m=v` advert over `BonjourListener`, with the same address rule as mode a and the approver's own
// pending pool; and (S3) D's browse, resolve and dial over the same Bonjour code mode a uses. `PolarisKeyCore`
// owns the engines and the ports; this file only adapts them to `PolarisKeyPlatform`.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

#if canImport(Network)
    import Network

    extension NearbyError {
        /// What a Bonjour failure means to the host.
        static func from(_ e: BonjourPipeError) -> NearbyError {
            switch e {
            case .browse(let b): return from(b)
            default: return .unavailable
            }
        }

        static func from(_ e: BonjourBrowseError) -> NearbyError {
            switch e {
            case .permissionDenied: return .permissionDenied
            case .notConfigured: return .notConfigured
            case .unavailable: return .unavailable
            }
        }
    }

    /// An `NWPipe` the approver's listener admitted, as the engine's inbound pipe.
    struct NearbyNWPipe: NearbyInboundPipe {
        let pipe: NWPipe
        var remoteAddress: String { pipe.remoteAddress }
        func read() async throws -> Data? { try await pipe.read() }
        func write(_ bytes: Data) async throws { try await pipe.write(bytes) }
        func close() async { await pipe.close() }
        func established() { pipe.markEstablished() }
        func settle() { pipe.markAuthenticated() }
    }

    /// The approver's network: a listener of its own on a random port for every generation, registered as
    /// `_pkeypeer._tcp` with the `m=v` TXT. Accept uses the mode-a rule (`BonjourDialPolicy`, `lanVerdict`), with
    /// the approver's pool: one waiting socket per source address, two per group, eight in all.
    public final class SystemNearbyApproverNetwork: NearbyApproverNetwork, @unchecked Sendable {
        private let peerToPeer: Bool
        private let allowLoopback: Bool

        /// `peerToPeer` is AWDL (D-5), off by default. `allowLoopback` is for tests and same-host use.
        public init(peerToPeer: Bool = false, allowLoopback: Bool = false) {
            self.peerToPeer = peerToPeer
            self.allowLoopback = allowLoopback
        }

        final class Handle: NearbyAdvertHandle, @unchecked Sendable {
            let listener: BonjourListener
            /// The port the listener got (a test dials it).
            let port: UInt16
            init(_ l: BonjourListener, port: UInt16) {
                listener = l
                self.port = port
            }
            func cancel() { listener.stop() }
            func stop() async { listener.stop() }
        }

        public func open(
            instance: String, txt: [String], onPipe: @escaping @Sendable (any NearbyInboundPipe) -> Void
        ) async throws -> any NearbyAdvertHandle {
            let listener = BonjourListener(
                peerToPeer: peerToPeer, limiter: UnauthenticatedLimiter.approver(),
                policy: BonjourDialPolicy(allowLoopback: allowLoopback))
            let port: UInt16
            do {
                port = try await listener.start(
                    advert: BonjourAdvert(instance: instance, txt: txt),
                    onPipe: { onPipe(NearbyNWPipe(pipe: $0)) },
                    // A registration the OS renamed is withdrawn and a failed listener ends: the renewal makes
                    // a new instance and port within 300 s, so neither is acted on here.
                    onEvent: { _ in })
            } catch let e as BonjourPipeError {
                throw NearbyError.from(e)
            }
            return Handle(listener, port: port)
        }
    }

    /// D's network: a browse for `_pkeypeer._tcp`, the resolve that judges every address before any connect
    /// (§15.4.1), and the dial, all through the Bonjour code mode a uses. D never listens.
    public final class SystemNearbyRequesterNetwork: NearbyRequesterNetwork, @unchecked Sendable {
        private let browseOptions: BonjourBrowseOptions
        private let dialOptions: BonjourDialOptions

        /// `peerToPeer` is AWDL (D-5), off by default. `allowLoopback` is for tests and same-host use.
        public init(peerToPeer: Bool = false, allowLoopback: Bool = false) {
            browseOptions = BonjourBrowseOptions(peerToPeer: peerToPeer)
            dialOptions = BonjourDialOptions(
                policy: BonjourDialPolicy(allowLoopback: allowLoopback), peerToPeer: peerToPeer)
        }

        public func browse(
            accept: @escaping @Sendable (NearbyAdvert) -> Bool, onUp: @escaping @Sendable (NearbyAdvert) -> Void,
            onDown: @escaping @Sendable (String) -> Void
        ) throws -> @Sendable () -> Void {
            @Sendable func advert(_ f: BonjourFound) -> NearbyAdvert {
                NearbyAdvert(instance: f.instance, txt: f.txt, endpoint: f.endpoint)
            }
            let b = BonjourBrowse(options: browseOptions, acceptFound: { accept(advert($0)) })
            do {
                try b.start(onUp: { onUp(advert($0)) }, onDown: onDown, onError: { _ in })
            } catch let e as BonjourBrowseError {
                throw NearbyError.from(e)
            }
            return { b.stop() }
        }

        public func resolve(_ advert: NearbyAdvert) async throws -> [NearbyTarget] {
            guard let endpoint = advert.endpoint as? BonjourEndpoint else { throw NearbyError.unavailable }
            do {
                return try await BonjourPipes.resolve(endpoint, options: dialOptions).map {
                    NearbyTarget(address: $0.name, endpoint: $0)
                }
            } catch let e as BonjourPipeError {
                throw NearbyError.from(e)
            }
        }

        public func dial(_ target: NearbyTarget) async throws -> any PeerBytePipe {
            guard let endpoint = target.endpoint as? BonjourEndpoint, let network = endpoint.network else {
                throw NearbyError.unavailable
            }
            do {
                return LanPipe(pipe: try await BonjourPipes.dial(network, options: dialOptions))
            } catch let e as BonjourPipeError {
                throw NearbyError.from(e)
            }
        }
    }

    /// What nearby approval reads of the client (CC-15.S4).
    public struct NearbyDeps: Sendable {
        public var slug: String
        /// Seconds since the epoch.
        public var now: @Sendable () -> Int
        /// The Identity service is on for this product, else the typed N/A.
        public var requireIdentity: @Sendable () async throws -> Void
        /// The Identity fragment of discovery; `fresh` loads it again first. nil while it is off.
        public var identity: @Sendable (_ fresh: Bool) async -> IdentityDiscovery?
        /// This device is signed in on the product.
        public var signedIn: @Sendable () async -> Bool
        /// D's device keys and its `X-PKey-Device` value.
        public var signer: @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String)
        public var approverNetwork: any NearbyApproverNetwork
        public var requesterNetwork: any NearbyRequesterNetwork

        public init(
            slug: String, now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
            requireIdentity: @escaping @Sendable () async throws -> Void,
            identity: @escaping @Sendable (_ fresh: Bool) async -> IdentityDiscovery?,
            signedIn: @escaping @Sendable () async -> Bool,
            signer: @escaping @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String),
            approverNetwork: any NearbyApproverNetwork = SystemNearbyApproverNetwork(),
            requesterNetwork: any NearbyRequesterNetwork = SystemNearbyRequesterNetwork()
        ) {
            self.slug = slug
            self.now = now
            self.requireIdentity = requireIdentity
            self.identity = identity
            self.signedIn = signedIn
            self.signer = signer
            self.approverNetwork = approverNetwork
            self.requesterNetwork = requesterNetwork
        }
    }

    /// Nearby approval (CC-15; WIRE-CONTRACT-V5 §15.6.1), `client.cloudConnect.nearby`. It is gated by the
    /// Identity service's discovery (`nearby` and its endpoints), never by Connect: it works with Connect off. It
    /// carries the vouch over the LAN and calls no route; the host calls `nearby/start`, `poll` and `approve` and
    /// gives the answers to the handles.
    public final class CloudNearby: Sendable {
        private struct State {
            var epoch = 0
            var approvers: [NearbyApprover] = []
            var requests: [NearbyRequester] = []
        }

        private let deps: NearbyDeps?
        private let deliver: NearbyDeliver
        private let state = LockedValue(State())

        init(_ deps: NearbyDeps?, deliver: @escaping NearbyDeliver) {
            self.deps = deps
            self.deliver = deliver
        }

        private func unsupported(_ detail: String, _ reason: String) -> PolarisError {
            let u = Unsupported(feature: Feature.identityNearby, reason: reason, detail: detail)
            return PolarisError(
                code: reason == UnsupportedReason.product
                    ? PolarisError.serviceUnavailable : ErrorCode.nearbyUnsupported,
                message: "Nearby approval is not available here.", detail: detail, unsupported: u)
        }

        private func fragment(fresh: Bool, endpoints: [String]) async throws -> NearbyDeps {
            guard let d = deps else {
                throw unsupported("Nearby approval is not set up on this client.", UnsupportedReason.runtime)
            }
            // Discovery first: the service table comes from it once it is loaded.
            let f = await d.identity(fresh)
            try await d.requireIdentity()
            guard let f, f.nearby, endpoints.allSatisfy({ f.endpoints[$0]?.isEmpty == false }) else {
                throw unsupported(
                    "This product's discovery does not name nearby approval.", UnsupportedReason.product)
            }
            return d
        }

        /// D, the device with no sign-in: browse for approvers nearby and list them for the person to tap
        /// (`choose`). `options.request` is the handle `nearby/start` answered. Throws the typed N/A when the
        /// product serves no nearby approval, `NearbyError.permissionDenied` or `.notConfigured` when Local
        /// Network is refused or the app's Info.plist lacks its entries (D-8), and `NearbyError.closed` when a
        /// sign-out (`stopAll`) landed while it was starting.
        public func request(_ options: NearbyRequestOptions) async throws -> NearbyRequester {
            let epoch = state.current.epoch
            let d = try await fragment(fresh: true, endpoints: ["nearbyStart", "nearbyPoll"])
            if epoch != state.current.epoch { throw NearbyError.closed }
            var o = options
            o.platform = connectPlatformName
            o.deliver = deliver
            let r = try await NearbyRequester.start(
                source: NearbyRequesterSource(slug: d.slug, now: d.now, signer: d.signer), options: o,
                network: d.requesterNetwork)
            let kept = state.with { s -> Bool in
                if epoch != s.epoch { return false }
                s.requests.append(r)
                return true
            }
            if !kept {
                await r.close()
                throw NearbyError.closed
            }
            return r
        }

        /// M, a signed-in device: advertise while the person has "Approve a nearby device" open
        /// (`prompt: true`) or has allowed background approval with the permission granted (`prompt: false` with
        /// `background: true`), and hand each session that reaches the code to `handler`. Returns the handle that
        /// stops, pauses and resumes it. Throws `account_required` when the device is signed out (also when the
        /// sign-out landed while this was starting), and the typed N/A when the product serves no nearby
        /// approval.
        public func onRequest(
            _ handler: @escaping @Sendable (NearbyApproval) -> Void, options: NearbyApproverOptions
        ) async throws -> NearbyApprover {
            let epoch = state.current.epoch
            let d = try await fragment(fresh: true, endpoints: ["nearbyApprove"])
            let signedOut = PolarisError(
                code: ErrorCode.accountRequired, message: "Sign in before approving a nearby device.")
            if !(await d.signedIn()) || epoch != state.current.epoch { throw signedOut }
            var o = options
            o.platform = connectPlatformName
            o.deliver = deliver
            let me = self
            let h = try await NearbyApprover.start(
                source: NearbyApproverSource(
                    slug: d.slug, now: d.now, signedIn: d.signedIn,
                    nearbyServed: { (try? await me.fragment(fresh: true, endpoints: ["nearbyApprove"])) != nil }),
                handler: handler, options: o, network: d.approverNetwork)
            // The sign-out may have landed while the advert was starting, before the handle was kept.
            let signed = await d.signedIn()
            let kept = state.with { s -> Bool in
                if !signed || epoch != s.epoch { return false }
                s.approvers.append(h)
                return true
            }
            if !kept {
                await h.stop()
                throw signedOut
            }
            return h
        }

        /// Stop every advert and close every request. The sign-out step.
        func stopAll() async {
            // The handles stay in the state until they have stopped: the sign-out bound's `forceStop` must
            // still find the ones a hanging withdrawal holds.
            let (hs, rs) = state.with { s -> ([NearbyApprover], [NearbyRequester]) in
                s.epoch += 1
                return (s.approvers, s.requests)
            }
            await withTaskGroup(of: Void.self) { group in
                for h in hs { group.addTask { await h.stop() } }
                for r in rs { group.addTask { await r.close() } }
            }
            state.with { s in
                s.approvers.removeAll { a in hs.contains { $0 === a } }
                s.requests.removeAll { q in rs.contains { $0 === q } }
            }
        }

        /// The sign-out bound ran out: drop every socket and listener now, with no goodbye.
        func forceStop() {
            let (hs, rs) = state.with { s -> ([NearbyApprover], [NearbyRequester]) in
                s.epoch += 1
                defer {
                    s.approvers = []
                    s.requests = []
                }
                return (s.approvers, s.requests)
            }
            for h in hs { h.destroy() }
            for r in rs { r.destroy() }
        }
    }
#endif
