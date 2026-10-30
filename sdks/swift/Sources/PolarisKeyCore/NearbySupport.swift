// What the two halves of nearby approval share (CC-15.S2, CC-15.S3; WIRE-CONTRACT-V5 §15.6.1): the
// ports to the network, the timer, the error, a value that one side resolves and several await, and the
// one-time static key. Core owns the engine and these ports; the umbrella wires them to Bonjour.

import CryptoKit
import Foundation

/// Schedule `fn` after `seconds`; returns the cancel. A test injects its own.
public typealias NearbyTimer = @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> @Sendable () -> Void

/// The default timer: a `Task` sleep.
public let nearbySystemTimer: NearbyTimer = { seconds, fn in
    let t = Task {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        if !Task.isCancelled { fn() }
    }
    return { t.cancel() }
}

/// Why a nearby call refused. `code` is a registered client code.
public enum NearbyError: Error, Sendable, Equatable, CustomStringConvertible {
    /// The session or the request is closed.
    case closed
    /// The person has not picked the matching code on this session (no silent approval, rule 10).
    case notPicked
    /// The host's input is not valid (a request handle, a label, a lifetime).
    case badInput
    /// A record type outside `0x0030` to `0x003F`.
    case badType
    /// The message is larger than the other device accepts.
    case tooLarge
    /// No approver with that id is on the list.
    case unknownApprover
    /// An approver is already chosen, or the request has its answer.
    case notAvailable
    /// Local Network access was refused (D-8).
    case permissionDenied
    /// The app's Info.plist lacks the Local Network entries.
    case notConfigured
    /// The network could not listen, browse or dial.
    case unavailable

    public var code: String {
        switch self {
        case .closed, .unavailable, .notAvailable: return ErrorCode.networkError
        case .notPicked, .badInput, .badType, .tooLarge, .unknownApprover: return ErrorCode.invalidArgument
        case .permissionDenied: return ErrorCode.nearbyPermissionDenied
        case .notConfigured: return ErrorCode.notConfigured
        }
    }

    public var description: String { "NearbyError(\(self))" }
}

/// A value one side resolves, once, and any number await (the request that arrives after the pick).
final class NearbyDeferred<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?
    private var waiters: [CheckedContinuation<T, Never>] = []

    func resolve(_ v: T) {
        let w: [CheckedContinuation<T, Never>] = lock.withLock {
            if value != nil { return [] }
            value = v
            defer { waiters = [] }
            return waiters
        }
        for c in w { c.resume(returning: v) }
    }

    func wait() async -> T {
        await withCheckedContinuation { c in
            let ready: T? = lock.withLock {
                if let v = value { return v }
                waiters.append(c)
                return nil
            }
            if let ready { c.resume(returning: ready) }
        }
    }
}

/// A one-time X25519 static key (§15.5): made for one handshake and wiped when it ends. Swift gives no
/// control over copies of CryptoKit key material, so "wiped" means the engine drops the key and answers
/// nothing more with it.
public final class PeerOneTimeKey: PeerNoiseStaticKey, CustomStringConvertible, CustomReflectable,
    @unchecked Sendable
{
    private let lock = NSLock()
    private var key: Curve25519.KeyAgreement.PrivateKey?

    public init(random: PeerRandom = peerSystemRandom) throws {
        guard let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: random(32)) else {
            throw PeerNoiseError.badKey
        }
        key = k
    }

    /// True once `wipe()` ran.
    public var isWiped: Bool { lock.withLock { key == nil } }

    /// The key has done its work: nothing is answered with it from here on.
    public func wipe() { lock.withLock { key = nil } }

    public func publicKey() async throws -> Data {
        guard let k = lock.withLock({ key }) else { throw PeerNoiseError.badKey }
        return k.publicKey.rawRepresentation
    }

    public func dh(_ remote: Data) async throws -> Data? {
        guard let k = lock.withLock({ key }) else { return nil }
        return PeerNoiseX25519.agree(k, remote)
    }

    public var description: String { "PeerOneTimeKey()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// Run a read that may hang or fail: past `seconds` or on a throw it reads as `false`.
func nearbyBounded(
    _ seconds: TimeInterval, timer: NearbyTimer, _ read: @escaping @Sendable () async throws -> Bool
) async -> Bool {
    await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
        let once = LockedValue(false)
        let claim: @Sendable () -> Bool = {
            once.with {
                let was = $0
                $0 = true
                return !was
            }
        }
        let cancel = LockedValue<(@Sendable () -> Void)?>(nil)
        cancel.set(timer(seconds) { if claim() { c.resume(returning: false) } })
        Task {
            let v = (try? await read()) ?? false
            if claim() {
                cancel.current?()
                c.resume(returning: v)
            }
        }
    }
}

// MARK: - The approver's ports (CC-15.S2)

/// An inbound connection the approver's listener admitted: the accept gate (the mode-a address rule and the
/// pending limits) has run. The slot it holds is the gate's.
public protocol NearbyInboundPipe: PeerBytePipe {
    /// The transport is up: the handshake window ends, the slot is kept until `settle()` or the end.
    func established()
    /// Release the slot (the person picked, or the session ended). Idempotent.
    func settle()
}

/// One advert generation's listener and registration.
public protocol NearbyAdvertHandle: Sendable {
    /// Stop accepting and withdraw the advert. A connection already made is not touched.
    func stop() async
}

/// Where the approver gets its network (WIRE-CONTRACT-V5 §15.4, §15.6.1 rule 2). The system one is in the
/// umbrella (`BonjourListener`); a test supplies in-memory pipes.
public protocol NearbyApproverNetwork: Sendable {
    /// Listen on a new random port and register `instance` with `txt`. Each admitted inbound connection
    /// goes to `onPipe`. Throws `NearbyError` (`permissionDenied`, `notConfigured`, `unavailable`).
    func open(
        instance: String, txt: [String], onPipe: @escaping @Sendable (any NearbyInboundPipe) -> Void
    ) async throws -> any NearbyAdvertHandle
}

// MARK: - The requester's ports (CC-15.S3)

/// An approver advert the browse saw. `endpoint` is the network's own token for it.
public struct NearbyAdvert: Sendable {
    public let instance: String
    public let txt: [String]
    public let endpoint: any Sendable

    public init(instance: String, txt: [String], endpoint: any Sendable) {
        self.instance = instance
        self.txt = txt
        self.endpoint = endpoint
    }
}

/// An address of an advert that passed the dial rule (resolved and judged before any connect, §15.4.1).
public struct NearbyTarget: Sendable {
    public let address: String
    public let endpoint: any Sendable

    public init(address: String, endpoint: any Sendable) {
        self.address = address
        self.endpoint = endpoint
    }
}

/// Where D gets its network: browse, resolve and dial. D never listens (R-4).
public protocol NearbyRequesterNetwork: Sendable {
    /// Browse for `_pkeypeer._tcp`; returns the stop. `accept` is asked before an advert takes a place in the
    /// network's table, so adverts that are not an approver of this product never evict one that is. Throws
    /// `NearbyError` when browsing cannot begin.
    func browse(
        accept: @escaping @Sendable (NearbyAdvert) -> Bool, onUp: @escaping @Sendable (NearbyAdvert) -> Void,
        onDown: @escaping @Sendable (String) -> Void
    ) throws -> @Sendable () -> Void
    /// The addresses of an advert that may be dialled, in order, judged before any connect.
    func resolve(_ advert: NearbyAdvert) async throws -> [NearbyTarget]
    /// Connect; the pipe is handed back only after the address passed the dial rule.
    func dial(_ target: NearbyTarget) async throws -> any PeerBytePipe
}
