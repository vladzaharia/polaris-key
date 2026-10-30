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
#endif
